'use strict';

const { z } = require('zod');
const { email, senhaEntrada, textoCurto } = require('./campos.schema');
const { TEMAS, MODOS_VISUAIS } = require('../utils/preferencias-aparencia');

/**
 * Configurações — conta da identidade autenticada. Só estrutura e
 * normalização: a identidade NUNCA vem do corpo (strictObject recusa
 * qualquer campo de autoridade) e é a da sessão global, decidida pelo
 * middleware. A senha atual passa como veio; o novo e-mail sai normalizado
 * (campos.schema.email). A query é sempre vazia.
 */

const TELEFONE_MAXIMO = 20;
const semQuery = z.strictObject({});
const telefone = textoCurto(TELEFONE_MAXIMO, 'TELEFONE_INVALIDO', 'Telefone inválido').nullable();

const atualizar = {
  body: z.strictObject({
    telefone: telefone.optional(),
    tema: z.enum(TEMAS).optional(),
    modoVisual: z.enum(MODOS_VISUAIS).optional(),
  }).refine((corpo) => Object.keys(corpo).length > 0, { message: 'Informe ao menos um campo' }),
  query: semQuery,
};

const trocarEmail = {
  body: z.strictObject({ senhaAtual: senhaEntrada, novoEmail: email }),
  query: semQuery,
};

module.exports = { atualizar, trocarEmail, TEMAS, MODOS_VISUAIS };
