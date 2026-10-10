'use strict';

const { escaparCoringasLike } = require('../utils/like');
const sqlPosicao = require('./sql/posicao-estoque');
const sqlPrevisto = require('./sql/previsto-ghe');

/**
 * Leituras do contexto para realizar uma entrega (10E): os materiais ativos
 * da empresa com a marca "previsto no GHE" do trabalhador, e os lotes com
 * saldo de um material com a situação do CA na data operacional. Só
 * leitura, sempre por empresa; nada aqui altera material ou lote.
 */

const DATA_FORMATO = /^\d{4}-\d{2}-\d{2}$/;
const LIMITE_MAXIMO = 100;

// Regra única de "previsto no GHE" (vínculo direto OU por tipo): sql/previsto-ghe.js. $2 = GHE do trabalhador.
const PREVISTO = sqlPrevisto.previstoNoGhe({ material: 'm', ghe: '$2' });

const FILTRO_MATERIAIS = `FROM materiais m
  WHERE m.empresa_id = $1 AND m.ativo
    AND ($3::text IS NULL OR m.nome ILIKE '%' || $3::text || '%' OR m.codigo_interno ILIKE '%' || $3::text || '%')
    AND ($4::boolean IS NULL OR ${PREVISTO} = $4::boolean)`;

// A mesma leitura do CA do estoque (definição única em sql/posicao-estoque.js): vence
// no fim do dia da validade; material que dispensa CA nunca é classificado por
// validade. Nesta consulta a data é $3 e não há dias de alerta.
const SITUACAO_CA = sqlPosicao.situacaoCa({ lote: 'l', material: 'm', hoje: '$3' });

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function filtrosDeMateriais(empresaId, { gheId = null, busca = null, previstoNoGhe = null } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  if (gheId !== null) exigirId(gheId, 'identificador de GHE');
  if (busca !== null && (typeof busca !== 'string' || busca.length === 0)) throw new TypeError('busca inválida');
  if (previstoNoGhe !== null && typeof previstoNoGhe !== 'boolean') throw new TypeError('previstoNoGhe inválido');
  return [empresaId, gheId, busca === null ? null : escaparCoringasLike(busca), previstoNoGhe];
}

const mapearMaterial = (m) => ({
  id: m.id,
  nome: m.nome,
  codigoInterno: m.codigo_interno ?? null,
  tipo: m.tipo,
  unidade: m.unidade,
  prazoUsoDias: m.prazo_uso_dias,
  exigeTamanho: m.exige_tamanho ?? null,
  oculosComGrau: m.oculos_com_grau ?? null,
  exigeCa: m.exige_ca,
  previstoNoGhe: m.previsto_no_ghe,
});

/** Materiais ativos da empresa para seleção na entrega; sem GHE, nenhum é previsto. */
async function listarMateriais(executor, empresaId, { pagina, limite, ...filtros }) {
  const parametros = filtrosDeMateriais(empresaId, filtros);
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT m.id, m.nome, m.codigo_interno, m.tipo, m.unidade, m.prazo_uso_dias, m.exige_tamanho, m.oculos_com_grau, m.exige_ca,
            ${PREVISTO} AS previsto_no_ghe
       ${FILTRO_MATERIAIS}
      ORDER BY lower(m.nome), m.id
      LIMIT $5 OFFSET $6`,
    [...parametros, limite, (pagina - 1) * limite],
  );
  return rows.map(mapearMaterial);
}

async function contarMateriais(executor, empresaId, filtros) {
  const { rows } = await executor.query(`SELECT count(*)::int AS total ${FILTRO_MATERIAIS}`, filtrosDeMateriais(empresaId, filtros));
  return rows[0].total;
}

/** Lotes com saldo do material, validade mais próxima primeiro (sem CA por último), id como desempate. */
async function listarLotes(executor, empresaId, materialId, hoje) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(materialId, 'identificador de material');
  if (typeof hoje !== 'string' || !DATA_FORMATO.test(hoje)) throw new TypeError('data operacional inválida');
  const { rows } = await executor.query(
    `SELECT l.id, l.tamanho, l.ca_numero, to_char(l.ca_validade, 'YYYY-MM-DD') AS ca_validade, l.saldo, ${SITUACAO_CA} AS situacao_ca
       FROM estoque_lotes l
       JOIN materiais m ON m.empresa_id = l.empresa_id AND m.id = l.material_id
      WHERE l.empresa_id = $1 AND l.material_id = $2 AND l.saldo > 0
      ORDER BY l.ca_validade ASC NULLS LAST, l.id ASC`,
    [empresaId, materialId, hoje],
  );
  return rows.map((l) => ({
    loteId: l.id, tamanho: l.tamanho, caNumero: l.ca_numero, caValidade: l.ca_validade, saldo: l.saldo, situacaoCa: l.situacao_ca,
  }));
}

// Só trabalhadores ATIVOS, por nome ou matrícula (nunca CPF); o GHE atual vem junto.
const FILTRO_FUNCIONARIOS = `FROM funcionarios f
  LEFT JOIN grupos_homogeneos_exposicao g ON g.empresa_id = f.empresa_id AND g.id = f.grupo_homogeneo_id
  WHERE f.empresa_id = $1 AND f.ativo
    AND ($2::text IS NULL OR f.nome ILIKE '%' || $2::text || '%' OR f.matricula ILIKE '%' || $2::text || '%')`;

function filtrosDeFuncionarios(empresaId, { busca = null } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  if (busca !== null && (typeof busca !== 'string' || busca.length === 0)) throw new TypeError('busca inválida');
  return [empresaId, busca === null ? null : escaparCoringasLike(busca)];
}

const mapearFuncionario = (l) => ({
  id: l.id,
  nome: l.nome,
  matricula: l.matricula,
  cpf: l.cpf,
  setor: l.setor,
  funcao: l.funcao,
  ativo: l.ativo,
  ghe: l.ghe_id === null ? null : { id: l.ghe_id, nome: l.ghe_nome },
});

/** Trabalhadores ativos da empresa para seleção na entrega, por nome. */
async function listarFuncionarios(executor, empresaId, { pagina, limite, ...filtros }) {
  const parametros = filtrosDeFuncionarios(empresaId, filtros);
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT f.id, f.nome, f.matricula, f.cpf, f.setor, f.funcao, f.ativo, g.id AS ghe_id, g.nome AS ghe_nome
       ${FILTRO_FUNCIONARIOS}
      ORDER BY lower(f.nome), f.id
      LIMIT $3 OFFSET $4`,
    [...parametros, limite, (pagina - 1) * limite],
  );
  return rows.map(mapearFuncionario);
}

async function contarFuncionarios(executor, empresaId, filtros) {
  const { rows } = await executor.query(`SELECT count(*)::int AS total ${FILTRO_FUNCIONARIOS}`, filtrosDeFuncionarios(empresaId, filtros));
  return rows[0].total;
}

module.exports = { listarMateriais, contarMateriais, listarLotes, listarFuncionarios, contarFuncionarios };
