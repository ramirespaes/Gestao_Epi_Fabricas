'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');
const { derivarAdvisoryLock64 } = require('../../src/security/cooldown');
const { buscarCooldownVigente } = require('../../src/repositories/login-tentativa.repository');

/**
 * Regressão: now() representa o INÍCIO da transação PostgreSQL, não o
 * instante em que uma consulta roda depois de esperar um advisory lock.
 *
 * Cenário controlado com duas conexões reais:
 *   1. Conexão A adquire o advisory lock de uma chave.
 *   2. Conexão B tenta adquirir o MESMO lock e fica bloqueada — confirmado
 *      de forma determinística via pg_stat_activity, não por suposição de
 *      tempo.
 *   3. A mantém o lock por um período conhecido (pg_sleep), de propósito.
 *   4. A libera o lock (COMMIT).
 *   5. B finalmente adquire o lock, bem depois de sua própria transação ter
 *      começado.
 *   6. B consulta um cooldown pré-inserido cujo cooldown_ate está entre o
 *      início da transação de B e o instante real em que B, de fato,
 *      processa a consulta.
 *
 * Com now(): B ainda vê o cooldown como vigente, porque seu now() ficou
 * congelado no início da transação de B — ANTES do cooldown ter vencido de
 * verdade. Com clock_timestamp(): B vê corretamente que o cooldown já
 * venceu, porque reflete o instante real da consulta, não o início da
 * transação.
 *
 * Não há sleep de coordenação entre os dois lados do teste: a espera de B
 * pelo lock é resolvida pelo próprio PostgreSQL; o único atraso arbitrário
 * (pg_sleep em A) é um parâmetro conhecido do experimento, não uma tentativa
 * de sincronizar por adivinhação.
 */

const DURACAO_SEGURA_DO_LOCK_SEGUNDOS = 2;
const COOLDOWN_DURACAO_MS = 1500; // menor que os 2s do lock: garante que vence antes de B ser liberada.

describe('login-tentativa.repository: now() vs clock_timestamp() sob espera de advisory lock', () => {
  let contexto;
  let clienteAdmin;

  before(async () => {
    contexto = await abrirPoolTemporario(['000', '001', '002', '005', '013', '015']);
    clienteAdmin = await contexto.pool.connect();
  });

  after(async () => {
    if (clienteAdmin) clienteAdmin.release();
    if (contexto) await contexto.encerrar();
  });

  test('now() e clock_timestamp() divergem depois de uma espera real pelo advisory lock', async () => {
    const chave = crypto.createHash('sha256').update('relogio:divergencia').digest('hex');
    const lockId = derivarAdvisoryLock64(chave);

    const clienteA = await contexto.pool.connect();
    const clienteB = await contexto.pool.connect();
    try {
      await clienteA.query('BEGIN');
      await clienteA.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockId]);

      await clienteB.query('BEGIN');
      const { rows: pidRows } = await clienteB.query('SELECT pg_backend_pid() AS pid');
      const pidB = pidRows[0].pid;

      // Disparada, NÃO aguardada ainda: fica pendente no servidor, bloqueada.
      const promessaLockB = clienteB.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockId]);

      // Confirmação determinística de que B já está esperando, antes de
      // deixar A prosseguir — sem isso, o restante do teste dependeria de
      // uma suposição de tempo.
      await aguardarEsperaPeloLock(clienteAdmin, pidB);

      await clienteA.query(`SELECT pg_sleep(${DURACAO_SEGURA_DO_LOCK_SEGUNDOS})`);
      await clienteA.query('COMMIT');

      // Só agora aguardamos a promessa de B — depois do COMMIT de A, nunca
      // antes: aguardar as duas ao mesmo tempo (Promise.all) produziria uma
      // espera circular, já que a promessa de B só resolve depois do COMMIT
      // de A, e não podemos condicionar o COMMIT de A a essa mesma promessa.
      await promessaLockB;

      const { rows } = await clienteB.query('SELECT now() AS ntransacao, clock_timestamp() AS nreal');
      const diferencaMs = rows[0].nreal.getTime() - rows[0].ntransacao.getTime();

      assert.ok(
        diferencaMs >= 1800,
        `now() deveria estar defasado de clock_timestamp() em ~${DURACAO_SEGURA_DO_LOCK_SEGUNDOS}s após a espera pelo lock; diferença observada: ${diferencaMs}ms`,
      );

      await clienteB.query('COMMIT');
    } finally {
      clienteA.release();
      clienteB.release();
    }
  });

  test('buscarCooldownVigente avalia corretamente um cooldown vencido durante a espera pelo lock', async () => {
    const chave = crypto.createHash('sha256').update('relogio:cooldown-vencido-durante-espera').digest('hex');
    const lockId = derivarAdvisoryLock64(chave);

    // Cooldown que vence 1.5s a partir de agora — antes que B, que vai
    // esperar 2s pelo lock, chegue a consultá-lo.
    const cooldownAte = new Date(Date.now() + COOLDOWN_DURACAO_MS);
    await contexto.pool.query(
      `INSERT INTO login_tentativas (chave_cooldown, sucesso, motivo, cooldown_ate)
       VALUES ($1, false, 'COOLDOWN_ATIVADO', $2)`,
      [chave, cooldownAte],
    );

    const clienteA = await contexto.pool.connect();
    const clienteB = await contexto.pool.connect();
    try {
      await clienteA.query('BEGIN');
      await clienteA.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockId]);

      await clienteB.query('BEGIN');
      const { rows: pidRows } = await clienteB.query('SELECT pg_backend_pid() AS pid');
      const pidB = pidRows[0].pid;

      const promessaLockB = clienteB.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockId]);
      await aguardarEsperaPeloLock(clienteAdmin, pidB);

      await clienteA.query(`SELECT pg_sleep(${DURACAO_SEGURA_DO_LOCK_SEGUNDOS})`);
      await clienteA.query('COMMIT');
      await promessaLockB;

      // Passados ~2s reais desde a inserção, o cooldown (1.5s) já venceu de
      // fato — mas a transação de B começou bem antes disso.
      const vigente = await buscarCooldownVigente(clienteB, chave);

      assert.equal(
        vigente, null,
        'o cooldown já venceu em tempo real; buscarCooldownVigente não pode reportá-lo como ativo só porque a transação de B começou antes do vencimento',
      );

      await clienteB.query('COMMIT');
    } finally {
      clienteA.release();
      clienteB.release();
    }
  });
});
