'use strict';

const empresaCadastroService = require('../services/empresa-cadastro.service');
const { CAMPOS_OPCIONAIS } = require('../schemas/empresa-cadastro.schema');
const { pool } = require('../config/database');

/**
 * Controller do cadastro de empresas no Painel Privado (Pacote 3). Mesmo
 * desenho de funcionario.controller.js.
 *
 * AUTORIDADE: `administradorId` vem EXCLUSIVAMENTE de
 * req.administradorPlataforma (exigirSessaoPlataforma) — nunca do corpo.
 * Um `administradorId`/`atorId` no corpo já é 400 pelo strictObject.
 */

const comContexto = (req) => ({ administradorId: req.administradorPlataforma.id, ip: req.ip, dispositivo: req.headers['user-agent'] });
const informado = (corpo, campo) => (Object.hasOwn(corpo, campo) ? { [campo]: corpo[campo], [`${campo}Informado`]: true } : {});

function criarEmpresaCadastroController({ pool: poolInjetado }) {
  return {
    async criar(req, res) {
      const c = req.validado.body;
      const opcionais = {};
      for (const campo of CAMPOS_OPCIONAIS) {
        opcionais[campo] = c[campo] ?? null;
      }
      const resultado = await empresaCadastroService.criar(poolInjetado, {
        ...comContexto(req), razaoSocial: c.razaoSocial, cnpj: c.cnpj, ...opcionais,
      });
      res.status(201).json({ status: 'ok', ...resultado });
    },

    async listar(req, res) {
      const { ativo, busca, pagina, limite } = req.validado.query;
      const resultado = await empresaCadastroService.listar(poolInjetado, { ativo: ativo ?? null, busca: busca ?? null, pagina, limite });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async buscar(req, res) {
      const empresa = await empresaCadastroService.buscar(poolInjetado, { empresaId: req.validado.params.id });
      res.status(200).json({ status: 'ok', empresa });
    },

    async provisionamento(req, res) {
      const resultado = await empresaCadastroService.consultarProvisionamento(poolInjetado, { empresaId: req.validado.params.id });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async alterar(req, res) {
      const c = req.validado.body;
      let dados = { ...comContexto(req), empresaId: req.validado.params.id };
      if (Object.hasOwn(c, 'razaoSocial')) {
        dados.razaoSocial = c.razaoSocial;
      }
      for (const campo of CAMPOS_OPCIONAIS) {
        dados = { ...dados, ...informado(c, campo) };
      }
      const empresa = await empresaCadastroService.alterar(poolInjetado, dados);
      res.status(200).json({ status: 'ok', empresa });
    },

    async inativar(req, res) {
      const { empresa, alterado } = await empresaCadastroService.inativar(poolInjetado, { ...comContexto(req), empresaId: req.validado.params.id });
      res.status(200).json({ status: 'ok', empresa, alterado });
    },

    async reativar(req, res) {
      const { empresa, alterado } = await empresaCadastroService.reativar(poolInjetado, { ...comContexto(req), empresaId: req.validado.params.id });
      res.status(200).json({ status: 'ok', empresa, alterado });
    },
  };
}

const empresaCadastroController = criarEmpresaCadastroController({ pool });

module.exports = { criarEmpresaCadastroController, empresaCadastroController };
