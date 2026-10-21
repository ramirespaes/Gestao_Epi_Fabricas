'use strict';

const servico = require('../services/token-imagem.service');
const { criarEntregaDeImagens } = require('../services/imagem-material-entrega.service');
const { criarEntregaDoAmbiente } = require('../services/imagem-material-entrega.ambiente');
const { lerConfiguracao } = require('../config/imagens');
const { tokenDoAtendimento } = require('./token-atendimento.controller');
const { pool: poolPadrao } = require('../config/database');

/**
 * Atendimento Token — entrega da imagem do material ao tablet. Empresa e tablet vêm só de req.dispositivo; o atendimento, só do cookie próprio
 * (ausente ou duplicado = ausente); origem, id, variante e versão, só de req.validado. A autorização é do serviço.
 *
 * Política HTTP PRÓPRIA (a do controller administrativo não serve: ela permite cache e ETag, e o 304 sobreviveria ao fim do atendimento):
 * `Cache-Control: private, no-store`, `Vary: Cookie` (somado ao que já existe) e NENHUM ETag. O corpo sai por `res.end`, nunca por
 * `res.send`, que recriaria o ETag e poderia responder 304. HEAD tem os mesmos cabeçalhos do GET, sem corpo.
 *
 * Dependências injetáveis: `armazenamento` (instância ou null; ausente = ambiente), `entrega` (o serviço de entrega), `autorizar` e `corp`.
 */

function resolverEntrega({ armazenamento, entrega }) {
  if (entrega !== undefined) return entrega;
  if (armazenamento !== undefined) return armazenamento === null ? null : criarEntregaDeImagens({ armazenamento });
  return criarEntregaDoAmbiente();
}

function criarTokenImagemController({ pool = poolPadrao, armazenamento, entrega, autorizar, corp } = {}) {
  const entregaResolvida = resolverEntrega({ armazenamento, entrega });
  const politicaCorp = corp ?? lerConfiguracao(process.env).entregaCorp;
  const dependencias = autorizar === undefined ? { entrega: entregaResolvida } : { autorizar, entrega: entregaResolvida };

  return {
    async obter(req, res) {
      const { origem, id, variante } = req.validado.params;
      const imagem = await servico.obter(pool, {
        empresaId: req.dispositivo.empresaId,
        dispositivoId: req.dispositivo.id,
        tokenAtendimento: tokenDoAtendimento(req),
        origem,
        id,
        variante,
        versao: req.validado.query.v ?? null,
      }, dependencias);
      res.status(200);
      res.set({
        'Content-Type': imagem.tipo,
        'Content-Length': String(imagem.corpo.length),
        'Cross-Origin-Resource-Policy': politicaCorp,
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(imagem.corpo);
    },
  };
}

module.exports = { criarTokenImagemController };
