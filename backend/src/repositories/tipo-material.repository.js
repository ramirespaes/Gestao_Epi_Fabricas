'use strict';

const { escaparCoringasLike } = require('../utils/like');

/**
 * Catálogo de tipos de material por empresa (tipos_material, migration 082). Só o que a API expõe sai daqui
 * (id, grupo, grupoProtecao, nome, ativo, origem); grupo, proteção, nome e origem são imutáveis no banco (gatilho),
 * então a única escrita depois de criar é `ativo`. Toda consulta filtra pela empresa.
 */

const PROJECAO = 'id, empresa_id, grupo, grupo_protecao, nome, ativo, origem';
const LIMITE_MAXIMO = 100;
const INDICE_UNICIDADE = 'uq_tipos_material_empresa_grupo_nome';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const mapear = (l) => (l === undefined ? null : {
  id: l.id, grupo: l.grupo, grupoProtecao: l.grupo_protecao, nome: l.nome, ativo: l.ativo, origem: l.origem,
});

function filtros({ grupo = null, grupoProtecao = null, ativo = null, busca = null } = {}) {
  for (const [v, n] of [[grupo, 'grupo'], [grupoProtecao, 'grupo de proteção'], [busca, 'busca']]) {
    if (v !== null && (typeof v !== 'string' || v.length === 0)) throw new TypeError(`filtro ${n} inválido`);
  }
  if (ativo !== null && typeof ativo !== 'boolean') throw new TypeError('filtro ativo inválido');
  return [grupo, grupoProtecao, ativo, busca === null ? null : escaparCoringasLike(busca)];
}

const CONDICAO = `WHERE empresa_id = $1
    AND ($2::text IS NULL OR grupo = $2::text)
    AND ($3::text IS NULL OR grupo_protecao = $3::text)
    AND ($4::boolean IS NULL OR ativo = $4::boolean)
    AND ($5::text IS NULL OR nome ILIKE '%' || $5::text || '%')`;

async function listar(executor, empresaId, { pagina = 1, limite = 20, ...f } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM tipos_material ${CONDICAO} ORDER BY grupo, grupo_protecao, lower(nome), id LIMIT $6 OFFSET $7`,
    [empresaId, ...filtros(f), limite, (pagina - 1) * limite],
  );
  return rows.map(mapear);
}

async function contar(executor, empresaId, f = {}) {
  exigirId(empresaId, 'identificador de empresa');
  const { rows } = await executor.query(`SELECT count(*)::int AS total FROM tipos_material ${CONDICAO}`, [empresaId, ...filtros(f)]);
  return rows[0].total;
}

async function buscarPorId(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de tipo');
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM tipos_material WHERE empresa_id = $1 AND id = $2`, [empresaId, id]);
  return mapear(rows[0]);
}

async function buscarPorIdParaAtualizacao(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de tipo');
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM tipos_material WHERE empresa_id = $1 AND id = $2 FOR UPDATE`, [empresaId, id]);
  return mapear(rows[0]);
}

/**
 * Leitura travada com FOR SHARE (dentro de transação) para quem vai VINCULAR este tipo (GHE × tipo): a inativação
 * concorrente trava a linha com FOR UPDATE e espera o COMMIT de quem vincula, e quem vincula depois dela lê a linha
 * já inativa. A FK composta garante empresa e existência, nunca `ativo`. Várias vinculações concorrentes coexistem.
 */
async function buscarPorIdParaVinculo(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de tipo');
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM tipos_material WHERE empresa_id = $1 AND id = $2 FOR SHARE`, [empresaId, id]);
  return mapear(rows[0]);
}

/** Vários ids de uma vez (resposta do material: `tipoMaterialAtivo`). */
async function listarPorIds(executor, empresaId, ids) {
  exigirId(empresaId, 'identificador de empresa');
  if (!Array.isArray(ids)) throw new TypeError('lista de ids inválida');
  ids.forEach((id) => exigirId(id, 'identificador de tipo'));
  if (ids.length === 0) return [];
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM tipos_material WHERE empresa_id = $1 AND id = ANY($2::int[])`, [empresaId, ids]);
  return rows.map(mapear);
}

async function criar(executor, { empresaId, grupo, grupoProtecao, nome, origem = 'MANUAL' }) {
  exigirId(empresaId, 'identificador de empresa');
  for (const [v, n] of [[grupo, 'grupo'], [grupoProtecao, 'grupo de proteção'], [nome, 'nome'], [origem, 'origem']]) {
    if (typeof v !== 'string' || v.length === 0) throw new TypeError(`${n} inválido`);
  }
  const { rows } = await executor.query(
    `INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome, origem) VALUES ($1, $2, $3, $4, $5) RETURNING ${PROJECAO}`,
    [empresaId, grupo, grupoProtecao, nome, origem],
  );
  return mapear(rows[0]);
}

async function atualizarAtivo(executor, empresaId, id, ativo) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de tipo');
  if (typeof ativo !== 'boolean') throw new TypeError('ativo inválido');
  const { rows } = await executor.query(
    `UPDATE tipos_material SET ativo = $3 WHERE empresa_id = $1 AND id = $2 RETURNING ${PROJECAO}`,
    [empresaId, id, ativo],
  );
  return mapear(rows[0]);
}

/**
 * Catálogo base da empresa (origem BASE), idempotente: a unicidade lógica ignora o que já existe. Devolve quantas
 * linhas entraram. Usado no cadastro da empresa; a 082 faz o mesmo, em SQL, para as empresas já existentes.
 */
async function semearCatalogoBase(executor, empresaId, catalogo) {
  exigirId(empresaId, 'identificador de empresa');
  if (!Array.isArray(catalogo) || catalogo.length === 0) throw new TypeError('catálogo base inválido');
  const { rowCount } = await executor.query(
    `INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome, origem)
     SELECT $1, c.grupo, c.grupo_protecao, c.nome, 'BASE'
       FROM unnest($2::text[], $3::text[], $4::text[]) AS c (grupo, grupo_protecao, nome)
         ON CONFLICT DO NOTHING`,
    [empresaId, catalogo.map((t) => t.grupo), catalogo.map((t) => t.grupoProtecao), catalogo.map((t) => t.nome)],
  );
  return rowCount;
}

module.exports = {
  LIMITE_MAXIMO, INDICE_UNICIDADE, listar, contar, buscarPorId, buscarPorIdParaAtualizacao, buscarPorIdParaVinculo, listarPorIds, criar, atualizarAtivo, semearCatalogoBase,
};
