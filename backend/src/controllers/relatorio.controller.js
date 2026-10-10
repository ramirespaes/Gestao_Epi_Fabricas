'use strict';

const service = require('../services/relatorio.service');
const auditoria = require('../services/relatorio-auditoria.service');
const { pool } = require('../config/database');
const { pipeline } = require('node:stream/promises');
const { HttpError } = require('../errors/HttpError');
const { criarServicoDoAmbiente } = require('../services/fiscalizacao-pacote.ambiente');

function criarRelatorioController({ pool: poolInjetado, fiscalizacao = null }) {
  // 12K-D6: sem o serviço (diretório de armazenamento não configurado) as rotas da Fiscalização respondem 503.
  const servico = () => {
    if (!fiscalizacao) throw new HttpError(503, 'FISCALIZACAO_INDISPONIVEL', 'A Fiscalização não está disponível neste ambiente.');
    return fiscalizacao;
  };
  const ator = (req) => ({
    empresaId: req.empresa.id, usuarioId: req.usuario.id, perfil: req.usuario.perfil, ip: req.ip, dispositivo: (req.headers['user-agent'] ?? '').slice(0, 150) || null,
  });
  const rota = (funcao) => async (req, res) => {
    const resultado = await funcao(poolInjetado, { empresaId: req.empresa.id, ...req.validado.query });
    res.status(200).json({ status: 'ok', ...resultado });
  };
  return {
    estoque: rota(service.estoque),
    proximoVencimento: rota(service.proximoVencimento),
    vencidos: rota(service.vencidos),
    entregues: rota(service.entregues),
    // 12K-D5: Relatório — Auditoria. A trilha também leva o ator, o IP e o dispositivo (só para auditar a própria consulta).
    auditoriaIndicadores: rota(auditoria.indicadores),
    auditoriaSolicitacoes: rota(auditoria.solicitacoesNaoAtendidas),
    auditoriaReprovadas: rota(auditoria.solicitacoesReprovadas),
    auditoriaCaVencidos: rota(auditoria.caVencidos),
    async auditoriaLog(req, res) {
      const resultado = await auditoria.log(poolInjetado, {
        empresaId: req.empresa.id, atorId: req.usuario.id, ip: req.ip, dispositivo: req.headers['user-agent'] ?? null, ...req.validado.query,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },
    // 12K-D6: Relatório — Fiscalização (reportsFiscal.visualizar): prévia, geração, histórico e download do pacote.
    async fiscalPrevia(req, res) {
      res.status(200).json({ status: 'ok', previa: await servico().previa(ator(req), req.validado.body) });
    },
    async fiscalGerar(req, res) {
      const resultado = await servico().gerar(ator(req), req.validado.body);
      res.status(resultado.criado ? 201 : 200).json({ status: 'ok', pacote: resultado.pacote });
    },
    async fiscalListar(req, res) {
      res.status(200).json({ status: 'ok', ...(await servico().listar(ator(req), req.validado.query)) });
    },
    async fiscalObter(req, res) {
      res.status(200).json({ status: 'ok', pacote: await servico().obter(ator(req), req.validado.params.id) });
    },
    async fiscalDownload(req, res) {
      const { fluxo, nomeArquivo, tamanhoBytes } = await servico().abrirDownload(ator(req), req.validado.params.id);
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
      res.setHeader('Content-Length', String(tamanhoBytes));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      try { await pipeline(fluxo, res); } catch { res.destroy(); }
    },
  };
}

module.exports = { criarRelatorioController, relatorioController: criarRelatorioController({ pool, fiscalizacao: criarServicoDoAmbiente(pool) }) };
