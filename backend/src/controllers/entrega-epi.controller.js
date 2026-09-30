'use strict';

const entregaService = require('../services/entrega-epi.service');
const consultaService = require('../services/entrega-epi-consulta.service');
const { entregaPublica } = require('../services/entrega-epi-publica');
const { dataOperacional } = require('../utils/data-operacional');
const { pool } = require('../config/database');

/**
 * Controller da entrega de EPI (10E) e da ficha (10F). Mesmo desenho de
 * estoque.controller.js: empresa e ator vêm sempre da sessão, a data
 * operacional do relógio do servidor em São Paulo, e a autorização é
 * decidida pela rota. Nenhuma regra transacional vive aqui.
 */

function criarEntregaEpiController({ pool: poolInjetado, relogio = () => new Date() }) {
  return {
    // 201 quando a entrega nasce; 200 quando a mesma chave repete a mesma requisição.
    async registrar(req, res) {
      const { funcionarioId, itens, confirmacao, chaveIdempotencia } = req.validado.body;
      const resultado = await entregaService.registrarEntrega(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        funcionarioId,
        itens,
        confirmacao,
        chaveIdempotencia,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });
      res.status(resultado.repetida ? 200 : 201).json({ status: 'ok', repetida: resultado.repetida, entrega: entregaPublica(resultado) });
    },

    async contextoFuncionarios(req, res) {
      const { busca, pagina, limite } = req.validado.query;
      const resultado = await consultaService.localizarTrabalhadores(poolInjetado, {
        empresaId: req.empresa.id, busca: busca ?? null, pagina, limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    // CPF só no corpo, nunca na URL; a resposta sai mascarada.
    async contextoConsultaCpf(req, res) {
      const resultado = await consultaService.localizarTrabalhadorPorCpf(poolInjetado, {
        empresaId: req.empresa.id, cpf: req.validado.body.cpf,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async contexto(req, res) {
      const resultado = await consultaService.contextoDoTrabalhador(poolInjetado, {
        empresaId: req.empresa.id, funcionarioId: req.validado.params.funcionarioId,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async contextoMateriais(req, res) {
      const { busca, previstoNoGhe, pagina, limite } = req.validado.query;
      const resultado = await consultaService.listarMateriaisDoContexto(poolInjetado, {
        empresaId: req.empresa.id,
        funcionarioId: req.validado.params.funcionarioId,
        busca: busca ?? null,
        previstoNoGhe: previstoNoGhe ?? null,
        pagina,
        limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async contextoLotes(req, res) {
      const resultado = await consultaService.listarLotesDoContexto(poolInjetado, {
        empresaId: req.empresa.id,
        funcionarioId: req.validado.params.funcionarioId,
        materialId: req.validado.params.materialId,
        hoje: dataOperacional(relogio()),
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async listarFichas(req, res) {
      const {
        busca, numero, funcionarioId, materialId, ativo, de, ate, pagina, limite,
      } = req.validado.query;
      const resultado = await consultaService.listarFichas(poolInjetado, {
        empresaId: req.empresa.id,
        busca: busca ?? null,
        numero: numero ?? null,
        funcionarioId: funcionarioId ?? null,
        materialId: materialId ?? null,
        ativo: ativo ?? null,
        de: de ?? null,
        ate: ate ?? null,
        pagina,
        limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    // CPF só no corpo, nunca na URL; a resposta sai mascarada.
    async consultarCpf(req, res) {
      const resultado = await consultaService.consultarFichaPorCpf(poolInjetado, {
        empresaId: req.empresa.id, cpf: req.validado.body.cpf,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async detalharFicha(req, res) {
      const resultado = await consultaService.detalharFicha(poolInjetado, {
        empresaId: req.empresa.id, fichaId: req.validado.params.id,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async entregasDaFicha(req, res) {
      const { de, ate, pagina, limite } = req.validado.query;
      const resultado = await consultaService.listarEntregasDaFicha(poolInjetado, {
        empresaId: req.empresa.id, fichaId: req.validado.params.id, de: de ?? null, ate: ate ?? null, pagina, limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async buscarEntrega(req, res) {
      const resultado = await consultaService.buscarEntrega(poolInjetado, {
        empresaId: req.empresa.id, entregaId: req.validado.params.id,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },
  };
}

const entregaEpiController = criarEntregaEpiController({ pool });

module.exports = { criarEntregaEpiController, entregaEpiController };
