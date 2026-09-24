'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarAuthPlataformaController } = require('../../src/controllers/auth-plataforma.controller');
const { criarAuthPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const { criarPainelPlataformaRoutes } = require('../../src/routes/painel-plataforma.routes');
const { painelPlataformaController } = require('../../src/controllers/painel-plataforma.controller');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarInicial } = require('../../src/services/administrador-plataforma.service');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * Integração HTTP completa do Painel Privado da plataforma (Autenticação
 * Global — Pacote 2): HTTP -> rota -> validação Zod -> controller ->
 * login-plataforma.service.js -> repositórios de plataforma -> PostgreSQL
 * real, em schema temporário removido em cascata ao final (contrato da
 * seção 11 do CLAUDE.md). O schema public nunca é lido nem escrito.
 *
 * Monta, no MESMO app de teste, tanto as rotas do cliente (/api/auth/*)
 * quanto as da plataforma (/api/plataforma/*) — necessário para o cenário
 * de isolamento: provar que o cookie de uma nunca autentica a outra. Não
 * reproduz corsPlataforma/verificarOrigemPlataforma/verificarHostPlataforma
 * aqui: essas camadas têm sua própria cobertura em test/app.test.js, no
 * mesmo espírito de auth-routes.integration.js para o cliente.
 *
 * Nenhum acesso operacional automático: o corpo de /api/plataforma/painel
 * só devolve `administrador`, nunca uma empresa — a ausência estrutural do
 * campo é, ela mesma, a prova de que autenticar como administrador de
 * plataforma não concede acesso a nenhuma empresa cliente.
 */

const CNPJ_CLIENTE = '12345678000195';
const SENHA_CORRETA = 'senha-correta-do-teste-http-2026';
// Não pode conter termos triviais nem o e-mail do administrador
// (validarPoliticaSenha real roda em criarInicial, sem atalho de teste).
const SENHA_ADMIN = 'planeta-nebulosa-ozonio-42';

/** Extrai "nome=valor" de um Set-Cookie identificado pelo NOME esperado. */
function extrairCookiePorNome(resposta, nome) {
  const cookies = resposta.headers['set-cookie'];
  assert.ok(Array.isArray(cookies), 'esperado ao menos um Set-Cookie');
  const alvo = cookies.find((c) => c.startsWith(`${nome}=`));
  assert.ok(alvo, `esperado um Set-Cookie chamado ${nome}, recebidos: ${cookies.map((c) => c.split('=')[0]).join(', ')}`);
  return alvo.split(';')[0];
}

describe('Painel Privado da plataforma — HTTP completo com PostgreSQL real', () => {
  let contexto;
  let app;
  let empresaCliente;
  let usuarioClienteId;
  let administradorId;

  before(async () => {
    contexto = await abrirPoolTemporario(['000', '001', '002', '005', '012', '013', '014', '015', '027', '028', '029', '030', '031']);

    // Rotas do CLIENTE, no mesmo app, para o cenário de isolamento de cookie.
    const authController = criarAuthController({ pool: contexto.pool });
    const exigirSessaoCliente = criarExigirSessao({ pool: contexto.pool });
    const limitadorCliente = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: authController, limitador: limitadorCliente, exigirSessao: exigirSessaoCliente });

    // Rotas da PLATAFORMA.
    const authPlataformaController = criarAuthPlataformaController({ pool: contexto.pool });
    const exigirSessaoPlataformaTeste = criarExigirSessaoPlataforma({ pool: contexto.pool });
    const limitadorPlataforma = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authPlataformaRoutes = criarAuthPlataformaRoutes({
      controller: authPlataformaController, limitador: limitadorPlataforma, exigirSessaoPlataforma: exigirSessaoPlataformaTeste,
    });
    const painelPlataformaRoutes = criarPainelPlataformaRoutes({
      controller: painelPlataformaController, exigirSessaoPlataforma: exigirSessaoPlataformaTeste,
    });

    app = criarAppTeste((a) => {
      a.use('/api', authRoutes);
      a.use('/api/plataforma', authPlataformaRoutes, painelPlataformaRoutes);
    });

    const hashClienteCorreto = await gerarHashSenha(SENHA_CORRETA);
    const cliente = await contexto.pool.connect();
    try {
      assert.equal(await inserirEmpresa(cliente, CNPJ_CLIENTE, 'Empresa Cliente'), 'ok');
      const { rows: empresas } = await cliente.query('SELECT id FROM empresas LIMIT 1');
      empresaCliente = empresas[0].id;
      const { rows: usuarios } = await cliente.query(
        `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [empresaCliente, 'Usuário Cliente', 'usuario.cliente@demo.safeworkengenharia.com.br', hashClienteCorreto, 'ADMINISTRADOR'],
      );
      usuarioClienteId = usuarios[0].id;
    } finally {
      cliente.release();
    }

    // Administrador inicial da plataforma, pelo procedimento controlado real
    // (mesmo que o script de bootstrap chamaria) — não um INSERT paralelo.
    const administrador = await criarInicial(contexto.pool, { email: 'admin@safework.com.br', senha: SENHA_ADMIN });
    administradorId = administrador.id;
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('login administrativo válido: cookie próprio, sessão persistida em sessoes_plataforma', async () => {
    const resposta = await request(app)
      .post('/api/plataforma/auth/login')
      .send({ email: 'admin@safework.com.br', senha: SENHA_ADMIN });

    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.body, { status: 'ok', administrador: { id: administradorId, email: 'admin@safework.com.br' } });
    assert.equal('empresa' in resposta.body, false, 'login administrativo nunca devolve empresa alguma');

    const cookie = extrairCookiePorNome(resposta, authConfig.sessao.cookieNomeAdmin);
    assert.notEqual(authConfig.sessao.cookieNomeAdmin, authConfig.sessao.cookieNome, 'pré-condição: nomes de cookie precisam ser distintos');
    const token = cookie.split('=')[1];
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(resposta.body).includes(token), false);

    const hashEsperado = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    const { rows } = await contexto.pool.query(
      'SELECT administrador_id, token_hash FROM sessoes_plataforma WHERE administrador_id = $1 ORDER BY id DESC LIMIT 1',
      [administradorId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, hashEsperado);
  });

  test('login administrativo não depende de nenhuma empresa cadastrada: funciona mesmo sem CNPJ no corpo', async () => {
    const resposta = await request(app)
      .post('/api/plataforma/auth/login')
      .send({ email: 'admin@safework.com.br', senha: SENHA_ADMIN, cnpj: '99999999000199' });

    // strictObject: campo desconhecido é recusado — prova que a rota
    // realmente não conhece CNPJ, não que ele foi ignorado silenciosamente.
    assert.equal(resposta.status, 400);
    assert.equal(resposta.body.codigo, 'VALIDACAO');
  });

  test('credenciais inválidas: 401 genérico, sem cookie, tanto para senha errada quanto e-mail inexistente', async () => {
    const senhaErrada = await request(app).post('/api/plataforma/auth/login').send({ email: 'admin@safework.com.br', senha: 'senha-errada' });
    assert.deepEqual([senhaErrada.status, senhaErrada.body.codigo], [401, 'CREDENCIAIS_INVALIDAS']);
    assert.equal(senhaErrada.headers['set-cookie'], undefined);

    const emailInexistente = await request(app).post('/api/plataforma/auth/login').send({ email: 'ninguem@safework.com.br', senha: SENHA_ADMIN });
    assert.deepEqual([emailInexistente.status, emailInexistente.body.codigo], [401, 'CREDENCIAIS_INVALIDAS']);
  });

  test('administrador inativo: login recusado mesmo com senha correta, e sessão pré-existente para de funcionar', async () => {
    const senhaInativo = 'senha-do-inativo-2026';
    const hash = await gerarHashSenha(senhaInativo);
    const { rows } = await contexto.pool.query(
      'INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id',
      ['inativo@safework.com.br', hash],
    );
    const idInativo = rows[0].id;

    const loginAntesDeInativar = await request(app).post('/api/plataforma/auth/login').send({ email: 'inativo@safework.com.br', senha: senhaInativo });
    assert.equal(loginAntesDeInativar.status, 200);
    const cookie = extrairCookiePorNome(loginAntesDeInativar, authConfig.sessao.cookieNomeAdmin);

    await contexto.pool.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [idInativo]);

    const painelDepois = await request(app).get('/api/plataforma/painel').set('Cookie', cookie);
    assert.equal(painelDepois.status, 401, 'inativar o administrador precisa derrubar, na próxima leitura, todas as sessões dele');
    assert.equal(painelDepois.body.codigo, 'SESSAO_INVALIDA');

    const loginDepoisDeInativo = await request(app).post('/api/plataforma/auth/login').send({ email: 'inativo@safework.com.br', senha: senhaInativo });
    assert.deepEqual([loginDepoisDeInativo.status, loginDepoisDeInativo.body.codigo], [401, 'CREDENCIAIS_INVALIDAS']);

    // Correção final do Pacote 2, item 3 da auditoria independente:
    // REATIVAR o administrador não pode devolver vida ao cookie antigo — a
    // revogação gravada pelo trigger (migration 031) é permanente.
    await contexto.pool.query('UPDATE administradores_plataforma SET ativo = true WHERE id = $1', [idInativo]);

    const painelAposReativar = await request(app).get('/api/plataforma/painel').set('Cookie', cookie);
    assert.equal(painelAposReativar.status, 401, 'reativar o administrador não pode restaurar cookies ou sessões antigas');
    assert.equal(painelAposReativar.body.codigo, 'SESSAO_INVALIDA');

    // Um login NOVO, depois da reativação, funciona normalmente — a
    // revogação atinge só as sessões que já existiam antes dela.
    const loginAposReativar = await request(app).post('/api/plataforma/auth/login').send({ email: 'inativo@safework.com.br', senha: senhaInativo });
    assert.equal(loginAposReativar.status, 200);
    const cookieNovo = extrairCookiePorNome(loginAposReativar, authConfig.sessao.cookieNomeAdmin);
    const painelComCookieNovo = await request(app).get('/api/plataforma/painel').set('Cookie', cookieNovo);
    assert.equal(painelComCookieNovo.status, 200, 'uma sessão criada depois da reativação precisa funcionar normalmente');
  });

  test('cooldown persistente por identidade (item 1): repetir a senha errada ativa bloqueio real via HTTP, mesmo com a senha correta na tentativa seguinte', async () => {
    const email = 'cooldown-http@safework.com.br';
    const senha = 'senha-do-cooldown-http-2026';
    const hash = await gerarHashSenha(senha);
    await contexto.pool.query('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2)', [email, hash]);

    for (let i = 0; i < authConfig.cooldown.niveis[0].falhas; i += 1) {
      const r = await request(app).post('/api/plataforma/auth/login').send({ email, senha: 'senha-errada-qualquer' });
      assert.equal(r.status, 401);
    }

    const bloqueada = await request(app).post('/api/plataforma/auth/login').send({ email, senha });
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.body.codigo, 'LOGIN_EM_COOLDOWN');
    assert.ok(Number(bloqueada.headers['retry-after']) > 0);
    assert.equal(bloqueada.headers['set-cookie'], undefined, 'nenhuma sessão pode ser criada durante o cooldown, mesmo com a senha correta');
  });

  describe('GET /api/plataforma/painel — área administrativa protegida', () => {
    test('sem cookie: 401 SESSAO_INVALIDA, nenhum dado de administrador devolvido', async () => {
      const resposta = await request(app).get('/api/plataforma/painel');
      assert.deepEqual(resposta.body, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'Sessão inválida ou expirada' });
      assert.equal('administrador' in resposta.body, false);
    });

    test('com cookie válido: 200, devolve exclusivamente o administrador, nunca uma empresa', async () => {
      const login = await request(app).post('/api/plataforma/auth/login').send({ email: 'admin@safework.com.br', senha: SENHA_ADMIN });
      const cookie = extrairCookiePorNome(login, authConfig.sessao.cookieNomeAdmin);

      const painel = await request(app).get('/api/plataforma/painel').set('Cookie', cookie);
      assert.equal(painel.status, 200);
      assert.deepEqual(Object.keys(painel.body).sort(), ['administrador', 'status']);
      assert.equal(painel.body.administrador.id, administradorId);
      assert.equal('empresa' in painel.body, false, 'nenhum acesso operacional a empresa alguma');
    });

    test('sessão expirada (expiração absoluta): 401, não revive', async () => {
      const login = await request(app).post('/api/plataforma/auth/login').send({ email: 'admin@safework.com.br', senha: SENHA_ADMIN });
      const cookie = extrairCookiePorNome(login, authConfig.sessao.cookieNomeAdmin);
      const tokenHash = crypto.createHash('sha256').update(cookie.split('=')[1], 'utf8').digest('hex');

      // expira_em precisa continuar posterior a criado_em
      // (chk_sessoes_plataforma_expira_apos_criacao, migration 031) mesmo
      // simulando uma sessão já vencida — por isso os dois são recuados
      // juntos, preservando a ordem, em vez de só mover expira_em para
      // antes do criado_em real do login.
      await contexto.pool.query(
        "UPDATE sessoes_plataforma SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 minute' WHERE token_hash = $1",
        [tokenHash],
      );

      const painel = await request(app).get('/api/plataforma/painel').set('Cookie', cookie);
      assert.equal(painel.status, 401);
      assert.equal(painel.body.codigo, 'SESSAO_INVALIDA');
    });

    test('sessão revogada (logout): 401, não revive', async () => {
      const login = await request(app).post('/api/plataforma/auth/login').send({ email: 'admin@safework.com.br', senha: SENHA_ADMIN });
      const cookie = extrairCookiePorNome(login, authConfig.sessao.cookieNomeAdmin);

      const logout = await request(app).post('/api/plataforma/auth/logout').set('Cookie', cookie);
      assert.deepEqual([logout.status, logout.body], [200, { status: 'ok' }]);
      assert.equal(extrairCookiePorNome(logout, authConfig.sessao.cookieNomeAdmin), `${authConfig.sessao.cookieNomeAdmin}=`);

      const painel = await request(app).get('/api/plataforma/painel').set('Cookie', cookie);
      assert.equal(painel.status, 401);
      assert.equal(painel.body.codigo, 'SESSAO_INVALIDA');
    });

    test('logout chamado duas vezes com o mesmo cookie: ambas 200, revogação persistida uma única vez', async () => {
      const login = await request(app).post('/api/plataforma/auth/login').send({ email: 'admin@safework.com.br', senha: SENHA_ADMIN });
      const cookie = extrairCookiePorNome(login, authConfig.sessao.cookieNomeAdmin);
      const tokenHash = crypto.createHash('sha256').update(cookie.split('=')[1], 'utf8').digest('hex');

      const primeira = await request(app).post('/api/plataforma/auth/logout').set('Cookie', cookie);
      const segunda = await request(app).post('/api/plataforma/auth/logout').set('Cookie', cookie);
      assert.equal(primeira.status, 200);
      assert.equal(segunda.status, 200);

      const { rows } = await contexto.pool.query('SELECT revogada_em FROM sessoes_plataforma WHERE token_hash = $1', [tokenHash]);
      assert.notEqual(rows[0].revogada_em, null);
    });
  });

  describe('isolamento entre a sessão administrativa e a sessão empresarial', () => {
    test('o cookie do cliente nunca autentica o Painel Privado', async () => {
      const loginCliente = await request(app)
        .post('/api/auth/login')
        .send({ cnpj: CNPJ_CLIENTE, email: 'usuario.cliente@demo.safeworkengenharia.com.br', senha: SENHA_CORRETA });
      assert.equal(loginCliente.status, 200);
      const cookieCliente = extrairCookiePorNome(loginCliente, authConfig.sessao.cookieNome);

      const painelComCookieCliente = await request(app).get('/api/plataforma/painel').set('Cookie', cookieCliente);
      assert.equal(painelComCookieCliente.status, 401, 'o cookie empresarial não deve autenticar administradores da plataforma');
      assert.equal(painelComCookieCliente.body.codigo, 'SESSAO_INVALIDA');
    });

    test('o cookie administrativo nunca autentica usuários no ambiente empresarial', async () => {
      const loginAdmin = await request(app).post('/api/plataforma/auth/login').send({ email: 'admin@safework.com.br', senha: SENHA_ADMIN });
      const cookieAdmin = extrairCookiePorNome(loginAdmin, authConfig.sessao.cookieNomeAdmin);

      const meComCookieAdmin = await request(app).get('/api/auth/me').set('Cookie', cookieAdmin);
      assert.equal(meComCookieAdmin.status, 401, 'o cookie administrativo não deve autenticar usuários nos ambientes empresariais');
      assert.equal(meComCookieAdmin.body.codigo, 'SESSAO_INVALIDA');
    });

    test('login administrativo não cria nem altera nenhum registro em usuarios/empresas', async () => {
      const { rows: usuariosAntes } = await contexto.pool.query('SELECT count(*)::int AS total FROM usuarios');
      const { rows: empresasAntes } = await contexto.pool.query('SELECT count(*)::int AS total FROM empresas');

      await request(app).post('/api/plataforma/auth/login').send({ email: 'admin@safework.com.br', senha: SENHA_ADMIN });

      const { rows: usuariosDepois } = await contexto.pool.query('SELECT count(*)::int AS total FROM usuarios');
      const { rows: empresasDepois } = await contexto.pool.query('SELECT count(*)::int AS total FROM empresas');
      assert.equal(usuariosDepois[0].total, usuariosAntes[0].total);
      assert.equal(empresasDepois[0].total, empresasAntes[0].total);
    });
  });
});
