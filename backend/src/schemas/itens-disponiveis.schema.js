'use strict';

const { z } = require('zod');
const { LIMITES, inteiroQuery, textoCurto } = require('./campos.schema');

/**
 * Consulta de itens disponíveis (Bloco 9, Etapa C, Parte C3). Somente
 * leitura. A query é estrita: empresa e usuário vêm exclusivamente da
 * sessão, nunca do cliente.
 *
 * `validade` refere-se EXCLUSIVAMENTE à validade do CA do material
 * (materiais.ca_validade) — não à validade física do EPI nem à
 * periodicidade de troca pelo trabalhador. É informativa: CA vencido não
 * bloqueia o estoque.
 */

// Alerta de CA "próximo do vencimento": mesmo limiar do protótipo em
// Validade do Estoque. Reutilizável pela Etapa E.
const DIAS_ALERTA_VALIDADE_CA = 60;
const LIMITE_PADRAO = 50;
const VALIDADES = Object.freeze(['ok', 'expiring', 'expired']);

// Mesmos tetos das colunas: categoria VARCHAR(30) (039), tipo VARCHAR(100)
// (007), tamanho VARCHAR(20) (008).
const categoria = textoCurto(30, 'CATEGORIA_INVALIDA', 'Categoria inválida');
const tipo = textoCurto(100, 'TIPO_INVALIDO', 'Tipo inválido');
const tamanho = textoCurto(20, 'TAMANHO_INVALIDO', 'Tamanho inválido');

const listar = {
  query: z.strictObject({
    categoria: categoria.optional(),
    tipo: tipo.optional(),
    tamanho: tamanho.optional(),
    validade: z.enum(VALIDADES).optional(),
    pagina: inteiroQuery(1, LIMITES.PAGINA_MAXIMA).default(1),
    limite: inteiroQuery(1, LIMITES.LIMITE_MAXIMO).default(LIMITE_PADRAO),
  }),
};

module.exports = { listar, DIAS_ALERTA_VALIDADE_CA, LIMITE_PADRAO, VALIDADES };
