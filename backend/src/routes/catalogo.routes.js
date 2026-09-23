'use strict';

const { Router } = require('express');
const { catalogoController } = require('../controllers/catalogo.controller');
const { exigirSessao } = require('../middleware/autenticacao');

/**
 * Rota do catálogo de ações (Bloco 8, Incremento 8, Etapa 5A, Subetapa
 * 3T).
 *
 * Mesma fábrica das demais rotas do bloco. Uma única rota, de leitura,
 * atrás de exigirSessao. Não leva `validar`: não há corpo, params nem
 * query — nada que o cliente informe influencia a resposta, então não há
 * o que validar.
 *
 * A autoridade administrativa NÃO mora aqui, como em todo o bloco:
 * catalogo.service.js exige ADMINISTRAR_PERMISSOES_GRUPO pelo ponto
 * único da 3Q, relendo perfil e autorizações do banco a cada chamada.
 *
 * POR QUE ESTA ROTA EXISTE: a tela de permissões (3T) precisa saber
 * quais ações podem ser configuradas e em que modo cada uma está — sem
 * ela, o frontend manteria uma cópia manual do catálogo, que a primeira
 * migration nova invalidaria. Expor o catálogo real foi a alternativa
 * aprovada ao "criar uma lista artificial".
 *
 * Caminho final, quando montado por app.js sob /api:
 *   GET /api/catalogo/acoes
 *
 * Somente leitura: não existe rota para criar, alterar ou desativar uma
 * ação. O catálogo continua sendo mantido exclusivamente por migration.
 */

function criarCatalogoRoutes({ controller, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();

  router.get('/catalogo/acoes', exigirSessaoInjetado, controller.listarAcoes);

  return router;
}

const catalogoRoutes = criarCatalogoRoutes({ controller: catalogoController, exigirSessao });

module.exports = { criarCatalogoRoutes, catalogoRoutes };
