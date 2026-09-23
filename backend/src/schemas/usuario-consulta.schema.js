'use strict';

const { z } = require('zod');
const { textoCurto, paginacaoQuery } = require('./campos.schema');

/**
 * Schema da consulta de usuários (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3U). Só estrutura e formato: não consulta banco, não conhece
 * empresa nem autoridade, e não decide nada — quem pode consultar é
 * usuario-consulta.service.js.
 *
 * `strictObject` recusa qualquer parâmetro não declarado com 400 antes
 * do controller. É assim que `empresaId`, `atorId`, `perfil` e
 * `isMaster` ficam fora do alcance desta rota: não por serem ignorados
 * em silêncio, mas por a requisição inteira ser recusada. Empresa e ator
 * vêm da sessão, sempre.
 *
 * `busca` aceita até 100 caracteres — teto de entrada da API, não regra
 * do domínio. O tratamento dos curingas de LIKE é do repositório.
 *
 * `vinculo` é enum fechado: qualquer outro valor é 400, e não um filtro
 * silenciosamente ignorado.
 *
 * `pagina` e `limite` reaproveitam paginacaoQuery (limite máximo 100,
 * padrão 20), a convenção já existente no projeto — em vez de inventar
 * um esquema de paginação só para esta rota.
 */

const BUSCA_MAXIMA = 100;

const listar = {
  query: z.strictObject({
    busca: textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Texto de busca inválido').optional(),
    // Ausente lista todos; os dois outros valores filtram explicitamente.
    vinculo: z.enum(['todos', 'sem_grupo', 'com_grupo']).optional(),
    pagina: paginacaoQuery.pagina,
    limite: paginacaoQuery.limite,
  }),
};

module.exports = { listar };
