'use strict';

const request = require('supertest');
const { abrirPoolTemporario } = require('./schema-temporario');
const { todasAsMigrations, inserir } = require('./entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./solicitacao-epi-servico');
const { criarFerramentas } = require('./reserva-estoque');
const { sessaoDeTeste, CABECALHO } = require('./ambiente-http-12d2');
const { exigirModulo } = require('../../helpers/exigir-modulo');
const { criarAppTeste } = require('../../helpers/app-teste');
const provisionamento = require('../../../src/services/provisionamento-permissoes.service');

/**
 * Ambiente HTTP da 12F contra PostgreSQL real: schema temporário com TODAS as
 * migrations, o mundo da camada de negócio (duas empresas, usuários,
 * trabalhadores, GHE e materiais), o provisionamento padrão do MASTER e as rotas
 * reais da solicitação de EPI e dos vínculos SST (consultas da 12F-1 e escrita
 * da 12F-2), com as autorizações, os schemas e os serviços de produção. A única
 * peça de teste é a SESSÃO (cabeçalho `x-teste-usuario`, empresa e perfil lidos
 * da linha do usuário no banco), a mesma da 12D-2. A empresa nunca vem do
 * cliente. A verificação de origem (CSRF) e o CORS ficam nos testes da cadeia
 * real de /api.
 */

async function montarAmbiente12f() {
  const rotasSolicitacao = exigirModulo('src/routes/solicitacao-epi.routes');
  const controllerSolicitacao = exigirModulo('src/controllers/solicitacao-epi.controller');
  const rotasVinculo = exigirModulo('src/routes/vinculo-sst.routes');
  const controllerVinculo = exigirModulo('src/controllers/vinculo-sst.controller');

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
      rotasSolicitacao.criarSolicitacaoEpiRoutes({ controller: controllerSolicitacao.criarSolicitacaoEpiController({ pool, relogio }), exigirSessao, pool }),
      rotasVinculo.criarVinculoSstRoutes({ controller: controllerVinculo.criarVinculoSstController({ pool }), exigirSessao, pool }),
    );
  });

  const como = (usuarioId) => ({
    get: (url) => request(app).get(url).set(CABECALHO, String(usuarioId)),
    head: (url) => request(app).head(url).set(CABECALHO, String(usuarioId)),
    post: (url, corpo = {}) => request(app).post(url).set(CABECALHO, String(usuarioId)).send(corpo),
    delete: (url) => request(app).delete(url).set(CABECALHO, String(usuarioId)),
  });
  const anonimo = {
    get: (url) => request(app).get(url),
    post: (url, corpo = {}) => request(app).post(url).send(corpo),
    delete: (url) => request(app).delete(url),
  };

  /**
   * Usuário da empresa com o que o teste pedir, concedido como a aplicação concede:
   *   recursos: { request: ['visualizar'] } (exceção individual de recurso);
   *   acoes: ['APROVAR_SOLICITACAO', ...] (autorização individual);
   *   sst: true (vínculo com a Segurança do Trabalho).
   * Quem concede é o MASTER da empresa.
   */
  let sequencia = 0;
  async function usuarioCom(empresaId, {
    perfil = 'USUARIO', recursos = {}, acoes = [], sst = false,
  } = {}) {
    sequencia += 1;
    const id = await inserirUsuario(pool, empresaId, `usuario-12f-${sequencia}@example.invalid`, perfil);
    const mestre = empresaId === d.empresaA ? d.master : d.masterB;
    for (const [recurso, operacoes] of Object.entries(recursos)) {
      await pool.query(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [empresaId, id, recurso, operacoes.includes('visualizar'), operacoes.includes('criar'), operacoes.includes('editar'), operacoes.includes('excluir'), mestre],
      );
    }
    for (const acao of acoes) {
      await inserir(pool, 'usuario_autorizacoes', {
        usuario_id: id, empresa_id: empresaId, acao_codigo: acao, autorizado_por: mestre,
      });
    }
    if (sst) await inserir(pool, 'vinculo_sst', { empresa_id: empresaId, usuario_id: id, concedido_por: mestre });
    return id;
  }

  const encerrar = async () => { await contexto.encerrar(); };

  return {
    pool, d, f, app, como, anonimo, usuarioCom, encerrar,
  };
}

module.exports = { montarAmbiente12f };
