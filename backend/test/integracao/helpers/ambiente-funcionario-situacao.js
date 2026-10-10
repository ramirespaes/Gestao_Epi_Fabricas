'use strict';

const request = require('supertest');
const { abrirPoolTemporario } = require('./schema-temporario');
const { todasAsMigrations } = require('./entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./solicitacao-epi-servico');
const { criarFerramentas } = require('./reserva-estoque');
const { sessaoDeTeste, CABECALHO } = require('./ambiente-http-12d2');
const { criarAppTeste } = require('../../helpers/app-teste');
const provisionamento = require('../../../src/services/provisionamento-permissoes.service');
const { criarFuncionarioController } = require('../../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../../src/routes/funcionario.routes');

/**
 * Ambiente do S2 (situação funcional do funcionário) contra PostgreSQL real: schema temporário com TODAS as
 * migrations (inclui a 084), o mundo da camada de negócio (duas empresas, usuários, trabalhadores, GHE e
 * materiais), o provisionamento padrão do MASTER e as rotas reais de funcionários, com as autorizações, os
 * schemas e os serviços de produção. A única peça de teste é a SESSÃO (`x-teste-usuario`, como na 12D-2).
 * Todo estado inicial de um trabalhador é semeado por SQL; a transição sob teste vai pela rota.
 */

const DISPOSITIVO = 'Navegador de teste S2';

async function montarAmbienteSituacao() {
  const contexto = await abrirPoolTemporario(todasAsMigrations());
  const { pool } = contexto;
  const d = await montarMundoDoServico(pool);
  for (const empresaId of [d.empresaA, d.empresaB]) await provisionamento.provisionar(pool, { empresaId, dryRun: false });
  const f = criarFerramentas(pool, d);

  const exigirSessao = sessaoDeTeste(pool);
  const app = criarAppTeste((a) => {
    a.use('/api', criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao, pool }));
  });

  const como = (usuarioId) => {
    const com = (metodo) => (url, corpo) => {
      const requisicao = request(app)[metodo](url).set(CABECALHO, String(usuarioId)).set('User-Agent', DISPOSITIVO);
      return corpo === undefined ? requisicao : requisicao.send(corpo);
    };
    return { get: com('get'), post: com('post'), patch: com('patch') };
  };
  const anonimo = {
    post: (url, corpo = {}) => request(app).post(url).send(corpo),
  };

  let sequencia = 0;
  async function usuarioCom(empresaId, operacoes, perfil = 'USUARIO') {
    sequencia += 1;
    const id = await inserirUsuario(pool, empresaId, `usuario-s2-${sequencia}@example.invalid`, perfil);
    if (operacoes.length > 0) {
      await pool.query(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
         VALUES ($1, $2, 'employeeHistory', $3, false, $4, false, $5)`,
        [empresaId, id, operacoes.includes('visualizar'), operacoes.includes('editar'), d.master],
      );
    }
    return id;
  }
  const usuarios = {
    master: d.master,
    masterB: d.masterB,
    comEditar: await usuarioCom(d.empresaA, ['visualizar', 'editar']),
    soVisualizar: await usuarioCom(d.empresaA, ['visualizar']),
    semPermissao: await usuarioCom(d.empresaA, []),
  };

  /** Trabalhador novo da empresa A no GHE A, já na situação pedida (semeada por SQL). */
  async function trabalhador(situacao = 'ATIVO') {
    const id = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
    if (situacao !== 'ATIVO') await pool.query('UPDATE funcionarios SET situacao = $2 WHERE id = $1', [id, situacao]);
    return id;
  }
  const definirSituacao = (id, situacao) => pool.query('UPDATE funcionarios SET situacao = $2 WHERE id = $1', [id, situacao]);
  const ler = async (id) => (await pool.query(
    'SELECT situacao, ativo, grupo_homogeneo_id, atualizado_em, cpf, telefone, data_nascimento FROM funcionarios WHERE id = $1', [id],
  )).rows[0];
  const auditoria = async (acao, funcionarioId) => (await pool.query(
    `SELECT id, empresa_id, usuario_id, acao, referencia, ip, dispositivo, contexto, dados_anteriores, dados_novos, criado_em, now() AS agora
       FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id`,
    [acao, String(funcionarioId)],
  )).rows;
  const eventos = async (funcionarioId) => (await pool.query(
    "SELECT acao FROM logs_auditoria WHERE referencia = $1 AND acao LIKE 'FUNCIONARIO\\_%' ORDER BY id", [String(funcionarioId)],
  )).rows.map((r) => r.acao);

  const encerrar = async () => { await contexto.encerrar(); };

  return {
    pool, d, f, app, como, anonimo, usuarios, trabalhador, definirSituacao, ler, auditoria, eventos, encerrar, DISPOSITIVO,
  };
}

module.exports = { montarAmbienteSituacao, DISPOSITIVO };
