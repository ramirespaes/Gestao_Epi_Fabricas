'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aguardarEsperaDaTrava, contarBloqueadosPor, corridaSobTravaDoTablet } = require('../integracao/helpers/aguardar-espera-trava');

const nunca = () => new Promise(() => {});
const timersAtivos = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('devolve false assim que a operação passa a esperar a trava', async () => {
  let chamadas = 0;
  const terminou = await aguardarEsperaDaTrava({
    operacao: nunca(),
    contarEsperando: async () => (++chamadas >= 3 ? 1 : 0),
    limiteMs: 1000,
    mensagem: 'não esperou',
  });
  assert.equal(terminou, false);
  assert.equal(chamadas, 3);
});

test('devolve true quando a operação termina sem esperar, sem consultar de novo', async () => {
  let chamadas = 0;
  const terminou = await aguardarEsperaDaTrava({
    operacao: Promise.resolve('ok'),
    contarEsperando: async () => { chamadas += 1; return 0; },
    limiteMs: 1000,
    mensagem: 'não esperou',
  });
  assert.equal(terminou, true);
  assert.ok(chamadas <= 1);
});

test('propaga na hora o erro da operação, sem gastar o limite', async () => {
  const original = new Error('falha da operação');
  const operacao = Promise.reject(original);
  operacao.catch(() => {});
  const inicio = Date.now();
  await assert.rejects(
    aguardarEsperaDaTrava({ operacao, contarEsperando: async () => 0, limiteMs: 5000, mensagem: 'não esperou' }),
    (erro) => erro === original,
  );
  assert.ok(Date.now() - inicio < 1000);
});

test('falha com a mensagem do teste quando nada acontece até o limite', async () => {
  const inicio = Date.now();
  await assert.rejects(
    aguardarEsperaDaTrava({ operacao: nunca(), contarEsperando: async () => 0, limiteMs: 150, mensagem: 'não chegou a esperar' }),
    { code: 'ERR_ASSERTION', message: 'não chegou a esperar' },
  );
  assert.ok(Date.now() - inicio >= 150);
});

test('não fica pendurado quando a consulta de espera nunca responde, e não deixa timer ativo', async () => {
  const antes = timersAtivos();
  const inicio = Date.now();
  await assert.rejects(
    aguardarEsperaDaTrava({ operacao: nunca(), contarEsperando: nunca, limiteMs: 150, mensagem: 'não chegou a esperar' }),
    { code: 'ERR_ASSERTION', message: 'não chegou a esperar' },
  );
  assert.ok(Date.now() - inicio < 1000);
  assert.equal(timersAtivos(), antes);
});

test('propaga na hora o erro da operação mesmo com a consulta de espera pendente', async () => {
  const original = new Error('falha da operação');
  let rejeitar;
  const operacao = new Promise((_, rej) => { rejeitar = rej; });
  operacao.catch(() => {});
  let consultou;
  const consultando = new Promise((resolver) => { consultou = resolver; });
  const inicio = Date.now();
  const espera = aguardarEsperaDaTrava({
    operacao,
    contarEsperando: () => { consultou(); return nunca(); },
    limiteMs: 5000,
    mensagem: 'não esperou',
  });
  await consultando;
  rejeitar(original);
  await assert.rejects(espera, (erro) => erro === original);
  assert.ok(Date.now() - inicio < 1000);
});

test('propaga o erro da própria consulta de espera', async () => {
  const falha = new Error('consulta falhou');
  await assert.rejects(
    aguardarEsperaDaTrava({ operacao: nunca(), contarEsperando: async () => { throw falha; }, limiteMs: 1000, mensagem: 'x' }),
    (erro) => erro === falha,
  );
});

function poolFalso(falharEm) {
  const comandos = [];
  const liberacoes = [];
  const cliente = {
    query: async (sql, parametros) => {
      comandos.push(sql);
      if (falharEm && sql.startsWith(falharEm)) throw new Error(`falhou: ${falharEm}`);
      return { rows: [{ n: parametros ? 2 : 0 }] };
    },
    release: (erro) => liberacoes.push(erro),
  };
  return { pool: { connect: async () => cliente }, comandos, liberacoes };
}

test('contarBloqueadosPor: limita a consulta no servidor dentro de uma transação própria e devolve a conexão sã', async () => {
  const f = poolFalso();
  assert.equal(await contarBloqueadosPor(f.pool, 123), 2);
  assert.deepEqual(f.comandos.map((c) => c.split(' ').slice(0, 2).join(' ')), ['BEGIN', 'SET LOCAL', 'SELECT count(*)::int', 'COMMIT']);
  assert.match(f.comandos[1], /^SET LOCAL statement_timeout = \d+$/);
  assert.deepEqual(f.liberacoes, [undefined]);
});

test('contarBloqueadosPor: com a consulta cancelada, desfaz a transação e descarta a conexão', async () => {
  const f = poolFalso('SELECT');
  await assert.rejects(contarBloqueadosPor(f.pool, 123), /falhou: SELECT/);
  assert.equal(f.comandos.at(-1), 'ROLLBACK');
  assert.equal(f.liberacoes.length, 1);
  assert.ok(f.liberacoes[0] instanceof Error);
});

function poolDaCorrida({ esperando = 1 } = {}) {
  const log = [];
  let conexoes = 0;
  const pool = {
    connect: async () => {
      const concorrente = conexoes++ === 0;
      const anotar = (passo) => { if (concorrente) log.push(passo); };
      return {
        query: async (sql) => {
          anotar(sql.split(' ').slice(0, 2).join(' '));
          if (sql.includes('pg_backend_pid')) return { rows: [{ pid: 7 }] };
          return { rows: [{ n: esperando }] };
        },
        release: () => anotar('release'),
      };
    },
  };
  return { pool, log };
}

test('corridaSobTravaDoTablet: segura a trava, aplica a mudança só com a operação esperando, confirma e devolve a resposta', async () => {
  const { pool, log } = poolDaCorrida();
  let liberar;
  const resposta = await corridaSobTravaDoTablet({
    pool,
    tabletId: 'tab-1',
    disparar: () => new Promise((resolver) => { liberar = resolver; }),
    mudanca: async () => { log.push('mudanca'); liberar('resposta'); },
    limiteMs: 1000,
    naoEsperou: 'deveria esperar',
  });
  assert.equal(resposta, 'resposta');
  assert.deepEqual(log, ['BEGIN', 'SELECT id', 'SELECT pg_backend_pid()', 'mudanca', 'COMMIT', 'release']);
});

test('corridaSobTravaDoTablet: operação que termina sem esperar falha com a mensagem, sem aplicar a mudança, e desfaz a trava', async () => {
  const { pool, log } = poolDaCorrida({ esperando: 0 });
  await assert.rejects(
    corridaSobTravaDoTablet({
      pool, tabletId: 'tab-1', disparar: async () => 'cedo', mudanca: async () => log.push('mudanca'), limiteMs: 1000, naoEsperou: 'deveria esperar',
    }),
    { code: 'ERR_ASSERTION', message: /^deveria esperar/ },
  );
  assert.ok(!log.includes('mudanca'));
  assert.deepEqual(log.slice(-2), ['ROLLBACK', 'release']);
});

test('corridaSobTravaDoTablet: erro da mudança propaga, desfaz a trava e devolve a conexão', async () => {
  const { pool, log } = poolDaCorrida();
  const falha = new Error('mudança falhou');
  const operacao = nunca();
  await assert.rejects(
    corridaSobTravaDoTablet({
      pool, tabletId: 'tab-1', disparar: () => operacao, mudanca: async () => { throw falha; }, limiteMs: 1000, naoEsperou: 'x',
    }),
    (erro) => erro === falha,
  );
  assert.deepEqual(log.slice(-2), ['ROLLBACK', 'release']);
  assert.ok(!log.includes('COMMIT'));
});

test('não deixa timer ativo depois de detectar a espera', async () => {
  const antes = timersAtivos();
  await aguardarEsperaDaTrava({ operacao: nunca(), contarEsperando: async () => 1, limiteMs: 60000, mensagem: 'x' });
  assert.equal(timersAtivos(), antes);
});
