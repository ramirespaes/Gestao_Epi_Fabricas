'use strict';

const consulta = require('../services/solicitacao-epi-consulta.service');
const contextoSvc = require('../services/solicitacao-epi-contexto.service');
const solicitacaoSvc = require('../services/solicitacao-epi.service');
const entregaSolicitacaoSvc = require('../services/entrega-solicitacao.service');
const { itensSemEstoque } = require('../services/solicitacao-epi-publica');
const { entregaPublica } = require('../services/entrega-epi-publica');
const { dataOperacional } = require('../utils/data-operacional');

/**
 * Solicitação de EPI pela camada HTTP: consultas (12F-1) e escrita (12F-2).
 * Empresa, usuário e perfil exclusivamente da sessão (req.empresa /
 * req.usuario, populados por exigirSessao); query, params e corpo já
 * validados e estritos em req.validado. A autorização é da rota; status,
 * autoria, cobertura, posição e estoque são do serviço. Nada é recalculado
 * aqui: o corpo é o que o serviço devolveu, só com a forma pública. O relógio
 * é injetável para os testes controlarem a data operacional.
 */
function criarSolicitacaoEpiController({ pool: poolInjetado, relogio = () => new Date() }) {
  const hoje = () => dataOperacional(relogio());
  const sessao = (req) => ({ empresaId: req.empresa.id, atorId: req.usuario.id });
  const origem = (req) => ({ ip: req.ip, dispositivo: req.headers['user-agent'] });

  return {
    async minhas(req, res) {
      const { status, pagina, limite } = req.validado.query;
      const resultado = await consulta.listarMinhas(poolInjetado, {
        empresaId: req.empresa.id, atorId: req.usuario.id, status: status ?? null, pagina, limite, hoje: hoje(),
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async fila(req, res) {
      const { pagina, limite } = req.validado.query;
      const resultado = await consulta.listarFila(poolInjetado, { empresaId: req.empresa.id, pagina, limite });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async entregaveis(req, res) {
      const { funcionarioId, pagina, limite } = req.validado.query;
      const resultado = await consulta.listarEntregaveis(poolInjetado, {
        empresaId: req.empresa.id, funcionarioId: funcionarioId ?? null, pagina, limite, hoje: hoje(),
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    // 12G-0: o contexto da criação (quem pede escolhe trabalhador e material) e as encerráveis.
    async contextoFuncionarios(req, res) {
      const { busca, pagina, limite } = req.validado.query;
      const resultado = await contextoSvc.localizarTrabalhadores(poolInjetado, {
        empresaId: req.empresa.id, busca: busca ?? null, pagina, limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async contextoMateriais(req, res) {
      const {
        busca, previstoNoGhe, pagina, limite,
      } = req.validado.query;
      const resultado = await contextoSvc.listarMateriais(poolInjetado, {
        empresaId: req.empresa.id,
        funcionarioId: req.validado.params.funcionarioId,
        busca: busca ?? null,
        previstoNoGhe: previstoNoGhe ?? null,
        pagina,
        limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async encerraveis(req, res) {
      const { funcionarioId, pagina, limite } = req.validado.query;
      const resultado = await consulta.listarEncerraveis(poolInjetado, {
        empresaId: req.empresa.id, funcionarioId: funcionarioId ?? null, pagina, limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async detalhe(req, res) {
      const resultado = await consulta.buscarDetalhe(poolInjetado, {
        empresaId: req.empresa.id, usuarioId: req.usuario.id, perfil: req.usuario.perfil, solicitacaoId: req.validado.params.id, hoje: hoje(),
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    // 201 quando nasce; 200 quando a mesma chave repete a mesma requisição. Quem pede não vê números de estoque.
    async criar(req, res) {
      const {
        funcionarioId, itens, observacao, chaveIdempotencia,
      } = req.validado.body;
      const resultado = await solicitacaoSvc.criarSolicitacao(poolInjetado, {
        ...sessao(req), funcionarioId, itens, observacao: observacao ?? null, chaveIdempotencia, ...origem(req),
      });
      res.status(resultado.repetida ? 200 : 201).json({
        status: 'ok', repetida: resultado.repetida, solicitacao: resultado.solicitacao, itens: itensSemEstoque(resultado.itens),
      });
    },

    async cancelar(req, res) {
      const visao = await solicitacaoSvc.cancelarSolicitacao(poolInjetado, {
        ...sessao(req), solicitacaoId: req.validado.params.id, justificativa: req.validado.body.justificativa ?? null, hoje: hoje(), ...origem(req),
      });
      res.status(200).json({ status: 'ok', solicitacao: visao.solicitacao, itens: itensSemEstoque(visao.itens) });
    },

    async decidir(req, res) {
      const visao = await solicitacaoSvc.decidirSolicitacao(poolInjetado, {
        ...sessao(req), solicitacaoId: req.validado.params.id, decisoes: req.validado.body.decisoes, hoje: hoje(), ...origem(req),
      });
      res.status(200).json({ status: 'ok', ...visao });
    },

    async encerrar(req, res) {
      const visao = await solicitacaoSvc.encerrarSolicitacao(poolInjetado, {
        ...sessao(req), solicitacaoId: req.validado.params.id, justificativa: req.validado.body.justificativa, hoje: hoje(), ...origem(req),
      });
      res.status(200).json({ status: 'ok', ...visao });
    },

    // 201 quando a entrega nasce; 200 quando a mesma chave repete a mesma requisição.
    async entregar(req, res) {
      const { itens, confirmacao, chaveIdempotencia } = req.validado.body;
      const resultado = await entregaSolicitacaoSvc.registrarEntregaPorSolicitacao(poolInjetado, {
        ...sessao(req), solicitacaoId: req.validado.params.id, itens, confirmacao, chaveIdempotencia, ...origem(req),
      });
      res.status(resultado.repetida ? 200 : 201).json({
        status: 'ok', repetida: resultado.repetida, entrega: entregaPublica(resultado), solicitacao: resultado.solicitacao,
      });
    },
  };
}

module.exports = { criarSolicitacaoEpiController };
