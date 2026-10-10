'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteSituacao } = require('./helpers/ambiente-funcionario-situacao');
const { chaveNova } = require('./helpers/solicitacao-epi-servico');
const { ACEITE } = require('./helpers/reserva-estoque');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const entregaSolicitacaoSvc = require('../../src/services/entrega-solicitacao.service');
const consultaEntregaSvc = require('../../src/services/entrega-epi-consulta.service');
const contextoSolicitacaoSvc = require('../../src/services/solicitacao-epi-contexto.service');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * S2 (RED) — o funcionário AFASTADO não solicita nem recebe EPI, com código e mensagem PRÓPRIOS
 * (409 FUNCIONARIO_AFASTADO, "afastado", nunca o texto de inativo). INATIVO continua como hoje.
 *
 * Cobre os três fluxos pedidos — entrega direta, criação de solicitação e entrega por solicitação — e as
 * leituras que os antecedem (contexto da entrega e da solicitação). A decisão da SST sobre uma solicitação já
 * criada NÃO é bloqueada pelo afastamento (decisão de 09/10/2026). Nada é apagado: solicitações, entregas, ficha e GHE ficam; ao voltar para ATIVO (pela rota da
 * situação) o funcionário volta a ser elegível pelas regras de sempre.
 *
 * O estado AFASTADO é semeado por SQL (a 084 já existe); a volta para ATIVO usa a rota nova, ainda ausente.
 * Toda falha é de comportamento (código, mensagem, estado), nunca de harness.
 */

const ROTA = (id) => `/api/funcionarios/${id}/situacao`;

// Devolve o erro lançado; se a operação passar, falha por asserção (nunca por TypeError).
async function recusada(promessa, rotulo) {
  try {
    await promessa;
  } catch (erro) {
    return erro;
  }
  return assert.fail(`${rotulo}: a operação deveria ter sido recusada`);
}

function exigirAfastado(erro, rotulo) {
  assert.ok(HttpError.ehHttpError(erro), `${rotulo}: esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
  assert.deepEqual([erro.status, erro.codigo], [409, 'FUNCIONARIO_AFASTADO'], `${rotulo}: ${erro.message}`);
  assert.match(erro.message, /afastad/i, rotulo);
  assert.doesNotMatch(erro.message, /inativ/i, `${rotulo}: AFASTADO não é tratado como inativo`);
}

describe('S2 — AFASTADO nos fluxos de EPI', () => {
  let amb;
  let d;
  let f;
  before(async () => {
    amb = await montarAmbienteSituacao();
    ({ d, f } = amb);
  });
  after(async () => { if (amb) await amb.encerrar(); });

  const contagens = async (funcionarioId) => {
    const um = async (sql) => (await amb.pool.query(sql, [funcionarioId])).rows[0].n;
    return {
      fichas: await um('SELECT count(*)::int AS n FROM fichas_epi WHERE funcionario_id = $1'),
      entregas: await um('SELECT count(*)::int AS n FROM entregas_epi e JOIN fichas_epi f ON f.id = e.ficha_id WHERE f.funcionario_id = $1'),
      solicitacoes: await um('SELECT count(*)::int AS n FROM solicitacoes_epi WHERE funcionario_id = $1'),
    };
  };
  const statusDaSolicitacao = async (id) => (await amb.pool.query('SELECT status FROM solicitacoes_epi WHERE id = $1', [id])).rows[0].status;
  const criarSolicitacao = (funcionarioId, materialId) => solicitacaoSvc.criarSolicitacao(amb.pool, {
    empresaId: d.empresaA, atorId: d.solicitante, funcionarioId, itens: [{ materialId, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
  });
  const aprovarTudo = (solicitacao) => solicitacaoSvc.decidirSolicitacao(amb.pool, {
    empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: solicitacao.solicitacao.id,
    decisoes: solicitacao.itens.map((item) => ({ itemId: item.id, decisao: 'APROVADO' })), hoje: f.HOJE,
  });
  const porSolicitacao = (alvo, loteId, quantidade = 1) => entregaSolicitacaoSvc.registrarEntregaPorSolicitacao(amb.pool, {
    empresaId: d.empresaA, atorId: d.master, solicitacaoId: alvo.id, itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
  });

  describe('o afastado não recebe nem solicita', () => {
    test('entrega direta: 409 FUNCIONARIO_AFASTADO (código e mensagem próprios); nada é gravado e o lote não baixa', async () => {
      const material = await f.material();
      const lote = await f.estoque(material, 5);
      const afastado = await amb.trabalhador('AFASTADO');
      const antes = await contagens(afastado);
      const saldoAntes = (await f.lote(lote)).saldo;
      const erro = await recusada(f.direta([[material, lote, 1]], { funcionarioId: afastado }), 'entrega direta');
      exigirAfastado(erro, 'entrega direta');
      assert.deepEqual(await contagens(afastado), antes);
      assert.equal((await f.lote(lote)).saldo, saldoAntes);
    });

    test('contexto da entrega (trabalhador, materiais, lotes e consulta por CPF): o mesmo 409 FUNCIONARIO_AFASTADO', async () => {
      const material = await f.material();
      await f.estoque(material, 3);
      const afastado = await amb.trabalhador('AFASTADO');
      const { cpf } = await amb.ler(afastado);
      const chamadas = {
        contexto: () => consultaEntregaSvc.contextoDoTrabalhador(amb.pool, { empresaId: d.empresaA, funcionarioId: afastado }),
        materiais: () => consultaEntregaSvc.listarMateriaisDoContexto(amb.pool, { empresaId: d.empresaA, funcionarioId: afastado, pagina: 1, limite: 20 }),
        lotes: () => consultaEntregaSvc.listarLotesDoContexto(amb.pool, { empresaId: d.empresaA, funcionarioId: afastado, materialId: material, hoje: f.HOJE }),
        cpf: () => consultaEntregaSvc.localizarTrabalhadorPorCpf(amb.pool, { empresaId: d.empresaA, cpf }),
      };
      for (const [rotulo, chamar] of Object.entries(chamadas)) exigirAfastado(await recusada(chamar(), rotulo), rotulo);
    });

    test('criação de solicitação e contexto de materiais do pedido: 409 FUNCIONARIO_AFASTADO; nenhuma solicitação nasce', async () => {
      const material = await f.material();
      const afastado = await amb.trabalhador('AFASTADO');
      const antes = await contagens(afastado);
      exigirAfastado(await recusada(criarSolicitacao(afastado, material), 'criação'), 'criação');
      exigirAfastado(await recusada(
        contextoSolicitacaoSvc.listarMateriais(amb.pool, { empresaId: d.empresaA, funcionarioId: afastado, pagina: 1, limite: 20 }),
        'contexto do pedido',
      ), 'contexto do pedido');
      assert.deepEqual(await contagens(afastado), antes);
    });

    test('entrega por solicitação já aprovada: 409 FUNCIONARIO_AFASTADO; nada é entregue e a solicitação, seus itens e o GHE ficam', async () => {
      const material = await f.material();
      const lote = await f.estoque(material, 5);
      const trabalhador = await amb.trabalhador('ATIVO');
      const alvo = await f.aprovada({ materialId: material, quantidade: 1, funcionarioId: trabalhador });
      await amb.definirSituacao(trabalhador, 'AFASTADO');
      const antes = await contagens(trabalhador);
      const gheAntes = (await amb.ler(trabalhador)).grupo_homogeneo_id;
      exigirAfastado(await recusada(porSolicitacao(alvo, lote), 'entrega por solicitação'), 'entrega por solicitação');
      assert.deepEqual(await contagens(trabalhador), antes);
      assert.equal(await statusDaSolicitacao(alvo.id), 'APROVADA');
      assert.equal((await amb.ler(trabalhador)).grupo_homogeneo_id, gheAntes);
      assert.equal((await f.lote(lote)).saldo, 5);
    });
  });

  // Decisão da SST (09/10/2026): AFASTADO bloqueia SOLICITAR e RECEBER, não a decisão administrativa de um pedido que
  // já existia. Aprovada, a solicitação não é entregável enquanto o trabalhador está afastado e a demanda fica
  // suspensa (fora da posição do estoque); ao voltar para ATIVO ela segue para a entrega como sempre.
  describe('a decisão da SST sobre uma solicitação já criada não depende do afastamento', () => {
    test('aprovar e reprovar continuam possíveis; a aprovada não é entregável (FUNCIONARIO_AFASTADO), fica suspensa e volta com o ATIVO', async () => {
      const material = await f.material();
      const lote = await f.estoque(material, 5);
      const trabalhador = await amb.trabalhador('ATIVO');
      const paraAprovar = await criarSolicitacao(trabalhador, material);
      const paraReprovar = await criarSolicitacao(trabalhador, material);
      await amb.definirSituacao(trabalhador, 'AFASTADO');

      const aprovada = await aprovarTudo(paraAprovar);
      assert.equal(aprovada.solicitacao.status, 'APROVADA');
      const reprovada = await solicitacaoSvc.decidirSolicitacao(amb.pool, {
        empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: paraReprovar.solicitacao.id,
        decisoes: paraReprovar.itens.map((item) => ({ itemId: item.id, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada' })), hoje: f.HOJE,
      });
      assert.equal(reprovada.solicitacao.status, 'REPROVADA');

      const alvo = { id: paraAprovar.solicitacao.id, item: paraAprovar.itens[0].id };
      exigirAfastado(await recusada(porSolicitacao(alvo, lote), 'entrega por solicitação'), 'entrega por solicitação');
      assert.equal(await statusDaSolicitacao(alvo.id), 'APROVADA');
      assert.equal((await f.lote(lote)).saldo, 5);
      const [, demandaAfastado] = f.numeros(await f.posicao(material));
      assert.equal(demandaAfastado, 0, 'enquanto afastado, a demanda aprovada fica suspensa (fora da posição)');

      const r = await amb.como(amb.usuarios.master).post(ROTA(trabalhador), { situacao: 'ATIVO' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [, demandaAtivo] = f.numeros(await f.posicao(material));
      assert.equal(demandaAtivo, 1, 'de volta ao ATIVO, a solicitação aprovada volta à demanda');
      await porSolicitacao(alvo, lote);
      assert.equal(await statusDaSolicitacao(alvo.id), 'ENTREGUE');
    });
  });

  describe('INATIVO continua como hoje (regressão: o código do inativo não muda)', () => {
    test('entrega direta e criação de solicitação: 409 FUNCIONARIO_INATIVO com texto de inativo', async () => {
      const material = await f.material();
      const lote = await f.estoque(material, 2);
      const inativo = await amb.trabalhador('INATIVO');
      const direta = await recusada(f.direta([[material, lote, 1]], { funcionarioId: inativo }), 'direta');
      assert.deepEqual([direta.status, direta.codigo], [409, 'FUNCIONARIO_INATIVO']);
      assert.match(direta.message, /inativo/i);
      const criacao = await recusada(criarSolicitacao(inativo, material), 'criação');
      assert.deepEqual([criacao.status, criacao.codigo], [409, 'FUNCIONARIO_INATIVO']);
    });
  });

  describe('a mudança de situação não apaga nada e a volta para ATIVO restabelece a elegibilidade', () => {
    test('ATIVO → AFASTADO preserva solicitações, entregas, ficha e GHE', async () => {
      const material = await f.material();
      const lote = await f.estoque(material, 6);
      const outro = await f.material();
      await f.estoque(outro, 6);
      const trabalhador = await amb.trabalhador('ATIVO');
      await f.direta([[material, lote, 1]], { funcionarioId: trabalhador });
      const alvo = await f.aprovada({ materialId: outro, quantidade: 1, funcionarioId: trabalhador });
      const antes = await contagens(trabalhador);
      assert.deepEqual([antes.fichas, antes.entregas, antes.solicitacoes], [1, 1, 1]);
      const gheAntes = (await amb.ler(trabalhador)).grupo_homogeneo_id;

      const r = await amb.como(amb.usuarios.master).post(ROTA(trabalhador), { situacao: 'AFASTADO' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(await contagens(trabalhador), antes);
      assert.equal(await statusDaSolicitacao(alvo.id), 'APROVADA');
      assert.equal((await amb.ler(trabalhador)).grupo_homogeneo_id, gheAntes);
    });

    test('AFASTADO → ATIVO: volta a receber por entrega direta e por solicitação, e a solicitação aprovada vira ENTREGUE', async () => {
      const material = await f.material();
      const lote = await f.estoque(material, 5);
      const direto = await f.material();
      const loteDireto = await f.estoque(direto, 5);
      const trabalhador = await amb.trabalhador('ATIVO');
      const alvo = await f.aprovada({ materialId: material, quantidade: 1, funcionarioId: trabalhador });
      await amb.definirSituacao(trabalhador, 'AFASTADO');

      const r = await amb.como(amb.usuarios.master).post(ROTA(trabalhador), { situacao: 'ATIVO' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await amb.ler(trabalhador)).situacao, 'ATIVO');

      const direta = await f.direta([[direto, loteDireto, 1]], { funcionarioId: trabalhador });
      assert.ok(direta.entrega?.id ?? direta.ficha?.id, 'a entrega direta deveria ter sido registrada');
      await porSolicitacao(alvo, lote);
      assert.equal(await statusDaSolicitacao(alvo.id), 'ENTREGUE');
      const solicitacoes = await contagens(trabalhador);
      assert.equal(solicitacoes.entregas, 2);
    });

    test('AFASTADO → ATIVO: o contexto de entrega e o de solicitação voltam a abrir; nova solicitação é aceita', async () => {
      const material = await f.material();
      const trabalhador = await amb.trabalhador('AFASTADO');
      const r = await amb.como(amb.usuarios.master).post(ROTA(trabalhador), { situacao: 'ATIVO' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const contexto = await consultaEntregaSvc.contextoDoTrabalhador(amb.pool, { empresaId: d.empresaA, funcionarioId: trabalhador });
      assert.equal(contexto.funcionario.id, trabalhador);
      const nova = await criarSolicitacao(trabalhador, material);
      assert.equal(nova.solicitacao.status, 'PENDENTE');
    });
  });
});
