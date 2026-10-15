'use strict';

const monitoramentoService = require('../services/token-monitoramento.service');

/**
 * Heartbeat do tablet (Etapa J, J2a). A empresa e o tablet vêm só de req.dispositivo, que o exigirDispositivo preencheu a partir
 * da credencial; corpo e query são vazios e estritos (schema) e nada do cliente escolhe empresa ou tablet. A resposta é mínima.
 */
function criarTokenHeartbeatController({ pool }) {
  return {
    async heartbeat(req, res) {
      await monitoramentoService.registrarContato(pool, { empresaId: req.dispositivo.empresaId, dispositivoId: req.dispositivo.id });
      res.status(200).json({ status: 'ok' });
    },
  };
}

module.exports = { criarTokenHeartbeatController };
