'use strict';

const { z } = require('zod');
const { idCorpo } = require('./campos.schema');

/**
 * Schema do alerta manual de falta de estoque (12G-6): só o pedido. Empresa,
 * ator, destinatários e texto nunca vêm do cliente (strictObject).
 */

const falta = { body: z.strictObject({ solicitacaoId: idCorpo }) };

module.exports = { falta };
