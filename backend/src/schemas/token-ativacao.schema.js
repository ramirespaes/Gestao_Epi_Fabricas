'use strict';

const { z } = require('zod');
const { idParametro } = require('./campos.schema');

/**
 * Atendimento Token — geração do código de ativação (Etapa C). Só formato. O corpo é estrito e VAZIO: empresa, autoria, código,
 * validade e qualquer outro campo NUNCA vêm do cliente (400 VALIDACAO). O id do tablet é o único parâmetro.
 */

const gerar = {
  params: z.strictObject({ id: idParametro }),
  body: z.strictObject({}),
};

module.exports = { gerar };
