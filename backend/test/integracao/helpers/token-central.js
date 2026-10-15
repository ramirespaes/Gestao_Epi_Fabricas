'use strict';

const request = require('supertest');
const { abrirAmbienteCatalogo } = require('./token-catalogo');
const base = require('./token-tablet');
const { modulosD } = require('./token-atendimento');
const { sessaoDeTeste } = require('./ambiente-http-12d2');
const { criarAppTeste } = require('../../helpers/app-teste');
const { criarVerificacaoOrigem } = require('../../../src/middleware/origem');
const { criarLimitador } = require('../../../src/middleware/rate-limit');

/**
 * Atendimento Token — Etapa H (RED): ambiente da Central Administrativa. PostgreSQL real, schema temporário com TODAS as migrations; reutiliza
 * os ambientes congelados das Etapas B, C e E e as rotas REAIS de administração dos tablets (B e C). A sessão é a de teste (o usuário vem do
 * cabeçalho; empresa e perfil, da linha do usuário), como nos demais ambientes HTTP administrativos.
 *
 * Contratos propostos (GREEN H ainda NÃO implementado), base /api/atendimento-token, TODOS somente GET, sob a mesma sessão administrativa:
 *   GET /visao-geral                      recurso atendimentoToken.visualizar
 *     200 { status:'ok', visaoGeral:{ dispositivos:{ cadastrados, ativos, pendentes, revogados }, ativacoesPendentes, situacaoGeral } }
 *     situacaoGeral: 'SEM_DISPOSITIVOS' | 'SEM_DISPOSITIVO_ATIVO' | 'COM_DISPOSITIVO_ATIVO' (administrativa; online/offline é da Etapa J)
 *   GET /dispositivos/:id/ativacao        recurso atendimentoToken.visualizar
 *     200 { status:'ok', ativacao:{ estado, geradaEm, expiraEm, usadaEm, canceladaEm } }; estado: NENHUMA|PENDENTE|EXPIRADA|CONSUMIDA|CANCELADA
 *     (a ativação MAIS RECENTE do dispositivo; nunca o código, o hash ou quem gerou)
 *   GET /previa/catalogo?funcionarioId=   ação TOKEN_PREVIA_CATALOGO_REAL
 *     200 { status:'ok', previa:{ catalogo:{ estado, total, materiais } } }  (o MESMO catálogo que o tablet mostraria ao funcionário)
 * Módulos esperados pelo GREEN H (carregados só se existirem): src/routes/token-central.routes.js (criarTokenCentralRoutes) e
 * src/controllers/token-central.controller.js (criarTokenCentralController).
 */

const RAIZ = '/api/atendimento-token';
const CHAVES_DA_VISAO_GERAL = Object.freeze(['ativacoesPendentes', 'dispositivos', 'situacaoGeral']);
const CHAVES_DOS_DISPOSITIVOS = Object.freeze(['ativos', 'cadastrados', 'pendentes', 'revogados']);
const CHAVES_DA_ATIVACAO = Object.freeze(['canceladaEm', 'estado', 'expiraEm', 'geradaEm', 'usadaEm']);

function carregar(caminho) {
  try {
    return require(caminho);
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes(caminho.split('/').pop())) return null;
    throw erro;
  }
}

async function abrirAmbienteCentral() {
  const a = await abrirAmbienteCatalogo();
  const A = () => a.d.empresaA;

  /** App de teste = tablet (C) + administração dos dispositivos (B) + ativação (C) + a Central (H), se o módulo já existir. */
  function criarApp({ origens = [base.ORIGEM] } = {}) {
    const c = base.modulos();
    const central = carregar('../../../src/routes/token-central.routes');
    const centralController = carregar('../../../src/controllers/token-central.controller');
    const exigirSessao = sessaoDeTeste(a.ctx.pool);
    const limitador = criarLimitador({ limite: 100000, janelaSegundos: 60 });
    return criarAppTeste((ap) => {
      ap.set('trust proxy', false);
      ap.use('/api', criarVerificacaoOrigem({ origens }));
      ap.use('/api', c.tabletRotas.criarTokenTabletRoutes({ controller: c.tabletController.criarTokenTabletController({ pool: a.ctx.pool }), limitador, pool: a.ctx.pool }));
      ap.use('/api', c.ativacaoRotas.criarTokenAtivacaoRoutes({ controller: c.ativacaoController.criarTokenAtivacaoController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
      ap.use('/api', c.dispositivoRotas.criarTokenDispositivoRoutes({ controller: c.dispositivoController.criarTokenDispositivoController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
      // Atendimento (D) e catálogo (E) reais do tablet: o teste de desativação de rede exerce o tablet de verdade, depois da desativação.
      const d = modulosD();
      ap.use('/api', d.rotas.criarTokenAtendimentoRoutes({ controller: d.controller.criarTokenAtendimentoController({ pool: a.ctx.pool }), pool: a.ctx.pool, limitador }));
      const catalogoRotas = require('../../../src/routes/token-catalogo.routes');
      const catalogoController = require('../../../src/controllers/token-catalogo.controller');
      ap.use('/api', catalogoRotas.criarTokenCatalogoRoutes({ controller: catalogoController.criarTokenCatalogoController({ pool: a.ctx.pool }), pool: a.ctx.pool, limitador }));
      if (central && centralController) {
        ap.use('/api', central.criarTokenCentralRoutes({ controller: centralController.criarTokenCentralController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
      }
    });
  }

  /** Requisições administrativas: o usuário vem do cabeçalho de teste (nunca um cookie de tablet). */
  const admin = (app, usuarioId) => {
    const com = (req) => req.set(base.CABECALHO, String(usuarioId)).set('Origin', base.ORIGEM);
    return {
      get: (url) => com(request(app).get(url)),
      post: (url, corpo = {}) => com(request(app).post(url)).send(corpo),
      patch: (url, corpo = {}) => com(request(app).patch(url)).send(corpo),
      put: (url, corpo = {}) => com(request(app).put(url)).send(corpo),
      delete: (url) => com(request(app).delete(url)),
    };
  };

  /** Dispositivo direto no banco, na situação pedida: 'PENDENTE' | 'ATIVO' | 'REVOGADO'. */
  async function dispositivoEm(empresaId, situacao, extra = {}) {
    const d = await a.dispositivo(empresaId, { nome: a.unico('Central'), ...extra });
    if (situacao === 'PENDENTE') return d;
    const credencial = base.hashAleatorio();
    await a.q('UPDATE token_dispositivos SET ativado_em = now(), credencial_hash = $1, credencial_emitida_em = now() WHERE id = $2', [credencial, d.id]);
    if (situacao === 'REVOGADO') {
      await a.q('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $1, credencial_hash = NULL, credencial_anterior_hash = NULL WHERE id = $2', [extra.criado_por ?? a.masterDe(empresaId), d.id]);
    }
    return { ...d, credencial };
  }

  /** Contagens esperadas, lidas DIRETAMENTE das tabelas por SQL independente (a verdade que a Visão Geral precisa refletir). */
  async function contagensReais(empresaId) {
    const r = (await a.q(
      `SELECT count(*)::int AS cadastrados,
              count(*) FILTER (WHERE revogado_em IS NULL AND ativado_em IS NOT NULL)::int AS ativos,
              count(*) FILTER (WHERE revogado_em IS NULL AND ativado_em IS NULL)::int AS pendentes,
              count(*) FILTER (WHERE revogado_em IS NOT NULL)::int AS revogados
         FROM token_dispositivos WHERE empresa_id = $1`, [empresaId],
    )).rows[0];
    const ativacoesPendentes = (await a.q(
      'SELECT count(*)::int AS n FROM token_ativacoes WHERE empresa_id = $1 AND usado_em IS NULL AND cancelado_em IS NULL AND expira_em > now()', [empresaId],
    )).rows[0].n;
    let situacaoGeral = 'COM_DISPOSITIVO_ATIVO';
    if (r.cadastrados === 0) situacaoGeral = 'SEM_DISPOSITIVOS';
    else if (r.ativos === 0) situacaoGeral = 'SEM_DISPOSITIVO_ATIVO';
    return { dispositivos: { ...r }, ativacoesPendentes, situacaoGeral };
  }

  /** Tudo o que a PRÉVIA e a Visão Geral não podem mudar (nada operacional). */
  async function fotografiaOperacional() {
    const um = async (sql) => (await a.q(sql)).rows[0].v;
    return {
      solicitacoes: await um('SELECT count(*)::int AS v FROM solicitacoes_epi'),
      itens: await um('SELECT count(*)::int AS v FROM solicitacoes_epi_itens'),
      autoatendimento: await um('SELECT count(*)::int AS v FROM solicitacoes_autoatendimento'),
      numeracao: await um('SELECT COALESCE(sum(ultimo_numero), 0)::int AS v FROM solicitacoes_epi_numeracao'),
      lotes: (await a.q('SELECT id, saldo, quantidade_entregue FROM estoque_lotes ORDER BY id')).rows,
      operacoes: await um('SELECT count(*)::int AS v FROM estoque_operacoes'),
      entregas: await um('SELECT count(*)::int AS v FROM entregas_epi'),
      fichas: await um('SELECT count(*)::int AS v FROM fichas_epi'),
      atendimentos: await um('SELECT count(*)::int AS v FROM token_atendimentos'),
      funcionarios: await um('SELECT count(*)::int AS v FROM funcionarios'),
      dispositivos: (await a.q('SELECT id, nome, ativado_em, revogado_em, credencial_hash FROM token_dispositivos ORDER BY id')).rows,
      ativacoes: (await a.q('SELECT id, usado_em, cancelado_em, expira_em FROM token_ativacoes ORDER BY id')).rows,
    };
  }

  return { ...a, criarApp, admin, dispositivoEm, contagensReais, fotografiaOperacional };
}

module.exports = {
  RAIZ, CHAVES_DA_VISAO_GERAL, CHAVES_DOS_DISPOSITIVOS, CHAVES_DA_ATIVACAO, abrirAmbienteCentral,
};
