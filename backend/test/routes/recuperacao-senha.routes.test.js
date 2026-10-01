'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarTurnstileController } = require('../../src/controllers/turnstile.controller');
const turnstileMiddleware = require('../../src/middleware/turnstile');
const { criarValidadorTurnstile } = require('../../src/security/turnstile');
const rateLimit = require('../../src/middleware/rate-limit');
const { criarAuthGlobalRoutes, authGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarAuthPlataformaRoutes, authPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const recuperacaoSenhaService = require('../../src/services/recuperacao-senha.service');
const cookies = require('../../src/security/cookie');
const { turnstileConfig } = require('../../src/config/turnstile');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Rotas HTTP da recuperação de senha (Bloco 11D), sem banco: o service é
 * substituído; validação, Turnstile, limitador, controller e tratamento de
 * erro são os reais. A rede do Turnstile (Siteverify) é um fetch falso.
 */

const rotas = () => exigirModulo('src/routes/recuperacao-senha.routes');
const controllers = () => exigirModulo('src/controllers/recuperacao-senha.controller');

const ACAO_RECUPERACAO = 'portal_recuperacao_senha';
const TOKEN_WIDGET = 'token-do-widget.abc_DEF-123';
const SECRET = '0x4AAAAAAAsegredoFicticioParaTeste000';
const SITE_KEY = '0x4AAAAAAAsiteFicticiaParaTeste';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const SENHA = 'girassol-quartzo-bussola-58';
const EMAIL = 'pessoa@example.invalid';
const RESPOSTA = { status: 'SOLICITACAO_RECEBIDA' };

const PORTAL = { solicitar: '/auth/global/recuperacao-senha/solicitar', redefinir: '/auth/global/recuperacao-senha/redefinir', turnstile: '/auth/global/recuperacao-senha/turnstile' };
const PLATAFORMA = { solicitar: '/auth/recuperacao-senha/solicitar', redefinir: '/auth/recuperacao-senha/redefinir', turnstile: '/auth/recuperacao-senha/turnstile' };

const poolSemBanco = {
  connect: async () => { throw new Error('o banco não pode ser tocado'); },
  query: async () => { throw new Error('o banco não pode ser tocado'); },
};

function fetchFalso(responder) {
  const chamadas = [];
  const fn = async (url, opcoes) => { chamadas.push({ url, opcoes }); return responder(); };
  fn.chamadas = chamadas;
  return fn;
}
const siteverify = (corpo, status = 200) => () => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
const aprovado = (action = ACAO_RECUPERACAO) => siteverify({ success: true, 'error-codes': [], hostname: 'localhost', action });

const limitadorDe = (limite) => rateLimit.criarLimitador({ limite, janelaSegundos: 60 });

function rotasDoPortal({ fetch = fetchFalso(aprovado()), limiteSolicitar = 1000, limiteRedefinir = 1000, modoTeste = false } = {}) {
  const validador = criarValidadorTurnstile({
    secretKey: SECRET, acao: ACAO_RECUPERACAO, hostnamesPermitidos: ['localhost'], modoTeste, timeoutMs: 1000, fetch,
  });
  return rotas().criarRecuperacaoSenhaPortalRoutes({
    controller: controllers().criarRecuperacaoSenhaController({ pool: poolSemBanco, escopo: 'PORTAL' }),
    limitadorSolicitar: limitadorDe(limiteSolicitar),
    limitadorRedefinir: limitadorDe(limiteRedefinir),
    exigirTurnstile: turnstileMiddleware.criarExigirTurnstile({ validador }),
    turnstileController: criarTurnstileController({ siteKey: SITE_KEY, acao: ACAO_RECUPERACAO }),
  });
}

function rotasDoPainel({ limiteSolicitar = 1000, limiteRedefinir = 1000 } = {}) {
  return rotas().criarRecuperacaoSenhaPlataformaRoutes({
    controller: controllers().criarRecuperacaoSenhaController({ pool: poolSemBanco, escopo: 'PLATAFORMA' }),
    limitadorSolicitar: limitadorDe(limiteSolicitar),
    limitadorRedefinir: limitadorDe(limiteRedefinir),
  });
}

function montarPortal(opcoes = {}) {
  const fetch = opcoes.fetch ?? fetchFalso(aprovado());
  const router = rotasDoPortal({ ...opcoes, fetch });
  return { app: criarAppTeste((app) => app.use(router)), fetch };
}

function montarPlataforma(opcoes = {}) {
  const router = rotasDoPainel(opcoes);
  return { app: criarAppTeste((app) => app.use(router)) };
}

function servicoFalso(t, { solicitar = async () => recuperacaoSenhaService.RESPOSTA_SOLICITACAO, redefinir = async () => ({ status: 'SENHA_REDEFINIDA' }) } = {}) {
  return {
    solicitar: t.mock.method(recuperacaoSenhaService, 'solicitar', solicitar),
    redefinir: t.mock.method(recuperacaoSenhaService, 'redefinir', redefinir),
  };
}

function espiarConsole(t) {
  const linhas = [];
  for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, metodo, (...argumentos) => { linhas.push(argumentos.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(' ')); });
  }
  return linhas;
}

const setCookies = (r) => r.headers['set-cookie'] ?? [];
const semSensiveis = (r, extras = []) => {
  const texto = JSON.stringify(r.body) + JSON.stringify(r.headers);
  for (const sensivel of [TOKEN, SENHA, '#token=', 'redefinir-senha.html', SECRET, ...extras]) {
    assert.equal(texto.includes(sensivel), false, `a resposta contém ${sensivel.slice(0, 8)}…`);
  }
};

describe('Portal — POST solicitar', () => {
  const pedir = (app, corpo = { email: EMAIL, turnstileToken: TOKEN_WIDGET }) => request(app).post(PORTAL.solicitar).set('User-Agent', 'Agente de Teste').send(corpo);

  test('corpo válido e Turnstile aprovado: 202 com o corpo genérico, sem cookie, e o service recebe o escopo PORTAL', async (t) => {
    const servico = servicoFalso(t);
    const { app, fetch } = montarPortal();
    const r = await pedir(app);

    assert.equal(r.status, 202);
    assert.deepEqual(r.body, RESPOSTA);
    assert.deepEqual(setCookies(r), []);
    assert.equal(fetch.chamadas.length, 1);
    assert.equal(servico.solicitar.mock.calls.length, 1);
    const [, dados] = servico.solicitar.mock.calls[0].arguments;
    assert.deepEqual(Object.keys(dados).sort(), ['dispositivo', 'email', 'escopo', 'ip']);
    assert.deepEqual([dados.escopo, dados.email, dados.dispositivo], ['PORTAL', EMAIL, 'Agente de Teste']);
    semSensiveis(r, [EMAIL, TOKEN_WIDGET]);
  });

  test('e-mail que não normaliza chega ao service como veio e recebe o mesmo 202', async (t) => {
    const servico = servicoFalso(t);
    const { app } = montarPortal();
    const respostas = [];
    for (const email of ['sem-arroba', '', 'a@b', '  Pessoa@Example.INVALID ', 'duas@@example.invalid']) {
      const r = await pedir(app, { email, turnstileToken: TOKEN_WIDGET });
      assert.equal(r.status, 202, JSON.stringify(email));
      assert.equal(servico.solicitar.mock.calls.at(-1).arguments[1].email, email);
      respostas.push(JSON.stringify(r.body));
    }
    assert.deepEqual([...new Set(respostas)], [JSON.stringify(RESPOSTA)]);
  });

  test('o que o service devolve para qualquer desfecho sai com o mesmo status, o mesmo corpo e os mesmos cabeçalhos de conteúdo', async (t) => {
    servicoFalso(t);
    const { app } = montarPortal();
    const respostas = [];
    for (const email of [EMAIL, 'ninguem@example.invalid', 'inativa@example.invalid', 'limitada@example.invalid']) {
      const r = await pedir(app, { email, turnstileToken: TOKEN_WIDGET });
      respostas.push(JSON.stringify([r.status, r.body, r.headers['content-type'], r.headers['content-length'], setCookies(r)]));
    }
    assert.equal(new Set(respostas).size, 1);
    assert.equal(JSON.parse(respostas[0])[0], 202);
  });

  test('corpo fora da estrutura: 400 de validação antes do Turnstile e do service', async (t) => {
    const servico = servicoFalso(t);
    const { app, fetch } = montarPortal();
    for (const corpo of [{ turnstileToken: TOKEN_WIDGET }, { email: EMAIL }, { email: 42, turnstileToken: TOKEN_WIDGET }, { email: 'a'.repeat(201), turnstileToken: TOKEN_WIDGET },
      { email: EMAIL, turnstileToken: TOKEN_WIDGET, escopo: 'PLATAFORMA' }]) {
      const r = await pedir(app, corpo);
      assert.equal(r.status, 400, JSON.stringify(Object.keys(corpo)));
      assert.equal(r.body.codigo, 'VALIDACAO');
    }
    assert.equal(fetch.chamadas.length, 0);
    assert.equal(servico.solicitar.mock.calls.length, 0);
  });

  test('Turnstile inválido bloqueia antes do service: 403', async (t) => {
    const servico = servicoFalso(t);
    const { app } = montarPortal({ fetch: fetchFalso(siteverify({ success: false, 'error-codes': ['invalid-input-response'] })) });
    const r = await pedir(app);
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'VERIFICACAO_SEGURANCA_INVALIDA');
    assert.equal(servico.solicitar.mock.calls.length, 0);
  });

  test('Turnstile indisponível bloqueia antes do service: 503', async (t) => {
    const servico = servicoFalso(t);
    espiarConsole(t);
    for (const fetch of [fetchFalso(siteverify({}, 500)), fetchFalso(() => { throw new Error('rede fora'); }), fetchFalso(siteverify({ success: false, 'error-codes': ['internal-error'] }))]) {
      const { app } = montarPortal({ fetch });
      const r = await pedir(app);
      assert.equal(r.status, 503);
      assert.equal(r.body.codigo, 'VERIFICACAO_SEGURANCA_INDISPONIVEL');
    }
    assert.equal(servico.solicitar.mock.calls.length, 0);
  });

  test('token aprovado para a action do login não vale para a recuperação; com a action da recuperação, vale', async (t) => {
    const servico = servicoFalso(t);
    const deLogin = montarPortal({ fetch: fetchFalso(aprovado('portal_login')) });
    const recusada = await pedir(deLogin.app);
    assert.equal(recusada.status, 403);
    assert.equal(recusada.body.codigo, 'VERIFICACAO_SEGURANCA_INVALIDA');
    assert.equal(servico.solicitar.mock.calls.length, 0);

    const daRecuperacao = montarPortal({ fetch: fetchFalso(aprovado(ACAO_RECUPERACAO)) });
    assert.equal((await pedir(daRecuperacao.app)).status, 202);
    assert.equal(servico.solicitar.mock.calls.length, 1);
  });

  test('com as chaves oficiais de teste (fora de production) o comportamento especial é preservado: basta success', async (t) => {
    servicoFalso(t);
    const { app } = montarPortal({ modoTeste: true, fetch: fetchFalso(siteverify({ success: true, 'error-codes': [] })) });
    assert.equal((await pedir(app)).status, 202);
  });

  test('o limitador vem antes de tudo: estourado, responde 429 sem validar, sem Turnstile e sem service', async (t) => {
    const servico = servicoFalso(t);
    const { app, fetch } = montarPortal({ limiteSolicitar: 1 });
    assert.equal((await pedir(app)).status, 202);
    const r = await pedir(app, { invalido: true });
    assert.equal(r.status, 429);
    assert.equal(r.body.codigo, 'LIMITE_REQUISICOES_EXCEDIDO');
    assert.equal(fetch.chamadas.length, 1);
    assert.equal(servico.solicitar.mock.calls.length, 1);
  });

  test('a rota é pública: funciona sem cookie e ignora cookies e cabeçalho de autorização que venham na requisição', async (t) => {
    const servico = servicoFalso(t);
    const { app } = montarPortal();
    const r = await pedir(app).set('Cookie', 'gepi_sessao_global=qualquer; gepi_sessao=outro').set('Authorization', 'Bearer qualquer');
    assert.equal(r.status, 202);
    assert.deepEqual(Object.keys(servico.solicitar.mock.calls[0].arguments[1]).sort(), ['dispositivo', 'email', 'escopo', 'ip']);
  });

  test('token na query é recusado, mesmo com o corpo correto', async (t) => {
    const servico = servicoFalso(t);
    const { app, fetch } = montarPortal();
    const r = await request(app).post(`${PORTAL.solicitar}?token=${TOKEN}`).send({ email: EMAIL, turnstileToken: TOKEN_WIDGET });
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'VALIDACAO');
    assert.equal(fetch.chamadas.length + servico.solicitar.mock.calls.length, 0);
    semSensiveis(r);
  });
});

describe('Portal — GET configuração pública do Turnstile da recuperação', () => {
  test('devolve só status, siteKey e action, com a action própria da recuperação', async () => {
    const { app } = montarPortal();
    const r = await request(app).get(PORTAL.turnstile);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'ok', siteKey: SITE_KEY, action: ACAO_RECUPERACAO });
    assert.equal(JSON.stringify(r.body).includes(SECRET), false);
  });

  test('a instância da aplicação usa a site key do Portal e a action da recuperação; a do login continua com a action do login', async () => {
    const { turnstileController, turnstileRecuperacaoSenhaController } = require('../../src/controllers/turnstile.controller'); // eslint-disable-line global-require
    assert.equal(typeof turnstileRecuperacaoSenhaController?.configuracao, 'function', 'controller público da recuperação ausente');
    const capturar = (controller) => {
      const res = { status(c) { this.c = c; return this; }, json(b) { this.b = b; return this; } };
      controller.configuracao({}, res);
      return [res.c, res.b];
    };
    assert.deepEqual(capturar(turnstileRecuperacaoSenhaController), [200, { status: 'ok', siteKey: turnstileConfig.portal.siteKey, action: 'portal_recuperacao_senha' }]);
    assert.deepEqual(capturar(turnstileController), [200, { status: 'ok', siteKey: turnstileConfig.portal.siteKey, action: 'portal_login' }]);
  });
});

describe('Portal — POST redefinir', () => {
  const redefinir = (app, corpo = { token: TOKEN, novaSenha: SENHA }) => request(app).post(PORTAL.redefinir).send(corpo);

  test('token e senha só no corpo: 200, corpo SENHA_REDEFINIDA e remoção dos cookies global e empresarial; sem Turnstile', async (t) => {
    const servico = servicoFalso(t);
    const { app, fetch } = montarPortal();
    const r = await redefinir(app);

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'SENHA_REDEFINIDA' });
    assert.deepEqual([...setCookies(r)].sort(), [cookies.serializarRemocaoCookieSessaoGlobal(), cookies.serializarRemocaoCookieSessao()].sort());
    assert.equal(fetch.chamadas.length, 0, 'o reset não usa Turnstile');
    const [, dados] = servico.redefinir.mock.calls[0].arguments;
    assert.deepEqual(Object.keys(dados).sort(), ['dispositivo', 'escopo', 'ip', 'novaSenha', 'token']);
    assert.deepEqual([dados.escopo, dados.token, dados.novaSenha], ['PORTAL', TOKEN, SENHA]);
    semSensiveis(r);
  });

  test('a rota é pública e não cria sessão: sem cookie na requisição e só cookies de remoção na resposta', async (t) => {
    servicoFalso(t);
    const { app } = montarPortal();
    const r = await redefinir(app);
    assert.equal(r.status, 200);
    for (const cookie of setCookies(r)) assert.match(cookie, /^[A-Za-z0-9_-]+=; Max-Age=0;/);
  });

  test('token na query ou no caminho não existe: 400 quando vem na query, 404 quando vem no caminho ou por GET', async (t) => {
    const servico = servicoFalso(t);
    const { app } = montarPortal();
    const soNaQuery = await request(app).post(`${PORTAL.redefinir}?token=${TOKEN}`).send({ novaSenha: SENHA });
    const nosDois = await request(app).post(`${PORTAL.redefinir}?token=${TOKEN}`).send({ token: TOKEN, novaSenha: SENHA });
    const noCaminho = await request(app).post(`${PORTAL.redefinir}/${TOKEN}`).send({ novaSenha: SENHA });
    const porGet = await request(app).get(`${PORTAL.redefinir}?token=${TOKEN}`);

    assert.deepEqual([soNaQuery.status, soNaQuery.body.codigo], [400, 'VALIDACAO']);
    assert.deepEqual([nosDois.status, nosDois.body.codigo], [400, 'VALIDACAO']);
    assert.equal(noCaminho.status, 404);
    assert.equal(porGet.status, 404);
    assert.equal(servico.redefinir.mock.calls.length, 0);
    for (const r of [soNaQuery, nosDois, noCaminho, porGet]) semSensiveis(r);
  });

  test('corpo fora da estrutura: 400 de validação sem chamar o service e sem ecoar valores', async (t) => {
    const servico = servicoFalso(t);
    const { app } = montarPortal();
    for (const corpo of [{ novaSenha: SENHA }, { token: TOKEN }, { token: 42, novaSenha: SENHA }, { token: TOKEN, novaSenha: '' }, { token: 'x'.repeat(257), novaSenha: SENHA },
      { token: TOKEN, novaSenha: SENHA, email: EMAIL }]) {
      const r = await redefinir(app, corpo);
      assert.equal(r.status, 400, JSON.stringify(Object.keys(corpo)));
      assert.equal(r.body.codigo, 'VALIDACAO');
      semSensiveis(r, [EMAIL]);
    }
    assert.equal(servico.redefinir.mock.calls.length, 0);
  });

  test('token malformado chega ao service e a recusa dele sai como veio: erro genérico, sem cookie e sem detalhe', async (t) => {
    const recusa = HttpError.badRequest('REDEFINICAO_INVALIDA', 'Link de redefinição inválido ou expirado');
    const servico = servicoFalso(t, { redefinir: async () => { throw recusa; } });
    const { app } = montarPortal();
    const corpos = [];
    for (const token of ['token-malformado', '', TOKEN]) {
      const r = await redefinir(app, { token, novaSenha: SENHA });
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { status: 'error', codigo: 'REDEFINICAO_INVALIDA', message: 'Link de redefinição inválido ou expirado' });
      assert.deepEqual(setCookies(r), []);
      semSensiveis(r);
      corpos.push(JSON.stringify(r.body));
    }
    assert.equal(new Set(corpos).size, 1);
    assert.equal(servico.redefinir.mock.calls.length, 3, 'o controller não reinterpreta o token');
  });

  test('senha igual à atual e senha fora da política saem como o service decidiu, sem cookie', async (t) => {
    const { app } = montarPortal();
    servicoFalso(t, { redefinir: async () => { throw HttpError.badRequest('SENHA_IGUAL_A_ATUAL', 'A nova senha deve ser diferente da senha atual'); } });
    const igual = await redefinir(app);
    assert.deepEqual([igual.status, igual.body.codigo, setCookies(igual)], [400, 'SENHA_IGUAL_A_ATUAL', []]);
    t.mock.restoreAll();

    servicoFalso(t, { redefinir: async () => { throw HttpError.validacao([{ campo: 'body.novaSenha', codigo: 'SENHA_CURTA', mensagem: 'A senha deve ter pelo menos 12 caracteres' }]); } });
    const fraca = await redefinir(app);
    assert.deepEqual([fraca.status, fraca.body.codigo, setCookies(fraca)], [400, 'VALIDACAO', []]);
    semSensiveis(fraca);
  });

  test('erro interno no reset: 500 genérico, sem cookie, sem token nem senha na resposta ou no log', async (t) => {
    const linhas = espiarConsole(t);
    servicoFalso(t, { redefinir: async () => { throw new Error(`falha simulada com ${TOKEN} e ${SENHA}`); } });
    const { app } = montarPortal();
    const r = await redefinir(app);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
    assert.deepEqual(setCookies(r), []);
    semSensiveis(r);
    const log = linhas.join('\n');
    for (const sensivel of [TOKEN, SENHA]) assert.equal(log.includes(sensivel), false, 'log técnico com dado sensível');
  });

  test('o limitador do reset vem antes de tudo: estourado, responde 429 sem validar e sem chamar o service', async (t) => {
    const servico = servicoFalso(t);
    const { app } = montarPortal({ limiteRedefinir: 1 });
    assert.equal((await redefinir(app)).status, 200);
    const r = await redefinir(app, { invalido: true });
    assert.deepEqual([r.status, r.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO']);
    assert.equal(servico.redefinir.mock.calls.length, 1);
  });
});

describe('Painel Privado — rotas', () => {
  test('solicitar: 202 com o corpo genérico e o escopo PLATAFORMA, sem Turnstile e sem cookie', async (t) => {
    const servico = servicoFalso(t);
    const fetchGlobal = t.mock.method(globalThis, 'fetch', async () => { throw new Error('o Painel não chama o Turnstile'); });
    const { app } = montarPlataforma();
    const r = await request(app).post(PLATAFORMA.solicitar).set('User-Agent', 'Agente de Teste').send({ email: 'admin@example.invalid' });

    assert.equal(r.status, 202);
    assert.deepEqual(r.body, RESPOSTA);
    assert.deepEqual(setCookies(r), []);
    assert.equal(fetchGlobal.mock.calls.length, 0);
    assert.deepEqual(servico.solicitar.mock.calls[0].arguments[1], {
      escopo: 'PLATAFORMA', email: 'admin@example.invalid', ip: servico.solicitar.mock.calls[0].arguments[1].ip, dispositivo: 'Agente de Teste',
    });
  });

  test('solicitar: e-mail que não normaliza recebe o mesmo 202; corpo com Turnstile ou campo a mais é 400', async (t) => {
    const servico = servicoFalso(t);
    const { app } = montarPlataforma();
    for (const email of ['sem-arroba', '', 'a@b']) {
      const r = await request(app).post(PLATAFORMA.solicitar).send({ email });
      assert.deepEqual([r.status, r.body], [202, RESPOSTA], JSON.stringify(email));
    }
    assert.equal(servico.solicitar.mock.calls.length, 3);
    for (const corpo of [{ email: 'admin@example.invalid', turnstileToken: TOKEN_WIDGET }, { email: 'admin@example.invalid', escopo: 'PORTAL' }, {}]) {
      assert.equal((await request(app).post(PLATAFORMA.solicitar).send(corpo)).status, 400);
    }
    assert.equal(servico.solicitar.mock.calls.length, 3);
  });

  test('não existe rota de configuração do Turnstile no Painel Privado', async () => {
    const { app } = montarPlataforma();
    assert.equal((await request(app).get(PLATAFORMA.turnstile)).status, 404);
  });

  test('redefinir: 200, corpo SENHA_REDEFINIDA e remoção dos cookies administrativo e do desafio MFA', async (t) => {
    const servico = servicoFalso(t);
    const { app } = montarPlataforma();
    const r = await request(app).post(PLATAFORMA.redefinir).send({ token: TOKEN, novaSenha: SENHA });

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'SENHA_REDEFINIDA' });
    assert.deepEqual([...setCookies(r)].sort(), [cookies.serializarRemocaoCookieSessaoPlataforma(), cookies.serializarRemocaoCookieDesafioMfa()].sort());
    assert.deepEqual([servico.redefinir.mock.calls[0].arguments[1].escopo, servico.redefinir.mock.calls[0].arguments[1].token], ['PLATAFORMA', TOKEN]);
    semSensiveis(r);
  });

  test('redefinir: token só no corpo; recusa do service sai genérica e sem cookie', async (t) => {
    const servico = servicoFalso(t, { redefinir: async () => { throw HttpError.badRequest('REDEFINICAO_INVALIDA', 'Link de redefinição inválido ou expirado'); } });
    const { app } = montarPlataforma();
    const naQuery = await request(app).post(`${PLATAFORMA.redefinir}?token=${TOKEN}`).send({ novaSenha: SENHA });
    const noCaminho = await request(app).post(`${PLATAFORMA.redefinir}/${TOKEN}`).send({ novaSenha: SENHA });
    assert.deepEqual([naQuery.status, noCaminho.status], [400, 404]);
    assert.equal(servico.redefinir.mock.calls.length, 0);

    const recusada = await request(app).post(PLATAFORMA.redefinir).send({ token: TOKEN, novaSenha: SENHA });
    assert.deepEqual(recusada.body, { status: 'error', codigo: 'REDEFINICAO_INVALIDA', message: 'Link de redefinição inválido ou expirado' });
    assert.deepEqual(setCookies(recusada), []);
    semSensiveis(recusada);
  });
});

describe('query string vazia nas quatro POST', () => {
  test('qualquer parâmetro na URL, mesmo inofensivo, dá 400 antes do Turnstile e do service, com o corpo correto', async (t) => {
    const servico = servicoFalso(t);
    const portal = montarPortal();
    const painel = montarPlataforma();
    const casos = [
      [portal.app, PORTAL.solicitar, { email: EMAIL, turnstileToken: TOKEN_WIDGET }],
      [portal.app, PORTAL.redefinir, { token: TOKEN, novaSenha: SENHA }],
      [painel.app, PLATAFORMA.solicitar, { email: 'admin@example.invalid' }],
      [painel.app, PLATAFORMA.redefinir, { token: TOKEN, novaSenha: SENHA }],
    ];
    for (const [app, caminho, corpo] of casos) {
      for (const query of [`token=${TOKEN}`, 'token=', 'a=1', 'utm_source=boletim', `email=${encodeURIComponent(EMAIL)}`, 'escopo=PLATAFORMA']) {
        const r = await request(app).post(`${caminho}?${query}`).send(corpo);
        assert.equal(r.status, 400, `${caminho}?${query.split('=')[0]}`);
        assert.equal(r.body.codigo, 'VALIDACAO');
        semSensiveis(r, [EMAIL]);
      }
      const semQuery = await request(app).post(caminho).send(corpo);
      assert.notEqual(semQuery.status, 400, `${caminho} sem query continua aceito`);
    }
    assert.equal(portal.fetch.chamadas.length, 1, 'o Turnstile só foi chamado na solicitação sem query');
    assert.equal(servico.solicitar.mock.calls.length, 2);
    assert.equal(servico.redefinir.mock.calls.length, 2);
  });
});

describe('limitadores da recuperação', () => {
  const NOMES = [
    'limitadorRecuperacaoSenhaSolicitar', 'limitadorRecuperacaoSenhaRedefinir',
    'limitadorPlataformaRecuperacaoSenhaSolicitar', 'limitadorPlataformaRecuperacaoSenhaRedefinir',
  ];

  test('existem quatro instâncias próprias (solicitar e redefinir, Portal e Painel), todas distintas entre si e das já existentes', () => {
    for (const nome of NOMES) assert.equal(typeof rateLimit[nome], 'function', `limitador ausente: ${nome}`);
    const novos = NOMES.map((nome) => rateLimit[nome]);
    assert.equal(new Set(novos).size, 4, 'quatro contadores independentes');
    const existentes = [
      rateLimit.limitadorGeral, rateLimit.limitadorAutenticacao, rateLimit.limitadorPlataformaGeral, rateLimit.limitadorPlataformaAutenticacao,
      rateLimit.limitadorPlataformaConvite, rateLimit.limitadorConviteUsuario, rateLimit.limitadorPlataformaMfa,
    ];
    for (const novo of novos) {
      for (const existente of existentes) assert.notEqual(novo, existente);
    }
  });

  test('nenhuma variável de ambiente nova: os quatro usam os parâmetros de autenticação já configurados', () => {
    const { httpConfig, carregarConfigHttp } = require('../../src/config/http'); // eslint-disable-line global-require
    assert.deepEqual(Object.keys(httpConfig.rateLimit).sort(), ['autenticacao', 'geral']);
    assert.deepEqual(Object.keys(carregarConfigHttp({ NODE_ENV: 'test' }).rateLimit).sort(), ['autenticacao', 'geral']);
  });

  const manipuladores = (router, caminho, metodo) => {
    const camada = router.stack.find((c) => c.route && c.route.path === caminho && c.route.methods[metodo]);
    assert.ok(camada, `rota ausente: ${metodo.toUpperCase()} ${caminho}`);
    return camada.route.stack.map((c) => c.handle);
  };

  test('cada rota da aplicação começa pelo próprio limitador e não leva nenhum outro; o Turnstile fica só na solicitação do Portal', () => {
    const { recuperacaoSenhaPortalRoutes, recuperacaoSenhaPlataformaRoutes } = rotas();
    const { exigirTurnstileRecuperacaoSenha, exigirTurnstilePortal } = turnstileMiddleware;
    assert.equal(typeof exigirTurnstileRecuperacaoSenha, 'function', 'Turnstile da recuperação ausente');
    assert.notEqual(exigirTurnstileRecuperacaoSenha, exigirTurnstilePortal);

    const cadeias = {
      limitadorRecuperacaoSenhaSolicitar: manipuladores(recuperacaoSenhaPortalRoutes, PORTAL.solicitar, 'post'),
      limitadorRecuperacaoSenhaRedefinir: manipuladores(recuperacaoSenhaPortalRoutes, PORTAL.redefinir, 'post'),
      limitadorPlataformaRecuperacaoSenhaSolicitar: manipuladores(recuperacaoSenhaPlataformaRoutes, PLATAFORMA.solicitar, 'post'),
      limitadorPlataformaRecuperacaoSenhaRedefinir: manipuladores(recuperacaoSenhaPlataformaRoutes, PLATAFORMA.redefinir, 'post'),
    };
    const outros = [
      rateLimit.limitadorGeral, rateLimit.limitadorAutenticacao, rateLimit.limitadorPlataformaGeral, rateLimit.limitadorPlataformaAutenticacao,
      rateLimit.limitadorPlataformaConvite, rateLimit.limitadorConviteUsuario, rateLimit.limitadorPlataformaMfa,
    ];
    for (const [nome, cadeia] of Object.entries(cadeias)) {
      assert.equal(typeof rateLimit[nome], 'function', `limitador ausente: ${nome}`);
      assert.equal(cadeia[0], rateLimit[nome], `${nome} é o primeiro da cadeia`);
      const alheios = [...NOMES.filter((n) => n !== nome).map((n) => rateLimit[n]), ...outros];
      for (const alheio of alheios) assert.equal(cadeia.includes(alheio), false, `${nome}: limitador de outra operação na cadeia`);
      assert.equal(cadeia.includes(exigirTurnstilePortal), false, 'nunca o Turnstile do login');
    }

    const solicitarPortal = cadeias.limitadorRecuperacaoSenhaSolicitar;
    assert.equal(solicitarPortal.indexOf(exigirTurnstileRecuperacaoSenha), solicitarPortal.length - 2, 'Turnstile logo antes do controller');
    for (const nome of NOMES.slice(1)) assert.equal(cadeias[nome].includes(exigirTurnstileRecuperacaoSenha), false, `${nome}: sem Turnstile`);
  });

  test('os logins continuam com os próprios limitadores e o login do Portal com o Turnstile do login', () => {
    const loginPortal = manipuladores(authGlobalRoutes, '/auth/global/login', 'post');
    assert.equal(loginPortal[0], rateLimit.limitadorAutenticacao);
    assert.equal(loginPortal.includes(turnstileMiddleware.exigirTurnstilePortal), true);
    const loginPlataforma = manipuladores(authPlataformaRoutes, '/auth/login', 'post');
    assert.equal(loginPlataforma[0], rateLimit.limitadorPlataformaAutenticacao);
  });

  /**
   * Um app com as rotas reais de login (controllers vazios) e as da
   * recuperação, dos dois portais, cada operação com o próprio limitador e
   * todos com o mesmo limite pequeno. Todas as requisições saem do mesmo IP.
   */
  function appComSeisCotas(limite) {
    const passar = (req, res, next) => next();
    const responder = (req, res) => res.status(200).json({ status: 'ok' });
    const loginPortal = criarAuthGlobalRoutes({
      controller: { login: responder, me: responder, selecionarEmpresa: responder, logout: responder },
      limitador: limitadorDe(limite),
      exigirSessaoGlobal: passar,
      exigirTurnstile: passar,
      turnstileController: criarTurnstileController({ siteKey: SITE_KEY, acao: 'portal_login' }),
    });
    const loginPainel = criarAuthPlataformaRoutes({
      controller: new Proxy({}, { get: () => responder }),
      limitador: limitadorDe(limite),
      limitadorMfa: limitadorDe(1000),
      exigirSessaoPlataforma: passar,
      desafioMfa: () => passar,
    });
    const recuperacaoPortal = rotasDoPortal({ limiteSolicitar: limite, limiteRedefinir: limite });
    const recuperacaoPainel = rotasDoPainel({ limiteSolicitar: limite, limiteRedefinir: limite });
    const app = criarAppTeste((a) => {
      a.use(loginPortal);
      a.use(recuperacaoPortal);
      a.use('/plataforma', loginPainel);
      a.use('/plataforma', recuperacaoPainel);
    });
    const post = (caminho, corpo) => request(app).post(caminho).send(corpo);
    return {
      'login do Portal': () => post('/auth/global/login', { email: EMAIL, senha: SENHA, turnstileToken: TOKEN_WIDGET }),
      'solicitação do Portal': () => post(PORTAL.solicitar, { email: EMAIL, turnstileToken: TOKEN_WIDGET }),
      'redefinição do Portal': () => post(PORTAL.redefinir, { token: TOKEN, novaSenha: SENHA }),
      'login do Painel': () => post('/plataforma/auth/login', { email: 'admin@example.invalid', senha: SENHA }),
      'solicitação do Painel': () => post(`/plataforma${PLATAFORMA.solicitar}`, { email: 'admin@example.invalid' }),
      'redefinição do Painel': () => post(`/plataforma${PLATAFORMA.redefinir}`, { token: TOKEN, novaSenha: SENHA }),
    };
  }

  /**
   * Esgota as operações uma a uma, na ordem dada. Se alguma dividisse o
   * contador com outra já esgotada, a primeira chamada dela já viria 429.
   */
  async function esgotarEmOrdem(operacoes, ordem, limite) {
    for (const nome of ordem) {
      const statuses = [];
      for (let i = 0; i < limite + 1; i += 1) statuses.push((await operacoes[nome]()).status);
      assert.equal(statuses.slice(0, limite).includes(429), false, `${nome}: cota consumida por outra operação (${statuses.join(', ')})`);
      assert.equal(statuses[limite], 429, `${nome}: deveria estourar na chamada ${limite + 1} (${statuses.join(', ')})`);
    }
  }

  const ORDEM = ['login do Portal', 'solicitação do Portal', 'redefinição do Portal', 'login do Painel', 'solicitação do Painel', 'redefinição do Painel'];

  test('seis cotas independentes: login, solicitação e redefinição de cada portal não consomem a cota uma da outra', async (t) => {
    servicoFalso(t);
    await esgotarEmOrdem(appComSeisCotas(3), ORDEM, 3);
  });

  test('a independência vale nos dois sentidos: na ordem inversa, nenhuma operação encontra a cota já consumida', async (t) => {
    servicoFalso(t);
    await esgotarEmOrdem(appComSeisCotas(3), [...ORDEM].reverse(), 3);
  });

  test('dentro de cada portal, esgotar a solicitação não afeta a redefinição, e esgotar a redefinição não afeta a solicitação', async (t) => {
    servicoFalso(t);
    for (const [solicitar, redefinir] of [['solicitação do Portal', 'redefinição do Portal'], ['solicitação do Painel', 'redefinição do Painel']]) {
      const a = appComSeisCotas(2);
      assert.deepEqual([(await a[solicitar]()).status, (await a[solicitar]()).status, (await a[solicitar]()).status], [202, 202, 429], solicitar);
      assert.deepEqual([(await a[redefinir]()).status, (await a[redefinir]()).status], [200, 200], `${redefinir} depois de esgotar a solicitação`);

      const b = appComSeisCotas(2);
      assert.deepEqual([(await b[redefinir]()).status, (await b[redefinir]()).status, (await b[redefinir]()).status], [200, 200, 429], redefinir);
      assert.deepEqual([(await b[solicitar]()).status, (await b[solicitar]()).status], [202, 202], `${solicitar} depois de esgotar a redefinição`);
    }
  });

  test('o limite persistente de 3 por hora do service não é um destes contadores: a rota não o aplica nem o altera', async (t) => {
    const servico = servicoFalso(t);
    const { app } = montarPortal({ limiteSolicitar: 10 });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await request(app).post(PORTAL.solicitar).send({ email: EMAIL, turnstileToken: TOKEN_WIDGET })).status, 202);
    }
    assert.equal(servico.solicitar.mock.calls.length, 5, 'as cinco chegam ao service, que é quem decide o limite por e-mail');
  });
});

describe('fábricas das rotas', () => {
  test('o Portal nunca é montado sem os dois limitadores, sem Turnstile ou sem o controller público do Turnstile', () => {
    const { criarRecuperacaoSenhaPortalRoutes } = rotas();
    const base = {
      controller: controllers().criarRecuperacaoSenhaController({ pool: poolSemBanco, escopo: 'PORTAL' }),
      limitadorSolicitar: limitadorDe(10),
      limitadorRedefinir: limitadorDe(10),
      exigirTurnstile: (req, res, next) => next(),
      turnstileController: criarTurnstileController({ siteKey: SITE_KEY, acao: ACAO_RECUPERACAO }),
    };
    assert.doesNotThrow(() => criarRecuperacaoSenhaPortalRoutes(base));
    for (const ausente of ['limitadorSolicitar', 'limitadorRedefinir', 'exigirTurnstile', 'turnstileController', 'controller']) {
      assert.throws(() => criarRecuperacaoSenhaPortalRoutes({ ...base, [ausente]: undefined }), TypeError, ausente);
    }
  });

  test('o Painel nunca é montado sem os dois limitadores ou sem controller', () => {
    const { criarRecuperacaoSenhaPlataformaRoutes } = rotas();
    const base = {
      controller: controllers().criarRecuperacaoSenhaController({ pool: poolSemBanco, escopo: 'PLATAFORMA' }),
      limitadorSolicitar: limitadorDe(10),
      limitadorRedefinir: limitadorDe(10),
    };
    assert.doesNotThrow(() => criarRecuperacaoSenhaPlataformaRoutes(base));
    for (const ausente of ['limitadorSolicitar', 'limitadorRedefinir', 'controller']) {
      assert.throws(() => criarRecuperacaoSenhaPlataformaRoutes({ ...base, [ausente]: undefined }), TypeError, ausente);
    }
  });

  test('a fábrica recusa a mesma instância de limitador para solicitar e redefinir, nos dois portais', () => {
    const { criarRecuperacaoSenhaPortalRoutes, criarRecuperacaoSenhaPlataformaRoutes } = rotas();
    const unico = limitadorDe(10);
    assert.throws(() => criarRecuperacaoSenhaPortalRoutes({
      controller: controllers().criarRecuperacaoSenhaController({ pool: poolSemBanco, escopo: 'PORTAL' }),
      limitadorSolicitar: unico,
      limitadorRedefinir: unico,
      exigirTurnstile: (req, res, next) => next(),
      turnstileController: criarTurnstileController({ siteKey: SITE_KEY, acao: ACAO_RECUPERACAO }),
    }), TypeError);
    assert.throws(() => criarRecuperacaoSenhaPlataformaRoutes({
      controller: controllers().criarRecuperacaoSenhaController({ pool: poolSemBanco, escopo: 'PLATAFORMA' }),
      limitadorSolicitar: unico,
      limitadorRedefinir: unico,
    }), TypeError);
  });
});
