'use strict';

const crypto = require('node:crypto');

/**
 * Declarações LGPD apresentadas em procedimentos administrativos
 * (Bloco 9, Etapa C, Parte C4 — decisão D4 de 25/09/2026).
 *
 * O QUE É: a DECLARAÇÃO da pessoa que importa a planilha de que os
 * trabalhadores foram informados sobre o tratamento dos dados. NÃO é
 * consentimento individual de cada trabalhador, e não deve ser apresentada
 * nem registrada como tal.
 *
 * Fonte única do texto: a página (frontend/js/funcionarios.js) exibe
 * exatamente este texto, e os testes conferem a igualdade. A auditoria
 * registra a VERSÃO e o SHA-256 do texto, nunca uma cópia livre dele —
 * mudar a redação exige uma versão nova, para que registros antigos
 * continuem apontando para o texto que de fato foi apresentado.
 */

const VERSAO_ATUAL = 'IMPORTACAO-FUNCIONARIOS-V1';

const TEXTOS = Object.freeze({
  'IMPORTACAO-FUNCIONARIOS-V1': 'Confirmo que todos os funcionários desta planilha foram informados sobre o tratamento dos seus dados pessoais conforme a Política de Privacidade (LGPD — Lei 13.709/2018).',
});

const HASHES = Object.freeze(Object.fromEntries(
  Object.entries(TEXTOS).map(([versao, texto]) => [versao, crypto.createHash('sha256').update(texto, 'utf8').digest('hex')]),
));

function versaoConhecida(versao) {
  return typeof versao === 'string' && Object.hasOwn(TEXTOS, versao);
}

function textoDaVersao(versao) {
  return versaoConhecida(versao) ? TEXTOS[versao] : null;
}

function hashDaVersao(versao) {
  return versaoConhecida(versao) ? HASHES[versao] : null;
}

module.exports = { VERSAO_ATUAL, versaoConhecida, textoDaVersao, hashDaVersao };
