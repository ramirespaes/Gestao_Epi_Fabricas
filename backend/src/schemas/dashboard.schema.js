'use strict';

const { z } = require('zod');

/**
 * Schema da rota do dashboard (Bloco 9, Etapa C, Parte C6): consulta sem
 * parâmetros — empresa e usuário vêm só da sessão; qualquer parâmetro de
 * consulta é recusado (strictObject).
 */

const indicadores = { query: z.strictObject({}) };

module.exports = { indicadores };
