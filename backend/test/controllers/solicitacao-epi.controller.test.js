'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Controller das consultas HTTP da solicitação de EPI (12F-1): fino. Empresa,
 * usuário e perfil saem só da sessão (req.empresa / req.usuario); a query e os
 * params chegam já validados em req.validado; a data operacional vem do relógio
 * injetado. Nada é recalculado aqui: o corpo é o que o serviço devolveu.
 */

const consulta = require('../../src/services/solicitacao-epi-consulta.service');

const controller = (opcoes = {}) => exigirModulo('src/controllers/solicitacao-epi.controller').criarSolicitacaoEpiController({ pool: { marca: 'pool' }, ...opcoes });
const respostaFalsa = () => ({ statusCode: 0, corpo: null, status(c) { this.statusCode = c; return this; }, json(b) { this.corpo = b; return this; } });
const RELOGIO = () => new Date('2026-10-04T02:30:00Z');
const requisicao = (validado, extra = {}) => ({
  empresa: { id: 3 }, usuario: { id: 9, perfil: 'USUARIO' }, query: { empresaId: '999', usuarioId: '998' }, params: {}, body: { empresaId: 997 }, validado, ...extra,
});
const pagina = { solicitacoes: [{ id: 1 }], total: 1, pagina: 2, limite: 10 };

describe('solicitacao-epi.controller', () => {
  test('minhas: empresa e ator da sessão, status e paginação validados, data operacional do relógio; 200 com o resultado do serviço', async (t) => {
    const chamadas = [];
    t.mock.method(consulta, 'listarMinhas', async (pool, dados) => { chamadas.push([pool, dados]); return pagina; });
    const res = respostaFalsa();
    await controller({ relogio: RELOGIO }).minhas(requisicao({ query: { status: 'ENCERRADA', pagina: 2, limite: 10 } }), res);
    assert.deepEqual(chamadas, [[{ marca: 'pool' }, {
      empresaId: 3, atorId: 9, status: 'ENCERRADA', pagina: 2, limite: 10, hoje: '2026-10-03',
    }]]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', ...pagina }]);
  });

  test('minhas sem status: o serviço recebe null', async (t) => {
    const chamadas = [];
    t.mock.method(consulta, 'listarMinhas', async (_pool, dados) => { chamadas.push(dados); return pagina; });
    await controller({ relogio: RELOGIO }).minhas(requisicao({ query: { pagina: 1, limite: 20 } }), respostaFalsa());
    assert.equal(chamadas[0].status, null);
  });

  test('fila: só a empresa da sessão e a paginação', async (t) => {
    const chamadas = [];
    t.mock.method(consulta, 'listarFila', async (_pool, dados) => { chamadas.push(dados); return pagina; });
    const res = respostaFalsa();
    await controller({ relogio: RELOGIO }).fila(requisicao({ query: { pagina: 2, limite: 10 } }), res);
    assert.deepEqual(chamadas, [{ empresaId: 3, pagina: 2, limite: 10 }]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', ...pagina }]);
  });

  test('entregáveis: empresa da sessão, trabalhador opcional (null sem filtro), paginação e data operacional', async (t) => {
    const chamadas = [];
    t.mock.method(consulta, 'listarEntregaveis', async (_pool, dados) => { chamadas.push(dados); return pagina; });
    const c = controller({ relogio: RELOGIO });
    await c.entregaveis(requisicao({ query: { funcionarioId: 42, pagina: 1, limite: 20 } }), respostaFalsa());
    await c.entregaveis(requisicao({ query: { pagina: 1, limite: 20 } }), respostaFalsa());
    assert.deepEqual(chamadas, [
      { empresaId: 3, funcionarioId: 42, pagina: 1, limite: 20, hoje: '2026-10-03' },
      { empresaId: 3, funcionarioId: null, pagina: 1, limite: 20, hoje: '2026-10-03' },
    ]);
  });

  test('detalhe: empresa, usuário e perfil da sessão e o id validado; o corpo é o detalhe do serviço', async (t) => {
    assert.equal(typeof consulta.buscarDetalhe, 'function', 'função ainda não implementada: buscarDetalhe (serviço)');
    const chamadas = [];
    const detalhe = { solicitacao: { id: 17 }, itens: [] };
    t.mock.method(consulta, 'buscarDetalhe', async (_pool, dados) => { chamadas.push(dados); return detalhe; });
    const res = respostaFalsa();
    await controller({ relogio: RELOGIO }).detalhe(requisicao({ params: { id: 17 }, query: {} }, { params: { id: '999' } }), res);
    assert.deepEqual(chamadas, [{
      empresaId: 3, usuarioId: 9, perfil: 'USUARIO', solicitacaoId: 17, hoje: '2026-10-03',
    }]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', ...detalhe }]);
  });

  test('o erro do serviço sobe sem tratamento local (o errorHandler responde)', async (t) => {
    const erro = new Error('falha do serviço');
    t.mock.method(consulta, 'listarFila', async () => { throw erro; });
    await assert.rejects(controller().fila(requisicao({ query: { pagina: 1, limite: 20 } }), respostaFalsa()), erro);
  });
});

// ── Escrita (12F-2) ─────────────────────────────────────────────────

const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const entregaSolicitacaoSvc = require('../../src/services/entrega-solicitacao.service');

describe('solicitacao-epi.controller — escrita (12F-2)', () => {
  // A requisição traz empresa e ator só na sessão; corpo, query e params brutos com valores estranhos nunca são lidos.
  const escrita = (validado) => requisicao(validado, {
    ip: '203.0.113.7', headers: { 'user-agent': 'Navegador de teste' }, body: { empresaId: 997, solicitanteUsuarioId: 996, atorId: 995 }, params: { id: '999' },
  });
  const itemDoServico = (extra = {}) => ({
    id: 31, materialId: 7, quantidade: 2, situacao: null, cobertura: { coberta: 2 }, posicao: { saldoLivre: 1 }, ...extra,
  });
  const visao = (status = 'PENDENTE') => ({ solicitacao: { id: 17, status }, itens: [itemDoServico()] });
  const semEstoque = ({ cobertura, posicao, ...item }) => item;

  test('criar: empresa e solicitante da sessão, corpo validado, IP e dispositivo; 201 com a visão do solicitante (sem números de estoque)', async (t) => {
    const chamadas = [];
    t.mock.method(solicitacaoSvc, 'criarSolicitacao', async (pool, dados) => { chamadas.push([pool, dados]); return { repetida: false, ...visao() }; });
    const res = respostaFalsa();
    const corpo = { funcionarioId: 5, itens: [{ materialId: 7, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO' }], observacao: 'Turno', chaveIdempotencia: 'c' };
    await controller({ relogio: RELOGIO }).criar(escrita({ body: corpo }), res);
    assert.deepEqual(chamadas, [[{ marca: 'pool' }, {
      empresaId: 3, atorId: 9, funcionarioId: 5, itens: corpo.itens, observacao: 'Turno', chaveIdempotencia: 'c', ip: '203.0.113.7', dispositivo: 'Navegador de teste',
    }]]);
    assert.deepEqual([res.statusCode, res.corpo], [201, { status: 'ok', repetida: false, solicitacao: { id: 17, status: 'PENDENTE' }, itens: [semEstoque(itemDoServico())] }]);
  });

  test('criar: sem observação o serviço recebe null; a repetição da chave responde 200 e continua sem números de estoque', async (t) => {
    const chamadas = [];
    t.mock.method(solicitacaoSvc, 'criarSolicitacao', async (_pool, dados) => { chamadas.push(dados); return { repetida: true, ...visao('APROVADA') }; });
    const res = respostaFalsa();
    await controller().criar(escrita({ body: { funcionarioId: 5, itens: [], chaveIdempotencia: 'c' } }), res);
    assert.equal(chamadas[0].observacao, null);
    assert.equal(res.statusCode, 200);
    assert.equal(res.corpo.repetida, true);
    assert.ok(res.corpo.itens.every((i) => !('cobertura' in i) && !('posicao' in i)), 'quem só pede não vê cobertura nem posição');
  });

  test('cancelar: empresa e ator da sessão, id validado, justificativa opcional (null sem ela), data do relógio; 200 sem números de estoque', async (t) => {
    const chamadas = [];
    t.mock.method(solicitacaoSvc, 'cancelarSolicitacao', async (_pool, dados) => { chamadas.push(dados); return visao('CANCELADA'); });
    const c = controller({ relogio: RELOGIO });
    const res = respostaFalsa();
    await c.cancelar(escrita({ params: { id: 17 }, body: { justificativa: 'Duplicada' } }), res);
    await c.cancelar(escrita({ params: { id: 17 }, body: {} }), respostaFalsa());
    assert.deepEqual(chamadas, [
      { empresaId: 3, atorId: 9, solicitacaoId: 17, justificativa: 'Duplicada', hoje: '2026-10-03', ip: '203.0.113.7', dispositivo: 'Navegador de teste' },
      { empresaId: 3, atorId: 9, solicitacaoId: 17, justificativa: null, hoje: '2026-10-03', ip: '203.0.113.7', dispositivo: 'Navegador de teste' },
    ]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', solicitacao: { id: 17, status: 'CANCELADA' }, itens: [semEstoque(itemDoServico())] }]);
  });

  test('decidir: empresa e decisor da sessão, decisões validadas, data do relógio; 200 com a visão completa (quem decide vê cobertura e posição)', async (t) => {
    const chamadas = [];
    t.mock.method(solicitacaoSvc, 'decidirSolicitacao', async (_pool, dados) => { chamadas.push(dados); return visao('APROVADA'); });
    const res = respostaFalsa();
    const decisoes = [{ itemId: 31, decisao: 'APROVADO' }];
    await controller({ relogio: RELOGIO }).decidir(escrita({ params: { id: 17 }, body: { decisoes } }), res);
    assert.deepEqual(chamadas, [{ empresaId: 3, atorId: 9, solicitacaoId: 17, decisoes, hoje: '2026-10-03', ip: '203.0.113.7', dispositivo: 'Navegador de teste' }]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', ...visao('APROVADA') }]);
  });

  test('encerrar: empresa e encerrador da sessão, justificativa validada, data do relógio; 200 com a visão do serviço', async (t) => {
    const chamadas = [];
    t.mock.method(solicitacaoSvc, 'encerrarSolicitacao', async (_pool, dados) => { chamadas.push(dados); return visao('ENCERRADA'); });
    const res = respostaFalsa();
    await controller({ relogio: RELOGIO }).encerrar(escrita({ params: { id: 17 }, body: { justificativa: 'Desligado' } }), res);
    assert.deepEqual(chamadas, [{ empresaId: 3, atorId: 9, solicitacaoId: 17, justificativa: 'Desligado', hoje: '2026-10-03', ip: '203.0.113.7', dispositivo: 'Navegador de teste' }]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', ...visao('ENCERRADA') }]);
  });

  test('entregar: empresa e responsável da sessão, solicitação do caminho, itens, confirmação e chave; 201 nova, 200 repetida; a forma pública da entrega', async (t) => {
    const chamadas = [];
    const resultado = (repetida) => ({
      repetida,
      ficha: { id: 4, numero: 1, funcionarioId: 5 },
      entrega: {
        id: 40, origem: 'SOLICITACAO', entregueEm: 'x', dataOperacional: '2026-10-03', empresa: { nome: 'A' }, trabalhador: { nome: 'T' }, ghe: null, responsavel: { nome: 'R' }, chave: 'segredo-nao', requisicaoHash: 'h',
      },
      itens: [],
      confirmacao: null,
      solicitacao: { id: 17, numero: 3, status: 'APROVADA', entregueEm: null },
    });
    let repetida = false;
    t.mock.method(entregaSolicitacaoSvc, 'registrarEntregaPorSolicitacao', async (_pool, dados) => { chamadas.push(dados); return resultado(repetida); });
    const corpo = { itens: [{ solicitacaoItemId: 31, loteId: 8, quantidade: 1 }], confirmacao: { modo: 'ACEITE_PRESENCIAL' }, chaveIdempotencia: 'c' };
    const nova = respostaFalsa();
    await controller().entregar(escrita({ params: { id: 17 }, body: corpo }), nova);
    repetida = true;
    const repetidaRes = respostaFalsa();
    await controller().entregar(escrita({ params: { id: 17 }, body: corpo }), repetidaRes);
    assert.deepEqual(chamadas[0], {
      empresaId: 3, atorId: 9, solicitacaoId: 17, itens: corpo.itens, confirmacao: corpo.confirmacao, chaveIdempotencia: 'c', ip: '203.0.113.7', dispositivo: 'Navegador de teste',
    });
    assert.equal(nova.statusCode, 201);
    assert.equal(repetidaRes.statusCode, 200);
    assert.deepEqual(nova.corpo.solicitacao, { id: 17, numero: 3, status: 'APROVADA', entregueEm: null });
    assert.deepEqual([nova.corpo.status, nova.corpo.repetida, nova.corpo.entrega.id, nova.corpo.entrega.origem], ['ok', false, 40, 'SOLICITACAO']);
    const texto = JSON.stringify(nova.corpo);
    assert.equal(texto.includes('segredo-nao') || texto.includes('requisicaoHash'), false, 'nem chave nem hash da requisição saem');
  });

  test('o erro do serviço de escrita sobe sem tratamento local', async (t) => {
    const erro = new Error('falha do serviço');
    t.mock.method(solicitacaoSvc, 'encerrarSolicitacao', async () => { throw erro; });
    await assert.rejects(controller().encerrar(escrita({ params: { id: 17 }, body: { justificativa: 'x' } }), respostaFalsa()), erro);
  });
});

// ── 12G-0 ───────────────────────────────────────────────────────────

describe('solicitacao-epi.controller — contexto da criação e encerráveis (12G-0)', () => {
  const contextoSvc = () => exigirModulo('src/services/solicitacao-epi-contexto.service');

  test('contexto de trabalhadores: só a empresa da sessão, a busca (null sem ela) e a paginação; 200 com o resultado do serviço', async (t) => {
    const chamadas = [];
    const resultado = { funcionarios: [{ id: 5 }], total: 1, pagina: 1, limite: 20 };
    assert.equal(typeof contextoSvc().localizarTrabalhadores, 'function', 'função ainda não implementada: localizarTrabalhadores');
    t.mock.method(contextoSvc(), 'localizarTrabalhadores', async (pool, dados) => { chamadas.push([pool, dados]); return resultado; });
    const c = controller();
    const res = respostaFalsa();
    await c.contextoFuncionarios(requisicao({ query: { busca: 'Silva', pagina: 1, limite: 20 } }), res);
    await c.contextoFuncionarios(requisicao({ query: { pagina: 2, limite: 10 } }), respostaFalsa());
    assert.deepEqual(chamadas, [
      [{ marca: 'pool' }, { empresaId: 3, busca: 'Silva', pagina: 1, limite: 20 }],
      [{ marca: 'pool' }, { empresaId: 3, busca: null, pagina: 2, limite: 10 }],
    ]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', ...resultado }]);
  });

  test('contexto de materiais: empresa da sessão, trabalhador do caminho validado, filtros opcionais (null sem eles)', async (t) => {
    const chamadas = [];
    const resultado = { funcionarioId: 5, materiais: [], total: 0, pagina: 1, limite: 20 };
    assert.equal(typeof contextoSvc().listarMateriais, 'function', 'função ainda não implementada: listarMateriais');
    t.mock.method(contextoSvc(), 'listarMateriais', async (_pool, dados) => { chamadas.push(dados); return resultado; });
    const c = controller();
    const res = respostaFalsa();
    await c.contextoMateriais(requisicao({ params: { funcionarioId: 5 }, query: { busca: 'Luva', previstoNoGhe: true, pagina: 1, limite: 20 } }, { params: { funcionarioId: '999' } }), res);
    await c.contextoMateriais(requisicao({ params: { funcionarioId: 5 }, query: { pagina: 1, limite: 20 } }), respostaFalsa());
    assert.deepEqual(chamadas, [
      { empresaId: 3, funcionarioId: 5, busca: 'Luva', previstoNoGhe: true, pagina: 1, limite: 20 },
      { empresaId: 3, funcionarioId: 5, busca: null, previstoNoGhe: null, pagina: 1, limite: 20 },
    ]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', ...resultado }]);
  });

  test('encerráveis: empresa da sessão, trabalhador opcional (null sem filtro) e paginação; 200 com o resultado do serviço', async (t) => {
    const chamadas = [];
    assert.equal(typeof consulta.listarEncerraveis, 'function', 'função ainda não implementada: listarEncerraveis');
    t.mock.method(consulta, 'listarEncerraveis', async (_pool, dados) => { chamadas.push(dados); return pagina; });
    const c = controller();
    const res = respostaFalsa();
    await c.encerraveis(requisicao({ query: { funcionarioId: 42, pagina: 2, limite: 10 } }), res);
    await c.encerraveis(requisicao({ query: { pagina: 1, limite: 20 } }), respostaFalsa());
    assert.deepEqual(chamadas, [
      { empresaId: 3, funcionarioId: 42, pagina: 2, limite: 10 },
      { empresaId: 3, funcionarioId: null, pagina: 1, limite: 20 },
    ]);
    assert.deepEqual([res.statusCode, res.corpo], [200, { status: 'ok', ...pagina }]);
  });
});
