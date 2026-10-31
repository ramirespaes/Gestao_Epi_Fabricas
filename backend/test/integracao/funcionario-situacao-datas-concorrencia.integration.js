'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteSituacaoDatas } = require('./helpers/ambiente-funcionario-situacao-datas');

/**
 * Datas efetivas da situação — atomicidade e concorrência (RED; PostgreSQL real). NÃO EXECUTADO na rodada do RED por restrição
 * operacional (sem PostgreSQL).
 *
 * Atomicidade: a atualização da situação, a linha de histórico e a auditoria são uma transação só; falha em qualquer ponto
 * (induzida por gatilho de teste) desfaz as três e a rota responde 500 sem alterar nada.
 * Concorrência: a trava do funcionário (FOR UPDATE) exclui a entrega (FOR NO KEY UPDATE); a checagem de entregas é feita DEPOIS
 * da trava, então uma entrega confirmada antes da mudança é sempre vista. Sincronização por pg_blocking_pids, sem sleeps cegos.
 */

const ROTA = (id) => `/api/funcionarios/${id}/situacao`;

describe('situação — atomicidade e concorrência (PostgreSQL)', () => {
  let amb;
  before(async () => { amb = await montarAmbienteSituacaoDatas(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const master = () => amb.usuarios.master;
  const mudar = (id, corpo) => amb.como(master()).post(ROTA(id), corpo);

  describe('atomicidade', () => {
    async function comGatilho(tabela, condicao, fn) {
      const sufixo = `${tabela}_${Math.random().toString(36).slice(2, 8)}`;
      await amb.pool.query(`CREATE FUNCTION falha_${sufixo}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF ${condicao} THEN RAISE EXCEPTION 'falha induzida pelo teste'; END IF; RETURN NEW; END $$`);
      await amb.pool.query(`CREATE TRIGGER trg_falha_${sufixo} BEFORE INSERT ON ${tabela} FOR EACH ROW EXECUTE FUNCTION falha_${sufixo}()`);
      try {
        await fn();
      } finally {
        await amb.pool.query(`DROP TRIGGER IF EXISTS trg_falha_${sufixo} ON ${tabela}`);
        await amb.pool.query(`DROP FUNCTION IF EXISTS falha_${sufixo}()`);
      }
    }

    test('falha ao gravar a linha de histórico: 500, situação intacta, nenhuma auditoria de sucesso', async () => {
      const id = await amb.trabalhador();
      const antes = await amb.ler(id);
      await comGatilho('funcionario_situacoes', 'true', async () => {
        const r = await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' });
        assert.equal(r.status, 500, 'a falha do histórico deveria derrubar a operação');
      });
      assert.deepEqual(await amb.ler(id), antes);
      assert.deepEqual(await amb.historico(id), []);
      assert.deepEqual(await amb.acoes(id), []);
    });

    test('falha na auditoria: 500, nenhuma linha de histórico e a situação não muda', async () => {
      const id = await amb.trabalhador();
      const antes = await amb.ler(id);
      await comGatilho('logs_auditoria', "NEW.acao = 'FUNCIONARIO_SITUACAO_ALTERADA'", async () => {
        const r = await mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
        assert.equal(r.status, 500, 'a falha da auditoria deveria derrubar a operação');
      });
      assert.deepEqual(await amb.ler(id), antes);
      assert.deepEqual(await amb.historico(id), []);
    });

    test('depois das falhas induzidas a mesma operação funciona normalmente (nada ficou preso)', async () => {
      const id = await amb.trabalhador();
      const r = await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await amb.historico(id)).length, 1);
    });
  });

  describe('concorrência', () => {
    async function esperarBloqueioPor(pid) {
      for (let i = 0; i < 100; i += 1) {
        const { rows } = await amb.pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[$1::int]', [pid]);
        if (rows[0].n > 0) return;
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      throw new Error('a mudança de situação não ficou esperando a trava do funcionário');
    }

    /** Segura a trava que uma entrega em andamento seguraria e devolve { cliente, pid }. */
    async function segurarComoEntrega(id) {
      const cliente = await amb.pool.connect();
      await cliente.query('BEGIN');
      await cliente.query('SELECT id FROM funcionarios WHERE id = $1 FOR NO KEY UPDATE', [id]);
      const { rows: [{ pid }] } = await cliente.query('SELECT pg_backend_pid() AS pid');
      return { cliente, pid };
    }

    test('entrega em andamento (trava do funcionário) × desligamento anterior a ela: a mudança espera, vê a entrega confirmada e é recusada com 409', async () => {
      const id = await amb.trabalhador();
      await amb.preparar(id);
      const antes = await amb.ler(id);
      const { cliente, pid } = await segurarComoEntrega(id);
      let liberada = false;
      try {
        const pendente = mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-04' }).then((r) => r);
        await esperarBloqueioPor(pid);
        await amb.entregar(id, '2026-10-05', '12:00:00', cliente); // grava e dá COMMIT na conexão que segurava a trava
        liberada = true;
        const r = await pendente;
        assert.deepEqual([r.status, r.body.codigo], [409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA'], JSON.stringify(r.body));
        assert.equal(r.body.detalhes.entregasPosteriores, 1);
      } finally {
        if (!liberada) await cliente.query('ROLLBACK');
        cliente.release();
      }
      assert.deepEqual(await amb.ler(id), antes);
      assert.deepEqual(await amb.historico(id), []);
    });

    test('a mesma corrida com entrega no MESMO dia da data efetiva: a mudança é aceita depois que a entrega confirma', async () => {
      const id = await amb.trabalhador();
      await amb.preparar(id);
      const { cliente, pid } = await segurarComoEntrega(id);
      let liberada = false;
      try {
        const pendente = mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-05' }).then((r) => r);
        await esperarBloqueioPor(pid);
        await amb.entregar(id, '2026-10-05', '12:00:00', cliente);
        liberada = true;
        const r = await pendente;
        assert.equal(r.status, 200, JSON.stringify(r.body));
      } finally {
        if (!liberada) await cliente.query('ROLLBACK');
        cliente.release();
      }
      assert.equal((await amb.ler(id)).situacao, 'INATIVO');
      assert.equal((await amb.historico(id)).length, 1);
    });

    test('duas mudanças iguais simultâneas: exatamente uma vence (200) e a outra recebe 409 FUNCIONARIO_SITUACAO_IGUAL; uma só linha de histórico', async () => {
      const id = await amb.trabalhador();
      const [a, b] = await Promise.all([
        mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }).then((r) => r),
        mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-02' }).then((r) => r),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409]);
      const perdedora = a.status === 409 ? a : b;
      assert.equal(perdedora.body.codigo, 'FUNCIONARIO_SITUACAO_IGUAL');
      assert.equal((await amb.historico(id)).length, 1);
      assert.deepEqual(await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id).then((l) => l.length), 1);
    });

    test('afastar e desligar ao mesmo tempo: a cadeia anterior → nova do histórico fica consistente com a situação final', async () => {
      for (let rodada = 0; rodada < 5; rodada += 1) {
        const id = await amb.trabalhador();
        const [a, b] = await Promise.all([
          mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' }).then((r) => r),
          mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-02' }).then((r) => r),
        ]);
        const linhas = await amb.historico(id);
        const sucessos = [a, b].filter((r) => r.status === 200).length;
        assert.equal(linhas.length, sucessos, `rodada ${rodada}: uma linha por mudança aceita`);
        let esperadaAnterior = 'ATIVO';
        for (const h of linhas) {
          assert.equal(h.situacao_anterior, esperadaAnterior, `rodada ${rodada}: cadeia quebrada`);
          esperadaAnterior = h.situacao_nova;
        }
        assert.equal((await amb.ler(id)).situacao, linhas.at(-1).situacao_nova);
        for (const r of [a, b].filter((x) => x.status !== 200)) {
          assert.equal(r.status, 409);
          assert.ok(['FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA', 'FUNCIONARIO_SITUACAO_IGUAL', 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA'].includes(r.body.codigo), r.body.codigo);
        }
      }
    });

    test('mudanças de funcionários diferentes não se bloqueiam entre si', async () => {
      const a = await amb.trabalhador();
      const b = await amb.trabalhador();
      const { cliente, pid } = await segurarComoEntrega(a);
      try {
        const r = await mudar(b, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' });
        assert.equal(r.status, 200, 'a trava do funcionário A não pode afetar o B');
        assert.equal(typeof pid, 'number');
      } finally {
        await cliente.query('ROLLBACK');
        cliente.release();
      }
    });
  });
});
