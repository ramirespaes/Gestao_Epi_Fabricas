'use strict';

const gheService = require('../services/grupo-homogeneo-exposicao.service');
const { pool } = require('../config/database');

/**
 * Controller de GHE (Bloco 9, Etapa B). Mesmo desenho de
 * material.controller.js: traduz requisição em chamada de serviço, não
 * decide nada; `empresaId`/`atorId` só de req.empresa/req.usuario
 * (exigirSessao); autorização já aconteceu no middleware da rota
 * (`criarExigirPermissaoRecurso('employeeGroups', operacao)`).
 */

const comContexto = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] });
const informado = (corpo, campo, flag) => (Object.hasOwn(corpo, campo) ? { [campo]: corpo[campo], [flag]: true } : {});

function criarGrupoHomogeneoExposicaoController({ pool: poolInjetado }) {
  return {
    async criar(req, res) {
      const { nome, descricao, setor, funcao, riscos } = req.validado.body;
      const grupo = await gheService.criar(poolInjetado, {
        ...comContexto(req), nome, descricao: descricao ?? null, setor: setor ?? null, funcao: funcao ?? null, riscos: riscos ?? null,
      });
      res.status(201).json({ status: 'ok', grupo });
    },

    async listar(req, res) {
      const { ativo, busca, pagina, limite } = req.validado.query;
      const resultado = await gheService.listar(poolInjetado, { empresaId: req.empresa.id, ativo: ativo ?? null, busca: busca ?? null, pagina, limite });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async buscar(req, res) {
      const grupo = await gheService.buscar(poolInjetado, { empresaId: req.empresa.id, gheId: req.validado.params.id });
      res.status(200).json({ status: 'ok', grupo });
    },

    async alterar(req, res) {
      const corpo = req.validado.body;
      const grupo = await gheService.alterar(poolInjetado, {
        ...comContexto(req),
        gheId: req.validado.params.id,
        ...(Object.hasOwn(corpo, 'nome') ? { nome: corpo.nome } : {}),
        ...informado(corpo, 'descricao', 'descricaoInformado'),
        ...informado(corpo, 'setor', 'setorInformado'),
        ...informado(corpo, 'funcao', 'funcaoInformado'),
        ...informado(corpo, 'riscos', 'riscosInformado'),
      });
      res.status(200).json({ status: 'ok', grupo });
    },

    async inativar(req, res) {
      const { grupo, alterado } = await gheService.inativar(poolInjetado, { ...comContexto(req), gheId: req.validado.params.id });
      res.status(200).json({ status: 'ok', grupo, alterado });
    },

    async reativar(req, res) {
      const { grupo, alterado } = await gheService.reativar(poolInjetado, { ...comContexto(req), gheId: req.validado.params.id });
      res.status(200).json({ status: 'ok', grupo, alterado });
    },
  };
}

const grupoHomogeneoExposicaoController = criarGrupoHomogeneoExposicaoController({ pool });

module.exports = { criarGrupoHomogeneoExposicaoController, grupoHomogeneoExposicaoController };
