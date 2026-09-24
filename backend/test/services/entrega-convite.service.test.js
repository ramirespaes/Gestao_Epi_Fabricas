'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const entrega = require('../../src/services/entrega-convite.service');
const { httpConfig } = require('../../src/config/http');

/**
 * Mecanismo de entrega de DESENVOLVIMENTO do convite (Pacote 3): monta o
 * link de aceite sob a origem do Painel Privado, não envia e-mail, não
 * loga o token.
 */

const TOKEN = 'Zm9ybWF0b2Jhc2U2NHVybGRldG9rZW5jb21fNDNjaGFy'.slice(0, 43);
const dados = { emailConvite: 'p@x.com', token: TOKEN, expiraEm: new Date('2026-09-30T00:00:00Z'), empresa: { id: 7, razaoSocial: 'X' } };

describe('entregar', () => {
  test('devolve o modo de desenvolvimento e um link sob a origem do Painel Privado com o token SÓ no fragmento (nunca na query)', async (t) => {
    t.mock.method(console, 'log', () => {});
    const r = await entrega.entregar(dados);
    assert.equal(r.modo, 'DESENVOLVIMENTO_SEM_EMAIL');
    const url = new URL(r.linkAceite);
    assert.equal(url.origin, httpConfig.plataforma.corsOrigens[0]);
    assert.equal(url.pathname, entrega.CAMINHO_PAGINA_ACEITE);
    assert.equal(url.search, '', 'query vazia: o token não pode ir para logs de acesso nem Referer');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'), TOKEN);
    assert.equal(r.expiraEm, dados.expiraEm);
  });

  test('exigirDisponivel: em production recusa com 503 CONVITE_ENTREGA_INDISPONIVEL; nos demais ambientes não lança; entregar() também recusa em production', async () => {
    assert.throws(() => entrega.exigirDisponivel('production'), (e) => e.status === 503 && e.codigo === 'CONVITE_ENTREGA_INDISPONIVEL');
    assert.doesNotThrow(() => entrega.exigirDisponivel('development'));
    assert.doesNotThrow(() => entrega.exigirDisponivel('test'));
    assert.doesNotThrow(() => entrega.exigirDisponivel(), 'ambiente da suíte (test) não bloqueia');
    assert.equal(httpConfig.ambiente, 'test');
  });

  test('a linha de log registra o fato, NUNCA o token nem o link', async (t) => {
    const logs = [];
    t.mock.method(console, 'log', (...args) => { logs.push(args); });
    await entrega.entregar(dados);
    const texto = JSON.stringify(logs);
    assert.ok(texto.includes('convite-master'));
    assert.equal(texto.includes(TOKEN), false);
    assert.equal(texto.includes('aceitar-convite.html'), false);
  });

  test('token ausente é erro de programação', async () => {
    await assert.rejects(() => entrega.entregar({ ...dados, token: '' }), TypeError);
  });
});
