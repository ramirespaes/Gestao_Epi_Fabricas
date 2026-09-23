'use strict';

const { Router } = require('express');
const { validar } = require('../middleware/validar');
const usuarioConsultaSchemas = require('../schemas/usuario-consulta.schema');
const { usuarioConsultaController } = require('../controllers/usuario-consulta.controller');
const { exigirSessao } = require('../middleware/autenticacao');

/**
 * Rota de consulta de usuários (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3U).
 *
 * Mesma fábrica das demais rotas do bloco. Uma única rota, de leitura,
 * atrás de exigirSessao, com `validar` na query.
 *
 * A AUTORIDADE ADMINISTRATIVA NÃO MORA AQUI, como em todo o bloco:
 * usuario-consulta.service.js exige ADMINISTRAR_VINCULOS_GRUPO pelo
 * ponto único da 3Q, relendo perfil e autorizações do banco a cada
 * chamada. A rota garante autenticação; o serviço garante autorização.
 *
 * POR QUE ESTA ROTA EXISTE: a tela de vínculos (3U) precisa apresentar
 * quem pode entrar num grupo. `GET /grupos-acesso/:id/usuarios` (3O)
 * devolve só os já vinculados àquele grupo — quem não tem grupo nenhum
 * não aparecia em lugar algum. Sem esta rota, a única forma de vincular
 * seria digitar o identificador numérico do usuário.
 *
 * Caminho final, quando montado por app.js sob /api:
 *   GET /api/usuarios
 *
 * SOMENTE LEITURA: não existe aqui rota para criar, alterar, inativar ou
 * excluir usuário — administração de usuários é assunto de outro
 * incremento. A única escrita relacionada a usuários no bloco continua
 * sendo a do vínculo, em grupo-usuario.routes.js (3O), que altera
 * exclusivamente `usuarios.grupo_acesso_id`.
 *
 * Convive com `DELETE /api/usuarios/:usuarioId/grupo-acesso` (3O) sem
 * conflito: caminhos distintos, routers distintos, mesma cadeia /api.
 */

function criarUsuarioConsultaRoutes({ controller, exigirSessao: exigirSessaoInjetado }) {
  const router = Router();

  router.get(
    '/usuarios',
    exigirSessaoInjetado,
    validar({ query: usuarioConsultaSchemas.listar.query }),
    controller.listar,
  );

  return router;
}

const usuarioConsultaRoutes = criarUsuarioConsultaRoutes({
  controller: usuarioConsultaController,
  exigirSessao,
});

module.exports = { criarUsuarioConsultaRoutes, usuarioConsultaRoutes };
