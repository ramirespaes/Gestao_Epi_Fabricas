'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { montarCenario } = require('./helpers/solicitacao-epi');
const repo = require('../../src/repositories/token-monitoramento.repository');
const servico = require('../../src/services/token-monitoramento.service');
const { JANELA_ESCRITA_MINIMA_SEGUNDOS } = require('../../src/config/token-monitoramento');

/**
 * Atendimento Token — Etapa J, J2a (Fase 3B-R1): janela de escrita do contato do heartbeat (45 s) em PostgreSQL real, schema
 * temporário do cluster dedicado. Complementa o RED sem tocá-lo: o DEP-H01 continua TODO no arquivo congelado e aqui a hipótese
 * (20 s não regrava, com estado registrado nulo) é afirmada de forma firme, junto com o limite exato, o estado OFFLINE, o
 * primeiro contato e o cancelamento da suspeita sem regravar o contato. Barreira determinística por pg_stat_activity; sem sleep
 * como prova. Não abre conexão ao ser importado.
 */

const TODAS = fs.readdirSync(path.join(__dirname, '..', '..', 'migrations')).map((n) => n.match(/^(\d{3})_.*\.sql$/)?.[1]).filter((p) => p !== undefined).sort();

describe('J2a — janela de escrita do contato do heartbeat (PostgreSQL real)', () => {
  let ctx;
  let pool;
  let admin;
  let d;
  let n = 0;

  const q = (sql, params) => pool.query(sql, params);
  const ids = (t) => ({ empresaId: t.empresaId, dispositivoId: t.id });
  // atualizado_us: o mesmo instante em texto, com microssegundos. O Date do pg trunca para milissegundos (duas escritas a menos de
  // 1 ms ficam iguais em JavaScript), então a ordem de atualizado_em é conferida no PostgreSQL com aposEstrito.
  const linha = async (t) => (await q('SELECT *, xmin::text AS versao, atualizado_em::text AS atualizado_us FROM token_dispositivos WHERE id = $1', [t.id])).rows[0];
  const aposEstrito = async (posterior, anterior) => (await q('SELECT $1::timestamptz > $2::timestamptz AS ok', [posterior, anterior])).rows[0].ok;
  const tipos = async (t) => (await q('SELECT tipo FROM token_dispositivo_eventos WHERE dispositivo_id = $1 ORDER BY id', [t.id])).rows.map((r) => r.tipo);
  const ms = (x) => (x === null ? null : x.getTime());

  /** Tablet ativado; contato, estado e suspeita definidos RELATIVAMENTE ao now() do banco (null = nulo). */
  async function tablet({ contatoAtras = null, registrada = null, suspeitaAtras = null, empresaId = d.empresaA } = {}) {
    n += 1;
    const { rows } = await q(
      `INSERT INTO token_dispositivos (empresa_id, nome, criado_por, ativado_em, ultimo_contato_em, comunicacao_registrada, queda_suspeita_desde)
       VALUES ($1, $2, $3, now(), CASE WHEN $4::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $4::float8) END, $5,
               CASE WHEN $6::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $6::float8) END) RETURNING id`,
      [empresaId, `Tablet janela ${n}`, empresaId === d.empresaA ? d.solicitante : d.usuarioB, contatoAtras, registrada, suspeitaAtras],
    );
    return { id: rows[0].id, empresaId };
  }

  async function aguardarEsperas(esperado) {
    for (let i = 0; i < 1000; i += 1) {
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'");
      if (rows[0].n >= esperado) return;
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    throw new Error(`menos de ${esperado} conexões esperando trava`);
  }

  before(async () => {
    ctx = await abrirPoolTemporario(TODAS);
    pool = ctx.pool;
    admin = await pool.connect();
    d = await montarCenario(admin);
  });
  after(async () => {
    if (admin) admin.release();
    if (ctx) await ctx.encerrar();
  });
  beforeEach(async () => {
    const { rows } = await q('SELECT current_schema() AS s');
    assert.match(rows[0].s, /^test_migration_[0-9a-f]+$/, 'fora do schema temporário');
  });

  test('a janela vem da configuração: 45 s', () => {
    assert.equal(JANELA_ESCRITA_MINIMA_SEGUNDOS, 45);
  });

  describe('dentro da janela não regrava', () => {
    test('J1 (DEP-H01, firme) — estado registrado NULL e contato de 20 s: não regrava, não gera evento, o estado continua nulo', async () => {
      const t = await tablet({ contatoAtras: 20 });
      const antes = await linha(t);
      assert.deepEqual(await servico.registrarContato(pool, ids(t)), { gravou: false, restabelecido: false });
      const depois = await linha(t);
      assert.equal(depois.versao, antes.versao, 'a linha não foi regravada');
      assert.equal(ms(depois.ultimo_contato_em), ms(antes.ultimo_contato_em));
      assert.equal(depois.comunicacao_registrada, null);
      assert.deepEqual(await tipos(t), []);
    });

    test('J2 — estado ONLINE: 44 s não regrava', async () => {
      const t = await tablet({ contatoAtras: 44, registrada: 'ONLINE' });
      const antes = await linha(t);
      assert.equal((await servico.registrarContato(pool, ids(t))).gravou, false);
      assert.equal((await linha(t)).versao, antes.versao);
    });
  });

  describe('limite exato da janela (mesma transação: now() idêntico)', () => {
    async function naTransacao(segundosAtras, esperado) {
      const t = await tablet({ contatoAtras: 1000, registrada: 'ONLINE' });
      const a = await pool.connect();
      try {
        await a.query('BEGIN');
        await a.query('UPDATE token_dispositivos SET ultimo_contato_em = now() - make_interval(secs => $2::float8) WHERE id = $1', [t.id, segundosAtras]);
        await repo.travarParaContato(a, ids(t));
        const gravou = await repo.gravarContato(a, { ...ids(t), janelaSegundos: JANELA_ESCRITA_MINIMA_SEGUNDOS });
        const { rows } = await a.query('SELECT ultimo_contato_em = now() AS agora FROM token_dispositivos WHERE id = $1', [t.id]);
        await a.query('COMMIT');
        assert.equal(gravou, esperado, `${segundosAtras} s`);
        assert.equal(rows[0].agora, esperado, 'o contato só vira now() quando gravou');
      } catch (erro) {
        await a.query('ROLLBACK').catch(() => {});
        throw erro;
      } finally { a.release(); }
    }
    test('J3 — exatamente 45 s: grava (a partir de 45 s, inclusive); 44,999 s: não grava', async () => {
      await naTransacao(45, true);
      await naTransacao(44.999, false);
    });
  });

  describe('depois da janela grava', () => {
    test('J4 — estado ONLINE e 46 s: grava, contato avança, estado ONLINE, sem evento', async () => {
      const t = await tablet({ contatoAtras: 46, registrada: 'ONLINE' });
      const antes = await linha(t);
      assert.equal((await servico.registrarContato(pool, ids(t))).gravou, true);
      const depois = await linha(t);
      assert.ok(depois.ultimo_contato_em > antes.ultimo_contato_em);
      assert.equal(depois.comunicacao_registrada, 'ONLINE');
      assert.deepEqual(await tipos(t), []);
    });

    test('J5 — estado NULL com contato velho (50 s): a janela vencida grava e o estado passa a ONLINE; NULL não contorna a janela, não a impede', async () => {
      const t = await tablet({ contatoAtras: 50, registrada: null });
      assert.equal((await servico.registrarContato(pool, ids(t))).gravou, true);
      const l = await linha(t);
      assert.equal(l.comunicacao_registrada, 'ONLINE');
      assert.deepEqual(await tipos(t), []);
    });

    test('J8 — primeiro contato válido (contato nulo): grava, estado ONLINE, sem evento', async () => {
      const t = await tablet({ contatoAtras: null, registrada: null });
      assert.deepEqual(await servico.registrarContato(pool, ids(t)), { gravou: true, restabelecido: false });
      const l = await linha(t);
      assert.ok(l.ultimo_contato_em instanceof Date);
      assert.equal(l.comunicacao_registrada, 'ONLINE');
      assert.deepEqual(await tipos(t), []);
    });
  });

  describe('estado formalmente OFFLINE', () => {
    test('J7 — contato de 5 s e estado OFFLINE: grava IMEDIATAMENTE, UM RESTABELECIMENTO com o silêncio real, estado ONLINE', async () => {
      const t = await tablet({ contatoAtras: 5, registrada: 'OFFLINE' });
      const antes = await linha(t);
      assert.deepEqual(await servico.registrarContato(pool, ids(t)), { gravou: true, restabelecido: true });
      const depois = await linha(t);
      assert.ok(depois.ultimo_contato_em > antes.ultimo_contato_em);
      assert.equal(depois.comunicacao_registrada, 'ONLINE');
      const eventos = (await q('SELECT * FROM token_dispositivo_eventos WHERE dispositivo_id = $1', [t.id])).rows;
      assert.deepEqual(eventos.map((e) => e.tipo), ['RESTABELECIMENTO']);
      assert.equal(eventos[0].empresa_id, t.empresaId);
      assert.ok(Number.isInteger(eventos[0].duracao_segundos) && eventos[0].duracao_segundos >= 4 && eventos[0].duracao_segundos <= 20, `duração ${eventos[0].duracao_segundos}`);
      assert.deepEqual(await servico.registrarContato(pool, ids(t)), { gravou: false, restabelecido: false }, 'a batida seguinte não repete');
      assert.equal((await tipos(t)).length, 1);
    });
  });

  describe('suspeita pendente', () => {
    test('J9 — contato recente (10 s) e suspeita pendente: a suspeita é cancelada SEM regravar o contato nem o estado, sem evento', async () => {
      const t = await tablet({ contatoAtras: 10, registrada: 'ONLINE', suspeitaAtras: 5 });
      const antes = await linha(t);
      assert.equal((await servico.registrarContato(pool, ids(t))).restabelecido, false);
      const depois = await linha(t);
      assert.equal(depois.queda_suspeita_desde, null, 'suspeita cancelada');
      assert.equal(ms(depois.ultimo_contato_em), ms(antes.ultimo_contato_em), 'o contato não foi alterado artificialmente');
      assert.equal(depois.comunicacao_registrada, 'ONLINE');
      assert.ok(await aposEstrito(depois.atualizado_us, antes.atualizado_us), 'o gatilho atualizado_em age no cancelamento (ordem estrita no PostgreSQL, em microssegundos)');
      assert.deepEqual(await tipos(t), []);
    });

    test('J10 — contato velho e suspeita pendente: a batida grava o contato novo e cancela a suspeita', async () => {
      const t = await tablet({ contatoAtras: 400, registrada: 'ONLINE', suspeitaAtras: 100 });
      const antes = await linha(t);
      assert.equal((await servico.registrarContato(pool, ids(t))).gravou, true);
      const depois = await linha(t);
      assert.equal(depois.queda_suspeita_desde, null);
      assert.ok(depois.ultimo_contato_em > antes.ultimo_contato_em);
      assert.deepEqual(await tipos(t), []);
    });
  });

  describe('batidas simultâneas (barreira determinística)', () => {
    async function simultaneas(t, quantidade) {
      const a = await pool.connect();
      try {
        await a.query('BEGIN');
        await a.query('SELECT id FROM token_dispositivos WHERE id = $1 FOR UPDATE', [t.id]);
        const batidas = Array.from({ length: quantidade }, () => servico.registrarContato(pool, ids(t)));
        await aguardarEsperas(quantidade);
        await a.query('ROLLBACK');
        return await Promise.all(batidas);
      } finally {
        await a.query('ROLLBACK').catch(() => {});
        a.release();
      }
    }

    test('J11a — cinco batidas sobre ONLINE com suspeita e contato recente: uma só escreve (cancela a suspeita), contato inalterado, nenhum evento', async () => {
      const t = await tablet({ contatoAtras: 10, registrada: 'ONLINE', suspeitaAtras: 5 });
      const antes = await linha(t);
      const resultados = await simultaneas(t, 5);
      assert.equal(resultados.filter((r) => r.gravou).length, 1);
      assert.equal(resultados.filter((r) => r.restabelecido).length, 0);
      const depois = await linha(t);
      assert.equal(depois.queda_suspeita_desde, null);
      assert.equal(ms(depois.ultimo_contato_em), ms(antes.ultimo_contato_em));
      assert.deepEqual(await tipos(t), []);
    });

    test('J11b — cinco batidas sobre OFFLINE com contato recente: exatamente UM RESTABELECIMENTO e uma só escrita', async () => {
      const t = await tablet({ contatoAtras: 5, registrada: 'OFFLINE' });
      const resultados = await simultaneas(t, 5);
      assert.equal(resultados.filter((r) => r.restabelecido).length, 1);
      assert.equal(resultados.filter((r) => r.gravou).length, 1);
      assert.deepEqual(await tipos(t), ['RESTABELECIMENTO']);
      assert.equal((await linha(t)).comunicacao_registrada, 'ONLINE');
    });
  });

  describe('isolamento', () => {
    test('J12 — a batida com a empresa errada não toca o tablet de outra empresa (inclusive com suspeita e OFFLINE)', async () => {
      const t = await tablet({ contatoAtras: 5, registrada: 'OFFLINE', suspeitaAtras: null });
      const antes = JSON.stringify(await linha(t));
      const errado = { empresaId: d.empresaB, dispositivoId: t.id };
      assert.equal((await servico.registrarContato(pool, errado)).gravou, false);
      assert.equal(await repo.gravarContato(pool, { ...errado, janelaSegundos: 45 }), false);
      assert.equal(JSON.stringify(await linha(t)), antes);
    });
  });
});
