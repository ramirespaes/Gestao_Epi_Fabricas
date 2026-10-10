'use strict';

const crypto = require('node:crypto');
const cooldown = require('../security/cooldown');

/**
 * Leituras e travas da importação GHE/EPI: a fotografia do banco da EMPRESA, em lote — uma consulta por assunto, nunca
 * uma por linha da planilha (5B), e as travas que a confirmação (5C) toma antes de escrever. Sempre filtrado por empresa_id.
 * A escrita em si usa os repositórios de GHE e de GHE × tipo (os mesmos do CRUD).
 */

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

async function listarGhes(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    'SELECT id, codigo, nome, ativo FROM grupos_homogeneos_exposicao WHERE empresa_id = $1 ORDER BY id', [empresaId],
  );
  return rows.map((l) => ({ id: l.id, codigo: l.codigo, nome: l.nome, ativo: l.ativo }));
}

async function listarTipos(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query('SELECT id, nome, ativo FROM tipos_material WHERE empresa_id = $1 ORDER BY id', [empresaId]);
  return rows.map((l) => ({ id: l.id, nome: l.nome, ativo: l.ativo }));
}

async function listarVinculos(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    'SELECT grupo_homogeneo_id, tipo_material_id, classificacao FROM ghe_tipos_material WHERE empresa_id = $1 ORDER BY id', [empresaId],
  );
  return rows.map((l) => ({ gheId: l.grupo_homogeneo_id, tipoId: l.tipo_material_id, classificacao: l.classificacao }));
}

/** Trava de transação, por empresa, só da CONFIRMAÇÃO da importação (granular: o preview e o resto do sistema não esperam). */
function travaDaImportacao(empresaId) {
  const digest = crypto.createHash('sha256').update(`GHE_IMPORTACAO\n${empresaId}`, 'utf8').digest('hex');
  return cooldown.derivarAdvisoryLock64(digest);
}

async function travarImportacaoDaEmpresa(executor, empresaId) {
  exigirEmpresa(empresaId);
  await executor.query('SELECT pg_advisory_xact_lock($1::bigint)', [travaDaImportacao(empresaId)]);
}

function exigirIds(ids) {
  if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id) && id > 0)) {
    throw new TypeError('ids inválidos');
  }
}

/**
 * Trava (FOR NO KEY UPDATE, em ordem de id) os GHEs que a confirmação vai tocar e devolve a versão TRAVADA, com os campos
 * do retrato de auditoria. Impede a inativação ou a edição manual concorrente até o COMMIT. O que sumiu não volta na lista.
 */
async function travarGhes(executor, empresaId, ids) {
  exigirEmpresa(empresaId);
  exigirIds(ids);
  const { rows } = await executor.query(
    `SELECT id, codigo, nome, ativo, descricao, setor, funcao, riscos FROM grupos_homogeneos_exposicao
      WHERE empresa_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR NO KEY UPDATE`,
    [empresaId, ids],
  );
  return rows.map((l) => ({ id: l.id, codigo: l.codigo, nome: l.nome, ativo: l.ativo, descricao: l.descricao, setor: l.setor, funcao: l.funcao, riscos: l.riscos }));
}

/** Trava (FOR SHARE, em ordem de id) os tipos que ganharão vínculo e devolve a versão travada (a inativação concorrente espera). */
async function travarTipos(executor, empresaId, ids) {
  exigirEmpresa(empresaId);
  exigirIds(ids);
  const { rows } = await executor.query(
    'SELECT id, nome, ativo FROM tipos_material WHERE empresa_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR SHARE', [empresaId, ids],
  );
  return rows.map((l) => ({ id: l.id, nome: l.nome, ativo: l.ativo }));
}

module.exports = { listarGhes, listarTipos, listarVinculos, travarImportacaoDaEmpresa, travarGhes, travarTipos };
