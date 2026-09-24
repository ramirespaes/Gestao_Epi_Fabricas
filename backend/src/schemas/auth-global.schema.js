'use strict';

const { z } = require('zod');
const { email, senhaEntrada, idParametro } = require('./campos.schema');

/**
 * Schemas das rotas de autenticação GLOBAL do Portal do Cliente
 * (Autenticação Global — Pacote 4). Reaproveita os campos genéricos de
 * campos.schema.js sem alteração.
 *
 * SEM `cnpj` em lugar nenhum: o Portal do Cliente autentica só por e-mail e
 * senha (contrato definitivo, adendo v2.1 §1.2); `strictObject` rejeita
 * qualquer campo a mais, inclusive um `cnpj` enviado por engano.
 *
 * A empresa selecionada vai na URL (`/auth/global/empresas/:id/selecionar`),
 * nunca no corpo: o cliente HTTP do frontend recusa, por construção, corpos
 * com `empresaId` (campo de autoridade), e aqui o identificador é uma
 * ESCOLHA entre opções que o servidor revalida — não uma autoridade.
 */

const login = {
  body: z.strictObject({
    email,
    senha: senhaEntrada,
  }),
};

const selecionarEmpresa = {
  params: z.strictObject({ id: idParametro }),
};

module.exports = { login, selecionarEmpresa };
