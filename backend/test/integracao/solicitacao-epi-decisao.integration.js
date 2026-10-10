'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations, criarMaterial } = require('./helpers/entrega-epi');
const { criarLoteDeEntrada } = require('./helpers/solicitacao-epi');
const {
  montarMundoDoServico, vincularMaterialAoGhe, chaveNova, esperarHttpError, esperarValidacao, portao,
  aguardarTravaAdvisoryPendente, aguardarEsperaPorTravaDeLinha, comLimite,
} = require('./helpers/solicitacao-epi-servico');
const solRepo = require('../../src/repositories/solicitacao-epi.repository');
const itemRepo = require('../../src/repositories/solicitacao-epi-item.repository');
const parRepo = require('../../src/repositories/estoque-par.repository');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');
const materialRepo = require('../../src/repositories/material.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Decisão da Segurança do Trabalho (12B) contra PostgreSQL real: todos os
 * itens e o cabeçalho num ato só, resultado do cabeçalho calculado pelo
 * serviço, justificativas, separação de funções, trabalhador e material
 * ativos na aprovação, trava dos pares na ordem canônica, aprovação sem
 * estoque, cobertura derivada em FIFO, auditoria e corridas.
 */

const servico = () => exigirModulo('src/services/solicitacao-epi.service');
const HOJE = dataOperacional();

function somarDias(dataIso, dias) {
  const data = new Date(`${dataIso}T00:00:00Z`);
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString().slice(0, 10);
}

describe('decisão da SST — serviço (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let sequencia = 0;

  const q = (sql, params) => pool.query(sql, params);
  const item = (materialId, extra = {}) => ({ materialId, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO', ...extra });

  // Material previsto no GHE A (a aprovação dispensa a justificativa de exceção).
  async function materialNoGhe(opcoes = {}) {
    sequencia += 1;
    const id = await criarMaterial(pool, d.empresaA, `Material de decisão ${sequencia}`, { exigeTamanho: true, ...opcoes });
    await vincularMaterialAoGhe(pool, d.empresaA, d.gheA, id);
    return id;
  }
  async function materialForaDoGhe(opcoes = {}) {
    sequencia += 1;
    return criarMaterial(pool, d.empresaA, `Material fora do GHE ${sequencia}`, { exigeTamanho: true, ...opcoes });
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
  const aprovar = (i, quantidadeAprovada, justificativa) => ({
    itemId: i.id, decisao: 'APROVADO', ...(quantidadeAprovada === undefined ? {} : { quantidadeAprovada }), ...(justificativa === undefined ? {} : { justificativa }),
  });
  const reprovar = (i, justificativa = 'Sem necessidade comprovada') => ({ itemId: i.id, decisao: 'REPROVADO', justificativa });
  const estoque = (materialId, quantidade, extra = {}) => criarLoteDeEntrada(pool, { empresaId: d.empresaA, materialId, quantidade, usuarioId: d.master, ...extra });

  const estadoGravado = async (id) => ({
    cabecalho: (await q('SELECT status, decidida_por, decidida_em, cancelada_por FROM solicitacoes_epi WHERE id = $1', [id])).rows[0],
    itens: (await q('SELECT decisao, quantidade_aprovada, justificativa_decisao FROM solicitacoes_epi_itens WHERE solicitacao_id = $1 ORDER BY id', [id])).rows,
  });
  const fotoDoEstoque = async () => (await q(
    `SELECT (SELECT json_agg(l ORDER BY l.id) FROM estoque_lotes l) AS lotes, (SELECT json_agg(o ORDER BY o.id) FROM estoque_operacoes o) AS operacoes`,
  )).rows[0];
  const contar = async (tabela, onde = 'true', params = []) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${onde}`, params)).rows[0].n;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('aprovação integral SEM estoque: APROVADA, itens aprovados na quantidade pedida, aguardando estoque de forma derivada; nada é reservado nem baixado', async () => {
    const a = await materialNoGhe();
    const b = await materialNoGhe();
    const { solicitacao, itens } = await criar([item(a, { quantidade: 3 }), item(b, { quantidade: 1 })]);
    const antes = await fotoDoEstoque();
    const resultado = await decidir(solicitacao.id, [aprovar(itens[0]), aprovar(itens[1], 1)]);

    assert.equal(resultado.solicitacao.status, 'APROVADA');
    assert.equal(resultado.solicitacao.decisao.decididaPor, d.sst1);
    assert.ok(resultado.solicitacao.decisao.decididaEm instanceof Date);
    assert.equal(resultado.solicitacao.situacaoOperacional, 'AGUARDANDO_ESTOQUE');
    assert.deepEqual(resultado.itens.map((i) => [i.decisao, i.quantidadeAprovada, i.justificativaDecisao, i.quantidadePendente, i.situacao]), [
      ['APROVADO', 3, null, 3, 'AGUARDANDO_ESTOQUE'], ['APROVADO', 1, null, 1, 'AGUARDANDO_ESTOQUE'],
    ]);
    assert.deepEqual(resultado.itens[0].cobertura, { coberta: 0, semCobertura: 3, acumuladoAnterior: 0, fisicoUtilizavel: 0 });
    assert.deepEqual(resultado.itens[0].posicao, { fisicoUtilizavel: 0, demandaPendente: 3, comprometido: 0, saldoLivre: 0, semCobertura: 3 });
    assert.deepEqual((await estadoGravado(solicitacao.id)).itens.map((i) => i.decisao), ['APROVADO', 'APROVADO']);
    assert.deepEqual(await fotoDoEstoque(), antes, 'aprovar autoriza o fornecimento; não reserva lote nem cria operação');
  });

  test('a quantidade aprovada omitida é a integral', async () => {
    const m = await materialNoGhe();
    const { solicitacao, itens } = await criar([item(m, { quantidade: 5 })]);
    const resultado = await decidir(solicitacao.id, [{ itemId: itens[0].id, decisao: 'APROVADO' }]);
    assert.deepEqual([resultado.solicitacao.status, resultado.itens[0].quantidadeAprovada], ['APROVADA', 5]);
  });

  test('aprovação parcial: um item reprovado, ou quantidade reduzida, dá APROVADA_PARCIAL', async () => {
    const a = await materialNoGhe();
    const b = await materialNoGhe();
    const c = await materialNoGhe();
    const comReprovado = await criar([item(a), item(b)]);
    const r1 = await decidir(comReprovado.solicitacao.id, [aprovar(comReprovado.itens[0]), reprovar(comReprovado.itens[1])]);
    assert.equal(r1.solicitacao.status, 'APROVADA_PARCIAL');
    assert.deepEqual(r1.itens.map((i) => [i.decisao, i.quantidadeAprovada, i.situacao]), [['APROVADO', 2, 'AGUARDANDO_ESTOQUE'], ['REPROVADO', 0, null]]);

    const comReducao = await criar([item(c, { quantidade: 5 })], { funcionarioId: d.trabalhador2 });
    const r2 = await decidir(comReducao.solicitacao.id, [aprovar(comReducao.itens[0], 3, 'Quantidade limitada pela política do setor')]);
    assert.deepEqual([r2.solicitacao.status, r2.itens[0].quantidadeAprovada, r2.itens[0].quantidadePendente], ['APROVADA_PARCIAL', 3, 3]);
  });

  test('reprovação total: REPROVADA, sem situação operacional, sem demanda e sem nenhuma trava de par', async (t) => {
    const a = await materialNoGhe();
    const b = await materialNoGhe();
    const { solicitacao, itens } = await criar([item(a), item(b)]);
    const travas = t.mock.method(parRepo, 'travarPares');
    const resultado = await decidir(solicitacao.id, [reprovar(itens[0]), reprovar(itens[1], 'Item não previsto para a função')]);
    assert.equal(resultado.solicitacao.status, 'REPROVADA');
    assert.equal(resultado.solicitacao.situacaoOperacional, null);
    assert.deepEqual(resultado.itens.map((i) => [i.decisao, i.quantidadeAprovada, i.situacao, i.cobertura]), [['REPROVADO', 0, null, null], ['REPROVADO', 0, null, null]]);
    assert.equal(travas.mock.callCount(), 0, 'a decisão que não aumenta a demanda não trava par algum');
  });

  test('redução sem justificativa é recusada; com justificativa passa; quantidade acima da pedida é recusada', async () => {
    const m = await materialNoGhe();
    const { solicitacao, itens } = await criar([item(m, { quantidade: 4 })]);
    await esperarValidacao(decidir(solicitacao.id, [aprovar(itens[0], 2)]), 'body.decisoes[0].justificativa', 'JUSTIFICATIVA_OBRIGATORIA');
    await esperarValidacao(decidir(solicitacao.id, [aprovar(itens[0], 5, 'Maior que o pedido')]), 'body.decisoes[0].quantidadeAprovada', 'QUANTIDADE_APROVADA_INVALIDA');
    assert.equal((await estadoGravado(solicitacao.id)).cabecalho.status, 'PENDENTE');
    const ok = await decidir(solicitacao.id, [aprovar(itens[0], 2, 'Estoque mínimo do setor')]);
    assert.equal(ok.itens[0].justificativaDecisao, 'Estoque mínimo do setor');
  });

  test('item fora do GHE: aprovar sem justificativa é recusado; aprovar com justificativa passa e fica gravada; reprovar exige a sua própria', async () => {
    const dentro = await materialNoGhe();
    const fora = await materialForaDoGhe();
    const { solicitacao, itens } = await criar([item(dentro), item(fora)]);
    assert.deepEqual(itens.map((i) => i.previstoNoGhe), [true, false]);
    await esperarValidacao(decidir(solicitacao.id, [aprovar(itens[0]), aprovar(itens[1])]), 'body.decisoes[1].justificativa', 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA');
    assert.equal((await estadoGravado(solicitacao.id)).cabecalho.status, 'PENDENTE');
    const ok = await decidir(solicitacao.id, [aprovar(itens[0]), aprovar(itens[1], undefined, 'Risco da função justifica o EPI fora do GHE')]);
    assert.equal(ok.solicitacao.status, 'APROVADA');
    assert.equal(ok.itens[1].justificativaDecisao, 'Risco da função justifica o EPI fora do GHE');

    const outra = await criar([item(fora)], { funcionarioId: d.trabalhador2 });
    await esperarValidacao(decidir(outra.solicitacao.id, [{ itemId: outra.itens[0].id, decisao: 'REPROVADO' }]), 'body.decisoes[0].justificativa', 'JUSTIFICATIVA_OBRIGATORIA');
    const reprovada = await decidir(outra.solicitacao.id, [reprovar(outra.itens[0], 'Não há risco que justifique')]);
    assert.equal(reprovada.solicitacao.status, 'REPROVADA');
  });

  test('a decisão cobre exatamente os itens da solicitação: faltando item ou item de outra solicitação é recusado', async () => {
    const a = await materialNoGhe();
    const b = await materialNoGhe();
    const { solicitacao, itens } = await criar([item(a), item(b)]);
    const outra = await criar([item(a)], { funcionarioId: d.trabalhador2 });
    await esperarValidacao(decidir(solicitacao.id, [aprovar(itens[0])]), 'body.decisoes', 'DECISAO_INCOMPLETA');
    await esperarValidacao(decidir(solicitacao.id, [aprovar(itens[0]), aprovar(outra.itens[0])]), 'body.decisoes[1].itemId', 'ITEM_NAO_PERTENCE');
    assert.deepEqual((await estadoGravado(outra.solicitacao.id)).itens.map((i) => i.decisao), [null], 'o item da outra solicitação não foi tocado');
  });

  test('separação de funções: quem criou não aprova nem reprova a própria solicitação; outro usuário pode', async () => {
    const m = await materialNoGhe();
    const { solicitacao, itens } = await criar([item(m)]);
    await esperarHttpError(decidir(solicitacao.id, [aprovar(itens[0])], { atorId: d.solicitante }), 403, 'AUTODECISAO_PROIBIDA');
    await esperarHttpError(decidir(solicitacao.id, [reprovar(itens[0])], { atorId: d.solicitante }), 403, 'AUTODECISAO_PROIBIDA');
    assert.equal((await estadoGravado(solicitacao.id)).cabecalho.status, 'PENDENTE');
    const ok = await decidir(solicitacao.id, [aprovar(itens[0])], { atorId: d.outroSolicitante });
    assert.equal(ok.solicitacao.decisao.decididaPor, d.outroSolicitante);
  });

  test('só decide solicitação PENDENTE: decidida, reprovada, cancelada ou inexistente é recusada', async () => {
    const m = await materialNoGhe();
    const decidida = await criar([item(m)]);
    await decidir(decidida.solicitacao.id, [aprovar(decidida.itens[0])]);
    await esperarHttpError(decidir(decidida.solicitacao.id, [reprovar(decidida.itens[0])]), 409, 'SOLICITACAO_NAO_PENDENTE');
    const cancelada = await criar([item(m)], { funcionarioId: d.trabalhador2 });
    await cancelar(cancelada.solicitacao.id);
    await esperarHttpError(decidir(cancelada.solicitacao.id, [aprovar(cancelada.itens[0])]), 409, 'SOLICITACAO_NAO_PENDENTE');
    await esperarHttpError(decidir(2147483000, [aprovar({ id: 1 })]), 404, 'SOLICITACAO_NAO_ENCONTRADA');
  });

  test('o decisor precisa existir na empresa e estar ativo; a empresa B não decide solicitação da A', async () => {
    const m = await materialNoGhe();
    const { solicitacao, itens } = await criar([item(m)]);
    await esperarHttpError(decidir(solicitacao.id, [aprovar(itens[0])], { atorId: 999999 }), 404, 'USUARIO_NAO_ENCONTRADO');
    await esperarHttpError(decidir(solicitacao.id, [aprovar(itens[0])], { atorId: d.usuarioInativo }), 403, 'USUARIO_INATIVO');
    await esperarHttpError(decidir(solicitacao.id, [aprovar(itens[0])], { empresaId: d.empresaB, atorId: d.sstB }), 404, 'SOLICITACAO_NAO_ENCONTRADA');
    assert.equal((await estadoGravado(solicitacao.id)).cabecalho.status, 'PENDENTE');
  });

  test('trabalhador inativo: não se aprova, mas se reprova; material inativo: só o item aprovado conta', async () => {
    const a = await materialNoGhe();
    const b = await materialNoGhe();
    const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
    const doInativo = await criar([item(a)], { funcionarioId: trabalhador });
    await q("UPDATE funcionarios SET situacao = 'INATIVO' WHERE id = $1", [trabalhador]);
    await esperarHttpError(decidir(doInativo.solicitacao.id, [aprovar(doInativo.itens[0])]), 409, 'FUNCIONARIO_INATIVO');
    assert.equal((await decidir(doInativo.solicitacao.id, [reprovar(doInativo.itens[0], 'Trabalhador desligado')])).solicitacao.status, 'REPROVADA');

    const comMaterialInativo = await criar([item(a), item(b)], { funcionarioId: d.trabalhador3 });
    await q('UPDATE materiais SET ativo = false WHERE id = $1', [b]);
    await esperarHttpError(decidir(comMaterialInativo.solicitacao.id, [aprovar(comMaterialInativo.itens[0]), aprovar(comMaterialInativo.itens[1])]), 409, 'MATERIAL_INATIVO');
    const parcial = await decidir(comMaterialInativo.solicitacao.id, [aprovar(comMaterialInativo.itens[0]), reprovar(comMaterialInativo.itens[1], 'Material descontinuado')]);
    assert.equal(parcial.solicitacao.status, 'APROVADA_PARCIAL');
    await q('UPDATE materiais SET ativo = true WHERE id = $1', [b]);
  });

  test('ordem de travas: solicitação, trabalhador, materiais, pares (únicos, na ordem canônica, só dos aprovados) e só então a decisão', async (t) => {
    const matA = await materialNoGhe();
    const matB = await materialNoGhe({ exigeTamanho: false });
    const matC = await materialNoGhe();
    const { solicitacao, itens } = await criar([
      item(matB, { tamanho: undefined, quantidade: 1 }), item(matA, { tamanho: '41' }), item(matA, { tamanho: '40' }), item(matC),
    ]);
    const ordem = [];
    const envolver = (modulo, funcao, rotulo) => {
      const original = modulo[funcao];
      t.mock.method(modulo, funcao, async (...args) => {
        ordem.push([rotulo, args]);
        return original(...args);
      });
    };
    envolver(solRepo, 'travarPorId', 'solicitacao');
    envolver(funcionarioRepo, 'buscarPorIdParaEntrega', 'trabalhador');
    envolver(materialRepo, 'listarPorIdsParaVinculo', 'materiais');
    envolver(parRepo, 'travarPares', 'pares');
    envolver(itemRepo, 'decidirTodos', 'decisao-itens');
    envolver(solRepo, 'registrarDecisao', 'decisao-cabecalho');

    const porMaterial = Object.fromEntries(itens.map((i) => [`${i.materialId}/${i.tamanho}`, i]));
    const decisoes = [
      aprovar(porMaterial[`${matA}/40`]), aprovar(porMaterial[`${matA}/41`]), aprovar(porMaterial[`${matB}/null`], undefined), reprovar(porMaterial[`${matC}/40`]),
    ];
    await decidir(solicitacao.id, decisoes);
    assert.deepEqual(ordem.map(([rotulo]) => rotulo), ['solicitacao', 'trabalhador', 'materiais', 'pares', 'decisao-itens', 'decisao-cabecalho']);
    const pares = ordem.find(([rotulo]) => rotulo === 'pares')[1][2];
    assert.deepEqual(pares, [{ materialId: matA, tamanho: '40' }, { materialId: matA, tamanho: '41' }, { materialId: matB, tamanho: null }], 'só os aprovados, sem repetição, em ordem canônica');
    const ids = ordem.find(([rotulo]) => rotulo === 'materiais')[1][2];
    assert.deepEqual(ids, [matA, matB], 'materiais só dos itens aprovados, em ordem crescente');
  });

  test('o serviço de decisão usa a infraestrutura da 12A: as travas vão ao repositório de pares', async (t) => {
    const m = await materialNoGhe();
    const { solicitacao, itens } = await criar([item(m)]);
    const travas = t.mock.method(parRepo, 'travarPares');
    await decidir(solicitacao.id, [aprovar(itens[0])]);
    assert.equal(travas.mock.callCount(), 1);
    assert.equal(travas.mock.calls[0].arguments[1], d.empresaA);
  });

  test('cobertura derivada logo após a aprovação: estoque suficiente, parcial e nenhum', async () => {
    const m = await materialNoGhe();
    await estoque(m, 5);
    const suficiente = await criar([item(m, { quantidade: 2 })]);
    const r1 = await decidir(suficiente.solicitacao.id, [aprovar(suficiente.itens[0])]);
    assert.equal(r1.solicitacao.situacaoOperacional, 'PRONTA_PARA_ENTREGA');
    assert.deepEqual(r1.itens[0].posicao, { fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3, semCobertura: 0 });

    const parcial = await criar([item(m, { quantidade: 5 })], { funcionarioId: d.trabalhador2 });
    const r2 = await decidir(parcial.solicitacao.id, [aprovar(parcial.itens[0])]);
    assert.equal(r2.itens[0].situacao, 'PARCIALMENTE_COBERTA');
    assert.deepEqual(r2.itens[0].cobertura, { coberta: 3, semCobertura: 2, acumuladoAnterior: 2, fisicoUtilizavel: 5 });

    const nenhum = await criar([item(m, { quantidade: 1 })], { funcionarioId: d.trabalhador3 });
    const r3 = await decidir(nenhum.solicitacao.id, [aprovar(nenhum.itens[0])]);
    assert.equal(r3.itens[0].situacao, 'AGUARDANDO_ESTOQUE');
    assert.deepEqual(r3.itens[0].posicao, { fisicoUtilizavel: 5, demandaPendente: 8, comprometido: 5, saldoLivre: 0, semCobertura: 3 });
  });

  test('FIFO pela ordem da decisão, não pela da criação: a decidida primeiro recebe a primeira unidade que entrar', async () => {
    const m = await materialNoGhe();
    const primeira = await criar([item(m, { quantidade: 1 })]);
    const segunda = await criar([item(m, { quantidade: 1 })], { funcionarioId: d.trabalhador2 });
    await decidir(segunda.solicitacao.id, [aprovar(segunda.itens[0])]);
    await decidir(primeira.solicitacao.id, [aprovar(primeira.itens[0])]);
    await estoque(m, 1);
    const lerPrimeira = await servico().buscarSolicitacao(pool, { empresaId: d.empresaA, solicitacaoId: primeira.solicitacao.id, hoje: HOJE });
    const lerSegunda = await servico().buscarSolicitacao(pool, { empresaId: d.empresaA, solicitacaoId: segunda.solicitacao.id, hoje: HOJE });
    assert.equal(lerSegunda.solicitacao.situacaoOperacional, 'PRONTA_PARA_ENTREGA');
    assert.equal(lerPrimeira.solicitacao.situacaoOperacional, 'AGUARDANDO_ESTOQUE');
  });

  test('a data operacional recebida define o físico utilizável: CA que vence hoje cobre hoje e deixa de cobrir amanhã', async () => {
    const m = await materialNoGhe();
    await estoque(m, 2, { caNumero: '99001', caValidade: HOJE });
    const { solicitacao, itens } = await criar([item(m, { quantidade: 2 })]);
    const hoje = await decidir(solicitacao.id, [aprovar(itens[0])], { hoje: HOJE });
    assert.equal(hoje.solicitacao.situacaoOperacional, 'PRONTA_PARA_ENTREGA');
    const amanha = await servico().buscarSolicitacao(pool, { empresaId: d.empresaA, solicitacaoId: solicitacao.id, hoje: somarDias(HOJE, 1) });
    assert.equal(amanha.solicitacao.situacaoOperacional, 'AGUARDANDO_ESTOQUE');
  });

  test('auditoria SOLICITACAO_EPI_DECIDIDA: quem decidiu, o resultado, cada item e a cobertura do momento; sem texto livre', async () => {
    const a = await materialNoGhe();
    const b = await materialNoGhe();
    await estoque(a, 1);
    const { solicitacao, itens } = await criar([item(a, { quantidade: 2 }), item(b, { quantidade: 1 })]);
    await decidir(solicitacao.id, [aprovar(itens[0], 1, 'Texto livre da justificativa'), reprovar(itens[1], 'Texto livre da reprovação')]);
    const { rows } = await q("SELECT usuario_id, referencia, contexto, dados_anteriores, dados_novos, descricao FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'SOLICITACAO_EPI_DECIDIDA' AND referencia = $2", [d.empresaA, String(solicitacao.id)]);
    assert.equal(rows.length, 1);
    const [linha] = rows;
    assert.equal(linha.usuario_id, d.sst1);
    assert.deepEqual(linha.contexto, {
      solicitacaoId: solicitacao.id,
      numero: solicitacao.numero,
      funcionarioId: d.trabalhador,
      resultado: 'APROVADA_PARCIAL',
      itens: [
        { itemId: itens[0].id, materialId: a, tamanho: '40', quantidadeSolicitada: 2, decisao: 'APROVADO', quantidadeAprovada: 1, previstoNoGhe: true, comJustificativa: true },
        { itemId: itens[1].id, materialId: b, tamanho: '40', quantidadeSolicitada: 1, decisao: 'REPROVADO', quantidadeAprovada: 0, previstoNoGhe: true, comJustificativa: true },
      ],
      cobertura: [{ itemId: itens[0].id, coberta: 1, semCobertura: 0 }],
    });
    assert.deepEqual(linha.dados_anteriores, { status: 'PENDENTE' });
    assert.deepEqual(linha.dados_novos, { status: 'APROVADA_PARCIAL' });
    assert.doesNotMatch(JSON.stringify(linha), /Texto livre/);
  });

  test('a reprovação também é auditada, sem cobertura', async () => {
    const m = await materialNoGhe();
    const { solicitacao, itens } = await criar([item(m)]);
    await decidir(solicitacao.id, [reprovar(itens[0])]);
    const { rows: [linha] } = await q("SELECT contexto, dados_novos FROM logs_auditoria WHERE acao = 'SOLICITACAO_EPI_DECIDIDA' AND referencia = $1", [String(solicitacao.id)]);
    assert.equal(linha.contexto.resultado, 'REPROVADA');
    assert.deepEqual(linha.contexto.cobertura, []);
    assert.deepEqual(linha.dados_novos, { status: 'REPROVADA' });
  });

  test('atomicidade: falha ao gravar o cabeçalho ou a auditoria desfaz a decisão dos itens e não deixa auditoria', async (t) => {
    const m = await materialNoGhe();
    const { solicitacao, itens } = await criar([item(m)]);
    const auditorias = await contar('logs_auditoria', "acao = 'SOLICITACAO_EPI_DECIDIDA'");
    const original = solRepo.registrarDecisao;
    t.mock.method(solRepo, 'registrarDecisao', async () => { throw new Error('falha ao gravar o cabeçalho'); });
    await assert.rejects(decidir(solicitacao.id, [aprovar(itens[0])]), /falha ao gravar o cabeçalho/);
    t.mock.restoreAll();
    assert.equal(solRepo.registrarDecisao, original);
    let estado = await estadoGravado(solicitacao.id);
    assert.deepEqual([estado.cabecalho.status, estado.itens[0].decisao], ['PENDENTE', null]);

    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha de auditoria'); });
    await assert.rejects(decidir(solicitacao.id, [aprovar(itens[0])]), /falha de auditoria/);
    t.mock.restoreAll();
    estado = await estadoGravado(solicitacao.id);
    assert.deepEqual([estado.cabecalho.status, estado.itens[0].decisao], ['PENDENTE', null]);
    assert.equal(await contar('logs_auditoria', "acao = 'SOLICITACAO_EPI_DECIDIDA'"), auditorias);
    assert.equal((await decidir(solicitacao.id, [aprovar(itens[0])])).solicitacao.status, 'APROVADA', 'depois das falhas a decisão ainda é possível');
  });

  describe('concorrência', () => {
    test('oito decisões simultâneas, de decisores diferentes e resultados opostos: exatamente uma vence; as outras sete recebem 409', async () => {
      const m = await materialNoGhe();
      const { solicitacao, itens } = await criar([item(m)]);
      const decisores = [d.sst1, d.sst2, d.master, d.outroSolicitante];
      const resultados = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => decidir(
        solicitacao.id,
        [i % 2 === 0 ? aprovar(itens[0]) : reprovar(itens[0])],
        { atorId: decisores[i % decisores.length] },
      )));
      const vencedoras = resultados.filter((r) => r.status === 'fulfilled');
      assert.equal(vencedoras.length, 1);
      for (const r of resultados.filter((x) => x.status === 'rejected')) {
        assert.deepEqual([r.reason.status, r.reason.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
      }
      const estado = await estadoGravado(solicitacao.id);
      assert.equal(estado.cabecalho.status, vencedoras[0].value.solicitacao.status);
      assert.equal(await contar('logs_auditoria', "acao = 'SOLICITACAO_EPI_DECIDIDA' AND referencia = $1", [String(solicitacao.id)]), 1);
    });

    test('decisão × cancelamento da mesma PENDENTE, nas duas ordens: quem trava a solicitação primeiro vence; o outro vê o estado novo e desiste', async (t) => {
      for (const primeiro of ['decisao', 'cancelamento']) {
        const m = await materialNoGhe();
        const { solicitacao, itens } = await criar([item(m)]);
        const pausa = primeiro === 'decisao' ? portao(t, solRepo, 'registrarDecisao') : portao(t, solRepo, 'cancelar');
        const lider = primeiro === 'decisao' ? decidir(solicitacao.id, [aprovar(itens[0])]) : cancelar(solicitacao.id);
        await pausa.chegada;
        // A seguidora é observada desde já: a rejeição esperada não pode ficar sem tratador.
        const seguidora = (primeiro === 'decisao' ? cancelar(solicitacao.id) : decidir(solicitacao.id, [aprovar(itens[0])]))
          .then((valor) => ({ valor }), (erro) => ({ erro }));
        await aguardarEsperaPorTravaDeLinha(pool);
        pausa.liberar();
        const resultado = await comLimite(lider, 'transação líder');
        const { valor, erro } = await comLimite(seguidora, 'transação seguidora');
        assert.equal(valor, undefined, 'a seguidora não pode ter vencido');
        assert.deepEqual([erro.status, erro.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
        const estado = await estadoGravado(solicitacao.id);
        if (primeiro === 'decisao') {
          assert.deepEqual([resultado.solicitacao.status, estado.cabecalho.status, estado.cabecalho.cancelada_por], ['APROVADA', 'APROVADA', null]);
        } else {
          assert.deepEqual([resultado.solicitacao.status, estado.cabecalho.status, estado.itens[0].decisao], ['CANCELADA', 'CANCELADA', null]);
        }
        t.mock.restoreAll();
      }
    });

    test('duas aprovações do mesmo par esperam uma pela outra na trava do par; um par diferente não espera', async (t) => {
      const m = await materialNoGhe();
      const outro = await materialNoGhe();
      const r1 = await criar([item(m, { quantidade: 1 })]);
      const r2 = await criar([item(m, { quantidade: 1 })], { funcionarioId: d.trabalhador2 });
      const r3 = await criar([item(outro, { quantidade: 1 })], { funcionarioId: d.trabalhador3 });
      const pausa = portao(t, solRepo, 'registrarDecisao');
      const primeira = decidir(r1.solicitacao.id, [aprovar(r1.itens[0])]);
      await pausa.chegada;
      const segunda = decidir(r2.solicitacao.id, [aprovar(r2.itens[0])]);
      await aguardarTravaAdvisoryPendente(pool);
      const terceira = await comLimite(decidir(r3.solicitacao.id, [aprovar(r3.itens[0])]), 'par diferente não deveria esperar');
      assert.equal(terceira.solicitacao.status, 'APROVADA');
      pausa.liberar();
      const [a, b] = await Promise.all([comLimite(primeira, 'primeira aprovação'), comLimite(segunda, 'segunda aprovação')]);
      assert.deepEqual([a.solicitacao.status, b.solicitacao.status], ['APROVADA', 'APROVADA']);
      assert.ok(a.solicitacao.decisao.decididaEm < b.solicitacao.decisao.decididaEm, 'a que travou o par primeiro é a mais antiga na fila');
    });
  });
});
