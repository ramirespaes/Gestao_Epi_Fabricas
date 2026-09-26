'use strict';

const { z } = require('zod');
const { idParametro, idCorpo } = require('./campos.schema');

/**
 * Schemas da matriz GHE × EPI (Bloco 9, Etapa C, Parte C5). Só formato;
 * existência, empresa e estado ativo são do serviço. `strictObject` em todo
 * corpo: empresa e ator nunca vêm do cliente.
 */

const paramsGhe = z.strictObject({ id: idParametro });

const consultar = { params: paramsGhe };

const vincular = {
  params: paramsGhe,
  body: z.strictObject({ materialId: idCorpo }),
};

const desvincular = {
  params: z.strictObject({ id: idParametro, materialId: idParametro }),
  body: z.strictObject({}),
};

module.exports = { consultar, vincular, desvincular };
