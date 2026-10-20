'use strict';

const { z } = require('zod');
const { normalizarIdGrande } = require('../utils/identificador-grande');

/**
 * Validadores do identificador BIGINT (imagens da Biblioteca de Imagens): texto decimal canônico de 1 a 9223372036854775807, SEM perda de
 * precisão — por isso nunca viram `Number` (os campos de `campos.schema.js`, `idParametro` e `idCorpo`, são int4 e convertem para Number).
 * O código de erro é o mesmo vocabulário dos demais identificadores (`ID_INVALIDO`), em URL ou em corpo.
 *
 * Ficam num módulo próprio, e não em `campos.schema.js`, porque o teste histórico `campos.schema.test.js` fixa a lista EXATA de exports
 * daquele módulo e a V7 não autorizou alterá-lo nesta rodada; mover estes dois validadores para lá é um ajuste de uma linha naquele teste,
 * se a V7 preferir consolidar.
 *
 * - `idGrandeParametro`: params de rota (sempre string). Aceita só a forma canônica; devolve a MESMA string.
 * - `idGrandeCorpo`: corpo JSON. Aceita texto canônico ou inteiro seguro positivo (a convenção dos ids int4), e devolve sempre TEXTO. Um número
 *   fora do intervalo seguro, zero, negativo ou fracionário é recusado: o JSON já o terá arredondado e a precisão não é recuperável. Tipos
 *   que não são texto nem número (booleano, null, objeto, ausente) seguem o vocabulário nativo de tipo inválido/campo obrigatório.
 * Toda issue tem mensagem fixa e nunca inclui o valor recebido.
 */

const MENSAGEM = 'Identificador inválido';

function recusar(ctx) {
  ctx.addIssue({ code: 'custom', message: MENSAGEM, params: { codigo: 'ID_INVALIDO' } });
  return z.NEVER;
}

const textoCanonico = z.string().transform((valor, ctx) => normalizarIdGrande(valor) ?? recusar(ctx));

const idGrandeParametro = textoCanonico;

// Todo número vira texto (inteiro seguro positivo) ou, se não for, o texto vazio — que a regra canônica recusa com ID_INVALIDO.
const idGrandeCorpo = z.preprocess(
  (valor) => (typeof valor === 'number' ? (Number.isSafeInteger(valor) && valor > 0 ? String(valor) : '') : valor),
  textoCanonico,
);

module.exports = { idGrandeParametro, idGrandeCorpo };
