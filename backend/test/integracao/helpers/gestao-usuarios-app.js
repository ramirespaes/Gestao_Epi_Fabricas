'use strict';

const request = require('supertest');

const { abrirPoolTemporario } = require('./schema-temporario');
const { criarEmpresa } = require('./entrega-epi');
const { todasAsMigrations } = require('./recuperacao-senha');
const { fabricaPortal } = require('./troca-senha');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./turnstile-teste');
const { criarAppTeste } = require('../../helpers/app-teste');
const { cpfFicticio } = require('../../helpers/cpf-ficticio');
const { criarLimitador } = require('../../../src/middleware/rate-limit');
const { criarExigirSessaoGlobal } = require('../../../src/middleware/autenticacao-global');
const { criarExigirSessao } = require('../../../src/middleware/autenticacao');
const { criarAuthGlobalRoutes } = require('../../../src/routes/auth-global.routes');
const { criarAuthGlobalController } = require('../../../src/controllers/auth-global.controller');
const { criarAuthRoutes } = require('../../../src/routes/auth.routes');
const { criarAuthController } = require('../../../src/controllers/auth.controller');
const { criarUsuarioAdministracaoRoutes } = require('../../../src/routes/usuario-administracao.routes');
const { criarUsuarioAdministracaoController } = require('../../../src/controllers/usuario-administracao.controller');
const { criarTrocaSenhaGlobalRoutes } = require('../../../src/routes/troca-senha.routes');
const { criarTrocaSenhaGlobalController } = require('../../../src/controllers/troca-senha.controller');
const { criarContaRoutes } = require('../../../src/routes/conta.routes');
const { criarContaController } = require('../../../src/controllers/conta.controller');
const password = require('../../../src/security/password');
const { authConfig } = require('../../../src/config/auth');

/**
 * Cenário comum da Gestão de Usuários (PostgreSQL real, schema temporário com
 * todas as migrations): duas empresas, contas MASTER/ADMINISTRADOR/..., app
 * HTTP com as rotas de autenticação, conta, troca de senha e administração de
 * usuários (e as extras que a suíte pedir). `extras(app, deps)` registra rotas.
 */
const SENHA_PROVISORIA = 'cometa-lanterna-ardosia-77';
const { cookieNomeGlobal: NOME_GLOBAL, cookieNome: NOME_EMPRESA } = authConfig.sessao;

async function montar({ extras = () => [] } = {}) {
  const contexto = await abrirPoolTemporario(todasAsMigrations());
  const pool = contexto.pool;
  const hashAtual = await password.gerarHashSenha('planeta-nebulosa-ozonio-42');
  const portal = fabricaPortal({ pool, hashSenha: hashAtual });
  const empresas = {
    A: await criarEmpresa(pool, '11222333000181', 'Empresa Alfa'),
    B: await criarEmpresa(pool, '11444777000161', 'Empresa Beta'),
  };
  const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
  const exigirGlobal = criarExigirSessaoGlobal({ pool });
  const exigirGlobalComProvisoria = criarExigirSessaoGlobal({ pool, permitirSenhaProvisoria: true });
  const exigirEmpresarial = criarExigirSessao({ pool });
  const deps = { pool, exigirEmpresarial, exigirGlobal, semLimite };
  const app = criarAppTeste((a) => {
    a.set('trust proxy', 1);
    a.use(
      '/api',
      criarAuthGlobalRoutes({
        controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: exigirGlobal, exigirSessaoGlobalMe: exigirGlobalComProvisoria, ...turnstileDeTeste(),
      }),
      criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao: exigirEmpresarial }),
      criarUsuarioAdministracaoRoutes({ controller: criarUsuarioAdministracaoController({ pool }), exigirSessao: exigirEmpresarial }),
      criarTrocaSenhaGlobalRoutes({ controller: criarTrocaSenhaGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: exigirGlobalComProvisoria }),
      criarContaRoutes({ controller: criarContaController({ pool }), limitadorEmail: semLimite(), exigirSessaoGlobal: exigirGlobal }),
      ...extras(deps),
    );
  });

  const um = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const todos = async (sql, p) => (await pool.query(sql, p)).rows;
  const cookie = (c) => [`${NOME_GLOBAL}=${c.global.token}`, ...(c.empresarial ? [`${NOME_EMPRESA}=${c.empresarial.token}`] : [])].join('; ');
  const cookiesDe = (r) => Object.fromEntries((r.headers['set-cookie'] ?? []).map((c) => c.split(';')[0].split('=')));
  const deCookies = (jar) => Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  const login = (email, senha) => request(app).post('/api/auth/global/login').send({ email, senha, turnstileToken: TOKEN_TURNSTILE_TESTE });
  let sequencia = 0;
  const corpoBase = (extra = {}) => {
    sequencia += 1;
    return {
      nome: `Pessoa ${sequencia}`, email: `pessoa.gu.${sequencia}@example.invalid`, tipoConta: 'USUARIO', senhaProvisoria: SENHA_PROVISORIA,
      cpf: cpfFicticio(7000 + sequencia), matricula: `GU-${sequencia}`, setor: 'Administrativo', ...extra,
    };
  };
  async function contaDaEmpresa(empresaId, perfil = 'MASTER') {
    const identidade = await portal.novaIdentidade();
    const usuarioId = await portal.vincular(identidade, empresaId, perfil);
    const global = await portal.entrar(identidade);
    const empresarial = await portal.selecionar(identidade, global, empresaId);
    return { identidade, usuarioId, empresaId, global, empresarial };
  }
  async function administradorAutorizado(empresaId, master) {
    const c = await contaDaEmpresa(empresaId, 'ADMINISTRADOR');
    await pool.query("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'GERENCIAR_USUARIOS', $3)", [empresaId, c.usuarioId, master.usuarioId]);
    return c;
  }
  const criar = (c, corpo) => request(app).post('/api/administracao/usuarios').set('Cookie', cookie(c)).send(corpo);
  /** Cria pelo POST e devolve {corpo, id, identidadeId, email}; `definitiva` encerra a provisória (fixture). */
  async function usuarioPronto(master, extra = {}, { definitiva = true } = {}) {
    const corpo = corpoBase(extra);
    const r = await criar(master, corpo);
    if (r.status !== 201) throw new Error(`criar falhou: ${r.status} ${JSON.stringify(r.body)}`);
    const { identidade_id: identidadeId } = await um('SELECT identidade_id FROM usuarios WHERE id = $1', [r.body.usuario.id]);
    if (definitiva) await pool.query('UPDATE identidades SET senha_provisoria = false, senha_provisoria_definida_em = NULL, senha_provisoria_expira_em = NULL WHERE id = $1', [identidadeId]);
    return { corpo, id: r.body.usuario.id, identidadeId, email: corpo.email };
  }

  return {
    request, app, pool, contexto, portal, empresas, um, todos, cookie, cookiesDe, deCookies, login, corpoBase, contaDaEmpresa, administradorAutorizado, criar, usuarioPronto,
    SENHA_PROVISORIA, NOME_GLOBAL, NOME_EMPRESA, cpfFicticio, encerrar: () => contexto.encerrar(),
  };
}

module.exports = { montar, SENHA_PROVISORIA };
