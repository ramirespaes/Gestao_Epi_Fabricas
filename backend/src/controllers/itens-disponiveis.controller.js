'use strict';

const estoqueService = require('../services/estoque.service');
const { dataOperacional } = require('../utils/data-operacional');

/**
 * Itens disponíveis (Bloco 9, Etapa C, Parte C3). Empresa exclusivamente
 * da sessão (req.empresa.id, populado por exigirSessao); a query já chega
 * validada e estrita. O relógio é injetável para os testes controlarem a
 * data operacional.
 */
function criarItensDisponiveisController({ pool: poolInjetado, relogio = () => new Date() }) {
  return {
    async listar(req, res) {
      const {
        categoria, tipo, tamanho, validade, busca, situacao, somenteComNecessidade, pagina, limite,
      } = req.validado.query;
      const resultado = await estoqueService.listarDisponiveis(poolInjetado, {
        empresaId: req.empresa.id,
        hoje: dataOperacional(relogio()),
        categoria: categoria ?? null,
        tipo: tipo ?? null,
        tamanho: tamanho ?? null,
        validade: validade ?? null,
        busca: busca ?? null,
        situacao: situacao ?? null,
        somenteComNecessidade: somenteComNecessidade ?? false,
        pagina,
        limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },
  };
}

module.exports = { criarItensDisponiveisController };
