'use strict';

const { z } = require('zod');
const { inteiroQuery, LIMITES } = require('./campos.schema');

/**
 * Schema da consulta de autorizações individuais (Bloco 8, Incremento 8,
 * Etapa 5A, Subetapa 3V). Só estrutura e formato: não consulta banco,
 * não conhece empresa nem autoridade, e não decide nada — quem pode ver
 * o quê é de autorizacao-consulta.service.js.
 *
 * `strictObject` recusa com 400 qualquer parâmetro não declarado. É
 * assim que `empresaId`, `atorId`, `perfil`, `isMaster` e
 * `autorizadoPor` ficam fora do alcance desta rota: não por serem
 * ignorados em silêncio, mas por a requisição inteira ser recusada.
 * Empresa e ator vêm sempre da sessão.
 *
 * `usuarioId` é OBRIGATÓRIO, de propósito: uma consulta sem alvo teria
 * de significar "todas as autorizações da empresa", e essa não é a
 * pergunta que a tela faz — ela sempre olha uma pessoa por vez. Exigir
 * o alvo evita criar, de carona, uma listagem geral que ninguém pediu.
 *
 * Usa `inteiroQuery` porque o identificador chega na QUERY STRING (é
 * texto), não no corpo nem na URL — mesmo teto de int4 dos demais.
 */

const listar = {
  query: z.strictObject({
    usuarioId: inteiroQuery(1, LIMITES.ID_MAXIMO),
  }),
};

module.exports = { listar };
