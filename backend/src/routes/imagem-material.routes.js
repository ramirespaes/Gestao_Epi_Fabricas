'use strict';

const { Router, raw } = require('express');
const { validar } = require('../middleware/validar');
const { criarLimitador } = require('../middleware/rate-limit');
const schemas = require('../schemas/imagem-material.schema');
const schemasEntrega = require('../schemas/imagem-material-entrega.schema');
const { imagemMaterialController } = require('../controllers/imagem-material.controller');
const { exigirSessao } = require('../middleware/autenticacao');
const { criarExigirPermissaoRecurso } = require('../middleware/autorizacao');
const { lerConfiguracao } = require('../config/imagens');
const { pool } = require('../config/database');

/**
 * Biblioteca de imagens de produto (Biblioteca de Imagens, Unidades 4, 5A-1 e 5C-2), dentro de Materiais / Gestão de Estoque. Reusa o recurso RBAC
 * `materials` (matriz do doc. 03, alternativa A; sem recurso, ação ou toggle novos): consultar = visualizar; enviar uma imagem nova = criar;
 * renomear, inativar, reativar e excluir a imagem privada da empresa = editar. A associação da imagem ao material é parte de POST/PATCH
 * /materiais (criar/editar).
 *
 * Ordem dos middlewares (a de material.routes.js): exigirSessao (identidade) -> exigirPermissao (autorização, ANTES de qualquer detalhe, inclusive
 * de validação) -> validar (formato) -> controller. CORS, verificação de origem (CSRF: toda escrita exige Origin da allowlist), JSON e rate limit
 * já se aplicam a todo /api em app.js, antes destas rotas.
 *
 * ENVIO (POST /imagens-material/empresa): sessão -> `materials.criar` -> limite por usuário -> limite por empresa -> leitura do corpo binário (até
 * 2 MiB; mais que isso é 413 PAYLOAD_MUITO_GRANDE pelo errorHandler) -> consulta -> controller. O corpo só é lido depois de autenticar, autorizar e
 * contar o pedido nos limites, e `materials.criar` NÃO substitui o isolamento: empresa e ator vêm só da sessão. Os dois contadores (por usuário e
 * empresa da sessão, por minuto; por empresa, por hora) ficam na memória do processo: com várias instâncias o limite efetivo se multiplica. A política
 * de conteúdo do /api só deixa passar `image/*` nesse caminho exato (middleware/conteudo.js).
 *
 *   GET    /api/imagens-material                        (visualizar) biblioteca padrão SafeWork + privada da empresa, com busca e filtros
 *   GET    /api/imagens-material/:origem/:id/:variante  (visualizar) arquivo WebP já verificado (origem padrao|empresa; variante
 *                                                                    miniatura|exibicao; ?v=<versao> opcional); GET e HEAD; nunca o mestre
 *   POST   /api/imagens-material/empresa?nome=          (criar)      corpo BINÁRIO image/png|jpeg|webp (até 2 MiB) -> 201 { imagem, reaproveitada:false }
 *                                                                    ou 200 reaproveitada:true (mesmo conteúdo já na empresa); 503 sem processador
 *   PATCH /api/imagens-material/empresa/:id            (editar)     { nome }
 *   POST   /api/imagens-material/empresa/:id/inativar   (editar)     {}   (409 IMAGEM_EM_USO se algum material a usa)
 *   POST   /api/imagens-material/empresa/:id/reativar   (editar)     {}
 *   DELETE /api/imagens-material/empresa/:id            (editar)     { confirmacao: true }  (convenção de DELETE com corpo validado, como em
 *                                                                    /autorizacoes-individuais/:id; 409 IMAGEM_EM_USO se algum material a usa)
 *
 * SOMENTE LEITURA PARA A BIBLIOTECA PADRÃO: não existe rota de escrita sob um caminho de imagem padrão. NÃO existe rota de registro por descritor:
 * o cliente nunca fornece o descritor da imagem (hashes, medidas, bytes); o registro sai do upload binário processado no servidor. A entrega só
 * LÊ, pelo serviço de entrega; nenhuma rota apaga arquivo.
 */

const RECURSO = 'materials';

// Identidade dos contadores do envio: sempre da SESSÃO (empresa e usuário), nunca do IP nem de algo enviado pelo cliente.
const chaveDoUsuario = (req) => `${req.empresa?.id}:${req.usuario?.id}`;
const chaveDaEmpresa = (req) => `${req.empresa?.id}`;

function criarImagemMaterialRoutes({ controller, exigirSessao: exigirSessaoInjetado, pool: poolInjetado }) {
  const router = Router();

  const exigirVisualizar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'visualizar');
  const exigirCriar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'criar');
  const exigirEditar = criarExigirPermissaoRecurso({ pool: poolInjetado }, RECURSO, 'editar');

  // Envio: contadores próprios desta rota (criados aqui, então cada fábrica tem os seus) e parser binário de 2 MiB, sem descompressão.
  const configuracao = lerConfiguracao(process.env);
  const limitarEnvioPorUsuario = criarLimitador({ limite: configuracao.envioPorMinutoUsuario, janelaSegundos: 60, chave: chaveDoUsuario });
  const limitarEnvioPorEmpresa = criarLimitador({ limite: configuracao.envioPorHoraEmpresa, janelaSegundos: 3600, chave: chaveDaEmpresa });
  const lerImagemBinaria = raw({ type: 'image/*', limit: configuracao.arquivoMaxBytes, inflate: false });

  router.get(
    '/imagens-material',
    exigirSessaoInjetado, exigirVisualizar,
    validar({ query: schemas.listar.query }),
    controller.listar,
  );
  router.get(
    '/imagens-material/:origem/:id/:variante',
    exigirSessaoInjetado, exigirVisualizar,
    validar({ params: schemasEntrega.entregar.params, query: schemasEntrega.entregar.query }),
    controller.entregar,
  );
  router.post(
    '/imagens-material/empresa',
    exigirSessaoInjetado, exigirCriar, limitarEnvioPorUsuario, limitarEnvioPorEmpresa,
    lerImagemBinaria,
    validar({ query: schemas.enviar.query }),
    controller.enviar,
  );
  router.patch(
    '/imagens-material/empresa/:id',
    exigirSessaoInjetado, exigirEditar,
    validar({ params: schemas.renomear.params, body: schemas.renomear.body }),
    controller.renomear,
  );
  router.post(
    '/imagens-material/empresa/:id/inativar',
    exigirSessaoInjetado, exigirEditar,
    validar({ params: schemas.inativar.params, body: schemas.inativar.body }),
    controller.inativar,
  );
  router.post(
    '/imagens-material/empresa/:id/reativar',
    exigirSessaoInjetado, exigirEditar,
    validar({ params: schemas.reativar.params, body: schemas.reativar.body }),
    controller.reativar,
  );
  router.delete(
    '/imagens-material/empresa/:id',
    exigirSessaoInjetado, exigirEditar,
    validar({ params: schemas.excluir.params, body: schemas.excluir.body }),
    controller.excluir,
  );

  return router;
}

const imagemMaterialRoutes = criarImagemMaterialRoutes({ controller: imagemMaterialController, exigirSessao, pool });

module.exports = { criarImagemMaterialRoutes, imagemMaterialRoutes, RECURSO };
