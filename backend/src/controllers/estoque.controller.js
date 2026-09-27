'use strict';

const estoqueService = require('../services/estoque.service');
const { dataOperacional } = require('../utils/data-operacional');
const { pool } = require('../config/database');

/**
 * Controller de estoque por tamanho (Bloco 9, Etapa A).
 *
 * Mesmo padrão de material.controller.js. `consultar` é protegida pela
 * mesma permissão de RECURSO (`'materials'`, visualizar) do cadastro de
 * materiais; `movimentar` é protegida por permissão de AÇÃO
 * (`MOVIMENTAR_ESTOQUE`) — dimensão separada, decidida pela rota, nunca
 * aqui.
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

    async consultar(req, res) {
      const resultado = await estoqueService.consultar(poolInjetado, {
        empresaId: req.empresa.id,
        materialId: req.validado.params.id,
      });

      res.status(200).json({ status: 'ok', material: resultado.material, saldos: resultado.saldos });
    },

    async movimentar(req, res) {
      const { tamanho, tipo, quantidade, motivo } = req.validado.body;

      const saldo = await estoqueService.movimentar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        materialId: req.validado.params.id,
        tamanho,
        tipo,
        quantidade,
        motivo: motivo ?? null,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', saldo });
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
