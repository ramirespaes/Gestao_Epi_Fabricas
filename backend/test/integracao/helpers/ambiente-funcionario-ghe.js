'use strict';

const { inserir } = require('./entrega-epi');
const { inserirUsuario } = require('./solicitacao-epi-servico');
const { montarAmbienteSituacao } = require('./ambiente-funcionario-situacao');

/**
 * Ambiente do S3 (GHE do funcionário) sobre o do S2: schema temporário com TODAS as migrations, duas empresas, as rotas
 * reais de funcionários e a sessão de teste. Acrescenta GHEs com código (083) e usuários cuja ÚNICA autoridade é outra:
 * `soGrupos` (employeeGroups.visualizar) e `soImportacao` (ação IMPORTAR_FUNCIONARIOS), para provar que o seletor de GHE
 * do formulário NÃO depende da Gestão de GHE nem da importação.
 *
 * Na tabela física, `codigo` é o código do GHE e `nome` é a descrição operacional (a coluna `descricao` é legada).
 * GHE A e GHE A2 do mundo base são legados: sem código.
 */
async function montarAmbienteGhe() {
  const amb = await montarAmbienteSituacao();
  const { pool, d } = amb;

  const criarGhe = async (empresaId, nome, codigo, ativo = true) => (
    await inserir(pool, 'grupos_homogeneos_exposicao', {
      empresa_id: empresaId, nome, codigo, ativo,
    })
  ).id;
  const ghes = {
    soldagem: await criarGhe(d.empresaA, 'Soldagem', 'GHE-020'),
    caldeiraria: await criarGhe(d.empresaA, 'Caldeiraria', 'GHE-010'),
    encerrado: await criarGhe(d.empresaA, 'Setor encerrado', 'GHE-005', false),
    outraEmpresa: await criarGhe(d.empresaB, 'Outra empresa', 'GHE-001'),
    legado: d.gheA,
    legado2: d.gheA2,
  };

  const soGrupos = await inserirUsuario(pool, d.empresaA, 'so-grupos-s3@example.invalid', 'USUARIO');
  await pool.query(
    `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
     VALUES ($1, $2, 'employeeGroups', true, false, false, false, $3)`,
    [d.empresaA, soGrupos, d.master],
  );
  const soImportacao = await inserirUsuario(pool, d.empresaA, 'so-importacao-s3@example.invalid', 'USUARIO');
  await inserir(pool, 'usuario_autorizacoes', {
    usuario_id: soImportacao, empresa_id: d.empresaA, acao_codigo: 'IMPORTAR_FUNCIONARIOS', autorizado_por: d.master,
  });

  /** Funcionário da empresa A já vinculado ao GHE pedido (ou sem GHE, com `null`), por SQL. */
  const trabalhadorNoGhe = (gheId) => d.novoTrabalhador(d.empresaA, { gheId });
  const gheDe = async (funcionarioId) => (await pool.query('SELECT grupo_homogeneo_id AS id FROM funcionarios WHERE id = $1', [funcionarioId])).rows[0].id;

  return {
    ...amb, ghes, usuarios: { ...amb.usuarios, soGrupos, soImportacao }, trabalhadorNoGhe, gheDe,
  };
}

module.exports = { montarAmbienteGhe };
