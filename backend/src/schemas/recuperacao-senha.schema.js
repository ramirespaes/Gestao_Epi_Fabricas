'use strict';

const { z } = require('zod');
const { senhaEntrada, turnstileToken, LIMITES } = require('./campos.schema');

/**
 * Schemas das rotas de recuperação de senha. Só estrutura.
 *
 * O e-mail não usa o campo `email` do projeto: ele normaliza e recusa
 * endereço malformado, e aqui um e-mail que não normaliza precisa chegar ao
 * service para receber a mesma resposta de um e-mail inexistente. O token
 * também segue como veio; quem decide se vale é o service.
 *
 * A query é sempre vazia: o token só viaja no corpo JSON.
 */

const TOKEN_ENTRADA_MAXIMO = 256;

const emailEntrada = z.string().max(LIMITES.EMAIL_ENTRADA_MAXIMO);
const tokenEntrada = z.string().max(TOKEN_ENTRADA_MAXIMO);
const semQuery = z.strictObject({});

const solicitarPortal = {
  body: z.strictObject({ email: emailEntrada, turnstileToken }),
  query: semQuery,
};

const solicitarPlataforma = {
  body: z.strictObject({ email: emailEntrada }),
  query: semQuery,
};

const redefinir = {
  body: z.strictObject({ token: tokenEntrada, novaSenha: senhaEntrada }),
  query: semQuery,
};

module.exports = { solicitarPortal, solicitarPlataforma, redefinir };
