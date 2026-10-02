'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarSessaoAdministrativa } = require('./helpers/sessao-plataforma-teste');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarConviteUsuarioController } = require('../../src/controllers/convite-usuario.controller');
const { criarConviteUsuarioRoutes } = require('../../src/routes/convite-usuario.routes');
const { criarConviteMasterController } = require('../../src/controllers/convite-master.controller');
const { criarConviteMasterRoutes } = require('../../src/routes/convite-master.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarInicial } = require('../../src/services/administrador-plataforma.service');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const { httpConfig } = require('../../src/config/http');

/**
 * Isolamento Portal x Plataforma no envio de convites (Bloco 11H), com os dois
 * conjuntos de rotas no mesmo app e PostgreSQL real: a sessão do Portal não
 * abre rota do Painel Privado e vice-versa, o token de um convite não serve no
 * outro, ids iguais em tabelas diferentes não se confundem, as trilhas de
 * auditoria são separadas e cada link aponta para a origem do seu portal.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 56 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-do-isolamento-2026';
const SENHA_ADMIN = 'planeta-nebulosa-ozonio-42';
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;

const tokenDoLink = (link) => new URLSearchParams(new URL(link).hash.slice(1)).get('token');

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

describe('Bloco 11H — isolamento Portal x Plataforma no envio de convites (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let cookiePortal;
  let cookieAdmin;
  let empresaId;
  let conviteUsuario;
  let conviteMaster;

  const q = (sql, params) => pool.query(sql, params);
  const doPortal = (req) => req.set('Cookie', cookiePortal);
  const doAdmin = (req) => req.set('Cookie', cookieAdmin);
  const envelhecer = async () => {
    await q("UPDATE convites_usuario SET criado_em = criado_em - interval '3 minutes', expira_em = expira_em - interval '3 minutes'");
    await q("UPDATE convites_master SET criado_em = criado_em - interval '3 minutes', expira_em = expira_em - interval '3 minutes'");
  };
  const linhaUsuario = async (id) => (await q('SELECT * FROM convites_usuario WHERE id = $1', [id])).rows[0];
  const linhaMaster = async (id) => (await q('SELECT * FROM convites_master WHERE id = $1', [id])).rows[0];
  const total = async (tabela, acao) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE acao = $1`, [acao])).rows[0].n;

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);
    empresaId = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Empresa Isolamento', '11222333000181') RETURNING id")).rows[0].id;
    const identidade = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', ['master.isolamento@exemplo-cliente.com.br', hash])).rows[0].id;
    await q("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Master Isolamento', NULL, NULL, 'MASTER', $2)", [empresaId, identidade]);

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao }),
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarConviteUsuarioRoutes({
          controller: criarConviteUsuarioController({ pool }), exigirSessao, limitador: semLimite(), limitadorEnvio: semLimite(),
        }),
      );
      a.use('/api/plataforma', criarConviteMasterRoutes({
        controller: criarConviteMasterController({ pool }), exigirSessaoPlataforma, limitador: semLimite(), limitadorEnvio: semLimite(),
      }));
    });

    const login = await request(app).post('/api/auth/global/login').send({ email: 'master.isolamento@exemplo-cliente.com.br', senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    cookiePortal = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;

    const administrador = await criarInicial(pool, { email: 'admin.isolamento@safework.com.br', senha: SENHA_ADMIN });
    ({ cookie: cookieAdmin } = await criarSessaoAdministrativa(pool, administrador.id));

    const u = await doPortal(request(app).post('/api/administracao/convites-usuario')).send({ email: 'convidado.usuario@exemplo-cliente.com.br', nome: 'Convidado Usuário', tipoConta: 'USUARIO' });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    const m = await doAdmin(request(app).post(`/api/plataforma/empresas/${empresaId}/convites-master`)).send({ email: 'convidado.master@exemplo-cliente.com.br' });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    conviteUsuario = { id: u.body.convite.id, token: tokenDoLink(u.body.entrega.linkAceite), link: u.body.entrega.linkAceite };
    conviteMaster = { id: m.body.convite.id, token: tokenDoLink(m.body.entrega.linkAceite), link: m.body.entrega.linkAceite };
    await envelhecer();
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('os dois convites têm o mesmo número de id em tabelas diferentes (premissa dos testes seguintes)', () => {
    assert.equal(conviteUsuario.id, conviteMaster.id);
  });

  test('a sessão do Portal não abre o reenvio do Painel Privado, e a do Painel não abre o do Portal (401, nada muda)', async () => {
    const noPainel = await doPortal(request(app).post(`/api/plataforma/convites-master/${empresaId}/${conviteMaster.id}/reenviar`)).send({});
    assert.equal(noPainel.status, 401);
    const noPortal = await doAdmin(request(app).post(`/api/administracao/convites-usuario/${conviteUsuario.id}/reenviar`)).send({});
    assert.equal(noPortal.status, 401);
    assert.equal((await linhaMaster(conviteMaster.id)).cancelado_em, null);
    assert.equal((await linhaUsuario(conviteUsuario.id)).cancelado_em, null);
  });

  test('a sessão do Portal não cria convite do MASTER e a do Painel não cria convite de usuário', async () => {
    const painel = await doPortal(request(app).post(`/api/plataforma/empresas/${empresaId}/convites-master`)).send({ email: 'x@exemplo-cliente.com.br' });
    const portal = await doAdmin(request(app).post('/api/administracao/convites-usuario')).send({ email: 'y@exemplo-cliente.com.br', nome: 'Y', tipoConta: 'USUARIO' });
    assert.deepEqual([painel.status, portal.status], [401, 401]);
  });

  test('o token de um convite não serve no endpoint do outro', async () => {
    const usuarioNoMaster = await request(app).post('/api/plataforma/convite-master/consultar').send({ token: conviteUsuario.token });
    const masterNoUsuario = await request(app).post('/api/convite-usuario/consultar').send({ token: conviteMaster.token });
    assert.deepEqual([usuarioNoMaster.status, usuarioNoMaster.body.codigo], [404, 'CONVITE_INVALIDO']);
    assert.deepEqual([masterNoUsuario.status, masterNoUsuario.body.codigo], [404, 'CONVITE_INVALIDO']);
    const aceiteCruzado = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token: conviteUsuario.token, nome: 'X', senha: 'Correnteza-Azul-Pedra-7319' });
    assert.equal(aceiteCruzado.status, 404);
    assert.equal((await linhaUsuario(conviteUsuario.id)).aceito_em, null);
  });

  test('cada link aponta para a origem e a página do seu portal', () => {
    const portal = new URL(conviteUsuario.link);
    const painel = new URL(conviteMaster.link);
    assert.deepEqual([portal.origin, portal.pathname], [httpConfig.urlsPublicas.portal, '/portal/aceitar-convite.html']);
    assert.deepEqual([painel.origin, painel.pathname], [httpConfig.urlsPublicas.painel, '/painel-privado/aceitar-convite.html']);
  });

  test('reenviar o convite de usuário não toca o do MASTER de mesmo id, e vice-versa; cada reenvio vai para a sua trilha de auditoria', async () => {
    const usuario = await doPortal(request(app).post(`/api/administracao/convites-usuario/${conviteUsuario.id}/reenviar`)).send({});
    assert.equal(usuario.status, 201, JSON.stringify(usuario.body));
    assert.equal((await linhaMaster(conviteMaster.id)).cancelado_em, null, 'o convite do MASTER não foi tocado');
    assert.notEqual((await linhaUsuario(conviteUsuario.id)).cancelado_em, null);
    assert.deepEqual([await total('logs_auditoria', 'USUARIO_CONVITE_REENVIADO'), await total('logs_auditoria_plataforma', 'USUARIO_CONVITE_REENVIADO')], [1, 0]);

    const master = await doAdmin(request(app).post(`/api/plataforma/convites-master/${empresaId}/${conviteMaster.id}/reenviar`)).send({});
    assert.equal(master.status, 201, JSON.stringify(master.body));
    assert.notEqual((await linhaMaster(conviteMaster.id)).cancelado_em, null);
    assert.equal(usuario.body.convite.id === conviteUsuario.id, false);
    assert.deepEqual([await total('logs_auditoria_plataforma', 'CONVITE_MASTER_REENVIADO'), await total('logs_auditoria', 'CONVITE_MASTER_REENVIADO')], [1, 0]);
    assert.equal((await q("SELECT count(*)::int AS n FROM convites_usuario WHERE cancelado_em IS NULL AND aceito_em IS NULL AND email_convite = 'convidado.usuario@exemplo-cliente.com.br'")).rows[0].n, 1);
  });

  test('a resposta do reenvio de usuário não traz campos da plataforma, e a do MASTER não traz campos do Portal', async () => {
    await envelhecer();
    const idUsuario = (await q("SELECT id FROM convites_usuario WHERE cancelado_em IS NULL AND aceito_em IS NULL AND email_convite = 'convidado.usuario@exemplo-cliente.com.br'")).rows[0].id;
    const idMaster = (await q("SELECT id FROM convites_master WHERE cancelado_em IS NULL AND aceito_em IS NULL AND lower(email_convite) = 'convidado.master@exemplo-cliente.com.br'")).rows[0].id;
    const usuario = await doPortal(request(app).post(`/api/administracao/convites-usuario/${idUsuario}/reenviar`)).send({});
    const master = await doAdmin(request(app).post(`/api/plataforma/convites-master/${empresaId}/${idMaster}/reenviar`)).send({});
    assert.deepEqual([usuario.status, master.status], [201, 201]);
    assert.equal('empresa' in usuario.body, false);
    assert.equal('perfil' in master.body.convite, false);
    assert.doesNotMatch(JSON.stringify(usuario.body), /administrador|plataforma/i);
  });
});
