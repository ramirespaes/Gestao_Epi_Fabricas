'use strict';

const { z } = require('zod');
const { cpf, textoCurto } = require('./campos.schema');

/**
 * Atendimento Token — atendimento temporário do funcionário no tablet (Etapa D). Só formato e limite de tamanho.
 * strictObject: empresa, tablet, funcionário, atendimento, PIN, senha, data de nascimento, crachá, segundo fator, código ou token
 * NUNCA vêm do cliente. O tipo é escolhido explicitamente: nunca se infere pelo formato do valor.
 *
 *   CPF        exatamente 11 algarismos, pontuação opcional (estrutura só: sem exigir dígitos verificadores, por causa dos legados).
 *   MATRICULA  o mesmo formato do cadastro (aparar, NFC, 1 a 30 pontos de código, sem controle); nunca convertida em número.
 */

const MATRICULA_MAXIMA = 30;

const identificar = {
  query: z.strictObject({}),
  body: z.discriminatedUnion('tipo', [
    z.strictObject({ tipo: z.literal('CPF'), valor: cpf }),
    z.strictObject({ tipo: z.literal('MATRICULA'), valor: textoCurto(MATRICULA_MAXIMA, 'MATRICULA_INVALIDA', 'Matrícula inválida') }),
  ]),
};

const operacao = {
  query: z.strictObject({}),
  body: z.strictObject({}),
};

const estado = {
  query: z.strictObject({}),
};

module.exports = { MATRICULA_MAXIMA, identificar, operacao, estado };
