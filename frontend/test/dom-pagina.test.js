'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  abrirPagina, turnstileFalso, ler, semComentarios, scriptsDe, arquivosLocaisDe, URL_TURNSTILE, SVG_NS,
} = require('./helpers/dom-pagina');

/**
 * Controle do harness dom-pagina: antes de confiar nele para provar páginas que
 * ainda não existem, ele é provado contra páginas que já existem (login do
 * Portal, aceite dos dois convites e Segurança da conta do Painel) e contra
 * HTML sintético para os recursos que essas páginas não exercitam. Estes
 * testes não dependem de nada do ciclo de senha.
 */

const TOKEN = 'Zm9ybWF0b2Jhc2U2NHVybGRldG9rZW5jb21fNDNjaGFy'.slice(0, 43);
const ok = (corpo = {}) => ({ status: 200, corpo: { status: 'ok', ...corpo } });
const erro = (status, codigo, message) => ({ status, corpo: { status: 'error', codigo, message } });
const SITE_KEY = '1x00000000000000000000AA';

describe('harness: árvore, estilo e visibilidade, com a página de aceite do Portal', () => {
  const CONVITE = ok({ situacao: 'PENDENTE', empresa: { razaoSocial: 'Empresa Alfa' }, emailConvite: 'nova@exemplo-cliente.com.br', nome: 'Nova Pessoa', perfil: 'SUPERVISOR', identidadeExistente: false });

  test('elementos com e sem id existem na árvore, com pais e textos; display vem do CSS da página e do script', async () => {
    const pg = abrirPagina('portal/aceitar-convite.html', { hash: `#token=${TOKEN}`, rotas: { 'POST /convite-usuario/consultar': CONVITE } });
    assert.equal(pg.el('formAceite').localName, 'form');
    assert.equal(pg.el('senha').getAttribute('autocomplete'), 'new-password');
    assert.equal(pg.el('formAceite').closest('main').getAttribute('class'), 'cartao');
    assert.equal(pg.consulta('h1')[0].textContent, 'Convite de acesso');
    assert.equal(pg.consulta('#formAceite input[type="password"]').length, 2);
    assert.equal(pg.consulta('dl.dados > dt').length, 4);
    assert.equal(pg.documento.title, 'Aceitar convite — SafeWork');

    assert.equal(pg.visivel('carregando'), true);
    assert.equal(pg.visivel('formAceite'), false, 'o CSS da página esconde o formulário até o script mostrar');
    assert.equal(pg.visivel('sucesso'), false);
    await pg.esperar();
    assert.equal(pg.visivel('formAceite'), true, 'o script pôs display:block');
    assert.deepEqual(['empresa', 'email', 'nomeConvite', 'tipoConta'].map((id) => pg.texto(id)), ['Empresa Alfa', 'nova@exemplo-cliente.com.br', 'Nova Pessoa', 'Supervisor']);
  });

  test('o fragmento é lido, a barra de endereço é limpa antes de qualquer rede e o token só vai no corpo', async () => {
    const pg = abrirPagina('portal/aceitar-convite.html', { hash: `#token=${TOKEN}`, rotas: { 'POST /convite-usuario/consultar': CONVITE } });
    assert.equal(pg.location.hash, '', 'depois do replaceState o fragmento não está mais na URL');
    await pg.esperar();
    assert.deepEqual(pg.eventos.map((e) => e.tipo), ['replaceState', 'fetch']);
    assert.deepEqual([pg.historico[0].metodo, pg.historico[0].estado, pg.historico[0].url], ['replaceState', null, '/portal/aceitar-convite.html']);
    assert.deepEqual(pg.chamadas.map((c) => [c.chave, c.corpo, c.temQuery, c.credentials]), [['POST /convite-usuario/consultar', { token: TOKEN }, false, 'include']]);
    assert.equal(pg.chamadas[0].url.includes(TOKEN), false);
    assert.equal(pg.textoDoDom().includes(TOKEN), false);
    assert.deepEqual([pg.storage, pg.cookiesEscritos, pg.externas], [[], [], []]);
  });

  test('prova por mutação: sem o replaceState o fragmento continua na barra, e o harness enxerga', async () => {
    const pg = abrirPagina('portal/aceitar-convite.html', {
      hash: `#token=${TOKEN}`,
      rotas: { 'POST /convite-usuario/consultar': CONVITE },
      transformar: (relativo, codigo) => (relativo === 'portal/aceitar-convite.js' ? codigo.replace('janela.history.replaceState(', '(function () {})(') : codigo),
    });
    await pg.esperar();
    assert.equal(pg.location.hash, `#token=${TOKEN}`);
    assert.deepEqual(pg.historico, []);
    assert.deepEqual(pg.eventos.map((e) => e.tipo), ['fetch']);
  });

  test('sem fragmento, com outro parâmetro ou com o token na query: nenhuma chamada e mensagem de link incompleto', async () => {
    for (const opcoes of [{ hash: '' }, { hash: '#outra=1' }, { hash: '', search: `?token=${TOKEN}` }]) {
      const pg = abrirPagina('portal/aceitar-convite.html', { rotas: { 'POST /convite-usuario/consultar': CONVITE }, ...opcoes });
      await pg.esperar();
      assert.deepEqual(pg.chamadas, [], JSON.stringify(opcoes));
      assert.match(pg.texto('mensagem'), /Link de convite incompleto/);
      assert.equal(pg.visivel('formAceite'), false);
    }
  });

  test('o envio do formulário e a limpeza dos campos passam pelos eventos como no navegador', async () => {
    const pg = abrirPagina('portal/aceitar-convite.html', {
      hash: `#token=${TOKEN}`,
      rotas: { 'POST /convite-usuario/consultar': CONVITE, 'POST /convite-usuario/aceitar': { status: 201, corpo: { status: 'ok', empresa: { razaoSocial: 'Empresa Alfa' } } } },
    });
    await pg.esperar();
    await pg.digitar('senha', 'Correnteza-Azul-Pedra-7319');
    await pg.digitar('senhaConfirmacao', 'Correnteza-Azul-Pedra-7319');
    await pg.clicar('botaoAceitar');
    assert.deepEqual(pg.chamadas.at(-1).corpo, { token: TOKEN, senha: 'Correnteza-Azul-Pedra-7319' });
    assert.deepEqual([pg.el('senha').value, pg.el('senhaConfirmacao').value], ['', '']);
    assert.equal(pg.visivel('sucesso'), true);
    assert.equal(pg.visivel('formAceite'), false);
    assert.equal(pg.el('botaoAceitar').disabled, true, 'o botão fica desabilitado enquanto a página está no estado final');
    assert.deepEqual(pg.enviosNaoInterceptados, []);
  });
});

describe('harness: login do Portal com o Turnstile falso, só pela URL exata', () => {
  const rotas = (extra = {}) => ({
    'GET /auth/global/me': erro(401, 'NAO_AUTENTICADO', 'x'),
    'GET /auth/global/turnstile': ok({ siteKey: SITE_KEY, action: 'portal_login' }),
    ...extra,
  });

  test('o script oficial é registrado como externo, o widget é renderizado no contêiner e o script embutido deixa os links visíveis', async () => {
    const pg = abrirPagina('portal/index.html', { rotas: rotas() });
    await pg.esperar();
    assert.deepEqual(pg.externas, [URL_TURNSTILE]);
    assert.equal(pg.scripts[0], URL_TURNSTILE);
    assert.equal(pg.turnstile.renders.length, 1);
    assert.equal(pg.turnstile.renders[0].elemento, pg.el('verificacao'));
    assert.deepEqual([pg.turnstile.renders[0].opcoes.sitekey, pg.turnstile.renders[0].opcoes.action, pg.turnstile.renders[0].opcoes.size], [SITE_KEY, 'portal_login', 'flexible']);
    assert.equal(pg.visivel('link-logo-site'), true, 'o script embutido mostrou o logo');
    assert.equal(pg.el('link-voltar-site').getAttribute('href'), 'http://localhost:5500/institucional/safework_engenharia_pagina_inicial.html');
    assert.equal(pg.el('botao-entrar').disabled, true, 'sem token o botão fica desabilitado');
  });

  test('com o token do widget o envio sai uma vez, com o token só no corpo, e o sucesso navega', async () => {
    const pg = abrirPagina('portal/index.html', {
      rotas: rotas({ 'POST /auth/global/login': ok({ identidade: { id: 1 }, empresas: [{ id: 1 }], contexto: { empresa: { id: 1 } } }) }),
    });
    await pg.esperar();
    pg.turnstile.emitir('callback', 'token-de-teste-1');
    assert.equal(pg.el('botao-entrar').disabled, false);
    await pg.digitar('email', 'pessoa@exemplo-cliente.com.br');
    await pg.digitar('senha', 'frase-longa-de-teste-42');
    await pg.clicar('botao-entrar');
    const login = pg.chamadas.filter((c) => c.chave === 'POST /auth/global/login');
    assert.equal(login.length, 1);
    assert.deepEqual(login[0].corpo, { email: 'pessoa@exemplo-cliente.com.br', senha: 'frase-longa-de-teste-42', turnstileToken: 'token-de-teste-1' });
    assert.equal(login[0].url.includes('token-de-teste-1'), false);
    assert.deepEqual(pg.navegacoes, ['../pages/dashboard.html']);
    assert.deepEqual([pg.storage, pg.cookiesEscritos, pg.alertas], [[], [], []]);
  });

  test('falha do login reinicia o widget e exige token novo; script bloqueado deixa o botão desabilitado', async () => {
    const pg = abrirPagina('portal/index.html', { rotas: rotas({ 'POST /auth/global/login': erro(401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha inválidos') }) });
    await pg.esperar();
    pg.turnstile.emitir('callback', 'token-de-teste-1');
    await pg.digitar('email', 'pessoa@exemplo-cliente.com.br');
    await pg.digitar('senha', 'errada');
    await pg.clicar('botao-entrar');
    assert.deepEqual(pg.turnstile.resets, ['widget-1']);
    assert.equal(pg.el('botao-entrar').disabled, true);
    assert.match(pg.texto('mensagem'), /E-mail ou senha inválidos/);

    const bloqueado = abrirPagina('portal/index.html', { rotas: rotas(), turnstile: null });
    await bloqueado.esperar();
    assert.equal(bloqueado.janela.turnstile, undefined);
    assert.equal(bloqueado.el('botao-entrar').disabled, true);
    assert.match(bloqueado.texto('mensagem'), /verificação de segurança/i);
  });

  test('qualquer outro script de fora, ou a mesma URL com variação, derruba o carregamento', () => {
    for (const src of [
      'https://cdn.exemplo.invalid/x.js', `${URL_TURNSTILE}&onload=iniciar`, 'https://challenges.cloudflare.com/turnstile/v0/api.js',
      'https://challenges.cloudflare.com.mal.test/turnstile/v0/api.js?render=explicit', '//challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    ]) {
      assert.throws(() => abrirPagina('portal/qualquer.html', { html: `<html><body><script src="${src}"></script></body></html>` }), /script de fora da aplicação/, src);
    }
    const pg = abrirPagina('portal/qualquer.html', { html: `<html><body><script src="${URL_TURNSTILE}"></script><script>window.visto = typeof window.turnstile;</script></body></html>` });
    assert.equal(pg.janela.visto, 'object');
    assert.deepEqual(pg.externas, [URL_TURNSTILE]);
  });
});

describe('harness: convite do Painel (IIFE de navegador) e a base da API do Painel', () => {
  test('lê o fragmento, limpa a barra e chama a API do Painel com caminho relativo à base /api/plataforma', async () => {
    const pg = abrirPagina('painel-privado/aceitar-convite.html', {
      hash: `#token=${TOKEN}`,
      rotas: { 'POST /convite-master/consultar': ok({ empresa: { razaoSocial: 'Empresa Beta' }, emailConvite: 'master@exemplo-cliente.com.br', identidadeExistente: false }) },
    });
    assert.equal(pg.location.hash, '');
    await pg.esperar();
    assert.equal(pg.api, 'http://localhost:3000/api/plataforma');
    assert.deepEqual(pg.chamadas.map((c) => [c.chave, c.corpo]), [['POST /convite-master/consultar', { token: TOKEN }]]);
    assert.equal(pg.visivel('form-aceite'), true);
    assert.equal(pg.texto('empresa'), 'Empresa Beta');
    assert.equal(pg.el('senha').autocomplete, 'new-password');
    assert.equal(pg.janela.SAFEWORK_PLATAFORMA_API_BASE_URL, 'http://localhost:3000/api/plataforma');
  });
});

describe('harness: Segurança da conta do Painel (menu, etapas, SVG e storage espiado)', () => {
  const SENHA = 'frase-longa-de-teste-42';
  const URI = 'otpauth://totp/SafeWork:admin%40safework.test?issuer=SafeWork&secret=KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU&algorithm=SHA1&digits=6&period=30';
  const rotas = () => ({
    'GET /auth/me': ok({ administrador: { id: 1, email: 'admin@safework.test' } }),
    'POST /auth/mfa/substituicao/iniciar': ok({ etapa: 'SUBSTITUICAO', expiraEm: '2026-09-28T12:15:00.000Z', cadastro: { uri: URI, chaveManual: 'KRSX G5CT MVRX EZLU' } }),
  });

  test('o conteúdo só aparece depois da confirmação da sessão; o menu é a única etapa visível; clicar leva à reautenticação', async () => {
    const pg = abrirPagina('painel-privado/seguranca.html', { rotas: rotas() });
    assert.equal(pg.visivel('conteudo'), false);
    assert.deepEqual(pg.etapasVisiveis(), []);
    await pg.esperar();
    assert.equal(pg.visivel('conteudo'), true);
    assert.deepEqual(pg.etapasVisiveis(), ['MENU']);
    await pg.clicar('botao-trocar-autenticador');
    assert.deepEqual(pg.etapasVisiveis(), ['REAUTENTICACAO']);
    assert.equal(pg.foco(), 'senha-atual');
  });

  test('a reautenticação monta o QR como SVG por createElementNS, limpa a senha e não toca storage, cookie nem rede externa', async () => {
    const pg = abrirPagina('painel-privado/seguranca.html', { rotas: rotas() });
    await pg.esperar();
    await pg.clicar('botao-trocar-autenticador');
    await pg.digitar('senha-atual', SENHA);
    await pg.digitar('codigo-atual', '004711');
    await pg.enviar('etapa-reautenticacao');
    assert.deepEqual(pg.chamadas.at(-1).corpo, { senha: SENHA, codigo: '004711' });
    assert.deepEqual(pg.etapasVisiveis(), ['CADASTRO']);
    assert.deepEqual(pg.el('cadastro-qr').children.map((f) => [f.localName, f.namespaceURI]), [['svg', SVG_NS]]);
    assert.deepEqual([pg.el('senha-atual').value, pg.el('codigo-atual').value], ['', '']);
    assert.deepEqual([pg.storage, pg.cookiesEscritos, pg.externas, pg.documento.usosDeInnerHTML, pg.navegacoes], [[], [], [], [], []]);
  });

  test('a restauração da página (pageshow) chega aos ouvintes da janela', async () => {
    const pg = abrirPagina('painel-privado/seguranca.html', { rotas: rotas() });
    await pg.esperar();
    const antes = pg.chamadas.length;
    await pg.eventoDaJanela('pageshow', { persisted: true });
    assert.equal(pg.chamadas[antes].chave, 'GET /auth/me');
  });
});

describe('harness: recursos exercitados só por HTML sintético', () => {
  const abrir = (corpo, scripts = '', opcoes = {}) => abrirPagina('portal/sintetica.html', {
    html: `<!DOCTYPE html><html><head><title>Teste &amp; harness</title><style>.oculto { display: none; } #escondido { display: none; } .a .b { display: none; } @media (max-width: 500px) { #movel { display: none; } }</style></head><body>${corpo}<script>${scripts}</script></body></html>`,
    ...opcoes,
  });

  test('entidades, atributos sem aspas, booleanos e elementos vazios são lidos como o navegador lê', () => {
    const pg = abrir('<p id=p class="x y">a &lt; b &amp; c&#33;</p><input id=i type=text maxlength=6 required disabled value="abc"><br><button id="b" type=button>Ok</button>');
    assert.equal(pg.documento.title, 'Teste & harness');
    assert.equal(pg.texto('p'), 'a < b & c!');
    assert.deepEqual([pg.el('i').maxLength, pg.el('i').required, pg.el('i').disabled, pg.el('i').value], [6, true, true, 'abc']);
    assert.equal(pg.el('p').classList.contains('y'), true);
    assert.equal(pg.el('b').parentNode.localName, 'body');
  });

  test('display: hidden, classe oculta, id escondido, descendente e o que está dentro de @media (ignorado)', () => {
    const pg = abrir('<div id="a1" hidden></div><div id="a2" class="oculto"></div><div id="a3"></div><div id="escondido"><span id="filho"></span></div><div class="a"><i id="b1" class="b"></i></div><div id="movel"></div><div id="a4" class="oculto" style="display:block"></div>');
    pg.el('a4').style.display = 'block';
    assert.deepEqual(['a1', 'a2', 'a3', 'filho', 'b1', 'movel', 'a4'].map((id) => pg.visivel(id)), [false, false, true, false, false, true, true]);
    pg.el('a2').classList.remove('oculto');
    pg.el('a1').hidden = false;
    assert.deepEqual([pg.visivel('a1'), pg.visivel('a2')], [true, true]);
  });

  test('o hidden perde para um display do autor, como no navegador, e volta a valer com a regra [hidden]', () => {
    const pg = abrirPagina('portal/sintetica.html', {
      html: '<!DOCTYPE html><html><head><style>.caixa { display: flex; } .firme { display: flex; } .firme[hidden] { display: none; }</style></head><body><div id="a" class="caixa" hidden></div><div id="b" class="firme" hidden></div><div id="c" hidden></div></body></html>',
    });
    assert.deepEqual(['a', 'b', 'c'].map((id) => pg.visivel(id)), [true, false, false]);
  });

  test('o cookie, o storage e o indexedDB são espiados; o console e o alert também', () => {
    const pg = abrir('', 'document.cookie = "a=1"; localStorage.setItem("k", "v"); sessionStorage.getItem("s"); void window.indexedDB; console.log("oi", { x: 1 }); alert("aviso");');
    assert.deepEqual(pg.cookiesEscritos, ['a=1']);
    assert.deepEqual(pg.storage.map((u) => [u.storage, u.operacao]), [['cookie', 'escrita'], ['localStorage', 'setItem'], ['sessionStorage', 'getItem'], ['indexedDB', 'acesso']]);
    assert.deepEqual(pg.consoleChamadas, [{ nivel: 'log', texto: 'oi {"x":1}' }]);
    assert.deepEqual(pg.alertas, ['aviso']);
  });

  test('temporizadores são falsos: só rodam quando o teste manda e podem ser cancelados', async () => {
    const pg = abrir('<p id="p"></p>', 'var a = setTimeout(function () { document.getElementById("p").textContent += "a"; }, 2000); var b = setTimeout(function () { document.getElementById("p").textContent += "b"; }, 500); var c = setTimeout(function () { window.nuncaRodou = true; }, 10); clearTimeout(c);');
    await pg.esperar();
    assert.equal(pg.texto('p'), '');
    assert.deepEqual(pg.temporizadoresPendentes().map((t) => t.ms), [2000, 500]);
    await pg.avancar(1000);
    assert.equal(pg.texto('p'), 'b');
    await pg.avancar();
    assert.equal(pg.texto('p'), 'ba');
    assert.equal(pg.janela.nuncaRodou, undefined);
  });

  test('eventos sobem pelos ancestrais; clique em botão de envio envia o formulário; cancelar o envio evita a ação padrão; botão desabilitado não recebe clique', async () => {
    const pg = abrir('<form id="f"><input id="campo"><button id="b" type="submit">Enviar</button></form><button id="x" type="button" disabled>X</button>', [
      'var ordem = []; window.ordem = ordem;',
      'document.getElementById("f").addEventListener("submit", function (e) { e.preventDefault(); ordem.push("submit:" + e.target.id); });',
      'document.body.addEventListener("click", function (e) { ordem.push("corpo:" + e.target.id); });',
      'document.getElementById("x").addEventListener("click", function () { ordem.push("x"); });',
    ].join('\n'));
    await pg.clicar('b');
    await pg.clicar('x');
    assert.deepEqual([...pg.janela.ordem], ['corpo:b', 'submit:f']);
    assert.deepEqual(pg.enviosNaoInterceptados, []);
    const solto = abrir('<form id="f"><button id="b">Enviar</button></form>');
    await solto.clicar('b');
    assert.deepEqual(solto.enviosNaoInterceptados, ['f']);
  });

  test('classList, dataset, closest, querySelector composto e seletor não suportado', () => {
    const pg = abrir('<ul id="u" data-info-extra="1"><li class="item" data-id="7"><a id="l" href="x.html">L</a></li></ul>');
    assert.equal(pg.el('u').dataset.infoExtra, '1');
    pg.el('l').dataset.novoValor = 'z';
    assert.equal(pg.el('l').getAttribute('data-novo-valor'), 'z');
    assert.equal(pg.el('l').closest('li.item').dataset.id, '7');
    assert.equal(pg.el('l').closest('[data-id="7"]').localName, 'li');
    assert.equal(pg.documento.querySelector('ul > li a').id, 'l');
    assert.equal(pg.documento.querySelectorAll('li, a').length, 2);
    assert.equal(pg.el('l').classList.toggle('on'), true);
    assert.equal(pg.el('l').className, 'on');
    assert.throws(() => pg.documento.querySelector('a:hover'), /seletor não suportado/);
  });

  test('o fragmento e a query iniciais, o replaceState e o pushState atualizam a URL; atribuir location.href é navegação registrada', async () => {
    const pg = abrir('', 'window.antes = location.hash + "|" + location.search; history.replaceState(null, document.title, location.pathname + location.search); window.depois = "[" + location.hash + "]"; location.href = "index.html";', { hash: '#a=1', search: '?q=2' });
    assert.deepEqual([pg.janela.antes, pg.janela.depois], ['#a=1|?q=2', '[]']);
    assert.deepEqual(pg.navegacoes, ['index.html']);
    assert.deepEqual(pg.eventos.map((e) => e.tipo), ['replaceState', 'navegacao']);
    assert.equal(pg.location.href, 'index.html');
  });

  test('o fetch só aceita a base da API do ambiente; o resto é rede externa bloqueada e fica registrado', async () => {
    const pg = abrir('', [
      'window.resultados = [];',
      'fetch("http://localhost:3000/api/x", { method: "POST", body: "{\\"a\\":1}", credentials: "include" }).then(function (r) { return r.text(); }).then(function (t) { window.resultados.push(t); });',
      'fetch("https://externo.invalid/y").catch(function (e) { window.resultados.push(e.message); });',
    ].join('\n'), { rotas: { 'POST /x': ok({ v: 1 }) } });
    await pg.esperar();
    assert.deepEqual([...pg.janela.resultados].sort(), ['rede externa bloqueada no teste', '{"status":"ok","v":1}'].sort());
    assert.deepEqual(pg.externas, ['https://externo.invalid/y']);
    assert.deepEqual(pg.chamadas.map((c) => [c.chave, c.corpo, c.credentials]), [['POST /x', { a: 1 }, 'include']]);
  });

  test('rota desconhecida responde 404 JSON; função de rota pode segurar a resposta e rota Error simula falha de rede', async () => {
    let liberar;
    const segurada = new Promise((r) => { liberar = r; });
    const pg = abrir('', [
      'window.estados = [];',
      'fetch("http://localhost:3000/api/desconhecida", { method: "GET" }).then(function (r) { window.estados.push(r.status); });',
      'fetch("http://localhost:3000/api/presa", { method: "GET" }).then(function (r) { window.estados.push("presa:" + r.status); });',
      'fetch("http://localhost:3000/api/cai", { method: "GET" }).catch(function () { window.estados.push("rede"); });',
    ].join('\n'), { rotas: { 'GET /presa': () => segurada, 'GET /cai': new Error('falha') } });
    await pg.esperar();
    assert.deepEqual([...pg.janela.estados].sort(), [404, 'rede']);
    liberar({ status: 200, corpo: {} });
    await pg.esperar();
    assert.deepEqual([...pg.janela.estados].sort((a, b) => String(a).localeCompare(String(b))), [404, 'presa:200', 'rede']);
  });
});

describe('harness: leitura estática dos arquivos de uma página', () => {
  test('scriptsDe e arquivosLocaisDe separam externos, locais e embutidos, ignorando comentários', () => {
    const html = ler('portal/index.html');
    const scripts = scriptsDe(html);
    assert.deepEqual(scripts.filter((s) => s.src).map((s) => s.src), [URL_TURNSTILE, '../js/api-http.js', '../js/portal-cliente.js', 'config.js', 'login.js']);
    assert.equal(scripts.filter((s) => s.inline !== undefined).length, 1);
    assert.deepEqual(arquivosLocaisDe('portal/index.html'), ['js/api-http.js', 'js/portal-cliente.js', 'portal/config.js', 'portal/login.js']);
    assert.deepEqual(arquivosLocaisDe('painel-privado/seguranca.html'), [
      'js/api-http.js', 'vendor/qrcode-generator-2.0.4.js', 'painel-privado/config.js', 'painel-privado/mfa.js', 'painel-privado/sair.js', 'painel-privado/seguranca.js', 'painel-privado/mfa.css',
    ]);
  });

  test('semComentarios remove blocos e linhas de comentário sem tocar no código; arquivo ausente falha dizendo que ainda não existe', () => {
    const limpo = semComentarios('/* a */\nvar x = 1; // fica\n  // some\nvar y = 2;').split('\n').filter((linha) => linha.trim() !== '').join('\n');
    assert.equal(limpo, 'var x = 1; // fica\nvar y = 2;');
    assert.throws(() => ler('portal/pagina-que-nao-existe.html'), /arquivo ainda não existe: portal\/pagina-que-nao-existe\.html/);
    assert.throws(() => abrirPagina('portal/pagina-que-nao-existe.html'), /a página portal\/pagina-que-nao-existe\.html ainda não existe/);
  });

  test('o Turnstile falso entrega os callbacks do widget na ordem e devolve o último render', () => {
    const t = turnstileFalso();
    assert.equal(t.render({}, { callback: () => 'a' }), 'widget-1');
    assert.equal(t.render({}, { callback: () => 'b' }), 'widget-2');
    assert.equal(t.emitir('callback'), 'b');
    t.reset('widget-2');
    assert.deepEqual(t.resets, ['widget-2']);
  });
});
