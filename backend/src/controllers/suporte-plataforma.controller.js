'use strict';

const service = require('../services/suporte-plataforma.service');
const { pool } = require('../config/database');

/** Controller do atendimento de suporte no Painel Privado. O administrador vem SÓ de req.administradorPlataforma. */
function criarSuportePlataformaController({ pool: poolInjetado }) {
  const contexto = (req) => ({ administradorId: req.administradorPlataforma.id, ip: req.ip, dispositivo: req.headers['user-agent'] });

  return {
    async listar(req, res) {
      const q = req.validado.query;
      const resultado = await service.listar(poolInjetado, {
        situacao: q.situacao ?? null, empresaId: q.empresaId ?? null, busca: q.busca ?? null, naoLidas: q.naoLidas === true, pagina: q.pagina, limite: q.limite,
      });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async novasMensagens(req, res) {
      const resultado = await service.novasMensagens(poolInjetado, { id: req.validado.params.id, aposId: req.validado.query.aposId });
      res.status(200).json({ status: 'ok', ...resultado });
    },

    async detalhar(req, res) {
      const detalhe = await service.detalhar(poolInjetado, { id: req.validado.params.id });
      res.status(200).json({ status: 'ok', ...detalhe });
    },

    async responder(req, res) {
      const resultado = await service.responder(poolInjetado, {
        ...contexto(req), id: req.validado.params.id, texto: req.validado.body.texto, chave: req.validado.body.chaveIdempotencia ?? null,
      });
      res.status(resultado.repetido ? 200 : 201).json({ status: 'ok', ...resultado });
    },

    async alterarSituacao(req, res) {
      const resultado = await service.alterarSituacao(poolInjetado, { ...contexto(req), id: req.validado.params.id, situacao: req.validado.body.situacao });
      res.status(200).json({ status: 'ok', ...resultado });
    },
  };
}

const suportePlataformaController = criarSuportePlataformaController({ pool });

module.exports = { criarSuportePlataformaController, suportePlataformaController };
