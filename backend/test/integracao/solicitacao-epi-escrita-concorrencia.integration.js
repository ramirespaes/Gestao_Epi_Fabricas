'use strict';

const {
  describe, test, before, after,
} = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const {
  chaveNova, comLimite, portao, aguardarTravaAdvisoryPendente, aguardarEsperaPorTravaDeLinha, inserirUsuario,
} = require('./helpers/solicitacao-epi-servico');
const { ACEITE } = require('./helpers/reserva-estoque');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const itemRepo = require('../../src/repositories/solicitacao-epi-item.repository');
const coberturaRepo = require('../../src/repositories/solicitacao-epi-cobertura.repository');
const solicitacaoRepo = require('../../src/repositories/solicitacao-epi.repository');
const numeracaoRepo = require('../../src/repositories/solicitacao-epi-numeracao.repository');
const vinculoRepo = require('../../src/repositories/vinculo-sst.repository');

/**
 * A camada HTTP da 12F-2 não muda a semântica de concorrência do domínio. As
 * requisições correm de verdade em paralelo pelas rotas de produção, cada uma
 * na sua conexão do PostgreSQL real. Os cenários ordenados usam portões (a
 * primeira operação para com as travas já tomadas) e esperam no próprio
 * PostgreSQL a segunda ficar bloqueada; nenhum depende de tempo. Os cenários de
 * rajada não têm ordem: só o resultado final importa.
 */

const LIMITE_MS = 30000;
const disparar = (requisicao) => comLimite(new Promise((resolve, reject) => {
  requisicao.end((erro, r) => (erro ? reject(erro) : resolve(r)));
}), 'requisição HTTP', LIMITE_MS);

/**
 * Primeira requisição parada no portão (travas tomadas), segunda disparada e
 * observada à espera no PostgreSQL, depois o portão abre. Se a primeira
 * responder sem chegar ao portão, o cenário falha na hora, e o portão é sempre
 * liberado, para nenhuma transação ficar presa.
 */
async function emOrdem(t, [modulo, funcao], primeiraReq, segundaReq, esperarBloqueio) {
  const gate = portao(t, modulo, funcao);
  const primeira = disparar(primeiraReq());
  try {
    const antes = await Promise.race([gate.chegada.then(() => null), primeira]);
    if (antes !== null) assert.fail(`a primeira requisição respondeu sem chegar ao portão: ${antes.status} ${JSON.stringify(antes.body)}`);
    const segunda = disparar(segundaReq());
    await esperarBloqueio();
    gate.liberar();
    return await Promise.all([primeira, segunda]);
  } finally {
    gate.liberar();
  }
}

describe('escrita HTTP da solicitação e do vínculo SST — concorrência (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  const u = {};

  const q = (sql, params) => pool.query(sql, params);
  const statusDe = async (alvo) => (await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [alvo.id])).rows[0].status;
  const entregueDe = async (alvo) => (await q('SELECT COALESCE(sum(quantidade), 0)::int AS n FROM entregas_epi_itens WHERE solicitacao_item_id = $1', [alvo.item])).rows[0].n;
  const contarAuditoria = async (acao, referencia) => (await q('SELECT count(*)::int AS n FROM logs_auditoria WHERE acao = $1 AND referencia = $2', [acao, String(referencia)])).rows[0].n;
  const encerrar = (ator, alvo, justificativa = 'Encerramento concorrente') => como(ator).post(`/api/solicitacoes-epi/${alvo.id}/encerramento`, { justificativa });
  const entregar = (ator, alvo, loteId, quantidade, chave = chaveNova()) => como(ator).post(`/api/solicitacoes-epi/${alvo.id}/entregas`, {
    itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade }], confirmacao: ACEITE, chaveIdempotencia: chave,
  });
  const pendenteDe = async (atorId, materialId, quantidade = 1) => {
    const criada = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId, funcionarioId: d.trabalhador, itens: [{ materialId, tamanho: '40', quantidade, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    return { id: criada.solicitacao.id, item: criada.itens[0].id };
  };
  const decidir = (ator, alvo, decisao) => como(ator).post(`/api/solicitacoes-epi/${alvo.id}/decisao`, {
    decisoes: [{ itemId: alvo.item, decisao, ...(decisao === 'REPROVADO' ? { justificativa: 'Sem necessidade' } : {}) }],
  });

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f, como } = env);
    const SST = { perfil: 'ADMINISTRADOR', sst: true };
    u.solicitante = await env.usuarioCom(d.empresaA, { recursos: { request: ['criar', 'editar'] } });
    u.encerrador = await env.usuarioCom(d.empresaA, { ...SST, acoes: ['ENCERRAR_SOLICITACAO'] });
    u.encerrador2 = await env.usuarioCom(d.empresaA, { ...SST, acoes: ['ENCERRAR_SOLICITACAO'] });
    u.decisor = await env.usuarioCom(d.empresaA, { ...SST, acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO'] });
    u.decisor2 = await env.usuarioCom(d.empresaA, { ...SST, acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO'] });
    u.entregador = await env.usuarioCom(d.empresaA, { acoes: ['REALIZAR_ENTREGA'] });
  });

  after(async () => { if (env) await env.encerrar(); });

  describe('encerramento × entrega: os quatro cenários da 12E-2, agora pela camada HTTP', () => {
    test('A) o encerramento vence: a entrega que chega depois espera a solicitação e recebe 409 SOLICITACAO_NAO_ENTREGAVEL, sem gravar nada', async (t) => {
      const m = await f.material();
      const loteId = await f.estoque(m, 3);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      const [rEncerrar, rEntrega] = await emOrdem(
        t, [itemRepo, 'listarPorSolicitacaoComEntregue'], () => encerrar(u.encerrador, alvo), () => entregar(u.entregador, alvo, loteId, 1), () => aguardarEsperaPorTravaDeLinha(pool),
      );
      assert.equal(rEncerrar.status, 200, JSON.stringify(rEncerrar.body));
      assert.deepEqual([rEntrega.status, rEntrega.body.codigo], [409, 'SOLICITACAO_NAO_ENTREGAVEL']);
      assert.equal(await statusDe(alvo), 'ENCERRADA');
      assert.equal(await entregueDe(alvo), 0);
      assert.deepEqual(await f.lote(loteId), { entrada: 3, baixada: 0, entregue: 0, saldo: 3 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [3, 0, 0, 3, 0]);
    });

    test('B) a entrega parcial vence: ela é preservada e o encerramento que esperava encerra só o restante', async (t) => {
      const m = await f.material();
      const loteId = await f.estoque(m, 5);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      const [rEntrega, rEncerrar] = await emOrdem(
        t, [coberturaRepo, 'listarCobertura'], () => entregar(u.entregador, alvo, loteId, 1), () => encerrar(u.encerrador, alvo), () => aguardarEsperaPorTravaDeLinha(pool),
      );
      assert.equal(rEntrega.status, 201, JSON.stringify(rEntrega.body));
      assert.equal(rEncerrar.status, 200, JSON.stringify(rEncerrar.body));
      assert.equal(await statusDe(alvo), 'ENCERRADA');
      assert.equal(await entregueDe(alvo), 1);
      assert.deepEqual(await f.lote(loteId), { entrada: 5, baixada: 0, entregue: 1, saldo: 4 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [4, 0, 0, 4, 0]);
      assert.deepEqual(rEncerrar.body.itens.map((i) => [i.quantidadeEntregue, i.quantidadePendente]), [[1, 0]]);
    });

    test('C) a entrega final vence: a solicitação fecha ENTREGUE e o encerramento que esperava recebe 409 SOLICITACAO_NAO_ENCERRAVEL', async (t) => {
      const m = await f.material();
      const loteId = await f.estoque(m, 3);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      const [rEntrega, rEncerrar] = await emOrdem(
        t, [coberturaRepo, 'listarCobertura'], () => entregar(u.entregador, alvo, loteId, 3), () => encerrar(u.encerrador, alvo), () => aguardarEsperaPorTravaDeLinha(pool),
      );
      assert.equal(rEntrega.status, 201, JSON.stringify(rEntrega.body));
      assert.equal(rEntrega.body.solicitacao.status, 'ENTREGUE');
      assert.deepEqual([rEncerrar.status, rEncerrar.body.codigo], [409, 'SOLICITACAO_NAO_ENCERRAVEL']);
      assert.equal(await statusDe(alvo), 'ENTREGUE');
      assert.equal(await entregueDe(alvo), 3);
      assert.equal(await contarAuditoria('SOLICITACAO_EPI_ENCERRADA', alvo.id), 0);
    });

    test('D) dois encerramentos ao mesmo tempo: um conclui; o outro espera e recebe 409 SOLICITACAO_NAO_ENCERRAVEL; uma auditoria só', async (t) => {
      const m = await f.material();
      await f.estoque(m, 1);
      const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
      const [r1, r2] = await emOrdem(
        t, [itemRepo, 'listarPorSolicitacaoComEntregue'], () => encerrar(u.encerrador, alvo), () => encerrar(u.encerrador2, alvo, 'Segunda tentativa'), () => aguardarEsperaPorTravaDeLinha(pool),
      );
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.deepEqual([r2.status, r2.body.codigo], [409, 'SOLICITACAO_NAO_ENCERRAVEL']);
      const { rows: [lida] } = await q('SELECT encerrada_por, justificativa_encerramento FROM solicitacoes_epi WHERE id = $1', [alvo.id]);
      assert.deepEqual([lida.encerrada_por, lida.justificativa_encerramento], [u.encerrador, 'Encerramento concorrente']);
      assert.equal(await contarAuditoria('SOLICITACAO_EPI_ENCERRADA', alvo.id), 1);
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 0, 0, 1, 0]);
    });
  });

  describe('decisão, cancelamento e repetições concorrentes', () => {
    test('duas decisões ao mesmo tempo: a primeira decide; a segunda espera e recebe 409 SOLICITACAO_NAO_PENDENTE; uma auditoria de decisão', async (t) => {
      const alvo = await pendenteDe(u.solicitante, await f.material());
      const [r1, r2] = await emOrdem(
        t, [itemRepo, 'listarPorSolicitacao'], () => decidir(u.decisor, alvo, 'APROVADO'), () => decidir(u.decisor2, alvo, 'REPROVADO'), () => aguardarEsperaPorTravaDeLinha(pool),
      );
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.deepEqual([r2.status, r2.body.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
      assert.equal(await statusDe(alvo), 'APROVADA');
      assert.equal(await contarAuditoria('SOLICITACAO_EPI_DECIDIDA', alvo.id), 1);
    });

    test('cancelamento × decisão: o cancelamento que chegou antes vence; a decisão espera e recebe 409 SOLICITACAO_NAO_PENDENTE', async (t) => {
      const alvo = await pendenteDe(u.solicitante, await f.material());
      const [r1, r2] = await emOrdem(
        t, [solicitacaoRepo, 'cancelar'], () => como(u.solicitante).post(`/api/solicitacoes-epi/${alvo.id}/cancelamento`, {}), () => decidir(u.decisor, alvo, 'APROVADO'),
        () => aguardarEsperaPorTravaDeLinha(pool),
      );
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.deepEqual([r2.status, r2.body.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
      assert.equal(await statusDe(alvo), 'CANCELADA');
      assert.equal(await contarAuditoria('SOLICITACAO_EPI_DECIDIDA', alvo.id), 0);
    });

    test('a mesma criação duas vezes ao mesmo tempo (mesma chave): uma 201, a outra espera a chave e recebe 200 repetida com a mesma solicitação; uma linha só', async (t) => {
      const m = await f.material();
      const corpo = {
        funcionarioId: d.trabalhador, itens: [{ materialId: m, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
      };
      const criar = () => como(u.solicitante).post('/api/solicitacoes-epi', corpo);
      const respostas = await emOrdem(t, [numeracaoRepo, 'proximoNumero'], criar, criar, () => aguardarTravaAdvisoryPendente(pool));
      assert.deepEqual(respostas.map((r) => [r.status, r.body.repetida]), [[201, false], [200, true]]);
      assert.equal(respostas[0].body.solicitacao.id, respostas[1].body.solicitacao.id);
      const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM solicitacoes_epi WHERE chave_idempotencia = $1', [corpo.chaveIdempotencia]);
      assert.equal(n, 1);
    });

    test('a mesma entrega duas vezes ao mesmo tempo (mesma chave): uma 201, a outra espera a chave e recebe 200 repetida; o lote baixa uma vez só', async (t) => {
      const m = await f.material();
      const loteId = await f.estoque(m, 5);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      const chave = chaveNova();
      const mesma = () => entregar(u.entregador, alvo, loteId, 2, chave);
      const respostas = await emOrdem(t, [coberturaRepo, 'listarCobertura'], mesma, mesma, () => aguardarTravaAdvisoryPendente(pool));
      assert.deepEqual(respostas.map((r) => [r.status, r.body.repetida]), [[201, false], [200, true]]);
      assert.equal(respostas[0].body.entrega.id, respostas[1].body.entrega.id);
      assert.equal(await entregueDe(alvo), 2);
      assert.deepEqual(await f.lote(loteId), { entrada: 5, baixada: 0, entregue: 2, saldo: 3 });
    });

    test('duas concessões do mesmo vínculo ao mesmo tempo (MASTERs diferentes): uma 201, a outra espera o alvo e recebe 409 VINCULO_SST_JA_EXISTE', async (t) => {
      const alvo = await inserirUsuario(pool, d.empresaA, 'alvo-concorrencia-12f2@example.invalid', 'ADMINISTRADOR');
      const [r1, r2] = await emOrdem(
        t, [vinculoRepo, 'inserir'], () => como(d.master).post('/api/vinculos-sst', { usuarioId: alvo }), () => como(d.master2).post('/api/vinculos-sst', { usuarioId: alvo }),
        () => aguardarEsperaPorTravaDeLinha(pool),
      );
      assert.equal(r1.status, 201, JSON.stringify(r1.body));
      assert.deepEqual([r2.status, r2.body.codigo], [409, 'VINCULO_SST_JA_EXISTE']);
      assert.equal(await contarAuditoria('VINCULO_SST_ADICIONADO', alvo), 1);
    });
  });

  describe('rajadas sem ordem: só o resultado final importa', () => {
    test('cinco encerramentos simultâneos: exatamente um 200, quatro 409 SOLICITACAO_NAO_ENCERRAVEL, uma auditoria', async () => {
      const m = await f.material();
      await f.estoque(m, 2);
      const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
      const respostas = await Promise.all(Array.from({ length: 5 }, (_, i) => disparar(encerrar(i % 2 === 0 ? u.encerrador : u.encerrador2, alvo, `Tentativa ${i}`))));
      const status = respostas.map((r) => r.status).sort();
      assert.deepEqual(status, [200, 409, 409, 409, 409]);
      assert.ok(respostas.filter((r) => r.status === 409).every((r) => r.body.codigo === 'SOLICITACAO_NAO_ENCERRAVEL'));
      assert.equal(await contarAuditoria('SOLICITACAO_EPI_ENCERRADA', alvo.id), 1);
      assert.deepEqual(f.numeros(await f.posicao(m)), [2, 0, 0, 2, 0]);
    });

    test('cinco entregas simultâneas de 1 numa solicitação com 3 pendentes: exatamente três 201, o lote baixa 3, a solicitação fecha ENTREGUE e as outras recebem 409', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 10);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      const respostas = await Promise.all(Array.from({ length: 5 }, () => disparar(entregar(u.entregador, alvo, loteId, 1))));
      assert.equal(respostas.filter((r) => r.status === 201).length, 3, JSON.stringify(respostas.map((r) => [r.status, r.body.codigo])));
      for (const r of respostas.filter((x) => x.status !== 201)) {
        assert.equal(r.status, 409);
        assert.ok(['SOLICITACAO_NAO_ENTREGAVEL', 'QUANTIDADE_ACIMA_DO_PENDENTE'].includes(r.body.codigo), r.body.codigo);
      }
      assert.equal(await entregueDe(alvo), 3);
      assert.equal(await statusDe(alvo), 'ENTREGUE');
      assert.deepEqual(await f.lote(loteId), { entrada: 10, baixada: 0, entregue: 3, saldo: 7 });
      assert.equal(await contarAuditoria('SOLICITACAO_EPI_ENTREGUE', alvo.id), 1);
    });
  });
});
