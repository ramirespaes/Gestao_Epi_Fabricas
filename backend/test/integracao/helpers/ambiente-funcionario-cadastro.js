'use strict';

const request = require('supertest');
const { montarAmbienteGhe } = require('./ambiente-funcionario-ghe');
const { sessaoDeTeste, CABECALHO } = require('./ambiente-http-12d2');
const { DISPOSITIVO } = require('./ambiente-funcionario-situacao');
const { criarAppTeste } = require('../../helpers/app-teste');
const { cpfFicticio } = require('../../helpers/cpf-ficticio');
const { criarFuncionarioController } = require('../../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../../src/routes/funcionario.routes');

/**
 * Ambiente do S4 (cadastro e edição individual) sobre o do S3: schema temporário com TODAS as migrations, duas empresas,
 * GHEs com código, usuários com e sem `employeeHistory`, e AS MESMAS rotas reais de funcionários, agora montadas com um
 * RELÓGIO FIXO injetado na fábrica do controller (`criarFuncionarioController({ pool, relogio })`, o mesmo padrão dos
 * controllers da solicitação e do estoque).
 *
 * O instante fixo é 2026-10-11T01:30:00Z = 22:30 de 10/10/2026 em America/Sao_Paulo: a data civil de "hoje" é
 * 2026-10-10 apesar de a data UTC já ser 2026-10-11. É de propósito: as regras de data comparam a DATA CIVIL do contrato,
 * sem conversão de fuso que mude o dia, e não dependem do dia real em que os testes rodam.
 */

const INSTANTE_FIXO = new Date('2026-10-11T01:30:00Z');
const HOJE = '2026-10-10';
const ONTEM = '2026-10-09';
const AMANHA = '2026-10-11';

async function montarAmbienteCadastro() {
  const amb = await montarAmbienteGhe();
  const { pool } = amb;
  const relogio = () => new Date(INSTANTE_FIXO);
  const exigirSessao = sessaoDeTeste(pool);
  const appFixo = criarAppTeste((a) => {
    a.use('/api', criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool, relogio }), exigirSessao, pool }));
  });

  /** Quem chama, com o relógio fixo: get, post e patch já com a identidade de teste e o User-Agent do teste. */
  const comoFixo = (usuarioId) => {
    const com = (metodo) => (url, corpo) => {
      const requisicao = request(appFixo)[metodo](url).set(CABECALHO, String(usuarioId)).set('User-Agent', DISPOSITIVO);
      return corpo === undefined ? requisicao : requisicao.send(corpo);
    };
    return { get: com('get'), post: com('post'), patch: com('patch') };
  };

  let sequenciaCpf = 700000;
  let sequenciaMatricula = 0;
  /** Corpo de cadastro COMPLETO e válido (todos os obrigatórios do S4); `extra` sobrescreve, `undefined` remove a chave. */
  const corpoValido = (extra = {}) => {
    sequenciaCpf += 1;
    sequenciaMatricula += 1;
    const corpo = {
      nome: 'Funcionário S4', cpf: cpfFicticio(sequenciaCpf), matricula: `S4-${sequenciaMatricula}`, setor: 'Manutenção', funcao: 'Mecânico',
      grupoHomogeneoId: amb.ghes.soldagem, dataAdmissao: '2026-01-15', ...extra,
    };
    for (const [chave, valor] of Object.entries(corpo)) if (valor === undefined) delete corpo[chave];
    return corpo;
  };

  const total = async (empresaId = amb.d.empresaA) => (await pool.query('SELECT count(*)::int AS n FROM funcionarios WHERE empresa_id = $1', [empresaId])).rows[0].n;
  /** Linha física do funcionário (nomes físicos do banco), para comparar antes e depois. */
  const linha = async (id) => (await pool.query('SELECT * FROM funcionarios WHERE id = $1', [id])).rows[0];
  /** Funcionário legado por SQL (sem as regras novas): campos físicos pedidos sobre o padrão da empresa A. */
  const legado = async ({ gheId = amb.ghes.soldagem, dataNascimento = null, dataAdmissao = null, setor = null, funcao = null } = {}) => {
    const id = await amb.d.novoTrabalhador(amb.d.empresaA, { gheId, setor, funcao });
    await pool.query('UPDATE funcionarios SET data_nascimento = $2, data_admissao = $3 WHERE id = $1', [id, dataNascimento, dataAdmissao]);
    return id;
  };
  const eventosDe = async (id) => (await pool.query(
    "SELECT acao FROM logs_auditoria WHERE referencia = $1 AND acao LIKE 'FUNCIONARIO\\_%' ORDER BY id", [String(id)],
  )).rows.map((r) => r.acao);
  const eventosTotal = async (acao) => (await pool.query('SELECT count(*)::int AS n FROM logs_auditoria WHERE acao = $1', [acao])).rows[0].n;

  return {
    ...amb, comoFixo, corpoValido, total, linha, legado, eventosDe, eventosTotal, HOJE, ONTEM, AMANHA,
  };
}

module.exports = { montarAmbienteCadastro, HOJE, ONTEM, AMANHA };
