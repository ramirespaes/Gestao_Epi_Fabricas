'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { abrirPoolTemporario } = require('./schema-temporario');
const { todasAsMigrations } = require('./entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./solicitacao-epi-servico');
const { sessaoDeTeste, CABECALHO } = require('./ambiente-http-12d2');
const { criarAppTeste } = require('../../helpers/app-teste');
const { criarVerificacaoOrigem } = require('../../../src/middleware/origem');
const { criarLimitador } = require('../../../src/middleware/rate-limit');
const { criarExigirSessao } = require('../../../src/middleware/autenticacao');
const { gerarTokenSessao, hashTokenSessao } = require('../../../src/security/token');
const { authConfig } = require('../../../src/config/auth');

/**
 * Ambiente do Atendimento Token — Etapa C (ativação e autenticação dos tablets). PostgreSQL real em schema temporário com
 * TODAS as migrations (086/087 incluídas); só o banco de teste. Nada aqui cria código de produção: os módulos da Etapa C
 * (rotas e controllers) são carregados sob demanda e, enquanto não existirem, simplesmente não são montados — o RED
 * aparece como 404 no lugar do status esperado, nunca como erro de import.
 *
 * Contrato proposto (GREEN C, ainda NÃO implementado):
 *   POST /api/atendimento-token/dispositivos/:id/ativacao   ação TOKEN_GERAR_ATIVACAO     (administrativo, sessão + RBAC)
 *   POST /api/atendimento-token/tablet/ativar               sem sessão; { codigo }         (consome o código de uso único)
 *   GET  /api/atendimento-token/tablet/estado               cookie do tablet; sem corpo    (exemplo mínimo de rota protegida)
 *   cookie do tablet: nome `gepi_tablet`, HttpOnly, Path=/api/atendimento-token/tablet, SameSite=Strict fixo (K5-A), Secure da política de sessão.
 */

const COOKIE_TABLET = 'gepi_tablet';
const CAMINHO_TABLET = '/api/atendimento-token/tablet';
const ORIGEM = 'http://localhost:5500';
const IP_TESTE = '127.0.0.1'; // o supertest conecta por IPv4 loopback (ver test/setup.js)
const HEX64 = /\b[0-9a-f]{64}\b/i;
const CHAVE_SENSIVEL = /hash|credencial|senha|segredo|secret|cookie|authorization|api.?key|codigo.?ativacao|private/i;

const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
const hashAleatorio = () => sha256(crypto.randomUUID());

function carregar(caminho) {
  try {
    return require(caminho);
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes(caminho.split('/').pop())) return null;
    throw erro;
  }
}
const modulos = () => ({
  ativacaoRotas: carregar('../../../src/routes/token-ativacao.routes'),
  ativacaoController: carregar('../../../src/controllers/token-ativacao.controller'),
  tabletRotas: carregar('../../../src/routes/token-tablet.routes'),
  tabletController: carregar('../../../src/controllers/token-tablet.controller'),
  dispositivoRotas: require('../../../src/routes/token-dispositivo.routes'),
  dispositivoController: require('../../../src/controllers/token-dispositivo.controller'),
});

/** Cabeçalho Cookie de um valor de credencial do tablet. */
const cookieDoTablet = (valor) => `${COOKIE_TABLET}=${valor}`;

/** Set-Cookie da resposta -> { nome, valor, atributos } (atributos em minúsculas). */
function lerSetCookie(resposta) {
  const brutos = resposta.headers['set-cookie'] ?? [];
  return brutos.map((bruto) => {
    const [par, ...resto] = bruto.split(';').map((p) => p.trim());
    const i = par.indexOf('=');
    const atributos = {};
    for (const a of resto) {
      const j = a.indexOf('=');
      atributos[(j === -1 ? a : a.slice(0, j)).toLowerCase()] = j === -1 ? true : a.slice(j + 1);
    }
    return { nome: par.slice(0, i), valor: par.slice(i + 1), atributos, bruto };
  });
}
const cookieDoTabletNaResposta = (resposta) => lerSetCookie(resposta).find((c) => c.nome === COOKIE_TABLET) ?? null;

function chavesJson(valor, acumulado = []) {
  if (Array.isArray(valor)) valor.forEach((v) => chavesJson(v, acumulado));
  else if (valor !== null && typeof valor === 'object') for (const [k, v] of Object.entries(valor)) { acumulado.push(k); chavesJson(v, acumulado); }
  return acumulado;
}

/** Varre TODAS as colunas (texto e JSONB) atrás de valores secretos, hashes de 64 hex e chaves sensíveis; devolve só {linha, coluna, motivo}. */
function varrer(linhas, segredos, { hex64 = true } = {}) {
  const achados = [];
  linhas.forEach((linha, i) => {
    for (const [coluna, valor] of Object.entries(linha)) {
      const texto = JSON.stringify(valor) ?? '';
      if (segredos.some((s) => texto.includes(s))) achados.push({ linha: i, coluna, motivo: 'VALOR_SECRETO' });
      if (hex64 && HEX64.test(texto)) achados.push({ linha: i, coluna, motivo: 'HASH_64_HEX' });
      if (chavesJson(valor).some((k) => CHAVE_SENSIVEL.test(k))) achados.push({ linha: i, coluna, motivo: 'CHAVE_SENSIVEL' });
    }
  });
  return achados;
}

async function abrirAmbiente() {
  const ctx = await abrirPoolTemporario(todasAsMigrations());
  const d = await montarMundoDoServico(ctx.pool);
  const q = (sql, parametros = []) => ctx.pool.query(sql, parametros);
  let seq = 0;
  const unico = (prefixo) => { seq += 1; return `${prefixo} ${seq}`; };
  const masterDe = (empresaId) => (empresaId === d.empresaA ? d.master : d.masterB);

  /** Usuário com concessões individuais explícitas (recurso atendimentoToken e/ou ações). */
  async function usuario(empresaId, { perfil = 'USUARIO', operacoes = [], acoes = [] } = {}) {
    const id = await inserirUsuario(ctx.pool, empresaId, `${unico('tablet-c')}@example.invalid`.replace(/ /g, '-'), perfil);
    if (operacoes.length > 0) {
      await q(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
         VALUES ($1, $2, 'atendimentoToken', $3, $4, $5, false, $6)`,
        [empresaId, id, operacoes.includes('visualizar'), operacoes.includes('criar'), operacoes.includes('editar'), masterDe(empresaId)],
      );
    }
    for (const acao of acoes) {
      await q('INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)', [empresaId, id, acao, masterDe(empresaId)]);
    }
    return id;
  }

  /** Dispositivo PENDENTE direto no banco (dados independentes por cenário). */
  async function dispositivo(empresaId, extra = {}) {
    const valores = { empresa_id: empresaId, nome: unico('Tablet C'), unidade: 'Fábrica 1', setor: 'Expedição', local_instalacao: 'Portaria', criado_por: masterDe(empresaId), ...extra };
    const colunas = Object.keys(valores);
    const { rows } = await q(`INSERT INTO token_dispositivos (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(valores));
    return rows[0];
  }

  /** Ativa o dispositivo direto no banco com uma credencial canônica REAL; devolve o valor em claro (o que iria no cookie). */
  async function ativado(empresaId, { horasDesdeEmissao = 0, extra = {} } = {}) {
    const x = await dispositivo(empresaId, extra);
    const credencial = gerarTokenSessao();
    await q(
      `UPDATE token_dispositivos SET ativado_em = now(), credencial_hash = $1, credencial_emitida_em = now() - make_interval(hours => $2::int) WHERE id = $3`,
      [hashTokenSessao(credencial), horasDesdeEmissao, x.id],
    );
    return { id: x.id, empresaId, credencial };
  }

  /** Ativação pendente direto no banco com um código canônico REAL; devolve o código em claro (o que iria no QR). */
  async function codigoPendente(x, { criadoHaMinutos = 0, validadeMinutos = 10 } = {}) {
    const codigo = gerarTokenSessao();
    await q(
      `INSERT INTO token_ativacoes (empresa_id, dispositivo_id, codigo_hash, criado_por, criado_em, expira_em)
       VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5::int), now() - make_interval(mins => $5::int) + make_interval(mins => $6::int))`,
      [x.empresa_id ?? x.empresaId, x.id, hashTokenSessao(codigo), masterDe(x.empresa_id ?? x.empresaId), criadoHaMinutos, validadeMinutos],
    );
    return codigo;
  }

  /**
   * Redes autorizadas ATIVAS: substitui tudo o que as duas empresas tinham. { A: [{tipo, rede}], B: [...] }.
   */
  async function redes({ A = [], B = [] }) {
    for (const [empresaId, lista] of [[d.empresaA, A], [d.empresaB, B]]) {
      await q('UPDATE token_redes_autorizadas SET desativada_em = now(), desativada_por = $2 WHERE empresa_id = $1 AND desativada_em IS NULL', [empresaId, masterDe(empresaId)]);
      for (const { tipo, rede } of lista) {
        await q('INSERT INTO token_redes_autorizadas (empresa_id, tipo, rede, criado_por) VALUES ($1, $2, $3::cidr, $4)', [empresaId, tipo, rede, masterDe(empresaId)]);
      }
    }
  }
  const redeDeTeste = { A: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }], B: [] };

  const linha = async (id) => (await q('SELECT * FROM token_dispositivos WHERE id = $1', [id])).rows[0];
  const ativacoesDe = async (id) => (await q('SELECT * FROM token_ativacoes WHERE dispositivo_id = $1 ORDER BY id', [id])).rows;
  const eventos = async (dispositivoId, tipo) => (await q('SELECT * FROM token_dispositivo_eventos WHERE dispositivo_id = $1 AND tipo = $2 ORDER BY id', [dispositivoId, tipo])).rows;
  const auditorias = async (acao, empresaId = d.empresaA) => (await q('SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2 ORDER BY id', [empresaId, acao])).rows;
  const todaAuditoria = async (empresaId) => (await q('SELECT * FROM logs_auditoria WHERE empresa_id = $1 ORDER BY id', [empresaId])).rows;
  const todosEventos = async (empresaId) => (await q('SELECT * FROM token_dispositivo_eventos WHERE empresa_id = $1 ORDER BY id', [empresaId])).rows;

  /** Sessão administrativa REAL (cookie de sessão empresarial), para provar a separação entre os dois tipos de credencial. */
  async function cookieAdministrativo(usuarioId, empresaId) {
    const token = gerarTokenSessao();
    await q('INSERT INTO sessoes (usuario_id, empresa_id, token_hash, expira_em) VALUES ($1, $2, $3, now() + interval \'1 hour\')', [usuarioId, empresaId, hashTokenSessao(token)]);
    return `${authConfig.sessao.cookieNome}=${token}`;
  }

  /**
   * App de teste com as rotas REAIS já existentes e, se existirem, as da Etapa C.
   *  hops      TRUST_PROXY_HOPS simulado (0 = sem proxy confiável)
   *  admin     'cabecalho' (x-teste-usuario) | 'cookie' (sessão real) | null
   *  limitador limitador por IP dos endpoints do tablet (padrão: praticamente sem limite; null = os limitadores PADRÃO da rota)
   *  limitadorDispositivo limitador por tablet (padrão da rota quando ausente)
   */
  function criarApp({ hops = 0, admin = 'cabecalho', limitador = criarLimitador({ limite: 100000, janelaSegundos: 60 }), limitadorDispositivo, origens = [ORIGEM], comRevogacao = true } = {}) {
    const m = modulos();
    const exigirSessao = admin === 'cookie' ? criarExigirSessao({ pool: ctx.pool }) : sessaoDeTeste(ctx.pool);
    return criarAppTeste((a) => {
      a.set('trust proxy', hops === 0 ? false : hops);
      a.get('/_sonda-ip', (req, res) => res.json({ ip: req.ip }));
      a.use('/api', criarVerificacaoOrigem({ origens }));
      if (m.tabletRotas && m.tabletController) {
        a.use('/api', m.tabletRotas.criarTokenTabletRoutes({ controller: m.tabletController.criarTokenTabletController({ pool: ctx.pool }), limitador: limitador ?? undefined, limitadorDispositivo, pool: ctx.pool }));
      }
      if (admin !== null && m.ativacaoRotas && m.ativacaoController) {
        a.use('/api', m.ativacaoRotas.criarTokenAtivacaoRoutes({ controller: m.ativacaoController.criarTokenAtivacaoController({ pool: ctx.pool }), exigirSessao, pool: ctx.pool }));
      }
      if (admin !== null && comRevogacao) {
        a.use('/api', m.dispositivoRotas.criarTokenDispositivoRoutes({ controller: m.dispositivoController.criarTokenDispositivoController({ pool: ctx.pool }), exigirSessao, pool: ctx.pool }));
      }
    });
  }

  const comoAdmin = (app, usuarioId) => ({
    get: (url) => request(app).get(url).set(CABECALHO, String(usuarioId)).set('Origin', ORIGEM),
    post: (url, corpo = {}) => request(app).post(url).set(CABECALHO, String(usuarioId)).set('Origin', ORIGEM).send(corpo),
  });
  /** Requisições do tablet: só o cookie (e o Origin permitido nas mutações). Cabeçalhos extras opcionais. */
  const comoTablet = (app, credencial, cabecalhos = {}) => {
    const aplicar = (req) => {
      if (credencial !== null && credencial !== undefined) req.set('Cookie', cookieDoTablet(credencial));
      for (const [k, v] of Object.entries(cabecalhos)) req.set(k, v);
      return req;
    };
    return {
      get: (url) => aplicar(request(app).get(url)),
      post: (url, corpo = {}) => aplicar(request(app).post(url).set('Origin', ORIGEM).send(corpo)),
    };
  };
  const ativar = (app, codigo, cabecalhos = {}) => comoTablet(app, null, cabecalhos).post(`${CAMINHO_TABLET}/ativar`, { codigo });

  return {
    ctx, d, q, unico, masterDe, usuario, dispositivo, ativado, codigoPendente, redes, redeDeTeste, linha, ativacoesDe, eventos, auditorias, todaAuditoria,
    todosEventos, cookieAdministrativo, criarApp, comoAdmin, comoTablet, ativar, encerrar: () => ctx.encerrar(),
  };
}

module.exports = {
  COOKIE_TABLET, CAMINHO_TABLET, ORIGEM, IP_TESTE, CABECALHO, sha256, hashAleatorio, cookieDoTablet, lerSetCookie, cookieDoTabletNaResposta,
  varrer, abrirAmbiente, modulos, criarLimitador,
};
