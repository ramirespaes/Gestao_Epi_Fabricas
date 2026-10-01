'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/recuperacao-senha');
const { capturarEntrega, espiarConsole } = require('./helpers/recuperacao-senha-servico');
const { criarSessaoAdministrativa } = require('./helpers/sessao-plataforma-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarTurnstileController } = require('../../src/controllers/turnstile.controller');
const { criarExigirTurnstile } = require('../../src/middleware/turnstile');
const { criarValidadorTurnstile } = require('../../src/security/turnstile');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const auditoriaIdentidadeRepo = require('../../src/repositories/auditoria-identidade.repository');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const loginGlobalService = require('../../src/services/login-global.service');
const loginPlataformaService = require('../../src/services/login-plataforma.service');
const mfaCripto = require('../../src/security/mfa-cripto');
const cooldown = require('../../src/security/cooldown');
const cookies = require('../../src/security/cookie');
const password = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * Recuperação de senha pela camada HTTP (Bloco 11D) contra PostgreSQL real:
 * rotas, validação, Turnstile, controller e service reais, num schema
 * temporário com todas as migrations. O Siteverify é um fetch falso e a
 * entrega de e-mail é uma caixa em memória, única fonte do token em claro.
 */

const rotas = () => exigirModulo('src/routes/recuperacao-senha.routes');
const controllers = () => exigirModulo('src/controllers/recuperacao-senha.controller');

const ACAO_RECUPERACAO = 'portal_recuperacao_senha';
const TOKEN_TURNSTILE = 'XXXX.DUMMY.TOKEN.XXXX';
const SENHA_ATUAL = 'planeta-nebulosa-ozonio-42';
const SENHA_NOVA = 'girassol-quartzo-bussola-58';
const RESPOSTA = { status: 'SOLICITACAO_RECEBIDA' };
const INVALIDA = { status: 'error', codigo: 'REDEFINICAO_INVALIDA', message: 'Link de redefinição inválido ou expirado' };

const PORTAL = { solicitar: '/auth/global/recuperacao-senha/solicitar', redefinir: '/auth/global/recuperacao-senha/redefinir' };
const PAINEL = { solicitar: '/plataforma/auth/recuperacao-senha/solicitar', redefinir: '/plataforma/auth/recuperacao-senha/redefinir' };

async function siteverifyDaSuite(url, opcoes) {
  const aprovado = new URLSearchParams(opcoes.body).get('response') === TOKEN_TURNSTILE;
  const corpo = aprovado
    ? { success: true, 'error-codes': [], hostname: 'localhost', action: ACAO_RECUPERACAO }
    : { success: false, 'error-codes': ['invalid-input-response'] };
  return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('recuperação de senha — rotas HTTP com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let hashAtual;
  let sequencia = 0;

  const um = async (sql, parametros) => (await pool.query(sql, parametros)).rows[0];
  const todos = async (sql, parametros) => (await pool.query(sql, parametros)).rows;
  const setCookies = (r) => r.headers['set-cookie'] ?? [];

  async function novaIdentidade({ ativo = true } = {}) {
    sequencia += 1;
    const email = `pessoa-http-${sequencia}@example.invalid`;
    const { id } = await um('INSERT INTO identidades (email, senha_hash, ativo) VALUES ($1, $2, $3) RETURNING id', [email, hashAtual, ativo]);
    return { id, email };
  }

  async function novoAdministrador() {
    sequencia += 1;
    const email = `admin-http-${sequencia}@example.invalid`;
    const { id } = await um('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hashAtual]);
    const fatorUid = crypto.randomUUID();
    const envelope = mfaCripto.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: id, fatorUid });
    const fator = await fatorRepo.criarPendenteTotp(pool, { administradorId: id, fatorUid, envelope, validadeMinutos: 15 });
    assert.equal(await fatorRepo.ativarTotp(pool, { administradorId: id, fatorId: fator.id, step: 1 }), true);
    return { id, email };
  }

  const solicitarPortal = (email) => request(app).post(PORTAL.solicitar).set('User-Agent', 'Agente de Teste').send({ email, turnstileToken: TOKEN_TURNSTILE });
  const redefinirPortal = (token, novaSenha = SENHA_NOVA) => request(app).post(PORTAL.redefinir).send({ token, novaSenha });
  const solicitarPainel = (email) => request(app).post(PAINEL.solicitar).send({ email });
  const redefinirPainel = (token, novaSenha = SENHA_NOVA) => request(app).post(PAINEL.redefinir).send({ token, novaSenha });

  const forma = (r) => JSON.stringify([r.status, r.body, r.headers['content-type'], r.headers['content-length'], setCookies(r)]);

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    hashAtual = await password.gerarHashSenha(SENHA_ATUAL);
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  /** Monta o app com as rotas reais; chamado por teste porque as rotas ainda não existem antes da 11D. */
  function montar() {
    const validador = criarValidadorTurnstile({
      secretKey: 'segredo-ficticio-das-suites', acao: ACAO_RECUPERACAO, hostnamesPermitidos: ['localhost'], modoTeste: false, timeoutMs: 1000, fetch: siteverifyDaSuite,
    });
    const portal = rotas().criarRecuperacaoSenhaPortalRoutes({
      controller: controllers().criarRecuperacaoSenhaController({ pool, escopo: 'PORTAL' }),
      limitadorSolicitar: criarLimitador({ limite: 1000, janelaSegundos: 60 }),
      limitadorRedefinir: criarLimitador({ limite: 1000, janelaSegundos: 60 }),
      exigirTurnstile: criarExigirTurnstile({ validador }),
      turnstileController: criarTurnstileController({ siteKey: '1x00000000000000000000AA', acao: ACAO_RECUPERACAO }),
    });
    const painel = rotas().criarRecuperacaoSenhaPlataformaRoutes({
      controller: controllers().criarRecuperacaoSenhaController({ pool, escopo: 'PLATAFORMA' }),
      limitadorSolicitar: criarLimitador({ limite: 1000, janelaSegundos: 60 }),
      limitadorRedefinir: criarLimitador({ limite: 1000, janelaSegundos: 60 }),
    });
    app = criarAppTeste((a) => {
      a.use(portal);
      a.use('/plataforma', painel);
    });
  }

  describe('controle das fixtures', () => {
    test('identidade e administrador de teste autenticam com a senha atual nos logins existentes', async () => {
      const identidade = await novaIdentidade();
      const admin = await novoAdministrador();
      assert.equal((await loginGlobalService.autenticar(pool, { email: identidade.email, senha: SENHA_ATUAL })).identidade.id, identidade.id);
      assert.equal((await loginPlataformaService.autenticar(pool, { email: admin.email, senha: SENHA_ATUAL })).desafio.etapa, 'VERIFICACAO');
    });
  });

  describe('Portal', () => {
    test('existente, inexistente, inativa, limitada, e-mail que não normaliza e erro interno: mesmo status 202, mesmo corpo e mesmos cabeçalhos', async (t) => {
      montar();
      const caixa = capturarEntrega(t);
      espiarConsole(t);
      const ativa = await novaIdentidade();
      const inativa = await novaIdentidade({ ativo: false });
      const limitada = await novaIdentidade();
      const comErro = await novaIdentidade();
      for (let i = 0; i < 3; i += 1) await solicitarPortal(limitada.email);
      const antes = caixa.redefinicoes.length;

      const respostas = {
        existente: await solicitarPortal(ativa.email),
        inexistente: await solicitarPortal(`ninguem-http-${sequencia}@example.invalid`),
        inativa: await solicitarPortal(inativa.email),
        limitada: await solicitarPortal(limitada.email),
        'não normaliza': await solicitarPortal('isto não é e-mail'),
      };
      t.mock.method(auditoriaIdentidadeRepo, 'registrarEventoSistema', async () => { throw new Error('falha simulada na auditoria'); });
      respostas['erro interno'] = await solicitarPortal(comErro.email);

      for (const [nome, r] of Object.entries(respostas)) {
        assert.equal(r.status, 202, nome);
        assert.deepEqual(r.body, RESPOSTA, nome);
      }
      assert.equal(new Set(Object.values(respostas).map(forma)).size, 1, 'respostas indistinguíveis');
      assert.equal(caixa.redefinicoes.length, antes + 1, 'só a conta ativa recebe e-mail');
      assert.equal(caixa.redefinicoes.at(-1).email, ativa.email);
    });

    test('Turnstile recusado: 403 e nada é gravado', async (t) => {
      montar();
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const r = await request(app).post(PORTAL.solicitar).send({ email: identidade.email, turnstileToken: 'outro-token' });
      assert.deepEqual([r.status, r.body.codigo], [403, 'VERIFICACAO_SEGURANCA_INVALIDA']);
      assert.equal(caixa.redefinicoes.length, 0);
      assert.deepEqual(await todos('SELECT id FROM redefinicoes_senha WHERE identidade_id = $1', [identidade.id]), []);
      const chave = cooldown.gerarChaveRecuperacaoSenha('PORTAL', identidade.email);
      assert.deepEqual(await todos('SELECT id FROM recuperacao_senha_solicitacoes WHERE chave = $1', [chave]), [], 'a solicitação nem chegou ao service');
    });

    test('fluxo completo: solicitar, redefinir com o token do e-mail, cookies removidos, sessões revogadas, nenhuma sessão nova e login com a senha nova', async (t) => {
      montar();
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const login = await loginGlobalService.autenticar(pool, { email: identidade.email, senha: SENHA_ATUAL });

      assert.equal((await solicitarPortal(identidade.email)).status, 202);
      const { token } = caixa.redefinicoes.at(-1);
      const sessoesAntes = (await um('SELECT count(*)::int AS n FROM sessoes_globais')).n;

      const r = await redefinirPortal(token).set('Cookie', `${authConfig.sessao.cookieNomeGlobal}=${login.token}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { status: 'SENHA_REDEFINIDA' });
      assert.deepEqual([...setCookies(r)].sort(), [cookies.serializarRemocaoCookieSessaoGlobal(), cookies.serializarRemocaoCookieSessao()].sort());

      const sessao = await um('SELECT revogada_em, motivo_revogacao FROM sessoes_globais WHERE id = $1', [login.sessao.id]);
      assert.equal(sessao.motivo_revogacao, 'SENHA_REDEFINIDA');
      assert.equal((await um('SELECT count(*)::int AS n FROM sessoes_globais')).n, sessoesAntes, 'nenhuma sessão nova');
      assert.equal((await loginGlobalService.autenticar(pool, { email: identidade.email, senha: SENHA_NOVA })).identidade.id, identidade.id);
      for (const sensivel of [token, SENHA_NOVA, identidade.email]) assert.equal(JSON.stringify(r.body).includes(sensivel) || JSON.stringify(r.headers).includes(sensivel), false);
    });

    test('replay, token desconhecido e token malformado: mesmo 400 genérico, sem cookie; a senha não muda de novo', async (t) => {
      montar();
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      await solicitarPortal(identidade.email);
      const { token } = caixa.redefinicoes.at(-1);
      assert.equal((await redefinirPortal(token)).status, 200);
      const hashDepois = (await um('SELECT senha_hash FROM identidades WHERE id = $1', [identidade.id])).senha_hash;

      const respostas = [
        await redefinirPortal(token, 'lanterna-cometa-ardosia-91'),
        await redefinirPortal(crypto.randomBytes(32).toString('base64url')),
        await redefinirPortal('token-malformado'),
        await redefinirPortal(''),
      ];
      for (const r of respostas) {
        assert.equal(r.status, 400);
        assert.deepEqual(r.body, INVALIDA);
        assert.deepEqual(setCookies(r), []);
      }
      assert.equal((await um('SELECT senha_hash FROM identidades WHERE id = $1', [identidade.id])).senha_hash, hashDepois);
    });

    test('senha igual à atual e senha fora da política: 400 com o código próprio e o pedido continua valendo', async (t) => {
      montar();
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      await solicitarPortal(identidade.email);
      const { token } = caixa.redefinicoes.at(-1);

      const igual = await redefinirPortal(token, SENHA_ATUAL);
      assert.deepEqual([igual.status, igual.body.codigo, setCookies(igual)], [400, 'SENHA_IGUAL_A_ATUAL', []]);
      const fraca = await redefinirPortal(token, 'Zx9!kq');
      assert.deepEqual([fraca.status, fraca.body.codigo, setCookies(fraca)], [400, 'VALIDACAO', []]);
      assert.equal(JSON.stringify(fraca.body).includes('Zx9!kq'), false);
      assert.equal((await redefinirPortal(token)).status, 200);
    });

    test('nenhuma resposta nem linha de log do fluxo traz token, link, senha ou e-mail', async (t) => {
      montar();
      const caixa = capturarEntrega(t);
      const console_ = espiarConsole(t);
      const identidade = await novaIdentidade();
      const respostas = [await solicitarPortal(identidade.email)];
      const { token } = caixa.redefinicoes.at(-1);
      respostas.push(await redefinirPortal(token, SENHA_ATUAL), await redefinirPortal(token), await redefinirPortal(token));

      const texto = respostas.map((r) => JSON.stringify(r.body) + JSON.stringify(r.headers)).join('\n') + console_.map((l) => l.texto).join('\n');
      for (const sensivel of [token, '#token=', 'redefinir-senha.html', SENHA_ATUAL, SENHA_NOVA, identidade.email]) {
        assert.equal(texto.includes(sensivel), false, `vazou ${sensivel.slice(0, 8)}…`);
      }
    });
  });

  describe('Painel Privado', () => {
    test('existente e inexistente: mesmo 202 e mesmo corpo, sem Turnstile; só o administrador ativo recebe e-mail', async (t) => {
      montar();
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      const existente = await solicitarPainel(admin.email);
      const inexistente = await solicitarPainel(`admin-ninguem-http-${sequencia}@example.invalid`);
      assert.deepEqual([existente.status, existente.body], [202, RESPOSTA]);
      assert.equal(forma(existente), forma(inexistente));
      assert.deepEqual(caixa.redefinicoes.map((m) => [m.escopo, m.email]), [['PLATAFORMA', admin.email]]);
    });

    test('fluxo completo: reset remove os cookies administrativo e do desafio, revoga a sessão, mantém o MFA e o próximo login pede TOTP', async (t) => {
      montar();
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      const sessao = await criarSessaoAdministrativa(pool, admin.id);
      const fatoresAntes = await todos('SELECT * FROM fatores_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id]);
      await solicitarPainel(admin.email);
      const { token } = caixa.redefinicoes.at(-1);

      const r = await redefinirPainel(token).set('Cookie', sessao.cookie);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { status: 'SENHA_REDEFINIDA' });
      assert.deepEqual([...setCookies(r)].sort(), [cookies.serializarRemocaoCookieSessaoPlataforma(), cookies.serializarRemocaoCookieDesafioMfa()].sort());

      const sessoes = await todos('SELECT id, motivo_revogacao FROM sessoes_plataforma WHERE administrador_id = $1', [admin.id]);
      assert.deepEqual(sessoes.map((s) => [s.id, s.motivo_revogacao]), [[sessao.id, 'SENHA_REDEFINIDA']], 'sessão revogada e nenhuma nova');
      assert.deepEqual(await todos('SELECT * FROM fatores_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id]), fatoresAntes, 'MFA intacto');
      assert.equal((await loginPlataformaService.autenticar(pool, { email: admin.email, senha: SENHA_NOVA })).desafio.etapa, 'VERIFICACAO');

      const replay = await redefinirPainel(token);
      assert.deepEqual([replay.status, replay.body, setCookies(replay)], [400, INVALIDA, []]);
    });
  });
});
