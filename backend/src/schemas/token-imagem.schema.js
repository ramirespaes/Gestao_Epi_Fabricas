'use strict';

const { z } = require('zod');
const { LIMITES, inteiroQuery } = require('./campos.schema');
const { idGrandeParametro } = require('./identificador-grande.schema');

/**
 * Atendimento Token — imagens do material no tablet:
 *   GET|HEAD /api/atendimento-token/tablet/atendimento/imagens/:origem/:id/:variante?v=<versao>
 *
 * Só formato, sem contexto. Diferente da rota administrativa, origem e variante são estritas (formato inválido é 400 antes da autenticação).
 * O `mestre` nunca sai por aqui. `id` é BIGINT em texto decimal canônico (nunca Number). Empresa, material, atendimento e tablet NÃO
 * são parâmetros: o servidor os deduz. Nenhum identificador recebido é autorização.
 */

const obter = {
  params: z.strictObject({ origem: z.enum(['empresa', 'padrao']), id: idGrandeParametro, variante: z.enum(['miniatura', 'exibicao']) }),
  query: z.strictObject({ v: inteiroQuery(1, LIMITES.INTEGER_MAXIMO).optional() }),
};

const ORIGEM_DA_ROTA = new Map([['EMPRESA', 'empresa'], ['PADRAO', 'padrao']]);

/** Converte a origem do catálogo (EMPRESA|PADRAO) para a da rota; qualquer outro valor é null. */
const origemDaRota = (origemDoCatalogo) => ORIGEM_DA_ROTA.get(origemDoCatalogo) ?? null;

module.exports = { obter, origemDaRota };
