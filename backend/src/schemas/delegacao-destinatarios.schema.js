'use strict';

const { z } = require('zod');
const { textoCurto } = require('./campos.schema');

/**
 * Schema da consulta de destinatários para delegação (Subetapa 3V —
 * complemento). Só estrutura: não conhece empresa, ator nem autoridade
 * — quem pode consultar é delegacao-destinatarios.service.js.
 *
 * `strictObject` recusa com 400 qualquer parâmetro não declarado. É
 * assim que `empresaId`, `atorId`, `usuarioId`, `perfil`, `isMaster`,
 * `ativo` e `limite` ficam fora do alcance da rota: não por serem
 * ignorados, mas por a requisição ser recusada. O limite é fixo no
 * serviço, de propósito — a lista serve para reconhecer uma pessoa, não
 * para exportar a empresa.
 *
 * Só `busca`, opcional, até 100 caracteres.
 */

const BUSCA_MAXIMA = 100;

const listar = {
  query: z.strictObject({
    busca: textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Texto de busca inválido').optional(),
  }),
};

module.exports = { listar };
