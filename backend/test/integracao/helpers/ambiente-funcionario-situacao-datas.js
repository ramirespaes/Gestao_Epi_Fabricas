'use strict';

const request = require('supertest');
const { abrirPoolTemporario } = require('./schema-temporario');
const {
  todasAsMigrations, criarFicha, criarMaterial, criarLote, registrarEntrega,
} = require('./entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./solicitacao-epi-servico');
const { sessaoDeTeste, CABECALHO } = require('./ambiente-http-12d2');
const { DISPOSITIVO } = require('./ambiente-funcionario-situacao');
const { criarAppTeste } = require('../../helpers/app-teste');
const provisionamento = require('../../../src/services/provisionamento-permissoes.service');
const { criarFuncionarioController } = require('../../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../../src/routes/funcionario.routes');

/**
 * Ambiente das datas efetivas da situação (PostgreSQL real, schema temporário com TODAS as migrations, inclusive a candidata que
 * cria funcionario_situacoes). Duas empresas, o mundo da camada de negócio, o provisionamento padrão do MASTER e as rotas reais de
 * funcionários com um RELÓGIO FIXO injetado no controller.
 *
 * Instante fixo: 2026-10-11T01:30:00Z = 22:30 de 10/10/2026 em America/Sao_Paulo. A data civil de "hoje" é 2026-10-10 mesmo com a
 * data UTC já em 2026-10-11 (de propósito: nenhuma regra pode comparar a data UTC). O relógio do banco (now()) é o real.
 *
 * Entregas: criadas direto no banco com a data operacional escolhida e entregue_em coerente com ela (a CHECK da 058 exige que
 * data_operacional seja o dia de entregue_em em São Paulo). Dados fictícios. Este arquivo não abre conexão ao ser importado.
 */

const INSTANTE_FIXO = new Date('2026-10-11T01:30:00Z');
const HOJE = '2026-10-10';
const AMANHA = '2026-10-11';

async function montarAmbienteSituacaoDatas() {
  const contexto = await abrirPoolTemporario(todasAsMigrations());
  const { pool } = contexto;
  const d = await montarMundoDoServico(pool);
  for (const empresaId of [d.empresaA, d.empresaB]) await provisionamento.provisionar(pool, { empresaId, dryRun: false });

  const relogio = () => new Date(INSTANTE_FIXO);
  const exigirSessao = sessaoDeTeste(pool);
  const app = criarAppTeste((a) => {
    a.use('/api', criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool, relogio }), exigirSessao, pool }));
  });

  const como = (usuarioId) => {
    const com = (metodo) => (url, corpo) => {
      const requisicao = request(app)[metodo](url).set(CABECALHO, String(usuarioId)).set('User-Agent', DISPOSITIVO);
      return corpo === undefined ? requisicao : requisicao.send(corpo);
    };
    return { get: com('get'), post: com('post'), patch: com('patch') };
  };
  const anonimo = { post: (url, corpo = {}) => request(app).post(url).send(corpo) };

  let sequencia = 0;
  async function usuarioCom(empresaId, operacoes, perfil = 'USUARIO') {
    sequencia += 1;
    const id = await inserirUsuario(pool, empresaId, `usuario-datas-${sequencia}@example.invalid`, perfil);
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

  /** Trabalhador novo da empresa A (ou da B) na situação pedida e com a admissão pedida (ambas semeadas por SQL, como o legado). */
  async function trabalhador({ situacao = 'ATIVO', admissao = '2020-01-01', empresaId = d.empresaA } = {}) {
    const id = await d.novoTrabalhador(empresaId, { gheId: empresaId === d.empresaA ? d.gheA : d.gheB });
    await pool.query('UPDATE funcionarios SET data_admissao = $2 WHERE id = $1', [id, admissao]);
    if (situacao !== 'ATIVO') await pool.query('UPDATE funcionarios SET situacao = $2 WHERE id = $1', [id, situacao]);
    return id;
  }
  const ler = async (id) => (await pool.query(
    `SELECT situacao, ativo, grupo_homogeneo_id, matricula, cpf, nome, telefone, to_char(data_admissao, 'YYYY-MM-DD') AS data_admissao,
            atualizado_em, criado_em FROM funcionarios WHERE id = $1`, [id],
  )).rows[0];
  const historico = async (id) => (await pool.query(
    `SELECT id, empresa_id, funcionario_id, situacao_anterior, situacao_nova, to_char(data_efetiva, 'YYYY-MM-DD') AS data_efetiva,
            registrado_por, registrado_em FROM funcionario_situacoes WHERE funcionario_id = $1 ORDER BY id`, [id],
  )).rows;
  const auditoria = async (acao, funcionarioId) => (await pool.query(
    `SELECT id, empresa_id, usuario_id, acao, referencia, contexto, dados_anteriores, dados_novos, criado_em
       FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id`, [acao, String(funcionarioId)],
  )).rows;
  const acoes = async (funcionarioId) => (await pool.query(
    "SELECT acao FROM logs_auditoria WHERE referencia = $1 AND acao LIKE 'FUNCIONARIO\\_%' ORDER BY id", [String(funcionarioId)],
  )).rows.map((r) => r.acao);

  // ── entregas ──────────────────────────────────────────────────────
  const porEmpresa = new Map();
  async function materialDaEmpresa(empresaId) {
    if (!porEmpresa.has(empresaId)) {
      const materialId = await criarMaterial(pool, empresaId, `Luva Datas ${empresaId}`, { prazo: 90 });
      const loteId = await criarLote(pool, { empresaId, materialId, quantidade: 100000, tamanho: '40' });
      porEmpresa.set(empresaId, { materialId, loteId, responsavel: empresaId === d.empresaA ? d.master : d.masterB });
    }
    return porEmpresa.get(empresaId);
  }
  const fichas = new Map();
  async function fichaDe(empresaId, funcionarioId) {
    if (!fichas.has(funcionarioId)) fichas.set(funcionarioId, await criarFicha(pool, empresaId, funcionarioId));
    return fichas.get(funcionarioId);
  }
  /** Cria antes (fora de qualquer trava) a ficha, o material e o lote usados pelas entregas do funcionário. */
  async function preparar(funcionarioId) {
    const { rows: [f] } = await pool.query('SELECT empresa_id FROM funcionarios WHERE id = $1', [funcionarioId]);
    await materialDaEmpresa(f.empresa_id);
    await fichaDe(f.empresa_id, funcionarioId);
  }
  /**
   * Entrega com data operacional `dia` (AAAA-MM-DD, civil de São Paulo) e hora local `hora`; o instante é gravado com o fuso -03:00.
   * `executor` pode ser uma conexão já aberta (o COMMIT final da entrega encerra a transação dela): serve para simular uma entrega
   * em andamento que segura a trava do funcionário. Chame `preparar` antes nesse caso.
   */
  async function entregar(funcionarioId, dia, hora = '12:00:00', executor = pool) {
    const { rows: [f] } = await pool.query('SELECT empresa_id FROM funcionarios WHERE id = $1', [funcionarioId]);
    const empresaId = f.empresa_id;
    const { materialId, loteId, responsavel } = await materialDaEmpresa(empresaId);
    const ficha = await fichaDe(empresaId, funcionarioId);
    return registrarEntrega(executor, {
      usuarioId: responsavel,
      entrega: {
        empresa_id: empresaId, ficha_id: ficha.id, responsavel_id: responsavel, data_operacional: dia, entregue_em: `${dia}T${hora}-03:00`,
      },
      itens: [{ material_id: materialId, lote_id: loteId, material_nome: `Luva Datas ${empresaId}`, material_prazo_uso_dias: 90, quantidade: 1 }],
    });
  }
  /** Fotografia das linhas de entrega (cabeçalho, itens, confirmação) do funcionário, para provar que nada foi alterado. */
  const fotografiaDeEntregas = async (funcionarioId) => JSON.stringify((await pool.query(
    `SELECT e.*, (SELECT json_agg(i ORDER BY i.id) FROM entregas_epi_itens i WHERE i.entrega_id = e.id AND i.empresa_id = e.empresa_id) AS itens,
            (SELECT row_to_json(c) FROM entregas_epi_confirmacoes c WHERE c.entrega_id = e.id AND c.empresa_id = e.empresa_id) AS confirmacao
       FROM entregas_epi e JOIN fichas_epi f ON f.id = e.ficha_id AND f.empresa_id = e.empresa_id
      WHERE f.funcionario_id = $1 ORDER BY e.id`, [funcionarioId],
  )).rows);

  const encerrar = async () => { await contexto.encerrar(); };

  return {
    pool, d, app, como, anonimo, usuarios, trabalhador, ler, historico, auditoria, acoes, preparar, entregar, fotografiaDeEntregas, encerrar,
    HOJE, AMANHA, INSTANTE_FIXO, DISPOSITIVO,
  };
}

module.exports = { montarAmbienteSituacaoDatas, HOJE, AMANHA, INSTANTE_FIXO };
