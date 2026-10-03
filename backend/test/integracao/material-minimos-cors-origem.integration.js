'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { montarAmbiente } = require('./helpers/ambiente-http-12d2');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { corsApi } = require('../../src/middleware/cors');
const { semCache } = require('../../src/middleware/cabecalhos');
const { verificarOrigem } = require('../../src/middleware/origem');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const { httpConfig } = require('../../src/config/http');

/**
 * Os mínimos por tamanho (PUT e DELETE) pela cadeia REAL de /api — o mesmo CORS,
 * a mesma verificação de origem e a mesma política de JSON de app.js — com
 * sessão REAL por cookie (login global) e PostgreSQL real. CORS e verificação de
 * origem são camadas diferentes: o primeiro diz ao navegador o que ele pode
 * enviar cross-origin (preflight), a segunda rejeita no servidor o método
 * inseguro vindo de origem não confiável. Aqui as duas, mais a autorização, o
 * corpo, a resposta e a auditoria.
 */

const SENHA = 'senha-forte-dos-minimos-cors-2026';
const ORIGEM = httpConfig.cors.origens[0];
const ORIGEM_DO_PAINEL = httpConfig.plataforma.corsOrigens[0];
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

describe('mínimos por tamanho — CORS, origem e sessão real (PostgreSQL real)', () => {
  let amb;
  let app;
  const cookie = {};
  const ids = {};
  const q = (sql, params) => amb.pool.query(sql, params);
  let sequencia = 0;

  before(async () => {
    amb = await montarAmbiente();
    const hash = await gerarHashSenha(SENHA);
    const identificar = async (usuarioId, email) => {
      const { rows: [identidade] } = await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash]);
      await q('UPDATE usuarios SET email = NULL, senha_hash = NULL, identidade_id = $2 WHERE id = $1', [usuarioId, identidade.id]);
    };
    const leitor = await amb.usuarioCom(amb.d.empresaA, { materials: ['visualizar'] });
    const editor = await amb.usuarioCom(amb.d.empresaA, { materials: ['visualizar', 'editar'] });
    ids.editor = editor;
    await identificar(amb.d.master, 'master.minimos.cors@exemplo-cliente.com.br');
    await identificar(leitor, 'leitor.minimos.cors@exemplo-cliente.com.br');
    await identificar(editor, 'editor.minimos.cors@exemplo-cliente.com.br');

    const pool = amb.pool;
    const semLimite = criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = express();
    app.use(
      '/api',
      corsApi,
      semCache,
      verificarOrigem,
      exigirJson,
      parserJson,
      criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite, exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
      criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);

    const entrar = async (email) => {
      const r = await request(app).post('/api/auth/global/login').set('Origin', ORIGEM).send({ email, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const c = cookiesDe(r);
      return `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
    };
    cookie.master = await entrar('master.minimos.cors@exemplo-cliente.com.br');
    cookie.leitor = await entrar('leitor.minimos.cors@exemplo-cliente.com.br');
    cookie.editor = await entrar('editor.minimos.cors@exemplo-cliente.com.br');
  });
  after(async () => { if (amb) await amb.encerrar(); });

  const novoMaterial = () => {
    sequencia += 1;
    return amb.material(amb.d.empresaA, `Material CORS ${sequencia}`, { estoqueMinimo: 20 });
  };
  const url = (id, tamanho) => `/api/materiais/${id}/minimos/${tamanho}`;
  const linhas = async (id) => (await q('SELECT tamanho, minimo FROM estoque_minimos WHERE material_id = $1 ORDER BY tamanho', [id])).rows;
  const auditorias = async (acao, id) => (await q('SELECT usuario_id, contexto FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id', [acao, String(id)])).rows;
  const preflight = (rota, metodo, origem = ORIGEM) => request(app).options(rota).set('Origin', origem)
    .set('Access-Control-Request-Method', metodo).set('Access-Control-Request-Headers', 'Content-Type');

  describe('preflight (o que o navegador pode enviar)', () => {
    for (const metodo of ['PUT', 'DELETE']) {
      test(`${metodo}: 204 sem sessão, com a origem exata, credentials, o método anunciado, só Content-Type e Vary: Origin`, async () => {
        const r = await preflight(url(1, 'M'), metodo);
        assert.equal(r.status, 204);
        assert.equal(r.headers['access-control-allow-origin'], ORIGEM);
        assert.equal(r.headers['access-control-allow-credentials'], 'true');
        assert.ok(r.headers['access-control-allow-methods'].split(',').map((m) => m.trim()).includes(metodo));
        assert.equal(r.headers['access-control-allow-headers'], 'Content-Type');
        assert.ok(String(r.headers.vary).split(',').map((v) => v.trim()).includes('Origin'));
      });

      test(`${metodo}: origem fora da allowlist (inclusive a do Painel Privado) não recebe cabeçalho CORS nenhum`, async () => {
        for (const origem of ['http://mal.test', ORIGEM_DO_PAINEL]) {
          const r = await preflight(url(1, 'M'), metodo, origem);
          assert.deepEqual(Object.keys(r.headers).filter((h) => h.startsWith('access-control-')), [], origem);
        }
      });
    }
  });

  describe('requisição real: verificação de origem, sessão, RBAC, corpo, resposta e auditoria', () => {
    test('PUT com a origem permitida e sessão real: 201, corpo, CORS na resposta, linha gravada e auditoria do ator da sessão', async () => {
      const id = await novoMaterial();
      const r = await request(app).put(url(id, 'M')).set('Cookie', cookie.master).set('Origin', ORIGEM).send({ minimo: 20 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body, {
        status: 'ok', criado: true, alterado: true, materialId: id, estoqueMinimoPadrao: 20, exigeTamanho: true, overrides: [{ tamanho: 'M', minimo: 20 }],
      });
      assert.equal(r.headers['access-control-allow-origin'], ORIGEM, 'a resposta real também leva a origem exata, para o navegador poder lê-la');
      assert.equal(r.headers['access-control-allow-credentials'], 'true');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.deepEqual(await linhas(id), [{ tamanho: 'M', minimo: 20 }]);
      const [auditoria] = await auditorias('ESTOQUE_MINIMO_DEFINIDO', id);
      assert.equal(auditoria.usuario_id, amb.d.master);
      assert.deepEqual(auditoria.contexto, { materialId: id, tamanho: 'M', minimoAnterior: null, minimoNovo: 20 });
    });

    test('DELETE com a origem permitida e sessão real: 200, a linha apagada e a auditoria da remoção', async () => {
      const id = await novoMaterial();
      await request(app).put(url(id, 'M')).set('Cookie', cookie.master).set('Origin', ORIGEM).send({ minimo: 30 });
      const r = await request(app).delete(url(id, 'M')).set('Cookie', cookie.master).set('Origin', ORIGEM);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: 'ok', alterado: true, materialId: id, estoqueMinimoPadrao: 20, exigeTamanho: true, overrides: [] });
      assert.equal(r.headers['access-control-allow-origin'], ORIGEM);
      assert.deepEqual(await linhas(id), []);
      assert.deepEqual((await auditorias('ESTOQUE_MINIMO_REMOVIDO', id)).map((a) => a.contexto), [{ materialId: id, tamanho: 'M', minimoAnterior: 30, minimoEfetivoDepois: 20 }]);
    });

    test('o Referer da origem permitida, sem Origin, também passa na verificação de origem', async () => {
      const id = await novoMaterial();
      const r = await request(app).put(url(id, 'M')).set('Cookie', cookie.master).set('Referer', `${ORIGEM}/pages/materiais.html`).send({ minimo: 7 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });

    for (const metodo of ['put', 'delete']) {
      test(`${metodo.toUpperCase()} sem Origin nem Referer: 403 ORIGEM_AUSENTE, mesmo com a sessão; nada gravado`, async () => {
        const id = await novoMaterial();
        await amb.pool.query("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, 'M', 9)", [amb.d.empresaA, id]);
        const r = await request(app)[metodo](url(id, 'M')).set('Cookie', cookie.master).send(metodo === 'put' ? { minimo: 1 } : undefined);
        assert.deepEqual([r.status, r.body.codigo], [403, 'ORIGEM_AUSENTE']);
        assert.deepEqual(await linhas(id), [{ tamanho: 'M', minimo: 9 }]);
        assert.deepEqual(await auditorias('ESTOQUE_MINIMO_DEFINIDO', id), []);
      });

      test(`${metodo.toUpperCase()} com origem estranha ou com a origem do Painel Privado: 403 ORIGEM_NAO_PERMITIDA, sem CORS e sem alterar nada`, async () => {
        const id = await novoMaterial();
        await amb.pool.query("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, 'M', 9)", [amb.d.empresaA, id]);
        for (const origem of ['http://mal.test', ORIGEM_DO_PAINEL]) {
          const r = await request(app)[metodo](url(id, 'M')).set('Cookie', cookie.master).set('Origin', origem).send(metodo === 'put' ? { minimo: 1 } : undefined);
          assert.deepEqual([r.status, r.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], origem);
          assert.deepEqual(Object.keys(r.headers).filter((h) => h.startsWith('access-control-')), [], origem);
        }
        assert.deepEqual(await linhas(id), [{ tamanho: 'M', minimo: 9 }]);
      });
    }

    test('RBAC com sessão real: só materials.visualizar lê mas não altera (403); com materials.editar altera; a verificação de origem vem antes', async () => {
      const id = await novoMaterial();
      const lido = await request(app).get(`/api/materiais/${id}/minimos`).set('Cookie', cookie.leitor).set('Origin', ORIGEM);
      assert.equal(lido.status, 200);
      const negado = await request(app).put(url(id, 'M')).set('Cookie', cookie.leitor).set('Origin', ORIGEM).send({ minimo: 5 });
      assert.deepEqual([negado.status, negado.body.codigo], [403, 'PERMISSAO_NEGADA']);
      const negadoDelete = await request(app).delete(url(id, 'M')).set('Cookie', cookie.leitor).set('Origin', ORIGEM);
      assert.deepEqual([negadoDelete.status, negadoDelete.body.codigo], [403, 'PERMISSAO_NEGADA']);
      assert.deepEqual(await linhas(id), []);
      const feito = await request(app).put(url(id, 'M')).set('Cookie', cookie.editor).set('Origin', ORIGEM).send({ minimo: 5 });
      assert.equal(feito.status, 201);
      assert.equal((await auditorias('ESTOQUE_MINIMO_DEFINIDO', id))[0].usuario_id, ids.editor, 'o ator auditado é o da sessão que alterou');
    });

    test('sem sessão: 401 mesmo com a origem permitida (a origem não substitui a autenticação)', async () => {
      const id = await novoMaterial();
      const put = await request(app).put(url(id, 'M')).set('Origin', ORIGEM).send({ minimo: 5 });
      const apagar = await request(app).delete(url(id, 'M')).set('Origin', ORIGEM);
      assert.deepEqual([put.status, apagar.status], [401, 401]);
      assert.deepEqual(await linhas(id), []);
    });

    test('corpo inválido ou com campo que o cliente não manda: 400 VALIDACAO sem devolver o valor, e nada gravado', async () => {
      const id = await novoMaterial();
      for (const corpo of [{ minimo: -1 }, { minimo: 'abc' }, {}, { minimo: 5, empresaId: amb.d.empresaB }]) {
        const r = await request(app).put(url(id, 'M')).set('Cookie', cookie.master).set('Origin', ORIGEM).send(corpo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
        assert.ok(!JSON.stringify(r.body).includes('abc'));
      }
      assert.deepEqual(await linhas(id), []);
    });

    test('Content-Type diferente de application/json no PUT: 415, e nada gravado', async () => {
      const id = await novoMaterial();
      const r = await request(app).put(url(id, 'M')).set('Cookie', cookie.master).set('Origin', ORIGEM).set('Content-Type', 'text/plain').send('minimo=5');
      assert.equal(r.status, 415);
      assert.deepEqual(await linhas(id), []);
    });
  });
});
