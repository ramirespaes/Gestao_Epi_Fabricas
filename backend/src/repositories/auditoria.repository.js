'use strict';

/**
 * Repositório de auditoria (logs_auditoria, migrations 012 e 014).
 *
 * Único ponto de escrita nesta tabela — que é append-only por desenho:
 * nenhum UPDATE/DELETE/TRUNCATE é sequer tentado aqui, e o próprio banco
 * os rejeitaria (triggers da migration 012). Primeiro código do projeto a
 * gravar em logs_auditoria (Bloco 8, Incremento 8, Etapa 5A, Subetapa 3I):
 * a migration 014 já previa "uma função central de redação da aplicação"
 * como primeira barreira contra dados sensíveis; ela ainda não existe, e
 * este repositório NÃO a substitui — só persiste o que recebe. A
 * responsabilidade de NUNCA incluir senha, hash, token, cookie, secret,
 * credencial ou chave privada em contexto/dados_anteriores/dados_novos é
 * de quem chama (hoje, só o serviço de autorizações individuais, que
 * grava exclusivamente ids, códigos de ação e booleanos). O banco impõe
 * a mesma regra por trigger (migration 014) como segunda barreira, e
 * também limita cada JSONB a objeto de no máximo 16 KiB.
 *
 * Mesmo padrão dos demais repositórios: executor por parâmetro (nunca o
 * pool global), validação de formato via exigir*, nenhuma regra de
 * negócio. Os objetos JS passados em contexto/dadosAnteriores/dadosNovos
 * são serializados pelo próprio driver `pg` (JSON.stringify automático
 * para objetos em parâmetros) e convertidos para JSONB pela coluna.
 */

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

function exigirUsuarioOpcional(usuarioId) {
  if (usuarioId !== null && (!Number.isInteger(usuarioId) || usuarioId <= 0)) {
    throw new TypeError('identificador de usuário inválido');
  }
}

// logs_auditoria.acao: VARCHAR(60) NOT NULL. Não é FK para o catálogo
// `acoes` (migration 012) — é um espaço de códigos próprio da auditoria.
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
 * Grava uma linha de auditoria. Propaga qualquer erro do PostgreSQL sem
 * traduzir (inclusive a rejeição por chave JSON sensível da migration 014,
 * que é um erro de programação do chamador, nunca um desfecho de negócio).
 *
 * @param {{query: Function}} executor
 * @param {{empresaId: number, usuarioId?: number|null, acao: string, referencia?: string|null, descricao?: string|null, ip?: string|null, dispositivo?: string|null, contexto?: object|null, dadosAnteriores?: object|null, dadosNovos?: object|null}} dados
 * @returns {Promise<{id: string, criadoEm: Date}>} id vem como string: BIGINT do PostgreSQL não cabe com segurança em Number
 */
async function registrar(executor, {
  empresaId,
  usuarioId = null,
  acao,
  referencia = null,
  descricao = null,
  ip = null,
  dispositivo = null,
  contexto = null,
  dadosAnteriores = null,
  dadosNovos = null,
}) {
  exigirEmpresa(empresaId);
  exigirUsuarioOpcional(usuarioId);
  exigirAcao(acao);
  exigirObjetoOpcional(contexto, 'contexto');
  exigirObjetoOpcional(dadosAnteriores, 'dadosAnteriores');
  exigirObjetoOpcional(dadosNovos, 'dadosNovos');

  const { rows } = await executor.query(
    `INSERT INTO logs_auditoria
       (empresa_id, usuario_id, acao, referencia, descricao, ip, dispositivo, contexto, dados_anteriores, dados_novos)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, criado_em`,
    [empresaId, usuarioId, acao, referencia, descricao, ip, dispositivo, contexto, dadosAnteriores, dadosNovos],
  );

  return { id: rows[0].id, criadoEm: rows[0].criado_em };
}

module.exports = { registrar };
