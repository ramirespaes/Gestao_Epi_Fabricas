'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('express');
const { criarExigirPermissaoRecurso } = require('../../src/middleware/autorizacao');

const { montar } = require('./helpers/gestao-usuarios-app');
const { TOGGLES, PENDENCIAS } = require('../../src/rbac/toggles');

/** Modelo binário de acessos: ON/OFF pelo resultado efetivo; camadas internas escolhidas pelo servidor. */
const BASE = '/api/administracao/usuarios';
const IDS_REAIS = ['dashboard', 'historicoFuncionarios', 'cadastrarFuncionario', 'editarFuncionario', 'fichaEpi', 'entregasSolicitacao', 'gestaoGhe', 'analiseEstoque', 'operacoesEstoque', 'cadastrarProduto', 'entradaLote', 'registrarBaixa', 'importacaoFuncionarios', 'gestaoUsuarios', 'aprovarSolicitacoes', 'reprovarSolicitacoes', 'reportsAudit', 'reportsFiscal'];

describe('Gestão de Usuários — acessos ON/OFF (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => {
      const r = Router();
      const rec = (caminho, recurso, operacao) => r.get(caminho, exigirEmpresarial, criarExigirPermissaoRecurso({ pool }, recurso, operacao), (req, res) => res.json({ ok: true }));
      rec('/teste/dashboard', 'dashboard', 'visualizar');
      rec('/teste/ghe-ler', 'employeeGroups', 'visualizar');
      rec('/teste/ghe-criar', 'employeeGroups', 'criar');
      rec('/teste/ghe-editar', 'employeeGroups', 'editar');
      return [r];
    } });
    master = await g.contaDaEmpresa(g.empresas.A);
  });
  after(async () => { if (g) await g.encerrar(); });

  const lista = (c, id) => g.request(g.app).get(`${BASE}/${id}/acessos`).set('Cookie', g.cookie(c));
  const ligar = (c, id, toggle, ligado) => g.request(g.app).put(`${BASE}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const efetivas = async (email) => (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', g.deCookies(g.cookiesDe(await g.login(email, g.SENHA_PROVISORIA))))).body;
  const linhasRecurso = (id, recurso) => g.todos('SELECT * FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = $2', [id, recurso]);
  const estado = async (c, id, toggle) => (await lista(c, id)).body.acessos.toggles.find((t) => t.id === toggle).ligado;

  test('catálogo: só os acessos com enforcement real viram controle; os demais ficam como pendência explícita, sem toggle decorativo', async () => {
    const u = await g.usuarioPronto(master);
    const r = await lista(master, u.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.acessos.toggles.map((t) => t.id), IDS_REAIS);
    assert.deepEqual(TOGGLES.map((t) => t.id), IDS_REAIS);
    assert.equal(TOGGLES.length + PENDENCIAS.length, 26, 'os 19 acessos aprovados, os dois da decisão da SST, Entregas por solicitação, o Relatório — Auditoria, o Relatório — Fiscalização e Cadastrar/Editar Funcionário estão contabilizados');
    assert.deepEqual(r.body.acessos.pendencias.map((p) => p.id).sort(), PENDENCIAS.map((p) => p.id).sort());
    for (const id of ['relatorios', 'token']) {
      assert.equal((await ligar(master, u.id, id, true)).status, 404, `${id} sem enforcement real não é controlável`);
    }
    assert.ok(r.body.acessos.toggles.every((t) => t.ligado === false && t.fixo === false));
    assert.equal(JSON.stringify(r.body).includes('perfil_base'), false);
  });

  test('ON/OFF simples sem herança: liga com concessão individual, o backend reflete, e desligar remove a exceção (nada redundante)', async () => {
    const u = await g.usuarioPronto(master);
    const on = await ligar(master, u.id, 'dashboard', true);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.acesso.ligado, true);
    assert.equal((await efetivas(u.email)).recursos.dashboard.visualizar, true);
    assert.equal((await linhasRecurso(u.id, 'dashboard')).length, 1);
    const off = await ligar(master, u.id, 'dashboard', false);
    assert.equal(off.body.acesso.ligado, false);
    assert.equal((await linhasRecurso(u.id, 'dashboard')).length, 0, 'voltou ao herdado: sem exceção');
    assert.equal((await efetivas(u.email)).recursos.dashboard?.visualizar ?? false, false);
  });

  test('herdado do perfil: desligar usa bloqueio individual, religar remove a exceção; o servidor nega a rota quando OFF', async () => {
    await g.pool.query("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar) VALUES ($1, 'USUARIO', 'dashboard', true) ON CONFLICT DO NOTHING", [g.empresas.A]);
    const u = await g.usuarioPronto(master);
    assert.equal(await estado(master, u.id, 'dashboard'), true, 'ON herdado do perfil');
    assert.equal((await ligar(master, u.id, 'dashboard', true)).status, 200);
    assert.equal((await linhasRecurso(u.id, 'dashboard')).length, 0, 'já ON por herança: nenhuma exceção redundante');
    assert.equal((await ligar(master, u.id, 'dashboard', false)).body.acesso.ligado, false);
    const [linha] = await linhasRecurso(u.id, 'dashboard');
    assert.equal(linha.pode_visualizar, false);
    const cookie = g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
    assert.equal((await g.request(g.app).get('/api/teste/dashboard').set('Cookie', cookie)).status, 403, 'URL/API direta bloqueada');
    assert.equal((await ligar(master, u.id, 'dashboard', true)).body.acesso.ligado, true);
    assert.equal((await linhasRecurso(u.id, 'dashboard')).length, 0);
  });

  test('Gestão de GHE é só consulta: ligar concede visualizar e nunca criar nem editar', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal((await ligar(master, u.id, 'gestaoGhe', true)).body.acesso.ligado, true);
    const e = (await efetivas(u.email)).recursos.employeeGroups;
    assert.deepEqual([e.visualizar, e.criar, e.editar, e.excluir], [true, false, false, false]);
    const cookie = g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
    const status = async (caminho) => (await g.request(g.app).get(`/api/teste/${caminho}`).set('Cookie', cookie)).status;
    assert.deepEqual([await status('ghe-ler'), await status('ghe-criar'), await status('ghe-editar')], [200, 403, 403]);
  });

  test('Cadastrar Produto liga visualizar e criar e não mexe nas outras permissões de estoque', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal((await ligar(master, u.id, 'cadastrarProduto', true)).body.acesso.ligado, true);
    const p = await efetivas(u.email);
    assert.deepEqual([p.recursos.materials.visualizar, p.recursos.materials.criar, p.recursos.materials.editar], [true, true, false]);
    assert.equal(p.acoes.MOVIMENTAR_ESTOQUE ?? false, false, 'entrada/baixa seguem independentes');
    assert.equal(await estado(master, u.id, 'analiseEstoque'), false);
    assert.equal(await estado(master, u.id, 'operacoesEstoque'), false);
  });

  test('Gestão de Usuários é um acesso único (GERENCIAR_USUARIOS): concede, herda do perfil e bloqueia, sem exceção redundante', async () => {
    const u = await g.usuarioPronto(master);
    assert.equal((await ligar(master, u.id, 'gestaoUsuarios', true)).body.acesso.ligado, true);
    assert.equal((await efetivas(u.email)).acoes.GERENCIAR_USUARIOS, true);
    assert.equal((await ligar(master, u.id, 'gestaoUsuarios', false)).body.acesso.ligado, false);
    assert.equal((await g.todos("SELECT 1 FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = 'GERENCIAR_USUARIOS'", [u.id])).length, 0);
    assert.equal((await g.todos("SELECT 1 FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = 'GERENCIAR_USUARIOS'", [u.id])).length, 0);
  });

  test('persistência e auditoria: o estado volta igual numa nova leitura, auditoria só no que mudou e sem dados sensíveis', async () => {
    const u = await g.usuarioPronto(master);
    await ligar(master, u.id, 'fichaEpi', true);
    await ligar(master, u.id, 'fichaEpi', true);
    assert.equal(await estado(master, u.id, 'fichaEpi'), true);
    const aud = await g.todos("SELECT dados_novos FROM logs_auditoria WHERE acao = 'USUARIO_ACESSO_ALTERADO' AND referencia = $1", [String(u.id)]);
    assert.equal(aud.length, 1, 'repetir o mesmo estado não audita');
    assert.equal(/senha|token|hash/i.test(JSON.stringify(aud)), false);
  });

  test('autoridade e regras estruturais: só o MASTER escreve; MASTER é fixo; outra empresa e id inválido não passam', async () => {
    const u = await g.usuarioPronto(master);
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    const negado = await ligar(adm, u.id, 'dashboard', true);
    assert.deepEqual([negado.status, negado.body.codigo], [403, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER']);
    assert.equal((await lista(adm, u.id)).status, 200, 'quem administra usuários pode ler');
    const noMaster = await ligar(master, master.usuarioId, 'dashboard', false);
    assert.deepEqual([noMaster.status, noMaster.body.codigo], [409, 'USUARIO_MASTER_PERMISSOES_FIXAS']);
    const visao = await lista(master, master.usuarioId);
    assert.equal(visao.status, 200);
    assert.ok(visao.body.acessos.toggles.every((t) => t.fixo === true), 'MASTER: fixo, não é usuário comum');
    assert.equal((await ligar(await g.contaDaEmpresa(g.empresas.B), u.id, 'dashboard', true)).status, 404);
    assert.equal((await ligar(master, u.id, 'naoExiste', true)).status, 404);
    assert.equal((await g.request(g.app).put(`${BASE}/${u.id}/acessos/dashboard`).set('Cookie', g.cookie(master)).send({ ligado: 'sim' })).status, 400);
    assert.equal((await g.request(g.app).put(`${BASE}/${u.id}/acessos/dashboard`).set('Cookie', g.cookie(master)).send({ ligado: true, perfil: 'MASTER' })).status, 400);
    assert.equal((await g.request(g.app).get(`${BASE}/${u.id}/acessos`)).status, 401);
  });
});
