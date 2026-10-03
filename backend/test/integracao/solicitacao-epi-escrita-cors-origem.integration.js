'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { chaveNova } = require('./helpers/solicitacao-epi-servico');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { corsApi } = require('../../src/middleware/cors');
const { semCache } = require('../../src/middleware/cabecalhos');
const { verificarOrigem } = require('../../src/middleware/origem');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarSolicitacaoEpiController } = require('../../src/controllers/solicitacao-epi.controller');
const { criarSolicitacaoEpiRoutes } = require('../../src/routes/solicitacao-epi.routes');
const { criarVinculoSstController } = require('../../src/controllers/vinculo-sst.controller');
const { criarVinculoSstRoutes } = require('../../src/routes/vinculo-sst.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const { httpConfig } = require('../../src/config/http');

/**
 * A escrita da solicitação de EPI e do vínculo SST (12F-2) pela cadeia REAL de
 * /api — o mesmo CORS, a mesma verificação de origem (CSRF) e a mesma política
 * de JSON de app.js — com sessão REAL por cookie (login global) e PostgreSQL
 * real. O CORS diz ao navegador o que ele pode enviar cross-origin (preflight);
 * a verificação de origem recusa no servidor o método inseguro vindo de origem
 * não confiável, antes da sessão e da autorização. Nenhuma das duas camadas foi
 * afrouxada: os métodos do Portal continuam os mesmos e o Painel Privado não
 * entra aqui.
 */

const SENHA = 'senha-forte-da-escrita-12f2-cors';
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

describe('escrita da solicitação e do vínculo SST — CORS, origem e sessão real (PostgreSQL real)', () => {
  let env;
  let app;
  const cookie = {};
  const u = {};
  const q = (sql, params) => env.pool.query(sql, params);
  const solicitacoesDe = async (atorId) => (await q('SELECT count(*)::int AS n FROM solicitacoes_epi WHERE solicitante_usuario_id = $1', [atorId])).rows[0].n;
  const vinculo = async (usuarioId) => (await q('SELECT usuario_id FROM vinculo_sst WHERE usuario_id = $1', [usuarioId])).rows.length;
  const cabecalhosCors = (r) => Object.keys(r.headers).filter((h) => h.startsWith('access-control-'));
  const pedido = () => ({
    funcionarioId: env.d.trabalhador, itens: [{ materialId: env.d.capacete, tamanho: null, quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
  });
  const preflight = (rota, metodo, origem = ORIGEM) => request(app).options(rota).set('Origin', origem)
    .set('Access-Control-Request-Method', metodo).set('Access-Control-Request-Headers', 'Content-Type');

  before(async () => {
    env = await montarAmbiente12f();
    const { pool, d } = env;
    const hash = await gerarHashSenha(SENHA);
    const identificar = async (usuarioId, email) => {
      const { rows: [identidade] } = await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash]);
      await q('UPDATE usuarios SET email = NULL, senha_hash = NULL, identidade_id = $2 WHERE id = $1', [usuarioId, identidade.id]);
    };
    u.solicitante = await env.usuarioCom(d.empresaA, { recursos: { request: ['visualizar', 'criar', 'editar'] } });
    u.sst = await env.usuarioCom(d.empresaA, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO'], sst: true });
    u.alvo = await env.usuarioCom(d.empresaA);
    await identificar(d.master, 'master.escrita.12f2@exemplo-cliente.com.br');
    await identificar(u.solicitante, 'solicitante.escrita.12f2@exemplo-cliente.com.br');
    await identificar(u.sst, 'sst.escrita.12f2@exemplo-cliente.com.br');

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
      criarSolicitacaoEpiRoutes({ controller: criarSolicitacaoEpiController({ pool }), exigirSessao, pool }),
      criarVinculoSstRoutes({ controller: criarVinculoSstController({ pool }), exigirSessao }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);

    const entrar = async (email) => {
      const r = await request(app).post('/api/auth/global/login').set('Origin', ORIGEM).send({ email, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const c = cookiesDe(r);
      return `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
    };
    cookie.master = await entrar('master.escrita.12f2@exemplo-cliente.com.br');
    cookie.solicitante = await entrar('solicitante.escrita.12f2@exemplo-cliente.com.br');
    cookie.sst = await entrar('sst.escrita.12f2@exemplo-cliente.com.br');
  });
  after(async () => { if (env) await env.encerrar(); });

  const ESCRITAS = [
    ['POST', '/api/solicitacoes-epi'],
    ['POST', '/api/solicitacoes-epi/1/cancelamento'],
    ['POST', '/api/solicitacoes-epi/1/decisao'],
    ['POST', '/api/solicitacoes-epi/1/encerramento'],
    ['POST', '/api/solicitacoes-epi/1/entregas'],
    ['POST', '/api/vinculos-sst'],
    ['DELETE', '/api/vinculos-sst/1'],
  ];

  describe('preflight (o que o navegador pode enviar)', () => {
    test('cada escrita: 204 sem sessão, com a origem exata, credentials, o método anunciado, só Content-Type e Vary: Origin', async () => {
      for (const [metodo, rota] of ESCRITAS) {
        const r = await preflight(rota, metodo);
        assert.equal(r.status, 204, `${metodo} ${rota}`);
        assert.equal(r.headers['access-control-allow-origin'], ORIGEM);
        assert.equal(r.headers['access-control-allow-credentials'], 'true');
        assert.ok(r.headers['access-control-allow-methods'].split(',').map((m) => m.trim()).includes(metodo), `${metodo} ${rota}`);
        assert.equal(r.headers['access-control-allow-headers'], 'Content-Type');
        assert.ok(String(r.headers.vary).split(',').map((v) => v.trim()).includes('Origin'));
      }
    });

    test('origem fora da allowlist (inclusive a do Painel Privado) não recebe cabeçalho CORS nenhum', async () => {
      for (const [metodo, rota] of ESCRITAS) {
        for (const origem of ['http://mal.test', ORIGEM_DO_PAINEL]) {
          assert.deepEqual(cabecalhosCors(await preflight(rota, metodo, origem)), [], `${metodo} ${rota} ${origem}`);
        }
      }
    });
  });

  describe('requisição real: origem antes da sessão e da autorização', () => {
    test('criar com a origem permitida e a sessão real: 201, CORS e no-store na resposta, o solicitante é o da sessão', async () => {
      const r = await request(app).post('/api/solicitacoes-epi').set('Cookie', cookie.solicitante).set('Origin', ORIGEM).send(pedido());
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.solicitacao.solicitanteUsuarioId, u.solicitante);
      assert.equal(r.headers['access-control-allow-origin'], ORIGEM);
      assert.equal(r.headers['access-control-allow-credentials'], 'true');
      assert.equal(r.headers['cache-control'], 'no-store');
    });

    test('o Referer da origem permitida, sem Origin, também passa', async () => {
      const r = await request(app).post('/api/solicitacoes-epi').set('Cookie', cookie.solicitante).set('Referer', `${ORIGEM}/pages/solicitacao.html`).send(pedido());
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });

    test('sem Origin nem Referer, com a sessão válida: 403 ORIGEM_AUSENTE em todas as escritas; nada gravado', async () => {
      const antes = await solicitacoesDe(u.solicitante);
      for (const [metodo, rota] of ESCRITAS) {
        const chamada = request(app)[metodo.toLowerCase()](rota).set('Cookie', metodo === 'DELETE' || rota.includes('vinculos') ? cookie.master : cookie.solicitante);
        const r = await (metodo === 'POST' ? chamada.send(rota === '/api/solicitacoes-epi' ? pedido() : {}) : chamada);
        assert.deepEqual([r.status, r.body.codigo], [403, 'ORIGEM_AUSENTE'], `${metodo} ${rota}`);
      }
      assert.equal(await solicitacoesDe(u.solicitante), antes);
    });

    test('origem estranha ou a do Painel Privado, com a sessão válida: 403 ORIGEM_NAO_PERMITIDA, sem cabeçalho CORS; nada gravado nem removido', async () => {
      const antes = await solicitacoesDe(u.solicitante);
      assert.equal((await request(app).post('/api/vinculos-sst').set('Cookie', cookie.master).set('Origin', ORIGEM).send({ usuarioId: u.alvo })).status, 201);
      for (const origem of ['http://mal.test', ORIGEM_DO_PAINEL]) {
        const criar = await request(app).post('/api/solicitacoes-epi').set('Cookie', cookie.solicitante).set('Origin', origem).send(pedido());
        assert.deepEqual([criar.status, criar.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], origem);
        assert.deepEqual(cabecalhosCors(criar), [], origem);
        const remover = await request(app).delete(`/api/vinculos-sst/${u.alvo}`).set('Cookie', cookie.master).set('Origin', origem);
        assert.deepEqual([remover.status, remover.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], origem);
      }
      assert.equal(await solicitacoesDe(u.solicitante), antes);
      assert.equal(await vinculo(u.alvo), 1, 'o vínculo continua');
      const removido = await request(app).delete(`/api/vinculos-sst/${u.alvo}`).set('Cookie', cookie.master).set('Origin', ORIGEM);
      assert.equal(removido.status, 200, JSON.stringify(removido.body));
      assert.equal(await vinculo(u.alvo), 0);
    });

    test('sem sessão: 401 com a origem permitida (a origem não substitui a autenticação); sem sessão e sem origem: 403 ORIGEM_AUSENTE primeiro', async () => {
      for (const [metodo, rota] of ESCRITAS) {
        const comOrigem = request(app)[metodo.toLowerCase()](rota).set('Origin', ORIGEM);
        const r = await (metodo === 'POST' ? comOrigem.send({}) : comOrigem);
        assert.equal(r.status, 401, `${metodo} ${rota}`);
        const semNada = request(app)[metodo.toLowerCase()](rota);
        const r2 = await (metodo === 'POST' ? semNada.send({}) : semNada);
        assert.deepEqual([r2.status, r2.body.codigo], [403, 'ORIGEM_AUSENTE'], `${metodo} ${rota}`);
      }
    });

    test('decidir e encerrar pela cadeia real: a SST com a sessão real e a origem permitida decide e encerra; o ator gravado é o da sessão', async () => {
      const criada = await request(app).post('/api/solicitacoes-epi').set('Cookie', cookie.solicitante).set('Origin', ORIGEM).send(pedido());
      const id = criada.body.solicitacao.id;
      const decidida = await request(app).post(`/api/solicitacoes-epi/${id}/decisao`).set('Cookie', cookie.sst).set('Origin', ORIGEM)
        .send({ decisoes: [{ itemId: criada.body.itens[0].id, decisao: 'APROVADO' }] });
      assert.equal(decidida.status, 200, JSON.stringify(decidida.body));
      const encerrada = await request(app).post(`/api/solicitacoes-epi/${id}/encerramento`).set('Cookie', cookie.sst).set('Origin', ORIGEM).send({ justificativa: 'Mudança de função' });
      assert.equal(encerrada.status, 200, JSON.stringify(encerrada.body));
      const { rows: [linha] } = await q('SELECT decidida_por, encerrada_por FROM solicitacoes_epi WHERE id = $1', [id]);
      assert.deepEqual([linha.decidida_por, linha.encerrada_por], [u.sst, u.sst]);

      // A auditoria dos três atos não leva cookie, token da sessão, cabeçalho nem a justificativa do encerramento.
      const { rows: registros } = await q(
        "SELECT acao, descricao, ip, dispositivo, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE referencia = $1 AND acao LIKE 'SOLICITACAO_EPI_%' ORDER BY id", [String(id)],
      );
      assert.deepEqual(registros.map((r) => r.acao), ['SOLICITACAO_EPI_CRIADA', 'SOLICITACAO_EPI_DECIDIDA', 'SOLICITACAO_EPI_ENCERRADA']);
      const texto = JSON.stringify(registros);
      const tokens = [cookie.solicitante, cookie.sst].flatMap((c) => c.split('; ').map((par) => par.slice(par.indexOf('=') + 1)));
      for (const token of tokens) assert.equal(texto.includes(token), false, 'token de sessão na auditoria');
      for (const proibido of [C_GLOBAL, C_EMPRESA, 'Cookie', 'cookie', 'Authorization', 'authorization', 'Mudança de função', SENHA]) {
        assert.equal(texto.includes(proibido), false, `"${proibido}" na auditoria`);
      }
    });

    test('a sessão de quem pede não decide (403 PERMISSAO_NEGADA) mesmo com a origem permitida', async () => {
      const criada = await request(app).post('/api/solicitacoes-epi').set('Cookie', cookie.solicitante).set('Origin', ORIGEM).send(pedido());
      const r = await request(app).post(`/api/solicitacoes-epi/${criada.body.solicitacao.id}/decisao`).set('Cookie', cookie.solicitante).set('Origin', ORIGEM)
        .send({ decisoes: [{ itemId: criada.body.itens[0].id, decisao: 'APROVADO' }] });
      assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA']);
    });

    test('Content-Type diferente de application/json: 415, e nada gravado', async () => {
      const antes = await solicitacoesDe(u.solicitante);
      const r = await request(app).post('/api/solicitacoes-epi').set('Cookie', cookie.solicitante).set('Origin', ORIGEM).set('Content-Type', 'text/plain').send('funcionarioId=1');
      assert.equal(r.status, 415);
      assert.equal(await solicitacoesDe(u.solicitante), antes);
    });
  });
});
