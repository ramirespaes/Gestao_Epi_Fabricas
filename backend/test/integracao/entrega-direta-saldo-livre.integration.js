'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations, criarLote } = require('./helpers/entrega-epi');
const { montarMundoDoServico, esperarHttpError, chaveNova } = require('./helpers/solicitacao-epi-servico');
const { criarFerramentas } = require('./helpers/reserva-estoque');

/**
 * Entrega DIRETA e saldo livre (12C-3) contra PostgreSQL real.
 *
 * Por empresa, material e tamanho: U físico utilizável, D demanda aprovada
 * pendente, C = min(U, D), L = max(0, U − D). A DIRETA só pode usar o livre:
 * a soma do ato por par tem de caber em L, e dividir entre lotes não contorna.
 * Tudo o que não envolve reserva continua como no Bloco 10: sem demanda
 * pendente todo o físico utilizável é livre, e a ordem dos erros do lote
 * (CA, saldo) não muda, porque o saldo livre é conferido depois deles.
 */

describe('entrega DIRETA e saldo livre — PostgreSQL real', () => {
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

  const retrato = async () => (await pool.query(
    `SELECT (SELECT count(*) FROM entregas_epi)::int AS entregas, (SELECT count(*) FROM entregas_epi_itens)::int AS itens,
            (SELECT count(*) FROM estoque_operacoes WHERE tipo = 'ENTREGA')::int AS operacoes, (SELECT count(*) FROM fichas_epi)::int AS fichas,
            (SELECT COALESCE(max(ultimo_numero), 0) FROM fichas_epi_numeracao)::int AS contador,
            (SELECT count(*) FROM logs_auditoria WHERE acao = 'ENTREGA_REGISTRADA')::int AS auditorias`,
  )).rows[0];

  describe('o exemplo obrigatório: U5, D2, C2, L3', () => {
    test('CASO A: DIRETA de 3 (o livre inteiro) é permitida e deixa U2 D2 C2 L0', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 5);
      assert.deepEqual(f.numeros(await f.posicao(m)), [5, 2, 2, 3, 0]);
      const r = await f.direta([[m, loteId, 3]]);
      assert.equal(r.entrega.origem, 'DIRETA');
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0], 'a demanda comprometida ficou intacta');
      assert.deepEqual(await f.recusas(m), [], 'entrega permitida não gera auditoria de recusa');
    });

    test('CASO B: DIRETA de 4 é recusada com 409 SALDO_LIVRE_INSUFICIENTE, sem gravar nada, e a recusa é auditada depois do rollback', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 5);
      const antes = await retrato();
      await esperarHttpError(f.direta([[m, loteId, 4]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.deepEqual(await retrato(), antes);
      assert.deepEqual(await f.lote(loteId), { entrada: 5, baixada: 0, entregue: 0, saldo: 5 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [5, 2, 2, 3, 0]);
      const [auditoria] = await f.recusas(m);
      assert.deepEqual(auditoria.contexto, {
        operacao: 'ENTREGA_DIRETA', materialId: m, tamanho: '40', quantidadeSolicitada: 4, fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3,
      });
      assert.equal(auditoria.usuario_id, d.master);
      assert.equal(auditoria.referencia, `ENTREGA_DIRETA:${m}:40`);
      assert.equal(auditoria.dispositivo, null, 'texto do cliente não vai para a auditoria da recusa');
      assert.equal(auditoria.descricao, null);
    });

    test('a recusa não revela solicitações de terceiros: o erro público é genérico', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 5);
      await assert.rejects(f.direta([[m, loteId, 4]]), (erro) => {
        assert.deepEqual(Object.keys(erro.corpoResposta()).sort(), ['codigo', 'message', 'status']);
        assert.doesNotMatch(JSON.stringify(erro.corpoResposta()), /solicit|demanda|comprometid|\b5\b|\b3\b/i);
        return true;
      });
    });
  });

  describe('a soma do ato por par, nunca item a item', () => {
    test('livre 3: lote A com 2 e lote B com 2 do mesmo par são recusados (2 + 2 = 4), embora cada item caiba', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2 });
      const loteA = await f.estoque(m, 3);
      const loteB = await f.estoque(m, 2);
      assert.deepEqual(f.numeros(await f.posicao(m)), [5, 2, 2, 3, 0]);
      const antes = await retrato();
      await esperarHttpError(f.direta([[m, loteA, 2], [m, loteB, 2]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.deepEqual(await retrato(), antes);
      const [auditoria] = await f.recusas(m);
      assert.equal(auditoria.contexto.quantidadeSolicitada, 4, 'a quantidade auditada é a soma do par');
      assert.equal((await f.direta([[m, loteA, 2], [m, loteB, 1]])).itens.length, 2, '2 + 1 = 3 cabe no livre');
    });

    test('pares diferentes do mesmo ato têm cada um o seu saldo livre; só o insuficiente é recusado e auditado', async () => {
      const a = await f.material();
      const b = await f.material();
      await f.aprovada({ materialId: a, quantidade: 2 });
      const loteA = await f.estoque(a, 5);
      const loteB = await f.estoque(b, 5);
      await esperarHttpError(f.direta([[a, loteA, 4], [b, loteB, 5]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.equal((await f.recusas(a)).length, 1);
      assert.deepEqual(await f.recusas(b), [], 'o par que cabia não é auditado');
      assert.equal((await f.direta([[a, loteA, 3], [b, loteB, 5]])).itens.length, 2);
    });

    test('tamanhos diferentes do mesmo material são pares diferentes: o comprometido de um não bloqueia o outro', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 3, tamanho: '40' });
      const lote40 = await f.estoque(m, 3, { tamanho: '40' });
      const lote41 = await f.estoque(m, 3, { tamanho: '41' });
      await esperarHttpError(f.direta([[m, lote40, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.equal((await f.direta([[m, lote41, 3]])).itens.length, 1);
    });
  });

  describe('compatibilidade: sem reserva, a DIRETA é a de sempre', () => {
    test('sem demanda pendente todo o físico utilizável é livre', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 5);
      assert.equal((await f.direta([[m, loteId, 5]])).itens[0].quantidade, 5);
      assert.equal(await f.saldoDoMaterial(m), 0);
    });

    test('a ordem dos erros do lote não mudou: CA vencido e saldo do lote vêm antes do saldo livre', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 1 });
      const vencido = await criarLote(pool, { empresaId: d.empresaA, materialId: m, quantidade: 3, caNumero: '9', caValidade: '2020-01-01' });
      await esperarHttpError(f.direta([[m, vencido, 1]]), 409, 'CA_VENCIDO');
      const bom = await f.estoque(m, 2);
      await esperarHttpError(f.direta([[m, bom, 3]]), 409, 'SALDO_INSUFICIENTE');
      assert.deepEqual(await f.recusas(m), [], 'nem uma nem outra é recusa por saldo livre');
    });

    test('a demanda de trabalhador ou material inativo não conta: a solicitação suspensa devolve o estoque ao livre', async () => {
      const m = await f.material();
      const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
      await f.aprovada({ materialId: m, quantidade: 4, funcionarioId: trabalhador });
      const loteId = await f.estoque(m, 5);
      await esperarHttpError(f.direta([[m, loteId, 5]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      await pool.query("UPDATE funcionarios SET situacao = 'INATIVO' WHERE id = $1", [trabalhador]);
      assert.deepEqual(f.numeros(await f.posicao(m)), [5, 0, 0, 5, 0]);
      assert.equal((await f.direta([[m, loteId, 5]])).itens[0].quantidade, 5);
    });

    test('a repetição da mesma chave devolve a entrega original sem reconferir o saldo livre', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 5);
      const chaveIdempotencia = chaveNova();
      const original = await f.direta([[m, loteId, 3]], { chaveIdempotencia });
      await f.aprovada({ materialId: m, quantidade: 2 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0]);
      const repetida = await f.direta([[m, loteId, 3]], { chaveIdempotencia });
      assert.deepEqual([repetida.repetida, repetida.entrega.id], [true, original.entrega.id]);
      assert.deepEqual(await f.recusas(m), []);
    });

    test('a solicitação entregue deixa de comprometer: depois de entregue o saldo livre volta a ser todo o físico', async () => {
      const m = await f.material();
      const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
      const loteId = await f.estoque(m, 4);
      await esperarHttpError(f.direta([[m, loteId, 3]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      const { registrarEntregaPorSolicitacao } = require('../../src/services/entrega-solicitacao.service');
      await registrarEntregaPorSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.master, solicitacaoId: alvo.id, itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade: 2 }],
        confirmacao: { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).' },
        chaveIdempotencia: chaveNova(),
      });
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 0, 0, 2, 0]);
      assert.equal((await f.direta([[m, loteId, 2]])).itens[0].quantidade, 2);
    });
  });
});
