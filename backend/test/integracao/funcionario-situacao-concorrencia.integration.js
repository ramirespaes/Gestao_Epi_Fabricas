'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteSituacao } = require('./helpers/ambiente-funcionario-situacao');

/**
 * S2 (RED) — concorrência da mudança de situação, em PostgreSQL real com conexões independentes.
 *
 * A transição é validada sobre o registro TRAVADO (FOR UPDATE), nunca sobre uma leitura anterior:
 *   1. outra transação segura a linha do funcionário e muda a situação por fora; a rota espera pela trava
 *      (observável em pg_stat_activity) e, ao liberar, avalia a transição sobre o estado NOVO;
 *   2. duas requisições simultâneas para a mesma situação: exatamente uma vence, a outra é 409 FUNCIONARIO_SITUACAO_IGUAL,
 *      e há uma só linha de auditoria.
 *
 * A rota ainda não existe: as falhas são de comportamento ausente (a rota não espera nem decide), não de harness.
 */

const ROTA = (id) => `/api/funcionarios/${id}/situacao`;
const dormir = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Espera, sem lançar erro, uma consulta bloqueada por trava de linha sobre `funcionarios`.
async function esperouPorTravaDeLinha(pool, { tentativas = 150, intervaloMs = 20 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    const { rows: [{ n }] } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple') AND query ILIKE '%funcionarios%'`,
    );
    if (n > 0) return true;
    await dormir(intervaloMs);
  }
  return false;
}

describe('S2 — concorrência da situação do funcionário', () => {
  let amb;
  before(async () => { amb = await montarAmbienteSituacao(); });
  after(async () => { if (amb) await amb.encerrar(); });

  test('a rota espera a trava da linha e decide sobre o estado já confirmado por outra transação', async () => {
    const id = await amb.trabalhador('ATIVO');
    const segurando = await amb.pool.connect();
    let respostaPendente;
    let esperou = false;
    try {
      await segurando.query('BEGIN');
      await segurando.query('SELECT id FROM funcionarios WHERE id = $1 FOR UPDATE', [id]);
      respostaPendente = (async () => amb.como(amb.usuarios.master).post(ROTA(id), { situacao: 'AFASTADO' }))();
      esperou = await esperouPorTravaDeLinha(amb.pool);
      await segurando.query("UPDATE funcionarios SET situacao = 'AFASTADO' WHERE id = $1", [id]);
      await segurando.query('COMMIT');
    } finally {
      await segurando.query('ROLLBACK').catch(() => {});
      segurando.release();
    }
    const resposta = await respostaPendente;
    assert.equal(esperou, true, 'a rota não esperou pela trava de linha do funcionário');
    assert.deepEqual([resposta.status, resposta.body.codigo], [409, 'FUNCIONARIO_SITUACAO_IGUAL']);
    assert.equal((await amb.ler(id)).situacao, 'AFASTADO');
    assert.deepEqual(await amb.eventos(id), [], 'a mudança feita por fora não é da rota: nenhuma auditoria dela');
  });

  test('duas requisições para a mesma situação ao mesmo tempo: uma vence (200), a outra é 409, uma só auditoria', async () => {
    for (let rodada = 0; rodada < 5; rodada += 1) {
      const id = await amb.trabalhador('ATIVO');
      const respostas = await Promise.all([
        amb.como(amb.usuarios.master).post(ROTA(id), { situacao: 'AFASTADO' }),
        amb.como(amb.usuarios.comEditar).post(ROTA(id), { situacao: 'AFASTADO' }),
      ]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 409], `rodada ${rodada}: ${JSON.stringify(respostas.map((r) => r.body))}`);
      assert.equal(respostas.find((r) => r.status === 409).body.codigo, 'FUNCIONARIO_SITUACAO_IGUAL');
      assert.equal((await amb.ler(id)).situacao, 'AFASTADO');
      assert.equal((await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id)).length, 1);
    }
  });

  test('transições encadeadas ao mesmo tempo (AFASTADO e depois INATIVO) respeitam a ordem real: o estado final é válido e cada mudança tem a sua auditoria', async () => {
    const id = await amb.trabalhador('ATIVO');
    const respostas = await Promise.all([
      amb.como(amb.usuarios.master).post(ROTA(id), { situacao: 'AFASTADO' }),
      amb.como(amb.usuarios.comEditar).post(ROTA(id), { situacao: 'INATIVO' }),
    ]);
    for (const r of respostas) assert.ok([200, 409].includes(r.status), JSON.stringify(r.body));
    assert.ok(respostas.some((r) => r.status === 200), 'ao menos uma mudança deveria vencer');
    const final = (await amb.ler(id)).situacao;
    assert.ok(['AFASTADO', 'INATIVO'].includes(final), final);
    const linhas = await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id);
    assert.equal(linhas.length, respostas.filter((r) => r.status === 200).length);
    // Cada linha parte da situação realmente anterior: a cadeia anterior→nova é contínua e termina no estado final.
    let corrente = 'ATIVO';
    for (const linha of linhas) {
      assert.equal(linha.dados_anteriores?.situacao, corrente);
      corrente = linha.dados_novos?.situacao;
    }
    assert.equal(corrente, final);
  });
});
