'use strict';

const { z } = require('zod');

/**
 * Catálogo do Atendimento Token (Etapa E): nenhuma entrada do cliente. Empresa, funcionário, GHE, material, filtro, busca e paginação
 * NUNCA vêm do navegador; qualquer parâmetro de query é 400 antes de tocar o banco.
 */
const obter = {
  query: z.strictObject({}),
};

module.exports = { obter };
