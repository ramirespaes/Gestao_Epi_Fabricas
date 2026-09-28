'use strict';

/**
 * Trava consultiva do administrador no MFA. Toda criação ou transição de
 * desafio, fator, lote ou liberação de um administrador acontece com ela,
 * dentro da transação de quem chama (pg_advisory_xact_lock é liberada no
 * COMMIT/ROLLBACK; fora de transação não protegeria nada).
 *
 * Usa a forma de DUAS chaves int4. O PostgreSQL mantém esse espaço separado
 * do de uma chave bigint, que é o do cooldown de login e das demais travas
 * do projeto: não existe colisão possível com elas, só entre travas do
 * próprio MFA. A primeira chave identifica o espaço, a segunda é o id do
 * administrador (SERIAL, cabe em int4).
 *
 * Ordem das travas no login por senha: e-mail (cooldown), depois esta,
 * depois as linhas.
 */

// "MFA1" em ASCII: só precisa ser fixo e distinto de outro espaço de duas chaves.
const ESPACO_TRAVA_ADMINISTRADOR_MFA = 0x4d464131;
const ADMINISTRADOR_ID_MAXIMO = 2147483647;

async function travarAdministrador(executor, administradorId) {
  if (!Number.isInteger(administradorId) || administradorId <= 0 || administradorId > ADMINISTRADOR_ID_MAXIMO) {
    throw new TypeError('identificador de administrador inválido');
  }
  await executor.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [ESPACO_TRAVA_ADMINISTRADOR_MFA, administradorId]);
}

module.exports = { travarAdministrador, ESPACO_TRAVA_ADMINISTRADOR_MFA };
