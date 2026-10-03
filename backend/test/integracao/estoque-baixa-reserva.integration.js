'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations, criarLote } = require('./helpers/entrega-epi');
const { montarMundoDoServico, esperarHttpError, chaveNova, aguardarTravaAdvisoryPendente } = require('./helpers/solicitacao-epi-servico');
const { criarFerramentas } = require('./helpers/reserva-estoque');
const parRepo = require('../../src/repositories/estoque-par.repository');

/**
 * Baixa de estoque e reserva lógica (12C-3) contra PostgreSQL real.
 *
 * EVENTO FÍSICO (CA vencido, avaria, descarte, perda, ajuste de inventário):
 * a realidade física é sempre registrada, mesmo quando reduz a cobertura de
 * solicitações aprovadas; só valem o saldo do lote, a idempotência e a
 * integridade. ATO DISCRICIONÁRIO (devolução ao fornecedor, outro): não pode
 * consumir o comprometido, e a quantidade que não participa de U (lote com CA
 * vencido ou ausente, material inativo) não está sob essa proteção, pela mesma
 * regra de "utilizável" da posição de estoque. A posição antes e depois e
 * reduziuCobertura (o comprometido caiu) vão para a auditoria ESTOQUE_BAIXA.
 */

describe('baixa de estoque e reserva lógica — PostgreSQL real', () => {
  let contexto;
  let pool;
  let d;
  let f;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
    f = criarFerramentas(pool, d);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  const operacoesDeBaixa = async (loteId) => (await pool.query("SELECT count(*)::int AS n FROM estoque_operacoes WHERE tipo = 'BAIXA' AND lote_id = $1", [loteId])).rows[0].n;

  describe('evento físico: a realidade não se recusa', () => {
    test('CASO C: U2 D2 C2 L0, PERDA 1 passa; depois U1 D2 C1 G1, auditado com reduziuCobertura verdadeiro e a posição antes e depois', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 2);
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0]);
      const r = await f.baixa(loteId, 1, 'PERDA');
      assert.equal(r.repetida, false);
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 2, 1, 0, 1]);
      const [auditoria] = await f.baixasAuditadas(loteId);
      assert.equal(auditoria.reduziuCobertura, true);
      assert.deepEqual(auditoria.posicaoAntes, { fisicoUtilizavel: 2, demandaPendente: 2, comprometido: 2, saldoLivre: 0, semCobertura: 0 });
      assert.deepEqual(auditoria.posicaoDepois, { fisicoUtilizavel: 1, demandaPendente: 2, comprometido: 1, saldoLivre: 0, semCobertura: 1 });
      assert.deepEqual([auditoria.materialId, auditoria.tamanho, auditoria.motivo, auditoria.quantidade], [m, '40', 'PERDA', 1]);
    });

    test('CASO H: U10 D2 C2, AVARIA 1: a cobertura continua 2 e reduziuCobertura é falso', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 10);
      await f.baixa(loteId, 1, 'AVARIA');
      assert.deepEqual(f.numeros(await f.posicao(m)), [9, 2, 2, 7, 0]);
      const [auditoria] = await f.baixasAuditadas(loteId);
      assert.equal(auditoria.reduziuCobertura, false);
      assert.deepEqual([auditoria.posicaoAntes.comprometido, auditoria.posicaoDepois.comprometido], [2, 2]);
    });

    test('CASO I: U2 D2 C2, AVARIA 1: a cobertura cai de 2 para 1 e reduziuCobertura é verdadeiro', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 2);
      await f.baixa(loteId, 1, 'AVARIA');
      const [auditoria] = await f.baixasAuditadas(loteId);
      assert.equal(auditoria.reduziuCobertura, true);
      assert.deepEqual([auditoria.posicaoAntes.comprometido, auditoria.posicaoDepois.comprometido], [2, 1]);
    });

    test('os cinco eventos físicos passam com L0, até zerar o lote, e nunca geram auditoria de recusa', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 5 });
      const loteId = await f.estoque(m, 5);
      for (const motivo of ['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO']) {
        assert.equal((await f.baixa(loteId, 1, motivo)).repetida, false, motivo);
      }
      assert.deepEqual(await f.lote(loteId), { entrada: 5, baixada: 5, entregue: 0, saldo: 0 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [0, 5, 0, 0, 5]);
      assert.deepEqual(await f.recusas(m), []);
    });

    test('o evento físico continua respeitando o saldo do lote (SALDO_LOTE_INSUFICIENTE) e nada mais', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 1 });
      const loteId = await f.estoque(m, 2);
      await esperarHttpError(f.baixa(loteId, 3, 'PERDA'), 409, 'SALDO_LOTE_INSUFICIENTE');
      assert.equal(await operacoesDeBaixa(loteId), 0);
      assert.deepEqual(await f.recusas(m), [], 'saldo do lote não é saldo livre');
    });
  });

  describe('ato discricionário: não consome o comprometido', () => {
    test('CASO D: U2 D2 L0, OUTRO 1 é 409 SALDO_LIVRE_INSUFICIENTE; nada é baixado nem auditado como baixa, e a recusa é auditada', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 2);
      await esperarHttpError(f.baixa(loteId, 1, 'OUTRO'), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 0, entregue: 0, saldo: 2 });
      assert.equal(await operacoesDeBaixa(loteId), 0);
      assert.deepEqual(await f.baixasAuditadas(loteId), []);
      const [recusa] = await f.recusas(m);
      assert.deepEqual(recusa.contexto, {
        operacao: 'BAIXA', materialId: m, tamanho: '40', loteId, motivo: 'OUTRO', quantidadeSolicitada: 1, fisicoUtilizavel: 2, demandaPendente: 2, comprometido: 2, saldoLivre: 0,
      });
      assert.equal(recusa.referencia, `BAIXA:${m}:40`);
      assert.doesNotMatch(JSON.stringify(recusa), /Doação autorizada|Navegador/, 'a justificativa e o dispositivo do operador não vão para a auditoria da recusa');
    });

    test('CASO E: U5 D2 L3, DEVOLUCAO_FORNECEDOR 3 passa; reduziuCobertura falso e U2 D2 C2 L0 depois', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 5);
      assert.equal((await f.baixa(loteId, 3, 'DEVOLUCAO_FORNECEDOR')).repetida, false);
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0]);
      assert.equal((await f.baixasAuditadas(loteId))[0].reduziuCobertura, false);
    });

    test('CASO F: U5 D2 L3, DEVOLUCAO_FORNECEDOR 4 é 409 SALDO_LIVRE_INSUFICIENTE', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 5);
      await esperarHttpError(f.baixa(loteId, 4, 'DEVOLUCAO_FORNECEDOR'), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.deepEqual(f.numeros(await f.posicao(m)), [5, 2, 2, 3, 0]);
    });

    test('sem demanda não há reserva: OUTRO leva o físico utilizável inteiro', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 4);
      assert.equal((await f.baixa(loteId, 4, 'OUTRO')).repetida, false);
      assert.deepEqual(await f.recusas(m), []);
    });
  });

  describe('CASO G: o que não participa de U não está sob a reserva', () => {
    test('lote com CA vencido (saldo inicial migrado): OUTRO e DEVOLUCAO_FORNECEDOR passam mesmo com o par em L0, e a cobertura não muda', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const bom = await f.estoque(m, 2);
      const vencido = await criarLote(pool, { empresaId: d.empresaA, materialId: m, quantidade: 4, caNumero: '9', caValidade: '2020-01-01' });
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0], 'o lote vencido não entra em U');
      assert.equal((await f.baixa(vencido, 2, 'OUTRO')).repetida, false);
      assert.equal((await f.baixa(vencido, 2, 'DEVOLUCAO_FORNECEDOR')).repetida, false);
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0]);
      assert.equal((await f.baixasAuditadas(vencido))[0].reduziuCobertura, false);
      await esperarHttpError(f.baixa(bom, 1, 'OUTRO'), 409, 'SALDO_LIVRE_INSUFICIENTE');
    });

    test('lote sem CA (saldo inicial) de material que exige CA: mesma regra do lote vencido', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 1 });
      await f.estoque(m, 1);
      const semCa = await criarLote(pool, { empresaId: d.empresaA, materialId: m, quantidade: 3, caNumero: null, caValidade: null });
      assert.equal((await f.baixa(semCa, 3, 'OUTRO')).repetida, false);
    });

    test('material inativo: U e D são zero, e a baixa discricionária do estoque físico que existe passa', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 2);
      await pool.query('UPDATE materiais SET ativo = false WHERE id = $1', [m]);
      assert.deepEqual(f.numeros(await f.posicao(m)), [0, 0, 0, 0, 0]);
      assert.equal((await f.baixa(loteId, 2, 'OUTRO')).repetida, false);
      assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 2, entregue: 0, saldo: 0 });
    });

    test('material que exige CA com lote válido participa de U: o mesmo OUTRO é recusado', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 2);
      await esperarHttpError(f.baixa(loteId, 1, 'OUTRO'), 409, 'SALDO_LIVRE_INSUFICIENTE');
    });
  });

  describe('idempotência e auditoria', () => {
    test('a repetição da mesma chave devolve a baixa original sem reconferir a reserva e sem auditar de novo', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 5);
      const chaveIdempotencia = chaveNova();
      const original = await f.baixa(loteId, 3, 'OUTRO', { chaveIdempotencia });
      await f.aprovada({ materialId: m, quantidade: 2 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0]);
      const repetida = await f.baixa(loteId, 3, 'OUTRO', { chaveIdempotencia });
      assert.deepEqual([repetida.repetida, repetida.operacao.id], [true, original.operacao.id]);
      assert.equal(await operacoesDeBaixa(loteId), 1);
      assert.equal((await f.baixasAuditadas(loteId)).length, 1);
    });

    test('a auditoria da baixa traz materialId e tamanho do lote, motivo e quantidade, além da posição', async () => {
      const m = await f.material({ exigeTamanho: false });
      const loteId = await f.estoque(m, 3, { tamanho: null });
      await f.baixa(loteId, 1, 'DESCARTE');
      const [auditoria] = await f.baixasAuditadas(loteId);
      assert.deepEqual([auditoria.materialId, auditoria.tamanho, auditoria.motivo, auditoria.quantidade], [m, null, 'DESCARTE', 1]);
      assert.deepEqual(auditoria.posicaoAntes, { fisicoUtilizavel: 3, demandaPendente: 0, comprometido: 0, saldoLivre: 3, semCobertura: 0 });
    });
  });

  describe('ordem de locks da baixa: idempotência, material, par, lote', () => {
    test('a baixa espera a trava do par e só então toma o lote: com o par travado por outra transação, nada é gravado até liberar', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 3);
      const segurando = await pool.connect();
      try {
        await segurando.query('BEGIN');
        await parRepo.travarPares(segurando, d.empresaA, [{ materialId: m, tamanho: '40' }]);
        const espera = f.baixa(loteId, 1, 'AVARIA');
        await aguardarTravaAdvisoryPendente(pool);
        assert.equal(await operacoesDeBaixa(loteId), 0);
        await segurando.query('COMMIT');
        await espera;
        assert.equal(await operacoesDeBaixa(loteId), 1);
      } finally {
        await segurando.query('ROLLBACK').catch(() => {});
        segurando.release();
      }
    });

    test('a baixa não segura o lote enquanto espera o par: quem precisa só do lote não fica bloqueado por ela', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 3);
      const segurando = await pool.connect();
      try {
        await segurando.query('BEGIN');
        await parRepo.travarPares(segurando, d.empresaA, [{ materialId: m, tamanho: '40' }]);
        const espera = f.baixa(loteId, 1, 'AVARIA');
        await aguardarTravaAdvisoryPendente(pool);
        const outra = await pool.connect();
        try {
          await outra.query('BEGIN');
          await outra.query("SET LOCAL lock_timeout = '1500ms'");
          await outra.query('SELECT 1 FROM estoque_lotes WHERE id = $1 FOR UPDATE', [loteId]);
          await outra.query('COMMIT');
        } finally {
          await outra.query('ROLLBACK').catch(() => {});
          outra.release();
        }
        await segurando.query('COMMIT');
        await espera;
      } finally {
        await segurando.query('ROLLBACK').catch(() => {});
        segurando.release();
      }
    });
  });
});
