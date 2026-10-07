'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EpiHttp = require('../js/api-http');
const EpiPortal = require('../js/portal-cliente');

/**
 * Verificação de segurança (Cloudflare Turnstile) no login do Portal.
 * O login.js real roda numa caixa de areia com DOM mínimo, um `turnstile`
 * falso (a API do widget) e fetch injetado no EpiHttp: sem navegador, sem
 * rede e sem Cloudflare real.
 */

const RAIZ = path.join(__dirname, '..');
const BASE = 'http://localhost:3000/api';
const URL_TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SITE_KEY = '1x00000000000000000000AA';
const SEGREDO_FICTICIO = '0x4AAAAAAAsegredoFicticioParaTeste000';
const TOKEN_1 = 'token-um.AAAA_bbbb-1111';
const TOKEN_2 = 'token-dois.CCCC_dddd-2222';

const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const esperar = () => new Promise((resolve) => { setImmediate(resolve); });
async function assentar() { for (let i = 0; i < 6; i += 1) await esperar(); }

function fetchRoteado(respostasDoLogin) {
  const chamadas = [];
  const fila = respostasDoLogin.slice();
  const fn = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    const caminho = url.replace(BASE, '');
    if (opcoes.method === 'GET' && caminho === '/auth/global/me') return resposta(401, { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' });
    if (opcoes.method === 'GET' && caminho === '/auth/global/turnstile') return resposta(200, { status: 'ok', siteKey: SITE_KEY, action: 'portal_login' });
    if (opcoes.method === 'POST' && caminho === '/auth/global/login') {
      const proxima = fila.length > 1 ? fila.shift() : fila[0];
      if (proxima instanceof Error) throw proxima;
      return proxima;
    }
    throw new Error(`rota inesperada: ${opcoes.method} ${caminho}`);
  };
  fn.chamadas = chamadas;
  fn.logins = () => chamadas.filter((c) => c.opcoes.method === 'POST' && c.url.endsWith('/auth/global/login'));
  return fn;
}

function turnstileFalso() {
  const t = {
    renders: [],
    resets: [],
    render(elemento, opcoes) { t.renders.push({ elemento, opcoes }); return 'widget-1'; },
    reset(id) { t.resets.push(id); },
  };
  t.emitir = (evento, ...args) => t.renders[0].opcoes[evento](...args);
  return t;
}

function elemento(id) {
  return {
    id, value: '', disabled: false, textContent: '', className: '', hidden: false, ouvintes: {},
    addEventListener(tipo, fn) { this.ouvintes[tipo] = fn; },
    focus() {},
  };
}

// Largura do contêiner do widget no desktop (cartão de 400px menos padding e borda).
const LARGURA_DESKTOP = 342;

function abrirLogin({
  respostasDoLogin = [resposta(401, { status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'E-mail ou senha inválidos' })],
  turnstile = turnstileFalso(),
  largura = LARGURA_DESKTOP,
} = {}) {
  const fetch = fetchRoteado(respostasDoLogin);
  EpiHttp.configurar({ baseUrl: BASE, fetch });
  const ids = ['form-login', 'email', 'senha', 'botao-entrar', 'mensagem', 'verificacao'];
  const els = Object.fromEntries(ids.map((id) => [id, elemento(id)]));
  if (largura !== null) els.verificacao.getBoundingClientRect = () => ({ width: largura, height: 0 });
  const window = {
    EpiHttp, EpiPortal, turnstile, SAFEWORK_PORTAL_API_BASE_URL: BASE, location: { href: 'index.html' },
  };
  const document = { getElementById: (id) => els[id] || null };
  const codigo = fs.readFileSync(path.join(RAIZ, 'portal/login.js'), 'utf8');
  new Function('window', 'document', codigo)(window, document);
  const enviar = async (email = 'p@x.com', senha = 'SenhaSentinela-9f3a') => {
    els.email.value = email;
    els.senha.value = senha;
    els['form-login'].ouvintes.submit({ preventDefault() {} });
    await assentar();
  };
  return { els, window, fetch, turnstile, enviar };
}

beforeEach(() => {
  EpiHttp.configurar({ baseUrl: BASE, fetch: async () => resposta(200, { status: 'ok' }) });
});

describe('login do Portal com Turnstile', () => {
  test('o widget é renderizado no contêiner com site key e action da configuração pública; opções fixas e sem secret', async () => {
    const { els, turnstile } = abrirLogin();
    await assentar();
    assert.equal(turnstile.renders.length, 1);
    const { elemento: alvo, opcoes } = turnstile.renders[0];
    assert.equal(alvo, els.verificacao);
    assert.deepEqual(Object.keys(opcoes).sort(), [
      'action', 'appearance', 'callback', 'error-callback', 'expired-callback', 'language', 'response-field', 'sitekey', 'size', 'theme', 'timeout-callback',
    ]);
    assert.deepEqual(
      [opcoes.sitekey, opcoes.action, opcoes.theme, opcoes.language, opcoes.size, opcoes.appearance, opcoes['response-field']],
      [SITE_KEY, 'portal_login', 'auto', 'pt-BR', 'flexible', 'always', false],
    );
  });

  test('sem token o login não sai: botão desabilitado e submit não chama a API', async () => {
    const { els, fetch, enviar } = abrirLogin();
    await assentar();
    assert.equal(els['botao-entrar'].disabled, true);
    await enviar();
    assert.equal(fetch.logins().length, 0);
    assert.notEqual(els.mensagem.textContent, '');
    assert.equal(/senha/i.test(els.mensagem.textContent), false, 'não é erro de senha');
  });

  test('callback válido libera o envio; o token vai só no corpo, como turnstileToken, nunca na URL', async () => {
    const { els, fetch, turnstile, enviar } = abrirLogin();
    await assentar();
    turnstile.emitir('callback', TOKEN_1);
    assert.equal(els['botao-entrar'].disabled, false);
    await enviar();
    const [login] = fetch.logins();
    assert.deepEqual(JSON.parse(login.opcoes.body), { email: 'p@x.com', senha: 'SenhaSentinela-9f3a', turnstileToken: TOKEN_1 });
    for (const chamada of fetch.chamadas) assert.equal(chamada.url.includes(TOKEN_1), false);
  });

  for (const [rotulo, respostaDoLogin] of [
    ['400', resposta(400, { status: 'error', codigo: 'VALIDACAO', message: 'Dados inválidos' })],
    ['401', resposta(401, { status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'E-mail ou senha inválidos' })],
    ['403', resposta(403, { status: 'error', codigo: 'VERIFICACAO_SEGURANCA_INVALIDA', message: 'Verificação de segurança inválida' })],
    ['429', resposta(429, { status: 'error', codigo: 'LOGIN_EM_COOLDOWN', message: 'Muitas tentativas. Tente novamente mais tarde' })],
    ['500', resposta(500, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' })],
    ['503', resposta(503, { status: 'error', codigo: 'VERIFICACAO_SEGURANCA_INDISPONIVEL', message: 'Erro interno do servidor' })],
    ['erro de rede depois do envio', new TypeError('Failed to fetch')],
  ]) {
    test(`${rotulo}: o token é descartado, o widget é reiniciado e a próxima tentativa exige token novo`, async () => {
      const { els, fetch, turnstile, enviar } = abrirLogin({ respostasDoLogin: [respostaDoLogin] });
      await assentar();
      turnstile.emitir('callback', TOKEN_1);
      await enviar();
      assert.equal(fetch.logins().length, 1);
      assert.deepEqual(turnstile.resets, ['widget-1']);
      assert.equal(els['botao-entrar'].disabled, true);

      await enviar();
      assert.equal(fetch.logins().length, 1, 'sem token novo, nada é enviado');

      turnstile.emitir('callback', TOKEN_2);
      assert.equal(els['botao-entrar'].disabled, false);
      await enviar();
      const tokens = fetch.logins().map((c) => JSON.parse(c.opcoes.body).turnstileToken);
      assert.deepEqual(tokens, [TOKEN_1, TOKEN_2], 'o token já enviado nunca é reutilizado');
    });
  }

  test('login bem-sucedido segue para o destino sem reiniciar o widget', async () => {
    const { window, turnstile, enviar } = abrirLogin({
      respostasDoLogin: [resposta(200, { status: 'ok', identidade: { id: 1 }, empresas: [{ id: 1 }], contexto: { empresa: { id: 1 } } })],
    });
    await assentar();
    turnstile.emitir('callback', TOKEN_1);
    await enviar();
    assert.equal(window.location.href, '../pages/dashboard.html');
    assert.deepEqual(turnstile.resets, []);
  });

  test('expiração e timeout do desafio limpam o token e bloqueiam o envio até um token novo', async () => {
    for (const evento of ['expired-callback', 'timeout-callback']) {
      const { els, fetch, turnstile, enviar } = abrirLogin();
      await assentar();
      turnstile.emitir('callback', TOKEN_1);
      turnstile.emitir(evento);
      assert.equal(els['botao-entrar'].disabled, true, evento);
      await enviar();
      assert.equal(fetch.logins().length, 0, evento);
    }
  });

  test('error-callback limpa o token, mostra mensagem genérica e informa ao widget que o erro foi tratado', async () => {
    const { els, fetch, turnstile, enviar } = abrirLogin();
    await assentar();
    turnstile.emitir('callback', TOKEN_1);
    assert.equal(turnstile.emitir('error-callback', '110200'), true);
    assert.equal(els['botao-entrar'].disabled, true);
    assert.match(els.mensagem.textContent, /verificação de segurança/i);
    assert.equal(els.mensagem.textContent.includes('110200'), false);
    await enviar();
    assert.equal(fetch.logins().length, 0);
  });

  test('script do Turnstile ausente (bloqueado ou fora do ar): nada é renderizado e o login fica bloqueado com mensagem', async () => {
    const { els, fetch, enviar } = abrirLogin({ turnstile: null });
    await assentar();
    assert.equal(els['botao-entrar'].disabled, true);
    assert.match(els.mensagem.textContent, /verificação de segurança/i);
    await enviar();
    assert.equal(fetch.logins().length, 0);
  });

  test('o token nunca vai para o console', async (t) => {
    const saidas = [];
    for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, metodo, (...a) => { saidas.push(a); });
    const { turnstile, enviar } = abrirLogin();
    await assentar();
    turnstile.emitir('callback', TOKEN_1);
    await enviar();
    assert.ok(saidas.length > 0, 'o cliente HTTP registra método e caminho');
    assert.equal(JSON.stringify(saidas).includes(TOKEN_1), false);
  });
});

describe('tamanho do widget pela largura real do contêiner', () => {
  // Larguras do contêiner #verificacao pelo CSS da página (border-box):
  // até 500px de viewport, viewport - 74 (320 -> 246, 375 -> 301); acima, 342.
  const TAMANHOS_OFICIAIS = ['normal', 'flexible', 'compact'];

  for (const [rotulo, largura, esperado] of [
    ['desktop (342px)', 342, 'flexible'],
    ['viewport 375px (301px)', 301, 'flexible'],
    ['exatamente 300px', 300, 'flexible'],
    ['299,5px', 299.5, 'compact'],
    ['299px', 299, 'compact'],
    ['viewport 320px (246px)', 246, 'compact'],
    ['largura zero', 0, 'compact'],
    ['largura desconhecida', null, 'compact'],
  ]) {
    test(`${rotulo}: size ${esperado}, com o restante das opções preservado`, async () => {
      const { turnstile } = abrirLogin({ largura });
      await assentar();
      assert.equal(turnstile.renders.length, 1, 'um único widget');
      const { opcoes } = turnstile.renders[0];
      assert.equal(opcoes.size, esperado);
      assert.ok(TAMANHOS_OFICIAIS.includes(opcoes.size));
      assert.deepEqual(
        [opcoes.action, opcoes.theme, opcoes.appearance, opcoes['response-field'], opcoes.language],
        ['portal_login', 'auto', 'always', false, 'pt-BR'],
      );
    });
  }

  test('a regra é exposta como função pura: >= 300 flexible; abaixo, zero, negativo ou não numérico, compact', () => {
    const { tamanho } = EpiPortal.verificacao;
    assert.deepEqual([300, 300.01, 342, 1200].map(tamanho), ['flexible', 'flexible', 'flexible', 'flexible']);
    assert.deepEqual([299.99, 246, 0, -1, NaN, Infinity, undefined, null, '400'].map(tamanho), Array(9).fill('compact'));
  });
});

describe('contratos do Portal para a verificação', () => {
  test('entrar exige turnstileToken texto não vazio antes de qualquer rede', async () => {
    let chamadas = 0;
    EpiHttp.configurar({ baseUrl: BASE, fetch: async () => { chamadas += 1; return resposta(200, {}); } });
    for (const turnstileToken of [undefined, '', 123, null]) {
      await assert.rejects(() => EpiPortal.acoes.entrar({ email: 'p@x.com', senha: 's', turnstileToken }), TypeError);
    }
    assert.equal(chamadas, 0);
  });

  test('configuração pública: GET /auth/global/turnstile', async () => {
    const chamadas = [];
    EpiHttp.configurar({ baseUrl: BASE, fetch: async (url, opcoes) => { chamadas.push([opcoes.method, url]); return resposta(200, { status: 'ok', siteKey: SITE_KEY, action: 'portal_login' }); } });
    const r = await EpiPortal.acoes.configuracaoVerificacao();
    assert.deepEqual(chamadas, [['GET', `${BASE}/auth/global/turnstile`]]);
    assert.deepEqual([r.dados.siteKey, r.dados.action], [SITE_KEY, 'portal_login']);
  });

  test('uma secret que o servidor devolvesse por engano nunca chega ao widget', async () => {
    const turnstile = turnstileFalso();
    const fetch = fetchRoteado([resposta(401, {})]);
    const original = fetch;
    const comSegredo = async (url, opcoes) => (url.endsWith('/auth/global/turnstile')
      ? resposta(200, { status: 'ok', siteKey: SITE_KEY, action: 'portal_login', secret: SEGREDO_FICTICIO, secretKey: SEGREDO_FICTICIO })
      : original(url, opcoes));
    EpiHttp.configurar({ baseUrl: BASE, fetch: comSegredo });
    const els = Object.fromEntries(['form-login', 'email', 'senha', 'botao-entrar', 'mensagem', 'verificacao'].map((id) => [id, elemento(id)]));
    const codigo = fs.readFileSync(path.join(RAIZ, 'portal/login.js'), 'utf8');
    new Function('window', 'document', codigo)(
      { EpiHttp, EpiPortal, turnstile, SAFEWORK_PORTAL_API_BASE_URL: BASE, location: { href: 'index.html' } },
      { getElementById: (id) => els[id] || null },
    );
    await assentar();
    assert.equal(JSON.stringify(turnstile.renders[0].opcoes).includes(SEGREDO_FICTICIO), false);
  });

  test('mensagens públicas para verificação inválida e indisponível, sem ecoar o servidor', () => {
    assert.match(EpiPortal.mensagens.deErro({ status: 403, codigo: 'VERIFICACAO_SEGURANCA_INVALIDA', mensagem: 'x' }), /verificação de segurança/i);
    assert.match(EpiPortal.mensagens.deErro({ status: 503, codigo: 'VERIFICACAO_SEGURANCA_INDISPONIVEL', mensagem: 'Erro interno do servidor' }), /temporariamente indisponível/i);
  });
});

describe('página de login do Portal', () => {
  const html = fs.readFileSync(path.join(RAIZ, 'portal/index.html'), 'utf8');
  const semComentarios = html.replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...semComentarios.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);

  test('carrega o script oficial do Turnstile pela URL exata, síncrono e antes do login.js', () => {
    const externos = scripts.filter((attrs) => /src\s*=\s*["']https?:/i.test(attrs));
    assert.equal(externos.length, 1);
    assert.match(externos[0], new RegExp(`src="${URL_TURNSTILE.replace(/[.?]/g, '\\$&')}"`));
    assert.equal(/\b(async|defer)\b/i.test(externos[0]), false);
    const ordem = scripts.map((attrs) => (attrs.match(/src="([^"]+)"/) || [])[1]).filter(Boolean);
    assert.ok(ordem.indexOf(URL_TURNSTILE) < ordem.indexOf('login.js'));
  });

  test('o contêiner do widget fica no formulário, entre a senha e o botão, e o botão nasce desabilitado', () => {
    const senha = semComentarios.indexOf('id="senha"');
    const contêiner = semComentarios.indexOf('id="verificacao"');
    const botao = semComentarios.indexOf('id="botao-entrar"');
    assert.ok(senha > 0 && contêiner > senha && botao > contêiner);
    assert.match(semComentarios, /<button type="submit" id="botao-entrar" class="botao" disabled>Entrar<\/button>/);
  });

  test('nenhum arquivo do login guarda o token fora da memória: sem storage, cookie, URL, dataset ou console com o token', () => {
    for (const arquivo of ['portal/login.js', 'js/portal-cliente.js']) {
      const codigo = fs.readFileSync(path.join(RAIZ, arquivo), 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
      for (const proibido of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'dataset', 'history.', 'location.hash', 'location.search']) {
        assert.equal(codigo.includes(proibido), false, `${arquivo} usa ${proibido}`);
      }
      assert.equal(/console\.[a-z]+\([^)]*token/i.test(codigo), false, `${arquivo} registra token no console`);
      assert.equal(/secret/i.test(codigo), false, `${arquivo} menciona secret`);
    }
  });
});

describe('login do Portal — mensagem por código do servidor (credencial errada x usuário desativado)', () => {
  const GENERICA = 'E-mail ou senha inválidos.';
  const DESATIVADO = 'Usuário desativado. Procure o administrador da empresa.';
  const tentar = async (corpo, status = 401) => {
    const { els, turnstile, enviar } = abrirLogin({ respostasDoLogin: [resposta(status, corpo)] });
    await assentar();
    turnstile.emitir('callback', TOKEN_1);
    await enviar();
    return els.mensagem.textContent;
  };

  test('credencial incorreta (inclusive usuário desativado com senha errada) mostra a mensagem genérica, sem revelar a conta', async () => {
    assert.equal(await tentar({ status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'E-mail ou senha inválidos' }), GENERICA);
    assert.equal(await tentar({ status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'texto qualquer do servidor' }), GENERICA);
  });

  test('credenciais corretas + usuário desativado (USUARIO_DESATIVADO) mostra o texto próprio, da tela, não o do servidor', async () => {
    assert.equal(await tentar({ status: 'error', codigo: 'USUARIO_DESATIVADO', message: 'texto do servidor que a tela não usa' }), DESATIVADO);
  });

  test('senha provisória vencida (SENHA_PROVISORIA_EXPIRADA) também não vira "senha inválida": orienta a recuperação', async () => {
    const m = await tentar({ status: 'error', codigo: 'SENHA_PROVISORIA_EXPIRADA', message: 'x' });
    assert.notEqual(m, GENERICA);
    assert.match(m, /Esqueci minha senha/);
  });
});
