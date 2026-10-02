'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const entrega = require('../../src/services/entrega-convite.service');
const entregaUsuario = require('../../src/services/entrega-convite-usuario.service');
const { httpConfig } = require('../../src/config/http');

/**
 * Camadas finas de entrega dos convites (Bloco 11H) sobre o serviço único de
 * e-mail. No ambiente da suíte a entrega está desativada, então a resposta
 * ainda leva o link (mecanismo manual de desenvolvimento).
 */

const TOKEN = 'Zm9ybWF0b2Jhc2U2NHVybGRldG9rZW5jb21fNDNjaGFy'.slice(0, 43);
const EMAIL = 'pessoa.convidada@exemplo-cliente.com.br';
const dadosMaster = {
  conviteId: '31', email: EMAIL, token: TOKEN, expiraEm: new Date('2026-09-30T00:00:00Z'), empresa: { id: 7, razaoSocial: 'Empresa Convidante Ltda' },
};
const dadosUsuario = {
  conviteId: '41', empresaId: 7, email: EMAIL, token: TOKEN, expiraEm: new Date('2026-09-30T00:00:00Z'), empresa: 'Empresa Convidante Ltda', nome: 'Ana Souza', perfil: 'USUARIO',
};

describe('convite do MASTER', () => {
  test('devolve o modo de desenvolvimento, o estado e um link sob a URL pública do Painel com o token SÓ no fragmento', async () => {
    const r = await entrega.entregar(dadosMaster);
    assert.equal(r.modo, 'DESENVOLVIMENTO_SEM_EMAIL');
    assert.equal(r.estado, 'NAO_ENVIADO');
    const url = new URL(r.linkAceite);
    assert.equal(url.origin, httpConfig.urlsPublicas.painel);
    assert.equal(url.pathname, entrega.CAMINHO_PAGINA_ACEITE);
    assert.equal(url.search, '', 'query vazia: o token não pode ir para logs de acesso nem Referer');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'), TOKEN);
    assert.equal(r.expiraEm, dadosMaster.expiraEm);
  });

  test('exigirDisponivel: em production sem provedor real recusa com 503; nos demais ambientes não lança', () => {
    assert.throws(() => entrega.exigirDisponivel('production'), (e) => e.status === 503 && e.codigo === 'CONVITE_ENTREGA_INDISPONIVEL');
    assert.doesNotThrow(() => entrega.exigirDisponivel('development'));
    assert.doesNotThrow(() => entrega.exigirDisponivel('test'));
    assert.doesNotThrow(() => entrega.exigirDisponivel(), 'ambiente da suíte (test) não bloqueia');
    assert.equal(httpConfig.ambiente, 'test');
  });

  test('não escreve nada no console: nem token, nem link, nem e-mail, nem nome da empresa', async (t) => {
    const saidas = [];
    for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, metodo, (...a) => { saidas.push(JSON.stringify(a)); });
    await entrega.entregar(dadosMaster);
    assert.deepEqual(saidas, []);
  });

  test('token ausente é erro de programação', async () => {
    await assert.rejects(() => entrega.entregar({ ...dadosMaster, token: '' }), TypeError);
  });
});

describe('convite de usuário', () => {
  test('o link vai à página de aceite do Portal, na URL pública do Portal, com o token só no fragmento', async () => {
    const r = await entregaUsuario.entregar(dadosUsuario);
    assert.equal(r.modo, 'DESENVOLVIMENTO_SEM_EMAIL');
    assert.equal(r.estado, 'NAO_ENVIADO');
    const url = new URL(r.linkAceite);
    assert.equal(url.origin, httpConfig.urlsPublicas.portal);
    assert.equal(url.pathname, entregaUsuario.CAMINHO_PAGINA_ACEITE);
    assert.equal(url.pathname, '/portal/aceitar-convite.html');
    assert.equal(url.search, '');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'), TOKEN);
  });

  test('mesmo bloqueio de production e o mesmo silêncio no console', async (t) => {
    assert.throws(() => entregaUsuario.exigirDisponivel('production'), (e) => e.status === 503 && e.codigo === 'CONVITE_ENTREGA_INDISPONIVEL');
    assert.equal(entregaUsuario.exigirDisponivel, entrega.exigirDisponivel);
    const saidas = [];
    for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, metodo, (...a) => { saidas.push(JSON.stringify(a)); });
    await entregaUsuario.entregar(dadosUsuario);
    assert.deepEqual(saidas, []);
  });
});
