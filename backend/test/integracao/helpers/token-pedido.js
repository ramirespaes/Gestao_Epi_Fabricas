'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { abrirAmbienteCatalogo, CATALOGO } = require('./token-catalogo');
const { BASE, cabecalhoCookie, modulosD } = require('./token-atendimento');
const base = require('./token-tablet');
const { ORIGEM } = base;
const { sessaoDeTeste } = require('./ambiente-http-12d2');
const { criarAppTeste } = require('../../helpers/app-teste');
const { criarVerificacaoOrigem } = require('../../../src/middleware/origem');
const { criarExigirSessao } = require('../../../src/middleware/autenticacao');
const { criarLimitador } = require('../../../src/middleware/rate-limit');

/**
 * Atendimento Token — Etapa F (RED): ambiente do PEDIDO do tablet (carrinho finalizado → solicitação de EPI de origem AUTOATENDIMENTO).
 * PostgreSQL real, schema temporário com TODAS as migrations. Reutiliza os ambientes das Etapas C, D e E (congelados) e o fluxo real de
 * solicitações da 12G (065/066/068/086): nenhuma tabela ou coluna fictícia.
 *
 * Contrato proposto (GREEN F ainda NÃO implementado), base /api/atendimento-token/tablet/atendimento:
 *   POST  BASE/pedido           { chaveIdempotencia, itens: [{ materialId, tamanho|null, quantidade, motivo, justificativa? }] }
 *         201 { status:'ok', repetida:false, pedido:{ numero, status:'PENDENTE', quantidadeItens, itens:[{ materialId, tamanho, quantidade, motivo }] } }
 *         200 (mesma chave, mesmo atendimento: o resultado ORIGINAL, repetida:true)
 *   GET   BASE/pedidos/:chave   200 { status:'ok', pedido:{ estado:'REGISTRADO', numero, status, quantidadeItens } }
 *                               202 { status:'ok', pedido:{ estado:'EM_PROCESSAMENTO' } } | 404 PEDIDO_NAO_ENCONTRADO
 * Os módulos esperados pelo GREEN (carregados só se existirem): src/routes/token-pedido.routes.js (criarTokenPedidoRoutes) e
 * src/controllers/token-pedido.controller.js (criarTokenPedidoController).
 */

const PEDIDO = `${BASE}/pedido`;
const PEDIDOS = `${BASE}/pedidos`;
const CHAVES_DO_PEDIDO = Object.freeze(['itens', 'numero', 'quantidadeItens', 'status']);
const CHAVES_DO_ITEM = Object.freeze(['materialId', 'motivo', 'quantidade', 'tamanho']);

function carregar(caminho) {
  try {
    return require(caminho);
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes(caminho.split('/').pop())) return null;
    throw erro;
  }
}

/**
 * Pool que intercepta consultas de um serviço: `pausar` avisa e espera o teste liberar (sem sleep: a ordem é imposta pelo teste);
 * `falhar` lança um erro no ponto escolhido (falha injetada). Tudo mais passa direto ao pool real.
 */
function poolInstrumentado(poolReal, regras) {
  const estado = Object.fromEntries(regras.map((r) => {
    const e = { usada: false };
    e.pausado = new Promise((resolver) => { e.avisar = resolver; });
    e.liberada = new Promise((resolver) => { e.liberar = resolver; });
    return [r.nome, e];
  }));
  const envolver = (client) => ({
    release: (...args) => client.release(...args),
    async query(texto, ...resto) {
      if (typeof texto === 'string') {
        for (const regra of regras) {
          const e = estado[regra.nome];
          if (!e.usada && regra.casa.test(texto)) {
            e.usada = true;
            if (regra.acao === 'falhar') throw new Error(`falha injetada: ${regra.nome}`);
            e.pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; // para o teste saber quem está segurando as travas
            e.avisar();
            await e.liberada;
          }
        }
      }
      return client.query(texto, ...resto);
    },
  });
  return {
    pool: { query: (...args) => poolReal.query(...args), connect: async () => envolver(await poolReal.connect()) },
    pausado: (nome) => estado[nome].pausado,
    pid: (nome) => estado[nome].pid,
    liberar: (nome) => estado[nome].liberar(),
  };
}

async function abrirAmbientePedido() {
  const a = await abrirAmbienteCatalogo();

  /** App de teste = C + D + catálogo (E) + a rota REAL do pedido (F), se o módulo já existir. `pool` troca o pool do pedido (instrumentado). */
  function criarApp({ hops = 0, admin = 'cabecalho', limitador = criarLimitador({ limite: 100000, janelaSegundos: 60 }), limitadorIdentificacao, limitadorDispositivo, origens = [base.ORIGEM], pool = a.ctx.pool } = {}) {
    const c = base.modulos();
    const d = modulosD();
    const catalogoRotas = require('../../../src/routes/token-catalogo.routes');
    const catalogoController = require('../../../src/controllers/token-catalogo.controller');
    const pedidoRotas = carregar('../../../src/routes/token-pedido.routes');
    const pedidoController = carregar('../../../src/controllers/token-pedido.controller');
    const exigirSessao = admin === 'cookie' ? criarExigirSessao({ pool: a.ctx.pool }) : sessaoDeTeste(a.ctx.pool);
    return criarAppTeste((ap) => {
      ap.set('trust proxy', hops === 0 ? false : hops);
      ap.use('/api', criarVerificacaoOrigem({ origens }));
      ap.use('/api', c.tabletRotas.criarTokenTabletRoutes({ controller: c.tabletController.criarTokenTabletController({ pool: a.ctx.pool }), limitador: limitador ?? undefined, limitadorDispositivo, pool: a.ctx.pool }));
      ap.use('/api', d.rotas.criarTokenAtendimentoRoutes({
        controller: d.controller.criarTokenAtendimentoController({ pool: a.ctx.pool }), pool: a.ctx.pool, limitador: limitador ?? undefined, limitadorIdentificacao, limitadorDispositivo,
      }));
      ap.use('/api', catalogoRotas.criarTokenCatalogoRoutes({
        controller: catalogoController.criarTokenCatalogoController({ pool: a.ctx.pool }), pool: a.ctx.pool, limitador: limitador ?? undefined, limitadorDispositivo,
      }));
      if (pedidoRotas && pedidoController) {
        ap.use('/api', pedidoRotas.criarTokenPedidoRoutes({
          controller: pedidoController.criarTokenPedidoController({ pool }), pool, limitador: limitador ?? undefined, limitadorDispositivo,
        }));
      }
      if (admin !== null) {
        ap.use('/api', c.ativacaoRotas.criarTokenAtivacaoRoutes({ controller: c.ativacaoController.criarTokenAtivacaoController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
        ap.use('/api', c.dispositivoRotas.criarTokenDispositivoRoutes({ controller: c.dispositivoController.criarTokenDispositivoController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
      }
    });
  }

  const chave = () => crypto.randomUUID();
  // Motivos do Totem (D-F2): SUBSTITUICAO_PRAZO, DESGASTE_DANO, PERDA_EXTRAVIO. ADMISSAO e OUTRO não são aceitos neste canal.
  const item = (materialId, extra = {}) => ({ materialId, tamanho: null, quantidade: 1, motivo: 'SUBSTITUICAO_PRAZO', ...extra });
  const corpo = (itens, extra = {}) => ({ chaveIdempotencia: chave(), itens, ...extra });

  /** Finaliza o pedido: cookie do tablet + cookie do atendimento + Origin. `token`/`t` nulos omitem o cookie respectivo. */
  const finalizar = (app, t, token, payload, cabecalhos = {}) => {
    const credencial = t !== null && typeof t === 'object' ? t.credencial : t;
    const req = request(app).post(PEDIDO).set('Origin', ORIGEM);
    const cookies = cabecalhoCookie(credencial, token);
    if (cookies) req.set('Cookie', cookies);
    for (const [k, v] of Object.entries(cabecalhos)) req.set(k, v);
    return req.send(payload);
  };
  const resultado = (app, t, token, chaveDoPedido, cabecalhos = {}) => a.pedir(app, 'GET', `${PEDIDOS}/${chaveDoPedido}`, t, token, cabecalhos);

  /** Contagens e somas que NÃO podem mudar quando o pedido é recusado, e que nunca podem mudar por um pedido (só a entrega mexe no estoque/ficha). */
  async function fotografia() {
    const um = async (sql) => (await a.q(sql)).rows[0].v;
    return {
      solicitacoes: await um('SELECT count(*)::int AS v FROM solicitacoes_epi'),
      itens: await um('SELECT count(*)::int AS v FROM solicitacoes_epi_itens'),
      autoatendimento: await um('SELECT count(*)::int AS v FROM solicitacoes_autoatendimento'),
      numeracao: await um('SELECT COALESCE(sum(ultimo_numero), 0)::int AS v FROM solicitacoes_epi_numeracao'),
      lotesBaixado: await um('SELECT COALESCE(sum(quantidade_baixada), 0)::int AS v FROM estoque_lotes'),
      lotesEntregue: await um('SELECT COALESCE(sum(quantidade_entregue), 0)::int AS v FROM estoque_lotes'),
      lotesEntrada: await um('SELECT COALESCE(sum(quantidade_entrada), 0)::int AS v FROM estoque_lotes'),
      operacoes: await um('SELECT count(*)::int AS v FROM estoque_operacoes'),
      entregas: await um('SELECT count(*)::int AS v FROM entregas_epi'),
      entregaItens: await um('SELECT count(*)::int AS v FROM entregas_epi_itens'),
      fichas: await um('SELECT count(*)::int AS v FROM fichas_epi'),
    };
  }

  const solicitacoesDe = async (funcionarioId) => (await a.q('SELECT * FROM solicitacoes_epi WHERE funcionario_id = $1 ORDER BY id', [funcionarioId])).rows;
  const itensDe = async (solicitacaoId) => (await a.q('SELECT * FROM solicitacoes_epi_itens WHERE solicitacao_id = $1 ORDER BY material_id, tamanho', [solicitacaoId])).rows;
  const lateralDe = async (solicitacaoId) => (await a.q('SELECT * FROM solicitacoes_autoatendimento WHERE solicitacao_id = $1', [solicitacaoId])).rows[0] ?? null;

  return {
    ...a, criarApp, chave, item, corpo, finalizar, resultado, fotografia, solicitacoesDe, itensDe, lateralDe, poolInstrumentado: (regras) => poolInstrumentado(a.ctx.pool, regras),
  };
}

module.exports = { PEDIDO, PEDIDOS, CATALOGO, CHAVES_DO_PEDIDO, CHAVES_DO_ITEM, abrirAmbientePedido, poolInstrumentado };
