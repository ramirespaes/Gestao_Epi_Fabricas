'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');

/** Permissões do GRUPO como acessos ON/OFF: reaproveitam grupo_permissoes_* e o serviço existente. */
const IDS_GRUPO = ['dashboard', 'historicoFuncionarios', 'cadastrarFuncionario', 'editarFuncionario', 'fichaEpi', 'entregasSolicitacao', 'gestaoGhe', 'analiseEstoque', 'operacoesEstoque', 'cadastrarProduto', 'entradaLote', 'registrarBaixa', 'importacaoFuncionarios', 'reportsAudit', 'reportsFiscal'];

describe('Gestão de Usuários — permissões do grupo ON/OFF (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao: exigirEmpresarial }),
    ] });
    master = await g.contaDaEmpresa(g.empresas.A);
  });
  after(async () => { if (g) await g.encerrar(); });

  let n = 0;
  const novoGrupo = async (empresaId = g.empresas.A, criador = master.usuarioId) => {
    n += 1;
    return (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [empresaId, `Grupo ${n}`, criador])).id;
  };
  const lista = (c, id) => g.request(g.app).get(`/api/grupos-acesso/${id}/acessos`).set('Cookie', g.cookie(c));
  const ligar = (c, id, toggle, ligado) => g.request(g.app).put(`/api/grupos-acesso/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const estado = async (grupo, toggle) => (await lista(master, grupo)).body.acessos.toggles.find((t) => t.id === toggle).ligado;
  const efetivas = async (u) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA))))).body;

  test('lista só os acessos que o grupo pode conceder (sem Gestão de Usuários, que exige concessão individual), todos OFF no grupo novo', async () => {
    const grupo = await novoGrupo();
    const r = await lista(master, grupo);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.acessos.toggles.map((t) => t.id), IDS_GRUPO);
    assert.ok(r.body.acessos.toggles.every((t) => t.ligado === false));
    assert.equal(r.body.acessos.grupo.id, grupo);
    assert.equal((await ligar(master, grupo, 'gestaoUsuarios', true)).status, 404);
  });

  test('ON concede aos integrantes do grupo (menu/API), OFF retira a opinião (null) e persiste', async () => {
    const grupo = await novoGrupo();
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    assert.equal((await efetivas(u)).recursos.dashboard?.visualizar ?? false, false);
    assert.equal((await ligar(master, grupo, 'dashboard', true)).body.acesso.ligado, true);
    assert.equal((await efetivas(u)).recursos.dashboard.visualizar, true, 'o integrante recebe pelo grupo');
    assert.equal(await estado(grupo, 'dashboard'), true, 'persiste');
    assert.equal((await ligar(master, grupo, 'dashboard', false)).body.acesso.ligado, false);
    assert.equal((await efetivas(u)).recursos.dashboard?.visualizar ?? false, false);
    const linha = await g.um("SELECT pode_visualizar FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = 'dashboard'", [grupo]);
    assert.notEqual(linha?.pode_visualizar, false, 'OFF nunca grava false (que bloquearia o que o perfil permite)');
  });

  test('OFF no grupo não derruba o que o perfil já concede', async () => {
    await g.pool.query("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar) VALUES ($1, 'SUPERVISOR', 'epiFicha', true) ON CONFLICT DO NOTHING", [g.empresas.A]);
    const grupo = await novoGrupo();
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo, tipoConta: 'SUPERVISOR' });
    await ligar(master, grupo, 'fichaEpi', true);
    await ligar(master, grupo, 'fichaEpi', false);
    assert.equal((await efetivas(u)).recursos.epiFicha.visualizar, true, 'o perfil continua concedendo');
  });

  test('ações do estoque e da importação: ligar concede a ação ao grupo e a leitura de materiais; desligar mexe só na regra própria', async () => {
    const grupo = await novoGrupo();
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupo });
    await ligar(master, grupo, 'entradaLote', true);
    await ligar(master, grupo, 'importacaoFuncionarios', true);
    let p = await efetivas(u);
    assert.deepEqual([p.acoes.ENTRADA_ESTOQUE, p.acoes.BAIXA_ESTOQUE, p.acoes.IMPORTAR_FUNCIONARIOS], [true, false, true], 'uma ação não concede a outra');
    assert.equal(p.recursos.materials.visualizar, true, 'dependência de leitura');
    assert.equal(p.recursos.materials.criar, false);
    await ligar(master, grupo, 'cadastrarProduto', true);
    await ligar(master, grupo, 'cadastrarProduto', false);
    p = await efetivas(u);
    assert.deepEqual([p.recursos.materials.visualizar, p.recursos.materials.criar, p.acoes.ENTRADA_ESTOQUE], [true, false, true]);
    await ligar(master, grupo, 'entradaLote', false);
    assert.equal((await efetivas(u)).acoes.ENTRADA_ESTOQUE, false);
  });

  test('autoridade e isolamento: só quem administra permissões de grupo; outra empresa e grupo inexistente = 404; corpo estrito', async () => {
    const grupo = await novoGrupo();
    const semAutoridade = await g.usuarioPronto(master);
    const cookieSem = { ...semAutoridade, cookies: null };
    const r = await g.request(g.app).put(`/api/grupos-acesso/${grupo}/acessos/dashboard`).set('Cookie', g.deCookies(g.cookiesDe(await g.login(cookieSem.email, g.SENHA_PROVISORIA)))).send({ ligado: true });
    assert.equal(r.status, 403);
    const empresaB = await g.contaDaEmpresa(g.empresas.B);
    assert.equal((await lista(empresaB, grupo)).status, 404, 'grupo de outra empresa não existe para B');
    assert.equal((await ligar(empresaB, grupo, 'dashboard', true)).status, 404);
    assert.equal((await lista(master, 999999)).status, 404);
    assert.equal((await ligar(master, grupo, 'naoExiste', true)).status, 404);
    assert.equal((await g.request(g.app).put(`/api/grupos-acesso/${grupo}/acessos/dashboard`).set('Cookie', g.cookie(master)).send({ ligado: 'sim' })).status, 400);
    assert.equal((await g.request(g.app).get(`/api/grupos-acesso/${grupo}/acessos`)).status, 401);
  });

  test('auditoria: a mudança entra na trilha existente do grupo, sem dados sensíveis', async () => {
    const grupo = await novoGrupo();
    await ligar(master, grupo, 'dashboard', true);
    const aud = await g.todos('SELECT acao, dados_novos FROM logs_auditoria WHERE referencia = $1', [String(grupo)]);
    assert.ok(aud.some((a) => /GRUPO_PERMISSAO/.test(a.acao)), JSON.stringify(aud));
    assert.equal(/senha|token|hash/i.test(JSON.stringify(aud)), false);
  });
});
