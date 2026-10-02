'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  abrirPagina, ler, semComentariosHtml, scriptsDe, URL_TURNSTILE,
} = require('./helpers/dom-pagina');
const {
  EMAIL, OUTRO_EMAIL, ok, erro, SOLICITACAO_RECEBIDA, ATAQUE, semSegredos, tagDe, inspecionarScripts, externosDe, rotasDoBackend, camposDoCorpo,
  exigirConfirmacaoGenerica, descreverRedefinicao,
} = require('./helpers/ciclo-senha');

/**
 * Recuperação de senha no Portal do Cliente (Bloco 11F): o link "Esqueci minha
 * senha" no login, a página que pede o link (com o Turnstile, action própria) e
 * a página que redefine a senha a partir do link. As páginas rodam como no
 * navegador, sobre o harness dom-pagina, com o servidor falso por rota.
 */

const SITE_KEY = '1x00000000000000000000AA';
const TOKEN_1 = 'token-um.AAAA_bbbb-1111';
const TOKEN_2 = 'token-dois.CCCC_dddd-2222';
const RECUPERAR = 'portal/recuperar-senha.html';
const SOLICITAR = 'POST /auth/global/recuperacao-senha/solicitar';
const CONFIGURACAO = 'GET /auth/global/recuperacao-senha/turnstile';

describe('Portal — entrada pelo login: "Esqueci minha senha"', () => {
  test('o link leva à página própria, fica dentro do formulário depois da senha, e o login segue com um único widget e um único script externo', () => {
    const html = semComentariosHtml(ler('portal/index.html'));
    const link = html.match(/<a\b[^>]*\bhref="recuperar-senha\.html"[^>]*>\s*Esqueci minha senha\s*<\/a>/i);
    assert.ok(link, 'portal/index.html não tem o link "Esqueci minha senha" para recuperar-senha.html');
    assert.doesNotMatch(link[0], /target=/i);
    const formulario = html.slice(html.indexOf('<form id="form-login"'), html.indexOf('</form>'));
    assert.ok(formulario.includes(link[0]), 'o link está dentro do formulário de login');
    assert.ok(formulario.indexOf(link[0]) > formulario.indexOf('id="senha"'), 'o link vem depois do campo de senha');
    assert.equal(html.match(/id="verificacao"/g).length, 1, 'continua um único contêiner de widget no login');
    assert.deepEqual(externosDe('portal/index.html').map((s) => s.src), [URL_TURNSTILE]);
  });

  test('o login continua igual: o único widget usa a action do login, a configuração do login é a única consultada e o link não navega sozinho', async () => {
    const pg = abrirPagina('portal/index.html', {
      rotas: {
        'GET /auth/global/me': erro(401, 'NAO_AUTENTICADO', 'x'),
        'GET /auth/global/turnstile': ok({ siteKey: SITE_KEY, action: 'portal_login' }),
      },
    });
    await pg.esperar();
    assert.equal(pg.consulta('a[href="recuperar-senha.html"]').length, 1);
    assert.equal(pg.turnstile.renders.length, 1);
    assert.equal(pg.turnstile.renders[0].opcoes.action, 'portal_login');
    assert.deepEqual(pg.chamadas.map((c) => c.chave).sort(), ['GET /auth/global/me', 'GET /auth/global/turnstile']);
    assert.deepEqual(pg.navegacoes, []);
  });
});

describe(`Portal — pedido do link (${RECUPERAR})`, () => {
  const rotas = (extra = {}) => ({ [CONFIGURACAO]: ok({ siteKey: SITE_KEY, action: 'portal_recuperacao_senha' }), [SOLICITAR]: SOLICITACAO_RECEBIDA, ...extra });
  async function abrir(extra, opcoes = {}) {
    const pg = abrirPagina(RECUPERAR, { rotas: rotas(extra), ...opcoes });
    await pg.esperar();
    return pg;
  }
  const pedidos = (pg) => pg.chamadas.filter((c) => c.chave === SOLICITAR);
  async function pedir(pg, email = EMAIL, token = TOKEN_1) {
    if (token) pg.turnstile.emitir('callback', token);
    await pg.digitar('email', email);
    await pg.clicar('botao-enviar');
  }

  test('marcação: sem referrer, o Turnstile oficial como primeiro e único script externo, e-mail com rótulo, widget entre o e-mail e o botão, botão desabilitado ao nascer', () => {
    const html = ler(RECUPERAR);
    const limpo = semComentariosHtml(html);
    assert.match(limpo, /<meta name="referrer" content="no-referrer">/);
    const externos = externosDe(RECUPERAR);
    assert.deepEqual(externos.map((s) => s.src), [URL_TURNSTILE]);
    assert.equal(/\b(async|defer)\b/i.test(externos[0].atributos), false, 'o script do Turnstile é síncrono');
    assert.equal(scriptsDe(html).filter((s) => s.src)[0].src, URL_TURNSTILE, 'o Turnstile vem antes do script da página');
    assert.match(tagDe(html, 'form-recuperacao'), /\bnovalidate\b/);
    assert.match(tagDe(html, 'email'), /type="email"/);
    assert.match(limpo, /<label\b[^>]*\bfor="email"/);
    assert.match(tagDe(html, 'botao-enviar'), /type="submit"/);
    assert.match(tagDe(html, 'botao-enviar'), /\bdisabled\b/);
    assert.match(tagDe(html, 'mensagem'), /aria-live="(?:polite|assertive)"/);
    tagDe(html, 'confirmacao');
    const [email, widget, botao] = ['id="email"', 'id="verificacao"', 'id="botao-enviar"'].map((marca) => limpo.indexOf(marca));
    assert.ok(email > 0 && widget > email && botao > widget, 'o widget fica entre o e-mail e o botão');
    assert.equal(limpo.match(/id="verificacao"/g).length, 1);
    assert.match(limpo, /<a\b[^>]*\bhref="index\.html"/, 'há caminho de volta ao login');
  });

  test('o widget usa a configuração pública da recuperação, com a action própria e as opções do login; a configuração do login não é consultada', async () => {
    const pg = await abrir();
    assert.equal(pg.chamadas.filter((c) => c.chave === CONFIGURACAO).length, 1);
    assert.equal(pg.chamadas.filter((c) => c.chave === 'GET /auth/global/turnstile').length, 0);
    assert.equal(pg.turnstile.renders.length, 1);
    const { elemento, opcoes } = pg.turnstile.renders[0];
    assert.equal(elemento, pg.el('verificacao'));
    assert.deepEqual(Object.keys(opcoes).sort(), [
      'action', 'appearance', 'callback', 'error-callback', 'expired-callback', 'language', 'response-field', 'sitekey', 'size', 'theme', 'timeout-callback',
    ]);
    assert.deepEqual(
      [opcoes.sitekey, opcoes.action, opcoes.theme, opcoes.language, opcoes.size, opcoes.appearance, opcoes['response-field']],
      [SITE_KEY, 'portal_recuperacao_senha', 'auto', 'pt-BR', 'flexible', 'always', false],
    );
    assert.equal(pg.el('botao-enviar').disabled, true);
    assert.deepEqual(pg.externas, [URL_TURNSTILE]);
  });

  test('sem token do widget, ou com o script do Turnstile bloqueado, o pedido não sai e a pessoa vê o motivo', async () => {
    const pg = await abrir();
    await pg.digitar('email', EMAIL);
    await pg.enviarSemEsperar('form-recuperacao');
    await pg.esperar();
    assert.equal(pedidos(pg).length, 0);
    assert.match(pg.texto('mensagem'), /verificação de segurança/i);

    const bloqueado = await abrir({}, { turnstile: null });
    assert.equal(bloqueado.el('botao-enviar').disabled, true);
    assert.match(bloqueado.texto('mensagem'), /verificação de segurança/i);
    await bloqueado.digitar('email', EMAIL);
    await bloqueado.enviarSemEsperar('form-recuperacao');
    await bloqueado.esperar();
    assert.equal(pedidos(bloqueado).length, 0);
  });

  test('com o token do widget sai um POST com e-mail e turnstileToken só no corpo, com cookies e sem nada na URL', async () => {
    const pg = await abrir();
    await pedir(pg);
    assert.equal(pg.el('botao-enviar').disabled, true);
    assert.equal(pedidos(pg).length, 1);
    const [c] = pedidos(pg);
    assert.deepEqual([c.corpo, c.temQuery, c.credentials], [{ email: EMAIL, turnstileToken: TOKEN_1 }, false, 'include']);
    semSegredos(c.url, 'a URL', [TOKEN_1, EMAIL, encodeURIComponent(EMAIL)]);
  });

  test('202: confirmação genérica e idêntica para qualquer e-mail, sem repetir o e-mail e sem dizer que algo foi enviado; o formulário sai', async () => {
    const textos = [];
    for (const email of [EMAIL, OUTRO_EMAIL]) {
      const pg = await abrir();
      await pedir(pg, email);
      assert.equal(pg.visivel('confirmacao'), true);
      assert.equal(pg.visivel('form-recuperacao'), false);
      exigirConfirmacaoGenerica(pg.texto('confirmacao'), email);
      semSegredos(pg.texto('mensagem'), 'a mensagem de erro', [email]);
      textos.push(pg.texto('confirmacao'));
    }
    assert.equal(textos[0], textos[1], 'a confirmação não depende do e-mail');
  });

  for (const [caso, falha, esperado] of [
    ['400', erro(400, 'VALIDACAO', 'Dados inválidos'), /e-?mail|dados|confira|revis/i],
    ['403 verificação inválida', erro(403, 'VERIFICACAO_SEGURANCA_INVALIDA', 'Verificação de segurança inválida'), /verificação de segurança/i],
    ['429', erro(429, 'LIMITE_REQUISICOES_EXCEDIDO', 'Muitas requisições. Tente novamente mais tarde'), /muitas|aguard|tente novamente/i],
    ['500', erro(500, 'ERRO_INTERNO', 'Erro interno do servidor'), /erro|não foi possível|tente/i],
    ['503 verificação indisponível', erro(503, 'VERIFICACAO_SEGURANCA_INDISPONIVEL', 'Erro interno do servidor'), /temporariamente indisponível/i],
    ['falha de rede', new Error('sem rede'), /conex|servidor/i],
  ]) {
    test(`${caso}: nenhuma confirmação, mensagem própria, widget reiniciado e nova tentativa só com token novo`, async () => {
      let tentativas = 0;
      const pg = await abrir({ [SOLICITAR]: () => { tentativas += 1; return tentativas === 1 ? falha : SOLICITACAO_RECEBIDA; } });
      await pedir(pg);
      assert.match(pg.texto('mensagem'), esperado);
      assert.equal(pg.visivel('confirmacao'), false);
      assert.equal(pg.visivel('form-recuperacao'), true);
      assert.deepEqual(pg.turnstile.resets, ['widget-1']);
      assert.equal(pg.el('botao-enviar').disabled, true);

      await pg.enviarSemEsperar('form-recuperacao');
      await pg.esperar();
      assert.equal(pedidos(pg).length, 1, 'sem token novo nada é enviado');

      pg.turnstile.emitir('callback', TOKEN_2);
      await pg.clicar('botao-enviar');
      assert.deepEqual(pedidos(pg).map((c) => c.corpo.turnstileToken), [TOKEN_1, TOKEN_2], 'o token já enviado nunca é reutilizado');
      assert.equal(pg.visivel('confirmacao'), true);
    });
  }

  test('enquanto o pedido está pendente o botão fica desabilitado e um segundo envio, mesmo com token novo, não gera outra chamada', async () => {
    let liberar;
    const presa = new Promise((resolve) => { liberar = resolve; });
    const pg = await abrir({ [SOLICITAR]: () => presa });
    pg.turnstile.emitir('callback', TOKEN_1);
    await pg.digitar('email', EMAIL);
    const primeiro = pg.enviarSemEsperar('form-recuperacao');
    await pg.esperar();
    assert.equal(pg.el('botao-enviar').disabled, true);
    pg.turnstile.emitir('callback', TOKEN_2);
    await pg.enviarSemEsperar('form-recuperacao');
    await pg.esperar();
    assert.equal(pedidos(pg).length, 1);
    liberar(SOLICITACAO_RECEBIDA);
    await primeiro;
    await pg.esperar();
    assert.equal(pg.visivel('confirmacao'), true);
    assert.equal(pedidos(pg).length, 1);
  });

  test('o que vem do servidor entra na tela como texto, nunca como HTML', async () => {
    const pg = await abrir({ [SOLICITAR]: erro(400, 'OUTRO_CODIGO', ATAQUE) });
    await pedir(pg);
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
    assert.equal(pg.consulta('img').length, 0);
  });

  test('nada sensível fora do lugar: sem storage, cookie, innerHTML nem console com token ou e-mail; só o script oficial de fora', async () => {
    const pg = await abrir();
    await pedir(pg);
    assert.equal(pg.visivel('confirmacao'), true);
    assert.deepEqual([pg.storage, pg.cookiesEscritos, pg.documento.usosDeInnerHTML, pg.alertas, pg.navegacoes], [[], [], [], [], []]);
    assert.deepEqual(pg.externas, [URL_TURNSTILE]);
    assert.ok(pg.consoleChamadas.length > 0, 'o cliente HTTP registra método, caminho e status');
    semSegredos(pg.consoleChamadas.map((c) => c.texto).join('\n'), 'o console', [TOKEN_1, EMAIL]);
    semSegredos(pg.textoDoDom(), 'o DOM', [TOKEN_1]);
    for (const c of pg.chamadas) semSegredos(c.url, 'a URL', [TOKEN_1, EMAIL]);
  });

  test('os scripts da página não usam storage, cookie, HTML inseguro, eval, console nem navegação pelo histórico', () => {
    const arquivos = inspecionarScripts(RECUPERAR);
    assert.ok(arquivos.includes('js/portal-cliente.js') || arquivos.some((f) => f.startsWith('portal/')));
  });

  test('contrato com o backend: as chamadas da página são rotas do backend e o corpo tem exatamente os campos do schema', async () => {
    const pg = await abrir();
    await pedir(pg);
    const declaradas = rotasDoBackend('recuperacao-senha.routes.js');
    assert.ok(pg.chamadas.length >= 2);
    for (const c of pg.chamadas) assert.ok(declaradas.has(`${c.metodo} ${c.caminho}`), `${c.chave} não é rota do backend`);
    assert.deepEqual(Object.keys(pedidos(pg)[0].corpo).sort(), camposDoCorpo('recuperacao-senha.schema.js', 'solicitarPortal'));
  });
});

descreverRedefinicao({
  rotulo: 'Portal',
  pagina: 'portal/redefinir-senha.html',
  rota: 'POST /auth/global/recuperacao-senha/redefinir',
  arquivoRotas: 'recuperacao-senha.routes.js',
  caminhoNoBackend: '/auth/global/recuperacao-senha/redefinir',
});
