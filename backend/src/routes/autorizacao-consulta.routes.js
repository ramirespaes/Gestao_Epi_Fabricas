'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const autorizacaoConsultaSchemas = require('../schemas/autorizacao-consulta.schema');
const { autorizacaoConsultaController } = require('../controllers/autorizacao-consulta.controller');
const { exigirSessao } = require('../middleware/autenticacao');

/**
 * Rota de consulta de autorizações individuais (Bloco 8, Incremento 8,
 * Etapa 5A, Subetapa 3V).
 *
 * Mesma fábrica das demais rotas do bloco. Uma única rota, de leitura,
 * atrás de exigirSessao, com `validar` na query.
 *
 * A AUTORIDADE NÃO MORA AQUI, como em todo o bloco:
 * autorizacao-consulta.service.js espelha a regra da 3I — MASTER lê
 * qualquer pessoa da empresa; não-MASTER lê as próprias autorizações e,
 * sobre terceiros, apenas as que ele mesmo concedeu. A rota garante
 * autenticação; o serviço garante autorização.
 *
 * POR QUE ESTA ROTA EXISTE: a Subetapa 3P deixou registrado que não
 * criou consulta porque o serviço da 3I não tinha leitura — e continua
 * não tendo. Sem ela, a tela da 3V não conseguiria listar o que existe
 * para revogar, nem descobrir quais autorizações do próprio ator têm
 * pode_delegar = true. A alternativa seria pedir um `origemId` digitado,
 * exatamente o que a autorização desta subetapa proíbe.
 *
 * Caminho final, quando montado por app.js sob /api:
 *   GET /api/autorizacoes-individuais?usuarioId=<id>
 *
 * Convive com as duas rotas da 3P no mesmo caminho base
 * (POST /api/autorizacoes-individuais e
 * DELETE /api/autorizacoes-individuais/:id) sem conflito: métodos
 * distintos, routers distintos, mesma cadeia /api. As rotas da 3P NÃO
 * foram tocadas.
 *
 * SOMENTE LEITURA: não existe aqui caminho para criar, alterar ou
 * revogar. Conceder e delegar continuam no POST da 3P; revogar, no
 * DELETE da 3P — ambos com as regras da 3I, inalteradas.
 */

function criarAutorizacaoConsultaRoutes({ controller, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();

  router.get(
    '/autorizacoes-individuais',
    exigirSessaoInjetado,
    validar({ query: autorizacaoConsultaSchemas.listar.query }),
    controller.listar,
  );

  return router;
}

const autorizacaoConsultaRoutes = criarAutorizacaoConsultaRoutes({
  controller: autorizacaoConsultaController,
  exigirSessao,
});

module.exports = { criarAutorizacaoConsultaRoutes, autorizacaoConsultaRoutes };
