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

module.exports = { login };
