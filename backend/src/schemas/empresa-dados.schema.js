'use strict';

const { z } = require('zod');
const { idCorpo, email } = require('./campos.schema');
const { opcionais } = require('./empresa-cadastro.schema');

/**
 * Schemas das rotas "Dados da Empresa" do Portal (GET/PATCH /api/empresa/dados). Só formato: coerência da inscrição estadual,
 * versão e existência são do serviço.
 *
 * RAZÃO SOCIAL E CNPJ NÃO SÃO EDITÁVEIS AQUI: as chaves não são declaradas, então o strictObject devolve 400 CAMPO_NAO_PERMITIDO
 * para qualquer presença delas (assim como `ativo`, `empresaId`, `usuarioId` ou qualquer outra). Empresa e ator vêm só da sessão.
 *
 * O PATCH envia só o que mudou, mais a `versao` carregada (obrigatória: sem ela não há comparação-e-troca). `null` limpa o campo.
 */

const editaveis = {
  ...opcionais,
  emailSst: email.nullable().optional(),
  emailAlmoxarifado: email.nullable().optional(),
};

const CAMPOS_EDITAVEIS = Object.freeze(Object.keys(editaveis));

const consultar = {};

const alterar = {
  body: z.strictObject({ versao: idCorpo, ...editaveis }),
};

module.exports = { consultar, alterar, CAMPOS_EDITAVEIS };
