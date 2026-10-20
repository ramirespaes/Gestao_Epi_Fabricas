'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { HttpError } = require('../../src/errors/HttpError');
const { semCache } = require('../../src/middleware/cabecalhos');
const { errorHandler } = require('../../src/middleware/errorHandler');
const { sha256Hex, webpFicticio } = require('../helpers/imagens-ficticias');

/**
 * Biblioteca de Imagens, Unidade 5A-1 (RED) — o handler `entregar` do controller da biblioteca (GET /imagens-material/:origem/:id/:variante).
 *
 * Sem banco e sem armazenamento: o serviço de entrega é um FALSO injetado (`entrega.obter(executor, { empresaId, origem, id, variante })`) e o
 * handler roda dentro de um Express de verdade (cabeçalhos, ETag, 304 e HEAD são os do Express), atrás de um adaptador que faz o papel de
 * sessão + validação: entrega `req.empresa`, `req.usuario` e `req.validado` (params; query só com `v`, já numérico). Contrato previsto:
 *   criarImagemMaterialController({ pool, entrega, corp }) — `entrega` (serviço) ou null = indisponível (503); `corp` 'same-origin' (padrão) ou 'same-site'.
 *   Empresa SÓ de req.empresa.id; o handler NUNCA lê req.query/req.params/req.body brutos. 200 e 304: Content-Type image/webp, nosniff, ETag forte do serviço,
 *   Vary com Cookie (preservando o que já existia, como Origin), Cross-Origin-Resource-Policy conforme `corp`, Cache-Control 'private, max-age=31536000,
 *   immutable' só quando `v` é a versão atual e 'private, no-cache' nos demais casos. O serviço é chamado ANTES de qualquer 304 (a integridade vem
 *   primeiro: arquivo ausente ou corrompido nunca recebe 304 só porque o ETag do cliente bate com o do registro).
 */

const CONTROLLER = () => exigirModulo('src/controllers/imagem-material.controller');
const POOL = Object.freeze({ marca: 'pool-de-teste' });
const CORPO = webpFicticio('c-corpo', 50);
const ETAG = `"${sha256Hex(CORPO)}"`;
const VERSAO = 4;
const URL = (extra = '') => `/imagens-material/empresa/7/miniatura${extra}`;

function entregaFalsa({ resultado = { corpo: CORPO, tipo: 'image/webp', etag: ETAG, versao: VERSAO }, falha = null } = {}) {
  const chamadas = [];
  return { chamadas, obter: async (executor, args) => { chamadas.push({ executor, args }); if (falha !== null) throw falha; return resultado; } };
}

function montar({ entrega, corp, dependencias = null, antes = [], comSemCache = false } = {}) {
  const { criarImagemMaterialController } = CONTROLLER();
  const controller = criarImagemMaterialController(dependencias ?? { pool: POOL, entrega, ...(corp === undefined ? {} : { corp }) });
  assert.equal(typeof controller.entregar, 'function', 'controller.entregar ainda não existe (não implementado)');
  const app = express();
  for (const mw of antes) app.use(mw);
  if (comSemCache) app.use(semCache);
  app.get('/imagens-material/:origem/:id/:variante', (req, res, next) => {
    req.empresa = { id: 3 };
    req.usuario = { id: 9 };
    req.validado = Object.freeze({
      params: Object.freeze({ origem: req.params.origem, id: req.params.id, variante: req.params.variante }),
      query: Object.freeze(req.query.v === undefined ? {} : { v: Number(req.query.v) }),
    });
    next();
  }, controller.entregar);
  app.use(errorHandler);
  return app;
}

const tokens = (valor) => [...new Set(String(valor ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))].sort();
const semVolateis = (headers) => Object.fromEntries(Object.entries(headers).filter(([n]) => !['date', 'connection', 'keep-alive'].includes(n)));

describe('[CTL-ENT] handler de entrega — contexto e resposta 200', () => {
  test('CTL-ENT-01 — a autoridade vem SÓ da sessão: empresa de req.empresa.id; query, cabeçalhos e corpo do cliente não entram; o executor é o pool injetado', async () => {
    const entrega = entregaFalsa();
    const app = montar({ entrega });
    const r = await request(app).get(URL('?empresaId=999&usuarioId=777&v=4')).set('x-empresa-id', '999').set('x-usuario-id', '777');
    assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(entrega.chamadas.length, 1);
    assert.equal(entrega.chamadas[0].executor, POOL);
    assert.deepEqual(entrega.chamadas[0].args, { empresaId: 3, origem: 'empresa', id: '7', variante: 'miniatura' });
  });

  test('CTL-ENT-02 — 200 com `v` igual à versão atual: bytes do serviço, image/webp, nosniff, ETag forte, Vary: Cookie, cache privado imutável, sem Set-Cookie', async () => {
    const app = montar({ entrega: entregaFalsa() });
    const r = await request(app).get(URL(`?v=${VERSAO}`));
    assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, CORPO);
    assert.match(r.headers['content-type'], /^image\/webp(?:;|$)/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers.etag, ETAG);
    assert.equal(r.headers.etag.startsWith('W/'), false, 'ETag forte');
    assert.equal(r.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.equal(tokens(r.headers.vary).includes('cookie'), true);
    assert.equal(r.headers['set-cookie'], undefined);
    assert.equal(Number(r.headers['content-length']), CORPO.length);
  });

  test('CTL-ENT-03 — sem `v` ou com `v` diferente da versão atual: continua 200 com o conteúdo atual, mas só `private, no-cache` (revalida por ETag, nunca imutável)', async () => {
    const app = montar({ entrega: entregaFalsa() });
    for (const sufixo of ['', '?v=3', '?v=5', '?v=1']) {
      const r = await request(app).get(URL(sufixo));
      assert.equal(r.status, 200, `${sufixo}: ${r.status}`);
      assert.equal(r.headers['cache-control'], 'private, no-cache', sufixo);
      assert.equal(r.headers.etag, ETAG, sufixo);
      assert.deepEqual(r.body, CORPO, sufixo);
    }
  });

  test('CTL-ENT-04 — Vary: Cookie é ACRESCENTADO ao que já existia (Origin do CORS) e não se repete', async () => {
    const comOrigin = (req, res, next) => { res.vary('Origin'); next(); };
    const comCookie = (req, res, next) => { res.vary('Origin'); res.vary('Cookie'); next(); };
    const a = await request(montar({ entrega: entregaFalsa(), antes: [comOrigin] })).get(URL(`?v=${VERSAO}`));
    assert.deepEqual(tokens(a.headers.vary), ['cookie', 'origin']);
    const b = await request(montar({ entrega: entregaFalsa(), antes: [comCookie] })).get(URL(`?v=${VERSAO}`));
    assert.deepEqual(tokens(b.headers.vary), ['cookie', 'origin']);
    assert.equal(String(b.headers.vary).toLowerCase().split('cookie').length - 1, 1, 'Cookie aparece uma vez');
  });

  test('CTL-ENT-05 — CORP: padrão e `same-origin` dão same-origin; `same-site` dá same-site; em 200 e em 304; valor desconhecido é recusado na fábrica', async () => {
    for (const [corp, esperado] of [[undefined, 'same-origin'], ['same-origin', 'same-origin'], ['same-site', 'same-site']]) {
      const app = montar({ entrega: entregaFalsa(), corp });
      const ok = await request(app).get(URL(`?v=${VERSAO}`));
      assert.equal(ok.headers['cross-origin-resource-policy'], esperado, `200 com corp=${corp}`);
      const nm = await request(app).get(URL(`?v=${VERSAO}`)).set('If-None-Match', ETAG);
      assert.equal(nm.status, 304);
      assert.equal(nm.headers['cross-origin-resource-policy'], esperado, `304 com corp=${corp}`);
    }
    const { criarImagemMaterialController } = CONTROLLER();
    for (const ruim of ['cross-origin', 'SAME-SITE', '*', '', 5]) {
      assert.throws(() => criarImagemMaterialController({ pool: POOL, entrega: entregaFalsa(), corp: ruim }), undefined, `corp ${JSON.stringify(ruim)}`);
    }
  });
});

describe('[CTL-ENT] handler de entrega — condicional (304), HEAD e a integridade primeiro', () => {
  test('CTL-ENT-06 — If-None-Match que casa (exato, fraco, em lista ou *) é 304 sem corpo, com ETag, Cache-Control, Vary e CORP; o serviço é chamado UMA vez por pedido', async () => {
    for (const condicional of [ETAG, `W/${ETAG}`, `"outro", ${ETAG}`, '*']) {
      const entrega = entregaFalsa();
      const r = await request(montar({ entrega })).get(URL(`?v=${VERSAO}`)).set('If-None-Match', condicional);
      assert.equal(r.status, 304, `${condicional}: ${r.status}`);
      assert.equal(r.text === undefined || r.text === '' || r.text === null, true);
      assert.equal(r.headers.etag, ETAG, condicional);
      assert.equal(r.headers['cache-control'], 'private, max-age=31536000, immutable', condicional);
      assert.equal(tokens(r.headers.vary).includes('cookie'), true, condicional);
      assert.equal(entrega.chamadas.length, 1, `o serviço (integridade) roda antes do 304: ${condicional}`);
    }
  });

  test('CTL-ENT-07 — If-None-Match que NÃO casa é 200 com o corpo', async () => {
    const r = await request(montar({ entrega: entregaFalsa() })).get(URL(`?v=${VERSAO}`)).set('If-None-Match', '"outro-etag"');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, CORPO);
  });

  test('CTL-ENT-08 — CORREÇÃO V8: se o serviço recusa (arquivo ausente, adulterado, imagem inativa), a resposta é o 404 uniforme MESMO com If-None-Match igual ao ETag — nunca 304', async () => {
    const falha = HttpError.notFound('IMAGEM_NAO_ENCONTRADA', 'Imagem não encontrada');
    const entrega = entregaFalsa({ falha });
    const r = await request(montar({ entrega, comSemCache: true })).get(URL(`?v=${VERSAO}`)).set('If-None-Match', ETAG);
    assert.equal(r.status, 404, `${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual([r.body.status, r.body.codigo], ['error', 'IMAGEM_NAO_ENCONTRADA']);
    // O Express gera sozinho um ETag FRACO para o corpo JSON do erro; o que não pode aparecer é o ETag da imagem (o SHA-256 da variante).
    assert.equal(String(r.headers.etag ?? '').includes(sha256Hex(CORPO)), false, 'a recusa não carrega o ETag do registro');
    assert.equal(entrega.chamadas.length, 1, 'o serviço foi consultado antes de qualquer decisão condicional');
  });

  test('CTL-ENT-09 — HEAD: mesmos cabeçalhos do GET, sem corpo; com If-None-Match que casa, 304; o serviço roda nos dois', async () => {
    const app = montar({ entrega: entregaFalsa() });
    const get = await request(app).get(URL(`?v=${VERSAO}`));
    const head = await request(app).head(URL(`?v=${VERSAO}`));
    assert.equal(head.status, 200);
    assert.equal(head.text === undefined || head.text === '', true);
    assert.deepEqual(semVolateis(head.headers), semVolateis(get.headers));
    const condicional = await request(app).head(URL(`?v=${VERSAO}`)).set('If-None-Match', ETAG);
    assert.equal(condicional.status, 304);
    const entrega = entregaFalsa({ falha: HttpError.notFound('IMAGEM_NAO_ENCONTRADA', 'Imagem não encontrada') });
    const recusado = await request(montar({ entrega })).head(URL(`?v=${VERSAO}`)).set('If-None-Match', ETAG);
    assert.equal(recusado.status, 404);
    assert.equal(entrega.chamadas.length, 1);
  });
});

describe('[CTL-ENT] handler de entrega — erros sem cache e sem vazamento', () => {
  test('CTL-ENT-10 — erro do serviço (404 uniforme, 503, 500): corpo padrão do projeto, Cache-Control no-store herdado, nenhum cabeçalho de imagem, nada do conteúdo', async () => {
    for (const [falha, status, codigo] of [
      [HttpError.notFound('IMAGEM_NAO_ENCONTRADA', 'Imagem não encontrada'), 404, 'IMAGEM_NAO_ENCONTRADA'],
      [new HttpError(503, 'IMAGENS_INDISPONIVEL', 'Imagens indisponíveis'), 503, 'IMAGENS_INDISPONIVEL'],
      [Object.assign(new Error("EACCES: permission denied, open '/var/segredo/imagens/3/abc/miniatura.webp'"), { code: 'EACCES' }), 500, 'ERRO_INTERNO'],
    ]) {
      const r = await request(montar({ entrega: entregaFalsa({ falha }), comSemCache: true })).get(URL(`?v=${VERSAO}`));
      assert.deepEqual([r.status, r.body.codigo], [status, codigo], `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(String(r.headers.etag ?? '').includes(sha256Hex(CORPO)), false, 'o erro não carrega o ETag da imagem (o ETag fraco automático do JSON é outra coisa)');
      assert.doesNotMatch(String(r.headers['content-type']), /image\/webp/);
      assert.equal(JSON.stringify(r.body).includes('segredo'), false);
    }
  });

  test('CTL-ENT-11 — serviço de entrega indisponível: `entrega: null` ou `armazenamento: null` dão 503 IMAGENS_INDISPONIVEL, sem chamar nada', async () => {
    for (const dependencias of [{ pool: POOL, entrega: null }, { pool: POOL, armazenamento: null }]) {
      const r = await request(montar({ dependencias, comSemCache: true })).get(URL(`?v=${VERSAO}`));
      assert.deepEqual([r.status, r.body.codigo], [503, 'IMAGENS_INDISPONIVEL'], `${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });
});
