'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations, criarMaterial } = require('./helpers/entrega-epi');
const { criarLoteDeEntrada, criarSolicitacao: criarSolicitacaoSql, entregarPorSolicitacao } = require('./helpers/solicitacao-epi');
const {
  montarMundoDoServico, vincularMaterialAoGhe, chaveNova, esperarHttpError,
} = require('./helpers/solicitacao-epi-servico');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Cancelamento (só PENDENTE, só pelo próprio solicitante) e consulta da
 * solicitação de EPI (12B) contra PostgreSQL real: situação operacional
 * derivada, cobertura e posição atuais, suspensão por inativação,
 * isolamento por empresa e leitura sem escrita.
 */

const servico = () => exigirModulo('src/services/solicitacao-epi.service');
const HOJE = dataOperacional();

describe('cancelamento e consulta da solicitação de EPI — serviço (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let sequencia = 0;

  const q = (sql, params) => pool.query(sql, params);
  const item = (materialId, extra = {}) => ({ materialId, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO', ...extra });

  async function materialNoGhe(opcoes = {}) {
    sequencia += 1;
    const id = await criarMaterial(pool, d.empresaA, `Material de consulta ${sequencia}`, { exigeTamanho: true, ...opcoes });
    await vincularMaterialAoGhe(pool, d.empresaA, d.gheA, id);
    return id;
  }
  const criar = (itens, extra = {}) => servico().criarSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: d.trabalhador, itens, chaveIdempotencia: chaveNova(), ...extra,
  });
  const decidir = (solicitacaoId, decisoes, extra = {}) => servico().decidirSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.sst1, solicitacaoId, decisoes, hoje: HOJE, ...extra,
  });
  const cancelar = (solicitacaoId, extra = {}) => servico().cancelarSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.solicitante, solicitacaoId, ...extra,
  });
  const buscar = (solicitacaoId, extra = {}) => servico().buscarSolicitacao(pool, { empresaId: d.empresaA, solicitacaoId, hoje: HOJE, ...extra });
  const aprovar = (i, quantidadeAprovada) => ({ itemId: i.id, decisao: 'APROVADO', ...(quantidadeAprovada === undefined ? {} : { quantidadeAprovada }) });
  const reprovar = (i) => ({ itemId: i.id, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada' });
  const estoque = (materialId, quantidade) => criarLoteDeEntrada(pool, { empresaId: d.empresaA, materialId, quantidade, usuarioId: d.master });
  // Entrega real ligada aos itens da solicitação (SQL, como o serviço da 12C-2 fará): [[itemId, loteId, quantidade]].
  async function entregarReal(solicitacaoId, entregas) {
    const { rows: [solicitacao] } = await q('SELECT * FROM solicitacoes_epi WHERE id = $1', [solicitacaoId]);
    const itens = [];
    for (const [itemId, loteId, quantidade] of entregas) {
      const { rows: [linha] } = await q('SELECT * FROM solicitacoes_epi_itens WHERE id = $1', [itemId]);
      itens.push({ item: linha, loteId, quantidade });
    }
    return entregarPorSolicitacao(pool, { solicitacao, itens, usuarioId: d.master });
  }
  const contar = async (tabela, onde = 'true', params = []) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${onde}`, params)).rows[0].n;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('cancelamento', () => {
    test('o próprio solicitante cancela a PENDENTE: quem, quando e a justificativa opcional; os itens ficam sem decisão', async () => {
      const m = await materialNoGhe();
      const comTexto = await criar([item(m)]);
      const resultado = await cancelar(comTexto.solicitacao.id, { justificativa: '  Pedido em duplicidade  ' });
      assert.equal(resultado.solicitacao.status, 'CANCELADA');
      assert.equal(resultado.solicitacao.cancelamento.canceladaPor, d.solicitante);
      assert.equal(resultado.solicitacao.cancelamento.justificativa, 'Pedido em duplicidade');
      assert.ok(resultado.solicitacao.cancelamento.canceladaEm instanceof Date);
      assert.equal(resultado.solicitacao.situacaoOperacional, null);
      assert.deepEqual(resultado.itens.map((i) => i.decisao), [null]);
      const semTexto = await criar([item(m)], { funcionarioId: d.trabalhador2 });
      assert.equal((await cancelar(semTexto.solicitacao.id)).solicitacao.cancelamento.justificativa, null);
    });

    // Fechamento 12E+12F: a solicitação de outro usuário, mesmo da mesma empresa, é "não encontrada", igual à inexistente.
    const recusa = async (promessa) => {
      try {
        await promessa;
      } catch (erro) {
        return { status: erro.status, corpo: erro.corpoResposta() };
      }
      return assert.fail('o cancelamento deveria ter sido recusado');
    };

    test('outro usuário da mesma empresa (outro solicitante, a SST, o MASTER) recebe exatamente o 404 da inexistente; nada muda', async () => {
      const m = await materialNoGhe();
      const { solicitacao } = await criar([item(m)]);
      const inexistente = await recusa(cancelar(2147483000, { atorId: d.outroSolicitante }));
      assert.deepEqual(inexistente, { status: 404, corpo: { status: 'error', codigo: 'SOLICITACAO_NAO_ENCONTRADA', message: 'Solicitação não encontrada' } });
      for (const atorId of [d.outroSolicitante, d.sst1, d.master]) {
        assert.deepEqual(await recusa(cancelar(solicitacao.id, { atorId })), inexistente, `ator ${atorId}`);
      }
      assert.equal((await buscar(solicitacao.id)).solicitacao.status, 'PENDENTE');
      assert.equal(await contar('logs_auditoria', "acao = 'SOLICITACAO_EPI_CANCELADA' AND referencia = $1", [String(solicitacao.id)]), 0);
    });

    test('igualdade completa: inexistente, de outro usuário da mesma empresa e de outra empresa dão a mesma resposta', async () => {
      const m = await materialNoGhe();
      const daA = await criar([item(m)]);
      const inexistente = await recusa(cancelar(2147483000, { atorId: d.outroSolicitante }));
      const deOutroUsuario = await recusa(cancelar(daA.solicitacao.id, { atorId: d.outroSolicitante }));
      const deOutraEmpresa = await recusa(cancelar(daA.solicitacao.id, { empresaId: d.empresaB, atorId: d.usuarioB }));
      assert.deepEqual(deOutroUsuario, inexistente);
      assert.deepEqual(deOutraEmpresa, inexistente);
    });

    test('depois da decisão (APROVADA, APROVADA_PARCIAL, REPROVADA), da entrega ou do próprio cancelamento, não se cancela', async () => {
      const a = await materialNoGhe();
      const b = await materialNoGhe();
      const aprovada = await criar([item(a)]);
      await decidir(aprovada.solicitacao.id, [aprovar(aprovada.itens[0])]);
      const parcial = await criar([item(a), item(b)], { funcionarioId: d.trabalhador2 });
      await decidir(parcial.solicitacao.id, [aprovar(parcial.itens[0]), reprovar(parcial.itens[1])]);
      const reprovada = await criar([item(a)], { funcionarioId: d.trabalhador3 });
      await decidir(reprovada.solicitacao.id, [reprovar(reprovada.itens[0])]);
      const entregue = await criar([item(b)]);
      await decidir(entregue.solicitacao.id, [aprovar(entregue.itens[0])]);
      await entregarReal(entregue.solicitacao.id, [[entregue.itens[0].id, await estoque(b, 2), 2]]);
      const cancelada = await criar([item(b)], { funcionarioId: d.trabalhador2 });
      await cancelar(cancelada.solicitacao.id);

      for (const { solicitacao } of [aprovada, parcial, reprovada, entregue, cancelada]) {
        await esperarHttpError(cancelar(solicitacao.id), 409, 'SOLICITACAO_NAO_PENDENTE');
      }
      assert.deepEqual(
        (await q('SELECT status FROM solicitacoes_epi WHERE id = ANY($1) ORDER BY id', [[aprovada, parcial, reprovada, entregue, cancelada].map((x) => x.solicitacao.id)])).rows.map((r) => r.status),
        ['APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'ENTREGUE', 'CANCELADA'],
      );
    });

    test('solicitação de autoatendimento não tem solicitante interno: para qualquer usuário interno ela é "não encontrada" por esta via', async () => {
      const m = await materialNoGhe();
      const { solicitacao } = await criarSolicitacaoSql(pool, { empresaA: d.empresaA, trabalhadorA: d.trabalhador, solicitante: d.solicitante }, {
        empresaId: d.empresaA, funcionarioId: d.trabalhador, origem: 'AUTOATENDIMENTO', itens: [{ material_id: m, tamanho: '40' }],
      });
      for (const atorId of [d.solicitante, d.sst1, d.master]) {
        await esperarHttpError(cancelar(solicitacao.id, { atorId }), 404, 'SOLICITACAO_NAO_ENCONTRADA');
      }
    });

    test('inexistente ou de outra empresa: 404; ator inexistente também; o próprio solicitante precisa estar ativo', async () => {
      const m = await materialNoGhe();
      const { solicitacao } = await criar([item(m)]);
      await esperarHttpError(cancelar(2147483000), 404, 'SOLICITACAO_NAO_ENCONTRADA');
      await esperarHttpError(cancelar(solicitacao.id, { empresaId: d.empresaB, atorId: d.usuarioB }), 404, 'SOLICITACAO_NAO_ENCONTRADA');
      await esperarHttpError(cancelar(solicitacao.id, { atorId: 999999 }), 404, 'SOLICITACAO_NAO_ENCONTRADA');
      const doInativo = await criar([item(m)], { atorId: d.outroSolicitante, funcionarioId: d.trabalhador2 });
      await q('UPDATE usuarios SET ativo = false WHERE id = $1', [d.outroSolicitante]);
      await esperarHttpError(cancelar(doInativo.solicitacao.id, { atorId: d.outroSolicitante }), 403, 'USUARIO_INATIVO');
      await q('UPDATE usuarios SET ativo = true WHERE id = $1', [d.outroSolicitante]);
      assert.equal((await buscar(solicitacao.id)).solicitacao.status, 'PENDENTE');
    });

    test('auditoria SOLICITACAO_EPI_CANCELADA: quem, o quê, se houve justificativa e o estado anterior e o novo; o texto da justificativa fica só na solicitação, nunca na auditoria', async () => {
      const m = await materialNoGhe();
      const { solicitacao } = await criar([item(m)]);
      await cancelar(solicitacao.id, { justificativa: 'Pedido em duplicidade' });
      const { rows } = await q("SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'SOLICITACAO_EPI_CANCELADA' AND referencia = $2", [d.empresaA, String(solicitacao.id)]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].usuario_id, d.solicitante);
      assert.equal(rows[0].descricao, null);
      assert.equal(JSON.stringify(rows[0]).includes('Pedido em duplicidade'), false, 'o texto livre não vai para a auditoria, em coluna nenhuma');
      assert.equal((await q('SELECT justificativa_cancelamento FROM solicitacoes_epi WHERE id = $1', [solicitacao.id])).rows[0].justificativa_cancelamento, 'Pedido em duplicidade');
      assert.deepEqual(rows[0].contexto, { solicitacaoId: solicitacao.id, numero: solicitacao.numero, funcionarioId: d.trabalhador, comJustificativa: true });
      assert.deepEqual(rows[0].dados_anteriores, { status: 'PENDENTE' });
      assert.deepEqual(rows[0].dados_novos, { status: 'CANCELADA' });
    });

    test('atomicidade: se a auditoria falhar, o cancelamento não fica', async (t) => {
      const m = await materialNoGhe();
      const { solicitacao } = await criar([item(m)]);
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha de auditoria'); });
      await assert.rejects(cancelar(solicitacao.id), /falha de auditoria/);
      t.mock.restoreAll();
      assert.equal((await buscar(solicitacao.id)).solicitacao.status, 'PENDENTE');
      assert.equal((await cancelar(solicitacao.id)).solicitacao.status, 'CANCELADA');
    });
  });

  describe('consulta', () => {
    test('PENDENTE: itens sem decisão, sem cobertura nem situação operacional; sem chave nem hash', async () => {
      const m = await materialNoGhe();
      const { solicitacao } = await criar([item(m)]);
      const lida = await buscar(solicitacao.id);
      assert.equal(lida.solicitacao.status, 'PENDENTE');
      assert.equal(lida.solicitacao.situacaoOperacional, null);
      assert.deepEqual(lida.itens.map((i) => [i.decisao, i.situacao, i.cobertura, i.posicao, i.quantidadePendente, i.quantidadeEntregue]), [[null, null, null, null, null, 0]]);
      for (const proibida of ['chaveIdempotencia', 'requisicaoHash', 'empresaId']) assert.equal(proibida in lida.solicitacao, false, proibida);
    });

    test('aprovada: aguardando estoque, parcialmente coberta e pronta, derivadas do estoque de agora; o cabeçalho resume os itens', async () => {
      const a = await materialNoGhe();
      const b = await materialNoGhe();
      const { solicitacao, itens } = await criar([item(a, { quantidade: 2 }), item(b, { quantidade: 3 })]);
      await decidir(solicitacao.id, [aprovar(itens[0]), aprovar(itens[1])]);
      let lida = await buscar(solicitacao.id);
      assert.deepEqual(lida.itens.map((i) => i.situacao), ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_ESTOQUE']);
      assert.equal(lida.solicitacao.situacaoOperacional, 'AGUARDANDO_ESTOQUE');

      await estoque(a, 2);
      await estoque(b, 1);
      lida = await buscar(solicitacao.id);
      assert.deepEqual(lida.itens.map((i) => i.situacao), ['PRONTA_PARA_ENTREGA', 'PARCIALMENTE_COBERTA']);
      assert.equal(lida.solicitacao.situacaoOperacional, 'PARCIALMENTE_COBERTA');
      assert.deepEqual(lida.itens[1].cobertura, { coberta: 1, semCobertura: 2, acumuladoAnterior: 0, fisicoUtilizavel: 1 });

      await estoque(b, 2);
      lida = await buscar(solicitacao.id);
      assert.deepEqual(lida.itens.map((i) => i.situacao), ['PRONTA_PARA_ENTREGA', 'PRONTA_PARA_ENTREGA']);
      assert.equal(lida.solicitacao.situacaoOperacional, 'PRONTA_PARA_ENTREGA');
      assert.deepEqual(lida.itens[1].posicao, { fisicoUtilizavel: 3, demandaPendente: 3, comprometido: 3, saldoLivre: 0, semCobertura: 0 });
    });

    test('aprovada parcial: o item reprovado fica sem situação e a do cabeçalho vem só dos aprovados; a decisão volta com quem e quando', async () => {
      const a = await materialNoGhe();
      const b = await materialNoGhe();
      await estoque(a, 5);
      const { solicitacao, itens } = await criar([item(a, { quantidade: 2 }), item(b, { quantidade: 1 })]);
      await decidir(solicitacao.id, [aprovar(itens[0]), reprovar(itens[1])]);
      const lida = await buscar(solicitacao.id);
      assert.equal(lida.solicitacao.status, 'APROVADA_PARCIAL');
      assert.deepEqual(lida.itens.map((i) => [i.decisao, i.situacao, i.quantidadePendente]), [['APROVADO', 'PRONTA_PARA_ENTREGA', 2], ['REPROVADO', null, null]]);
      assert.equal(lida.solicitacao.situacaoOperacional, 'PRONTA_PARA_ENTREGA');
      assert.equal(lida.solicitacao.decisao.decididaPor, d.sst1);
      assert.equal(lida.itens[1].justificativaDecisao, 'Sem necessidade comprovada');
    });

    test('a cobertura muda com o estoque sem nenhuma escrita na solicitação: a baixa física recalcula na leitura seguinte', async () => {
      const m = await materialNoGhe();
      await estoque(m, 3);
      const { solicitacao, itens } = await criar([item(m, { quantidade: 3 })]);
      await decidir(solicitacao.id, [aprovar(itens[0])]);
      assert.equal((await buscar(solicitacao.id)).solicitacao.situacaoOperacional, 'PRONTA_PARA_ENTREGA');
      const { rows: [{ id: loteId }] } = await q('SELECT id FROM estoque_lotes WHERE material_id = $1', [m]);
      await q(
        "INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, motivo, usuario_id, chave_idempotencia, requisicao_hash) VALUES ($1, $2, 'BAIXA', 2, 'AVARIA', $3, $4, $5)",
        [d.empresaA, loteId, d.master, chaveNova(), 'a'.repeat(64)],
      );
      const depois = await buscar(solicitacao.id);
      assert.equal(depois.solicitacao.situacaoOperacional, 'PARCIALMENTE_COBERTA');
      assert.deepEqual(depois.itens[0].cobertura, { coberta: 1, semCobertura: 2, acumuladoAnterior: 0, fisicoUtilizavel: 1 });
      // Só o estoque mudou: depois da baixa de 2 sobra 1, e a data operacional só afeta CA vencido (o lote vale até 2099).
      const daquiA400Dias = new Date(`${HOJE}T00:00:00Z`);
      daquiA400Dias.setUTCDate(daquiA400Dias.getUTCDate() + 400);
      const muitoDepois = await buscar(solicitacao.id, { hoje: daquiA400Dias.toISOString().slice(0, 10) });
      assert.equal(muitoDepois.solicitacao.situacaoOperacional, 'PARCIALMENTE_COBERTA');
    });

    test('trabalhador ou material inativo suspende a demanda de forma derivada; o status não muda e reativar devolve a fila', async () => {
      const m = await materialNoGhe();
      await estoque(m, 5);
      const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
      const { solicitacao, itens } = await criar([item(m, { quantidade: 2 })], { funcionarioId: trabalhador });
      await decidir(solicitacao.id, [aprovar(itens[0])]);
      await q('UPDATE funcionarios SET ativo = false WHERE id = $1', [trabalhador]);
      let lida = await buscar(solicitacao.id);
      assert.equal(lida.solicitacao.status, 'APROVADA');
      assert.deepEqual([lida.itens[0].situacao, lida.itens[0].cobertura, lida.solicitacao.situacaoOperacional], ['SUSPENSA', null, 'SUSPENSA']);
      assert.equal(lida.itens[0].posicao.demandaPendente, 0, 'a demanda suspensa não entra no compromisso');
      await q('UPDATE funcionarios SET ativo = true WHERE id = $1', [trabalhador]);
      lida = await buscar(solicitacao.id);
      assert.equal(lida.solicitacao.situacaoOperacional, 'PRONTA_PARA_ENTREGA');

      await q('UPDATE materiais SET ativo = false WHERE id = $1', [m]);
      lida = await buscar(solicitacao.id);
      assert.equal(lida.itens[0].situacao, 'SUSPENSA');
      await q('UPDATE materiais SET ativo = true WHERE id = $1', [m]);
    });

    test('entrega parcial: a entregue vem das entregas ligadas ao item, a pendente continua, a solicitação segue aberta e a situação é PARCIALMENTE_ENTREGUE', async () => {
      const m = await materialNoGhe();
      const lote = await estoque(m, 5);
      const { solicitacao, itens } = await criar([item(m, { quantidade: 3 })]);
      await decidir(solicitacao.id, [aprovar(itens[0])]);
      await entregarReal(solicitacao.id, [[itens[0].id, lote, 1]]);
      const lida = await buscar(solicitacao.id);
      assert.equal(lida.solicitacao.status, 'APROVADA', 'o status decisório não muda com a entrega parcial');
      assert.equal(lida.solicitacao.entregueEm, null);
      assert.deepEqual([lida.itens[0].situacao, lida.itens[0].quantidadeEntregue, lida.itens[0].quantidadePendente], ['PARCIALMENTE_ENTREGUE', 1, 2]);
      assert.equal(lida.solicitacao.situacaoOperacional, 'PARCIALMENTE_ENTREGUE');
      assert.deepEqual(lida.itens[0].cobertura, { coberta: 2, semCobertura: 0, acumuladoAnterior: 0, fisicoUtilizavel: 4 });
      assert.deepEqual(lida.itens[0].posicao, { fisicoUtilizavel: 4, demandaPendente: 2, comprometido: 2, saldoLivre: 2, semCobertura: 0 });
      await entregarReal(solicitacao.id, [[itens[0].id, lote, 2]]);
      const fechada = await buscar(solicitacao.id);
      assert.equal(fechada.solicitacao.status, 'ENTREGUE');
      assert.deepEqual([fechada.itens[0].situacao, fechada.itens[0].quantidadeEntregue, fechada.itens[0].quantidadePendente], ['ENTREGUE', 3, 0]);
    });

    test('vários itens: um entregue por inteiro e outro pendente deixam o cabeçalho PARCIALMENTE_ENTREGUE; o item reprovado não entra na conta', async () => {
      const a = await materialNoGhe();
      const b = await materialNoGhe();
      const c = await materialNoGhe();
      const loteA = await estoque(a, 3);
      await estoque(b, 1);
      const { solicitacao, itens } = await criar([item(a, { quantidade: 2 }), item(b, { quantidade: 2 }), item(c, { quantidade: 1 })]);
      await decidir(solicitacao.id, [aprovar(itens[0]), aprovar(itens[1]), reprovar(itens[2])]);
      await entregarReal(solicitacao.id, [[itens[0].id, loteA, 2]]);
      const lida = await buscar(solicitacao.id);
      assert.equal(lida.solicitacao.status, 'APROVADA_PARCIAL');
      assert.deepEqual(lida.itens.map((i) => [i.situacao, i.quantidadeEntregue, i.quantidadePendente]), [['ENTREGUE', 2, 0], ['PARCIALMENTE_COBERTA', 0, 2], [null, 0, null]]);
      assert.equal(lida.solicitacao.situacaoOperacional, 'PARCIALMENTE_ENTREGUE');
    });

    test('trabalhador inativo com entrega parcial: o remanescente fica SUSPENSO, derivado, sem mudar o status', async () => {
      const m = await materialNoGhe();
      const lote = await estoque(m, 5);
      const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
      const { solicitacao, itens } = await criar([item(m, { quantidade: 3 })], { funcionarioId: trabalhador });
      await decidir(solicitacao.id, [aprovar(itens[0])]);
      await entregarReal(solicitacao.id, [[itens[0].id, lote, 1]]);
      await q('UPDATE funcionarios SET ativo = false WHERE id = $1', [trabalhador]);
      const suspensa = await buscar(solicitacao.id);
      assert.equal(suspensa.solicitacao.status, 'APROVADA');
      assert.deepEqual([suspensa.itens[0].situacao, suspensa.itens[0].quantidadeEntregue, suspensa.itens[0].quantidadePendente, suspensa.itens[0].cobertura], ['SUSPENSA', 1, 2, null]);
      await q('UPDATE funcionarios SET ativo = true WHERE id = $1', [trabalhador]);
      assert.equal((await buscar(solicitacao.id)).itens[0].situacao, 'PARCIALMENTE_ENTREGUE');
    });

    test('ENTREGUE (fechada pela última entrega): itens entregues, pendente zero; REPROVADA e CANCELADA sem situação operacional', async () => {
      const m = await materialNoGhe();
      const lote = await estoque(m, 2);
      const entregue = await criar([item(m, { quantidade: 2 })]);
      await decidir(entregue.solicitacao.id, [aprovar(entregue.itens[0])]);
      await entregarReal(entregue.solicitacao.id, [[entregue.itens[0].id, lote, 2]]);
      const lida = await buscar(entregue.solicitacao.id);
      assert.equal(lida.solicitacao.situacaoOperacional, 'ENTREGUE');
      assert.deepEqual([lida.itens[0].situacao, lida.itens[0].quantidadeEntregue, lida.itens[0].quantidadePendente], ['ENTREGUE', 2, 0]);
      assert.ok(lida.solicitacao.entregueEm instanceof Date);

      const reprovada = await criar([item(m)], { funcionarioId: d.trabalhador2 });
      await decidir(reprovada.solicitacao.id, [reprovar(reprovada.itens[0])]);
      const cancelada = await criar([item(m)], { funcionarioId: d.trabalhador3 });
      await cancelar(cancelada.solicitacao.id);
      for (const { solicitacao } of [reprovada, cancelada]) {
        const outra = await buscar(solicitacao.id);
        assert.equal(outra.solicitacao.situacaoOperacional, null);
        assert.deepEqual(outra.itens.map((i) => i.cobertura), [null]);
      }
    });

    test('sem a data operacional informada, a consulta usa a de hoje em São Paulo', async () => {
      const m = await materialNoGhe();
      await estoque(m, 1);
      const { solicitacao, itens } = await criar([item(m, { quantidade: 1 })]);
      await decidir(solicitacao.id, [aprovar(itens[0])]);
      const lida = await servico().buscarSolicitacao(pool, { empresaId: d.empresaA, solicitacaoId: solicitacao.id });
      assert.equal(lida.solicitacao.situacaoOperacional, 'PRONTA_PARA_ENTREGA');
    });

    test('isolamento: outra empresa não encontra a solicitação; inexistente é 404', async () => {
      const m = await materialNoGhe();
      const { solicitacao } = await criar([item(m)]);
      await esperarHttpError(servico().buscarSolicitacao(pool, { empresaId: d.empresaB, solicitacaoId: solicitacao.id, hoje: HOJE }), 404, 'SOLICITACAO_NAO_ENCONTRADA');
      await esperarHttpError(buscar(2147483000), 404, 'SOLICITACAO_NAO_ENCONTRADA');
    });

    test('leitura pura: roda mesmo quando toda escrita é recusada e não altera nenhuma tabela', async () => {
      const m = await materialNoGhe();
      await estoque(m, 1);
      const { solicitacao, itens } = await criar([item(m, { quantidade: 2 })]);
      await decidir(solicitacao.id, [aprovar(itens[0])]);
      const foto = async () => (await q(
        `SELECT (SELECT json_agg(l ORDER BY l.id) FROM estoque_lotes l) AS lotes, (SELECT json_agg(o ORDER BY o.id) FROM estoque_operacoes o) AS operacoes,
                (SELECT json_agg(s ORDER BY s.id) FROM solicitacoes_epi s) AS solicitacoes, (SELECT json_agg(i ORDER BY i.id) FROM solicitacoes_epi_itens i) AS itens,
                (SELECT count(*)::int FROM logs_auditoria) AS auditorias`,
      )).rows[0];
      const antes = await foto();
      const poolSomenteLeitura = {
        connect: async () => {
          const cliente = await pool.connect();
          const consultar = cliente.query.bind(cliente);
          cliente.query = (texto, ...resto) => {
            const sql = typeof texto === 'string' ? texto : texto.text;
            if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql) || /pg_advisory|FOR\s+(NO KEY\s+)?(UPDATE|SHARE)/i.test(sql)) throw new Error(`escrita ou trava na consulta: ${sql.slice(0, 40)}`);
            return consultar(texto, ...resto);
          };
          return cliente;
        },
        query: (...args) => pool.query(...args),
      };
      const lida = await servico().buscarSolicitacao(poolSomenteLeitura, { empresaId: d.empresaA, solicitacaoId: solicitacao.id, hoje: HOJE });
      assert.equal(lida.solicitacao.situacaoOperacional, 'PARCIALMENTE_COBERTA');
      assert.deepEqual(await foto(), antes);
    });
  });
});
