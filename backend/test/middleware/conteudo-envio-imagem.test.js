'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');

/**
 * Biblioteca de Imagens, Unidade 5C-1 (RED) — a EXCEÇÃO CONTROLADA da política de conteúdo do /api para o envio de imagem (H1/G2 dos Documentos 32 e 56).
 *
 * A política de hoje (exigirJson) responde 415 TIPO_CONTEUDO_NAO_SUPORTADO a todo POST, PUT e PATCH com corpo que não seja JSON. O envio da imagem da empresa
 * (POST /api/imagens-material/empresa?nome=, corpo BINÁRIO image/png|jpeg|webp) precisa passar por ela, e SÓ ele: a exceção é por IGUALDADE EXATA do caminho
 * completo (nunca prefixo, nunca barra final, nunca outro método, nunca outra caixa), na mesma disciplina das exceções de tamanho da importação GHE. Quem decide
 * o tipo, o tamanho e o conteúdo do corpo é a PRÓPRIA ROTA, depois da sessão e da permissão (testes da rota em test/routes/imagem-material-envio.routes.test.js).
 *
 * Aqui só se observa o que sai da cadeia exigirJson -> parserJson, sem depender de COMO a exceção é implementada (lista, função ou outro mecanismo): uma
 * sonda no fim da cadeia diz se o pedido chegou e quantos bytes do corpo ainda estavam no fluxo (a política não pode ter lido nem alterado o corpo, que a rota
 * vai ler). Nada aqui acessa o banco.
 *
 * Verde HOJE e que precisa continuar verde (proteção de regressão): UPL-09b e UPL-09c. RED: UPL-09a.
 */

const CAMINHO = '/api/imagens-material/empresa';
const TIPOS_DE_IMAGEM = ['image/png', 'image/jpeg', 'image/webp'];

// Cadeia equivalente à do app real dentro de /api: exigirJson -> parserJson -> rotas. A sonda lê o fluxo inteiro e diz quantos bytes chegaram.
const app = express();
app.use('/api', exigirJson, parserJson);
app.all('/api/*splat', async (req, res) => {
  let bytes = 0;
  for await (const bloco of req) bytes += bloco.length;
  res.status(200).json({ passou: true, metodo: req.method, bytes });
});
app.use(notFoundHandler);
app.use(errorHandler);

const resumo = (r) => `${r.status} ${JSON.stringify(r.body)}`;

describe('política de conteúdo do /api — exceção controlada do envio de imagem (Unidade 5C-1)', () => {
  test('UPL-09a — POST com image/png, image/jpeg e image/webp no caminho EXATO do envio (com a consulta ?nome=) chega à rota com o corpo intacto, inclusive acima de 32 KiB', async () => {
    const corpo = Buffer.alloc(100 * 1024, 7);
    for (const tipo of TIPOS_DE_IMAGEM) {
      const r = await request(app).post(`${CAMINHO}?nome=Luva`).set('Content-Type', tipo).send(corpo);
      if (r.status === 415 && r.body?.codigo === 'TIPO_CONTEUDO_NAO_SUPORTADO') {
        assert.fail(`contrato futuro: a exceção da política de conteúdo para POST ${CAMINHO} ainda não existe — ${tipo} respondeu ${resumo(r)}`);
      }
      assert.deepEqual([r.status, r.body.passou, r.body.metodo, r.body.bytes], [200, true, 'POST', corpo.length], `${tipo}: ${resumo(r)}`);
    }
  });

  test('UPL-09b (verde hoje; proteção de regressão) — a exceção é por igualdade EXATA: barra final, subcaminhos, prefixo, outra caixa, outro recurso e a lista continuam 415 TIPO_CONTEUDO_NAO_SUPORTADO para image/png', async () => {
    const vizinhos = [
      `${CAMINHO}/`, `${CAMINHO}/123`, `${CAMINHO}/123/inativar`, `${CAMINHO}x`, `${CAMINHO}//`, '/api/imagens-material', '/api/imagens-material/padrao',
      '/api/imagens-material/empresa/..%2Fmateriais', '/api/imagens-material/%65mpresa', '/api/IMAGENS-MATERIAL/EMPRESA', '/api/Imagens-Material/empresa', '/api/materiais',
      '/api/materiais/1', '/api/grupos-homogeneos/importacao/preview',
    ];
    for (const caminho of vizinhos) {
      const r = await request(app).post(caminho).set('Content-Type', 'image/png').send(Buffer.alloc(64, 1));
      assert.deepEqual([r.status, r.body.codigo], [415, 'TIPO_CONTEUDO_NAO_SUPORTADO'], `POST ${caminho}: ${resumo(r)}`);
    }
  });

  test('UPL-09c (verde hoje; proteção de regressão) — a exceção é só do POST: PUT e PATCH no mesmo caminho exato, com image/png, continuam 415', async () => {
    for (const metodo of ['put', 'patch']) {
      const r = await request(app)[metodo](`${CAMINHO}?nome=Luva`).set('Content-Type', 'image/png').send(Buffer.alloc(64, 1));
      assert.deepEqual([r.status, r.body.codigo], [415, 'TIPO_CONTEUDO_NAO_SUPORTADO'], `${metodo.toUpperCase()}: ${resumo(r)}`);
    }
  });
});
