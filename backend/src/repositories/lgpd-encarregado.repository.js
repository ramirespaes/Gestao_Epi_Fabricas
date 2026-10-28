'use strict';

/**
 * Encarregado pelo tratamento de dados pessoais (DPO) — tabela lgpd_encarregados (migration 094). Só SQL parametrizado,
 * sempre filtrado pela empresa; nenhuma regra de negócio. A linha nunca é apagada; "encerrar" é o único UPDATE (o gatilho da
 * 094 recusa qualquer outro) e leva a versão esperada, para o serviço detectar concorrência.
 *
 * As colunas legadas empresas.dpo_* (001) NÃO são lidas nem escritas aqui: a fonte de verdade é só esta tabela.
 */

const FUNCOES = Object.freeze(['PRINCIPAL', 'SUBSTITUTO']);

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) throw new TypeError('identificador de empresa inválido');
}
function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const PROJECAO = `id, empresa_id, funcao, tipo_pessoa, nome, razao_social, cnpj, vinculo, cargo, email, telefone,
  inicio_em::text AS inicio_em, fim_em::text AS fim_em, situacao, ato_referencia, ato_data::text AS ato_data,
  conflito_interesses, conflito_nota, motivo_encerramento, substitui_id, substituida_por_id, versao, designado_por, encerrado_por,
  criado_em, atualizado_em`;

const mapear = (r) => ({
  id: Number(r.id),
  empresaId: r.empresa_id,
  funcao: r.funcao,
  tipoPessoa: r.tipo_pessoa,
  nome: r.nome,
  razaoSocial: r.razao_social,
  cnpj: r.cnpj, // CHAR(14) canônico ou null (PF, ou PJ anterior à 095)
  vinculo: r.vinculo,
  cargo: r.cargo,
  email: r.email,
  telefone: r.telefone,
  inicioEm: r.inicio_em,
  fimEm: r.fim_em,
  situacao: r.situacao,
  atoReferencia: r.ato_referencia,
  atoData: r.ato_data,
  conflitoInteresses: r.conflito_interesses,
  conflitoNota: r.conflito_nota,
  motivoEncerramento: r.motivo_encerramento,
  substituiId: r.substitui_id === null ? null : Number(r.substitui_id),
  substituidaPorId: r.substituida_por_id === null ? null : Number(r.substituida_por_id),
  versao: r.versao,
  designadoPor: r.designado_por,
  encerradoPor: r.encerrado_por,
  criadoEm: r.criado_em,
  atualizadoEm: r.atualizado_em,
});

/** { principal, substituto } vigentes (null quando não há). */
async function listarVigentes(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM lgpd_encarregados WHERE empresa_id = $1 AND fim_em IS NULL`,
    [empresaId],
  );
  const vigentes = { principal: null, substituto: null };
  for (const r of rows) vigentes[r.funcao === 'PRINCIPAL' ? 'principal' : 'substituto'] = mapear(r);
  return vigentes;
}

async function listarHistorico(executor, empresaId, { limite = 200 } = {}) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM lgpd_encarregados WHERE empresa_id = $1 ORDER BY inicio_em DESC, id DESC LIMIT $2`,
    [empresaId, limite],
  );
  return rows.map(mapear);
}

async function buscarPorId(executor, empresaId, id, { travar = false } = {}) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador do encarregado');
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM lgpd_encarregados WHERE empresa_id = $1 AND id = $2${travar ? ' FOR UPDATE' : ''}`,
    [empresaId, id],
  );
  return rows.length === 0 ? null : mapear(rows[0]);
}

async function inserir(executor, {
  empresaId, funcao, tipoPessoa, nome, razaoSocial, cnpj = null, vinculo, cargo, email, telefone, inicioEm, atoReferencia, atoData,
  conflitoInteresses, conflitoNota, substituiId, designadoPor,
}) {
  exigirEmpresa(empresaId);
  exigirId(designadoPor, 'identificador do ator');
  if (!FUNCOES.includes(funcao)) throw new TypeError('função inválida');
  const { rows } = await executor.query(
    `INSERT INTO lgpd_encarregados
       (empresa_id, funcao, tipo_pessoa, nome, razao_social, cnpj, vinculo, cargo, email, telefone, inicio_em, ato_referencia, ato_data,
        conflito_interesses, conflito_nota, substitui_id, designado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${PROJECAO}`,
    [empresaId, funcao, tipoPessoa, nome, razaoSocial, cnpj, vinculo, cargo, email, telefone, inicioEm, atoReferencia, atoData,
      conflitoInteresses, conflitoNota, substituiId, designadoPor],
  );
  return mapear(rows[0]);
}

/**
 * Encerra uma designação VIGENTE com a versão esperada. Devolve a linha encerrada ou null quando a versão não confere ou a
 * linha já não está vigente (o serviço decide o 409).
 */
async function encerrar(executor, {
  empresaId, id, versaoEsperada, fimEm, motivo, encerradoPor,
}) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador do encarregado');
  exigirId(versaoEsperada, 'versão esperada');
  exigirId(encerradoPor, 'identificador do ator');
  const { rows } = await executor.query(
    `UPDATE lgpd_encarregados
        SET fim_em = $4, situacao = 'ENCERRADA', motivo_encerramento = $5, encerrado_por = $6, versao = versao + 1
      WHERE empresa_id = $1 AND id = $2 AND versao = $3 AND fim_em IS NULL
      RETURNING ${PROJECAO}`,
    [empresaId, id, versaoEsperada, fimEm, motivo, encerradoPor],
  );
  return rows.length === 0 ? null : mapear(rows[0]);
}

/** Grava na designação já encerrada o vínculo com a sucessora (única alteração que o gatilho da 094 admite numa encerrada). */
async function vincularSucessora(executor, { empresaId, id, sucessoraId }) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador do encarregado');
  exigirId(sucessoraId, 'identificador da sucessora');
  const { rows } = await executor.query(
    `UPDATE lgpd_encarregados SET substituida_por_id = $3
      WHERE empresa_id = $1 AND id = $2 AND situacao = 'ENCERRADA' AND substituida_por_id IS NULL
      RETURNING id`,
    [empresaId, id, sucessoraId],
  );
  return rows.length === 1;
}

module.exports = {
  FUNCOES, listarVigentes, listarHistorico, buscarPorId, inserir, encerrar, vincularSucessora,
};
