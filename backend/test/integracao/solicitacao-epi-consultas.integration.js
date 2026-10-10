'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations, criarMaterial } = require('./helpers/entrega-epi');
const { criarLoteDeEntrada, entregarPorSolicitacao, criarSolicitacao: criarSolicitacaoSql } = require('./helpers/solicitacao-epi');
const {
  montarMundoDoServico, inserirUsuario, vincularMaterialAoGhe, chaveNova,
} = require('./helpers/solicitacao-epi-servico');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Listagens da solicitação de EPI (12E-1) contra PostgreSQL real: minhas
 * solicitações, fila de decisão da SST e solicitações entregáveis. Situação
 * operacional e quantidades derivadas (nada gravado), coerência com o
 * detalhe, ordem, paginação, isolamento por empresa, ausência de CPF e de
 * texto livre, e leitura sem escrita.
 */

const consulta = () => exigirModulo('src/services/solicitacao-epi-consulta.service');
const funcao = (nome) => {
  const modulo = consulta();
  assert.equal(typeof modulo[nome], 'function', `função ainda não implementada: ${nome}`);
  return modulo[nome];
};
const servico = () => exigirModulo('src/services/solicitacao-epi.service');
const itemRepo = require('../../src/repositories/solicitacao-epi-item.repository');
const coberturaRepo = require('../../src/repositories/solicitacao-epi-cobertura.repository');
const HOJE = dataOperacional();
const TEXTO_LIVRE = 'Observação sensível que a lista não pode devolver';

async function abrirMundo() {
  const contexto = await abrirPoolTemporario(todasAsMigrations());
  const d = await montarMundoDoServico(contexto.pool);
  await vincularMaterialAoGhe(contexto.pool, d.empresaB, d.gheB, d.botinaB);
  return { contexto, pool: contexto.pool, d };
}

function ferramentas(pool, d) {
  let sequencia = 0;
  const q = (sql, params) => pool.query(sql, params);
  const item = (materialId, extra = {}) => ({ materialId, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO', ...extra });
  async function materialNoGhe() {
    sequencia += 1;
    const id = await criarMaterial(pool, d.empresaA, `Material de listagem ${sequencia}`, { exigeTamanho: true });
    await vincularMaterialAoGhe(pool, d.empresaA, d.gheA, id);
    return id;
  }
  const novoUsuario = async () => {
    sequencia += 1;
    return inserirUsuario(pool, d.empresaA, `listagem-${sequencia}@example.invalid`, 'USUARIO');
  };
  const novoTrabalhador = (opcoes = {}) => d.novoTrabalhador(d.empresaA, { gheId: d.gheA, ...opcoes });
  const criar = (atorId, funcionarioId, itens, extra = {}) => servico().criarSolicitacao(pool, {
    empresaId: d.empresaA, atorId, funcionarioId, itens, chaveIdempotencia: chaveNova(), ...extra,
  });
  const decidir = (solicitacaoId, decisoes, extra = {}) => servico().decidirSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.sst1, solicitacaoId, decisoes, hoje: HOJE, ...extra,
  });
  const cancelar = (atorId, solicitacaoId) => servico().cancelarSolicitacao(pool, { empresaId: d.empresaA, atorId, solicitacaoId });
  const aprovar = (i, quantidadeAprovada, justificativa) => ({
    itemId: i.id, decisao: 'APROVADO', ...(quantidadeAprovada === undefined ? {} : { quantidadeAprovada }), ...(justificativa === undefined ? {} : { justificativa }),
  });
  const reprovar = (i) => ({ itemId: i.id, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada' });
  const estoque = (materialId, quantidade) => criarLoteDeEntrada(pool, { empresaId: d.empresaA, materialId, quantidade, usuarioId: d.master });
  async function entregarReal(solicitacaoId, entregas) {
    const { rows: [solicitacao] } = await q('SELECT * FROM solicitacoes_epi WHERE id = $1', [solicitacaoId]);
    const itens = [];
    for (const [itemId, loteId, quantidade] of entregas) {
      const { rows: [linha] } = await q('SELECT * FROM solicitacoes_epi_itens WHERE id = $1', [itemId]);
      itens.push({ item: linha, loteId, quantidade });
    }
    return entregarPorSolicitacao(pool, { solicitacao, itens, usuarioId: d.master });
  }
  const detalhe = (solicitacaoId, empresaId = d.empresaA) => servico().buscarSolicitacao(pool, { empresaId, solicitacaoId, hoje: HOJE });
  const cpfsCadastrados = async () => (await q('SELECT cpf FROM funcionarios')).rows.map((r) => r.cpf);
  const fotoDeEscrita = async () => (await q(
    `SELECT (SELECT count(*)::int FROM solicitacoes_epi) AS solicitacoes, (SELECT count(*)::int FROM solicitacoes_epi_itens) AS itens,
            (SELECT count(*)::int FROM logs_auditoria) AS auditoria, (SELECT count(*)::int FROM estoque_operacoes) AS operacoes,
            (SELECT count(*)::int FROM entregas_epi) AS entregas, (SELECT count(*)::int FROM estoque_lotes) AS lotes`,
  )).rows[0];
  return {
    q, item, materialNoGhe, novoUsuario, novoTrabalhador, criar, decidir, cancelar, aprovar, reprovar, estoque, entregarReal, detalhe, cpfsCadastrados, fotoDeEscrita,
  };
}

const CHAVES_DA_LINHA = [
  'criadaEm', 'decididaEm', 'canceladaEm', 'entregueEm', 'funcionario', 'id', 'numero', 'quantidadeItens', 'quantidades', 'situacaoOperacional', 'solicitanteUsuarioId', 'status',
].sort();
// "Minhas" traz também a data do encerramento (12F-1); a fila e os entregáveis não.
const CHAVES_DA_MINHA = [...CHAVES_DA_LINHA, 'encerradaEm'].sort();

function somarDoDetalhe(lida) {
  const aprovados = lida.itens.filter((i) => i.decisao === 'APROVADO');
  return {
    solicitada: lida.itens.reduce((s, i) => s + i.quantidade, 0),
    aprovada: aprovados.reduce((s, i) => s + i.quantidadeAprovada, 0),
    entregue: aprovados.reduce((s, i) => s + i.quantidadeEntregue, 0),
  };
}

describe('listagens da solicitação de EPI — minhas solicitações (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let f;
  let eu;
  let outro;
  let t1;
  let t2;
  const R = {};
  let ordemDeCriacao;

  const minhas = (atorId, extra = {}) => funcao('listarMinhas')(pool, {
    empresaId: d.empresaA, atorId, pagina: 1, limite: 100, hoje: HOJE, ...extra,
  });

  before(async () => {
    ({ contexto, pool, d } = await abrirMundo());
    f = ferramentas(pool, d);
    eu = await f.novoUsuario();
    outro = await f.novoUsuario();
    t1 = await f.novoTrabalhador();
    t2 = await f.novoTrabalhador();

    R.pendente = await f.criar(eu, t1, [f.item(await f.materialNoGhe())], { observacao: TEXTO_LIVRE });
    R.cancelada = await f.criar(eu, t2, [f.item(await f.materialNoGhe())]);
    await f.cancelar(eu, R.cancelada.solicitacao.id);
    R.reprovada = await f.criar(eu, t1, [f.item(await f.materialNoGhe())]);
    await f.decidir(R.reprovada.solicitacao.id, [f.reprovar(R.reprovada.itens[0])]);

    const mAguardando = await f.materialNoGhe();
    R.aguardando = await f.criar(eu, t2, [f.item(mAguardando)]);
    await f.decidir(R.aguardando.solicitacao.id, [f.aprovar(R.aguardando.itens[0])]);

    const mPronta = await f.materialNoGhe();
    R.pronta = await f.criar(eu, t1, [f.item(mPronta)]);
    await f.decidir(R.pronta.solicitacao.id, [f.aprovar(R.pronta.itens[0])]);
    await f.estoque(mPronta, 2);

    const mA = await f.materialNoGhe();
    const mB = await f.materialNoGhe();
    R.parcialAprovada = await f.criar(eu, t2, [f.item(mA, { quantidade: 3 }), f.item(mB, { quantidade: 2 })]);
    await f.decidir(R.parcialAprovada.solicitacao.id, [
      f.aprovar(R.parcialAprovada.itens[0], 2, 'Estoque limitado de teste'), f.reprovar(R.parcialAprovada.itens[1]),
    ]);
    await f.estoque(mA, 2);

    const mC = await f.materialNoGhe();
    R.parcialEntregue = await f.criar(eu, t1, [f.item(mC, { quantidade: 4 })]);
    await f.decidir(R.parcialEntregue.solicitacao.id, [f.aprovar(R.parcialEntregue.itens[0])]);
    const loteC = await f.estoque(mC, 4);
    await f.entregarReal(R.parcialEntregue.solicitacao.id, [[R.parcialEntregue.itens[0].id, loteC, 1]]);

    const mD = await f.materialNoGhe();
    R.entregue = await f.criar(eu, t2, [f.item(mD)]);
    await f.decidir(R.entregue.solicitacao.id, [f.aprovar(R.entregue.itens[0])]);
    const loteD = await f.estoque(mD, 2);
    await f.entregarReal(R.entregue.solicitacao.id, [[R.entregue.itens[0].id, loteD, 2]]);

    R.deOutro = await f.criar(outro, t1, [f.item(await f.materialNoGhe())]);
    R.deB = await servico().criarSolicitacao(pool, {
      empresaId: d.empresaB,
      atorId: d.usuarioB,
      funcionarioId: d.trabalhadorB,
      itens: [{ materialId: d.botinaB, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }],
      chaveIdempotencia: chaveNova(),
    });
    await criarSolicitacaoSql(pool, d, {
      empresaId: d.empresaA, funcionarioId: t1, solicitanteId: null, origem: 'AUTOATENDIMENTO', itens: [{ material_id: await f.materialNoGhe() }],
    });
    ordemDeCriacao = [R.pendente, R.cancelada, R.reprovada, R.aguardando, R.pronta, R.parcialAprovada, R.parcialEntregue, R.entregue].map((x) => x.solicitacao.id);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('lista só as solicitações do próprio usuário, todas as situações, das mais recentes para as antigas; nada de outro usuário, de autoatendimento ou de outra empresa', async () => {
    const lista = await minhas(eu);
    assert.deepEqual(lista.solicitacoes.map((s) => s.id), [...ordemDeCriacao].reverse());
    assert.deepEqual([lista.total, lista.pagina, lista.limite], [8, 1, 100]);
    assert.equal(lista.solicitacoes.some((s) => s.id === R.deOutro.solicitacao.id), false);
    assert.equal(lista.solicitacoes.some((s) => s.id === R.deB.solicitacao.id), false);
    assert.ok(lista.solicitacoes.every((s) => s.solicitanteUsuarioId === eu));
  });

  test('situação operacional e quantidades por estado: pendente, cancelada, reprovada, aguardando, pronta, parcial, parcialmente entregue e entregue', async () => {
    const lista = await minhas(eu);
    const por = new Map(lista.solicitacoes.map((s) => [s.id, s]));
    const esperado = (r) => por.get(r.solicitacao.id);
    const veja = (r) => [esperado(r).status, esperado(r).situacaoOperacional, esperado(r).quantidades];
    assert.deepEqual(veja(R.pendente), ['PENDENTE', null, { solicitada: 2, aprovada: null, entregue: null, restante: null }]);
    assert.deepEqual(veja(R.cancelada), ['CANCELADA', null, { solicitada: 2, aprovada: null, entregue: null, restante: null }]);
    assert.deepEqual(veja(R.reprovada), ['REPROVADA', null, { solicitada: 2, aprovada: 0, entregue: null, restante: null }]);
    assert.deepEqual(veja(R.aguardando), ['APROVADA', 'AGUARDANDO_ESTOQUE', { solicitada: 2, aprovada: 2, entregue: 0, restante: 2 }]);
    assert.deepEqual(veja(R.pronta), ['APROVADA', 'PRONTA_PARA_ENTREGA', { solicitada: 2, aprovada: 2, entregue: 0, restante: 2 }]);
    assert.deepEqual(veja(R.parcialAprovada), ['APROVADA_PARCIAL', 'PRONTA_PARA_ENTREGA', { solicitada: 5, aprovada: 2, entregue: 0, restante: 2 }]);
    assert.deepEqual(veja(R.parcialEntregue), ['APROVADA', 'PARCIALMENTE_ENTREGUE', { solicitada: 4, aprovada: 4, entregue: 1, restante: 3 }]);
    assert.deepEqual(veja(R.entregue), ['ENTREGUE', 'ENTREGUE', { solicitada: 2, aprovada: 2, entregue: 2, restante: 0 }]);
  });

  test('a solicitação entregue continua na lista do solicitante, com a data da entrega', async () => {
    const lista = await minhas(eu, { status: 'ENTREGUE' });
    assert.deepEqual(lista.solicitacoes.map((s) => s.id), [R.entregue.solicitacao.id]);
    assert.ok(lista.solicitacoes[0].entregueEm instanceof Date);
  });

  test('o filtro de status devolve só aquele status e o total correspondente', async () => {
    const aprovadas = await minhas(eu, { status: 'APROVADA' });
    assert.deepEqual(aprovadas.solicitacoes.map((s) => s.id).sort((a, b) => a - b), [R.aguardando, R.pronta, R.parcialEntregue].map((r) => r.solicitacao.id));
    assert.equal(aprovadas.total, 3);
    const pendentes = await minhas(eu, { status: 'PENDENTE' });
    assert.deepEqual([pendentes.solicitacoes.map((s) => s.id), pendentes.total], [[R.pendente.solicitacao.id], 1]);
    const nenhuma = await minhas(eu, { status: 'APROVADA_PARCIAL' });
    assert.equal(nenhuma.total, 1);
  });

  test('paginação: páginas consecutivas reconstroem a lista inteira, sem repetir; página além da última vem vazia com o total', async () => {
    const inteira = (await minhas(eu)).solicitacoes.map((s) => s.id);
    const paginas = [];
    for (let pagina = 1; pagina <= 3; pagina += 1) paginas.push(await minhas(eu, { pagina, limite: 3 }));
    assert.deepEqual(paginas.map((p) => p.solicitacoes.length), [3, 3, 2]);
    assert.ok(paginas.every((p) => p.total === 8 && p.limite === 3));
    assert.deepEqual(paginas.flatMap((p) => p.solicitacoes.map((s) => s.id)), inteira);
    const alemDaUltima = await minhas(eu, { pagina: 4, limite: 3 });
    assert.deepEqual([alemDaUltima.solicitacoes.length, alemDaUltima.total], [0, 8]);
  });

  test('a linha tem só os campos previstos; o trabalhador sai com nome, matrícula e situação, sem CPF; nenhum texto livre', async () => {
    const lista = await minhas(eu);
    for (const s of lista.solicitacoes) {
      assert.deepEqual(Object.keys(s).sort(), CHAVES_DA_MINHA);
      assert.deepEqual(Object.keys(s.funcionario).sort(), ['ativo', 'id', 'matricula', 'nome']);
    }
    const doPendente = lista.solicitacoes.find((s) => s.id === R.pendente.solicitacao.id);
    assert.deepEqual(doPendente.funcionario, { id: t1, nome: doPendente.funcionario.nome, matricula: doPendente.funcionario.matricula, ativo: true });
    assert.match(doPendente.funcionario.nome, /^Trabalhador T-\d+$/);
    const texto = JSON.stringify(lista);
    for (const cpf of await f.cpfsCadastrados()) assert.equal(texto.includes(cpf), false, 'CPF na lista');
    assert.equal(texto.includes(TEXTO_LIVRE), false);
    for (const proibido of ['observacao', 'justificativa', 'chaveIdempotencia', 'requisicaoHash', 'empresaId', 'itens"']) assert.equal(texto.includes(proibido), false, proibido);
  });

  test('coerente com o detalhe: a situação e as quantidades de cada linha são as do detalhe da mesma solicitação', async () => {
    const lista = await minhas(eu);
    for (const s of lista.solicitacoes) {
      const lida = await f.detalhe(s.id);
      assert.equal(s.situacaoOperacional, lida.solicitacao.situacaoOperacional, `solicitação ${s.id}`);
      assert.equal(s.status, lida.solicitacao.status);
      const soma = somarDoDetalhe(lida);
      assert.equal(s.quantidades.solicitada, soma.solicitada);
      if (s.quantidades.aprovada !== null) assert.equal(s.quantidades.aprovada, soma.aprovada);
      if (s.quantidades.entregue !== null) assert.equal(s.quantidades.entregue, soma.entregue);
    }
  });

  test('a fila de cobertura é a da empresa inteira: a solicitação de outro usuário, aprovada antes, consome o estoque e a minha fica aguardando', async () => {
    const m = await f.materialNoGhe();
    const meu = await f.novoUsuario();
    const outroUsuario = await f.novoUsuario();
    const trabalhador = await f.novoTrabalhador();
    const doOutro = await f.criar(outroUsuario, trabalhador, [f.item(m)]);
    const minha = await f.criar(meu, trabalhador, [f.item(m)]);
    await f.decidir(doOutro.solicitacao.id, [f.aprovar(doOutro.itens[0])]);
    await f.decidir(minha.solicitacao.id, [f.aprovar(minha.itens[0])]);
    await f.estoque(m, 2);
    const lista = await minhas(meu);
    assert.deepEqual(lista.solicitacoes.map((s) => [s.id, s.situacaoOperacional]), [[minha.solicitacao.id, 'AGUARDANDO_ESTOQUE']]);
    const dele = await minhas(outroUsuario);
    assert.equal(dele.solicitacoes[0].situacaoOperacional, 'PRONTA_PARA_ENTREGA');
  });

  test('a suspensão por trabalhador inativo é derivada: o status gravado não muda e a linha volta ao normal na reativação', async () => {
    const m = await f.materialNoGhe();
    const usuario = await f.novoUsuario();
    const trabalhador = await f.novoTrabalhador();
    const { solicitacao, itens } = await f.criar(usuario, trabalhador, [f.item(m)]);
    await f.decidir(solicitacao.id, [f.aprovar(itens[0])]);
    await f.estoque(m, 2);
    try {
      await f.q("UPDATE funcionarios SET situacao = 'INATIVO' WHERE id = $1", [trabalhador]);
      const suspensa = (await minhas(usuario)).solicitacoes[0];
      assert.deepEqual([suspensa.status, suspensa.situacaoOperacional, suspensa.funcionario.ativo], ['APROVADA', 'SUSPENSA', false]);
      assert.deepEqual(suspensa.quantidades, { solicitada: 2, aprovada: 2, entregue: 0, restante: 2 });
    } finally {
      await f.q("UPDATE funcionarios SET situacao = 'ATIVO' WHERE id = $1", [trabalhador]);
    }
    assert.equal((await minhas(usuario)).solicitacoes[0].situacaoOperacional, 'PRONTA_PARA_ENTREGA');
  });

  test('isolamento: o usuário de outra empresa lista só as suas; o identificador de ator de uma empresa não enxerga nada na outra', async () => {
    const daB = await funcao('listarMinhas')(pool, { empresaId: d.empresaB, atorId: d.usuarioB, pagina: 1, limite: 100, hoje: HOJE });
    assert.deepEqual(daB.solicitacoes.map((s) => s.id), [R.deB.solicitacao.id]);
    const forjado = await funcao('listarMinhas')(pool, { empresaId: d.empresaB, atorId: eu, pagina: 1, limite: 100, hoje: HOJE });
    assert.deepEqual([forjado.solicitacoes.length, forjado.total], [0, 0]);
    const outroAtor = await minhas(outro);
    assert.deepEqual(outroAtor.solicitacoes.map((s) => s.id), [R.deOutro.solicitacao.id]);
  });

  test('leitura pura: nenhuma tabela muda, nem a auditoria', async () => {
    const antes = await f.fotoDeEscrita();
    await minhas(eu);
    await minhas(eu, { status: 'APROVADA', pagina: 1, limite: 2 });
    assert.deepEqual(await f.fotoDeEscrita(), antes);
  });
});

describe('listagens da solicitação de EPI — fila de decisão da SST (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let f;
  let u1;
  let u2;
  let t1;
  let t2;
  const criadas = [];
  let autoatendimento;

  const fila = (extra = {}, empresaId = undefined) => funcao('listarFila')(pool, {
    empresaId: empresaId ?? d.empresaA, pagina: 1, limite: 100, ...extra,
  });

  before(async () => {
    ({ contexto, pool, d } = await abrirMundo());
    f = ferramentas(pool, d);
    u1 = await f.novoUsuario();
    u2 = await f.novoUsuario();
    t1 = await f.novoTrabalhador();
    t2 = await f.novoTrabalhador();
    for (let i = 0; i < 6; i += 1) {
      const m = await f.materialNoGhe();
      const extra = i === 0 ? { observacao: TEXTO_LIVRE } : {};
      criadas.push(await f.criar(i % 2 === 0 ? u1 : u2, i % 2 === 0 ? t1 : t2, [f.item(m, { quantidade: i + 1 }), f.item(await f.materialNoGhe(), { quantidade: 1 })], extra));
    }
    autoatendimento = await criarSolicitacaoSql(pool, d, {
      empresaId: d.empresaA, funcionarioId: t1, solicitanteId: null, origem: 'AUTOATENDIMENTO', itens: [{ material_id: await f.materialNoGhe(), quantidade: 3 }],
    });
    await f.cancelar(u2, criadas[1].solicitacao.id);
    await f.decidir(criadas[2].solicitacao.id, [f.aprovar(criadas[2].itens[0]), f.aprovar(criadas[2].itens[1])]);
    await f.decidir(criadas[3].solicitacao.id, [f.reprovar(criadas[3].itens[0]), f.reprovar(criadas[3].itens[1])]);
    await servico().criarSolicitacao(pool, {
      empresaId: d.empresaB,
      atorId: d.usuarioB,
      funcionarioId: d.trabalhadorB,
      itens: [{ materialId: d.botinaB, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }],
      chaveIdempotencia: chaveNova(),
    });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('só as PENDENTE da empresa, da mais antiga para a mais nova; decididas e canceladas saem; autoatendimento entra sem solicitante', async () => {
    const lista = await fila();
    assert.deepEqual(
      lista.solicitacoes.map((s) => s.id),
      [criadas[0], criadas[4], criadas[5]].map((r) => r.solicitacao.id).concat([autoatendimento.solicitacao.id]),
    );
    assert.equal(lista.total, 4);
    assert.ok(lista.solicitacoes.every((s) => s.status === 'PENDENTE'));
    const sem = lista.solicitacoes.find((s) => s.id === autoatendimento.solicitacao.id);
    assert.equal(sem.solicitanteUsuarioId, null);
    assert.deepEqual(lista.solicitacoes.slice(0, 3).map((s) => s.solicitanteUsuarioId), [u1, u1, u2]);
  });

  test('dados mínimos: sem itens, sem situação operacional; só a quantidade solicitada; trabalhador sem CPF; nenhum texto livre', async () => {
    const lista = await fila();
    for (const s of lista.solicitacoes) {
      assert.deepEqual(Object.keys(s).sort(), CHAVES_DA_LINHA);
      assert.equal(s.situacaoOperacional, null);
      assert.deepEqual([s.quantidades.aprovada, s.quantidades.entregue, s.quantidades.restante], [null, null, null]);
    }
    const primeira = lista.solicitacoes[0];
    assert.equal(primeira.quantidades.solicitada, 2);
    assert.equal(primeira.quantidadeItens, 2);
    assert.deepEqual(Object.keys(primeira.funcionario).sort(), ['ativo', 'id', 'matricula', 'nome']);
    const texto = JSON.stringify(lista);
    for (const cpf of await f.cpfsCadastrados()) assert.equal(texto.includes(cpf), false, 'CPF na fila');
    assert.equal(texto.includes(TEXTO_LIVRE), false);
  });

  test('a solicitação decidida ou cancelada deixa a fila no ato', async () => {
    const m = await f.materialNoGhe();
    const { solicitacao, itens } = await f.criar(u1, t1, [f.item(m)]);
    assert.equal((await fila()).solicitacoes.some((s) => s.id === solicitacao.id), true);
    await f.decidir(solicitacao.id, [f.aprovar(itens[0])]);
    assert.equal((await fila()).solicitacoes.some((s) => s.id === solicitacao.id), false);
    const outra = await f.criar(u1, t1, [f.item(await f.materialNoGhe())]);
    await f.cancelar(u1, outra.solicitacao.id);
    assert.equal((await fila()).solicitacoes.some((s) => s.id === outra.solicitacao.id), false);
  });

  test('paginação da fila: total estável, páginas consecutivas na mesma ordem, além da última vem vazia', async () => {
    const inteira = (await fila()).solicitacoes.map((s) => s.id);
    const p1 = await fila({ pagina: 1, limite: 2 });
    const p2 = await fila({ pagina: 2, limite: 2 });
    const p3 = await fila({ pagina: 3, limite: 2 });
    assert.ok([p1, p2, p3].every((p) => p.total === inteira.length));
    assert.deepEqual([...p1.solicitacoes, ...p2.solicitacoes, ...p3.solicitacoes].map((s) => s.id), inteira);
    assert.deepEqual([p3.solicitacoes.length], [Math.max(0, inteira.length - 4)]);
  });

  test('isolamento: a fila de cada empresa traz só as pendentes dela', async () => {
    const daB = await fila({}, d.empresaB);
    assert.equal(daB.total, 1);
    assert.deepEqual(daB.solicitacoes.map((s) => s.funcionario.id), [d.trabalhadorB]);
    const daA = await fila();
    assert.equal(daA.solicitacoes.some((s) => s.funcionario.id === d.trabalhadorB), false);
  });

  test('leitura pura: nenhuma tabela muda, nem a auditoria', async () => {
    const antes = await f.fotoDeEscrita();
    await fila();
    await fila({ pagina: 2, limite: 1 });
    assert.deepEqual(await f.fotoDeEscrita(), antes);
  });
});

describe('listagens da solicitação de EPI — entregáveis (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let f;
  let solicitante;
  let t1;
  let t2;
  let tInativo;
  const R = {};

  const entregaveis = (extra = {}, empresaId = undefined) => funcao('listarEntregaveis')(pool, {
    empresaId: empresaId ?? d.empresaA, pagina: 1, limite: 100, hoje: HOJE, ...extra,
  });
  const aprovada = async (trabalhador, materialId, quantidade, { estoqueInicial = null } = {}) => {
    const r = await f.criar(solicitante, trabalhador, [f.item(materialId, { quantidade })]);
    await f.decidir(r.solicitacao.id, [f.aprovar(r.itens[0])]);
    const lote = estoqueInicial === null ? null : await f.estoque(materialId, estoqueInicial);
    return { ...r, lote };
  };

  before(async () => {
    ({ contexto, pool, d } = await abrirMundo());
    f = ferramentas(pool, d);
    solicitante = await f.novoUsuario();
    t1 = await f.novoTrabalhador();
    t2 = await f.novoTrabalhador();
    tInativo = await f.novoTrabalhador();

    R.pronta = await aprovada(t1, await f.materialNoGhe(), 2, { estoqueInicial: 2 });
    R.parcial = await aprovada(t2, await f.materialNoGhe(), 5, { estoqueInicial: 2 });
    const mP = R.parcial.itens[0].materialId;
    const segundoLote = await f.estoque(mP, 3);
    await f.entregarReal(R.parcial.solicitacao.id, [[R.parcial.itens[0].id, R.parcial.lote, 2], [R.parcial.itens[0].id, segundoLote, 1]]);
    R.aguardando = await aprovada(t1, await f.materialNoGhe(), 4);
    R.entregue = await aprovada(t2, await f.materialNoGhe(), 1, { estoqueInicial: 1 });
    await f.entregarReal(R.entregue.solicitacao.id, [[R.entregue.itens[0].id, R.entregue.lote, 1]]);
    R.pendente = await f.criar(solicitante, t1, [f.item(await f.materialNoGhe())]);
    R.cancelada = await f.criar(solicitante, t1, [f.item(await f.materialNoGhe())]);
    await f.cancelar(solicitante, R.cancelada.solicitacao.id);
    R.reprovada = await f.criar(solicitante, t1, [f.item(await f.materialNoGhe())]);
    await f.decidir(R.reprovada.solicitacao.id, [f.reprovar(R.reprovada.itens[0])]);
    R.suspensa = await aprovada(tInativo, await f.materialNoGhe(), 2, { estoqueInicial: 2 });
    await f.q("UPDATE funcionarios SET situacao = 'INATIVO' WHERE id = $1", [tInativo]);

    const daB = await servico().criarSolicitacao(pool, {
      empresaId: d.empresaB,
      atorId: d.usuarioB,
      funcionarioId: d.trabalhadorB,
      itens: [{ materialId: d.botinaB, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }],
      chaveIdempotencia: chaveNova(),
    });
    await servico().decidirSolicitacao(pool, {
      empresaId: d.empresaB, atorId: d.sstB, solicitacaoId: daB.solicitacao.id, decisoes: [{ itemId: daB.itens[0].id, decisao: 'APROVADO' }], hoje: HOJE,
    });
    R.deB = daB;
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('só APROVADA e APROVADA_PARCIAL, na ordem da fila de cobertura (decidida_em, id); entregue, pendente, cancelada e reprovada ficam de fora', async () => {
    const lista = await entregaveis();
    assert.deepEqual(
      lista.solicitacoes.map((s) => s.id),
      [R.pronta, R.parcial, R.aguardando, R.suspensa].map((r) => r.solicitacao.id),
    );
    assert.equal(lista.total, 4);
    assert.ok(lista.solicitacoes.every((s) => ['APROVADA', 'APROVADA_PARCIAL'].includes(s.status)));
  });

  test('situação operacional e quantidades: aprovada, entregue (soma de entregas e lotes) e restante', async () => {
    const lista = await entregaveis();
    const por = new Map(lista.solicitacoes.map((s) => [s.id, s]));
    const veja = (r) => [por.get(r.solicitacao.id).situacaoOperacional, por.get(r.solicitacao.id).quantidades];
    assert.deepEqual(veja(R.pronta), ['PRONTA_PARA_ENTREGA', { solicitada: 2, aprovada: 2, entregue: 0, restante: 2 }]);
    assert.deepEqual(veja(R.parcial), ['PARCIALMENTE_ENTREGUE', { solicitada: 5, aprovada: 5, entregue: 3, restante: 2 }]);
    assert.deepEqual(veja(R.aguardando), ['AGUARDANDO_ESTOQUE', { solicitada: 4, aprovada: 4, entregue: 0, restante: 4 }]);
  });

  test('o trabalhador inativo mantém a solicitação na lista como SUSPENSA, com o status gravado intacto e o trabalhador marcado como inativo', async () => {
    const lista = await entregaveis();
    const suspensa = lista.solicitacoes.find((s) => s.id === R.suspensa.solicitacao.id);
    assert.deepEqual([suspensa.status, suspensa.situacaoOperacional, suspensa.funcionario.ativo], ['APROVADA', 'SUSPENSA', false]);
  });

  test('o filtro por trabalhador devolve só as dele e o total correspondente', async () => {
    const doT1 = await entregaveis({ funcionarioId: t1 });
    assert.deepEqual(doT1.solicitacoes.map((s) => s.id), [R.pronta, R.aguardando].map((r) => r.solicitacao.id));
    assert.equal(doT1.total, 2);
    const doT2 = await entregaveis({ funcionarioId: t2 });
    assert.deepEqual(doT2.solicitacoes.map((s) => s.id), [R.parcial.solicitacao.id]);
    const semNada = await entregaveis({ funcionarioId: d.trabalhadorB });
    assert.deepEqual([semNada.solicitacoes.length, semNada.total], [0, 0]);
  });

  test('a cobertura é calculada contra a fila inteira, não contra a página: com uma linha por página, a segunda aprovada continua aguardando', async () => {
    const m = await f.materialNoGhe();
    const primeira = await aprovada(t1, m, 3, { estoqueInicial: 3 });
    const segunda = await aprovada(t2, m, 3);
    const todas = (await entregaveis()).solicitacoes.map((s) => s.id);
    const posPrimeira = todas.indexOf(primeira.solicitacao.id);
    const pagina = (n) => entregaveis({ pagina: n, limite: 1 });
    const daPrimeira = (await pagina(posPrimeira + 1)).solicitacoes[0];
    const daSegunda = (await pagina(todas.indexOf(segunda.solicitacao.id) + 1)).solicitacoes[0];
    assert.equal(daPrimeira.situacaoOperacional, 'PRONTA_PARA_ENTREGA');
    assert.equal(daSegunda.situacaoOperacional, 'AGUARDANDO_ESTOQUE');
  });

  test('paginação: páginas consecutivas reconstroem a lista, o total é estável e além da última vem vazia', async () => {
    const inteira = (await entregaveis()).solicitacoes.map((s) => s.id);
    const paginas = [];
    for (let pagina = 1; pagina <= Math.ceil(inteira.length / 2); pagina += 1) paginas.push(await entregaveis({ pagina, limite: 2 }));
    assert.deepEqual(paginas.flatMap((p) => p.solicitacoes.map((s) => s.id)), inteira);
    assert.ok(paginas.every((p) => p.total === inteira.length));
    const alem = await entregaveis({ pagina: 99, limite: 2 });
    assert.deepEqual([alem.solicitacoes.length, alem.total], [0, inteira.length]);
  });

  test('coerente com o detalhe: situação e quantidades de cada linha são as do detalhe', async () => {
    for (const s of (await entregaveis()).solicitacoes) {
      const lida = await f.detalhe(s.id);
      assert.equal(s.situacaoOperacional, lida.solicitacao.situacaoOperacional, `solicitação ${s.id}`);
      const soma = somarDoDetalhe(lida);
      assert.deepEqual([s.quantidades.solicitada, s.quantidades.aprovada, s.quantidades.entregue], [soma.solicitada, soma.aprovada, soma.entregue]);
      assert.equal(s.quantidades.restante, soma.aprovada - soma.entregue);
    }
  });

  test('sem CPF, sem texto livre, só os campos previstos', async () => {
    const lista = await entregaveis();
    for (const s of lista.solicitacoes) assert.deepEqual(Object.keys(s).sort(), CHAVES_DA_LINHA);
    const texto = JSON.stringify(lista);
    for (const cpf of await f.cpfsCadastrados()) assert.equal(texto.includes(cpf), false, 'CPF na lista');
    for (const proibido of ['observacao', 'justificativa', 'chaveIdempotencia', 'requisicaoHash', 'empresaId']) assert.equal(texto.includes(proibido), false, proibido);
  });

  test('isolamento: cada empresa vê só as aprovadas dela', async () => {
    const daB = await entregaveis({}, d.empresaB);
    assert.deepEqual(daB.solicitacoes.map((s) => s.id), [R.deB.solicitacao.id]);
    const daA = await entregaveis();
    assert.equal(daA.solicitacoes.some((s) => s.id === R.deB.solicitacao.id), false);
    const cruzado = await entregaveis({ funcionarioId: t1 }, d.empresaB);
    assert.deepEqual([cruzado.solicitacoes.length, cruzado.total], [0, 0]);
  });

  test('leitura pura: nenhuma tabela muda, nem a auditoria', async () => {
    const antes = await f.fotoDeEscrita();
    await entregaveis();
    await entregaveis({ funcionarioId: t1, pagina: 1, limite: 1 });
    assert.deepEqual(await f.fotoDeEscrita(), antes);
  });

  test('cobertura em lote: igual à de cada solicitação isolada, só com os itens pedidos e contra a fila inteira do par', async () => {
    const m = await f.materialNoGhe();
    const primeira = await aprovada(t1, m, 3, { estoqueInicial: 4 });
    const segunda = await aprovada(t2, m, 3);
    const ids = [R.pronta, R.parcial, R.aguardando, R.suspensa, primeira, segunda].map((r) => r.solicitacao.id);
    const emLote = await coberturaRepo.listarCoberturaDasSolicitacoes(pool, d.empresaA, { hoje: HOJE, solicitacaoIds: ids });
    const separadas = [];
    for (const id of ids) separadas.push(...await coberturaRepo.listarCobertura(pool, d.empresaA, { hoje: HOJE, solicitacaoId: id }));
    const ordem = (a, b) => a.decididaEm - b.decididaEm || a.solicitacaoId - b.solicitacaoId || a.itemId - b.itemId;
    assert.deepEqual(emLote, separadas.sort(ordem));

    const soAsegunda = await coberturaRepo.listarCoberturaDasSolicitacoes(pool, d.empresaA, { hoje: HOJE, solicitacaoIds: [segunda.solicitacao.id] });
    assert.deepEqual(soAsegunda.map((c) => [c.solicitacaoId, c.acumuladoAnterior, c.coberta, c.semCobertura]), [[segunda.solicitacao.id, 3, 1, 2]]);
  });

  test('itens e cobertura em lote não atravessam empresas: o identificador de outra empresa não devolve nada', async () => {
    const dosItens = await itemRepo.listarPorSolicitacoesComEntregue(pool, d.empresaA, [R.deB.solicitacao.id, R.pronta.solicitacao.id]);
    assert.deepEqual([...new Set(dosItens.map((i) => i.solicitacaoId))], [R.pronta.solicitacao.id]);
    assert.deepEqual(await itemRepo.listarPorSolicitacoesComEntregue(pool, d.empresaA, [R.deB.solicitacao.id]), []);
    const dosItensDaB = await itemRepo.listarPorSolicitacoesComEntregue(pool, d.empresaB, [R.deB.solicitacao.id, R.pronta.solicitacao.id]);
    assert.deepEqual([...new Set(dosItensDaB.map((i) => i.solicitacaoId))], [R.deB.solicitacao.id]);
    assert.deepEqual(await coberturaRepo.listarCoberturaDasSolicitacoes(pool, d.empresaA, { hoje: HOJE, solicitacaoIds: [R.deB.solicitacao.id] }), []);
  });
});
