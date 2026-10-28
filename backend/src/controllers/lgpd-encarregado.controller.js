'use strict';

const servico = require('../services/lgpd-encarregado.service');
const { pool } = require('../config/database');

/** Encarregado (DPO), LGPD-1. Empresa e ator SÓ da sessão (req.empresa/req.usuario); o corpo validado nunca os traz. */
function criarLgpdEncarregadoController({ pool: poolInjetado }) {
  const base = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] });
  return {
    async consultar(req, res) {
      const encarregados = await servico.consultar(poolInjetado, { empresaId: req.empresa.id });
      res.status(200).json({ status: 'ok', encarregados });
    },
    async historico(req, res) {
      const historico = await servico.historico(poolInjetado, { empresaId: req.empresa.id });
      res.status(200).json({ status: 'ok', historico });
    },
    async designar(req, res) {
      const encarregado = await servico.designar(poolInjetado, { ...base(req), dados: req.validado.body });
      res.status(201).json({ status: 'ok', encarregado });
    },
    async substituir(req, res) {
      const { versao, fimAnteriorEm, ...dados } = req.validado.body;
      const encarregado = await servico.substituir(poolInjetado, { ...base(req), id: req.validado.params.id, versao, fimAnteriorEm, dados });
      res.status(201).json({ status: 'ok', encarregado });
    },
    async contato(req, res) {
      const { versao, ...contato } = req.validado.body;
      const encarregado = await servico.corrigirContato(poolInjetado, { ...base(req), id: req.validado.params.id, versao, contato });
      res.status(201).json({ status: 'ok', encarregado });
    },
    async encerrar(req, res) {
      const encarregado = await servico.encerrar(poolInjetado, { ...base(req), id: req.validado.params.id, versao: req.validado.body.versao, fimEm: req.validado.body.fimEm });
      res.status(200).json({ status: 'ok', encarregado });
    },
  };
}

const lgpdEncarregadoController = criarLgpdEncarregadoController({ pool });

module.exports = { criarLgpdEncarregadoController, lgpdEncarregadoController };
