'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const {
  montarMundoDoServico, esperarHttpError, comLimite, aguardarTravaAdvisoryPendente,
} = require('./helpers/solicitacao-epi-servico');
const { criarFerramentas } = require('./helpers/reserva-estoque');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const parRepo = require('../../src/repositories/estoque-par.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Auditoria da recusa por SALDO_LIVRE_INSUFICIENTE (12C-3) contra PostgreSQL
 * real. Só depois do ROLLBACK da operação principal, em transação própria, com
 * janela de supressão de 60 s por empresa, ator, tipo de operação, material e
 * tamanho, serializada por advisory lock de namespace próprio (nunca o do par
 * de estoque). Dados estruturados apenas; a falha dela não muda o erro.
 */

const auditoriaRecusa = () => exigirModulo('src/services/auditoria-recusa-saldo-livre');
const supressao = () => exigirModulo('src/utils/supressao-auditoria');

const dormir = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('auditoria da recusa por saldo livre — PostgreSQL real', () => {
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

  // Par em L0: U2, D2.
  async function parSemLivre(quantidade = 2) {
    const m = await f.material();
    await f.aprovada({ materialId: m, quantidade });
    const loteId = await f.estoque(m, quantidade);
    return { m, loteId };
  }

  const recusaDireta = (m, quantidadeSolicitada = 1) => ({
    operacao: 'ENTREGA_DIRETA',
    recusas: [{ materialId: m, tamanho: '40', quantidadeSolicitada, fisicoUtilizavel: 2, demandaPendente: 2, comprometido: 2, saldoLivre: 0 }],
    loteId: null,
    motivo: null,
  });

  describe('supressão de 60 segundos', () => {
    test('a mesma recusa repetida do mesmo ator no mesmo par gera um registro só; o erro público é o mesmo nas duas', async () => {
      const { m, loteId } = await parSemLivre();
      await esperarHttpError(f.direta([[m, loteId, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      await esperarHttpError(f.direta([[m, loteId, 2]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      const registros = await f.recusas(m, { operacao: 'ENTREGA_DIRETA' });
      assert.equal(registros.length, 1);
      assert.equal(registros[0].contexto.quantidadeSolicitada, 1, 'permanece o primeiro evento da janela');
    });

    test('ator diferente no mesmo par não é suprimido pelo primeiro', async () => {
      const { m, loteId } = await parSemLivre();
      await esperarHttpError(f.direta([[m, loteId, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      await esperarHttpError(f.direta([[m, loteId, 1]], { atorId: d.sst1 }), 409, 'SALDO_LIVRE_INSUFICIENTE');
      const registros = await f.recusas(m);
      assert.deepEqual(registros.map((r) => r.usuario_id).sort(), [d.master, d.sst1].sort());
    });

    test('tipo de operação diferente no mesmo par não é suprimido: DIRETA e baixa discricionária geram um registro cada', async () => {
      const { m, loteId } = await parSemLivre();
      await esperarHttpError(f.direta([[m, loteId, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      await esperarHttpError(f.baixa(loteId, 1, 'OUTRO'), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.deepEqual((await f.recusas(m)).map((r) => r.contexto.operacao).sort(), ['BAIXA', 'ENTREGA_DIRETA']);
      await esperarHttpError(f.baixa(loteId, 1, 'DEVOLUCAO_FORNECEDOR'), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.equal((await f.recusas(m, { operacao: 'BAIXA' })).length, 1, 'a mesma operação (BAIXA) no mesmo par continua suprimida, qualquer que seja o motivo');
    });

    test('par diferente (outro material ou outro tamanho) não é suprimido', async () => {
      const a = await parSemLivre();
      const b = await parSemLivre();
      await esperarHttpError(f.direta([[a.m, a.loteId, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      await esperarHttpError(f.direta([[b.m, b.loteId, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.equal((await f.recusas(a.m)).length, 1);
      assert.equal((await f.recusas(b.m)).length, 1);
    });

    test('o mesmo material em tamanhos diferentes são pares diferentes: um registro por tamanho, e a repetição de cada um é suprimida', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 2, tamanho: '40' });
      await f.aprovada({ materialId: m, quantidade: 2, tamanho: '41' });
      const lote40 = await f.estoque(m, 2, { tamanho: '40' });
      const lote41 = await f.estoque(m, 2, { tamanho: '41' });
      for (let vez = 0; vez < 2; vez += 1) {
        await esperarHttpError(f.direta([[m, lote40, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
        await esperarHttpError(f.direta([[m, lote41, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      }
      const registros = await f.recusas(m);
      assert.deepEqual(registros.map((r) => r.contexto.tamanho).sort(), ['40', '41']);
      assert.deepEqual(registros.map((r) => r.referencia).sort(), [`ENTREGA_DIRETA:${m}:40`, `ENTREGA_DIRETA:${m}:41`]);
    });

    test('empresa diferente não é suprimida: a chave de supressão inclui a empresa', async () => {
      const { m } = await parSemLivre();
      const comoEmpresa = (empresaId) => auditoriaRecusa().registrarRecusaPorSaldoLivre(pool, {
        empresaId, atorId: empresaId === d.empresaA ? d.master : d.masterB, recusa: recusaDireta(m),
      });
      await comoEmpresa(d.empresaA);
      await comoEmpresa(d.empresaB);
      const { rows } = await pool.query(
        "SELECT empresa_id FROM logs_auditoria WHERE acao = 'SALDO_LIVRE_INSUFICIENTE' AND (contexto->>'materialId')::int = $1 ORDER BY empresa_id", [m],
      );
      assert.deepEqual(rows.map((r) => r.empresa_id), [d.empresaA, d.empresaB].sort((x, y) => x - y));
    });

    test('depois da janela o evento volta a ser registrado (janela configurável só pelo serviço, para o teste)', async () => {
      const { m } = await parSemLivre();
      const registrar = () => auditoriaRecusa().registrarRecusaPorSaldoLivre(pool, {
        empresaId: d.empresaA, atorId: d.master, recusa: recusaDireta(m),
      }, { janelaSegundos: 1 });
      await registrar();
      await registrar();
      assert.equal((await f.recusas(m)).length, 1, 'dentro da janela');
      await dormir(1200);
      await registrar();
      assert.equal((await f.recusas(m)).length, 2, 'fora da janela');
    });

    test('vários pares insuficientes no mesmo ato: um registro por par e a repetição imediata não duplica nenhum', async () => {
      const a = await parSemLivre();
      const b = await parSemLivre();
      const itens = [[a.m, a.loteId, 1], [b.m, b.loteId, 1]];
      await esperarHttpError(f.direta(itens), 409, 'SALDO_LIVRE_INSUFICIENTE');
      await esperarHttpError(f.direta(itens), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.equal((await f.recusas(a.m)).length, 1);
      assert.equal((await f.recusas(b.m)).length, 1);
    });
  });

  describe('depois do ROLLBACK, em transação própria', () => {
    test('quando a auditoria roda, a transação principal já terminou: trava do par e lote livres, nada gravado da entrega', async (t) => {
      const { m, loteId } = await parSemLivre();
      const original = auditoriaRecusa().registrarRecusaPorSaldoLivre;
      let observado = null;
      t.mock.method(auditoriaRecusa(), 'registrarRecusaPorSaldoLivre', async (...args) => {
        const cliente = await pool.connect();
        try {
          await cliente.query('BEGIN');
          await cliente.query("SET LOCAL lock_timeout = '1500ms'");
          const par = await cliente.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS livre', [require('../../src/utils/lock-par-estoque').lockDoPar(d.empresaA, m, '40')]);
          const lote = await cliente.query('SELECT id FROM estoque_lotes WHERE id = $1 FOR UPDATE', [loteId]);
          const entregas = await cliente.query('SELECT count(*)::int AS n FROM entregas_epi');
          observado = { parLivre: par.rows[0].livre, loteTravado: lote.rowCount === 1, entregas: entregas.rows[0].n };
          await cliente.query('COMMIT');
        } finally {
          await cliente.query('ROLLBACK').catch(() => {});
          cliente.release();
        }
        return original(...args);
      });
      const antes = (await pool.query('SELECT count(*)::int AS n FROM entregas_epi')).rows[0].n;
      await esperarHttpError(f.direta([[m, loteId, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.ok(observado, 'a auditoria da recusa nunca foi chamada');
      assert.equal(observado.parLivre, true, 'a trava do par já tinha sido liberada pelo ROLLBACK');
      assert.equal(observado.loteTravado, true);
      assert.equal(observado.entregas, antes, 'nada da entrega recusada estava visível nem pendente');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM entregas_epi')).rows[0].n, antes);
    });

    test('a auditoria da recusa sobrevive ao rollback: a recusa fica registrada e a entrega não', async () => {
      const { m, loteId } = await parSemLivre();
      await esperarHttpError(f.direta([[m, loteId, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.equal((await f.recusas(m)).length, 1);
      assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 0, entregue: 0, saldo: 2 });
      assert.equal((await pool.query(
        "SELECT count(*)::int AS n FROM logs_auditoria WHERE acao = 'ENTREGA_REGISTRADA' AND contexto->'itens' @> jsonb_build_array(jsonb_build_object('materialId', $1::int))", [m],
      )).rows[0].n, 0);
    });

    test('a recusa que não é por saldo livre (SALDO_INSUFICIENTE, CA_VENCIDO, validação) não gera auditoria de recusa', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 1 });
      const loteId = await f.estoque(m, 2);
      await esperarHttpError(f.direta([[m, loteId, 3]]), 409, 'SALDO_INSUFICIENTE');
      await esperarHttpError(f.baixa(loteId, 3, 'OUTRO'), 409, 'SALDO_LOTE_INSUFICIENTE');
      assert.deepEqual(await f.recusas(m), []);
    });
  });

  describe('dados estruturados e segurança', () => {
    test('o registro leva só ids, números e valores estruturados: nada de confirmação, assinatura, justificativa, observação, dispositivo ou texto livre', async () => {
      const { m, loteId } = await parSemLivre();
      await esperarHttpError(f.baixa(loteId, 1, 'OUTRO', { justificativa: 'Texto livre do operador, sigiloso' }), 409, 'SALDO_LIVRE_INSUFICIENTE');
      const [registro] = await f.recusas(m);
      assert.deepEqual(Object.keys(registro.contexto).sort(), [
        'comprometido', 'demandaPendente', 'fisicoUtilizavel', 'loteId', 'materialId', 'motivo', 'operacao', 'quantidadeSolicitada', 'saldoLivre', 'tamanho',
      ]);
      const texto = JSON.stringify(registro);
      assert.doesNotMatch(texto, /sigiloso|Navegador|ACEITE|NR6|declara|assinatura|senha|token|cookie|secret|segredo|credencial/i);
      assert.equal(registro.ip, '203.0.113.10');
      assert.equal(registro.dispositivo, null);
      assert.equal(registro.descricao, null);
    });

    test('a recusa da DIRETA leva só o contexto numérico (sem loteId e sem motivo): os do lote ficam fora', async () => {
      const { m, loteId } = await parSemLivre();
      await esperarHttpError(f.direta([[m, loteId, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      const [registro] = await f.recusas(m);
      assert.deepEqual(Object.keys(registro.contexto).sort(), [
        'comprometido', 'demandaPendente', 'fisicoUtilizavel', 'materialId', 'operacao', 'quantidadeSolicitada', 'saldoLivre', 'tamanho',
      ]);
    });

    test('o erro público não carrega a posição nem a recusa: só status, código e mensagem genéricos', async () => {
      const { m, loteId } = await parSemLivre();
      for (const tentativa of [() => f.direta([[m, loteId, 1]]), () => f.baixa(loteId, 1, 'OUTRO')]) {
        await assert.rejects(tentativa(), (erro) => {
          assert.ok(HttpError.ehHttpError(erro));
          assert.deepEqual(Object.keys(erro.corpoResposta()).sort(), ['codigo', 'message', 'status']);
          assert.equal(erro.codigo, 'SALDO_LIVRE_INSUFICIENTE');
          assert.doesNotMatch(JSON.stringify(erro.corpoResposta()), /solicit|demanda|comprometid|posi[cç]/i);
          return true;
        });
      }
    });
  });

  describe('falha da auditoria secundária', () => {
    test('se o registro falhar, o erro continua SALDO_LIVRE_INSUFICIENTE (nunca sucesso, nunca erro 500) e a falha vai ao log técnico sem payload', async (t) => {
      const { m, loteId } = await parSemLivre();
      const falhas = [];
      t.mock.method(console, 'error', (...args) => { falhas.push(args); });
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw Object.assign(new Error('falha simulada; senha=segredo123 CPF 123.456.789-09'), { code: '53300' }); });
      await esperarHttpError(f.direta([[m, loteId, 1]]), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 0, entregue: 0, saldo: 2 });
      const tecnicos = falhas.filter((a) => a[0] === '[auditoria-recusa]');
      assert.equal(tecnicos.length, 1);
      assert.deepEqual(tecnicos[0][1], { evento: 'auditoria_recusa_saldo_livre_falhou', operacao: 'ENTREGA_DIRETA', motivo: '53300' });
      assert.doesNotMatch(JSON.stringify(falhas), /segredo123|123\.456|Navegador|ACEITE/);
    });

    test('a mesma garantia na baixa discricionária', async (t) => {
      const { m, loteId } = await parSemLivre();
      t.mock.method(console, 'error', () => {});
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('indisponível'); });
      await esperarHttpError(f.baixa(loteId, 1, 'OUTRO'), 409, 'SALDO_LIVRE_INSUFICIENTE');
      assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 0, entregue: 0, saldo: 2 });
    });
  });

  describe('trava da supressão: serializa e não atrasa o estoque', () => {
    test('com a trava da supressão ocupada, a auditoria espera; quem a ocupava registra, e a espera então SUPRIME (um único registro)', async () => {
      const { m } = await parSemLivre();
      const evento = supressao().chaveDoEvento('ENTREGA_DIRETA', m, '40');
      const segurando = await pool.connect();
      try {
        await segurando.query('BEGIN');
        await segurando.query('SELECT pg_advisory_xact_lock($1::bigint)', [supressao().lockDaSupressao(d.empresaA, d.master, evento)]);
        const espera = auditoriaRecusa().registrarRecusaPorSaldoLivre(pool, { empresaId: d.empresaA, atorId: d.master, recusa: recusaDireta(m) });
        await aguardarTravaAdvisoryPendente(pool);
        assert.equal((await f.recusas(m)).length, 0, 'enquanto a trava estiver ocupada nada é inserido');
        await auditoriaRepo.registrar(segurando, { empresaId: d.empresaA, usuarioId: d.master, acao: 'SALDO_LIVRE_INSUFICIENTE', referencia: evento, contexto: { operacao: 'ENTREGA_DIRETA', materialId: m, tamanho: '40' } });
        await segurando.query('COMMIT');
        await comLimite(espera, 'recusa esperando a trava', 5000);
        assert.equal((await f.recusas(m)).length, 1, 'a consulta depois da trava enxergou o evento recente');
      } finally {
        await segurando.query('ROLLBACK').catch(() => {});
        segurando.release();
      }
    });

    test('a trava da supressão é de namespace próprio: com a trava do par de estoque ocupada, a auditoria não espera', async () => {
      const { m } = await parSemLivre();
      const segurando = await pool.connect();
      try {
        await segurando.query('BEGIN');
        await parRepo.travarPares(segurando, d.empresaA, [{ materialId: m, tamanho: '40' }]);
        await comLimite(
          auditoriaRecusa().registrarRecusaPorSaldoLivre(pool, { empresaId: d.empresaA, atorId: d.master, recusa: recusaDireta(m) }),
          'auditoria com o par travado',
          3000,
        );
        assert.equal((await f.recusas(m)).length, 1);
      } finally {
        await segurando.query('ROLLBACK').catch(() => {});
        segurando.release();
      }
    });

    test('a janela é consultada com o relógio da consulta e com a empresa do ator: o registro de outra empresa não suprime', async () => {
      const { m } = await parSemLivre();
      await auditoriaRepo.registrar(pool, {
        empresaId: d.empresaB, usuarioId: d.masterB, acao: 'SALDO_LIVRE_INSUFICIENTE', referencia: `ENTREGA_DIRETA:${m}:40`, contexto: { operacao: 'ENTREGA_DIRETA', materialId: m, tamanho: '40' },
      });
      assert.equal(await auditoriaRepo.existeRecente(pool, {
        empresaId: d.empresaA, usuarioId: d.master, acao: 'SALDO_LIVRE_INSUFICIENTE', referencia: `ENTREGA_DIRETA:${m}:40`, janelaSegundos: 60,
      }), false);
      assert.equal(await auditoriaRepo.existeRecente(pool, {
        empresaId: d.empresaB, usuarioId: d.masterB, acao: 'SALDO_LIVRE_INSUFICIENTE', referencia: `ENTREGA_DIRETA:${m}:40`, janelaSegundos: 60,
      }), true);
    });
  });
});
