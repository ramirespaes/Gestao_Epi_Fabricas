'use strict';

const { z } = require('zod');

/**
 * Atendimento Token — rotas do tablet (Etapa C). Só formato e limite de tamanho: o código malformado dentro do limite NÃO é 400
 * (é a mesma recusa genérica de qualquer código inválido, sem revelar a causa); acima do limite ou fora do contrato é 400.
 * strictObject: empresa, tablet, credencial e qualquer campo extra NUNCA vêm do cliente. O estado não aceita parâmetro algum
 * (a credencial só vale no cookie, nunca em query).
 */

const CODIGO_TAMANHO_MAXIMO = 128;

const ativar = {
  body: z.strictObject({ codigo: z.string().min(1).max(CODIGO_TAMANHO_MAXIMO) }),
};

const estado = {
  query: z.strictObject({}),
};

module.exports = { CODIGO_TAMANHO_MAXIMO, ativar, estado };
