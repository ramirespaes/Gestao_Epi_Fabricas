'use strict';

const tokenCentralService = require('../services/token-central.service');
const tokenRedeAdminService = require('../services/token-rede-admin.service');
const { pool } = require('../config/database');

/**
 * Central Administrativa do Atendimento Token (Etapa H). Empresa e ator SÓ de req.empresa/req.usuario (sessão administrativa), nunca do
 * corpo, da query ou de cookie do tablet. Respostas mínimas; nada de credencial, hash ou código de ativação.
 */
function criarTokenCentralController({ pool: poolInjetado }) {
  const contexto = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] });
  return {
    async visaoGeral(req, res) {
      const visaoGeral = await tokenCentralService.visaoGeral(poolInjetado, { empresaId: req.empresa.id });
      res.status(200).json({ status: 'ok', visaoGeral });
    },
    async estadoAtivacao(req, res) {
      const ativacao = await tokenCentralService.estadoAtivacao(poolInjetado, { empresaId: req.empresa.id, dispositivoId: req.validado.params.id });
      res.status(200).json({ status: 'ok', ativacao });
    },
    async previaCatalogo(req, res) {
      const previa = await tokenCentralService.previaCatalogo(poolInjetado, { ...contexto(req), funcionarioId: req.validado.query.funcionarioId });
      res.status(200).json({ status: 'ok', previa });
    },
    async listarRedes(req, res) {
      const { pagina, limite } = req.validado.query;
      const resultado = await tokenRedeAdminService.listar(poolInjetado, { empresaId: req.empresa.id, pagina, limite });
      res.status(200).json({ status: 'ok', ...resultado });
    },
    async cadastrarRede(req, res) {
      const rede = await tokenRedeAdminService.cadastrar(poolInjetado, { ...contexto(req), dados: req.validado.body });
      res.status(201).json({ status: 'ok', rede });
    },
    async desativarRede(req, res) {
      const { rede, alterado } = await tokenRedeAdminService.desativar(poolInjetado, { ...contexto(req), id: req.validado.params.id });
      res.status(200).json({ status: 'ok', rede, alterado });
    },
  };
}

const tokenCentralController = criarTokenCentralController({ pool });

module.exports = { criarTokenCentralController, tokenCentralController };
