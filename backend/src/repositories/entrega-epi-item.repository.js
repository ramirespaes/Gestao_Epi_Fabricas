'use strict';

/**
 * Itens da entrega de EPI (entregas_epi_itens, migration 058), com as cópias
 * congeladas do material. Tamanho, CA e validade vêm do lote, que é
 * imutável, e a operação ENTREGA do item vem de estoque_operacoes. Só INSERT
 * e leitura. Toda consulta filtra pela empresa.
 */

const MOTIVOS = Object.freeze(['ADMISSAO', 'SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO', 'OUTRO']);
const INTEGER_MAXIMO = 2147483647;
const JUSTIFICATIVA_MAXIMA = 500;

const COLUNAS = Object.freeze([
  'id', 'empresa_id', 'entrega_id', 'material_id', 'lote_id', 'quantidade', 'motivo', 'justificativa',
  'previsto_no_ghe', 'justificativa_fora_ghe', 'material_nome', 'material_tipo', 'material_codigo_interno', 'material_unidade',
  'material_prazo_uso_dias', 'material_oculos_com_grau', 'material_exige_ca',
]);
const COLUNAS_ITEM = COLUNAS.join(', ');
// Do lote só o que é imutável (tamanho, CA, validade); o saldo muda e não é histórico.
const COLUNAS_LEITURA = `${COLUNAS.map((c) => `i.${c}`).join(', ')}, l.tamanho, l.ca_numero, to_char(l.ca_validade, 'YYYY-MM-DD') AS ca_validade,
  o.id AS operacao_id`;
const JUNCAO_LEITURA = `FROM entregas_epi_itens i
  JOIN estoque_lotes l ON l.empresa_id = i.empresa_id AND l.id = i.lote_id
  LEFT JOIN estoque_operacoes o ON o.empresa_id = i.empresa_id AND o.entrega_item_id = i.id AND o.tipo = 'ENTREGA'`;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirTextoOpcional(valor, nome, maximo) {
  if (valor !== null && (typeof valor !== 'string' || valor.length === 0 || valor.length > maximo)) {
    throw new TypeError(`${nome} inválido`);
  }
}

const mapearMaterial = (l) => ({
  nome: l.material_nome,
  tipo: l.material_tipo,
  codigoInterno: l.material_codigo_interno,
  unidade: l.material_unidade,
  prazoUsoDias: l.material_prazo_uso_dias,
  oculosComGrau: l.material_oculos_com_grau,
  exigeCa: l.material_exige_ca,
});

const mapearItem = (l) => ({
  id: l.id,
  empresaId: l.empresa_id,
  entregaId: l.entrega_id,
  materialId: l.material_id,
  loteId: l.lote_id,
  quantidade: l.quantidade,
  motivo: l.motivo,
  justificativa: l.justificativa,
  previstoNoGhe: l.previsto_no_ghe,
  justificativaForaGhe: l.justificativa_fora_ghe,
  material: mapearMaterial(l),
});

// A operação é BIGINT: fica em texto, como no repositório de operações.
const mapearLeitura = (l) => ({
  ...mapearItem(l),
  lote: { tamanho: l.tamanho, caNumero: l.ca_numero, caValidade: l.ca_validade },
  operacaoId: l.operacao_id === null ? null : String(l.operacao_id),
});

/** Grava um item com a cópia do material lida na mesma transação. */
async function criar(executor, {
  empresaId, entregaId, materialId, loteId, quantidade, motivo, justificativa = null, previstoNoGhe, justificativaForaGhe = null, material,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(entregaId, 'identificador de entrega');
  exigirId(materialId, 'identificador de material');
  exigirId(loteId, 'identificador de lote');
  if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > INTEGER_MAXIMO) throw new TypeError('quantidade inválida');
  if (!MOTIVOS.includes(motivo)) throw new TypeError('motivo inválido');
  exigirTextoOpcional(justificativa, 'justificativa', JUSTIFICATIVA_MAXIMA);
  if (typeof previstoNoGhe !== 'boolean') throw new TypeError('previsto_no_ghe inválido');
  exigirTextoOpcional(justificativaForaGhe, 'justificativa fora do GHE', JUSTIFICATIVA_MAXIMA);
  if (typeof material.nome !== 'string' || typeof material.unidade !== 'string') throw new TypeError('cópia do material inválida');
  exigirId(material.prazoUsoDias, 'prazo de uso');
  if (typeof material.exigeCa !== 'boolean') throw new TypeError('cópia do material inválida');

  const { rows } = await executor.query(
    `INSERT INTO entregas_epi_itens
       (empresa_id, entrega_id, material_id, lote_id, quantidade, motivo, justificativa, previsto_no_ghe, justificativa_fora_ghe,
        material_nome, material_tipo, material_codigo_interno, material_unidade, material_prazo_uso_dias, material_oculos_com_grau, material_exige_ca)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${COLUNAS_ITEM}`,
    [empresaId, entregaId, materialId, loteId, quantidade, motivo, justificativa, previstoNoGhe, justificativaForaGhe,
      material.nome, material.tipo, material.codigoInterno, material.unidade, material.prazoUsoDias, material.oculosComGrau, material.exigeCa],
  );
  return mapearItem(rows[0]);
}

/** Itens da entrega com o lote e a operação ENTREGA de cada um, na ordem de gravação. */
async function listarPorEntrega(executor, empresaId, entregaId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(entregaId, 'identificador de entrega');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_LEITURA} ${JUNCAO_LEITURA} WHERE i.empresa_id = $1 AND i.entrega_id = $2 ORDER BY i.id`,
    [empresaId, entregaId],
  );
  return rows.map(mapearLeitura);
}

/** Itens de várias entregas da empresa, agrupáveis por entregaId, na ordem de gravação. */
async function listarPorEntregas(executor, empresaId, entregaIds) {
  exigirId(empresaId, 'identificador de empresa');
  if (!Array.isArray(entregaIds)) throw new TypeError('lista de entregas inválida');
  if (entregaIds.length === 0) return [];
  for (const id of entregaIds) exigirId(id, 'identificador de entrega');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_LEITURA} ${JUNCAO_LEITURA} WHERE i.empresa_id = $1 AND i.entrega_id = ANY($2::int[]) ORDER BY i.entrega_id, i.id`,
    [empresaId, entregaIds],
  );
  return rows.map(mapearLeitura);
}

module.exports = { MOTIVOS, JUSTIFICATIVA_MAXIMA, criar, listarPorEntrega, listarPorEntregas };
