'use strict';

const empresaDadosService = require('../services/empresa-dados.service');
const { CAMPOS_EDITAVEIS } = require('../schemas/empresa-dados.schema');
const { pool } = require('../config/database');

/**
 * Controller de "Dados da Empresa" (Portal). Empresa e ator SÓ de req.empresa/req.usuario (sessão): o corpo não tem como trazer
 * empresa, usuário, razão social ou CNPJ (o schema estrito os recusa antes de chegar aqui).
 */
function criarEmpresaDadosController({ pool: poolInjetado }) {
  return {
    async consultar(req, res) {
      const dados = await empresaDadosService.consultar(poolInjetado, { empresaId: req.empresa.id });
      res.status(200).json({ status: 'ok', dados });
    },

    async alterar(req, res) {
      const corpo = req.validado.body;
      const campos = {};
      for (const campo of CAMPOS_EDITAVEIS) {
        if (Object.hasOwn(corpo, campo)) {
          campos[campo] = corpo[campo];
        }
      }
      const { dados, alterado, camposAlterados } = await empresaDadosService.alterar(poolInjetado, {
        empresaId: req.empresa.id,
        usuarioId: req.usuario.id,
        versaoEsperada: corpo.versao,
        campos,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });
      res.status(200).json({ status: 'ok', dados, alterado, camposAlterados });
    },
  };
}

const empresaDadosController = criarEmpresaDadosController({ pool });

module.exports = { criarEmpresaDadosController, empresaDadosController };
