'use strict';

const { z } = require('zod');
const {
  idCorpo, idParametro, textoCurto, paginacaoQuery,
} = require('./campos.schema');
const { MOTIVO_MAXIMO } = require('../repositories/vinculo-sst.repository');

/**
 * Vínculos SST pela camada HTTP: listagem (12F-1), concessão e remoção (12F-2).
 * Estritos: a empresa e quem concede ou remove vêm da sessão, nunca do cliente;
 * o alvo é o usuário informado, e a autoridade (MASTER ativo da própria
 * empresa) é decidida pelo serviço.
 */

const listar = { query: z.strictObject({ ...paginacaoQuery }) };

const conceder = {
  body: z.strictObject({
    usuarioId: idCorpo,
    motivo: textoCurto(MOTIVO_MAXIMO, 'MOTIVO_INVALIDO', 'Motivo inválido').nullable().optional(),
  }),
};

const remover = { params: z.strictObject({ usuarioId: idParametro }) };

module.exports = { listar, conceder, remover };
