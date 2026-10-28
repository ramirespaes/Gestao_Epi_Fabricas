'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const app = require('../../src/app');
const { httpConfig } = require('../../src/config/http');

/**
 * Bloco A1 — as duas rotas de resumo estão montadas no app REAL, atrás da sessão (sem cookie: 401, antes de qualquer consulta),
 * só com GET (escrita = 404) e lendo empresa e usuário exclusivamente da sessão.
 */
const ORIGEM = httpConfig.cors.origens[0];
const RAIZ = path.join(__dirname, '..', '..', 'src');

describe('Privacidade e LGPD e Gestão de E-mails — composição no app real', () => {
  test('sem sessão, os dois GET respondem 401 (nenhum é público)', async () => {
    for (const caminho of ['/api/lgpd/resumo', '/api/emails/resumo']) {
      const r = await request(app).get(caminho).set('Origin', ORIGEM);
      assert.equal(r.status, 401, caminho);
    }
  });

  test('não existe escrita: POST, PUT, PATCH e DELETE nos caminhos são 404, mesmo com origem permitida', async () => {
    for (const caminho of ['/api/lgpd/resumo', '/api/emails/resumo']) {
      for (const metodo of ['post', 'put', 'patch', 'delete']) {
        const r = await request(app)[metodo](caminho).set('Origin', ORIGEM).send({});
        assert.equal(r.status, 404, `${metodo} ${caminho}`);
      }
    }
  });

  test('os controllers só leem req.empresa (nunca body, query ou params) e não citam usuário de outra empresa', () => {
    for (const arquivo of ['lgpd.controller.js', 'email-gestao.controller.js']) {
      const codigo = fs.readFileSync(path.join(RAIZ, 'controllers', arquivo), 'utf8');
      assert.match(codigo, /req\.empresa\.id/, arquivo);
      assert.doesNotMatch(codigo, /req\.(body|query|params|validado)/, arquivo);
    }
  });

  test('o resumo de e-mails nunca importa o transporte nem conta envios: só o catálogo de templates, os canais do cadastro e a configuração de entrega', () => {
    const servico = fs.readFileSync(path.join(RAIZ, 'services', 'email-gestao.service.js'), 'utf8');
    assert.doesNotMatch(servico, /nodemailer|createTransport|servico-email|enviados|falhas/i);
    assert.match(servico, /email\/templates/);
  });
});
