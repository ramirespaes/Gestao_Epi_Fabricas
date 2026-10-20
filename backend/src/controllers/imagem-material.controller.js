'use strict';

const imagemMaterialService = require('../services/imagem-material.service');
const { criarEntregaDeImagens } = require('../services/imagem-material-entrega.service');
const { criarEntregaDoAmbiente } = require('../services/imagem-material-entrega.ambiente');
const { criarUploadDeImagens, criarUploadDoAmbiente } = require('../services/imagem-material-upload.service');
const { processadorDoProcesso } = require('../services/imagem-processador.ambiente');
const { lerConfiguracao } = require('../config/imagens');
const { pool } = require('../config/database');

/**
 * Controller da biblioteca de imagens de produto (Biblioteca de Imagens, Unidades 4 e 5A-1).
 *
 * Traduz requisição em chamada de serviço e resultado em resposta HTTP. Não decide nada: autorização já aconteceu no middleware da rota
 * (`criarExigirPermissaoRecurso('materials', operacao)`); isolamento, validação de domínio, travas e auditoria estão em
 * imagem-material.service.js. Sem try/catch: Express 5 encaminha a Promise rejeitada ao errorHandler.
 *
 * FONTE DE AUTORIDADE: `empresaId` e `atorId` saem EXCLUSIVAMENTE de req.empresa.id e req.usuario.id, populados por exigirSessao depois de
 * validar o cookie contra o PostgreSQL. Nada vindo de body, params ou query influencia quem é o ator ou de qual empresa ele é.
 * O serviço é chamado por namespace, nunca desestruturado (permite mock.method nos testes).
 *
 * ENTREGA DE ARQUIVOS (`entregar`, Unidade 5A-1): o serviço de entrega verifica o arquivo (existência, tamanho, SHA-256 e assinatura)
 * ANTES de qualquer resposta, 304 inclusive; o 304 sai do `res.send` do Express com o ETag já verificado. Dependências injetáveis:
 * `entrega` (o serviço; null = indisponível), ou `armazenamento` (instância ou null); sem nenhuma das duas vale o ambiente. `corp` é a
 * política Cross-Origin-Resource-Policy da imagem entregue; sem ela vale a configuração (same-origin por padrão).
 *
 * ENVIO DE IMAGEM (`enviar`, Unidade 5C-2): o corpo é a imagem em binário (Buffer lido pelo parser da rota, depois de sessão, permissão e limites);
 * a consulta traz só o nome (já validado). O serviço de envio decide tudo o mais. Dependências injetáveis: `envio` (o serviço inteiro; null =
 * indisponível), ou `processador` (a porta de processamento de imagens) com `armazenamento` (instância ou null; sem ele vale o ambiente). SEM PROCESSADOR
 * o envio responde 503 IMAGENS_INDISPONIVEL. O controller de produção (o singleton abaixo) recebe o processador REAL só se o ambiente o ligar
 * (imagem-processador.ambiente.js: IMAGENS_PROCESSADOR_REAL=ativo, desligado por padrão); o processador falso dos testes nunca é importado por src/.
 */

const POLITICAS_CORP = Object.freeze(['same-origin', 'same-site']);
const CACHE_VERSIONADO = 'private, max-age=31536000, immutable';
const CACHE_REVALIDAR = 'private, no-cache';

function resolverEntrega({ armazenamento, entrega }) {
  if (entrega !== undefined) return entrega;
  if (armazenamento !== undefined) return armazenamento === null ? null : criarEntregaDeImagens({ armazenamento });
  return criarEntregaDoAmbiente();
}

function resolverCorp(corp) {
  if (corp === undefined) return lerConfiguracao(process.env).entregaCorp;
  if (!POLITICAS_CORP.includes(corp)) throw new TypeError('política CORP da entrega de imagens inválida');
  return corp;
}

function resolverEnvio({ envio, armazenamento, processador }) {
  if (envio === null) return criarUploadDeImagens();
  if (envio !== undefined) return envio;
  if (armazenamento !== undefined) return criarUploadDeImagens({ armazenamento, processador: processador ?? null });
  return criarUploadDoAmbiente({ processador: processador ?? null });
}

function criarImagemMaterialController({
  pool: poolInjetado, armazenamento, entrega, corp, envio, processador,
}) {
  const contexto = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] });
  // Sem serviço, a entrega responde 503 pelo próprio serviço sem armazenamento (um único lugar para o código).
  const servicoDeEntrega = resolverEntrega({ armazenamento, entrega }) ?? criarEntregaDeImagens();
  const servicoDeEnvio = resolverEnvio({ envio, armazenamento, processador });
  const politicaCorp = resolverCorp(corp);

  return {
    async listar(req, res) {
      const { origem, estado, busca, tipoNome, pagina, limite } = req.validado.query;
      const resultado = await imagemMaterialService.listar(poolInjetado, {
        empresaId: req.empresa.id, origem, estado, busca: busca ?? null, tipoNome: tipoNome ?? null, pagina, limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async renomear(req, res) {
      const { imagem, alterado } = await imagemMaterialService.renomear(poolInjetado, { ...contexto(req), imagemId: req.validado.params.id, nome: req.validado.body.nome });
      res.status(200).json({ status: 'ok', imagem, alterado });
    },

    async inativar(req, res) {
      const { imagem, alterado } = await imagemMaterialService.inativar(poolInjetado, { ...contexto(req), imagemId: req.validado.params.id });
      res.status(200).json({ status: 'ok', imagem, alterado });
    },

    async reativar(req, res) {
      const { imagem, alterado } = await imagemMaterialService.reativar(poolInjetado, { ...contexto(req), imagemId: req.validado.params.id });
      res.status(200).json({ status: 'ok', imagem, alterado });
    },

    async excluir(req, res) {
      const { excluida, imagemId } = await imagemMaterialService.excluir(poolInjetado, {
        ...contexto(req), imagemId: req.validado.params.id, confirmacao: req.validado.body.confirmacao,
      });
      res.status(200).json({ status: 'ok', excluida, imagemId });
    },

    async enviar(req, res) {
      // Sem corpo o parser não define req.body: o serviço recusa bytes vazios (415 IMAGEM_FORMATO_NAO_SUPORTADO).
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const { imagem, reaproveitada } = await servicoDeEnvio.enviar(poolInjetado, { ...contexto(req), nome: req.validado.query.nome, bytes });
      res.status(reaproveitada ? 200 : 201).json({ status: 'ok', imagem, reaproveitada });
    },

    async entregar(req, res) {
      const { origem, id, variante } = req.validado.params;
      const imagem = await servicoDeEntrega.obter(poolInjetado, { empresaId: req.empresa.id, origem, id, variante });
      // `Vary: Cookie` ACRESCENTA ao que já existe (Origin do CORS). O cache é privado; só é imutável quando `v` é a versão atual.
      res.vary('Cookie');
      res.set({
        'Cross-Origin-Resource-Policy': politicaCorp,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': req.validado.query.v === imagem.versao ? CACHE_VERSIONADO : CACHE_REVALIDAR,
        ETag: imagem.etag,
      });
      res.type(imagem.tipo).send(imagem.corpo);
    },
  };
}

const imagemMaterialController = criarImagemMaterialController({ pool, processador: processadorDoProcesso() });

module.exports = { criarImagemMaterialController, imagemMaterialController };
