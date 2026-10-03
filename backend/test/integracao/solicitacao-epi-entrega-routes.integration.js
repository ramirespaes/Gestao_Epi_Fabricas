'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { vincularMaterialAoGhe, chaveNova } = require('./helpers/solicitacao-epi-servico');
const { criarLoteDeEntrada } = require('./helpers/solicitacao-epi');
const { ACEITE } = require('./helpers/reserva-estoque');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');

/**
 * Entrega por solicitação pela camada HTTP (12F-2), contra PostgreSQL real:
 *   POST /api/solicitacoes-epi/:id/entregas   ação REALIZAR_ENTREGA.
 * A rota só valida a entrada, autoriza e delega ao serviço da 12C: cobertura
 * FIFO, pendente, lote, estoque, ficha, confirmação, auditoria e o fechamento
 * ENTREGUE continuam sendo do domínio, que recalcula tudo depois das travas.
 * Empresa e responsável vêm da sessão; o que o servidor deriva da solicitação
 * não vem do cliente. Outra empresa recebe o mesmo 404 da inexistente.
 */

const ID_INEXISTENTE = 2147483000;
const entregas = (id) => `/api/solicitacoes-epi/${id}/entregas`;

describe('entrega por solicitação HTTP (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  const u = {};

  const q = (sql, params) => pool.query(sql, params);
  const resposta = (r) => ({ status: r.status, corpo: r.body });
  const cpfs = async () => (await q('SELECT cpf FROM funcionarios')).rows.map((l) => l.cpf);
  const semCpf = async (texto, rotulo) => { for (const cpf of await cpfs()) assert.equal(texto.includes(cpf), false, `CPF em ${rotulo}`); };
  const corpo = (alvo, loteId, quantidade, extra = {}) => ({
    itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(), ...extra,
  });
  const statusDe = async (alvo) => (await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [alvo.id])).rows[0].status;
  const entregasDe = async (alvo) => (await q(
    'SELECT count(*)::int AS n, COALESCE(sum(quantidade), 0)::int AS quantidade FROM entregas_epi_itens WHERE solicitacao_item_id = $1', [alvo.item],
  )).rows[0];
  const auditorias = async (acao, referencia) => (await q(
    'SELECT usuario_id, contexto FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id', [acao, String(referencia)],
  )).rows;

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f, como } = env);
    u.entregador = await env.usuarioCom(d.empresaA, { acoes: ['REALIZAR_ENTREGA'] });
    u.sstSemEntrega = await env.usuarioCom(d.empresaA, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO'], sst: true });
    u.semNada = await env.usuarioCom(d.empresaA);
    u.entregadorB = await env.usuarioCom(d.empresaB, { acoes: ['REALIZAR_ENTREGA'] });
    await vincularMaterialAoGhe(pool, d.empresaB, d.gheB, d.botinaB);
  });

  after(async () => { if (env) await env.encerrar(); });

  test('parcial: 201 SOLICITACAO; responsável, ficha e auditoria da sessão e da solicitação; continua APROVADA; o lote e a posição andam juntos; sem CPF', async () => {
    const m = await f.material();
    const loteId = await f.estoque(m, 5);
    const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
    assert.deepEqual(f.numeros(await f.posicao(m)), [5, 3, 3, 2, 0]);
    const r = await como(u.entregador).post(entregas(alvo.id), corpo(alvo, loteId, 1)).set('User-Agent', 'Tablet do almoxarifado');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.status, r.body.repetida, r.body.entrega.origem], ['ok', false, 'SOLICITACAO']);
    assert.deepEqual(r.body.solicitacao, { id: alvo.id, numero: r.body.solicitacao.numero, status: 'APROVADA', entregueEm: null });
    assert.equal(r.body.entrega.ficha.funcionarioId, d.trabalhador, 'a ficha é a do trabalhador da solicitação');
    await semCpf(JSON.stringify(r.body), 'resposta da entrega');
    const { rows: [gravada] } = await q('SELECT responsavel_id, origem FROM entregas_epi WHERE id = $1', [r.body.entrega.id]);
    assert.deepEqual([gravada.responsavel_id, gravada.origem], [u.entregador, 'SOLICITACAO']);
    assert.deepEqual(await entregasDe(alvo), { n: 1, quantidade: 1 });
    assert.deepEqual(await f.lote(loteId), { entrada: 5, baixada: 0, entregue: 1, saldo: 4 });
    assert.deepEqual(f.numeros(await f.posicao(m)), [4, 2, 2, 2, 0]);
    const [registro] = await auditorias('ENTREGA_REGISTRADA', r.body.entrega.id);
    assert.deepEqual([registro.usuario_id, registro.contexto.solicitacaoId, registro.contexto.entregaParcial], [u.entregador, alvo.id, true]);
  });

  test('final: 201 e a solicitação passa a ENTREGUE no mesmo ato (auditado); depois disso não encerra nem recebe outra entrega (409)', async () => {
    const m = await f.material();
    const loteId = await f.estoque(m, 5);
    const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
    assert.equal((await como(u.entregador).post(entregas(alvo.id), corpo(alvo, loteId, 1))).status, 201);
    const final = await como(d.master).post(entregas(alvo.id), corpo(alvo, loteId, 1));
    assert.equal(final.status, 201, JSON.stringify(final.body));
    assert.equal(final.body.solicitacao.status, 'ENTREGUE');
    assert.ok(final.body.solicitacao.entregueEm);
    assert.equal(await statusDe(alvo), 'ENTREGUE');
    assert.deepEqual((await auditorias('SOLICITACAO_EPI_ENTREGUE', alvo.id)).map((x) => x.usuario_id), [d.master]);
    // sstSemEntrega tem ENCERRAR_SOLICITACAO e vínculo SST: chega ao domínio, que recusa a ENTREGUE.
    const encerrar = await como(u.sstSemEntrega).post(`/api/solicitacoes-epi/${alvo.id}/encerramento`, { justificativa: 'Tarde demais' });
    assert.deepEqual([encerrar.status, encerrar.body.codigo], [409, 'SOLICITACAO_NAO_ENCERRAVEL']);
    const outra = await como(u.entregador).post(entregas(alvo.id), corpo(alvo, loteId, 1));
    assert.deepEqual([outra.status, outra.body.codigo], [409, 'SOLICITACAO_NAO_ENTREGAVEL']);
    assert.deepEqual(await entregasDe(alvo), { n: 2, quantidade: 2 });
    assert.deepEqual(f.numeros(await f.posicao(m)), [3, 0, 0, 3, 0]);
  });

  test('cobertura e pendente são do servidor: acima do pendente é 409 QUANTIDADE_ACIMA_DO_PENDENTE; a mais nova da fila sem cobertura é 409 QUANTIDADE_ACIMA_DA_COBERTURA; nada gravado', async () => {
    const m = await f.material();
    const loteId = await f.estoque(m, 2);
    const primeira = await f.aprovada({ materialId: m, quantidade: 2 });
    const segunda = await f.aprovada({ materialId: m, quantidade: 1, funcionarioId: d.trabalhador2 });
    const antes = f.numeros(await f.posicao(m));
    assert.deepEqual(antes, [2, 3, 2, 0, 1]);
    const acimaDoPendente = await como(u.entregador).post(entregas(primeira.id), corpo(primeira, loteId, 3));
    assert.deepEqual([acimaDoPendente.status, acimaDoPendente.body.codigo], [409, 'QUANTIDADE_ACIMA_DO_PENDENTE']);
    const semCobertura = await como(u.entregador).post(entregas(segunda.id), corpo(segunda, loteId, 1));
    assert.deepEqual([semCobertura.status, semCobertura.body.codigo], [409, 'QUANTIDADE_ACIMA_DA_COBERTURA']);
    assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 0, entregue: 0, saldo: 2 });
    assert.deepEqual(f.numeros(await f.posicao(m)), antes);
    assert.deepEqual([await entregasDe(primeira), await entregasDe(segunda)], [{ n: 0, quantidade: 0 }, { n: 0, quantidade: 0 }]);
  });

  test('sem REALIZAR_ENTREGA (SST que aprova e encerra, ou sem nada): o mesmo 403 PERMISSAO_NEGADA; nada muda', async () => {
    const m = await f.material();
    const loteId = await f.estoque(m, 2);
    const alvo = await f.aprovada({ materialId: m, quantidade: 1 });
    const respostas = [];
    for (const usuario of [u.sstSemEntrega, u.semNada]) respostas.push(resposta(await como(usuario).post(entregas(alvo.id), corpo(alvo, loteId, 1))));
    assert.deepEqual([respostas[0].status, respostas[0].corpo.codigo], [403, 'PERMISSAO_NEGADA']);
    assert.deepEqual(respostas[1], respostas[0]);
    assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 0, entregue: 0, saldo: 2 });
    assert.equal(await statusDe(alvo), 'APROVADA');
  });

  test('outra empresa: entregar a solicitação da outra é o mesmo 404 da inexistente (corpo idêntico), nos dois sentidos; nenhum lote muda', async () => {
    const m = await f.material();
    const loteA = await f.estoque(m, 2);
    const daA = await f.aprovada({ materialId: m, quantidade: 1 });
    const criadaB = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaB, atorId: d.usuarioB, funcionarioId: d.trabalhadorB, itens: [{ materialId: d.botinaB, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: d.empresaB, atorId: d.sstB, solicitacaoId: criadaB.solicitacao.id, decisoes: [{ itemId: criadaB.itens[0].id, decisao: 'APROVADO' }], hoje: f.HOJE,
    });
    const daB = { id: criadaB.solicitacao.id, item: criadaB.itens[0].id };
    const loteB = await criarLoteDeEntrada(pool, { empresaId: d.empresaB, materialId: d.botinaB, quantidade: 2, usuarioId: d.masterB });

    const inexistenteB = resposta(await como(u.entregadorB).post(entregas(ID_INEXISTENTE), corpo(daA, loteB, 1)));
    const cruzadaB = resposta(await como(u.entregadorB).post(entregas(daA.id), corpo(daA, loteB, 1)));
    assert.deepEqual([inexistenteB.status, inexistenteB.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
    assert.deepEqual(cruzadaB, inexistenteB);
    const inexistenteA = resposta(await como(u.entregador).post(entregas(ID_INEXISTENTE), corpo(daB, loteA, 1)));
    const cruzadaA = resposta(await como(u.entregador).post(entregas(daB.id), corpo(daB, loteA, 1)));
    assert.deepEqual([inexistenteA.status, inexistenteA.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
    assert.deepEqual(cruzadaA, inexistenteA);
    assert.deepEqual([await f.lote(loteA), await f.lote(loteB)], [
      { entrada: 2, baixada: 0, entregue: 0, saldo: 2 }, { entrada: 2, baixada: 0, entregue: 0, saldo: 2 },
    ]);
    assert.deepEqual([await statusDe(daA), await statusDe(daB)], ['APROVADA', 'APROVADA']);
  });

  test('ENCERRADA não recebe entrega: 409 SOLICITACAO_NAO_ENTREGAVEL; o lote não muda', async () => {
    const m = await f.material();
    const loteId = await f.estoque(m, 2);
    const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
    await solicitacaoSvc.encerrarSolicitacao(pool, { empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: alvo.id, justificativa: 'Desligado', hoje: f.HOJE });
    const r = await como(u.entregador).post(entregas(alvo.id), corpo(alvo, loteId, 1));
    assert.deepEqual([r.status, r.body.codigo], [409, 'SOLICITACAO_NAO_ENTREGAVEL']);
    assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 0, entregue: 0, saldo: 2 });
    assert.deepEqual(await entregasDe(alvo), { n: 0, quantidade: 0 });
  });

  test('repetição: a mesma chave e o mesmo corpo devolvem 200 com a mesma entrega, sem baixar o lote de novo; a chave com outro corpo é 409 IDEMPOTENCIA_CONFLITO', async () => {
    const m = await f.material();
    const loteId = await f.estoque(m, 5);
    const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
    const pedido = corpo(alvo, loteId, 1);
    const primeira = await como(u.entregador).post(entregas(alvo.id), pedido);
    assert.equal(primeira.status, 201);
    const repetida = await como(u.entregador).post(entregas(alvo.id), pedido);
    assert.deepEqual([repetida.status, repetida.body.repetida, repetida.body.entrega.id], [200, true, primeira.body.entrega.id]);
    const outroCorpo = await como(u.entregador).post(entregas(alvo.id), { ...pedido, itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade: 2 }] });
    assert.deepEqual([outroCorpo.status, outroCorpo.body.codigo], [409, 'IDEMPOTENCIA_CONFLITO']);
    assert.deepEqual(await f.lote(loteId), { entrada: 5, baixada: 0, entregue: 1, saldo: 4 });
    assert.deepEqual(await entregasDe(alvo), { n: 1, quantidade: 1 });
  });

  test('o cliente não manda o que o servidor deriva (material, tamanho, motivo, justificativas, trabalhador, solicitação, empresa): 400 CAMPO_NAO_PERMITIDO; nada muda', async () => {
    const m = await f.material();
    const loteId = await f.estoque(m, 2);
    const alvo = await f.aprovada({ materialId: m, quantidade: 1 });
    const comItem = (extra) => ({ ...corpo(alvo, loteId, 1), itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade: 1, ...extra }] });
    const tentativas = [
      comItem({ materialId: m }), comItem({ tamanho: '40' }), comItem({ motivo: 'OUTRO' }), comItem({ justificativaForaGhe: 'x' }),
      corpo(alvo, loteId, 1, { funcionarioId: d.trabalhador2 }), corpo(alvo, loteId, 1, { solicitacaoId: alvo.id }), corpo(alvo, loteId, 1, { empresaId: d.empresaB }),
    ];
    for (const tentativa of tentativas) {
      const r = await como(u.entregador).post(entregas(alvo.id), tentativa);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(tentativa).slice(0, 80));
      assert.ok(r.body.detalhes.some((x) => x.codigo === 'CAMPO_NAO_PERMITIDO'), JSON.stringify(r.body.detalhes));
    }
    assert.deepEqual(await f.lote(loteId), { entrada: 2, baixada: 0, entregue: 0, saldo: 2 });
  });
});
