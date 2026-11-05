'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../../src/services/backup-restauracao-duravel.service');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const H = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const Mm = require('../../src/services/backup-fontes-manifesto-l2.service');
const X = require('../../src/services/backup-custodia-xor.service');
const Off = require('../../src/services/backup-fontes-recuperacao-offline.service');
const Kms = require('../../src/services/backup-fontes-kms-pre-resolvido.service');
const { criarValidadorDeDestinos } = require('../../src/services/imagem-backup-destinos.service');
const { verificarPacoteL2 } = require('../../src/services/backup-fontes-composicao-l2.service');
const { criarKmsFalso } = require('../helpers/kms-falso');
const { ambienteS3, sha } = require('../helpers/ambiente-s3-falso');
const { novaRaiz, limparRaizes, pacoteSintetico, arvore } = require('../helpers/pacote-l2-sintetico');

/**
 * R-D45 [DWN-E2E]: ciclo COMPLETO com a composição existente (P6, P11) e dados sintéticos: pacote L2 → cifra em envelope (chaves do KMS falso pré-resolvido) →
 * publicação no S3 falso com recibos → baixar por versão explícita para um destino local AUTORIZADO → decifrar (chaves reconstruídas OFF-LINE das partes XOR) → verificar o pacote L2.
 */

after(limparRaizes);
const SEG_MAC = crypto.randomBytes(32);
const SEG_KEK = crypto.randomBytes(32);
const dMac = X.dividirSegredo({ chaveId: 'mac-hml-v1', segredo: SEG_MAC });
const dKek = X.dividirSegredo({ chaveId: 'kek-hml-v1', segredo: SEG_KEK });

/** Chaves de OPERAÇÃO: KMS falso pré-resolvido (o caminho do host). */
async function chavesDeOperacao(a) {
  const kms = criarKmsFalso();
  const ctx = (finalidade, chaveId) => Kms.contextoDeCriptografia({ ambiente: 'HOMOLOGACAO', finalidade, chaveId });
  const p = Kms.criarProvedoresKmsPreResolvidos({
    ficha: a.ficha, cliente: kms.cliente, prazoMs: 1000,
    chaves: {
      mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', blob: kms.cifrar({ chaveArn: a.ficha.chaveMac, contexto: ctx('MAC', 'mac-hml-v1'), segredo: SEG_MAC }), vc: X.valorDeVerificacao('mac-hml-v1', SEG_MAC) }],
      cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', blob: kms.cifrar({ chaveArn: a.ficha.chaveCifra, contexto: ctx('CIFRA', 'kek-hml-v1'), segredo: SEG_KEK }), vc: X.valorDeVerificacao('kek-hml-v1', SEG_KEK) }],
    },
  });
  await p.resolver();
  return p;
}
const comoFontes = (provedor, macId = 'mac-hml-v1', kekId = 'kek-hml-v1') => {
  const fonteMac = H.criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: provedor.mac });
  const fonteCifra = E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: kekId, segredo: provedor.cifra.obter(kekId).segredo }] });
  return { fonteMac, chaves: { cifra: { fonte: fonteCifra, chaveId: kekId }, mac: { fonte: fonteMac, chaveId: macId } } };
};

/** Cifra um pacote sintético, publica o contêiner e cria o destino local autorizado de TESTE; devolve tudo o que a restauração precisa. */
async function cenario() {
  const a = ambienteS3({ bloco: 4096 });
  const raiz = novaRaiz();
  const operacao = await chavesDeOperacao(a);
  const { fonteMac, chaves } = comoFontes(operacao);
  const pacote = pacoteSintetico(raiz, { fonteMac, macId: 'mac-hml-v1', conjuntoId: 'conjunto-d45' });
  const container = path.join(raiz, 'container');
  const c = await E.cifrarPacote({ pacote: pacote.dir, lido: pacote.lido, destino: container, ...chaves });
  assert.equal(c.ok, true, JSON.stringify(c.falha));
  const arquivos = arvore(container).map((rel) => ({ chave: rel, conteudo: fs.readFileSync(path.join(container, rel)) }));
  const consolidado = await a.publicar({ conjuntoId: 'conjunto-d45', arquivos, raiz });
  assert.equal(consolidado.ok, true);
  const dl = a.destinoLocal(raiz);
  return { a, raiz, pacote, consolidado, container, dl };
}
/** Chaves de RECUPERAÇÃO: reconstruídas só das partes (qualquer dupla de custodiantes), sem KMS. */
const chavesOffline = () => comoFontes(Off.criarProvedoresDeRecuperacaoOffline({ chaves: {
  mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', pacotes: [dMac.pacotes[2], dMac.pacotes[1]] }],
  cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', pacotes: [dKek.pacotes[0], dKek.pacotes[2]] }],
} }));
const restaurar = (x, nome, chavesDe, extra = {}, baixador = x.a.baixador(x.dl)) => R.restaurarContainerDoDestinoDuravel({
  baixador, validadorDeDestinos: x.dl.validador, consolidado: x.consolidado.consolidado, destinoLocalId: x.dl.id, raiz: x.dl.raiz, nomeContainer: `baixado-${nome}`, nomeDecifrado: `restaurado-${nome}`, ...chavesDe.chaves, ...extra,
});
const falha = (r, passo, codigo) => assert.deepEqual({ ok: r.ok, falha: r.falha }, { ok: false, falha: { passo, codigo } });

describe('[DWN-E2E] publicar, baixar por versão, decifrar e verificar', () => {
  test('E2E-01 — ciclo completo com chaves de operação (KMS falso) e restauração com chaves OFF-LINE: pacote reconstruído idêntico e verificado; os dois destinos são filhos novos da raiz autorizada; o bucket confere com os recibos', async () => {
    const x = await cenario();
    const ver = await x.a.verificador().verificar(x.consolidado.consolidado);
    assert.equal(ver.conforme, true, JSON.stringify(ver));
    const off = chavesOffline();
    const r = await restaurar(x, 'ok', off);
    assert.equal(r.ok, true, JSON.stringify(r.falha));
    assert.equal(r.baixados.arquivos, x.consolidado.consolidado.recibos.length);
    assert.deepEqual(fs.readdirSync(x.dl.raiz).sort(), ['baixado-ok', 'restaurado-ok']);
    const destino = path.join(x.dl.raiz, 'restaurado-ok');
    assert.deepEqual(arvore(destino), arvore(x.pacote.dir));
    for (const f of arvore(x.pacote.dir)) assert.ok(fs.readFileSync(path.join(destino, f)).equals(fs.readFileSync(path.join(x.pacote.dir, f))), f);
    const bytes = fs.readFileSync(path.join(destino, 'manifesto.json'));
    const lido = Mm.criarLeitorL2({ fonteDeChaves: off.fonteMac, layoutMinimo: 2 })({ bytes, sha256: sha(bytes) });
    assert.equal((await verificarPacoteL2({ pacote: destino, lido })).ok, true);
  });

  test('E2E-02 — objeto do contêiner adulterado no bucket: a INTEGRIDADE contra o recibo barra no download; a decifragem nem começa e nada é criado no destino decifrado', async () => {
    const x = await cenario();
    const alvo = x.consolidado.consolidado.recibos.find((r) => r.chave.endsWith('.enc'));
    x.a.s3.corromper(alvo.chave, alvo.versaoId, crypto.randomBytes(alvo.bytes));
    falha(await restaurar(x, 'adulterado', chavesOffline()), 'BAIXAR', 'INTEGRIDADE_DIVERGENTE');
    assert.equal(fs.existsSync(path.join(x.dl.raiz, 'restaurado-adulterado')), false);
  });

  test('E2E-03 — MAC ANTES da decifragem: com outra chave de MAC o envelope é recusado (MAC_INVALIDO) e o destino decifrado não é criado', async () => {
    const x = await cenario();
    const outra = X.dividirSegredo({ chaveId: 'mac-hml-v1', segredo: crypto.randomBytes(32) });
    const errado = comoFontes(Off.criarProvedoresDeRecuperacaoOffline({ chaves: {
      mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', pacotes: [outra.pacotes[0], outra.pacotes[1]] }],
      cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', pacotes: [dKek.pacotes[0], dKek.pacotes[1]] }],
    } }));
    falha(await restaurar(x, 'mac-errado', errado), 'ENVELOPE', 'MAC_INVALIDO');
    assert.equal(fs.existsSync(path.join(x.dl.raiz, 'restaurado-mac-errado')), false);
    assert.ok(fs.existsSync(path.join(x.dl.raiz, 'baixado-mac-errado', 'envelope.json')), 'o contêiner baixado permanece para análise');
  });

  test('E2E-04 — KEK errada: MAC confere, mas a chave de dados não se desenvolve (DEK_NAO_DESENVOLVIDA); nada é decifrado', async () => {
    const x = await cenario();
    const outra = X.dividirSegredo({ chaveId: 'kek-hml-v1', segredo: crypto.randomBytes(32) });
    const errado = comoFontes(Off.criarProvedoresDeRecuperacaoOffline({ chaves: {
      mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', pacotes: [dMac.pacotes[0], dMac.pacotes[1]] }],
      cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', pacotes: [outra.pacotes[1], outra.pacotes[2]] }],
    } }));
    falha(await restaurar(x, 'kek-errada', errado), 'CHAVES', 'DEK_NAO_DESENVOLVIDA');
    assert.equal(fs.existsSync(path.join(x.dl.raiz, 'restaurado-kek-errada')), false);
  });

  test('E2E-05 — versão forjada mais nova sob o mesmo nome (inclusive do envelope): a restauração usa a versão do recibo e conclui; a conferência independente acusa a forjada', async () => {
    const x = await cenario();
    const envelope = x.consolidado.consolidado.recibos.find((r) => r.chave.endsWith('/envelope.json'));
    const forjada = x.a.s3.injetarVersaoExtra(envelope.chave, Buffer.from('{"forjado":true}'));
    const r = await restaurar(x, 'forjada', chavesOffline());
    assert.equal(r.ok, true, JSON.stringify(r.falha));
    const ver = await x.a.verificador().verificar(x.consolidado.consolidado);
    assert.equal(ver.conforme, false);
    assert.ok(ver.extras.some((e) => e.versaoId === forjada && e.codigo === 'VERSAO_EXTRA'));
  });

  test('E2E-06 — os dois destinos são sempre NOVOS: contêiner existente, decifrado existente e nomes iguais ou inválidos são recusados pelo orquestrador', async () => {
    const x = await cenario();
    const off = chavesOffline();
    fs.mkdirSync(path.join(x.dl.raiz, 'baixado-existente'), { mode: 0o700 });
    falha(await restaurar(x, 'existente', off), 'DESTINO', 'DESTINO_EXISTENTE');
    assert.equal((await restaurar(x, 'novo', off)).ok, true);
    const de = await R.restaurarContainerDoDestinoDuravel({ baixador: x.a.baixador(x.dl), validadorDeDestinos: x.dl.validador, consolidado: x.consolidado.consolidado, destinoLocalId: x.dl.id, raiz: x.dl.raiz, nomeContainer: 'baixado-outro', nomeDecifrado: 'restaurado-novo', ...off.chaves });
    falha(de, 'DESTINO', 'DESTINO_EXISTENTE');
    assert.equal(fs.existsSync(path.join(x.dl.raiz, 'baixado-outro', 'envelope.json')), true, 'o contêiner já baixado permanece; a decifra não começou');
    const base = { baixador: x.a.baixador(x.dl), validadorDeDestinos: x.dl.validador, consolidado: x.consolidado.consolidado, destinoLocalId: x.dl.id, raiz: x.dl.raiz, nomeContainer: 'c1', nomeDecifrado: 'd1', ...off.chaves };
    for (const ruim of [null, {}, { baixador: {} }, { ...base, validadorDeDestinos: undefined }, { ...base, validadorDeDestinos: {} }, { ...base, nomeDecifrado: 'c1' }, { ...base, nomeContainer: '../fora' }, { ...base, nomeDecifrado: 'a/b' }, { ...base, raiz: 'relativo' }, { ...base, extra: 1 }, { ...base, destinoLocalId: 7 }]) {
      falha(await R.restaurarContainerDoDestinoDuravel(ruim), 'ENTRADA', 'ENTRADA_INVALIDA');
    }
  });

  test('E2E-07 — destino local não autorizado (lista real vazia, id fora da lista) recusa a restauração inteira: nada é baixado, criado ou decifrado', async () => {
    const x = await cenario();
    const real = criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO' });
    const lerAntes = x.a.s3.chamadas.filter((c) => c.operacao === 'lerVersao').length;
    falha(await restaurar(x, 'real', chavesOffline(), {}, x.a.baixador(x.dl, { validadorDeDestinos: real })), 'DESTINO', 'DESTINO_NAO_AUTORIZADO');
    falha(await restaurar(x, 'fora-da-lista', chavesOffline(), { destinoLocalId: 'nao-listado' }), 'DESTINO', 'DESTINO_NAO_AUTORIZADO');
    assert.deepEqual(fs.readdirSync(x.dl.raiz), []);
    assert.equal(x.a.s3.chamadas.filter((c) => c.operacao === 'lerVersao').length, lerAntes);
  });

  test('E2E-09 — troca concorrente DURANTE a decifra da restauração (pasta do destino vira link para fora, logo antes do open): a restauração para com DESTINO_ALTERADO e nada chega fora da raiz autorizada', async () => {
    const x = await cenario();
    const fora = path.join(x.raiz, 'fora');
    fs.mkdirSync(fora, { mode: 0o700 });
    const pasta = path.join(x.dl.raiz, 'restaurado-troca', path.dirname(arvore(x.pacote.dir)[0]));
    const original = crypto.randomBytes;
    let feito = false;
    crypto.randomBytes = (tamanho, ...resto) => {
      if (tamanho === 8 && !feito && fs.existsSync(pasta)) { feito = true; fs.renameSync(pasta, `${pasta}.orig`); fs.symlinkSync(fora, pasta); }
      return original(tamanho, ...resto);
    };
    let r;
    try { r = await restaurar(x, 'troca', chavesOffline()); } finally { crypto.randomBytes = original; }
    assert.equal(feito, true, 'a troca foi provocada no ponto certo');
    falha(r, 'DECIFRA', 'DESTINO_ALTERADO');
    assert.deepEqual(fs.readdirSync(fora), []);
  });

  test('E2E-08 — nada é ativado: listas aprovadas vazias, fábricas operacionais bloqueadas, o orquestrador não escreve nem remove arquivos e não usa ambiente, SDK ou rede', () => {
    assert.deepEqual([...require('../../src/services/imagem-backup-durabilidade.service').ARMAZENAMENTOS_DURAVEIS_APROVADOS], []);
    assert.deepEqual([...H.PROVEDORES_OPERACIONAIS_APROVADOS], []);
    assert.deepEqual([...E.PROVEDORES_DE_CIFRA_APROVADOS], []);
    assert.deepEqual([...require('../../src/services/imagem-backup-destinos.service').DESTINOS_AUTORIZADOS.HOMOLOGACAO], []);
    assert.deepEqual([...require('../../src/services/imagem-backup-destinos.service').DESTINOS_AUTORIZADOS.PRODUCAO], []);
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'backup-restauracao-duravel.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
    assert.equal(/\b(?:createWriteStream|writeFile|writeFileSync|appendFile|copyFile|link|symlink|rename|mkdir|truncate|unlink|rm|rmdir)\s*\(|\bO_(?:WRONLY|CREAT|RDWR|APPEND)\b|process\.env|@aws-sdk|require\(['"]node:(?:net|http|https|child_process|dns|tls|fs)/.test(fonte), false);
  });
});
