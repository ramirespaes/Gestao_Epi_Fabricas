'use strict';

const { z } = require('zod');
const { senhaEntrada } = require('./campos.schema');

/**
 * Schemas da troca de senha autenticada. Só estrutura: a política da senha
 * nova é do service, e a identidade nunca vem do corpo (strictObject recusa
 * qualquer campo de autoridade). As senhas passam como vieram.
 *
 * No Painel Privado o código é só o TOTP de seis dígitos: recovery code não
 * substitui, e o campo de recuperação é recusado como qualquer outro.
 *
 * A query é sempre vazia.
 */

const semQuery = z.strictObject({});
const codigoTotp = z.string().regex(/^[0-9]{6}$/);

const trocarPortal = {
  body: z.strictObject({ senhaAtual: senhaEntrada, novaSenha: senhaEntrada }),
  query: semQuery,
};

const trocarPlataforma = {
  body: z.strictObject({ senhaAtual: senhaEntrada, novaSenha: senhaEntrada, codigo: codigoTotp }),
  query: semQuery,
};

module.exports = { trocarPortal, trocarPlataforma };
