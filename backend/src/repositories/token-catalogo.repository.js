'use strict';

const sqlCatalogo = require('./sql/catalogo-token');

/**
 * Leituras do catálogo do Atendimento Token (Etapa E). Só leitura, sempre por empresa, com o GHE vindo do cadastro do funcionário do
 * atendimento (nunca do cliente). Nenhuma coluna de estoque é lida para a resposta: o saldo não filtra nem aparece.
 * Executor por parâmetro; nenhuma regra de negócio além da seleção SQL.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const AUTORIZADO = sqlCatalogo.autorizadoNoCatalogo({ material: 'm', ghe: '$2' });
const TAMANHOS = sqlCatalogo.tamanhosDoMaterial({ material: 'm' });

/** GHE ATUAL do funcionário e se ele está ativo (`null` em ambos quando não há GHE). */
async function buscarGheDoFuncionario(executor, { empresaId, funcionarioId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  const { rows } = await executor.query(
    `SELECT f.grupo_homogeneo_id AS ghe_id, g.ativo AS ghe_ativo
       FROM funcionarios f
       LEFT JOIN grupos_homogeneos_exposicao g ON g.empresa_id = f.empresa_id AND g.id = f.grupo_homogeneo_id
      WHERE f.empresa_id = $1 AND f.id = $2`,
    [empresaId, funcionarioId],
  );
  return rows[0] ?? null;
}

/**
 * Materiais físicos solicitáveis do GHE: ativos, classificados quanto a tamanho (exige_tamanho não nulo), autorizados pelo GHE
 * (direto, ou por tipo ATIVO) e, se exigem tamanho, com ao menos um tamanho cadastrado. Material que não exige tamanho nunca é
 * excluído por falta de grade. Sem LIMIT: nenhum teto elimina material elegível. Ordem estável: lower(nome), id.
 */
async function listarMateriaisAutorizados(executor, { empresaId, gheId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  const { rows } = await executor.query(
    `SELECT m.id, m.nome, m.unidade, m.categoria, m.grupo_protecao, m.tipo, m.tipo_material_id, m.exige_tamanho, ${TAMANHOS} AS tamanhos
       FROM materiais m
      WHERE m.empresa_id = $1 AND m.ativo AND m.exige_tamanho IS NOT NULL AND ${AUTORIZADO}
      ORDER BY lower(m.nome), m.id`,
    [empresaId, gheId],
  );
  return rows;
}

module.exports = { buscarGheDoFuncionario, listarMateriaisAutorizados };
