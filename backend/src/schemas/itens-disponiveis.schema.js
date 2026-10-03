'use strict';

const { z } = require('zod');
const {
  LIMITES, inteiroQuery, textoCurto, booleanoQuery,
} = require('./campos.schema');

/**
 * Consulta de itens disponíveis (Bloco 9, Etapa C, Parte C3). Somente
 * leitura. A query é estrita: empresa e usuário vêm exclusivamente da
 * sessão, nunca do cliente.
 *
 * `validade` refere-se EXCLUSIVAMENTE à validade do CA dos lotes com saldo
 * (estoque_lotes.ca_validade), a pior entre eles — não à validade física do
 * EPI nem à periodicidade de troca pelo trabalhador. O saldo de lote com CA
 * vencido ou sem CA fica bloqueado e não conta como disponível.
 */

// Alerta de CA "próximo do vencimento": o mesmo limiar da Validade de
// estoque e do Dashboard.
const DIAS_ALERTA_VALIDADE_CA = 60;
const LIMITE_PADRAO = 50;
const VALIDADES = Object.freeze(['ok', 'expiring', 'expired']);
// Situação funcional do par, derivada no servidor da posição (12D): sem físico
// utilizável, abaixo do mínimo pelo saldo livre, com parte comprometida e com
// demanda sem cobertura. `somenteComNecessidade` é um filtro à parte, que se
// soma à situação: necessidade = demanda sem cobertura + déficit do mínimo.
const SITUACOES_ESTOQUE = Object.freeze(['SEM_ESTOQUE', 'ABAIXO_MINIMO', 'COM_COMPROMETIDO', 'SEM_COBERTURA']);
const BUSCA_MAXIMA = 100;

// Mesmos tetos das colunas: categoria VARCHAR(30) (039), tipo VARCHAR(100)
// (007), tamanho VARCHAR(20) (008).
const categoria = textoCurto(30, 'CATEGORIA_INVALIDA', 'Categoria inválida');
const tipo = textoCurto(100, 'TIPO_INVALIDO', 'Tipo inválido');
const tamanho = textoCurto(20, 'TAMANHO_INVALIDO', 'Tamanho inválido');
const busca = textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido');

const listar = {
  query: z.strictObject({
    categoria: categoria.optional(),
    tipo: tipo.optional(),
    tamanho: tamanho.optional(),
    validade: z.enum(VALIDADES).optional(),
    busca: busca.optional(),
    situacao: z.enum(SITUACOES_ESTOQUE).optional(),
    somenteComNecessidade: booleanoQuery.optional(),
    pagina: inteiroQuery(1, LIMITES.PAGINA_MAXIMA).default(1),
    limite: inteiroQuery(1, LIMITES.LIMITE_MAXIMO).default(LIMITE_PADRAO),
  }),
};

module.exports = {
  listar, DIAS_ALERTA_VALIDADE_CA, LIMITE_PADRAO, VALIDADES, SITUACOES_ESTOQUE,
};
