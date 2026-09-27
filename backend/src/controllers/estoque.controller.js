'use strict';

const estoqueService = require('../services/estoque.service');
const { dataOperacional } = require('../utils/data-operacional');
const { pool } = require('../config/database');

/**
 * Controller de estoque por lote (Bloco 9).
 *
 * Mesmo padrão de material.controller.js. Empresa e ator vêm sempre da
 * sessão; a data operacional, do relógio do servidor em São Paulo. A
 * autorização (recurso nas leituras, MOVIMENTAR_ESTOQUE na entrada e na
 * baixa) é decidida pela rota, nunca aqui.
 */

function criarEstoqueController({ pool: poolInjetado, relogio = () => new Date() }) {
  return {
    async lotes(req, res) {
      const resultado = await estoqueService.listarLotes(poolInjetado, {
        empresaId: req.empresa.id,
        materialId: req.validado.params.id,
        hoje: dataOperacional(relogio()),
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    // E7: a data operacional vem do relógio do servidor em São Paulo, nunca do cliente.
    async validade(req, res) {
      const {
        situacao, busca, pagina, limite,
      } = req.validado.query;
      const resultado = await estoqueService.listarValidade(poolInjetado, {
        empresaId: req.empresa.id,
        situacao: situacao ?? null,
        busca: busca ?? null,
        pagina,
        limite,
        hoje: dataOperacional(relogio()),
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    // E8: a empresa vem da sessão; a ordem e o fuso são do servidor.
    async operacoes(req, res) {
      const {
        tipo, de, ate, busca, pagina, limite,
      } = req.validado.query;
      const resultado = await estoqueService.listarOperacoes(poolInjetado, {
        empresaId: req.empresa.id,
        tipo: tipo ?? null,
        de: de ?? null,
        ate: ate ?? null,
        busca: busca ?? null,
        pagina,
        limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    // 201 quando a operação nasce; 200 quando a mesma chave repete a mesma requisição.
    async entrada(req, res) {
      const {
        tamanho, quantidade, caNumero, caValidade, chaveIdempotencia,
      } = req.validado.body;
      const resultado = await estoqueService.registrarEntrada(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        materialId: req.validado.params.id,
        tamanho: tamanho ?? null,
        quantidade,
        caNumero,
        caValidade,
        chaveIdempotencia,
        hoje: dataOperacional(relogio()),
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });
      res.status(resultado.repetida ? 200 : 201).json({ status: 'ok', ...resultado });
    },

    async baixa(req, res) {
      const {
        quantidade, motivo, justificativa, chaveIdempotencia,
      } = req.validado.body;
      const resultado = await estoqueService.registrarBaixa(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        loteId: req.validado.params.loteId,
        quantidade,
        motivo,
        justificativa: justificativa ?? null,
        chaveIdempotencia,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });
      res.status(resultado.repetida ? 200 : 201).json({ status: 'ok', ...resultado });
    },
  };
}

const estoqueController = criarEstoqueController({ pool });

module.exports = { criarEstoqueController, estoqueController };
