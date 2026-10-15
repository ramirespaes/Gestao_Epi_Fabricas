'use strict';

const request = require('supertest');
const base = require('./token-tablet');
const { sessaoDeTeste } = require('./ambiente-http-12d2');
const { criarAppTeste } = require('../../helpers/app-teste');
const { cpfFicticio } = require('../../helpers/cpf-ficticio');
const { criarVerificacaoOrigem } = require('../../../src/middleware/origem');
const { criarExigirSessao } = require('../../../src/middleware/autenticacao');
const { criarLimitador } = require('../../../src/middleware/rate-limit');
const { gerarTokenSessao, hashTokenSessao } = require('../../../src/security/token');

/**
 * Atendimento Token — Etapa D (RED): ambiente da IDENTIFICAÇÃO DO FUNCIONÁRIO e do ATENDIMENTO TEMPORÁRIO no tablet. PostgreSQL real
 * em schema temporário com TODAS as migrations; só o banco de teste. Reutiliza o ambiente da Etapa C (congelada): o tablet continua
 * autenticado pela credencial persistente `gepi_tablet`; o atendimento do funcionário é um SEGUNDO cookie, curto, de nome e Path próprios.
 *
 * Contrato proposto (GREEN D, ainda NÃO implementado) — base /api/atendimento-token/tablet/atendimento:
 *   POST  BASE            { tipo: 'CPF' | 'MATRICULA', valor }  → 201 { status, atendimento: { funcionario: { primeiroNome }, expiraEm, inatividadeSegundos } } + Set-Cookie gepi_atendimento
 *   GET   BASE            (credencial do tablet + cookie do atendimento) → 200 { status, atendimento: { funcionario: { primeiroNome }, expiraEm, restanteSegundos } }, sem prorrogar
 *   POST  BASE/atividade  (idem) → 200, prorroga o prazo para 60 s a partir de agora (interação do funcionário); é a ÚNICA forma de renovar
 *   POST  BASE/encerrar   (idem) → 200 { status }, motivo SAIDA, cookie removido
 *   erros: 400 VALIDACAO | 401 DISPOSITIVO_NAO_AUTORIZADO | 403 REDE_NAO_AUTORIZADA | 404 FUNCIONARIO_NAO_IDENTIFICADO (UMA resposta para
 *   inexistente, afastado, inativo, de outra empresa e identificador de outro tipo) | 401 ATENDIMENTO_INVALIDO (ausente, malformado,
 *   desconhecido, expirado, encerrado, de outro tablet ou empresa) | 429 LIMITE_REQUISICOES_EXCEDIDO.
 */

const COOKIE_ATENDIMENTO = 'gepi_atendimento';
const BASE = '/api/atendimento-token/tablet/atendimento';
const NAO_IDENTIFICADO = Object.freeze([404, 'FUNCIONARIO_NAO_IDENTIFICADO']);
const ATENDIMENTO_INVALIDO = Object.freeze([401, 'ATENDIMENTO_INVALIDO']);
// Decisão definitiva do responsável (11/10/2026): 60 segundos de inatividade, deslizantes, decididos pelo servidor (substitui os 90 s propostos).
const INATIVIDADE_SEGUNDOS = 60;

function carregar(caminho) {
  try {
    return require(caminho);
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes(caminho.split('/').pop())) return null;
    throw erro;
  }
}
const modulosD = () => ({
  rotas: carregar('../../../src/routes/token-atendimento.routes'),
  controller: carregar('../../../src/controllers/token-atendimento.controller'),
});

const cabecalhoCookie = (credencialTablet, tokenAtendimento) => [
  credencialTablet ? `${base.COOKIE_TABLET}=${credencialTablet}` : null,
  tokenAtendimento ? `${COOKIE_ATENDIMENTO}=${tokenAtendimento}` : null,
].filter(Boolean).join('; ');

const cookieDoAtendimentoNaResposta = (resposta) => base.lerSetCookie(resposta).find((c) => c.nome === COOKIE_ATENDIMENTO) ?? null;

async function abrirAmbienteAtendimento() {
  const a = await base.abrirAmbiente();
  let sequencia = 0;

  /** Funcionário direto no banco (dados independentes por cenário). CPF com dígitos verificadores válidos e único. */
  async function funcionario(empresaId, { nome = 'Maria Aparecida da Silva', cpf, matricula, situacao = 'ATIVO' } = {}) {
    sequencia += 1;
    const valores = { empresa_id: empresaId, nome, cpf: cpf ?? cpfFicticio(800000 + sequencia + empresaId * 50000), matricula: matricula === undefined ? `M${sequencia}x` : matricula, situacao };
    const colunas = Object.keys(valores);
    const { rows } = await a.q(`INSERT INTO funcionarios (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(valores));
    return rows[0];
  }

  /** Atendimento direto no banco, com um token canônico REAL; `restanteSegundos` negativo = já vencido. Devolve o token em claro. */
  async function atendimentoDireto(tablet, funcionarioId, { restanteSegundos = INATIVIDADE_SEGUNDOS, iniciadoHaSegundos = 0 } = {}) {
    const token = gerarTokenSessao();
    const { rows } = await a.q(
      `INSERT INTO token_atendimentos (empresa_id, dispositivo_id, funcionario_id, token_hash, iniciado_em, expira_em)
       VALUES ($1, $2, $3, $4, now() - make_interval(secs => $5::int), now() + make_interval(secs => $6::int)) RETURNING id`,
      [tablet.empresaId, tablet.id, funcionarioId, hashTokenSessao(token), iniciadoHaSegundos, restanteSegundos],
    );
    return { id: rows[0].id, token };
  }

  const atendimentosDe = async (dispositivoId) => (await a.q('SELECT * FROM token_atendimentos WHERE dispositivo_id = $1 ORDER BY id', [dispositivoId])).rows;
  const abertosDe = async (dispositivoId) => (await a.q('SELECT * FROM token_atendimentos WHERE dispositivo_id = $1 AND encerrado_em IS NULL', [dispositivoId])).rows;
  const atendimento = async (id) => (await a.q('SELECT * FROM token_atendimentos WHERE id = $1', [id])).rows[0];

  /**
   * App de teste com as rotas REAIS da Etapa C, as da Etapa D (se existirem) e as administrativas da B/C.
   *   limitador               por IP (tablet), padrão praticamente sem limite; null = limitadores PADRÃO
   *   limitadorIdentificacao  por tablet na identificação (padrão da rota quando ausente)
   */
  function criarApp({ hops = 0, admin = 'cabecalho', limitador = criarLimitador({ limite: 100000, janelaSegundos: 60 }), limitadorIdentificacao, limitadorDispositivo, origens = [base.ORIGEM] } = {}) {
    const c = base.modulos();
    const d = modulosD();
    const exigirSessao = admin === 'cookie' ? criarExigirSessao({ pool: a.ctx.pool }) : sessaoDeTeste(a.ctx.pool);
    return criarAppTeste((ap) => {
      ap.set('trust proxy', hops === 0 ? false : hops);
      ap.get('/_sonda-ip', (req, res) => res.json({ ip: req.ip }));
      ap.use('/api', criarVerificacaoOrigem({ origens }));
      if (c.tabletRotas && c.tabletController) {
        ap.use('/api', c.tabletRotas.criarTokenTabletRoutes({ controller: c.tabletController.criarTokenTabletController({ pool: a.ctx.pool }), limitador: limitador ?? undefined, limitadorDispositivo, pool: a.ctx.pool }));
      }
      if (d.rotas && d.controller) {
        ap.use('/api', d.rotas.criarTokenAtendimentoRoutes({
          controller: d.controller.criarTokenAtendimentoController({ pool: a.ctx.pool }), pool: a.ctx.pool, limitador: limitador ?? undefined, limitadorIdentificacao, limitadorDispositivo,
        }));
      }
      if (admin !== null && c.ativacaoRotas && c.ativacaoController) {
        ap.use('/api', c.ativacaoRotas.criarTokenAtivacaoRoutes({ controller: c.ativacaoController.criarTokenAtivacaoController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
      }
      if (admin !== null) {
        ap.use('/api', c.dispositivoRotas.criarTokenDispositivoRoutes({ controller: c.dispositivoController.criarTokenDispositivoController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
      }
    });
  }

  const aplicar = (req, cabecalhos) => { for (const [k, v] of Object.entries(cabecalhos)) req.set(k, v); return req; };
  /** Identificação: só o cookie do TABLET (e o Origin permitido). */
  const identificar = (app, credencialTablet, corpo, cabecalhos = {}) => {
    const req = request(app).post(BASE).set('Origin', base.ORIGEM);
    if (credencialTablet) req.set('Cookie', cabecalhoCookie(credencialTablet, null));
    return aplicar(req, cabecalhos).send(corpo);
  };
  /** Operações do atendimento: cookie do tablet + cookie do atendimento. */
  const pedir = (app, metodo, caminho, tablet, tokenAtendimento, cabecalhos = {}) => {
    const req = metodo === 'GET' ? request(app).get(caminho) : request(app).post(caminho).set('Origin', base.ORIGEM);
    // `tablet` pode ser o objeto do ambiente ({ credencial }), a credencial em texto ou null (sem a credencial do tablet).
    const credencialTablet = tablet !== null && typeof tablet === 'object' ? tablet.credencial : tablet;
    const cookies = cabecalhoCookie(credencialTablet, tokenAtendimento);
    if (cookies) req.set('Cookie', cookies);
    return aplicar(req, cabecalhos).send(metodo === 'GET' ? undefined : {});
  };
  const consultar = (app, tablet, token, cab) => pedir(app, 'GET', BASE, tablet, token, cab);
  const prorrogar = (app, tablet, token, cab) => pedir(app, 'POST', `${BASE}/atividade`, tablet, token, cab);
  // Atenção: `encerrar` do ambiente base é o ENCERRAMENTO DO SCHEMA; o do atendimento tem outro nome.
  const encerrarAtendimento = (app, tablet, token, cab) => pedir(app, 'POST', `${BASE}/encerrar`, tablet, token, cab);

  return {
    ...a, funcionario, atendimentoDireto, atendimentosDe, abertosDe, atendimento, criarApp, identificar, consultar, prorrogar, encerrarAtendimento, pedir,
  };
}

module.exports = {
  COOKIE_ATENDIMENTO, BASE, NAO_IDENTIFICADO, ATENDIMENTO_INVALIDO, INATIVIDADE_SEGUNDOS, cabecalhoCookie, cookieDoAtendimentoNaResposta, abrirAmbienteAtendimento, modulosD,
};
