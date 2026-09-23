'use strict';

const funcionarioService = require('../services/funcionario.service');
const { pool } = require('../config/database');

/**
 * Controller de funcionários (Bloco 9, Etapa B). Mesmo desenho de
 * material.controller.js. Autorização: `criarExigirPermissaoRecurso(
 * 'employeeHistory', operacao)` na rota. Nada aqui toca `usuarios`.
 *
 * `alterar` NÃO repassa `cpf` ao serviço: o CPF é imutável após o cadastro
 * (schema de alterar não o declara; o serviço e o repositório o recusam).
 */

const comContexto = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] });
const informado = (corpo, campo, flag) => (Object.hasOwn(corpo, campo) ? { [campo]: corpo[campo], [flag]: true } : {});

function criarFuncionarioController({ pool: poolInjetado }) {
  return {
    async criar(req, res) {
      const c = req.validado.body;
      const funcionario = await funcionarioService.criar(poolInjetado, {
        ...comContexto(req),
        matricula: c.matricula, nome: c.nome, cpf: c.cpf,
        grupoHomogeneoId: c.grupoHomogeneoId ?? null, dataNascimento: c.dataNascimento ?? null,
        setor: c.setor ?? null, funcao: c.funcao ?? null, cracha: c.cracha ?? null, telefone: c.telefone ?? null,
      });
      res.status(201).json({ status: 'ok', funcionario });
    },

    async listar(req, res) {
      const { ativo, busca, grupoHomogeneoId, pagina, limite } = req.validado.query;
      const resultado = await funcionarioService.listar(poolInjetado, {
        empresaId: req.empresa.id, ativo: ativo ?? null, busca: busca ?? null, grupoHomogeneoId: grupoHomogeneoId ?? null, pagina, limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async buscar(req, res) {
      const funcionario = await funcionarioService.buscar(poolInjetado, { empresaId: req.empresa.id, funcionarioId: req.validado.params.id });
      res.status(200).json({ status: 'ok', funcionario });
    },

    async alterar(req, res) {
      const c = req.validado.body;
      const funcionario = await funcionarioService.alterar(poolInjetado, {
        ...comContexto(req),
        funcionarioId: req.validado.params.id,
        ...(Object.hasOwn(c, 'matricula') ? { matricula: c.matricula } : {}),
        ...(Object.hasOwn(c, 'nome') ? { nome: c.nome } : {}),
        ...informado(c, 'grupoHomogeneoId', 'grupoHomogeneoIdInformado'),
        ...informado(c, 'dataNascimento', 'dataNascimentoInformado'),
        ...informado(c, 'setor', 'setorInformado'),
        ...informado(c, 'funcao', 'funcaoInformado'),
        ...informado(c, 'cracha', 'crachaInformado'),
        ...informado(c, 'telefone', 'telefoneInformado'),
      });
      res.status(200).json({ status: 'ok', funcionario });
    },

    async inativar(req, res) {
      const { funcionario, alterado } = await funcionarioService.inativar(poolInjetado, { ...comContexto(req), funcionarioId: req.validado.params.id });
      res.status(200).json({ status: 'ok', funcionario, alterado });
    },

    async reativar(req, res) {
      const { funcionario, alterado } = await funcionarioService.reativar(poolInjetado, { ...comContexto(req), funcionarioId: req.validado.params.id });
      res.status(200).json({ status: 'ok', funcionario, alterado });
    },
  };
}

const funcionarioController = criarFuncionarioController({ pool });

module.exports = { criarFuncionarioController, funcionarioController };
