'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarGrupoAcessoRoutes } = require('../../src/routes/grupo-acesso.routes');
const { criarGrupoAcessoController } = require('../../src/controllers/grupo-acesso.controller');

/** ETAPA B — Novo → Grupo: o grupo nasce vazio, da empresa da sessão, SEM permissão alguma pelo nome. */
describe('Gestão de Usuários — Novo Grupo (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [criarGrupoAcessoRoutes({ controller: criarGrupoAcessoController({ pool }), exigirSessao: exigirEmpresarial })] });
    master = await g.contaDaEmpresa(g.empresas.A);
  });
  after(async () => { if (g) await g.encerrar(); });
  const post = (c, corpo) => g.request(g.app).post('/api/grupos-acesso').set('Cookie', g.cookie(c)).send(corpo);

  test('cria na empresa da sessão, sem integrantes e sem nenhuma permissão (nem pelo nome "Almoxarifado"); auditoria; aparece no seletor do Novo Usuário', async () => {
    const r = await post(master, { nome: 'Almoxarifado', descricao: 'Estoque' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.grupo.id;
    assert.equal((await g.um('SELECT empresa_id FROM grupos_acesso WHERE id = $1', [id])).empresa_id, g.empresas.A);
    assert.equal((await g.um('SELECT count(*)::int AS n FROM usuarios WHERE grupo_acesso_id = $1', [id])).n, 0);
    for (const t of ['grupo_permissoes_recurso', 'grupo_permissoes_acao']) {
      assert.equal((await g.um(`SELECT count(*)::int AS n FROM ${t} WHERE grupo_acesso_id = $1`, [id])).n, 0, `${t}: nenhuma permissão automática`);
    }
    assert.equal((await g.um("SELECT count(*)::int AS n FROM logs_auditoria WHERE acao = 'GRUPO_ACESSO_CRIADO' AND referencia = $1", [String(id)])).n, 1);
    const lista = await g.request(g.app).get('/api/grupos-acesso?ativo=true').set('Cookie', g.cookie(master));
    assert.ok(lista.body.grupos.some((x) => x.id === id));
    const novo = await g.criar(master, g.corpoBase({ tipoConta: 'SUPERVISOR', grupoAcessoId: id }));
    assert.equal(novo.status, 201, JSON.stringify(novo.body));
  });

  test('nome obrigatório (400), duplicidade na empresa (409 GRUPO_NOME_EM_USO) e a mesma nome em outra empresa é aceito; ADMINISTRADOR não cria; outra empresa não vê', async () => {
    assert.equal((await post(master, { nome: '   ' })).status, 400);
    assert.equal((await post(master, { descricao: 'x' })).status, 400);
    assert.equal((await post(master, { nome: 'RH' })).status, 201);
    const dup = await post(master, { nome: 'rh' });
    assert.deepEqual([dup.status, dup.body.codigo], [409, 'GRUPO_NOME_EM_USO']);
    const masterB = await g.contaDaEmpresa(g.empresas.B);
    assert.equal((await post(masterB, { nome: 'RH' })).status, 201);
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    assert.equal((await post(adm, { nome: 'Outro' })).status, 403);
    const listaB = await g.request(g.app).get('/api/grupos-acesso').set('Cookie', g.cookie(masterB));
    assert.equal(listaB.body.grupos.some((x) => x.nome === 'Almoxarifado'), false);
  });
});
