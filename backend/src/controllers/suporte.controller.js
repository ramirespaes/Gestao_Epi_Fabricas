'use strict';

const suporteService = require('../services/suporte.service');
const { CANAIS } = require('../schemas/suporte.schema');
const { pool } = require('../config/database');

/**
 * Controller do Suporte (Portal). Empresa, usuário, nome e e-mail do solicitante SÓ de req.empresa/req.usuario (sessão): o schema
 * estrito não deixa o corpo trazer nenhum deles nem o destinatário.
 */
function criarSuporteController({ pool: poolInjetado, servicoEmail = undefined }) {
  const ator = (req) => ({
    empresaId: req.empresa.id,
    usuarioId: req.usuario.id,
    solicitanteNome: req.usuario.nome,
    solicitanteEmail: req.usuario.email,
    ip: req.ip,
    dispositivo: req.headers['user-agent'],
  });

  return {
    async canais(req, res) {
      const canais = await suporteService.consultarCanais(poolInjetado, { empresaId: req.empresa.id });
      res.status(200).json({ status: 'ok', canais });
    },

    async abrirChamado(req, res) {
      const { assunto, categoria, descricao, chaveIdempotencia } = req.validado.body;
      const { chamado, repetido } = await suporteService.abrirChamado(poolInjetado, {
        ...ator(req), assunto, categoria, descricao, chave: chaveIdempotencia,
      });
      res.status(repetido ? 200 : 201).json({ status: 'ok', chamado, repetido });
    },

    async listarChamados(req, res) {
      const { pagina, limite } = req.validado.query;
      const resultado = await suporteService.listarMeusChamados(poolInjetado, { empresaId: req.empresa.id, usuarioId: req.usuario.id, pagina, limite });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async notificacoes(req, res) {
      const resultado = await suporteService.contarNotificacoes(poolInjetado, { empresaId: req.empresa.id, usuarioId: req.usuario.id });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async detalharChamado(req, res) {
      const detalhe = await suporteService.detalharMeuChamado(poolInjetado, { empresaId: req.empresa.id, usuarioId: req.usuario.id, id: req.validado.params.id });
      res.status(200).json({ status: 'ok', ...detalhe });
    },

    async novasMensagens(req, res) {
      const resultado = await suporteService.novasMensagensDoMeuChamado(poolInjetado, {
        empresaId: req.empresa.id, usuarioId: req.usuario.id, id: req.validado.params.id, aposId: req.validado.query.aposId,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async enviarMensagem(req, res) {
      const { texto, chaveIdempotencia } = req.validado.body;
      const { mensagem, situacao, repetido } = await suporteService.enviarMensagem(poolInjetado, {
        empresaId: req.empresa.id, usuarioId: req.usuario.id, id: req.validado.params.id, texto, chave: chaveIdempotencia, ip: req.ip, dispositivo: req.headers['user-agent'],
      });
      res.status(repetido ? 200 : 201).json({ status: 'ok', mensagem, situacao, repetido });
    },

    async enviarContato(req, res) {
      const { assunto, mensagem, chaveIdempotencia } = req.validado.body;
      const { contato, repetido } = await suporteService.enviarContato(poolInjetado, {
        ...ator(req), empresaNome: req.empresa.nome, canal: CANAIS[req.validado.params.canal], assunto, mensagem, chave: chaveIdempotencia,
      }, servicoEmail === undefined ? undefined : { servicoEmail });
      res.status(repetido ? 200 : 201).json({ status: 'ok', contato, repetido });
    },
  };
}

const suporteController = criarSuporteController({ pool });

module.exports = { criarSuporteController, suporteController };
