'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../src/services/token-imagem.service');
const catalogoRepo = require('../../src/repositories/token-catalogo.repository');
const atendimentoRepo = require('../../src/repositories/token-atendimento.repository');
const sqlCatalogo = require('../../src/repositories/sql/catalogo-token');
const catalogoService = require('../../src/services/token-catalogo.service');
const { gerarTokenSessao, hashTokenSessao } = require('../../src/security/token');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Autorização das imagens do tablet pelo catálogo — SEM banco. Prova a ESTRUTURA da consulta (predicados e parâmetros) e a LÓGICA de decisão do
 * serviço com repositórios simulados. Não prova a equivalência funcional da SQL com o catálogo: isso exige PostgreSQL autorizado (TIA-01 a TIA-11).
 */

const AUTORIZADO = sqlCatalogo.autorizadoNoCatalogo({ material: 'm', ghe: '$2' });
const TAMANHOS = sqlCatalogo.tamanhosDoMaterial({ material: 'm' });
const normaliza = (s) => s.replace(/\s+/g, ' ').trim();
const TOKEN = gerarTokenSessao();
const ATENDIMENTO = { empresa_id: 3, funcionario_id: 11, vencido: false, funcionario_ativo: true, anterior_a_reativacao: false };
const GHE = { ghe_id: 21, ghe_ativo: true };
const DADOS = { empresaId: 3, dispositivoId: 7, tokenAtendimento: TOKEN, origem: 'empresa', id: '5', variante: 'miniatura', versao: null };

function executorFalso(linhas = [{ autorizada: true }]) {
  const chamadas = [];
  return { chamadas, query: async (sql, params) => { chamadas.push({ sql, params }); return { rows: linhas }; } };
}

function poolFalso({ falhaEm = null } = {}) {
  const comandos = [];
  const client = { query: async (sql) => { comandos.push(sql); if (falhaEm === sql) throw new Error('falha simulada'); return { rows: [] }; }, release() { comandos.push('release'); } };
  return { comandos, connect: async () => client };
}

function preparar(t, { atendimento = ATENDIMENTO, ghe = GHE, autorizada = true, entrega } = {}) {
  const c = { atendimento: [], ghe: [], imagem: [], entregas: [] };
  t.mock.method(atendimentoRepo, 'buscarAbertoPorToken', async (_x, dados) => { c.atendimento.push(dados); return atendimento === null ? null : { ...atendimento }; });
  t.mock.method(catalogoRepo, 'buscarGheDoFuncionario', async (_x, dados) => { c.ghe.push(dados); return ghe; });
  t.mock.method(catalogoRepo, 'imagemAutorizada', async (_x, dados) => { c.imagem.push(dados); return autorizada; });
  const corpo = Buffer.from('webp');
  c.entrega = entrega ?? { obter: async (_p, dados) => { c.entregas.push(dados); return { corpo, tipo: 'image/webp', etag: '"x"', versao: 9 }; } };
  return c;
}

describe('[TIAU-R] imagemAutorizada — estrutura da consulta', () => {
  test('TIAU-R1 — uma única consulta EXISTS com os predicados do catálogo: ativo, exige_tamanho classificado, AUTORIZADO e a regra de grade com a MESMA expressão TAMANHOS', async () => {
    const ex = executorFalso();
    assert.equal(await catalogoRepo.imagemAutorizada(ex, { empresaId: 3, gheId: 21, origem: 'EMPRESA', imagemId: '5' }), true);
    assert.equal(ex.chamadas.length, 1);
    const sql = normaliza(ex.chamadas[0].sql);
    assert.ok(sql.startsWith('SELECT EXISTS ('), 'EXISTS');
    assert.ok(sql.includes('m.empresa_id = $1 AND m.ativo AND m.exige_tamanho IS NOT NULL'), 'critérios de listarMateriaisAutorizados');
    assert.ok(sql.includes(normaliza(AUTORIZADO)), 'o predicado AUTORIZADO existente, sem cópia');
    assert.ok(sql.includes(`(m.exige_tamanho IS NOT TRUE OR cardinality(${normaliza(TAMANHOS)}) > 0)`), 'regra de grade com a expressão TAMANHOS existente');
    assert.equal(/\b(INSERT|UPDATE|DELETE|LOCK|FOR UPDATE|FOR SHARE)\b/i.test(sql), false, 'só leitura');
    const proprio = sql.split(normaliza(AUTORIZADO)).join('').split(normaliza(TAMANHOS)).join('');
    assert.equal(/LIMIT|ORDER BY|JOIN|GROUP BY/i.test(proprio), false, 'não monta o catálogo (fora dos fragmentos reutilizados)');
    assert.deepEqual(ex.chamadas[0].params, [3, 21, '5']);
  });

  test('TIAU-R2 — o vínculo da imagem segue a origem: EMPRESA pela chave composta e ATIVA; PADRAO ativa; o id vai como parâmetro, nunca no texto', async () => {
    const empresa = executorFalso();
    await catalogoRepo.imagemAutorizada(empresa, { empresaId: 3, gheId: 21, origem: 'EMPRESA', imagemId: '9223372036854775807' });
    const sqlE = normaliza(empresa.chamadas[0].sql);
    assert.ok(sqlE.includes('m.imagem_empresa_id = $3::bigint') && sqlE.includes("ie.empresa_id = m.empresa_id AND ie.id = m.imagem_empresa_id AND ie.estado = 'ATIVA'"));
    assert.equal(sqlE.includes('imagem_padrao_id'), false);
    const padrao = executorFalso();
    await catalogoRepo.imagemAutorizada(padrao, { empresaId: 3, gheId: 21, origem: 'PADRAO', imagemId: '9223372036854775806' });
    const sqlP = normaliza(padrao.chamadas[0].sql);
    assert.ok(sqlP.includes('m.imagem_padrao_id = $3::bigint') && sqlP.includes('ip.id = m.imagem_padrao_id AND ip.ativo'));
    assert.equal(sqlP.includes('imagem_empresa_id'), false);
    for (const ex of [empresa, padrao]) assert.equal(ex.chamadas[0].sql.includes(ex.chamadas[0].params[2]), false, 'id só como parâmetro');
  });

  test('TIAU-R3 — o resultado é o booleano do EXISTS (verdadeiro só com true)', async () => {
    for (const [linhas, esperado] of [[[{ autorizada: true }], true], [[{ autorizada: false }], false], [[{ autorizada: null }], false]]) {
      assert.equal(await catalogoRepo.imagemAutorizada(executorFalso(linhas), { empresaId: 3, gheId: 21, origem: 'PADRAO', imagemId: '2' }), esperado);
    }
  });

  test('TIAU-R4 — identificador BIGINT: aceita 1 e 9223372036854775807; recusa o resto antes de consultar (zero, zeros à esquerda, acima do limite, número, nulo, sinal, notação)', async () => {
    for (const bom of ['1', '9223372036854775807']) assert.equal(await catalogoRepo.imagemAutorizada(executorFalso(), { empresaId: 3, gheId: 21, origem: 'EMPRESA', imagemId: bom }), true);
    for (const ruim of ['0', '007', '9223372036854775808', '99999999999999999999', '-1', '+1', '1e3', '1.0', ' 1', '', 5, 5n, null, undefined, {}]) {
      const ex = executorFalso();
      await assert.rejects(catalogoRepo.imagemAutorizada(ex, { empresaId: 3, gheId: 21, origem: 'EMPRESA', imagemId: ruim }), TypeError, String(ruim));
      assert.equal(ex.chamadas.length, 0, 'sem consulta');
    }
  });

  test('TIAU-R5 — empresa, GHE e origem inválidos são recusados antes de consultar', async () => {
    for (const dados of [{ empresaId: 0 }, { empresaId: '3' }, { gheId: -1 }, { gheId: null }, { origem: 'empresa' }, { origem: 'OUTRA' }, { origem: undefined }]) {
      const ex = executorFalso();
      await assert.rejects(catalogoRepo.imagemAutorizada(ex, { empresaId: 3, gheId: 21, origem: 'EMPRESA', imagemId: '5', ...dados }), TypeError);
      assert.equal(ex.chamadas.length, 0);
    }
  });

  test('TIAU-R6 — a seleção existente não foi tocada: o repositório segue exportando as duas funções anteriores', () => {
    assert.equal(typeof catalogoRepo.listarMateriaisAutorizados, 'function');
    assert.equal(typeof catalogoRepo.buscarGheDoFuncionario, 'function');
  });
});

describe('[TIAU-P] paridade lógica da regra de grade com montarCatalogoDoFuncionario', () => {
  test('TIAU-P1 — o catálogo mantém o material se e somente se `exige_tamanho !== true || tamanhos.length > 0`; é exatamente a regra que a SQL reproduz (3 casos: exige com grade, exige sem grade, não exige)', async (t) => {
    const linhas = [
      { id: 1, nome: 'a', unidade: 'un', categoria: 'EPI', grupo_protecao: null, tipo: null, tipo_material_id: null, exige_tamanho: true, tamanhos: ['P', 'M'], imagem_origem: null, imagem_id: null, imagem_versao: null },
      { id: 2, nome: 'b', unidade: 'un', categoria: 'EPI', grupo_protecao: null, tipo: null, tipo_material_id: null, exige_tamanho: true, tamanhos: [], imagem_origem: null, imagem_id: null, imagem_versao: null },
      { id: 3, nome: 'c', unidade: 'un', categoria: 'EPI', grupo_protecao: null, tipo: null, tipo_material_id: null, exige_tamanho: false, tamanhos: [], imagem_origem: null, imagem_id: null, imagem_versao: null },
    ];
    t.mock.method(catalogoRepo, 'buscarGheDoFuncionario', async () => GHE);
    t.mock.method(catalogoRepo, 'listarMateriaisAutorizados', async () => linhas);
    const r = await catalogoService.montarCatalogoDoFuncionario({}, { empresaId: 3, funcionarioId: 11 });
    const noCatalogo = r.materiais.map((m) => m.id);
    // Modelo da condição SQL `(exige IS NOT TRUE OR cardinality(tamanhos) > 0)` com exige não nulo.
    const pelaCondicaoSql = linhas.filter((m) => m.exige_tamanho !== true || m.tamanhos.length > 0).map((m) => m.id);
    assert.deepEqual(noCatalogo, [1, 3]);
    assert.deepEqual(pelaCondicaoSql, noCatalogo);
  });
});

describe('[TIAU-S] autorizarPeloCatalogo / obter — serviço', () => {
  test('TIAU-S1 — autorizada: lê atendimento, GHE e imagem numa transação READ ONLY REPEATABLE READ, só leitura, e entrega com os dados do servidor', async (t) => {
    const c = preparar(t);
    const pool = poolFalso();
    const r = await service.obter(pool, DADOS, { entrega: c.entrega });
    assert.deepEqual([r.corpo.toString(), r.tipo], ['webp', 'image/webp']);
    assert.deepEqual(Object.keys(r).sort(), ['corpo', 'tipo']);
    assert.deepEqual(pool.comandos, ['BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ', 'COMMIT', 'release']);
    assert.deepEqual(c.atendimento, [{ empresaId: 3, dispositivoId: 7, tokenHash: hashTokenSessao(TOKEN) }]);
    assert.deepEqual(c.ghe, [{ empresaId: 3, funcionarioId: 11 }]);
    assert.deepEqual(c.imagem, [{ empresaId: 3, gheId: 21, origem: 'EMPRESA', imagemId: '5' }]);
    assert.deepEqual(c.entregas, [{ empresaId: 3, origem: 'empresa', id: '5', variante: 'miniatura' }]);
  });

  test('TIAU-S2 — a origem da rota é convertida para a do catálogo (padrao → PADRAO)', async (t) => {
    const c = preparar(t);
    await service.obter(poolFalso(), { ...DADOS, origem: 'padrao', id: '9223372036854775807' }, { entrega: c.entrega });
    assert.deepEqual([c.imagem[0].origem, c.imagem[0].imagemId], ['PADRAO', '9223372036854775807']);
  });

  test('TIAU-S3 — imagem não autorizada: 404 IMAGEM_NAO_ENCONTRADA e NENHUMA entrega', async (t) => {
    const c = preparar(t, { autorizada: false });
    await assert.rejects(service.obter(poolFalso(), DADOS, { entrega: c.entrega }), (e) => e.status === 404 && e.codigo === 'IMAGEM_NAO_ENCONTRADA');
    assert.equal(c.entregas.length, 0);
  });

  test('TIAU-S4 — atendimento inexistente, vencido, de funcionário inativo ou anterior à reativação: 401 ATENDIMENTO_INVALIDO, sem consultar GHE nem imagem e sem entrega', async (t) => {
    const casos = [null, { ...ATENDIMENTO, vencido: true }, { ...ATENDIMENTO, funcionario_ativo: false }, { ...ATENDIMENTO, anterior_a_reativacao: true }];
    for (const atendimento of casos) {
      const c = preparar(t, { atendimento });
      await assert.rejects(service.obter(poolFalso(), DADOS, { entrega: c.entrega }), (e) => e.status === 401 && e.codigo === 'ATENDIMENTO_INVALIDO');
      assert.deepEqual([c.ghe.length, c.imagem.length, c.entregas.length], [0, 0, 0]);
      t.mock.restoreAll();
    }
  });

  test('TIAU-S5 — token de atendimento ausente, malformado ou vazio: 401 sem abrir transação', async (t) => {
    const c = preparar(t);
    for (const tokenAtendimento of [null, undefined, '', 'nao-e-um-token', 123]) {
      const pool = poolFalso();
      await assert.rejects(service.obter(pool, { ...DADOS, tokenAtendimento }, { entrega: c.entrega }), (e) => e.status === 401 && e.codigo === 'ATENDIMENTO_INVALIDO');
      assert.deepEqual(pool.comandos, []);
    }
    assert.equal(c.atendimento.length, 0);
  });

  test('TIAU-S6 — funcionário sem GHE ou com GHE inativo: 404, sem consultar a imagem e sem entrega', async (t) => {
    for (const ghe of [null, { ghe_id: null, ghe_ativo: null }, { ghe_id: 21, ghe_ativo: false }]) {
      const c = preparar(t, { ghe });
      await assert.rejects(service.obter(poolFalso(), DADOS, { entrega: c.entrega }), (e) => e.status === 404 && e.codigo === 'IMAGEM_NAO_ENCONTRADA');
      assert.deepEqual([c.imagem.length, c.entregas.length], [0, 0]);
      t.mock.restoreAll();
    }
  });

  test('TIAU-S7 — isolamento por empresa: o GHE e a imagem são consultados com a empresa do ATENDIMENTO (do servidor), e o atendimento é buscado com a empresa e o tablet da credencial', async (t) => {
    const c = preparar(t, { atendimento: { ...ATENDIMENTO, empresa_id: 3 } });
    await service.obter(poolFalso(), { ...DADOS, empresaId: 3 }, { entrega: c.entrega });
    assert.equal(c.atendimento[0].empresaId, 3);
    assert.equal(c.ghe[0].empresaId, 3);
    assert.equal(c.imagem[0].empresaId, 3);
    const outra = preparar(t, { atendimento: null });
    await assert.rejects(service.obter(poolFalso(), { ...DADOS, empresaId: 4 }, { entrega: outra.entrega }), (e) => e.status === 401);
    assert.equal(outra.atendimento[0].empresaId, 4, 'atendimento de outra empresa não é encontrado: o repositório filtra por empresa e tablet');
  });

  test('TIAU-S8 — identificador ou origem inválidos: 404 sem abrir transação (o navegador nunca autoriza por id)', async (t) => {
    const c = preparar(t);
    for (const dados of [{ id: '0' }, { id: '007' }, { id: '9223372036854775808' }, { id: 5 }, { id: null }, { origem: 'EMPRESA' }, { origem: 'x' }]) {
      const pool = poolFalso();
      await assert.rejects(service.obter(pool, { ...DADOS, ...dados }, { entrega: c.entrega }), (e) => e.status === 404 && e.codigo === 'IMAGEM_NAO_ENCONTRADA');
      assert.deepEqual(pool.comandos, []);
    }
    assert.equal(c.entregas.length, 0);
  });

  test('TIAU-S9 — falha na leitura da autorização: ROLLBACK, o erro original propaga e não há entrega; a conexão é sempre liberada', async (t) => {
    const c = preparar(t);
    t.mock.method(catalogoRepo, 'imagemAutorizada', async () => { throw new Error('banco caiu'); });
    const pool = poolFalso();
    await assert.rejects(service.obter(pool, DADOS, { entrega: c.entrega }), /banco caiu/);
    assert.deepEqual(pool.comandos, ['BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ', 'ROLLBACK', 'release']);
    assert.equal(c.entregas.length, 0);
  });

  test('TIAU-S10 — os erros do serviço de entrega propagam SEM conversão: 404, 503 e 500', async (t) => {
    for (const erro of [HttpError.notFound('IMAGEM_NAO_ENCONTRADA', 'Imagem não encontrada'), new HttpError(503, 'IMAGENS_INDISPONIVEL', 'Imagens indisponíveis'), HttpError.internal(new Error('disco'))]) {
      const c = preparar(t, { entrega: { obter: async () => { throw erro; } } });
      await assert.rejects(service.obter(poolFalso(), DADOS, { entrega: c.entrega }), (e) => e === erro);
      t.mock.restoreAll();
    }
  });

  test('TIAU-S11 — sem serviço de entrega configurado a autorização acontece e a entrega responde 503 IMAGENS_INDISPONIVEL (nada sai)', async (t) => {
    const c = preparar(t);
    await assert.rejects(service.obter(poolFalso(), DADOS, {}), (e) => e.status === 503 && e.codigo === 'IMAGENS_INDISPONIVEL');
    assert.equal(c.imagem.length, 1);
  });

  test('TIAU-S12 — a injeção de `autorizar` substitui o padrão (os repositórios não são tocados) e a negativa dele impede a entrega', async (t) => {
    const c = preparar(t);
    const recebidos = [];
    const autorizar = async (_p, dados) => { recebidos.push(dados); throw HttpError.notFound('IMAGEM_NAO_ENCONTRADA', 'Imagem não encontrada'); };
    await assert.rejects(service.obter(poolFalso(), DADOS, { autorizar, entrega: c.entrega }), (e) => e.status === 404);
    assert.deepEqual(recebidos, [{ empresaId: 3, dispositivoId: 7, tokenAtendimento: TOKEN, origem: 'empresa', id: '5', variante: 'miniatura' }]);
    assert.deepEqual([c.atendimento.length, c.entregas.length], [0, 0]);
  });
});
