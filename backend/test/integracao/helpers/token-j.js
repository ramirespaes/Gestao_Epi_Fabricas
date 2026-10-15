'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const base = require('./token-tablet');
const { abrirAmbientePedido } = require('./token-pedido');
const { modulosD } = require('./token-atendimento');
const { sessaoDeTeste } = require('./ambiente-http-12d2');
const { criarAppTeste } = require('../../helpers/app-teste');
const { exigirModulo } = require('../../helpers/exigir-modulo');
const { criarVerificacaoOrigem } = require('../../../src/middleware/origem');
const { criarExigirSessao } = require('../../../src/middleware/autenticacao');
const { criarLimitador } = require('../../../src/middleware/rate-limit');

/**
 * Atendimento Token — Etapa J, incremento J2a (RED): ambiente do heartbeat e do job de verificação. PostgreSQL real em schema
 * temporário com TODAS as migrations; só o banco de teste (herdado de schema-temporario). Reutiliza, sem alterar, os ambientes
 * das Etapas C, D, E e F; este arquivo só acrescenta o router do heartbeat e utilitários.
 *
 * Interface ASSUMIDA pelo RED (premissa a confirmar; o GREEN a segue ou pede alteração formal):
 *   POST /api/atendimento-token/tablet/heartbeat        corpo vazio estrito, 200 { status: 'ok' }, sob exigirDispositivo inalterado
 *   src/routes/token-heartbeat.routes.js                criarTokenHeartbeatRoutes({ controller, pool, limitador, limitadorDispositivo })
 *   src/controllers/token-heartbeat.controller.js       criarTokenHeartbeatController({ pool })
 *   src/services/token-monitoramento.service.js         derivarEstado(linha, agora) e verificarComunicacao(pool, { relogio, sonda })
 *     relogio: () => Date | Promise<Date>      sonda: () => boolean | Promise<boolean>     retorno: { abortada: boolean, quedas: number }
 *
 * Razões contratuais válidas de falha (qualquer outra é RED INVÁLIDO):
 *   (a) "módulo ainda não implementado: <caminho>"      (b) "função ainda não implementada: <nome>"
 *   (c) "arquivo ainda não implementado: <caminho>"      (d) resposta 404 ROTA_NAO_ENCONTRADA no caminho do heartbeat
 */

const HEARTBEAT = `${base.CAMINHO_TABLET}/heartbeat`;
const LIMIAR_OFFLINE_S = 180;
const CONFIRMACAO_S = 90;
const RAIZ_BACKEND = path.join(__dirname, '..', '..', '..');
const REDE_DE_TESTE = Object.freeze([{ tipo: 'IP_FIXO', rede: `${base.IP_TESTE}/32` }]);

/** Carrega um módulo de src/ que ainda pode não existir; qualquer outro erro de carga é propagado. */
function carregarOpcional(caminho) {
  const absoluto = path.join(RAIZ_BACKEND, caminho);
  try {
    return require(absoluto);
  } catch (erro) {
    if (erro && erro.code === 'MODULE_NOT_FOUND' && typeof erro.message === 'string' && erro.message.startsWith(`Cannot find module '${absoluto}'`)) return null;
    throw erro;
  }
}

function exigirStatus(resposta, status, rotulo, codigo) {
  const detalhe = `${rotulo}: esperado ${status}${codigo === undefined ? '' : ` ${codigo}`}; recebido ${resposta.status} ${JSON.stringify(resposta.body)}`;
  assert.equal(resposta.status, status, detalhe);
  if (codigo !== undefined) assert.equal(resposta.body?.codigo, codigo, detalhe);
}

const depois = (instante, segundos) => new Date(instante.getTime() + segundos * 1000);
/** Instante-base dos cenários do job: 48 h no passado, para que todo relógio injetado (até ~27 h depois) fique antes do "agora" real. */
const instanteBase = () => new Date(Date.now() - 48 * 3600 * 1000);

async function abrirAmbienteJ() {
  assert.ok(
    globalThis.__GEPI_GUARDA_J2A__,
    'guarda D1 ausente: use o comando oficial do RED integrado (--require ./test/integracao/exigir-instancia-dedicada.js)',
  );
  const a = await abrirAmbientePedido();

  // Escritas sem WHERE por empresa (zerarContatos) só são seguras no schema temporário: recusa o ambiente se o search_path não for só ele.
  try {
    const { rows } = await a.q("SELECT current_schema() AS schema, current_setting('search_path') AS caminho");
    assert.match(rows[0].schema, /^test_migration_[0-9a-f]+$/, 'o pool não está no schema temporário');
    assert.equal(rows[0].caminho, rows[0].schema, 'o search_path do pool deve conter somente o schema temporário');
  } catch (erro) {
    await a.encerrar();
    throw erro;
  }

  function criarApp({ hops = 0, admin = 'cabecalho', limitador = criarLimitador({ limite: 100000, janelaSegundos: 60 }), limitadorDispositivo, origens = [base.ORIGEM] } = {}) {
    const c = base.modulos();
    const d = modulosD();
    const catalogoRotas = require('../../../src/routes/token-catalogo.routes');
    const catalogoController = require('../../../src/controllers/token-catalogo.controller');
    const pedidoRotas = require('../../../src/routes/token-pedido.routes');
    const pedidoController = require('../../../src/controllers/token-pedido.controller');
    const heartbeatRotas = carregarOpcional('src/routes/token-heartbeat.routes');
    const heartbeatController = carregarOpcional('src/controllers/token-heartbeat.controller');
    const exigirSessao = admin === 'cookie' ? criarExigirSessao({ pool: a.ctx.pool }) : sessaoDeTeste(a.ctx.pool);
    const pool = a.ctx.pool;
    return criarAppTeste((ap) => {
      ap.set('trust proxy', hops === 0 ? false : hops);
      ap.use('/api', criarVerificacaoOrigem({ origens }));
      ap.use('/api', c.tabletRotas.criarTokenTabletRoutes({ controller: c.tabletController.criarTokenTabletController({ pool }), limitador: limitador ?? undefined, limitadorDispositivo, pool }));
      if (heartbeatRotas && heartbeatController) {
        ap.use('/api', heartbeatRotas.criarTokenHeartbeatRoutes({ controller: heartbeatController.criarTokenHeartbeatController({ pool }), pool, limitador: limitador ?? undefined, limitadorDispositivo }));
      }
      ap.use('/api', d.rotas.criarTokenAtendimentoRoutes({ controller: d.controller.criarTokenAtendimentoController({ pool }), pool, limitador: limitador ?? undefined, limitadorDispositivo }));
      ap.use('/api', catalogoRotas.criarTokenCatalogoRoutes({ controller: catalogoController.criarTokenCatalogoController({ pool }), pool, limitador: limitador ?? undefined, limitadorDispositivo }));
      ap.use('/api', pedidoRotas.criarTokenPedidoRoutes({ controller: pedidoController.criarTokenPedidoController({ pool }), pool, limitador: limitador ?? undefined, limitadorDispositivo }));
      if (admin !== null) {
        ap.use('/api', c.ativacaoRotas.criarTokenAtivacaoRoutes({ controller: c.ativacaoController.criarTokenAtivacaoController({ pool }), exigirSessao, pool }));
        ap.use('/api', c.dispositivoRotas.criarTokenDispositivoRoutes({ controller: c.dispositivoController.criarTokenDispositivoController({ pool }), exigirSessao, pool }));
      }
    });
  }

  /** Heartbeat: só o cookie do tablet (e o Origin permitido). */
  const heartbeat = (app, credencial, { corpo = {}, cabecalhos = {} } = {}) => a.comoTablet(app, credencial, cabecalhos).post(HEARTBEAT, corpo);

  /** Redes autorizadas IP_FIXO do ambiente de teste para as duas empresas (o padrão do ambiente só autoriza a empresa A). */
  const redesDasDuasEmpresas = () => a.redes({ A: [...REDE_DE_TESTE], B: [...REDE_DE_TESTE] });

  const contatoDe = async (id) => (await a.q(
    'SELECT ultimo_contato_em, comunicacao_registrada, xmin::text AS versao FROM token_dispositivos WHERE id = $1', [id],
  )).rows[0];
  const definirContato = (id, instante, registrada = 'ONLINE') => a.q(
    'UPDATE token_dispositivos SET ultimo_contato_em = $2, comunicacao_registrada = $3 WHERE id = $1', [id, instante, registrada],
  );
  const tabletComContato = async (empresaId, instante, registrada = 'ONLINE') => {
    const t = await a.ativado(empresaId);
    await definirContato(t.id, instante, registrada);
    return t;
  };
  /** Tira de monitoramento todos os tablets de rodadas anteriores (contato nulo = SEM_COMUNICACAO), para o job só ver os do teste. */
  const zerarContatos = () => a.q(
    "UPDATE token_dispositivos SET ultimo_contato_em = NULL, comunicacao_registrada = NULL WHERE current_schema() ~ '^test_migration_[0-9a-f]+$'",
  );

  const tiposDeTransicao = async (id) => (await a.q(
    "SELECT tipo FROM token_dispositivo_eventos WHERE dispositivo_id = $1 AND tipo IN ('QUEDA', 'RESTABELECIMENTO') ORDER BY id", [id],
  )).rows.map((l) => l.tipo);
  const quedas = (id) => a.eventos(id, 'QUEDA');
  const restabelecimentos = (id) => a.eventos(id, 'RESTABELECIMENTO');
  const contagem = async (sql, parametros = []) => (await a.q(sql, parametros)).rows[0].n;

  /** Fotografia do que heartbeat e job NÃO podem alterar: pedidos, estoque, entregas, fichas, atendimentos e sessões. */
  async function fotografiaSegura() {
    return {
      ...(await a.fotografia()),
      atendimentos: JSON.stringify((await a.q('SELECT * FROM token_atendimentos ORDER BY id')).rows),
      sessoes: await contagem('SELECT count(*)::int AS n FROM sessoes'),
    };
  }
  /**
   * O que uma passagem abortada não pode mudar: o contato e o estado registrado dos tablets e TODOS os eventos. Colunas de
   * agendamento da verificação ficam de fora de propósito: o armazenamento da suspeita ainda não foi decidido.
   */
  async function fotografiaDoMonitoramento() {
    return JSON.stringify({
      tablets: (await a.q('SELECT id, ultimo_contato_em, comunicacao_registrada, revogado_em, credencial_hash FROM token_dispositivos ORDER BY id')).rows,
      eventos: (await a.q('SELECT * FROM token_dispositivo_eventos ORDER BY id')).rows,
    });
  }

  async function job({ agora, saudavel = true } = {}) {
    const servico = exigirModulo('src/services/token-monitoramento.service');
    assert.equal(typeof servico.verificarComunicacao, 'function', 'função ainda não implementada: verificarComunicacao');
    return servico.verificarComunicacao(a.ctx.pool, { relogio: () => agora, sonda: async () => saudavel });
  }

  return {
    ...a, criarApp, heartbeat, redesDasDuasEmpresas, contatoDe, definirContato, tabletComContato, zerarContatos, tiposDeTransicao, quedas, restabelecimentos,
    contagem, fotografiaSegura, fotografiaDoMonitoramento, job,
  };
}

module.exports = {
  HEARTBEAT, LIMIAR_OFFLINE_S, CONFIRMACAO_S, REDE_DE_TESTE, carregarOpcional, exigirStatus, depois, instanteBase, abrirAmbienteJ,
};
