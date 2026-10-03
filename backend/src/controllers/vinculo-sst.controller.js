'use strict';

const vinculoSst = require('../services/vinculo-sst.service');

/**
 * Vínculos SST pela camada HTTP: listagem (12F-1), concessão e remoção (12F-2).
 * Empresa e ator só da sessão; quem pode listar, conceder e remover (o MASTER
 * ativo da própria empresa) é decidido pelo serviço.
 */
function criarVinculoSstController({ pool: poolInjetado }) {
  const sessao = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id });
  const origem = (req) => ({ ip: req.ip, dispositivo: req.headers['user-agent'] });

  return {
    async listar(req, res) {
      const { pagina, limite } = req.validado.query;
      const resultado = await vinculoSst.listarVinculos(poolInjetado, { ...sessao(req), pagina, limite });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async conceder(req, res) {
      const { usuarioId, motivo } = req.validado.body;
      const vinculo = await vinculoSst.concederVinculo(poolInjetado, {
        ...sessao(req), usuarioId, motivo: motivo ?? null, ...origem(req),
      });
      res.status(201).json({ status: 'ok', vinculo });
    },

    async remover(req, res) {
      const resultado = await vinculoSst.removerVinculo(poolInjetado, { ...sessao(req), usuarioId: req.validado.params.usuarioId, ...origem(req) });
      res.status(200).json({ status: 'ok', ...resultado });
    },
  };
}

module.exports = { criarVinculoSstController };
