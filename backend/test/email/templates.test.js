'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Templates transacionais oficiais (Bloco 11H): recuperação de senha, senha
 * alterada, convite de usuário e convite do primeiro MASTER, com a variante
 * de reenvio nos dois convites. HTML compatível com clientes de e-mail
 * (tabelas e CSS inline), sem JavaScript, com logo por CID, link textual de
 * fallback e suporte; assuntos sempre constantes.
 */

const modulo = () => exigirModulo('src/email/templates');
const render = (tipo, dados, opcoes) => modulo().renderizar(tipo, dados, { suporte: SUPORTE, ...opcoes });

const SUPORTE = 'suporte@safeworkengenharia.com.br';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const LINK_PORTAL = `https://app.exemplo-cliente.test/portal/redefinir-senha.html#token=${TOKEN}`;
const LINK_PAINEL = `https://admin.exemplo-cliente.test/painel-privado/redefinir-senha.html#token=${TOKEN}`;
const LINK_CONVITE_USUARIO = `https://app.exemplo-cliente.test/portal/aceitar-convite.html#token=${TOKEN}`;
const LINK_CONVITE_MASTER = `https://admin.exemplo-cliente.test/painel-privado/aceitar-convite.html#token=${TOKEN}`;
const EXPIRA = new Date('2026-10-02T15:00:00.000Z');

const CASOS = Object.freeze({
  recuperacaoPortal: ['RECUPERACAO_SENHA', { escopo: 'PORTAL', link: LINK_PORTAL, expiraEm: EXPIRA }, 'Redefinição de senha — Portal do Cliente'],
  recuperacaoPainel: ['RECUPERACAO_SENHA', { escopo: 'PLATAFORMA', link: LINK_PAINEL, expiraEm: EXPIRA }, 'Redefinição de senha — Painel Privado'],
  alteradaPortal: ['SENHA_ALTERADA', { escopo: 'PORTAL', origem: 'TROCA' }, 'Sua senha foi alterada — Portal do Cliente'],
  alteradaPainel: ['SENHA_ALTERADA', { escopo: 'PLATAFORMA', origem: 'REDEFINICAO' }, 'Sua senha foi alterada — Painel Privado'],
  conviteUsuario: ['CONVITE_USUARIO', { link: LINK_CONVITE_USUARIO, expiraEm: EXPIRA, empresa: 'Empresa Convidante Ltda', nome: 'Ana Souza', perfil: 'SUPERVISOR' }, 'Convite para acessar o Portal do Cliente — SafeWork Engenharia'],
  conviteUsuarioReenvio: ['CONVITE_USUARIO', { link: LINK_CONVITE_USUARIO, expiraEm: EXPIRA, empresa: 'Empresa Convidante Ltda', nome: 'Ana Souza', perfil: 'SUPERVISOR', reenvio: true }, 'Novo convite para acessar o Portal do Cliente — SafeWork Engenharia'],
  conviteMaster: ['CONVITE_MASTER', { link: LINK_CONVITE_MASTER, expiraEm: EXPIRA, empresa: 'Empresa Convidante Ltda' }, 'Convite para administrar sua empresa no SafeWork Engenharia'],
  conviteMasterReenvio: ['CONVITE_MASTER', { link: LINK_CONVITE_MASTER, expiraEm: EXPIRA, empresa: 'Empresa Convidante Ltda', reenvio: true }, 'Novo convite para administrar sua empresa no SafeWork Engenharia'],
});

const COM_LINK = ['recuperacaoPortal', 'recuperacaoPainel', 'conviteUsuario', 'conviteUsuarioReenvio', 'conviteMaster', 'conviteMasterReenvio'];
const linkDe = (nome) => CASOS[nome][1].link;

describe('tipos e assuntos', () => {
  test('os quatro tipos existem e cada caso devolve assunto, texto e html', () => {
    assert.deepEqual(Object.keys(modulo().TIPOS).sort(), ['CONVITE_MASTER', 'CONVITE_USUARIO', 'RECUPERACAO_SENHA', 'SENHA_ALTERADA']);
    for (const [nome, [tipo, dados]] of Object.entries(CASOS)) {
      const r = render(tipo, dados);
      assert.deepEqual(Object.keys(r).sort(), ['assunto', 'html', 'texto'], nome);
      for (const parte of Object.values(r)) assert.equal(typeof parte, 'string', nome);
    }
  });

  test('os assuntos são constantes aprovadas e não carregam dado vindo do usuário', () => {
    for (const [nome, [tipo, dados, assunto]] of Object.entries(CASOS)) {
      assert.equal(render(tipo, dados).assunto, assunto, nome);
    }
    const conviteA = render('CONVITE_USUARIO', { ...CASOS.conviteUsuario[1], empresa: 'Outra Empresa SA', nome: 'Beto\r\nBcc: x@y.test' });
    assert.equal(conviteA.assunto, CASOS.conviteUsuario[2]);
    assert.doesNotMatch(conviteA.assunto, /[\r\n]/);
  });

  test('tipo desconhecido, escopo ou origem inválidos são erro de programação', () => {
    assert.throws(() => render('OUTRO', {}), TypeError);
    assert.throws(() => render('RECUPERACAO_SENHA', { escopo: 'OUTRO', link: LINK_PORTAL, expiraEm: EXPIRA }), TypeError);
    assert.throws(() => render('SENHA_ALTERADA', { escopo: 'PORTAL', origem: 'OUTRA' }), TypeError);
    assert.throws(() => render('CONVITE_USUARIO', { ...CASOS.conviteUsuario[1], expiraEm: 'amanhã' }), TypeError);
  });

  test('só link http(s) é aceito: javascript:, data: e texto solto são recusados', () => {
    for (const ruim of ['javascript:alert(1)', 'data:text/html,<b>', 'ftp://x.test/a', 'portal/redefinir-senha.html', '', 'https://x.test/a b', 'https://x.test/a\r\nBcc: z@y.test']) {
      assert.throws(() => render('RECUPERACAO_SENHA', { escopo: 'PORTAL', link: ruim, expiraEm: EXPIRA }), TypeError, JSON.stringify(ruim));
    }
  });
});

describe('conteúdo em texto', () => {
  test('os casos com link o trazem inteiro, em linha própria, com a validade em horário de Brasília e o suporte', () => {
    for (const nome of COM_LINK) {
      const { texto } = render(...CASOS[nome].slice(0, 2));
      assert.ok(texto.split('\n').includes(linkDe(nome)), `${nome}: link em linha própria`);
      assert.match(texto, /02\/10\/2026 às 12:00 \(horário de Brasília\)/, nome);
      assert.ok(texto.includes(SUPORTE), `${nome}: suporte`);
    }
  });

  test('recuperação: uso único e ignorar se não foi a pessoa; convites: ignorar se não esperava', () => {
    assert.match(render(...CASOS.recuperacaoPortal.slice(0, 2)).texto, /só pode ser usado uma vez/);
    assert.match(render(...CASOS.recuperacaoPortal.slice(0, 2)).texto, /ignore esta mensagem/);
    assert.match(render(...CASOS.conviteUsuario.slice(0, 2)).texto, /não esperava este convite, ignore esta mensagem/);
    assert.match(render(...CASOS.conviteMaster.slice(0, 2)).texto, /não esperava este convite, ignore esta mensagem/);
  });

  test('senha alterada: texto próprio da origem, sem link, sem token e com o suporte', () => {
    const troca = render(...CASOS.alteradaPortal.slice(0, 2)).texto;
    const reset = render(...CASOS.alteradaPainel.slice(0, 2)).texto;
    assert.match(troca, /A senha da sua conta acabou de ser alterada e os demais acessos foram encerrados\./);
    assert.match(reset, /A senha da sua conta acabou de ser alterada e os acessos abertos foram encerrados\./);
    for (const texto of [troca, reset]) {
      assert.ok(texto.includes(`fale com o suporte: ${SUPORTE}`));
      assert.doesNotMatch(texto, /https?:\/\/|#token=|redefinir-senha/);
    }
  });

  test('convites: empresa, nome e perfil por extenso; reenvio avisa que o convite anterior deixou de valer', () => {
    const usuario = render(...CASOS.conviteUsuario.slice(0, 2)).texto;
    assert.match(usuario, /Olá, Ana Souza\./);
    assert.ok(usuario.includes('Empresa Convidante Ltda'));
    assert.match(usuario, /Supervisor/);
    assert.doesNotMatch(usuario, /anterior deixou de valer/);
    for (const nome of ['conviteUsuarioReenvio', 'conviteMasterReenvio']) {
      assert.match(render(...CASOS[nome].slice(0, 2)).texto, /o convite anterior deixou de valer/, nome);
    }
    assert.doesNotMatch(render(...CASOS.conviteMaster.slice(0, 2)).texto, /anterior deixou de valer/);
  });

  test('texto vindo do usuário não quebra linha nem forja cabeçalho no texto simples', () => {
    const { texto } = render('CONVITE_USUARIO', { ...CASOS.conviteUsuario[1], nome: 'Ana\r\nBcc: x@y.test', empresa: 'Empresa\nX' });
    assert.doesNotMatch(texto, /^Bcc:/m);
    assert.match(texto, /Olá, Ana Bcc: x@y\.test\./);
  });
});

describe('HTML compatível com clientes de e-mail', () => {
  test('tabelas, CSS inline, logo por CID com texto alternativo e botão com o link, mais o link textual de fallback', () => {
    for (const nome of COM_LINK) {
      const { html } = render(...CASOS[nome].slice(0, 2));
      assert.match(html, /<table[^>]*role="presentation"/, nome);
      assert.match(html, /<img[^>]*src="cid:marca-safework"[^>]*alt="SafeWork Engenharia"/, nome);
      const link = linkDe(nome);
      const botao = html.match(/<a[^>]*href="([^"]+)"[^>]*style="[^"]*background-color:#1f7563[^"]*"[^>]*>/);
      assert.ok(botao, `${nome}: botão com estilo inline`);
      assert.equal(botao[1], link, `${nome}: o botão aponta para o link`);
      assert.equal(html.split(link).length - 1, 3, `${nome}: href do botão, href e texto do link de fallback`);
      assert.ok(html.includes(SUPORTE), `${nome}: suporte`);
      assert.match(html, /<html[^>]*lang="pt-BR"/);
    }
  });

  test('sem JavaScript, sem backdrop-filter, sem recurso externo e sem manipuladores de evento', () => {
    for (const [nome, [tipo, dados]] of Object.entries(CASOS)) {
      const { html } = render(tipo, dados);
      for (const proibido of [/<script/i, /javascript:/i, /backdrop-filter/i, /<link[\s>]/i, /@import/i, /url\(\s*['"]?https?:/i, /\son[a-z]+\s*=/i, /<iframe/i, /<form/i, /<img[^>]*src="https?:/i, /<base[\s>]/i]) {
        assert.doesNotMatch(html, proibido, `${nome}: ${proibido}`);
      }
      assert.ok(Buffer.byteLength(html) < 60 * 1024, `${nome}: html de ${Buffer.byteLength(html)} bytes`);
    }
  });

  test('o modo escuro é só melhoria progressiva: meta color-scheme e media query, com o claro como base', () => {
    for (const [nome, [tipo, dados]] of Object.entries(CASOS)) {
      const { html } = render(tipo, dados);
      assert.match(html, /<meta name="color-scheme" content="light dark">/, nome);
      assert.match(html, /@media \(prefers-color-scheme: dark\)/, nome);
      assert.match(html, /style="[^"]*background-color:#f7f8f6/, `${nome}: fundo claro inline`);
    }
  });

  test('o texto vindo do usuário é escapado e nunca vira marcação', () => {
    const ataque = '<img src=x onerror=alert(1)>"\'';
    const { html } = render('CONVITE_USUARIO', { ...CASOS.conviteUsuario[1], nome: ataque, empresa: ataque });
    assert.doesNotMatch(html, /<img src=x/);
    assert.equal((html.match(/<img\b/g) || []).length, 1, 'só a marca é uma imagem');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;'));
  });

  test('o link é escapado no atributo e a mensagem de senha alterada não tem botão nem link', () => {
    const link = 'https://app.exemplo-cliente.test/portal/aceitar-convite.html#token=AB&x="1"';
    const { html } = render('RECUPERACAO_SENHA', { escopo: 'PORTAL', link, expiraEm: EXPIRA });
    assert.ok(html.includes('href="https://app.exemplo-cliente.test/portal/aceitar-convite.html#token=AB&amp;x=&quot;1&quot;"'));
    for (const nome of ['alteradaPortal', 'alteradaPainel']) {
      assert.doesNotMatch(render(...CASOS[nome].slice(0, 2)).html, /<a[^>]*href=/, nome);
    }
  });

  test('a marca de reenvio e o perfil por extenso aparecem também no HTML', () => {
    assert.match(render(...CASOS.conviteMasterReenvio.slice(0, 2)).html, /o convite anterior deixou de valer/);
    assert.match(render(...CASOS.conviteUsuario.slice(0, 2)).html, /Supervisor/);
  });
});
