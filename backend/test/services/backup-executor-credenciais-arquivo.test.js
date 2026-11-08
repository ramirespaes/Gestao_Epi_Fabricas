'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../../src/services/backup-executor-credenciais-arquivo.service');
const { criarConjuntoDeCredenciais } = require('../../src/services/backup-executor-credenciais.service');
const { removerTemporarioSeguro, criarRaizTemporaria } = require('../storage/helpers/tmp-seguro');

/** D-ORF-6, Rodada B (B1) [CRD], H9-a: fornecedor de credenciais SINTÉTICAS por arquivo, só para ensaio isolado. Todos os valores abaixo são inventados; nada é real. */

const UID = process.getuid();
const AGORA = 1_800_000_000_000;
const relogio = () => AGORA;
const raizes = [];
after(() => { for (const r of raizes) removerTemporarioSeguro(r); });
const novaRaiz = () => { const r = criarRaizTemporaria(); raizes.push(r); return r; };
const gravar = (caminho, texto, modo = 0o600) => { fs.writeFileSync(caminho, texto, { mode: modo }); fs.chmodSync(caminho, modo); return caminho; };
const SEGREDO = 'SWBTESTE-segredo-falso-0123';
const cred = (papel, extra = {}) => ({ papel, accessKeyId: `SWBTESTE${papel.slice(0, 3)}12345`, secretAccessKey: SEGREDO, ...extra });
const codigoDe = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const codigoAsync = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

function arquivoDe(papel, conteudo, { modo = 0o600, nome = `${papel}.json` } = {}) {
  const raiz = novaRaiz();
  const caminho = gravar(path.join(raiz, nome), typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo), modo);
  return { raiz, caminho, fornecedor: F.criarFornecedoresPorArquivo({ caminhos: { [papel]: caminho } })[papel] };
}
const obter = (papel, conteudo, opcoes) => arquivoDe(papel, conteudo, opcoes).fornecedor.obter({ papel });

describe('[CRD] fornecedor de credenciais sintéticas por arquivo', () => {
  test('CRD-01 — arquivo 0600 com o formato sintético: devolve papel, chave e segredo; expiration vira Date', () => {
    const r = obter('PUBLICADOR', cred('PUBLICADOR'));
    assert.deepEqual(r, { papel: 'PUBLICADOR', accessKeyId: 'SWBTESTEPUB12345', secretAccessKey: SEGREDO });
    const com = obter('VERIFICADOR', cred('VERIFICADOR', { expiration: '2027-01-01T00:00:00Z' }));
    assert.ok(com.expiration instanceof Date);
    assert.equal(com.expiration.toISOString(), '2027-01-01T00:00:00.000Z');
  });

  test('CRD-02 — alimenta o conjunto de credenciais: papéis distintos, segredo e sessão não enumeráveis, nada no JSON', async () => {
    const pub = arquivoDe('PUBLICADOR', cred('PUBLICADOR'));
    const ver = arquivoDe('VERIFICADOR', cred('VERIFICADOR'));
    const fornecedores = { PUBLICADOR: pub.fornecedor, VERIFICADOR: ver.fornecedor };
    const conjunto = criarConjuntoDeCredenciais({ acao: 'BACKUP', modo: 'ENSAIO', fornecedores, relogio });
    assert.deepEqual((await conjunto.verificarSeparacao()).papeis, ['PUBLICADOR', 'VERIFICADOR']);
    const c = await conjunto.credenciais('PUBLICADOR')();
    assert.equal(c.secretAccessKey, SEGREDO);
    assert.ok(Object.isFrozen(c));
    assert.ok(!JSON.stringify(c).includes(SEGREDO) && !JSON.stringify({ ...c }).includes(SEGREDO));
  });

  test('CRD-03 — SOMENTE 0600: 0400, 0640, 0644, 0660, 0666 e 0700 são recusados', () => {
    for (const modo of [0o400, 0o640, 0o644, 0o660, 0o666, 0o700]) {
      assert.equal(codigoDe(() => obter('PUBLICADOR', cred('PUBLICADOR'), { modo })), 'CREDENCIAL_ARQUIVO_INDISPONIVEL', modo.toString(8));
    }
  });

  test('CRD-04 — link simbólico, dono diferente, arquivo grande, vínculo extra, diretório gravável, ausente e arquivo especial são recusados', () => {
    const base = arquivoDe('PUBLICADOR', cred('PUBLICADOR'));
    const link = path.join(base.raiz, 'link.json');
    fs.symlinkSync(base.caminho, link);
    const dar = (caminho, extra = {}) => F.criarFornecedoresPorArquivo({ caminhos: { PUBLICADOR: caminho }, ...extra }).PUBLICADOR.obter({ papel: 'PUBLICADOR' });
    assert.equal(codigoDe(() => dar(link)), 'CREDENCIAL_ARQUIVO_INDISPONIVEL');
    assert.equal(codigoDe(() => dar(base.caminho, { uid: UID + 1 })), 'CREDENCIAL_ARQUIVO_INDISPONIVEL');
    const grande = gravar(path.join(base.raiz, 'grande.json'), `{${' '.repeat(F.LIMITE_ARQUIVO_BYTES + 10)}}`);
    assert.equal(codigoDe(() => dar(grande)), 'CREDENCIAL_ARQUIVO_INDISPONIVEL');
    fs.linkSync(base.caminho, path.join(base.raiz, 'outro-vinculo.json'));
    assert.equal(codigoDe(() => dar(base.caminho)), 'CREDENCIAL_ARQUIVO_INDISPONIVEL');
    const aberto = path.join(base.raiz, 'aberto');
    fs.mkdirSync(aberto, { mode: 0o700 });
    const dentro = gravar(path.join(aberto, 'c.json'), JSON.stringify(cred('PUBLICADOR')));
    fs.chmodSync(aberto, 0o770);
    assert.equal(codigoDe(() => dar(dentro)), 'CREDENCIAL_ARQUIVO_INDISPONIVEL');
    fs.chmodSync(aberto, 0o700);
    assert.equal(dar(dentro).accessKeyId, 'SWBTESTEPUB12345');
    assert.equal(codigoDe(() => dar(path.join(base.raiz, 'ausente.json'))), 'CREDENCIAL_ARQUIVO_INDISPONIVEL');
    assert.equal(codigoDe(() => dar('/dev/null')), 'CREDENCIAL_ARQUIVO_INDISPONIVEL');
  });

  test('CRD-05 — papel trocado: o pedido incoerente é recusado; arquivo de outro papel é recusado pelo conjunto', async () => {
    const pub = arquivoDe('PUBLICADOR', cred('PUBLICADOR'));
    assert.equal(codigoDe(() => pub.fornecedor.obter({ papel: 'VERIFICADOR' })), 'CREDENCIAL_PAPEL_INCOERENTE');
    assert.equal(codigoDe(() => pub.fornecedor.obter({ papel: 'PUBLICADOR', extra: 1 })), 'CREDENCIAL_PAPEL_INCOERENTE');
    assert.equal(codigoDe(() => pub.fornecedor.obter(undefined)), 'CREDENCIAL_PAPEL_INCOERENTE');
    const trocado = arquivoDe('PUBLICADOR', cred('VERIFICADOR'));
    const conjunto = criarConjuntoDeCredenciais({ acao: 'BACKUP', modo: 'ENSAIO', fornecedores: { PUBLICADOR: trocado.fornecedor }, relogio });
    assert.equal(await codigoAsync(conjunto.credenciais('PUBLICADOR')()), 'CREDENCIAL_DE_OUTRO_PAPEL');
  });

  test('CRD-06 — credencial sem o marcador sintético é recusada: chave, segredo, caixa, tamanho e posição do marcador', () => {
    const sem = (extra) => codigoDe(() => obter('PUBLICADOR', cred('PUBLICADOR', extra)));
    for (const extra of [
      { accessKeyId: 'EXEMPLOIDCHAVEPUB01' }, { accessKeyId: 'XSWBTESTEPUB12345' }, { accessKeyId: 'swbtestepub12345' }, { accessKeyId: 'SWBTESTE1234567' },
      { accessKeyId: `SWBTESTE${'A'.repeat(33)}` }, { accessKeyId: 'SWBTESTE-PUB12345' },
      { secretAccessKey: 'segredo-sem-marcador-0123456789' }, { secretAccessKey: 'swbteste-segredo-falso-0123' }, { secretAccessKey: 'SWBTESTEsegredo-falso-0123' },
      { secretAccessKey: 'SWBTESTE-curto' }, { secretAccessKey: ` ${SEGREDO}` },
    ]) {
      assert.equal(sem(extra), 'CREDENCIAL_SEM_MARCADOR_SINTETICO', JSON.stringify(extra));
    }
  });

  test('CRD-07 — identificadores no formato de chave AWS real são recusados como credencial real, mesmo com resto plausível', () => {
    for (const prefixo of ['ABIA', 'ACCA', 'AGPA', 'AIDA', 'AIPA', 'AKIA', 'ANPA', 'ANVA', 'APKA', 'AROA', 'ASCA', 'ASIA']) {
      const id = `${prefixo}IOSFODNN7EXAMPLE`;
      assert.equal(codigoDe(() => obter('PUBLICADOR', cred('PUBLICADOR', { accessKeyId: id }))), 'CREDENCIAL_REAL_NAO_AUTORIZADA', prefixo);
      assert.equal(codigoDe(() => obter('PUBLICADOR', cred('PUBLICADOR', { accessKeyId: id, secretAccessKey: SEGREDO }))), 'CREDENCIAL_REAL_NAO_AUTORIZADA', `${prefixo} com segredo sintético`);
    }
  });

  test('CRD-08 — token de sessão é proibido (mesmo válido); campo extra, campo ausente, JSON ruim e expiração fora do ISO são forma inválida', () => {
    const de = (conteudo) => codigoDe(() => obter('PUBLICADOR', conteudo));
    assert.equal(de(cred('PUBLICADOR', { sessionToken: 'sessao-falsa-0123456789' })), 'CREDENCIAL_TOKEN_DE_SESSAO_PROIBIDO');
    for (const ruim of [
      cred('PUBLICADOR', { extra: 'x' }), (({ papel, ...resto }) => resto)(cred('PUBLICADOR')), (({ accessKeyId, ...resto }) => resto)(cred('PUBLICADOR')),
      cred('PUBLICADOR', { expiration: '2027-01-01' }), cred('PUBLICADOR', { expiration: 1893456000000 }), cred('PUBLICADOR', { expiration: '2027-13-45T00:00:00Z' }),
      { ...cred('PUBLICADOR'), papel: 3 }, '{', '[]', '"x"', 'null',
    ]) {
      assert.equal(de(ruim), 'CREDENCIAL_FORMA_INVALIDA', typeof ruim === 'string' ? ruim : JSON.stringify(ruim));
    }
  });

  test('CRD-09 — credencial expirada (inclusive dentro da margem) é recusada pelo conjunto', async () => {
    const mk = (expira) => criarConjuntoDeCredenciais({
      acao: 'BACKUP', modo: 'ENSAIO', relogio,
      fornecedores: { PUBLICADOR: arquivoDe('PUBLICADOR', cred('PUBLICADOR', { expiration: new Date(expira).toISOString().replace(/\.\d{3}Z$/, 'Z') })).fornecedor },
    });
    assert.equal(await codigoAsync(mk(AGORA - 1000).credenciais('PUBLICADOR')()), 'CREDENCIAL_EXPIRADA');
    assert.equal(await codigoAsync(mk(AGORA + 30000).credenciais('PUBLICADOR')()), 'CREDENCIAL_EXPIRADA');
    assert.equal(await codigoAsync(mk(AGORA + 3600000).credenciais('PUBLICADOR')()), null);
  });

  test('CRD-10 — sem cache: o arquivo é relido a cada pedido (a troca de credencial vale na hora)', () => {
    const a = arquivoDe('PUBLICADOR', cred('PUBLICADOR'));
    assert.equal(a.fornecedor.obter({ papel: 'PUBLICADOR' }).accessKeyId, 'SWBTESTEPUB12345');
    gravar(a.caminho, JSON.stringify(cred('PUBLICADOR', { accessKeyId: 'SWBTESTEOUTRA9999' })));
    assert.equal(a.fornecedor.obter({ papel: 'PUBLICADOR' }).accessKeyId, 'SWBTESTEOUTRA9999');
    gravar(a.caminho, JSON.stringify(cred('PUBLICADOR', { accessKeyId: 'AKIAIOSFODNN7EXAMPLE' })));
    assert.equal(codigoDe(() => a.fornecedor.obter({ papel: 'PUBLICADOR' })), 'CREDENCIAL_REAL_NAO_AUTORIZADA');
  });

  test('CRD-11 — nenhum erro ecoa valor, caminho ou conteúdo', () => {
    const segredos = ['SWBTESTE-NAO-PODE-APARECER', 'AKIAIOSFODNN7EXAMPLE', 'sessao-falsa-0123456789'];
    const casos = [
      cred('PUBLICADOR', { secretAccessKey: segredos[0], accessKeyId: 'SEMMARCADORXXXXXXXX' }), cred('PUBLICADOR', { accessKeyId: segredos[1] }),
      cred('PUBLICADOR', { sessionToken: segredos[2] }), `{${segredos[0]}`,
    ];
    for (const caso of casos) {
      const a = arquivoDe('PUBLICADOR', caso);
      let erro;
      try { a.fornecedor.obter({ papel: 'PUBLICADOR' }); } catch (e) { erro = e; }
      assert.ok(erro, 'deveria recusar');
      const texto = `${erro.message} ${erro.code} ${JSON.stringify(erro)} ${erro.stack.split('\n')[0]}`;
      for (const s of [...segredos, a.caminho, a.raiz]) assert.ok(!texto.includes(s), `${erro.code} ecoou ${s.slice(0, 10)}`);
    }
  });

  test('CRD-12 — construção fora da forma é FORNECEDOR_CONFIGURACAO_INVALIDA; fornecedores são distintos e congelados', () => {
    const raiz = novaRaiz();
    const p = (n) => path.join(raiz, `${n}.json`);
    for (const ruim of [
      undefined, null, [], {}, { caminhos: {} }, { caminhos: { OUTRO: p('a') } }, { caminhos: { PUBLICADOR: 'relativo.json' } }, { caminhos: { PUBLICADOR: p('a'), VERIFICADOR: p('a') } },
      { caminhos: { PUBLICADOR: p('a'), VERIFICADOR: p('A') } }, { caminhos: { PUBLICADOR: p('a') }, extra: 1 }, { caminhos: { PUBLICADOR: p('a') }, lerArquivo: 'x' }, { caminhos: { PUBLICADOR: p('a') }, uid: -1 },
    ]) {
      assert.equal(codigoDe(() => F.criarFornecedoresPorArquivo(ruim)), 'FORNECEDOR_CONFIGURACAO_INVALIDA', JSON.stringify(ruim));
    }
    const f = F.criarFornecedoresPorArquivo({ caminhos: { PUBLICADOR: p('a'), VERIFICADOR: p('b') } });
    assert.ok(Object.isFrozen(f) && Object.isFrozen(f.PUBLICADOR));
    assert.notEqual(f.PUBLICADOR, f.VERIFICADOR);
  });

  test('CRD-13 — leitor injetado: resposta fora da forma ou com falha é CREDENCIAL_ARQUIVO_INDISPONIVEL', () => {
    const raiz = novaRaiz();
    const f = (resposta) => F.criarFornecedoresPorArquivo({ caminhos: { PUBLICADOR: path.join(raiz, 'x.json') }, lerArquivo: () => resposta }).PUBLICADOR;
    for (const r of [undefined, null, { ok: false, codigo: 'ARQUIVO_INSEGURO' }, { ok: true, texto: 1 }]) {
      assert.equal(codigoDe(() => f(r).obter({ papel: 'PUBLICADOR' })), 'CREDENCIAL_ARQUIVO_INDISPONIVEL');
    }
    assert.equal(f({ ok: true, texto: JSON.stringify(cred('PUBLICADOR')) }).obter({ papel: 'PUBLICADOR' }).accessKeyId, 'SWBTESTEPUB12345');
  });
});
