'use strict';

const { ipParaGravar, dispositivoParaGravar } = require('../utils/origem-requisicao');

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
 *
 * IP e User-Agent são cortados aqui no tamanho das colunas (45 e 150):
 * vêm do cliente, e nenhum serviço precisa lembrar de cortar (SEC-002).
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
  const ipGravado = ipParaGravar(ip);
  const dispositivoGravado = dispositivoParaGravar(dispositivo);

  // perfil_ator (079): o perfil que o ator tem AGORA, lido na mesma instrução. Fica gravado como o perfil de então.
  // Sem usuário (evento automático) ou usuário de outra empresa, fica nulo.
  const { rows } = await executor.query(
    `INSERT INTO logs_auditoria
       (empresa_id, usuario_id, acao, referencia, descricao, ip, dispositivo, contexto, dados_anteriores, dados_novos, perfil_ator)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             (SELECT u.perfil FROM usuarios u WHERE u.empresa_id = $1 AND u.id = $2))
     RETURNING id, criado_em`,
    [empresaId, usuarioId, acao, referencia, descricao, ipGravado, dispositivoGravado, contexto, dadosAnteriores, dadosNovos],
  );

  return { id: rows[0].id, criadoEm: rows[0].criado_em };
}

/**
 * Há registro do mesmo ator, ação e referência na janela? Só leitura, para a
 * supressão da auditoria de recusa (12C-3). A janela corre pelo relógio da
 * consulta (clock_timestamp), não pelo do início da transação. Atende-se pelos
 * índices de empresa e usuário e pelo de criado_em; sem índice novo.
 */
async function existeRecente(executor, {
  empresaId, usuarioId, acao, referencia, janelaSegundos,
}) {
  exigirEmpresa(empresaId);
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) throw new TypeError('identificador de usuário inválido');
  exigirAcao(acao);
  // logs_auditoria.referencia: VARCHAR(150).
  if (typeof referencia !== 'string' || referencia.length === 0 || referencia.length > 150) throw new TypeError('referência de auditoria inválida');
  if (!Number.isInteger(janelaSegundos) || janelaSegundos < 1 || janelaSegundos > 3600) throw new TypeError('janela em segundos inválida');

  const { rows } = await executor.query(
    `SELECT 1
       FROM logs_auditoria
      WHERE empresa_id = $1 AND usuario_id = $2 AND acao = $3 AND referencia = $4
        AND criado_em > clock_timestamp() - make_interval(secs => $5)
      LIMIT 1`,
    [empresaId, usuarioId, acao, referencia, janelaSegundos],
  );
  return rows.length > 0;
}

module.exports = { registrar, existeRecente };
