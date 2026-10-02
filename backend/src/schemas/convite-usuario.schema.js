'use strict';

const { z } = require('zod');
const {
  LIMITES, email, senhaEntrada, inteiroQuery, textoCurto,
} = require('./campos.schema');
const { PERFIS } = require('./usuario-administracao.schema');

/**
 * Convite de usuário (Bloco 9, parte F). Corpos estritos: empresa, quem
 * convida, identidade e situação vêm do servidor, nunca da requisição.
 * O perfil do convidado viaja como `tipoConta`, como na edição.
 * O token viaja SEMPRE em corpo JSON, nunca na URL.
 */

const CONVITE_ID_TEXTO = /^[1-9][0-9]{0,17}$/;
const TOKEN_FORMATO = /^[A-Za-z0-9_-]{43}$/;

const conviteIdParametro = z.string().transform((valor, ctx) => {
  if (!CONVITE_ID_TEXTO.test(valor)) {
    ctx.addIssue({ code: 'custom', message: 'Identificador inválido', params: { codigo: 'ID_INVALIDO' } });
    return z.NEVER;
  }
  return valor;
});

const tokenConvite = z.string().transform((valor, ctx) => {
  if (!TOKEN_FORMATO.test(valor)) {
    ctx.addIssue({ code: 'custom', message: 'Token de convite inválido', params: { codigo: 'TOKEN_INVALIDO' } });
    return z.NEVER;
  }
  return valor;
});

const criar = {
  body: z.strictObject({
    email,
    nome: textoCurto(150, 'NOME_INVALIDO', 'Nome inválido'),
    tipoConta: z.enum(PERFIS),
  }),
};

const listar = {
  query: z.strictObject({
    pagina: inteiroQuery(1, LIMITES.PAGINA_MAXIMA).default(1),
    limite: inteiroQuery(1, LIMITES.LIMITE_MAXIMO).default(LIMITES.LIMITE_PADRAO),
  }),
};

const cancelar = { params: z.strictObject({ conviteId: conviteIdParametro }), body: z.strictObject({}) };
const reenviar = { params: z.strictObject({ conviteId: conviteIdParametro }), body: z.strictObject({}) };

// Pessoa convidada, sem sessão.
const consultar = { body: z.strictObject({ token: tokenConvite }) };
const aceitar = { body: z.strictObject({ token: tokenConvite, senha: senhaEntrada }) };

module.exports = {
  criar, listar, cancelar, reenviar, consultar, aceitar,
};
