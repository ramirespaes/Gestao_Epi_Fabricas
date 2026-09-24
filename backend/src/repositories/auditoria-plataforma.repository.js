'use strict';

/**
 * Repositório de auditoria da PLATAFORMA (logs_auditoria_plataforma,
 * migration 029 — Autenticação Global, Pacote 2). Espelha
 * `auditoria.repository.js` (logs_auditoria) quase exatamente — mesma
 * disciplina de "só persiste o que recebe", mesma responsabilidade de quem
 * chama nunca incluir senha/hash/token/segredo em contexto/dados_*
 * (o banco também recusa, pela mesma função `logs_auditoria_bloquear_
 * dado_sensivel` reaproveitada na 029).
 *
 * Diferença de forma: `administrador_id` é OBRIGATÓRIO (toda ação de
 * plataforma tem um autor identificado; não existe ação anônima aqui, ao
 * contrário de `logs_auditoria.usuario_id`, que é nulável) e
 * `empresa_afetada_id` é OPCIONAL (nem toda ação de plataforma mira uma
 * empresa).
 */

function exigirAdministrador(administradorId) {
  if (!Number.isInteger(administradorId) || administradorId <= 0) {
    throw new TypeError('identificador de administrador inválido');
  }
}

function exigirEmpresaOpcional(empresaId) {
  if (empresaId !== null && (!Number.isInteger(empresaId) || empresaId <= 0)) {
    throw new TypeError('identificador de empresa afetada inválido');
  }
}

function exigirAcao(acao) {
  if (typeof acao !== 'string' || acao.length === 0 || acao.length > 60) {
    throw new TypeError('código de ação de auditoria inválido');
  }
}

function exigirObjetoOpcional(valor, nome) {
  if (valor === null) {
    return;
  }
  if (typeof valor !== 'object' || Array.isArray(valor)) {
    throw new TypeError(`${nome} deve ser um objeto ou null`);
  }
}

/**
 * Grava uma linha de auditoria da plataforma. Propaga qualquer erro do
 * PostgreSQL sem traduzir — inclusive a rejeição por chave JSON sensível
 * (erro de programação do chamador, nunca um desfecho de negócio).
 *
 * @param {{query: Function}} executor
 * @param {{administradorId: number, empresaAfetadaId?: number|null, acao: string,
 *          referencia?: string|null, descricao?: string|null, ip?: string|null,
 *          dispositivo?: string|null, contexto?: object|null,
 *          dadosAnteriores?: object|null, dadosNovos?: object|null}} dados
 * @returns {Promise<{id: string, criadoEm: Date}>}
 */
async function registrar(executor, {
  administradorId,
  empresaAfetadaId = null,
  acao,
  referencia = null,
  descricao = null,
  ip = null,
  dispositivo = null,
  contexto = null,
  dadosAnteriores = null,
  dadosNovos = null,
}) {
  exigirAdministrador(administradorId);
  exigirEmpresaOpcional(empresaAfetadaId);
  exigirAcao(acao);
  exigirObjetoOpcional(contexto, 'contexto');
  exigirObjetoOpcional(dadosAnteriores, 'dadosAnteriores');
  exigirObjetoOpcional(dadosNovos, 'dadosNovos');

  const { rows } = await executor.query(
    `INSERT INTO logs_auditoria_plataforma
       (administrador_id, empresa_afetada_id, acao, referencia, descricao, ip, dispositivo, contexto, dados_anteriores, dados_novos)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, criado_em`,
    [administradorId, empresaAfetadaId, acao, referencia, descricao, ip, dispositivo, contexto, dadosAnteriores, dadosNovos],
  );

  return { id: rows[0].id, criadoEm: rows[0].criado_em };
}

module.exports = { registrar };
