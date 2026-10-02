'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-painel');

/**
 * Convite do primeiro MASTER no Painel Privado (Bloco 11H), na página real de
 * empresas: o link de aceite só aparece quando o servidor o devolve (modo de
 * desenvolvimento); com e-mail de verdade a tela mostra o estado do envio. O
 * convite pendente ou expirado pode ser reenviado, o que invalida o link
 * anterior, e a página nunca mostra "undefined" nem o token fora do campo.
 */

const PAGINA = 'painel-privado/empresas.html';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const LINK = `http://localhost:5501/painel-privado/aceitar-convite.html#token=${TOKEN}`;
const EXPIRA = '2026-10-05T15:00:00.000Z';

const ok = (corpo = {}) => ({ status: 200, corpo: { status: 'ok', ...corpo } });
const criado = (corpo) => ({ status: 201, corpo: { status: 'ok', ...corpo } });
const erro = (status, codigo, message) => ({ status, corpo: { status: 'error', codigo, message } });

const convite = (id, situacao, extra = {}) => ({
  id, emailConvite: `pessoa${id}@exemplo-cliente.com.br`, situacao, expiraEm: EXPIRA, ...extra,
});
const CONVITES = [convite('50', 'PENDENTE'), convite('51', 'EXPIRADO'), convite('52', 'ACEITO'), convite('53', 'CANCELADO')];
const EMPRESA = {
  id: 3, razaoSocial: 'Empresa Convidante Ltda', cnpj: '11222333000181', ativo: true, representante: {}, financeiro: {},
};

const rotas = (extra = {}) => ({
  'GET /auth/me': ok(),
  'GET /empresas': ok({ empresas: [{ ...EMPRESA, nomeFantasia: null }], total: 1 }),
  'GET /empresas/3': ok({ empresa: EMPRESA }),
  'GET /empresas/3/provisionamento': ok({ prontaParaMaster: true, totais: { ADEQUADA: 1, INSERIDA: 0, AUSENTE: 0, INSUFICIENTE: 0, NAO_CATALOGADA: 0 } }),
  'GET /empresas/3/convites-master': ok({ convites: CONVITES }),
  ...extra,
});

async function abrir(extra) {
  const pg = abrirPagina(PAGINA, { rotas: rotas(extra) });
  await pg.esperar();
  await pg.el('lista').disparar('click', { target: { closest: () => ({ getAttribute: () => '3' }) } });
  await pg.esperar();
  return pg;
}

const tabela = (pg) => pg.documento.usosDeInnerHTML.filter((u) => u.id === 'convites').at(-1).valor;
const botaoFalso = (atributo, id) => ({ disabled: false, getAttribute: (nome) => (nome === atributo ? id : null) });

async function clicarNaTabela(pg, atributo, id) {
  await pg.el('convites').disparar('click', {
    target: { closest: (seletor) => (seletor.includes(`[${atributo}]`) ? botaoFalso(atributo, id) : null) },
  });
  await pg.esperar();
}

async function convidar(pg, email = 'novo.master@exemplo-cliente.com.br') {
  pg.el('email-master').value = email;
  await pg.clicar('btn-convidar');
}

const semQuebra = (pg) => {
  const texto = pg.textoDoDom();
  assert.equal(/undefined|\[object/.test(texto), false, 'texto quebrado na página');
};

describe('gerar convite do primeiro MASTER', () => {
  test('com e-mail enviado (production): nenhum link na tela e a confirmação do envio', async () => {
    const pg = await abrir({ 'POST /empresas/3/convites-master': criado({ convite: convite('60', 'PENDENTE', { emailConvite: 'novo.master@exemplo-cliente.com.br' }), empresa: { id: 3 }, entrega: { modo: 'EMAIL', estado: 'ENVIADO', expiraEm: EXPIRA } }) });
    await convidar(pg);
    assert.equal(pg.el('link-aceite').textContent, '');
    assert.equal(pg.el('entrega').style.display, 'block');
    assert.match(pg.el('entrega-texto').textContent, /enviado por e-mail/);
    assert.match(pg.el('msg-convite').textContent, /novo\.master@exemplo-cliente\.com\.br/);
    semQuebra(pg);
  });

  test('com falha no envio: o convite existe, a tela diz isso e aponta o Reenviar, sem link', async () => {
    const pg = await abrir({ 'POST /empresas/3/convites-master': criado({ convite: convite('60', 'PENDENTE'), empresa: { id: 3 }, entrega: { modo: 'EMAIL', estado: 'FALHA', expiraEm: EXPIRA } }) });
    await convidar(pg);
    assert.match(pg.el('entrega-texto').textContent, /não pôde ser enviado/);
    assert.match(pg.el('entrega-texto').textContent, /Reenviar/);
    assert.equal(pg.el('link-aceite').textContent, '');
    semQuebra(pg);
  });

  test('em desenvolvimento o link continua aparecendo, para repassar à pessoa', async () => {
    const pg = await abrir({ 'POST /empresas/3/convites-master': criado({ convite: convite('60', 'PENDENTE'), empresa: { id: 3 }, entrega: { modo: 'DESENVOLVIMENTO_SEM_EMAIL', estado: 'NAO_ENVIADO', linkAceite: LINK, expiraEm: EXPIRA } }) });
    await convidar(pg);
    assert.equal(pg.el('link-aceite').textContent, LINK);
    assert.match(pg.el('entrega-texto').textContent, /Modo de desenvolvimento/);
  });
});

describe('lista de convites', () => {
  test('Reenviar aparece para pendente e expirado, e não para aceito ou cancelado', async () => {
    const pg = await abrir();
    const html = tabela(pg);
    assert.match(html, /data-reenviar="50"/);
    assert.match(html, /data-reenviar="51"/);
    assert.equal(/data-reenviar="52"/.test(html), false);
    assert.equal(/data-reenviar="53"/.test(html), false);
    assert.match(html, /data-cancelar="50"/);
  });

  test('o e-mail do convite vai escapado para o HTML da lista', async () => {
    const ataque = '<img src=x onerror=alert(1)>';
    const pg = await abrir({ 'GET /empresas/3/convites-master': ok({ convites: [convite('50', 'PENDENTE', { emailConvite: ataque })] }) });
    assert.equal(tabela(pg).includes(ataque), false);
    assert.match(tabela(pg), /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

describe('reenviar convite', () => {
  const REENVIADO = (entrega) => criado({ convite: convite('61', 'PENDENTE', { emailConvite: 'pessoa50@exemplo-cliente.com.br' }), conviteAnteriorId: '50', empresa: { id: 3 }, entrega });

  test('pede ao servidor com corpo vazio, mostra o novo envio e recarrega a lista; o link anterior some da tela', async () => {
    const pg = await abrir({ 'POST /convites-master/3/50/reenviar': REENVIADO({ modo: 'EMAIL', estado: 'ENVIADO', expiraEm: EXPIRA }) });
    pg.el('link-aceite').textContent = LINK;
    const antes = pg.chamadas.length;
    await clicarNaTabela(pg, 'data-reenviar', '50');

    const novas = pg.chamadas.slice(antes);
    const post = novas.find((c) => c.chave === 'POST /convites-master/3/50/reenviar');
    assert.ok(post, 'POST de reenvio não aconteceu');
    assert.deepEqual(post.corpo, {});
    assert.equal(novas.at(-1).chave, 'GET /empresas/3/convites-master', 'a lista é recarregada');
    assert.equal(pg.el('link-aceite').textContent, '', 'o link do convite anterior não fica na tela');
    assert.match(pg.el('entrega-texto').textContent, /enviado por e-mail/);
    assert.match(pg.el('entrega-texto').textContent, /link anterior deixou de valer/);
    assert.match(pg.el('msg-convite').textContent, /reenviado/i);
    semQuebra(pg);
  });

  test('em desenvolvimento o reenvio mostra o link novo', async () => {
    const pg = await abrir({ 'POST /convites-master/3/50/reenviar': REENVIADO({ modo: 'DESENVOLVIMENTO_SEM_EMAIL', estado: 'NAO_ENVIADO', linkAceite: LINK, expiraEm: EXPIRA }) });
    await clicarNaTabela(pg, 'data-reenviar', '50');
    assert.equal(pg.el('link-aceite').textContent, LINK);
  });

  test('falha de envio no reenvio: mensagem própria e nenhum link', async () => {
    const pg = await abrir({ 'POST /convites-master/3/50/reenviar': REENVIADO({ modo: 'EMAIL', estado: 'FALHA', expiraEm: EXPIRA }) });
    await clicarNaTabela(pg, 'data-reenviar', '50');
    assert.match(pg.el('entrega-texto').textContent, /não pôde ser enviado/);
    assert.equal(pg.el('link-aceite').textContent, '');
  });

  test('recusa do servidor (limite, convite que já foi aceito): a mensagem aparece e a entrega anterior não é alterada', async () => {
    for (const [status, codigo, mensagem] of [[429, 'CONVITE_ENVIO_MUITO_RECENTE', 'Um convite foi enviado há poucos instantes'], [409, 'CONVITE_NAO_REENVIAVEL', 'Somente convite pendente ou expirado pode ser reenviado']]) {
      const pg = await abrir({ 'POST /convites-master/3/50/reenviar': erro(status, codigo, mensagem) });
      await clicarNaTabela(pg, 'data-reenviar', '50');
      assert.match(pg.el('msg-convite').textContent, new RegExp(mensagem));
      assert.equal(pg.el('entrega').style.display, 'none', 'nenhum resultado de envio');
    }
  });

  test('dois cliques seguidos enviam uma única solicitação', async () => {
    let liberar;
    const trava = new Promise((resolver) => { liberar = resolver; });
    const pg = await abrir({ 'POST /convites-master/3/50/reenviar': async () => { await trava; return REENVIADO({ modo: 'EMAIL', estado: 'ENVIADO', expiraEm: EXPIRA }); } });
    const primeiro = clicarNaTabela(pg, 'data-reenviar', '50');
    const segundo = clicarNaTabela(pg, 'data-reenviar', '50');
    await new Promise((resolver) => { setImmediate(resolver); });
    liberar();
    await Promise.all([primeiro, segundo]);
    assert.equal(pg.chamadas.filter((c) => c.chave === 'POST /convites-master/3/50/reenviar').length, 1);
  });

  test('sessão que terminou durante o reenvio leva ao login', async () => {
    const pg = await abrir({ 'POST /convites-master/3/50/reenviar': erro(401, 'NAO_AUTENTICADO', 'x') });
    await clicarNaTabela(pg, 'data-reenviar', '50');
    assert.equal(pg.janela.location.href, 'index.html');
  });

  test('o identificador do convite vem do atributo do botão e é recusado se não for decimal', async () => {
    const pg = await abrir();
    const antes = pg.chamadas.length;
    for (const ruim of ['', '0', '1 OR 1', '../50', '50/cancelar']) await clicarNaTabela(pg, 'data-reenviar', ruim);
    assert.equal(pg.chamadas.slice(antes).some((c) => c.chave.startsWith('POST')), false);
  });
});

describe('limpeza da área protegida', () => {
  test('o texto do envio e o link somem junto com o resto quando a tela é limpa pelo Sair', async () => {
    const pg = await abrir({
      'POST /empresas/3/convites-master': criado({ convite: convite('60', 'PENDENTE'), empresa: { id: 3 }, entrega: { modo: 'DESENVOLVIMENTO_SEM_EMAIL', estado: 'NAO_ENVIADO', linkAceite: LINK, expiraEm: EXPIRA } }),
      'POST /auth/logout': ok(),
    });
    await convidar(pg);
    assert.equal(pg.el('link-aceite').textContent, LINK);
    await pg.clicar('sair');
    assert.equal(pg.el('link-aceite').textContent, '');
    assert.equal(pg.el('entrega-texto').textContent, '');
    assert.equal(pg.el('entrega').style.display, 'none');
  });
});

describe('HTML da página', () => {
  test('tem o ponto de ancoragem do texto do envio e não afirma de forma fixa que o ambiente é de desenvolvimento', () => {
    const pg = abrirPagina(PAGINA, { rotas: rotas() });
    assert.ok(pg.existe('entrega-texto'));
    assert.equal(/Modo de desenvolvimento/.test(pg.html.slice(0, pg.html.indexOf('<script'))), false);
  });
});
