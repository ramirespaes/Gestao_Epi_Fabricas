'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarFuncionario } = require('./helpers/entrega-epi');
const { cpfFicticio } = require('../helpers/cpf-ficticio');
const { criarLgpdRoutes } = require('../../src/routes/lgpd.routes');
const { criarLgpdController } = require('../../src/controllers/lgpd.controller');
const { criarEmailGestaoRoutes } = require('../../src/routes/email-gestao.routes');
const { criarEmailGestaoController } = require('../../src/controllers/email-gestao.controller');
const { TIPOS } = require('../../src/email/templates');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * Bloco A1 — os dois toggles (privacidadeLgpd, gestaoEmail) protegem UMA rota real cada (GET /lgpd/resumo, GET /emails/resumo),
 * pelo RBAC existente: perfil (provisionamento do MASTER), grupo, exceção individual, bloqueio, autoridade de quem altera,
 * auditoria, isolamento por empresa e revogação na requisição seguinte. HTTP real contra PostgreSQL real em schema temporário.
 */
const LGPD = '/api/lgpd/resumo';
const EMAILS = '/api/emails/resumo';
const ACESSOS = '/api/administracao/usuarios';
const CHAVES_LGPD = ['controladora', 'encarregado', 'titulares']; // LGPD-1: o resumo passou a trazer o encarregado (DPO)
const CHAVES_EMAILS = ['canais', 'entrega', 'templates'];

describe('Privacidade e LGPD e Gestão de E-mails — toggles com efeito real (PostgreSQL real)', () => {
  let g;
  let masterA;
  let masterB;

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarLgpdRoutes({ controller: criarLgpdController({ pool }), exigirSessao: exigirEmpresarial, pool }),
      criarEmailGestaoRoutes({ controller: criarEmailGestaoController({ pool, emailConfig: { modo: 'desativado' } }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    masterA = await g.contaDaEmpresa(g.empresas.A);
    masterB = await g.contaDaEmpresa(g.empresas.B);
  });
  after(async () => { if (g) await g.encerrar(); });

  const get = (caminho, cookie) => g.request(g.app).get(caminho).set('Cookie', cookie);
  const acesso = (c, id, toggle, ligado) => g.request(g.app).put(`${ACESSOS}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const lista = (c, id) => g.request(g.app).get(`${ACESSOS}/${id}/acessos`).set('Cookie', g.cookie(c));
  const cookieDe = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const efetivas = async (cookie) => (await get('/api/auth/permissoes', cookie)).body;
  const auditorias = (empresaId, toggle) => g.todos("SELECT usuario_id, referencia, dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'USUARIO_ACESSO_ALTERADO' AND dados_novos->>'acesso' = $2 ORDER BY id", [empresaId, toggle]);

  test('401: sem sessão, os dois resumos são recusados antes de qualquer consulta', async () => {
    assert.equal((await g.request(g.app).get(LGPD)).status, 401);
    assert.equal((await g.request(g.app).get(EMAILS)).status, 401);
  });

  test('MASTER SEM provisionamento: 403 nos dois (a autoridade do MASTER vem só da linha de perfil; nada é presumido)', async () => {
    assert.equal((await get(LGPD, g.cookie(masterA))).status, 403);
    assert.equal((await get(EMAILS, g.cookie(masterA))).status, 403);
    const l = (await lista(masterA, masterA.usuarioId)).body.acessos.toggles;
    assert.deepEqual([l.find((t) => t.id === 'privacidadeLgpd').ligado, l.find((t) => t.id === 'gestaoEmail').ligado], [false, false]);
    assert.ok(l.every((t) => t.fixo === true), 'MASTER é fixo: a tela não oferece alteração');
  });

  test('MASTER provisionado: só visualizar em lgpd e emailsGestao; 200 nos dois, com dados reais da própria empresa', async () => {
    const r = await provisionamento.provisionar(g.pool, { empresaId: g.empresas.A, dryRun: false });
    assert.ok(r.inseridos.recursos.includes('lgpd') && r.inseridos.recursos.includes('emailsGestao'));
    for (const recurso of ['lgpd', 'emailsGestao']) {
      const l = await g.um("SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM permissoes_recurso WHERE empresa_id = $1 AND perfil = 'MASTER' AND recurso = $2", [g.empresas.A, recurso]);
      assert.deepEqual(l, { pode_visualizar: true, pode_criar: false, pode_editar: false, pode_excluir: false }, recurso);
    }
    await criarFuncionario(g.pool, g.empresas.A, { matricula: 'LGPD-1', cpf: cpfFicticio(9101) });
    await criarFuncionario(g.pool, g.empresas.A, { matricula: 'LGPD-2', cpf: cpfFicticio(9102) });
    await criarFuncionario(g.pool, g.empresas.A, { matricula: 'LGPD-3', cpf: cpfFicticio(9103), ativo: false });
    await criarFuncionario(g.pool, g.empresas.B, { matricula: 'LGPD-B', cpf: cpfFicticio(9104) });

    const lgpd = await get(LGPD, g.cookie(masterA));
    assert.equal(lgpd.status, 200, JSON.stringify(lgpd.body));
    assert.deepEqual(Object.keys(lgpd.body.resumo).sort(), CHAVES_LGPD);
    assert.deepEqual(lgpd.body.resumo.controladora, { razaoSocial: 'Empresa Alfa', cnpj: '11222333000181' });
    const funcionarios = await g.um("SELECT count(*)::int AS total, count(*) FILTER (WHERE situacao = 'ATIVO')::int AS ativos, count(*) FILTER (WHERE situacao = 'AFASTADO')::int AS afastados, count(*) FILTER (WHERE situacao = 'INATIVO')::int AS inativos FROM funcionarios WHERE empresa_id = $1", [g.empresas.A]);
    const usuarios = await g.um('SELECT count(*)::int AS total, count(*) FILTER (WHERE ativo)::int AS ativos FROM usuarios WHERE empresa_id = $1', [g.empresas.A]);
    assert.deepEqual(lgpd.body.resumo.titulares, { funcionarios, usuarios }, 'as contagens batem com o banco, só da empresa A');
    assert.deepEqual([funcionarios.total, funcionarios.ativos, funcionarios.inativos], [3, 2, 1]);
    const bruto = JSON.stringify(lgpd.body);
    for (const sensivel of ['cpf', 'nome', 'matricula', 'email', 'Trabalhador', 'LGPD-1']) assert.equal(bruto.includes(sensivel), false, `nenhum dado individual: ${sensivel}`);

    const emails = await get(EMAILS, g.cookie(masterA));
    assert.equal(emails.status, 200, JSON.stringify(emails.body));
    assert.deepEqual(Object.keys(emails.body.resumo).sort(), CHAVES_EMAILS);
    assert.deepEqual(emails.body.resumo.templates, Object.values(TIPOS).map((tipo) => ({ tipo })), 'catálogo real de templates, em código');
    assert.deepEqual(emails.body.resumo.canais, { almoxarifado: { configurado: false }, sst: { configurado: false } });
    assert.deepEqual(emails.body.resumo.entrega, { ativa: false });
    assert.equal(/enviad|falha|hoje|semana|destinatarios/i.test(JSON.stringify(emails.body)), false, 'nenhum indicador sem fonte confiável');
    await g.pool.query('UPDATE empresas SET email_sst = $2 WHERE id = $1', [g.empresas.A, 'sst@alfa.example.invalid']);
    const depois = await get(EMAILS, g.cookie(masterA));
    assert.deepEqual(depois.body.resumo.canais, { almoxarifado: { configurado: false }, sst: { configurado: true } });
    assert.equal(JSON.stringify(depois.body).includes('alfa.example'), false, 'o endereço nunca sai');
  });

  test('toggle LGPD ON/OFF num USUARIO: ON = 200 na rota e no /auth/permissoes; OFF = 403 na requisição seguinte com a MESMA sessão; o outro módulo não muda', async () => {
    const u = await g.usuarioPronto(masterA);
    const cookie = await cookieDe(u);
    assert.equal((await get(LGPD, cookie)).status, 403);
    const on = await acesso(masterA, u.id, 'privacidadeLgpd', true);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.acesso.ligado, true);
    assert.equal((await get(LGPD, cookie)).status, 200);
    assert.equal((await efetivas(cookie)).recursos.lgpd.visualizar, true);
    assert.equal((await get(EMAILS, cookie)).status, 403, 'E-mails continua fechado');
    assert.equal((await efetivas(cookie)).recursos.emailsGestao.visualizar, false);
    const off = await acesso(masterA, u.id, 'privacidadeLgpd', false);
    assert.equal(off.body.acesso.ligado, false);
    assert.equal((await get(LGPD, cookie)).status, 403, 'revogado com a sessão ainda aberta');
    assert.equal((await g.todos("SELECT 1 FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = 'lgpd'", [u.id])).length, 0, 'voltou ao herdado: sem exceção redundante');
  });

  test('toggle E-mails ON/OFF é independente: liga só emailsGestao, LGPD segue 403; OFF revoga na hora', async () => {
    const u = await g.usuarioPronto(masterA);
    const cookie = await cookieDe(u);
    assert.equal((await acesso(masterA, u.id, 'gestaoEmail', true)).body.acesso.ligado, true);
    assert.equal((await get(EMAILS, cookie)).status, 200);
    assert.equal((await get(LGPD, cookie)).status, 403);
    const l = (await lista(masterA, u.id)).body.acessos.toggles;
    assert.deepEqual([l.find((t) => t.id === 'gestaoEmail').ligado, l.find((t) => t.id === 'privacidadeLgpd').ligado], [true, false]);
    assert.equal((await acesso(masterA, u.id, 'gestaoEmail', false)).body.acesso.ligado, false);
    assert.equal((await get(EMAILS, cookie)).status, 403);
  });

  test('grupo concede; exceção individual negativa (toggle OFF) prevalece sobre o grupo; religar remove a exceção e volta a herdar', async () => {
    const grupo = (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [g.empresas.A, 'Grupo LGPD', masterA.usuarioId])).id;
    await g.pool.query('INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar) VALUES ($1, $2, $3, true)', [g.empresas.A, grupo, 'lgpd']);
    const u = await g.usuarioPronto(masterA, { grupoAcessoId: grupo });
    const cookie = await cookieDe(u);
    assert.equal((await get(LGPD, cookie)).status, 200, 'herdado do grupo');
    assert.equal((await get(EMAILS, cookie)).status, 403, 'o grupo concedeu só LGPD');
    assert.equal((await acesso(masterA, u.id, 'privacidadeLgpd', false)).body.acesso.ligado, false);
    const [linha] = await g.todos("SELECT pode_visualizar FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = 'lgpd'", [u.id]);
    assert.equal(linha.pode_visualizar, false, 'bloqueio individual explícito');
    assert.equal((await get(LGPD, cookie)).status, 403);
    assert.equal((await acesso(masterA, u.id, 'privacidadeLgpd', true)).body.acesso.ligado, true);
    assert.equal((await g.todos("SELECT 1 FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = 'lgpd'", [u.id])).length, 0, 'já ON pelo grupo: nenhuma exceção');
    assert.equal((await get(LGPD, cookie)).status, 200);
  });

  test('autoridade: ADMINISTRADOR (com ou sem GERENCIAR_USUARIOS) e USUARIO não ligam o toggle, nem o próprio; MASTER de outra empresa não alcança', async () => {
    const u = await g.usuarioPronto(masterA);
    const admSem = await g.contaDaEmpresa(g.empresas.A, 'ADMINISTRADOR');
    const admCom = await g.administradorAutorizado(g.empresas.A, masterA);
    const r1 = await acesso(admSem, u.id, 'privacidadeLgpd', true);
    assert.deepEqual([r1.status, r1.body.codigo], [403, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA']);
    const r2 = await acesso(admCom, u.id, 'privacidadeLgpd', true);
    assert.deepEqual([r2.status, r2.body.codigo], [403, 'PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER']);
    const proprio = await g.request(g.app).put(`${ACESSOS}/${u.id}/acessos/gestaoEmail`).set('Cookie', await cookieDe(u)).send({ ligado: true });
    assert.equal(proprio.status, 403, 'ninguém liga a própria autoridade');
    assert.equal((await acesso(masterB, u.id, 'gestaoEmail', true)).status, 404, 'outra empresa: não existe');
    assert.equal((await get(LGPD, await cookieDe(u))).status, 403);
    assert.equal((await get(EMAILS, await cookieDe(u))).status, 403);
    assert.equal((await g.todos("SELECT 1 FROM usuario_permissoes_recurso WHERE usuario_id = $1", [u.id])).length, 0, 'nada gravado');
  });

  test('isolamento: o resumo é sempre da empresa da sessão; MASTER de B provisionado vê só B', async () => {
    await provisionamento.provisionar(g.pool, { empresaId: g.empresas.B, dryRun: false });
    const b = await get(LGPD, g.cookie(masterB));
    assert.equal(b.status, 200);
    assert.equal(b.body.resumo.controladora.razaoSocial, 'Empresa Beta');
    assert.equal(b.body.resumo.titulares.funcionarios.total, 1);
    const a = await get(LGPD, g.cookie(masterA));
    assert.equal(a.body.resumo.controladora.razaoSocial, 'Empresa Alfa');
    assert.notEqual(a.body.resumo.titulares.funcionarios.total, b.body.resumo.titulares.funcionarios.total);
  });

  test('identidade com duas empresas: a permissão é do vínculo; concedida em A não vale em B, e a troca de empresa não a leva junto', async () => {
    const identidade = await g.portal.novaIdentidade();
    const usuarioA = await g.portal.vincular(identidade, g.empresas.A, 'USUARIO');
    const usuarioB = await g.portal.vincular(identidade, g.empresas.B, 'USUARIO');
    const global = await g.portal.entrar(identidade);
    const emA = await g.portal.selecionar(identidade, global, g.empresas.A);
    assert.equal((await acesso(masterA, usuarioA, 'privacidadeLgpd', true)).status, 200);
    assert.equal((await get(LGPD, g.cookie({ global, empresarial: emA }))).status, 200);
    const emB = await g.portal.selecionar(identidade, global, g.empresas.B);
    assert.equal((await get(LGPD, g.cookie({ global, empresarial: emB }))).status, 403, 'em B o vínculo não tem a permissão');
    assert.equal((await acesso(masterB, usuarioA, 'privacidadeLgpd', true)).status, 404, 'o MASTER de B não enxerga o vínculo de A');
    assert.equal((await acesso(masterB, usuarioB, 'privacidadeLgpd', true)).status, 200);
    assert.equal((await get(LGPD, g.cookie({ global, empresarial: emB }))).status, 200);
  });

  test('sessão encerrada: depois do logout, a mesma sessão recebe 401 mesmo com o toggle ligado', async () => {
    const u = await g.usuarioPronto(masterA);
    const cookie = await cookieDe(u);
    assert.equal((await acesso(masterA, u.id, 'gestaoEmail', true)).status, 200);
    assert.equal((await get(EMAILS, cookie)).status, 200);
    assert.equal((await g.request(g.app).post('/api/auth/global/logout').set('Cookie', cookie)).status, 200);
    assert.equal((await get(EMAILS, cookie)).status, 401);
  });

  test('auditoria: cada mudança real gera USUARIO_ACESSO_ALTERADO com o id do toggle; repetir o estado não audita; nada sensível', async () => {
    const u = await g.usuarioPronto(masterA);
    await acesso(masterA, u.id, 'privacidadeLgpd', true);
    await acesso(masterA, u.id, 'privacidadeLgpd', true);
    await acesso(masterA, u.id, 'gestaoEmail', true);
    const lgpd = await auditorias(g.empresas.A, 'privacidadeLgpd');
    const emails = await auditorias(g.empresas.A, 'gestaoEmail');
    assert.equal(lgpd.filter((a) => a.referencia === String(u.id)).length, 1);
    assert.equal(emails.filter((a) => a.referencia === String(u.id)).length, 1);
    const ultima = lgpd.find((a) => a.referencia === String(u.id));
    assert.equal(ultima.usuario_id, masterA.usuarioId);
    assert.deepEqual([ultima.dados_anteriores, ultima.dados_novos], [{ acesso: 'privacidadeLgpd', ligado: false }, { acesso: 'privacidadeLgpd', ligado: true }]);
    assert.equal(/senha|token|hash|cpf/i.test(JSON.stringify([...lgpd, ...emails])), false);
  });

  test('falha fechada: toggle inexistente, corpo inválido e campo extra são recusados sem gravar', async () => {
    const u = await g.usuarioPronto(masterA);
    assert.equal((await acesso(masterA, u.id, 'lgpdEditar', true)).status, 404);
    assert.equal((await g.request(g.app).put(`${ACESSOS}/${u.id}/acessos/privacidadeLgpd`).set('Cookie', g.cookie(masterA)).send({ ligado: 'sim' })).status, 400);
    assert.equal((await g.request(g.app).put(`${ACESSOS}/${u.id}/acessos/privacidadeLgpd`).set('Cookie', g.cookie(masterA)).send({ ligado: true, perfil: 'MASTER' })).status, 400);
    assert.equal((await g.todos('SELECT 1 FROM usuario_permissoes_recurso WHERE usuario_id = $1', [u.id])).length, 0);
    assert.equal((await get(LGPD, await cookieDe(u))).status, 403);
  });
});
