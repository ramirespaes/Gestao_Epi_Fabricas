'use strict';

const { z } = require('zod');

/**
 * Consulta das solicitações existentes do Atendimento Token (Etapa G): nenhuma entrada do cliente. Empresa, funcionário, GHE, CPF, matrícula,
 * filtro de situação, paginação e inclusão de pedidos encerrados NUNCA vêm do navegador; qualquer parâmetro de query é 400 antes de tocar
 * o banco.
 */
const obter = {
  query: z.strictObject({}),
};

module.exports = { obter };
