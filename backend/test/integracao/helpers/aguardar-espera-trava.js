'use strict';

const assert = require('node:assert/strict');

const LIMITE_DA_CONSULTA_MS = 2000;
const SQL_BLOQUEADOS = 'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))';

const proximoTurno = () => new Promise((resolver) => setImmediate(resolver));

async function antesDoLimite(promessa, restanteMs, mensagem) {
  let timer;
  const esgotado = new Promise((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new assert.AssertionError({ message: mensagem })), Math.max(0, restanteMs));
  });
  try {
    return await Promise.race([promessa, esgotado]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Conta os backends bloqueados por `pidBloqueador`. O statement_timeout local faz o próprio
 * PostgreSQL cancelar a consulta, então uma consulta abandonada pelo limite do teste não
 * segura a conexão nem o pool.end(); em falha, a conexão é descartada, nunca devolvida ao pool.
 * `sql` só é trocado pela sonda que prova o cancelamento.
 */
async function contarBloqueadosPor(pool, pidBloqueador, { limiteDaConsultaMs = LIMITE_DA_CONSULTA_MS, sql = SQL_BLOQUEADOS } = {}) {
  const cliente = await pool.connect();
  let falha;
  try {
    await cliente.query('BEGIN');
    await cliente.query(`SET LOCAL statement_timeout = ${Math.trunc(limiteDaConsultaMs)}`);
    const { rows } = await cliente.query(sql, [pidBloqueador]);
    await cliente.query('COMMIT');
    return rows[0].n;
  } catch (erro) {
    falha = erro;
    await cliente.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    cliente.release(falha);
  }
}

/**
 * Espera até `operacao` passar a aguardar uma trava (`contarEsperando()` > 0) ou terminar.
 * Devolve `true` se a operação terminou antes de esperar e `false` se ficou esperando;
 * propaga na hora o erro da operação, mesmo com a consulta pendente, e falha com `mensagem`
 * ao atingir `limiteMs`, inclusive quando a própria consulta de espera não responde.
 */
async function aguardarEsperaDaTrava({ operacao, contarEsperando, limiteMs, mensagem }) {
  const desfecho = operacao.then(() => ({ terminou: true }), (erro) => ({ erro }));
  const limite = Date.now() + limiteMs;

  while (Date.now() <= limite) {
    const consulta = contarEsperando().then((n) => ({ n }), (erroDaConsulta) => ({ erroDaConsulta }));
    const vez = await antesDoLimite(Promise.race([desfecho, consulta]), limite - Date.now(), mensagem);
    if (vez.erro) throw vez.erro;
    if (vez.terminou) return true;
    if (vez.erroDaConsulta) throw vez.erroDaConsulta;
    if (vez.n > 0) return false;
    await proximoTurno();
  }
  return assert.fail(mensagem);
}

const MENSAGEM_SEM_ESPERA = 'a requisição não chegou a esperar a trava nem terminou (limite de segurança do teste)';

/**
 * Executa `disparar()` enquanto uma transação concorrente SEGURA a trava da linha do tablet; quando a
 * requisição estiver esperando essa trava, aplica `mudanca(concorrente)` e confirma. Devolve a resposta.
 * Se a requisição terminar sem esperar, falha com `naoEsperou`; em qualquer falha, desfaz a trava.
 */
async function corridaSobTravaDoTablet({ pool, tabletId, disparar, mudanca, limiteMs, naoEsperou }) {
  const concorrente = await pool.connect();
  let confirmou = false;
  try {
    await concorrente.query('BEGIN');
    await concorrente.query('SELECT id FROM token_dispositivos WHERE id = $1 FOR UPDATE', [tabletId]);
    const pid = (await concorrente.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const resposta = disparar();
    const encerrada = await aguardarEsperaDaTrava({
      operacao: resposta,
      contarEsperando: () => contarBloqueadosPor(pool, pid),
      limiteMs,
      mensagem: MENSAGEM_SEM_ESPERA,
    });
    assert.equal(encerrada, false, naoEsperou);
    await mudanca(concorrente);
    await concorrente.query('COMMIT');
    confirmou = true;
    return await resposta;
  } finally {
    if (!confirmou) await concorrente.query('ROLLBACK').catch(() => {});
    concorrente.release();
  }
}

module.exports = { aguardarEsperaDaTrava, contarBloqueadosPor, corridaSobTravaDoTablet };
