'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarRestauradorL2 } = require('../../src/services/backup-executor-restaurador-l2.service');
const D = require('../../src/services/backup-fontes-dr.service');

/** D-ORF-6, L1 (Bloco B): adaptador `restaurador` L2 com composição de restauração falsa; nada de processo, banco ou arquivo. */

const RAIZ = '/var/safework/publicados';
const PACOTE = `${RAIZ}/l2-${'a'.repeat(32)}`;
const DESTINO = { banco: 'gepi_hom_dest', host: 'db.exemplo', porta: 5432, usuario: 'u', arquivoDeSenha: '/x/pgpass' };
const IMAGENS = { raiz: '/var/safework/restaurado', nome: 'imagens-novo' };
const BOM = () => ({ restauracao: { ok: true, layout: 2, banco: { ok: true }, esquema: { relacao: 'IGUAL' }, veredito: { classe: 'INTEGRO', motivos: [], recuperavelEmProducao: false, restauracaoReal: false } } });
const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
let t = 1_800_000_000_000;
const mk = (extra = {}) => criarRestauradorL2({ restauracao: { restaurar: async () => BOM() }, raizAutorizada: RAIZ, destino: DESTINO, imagens: IMAGENS, maxBytesPorArquivo: 1024, relogio: () => (t += 50), ...extra });

describe('[REST-L2] adaptador restaurador', () => {
  test('RL2-01 — configuração estrita', () => {
    assert.equal(codigo(() => mk({ extra: 1 })), 'RESTAURADOR_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk({ raizAutorizada: 'rel' })), 'RESTAURADOR_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk({ imagens: { raiz: '/x', nome: '../y' } })), 'RESTAURADOR_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk({ maxBytesPorArquivo: 0 })), 'RESTAURADOR_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk({ relogio: null })), 'RESTAURADOR_L2_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => criarRestauradorL2({ restauracao: { restaurar() {} } })), 'RESTAURADOR_L2_CONFIGURACAO_INVALIDA');
  });

  test('RL2-02 — sucesso: chama a composição com layout 2, destino e imagens do chamador; devolve cinco passos aceitos pelo DR', async () => {
    let visto;
    const T0 = t;
    const r = mk({ restauracao: { restaurar: async (e) => { visto = e; return BOM(); } } });
    const x = await r.restaurar({ pacote: PACOTE, lido: {} });
    assert.equal(x.ok, true);
    assert.deepEqual(visto, { raizAutorizada: RAIZ, nome: path.basename(PACOTE), imagens: IMAGENS, destino: DESTINO, layoutMinimo: 2, maxBytesPorArquivo: 1024 });
    assert.deepEqual(x.passos.map((p) => p.id), ['BANCO', 'ESQUEMA', 'ARQUIVOS_POR_FONTE', 'CONCILIACAO', 'VEREDITO']);
    const base = new Date(T0).toISOString();
    const plano = D.planejarEnsaioDeDR({ ultimoBackupEm: base, agora: base, alvos: { rpoMs: 1000, rtoMs: 100000 } });
    const medidos = [['DECIFRAR', T0 - 20, T0 - 10], ['VERIFICACOES_8_7', T0 - 10, T0]].map(([id, a, b]) => ({ id, ok: true, inicioEm: new Date(a).toISOString(), fimEm: new Date(b).toISOString() }));
    const av = D.avaliarEnsaioDeDR({ plano, passos: [...medidos, ...x.passos], restauracao: x.restauracao });
    assert.equal(av.classe, 'RECUPERADO');
    assert.equal(av.recuperavelEmProducao, false);
    assert.equal(av.restauracaoReal, false);
  });

  test('RL2-03 — pacote fora da raiz, em subdiretório, relativo ou pedido com chave extra: recusado sem chamar a composição', async () => {
    let n = 0;
    const r = mk({ restauracao: { restaurar: async () => { n += 1; return BOM(); } } });
    assert.equal((await r.restaurar({ pacote: '/outra/raiz/l2-x', lido: {} })).codigo, 'RESTAURADOR_PACOTE_FORA_DA_RAIZ');
    assert.equal((await r.restaurar({ pacote: `${PACOTE}/sub`, lido: {} })).codigo, 'RESTAURADOR_PACOTE_FORA_DA_RAIZ');
    assert.equal((await r.restaurar({ pacote: 'rel/l2', lido: {} })).codigo, 'RESTAURADOR_PEDIDO_INVALIDO');
    assert.equal((await r.restaurar({ pacote: PACOTE, lido: {}, extra: 1 })).codigo, 'RESTAURADOR_PEDIDO_INVALIDO');
    assert.equal((await r.restaurar(null)).codigo, 'RESTAURADOR_PEDIDO_INVALIDO');
    assert.equal(n, 0);
  });

  test('RL2-04 — falhas da composição e resultados que não provam a restauração viram código fixo', async () => {
    const com = (retorno) => mk({ restauracao: { restaurar: async () => (typeof retorno === 'function' ? retorno() : retorno) } });
    const pedido = { pacote: PACOTE, lido: {} };
    const falha = async (r) => (await r.restaurar(pedido)).codigo;
    const b = BOM;
    const mut = (f) => { const x = b(); f(x.restauracao); return x; };
    assert.equal(await falha(com(() => { throw new Error('SENHA'); })), 'RESTAURADOR_COMPOSICAO_FALHOU');
    assert.equal(await falha(com({})), 'RESTAURADOR_RESULTADO_INVALIDO');
    assert.equal(await falha(com(mut((r) => { r.layout = 1; }))), 'RESTAURADOR_RESULTADO_INVALIDO');
    assert.equal(await falha(com(mut((r) => { r.ok = false; }))), 'RESTAURADOR_RESTAURACAO_FALHOU');
    assert.equal(await falha(com(mut((r) => { r.banco = { ok: false }; }))), 'RESTAURADOR_BANCO_NAO_RESTAURADO');
    assert.equal(await falha(com(mut((r) => { r.esquema = { relacao: 'DIVERGENTE' }; }))), 'RESTAURADOR_ESQUEMA_DIVERGENTE');
    assert.equal(await falha(com(mut((r) => { r.veredito = { classe: 'INCONSISTENTE' }; }))), 'RESTAURADOR_VEREDITO_NAO_INTEGRO');
    assert.equal(await falha(com(mut((r) => { r.veredito = { classe: 'INTEGRO', recuperavelEmProducao: true }; }))), 'RESTAURADOR_VEREDITO_NAO_INTEGRO');
  });

  test('RL2-05 — relógio inválido é recusado; o módulo não cria processo, não escreve, não lê ambiente nem rede', async () => {
    assert.equal((await mk({ relogio: () => 'x' }).restaurar({ pacote: PACOTE, lido: {} })).codigo, 'RESTAURADOR_RELOGIO_INVALIDO');
    const fonte = fs.readFileSync(path.join(__dirname, '../../src/services/backup-executor-restaurador-l2.service.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const padrao of [/\bwriteFile/, /\bappendFile/, /createWriteStream/, /\bunlink/, /\brmSync|\brm\(/, /\brename/, /\bmkdir/, /child_process/, /\bspawn|\bexec(?:File)?\b/, /process\.env/, /\bfetch\(/, /node:(?:http|https|net|dns)/, /require\('node:fs'\)/, /OPERACAO_HABILITADA/]) assert.doesNotMatch(fonte, padrao, String(padrao));
  });
});
