'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const {
  montarMundoDoServico, vincularMaterialAoGhe, chaveNova, esperarHttpError, esperarValidacao,
} = require('./helpers/solicitacao-epi-servico');
const { criarFerramentas } = require('./helpers/reserva-estoque');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const consulta = require('../../src/services/solicitacao-epi-consulta.service');

/**
 * Encerramento da solicitação de EPI aprovada que não será mais entregue (D6,
 * 12E-2), serviço contra PostgreSQL real com todas as migrations.
 *
 * Encerrar muda só o status (ENCERRADA, terminal) e grava quem, quando e a
 * justificativa. As entregas feitas, os lotes, a ficha e as operações ficam
 * como estavam. A quantidade aprovada ainda não entregue sai da demanda D
 * porque a posição só conta APROVADA e APROVADA_PARCIAL: U não muda, e C, L e
 * G são recalculados pelas mesmas fórmulas de sempre. Nada de reserva,
 * contador ou alocação gravada.
 */

const servico = () => exigirModulo('src/services/solicitacao-epi.service');
const encerrar = (pool, dados) => {
  const modulo = servico();
  assert.equal(typeof modulo.encerrarSolicitacao, 'function', 'função ainda não implementada: encerrarSolicitacao');
  return modulo.encerrarSolicitacao(pool, dados);
};
const entregaSvc = () => exigirModulo('src/services/entrega-solicitacao.service');

const JUSTIFICATIVA = 'Trabalhador transferido para outra unidade';
const DECLARACAO = 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).';
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };

describe('encerramento da solicitação de EPI — serviço (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let f;

  const q = (sql, params) => pool.query(sql, params);
  const encerrarA = (solicitacaoId, extra = {}) => encerrar(pool, {
    empresaId: d.empresaA, atorId: d.sst1, solicitacaoId, justificativa: JUSTIFICATIVA, hoje: f.HOJE, ...extra,
  });
  const criar = (itens, extra = {}) => servico().criarSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: d.trabalhador, itens, chaveIdempotencia: chaveNova(), ...extra,
  });
  const decidir = (solicitacaoId, decisoes, extra = {}) => servico().decidirSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.sst1, solicitacaoId, decisoes, hoje: f.HOJE, ...extra,
  });
  const entregarPorSolicitacao = (alvo, loteId, quantidade) => entregaSvc().registrarEntregaPorSolicitacao(pool, {
    empresaId: d.empresaA,
    atorId: d.master,
    solicitacaoId: alvo.id,
    itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade }],
    confirmacao: ACEITE,
    chaveIdempotencia: chaveNova(),
  });
  const linha = async (id) => (await q('SELECT * FROM solicitacoes_epi WHERE id = $1', [id])).rows[0];
  const auditorias = async (id) => (await q(
    "SELECT * FROM logs_auditoria WHERE acao = 'SOLICITACAO_EPI_ENCERRADA' AND empresa_id = $1 AND referencia = $2 ORDER BY id", [d.empresaA, String(id)],
  )).rows;
  const fotoDoEstoque = async (materialId) => (await q(
    `SELECT (SELECT json_agg(l ORDER BY l.id) FROM estoque_lotes l WHERE l.material_id = $1) AS lotes,
            (SELECT json_agg(o ORDER BY o.id) FROM estoque_operacoes o JOIN estoque_lotes l ON l.id = o.lote_id WHERE l.material_id = $1) AS operacoes,
            (SELECT json_agg(i ORDER BY i.id) FROM entregas_epi_itens i WHERE i.material_id = $1) AS itens_entregues,
            (SELECT count(*)::int FROM entregas_epi) AS entregas, (SELECT count(*)::int FROM fichas_epi) AS fichas,
            (SELECT count(*)::int FROM entregas_epi_confirmacoes) AS confirmacoes`,
    [materialId],
  )).rows[0];

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
    f = criarFerramentas(pool, d);
    await vincularMaterialAoGhe(pool, d.empresaB, d.gheB, d.botinaB);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('o ato e o efeito na posição', () => {
    test('APROVADA sem entrega: vira ENCERRADA com quem, quando e a justificativa; D cai do aprovado, U não muda (U 5, D 3 → D 0, L 5)', async () => {
      const m = await f.material();
      await f.estoque(m, 5);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [5, 3, 3, 2, 0]);
      const estoqueAntes = await fotoDoEstoque(m);

      const visao = await encerrarA(alvo.id);

      assert.equal(visao.solicitacao.status, 'ENCERRADA');
      assert.equal(visao.solicitacao.encerramento.encerradaPor, d.sst1);
      assert.equal(visao.solicitacao.encerramento.justificativa, JUSTIFICATIVA);
      assert.ok(visao.solicitacao.encerramento.encerradaEm instanceof Date);
      assert.equal(visao.solicitacao.situacaoOperacional, null);
      assert.deepEqual(visao.itens.map((i) => [i.quantidadeAprovada, i.quantidadeEntregue, i.quantidadePendente, i.situacao, i.cobertura]), [[3, 0, 0, null, null]]);
      const gravada = await linha(alvo.id);
      assert.deepEqual([gravada.status, gravada.encerrada_por, gravada.justificativa_encerramento], ['ENCERRADA', d.sst1, JUSTIFICATIVA]);
      assert.ok(gravada.encerrada_em >= gravada.decidida_em);
      assert.deepEqual(f.numeros(await f.posicao(m)), [5, 0, 0, 5, 0]);
      assert.deepEqual(await fotoDoEstoque(m), estoqueAntes, 'nenhum lote, operação, entrega ou ficha muda');
    });

    test('com G > 0: U 1 e aprovada 4 (D 4, C 1, L 0, G 3) passa a D 0, C 0, L 1, G 0', async () => {
      const m = await f.material();
      await f.estoque(m, 1);
      const alvo = await f.aprovada({ materialId: m, quantidade: 4 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 4, 1, 0, 3]);
      await encerrarA(alvo.id);
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 0, 0, 1, 0]);
    });

    test('com entrega parcial: a entrega fica, só o restante sai de D, e o detalhe mostra a entregue preservada e o pendente zero', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 6);
      const alvo = await f.aprovada({ materialId: m, quantidade: 4 });
      await entregarPorSolicitacao(alvo, loteId, 1);
      assert.deepEqual(f.numeros(await f.posicao(m)), [5, 3, 3, 2, 0]);
      const estoqueAntes = await fotoDoEstoque(m);
      assert.equal(estoqueAntes.itens_entregues.length, 1);

      const visao = await encerrarA(alvo.id);

      assert.deepEqual(await fotoDoEstoque(m), estoqueAntes, 'a entrega, o lote, a operação, a ficha e a confirmação ficam intactos');
      assert.deepEqual(f.numeros(await f.posicao(m)), [5, 0, 0, 5, 0]);
      assert.deepEqual(visao.itens.map((i) => [i.quantidadeAprovada, i.quantidadeEntregue, i.quantidadePendente]), [[4, 1, 0]]);
      assert.deepEqual(await f.lote(loteId), { entrada: 6, baixada: 0, entregue: 1, saldo: 5 });
    });

    test('APROVADA_PARCIAL com vários itens e vários pares: cada par perde só o seu pendente; o item reprovado não conta', async () => {
      const a = await f.material();
      const b = await f.material();
      const c = await f.material();
      const loteA = await f.estoque(a, 10);
      await f.estoque(b, 1);
      await f.estoque(a, 4, { tamanho: '42' });
      const { solicitacao, itens } = await criar([
        { materialId: a, tamanho: '40', quantidade: 5, motivo: 'ADMISSAO' },
        { materialId: a, tamanho: '42', quantidade: 2, motivo: 'ADMISSAO' },
        { materialId: b, tamanho: '40', quantidade: 3, motivo: 'ADMISSAO' },
        { materialId: c, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' },
      ]);
      const porMaterial = (materialId, tamanho) => itens.find((i) => i.materialId === materialId && i.tamanho === tamanho);
      const decidida = await decidir(solicitacao.id, [
        { itemId: porMaterial(a, '40').id, decisao: 'APROVADO', quantidadeAprovada: 4, justificativa: 'Reduzida para o turno atual' },
        { itemId: porMaterial(a, '42').id, decisao: 'APROVADO' },
        { itemId: porMaterial(b, '40').id, decisao: 'APROVADO' },
        { itemId: porMaterial(c, '40').id, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada' },
      ]);
      assert.equal(decidida.solicitacao.status, 'APROVADA_PARCIAL');
      await entregarPorSolicitacao({ id: solicitacao.id, item: porMaterial(a, '40').id }, loteA, 1);
      assert.deepEqual(f.numeros(await f.posicao(a, '40')), [9, 3, 3, 6, 0]);
      assert.deepEqual(f.numeros(await f.posicao(a, '42')), [4, 2, 2, 2, 0]);
      assert.deepEqual(f.numeros(await f.posicao(b, '40')), [1, 3, 1, 0, 2]);
      assert.deepEqual(f.numeros(await f.posicao(c, '40')), [0, 0, 0, 0, 0]);

      await encerrarA(solicitacao.id);

      assert.deepEqual(f.numeros(await f.posicao(a, '40')), [9, 0, 0, 9, 0]);
      assert.deepEqual(f.numeros(await f.posicao(a, '42')), [4, 0, 0, 4, 0]);
      assert.deepEqual(f.numeros(await f.posicao(b, '40')), [1, 0, 0, 1, 0]);
      const [registro] = await auditorias(solicitacao.id);
      assert.deepEqual(
        registro.contexto.pares.map((p) => [p.materialId, p.tamanho, p.posicaoAntes.demandaPendente, p.posicaoDepois.demandaPendente]).sort((x, y) => x[0] - y[0] || String(x[1]).localeCompare(String(y[1]))),
        [[a, '40', 3, 0], [a, '42', 2, 0], [b, '40', 3, 0]].sort((x, y) => x[0] - y[0] || String(x[1]).localeCompare(String(y[1]))),
      );
      assert.deepEqual([registro.contexto.quantidadeAprovada, registro.contexto.quantidadeEntregue, registro.contexto.quantidadeLiberada], [9, 1, 8]);
    });

    test('a fila FIFO anda: a solicitação aprovada depois, no mesmo par, recebe a cobertura que a encerrada segurava', async () => {
      const m = await f.material();
      await f.estoque(m, 2);
      const primeira = await f.aprovada({ materialId: m, quantidade: 2 });
      const segunda = await f.aprovada({ materialId: m, quantidade: 2, funcionarioId: d.trabalhador2 });
      const antes = await servico().buscarSolicitacao(pool, { empresaId: d.empresaA, solicitacaoId: segunda.id, hoje: f.HOJE });
      assert.equal(antes.solicitacao.situacaoOperacional, 'AGUARDANDO_ESTOQUE');
      await encerrarA(primeira.id);
      const depois = await servico().buscarSolicitacao(pool, { empresaId: d.empresaA, solicitacaoId: segunda.id, hoje: f.HOJE });
      assert.equal(depois.solicitacao.situacaoOperacional, 'PRONTA_PARA_ENTREGA');
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 2, 2, 0, 0]);
    });

    test('o saldo liberado serve à entrega DIRETA: antes do encerramento ela é recusada por saldo livre; depois, passa', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 2);
      const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
      await assert.rejects(f.direta([[m, loteId, 1]]), (erro) => erro.codigo === 'SALDO_LIVRE_INSUFICIENTE');
      await encerrarA(alvo.id);
      const entrega = await f.direta([[m, loteId, 1]]);
      assert.equal(entrega.entrega.origem, 'DIRETA');
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 0, 0, 1, 0]);
    });

    test('a solicitação suspensa (trabalhador inativo) também é encerrada, e reativar o trabalhador não devolve a demanda', async () => {
      const m = await f.material();
      await f.estoque(m, 5);
      const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
      const alvo = await f.aprovada({ materialId: m, quantidade: 2, funcionarioId: trabalhador });
      await q("UPDATE funcionarios SET situacao = 'INATIVO' WHERE id = $1", [trabalhador]);
      try {
        assert.deepEqual(f.numeros(await f.posicao(m)), [5, 0, 0, 5, 0], 'suspensa: a demanda já está fora');
        const visao = await encerrarA(alvo.id);
        assert.equal(visao.solicitacao.status, 'ENCERRADA');
      } finally {
        await q("UPDATE funcionarios SET situacao = 'ATIVO' WHERE id = $1", [trabalhador]);
      }
      assert.deepEqual(f.numeros(await f.posicao(m)), [5, 0, 0, 5, 0], 'a encerrada não volta à demanda com a reativação');
    });
  });

  describe('estados, justificativa e autoria', () => {
    test('PENDENTE, REPROVADA, CANCELADA, ENTREGUE e ENCERRADA não encerram: 409 SOLICITACAO_NAO_ENCERRAVEL, sem gravar nem auditar', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 5);
      const pendente = await criar([{ materialId: m, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }]);
      const reprovada = await criar([{ materialId: m, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], { funcionarioId: d.trabalhador2 });
      await decidir(reprovada.solicitacao.id, [{ itemId: reprovada.itens[0].id, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada' }]);
      const cancelada = await criar([{ materialId: m, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], { funcionarioId: d.trabalhador3 });
      await servico().cancelarSolicitacao(pool, { empresaId: d.empresaA, atorId: d.solicitante, solicitacaoId: cancelada.solicitacao.id });
      const entregue = await f.aprovada({ materialId: m, quantidade: 1, funcionarioId: await d.novoTrabalhador(d.empresaA, { gheId: d.gheA }) });
      await entregarPorSolicitacao(entregue, loteId, 1);
      const encerrada = await f.aprovada({ materialId: m, quantidade: 1 });
      await encerrarA(encerrada.id);

      for (const [rotulo, id] of [
        ['PENDENTE', pendente.solicitacao.id], ['REPROVADA', reprovada.solicitacao.id], ['CANCELADA', cancelada.solicitacao.id],
        ['ENTREGUE', entregue.id], ['ENCERRADA', encerrada.id],
      ]) {
        const antes = await linha(id);
        const auditadas = (await auditorias(id)).length;
        await esperarHttpError(encerrarA(id, { atorId: d.sst2, justificativa: 'Outra tentativa' }), 409, 'SOLICITACAO_NAO_ENCERRAVEL');
        assert.deepEqual(await linha(id), antes, rotulo);
        assert.equal((await auditorias(id)).length, auditadas, rotulo);
      }
      assert.equal((await linha(encerrada.id)).justificativa_encerramento, JUSTIFICATIVA, 'a segunda tentativa não regrava');
    });

    test('justificativa obrigatória: ausente ou só espaços é 400 JUSTIFICATIVA_OBRIGATORIA; a gravada sai aparada e normalizada', async () => {
      const m = await f.material();
      const alvo = await f.aprovada({ materialId: m, quantidade: 1 });
      for (const justificativa of [undefined, null, '', '   ', '\t\n']) {
        await esperarValidacao(encerrarA(alvo.id, { justificativa }), 'body.justificativa', 'JUSTIFICATIVA_OBRIGATORIA');
      }
      await esperarValidacao(encerrarA(alvo.id, { justificativa: 'x'.repeat(501) }), 'body.justificativa', 'JUSTIFICATIVA_INVALIDA');
      assert.equal((await linha(alvo.id)).status, 'APROVADA');
      await encerrarA(alvo.id, { justificativa: '  Transferência confirmada  ' });
      assert.equal((await linha(alvo.id)).justificativa_encerramento, 'Transferência confirmada');
    });

    test('quem criou a solicitação pode encerrá-la (sem regra de autodecisão); a decisão continua proibida a ele', async () => {
      const m = await f.material();
      const alvo = await f.aprovada({ materialId: m, quantidade: 1 });
      const visao = await encerrarA(alvo.id, { atorId: d.solicitante });
      assert.equal(visao.solicitacao.encerramento.encerradaPor, d.solicitante);
      const [registro] = await auditorias(alvo.id);
      assert.equal(registro.contexto.autoencerramento, true);
      const pendente = await criar([{ materialId: m, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }]);
      await esperarHttpError(decidir(pendente.solicitacao.id, [{ itemId: pendente.itens[0].id, decisao: 'APROVADO' }], { atorId: d.solicitante }), 403, 'AUTODECISAO_PROIBIDA');
    });

    test('encerrador inativo: 403 USUARIO_INATIVO; inexistente na empresa: 404; nada muda', async () => {
      const m = await f.material();
      const alvo = await f.aprovada({ materialId: m, quantidade: 1 });
      await esperarHttpError(encerrarA(alvo.id, { atorId: d.usuarioInativo }), 403, 'USUARIO_INATIVO');
      await esperarHttpError(encerrarA(alvo.id, { atorId: d.usuarioB }), 404, 'USUARIO_NAO_ENCONTRADO');
      assert.equal((await linha(alvo.id)).status, 'APROVADA');
      assert.equal((await auditorias(alvo.id)).length, 0);
    });
  });

  describe('isolamento por empresa', () => {
    test('a solicitação de outra empresa é "não encontrada", e a posição dela não muda', async () => {
      const loteB = await f.estoque(d.botinaB, 3, { empresaId: d.empresaB, usuarioId: d.masterB });
      assert.ok(loteB);
      const criada = await servico().criarSolicitacao(pool, {
        empresaId: d.empresaB, atorId: d.usuarioB, funcionarioId: d.trabalhadorB, itens: [{ materialId: d.botinaB, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
      });
      await servico().decidirSolicitacao(pool, {
        empresaId: d.empresaB, atorId: d.sstB, solicitacaoId: criada.solicitacao.id, decisoes: [{ itemId: criada.itens[0].id, decisao: 'APROVADO' }], hoje: f.HOJE,
      });
      const posicaoB = async () => (await require('../../src/repositories/solicitacao-epi-cobertura.repository').lerPosicoes(
        pool, d.empresaB, [{ materialId: d.botinaB, tamanho: '40' }], { hoje: f.HOJE },
      ))[0];
      const antes = await posicaoB();
      await esperarHttpError(encerrarA(criada.solicitacao.id), 404, 'SOLICITACAO_NAO_ENCONTRADA');
      assert.equal((await linha(criada.solicitacao.id)).status, 'APROVADA');
      assert.deepEqual(await posicaoB(), antes);
      const visaoB = await encerrar(pool, {
        empresaId: d.empresaB, atorId: d.sstB, solicitacaoId: criada.solicitacao.id, justificativa: JUSTIFICATIVA, hoje: f.HOJE,
      });
      assert.equal(visaoB.solicitacao.status, 'ENCERRADA');
      assert.equal((await q("SELECT count(*)::int AS n FROM logs_auditoria WHERE acao = 'SOLICITACAO_EPI_ENCERRADA' AND referencia = $1 AND empresa_id = $2", [String(criada.solicitacao.id), d.empresaA])).rows[0].n, 0);
    });
  });

  describe('auditoria', () => {
    test('SOLICITACAO_EPI_ENCERRADA na mesma transação: ids, status, quantidades e posição; sem justificativa, observação, CPF nem texto livre', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 3);
      const criada = await criar([{ materialId: m, tamanho: '40', quantidade: 3, motivo: 'OUTRO', justificativa: 'Pedido especial do setor' }], { observacao: 'Observação livre do pedido' });
      await decidir(criada.solicitacao.id, [{ itemId: criada.itens[0].id, decisao: 'APROVADO' }]);
      await entregarPorSolicitacao({ id: criada.solicitacao.id, item: criada.itens[0].id }, loteId, 1);
      await encerrarA(criada.solicitacao.id, { ip: '203.0.113.10', dispositivo: 'Navegador de teste' });

      const [registro, ...outros] = await auditorias(criada.solicitacao.id);
      assert.equal(outros.length, 0);
      assert.deepEqual([registro.usuario_id, registro.descricao, registro.ip, registro.dispositivo], [d.sst1, null, '203.0.113.10', 'Navegador de teste']);
      assert.deepEqual(registro.dados_anteriores, { status: 'APROVADA' });
      assert.deepEqual(registro.dados_novos, { status: 'ENCERRADA' });
      assert.deepEqual(
        [registro.contexto.solicitacaoId, registro.contexto.funcionarioId, registro.contexto.autoencerramento, registro.contexto.comEntregaAnterior],
        [criada.solicitacao.id, d.trabalhador, false, true],
      );
      assert.deepEqual(registro.contexto.itens, [{
        itemId: criada.itens[0].id, materialId: m, tamanho: '40', quantidadeAprovada: 3, quantidadeEntregue: 1, quantidadeLiberada: 2,
      }]);
      assert.deepEqual(registro.contexto.pares, [{
        materialId: m,
        tamanho: '40',
        posicaoAntes: { fisicoUtilizavel: 2, demandaPendente: 2, comprometido: 2, saldoLivre: 0, semCobertura: 0 },
        posicaoDepois: { fisicoUtilizavel: 2, demandaPendente: 0, comprometido: 0, saldoLivre: 2, semCobertura: 0 },
      }]);
      const texto = JSON.stringify(registro);
      const { rows: [{ cpf }] } = await q('SELECT cpf FROM funcionarios WHERE id = $1', [d.trabalhador]);
      for (const proibido of [JUSTIFICATIVA, 'Pedido especial do setor', 'Observação livre do pedido', cpf]) assert.equal(texto.includes(proibido), false, proibido);
    });

    test('atomicidade: se a auditoria falhar, nada fica (status, encerramento e demanda continuam os de antes)', async (t) => {
      const m = await f.material();
      await f.estoque(m, 1);
      const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
      const antes = await linha(alvo.id);
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha de auditoria'); });
      await assert.rejects(encerrarA(alvo.id), /falha de auditoria/);
      t.mock.restoreAll();
      assert.deepEqual(await linha(alvo.id), antes);
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 2, 1, 0, 1]);
    });
  });

  describe('depois de encerrada', () => {
    test('não recebe entrega por solicitação (409 SOLICITACAO_NAO_ENTREGAVEL), sai dos entregáveis e aparece em "minhas" com restante zero', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 5);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      await entregarPorSolicitacao(alvo, loteId, 1);
      await encerrarA(alvo.id);
      const estoqueAntes = await fotoDoEstoque(m);
      await esperarHttpError(entregarPorSolicitacao(alvo, loteId, 1), 409, 'SOLICITACAO_NAO_ENTREGAVEL');
      assert.deepEqual(await fotoDoEstoque(m), estoqueAntes);

      const entregaveis = await consulta.listarEntregaveis(pool, { empresaId: d.empresaA, pagina: 1, limite: 100, hoje: f.HOJE });
      assert.equal(entregaveis.solicitacoes.some((s) => s.id === alvo.id), false);
      const minhas = await consulta.listarMinhas(pool, {
        empresaId: d.empresaA, atorId: d.solicitante, status: 'ENCERRADA', pagina: 1, limite: 100, hoje: f.HOJE,
      });
      const daLista = minhas.solicitacoes.find((s) => s.id === alvo.id);
      assert.deepEqual([daLista.status, daLista.situacaoOperacional, daLista.quantidades], ['ENCERRADA', null, { solicitada: 3, aprovada: 3, entregue: 1, restante: 0 }]);
      assert.equal(JSON.stringify(minhas).includes(JUSTIFICATIVA), false, 'a justificativa não vai para a lista');
    });

    test('o detalhe da solicitação devolve o encerramento com a justificativa', async () => {
      const m = await f.material();
      const alvo = await f.aprovada({ materialId: m, quantidade: 1 });
      await encerrarA(alvo.id, { atorId: d.sst2 });
      const lida = await servico().buscarSolicitacao(pool, { empresaId: d.empresaA, solicitacaoId: alvo.id, hoje: f.HOJE });
      assert.deepEqual([lida.solicitacao.status, lida.solicitacao.encerramento.encerradaPor, lida.solicitacao.encerramento.justificativa], ['ENCERRADA', d.sst2, JUSTIFICATIVA]);
      assert.deepEqual(lida.solicitacao.decisao.decididaPor, d.sst1);
    });
  });
});
