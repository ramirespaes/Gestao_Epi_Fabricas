'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');
const {
  EMAIL, OUTRO_EMAIL, erro, SOLICITACAO_RECEBIDA, ATAQUE, semSegredos, tagDe, inspecionarScripts, externosDe, rotasDoBackend, camposDoCorpo,
  exigirConfirmacaoGenerica, descreverRedefinicao,
} = require('./helpers/ciclo-senha');

/**
 * Recuperação de senha no Painel Privado (Bloco 11F): o link "Esqueci minha
 * senha" no login, a página que pede o link, sem Turnstile, e a página que
 * redefine a senha a partir do link. A origem do Painel é outra: as chamadas
 * vão para /api/plataforma e nada é compartilhado com o Portal além do cliente
 * HTTP.
 */

const RECUPERAR = 'painel-privado/recuperar-senha.html';
const SOLICITAR = 'POST /auth/recuperacao-senha/solicitar';

describe('Painel Privado — entrada pelo login: "Esqueci minha senha"', () => {
  test('o link leva à página própria e fica só na etapa de senha do login, não nas etapas do segundo fator', () => {
    const html = semComentariosHtml(ler('painel-privado/index.html'));
    const link = html.match(/<a\b[^>]*\bhref="recuperar-senha\.html"[^>]*>\s*Esqueci minha senha\s*<\/a>/i);
    assert.ok(link, 'painel-privado/index.html não tem o link "Esqueci minha senha" para recuperar-senha.html');
    assert.doesNotMatch(link[0], /target=/i);
    const login = html.slice(html.indexOf('<form id="form-login"'), html.indexOf('</form>'));
    assert.ok(login.includes(link[0]), 'o link está dentro do formulário de login (etapa LOGIN)');
    assert.ok(login.indexOf(link[0]) > login.indexOf('id="senha"'), 'o link vem depois do campo de senha');
    assert.equal(html.split(link[0]).length - 1, 1, 'um único link');
  });

  test('a etapa de login abre como antes: só o formulário de login visível, e o link existe nela', async () => {
    const pg = abrirPagina('painel-privado/index.html', { rotas: { 'GET /auth/mfa/estado': erro(401, 'DESAFIO_INVALIDO', 'x') } });
    await pg.esperar();
    assert.deepEqual(pg.etapasVisiveis(), ['LOGIN']);
    assert.equal(pg.consulta('#form-login a[href="recuperar-senha.html"]').length, 1);
    assert.deepEqual(pg.navegacoes, []);
  });
});

describe(`Painel Privado — pedido do link (${RECUPERAR})`, () => {
  const abrir = (rotas = {}, opcoes = {}) => abrirPagina(RECUPERAR, { rotas: { [SOLICITAR]: SOLICITACAO_RECEBIDA, ...rotas }, ...opcoes });
  async function abrirPronta(rotas, opcoes) {
    const pg = abrir(rotas, opcoes);
    await pg.esperar();
    return pg;
  }
  const pedidos = (pg) => pg.chamadas.filter((c) => c.chave === SOLICITAR);
  async function pedir(pg, email = EMAIL) {
    await pg.digitar('email', email);
    await pg.clicar('botao-enviar');
  }

  test('marcação: sem script externo, sem Turnstile, e-mail com rótulo, envio habilitado, confirmação oculta ao nascer, caminho de volta ao login', () => {
    const html = ler(RECUPERAR);
    const limpo = semComentariosHtml(html);
    assert.match(limpo, /<meta name="referrer" content="no-referrer">/);
    assert.deepEqual(externosDe(RECUPERAR), [], 'o Painel não usa Turnstile nem outro script de fora');
    assert.doesNotMatch(limpo, /turnstile|cloudflare|id="verificacao"/i);
    assert.match(tagDe(html, 'form-recuperacao'), /\bnovalidate\b/);
    assert.match(tagDe(html, 'email'), /type="email"/);
    assert.match(limpo, /<label\b[^>]*\bfor="email"/);
    assert.match(tagDe(html, 'botao-enviar'), /type="submit"/);
    assert.doesNotMatch(tagDe(html, 'botao-enviar'), /\bdisabled\b/, 'sem widget, o botão não espera token');
    assert.match(tagDe(html, 'mensagem'), /aria-live="(?:polite|assertive)"/);
    tagDe(html, 'confirmacao');
    assert.match(limpo, /<a\b[^>]*\bhref="index\.html"/);
  });

  test('o pedido sai só com o e-mail no corpo, para a base do Painel, sem token de verificação, e nenhuma configuração de widget é consultada', async () => {
    const pg = await abrirPronta();
    assert.equal(pg.turnstile.renders.length, 0);
    await pedir(pg);
    assert.deepEqual(pg.chamadas.filter((c) => /turnstile|verificacao/i.test(c.caminho)), []);
    assert.equal(pedidos(pg).length, 1);
    const [c] = pedidos(pg);
    assert.deepEqual([c.corpo, c.temQuery, c.credentials], [{ email: EMAIL }, false, 'include']);
    assert.ok(c.url.startsWith('http://localhost:3000/api/plataforma/'), c.url);
    semSegredos(c.url, 'a URL', [EMAIL, encodeURIComponent(EMAIL)]);
    assert.deepEqual(pg.externas, []);
  });

  test('202: confirmação genérica e idêntica para qualquer e-mail, sem repetir o e-mail e sem dizer que algo foi enviado; o formulário sai', async () => {
    const textos = [];
    for (const email of [EMAIL, OUTRO_EMAIL]) {
      const pg = await abrirPronta();
      assert.equal(pg.visivel('confirmacao'), false);
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
    ['429', erro(429, 'LIMITE_REQUISICOES_EXCEDIDO', 'Muitas requisições. Tente novamente mais tarde'), /muitas|aguard|tente novamente/i],
    ['500', erro(500, 'ERRO_INTERNO', 'Erro interno do servidor'), /erro|não foi possível|tente/i],
    ['falha de rede', new Error('sem rede'), /conex|servidor/i],
  ]) {
    test(`${caso}: nenhuma confirmação, mensagem própria, formulário mantido e nova tentativa possível`, async () => {
      let tentativas = 0;
      const pg = await abrirPronta({ [SOLICITAR]: () => { tentativas += 1; return tentativas === 1 ? falha : SOLICITACAO_RECEBIDA; } });
      await pedir(pg);
      assert.match(pg.texto('mensagem'), esperado);
      assert.equal(pg.visivel('confirmacao'), false);
      assert.equal(pg.visivel('form-recuperacao'), true);
      assert.equal(pg.el('botao-enviar').disabled, false);
      await pedir(pg);
      assert.equal(pedidos(pg).length, 2);
      assert.equal(pg.visivel('confirmacao'), true);
    });
  }

  test('e-mail vazio não vai ao servidor', async () => {
    const pg = await abrirPronta();
    await pedir(pg, '');
    assert.equal(pedidos(pg).length, 0);
    assert.notEqual(pg.texto('mensagem').trim(), '');
    assert.equal(pg.visivel('form-recuperacao'), true);
  });

  test('enquanto o pedido está pendente o botão fica desabilitado e um segundo envio não gera outra chamada', async () => {
    let liberar;
    const presa = new Promise((resolve) => { liberar = resolve; });
    const pg = await abrirPronta({ [SOLICITAR]: () => presa });
    await pg.digitar('email', EMAIL);
    const primeiro = pg.enviarSemEsperar('form-recuperacao');
    await pg.esperar();
    assert.equal(pg.el('botao-enviar').disabled, true);
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
    const pg = await abrirPronta({ [SOLICITAR]: erro(400, 'OUTRO_CODIGO', ATAQUE) });
    await pedir(pg);
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
    assert.equal(pg.consulta('img').length, 0);
  });

  test('nada sensível fora do lugar: sem storage, cookie, rede externa, innerHTML nem console com o e-mail', async () => {
    const pg = await abrirPronta();
    await pedir(pg);
    assert.equal(pg.visivel('confirmacao'), true);
    assert.deepEqual([pg.storage, pg.cookiesEscritos, pg.externas, pg.documento.usosDeInnerHTML, pg.alertas, pg.navegacoes], [[], [], [], [], [], []]);
    assert.ok(pg.consoleChamadas.length > 0, 'o cliente HTTP registra método, caminho e status');
    semSegredos(pg.consoleChamadas.map((c) => c.texto).join('\n'), 'o console', [EMAIL]);
    for (const c of pg.chamadas) semSegredos(c.url, 'a URL', [EMAIL]);
  });

  test('os scripts da página não usam storage, cookie, HTML inseguro, eval, console nem navegação pelo histórico', () => {
    assert.ok(inspecionarScripts(RECUPERAR).length > 0);
  });

  test('contrato com o backend: a chamada da página é rota do backend e o corpo tem exatamente os campos do schema', async () => {
    const pg = await abrirPronta();
    await pedir(pg);
    assert.ok(rotasDoBackend('recuperacao-senha.routes.js').has('POST /auth/recuperacao-senha/solicitar'));
    for (const c of pg.chamadas) assert.ok(rotasDoBackend('recuperacao-senha.routes.js').has(`${c.metodo} ${c.caminho}`), `${c.chave} não é rota do backend`);
    assert.deepEqual(Object.keys(pedidos(pg)[0].corpo).sort(), camposDoCorpo('recuperacao-senha.schema.js', 'solicitarPlataforma'));
  });
});

descreverRedefinicao({
  rotulo: 'Painel Privado',
  pagina: 'painel-privado/redefinir-senha.html',
  rota: 'POST /auth/recuperacao-senha/redefinir',
  arquivoRotas: 'recuperacao-senha.routes.js',
  caminhoNoBackend: '/auth/recuperacao-senha/redefinir',
});
