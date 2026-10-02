'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { authConfig } = require('../../src/config/auth');
const { criarTurnstileController } = require('../../src/controllers/turnstile.controller');
const turnstileMiddleware = require('../../src/middleware/turnstile');
const rateLimit = require('../../src/middleware/rate-limit');
const { exigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { exigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarAuthPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const recuperacaoSenhaService = require('../../src/services/recuperacao-senha.service');
const token = require('../../src/security/token');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Rotas HTTP da troca de senha autenticada (Bloco 11E), sem banco: o service é
 * substituído e a sessão é um middleware falso nas fábricas; a validação, o
 * limitador, o controller e o tratamento de erro são os reais. A cadeia de
 * cada rota é fixa: limitador, sessão, validação, controller. Antes de
 * qualquer leitura de corpo vem o 401; antes do 401 vem o 429.
 */

const rotas = () => exigirModulo('src/routes/troca-senha.routes');
const controllers = () => exigirModulo('src/controllers/troca-senha.controller');
const servicoGlobal = () => exigirModulo('src/services/troca-senha-global.service');
const servicoPlataforma = () => exigirModulo('src/services/troca-senha-plataforma.service');

const SENHA_ATUAL = 'planeta-nebulosa-ozonio-42';
const SENHA_NOVA = 'girassol-quartzo-bussola-58';
const CODIGO = '123456';
const OK = { status: 'SENHA_ALTERADA' };
const CAMINHO_PORTAL = '/auth/global/senha';
const CAMINHO_PAINEL = '/auth/senha';
const { cookieNomeGlobal: NOME_GLOBAL, cookieNome: NOME_EMPRESA, cookieNomeAdmin: NOME_ADMIN } = authConfig.sessao;
const TOKEN_GLOBAL = token.gerarTokenSessao();
const TOKEN_EMPRESARIAL = token.gerarTokenSessao();
const TOKEN_ADMIN = token.gerarTokenSessao();
const COOKIE_PORTAL = `${NOME_GLOBAL}=${TOKEN_GLOBAL}; ${NOME_EMPRESA}=${TOKEN_EMPRESARIAL}`;
const COOKIE_PAINEL = `${NOME_ADMIN}=${TOKEN_ADMIN}`;

const CORPO_PORTAL = Object.freeze({ senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA });
const CORPO_PAINEL = Object.freeze({ senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA, codigo: CODIGO });

const poolSemBanco = {
  connect: async () => { throw new Error('o banco não pode ser tocado'); },
  query: async () => { throw new Error('o banco não pode ser tocado'); },
};

const limitadorDe = (limite) => rateLimit.criarLimitador({ limite, janelaSegundos: 60 });
const setCookies = (r) => r.headers['set-cookie'] ?? [];
const SESSAO_INVALIDA = () => HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada');

function sessaoGlobalFalsa({ valida = true } = {}) {
  const chamadas = [];
  const middleware = (req, res, next) => {
    chamadas.push(req.path);
    if (!valida) { next(SESSAO_INVALIDA()); return; }
    req.sessaoGlobal = { id: '7' };
    req.identidade = { id: 42, email: 'pessoa@example.invalid' };
    next();
  };
  return { middleware, chamadas };
}

function sessaoPlataformaFalsa({ valida = true } = {}) {
  const chamadas = [];
  const middleware = (req, res, next) => {
    chamadas.push(req.path);
    if (!valida) { next(SESSAO_INVALIDA()); return; }
    req.sessaoPlataforma = { id: '5' };
    req.administradorPlataforma = { id: 9, email: 'admin@example.invalid' };
    next();
  };
  return { middleware, chamadas };
}

function routerGlobal({ sessao = sessaoGlobalFalsa(), limite = 1000 } = {}) {
  return rotas().criarTrocaSenhaGlobalRoutes({
    controller: controllers().criarTrocaSenhaGlobalController({ pool: poolSemBanco }),
    limitador: limitadorDe(limite),
    exigirSessaoGlobal: sessao.middleware,
  });
}

function routerPlataforma({ sessao = sessaoPlataformaFalsa(), limite = 1000 } = {}) {
  return rotas().criarTrocaSenhaPlataformaRoutes({
    controller: controllers().criarTrocaSenhaPlataformaController({ pool: poolSemBanco }),
    limitador: limitadorDe(limite),
    exigirSessaoPlataforma: sessao.middleware,
  });
}

const appGlobal = (opcoes) => criarAppTeste((app) => app.use(routerGlobal(opcoes)));
const appPlataforma = (opcoes) => criarAppTeste((app) => app.use(routerPlataforma(opcoes)));

function espiarConsole(t) {
  const linhas = [];
  for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, metodo, (...argumentos) => { linhas.push(argumentos.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(' ')); });
  }
  return linhas;
}

const semSensiveis = (r, extras = []) => {
  const texto = JSON.stringify(r.body) + JSON.stringify(r.headers);
  for (const sensivel of [SENHA_ATUAL, SENHA_NOVA, TOKEN_GLOBAL, TOKEN_EMPRESARIAL, TOKEN_ADMIN, CODIGO, ...extras]) {
    assert.equal(texto.includes(sensivel), false, `a resposta contém ${sensivel.slice(0, 8)}…`);
  }
};

// Erro 5xx previsível: o código sai como veio, mas a mensagem é sempre a genérica.
const corpoEsperado = (erro) => (erro.expose
  ? erro.corpoResposta()
  : { status: 'error', codigo: erro.codigo, message: 'Erro interno do servidor' });

const ERROS = [
  [401, HttpError.unauthorized('SENHA_ATUAL_INVALIDA', 'Senha atual incorreta')],
  [401, HttpError.unauthorized('REAUTENTICACAO_INVALIDA', 'Senha ou código inválidos')],
  [400, HttpError.badRequest('SENHA_IGUAL_A_ATUAL', 'A nova senha deve ser diferente da senha atual')],
  [400, HttpError.validacao([{ campo: 'body.novaSenha', codigo: 'SENHA_CURTA', mensagem: 'A senha deve ter pelo menos 12 caracteres' }])],
  [429, HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', 'Muitas tentativas. Tente novamente mais tarde', { retryAfterSegundos: 30 })],
  [429, HttpError.tooManyRequests('MFA_EM_COOLDOWN', 'Muitas tentativas. Tente novamente mais tarde', { retryAfterSegundos: 45 })],
  [503, new HttpError(503, 'MFA_INDISPONIVEL', 'Verificação em duas etapas indisponível no momento')],
];

describe('Portal — POST /auth/global/senha', () => {
  const pedir = (app, corpo = CORPO_PORTAL, cookie = COOKIE_PORTAL) => request(app).post(CAMINHO_PORTAL).set('User-Agent', 'Agente de Teste').set('Cookie', cookie).send(corpo);

  test('sessão válida e corpo válido: 200 com o corpo fixo, sem cookie, e o service recebe a identidade da sessão, as senhas e os tokens dos cookies', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => OK);
    const r = await pedir(appGlobal());

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, OK);
    assert.deepEqual(setCookies(r), []);
    assert.equal(trocar.mock.calls.length, 1);
    const dados = trocar.mock.calls[0].arguments[1];
    assert.deepEqual(Object.keys(dados).sort(), ['dispositivo', 'identidadeId', 'ip', 'novaSenha', 'senhaAtual', 'sessaoGlobalId', 'tokenSessaoEmpresarial', 'tokenSessaoGlobal']);
    assert.deepEqual(
      [dados.identidadeId, dados.sessaoGlobalId, dados.senhaAtual, dados.novaSenha, dados.tokenSessaoGlobal, dados.tokenSessaoEmpresarial, dados.dispositivo],
      [42, '7', SENHA_ATUAL, SENHA_NOVA, TOKEN_GLOBAL, TOKEN_EMPRESARIAL, 'Agente de Teste'],
    );
    semSensiveis(r);
  });

  test('sem sessão: 401 antes de qualquer validação, mesmo com corpo inválido; nem a validação nem o service são alcançados', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => OK);
    const sessao = sessaoGlobalFalsa({ valida: false });
    const app = appGlobal({ sessao });
    for (const corpo of [CORPO_PORTAL, {}, { identidadeId: 1 }, { senhaAtual: '' }]) {
      const r = await pedir(app, corpo, '');
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], JSON.stringify(Object.keys(corpo)));
      assert.deepEqual(setCookies(r), []);
    }
    assert.equal(trocar.mock.calls.length, 0);
    assert.equal(sessao.chamadas.length, 4);
  });

  test('o limitador vem antes de tudo: estourado, responde 429 sem consultar a sessão, sem validar e sem chamar o service', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => OK);
    const sessao = sessaoGlobalFalsa();
    const app = appGlobal({ sessao, limite: 1 });
    assert.equal((await pedir(app)).status, 200);
    const r = await pedir(app, { invalido: true });
    assert.deepEqual([r.status, r.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO']);
    assert.equal(sessao.chamadas.length, 1, 'a sessão só foi consultada na primeira');
    assert.equal(trocar.mock.calls.length, 1);
  });

  test('corpo fora da estrutura: 400 de validação depois da sessão e sem chamar o service, sem ecoar valores', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => OK);
    const app = appGlobal();
    const corpos = [
      {}, { senhaAtual: SENHA_ATUAL }, { novaSenha: SENHA_NOVA }, { senhaAtual: '', novaSenha: SENHA_NOVA }, { senhaAtual: SENHA_ATUAL, novaSenha: '' },
      { senhaAtual: 42, novaSenha: SENHA_NOVA }, { senhaAtual: SENHA_ATUAL, novaSenha: 'x'.repeat(1025) },
      { ...CORPO_PORTAL, identidadeId: 99 }, { ...CORPO_PORTAL, usuarioId: 99 }, { ...CORPO_PORTAL, empresaId: 99 }, { ...CORPO_PORTAL, sessionId: '99' },
      { ...CORPO_PORTAL, email: 'outra@example.invalid' }, { ...CORPO_PORTAL, codigo: CODIGO },
    ];
    for (const corpo of corpos) {
      const r = await pedir(app, corpo);
      assert.equal(r.status, 400, JSON.stringify(Object.keys(corpo)));
      assert.equal(r.body.codigo, 'VALIDACAO');
      semSensiveis(r, ['outra@example.invalid']);
    }
    assert.equal(trocar.mock.calls.length, 0);
  });

  test('qualquer parâmetro na query é recusado com 400, antes do service, mesmo com o corpo correto', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => OK);
    const app = appGlobal();
    for (const query of ['a=1', 'token=x', `senhaAtual=${SENHA_ATUAL}`, 'email=pessoa%40example.invalid']) {
      const r = await request(app).post(`${CAMINHO_PORTAL}?${query}`).set('Cookie', COOKIE_PORTAL).send(CORPO_PORTAL);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], query.split('=')[0]);
      semSensiveis(r);
    }
    assert.equal(trocar.mock.calls.length, 0);
  });

  test('só existe o POST deste caminho: outros métodos, caminho com sufixo e a rota do Painel dão 404', async (t) => {
    const trocar = t.mock.method(servicoGlobal(), 'trocar', async () => OK);
    const app = appGlobal();
    assert.equal((await request(app).get(CAMINHO_PORTAL).set('Cookie', COOKIE_PORTAL)).status, 404);
    assert.equal((await request(app).put(CAMINHO_PORTAL).set('Cookie', COOKIE_PORTAL).send(CORPO_PORTAL)).status, 404);
    assert.equal((await request(app).post(`${CAMINHO_PORTAL}/${TOKEN_GLOBAL}`).set('Cookie', COOKIE_PORTAL).send(CORPO_PORTAL)).status, 404);
    assert.equal((await request(app).post(CAMINHO_PAINEL).set('Cookie', COOKIE_PORTAL).send(CORPO_PAINEL)).status, 404);
    assert.equal(trocar.mock.calls.length, 0);
  });

  test('o que o service recusa sai como veio: mesmo status, código, mensagem e Retry-After, sem cookie e sem dado sensível', async (t) => {
    espiarConsole(t);
    let erroDaVez;
    t.mock.method(servicoGlobal(), 'trocar', async () => { throw erroDaVez; });
    const app = appGlobal();
    for (const [status, erro] of ERROS) {
      erroDaVez = erro;
      const r = await pedir(app);
      assert.equal(r.status, status, erro.codigo);
      assert.deepEqual(r.body, corpoEsperado(erro), erro.codigo);
      if (erro.headers) assert.equal(r.headers['retry-after'], erro.headers['Retry-After'], erro.codigo);
      assert.deepEqual(setCookies(r), []);
      semSensiveis(r);
    }
  });

  test('erro interno: 500 genérico, sem cookie, e nem a resposta nem o log técnico trazem senha, token ou e-mail', async (t) => {
    const linhas = espiarConsole(t);
    t.mock.method(servicoGlobal(), 'trocar', async () => { throw new Error(`falha simulada com ${SENHA_ATUAL}, ${SENHA_NOVA}, ${TOKEN_GLOBAL} e pessoa@example.invalid`); });
    const r = await pedir(appGlobal());
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
    assert.deepEqual(setCookies(r), []);
    const log = linhas.join('\n');
    for (const sensivel of [SENHA_ATUAL, SENHA_NOVA, TOKEN_GLOBAL, TOKEN_EMPRESARIAL, 'pessoa@example.invalid']) {
      assert.equal(log.includes(sensivel), false, 'log técnico com dado sensível');
      assert.equal(JSON.stringify(r.body).includes(sensivel), false);
    }
  });
});

describe('Painel Privado — POST /auth/senha', () => {
  const pedir = (app, corpo = CORPO_PAINEL, cookie = COOKIE_PAINEL) => request(app).post(CAMINHO_PAINEL).set('User-Agent', 'Agente de Teste').set('Cookie', cookie).send(corpo);

  test('sessão plena e corpo válido: 200 com o corpo fixo, sem cookie, e o service recebe o administrador da sessão, as senhas, o TOTP e o token do cookie', async (t) => {
    const trocar = t.mock.method(servicoPlataforma(), 'trocar', async () => OK);
    const r = await pedir(appPlataforma());

    assert.equal(r.status, 200);
    assert.deepEqual(r.body, OK);
    assert.deepEqual(setCookies(r), []);
    const dados = trocar.mock.calls[0].arguments[1];
    assert.deepEqual(Object.keys(dados).sort(), ['administradorId', 'codigo', 'dispositivo', 'ip', 'novaSenha', 'senhaAtual', 'sessaoId', 'tokenSessao']);
    assert.deepEqual(
      [dados.administradorId, dados.sessaoId, dados.senhaAtual, dados.novaSenha, dados.codigo, dados.tokenSessao],
      [9, '5', SENHA_ATUAL, SENHA_NOVA, CODIGO, TOKEN_ADMIN],
    );
    semSensiveis(r);
  });

  test('sem sessão plena: 401 antes de qualquer validação, mesmo com corpo inválido', async (t) => {
    const trocar = t.mock.method(servicoPlataforma(), 'trocar', async () => OK);
    const sessao = sessaoPlataformaFalsa({ valida: false });
    const app = appPlataforma({ sessao });
    for (const corpo of [CORPO_PAINEL, {}, { codigo: 'ABCD-EFGH-JKMN-PQRS' }]) {
      const r = await pedir(app, corpo, '');
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA']);
    }
    assert.equal(trocar.mock.calls.length, 0);
    assert.equal(sessao.chamadas.length, 3);
  });

  test('o limitador vem antes de tudo: estourado, responde 429 sem consultar a sessão e sem chamar o service', async (t) => {
    const trocar = t.mock.method(servicoPlataforma(), 'trocar', async () => OK);
    const sessao = sessaoPlataformaFalsa();
    const app = appPlataforma({ sessao, limite: 1 });
    assert.equal((await pedir(app)).status, 200);
    const r = await pedir(app, {});
    assert.deepEqual([r.status, r.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO']);
    assert.equal(sessao.chamadas.length, 1);
    assert.equal(trocar.mock.calls.length, 1);
  });

  test('o código só pode ser TOTP: recovery code, código curto e campo de recuperação dão 400 sem chamar o service', async (t) => {
    const trocar = t.mock.method(servicoPlataforma(), 'trocar', async () => OK);
    const app = appPlataforma();
    const { codigo: _omitido, ...semCodigo } = CORPO_PAINEL;
    const corpos = [
      { ...CORPO_PAINEL, codigo: 'ABCD-EFGH-JKMN-PQRS' }, { ...CORPO_PAINEL, codigo: '12345' }, { ...CORPO_PAINEL, codigo: '123 456' }, semCodigo,
      { ...semCodigo, codigoRecuperacao: 'ABCD-EFGH-JKMN-PQRS' }, { ...CORPO_PAINEL, codigoRecuperacao: 'ABCD-EFGH-JKMN-PQRS' },
      { ...CORPO_PAINEL, administradorId: 99 }, { ...CORPO_PAINEL, email: 'outra@example.invalid' }, { ...CORPO_PAINEL, turnstileToken: 'x' },
    ];
    for (const corpo of corpos) {
      const r = await pedir(app, corpo);
      assert.equal(r.status, 400, JSON.stringify(Object.keys(corpo)));
      assert.equal(r.body.codigo, 'VALIDACAO');
      semSensiveis(r, ['ABCD-EFGH-JKMN-PQRS']);
    }
    assert.equal(trocar.mock.calls.length, 0);
  });

  test('qualquer parâmetro na query é recusado com 400, antes do service', async (t) => {
    const trocar = t.mock.method(servicoPlataforma(), 'trocar', async () => OK);
    const app = appPlataforma();
    for (const query of ['a=1', `codigo=${CODIGO}`, 'token=x']) {
      const r = await request(app).post(`${CAMINHO_PAINEL}?${query}`).set('Cookie', COOKIE_PAINEL).send(CORPO_PAINEL);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], query.split('=')[0]);
    }
    assert.equal(trocar.mock.calls.length, 0);
  });

  test('só existe o POST deste caminho: outros métodos e a rota do Portal dão 404', async (t) => {
    const trocar = t.mock.method(servicoPlataforma(), 'trocar', async () => OK);
    const app = appPlataforma();
    assert.equal((await request(app).get(CAMINHO_PAINEL).set('Cookie', COOKIE_PAINEL)).status, 404);
    assert.equal((await request(app).delete(CAMINHO_PAINEL).set('Cookie', COOKIE_PAINEL)).status, 404);
    assert.equal((await request(app).post(CAMINHO_PORTAL).set('Cookie', COOKIE_PAINEL).send(CORPO_PORTAL)).status, 404);
    assert.equal(trocar.mock.calls.length, 0);
  });

  test('o que o service recusa sai como veio: mesmo status, código, mensagem e Retry-After, sem cookie e sem dado sensível', async (t) => {
    espiarConsole(t);
    let erroDaVez;
    t.mock.method(servicoPlataforma(), 'trocar', async () => { throw erroDaVez; });
    const app = appPlataforma();
    for (const [status, erro] of ERROS) {
      erroDaVez = erro;
      const r = await pedir(app);
      assert.equal(r.status, status, erro.codigo);
      assert.deepEqual(r.body, corpoEsperado(erro), erro.codigo);
      if (erro.headers) assert.equal(r.headers['retry-after'], erro.headers['Retry-After'], erro.codigo);
      assert.deepEqual(setCookies(r), []);
      semSensiveis(r);
    }
  });

  test('erro interno: 500 genérico, sem cookie, e nem a resposta nem o log técnico trazem senha, TOTP ou token', async (t) => {
    const linhas = espiarConsole(t);
    t.mock.method(servicoPlataforma(), 'trocar', async () => { throw new Error(`falha simulada com ${SENHA_ATUAL}, ${SENHA_NOVA}, ${CODIGO} e ${TOKEN_ADMIN}`); });
    const r = await pedir(appPlataforma());
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
    assert.deepEqual(setCookies(r), []);
    const log = linhas.join('\n');
    for (const sensivel of [SENHA_ATUAL, SENHA_NOVA, CODIGO, TOKEN_ADMIN]) assert.equal(log.includes(sensivel), false, 'log técnico com dado sensível');
  });
});

describe('fábricas e instâncias das rotas', () => {
  test('o Portal nunca é montado sem controller, limitador ou middleware de sessão', () => {
    const { criarTrocaSenhaGlobalRoutes } = rotas();
    const base = {
      controller: controllers().criarTrocaSenhaGlobalController({ pool: poolSemBanco }),
      limitador: limitadorDe(10),
      exigirSessaoGlobal: sessaoGlobalFalsa().middleware,
    };
    assert.doesNotThrow(() => criarTrocaSenhaGlobalRoutes(base));
    for (const ausente of ['controller', 'limitador', 'exigirSessaoGlobal']) {
      assert.throws(() => criarTrocaSenhaGlobalRoutes({ ...base, [ausente]: undefined }), TypeError, ausente);
    }
    assert.throws(() => criarTrocaSenhaGlobalRoutes({ ...base, controller: {} }), TypeError);
    assert.throws(() => criarTrocaSenhaGlobalRoutes(), TypeError);
  });

  test('o Painel nunca é montado sem controller, limitador ou middleware de sessão', () => {
    const { criarTrocaSenhaPlataformaRoutes } = rotas();
    const base = {
      controller: controllers().criarTrocaSenhaPlataformaController({ pool: poolSemBanco }),
      limitador: limitadorDe(10),
      exigirSessaoPlataforma: sessaoPlataformaFalsa().middleware,
    };
    assert.doesNotThrow(() => criarTrocaSenhaPlataformaRoutes(base));
    for (const ausente of ['controller', 'limitador', 'exigirSessaoPlataforma']) {
      assert.throws(() => criarTrocaSenhaPlataformaRoutes({ ...base, [ausente]: undefined }), TypeError, ausente);
    }
    assert.throws(() => criarTrocaSenhaPlataformaRoutes(), TypeError);
  });

  test('o módulo exporta só as duas fábricas e os dois routers da aplicação, e cada router tem exatamente uma rota, POST', () => {
    const modulo = rotas();
    assert.deepEqual(Object.keys(modulo).sort(), ['criarTrocaSenhaGlobalRoutes', 'criarTrocaSenhaPlataformaRoutes', 'trocaSenhaGlobalRoutes', 'trocaSenhaPlataformaRoutes']);
    const rotasDe = (router) => router.stack.filter((camada) => camada.route).map((camada) => [camada.route.path, Object.keys(camada.route.methods)]);
    assert.deepEqual(rotasDe(modulo.trocaSenhaGlobalRoutes), [[CAMINHO_PORTAL, ['post']]]);
    assert.deepEqual(rotasDe(modulo.trocaSenhaPlataformaRoutes), [[CAMINHO_PAINEL, ['post']]]);
    assert.equal(modulo.trocaSenhaGlobalRoutes.stack.every((camada) => camada.route), true, 'nenhum middleware solto no router');
  });
});

describe('limitadores da troca de senha', () => {
  const ANTIGOS = [
    'limitadorGeral', 'limitadorAutenticacao', 'limitadorPlataformaGeral', 'limitadorPlataformaAutenticacao',
    'limitadorPlataformaConvite', 'limitadorConviteUsuario', 'limitadorPlataformaMfa',
  ];
  const RECUPERACAO = [
    'limitadorRecuperacaoSenhaSolicitar', 'limitadorRecuperacaoSenhaRedefinir',
    'limitadorPlataformaRecuperacaoSenhaSolicitar', 'limitadorPlataformaRecuperacaoSenhaRedefinir',
  ];
  const NOVOS = ['limitadorTrocaSenha', 'limitadorPlataformaTrocaSenha'];

  test('existem duas instâncias próprias, distintas entre si e de todas as outras já existentes', () => {
    for (const nome of NOVOS) assert.equal(typeof rateLimit[nome], 'function', `limitador ausente: ${nome}`);
    const todos = [...ANTIGOS, ...RECUPERACAO, ...NOVOS].map((nome) => rateLimit[nome]);
    assert.equal(todos.every((limitador) => typeof limitador === 'function'), true);
    assert.equal(new Set(todos).size, ANTIGOS.length + RECUPERACAO.length + NOVOS.length, 'treze contadores independentes');
  });

  test('nenhuma variável de ambiente nova: os parâmetros de autenticação já configurados bastam', () => {
    const { httpConfig, carregarConfigHttp } = require('../../src/config/http'); // eslint-disable-line global-require
    assert.deepEqual(Object.keys(httpConfig.rateLimit).sort(), ['autenticacao', 'geral']);
    assert.deepEqual(Object.keys(carregarConfigHttp({ NODE_ENV: 'test' }).rateLimit).sort(), ['autenticacao', 'geral']);
  });

  const manipuladores = (router, caminho) => {
    const camada = router.stack.find((c) => c.route && c.route.path === caminho && c.route.methods.post);
    assert.ok(camada, `rota ausente: POST ${caminho}`);
    return camada.route.stack.map((c) => c.handle);
  };

  test('cada rota da aplicação tem a cadeia fixa — o próprio limitador, a sessão do próprio portal, a validação e o controller — e nenhum outro limitador nem Turnstile', () => {
    const { trocaSenhaGlobalRoutes, trocaSenhaPlataformaRoutes } = rotas();
    const { trocaSenhaGlobalController, trocaSenhaPlataformaController } = controllers();
    const alheios = [...ANTIGOS, ...RECUPERACAO].map((nome) => rateLimit[nome]);
    const turnstile = [turnstileMiddleware.exigirTurnstilePortal, turnstileMiddleware.exigirTurnstileRecuperacaoSenha];

    const portal = manipuladores(trocaSenhaGlobalRoutes, CAMINHO_PORTAL);
    assert.equal(portal.length, 4, 'limitador, sessão, validação, controller');
    assert.equal(portal[0], rateLimit.limitadorTrocaSenha);
    assert.equal(portal[1], exigirSessaoGlobal);
    assert.equal(portal[3], trocaSenhaGlobalController.trocar);

    const painel = manipuladores(trocaSenhaPlataformaRoutes, CAMINHO_PAINEL);
    assert.equal(painel.length, 4, 'limitador, sessão, validação, controller');
    assert.equal(painel[0], rateLimit.limitadorPlataformaTrocaSenha);
    assert.equal(painel[1], exigirSessaoPlataforma);
    assert.equal(painel[3], trocaSenhaPlataformaController.trocar);

    for (const cadeia of [portal, painel]) {
      assert.equal(typeof cadeia[2], 'function', 'validação');
      for (const alheio of [...alheios, ...turnstile, rateLimit.limitadorTrocaSenha === cadeia[0] ? rateLimit.limitadorPlataformaTrocaSenha : rateLimit.limitadorTrocaSenha]) {
        assert.equal(cadeia.includes(alheio), false, 'a cadeia só leva o próprio limitador e nenhum Turnstile');
      }
    }
  });

  /**
   * Oito operações num app só, todas do mesmo IP e com o mesmo limite pequeno:
   * os dois logins, a solicitação, a redefinição e a troca de cada portal.
   * Cada uma com o contador próprio.
   */
  function appComOitoCotas(limite) {
    const passar = (req, res, next) => next();
    const responder = (req, res) => res.status(200).json({ status: 'ok' });
    const recuperacao = exigirModulo('src/routes/recuperacao-senha.routes');
    const recuperacaoControllers = exigirModulo('src/controllers/recuperacao-senha.controller');

    const loginPortal = criarAuthGlobalRoutes({
      controller: { login: responder, me: responder, selecionarEmpresa: responder, logout: responder },
      limitador: limitadorDe(limite),
      exigirSessaoGlobal: passar,
      exigirTurnstile: passar,
      turnstileController: criarTurnstileController({ siteKey: '0x4AAAAAAAsiteFicticiaParaTeste', acao: 'portal_login' }),
    });
    const loginPainel = criarAuthPlataformaRoutes({
      controller: new Proxy({}, { get: () => responder }),
      limitador: limitadorDe(limite),
      limitadorMfa: limitadorDe(1000),
      exigirSessaoPlataforma: passar,
      desafioMfa: () => passar,
    });
    const recuperacaoPortal = recuperacao.criarRecuperacaoSenhaPortalRoutes({
      controller: recuperacaoControllers.criarRecuperacaoSenhaController({ pool: poolSemBanco, escopo: 'PORTAL' }),
      limitadorSolicitar: limitadorDe(limite),
      limitadorRedefinir: limitadorDe(limite),
      exigirTurnstile: passar,
      turnstileController: criarTurnstileController({ siteKey: '0x4AAAAAAAsiteFicticiaParaTeste', acao: 'portal_recuperacao_senha' }),
    });
    const recuperacaoPainel = recuperacao.criarRecuperacaoSenhaPlataformaRoutes({
      controller: recuperacaoControllers.criarRecuperacaoSenhaController({ pool: poolSemBanco, escopo: 'PLATAFORMA' }),
      limitadorSolicitar: limitadorDe(limite),
      limitadorRedefinir: limitadorDe(limite),
    });
    const app = criarAppTeste((a) => {
      a.use(loginPortal);
      a.use(recuperacaoPortal);
      a.use(routerGlobal({ limite }));
      a.use('/plataforma', loginPainel);
      a.use('/plataforma', recuperacaoPainel);
      a.use('/plataforma', routerPlataforma({ limite }));
    });
    const post = (caminho, corpo) => request(app).post(caminho).set('Cookie', `${COOKIE_PORTAL}; ${COOKIE_PAINEL}`).send(corpo);
    return {
      'login do Portal': () => post('/auth/global/login', { email: 'pessoa@example.invalid', senha: SENHA_ATUAL, turnstileToken: 'token-do-widget' }),
      'solicitação do Portal': () => post('/auth/global/recuperacao-senha/solicitar', { email: 'pessoa@example.invalid', turnstileToken: 'token-do-widget' }),
      'redefinição do Portal': () => post('/auth/global/recuperacao-senha/redefinir', { token: TOKEN_GLOBAL, novaSenha: SENHA_NOVA }),
      'troca do Portal': () => post(CAMINHO_PORTAL, CORPO_PORTAL),
      'login do Painel': () => post('/plataforma/auth/login', { email: 'admin@example.invalid', senha: SENHA_ATUAL }),
      'solicitação do Painel': () => post('/plataforma/auth/recuperacao-senha/solicitar', { email: 'admin@example.invalid' }),
      'redefinição do Painel': () => post('/plataforma/auth/recuperacao-senha/redefinir', { token: TOKEN_ADMIN, novaSenha: SENHA_NOVA }),
      'troca do Painel': () => post(`/plataforma${CAMINHO_PAINEL}`, CORPO_PAINEL),
    };
  }

  async function esgotarEmOrdem(operacoes, ordem, limite) {
    for (const nome of ordem) {
      const statuses = [];
      for (let i = 0; i < limite + 1; i += 1) statuses.push((await operacoes[nome]()).status);
      assert.equal(statuses.slice(0, limite).includes(429), false, `${nome}: cota consumida por outra operação (${statuses.join(', ')})`);
      assert.equal(statuses[limite], 429, `${nome}: deveria estourar na chamada ${limite + 1} (${statuses.join(', ')})`);
    }
  }

  const ORDEM = [
    'login do Portal', 'solicitação do Portal', 'redefinição do Portal', 'troca do Portal',
    'login do Painel', 'solicitação do Painel', 'redefinição do Painel', 'troca do Painel',
  ];

  function servicosFalsos(t) {
    t.mock.method(servicoGlobal(), 'trocar', async () => OK);
    t.mock.method(servicoPlataforma(), 'trocar', async () => OK);
    t.mock.method(recuperacaoSenhaService, 'solicitar', async () => recuperacaoSenhaService.RESPOSTA_SOLICITACAO);
    t.mock.method(recuperacaoSenhaService, 'redefinir', async () => ({ status: 'SENHA_REDEFINIDA' }));
  }

  test('oito cotas independentes: login, solicitação, redefinição e troca de cada portal não consomem a cota uma da outra', async (t) => {
    servicosFalsos(t);
    await esgotarEmOrdem(appComOitoCotas(3), ORDEM, 3);
  });

  test('a independência vale nos dois sentidos: na ordem inversa, nenhuma operação encontra a cota já consumida', async (t) => {
    servicosFalsos(t);
    await esgotarEmOrdem(appComOitoCotas(3), [...ORDEM].reverse(), 3);
  });
});
