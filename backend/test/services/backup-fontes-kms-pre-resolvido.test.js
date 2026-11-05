'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const K = require('../../src/services/backup-fontes-kms-pre-resolvido.service');
const X = require('../../src/services/backup-custodia-xor.service');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const H = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const Mm = require('../../src/services/backup-fontes-manifesto-l2.service');
const { verificarPacoteL2 } = require('../../src/services/backup-fontes-composicao-l2.service');
const { criarKmsFalso } = require('../helpers/kms-falso');
const { fichaDeTeste, registro } = require('../helpers/fichas-duraveis');
const { novaRaiz, limparRaizes, pacoteSintetico, arvore, sha } = require('../helpers/pacote-l2-sintetico');

/** R-D45 [KMS]: provedor KMS PRÉ-RESOLVIDO — decifra os blobs uma única vez (assíncrono) e entrega as famílias MAC e KEK por contrato SÍNCRONO. KMS falso; segredos sintéticos; sem rede. */

after(limparRaizes);
const ficha = registro(fichaDeTeste('HOMOLOGACAO'))[0];
const ctx = (finalidade, chaveId) => K.contextoDeCriptografia({ ambiente: 'HOMOLOGACAO', finalidade, chaveId });
const ARN_ESTRANHO = 'arn:aws:kms:us-east-1:111111111111:key/99999999-9999-4999-8999-999999999999';

function montar({ segMac = crypto.randomBytes(32), segKek = crypto.randomBytes(32) } = {}) {
  const kms = criarKmsFalso();
  const blobMac = kms.cifrar({ chaveArn: ficha.chaveMac, contexto: ctx('MAC', 'mac-hml-v1'), segredo: segMac });
  const blobKek = kms.cifrar({ chaveArn: ficha.chaveCifra, contexto: ctx('CIFRA', 'kek-hml-v1'), segredo: segKek });
  const chaves = {
    mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', blob: blobMac, vc: X.valorDeVerificacao('mac-hml-v1', segMac) }],
    cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', blob: blobKek, vc: X.valorDeVerificacao('kek-hml-v1', segKek) }],
  };
  return { kms, segMac, segKek, chaves, criar: (o = {}) => K.criarProvedoresKmsPreResolvidos({ ficha, cliente: kms.cliente, chaves, prazoMs: 1000, ...o }) };
}
const rejeita = async (promessa, motivo) => assert.rejects(promessa, (e) => e.code === 'KMS_PRE_RESOLUCAO_FALHOU' && e.motivo === motivo, motivo);
const nenhumaChave = (p) => { assert.equal(p.mac.obter('mac-hml-v1').situacao, 'INDISPONIVEL'); assert.equal(p.cifra.obter('kek-hml-v1').situacao, 'INDISPONIVEL'); };

describe('[KMS] pré-resolução e contrato síncrono', () => {
  test('KMS-01 — antes: indisponível; depois de resolver: cada família só vê as próprias chaves, por cópia; zerar encerra', async () => {
    const m = montar();
    const p = m.criar();
    assert.equal(p.estado(), 'NAO_RESOLVIDO');
    nenhumaChave(p);
    await p.resolver();
    assert.equal(p.estado(), 'RESOLVIDO');
    const r = p.mac.obter('mac-hml-v1');
    assert.equal(r.situacao, 'ATIVA');
    assert.ok(r.segredo.equals(m.segMac));
    assert.ok(p.cifra.obter('kek-hml-v1').segredo.equals(m.segKek));
    assert.equal(p.mac.obter('kek-hml-v1').situacao, 'INDISPONIVEL');
    assert.equal(p.cifra.obter('mac-hml-v1').situacao, 'INDISPONIVEL');
    r.segredo.fill(0);
    assert.ok(p.mac.obter('mac-hml-v1').segredo.equals(m.segMac), 'a cópia entregue é independente');
    p.zerar();
    assert.equal(p.estado(), 'ZERADO');
    nenhumaChave(p);
  });

  test('KMS-02 — a chave KMS é FIXADA pela ficha e o contexto é o esperado; resposta de outra chave derruba tudo', async () => {
    const m = montar();
    const p = m.criar();
    await p.resolver();
    assert.equal(m.kms.chamadas.length, 2);
    assert.deepEqual(m.kms.chamadas[0], { chaveArn: ficha.chaveMac, contexto: { 'safework:ambiente': 'HOMOLOGACAO', 'safework:finalidade': 'MAC', 'safework:chave-id': 'mac-hml-v1' } });
    assert.deepEqual(m.kms.chamadas[1], { chaveArn: ficha.chaveCifra, contexto: { 'safework:ambiente': 'HOMOLOGACAO', 'safework:finalidade': 'CIFRA', 'safework:chave-id': 'kek-hml-v1' } });

    const m2 = montar();
    m2.kms.desviar(async () => ({ chaveArn: ARN_ESTRANHO, segredo: crypto.randomBytes(32) }));
    const p2 = m2.criar();
    await rejeita(p2.resolver(), 'CHAVE_KMS_DIVERGENTE');
    assert.equal(p2.estado(), 'FALHOU');
    nenhumaChave(p2);
  });

  test('KMS-03 — o blob de uma família apresentado à outra é recusado pelo contexto (o KMS falso recusa como o real)', async () => {
    const m = montar();
    const trocado = { mac: m.chaves.mac, cifra: [{ ...m.chaves.cifra[0], blob: m.chaves.mac[0].blob }] };
    const p = m.criar({ chaves: trocado });
    await rejeita(p.resolver(), 'KMS_INDISPONIVEL');
    nenhumaChave(p);
  });

  test('KMS-04 — chave revogada não é decifrada (nenhuma chamada) e responde REVOGADA; várias versões convivem', async () => {
    const m = montar();
    const segV2 = crypto.randomBytes(32);
    const blobV2 = m.kms.cifrar({ chaveArn: ficha.chaveMac, contexto: ctx('MAC', 'mac-hml-v2'), segredo: segV2 });
    const chaves = { ...m.chaves, mac: [...m.chaves.mac, { chaveId: 'mac-hml-v2', estado: 'ATIVA', blob: blobV2, vc: X.valorDeVerificacao('mac-hml-v2', segV2) }, { chaveId: 'mac-hml-v0', estado: 'REVOGADA', blob: Buffer.from([1]), vc: 'a'.repeat(64) }] };
    const p = m.criar({ chaves });
    await p.resolver();
    assert.equal(m.kms.chamadas.length, 3, 'v0 revogada não é decifrada');
    assert.deepEqual({ ...p.mac.obter('mac-hml-v0') }, { situacao: 'REVOGADA' });
    assert.ok(p.mac.obter('mac-hml-v2').segredo.equals(segV2));
    assert.ok(p.mac.obter('mac-hml-v1').segredo.equals(m.segMac));
  });

  test('KMS-05 — exceção, atraso além do prazo e resposta fora do contrato derrubam TUDO (inclusive a família que já tinha sido decifrada); o erro não cita nada', async () => {
    const casos = [
      async (pedido) => { if (pedido.contexto['safework:finalidade'] === 'CIFRA') throw new Error('detalhe-interno-secreto'); },
      async (pedido) => { if (pedido.contexto['safework:finalidade'] === 'CIFRA') await new Promise(() => {}); },
      async (pedido) => ({ chaveArn: pedido.chaveArn, segredo: crypto.randomBytes(32), extra: 1 }),
      async (pedido) => ({ chaveArn: pedido.chaveArn, segredo: 'texto' }),
      async () => null,
      async (pedido) => ({ chaveArn: pedido.chaveArn }),
    ];
    for (const desvio of casos) {
      const m = montar();
      m.kms.desviar(desvio);
      const p = m.criar({ prazoMs: 40 });
      await assert.rejects(p.resolver(), (e) => {
        const texto = `${e.message} ${e.code} ${e.motivo} ${JSON.stringify(e)}`;
        return e.code === 'KMS_PRE_RESOLUCAO_FALHOU' && e.motivo === 'KMS_INDISPONIVEL' && !texto.includes('secreto') && !texto.includes(ficha.chaveMac) && !texto.includes(ficha.contaId);
      });
      assert.equal(p.estado(), 'FALHOU');
      nenhumaChave(p);
    }
  });

  test('KMS-06 — segredo com tamanho errado, valor de verificação divergente e MAC igual à KEK são recusados', async () => {
    const mac16 = montar({ segMac: crypto.randomBytes(16) });
    await rejeita(mac16.criar().resolver(), 'SEGREDO_INVALIDO');
    const kek40 = montar({ segKek: crypto.randomBytes(40) });
    await rejeita(kek40.criar().resolver(), 'SEGREDO_INVALIDO');
    const vc = montar();
    await rejeita(vc.criar({ chaves: { ...vc.chaves, mac: [{ ...vc.chaves.mac[0], vc: 'f'.repeat(64) }] } }).resolver(), 'VALOR_DE_VERIFICACAO_DIVERGENTE');
    const igual = crypto.randomBytes(32);
    await rejeita(montar({ segMac: igual, segKek: igual }).criar().resolver(), 'CHAVES_NAO_SEPARADAS');
  });

  test('KMS-07 — resolver duas vezes (ou em paralelo) é recusado; o estado resolvido não muda', async () => {
    const m = montar();
    const p = m.criar();
    const primeira = p.resolver();
    await rejeita(p.resolver(), 'RESOLUCAO_JA_REALIZADA');
    await primeira;
    await rejeita(p.resolver(), 'RESOLUCAO_JA_REALIZADA');
    assert.equal(p.estado(), 'RESOLVIDO');
    assert.equal(m.kms.chamadas.length, 2);
  });
});

describe('[KMS] configuração, vazamento e composição', () => {
  test('KMS-08 — configuração inválida lança CONFIGURACAO_INVALIDA na criação: ficha, cliente, chaves, prazo', () => {
    const m = montar();
    const ruim = (o) => assert.throws(() => m.criar(o), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    ruim({ ficha: fichaDeTeste('HOMOLOGACAO') });
    ruim({ ficha: { ...ficha, bucket: 'qualquer' } });
    ruim({ cliente: {} });
    ruim({ cliente: null });
    ruim({ prazoMs: 0 });
    ruim({ prazoMs: 60001 });
    ruim({ chaves: { mac: m.chaves.mac } });
    ruim({ chaves: { ...m.chaves, extra: [] } });
    ruim({ chaves: { ...m.chaves, cifra: [] } });
    ruim({ chaves: { ...m.chaves, mac: [{ ...m.chaves.mac[0], estado: 'REVOGADA' }] } });
    ruim({ chaves: { ...m.chaves, cifra: [{ ...m.chaves.cifra[0], chaveId: 'mac-hml-v1' }] } });
    ruim({ chaves: { ...m.chaves, mac: [m.chaves.mac[0], m.chaves.mac[0]] } });
    ruim({ chaves: { ...m.chaves, mac: [{ ...m.chaves.mac[0], chaveId: 'id inválido' }] } });
    ruim({ chaves: { ...m.chaves, mac: [{ ...m.chaves.mac[0], estado: 'PAUSADA' }] } });
    ruim({ chaves: { ...m.chaves, mac: [{ ...m.chaves.mac[0], blob: Buffer.alloc(0) }] } });
    ruim({ chaves: { ...m.chaves, mac: [{ ...m.chaves.mac[0], blob: Buffer.alloc(4097) }] } });
    ruim({ chaves: { ...m.chaves, mac: [{ ...m.chaves.mac[0], vc: 'xyz' }] } });
    ruim({ chaves: { ...m.chaves, mac: [{ ...m.chaves.mac[0], extra: 1 }] } });
    ruim({ chaves: { ...m.chaves, mac: Array.from({ length: 9 }, (_, i) => ({ ...m.chaves.mac[0], chaveId: `mac-${i}` })) } });
  });

  test('KMS-09 — contexto de criptografia: função pura, só finalidades MAC e CIFRA, ambiente e id válidos', () => {
    assert.deepEqual({ ...K.contextoDeCriptografia({ ambiente: 'PRODUCAO', finalidade: 'CIFRA', chaveId: 'kek-prod-v1' }) }, { 'safework:ambiente': 'PRODUCAO', 'safework:finalidade': 'CIFRA', 'safework:chave-id': 'kek-prod-v1' });
    for (const ruim of [{ ambiente: 'CI', finalidade: 'MAC', chaveId: 'a' }, { ambiente: 'HOMOLOGACAO', finalidade: 'KEK', chaveId: 'a' }, { ambiente: 'HOMOLOGACAO', finalidade: 'MAC', chaveId: 'a b' }, { ambiente: 'HOMOLOGACAO', finalidade: 'MAC' }, null]) {
      assert.throws(() => K.contextoDeCriptografia(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    }
  });

  test('KMS-10 — contrato síncrono e nenhum vazamento: obter não devolve promessa; JSON, inspeção e erros não contêm segredo, blob ou ARN', async () => {
    const m = montar();
    const p = m.criar();
    await p.resolver();
    assert.equal(typeof p.mac.obter('mac-hml-v1').then, 'undefined');
    const material = [m.segMac, m.segKek, m.chaves.mac[0].blob, m.chaves.cifra[0].blob].flatMap((b) => [b.toString('hex'), b.toString('base64')]);
    for (const texto of [JSON.stringify(p), JSON.stringify(p.mac), JSON.stringify(p.cifra), util.inspect(p, { showHidden: true, depth: 6 })]) for (const v of material) assert.equal(texto.includes(v), false);
  });

  test('KMS-11 — composição existente: as duas famílias encaixam nas fontes e em capturarChaves; cifrar, decifrar e verificar o pacote L2 funcionam', async () => {
    const m = montar();
    const p = m.criar();
    await p.resolver();
    const fonteMac = H.criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: p.mac });
    const fonteCifra = E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-hml-v1', segredo: p.cifra.obter('kek-hml-v1').segredo }] });
    const chaves = { cifra: { fonte: fonteCifra, chaveId: 'kek-hml-v1' }, mac: { fonte: fonteMac, chaveId: 'mac-hml-v1' } };
    assert.equal(E.capturarChaves(chaves).motivo, undefined);
    const raiz = novaRaiz();
    const pacote = pacoteSintetico(raiz, { fonteMac, macId: 'mac-hml-v1' });
    const container = path.join(raiz, 'container');
    const c = await E.cifrarPacote({ pacote: pacote.dir, lido: pacote.lido, destino: container, ...chaves });
    assert.equal(c.ok, true, JSON.stringify(c.falha));
    const reconstruido = path.join(raiz, 'reconstruido');
    const d = await E.decifrarContainer({ container, destino: reconstruido, ...chaves });
    assert.equal(d.ok, true, JSON.stringify(d.falha));
    assert.deepEqual(arvore(reconstruido), arvore(pacote.dir));
    const bytes = fs.readFileSync(path.join(reconstruido, 'manifesto.json'));
    const lido = Mm.criarLeitorL2({ fonteDeChaves: fonteMac, layoutMinimo: 2 })({ bytes, sha256: sha(bytes) });
    assert.equal((await verificarPacoteL2({ pacote: reconstruido, lido })).ok, true);
  });

  test('KMS-12 — nada é ativado: listas de provedores vazias, fábricas operacionais bloqueadas; o módulo não cifra, não gera chave, não usa SDK, arquivo, rede nem ambiente', () => {
    assert.equal(typeof K.PROVEDOR_ID, 'string');
    assert.deepEqual([...H.PROVEDORES_OPERACIONAIS_APROVADOS], []);
    assert.deepEqual([...E.PROVEDORES_DE_CIFRA_APROVADOS], []);
    assert.throws(() => H.criarFonteOperacionalDeChaves({ provedor: K.PROVEDOR_ID, adaptador: {} }));
    assert.throws(() => E.criarFonteOperacionalDeCifra({ provedor: K.PROVEDOR_ID, adaptador: {} }), (e) => e.code === 'FONTE_OPERACIONAL_INDISPONIVEL');
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'backup-fontes-kms-pre-resolvido.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
    assert.equal(/require\(['"]node:(?:fs|net|http|https|child_process|dns|tls)|process\.(?:env|stdin|argv)|@aws-sdk|GenerateDataKey|EncryptCommand|ScheduleKeyDeletion|DisableKey/.test(fonte), false);
    assert.equal(/\.encrypt\b|createCipheriv/.test(fonte), false, 'o host nunca cifra segredos');
  });
});
