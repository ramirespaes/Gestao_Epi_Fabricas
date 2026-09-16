'use strict';

const express = require('express');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');

/**
 * App Express descartável para testes HTTP com supertest: a mesma política
 * de conteúdo do app real (exigirJson + parserJson), as rotas registradas
 * pelo callback e os handlers reais de 404 e de erro. Não abre porta, não
 * acessa banco.
 */
function criarAppTeste(registrarRotas = () => {}) {
  const app = express();
  app.use(exigirJson, parserJson);
  registrarRotas(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { criarAppTeste };
