'use strict';

/**
 * Escape de coringas para termos de busca usados em LIKE/ILIKE.
 *
 * Nasceu privado em material.repository.js (Bloco 9, Etapa A, correção
 * pós-auditoria) e foi promovido para cá na Etapa B, quando os repositórios
 * de GHE e de funcionários passaram a precisar da mesma regra — uma única
 * definição, vários consumidores (mesma disciplina de utils/normalizacao.js).
 *
 * Escapa `%` e `_` (coringas) e o próprio `\` (caractere de escape padrão
 * do PostgreSQL), para que o termo seja tratado como texto literal. A barra
 * invertida é escapada PRIMEIRO, para não escapar em dobro os `\%`/`\_`
 * que ela mesma produz a seguir. O resultado deve ir SEMPRE como
 * parâmetro ($n), nunca concatenado na string SQL — isto não é proteção
 * contra injeção (que o parâmetro já garante), é proteção contra o termo
 * ser interpretado como padrão de correspondência.
 */
function escaparCoringasLike(texto) {
  if (typeof texto !== 'string') {
    throw new TypeError('termo de busca deve ser string');
  }
  return texto.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

module.exports = { escaparCoringasLike };
