'use strict';

const request = require('supertest');
const { abrirAmbientePedido } = require('./token-pedido');
const { BASE, cabecalhoCookie, modulosD, cookieDoAtendimentoNaResposta } = require('./token-atendimento');
const base = require('./token-tablet');
const { sessaoDeTeste } = require('./ambiente-http-12d2');
const { criarAppTeste } = require('../../helpers/app-teste');
const { criarVerificacaoOrigem } = require('../../../src/middleware/origem');
const { criarLimitador } = require('../../../src/middleware/rate-limit');
const { criarLote } = require('./entrega-epi');
const solicitacaoSvc = require('../../../src/services/solicitacao-epi.service');
const entregaSolicitacaoSvc = require('../../../src/services/entrega-solicitacao.service');
const { dataOperacional } = require('../../../src/utils/data-operacional');

/**
 * Atendimento Token — Etapa G (RED): ambiente da CONSULTA das solicitações existentes do funcionário do atendimento atual.
 * PostgreSQL real, schema temporário com TODAS as migrations; reutiliza os ambientes congelados das Etapas C, D, E e F e o fluxo REAL da
 * 12G-6 (criação, decisão, entrada de estoque, entrega por solicitação, cancelamento). Nenhuma tabela, coluna ou estado fictício.
 *
 * Contrato proposto (GREEN G ainda NÃO implementado), base /api/atendimento-token/tablet/atendimento:
 *   GET BASE/solicitacoes            sem parâmetros; somente leitura; não renova os 60 s; não emite cookie
 *     200 { status:'ok', temDisponiveis:boolean,
 *           itens:[{ materialId, nome, tamanho|null, situacao, quantidade, retiradaParcial }] }
 *     situacao: 'DISPONIVEL_PARA_RETIRADA' | 'AGUARDANDO_ESTOQUE' | 'AGUARDANDO_APROVACAO' | 'INDISPONIVEL'
 *     (somente solicitações em aberto; entregue, cancelada, reprovada e encerrada não aparecem)
 * O caminho NÃO é `/pedidos`: a consulta posterior após a identificação é outra operação, distinta da recuperação da resposta HTTP original
 * da Etapa F (`GET .../pedidos/:chave`, vinculada ao atendimento original).
 * Módulos esperados pelo GREEN G (carregados só se existirem): src/routes/token-solicitacoes.routes.js (criarTokenSolicitacoesRoutes) e
 * src/controllers/token-solicitacoes.controller.js (criarTokenSolicitacoesController).
 */

const SOLICITACOES = `${BASE}/solicitacoes`;
const CHAVES_DA_RESPOSTA = Object.freeze(['itens', 'status', 'temDisponiveis']);
const CHAVES_DO_ITEM = Object.freeze(['materialId', 'nome', 'quantidade', 'retiradaParcial', 'situacao', 'tamanho']);
const SITUACOES = Object.freeze(['DISPONIVEL_PARA_RETIRADA', 'AGUARDANDO_ESTOQUE', 'AGUARDANDO_APROVACAO', 'INDISPONIVEL']);
const DECLARACAO = 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).';
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };

function carregar(caminho) {
  try {
    return require(caminho);
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes(caminho.split('/').pop())) return null;
    throw erro;
  }
}

async function abrirAmbienteSolicitacoes() {
  const a = await abrirAmbientePedido();
  const A = () => a.d.empresaA;

  /** App de teste = C + D + catálogo (E) + pedido (F, real) + consulta das solicitações (G), se o módulo já existir. */
  function criarApp({ limitador = criarLimitador({ limite: 100000, janelaSegundos: 60 }), limitadorDispositivo, origens = [base.ORIGEM], pool = a.ctx.pool } = {}) {
    const c = base.modulos();
    const d = modulosD();
    const catalogoRotas = require('../../../src/routes/token-catalogo.routes');
    const catalogoController = require('../../../src/controllers/token-catalogo.controller');
    const pedidoRotas = require('../../../src/routes/token-pedido.routes');
    const pedidoController = require('../../../src/controllers/token-pedido.controller');
    const solicitacoesRotas = carregar('../../../src/routes/token-solicitacoes.routes');
    const solicitacoesController = carregar('../../../src/controllers/token-solicitacoes.controller');
    const exigirSessao = sessaoDeTeste(a.ctx.pool);
    return criarAppTeste((ap) => {
      ap.set('trust proxy', false);
      ap.use('/api', criarVerificacaoOrigem({ origens }));
      ap.use('/api', c.tabletRotas.criarTokenTabletRoutes({ controller: c.tabletController.criarTokenTabletController({ pool: a.ctx.pool }), limitador, limitadorDispositivo, pool: a.ctx.pool }));
      ap.use('/api', d.rotas.criarTokenAtendimentoRoutes({
        controller: d.controller.criarTokenAtendimentoController({ pool: a.ctx.pool }), pool: a.ctx.pool, limitador, limitadorDispositivo,
      }));
      ap.use('/api', catalogoRotas.criarTokenCatalogoRoutes({
        controller: catalogoController.criarTokenCatalogoController({ pool: a.ctx.pool }), pool: a.ctx.pool, limitador, limitadorDispositivo,
      }));
      ap.use('/api', pedidoRotas.criarTokenPedidoRoutes({
        controller: pedidoController.criarTokenPedidoController({ pool }), pool, limitador, limitadorDispositivo,
      }));
      if (solicitacoesRotas && solicitacoesController) {
        ap.use('/api', solicitacoesRotas.criarTokenSolicitacoesRoutes({
          controller: solicitacoesController.criarTokenSolicitacoesController({ pool }), pool, limitador, limitadorDispositivo,
        }));
      }
      ap.use('/api', c.ativacaoRotas.criarTokenAtivacaoRoutes({ controller: c.ativacaoController.criarTokenAtivacaoController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
      ap.use('/api', c.dispositivoRotas.criarTokenDispositivoRoutes({ controller: c.dispositivoController.criarTokenDispositivoController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
    });
  }

  /** A consulta: cookie do tablet + cookie do atendimento (qualquer um pode faltar). */
  const consultarSolicitacoes = (app, t, token, cabecalhos = {}) => a.pedir(app, 'GET', SOLICITACOES, t, token, cabecalhos);
  const consultarComQuery = (app, t, token, query) => request(app).get(`${SOLICITACOES}?${query}`).set('Cookie', cabecalhoCookie(t.credencial, token));
  const escreverEm = (app, metodo, t, token) => request(app)[metodo](SOLICITACOES).set('Origin', base.ORIGEM).set('Cookie', cabecalhoCookie(t.credencial, token)).send({});

  /** Um NOVO atendimento do mesmo funcionário no mesmo tablet (o anterior já foi encerrado). Devolve { token, atendimentoId }. */
  async function reabrir(app, c) {
    const r = await a.identificar(app, c.t.credencial, { tipo: 'CPF', valor: c.f.cpf });
    if (r.status !== 201) throw new Error(`premissa: o novo atendimento deveria abrir (${r.status} ${JSON.stringify(r.body)})`);
    const [linha] = await a.abertosDe(c.t.id);
    return { token: cookieDoAtendimentoNaResposta(r).valor, atendimentoId: linha.id };
  }

  let usuarios = 0;
  const novoUsuario = async (perfil = 'USUARIO') => { usuarios += 1; return a.usuario(A(), { perfil }); };

  /** Pedido INTERNO (origem USUARIO_INTERNO) pelo serviço real da 12G-6. `itens`: { materialId, tamanho?, quantidade, motivo? }. */
  async function criarInterna(funcionarioId, itens, { solicitanteId } = {}) {
    const solicitante = solicitanteId ?? await novoUsuario();
    const r = await solicitacaoSvc.criarSolicitacao(a.ctx.pool, {
      empresaId: A(), atorId: solicitante, funcionarioId,
      itens: itens.map((i) => ({ materialId: i.materialId, tamanho: i.tamanho ?? null, quantidade: i.quantidade ?? 1, motivo: i.motivo ?? 'ADMISSAO' })),
      chaveIdempotencia: a.chave(),
    });
    // Os ids dos itens na ORDEM DE ENTRADA (o serviço grava em ordem canônica de material e tamanho): o índice do teste é o da chamada.
    const idsNaOrdemDeEntrada = itens.map((i) => r.itens.find((x) => x.materialId === i.materialId && (x.tamanho ?? null) === (i.tamanho ?? null)).id);
    return { id: r.solicitacao.id, itens: idsNaOrdemDeEntrada, solicitante };
  }

  /** Decide pelo serviço real. `aprovar`: por índice do item, true (tudo), número (quantidade aprovada) ou false (reprova). */
  async function decidir(solicitacao, decisoesPorItem) {
    const decisoes = solicitacao.itens.map((itemId, indice) => {
      const d = decisoesPorItem?.[indice] ?? true;
      if (d === false) return { itemId, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada' };
      if (typeof d === 'number') return { itemId, decisao: 'APROVADO', quantidadeAprovada: d, justificativa: 'Quantidade reduzida pela SST' };
      return { itemId, decisao: 'APROVADO' };
    });
    return solicitacaoSvc.decidirSolicitacao(a.ctx.pool, { empresaId: A(), atorId: a.d.sst1, solicitacaoId: solicitacao.id, decisoes, hoje: dataOperacional() });
  }

  const cancelar = (solicitacao) => solicitacaoSvc.cancelarSolicitacao(a.ctx.pool, { empresaId: A(), atorId: solicitacao.solicitante, solicitacaoId: solicitacao.id, hoje: dataOperacional() });
  const encerrarPedido = (solicitacao) => solicitacaoSvc.encerrarSolicitacao(a.ctx.pool, {
    empresaId: A(), atorId: a.d.sst1, solicitacaoId: solicitacao.id, justificativa: 'Não será mais entregue', hoje: dataOperacional(),
  });

  /** Entrada de estoque (lote com CA válido) do material e tamanho. Devolve o id do lote. */
  const repor = (materialId, tamanho, quantidade, extra = {}) => criarLote(a.ctx.pool, { empresaId: A(), materialId, tamanho, quantidade, ...extra });

  /** Entrega física pelo serviço real da 12G-6: `itens` = [{ itemId, loteId, quantidade }]. */
  const entregar = (solicitacao, itens) => entregaSolicitacaoSvc.registrarEntregaPorSolicitacao(a.ctx.pool, {
    empresaId: A(), atorId: a.d.master, solicitacaoId: solicitacao.id,
    itens: itens.map((i) => ({ solicitacaoItemId: i.itemId, loteId: i.loteId, quantidade: i.quantidade })),
    confirmacao: ACEITE, chaveIdempotencia: a.chave(), ip: '203.0.113.10', dispositivo: 'Navegador de teste',
  });

  /** Tudo o que a CONSULTA não pode mudar (pedidos, itens, estoque, entregas, ficha, auditoria e o próprio atendimento). */
  async function fotografiaDaConsulta(atendimentoId) {
    const um = async (sql, p = []) => (await a.q(sql, p)).rows[0].v;
    return {
      ...(await a.fotografia()),
      statusDosPedidos: (await a.q('SELECT id, status, decidida_em, cancelada_em, entregue_em, encerrada_em FROM solicitacoes_epi ORDER BY id')).rows,
      decisoes: (await a.q('SELECT id, decisao, quantidade_aprovada FROM solicitacoes_epi_itens ORDER BY id')).rows,
      saldoDosLotes: (await a.q('SELECT id, saldo, quantidade_entregue FROM estoque_lotes ORDER BY id')).rows,
      auditoria: await um('SELECT count(*)::int AS v FROM logs_auditoria'),
      atendimento: (await a.q('SELECT * FROM token_atendimentos WHERE id = $1', [atendimentoId])).rows[0],
    };
  }

  return {
    ...a, criarApp, consultarSolicitacoes, consultarComQuery, escreverEm, reabrir, novoUsuario, criarInterna, decidir, cancelar, encerrarPedido, repor, entregar, fotografiaDaConsulta,
  };
}

module.exports = {
  SOLICITACOES, CHAVES_DA_RESPOSTA, CHAVES_DO_ITEM, SITUACOES, abrirAmbienteSolicitacoes,
};
