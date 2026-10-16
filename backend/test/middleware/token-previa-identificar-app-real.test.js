'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');

const app = require('../../src/app');
const rateLimit = require('../../src/middleware/rate-limit');
const { httpConfig } = require('../../src/config/http');
const { gerarTokenSessao } = require('../../src/security/token');

/**
 * K7 — Consulta real da prévia do Totem (RED), SEM banco, no app REAL: a rota nova está montada, exige sessão administrativa antes de
 * qualquer outra coisa (nem o cookie do tablet nem o do atendimento a autenticam) e passa pela verificação de Origin (é POST). O
 * limitador próprio conta por EMPRESA + USUÁRIO (20 por minuto) e responde com a mensagem genérica de limite, sem ecoar nada.
 */

const ROTA = '/api/atendimento-token/previa/identificar';
const ORIGEM = httpConfig.cors.origens[0];
const CORPO = { tipo: 'MATRICULA', valor: 'MX-4242' };

function rotasDoPortal() {
  const rotas = [];
  const coletar = (pilha) => {
    for (const c of pilha) {
      if (c.route) for (const [m, ativo] of Object.entries(c.route.methods)) { if (ativo) rotas.push(`${m.toUpperCase()} ${c.route.path}`); }
      else if (c.handle && Array.isArray(c.handle.stack)) coletar(c.handle.stack);
    }
  };
  app.router.stack.filter((c) => c.handle && Array.isArray(c.handle.stack) && c.match('/api/x')).forEach((c) => coletar(c.handle.stack));
  return rotas;
}

describe('K7 — rota previa/identificar no app real (sem banco)', () => {
  test('K7-R1 — a rota POST está montada no namespace do portal, sem outro verbo para o mesmo caminho', () => {
    const rotas = rotasDoPortal();
    assert.ok(rotas.includes('POST /atendimento-token/previa/identificar'), 'RED K7: rota ainda não montada (comportamento ausente)');
    assert.equal(rotas.some((r) => /^(GET|PUT|PATCH|DELETE) \/atendimento-token\/previa\/identificar/.test(r)), false);
  });

  test('K7-R2 — sem sessão administrativa é 401 (antes de validar o corpo); cookies do tablet e do atendimento não autenticam', async () => {
    const sem = await request(app).post(ROTA).set('Origin', ORIGEM).send(CORPO);
    assert.deepEqual([sem.status, sem.body.codigo !== 'ROTA_NAO_ENCONTRADA'], [401, true], `${sem.status} ${JSON.stringify(sem.body)}`);
    const comTablet = await request(app).post(ROTA).set('Origin', ORIGEM).set('Cookie', `gepi_tablet=${gerarTokenSessao()}; gepi_atendimento=${gerarTokenSessao()}`).send(CORPO);
    assert.equal(comTablet.status, 401);
    const invalido = await request(app).post(ROTA).set('Origin', ORIGEM).send({ qualquer: 'coisa' });
    assert.equal(invalido.status, 401, 'a negação vem antes de qualquer detalhe do corpo');
  });

  test('K7-R3 — sem Origin ou com origem de fora a mutação é recusada (403), como todas as rotas POST do portal', async () => {
    const sem = await request(app).post(ROTA).send(CORPO);
    assert.deepEqual([sem.status, sem.body.codigo], [403, 'ORIGEM_AUSENTE']);
    const fora = await request(app).post(ROTA).set('Origin', 'https://atacante.example').send(CORPO);
    assert.deepEqual([fora.status, fora.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA']);
  });

  test('K7-R4 — a resposta de erro nunca ecoa o identificador enviado', async () => {
    const SEGREDO = 'IDENTIFICADOR-QUE-NAO-PODE-VOLTAR';
    const r = await request(app).post(ROTA).set('Origin', ORIGEM).send({ tipo: 'MATRICULA', valor: SEGREDO });
    assert.equal(JSON.stringify(r.body).includes(SEGREDO), false);
  });
});

describe('K7 — limitador da prévia (20 por minuto por empresa + usuário)', () => {
  const montar = (limitador) => {
    const a = express();
    a.use((req, res, next) => { req.empresa = { id: Number(req.get('x-e')) }; req.usuario = { id: Number(req.get('x-u')) }; next(); });
    a.post('/x', limitador, (req, res) => res.json({ ok: true }));
    a.use((erro, req, res, next) => { res.status(erro.status || 500).json(erro.corpoResposta ? erro.corpoResposta() : { codigo: 'ERRO' }); });
    return a;
  };
  const exigir = () => assert.equal(typeof rateLimit.criarLimitadorPreviaIdentificacao, 'function', 'RED K7: limitador ainda não existe (comportamento ausente)');

  test('K7-L1 — constante e fábrica: 20 por 60 s', () => {
    exigir();
    assert.deepEqual({ ...rateLimit.LIMITE_PREVIA_IDENTIFICACAO }, { limite: 20, janelaSegundos: 60 });
    assert.equal(typeof rateLimit.limitadorPreviaIdentificacao, 'function', 'instância compartilhada pelas rotas reais');
  });

  test('K7-L2 — a 21ª tentativa do mesmo usuário e empresa é 429 genérico; outro usuário ou outra empresa tem contador próprio', async () => {
    exigir();
    const a = montar(rateLimit.criarLimitadorPreviaIdentificacao());
    for (let i = 0; i < 20; i += 1) {
      const r = await request(a).post('/x').set('x-e', '1').set('x-u', '5').send({ valor: 'MX-1' });
      assert.equal(r.status, 200, `tentativa ${i + 1}`);
    }
    const excesso = await request(a).post('/x').set('x-e', '1').set('x-u', '5').send({ valor: 'IDENTIFICADOR-SECRETO' });
    assert.equal(excesso.status, 429);
    assert.equal(excesso.body.codigo, 'LIMITE_REQUISICOES_EXCEDIDO');
    assert.equal(JSON.stringify(excesso.body).includes('IDENTIFICADOR-SECRETO'), false);
    assert.equal((await request(a).post('/x').set('x-e', '1').set('x-u', '6').send({})).status, 200, 'outro usuário');
    assert.equal((await request(a).post('/x').set('x-e', '2').set('x-u', '5').send({})).status, 200, 'outra empresa');
  });
});
