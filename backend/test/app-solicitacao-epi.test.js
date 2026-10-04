'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

/**
 * As rotas HTTP da solicitação de EPI e dos vínculos SST (12F-1 consultas,
 * 12F-2 escrita) estão montadas no app real, sob /api e atrás da cadeia global:
 * sem sessão, cada uma responde 401 (nunca 404, nunca 200), também em HEAD. As
 * de escrita passam antes pela verificação de origem (CSRF): sem Origin nem
 * Referer, ou com uma origem fora da allowlist do Portal, são recusadas antes
 * da sessão. O Painel Privado não atende nenhum desses caminhos. Nada aqui
 * acessa o banco: a origem e exigirSessao recusam antes.
 */

describe('app.js — solicitação de EPI e vínculos SST (12F-1 e 12F-2)', () => {
  const app = require('../src/app');
  const ORIGEM = 'http://localhost:5500';
  const ORIGEM_DO_PAINEL = 'http://localhost:5501';
  const ROTAS = [
    '/api/solicitacoes-epi/minhas', '/api/solicitacoes-epi/fila', '/api/solicitacoes-epi/entregaveis', '/api/solicitacoes-epi/1', '/api/vinculos-sst',
    // 12G-0
    '/api/solicitacoes-epi/contexto/funcionarios', '/api/solicitacoes-epi/contexto/1/materiais', '/api/solicitacoes-epi/encerraveis',
  ];
  const ESCRITAS = [
    ['post', '/api/solicitacoes-epi'],
    ['post', '/api/solicitacoes-epi/1/cancelamento'],
    ['post', '/api/solicitacoes-epi/1/decisao'],
    ['post', '/api/solicitacoes-epi/1/encerramento'],
    ['post', '/api/solicitacoes-epi/1/entregas'],
    ['post', '/api/vinculos-sst'],
    ['delete', '/api/vinculos-sst/1'],
  ];
  const enviar = (metodo, rota) => (metodo === 'post' ? request(app).post(rota).send({}) : request(app)[metodo](rota));

  test('nenhuma consulta é pública: sem cookie de sessão, 401 SESSAO_INVALIDA em GET e em HEAD', async () => {
    for (const rota of ROTAS) {
      const r = await request(app).get(rota).set('Origin', ORIGEM);
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `GET ${rota}`);
      const cabeca = await request(app).head(rota).set('Origin', ORIGEM);
      assert.equal(cabeca.status, 401, `HEAD ${rota}`);
    }
  });

  test('nenhuma escrita é pública: com a origem do Portal e sem sessão, 401 SESSAO_INVALIDA', async () => {
    for (const [metodo, rota] of ESCRITAS) {
      const r = await (metodo === 'post' ? request(app).post(rota).set('Origin', ORIGEM).send({}) : request(app)[metodo](rota).set('Origin', ORIGEM));
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `${metodo.toUpperCase()} ${rota}`);
    }
  });

  test('CSRF: a escrita sem Origin nem Referer é 403 ORIGEM_AUSENTE; com origem estranha ou a do Painel Privado, 403 ORIGEM_NAO_PERMITIDA', async () => {
    for (const [metodo, rota] of ESCRITAS) {
      const semOrigem = await enviar(metodo, rota);
      assert.deepEqual([semOrigem.status, semOrigem.body.codigo], [403, 'ORIGEM_AUSENTE'], `${metodo.toUpperCase()} ${rota}`);
      for (const origem of ['http://mal.test', ORIGEM_DO_PAINEL]) {
        const r = await (metodo === 'post' ? request(app).post(rota).set('Origin', origem).send({}) : request(app)[metodo](rota).set('Origin', origem));
        assert.deepEqual([r.status, r.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], `${metodo.toUpperCase()} ${rota} ${origem}`);
      }
    }
  });

  test('a escrita só aceita JSON: outro Content-Type é 415, mesmo antes da sessão', async () => {
    const r = await request(app).post('/api/solicitacoes-epi').set('Origin', ORIGEM).set('Content-Type', 'text/plain').send('funcionarioId=1');
    assert.equal(r.status, 415);
  });

  test('os caminhos montados são exatamente as consultas da 12F-1 e da 12G-0 e as escritas da 12F-2 (só POST e DELETE)', () => {
    const caminhos = [];
    const percorrer = (pilha) => {
      for (const camada of pilha) {
        if (camada.route) {
          for (const [metodo, ativo] of Object.entries(camada.route.methods)) if (ativo) caminhos.push(`${metodo.toUpperCase()} ${camada.route.path}`);
        } else if (camada.handle && Array.isArray(camada.handle.stack)) percorrer(camada.handle.stack);
      }
    };
    percorrer(app.router.stack);
    const novos = caminhos.filter((c) => /\/solicitacoes-epi|\/vinculos-sst/.test(c)).sort();
    assert.deepEqual(novos, [
      'DELETE /vinculos-sst/:usuarioId',
      'GET /solicitacoes-epi/:id', 'GET /solicitacoes-epi/contexto/:funcionarioId/materiais', 'GET /solicitacoes-epi/contexto/funcionarios',
      'GET /solicitacoes-epi/encerraveis', 'GET /solicitacoes-epi/entregaveis', 'GET /solicitacoes-epi/fila', 'GET /solicitacoes-epi/minhas', 'GET /vinculos-sst',
      'POST /solicitacoes-epi', 'POST /solicitacoes-epi/:id/cancelamento', 'POST /solicitacoes-epi/:id/decisao', 'POST /solicitacoes-epi/:id/encerramento',
      'POST /solicitacoes-epi/:id/entregas', 'POST /vinculos-sst',
    ]);
  });

  test('o Painel Privado não atende a solicitação nem os vínculos: com a origem dele, 404 fixo na cadeia própria', async () => {
    for (const [metodo, rota] of ESCRITAS) {
      const rotaPainel = rota.replace('/api/', '/api/plataforma/');
      const r = await (metodo === 'post'
        ? request(app).post(rotaPainel).set('Origin', ORIGEM_DO_PAINEL).send({})
        : request(app)[metodo](rotaPainel).set('Origin', ORIGEM_DO_PAINEL));
      assert.deepEqual([r.status, r.body.codigo], [404, 'ROTA_NAO_ENCONTRADA'], `${metodo.toUpperCase()} ${rotaPainel}`);
    }
  });

  test('rota inexistente ao lado das novas continua 404 fixo', async () => {
    const r = await request(app).get('/api/solicitacoes-epi/1/inexistente');
    assert.deepEqual([r.status, r.body.codigo], [404, 'ROTA_NAO_ENCONTRADA']);
  });
});
