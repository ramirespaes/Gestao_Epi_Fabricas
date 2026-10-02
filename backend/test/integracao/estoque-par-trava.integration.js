'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Trava do par (empresa, material, tamanho) com PostgreSQL real e conexões
 * distintas: espera, liberação no fim da transação, independência entre
 * pares, ausência de deadlock com a ordem canônica e o uso que ela existe
 * para proteger (conferir o saldo livre e consumi-lo sem que duas
 * transações gastem o mesmo saldo).
 *
 * Advisory lock é do banco inteiro, não do schema: os pares usados aqui só
 * se chocam com este próprio teste, que roda sozinho (concorrência 1).
 */

const par = (materialId, tamanho) => ({ materialId, tamanho });
const EMPRESA = 910001;
const ESPERA_MAXIMA_MS = 3000;

const repo = () => exigirModulo('src/repositories/estoque-par.repository');
const util = () => exigirModulo('src/utils/lock-par-estoque');

// Sem mudar de espera: se a promessa não resolver, o teste falha por tempo em vez de travar o processo.
const comLimite = (promessa, rotulo) => Promise.race([
  promessa,
  new Promise((_, rejeitar) => { setTimeout(() => rejeitar(new Error(`${rotulo}: não resolveu em ${ESPERA_MAXIMA_MS} ms`)), ESPERA_MAXIMA_MS); }),
]);

describe('trava do par — espera e liberação', () => {
  let contexto;
  let clientes;

  const abrir = async () => {
    const c = await contexto.pool.connect();
    clientes.push(c);
    const { rows: [{ pid }] } = await c.query('SELECT pg_backend_pid() AS pid');
    await c.query('BEGIN');
    return { c, pid };
  };

  before(async () => {
    contexto = await abrirPoolTemporario([]);
  });

  after(async () => {
    if (contexto) await contexto.encerrar();
  });

  test('a mesma trava só passa para a segunda transação quando a primeira confirma; a espera é de advisory lock', async () => {
    clientes = [];
    try {
      const um = await abrir();
      const dois = await abrir();
      await repo().travarPares(um.c, EMPRESA, [par(30, '40')]);
      const { rows: [{ n }] } = await contexto.pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = $1 AND granted", [um.pid]);
      assert.equal(n, 1, 'a primeira transação segura exatamente uma trava advisory');

      const segunda = repo().travarPares(dois.c, EMPRESA, [par(30, '40')]);
      const evento = await aguardarEsperaPeloLock(contexto.pool, dois.pid);
      assert.equal(evento, 'advisory');
      await um.c.query('COMMIT');
      await comLimite(segunda, 'segunda trava');
      await dois.c.query('COMMIT');
    } finally {
      await Promise.all(clientes.map((c) => c.query('ROLLBACK').catch(() => {})));
      clientes.forEach((c) => c.release());
    }
  });

  test('a trava é liberada também no ROLLBACK', async () => {
    clientes = [];
    try {
      const um = await abrir();
      const dois = await abrir();
      await repo().travarPares(um.c, EMPRESA, [par(30, '40')]);
      const segunda = repo().travarPares(dois.c, EMPRESA, [par(30, '40')]);
      await aguardarEsperaPeloLock(contexto.pool, dois.pid);
      await um.c.query('ROLLBACK');
      await comLimite(segunda, 'segunda trava depois do rollback');
      await dois.c.query('COMMIT');
    } finally {
      await Promise.all(clientes.map((c) => c.query('ROLLBACK').catch(() => {})));
      clientes.forEach((c) => c.release());
    }
  });

  test('pares diferentes não se bloqueiam: outro tamanho, outro material, tamanho ausente e outra empresa passam na hora', async () => {
    clientes = [];
    try {
      const um = await abrir();
      const outro = await abrir();
      await repo().travarPares(um.c, EMPRESA, [par(30, '40')]);
      for (const livre of [[EMPRESA, par(30, '41')], [EMPRESA, par(31, '40')], [EMPRESA, par(30, null)], [EMPRESA + 1, par(30, '40')]]) {
        await comLimite(repo().travarPares(outro.c, livre[0], [livre[1]]), JSON.stringify(livre));
      }
      await um.c.query('COMMIT');
      await outro.c.query('COMMIT');
    } finally {
      await Promise.all(clientes.map((c) => c.query('ROLLBACK').catch(() => {})));
      clientes.forEach((c) => c.release());
    }
  });

  test('a trava é reentrante na própria transação e cobre vários pares de uma vez', async () => {
    clientes = [];
    try {
      const um = await abrir();
      await repo().travarPares(um.c, EMPRESA, [par(30, '40'), par(31, null)]);
      await comLimite(repo().travarPares(um.c, EMPRESA, [par(31, null), par(30, '40')]), 'reentrada');
      const { rows: [{ n }] } = await contexto.pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = $1 AND granted", [um.pid]);
      assert.equal(n, 2);
      await um.c.query('COMMIT');
    } finally {
      await Promise.all(clientes.map((c) => c.query('ROLLBACK').catch(() => {})));
      clientes.forEach((c) => c.release());
    }
  });
});

describe('trava do par — ordem canônica e deadlock', () => {
  let contexto;

  before(async () => {
    contexto = await abrirPoolTemporario([]);
  });

  after(async () => {
    if (contexto) await contexto.encerrar();
  });

  const mulberry32 = (semente) => () => {
    let t = (semente += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  test('transações simultâneas que travam subconjuntos dos mesmos pares, em ordens de entrada diferentes, terminam todas sem deadlock', async () => {
    const aleatorio = mulberry32(20261002);
    const universo = [par(30, '40'), par(30, '41'), par(30, null), par(31, '40'), par(31, 'M')];
    const embaralhar = (lista) => lista.map((valor) => [aleatorio(), valor]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const execucoes = Array.from({ length: 30 }, () => {
      const escolhidos = embaralhar(universo).slice(0, 2 + Math.floor(aleatorio() * 3));
      return (async () => {
        const c = await contexto.pool.connect();
        try {
          await c.query('BEGIN');
          await repo().travarPares(c, EMPRESA, escolhidos);
          await c.query('SELECT pg_sleep(0.005)');
          await c.query('COMMIT');
          return 'ok';
        } catch (erro) {
          await c.query('ROLLBACK').catch(() => {});
          return erro.code ?? erro.message;
        } finally {
          c.release();
        }
      })();
    });
    const resultados = await Promise.all(execucoes);
    assert.deepEqual([...new Set(resultados)], ['ok'], `resultados: ${resultados.join(',')}`);
  });

  test('controle: sem a ordem canônica, duas transações que pedem os mesmos pares em ordem oposta caem em deadlock (40P01)', async () => {
    const { lockDoPar } = util();
    const a = lockDoPar(EMPRESA, 30, '40');
    const b = lockDoPar(EMPRESA, 31, '40');
    const um = await contexto.pool.connect();
    const dois = await contexto.pool.connect();
    try {
      await um.query('BEGIN');
      await dois.query('BEGIN');
      await um.query('SELECT pg_advisory_xact_lock($1::bigint)', [a]);
      await dois.query('SELECT pg_advisory_xact_lock($1::bigint)', [b]);
      // A derrubada desfaz na hora: enquanto não faz ROLLBACK ela segura a trava e a sobrevivente não termina.
      const pedir = async (cliente, lock) => {
        try {
          await cliente.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
          return 'ok';
        } catch (erro) {
          await cliente.query('ROLLBACK');
          return erro.code;
        }
      };
      const codigos = (await comLimite(Promise.all([pedir(um, b), pedir(dois, a)]), 'deadlock')).sort();
      assert.deepEqual(codigos, ['40P01', 'ok'], 'o PostgreSQL derruba uma das duas');
    } finally {
      await um.query('ROLLBACK').catch(() => {});
      await dois.query('ROLLBACK').catch(() => {});
      um.release();
      dois.release();
    }
  });
});

describe('trava do par — conferir o saldo livre e consumi-lo', () => {
  let contexto;

  before(async () => {
    contexto = await abrirPoolTemporario([]);
    await contexto.pool.query('CREATE TABLE saldo_livre_teste (empresa_id INTEGER, material_id INTEGER, livre INTEGER NOT NULL, PRIMARY KEY (empresa_id, material_id))');
  });

  after(async () => {
    if (contexto) await contexto.encerrar();
  });

  // Conferir e consumir: lê o livre, decide e grava. Sem trava a leitura de uma pode ser anterior à gravação da outra.
  async function consumir({ material, quantidade, travar, pausaEntreLerEGravar = 80 }) {
    const c = await contexto.pool.connect();
    try {
      await c.query('BEGIN');
      if (travar) await repo().travarPares(c, EMPRESA, [par(material, '40')]);
      const { rows: [{ livre }] } = await c.query('SELECT livre FROM saldo_livre_teste WHERE empresa_id = $1 AND material_id = $2', [EMPRESA, material]);
      if (quantidade > livre) {
        await c.query('ROLLBACK');
        return 'recusada';
      }
      await new Promise((resolve) => { setTimeout(resolve, pausaEntreLerEGravar); });
      await c.query('UPDATE saldo_livre_teste SET livre = livre - $3 WHERE empresa_id = $1 AND material_id = $2', [EMPRESA, material, quantidade]);
      await c.query('COMMIT');
      return 'consumida';
    } finally {
      c.release();
    }
  }

  const semear = (material, livre) => contexto.pool.query(
    'INSERT INTO saldo_livre_teste (empresa_id, material_id, livre) VALUES ($1, $2, $3)', [EMPRESA, material, livre],
  );
  const livreDe = async (material) => (await contexto.pool.query('SELECT livre FROM saldo_livre_teste WHERE empresa_id = $1 AND material_id = $2', [EMPRESA, material])).rows[0].livre;

  test('controle: sem a trava, duas consumidoras de 3 e de 2 sobre livre 3 leem o mesmo saldo e as duas passam (o saldo livre é gasto duas vezes)', async () => {
    await semear(1, 3);
    const resultados = await Promise.all([consumir({ material: 1, quantidade: 3, travar: false }), consumir({ material: 1, quantidade: 2, travar: false })]);
    assert.deepEqual(resultados, ['consumida', 'consumida']);
    assert.equal(await livreDe(1), -2, 'saldo livre negativo: exatamente o que a trava evita');
  });

  test('com a trava do par, só uma passa e a outra é recusada sobre o saldo já gasto; o saldo livre não fica negativo', async () => {
    await semear(2, 3);
    const resultados = await Promise.all([consumir({ material: 2, quantidade: 3, travar: true }), consumir({ material: 2, quantidade: 2, travar: true })]);
    assert.deepEqual([...resultados].sort(), ['consumida', 'recusada']);
    assert.ok(await livreDe(2) >= 0);
  });

  test('em volume: trinta consumidoras de 1 sobre livre 10 geram exatamente dez consumos e vinte recusas', async () => {
    await semear(3, 10);
    const resultados = await Promise.all(Array.from({ length: 30 }, () => consumir({ material: 3, quantidade: 1, travar: true, pausaEntreLerEGravar: 2 })));
    assert.equal(resultados.filter((r) => r === 'consumida').length, 10);
    assert.equal(resultados.filter((r) => r === 'recusada').length, 20);
    assert.equal(await livreDe(3), 0);
  });
});
