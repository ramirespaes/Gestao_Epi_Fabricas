'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const app = require('../../src/app');
const { httpConfig } = require('../../src/config/http');

/**
 * Suporte — o app REAL monta as rotas do Portal e as do Painel, cada uma atrás da própria sessão. Sem banco: todas as respostas
 * abaixo vêm antes de qualquer consulta (sem cookie, a sessão recusa).
 */
const ORIGEM = httpConfig.cors.origens[0];
const RAIZ = path.join(__dirname, '..', '..', 'src');

describe('Suporte — composição no app real', () => {
  test('Portal: sem sessão, todas as rotas respondem 401 (nenhuma é pública)', async () => {
    for (const [metodo, caminho] of [['get', '/api/suporte/canais'], ['get', '/api/suporte/chamados'], ['post', '/api/suporte/chamados'], ['get', '/api/suporte/chamados/1'], ['post', '/api/suporte/contatos/sst']]) {
      const r = await request(app)[metodo](caminho).set('Origin', ORIGEM).send(metodo === 'post' ? {} : undefined);
      assert.equal(r.status, 401, `${metodo} ${caminho}`);
    }
  });

  test('Painel: as rotas existem só no namespace da plataforma e exigem a sessão administrativa; no Portal /api/plataforma/suporte não é alcançável', async () => {
    const r = await request(app).get('/api/plataforma/suporte/chamados');
    assert.ok([401, 403, 404].includes(r.status), `${r.status}`);
    assert.notEqual(r.status, 200);
    const portal = await request(app).get('/api/suporte/plataforma').set('Origin', ORIGEM);
    assert.equal(portal.status, 404);
  });

  test('as rotas do Portal não leem empresa, usuário, e-mail ou destinatário do cliente (a fonte é a sessão e o cadastro)', () => {
    const controlador = fs.readFileSync(path.join(RAIZ, 'controllers', 'suporte.controller.js'), 'utf8');
    assert.doesNotMatch(controlador, /req\.(body|query|params)\./, 'o controller só lê req.validado');
    assert.doesNotMatch(controlador, /req\.validado\.(body|query)\.(empresa|usuario|email|para|destinatario)/i);
    assert.match(controlador, /req\.empresa\.id/);
    assert.match(controlador, /req\.usuario\.id/);
    const plataforma = fs.readFileSync(path.join(RAIZ, 'controllers', 'suporte-plataforma.controller.js'), 'utf8');
    assert.match(plataforma, /req\.administradorPlataforma\.id/);
    assert.doesNotMatch(plataforma, /req\.usuario|req\.empresa/);
  });

  test('o serviço de contatos nunca importa o transporte direto: usa o serviço único de e-mail', () => {
    const servico = fs.readFileSync(path.join(RAIZ, 'services', 'suporte.service.js'), 'utf8');
    assert.match(servico, /servico-email/);
    assert.doesNotMatch(servico, /nodemailer|createTransport|mailto:/);
  });
});
