'use strict';

const { exigirIdGrande } = require('../utils/identificador-grande');

/**
 * Vínculo material × imagem. A imagem pertence ao MATERIAL, por identificador: o vínculo mora nas colunas `imagem_padrao_id` e
 * `imagem_empresa_id` de `materiais` (migration 090, no máximo uma preenchida) e é o ÚNICO vínculo do sistema: o catálogo do Totem lê o mesmo.
 * Executor por parâmetro; nenhuma regra de negócio. A empresa filtra tudo; a FK composta do banco é a última barreira contra imagem de outra
 * empresa. Ids de imagem (BIGINT) saem como string decimal; ids de material são inteiros.
 */

const INT_MAXIMO = 2147483647;

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) throw new TypeError('identificador de empresa inválido');
}
function exigirMaterial(id) {
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAXIMO) throw new TypeError('identificador de material inválido');
}
function exigirIdsDeMaterial(ids) {
  if (!Array.isArray(ids)) throw new TypeError('lista de identificadores de material inválida');
  ids.forEach(exigirMaterial);
}

/** Troca a imagem do material: uma das duas colunas (ou nenhuma, para soltar). Devolve se o material da empresa existia. */
async function definir(executor, empresaId, materialId, { imagemPadraoId = null, imagemEmpresaId = null } = {}) {
  exigirEmpresa(empresaId);
  exigirMaterial(materialId);
  const padrao = imagemPadraoId === null ? null : exigirIdGrande(imagemPadraoId, 'identificador de imagem padrão');
  const empresa = imagemEmpresaId === null ? null : exigirIdGrande(imagemEmpresaId, 'identificador de imagem da empresa');
  if (padrao !== null && empresa !== null) throw new TypeError('o material tem no máximo uma imagem');
  const { rows } = await executor.query(
    `UPDATE materiais SET imagem_padrao_id = $3::bigint, imagem_empresa_id = $4::bigint WHERE empresa_id = $1 AND id = $2 RETURNING id`,
    [empresaId, materialId, padrao, empresa],
  );
  return rows.length > 0;
}

/** Mapa material → `{ origem, id, versao, nome }` dos materiais da empresa que têm imagem (sem imagem: ausente do mapa). Sem N+1. */
async function obterPorMateriais(executor, empresaId, ids) {
  exigirEmpresa(empresaId);
  exigirIdsDeMaterial(ids);
  const mapa = new Map();
  if (ids.length === 0) return mapa;
  const { rows } = await executor.query(
    `SELECT m.id AS material_id, 'EMPRESA' AS origem, i.id AS imagem_id, i.versao, i.nome
       FROM materiais m JOIN imagens_empresa i ON i.empresa_id = m.empresa_id AND i.id = m.imagem_empresa_id
      WHERE m.empresa_id = $1 AND m.id = ANY($2::int[])
     UNION ALL
     SELECT m.id, 'PADRAO', p.id, p.versao, p.nome
       FROM materiais m JOIN imagens_padrao p ON p.id = m.imagem_padrao_id
      WHERE m.empresa_id = $1 AND m.id = ANY($2::int[])`,
    [empresaId, ids],
  );
  for (const l of rows) mapa.set(l.material_id, { origem: l.origem, id: String(l.imagem_id), versao: l.versao, nome: l.nome });
  return mapa;
}

async function obterPorMaterial(executor, empresaId, materialId) {
  exigirMaterial(materialId);
  return (await obterPorMateriais(executor, empresaId, [materialId])).get(materialId) ?? null;
}

/**
 * Quantos materiais DESTA empresa usam cada imagem. Para a imagem padrão só conta a própria empresa (o uso de outras empresas nunca vaza).
 * @returns {Promise<{ padrao: Map<string, number>, empresa: Map<string, number> }>}
 */
async function contarUsos(executor, empresaId, { padraoIds = [], empresaIds = [] } = {}) {
  exigirEmpresa(empresaId);
  const normalizar = (lista) => lista.map((v) => exigirIdGrande(v, 'identificador de imagem'));
  const padrao = normalizar(padraoIds);
  const empresa = normalizar(empresaIds);
  const resultado = { padrao: new Map(), empresa: new Map() };
  if (padrao.length === 0 && empresa.length === 0) return resultado;
  const { rows } = await executor.query(
    `SELECT 'PADRAO' AS origem, imagem_padrao_id AS id, count(*)::int AS n FROM materiais
      WHERE empresa_id = $1 AND imagem_padrao_id = ANY($2::bigint[]) GROUP BY imagem_padrao_id
     UNION ALL
     SELECT 'EMPRESA', imagem_empresa_id, count(*)::int FROM materiais
      WHERE empresa_id = $1 AND imagem_empresa_id = ANY($3::bigint[]) GROUP BY imagem_empresa_id`,
    [empresaId, padrao, empresa],
  );
  for (const l of rows) resultado[l.origem === 'PADRAO' ? 'padrao' : 'empresa'].set(String(l.id), l.n);
  return resultado;
}

module.exports = { definir, obterPorMateriais, obterPorMaterial, contarUsos };
