'use strict';

const funcionarioService = require('../services/funcionario.service');
const { mascararCpf } = require('../utils/normalizacao');
const { pool } = require('../config/database');
const { dataOperacional } = require('../utils/data-operacional');

/**
 * Controller de funcionários (Bloco 9, Etapa B). Mesmo desenho de
 * material.controller.js. Autorização: `criarExigirPermissaoRecurso(
 * 'employeeHistory', operacao)` na rota. Nada aqui toca `usuarios`.
 *
 * `alterar` NÃO repassa `cpf` ao serviço: o CPF é imutável após o cadastro
 * (schema de alterar não o declara; o serviço e o repositório o recusam).
 *
 * Nenhuma resposta devolve o CPF completo (segurança S3 do Bloco 9): nenhuma
 * tela precisa dele e a listagem permitiria coletar os CPFs da empresa
 * inteira. Sai só `cpfMascarado` (***.***.***-XX). Gravação, validação e
 * busca por CPF completo (igualdade exata) continuam as mesmas.
 */

const LIMITE_CONSULTA_CPF = 20;

const comContexto = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] });
const informado = (corpo, campo, flag) => (Object.hasOwn(corpo, campo) ? { [campo]: corpo[campo], [flag]: true } : {});

function paraResposta(funcionario) {
  const { cpf, ...resto } = funcionario;
  return { ...resto, cpfMascarado: mascararCpf(cpf) };
}

// S4: "hoje" das regras de data é a data civil (America/Sao_Paulo) do relógio injetado; o padrão é o relógio real.
function criarFuncionarioController({ pool: poolInjetado, relogio = () => new Date() }) {
  return {
    async criar(req, res) {
      const c = req.validado.body;
      const funcionario = await funcionarioService.criar(poolInjetado, {
        ...comContexto(req), hoje: dataOperacional(relogio()),
        matricula: c.matricula, nome: c.nome, cpf: c.cpf,
        grupoHomogeneoId: c.grupoHomogeneoId ?? null, dataNascimento: c.dataNascimento ?? null,
        setor: c.setor ?? null, funcao: c.funcao ?? null, cracha: c.cracha ?? null, telefone: c.telefone ?? null,
        dataAdmissao: c.dataAdmissao ?? null,
      });
      res.status(201).json({ status: 'ok', funcionario: paraResposta(funcionario) });
    },

    async listar(req, res) {
      const { ativo, busca, grupoHomogeneoId, pagina, limite } = req.validado.query;
      const resultado = await funcionarioService.listar(poolInjetado, {
        empresaId: req.empresa.id, ativo: ativo ?? null, busca: busca ?? null, grupoHomogeneoId: grupoHomogeneoId ?? null,
        cpf: null, pagina, limite,
      });
      res.status(200).json({ status: 'ok', ...resultado, funcionarios: resultado.funcionarios.map(paraResposta) });
    },

    // SEC-008: CPF completo no corpo, nunca na URL. Mesma resposta da
    // listagem; o CPF é único por empresa, então uma página basta.
    async consultarCpf(req, res) {
      const resultado = await funcionarioService.listar(poolInjetado, {
        empresaId: req.empresa.id, ativo: null, busca: null, grupoHomogeneoId: null,
        cpf: req.validado.body.cpf, pagina: 1, limite: LIMITE_CONSULTA_CPF,
      });
      res.status(200).json({ status: 'ok', ...resultado, funcionarios: resultado.funcionarios.map(paraResposta) });
    },

    // Única resposta com o CPF completo: dedicada, POST, no-store, empresa e ator só da sessão (corpo e query são vazios e estritos).
    async revelarCpf(req, res) {
      const { cpf } = await funcionarioService.revelarCpf(poolInjetado, { ...comContexto(req), funcionarioId: req.validado.params.id });
      res.set('Cache-Control', 'no-store');
      res.status(200).json({ status: 'ok', cpf });
    },

    async buscar(req, res) {
      const funcionario = await funcionarioService.buscar(poolInjetado, { empresaId: req.empresa.id, funcionarioId: req.validado.params.id });
      res.status(200).json({ status: 'ok', funcionario: paraResposta(funcionario) });
    },

    async alterar(req, res) {
      const c = req.validado.body;
      const funcionario = await funcionarioService.alterar(poolInjetado, {
        ...comContexto(req), hoje: dataOperacional(relogio()),
        funcionarioId: req.validado.params.id,
        ...(Object.hasOwn(c, 'matricula') ? { matricula: c.matricula } : {}),
        ...(Object.hasOwn(c, 'nome') ? { nome: c.nome } : {}),
        ...informado(c, 'grupoHomogeneoId', 'grupoHomogeneoIdInformado'),
        ...informado(c, 'dataNascimento', 'dataNascimentoInformado'),
        ...informado(c, 'setor', 'setorInformado'),
        ...informado(c, 'funcao', 'funcaoInformado'),
        ...informado(c, 'cracha', 'crachaInformado'),
        ...informado(c, 'telefone', 'telefoneInformado'),
        ...informado(c, 'dataAdmissao', 'dataAdmissaoInformado'),
      });
      res.status(200).json({ status: 'ok', funcionario: paraResposta(funcionario) });
    },

    /**
     * Importação em lote (C4). Empresa e ator sempre da sessão; o corpo
     * validado nunca carrega empresaId. Resposta 200 com um resultado por
     * linha — recusas e duplicidades de linha não são erro HTTP do lote.
     */
    async listarGhesImportacao(req, res) {
      const ghes = await funcionarioService.listarGhesParaImportacao(poolInjetado, { empresaId: req.empresa.id });
      res.status(200).json({ status: 'ok', ghes });
    },

    // S3: seletor de GHE do formulário (employeeHistory.visualizar); a empresa vem só da sessão.
    async listarGhes(req, res) {
      const ghes = await funcionarioService.listarGhesParaFormulario(poolInjetado, { empresaId: req.empresa.id });
      res.status(200).json({ status: 'ok', ghes });
    },

    async importar(req, res) {
      const c = req.validado.body;
      const resultado = await funcionarioService.importar(poolInjetado, {
        ...comContexto(req),
        importacaoId: c.importacaoId, lote: c.lote, arquivo: c.arquivo, declaracaoLgpd: c.declaracaoLgpd, linhas: c.linhas,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async inativar(req, res) {
      const { funcionario, alterado } = await funcionarioService.inativar(poolInjetado, { ...comContexto(req), funcionarioId: req.validado.params.id });
      res.status(200).json({ status: 'ok', funcionario: paraResposta(funcionario), alterado });
    },

    async alterarSituacao(req, res) {
      const { funcionario, situacaoAnterior } = await funcionarioService.alterarSituacao(poolInjetado, {
        ...comContexto(req), funcionarioId: req.validado.params.id, situacao: req.validado.body.situacao,
      });
      res.status(200).json({ status: 'ok', funcionario: paraResposta(funcionario), situacaoAnterior });
    },

    async reativar(req, res) {
      const { funcionario, alterado } = await funcionarioService.reativar(poolInjetado, { ...comContexto(req), funcionarioId: req.validado.params.id });
      res.status(200).json({ status: 'ok', funcionario: paraResposta(funcionario), alterado });
    },
  };
}

const funcionarioController = criarFuncionarioController({ pool });

module.exports = { criarFuncionarioController, funcionarioController };
