'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/estoque.service');
const materialRepo = require('../../src/repositories/material.repository');
const loteRepo = require('../../src/repositories/estoque-lote.repository');
const posicaoRepo = require('../../src/repositories/posicao-estoque.repository');
const autorizacao = require('../../src/middleware/autorizacao');
const operacaoRepo = require('../../src/repositories/estoque-operacao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const parRepo = require('../../src/repositories/estoque-par.repository');
const coberturaRepo = require('../../src/repositories/solicitacao-epi-cobertura.repository');
const entregaRepo = require('../../src/repositories/entrega-epi.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de estoque por lote (Bloco 9), sem PostgreSQL
 * real. Ponto central: entrada e baixa nunca consultam permissao.repository.js
 * nem autoridade-administrativa.js — a autorização por AÇÃO
 * (MOVIMENTAR_ESTOQUE) é inteiramente do middleware da rota.
 */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const ATOR_ID = 7;
const MATERIAL_ID = 30;

const material = (extra = {}) => ({
  id: MATERIAL_ID, empresaId: EMPRESA, nome: 'Botina de segurança', ativo: true, exigeTamanho: true, ...extra,
});

function criarClienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; },
    release: () => { chamadas.push('RELEASE'); },
  };
}

const criarPoolFalso = (cliente) => ({ connect: async () => cliente, query: (...args) => cliente.query(...args) });
const contar = (chamadas, padrao) => chamadas.filter((c) => padrao.test(c)).length;

async function esperarHttpError(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.equal(erro.status, status);
    assert.equal(erro.codigo, codigo);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════
// Leitura por lote — Itens Disponíveis e lotes do material
// ═══════════════════════════════════════════════════════════════════
describe('listarDisponiveis — pela posição de todos os pares, com a data operacional (12D-2)', () => {
  const itemDaPosicao = (extra = {}) => ({
    materialId: 1, material: 'Botina', codigoInterno: 'EPI-1', categoria: 'EPI', tipo: 'Botina', tamanho: '40', unidade: 'par',
    saldo: 8, bloqueado: 3, fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3, semCobertura: 0,
    estoqueMinimo: 5, minimoOrigem: 'PROPRIO', abaixoDoMinimo: true, deficit: 2, necessidade: 2, caValidade: '2027-01-31', validade: 'ok', ...extra,
  });

  test('compõe itens, total, página, limite e filtros; passa empresa, hoje, o alerta de 60 dias e todos os filtros; nenhuma escrita', async (t) => {
    const recebido = {};
    t.mock.method(posicaoRepo, 'listarPosicoes', async (_p, empresaId, f) => { recebido.lista = [empresaId, f]; return { itens: [itemDaPosicao()], total: 1 }; });
    t.mock.method(loteRepo, 'listarFiltrosDisponiveis', async (_p, empresaId) => { recebido.filtros = empresaId; return { categorias: ['EPI'], tipos: [], tamanhos: ['G'] }; });
    const auditoria = t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('não deve auditar'); });
    const pool = { connect: async () => { throw new Error('não deve abrir transação'); }, query: async () => ({ rows: [] }) };

    const r = await servico.listarDisponiveis(pool, {
      empresaId: EMPRESA, hoje: '2026-09-30', categoria: 'EPI', validade: 'expired', busca: 'bot', situacao: 'ABAIXO_MINIMO', somenteComNecessidade: true, pagina: 1, limite: 50,
    });
    assert.deepEqual(recebido.lista, [EMPRESA, {
      hoje: '2026-09-30', diasAlerta: 60, categoria: 'EPI', tipo: null, tamanho: null, validade: 'expired', busca: 'bot', situacao: 'ABAIXO_MINIMO', somenteComNecessidade: true, pagina: 1, limite: 50,
    }]);
    assert.equal(recebido.filtros, EMPRESA);
    assert.deepEqual([r.total, r.pagina, r.limite, r.filtros], [1, 1, 50, { categorias: ['EPI'], tipos: [], tamanhos: ['G'] }]);
    assert.equal(auditoria.mock.callCount(), 0);
  });

  test('o item público é o contrato aditivo: campos antigos preservados, disponivel igual ao físico utilizável, e nada além (sem demandaPendente)', async (t) => {
    t.mock.method(posicaoRepo, 'listarPosicoes', async () => ({ itens: [itemDaPosicao()], total: 1 }));
    t.mock.method(loteRepo, 'listarFiltrosDisponiveis', async () => ({ categorias: [], tipos: [], tamanhos: [] }));
    const { itens: [item] } = await servico.listarDisponiveis({}, { empresaId: EMPRESA, hoje: '2026-09-30', pagina: 1, limite: 50 });
    assert.deepEqual(item, {
      materialId: 1,
      material: 'Botina',
      codigoInterno: 'EPI-1',
      categoria: 'EPI',
      tipo: 'Botina',
      tamanho: '40',
      saldo: 8,
      bloqueado: 3,
      disponivel: 5,
      fisicoUtilizavel: 5,
      comprometido: 2,
      saldoLivre: 3,
      semCobertura: 0,
      estoqueMinimo: 5,
      minimoOrigem: 'PROPRIO',
      abaixoDoMinimo: true,
      deficit: 2,
      necessidade: 2,
      unidade: 'par',
      caValidade: '2027-01-31',
      validade: 'ok',
    });
    assert.equal(item.disponivel, item.fisicoUtilizavel);
  });

  test('filtros ausentes viram null e somenteComNecessidade ausente vira falso', async (t) => {
    let recebido;
    t.mock.method(posicaoRepo, 'listarPosicoes', async (_p, _e, f) => { recebido = f; return { itens: [], total: 0 }; });
    t.mock.method(loteRepo, 'listarFiltrosDisponiveis', async () => ({ categorias: [], tipos: [], tamanhos: [] }));
    await servico.listarDisponiveis({}, { empresaId: EMPRESA, hoje: '2026-09-30', pagina: 1, limite: 50 });
    assert.deepEqual(recebido, {
      hoje: '2026-09-30', diasAlerta: 60, categoria: null, tipo: null, tamanho: null, validade: null, busca: null, situacao: null, somenteComNecessidade: false, pagina: 1, limite: 50,
    });
  });

  test('página além da última: itens vazios e o total continua correto', async (t) => {
    t.mock.method(posicaoRepo, 'listarPosicoes', async () => ({ itens: [], total: 23 }));
    t.mock.method(loteRepo, 'listarFiltrosDisponiveis', async () => ({ categorias: [], tipos: [], tamanhos: [] }));
    const r = await servico.listarDisponiveis({}, { empresaId: EMPRESA, hoje: '2026-09-30', pagina: 4, limite: 10 });
    assert.deepEqual([r.itens, r.total, r.pagina, r.limite], [[], 23, 4, 10]);
  });

  test('empresa ou data operacional inválida é recusada antes de consultar', async (t) => {
    const lista = t.mock.method(posicaoRepo, 'listarPosicoes', async () => ({ itens: [], total: 0 }));
    await assert.rejects(() => servico.listarDisponiveis({}, { empresaId: 0, hoje: '2026-09-30', pagina: 1, limite: 50 }), /empresa/i);
    await assert.rejects(() => servico.listarDisponiveis({}, { empresaId: EMPRESA, pagina: 1, limite: 50 }), /data operacional/i);
    assert.equal(lista.mock.callCount(), 0);
  });
});

describe('listarOperacoes — histórico, com o detalhe da entrega só para quem vê a ficha (12D-2)', () => {
  const contextoDoUsuario = { empresaId: EMPRESA, usuarioId: 11, perfil: 'USUARIO' };
  const pagina = { pagina: 1, limite: 50 };

  function simular(t, { podeVerFicha, linhas = [], total = 0 }) {
    const recebido = {};
    t.mock.method(operacaoRepo, 'listarHistorico', async (_p, empresaId, f) => { recebido.lista = [empresaId, f]; return linhas; });
    t.mock.method(operacaoRepo, 'contarHistorico', async (_p, empresaId, f) => { recebido.conta = [empresaId, f]; return total; });
    const avaliar = t.mock.method(autorizacao, 'avaliarPermissaoRecurso', async (_p, ctx, recurso) => { recebido.avaliou = [ctx, recurso]; return { visualizar: podeVerFicha }; });
    return { recebido, avaliar };
  }

  test('com epiFicha.visualizar: o repositório recebe detalheEntrega verdadeiro; a permissão é avaliada pelo recurso epiFicha, da empresa e do usuário da sessão', async (t) => {
    const { recebido } = simular(t, { podeVerFicha: true, total: 3 });
    const r = await servico.listarOperacoes({}, { ...contextoDoUsuario, tipo: 'ENTREGA', origem: 'DIRETA', ...pagina });
    assert.deepEqual(recebido.avaliou, [{ empresaId: EMPRESA, usuarioId: 11, perfil: 'USUARIO' }, 'epiFicha']);
    assert.deepEqual(recebido.lista, [EMPRESA, { tipo: 'ENTREGA', origem: 'DIRETA', de: null, ate: null, busca: null, pagina: 1, limite: 50, detalheEntrega: true }]);
    assert.deepEqual(recebido.conta, [EMPRESA, { tipo: 'ENTREGA', origem: 'DIRETA', de: null, ate: null, busca: null }]);
    assert.deepEqual([r.total, r.pagina, r.limite, r.paginas], [3, 1, 50, 1]);
  });

  test('sem epiFicha.visualizar: o detalhe vai falso e a linha de ENTREGA continua listada', async (t) => {
    const { recebido } = simular(t, { podeVerFicha: false });
    await servico.listarOperacoes({}, { ...contextoDoUsuario, ...pagina });
    assert.equal(recebido.lista[1].detalheEntrega, false);
  });

  test('sem usuário e perfil na chamada, o detalhe é falso e a permissão nem é consultada (falha fechada)', async (t) => {
    const { recebido, avaliar } = simular(t, { podeVerFicha: true });
    await servico.listarOperacoes({}, { empresaId: EMPRESA, ...pagina });
    assert.equal(recebido.lista[1].detalheEntrega, false);
    assert.equal(avaliar.mock.callCount(), 0);
  });

  test('filtro que não pode trazer ENTREGA (ENTRADA, BAIXA, SALDO_INICIAL) não consulta a permissão', async (t) => {
    const { avaliar, recebido } = simular(t, { podeVerFicha: true });
    for (const tipo of ['ENTRADA', 'BAIXA', 'SALDO_INICIAL']) await servico.listarOperacoes({}, { ...contextoDoUsuario, tipo, ...pagina });
    assert.equal(avaliar.mock.callCount(), 0);
    assert.equal(recebido.lista[1].detalheEntrega, false);
  });

  test('tipo BAIXA com origem DIRETA é válido e não é erro: o repositório responde conjunto vazio', async (t) => {
    simular(t, { podeVerFicha: true, linhas: [], total: 0 });
    const r = await servico.listarOperacoes({}, { ...contextoDoUsuario, tipo: 'BAIXA', origem: 'DIRETA', ...pagina });
    assert.deepEqual([r.operacoes, r.total, r.paginas], [[], 0, 0]);
  });

  test('a página e o total vêm das duas consultas; paginas é o teto de total por limite', async (t) => {
    simular(t, { podeVerFicha: false, linhas: [{ operacaoId: '1' }], total: 101 });
    const r = await servico.listarOperacoes({}, { ...contextoDoUsuario, pagina: 1, limite: 50 });
    assert.deepEqual([r.operacoes.length, r.total, r.paginas], [1, 101, 3]);
  });
});

describe('listarLotes — lotes com saldo do material', () => {
  const lote = (extra) => ({ loteId: 1, materialId: MATERIAL_ID, tamanho: '40', fisico: 0, bloqueado: 0, disponivel: 0, ...extra });

  test('material da empresa: devolve os lotes e agrega físico, bloqueado e disponível por tamanho e no total', async (t) => {
    t.mock.method(materialRepo, 'buscarPorId', async () => material());
    const recebido = {};
    t.mock.method(loteRepo, 'listarPorMaterial', async (_p, empresaId, materialId, opcoes) => {
      recebido.args = [empresaId, materialId, opcoes];
      return [
        lote({ loteId: 1, tamanho: '40', fisico: 5, bloqueado: 5, disponivel: 0 }),
        lote({ loteId: 2, tamanho: '40', fisico: 10, bloqueado: 0, disponivel: 10 }),
        lote({ loteId: 3, tamanho: '41', fisico: 4, bloqueado: 0, disponivel: 4 }),
      ];
    });
    const r = await servico.listarLotes({}, { empresaId: EMPRESA, materialId: MATERIAL_ID, hoje: '2026-09-30' });
    assert.deepEqual(recebido.args, [EMPRESA, MATERIAL_ID, { hoje: '2026-09-30', diasAlerta: 60 }]);
    assert.deepEqual(r.material, material());
    assert.deepEqual([r.hoje, r.diasAlerta, r.lotes.length], ['2026-09-30', 60, 3]);
    assert.deepEqual(r.porTamanho, [
      { tamanho: '40', fisico: 15, bloqueado: 5, disponivel: 10 },
      { tamanho: '41', fisico: 4, bloqueado: 0, disponivel: 4 },
    ]);
    assert.deepEqual(r.totais, { fisico: 19, bloqueado: 5, disponivel: 14 });
  });

  test('material de outra empresa ou inexistente: 404 sem consultar lotes', async (t) => {
    t.mock.method(materialRepo, 'buscarPorId', async () => null);
    const lotes = t.mock.method(loteRepo, 'listarPorMaterial', async () => []);
    await assert.rejects(
      () => servico.listarLotes({}, { empresaId: EMPRESA_OUTRA, materialId: MATERIAL_ID, hoje: '2026-09-30' }),
      (erro) => erro instanceof HttpError && erro.status === 404 && erro.codigo === 'MATERIAL_NAO_ENCONTRADO',
    );
    assert.equal(lotes.mock.callCount(), 0);
  });

  test('data operacional inválida é recusada antes de consultar', async (t) => {
    const busca = t.mock.method(materialRepo, 'buscarPorId', async () => material());
    await assert.rejects(() => servico.listarLotes({}, { empresaId: EMPRESA, materialId: MATERIAL_ID, hoje: '2026/09/30' }), /data operacional/i);
    assert.equal(busca.mock.callCount(), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Entrada e baixa por lote
// ═══════════════════════════════════════════════════════════════════
const HOJE = '2026-09-30';
const CHAVE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const LOTE_ID = 500;
const CRIADO_EM = new Date('2026-09-30T15:00:00Z');

const lotePublico = (extra = {}) => ({
  loteId: LOTE_ID, materialId: MATERIAL_ID, tamanho: '40', caNumero: '12345', caValidade: '2027-06-30', origem: 'ENTRADA',
  quantidadeEntrada: 10, quantidadeBaixada: 0, quantidadeEntregue: 0, saldo: 10, ...extra,
});
const operacaoPublica = (extra = {}) => ({
  id: '900', tipo: 'ENTRADA', loteId: LOTE_ID, quantidade: 10, motivo: null, justificativa: null, usuarioId: ATOR_ID, criadoEm: CRIADO_EM, ...extra,
});

// Posição do par (12C-3): U físico utilizável, D demanda pendente; C, L e G derivam deles.
const posicaoDoPar = (U, D, extra = {}) => ({
  materialId: MATERIAL_ID, tamanho: '40', fisicoUtilizavel: U, demandaPendente: D, comprometido: Math.min(U, D), saldoLivre: Math.max(0, U - D), semCobertura: Math.max(0, D - U), ...extra,
});

function mundoDeLotes(t, {
  materialExistente = material(), existente = null, lote = lotePublico(), loteDepois = null, antes = posicaoDoPar(10, 0), depois = posicaoDoPar(6, 0),
} = {}) {
  const ordem = [];
  let leituras = 0;
  let posicoesLidas = 0;
  t.mock.method(materialRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => {
    ordem.push('material');
    return empresaId === EMPRESA && materialExistente && id === materialExistente.id ? materialExistente : null;
  });
  t.mock.method(operacaoRepo, 'travarChave', async () => { ordem.push('trava'); });
  t.mock.method(operacaoRepo, 'buscarPorChave', async () => { ordem.push('chave'); return existente; });
  t.mock.method(operacaoRepo, 'buscarLoteParaBaixa', async (_c, empresaId, id) => {
    ordem.push('lote');
    return empresaId === EMPRESA && lote && id === lote.loteId ? lote : null;
  });
  // A primeira leitura do lote (sem trava) e a repetição da chave devolvem o lote; a releitura depois da baixa devolve loteDepois.
  t.mock.method(operacaoRepo, 'buscarLote', async (_c, empresaId, id) => {
    ordem.push('releitura');
    leituras += 1;
    if (!(empresaId === EMPRESA && lote && id === lote.loteId)) return null;
    return leituras > 1 ? loteDepois ?? lote : lote;
  });
  t.mock.method(materialRepo, 'listarPorIdsParaVinculo', async (_c, empresaId, ids) => {
    ordem.push('material-baixa');
    return [{ id: ids[0], empresaId, ativo: materialExistente?.ativo ?? true, exigeCa: true }];
  });
  t.mock.method(parRepo, 'travarPares', async (_c, _empresaId, pares) => { ordem.push('par'); return pares; });
  t.mock.method(entregaRepo, 'dataOperacionalDaTransacao', async () => HOJE);
  t.mock.method(coberturaRepo, 'lerPosicoes', async (_c, _empresaId, pares) => {
    ordem.push('posicao');
    const lida = posicoesLidas === 0 ? antes : depois;
    posicoesLidas += 1;
    return [{ ...lida, materialId: pares[0].materialId, tamanho: pares[0].tamanho }];
  });
  return {
    ordem,
    entrada: t.mock.method(operacaoRepo, 'registrarEntrada', async (_c, d) => {
      ordem.push('entrada');
      return {
        operacao: operacaoPublica({ quantidade: d.quantidade }),
        lote: lotePublico({ tamanho: d.tamanho, caNumero: d.caNumero, caValidade: d.caValidade, quantidadeEntrada: d.quantidade, saldo: d.quantidade }),
      };
    }),
    baixa: t.mock.method(operacaoRepo, 'registrarBaixa', async (_c, d) => {
      ordem.push('baixa');
      return operacaoPublica({ tipo: 'BAIXA', quantidade: d.quantidade, motivo: d.motivo, justificativa: d.justificativa });
    }),
    registrar: t.mock.method(auditoriaRepo, 'registrar', async () => { ordem.push('auditoria'); return { id: '1', criadoEm: new Date() }; }),
  };
}

const dadosEntrada = (extra = {}) => ({
  empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', quantidade: 10,
  caNumero: '12345', caValidade: '2027-06-30', chaveIdempotencia: CHAVE, hoje: HOJE, ip: '10.0.0.1', dispositivo: 'Navegador', ...extra,
});
const dadosBaixa = (extra = {}) => ({
  empresaId: EMPRESA, atorId: ATOR_ID, loteId: LOTE_ID, quantidade: 4, motivo: 'AVARIA', justificativa: null,
  chaveIdempotencia: CHAVE, ip: '10.0.0.1', dispositivo: 'Navegador', ...extra,
});

async function esperarValidacao(promessa, campo, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.deepEqual([erro.status, erro.codigo], [400, 'VALIDACAO']);
    assert.deepEqual(erro.detalhes.map((d) => [d.campo, d.codigo]), [[campo, codigo]]);
    return true;
  });
}

function assertSemEscrita(cliente, mundo) {
  assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  assert.equal(mundo.entrada.mock.callCount() + mundo.baixa.mock.callCount() + mundo.registrar.mock.callCount(), 0, 'nada gravado, nada auditado');
  assert.ok(cliente.chamadas.includes('RELEASE'));
}

// O hash é interno; descubro o da requisição fazendo a entrada uma vez.
async function hashDaEntrada(t, extra = {}) {
  const mundo = mundoDeLotes(t);
  await servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada(extra));
  const hash = mundo.entrada.mock.calls.at(-1).arguments[1].requisicaoHash;
  t.mock.restoreAll();
  return hash;
}

async function hashDaBaixa(t, extra = {}) {
  const mundo = mundoDeLotes(t);
  await servico.registrarBaixa(criarPoolFalso(criarClienteFalso()), dadosBaixa(extra));
  const hash = mundo.baixa.mock.calls.at(-1).arguments[1].requisicaoHash;
  t.mock.restoreAll();
  return hash;
}

describe('registrarEntrada — lote novo com CA obrigatório', () => {
  test('trava a chave, consulta a chave, trava o material, cria lote e operação, audita e commita', async (t) => {
    const mundo = mundoDeLotes(t);
    const cliente = criarClienteFalso();
    const r = await servico.registrarEntrada(criarPoolFalso(cliente), dadosEntrada());

    assert.deepEqual(mundo.ordem, ['trava', 'chave', 'material', 'entrada', 'auditoria']);
    assert.deepEqual(cliente.chamadas.filter((c) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(c)), ['BEGIN', 'COMMIT']);

    const gravado = mundo.entrada.mock.calls[0].arguments[1];
    assert.match(gravado.requisicaoHash, /^[0-9a-f]{64}$/);
    assert.deepEqual({ ...gravado, requisicaoHash: undefined }, {
      empresaId: EMPRESA, materialId: MATERIAL_ID, usuarioId: ATOR_ID, tamanho: '40', quantidade: 10,
      caNumero: '12345', caValidade: '2027-06-30', chave: CHAVE, requisicaoHash: undefined,
    });

    const auditoria = mundo.registrar.mock.calls[0].arguments[1];
    assert.deepEqual(auditoria, {
      empresaId: EMPRESA, usuarioId: ATOR_ID, acao: 'ESTOQUE_ENTRADA', referencia: String(LOTE_ID), ip: '10.0.0.1', dispositivo: 'Navegador',
      contexto: { operacaoId: '900', materialId: MATERIAL_ID, loteId: LOTE_ID, tamanho: '40', caNumero: '12345', caValidade: '2027-06-30', quantidade: 10 },
      dadosNovos: { saldo: 10 },
    });

    assert.equal(r.repetida, false);
    assert.deepEqual(r.operacao, operacaoPublica());
    assert.equal(r.lote.saldo, 10);
  });

  test('CA que vence hoje ou amanhã é aceito; a janela de 60 dias não bloqueia entrada', async (t) => {
    for (const caValidade of [HOJE, '2026-10-01', '2026-11-15']) {
      const mundo = mundoDeLotes(t);
      const r = await servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada({ caValidade }));
      assert.equal(r.lote.caValidade, caValidade);
      assert.equal(mundo.entrada.mock.callCount(), 1);
      t.mock.restoreAll();
    }
  });

  test('CA vencido ontem: 400 VALIDACAO com CA_VENCIDO, ROLLBACK, nada gravado', async (t) => {
    const mundo = mundoDeLotes(t);
    const cliente = criarClienteFalso();
    await esperarValidacao(
      servico.registrarEntrada(criarPoolFalso(cliente), dadosEntrada({ caValidade: '2026-09-29' })),
      'body.caValidade', 'CA_VENCIDO',
    );
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
    assertSemEscrita(cliente, mundo);
  });

  test('material inexistente ou de outra empresa: 404; inativo: 409; nada gravado', async (t) => {
    for (const [dados, mundoInicial, status, codigo] of [
      [dadosEntrada({ materialId: 31 }), {}, 404, 'MATERIAL_NAO_ENCONTRADO'],
      [dadosEntrada({ empresaId: EMPRESA_OUTRA }), {}, 404, 'MATERIAL_NAO_ENCONTRADO'],
      [dadosEntrada(), { materialExistente: material({ ativo: false }) }, 409, 'MATERIAL_INATIVO'],
    ]) {
      const mundo = mundoDeLotes(t, mundoInicial);
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.registrarEntrada(criarPoolFalso(cliente), dados), status, codigo);
      assertSemEscrita(cliente, mundo);
      t.mock.restoreAll();
    }
  });

  test('o CA é exigido mesmo quando o material dispensa CA; nenhum campo do material libera a entrada sem CA', async (t) => {
    const mundo = mundoDeLotes(t, { materialExistente: material({ exigeCa: false }) });
    await servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada());
    assert.equal(mundo.entrada.mock.calls[0].arguments[1].caNumero, '12345');
    t.mock.restoreAll();

    for (const [campo, extra, codigo] of [
      ['body.caNumero', { caNumero: null }, 'CA_NUMERO_INVALIDO'],
      ['body.caNumero', { caNumero: '   ' }, 'CA_NUMERO_INVALIDO'],
      ['body.caValidade', { caValidade: null }, 'CA_VALIDADE_INVALIDA'],
      ['body.caValidade', { caValidade: '2026-02-30' }, 'CA_VALIDADE_INVALIDA'],
    ]) {
      const semCa = mundoDeLotes(t, { materialExistente: material({ exigeCa: false }) });
      const cliente = criarClienteFalso();
      await esperarValidacao(servico.registrarEntrada(criarPoolFalso(cliente), dadosEntrada(extra)), campo, codigo);
      assert.equal(cliente.chamadas.length, 0, 'recusado antes de abrir transação');
      assert.equal(semCa.ordem.length, 0);
      t.mock.restoreAll();
    }
  });

  test('tamanho, quantidade e chave inválidos: 400 antes de abrir transação', async (t) => {
    mundoDeLotes(t);
    for (const [campo, extra, codigo] of [
      ['body.tamanho', { tamanho: '   ' }, 'TAMANHO_INVALIDO'],
      ['body.tamanho', { tamanho: 'x'.repeat(21) }, 'TAMANHO_INVALIDO'],
      ['body.quantidade', { quantidade: 0 }, 'QUANTIDADE_INVALIDA'],
      ['body.quantidade', { quantidade: -2 }, 'QUANTIDADE_INVALIDA'],
      ['body.quantidade', { quantidade: 1.5 }, 'QUANTIDADE_INVALIDA'],
      ['body.chaveIdempotencia', { chaveIdempotencia: 'abc' }, 'FORMATO_INVALIDO'],
    ]) {
      const cliente = criarClienteFalso();
      await esperarValidacao(servico.registrarEntrada(criarPoolFalso(cliente), dadosEntrada(extra)), campo, codigo);
      assert.equal(cliente.chamadas.length, 0);
    }
  });

  test('identificadores e data operacional inválidos: TypeError antes de abrir transação', async (t) => {
    mundoDeLotes(t);
    for (const [extra, padrao] of [
      [{ empresaId: 0 }, /empresa/i], [{ atorId: null }, /ator/i], [{ materialId: '30' }, /material/i], [{ hoje: '30/09/2026' }, /data operacional/i],
    ]) {
      const cliente = criarClienteFalso();
      await assert.rejects(() => servico.registrarEntrada(criarPoolFalso(cliente), dadosEntrada(extra)), padrao);
      assert.equal(cliente.chamadas.length, 0);
    }
  });

  test('ip e dispositivo cabem nas colunas da auditoria', async (t) => {
    const mundo = mundoDeLotes(t);
    await servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada({ ip: '1'.repeat(60), dispositivo: 'x'.repeat(400) }));
    const { ip, dispositivo } = mundo.registrar.mock.calls[0].arguments[1];
    assert.deepEqual([ip.length, dispositivo.length], [45, 150]);
  });
});

describe('registrarEntrada — idempotência', () => {
  test('mesma chave e mesma requisição: devolve a entrada original, sem travar material, sem gravar, sem auditar', async (t) => {
    const hash = await hashDaEntrada(t);
    const mundo = mundoDeLotes(t, { existente: { ...operacaoPublica(), requisicaoHash: hash }, lote: lotePublico({ saldo: 7, quantidadeBaixada: 3 }) });
    const cliente = criarClienteFalso();
    const r = await servico.registrarEntrada(criarPoolFalso(cliente), dadosEntrada());
    assert.deepEqual(mundo.ordem, ['trava', 'chave', 'releitura']);
    assert.deepEqual(r, { repetida: true, operacao: operacaoPublica(), lote: lotePublico({ saldo: 7, quantidadeBaixada: 3 }) });
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
    assert.equal(mundo.entrada.mock.callCount() + mundo.registrar.mock.callCount(), 0);
  });

  test('a repetição devolve a original mesmo depois de o material ser inativado ou de o CA vencer', async (t) => {
    const hash = await hashDaEntrada(t, { caValidade: HOJE });
    const mundo = mundoDeLotes(t, { existente: { ...operacaoPublica(), requisicaoHash: hash }, materialExistente: material({ ativo: false }) });
    const r = await servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada({ caValidade: HOJE, hoje: '2026-10-01' }));
    assert.equal(r.repetida, true);
    assert.deepEqual(mundo.ordem, ['trava', 'chave', 'releitura']);
  });

  test('mesma chave com outra requisição: 409 IDEMPOTENCIA_CONFLITO, ROLLBACK, nada gravado', async (t) => {
    const hash = await hashDaEntrada(t);
    for (const extra of [{ quantidade: 11 }, { tamanho: '41' }, { caNumero: '54321' }, { caValidade: '2027-07-01' }, { materialId: 31 }]) {
      const mundo = mundoDeLotes(t, { existente: { ...operacaoPublica(), requisicaoHash: hash } });
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.registrarEntrada(criarPoolFalso(cliente), dadosEntrada(extra)), 409, 'IDEMPOTENCIA_CONFLITO');
      assertSemEscrita(cliente, mundo);
      t.mock.restoreAll();
    }
  });

  test('o hash é da requisição lógica: não depende da chave, do ip nem do dispositivo; muda com cada campo da entrada', async (t) => {
    const base = await hashDaEntrada(t);
    assert.equal(await hashDaEntrada(t, { chaveIdempotencia: '0f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c', ip: null, dispositivo: 'outro' }), base);
    const variacoes = [];
    for (const extra of [{ quantidade: 11 }, { tamanho: '41' }, { caNumero: '54321' }, { caValidade: '2027-07-01' }]) {
      variacoes.push(await hashDaEntrada(t, extra));
    }
    assert.equal(new Set([base, ...variacoes]).size, 5);
  });

  test('chave usada numa baixa não serve para uma entrada', async (t) => {
    const hashBaixa = await hashDaBaixa(t);
    const mundo = mundoDeLotes(t, { existente: { ...operacaoPublica({ tipo: 'BAIXA' }), requisicaoHash: hashBaixa } });
    await esperarHttpError(servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada()), 409, 'IDEMPOTENCIA_CONFLITO');
    assert.equal(mundo.entrada.mock.callCount(), 0);
  });
});

describe('registrarBaixa — baixa manual por lote', () => {
  test('trava a chave; lê o lote sem trava; trava o material, o par e o lote; mede a posição, grava a BAIXA, mede de novo, relê o lote, audita e commita', async (t) => {
    const mundo = mundoDeLotes(t, { loteDepois: lotePublico({ quantidadeBaixada: 4, saldo: 6 }) });
    const cliente = criarClienteFalso();
    const r = await servico.registrarBaixa(criarPoolFalso(cliente), dadosBaixa());

    assert.deepEqual(mundo.ordem, ['trava', 'chave', 'releitura', 'material-baixa', 'par', 'lote', 'posicao', 'baixa', 'posicao', 'releitura', 'auditoria']);
    assert.deepEqual(cliente.chamadas.filter((c) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(c)), ['BEGIN', 'COMMIT']);

    const gravado = mundo.baixa.mock.calls[0].arguments[1];
    assert.match(gravado.requisicaoHash, /^[0-9a-f]{64}$/);
    assert.deepEqual({ ...gravado, requisicaoHash: undefined }, {
      empresaId: EMPRESA, loteId: LOTE_ID, usuarioId: ATOR_ID, quantidade: 4, motivo: 'AVARIA', justificativa: null, chave: CHAVE, requisicaoHash: undefined,
    });

    assert.deepEqual(mundo.registrar.mock.calls[0].arguments[1], {
      empresaId: EMPRESA, usuarioId: ATOR_ID, acao: 'ESTOQUE_BAIXA', referencia: String(LOTE_ID), ip: '10.0.0.1', dispositivo: 'Navegador',
      contexto: {
        operacaoId: '900',
        materialId: MATERIAL_ID,
        loteId: LOTE_ID,
        tamanho: '40',
        caNumero: '12345',
        quantidade: 4,
        motivo: 'AVARIA',
        justificativa: null,
        posicaoAntes: { fisicoUtilizavel: 10, demandaPendente: 0, comprometido: 0, saldoLivre: 10, semCobertura: 0 },
        posicaoDepois: { fisicoUtilizavel: 6, demandaPendente: 0, comprometido: 0, saldoLivre: 6, semCobertura: 0 },
        reduziuCobertura: false,
      },
      dadosAnteriores: { saldo: 10 },
      dadosNovos: { saldo: 6 },
    });
    assert.equal(r.repetida, false);
    assert.equal(r.operacao.tipo, 'BAIXA');
    assert.equal(r.lote.saldo, 6);
  });

  test('material inativo e lote legado sem CA também recebem baixa: o material é só travado (FOR SHARE), nunca recusado', async (t) => {
    const mundo = mundoDeLotes(t, {
      materialExistente: material({ ativo: false }),
      lote: lotePublico({ origem: 'SALDO_INICIAL', caNumero: null, caValidade: null }),
      antes: posicaoDoPar(0, 0),
      depois: posicaoDoPar(0, 0),
    });
    const r = await servico.registrarBaixa(criarPoolFalso(criarClienteFalso()), dadosBaixa({ motivo: 'DESCARTE' }));
    assert.equal(r.repetida, false);
    assert.equal(mundo.ordem.includes('material-baixa'), true);
    assert.equal(mundo.ordem.includes('material'), false, 'não é a trava de escrita da entrada');
    assert.equal(mundo.registrar.mock.calls[0].arguments[1].contexto.caNumero, null);
  });

  test('baixa igual ao saldo zera o lote; acima do saldo é 409 SALDO_LOTE_INSUFICIENTE sem gravar', async (t) => {
    const zerou = mundoDeLotes(t);
    await servico.registrarBaixa(criarPoolFalso(criarClienteFalso()), dadosBaixa({ quantidade: 10 }));
    assert.equal(zerou.baixa.mock.callCount(), 1);
    t.mock.restoreAll();

    const mundo = mundoDeLotes(t);
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.registrarBaixa(criarPoolFalso(cliente), dadosBaixa({ quantidade: 11 })), 409, 'SALDO_LOTE_INSUFICIENTE');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
    assertSemEscrita(cliente, mundo);
  });

  test('lote inexistente ou de outra empresa: 404 LOTE_NAO_ENCONTRADO sem gravar', async (t) => {
    for (const dados of [dadosBaixa({ loteId: 501 }), dadosBaixa({ empresaId: EMPRESA_OUTRA })]) {
      const mundo = mundoDeLotes(t);
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.registrarBaixa(criarPoolFalso(cliente), dados), 404, 'LOTE_NAO_ENCONTRADO');
      assertSemEscrita(cliente, mundo);
      t.mock.restoreAll();
    }
  });

  test('os sete motivos são aceitos; OUTRO exige justificativa; motivo fora da lista é recusado', async (t) => {
    for (const motivo of ['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO', 'DEVOLUCAO_FORNECEDOR']) {
      const mundo = mundoDeLotes(t);
      await servico.registrarBaixa(criarPoolFalso(criarClienteFalso()), dadosBaixa({ motivo }));
      assert.equal(mundo.baixa.mock.calls[0].arguments[1].motivo, motivo);
      t.mock.restoreAll();
    }
    const outro = mundoDeLotes(t);
    await servico.registrarBaixa(criarPoolFalso(criarClienteFalso()), dadosBaixa({ motivo: 'OUTRO', justificativa: '  Doação  ' }));
    assert.equal(outro.baixa.mock.calls[0].arguments[1].justificativa, 'Doação');
    t.mock.restoreAll();

    mundoDeLotes(t);
    for (const [extra, campo, codigo] of [
      [{ motivo: 'OUTRO', justificativa: null }, 'body.justificativa', 'JUSTIFICATIVA_OBRIGATORIA'],
      [{ motivo: 'OUTRO', justificativa: '   ' }, 'body.justificativa', 'JUSTIFICATIVA_INVALIDA'],
      [{ justificativa: 'x'.repeat(501) }, 'body.justificativa', 'JUSTIFICATIVA_INVALIDA'],
      [{ motivo: 'ROUBO' }, 'body.motivo', 'VALOR_NAO_PERMITIDO'],
      [{ quantidade: 0 }, 'body.quantidade', 'QUANTIDADE_INVALIDA'],
      [{ chaveIdempotencia: 'abc' }, 'body.chaveIdempotencia', 'FORMATO_INVALIDO'],
    ]) {
      const cliente = criarClienteFalso();
      await esperarValidacao(servico.registrarBaixa(criarPoolFalso(cliente), dadosBaixa(extra)), campo, codigo);
      assert.equal(cliente.chamadas.length, 0);
    }
  });

  test('identificadores inválidos: TypeError antes de abrir transação', async (t) => {
    mundoDeLotes(t);
    for (const [extra, padrao] of [[{ empresaId: -1 }, /empresa/i], [{ atorId: 0 }, /ator/i], [{ loteId: 'x' }, /lote/i]]) {
      const cliente = criarClienteFalso();
      await assert.rejects(() => servico.registrarBaixa(criarPoolFalso(cliente), dadosBaixa(extra)), padrao);
      assert.equal(cliente.chamadas.length, 0);
    }
  });
});

describe('registrarBaixa — idempotência', () => {
  test('mesma chave e mesma baixa: devolve a original, sem travar o lote, sem gravar, sem auditar', async (t) => {
    const hash = await hashDaBaixa(t);
    const original = operacaoPublica({ tipo: 'BAIXA', quantidade: 4, motivo: 'AVARIA' });
    const mundo = mundoDeLotes(t, { existente: { ...original, requisicaoHash: hash }, lote: lotePublico({ saldo: 6, quantidadeBaixada: 4 }) });
    const r = await servico.registrarBaixa(criarPoolFalso(criarClienteFalso()), dadosBaixa());
    assert.deepEqual(mundo.ordem, ['trava', 'chave', 'releitura']);
    assert.deepEqual(r, { repetida: true, operacao: original, lote: lotePublico({ saldo: 6, quantidadeBaixada: 4 }) });
    assert.equal(mundo.baixa.mock.callCount() + mundo.registrar.mock.callCount(), 0);
  });

  test('mesma chave com outra baixa: 409 IDEMPOTENCIA_CONFLITO', async (t) => {
    const hash = await hashDaBaixa(t, { motivo: 'OUTRO', justificativa: 'Doação' });
    for (const extra of [
      { motivo: 'OUTRO', justificativa: 'Doação', quantidade: 5 },
      { motivo: 'OUTRO', justificativa: 'Doação', loteId: 501 },
      { motivo: 'OUTRO', justificativa: 'Treinamento' },
      { motivo: 'PERDA', justificativa: 'Doação' },
    ]) {
      const mundo = mundoDeLotes(t, { existente: { ...operacaoPublica({ tipo: 'BAIXA' }), requisicaoHash: hash } });
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.registrarBaixa(criarPoolFalso(cliente), dadosBaixa(extra)), 409, 'IDEMPOTENCIA_CONFLITO');
      assertSemEscrita(cliente, mundo);
      t.mock.restoreAll();
    }
  });

  test('a justificativa entra aparada no hash: espaços nas pontas não mudam a baixa', async (t) => {
    const aparada = await hashDaBaixa(t, { motivo: 'OUTRO', justificativa: 'Doação' });
    assert.equal(await hashDaBaixa(t, { motivo: 'OUTRO', justificativa: '  Doação ' }), aparada);
    assert.notEqual(await hashDaBaixa(t, { justificativa: null }), await hashDaBaixa(t, { justificativa: 'Doação' }));
  });
});

describe('registrarEntrada — tamanho conforme o material', () => {
  test('material que exige tamanho e entrada sem tamanho: 400 TAMANHO_OBRIGATORIO, ROLLBACK, nada gravado', async (t) => {
    for (const tamanho of [null, undefined]) {
      const mundo = mundoDeLotes(t);
      const cliente = criarClienteFalso();
      await esperarValidacao(servico.registrarEntrada(criarPoolFalso(cliente), dadosEntrada({ tamanho })), 'body.tamanho', 'TAMANHO_OBRIGATORIO');
      assert.deepEqual(mundo.ordem, ['trava', 'chave', 'material']);
      assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
      assertSemEscrita(cliente, mundo);
      t.mock.restoreAll();
    }
  });

  test('material sem tamanho e entrada sem tamanho: lote com tamanho null, auditado como null', async (t) => {
    const mundo = mundoDeLotes(t, { materialExistente: material({ exigeTamanho: false }) });
    const r = await servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada({ tamanho: null }));
    assert.equal(mundo.entrada.mock.calls[0].arguments[1].tamanho, null);
    assert.equal(mundo.registrar.mock.calls[0].arguments[1].contexto.tamanho, null);
    assert.equal(r.lote.tamanho, null);
  });

  test('material sem tamanho e entrada com tamanho: 400 TAMANHO_NAO_SE_APLICA, nada gravado', async (t) => {
    const mundo = mundoDeLotes(t, { materialExistente: material({ exigeTamanho: false }) });
    const cliente = criarClienteFalso();
    await esperarValidacao(servico.registrarEntrada(criarPoolFalso(cliente), dadosEntrada({ tamanho: 'Único' })), 'body.tamanho', 'TAMANHO_NAO_SE_APLICA');
    assertSemEscrita(cliente, mundo);
  });

  test('material não classificado: 409 MATERIAL_TAMANHO_NAO_CLASSIFICADO, com ou sem tamanho', async (t) => {
    for (const tamanho of [null, '40']) {
      const mundo = mundoDeLotes(t, { materialExistente: material({ exigeTamanho: null }) });
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.registrarEntrada(criarPoolFalso(cliente), dadosEntrada({ tamanho })), 409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO');
      assertSemEscrita(cliente, mundo);
      t.mock.restoreAll();
    }
  });

  test('sem tamanho, CA e validade continuam obrigatórios', async (t) => {
    mundoDeLotes(t, { materialExistente: material({ exigeTamanho: false }) });
    await esperarValidacao(servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada({ tamanho: null, caNumero: null })), 'body.caNumero', 'CA_NUMERO_INVALIDO');
    await esperarValidacao(servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada({ tamanho: null, caValidade: null })), 'body.caValidade', 'CA_VALIDADE_INVALIDA');
  });

  test('idempotência sem tamanho: ausente e null são a mesma requisição, e diferem de uma com tamanho', async (t) => {
    const hashDe = async (extra) => {
      const mundo = mundoDeLotes(t, { materialExistente: material({ exigeTamanho: false }) });
      await servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada(extra));
      const hash = mundo.entrada.mock.calls[0].arguments[1].requisicaoHash;
      t.mock.restoreAll();
      return hash;
    };
    const semTamanho = await hashDe({ tamanho: null });
    assert.equal(await hashDe({ tamanho: undefined }), semTamanho);
    assert.notEqual(await hashDaEntrada(t, { tamanho: '40' }), semTamanho);

    const mundo = mundoDeLotes(t, { materialExistente: material({ exigeTamanho: false }), existente: { ...operacaoPublica(), requisicaoHash: semTamanho } });
    const r = await servico.registrarEntrada(criarPoolFalso(criarClienteFalso()), dadosEntrada({ tamanho: null }));
    assert.equal(r.repetida, true);
    assert.equal(mundo.entrada.mock.callCount(), 0);
  });
});
