'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { montarAmbienteGhe } = require('./helpers/ambiente-funcionario-ghe');

/**
 * S3 (RED) — `GET /api/funcionarios/ghes`: o seletor de GHE do formulário de funcionário.
 *
 * Contrato esperado:
 *   - autoridade: `employeeHistory.visualizar` (a mesma que carrega a lista de funcionários). Não exige
 *     `employeeGroups.visualizar` (Gestão de GHE) nem a ação IMPORTAR_FUNCIONARIOS; nenhuma permissão nova;
 *   - resposta `{ status: 'ok', ghes: [{ id, codigo, descricao }] }`, só GHEs ATIVOS da empresa da sessão, ordenados por
 *     código (nulos por último), depois descrição e id; `descricao` é o `nome` físico (a descrição operacional);
 *     nenhum setor, função, riscos ou coluna `descricao` legada.
 *
 * Hoje `/funcionarios/ghes` cai na rota `/funcionarios/:id` (id inválido): as falhas são de comportamento ausente.
 */

const ROTA = '/api/funcionarios/ghes';

describe('S3 — GET /funcionarios/ghes (seletor de GHE do formulário de funcionário)', () => {
  let amb;
  before(async () => { amb = await montarAmbienteGhe(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const listar = (usuarioId) => amb.como(usuarioId).get(ROTA);

  test('a rota existe e devolve { status, ghes } para quem tem employeeHistory.visualizar', async () => {
    const r = await listar(amb.usuarios.soVisualizar);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'ok');
    assert.ok(Array.isArray(r.body.ghes), 'ghes deveria ser uma lista');
  });

  test('autoridade: employeeHistory.visualizar basta; sem sessão 401; sem permissão, só Gestão de GHE ou só importação: 403', async () => {
    assert.equal((await listar(amb.usuarios.soVisualizar)).status, 200);
    assert.equal((await listar(amb.usuarios.master)).status, 200);
    assert.equal((await request(amb.app).get(ROTA)).status, 401);
    assert.equal((await listar(amb.usuarios.semPermissao)).status, 403);
    // employeeGroups.visualizar e a importação NÃO são a autoridade deste seletor: quem só tem elas não o carrega.
    assert.equal((await listar(amb.usuarios.soGrupos)).status, 403);
    assert.equal((await listar(amb.usuarios.soImportacao)).status, 403);
  });

  test('o seletor NÃO exige Gestão de GHE nem importação: quem só visualiza funcionários o carrega', async () => {
    const r = await listar(amb.usuarios.soVisualizar);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Premissa do cenário: esse usuário não tem nenhuma permissão de Gestão de GHE nem a ação de importação.
    const recursos = (await amb.pool.query('SELECT recurso FROM usuario_permissoes_recurso WHERE usuario_id = $1', [amb.usuarios.soVisualizar])).rows.map((x) => x.recurso);
    assert.deepEqual(recursos, ['employeeHistory']);
    assert.equal((await amb.pool.query('SELECT count(*)::int AS n FROM usuario_autorizacoes WHERE usuario_id = $1', [amb.usuarios.soVisualizar])).rows[0].n, 0);
  });

  test('só os GHEs ATIVOS da empresa da sessão: o inativo e os de outra empresa nunca aparecem', async () => {
    const r = await listar(amb.usuarios.soVisualizar);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.ghes.map((g) => g.id);
    assert.deepEqual([...ids].sort((a, b) => a - b), [amb.ghes.soldagem, amb.ghes.caldeiraria, amb.ghes.legado, amb.ghes.legado2].sort((a, b) => a - b));
    assert.equal(ids.includes(amb.ghes.encerrado), false);
    assert.equal(ids.includes(amb.ghes.outraEmpresa), false);
    const deB = await listar(amb.usuarios.masterB);
    assert.equal(deB.status, 200, JSON.stringify(deB.body));
    assert.deepEqual(deB.body.ghes.map((g) => g.id).sort((a, b) => a - b), [amb.ghes.outraEmpresa, amb.d.gheB].sort((a, b) => a - b));
  });

  test('ordem estável: por código (sem código por último), depois descrição e id; a mesma em chamadas repetidas', async () => {
    const primeira = await listar(amb.usuarios.soVisualizar);
    assert.equal(primeira.status, 200, JSON.stringify(primeira.body));
    assert.deepEqual(primeira.body.ghes.map((g) => g.id), [amb.ghes.caldeiraria, amb.ghes.soldagem, amb.ghes.legado, amb.ghes.legado2]);
    const segunda = await listar(amb.usuarios.soVisualizar);
    assert.deepEqual(segunda.body.ghes, primeira.body.ghes);
  });

  test('payload mínimo: só id, codigo e descricao (descricao = nome físico); GHE legado sem código vem com codigo nulo', async () => {
    const r = await listar(amb.usuarios.soVisualizar);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const ghe of r.body.ghes) assert.deepEqual(Object.keys(ghe).sort(), ['codigo', 'descricao', 'id'], JSON.stringify(ghe));
    const porId = new Map(r.body.ghes.map((g) => [g.id, g]));
    assert.deepEqual(porId.get(amb.ghes.soldagem), { id: amb.ghes.soldagem, codigo: 'GHE-020', descricao: 'Soldagem' });
    assert.deepEqual(porId.get(amb.ghes.legado), { id: amb.ghes.legado, codigo: null, descricao: 'GHE A' });
    const texto = JSON.stringify(r.body);
    for (const proibido of ['setor', 'funcao', 'riscos', 'empresa_id', 'empresaId', 'criado_em', 'atualizado_em', 'ativo']) assert.equal(texto.includes(`"${proibido}"`), false, proibido);
  });

  test('o seletor da importação continua como está (rota própria, mesma autoridade de antes)', async () => {
    const semImportacao = await amb.como(amb.usuarios.soVisualizar).get('/api/funcionarios/importacao/ghes');
    assert.equal(semImportacao.status, 403);
    const comImportacao = await amb.como(amb.usuarios.soImportacao).get('/api/funcionarios/importacao/ghes');
    assert.equal(comImportacao.status, 200);
  });
});
