'use strict';

const { z } = require('zod');
const { idParametro } = require('./campos.schema');

/**
 * Schemas do vínculo GHE × tipo de material (Incremento 3). Só formato; existência, empresa e estado ativo são do
 * serviço. `strictObject` em todo corpo: empresa e ator nunca vêm do cliente.
 */

const CLASSIFICACOES = Object.freeze(['OBRIGATORIO', 'NAO_OBRIGATORIO']);

const paramsGhe = z.strictObject({ id: idParametro });
const paramsVinculo = z.strictObject({ id: idParametro, tipoId: idParametro });

const consultar = { params: paramsGhe };

const definir = {
  params: paramsVinculo,
  body: z.strictObject({ classificacao: z.enum(CLASSIFICACOES) }),
};

const desvincular = {
  params: paramsVinculo,
  body: z.strictObject({}),
};

module.exports = { consultar, definir, desvincular, CLASSIFICACOES };
