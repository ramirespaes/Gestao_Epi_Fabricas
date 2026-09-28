'use strict';

const { z } = require('zod');
const { email, senhaEntrada } = require('./campos.schema');

/**
 * Schema da rota de login do Painel Privado (Autenticação Global —
 * Pacote 2). Reaproveita `email`/`senhaEntrada` de campos.schema.js sem
 * alteração — os mesmos campos genéricos usados pelo login empresarial.
 *
 * SEM `cnpj`: "o login administrativo não pode depender da existência de
 * uma empresa cadastrada" — o corpo é estritamente { email, senha }, e
 * `strictObject` rejeita qualquer campo a mais, incluindo um `cnpj`
 * enviado por engano.
 */

const login = {
  body: z.strictObject({
    email,
    senha: senhaEntrada,
  }),
};

// Cadastro do MFA. O código de liberação só tem limite de tamanho aqui: a
// forma canônica (16 símbolos, aliases, hífens e espaços) é do serviço, e
// um código fora do formato conta como tentativa inválida, não como 400.
const mfaLiberacao = {
  body: z.strictObject({
    codigoLiberacao: z.string().min(1).max(64),
  }),
};

const mfaCadastroReiniciar = {
  body: z.strictObject({}),
};

const mfaCadastroConfirmar = {
  body: z.strictObject({
    codigo: z.string().regex(/^[0-9]{6}$/),
  }),
};

module.exports = { login, mfaLiberacao, mfaCadastroReiniciar, mfaCadastroConfirmar };
