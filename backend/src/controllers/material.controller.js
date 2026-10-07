'use strict';

const materialService = require('../services/material.service');
const minimoService = require('../services/estoque-minimo.service');
const { pool } = require('../config/database');

/**
 * Controller de materiais (Bloco 9, Etapa A).
 *
 * Traduz requisição em chamada de serviço e resultado em resposta HTTP.
 * Não decide nada: autorização já aconteceu no middleware da rota
 * (`criarExigirPermissaoRecurso('materials', operacao)`, Bloco 8); isolamento,
 * normalização e auditoria já estão em material.service.js. Sem try/catch:
 * Express 5 encaminha a Promise rejeitada ao errorHandler.
 *
 * `materialService.funcao(...)` é chamado por namespace, nunca
 * desestruturado — mesma razão de grupo-acesso.controller.js: permite
 * mock.method nos testes sem alterar produção.
 *
 * FONTE DE AUTORIDADE: `empresaId` e `atorId` saem EXCLUSIVAMENTE de
 * req.empresa.id e req.usuario.id, populados por exigirSessao depois de
 * validar o cookie contra o PostgreSQL. Nada vindo de body, params ou
 * query influencia quem é o ator ou de qual empresa ele é.
 */

function criarMaterialController({ pool: poolInjetado }) {
  return {
    async criar(req, res) {
      const {
        nome, tipo, tipoDescricao, fabricante, prazoUsoDias, exigeTamanho, oculosComGrau, unidade, estoqueMinimo,
        categoria, codigoInterno, descricao, tamanhos,
      } = req.validado.body;

      const material = await materialService.criar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        nome,
        tipo: tipo ?? null,
        tipoDescricao: tipoDescricao ?? null,
        fabricante: fabricante ?? null,
        prazoUsoDias: prazoUsoDias ?? null,
        exigeTamanho,
        oculosComGrau: oculosComGrau ?? null,
        unidade,
        estoqueMinimo,
        categoria: categoria ?? null,
        codigoInterno: codigoInterno ?? null,
        descricao: descricao ?? null,
        tamanhos: tamanhos ?? [],
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(201).json({ status: 'ok', material });
    },

    async listar(req, res) {
      const { ativo, busca, pagina, limite } = req.validado.query;

      const resultado = await materialService.listar(poolInjetado, {
        empresaId: req.empresa.id,
        ativo: ativo ?? null,
        busca: busca ?? null,
        pagina,
        limite,
      });

      res.status(200).json({ status: 'ok', ...resultado });
    },

    async buscar(req, res) {
      const material = await materialService.buscar(poolInjetado, {
        empresaId: req.empresa.id,
        materialId: req.validado.params.id,
      });

      res.status(200).json({ status: 'ok', material });
    },

    /**
     * Só os campos declarados no schema. Campos opcionais do domínio
     * (tipo, fabricante, prazoUsoDias e os da Parte C2) são
     * repassados condicionalmente, com a flag `*Informado`, para que o
     * serviço distinga "ausente" (não mexer) de "null" (limpar) — mesmo
     * mecanismo de `descricao` em grupo-acesso.controller.js, repetido
     * por campo.
     */
    async alterar(req, res) {
      const corpo = req.validado.body;

      const material = await materialService.alterar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        materialId: req.validado.params.id,
        ...(Object.hasOwn(corpo, 'nome') ? { nome: corpo.nome } : {}),
        ...(Object.hasOwn(corpo, 'tipo') ? { tipo: corpo.tipo, tipoInformado: true } : {}),
        ...(Object.hasOwn(corpo, 'tipoDescricao') ? { tipoDescricao: corpo.tipoDescricao, tipoDescricaoInformado: true } : {}),
        ...(Object.hasOwn(corpo, 'fabricante') ? { fabricante: corpo.fabricante, fabricanteInformado: true } : {}),
        ...(Object.hasOwn(corpo, 'prazoUsoDias') ? { prazoUsoDias: corpo.prazoUsoDias, prazoUsoDiasInformado: true } : {}),
        ...(Object.hasOwn(corpo, 'exigeTamanho') ? { exigeTamanho: corpo.exigeTamanho } : {}),
        ...(Object.hasOwn(corpo, 'oculosComGrau') ? { oculosComGrau: corpo.oculosComGrau, oculosComGrauInformado: true } : {}),
        // `unidade` não é repassada: o schema de alterar não a aceita (unidade imutável).
        ...(Object.hasOwn(corpo, 'estoqueMinimo') ? { estoqueMinimo: corpo.estoqueMinimo } : {}),
        ...(Object.hasOwn(corpo, 'categoria') ? { categoria: corpo.categoria, categoriaInformado: true } : {}),
        ...(Object.hasOwn(corpo, 'codigoInterno') ? { codigoInterno: corpo.codigoInterno, codigoInternoInformado: true } : {}),
        ...(Object.hasOwn(corpo, 'descricao') ? { descricao: corpo.descricao, descricaoInformado: true } : {}),
        ...(Object.hasOwn(corpo, 'tamanhos') ? { tamanhos: corpo.tamanhos, tamanhosInformado: true } : {}),
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', material });
    },

    async inativar(req, res) {
      const { material, alterado } = await materialService.inativar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        materialId: req.validado.params.id,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', material, alterado });
    },

    async reativar(req, res) {
      const { material, alterado } = await materialService.reativar(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        materialId: req.validado.params.id,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', material, alterado });
    },

    // 12D-2 — mínimo padrão e sobrescritas por tamanho. A empresa e o ator são os da sessão.
    async minimos(req, res) {
      const estado = await minimoService.consultar(poolInjetado, {
        empresaId: req.empresa.id,
        materialId: req.validado.params.id,
      });

      res.status(200).json({ status: 'ok', ...estado });
    },

    // 201 quando a sobrescrita nasce; 200 quando já existia, tenha mudado ou não (alterado diz).
    async definirMinimo(req, res) {
      const resultado = await minimoService.definir(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        materialId: req.validado.params.id,
        tamanho: req.validado.params.tamanho,
        minimo: req.validado.body.minimo,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(resultado.criado ? 201 : 200).json({ status: 'ok', ...resultado });
    },

    async removerMinimo(req, res) {
      const resultado = await minimoService.remover(poolInjetado, {
        empresaId: req.empresa.id,
        atorId: req.usuario.id,
        materialId: req.validado.params.id,
        tamanho: req.validado.params.tamanho,
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', ...resultado });
    },
  };
}

const materialController = criarMaterialController({ pool });

module.exports = { criarMaterialController, materialController };
