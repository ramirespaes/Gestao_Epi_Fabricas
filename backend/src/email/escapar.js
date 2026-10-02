'use strict';

/**
 * Tratamento do texto vindo do usuário antes de entrar numa mensagem:
 * escape de HTML para o corpo e limpeza de quebras de linha e caracteres de
 * controle para o texto simples.
 */

const MAPA = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
// Controles C0 e C1, separadores de linha e de parágrafo e os controles bidirecionais.
// Montada por string para o arquivo não carregar os separadores de linha literais.
const CONTROLES = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+', 'g');

function exigirTexto(valor) {
  if (typeof valor !== 'string') {
    throw new TypeError('texto esperado');
  }
}

function escaparHtml(valor) {
  exigirTexto(valor);
  return valor.replace(/[&<>"']/g, (c) => MAPA[c]);
}

function textoSimples(valor, maximo = 200) {
  exigirTexto(valor);
  const limpo = valor.replace(CONTROLES, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(limpo).slice(0, maximo).join('');
}

module.exports = { escaparHtml, textoSimples };
