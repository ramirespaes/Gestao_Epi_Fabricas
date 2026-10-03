'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations, erroDe, criarEmpresa, criarUsuario, criarMaterial } = require('./helpers/entrega-epi');
const { esperarHttpError, portao, aguardarEsperaPorTravaDeLinha, comLimite } = require('./helpers/solicitacao-epi-servico');
const materialService = require('../../src/services/material.service');
const loteRepo = require('../../src/repositories/estoque-lote.repository');

/**
 * Troca da classificação de tamanho de um material com mínimos por tamanho
 * (12D-1), em PostgreSQL real: a troca de "exige tamanho" para outra coisa é
 * recusada com 409 de domínio enquanto houver mínimo próprio, e nunca apaga
 * configuração. A troca (FOR UPDATE do material) e a gravação do mínimo
 * (o gatilho lê o material FOR SHARE) se serializam pela trava de linha do
 * material, em qualquer ordem de chegada.
 */

const repo = () => exigirModulo('src/repositories/estoque-minimo.repository');
const RODADAS = Number.parseInt(process.env.RODADAS_MINIMOS ?? '4', 10);
const MINIMOS = 'MATERIAL_TAMANHO_MINIMOS_INCOMPATIVEIS';

describe('troca de exige_tamanho com mínimos por tamanho — PostgreSQL real', () => {
  let contexto;
  let pool;
  let empresaId;
  let atorId;
  let n = 0;

  const q = (sql, params) => pool.query(sql, params);
  const novoMaterial = async (exigeTamanho = true) => { n += 1; return criarMaterial(pool, empresaId, `Luva ${n}`, { exigeTamanho }); };
  const trocar = (materialId, exigeTamanho) => materialService.alterar(pool, { empresaId, atorId, materialId, exigeTamanho });
  const classificacao = async (materialId) => (await q('SELECT exige_tamanho FROM materiais WHERE id = $1', [materialId])).rows[0].exige_tamanho;
  const auditorias = async (materialId) => (await q('SELECT count(*)::int AS n FROM logs_auditoria WHERE referencia = $1', [String(materialId)])).rows[0].n;

  before(async () => {
    exigirModulo('src/repositories/estoque-minimo.repository');
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    empresaId = await criarEmpresa(pool, '11222333000181', 'Empresa A');
    atorId = await criarUsuario(pool, empresaId, 'master@example.invalid');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('o serviço, sem concorrência', () => {
    test('true para false com mínimo próprio: 409 de domínio; o material não muda, o mínimo fica e nada é auditado', async () => {
      const m = await novoMaterial(true);
      await repo().definir(pool, empresaId, { materialId: m, tamanho: 'P', minimo: 10 });
      await repo().definir(pool, empresaId, { materialId: m, tamanho: 'M', minimo: 30 });
      const antes = await auditorias(m);
      await esperarHttpError(trocar(m, false), 409, MINIMOS);
      assert.equal(await classificacao(m), true);
      assert.deepEqual((await repo().listarPorMaterial(pool, empresaId, m)).map((x) => [x.tamanho, x.minimo]), [['M', 30], ['P', 10]], 'nenhuma configuração foi apagada');
      assert.equal(await auditorias(m), antes, 'a recusa não deixa rastro de alteração');
    });

    test('a mensagem pública é de domínio, sem tabela nem erro técnico do banco', async () => {
      const m = await novoMaterial(true);
      await repo().definir(pool, empresaId, { materialId: m, tamanho: 'P', minimo: 10 });
      await assert.rejects(trocar(m, false), (erro) => {
        assert.deepEqual([erro.status, erro.codigo], [409, MINIMOS]);
        assert.match(erro.message, /mínimos? por tamanho/i);
        assert.doesNotMatch(JSON.stringify(erro.corpoResposta()), /estoque_minimos|trigger|gatilho|P0001|constraint/i);
        return true;
      });
    });

    test('removidos os mínimos, a troca passa; um mínimo de outro material não atrapalha', async () => {
      const m = await novoMaterial(true);
      const outro = await novoMaterial(true);
      await repo().definir(pool, empresaId, { materialId: outro, tamanho: 'P', minimo: 3 });
      await repo().definir(pool, empresaId, { materialId: m, tamanho: 'P', minimo: 10 });
      await esperarHttpError(trocar(m, false), 409, MINIMOS);
      await repo().remover(pool, empresaId, m, 'P');
      assert.equal((await trocar(m, false)).exigeTamanho, false);
      assert.equal(await classificacao(m), false);
      assert.equal(await repo().possuiOverrides(pool, empresaId, outro), true, 'o do outro material ficou intacto');
    });

    test('sem mínimos próprios: true para false, false para true e a primeira classificação do legado (NULL) continuam livres', async () => {
      const a = await novoMaterial(true);
      assert.equal((await trocar(a, false)).exigeTamanho, false);
      assert.equal((await trocar(a, true)).exigeTamanho, true);
      const legado = await novoMaterial(null);
      assert.equal((await trocar(legado, true)).exigeTamanho, true);
    });

    test('depois da troca (false), a tabela passa a recusar mínimo do material, pelo próprio gatilho', async () => {
      const m = await novoMaterial(true);
      await trocar(m, false);
      assert.equal((await erroDe(repo().definir(pool, empresaId, { materialId: m, tamanho: 'P', minimo: 1 })))?.code, 'P0001');
    });
  });

  describe('concorrência: a troca e a gravação do mínimo se serializam pela trava do material', () => {
    test('o mínimo chegou primeiro: a troca espera, vê o mínimo e é recusada (409); o mínimo e a classificação ficam como estavam', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await novoMaterial(true);
        const gravando = await pool.connect();
        try {
          await gravando.query('BEGIN');
          await repo().definir(gravando, empresaId, { materialId: m, tamanho: 'P', minimo: 10 });
          const troca = trocar(m, false);
          const resultado = troca.then(() => ({ ok: true }), (erro) => ({ ok: false, status: erro.status, codigo: erro.codigo }));
          await aguardarEsperaPorTravaDeLinha(pool);
          await gravando.query('COMMIT');
          assert.deepEqual(await comLimite(resultado, `troca ${rodada}`, 10000), { ok: false, status: 409, codigo: MINIMOS }, `rodada ${rodada}`);
        } finally {
          await gravando.query('ROLLBACK').catch(() => {});
          gravando.release();
        }
        assert.equal(await classificacao(m), true);
        assert.equal(await repo().possuiOverrides(pool, empresaId, m), true);
      }
    });

    test('a troca chegou primeiro: a gravação do mínimo espera e, depois da troca, é recusada pelo gatilho; nunca sobra mínimo em material sem tamanho', async (t) => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await novoMaterial(true);
        const { liberar, chegada } = portao(t, loteRepo, 'possuiSaldoIncompativel');
        const troca = trocar(m, false);
        await chegada; // o material já está travado FOR UPDATE, a troca ainda não gravou
        const gravacao = erroDe(repo().definir(pool, empresaId, { materialId: m, tamanho: 'P', minimo: 10 }));
        await aguardarEsperaPorTravaDeLinha(pool);
        liberar();
        assert.equal((await comLimite(troca, `troca ${rodada}`, 10000)).exigeTamanho, false);
        const erro = await comLimite(gravacao, `gravação ${rodada}`, 10000);
        assert.equal(erro?.code, 'P0001', `rodada ${rodada}: o mínimo foi recusado depois da troca`);
        assert.equal(await classificacao(m), false);
        assert.equal(await repo().possuiOverrides(pool, empresaId, m), false, 'nenhum mínimo em material que não usa tamanho');
        t.mock.restoreAll();
      }
    });

    test('várias trocas e gravações simultâneas do mesmo material: o resultado final nunca mistura (sem mínimo em material sem tamanho)', async () => {
      for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
        const m = await novoMaterial(true);
        const tarefas = [
          () => trocar(m, false),
          () => repo().definir(pool, empresaId, { materialId: m, tamanho: 'P', minimo: 5 }),
          () => repo().definir(pool, empresaId, { materialId: m, tamanho: 'M', minimo: 7 }),
          () => trocar(m, false),
        ];
        await Promise.all(tarefas.map((tarefa) => comLimite(tarefa().catch(() => null), `rodada ${rodada}`, 15000)));
        const exige = await classificacao(m);
        const temMinimos = await repo().possuiOverrides(pool, empresaId, m);
        assert.equal(exige === false && temMinimos, false, `rodada ${rodada}: classificação ${exige} com mínimos ${temMinimos}`);
      }
    });
  });
});
