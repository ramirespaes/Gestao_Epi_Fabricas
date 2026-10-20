'use strict';

const { z } = require('zod');
const { LIMITES, inteiroQuery } = require('./campos.schema');
const { idGrandeParametro } = require('./identificador-grande.schema');

/**
 * Schema da entrega de arquivos de imagem (Biblioteca de Imagens, Unidade 5A-1):
 *   GET|HEAD /api/imagens-material/:origem/:id/:variante?v=<versao>
 *
 * Só formato, sem contexto: não consulta banco nem conhece empresa. `origem` e `variante` entram como texto e NÃO são validadas aqui:
 * valor fora de `empresa|padrao` e `miniatura|exibicao` é 404 uniforme do serviço, nunca 400 (nenhum oráculo de existência). O `id` é
 * BIGINT em texto decimal canônico. `v` (versão da imagem, usada só para o cache imutável) é opcional e a única chave aceita na query.
 */
const entregar = {
  params: z.strictObject({ origem: z.string(), id: idGrandeParametro, variante: z.string() }),
  query: z.strictObject({ v: inteiroQuery(1, LIMITES.INTEGER_MAXIMO).optional() }),
};

module.exports = { entregar };
