'use strict';

const { z } = require('zod');
const { idParametro, email, senhaEntrada, textoCurto } = require('./campos.schema');

/**
 * Schemas das rotas de convite do MASTER (Pacote 3). Só formato.
 *
 * `conviteId` em params é BIGINT (convites_master.id): string decimal
 * canônica, PRESERVADA como string (nunca Number — perderia precisão
 * acima de 2^53). Mesma disciplina de sessoes.id.
 *
 * `token` (rotas públicas de aceite) é o token opaco em claro, no formato
 * canônico de src/security/token.js (43 chars base64url). Nunca é
 * ecoado em erro: o código é fixo.
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

const nome = textoCurto(150, 'NOME_INVALIDO', 'Nome inválido');

const paramsEmpresa = z.strictObject({ id: idParametro });
const paramsConvite = z.strictObject({ id: idParametro, conviteId: conviteIdParametro });
const semCorpo = z.strictObject({});

// Administrador da plataforma
const criar = { params: paramsEmpresa, body: z.strictObject({ email }) };
const listar = { params: paramsEmpresa };
const buscar = { params: paramsConvite };
const cancelar = { params: paramsConvite, body: semCorpo };

// Pessoa convidada (sem sessão). O token viaja SEMPRE em corpo JSON —
// nunca em query (sigilo: caminho vai para log/console, corpo não).
const consultar = { body: z.strictObject({ token: tokenConvite }) };
const aceitar = { body: z.strictObject({ token: tokenConvite, nome, senha: senhaEntrada }) };

module.exports = { criar, listar, buscar, cancelar, consultar, aceitar };
