'use strict';

const estoqueService = require('../services/estoque.service');

/**
 * Itens disponíveis (Bloco 9, Etapa C, Parte C3). Empresa exclusivamente
 * da sessão (req.empresa.id, populado por exigirSessao); a query já chega
 * validada e estrita.
 */
function criarItensDisponiveisController({ pool: poolInjetado }) {
  return {
    async listar(req, res) {
      const { categoria, tipo, tamanho, validade, pagina, limite } = req.validado.query;
      const resultado = await estoqueService.listarDisponiveis(poolInjetado, {
        empresaId: req.empresa.id,
        categoria: categoria ?? null,
        tipo: tipo ?? null,
        tamanho: tamanho ?? null,
        validade: validade ?? null,
        pagina,
        limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },
  };
}

module.exports = { criarItensDisponiveisController };
