'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Dados de referência dos REDs da classificação V2 (Grupo → Grupo de Proteção → Tipo). São os valores APROVADOS pelo
 * responsável; os testes comparam a produção com eles, nunca o contrário.
 */

const GRUPOS_PROTECAO = Object.freeze([
  'Proteção auditiva', 'Proteção contra quedas', 'Proteção da cabeça', 'Proteção das mãos', 'Proteção das pernas', 'Proteção dos braços',
  'Proteção dos pés', 'Proteção facial', 'Proteção ocular', 'Proteção da pele (membros superiores)', 'Proteção respiratória', 'Proteção do tronco',
]);

const CATALOGO_BASE = Object.freeze([
  ['EPI', 'Proteção auditiva', 'Protetor Auricular Concha'],
  ['EPI', 'Proteção auditiva', 'Protetor Auricular Plug'],
  ['EPI', 'Proteção contra quedas', 'Cinturão de Segurança com Talabarte/Trava-Quedas'],
  ['EPI', 'Proteção da cabeça', 'Capacete de Segurança'],
  ['EPI', 'Proteção da cabeça', 'Capuz de Segurança'],
  ['EPI', 'Proteção das mãos', 'Luva Isolante de Borracha'],
  ['EPI', 'Proteção das mãos', 'Luva de Segurança'],
  ['EPI', 'Proteção das mãos', 'Luva de Segurança Nitrila'],
  ['EPI', 'Proteção das mãos', 'Luva para Proteção contra Agentes Térmicos'],
  ['EPI', 'Proteção das pernas', 'Perneira de Proteção Aluminizada'],
  ['EPI', 'Proteção dos braços', 'Manga de Segurança'],
  ['EPI', 'Proteção dos braços', 'Manga de Segurança para Corte'],
  ['EPI', 'Proteção dos braços', 'Mangote de Segurança'],
  ['EPI', 'Proteção dos pés', 'Sapato de Segurança'],
  ['EPI', 'Proteção facial', 'Protetor Facial'],
  ['EPI', 'Proteção ocular', 'Óculos de Proteção Fumê'],
  ['EPI', 'Proteção ocular', 'Óculos de Proteção Incolor'],
  ['EPI', 'Proteção ocular', 'Óculos de Proteção Sobrepor'],
  ['EPI', 'Proteção da pele (membros superiores)', 'Creme Protetor de Segurança'],
  ['EPI', 'Proteção respiratória', 'Respirador PFF2'],
  ['Vestimenta', 'Proteção das pernas', 'Calça de Segurança'],
  ['Vestimenta', 'Proteção do tronco', 'Avental de Segurança'],
  ['Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco - Agente Térmico'],
  ['Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco - Camisa'],
  ['Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco - Raspa'],
  ['Vestimenta', 'Proteção do tronco', 'Vestimenta para Proteção do Tronco Aluminizada'],
]);

/** Carrega um módulo de produção (caminho relativo a test/integracao) que ainda pode não existir; se não existe, o TESTE falha com mensagem clara. */
function exigir(caminho, descricao) {
  const absoluto = path.resolve(__dirname, '..', caminho);
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(absoluto);
  } catch (erro) {
    if (erro && erro.code === 'MODULE_NOT_FOUND' && String(erro.message).includes(absoluto)) {
      return assert.fail(`${descricao} ainda não existe (${caminho})`);
    }
    throw erro;
  }
}

/** Executa uma consulta que depende da migration 082; sem ela, falha com a causa esperada. */
async function dependeDaMigration(promessa, descricao = 'estrutura da classificação V2') {
  try {
    return await promessa;
  } catch (erro) {
    if (erro && ['42P01', '42703'].includes(erro.code)) return assert.fail(`${descricao} depende da migration 082, ainda inexistente (${erro.message})`);
    throw erro;
  }
}

module.exports = { GRUPOS_PROTECAO, CATALOGO_BASE, exigir, dependeDaMigration };
