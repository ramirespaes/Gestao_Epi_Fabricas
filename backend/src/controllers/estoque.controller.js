'use strict';

const estoqueService = require('../services/estoque.service');
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

function criarEstoqueController({ pool: poolInjetado }) {
  return {
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
  };
}

const estoqueController = criarEstoqueController({ pool });

module.exports = { criarEstoqueController, estoqueController };
