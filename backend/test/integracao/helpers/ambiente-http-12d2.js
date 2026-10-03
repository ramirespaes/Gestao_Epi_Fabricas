'use strict';

const request = require('supertest');
const { abrirPoolTemporario } = require('./schema-temporario');
const { todasAsMigrations, inserir } = require('./entrega-epi');
const { montarMundoDoServico, inserirUsuario, chaveNova } = require('./solicitacao-epi-servico');
const { criarFerramentas, ACEITE } = require('./reserva-estoque');
const { criarAppTeste } = require('../../helpers/app-teste');
const { HttpError } = require('../../../src/errors/HttpError');
const provisionamento = require('../../../src/services/provisionamento-permissoes.service');
const { criarMaterialController } = require('../../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../../src/routes/material.routes');
const { criarEstoqueController } = require('../../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../../src/routes/estoque.routes');
const { criarItensDisponiveisController } = require('../../../src/controllers/itens-disponiveis.controller');
const { criarItensDisponiveisRoutes } = require('../../../src/routes/itens-disponiveis.routes');
const { criarDashboardController } = require('../../../src/controllers/dashboard.controller');
const { criarDashboardRoutes } = require('../../../src/routes/dashboard.routes');
const { criarEntregaEpiController } = require('../../../src/controllers/entrega-epi.controller');
const { criarEntregaEpiRoutes } = require('../../../src/routes/entrega-epi.routes');
const { criarExigirSessao } = require('../../../src/middleware/autenticacao');
const { criarVerificacaoOrigem } = require('../../../src/middleware/origem');

/**
 * Ambiente HTTP da 12D-2 contra PostgreSQL real: o schema temporário com TODAS
 * as migrations, o mundo da camada de negócio (duas empresas, usuários,
 * trabalhadores, GHE e materiais) e as rotas reais de materiais, estoque, itens
 * disponíveis, dashboard e entrega de EPI, com as autorizações, os schemas e os
 * serviços de produção. A única peça de teste é a SESSÃO: quem chama se
 * identifica pelo cabeçalho `x-teste-usuario` e a empresa e o perfil saem da
 * linha do usuário no banco, exatamente como o middleware real as entrega ao
 * controller. A empresa nunca vem do cliente. O relógio é o real: as ferramentas
 * do mundo usam a mesma data operacional.
 */

const CABECALHO = 'x-teste-usuario';

function sessaoDeTeste(pool) {
  return async (req, res, next) => {
    const id = Number.parseInt(req.headers[CABECALHO] ?? '', 10);
    if (!Number.isInteger(id)) {
      next(HttpError.unauthorized());
      return;
    }
    const { rows: [usuario] } = await pool.query('SELECT id, empresa_id, perfil, ativo FROM usuarios WHERE id = $1', [id]);
    if (usuario === undefined || usuario.ativo !== true) {
      next(HttpError.unauthorized());
      return;
    }
    req.usuario = { id: usuario.id, perfil: usuario.perfil };
    req.empresa = { id: usuario.empresa_id };
    next();
  };
}

async function montarAmbiente() {
  const contexto = await abrirPoolTemporario(todasAsMigrations());
  const { pool } = contexto;
  const d = await montarMundoDoServico(pool);
  for (const empresaId of [d.empresaA, d.empresaB]) await provisionamento.provisionar(pool, { empresaId, dryRun: false });
  const f = criarFerramentas(pool, d);

  const exigirSessao = sessaoDeTeste(pool);
  const relogio = () => new Date();
  const app = criarAppTeste((a) => {
    a.use(
      '/api',
      criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool }),
      criarEstoqueRoutes({ controller: criarEstoqueController({ pool, relogio }), exigirSessao, pool }),
      criarItensDisponiveisRoutes({ controller: criarItensDisponiveisController({ pool, relogio }), exigirSessao, pool }),
      criarDashboardRoutes({ controller: criarDashboardController({ pool, relogio }), exigirSessao, pool }),
      criarEntregaEpiRoutes({ controller: criarEntregaEpiController({ pool, relogio }), exigirSessao, pool }),
    );
  });

  // As rotas de materiais atrás da verificação de origem real (a mesma de app.js), para provar que
  // PUT e DELETE são métodos inseguros e exigem Origin da lista.
  const appComVerificacaoDeOrigem = (origens) => criarAppTeste((a) => {
    a.use('/api', criarVerificacaoOrigem({ origens }), criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool }));
  });

  // As rotas novas com o middleware de sessão REAL (cookie): sem cookie, 401.
  const appComSessaoReal = () => criarAppTeste((a) => {
    const real = criarExigirSessao({ pool });
    a.use(
      '/api',
      criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao: real, pool }),
      criarEstoqueRoutes({ controller: criarEstoqueController({ pool, relogio }), exigirSessao: real, pool }),
      criarItensDisponiveisRoutes({ controller: criarItensDisponiveisController({ pool, relogio }), exigirSessao: real, pool }),
      criarDashboardRoutes({ controller: criarDashboardController({ pool, relogio }), exigirSessao: real, pool }),
    );
  });

  // Quem chama: get, put, delete, post e patch já com a identidade de teste.
  const como = (usuarioId) => {
    const com = (metodo) => (url) => request(app)[metodo](url).set(CABECALHO, String(usuarioId));
    return {
      get: com('get'), put: com('put'), delete: com('delete'), post: com('post'), patch: com('patch'),
    };
  };
  const anonimo = {
    get: (url) => request(app).get(url),
    put: (url) => request(app).put(url),
    delete: (url) => request(app).delete(url),
  };

  /**
   * Usuário comum da empresa (perfil USUARIO), sem nenhuma permissão, com as exceções individuais pedidas:
   * { recurso: ['visualizar', 'editar'] }. Quem concede é o MASTER da empresa.
   */
  let sequencia = 0;
  async function usuarioCom(empresaId, permissoes = {}, perfil = 'USUARIO') {
    sequencia += 1;
    const id = await inserirUsuario(pool, empresaId, `usuario-12d2-${sequencia}@example.invalid`, perfil);
    const mestre = empresaId === d.empresaA ? d.master : d.masterB;
    for (const [recurso, operacoes] of Object.entries(permissoes)) {
      await pool.query(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [empresaId, id, recurso, operacoes.includes('visualizar'), operacoes.includes('criar'), operacoes.includes('editar'), operacoes.includes('excluir'), mestre],
      );
    }
    return id;
  }

  /** Material com cadastro completo; devolve o id. `exigeTamanho` false ou null são os casos sem tamanho. */
  async function material(empresaId, nome, {
    exigeTamanho = true, estoqueMinimo = 0, exigeCa = true, ativo = true, categoria = 'EPI', tipo = 'Luva', unidade = 'par', codigoInterno = null,
  } = {}) {
    const linha = await inserir(pool, 'materiais', {
      empresa_id: empresaId,
      nome,
      exige_ca: exigeCa,
      exige_tamanho: exigeTamanho,
      prazo_uso_dias: 180,
      estoque_minimo: estoqueMinimo,
      categoria,
      tipo,
      unidade,
      codigo_interno: codigoInterno,
      ativo,
    });
    return linha.id;
  }

  const encerrar = async () => { await contexto.encerrar(); };

  return {
    pool, d, f, app, appComVerificacaoDeOrigem, appComSessaoReal, como, anonimo, usuarioCom, material, encerrar, ACEITE, chaveNova,
  };
}

module.exports = { montarAmbiente, CABECALHO, sessaoDeTeste };
