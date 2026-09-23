'use strict';

/**
 * Escrita de permissões por PERFIL (permissoes_recurso, migration 009;
 * permissoes_acao, migration 010) — Bloco 9, Etapa B (provisionamento do
 * MASTER, pós-diagnóstico de 23/09/2026).
 *
 * Módulo SEPARADO de permissao.repository.js de propósito: aquele se
 * declara somente-leitura por contrato e é a única fonte das decisões de
 * autorização; este só insere. Nenhuma função aqui é chamada pelo
 * middleware de autorização — o RBAC continua decidindo exclusivamente a
 * partir das linhas que existem (sem bypass para MASTER).
 *
 * INSERIR "SE AUSENTE", NUNCA SOBRESCREVER: os dois inserts usam
 * `ON CONFLICT ... DO NOTHING` sobre as UNIQUEs (empresa_id, perfil,
 * recurso) / (empresa_id, perfil, acao_codigo) e devolvem `true` só quando
 * a linha foi de fato criada. Uma linha já existente — inclusive uma com
 * flags negadas — NÃO é tocada; classificar essa linha como "adequada" ou
 * "insuficiente" é responsabilidade do serviço, que a relata ao operador.
 * Não há `DO UPDATE` neste módulo, e não deve haver.
 *
 * Mesmo padrão dos demais repositórios: executor por parâmetro, validação
 * de formato via exigir*, nenhuma regra de negócio, SQL parametrizado.
 */

const FORMATO_PERFIL = /^[A-Z][A-Z0-9_]{0,19}$/;
const FORMATO_RECURSO = /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/;
const FORMATO_ACAO_CODIGO = /^[A-Z][A-Z0-9_]{0,59}$/;
const LISTA_MAXIMA = 100;

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

function exigirPerfil(perfil) {
  if (typeof perfil !== 'string' || !FORMATO_PERFIL.test(perfil)) {
    throw new TypeError('perfil inválido');
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

function exigirLista(lista, validarItem, nome) {
  if (!Array.isArray(lista) || lista.length === 0 || lista.length > LISTA_MAXIMA) {
    throw new TypeError(`${nome} deve ser uma lista com 1 a ${LISTA_MAXIMA} itens`);
  }
  for (const item of lista) validarItem(item);
}

function exigirBooleano(valor, nome) {
  if (typeof valor !== 'boolean') {
    throw new TypeError(`${nome} deve ser booleano`);
  }
}

const mapearRecurso = (linha) => ({
  recurso: linha.recurso,
  podeVisualizar: linha.pode_visualizar,
  podeCriar: linha.pode_criar,
  podeEditar: linha.pode_editar,
  podeExcluir: linha.pode_excluir,
});

/**
 * Permissões de recurso já existentes para o perfil, restritas aos recursos
 * informados. Devolve um Map recurso -> flags (como persistidas); recurso
 * sem linha simplesmente não está no Map.
 */
async function listarPermissoesRecurso(executor, empresaId, perfil, recursos) {
  exigirEmpresa(empresaId);
  exigirPerfil(perfil);
  exigirLista(recursos, exigirRecurso, 'recursos');

  const { rows } = await executor.query(
    `SELECT recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir
       FROM permissoes_recurso
      WHERE empresa_id = $1 AND perfil = $2 AND recurso = ANY($3::text[])`,
    [empresaId, perfil, recursos],
  );

  return new Map(rows.map((linha) => [linha.recurso, mapearRecurso(linha)]));
}

/**
 * Insere a permissão de recurso do perfil SE não existir. `true` quando a
 * linha foi criada nesta chamada; `false` quando já existia (intocada).
 */
async function inserirPermissaoRecursoSeAusente(executor, {
  empresaId, perfil, recurso, podeVisualizar, podeCriar, podeEditar, podeExcluir,
}) {
  exigirEmpresa(empresaId);
  exigirPerfil(perfil);
  exigirRecurso(recurso);
  exigirBooleano(podeVisualizar, 'podeVisualizar');
  exigirBooleano(podeCriar, 'podeCriar');
  exigirBooleano(podeEditar, 'podeEditar');
  exigirBooleano(podeExcluir, 'podeExcluir');

  const { rows } = await executor.query(
    `INSERT INTO permissoes_recurso
       (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ON CONSTRAINT uq_permissoes_recurso_empresa_perfil_recurso DO NOTHING
     RETURNING recurso`,
    [empresaId, perfil, recurso, podeVisualizar, podeCriar, podeEditar, podeExcluir],
  );

  return rows.length === 1;
}

/**
 * Permissões de ação já existentes para o perfil, restritas aos códigos
 * informados. Map acaoCodigo -> { permitido }.
 */
async function listarPermissoesAcao(executor, empresaId, perfil, acoes) {
  exigirEmpresa(empresaId);
  exigirPerfil(perfil);
  exigirLista(acoes, exigirAcaoCodigo, 'acoes');

  const { rows } = await executor.query(
    `SELECT acao_codigo, permitido
       FROM permissoes_acao
      WHERE empresa_id = $1 AND perfil = $2 AND acao_codigo = ANY($3::text[])`,
    [empresaId, perfil, acoes],
  );

  return new Map(rows.map((linha) => [linha.acao_codigo, { acaoCodigo: linha.acao_codigo, permitido: linha.permitido }]));
}

/**
 * Insere a permissão de ação do perfil SE não existir. `true` quando a linha
 * foi criada nesta chamada; `false` quando já existia (intocada). Uma ação
 * inexistente no catálogo `acoes` viola a FK (23503) e propaga — o serviço
 * confere o catálogo antes.
 */
async function inserirPermissaoAcaoSeAusente(executor, { empresaId, perfil, acaoCodigo, permitido }) {
  exigirEmpresa(empresaId);
  exigirPerfil(perfil);
  exigirAcaoCodigo(acaoCodigo);
  exigirBooleano(permitido, 'permitido');

  const { rows } = await executor.query(
    `INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT uq_permissoes_acao_empresa_perfil_acao DO NOTHING
     RETURNING acao_codigo`,
    [empresaId, perfil, acaoCodigo, permitido],
  );

  return rows.length === 1;
}

module.exports = {
  listarPermissoesRecurso,
  inserirPermissaoRecursoSeAusente,
  listarPermissoesAcao,
  inserirPermissaoAcaoSeAusente,
};
