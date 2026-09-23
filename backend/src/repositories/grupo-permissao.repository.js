'use strict';

/**
 * Repositório administrativo das permissões de grupo
 * (grupo_permissoes_recurso e grupo_permissoes_acao, migration 021):
 * leitura pontual da configuração atual e gravação (criação ou
 * atualização) de uma configuração inteira.
 *
 * Contraparte de permissao.repository.js, que continua sendo a ÚNICA
 * fonte de leitura da DECISÃO de autorização (buscarPermissaoRecursoGrupo/
 * buscarPermissaoAcaoGrupo, consultadas pelo middleware a cada requisição)
 * e permanece intocado — mesma separação já adotada entre ele e
 * autorizacao-individual.repository.js (3I) e grupo-acesso.repository.js
 * (3J): o lado que decide autorização nunca ganha funções de escrita.
 *
 * TRI-STATE PRESERVADO LITERALMENTE: as quatro colunas de recurso e a
 * coluna `permitido` de ação são BOOLEAN nullable, e este repositório
 * grava exatamente o que recebe — true, false ou null. Nada aqui converte
 * false em null, nem presume true, nem trata null como "sem valor a
 * gravar": null é uma configuração legítima ("herda do perfil"), e é
 * gravada como tal.
 *
 * A COMPOSIÇÃO PARCIAL NÃO ACONTECE AQUI: quem decide o que preservar de
 * uma configuração existente é o serviço, que lê o estado atual e envia a
 * configuração final completa. Assim o UPSERT abaixo é trivial e não
 * precisa distinguir "campo ausente" de "campo null" em SQL.
 *
 * Sem exclusão: não existe DELETE. Retirar a opinião de um grupo sobre uma
 * operação é gravar null nela, não apagar a linha — o que preserva a
 * linha para auditoria e para a distinção, já estabelecida na Subetapa 3C,
 * entre "linha ausente" e "linha existente sem opinião".
 *
 * empresaId é sempre o filtro de isolamento e nunca é opcional.
 */

// grupo_permissoes_recurso.recurso / grupo_permissoes_acao.acao_codigo:
// VARCHAR(60) (migration 021). Mesmos formatos de permissao.repository.js.
const FORMATO_RECURSO = /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/;
const FORMATO_ACAO_CODIGO = /^[A-Z][A-Z0-9_]{0,59}$/;

const PROJECAO_RECURSO = 'id, empresa_id, grupo_acesso_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, criado_em, atualizado_em';
const PROJECAO_ACAO = 'id, empresa_id, grupo_acesso_id, acao_codigo, permitido, criado_em, atualizado_em';

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

function exigirGrupo(grupoAcessoId) {
  if (!Number.isInteger(grupoAcessoId) || grupoAcessoId <= 0) {
    throw new TypeError('identificador de grupo de acesso inválido');
  }
}

function exigirRecurso(recurso) {
  if (typeof recurso !== 'string' || !FORMATO_RECURSO.test(recurso)) {
    throw new TypeError('recurso inválido');
  }
}

function exigirAcaoCodigo(acaoCodigo) {
  if (typeof acaoCodigo !== 'string' || !FORMATO_ACAO_CODIGO.test(acaoCodigo)) {
    throw new TypeError('código de ação inválido');
  }
}

/** true, false ou null — nada mais. undefined é erro de contrato do chamador. */
function exigirTriState(valor, nome) {
  if (valor !== null && typeof valor !== 'boolean') {
    throw new TypeError(`${nome} deve ser true, false ou null`);
  }
}

const mapearRecurso = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresaId: linha.empresa_id,
  grupoAcessoId: linha.grupo_acesso_id,
  recurso: linha.recurso,
  podeVisualizar: linha.pode_visualizar,
  podeCriar: linha.pode_criar,
  podeEditar: linha.pode_editar,
  podeExcluir: linha.pode_excluir,
  criadoEm: linha.criado_em,
  atualizadoEm: linha.atualizado_em,
});

const mapearAcao = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresaId: linha.empresa_id,
  grupoAcessoId: linha.grupo_acesso_id,
  acaoCodigo: linha.acao_codigo,
  permitido: linha.permitido,
  criadoEm: linha.criado_em,
  atualizadoEm: linha.atualizado_em,
});

/**
 * Configuração atual de um recurso para um grupo. `null` quando não existe
 * nenhuma linha — que é diferente de existir uma linha com as quatro
 * colunas null (grupo sem opinião), distinção estabelecida na Subetapa 3C.
 */
async function buscarRecurso(executor, empresaId, grupoAcessoId, recurso) {
  exigirEmpresa(empresaId);
  exigirGrupo(grupoAcessoId);
  exigirRecurso(recurso);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_RECURSO}
       FROM grupo_permissoes_recurso
      WHERE empresa_id = $1 AND grupo_acesso_id = $2 AND recurso = $3`,
    [empresaId, grupoAcessoId, recurso],
  );

  return mapearRecurso(rows[0]);
}

/** Configuração atual de uma ação para um grupo; `null` quando não existe linha. */
async function buscarAcao(executor, empresaId, grupoAcessoId, acaoCodigo) {
  exigirEmpresa(empresaId);
  exigirGrupo(grupoAcessoId);
  exigirAcaoCodigo(acaoCodigo);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_ACAO}
       FROM grupo_permissoes_acao
      WHERE empresa_id = $1 AND grupo_acesso_id = $2 AND acao_codigo = $3`,
    [empresaId, grupoAcessoId, acaoCodigo],
  );

  return mapearAcao(rows[0]);
}

/**
 * Grava a configuração COMPLETA de um recurso para um grupo: cria a linha
 * se não existir, atualiza as quatro colunas se existir (ON CONFLICT sobre
 * uq_grupo_permissoes_recurso_grupo_recurso, migration 021).
 *
 * As quatro operações são obrigatórias e independentes — o serviço já
 * resolveu o que preservar do estado anterior. O que chega aqui é o estado
 * final desejado, inclusive os `null` que significam "herda do perfil".
 *
 * A FK composta (empresa_id, grupo_acesso_id) -> grupos_acesso garante, no
 * próprio banco, que o grupo pertence à empresa informada: configurar um
 * grupo de outra empresa é estruturalmente impossível, além de já ser
 * impedido pelas verificações do serviço.
 */
async function salvarRecurso(executor, {
  empresaId, grupoAcessoId, recurso, podeVisualizar, podeCriar, podeEditar, podeExcluir,
}) {
  exigirEmpresa(empresaId);
  exigirGrupo(grupoAcessoId);
  exigirRecurso(recurso);
  exigirTriState(podeVisualizar, 'pode_visualizar');
  exigirTriState(podeCriar, 'pode_criar');
  exigirTriState(podeEditar, 'pode_editar');
  exigirTriState(podeExcluir, 'pode_excluir');

  const { rows } = await executor.query(
    `INSERT INTO grupo_permissoes_recurso
       (empresa_id, grupo_acesso_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ON CONSTRAINT uq_grupo_permissoes_recurso_grupo_recurso DO UPDATE
       SET pode_visualizar = EXCLUDED.pode_visualizar,
           pode_criar = EXCLUDED.pode_criar,
           pode_editar = EXCLUDED.pode_editar,
           pode_excluir = EXCLUDED.pode_excluir
     RETURNING ${PROJECAO_RECURSO}`,
    [empresaId, grupoAcessoId, recurso, podeVisualizar, podeCriar, podeEditar, podeExcluir],
  );

  return mapearRecurso(rows[0]);
}

/**
 * Grava a configuração de uma ação para um grupo: cria ou atualiza
 * `permitido` (ON CONFLICT sobre uq_grupo_permissoes_acao_grupo_acao).
 * `permitido` é tri-state e gravado exatamente como recebido.
 *
 * A FK de acao_codigo contra o catálogo `acoes` (migration 021) rejeita
 * código inexistente; se a ação está ATIVA e qual é o seu modo é decisão
 * do serviço, que consulta o catálogo real.
 */
async function salvarAcao(executor, { empresaId, grupoAcessoId, acaoCodigo, permitido }) {
  exigirEmpresa(empresaId);
  exigirGrupo(grupoAcessoId);
  exigirAcaoCodigo(acaoCodigo);
  exigirTriState(permitido, 'permitido');

  const { rows } = await executor.query(
    `INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT uq_grupo_permissoes_acao_grupo_acao DO UPDATE
       SET permitido = EXCLUDED.permitido
     RETURNING ${PROJECAO_ACAO}`,
    [empresaId, grupoAcessoId, acaoCodigo, permitido],
  );

  return mapearAcao(rows[0]);
}

/** Todas as configurações de recurso de um grupo, ordenadas pelo recurso. */
async function listarRecursosDoGrupo(executor, empresaId, grupoAcessoId) {
  exigirEmpresa(empresaId);
  exigirGrupo(grupoAcessoId);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_RECURSO}
       FROM grupo_permissoes_recurso
      WHERE empresa_id = $1 AND grupo_acesso_id = $2
      ORDER BY recurso`,
    [empresaId, grupoAcessoId],
  );

  return rows.map((linha) => mapearRecurso(linha));
}

/** Todas as configurações de ação de um grupo, ordenadas pelo código. */
async function listarAcoesDoGrupo(executor, empresaId, grupoAcessoId) {
  exigirEmpresa(empresaId);
  exigirGrupo(grupoAcessoId);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_ACAO}
       FROM grupo_permissoes_acao
      WHERE empresa_id = $1 AND grupo_acesso_id = $2
      ORDER BY acao_codigo`,
    [empresaId, grupoAcessoId],
  );

  return rows.map((linha) => mapearAcao(linha));
}

module.exports = {
  buscarRecurso,
  buscarAcao,
  salvarRecurso,
  salvarAcao,
  listarRecursosDoGrupo,
  listarAcoesDoGrupo,
};
