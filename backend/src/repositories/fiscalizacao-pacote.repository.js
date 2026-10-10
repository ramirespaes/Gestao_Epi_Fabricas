'use strict';

/**
 * Metadados dos pacotes de fiscalização (12K-D6, tabela fiscalizacao_pacotes da migration 080). Só persistência: as regras do
 * ciclo (idempotência, uma geração por empresa, estados finais imutáveis) são do serviço e do banco. O identificador do pacote é
 * o id da tabela (não há numeração própria por empresa). Toda consulta e toda atualização é filtrada pela empresa; o ZIP não passa
 * por aqui (só o SHA-256 e a chave de armazenamento, que o servidor gera).
 */

const PROJECAO = `p.id, p.empresa_id, to_char(p.periodo_inicio, 'YYYY-MM-DD') AS periodo_inicio,
  to_char(p.periodo_fim, 'YYYY-MM-DD') AS periodo_fim, p.finalidade, p.observacao, p.escopos, p.versao_formato, p.usuario_id,
  p.perfil_ator, p.criado_em, p.status, p.heartbeat_em, p.concluido_em, p.erro_codigo, p.contagens, p.nome_logico, p.tamanho_bytes,
  p.sha256, p.chave_armazenamento, p.chave_idempotencia, p.requisicao_hash, u.nome AS gerado_por_nome`;
const DE = `fiscalizacao_pacotes p
  LEFT JOIN usuarios u ON u.empresa_id = p.empresa_id AND u.id = p.usuario_id`;

/** Serializa, dentro da transação, a checagem de geração em andamento e a inserção de pacote da empresa. */
async function travarEmpresa(client, empresaId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('fiscalizacao_pacotes:' || $1::text, 0))", [empresaId]);
}

async function buscarPorChave(executor, empresaId, chaveIdempotencia) {
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM ${DE} WHERE p.empresa_id = $1 AND p.chave_idempotencia = $2`,
    [empresaId, chaveIdempotencia],
  );
  return rows[0] ?? null;
}

async function buscarPorId(executor, empresaId, id) {
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM ${DE} WHERE p.empresa_id = $1 AND p.id = $2`, [empresaId, id]);
  return rows[0] ?? null;
}

async function existeGerando(executor, empresaId) {
  const { rows } = await executor.query("SELECT 1 FROM fiscalizacao_pacotes WHERE empresa_id = $1 AND status = 'GERANDO' LIMIT 1", [empresaId]);
  return rows.length > 0;
}

async function inserirGerando(client, {
  empresaId, usuarioId, perfil, periodoInicio, periodoFim, finalidade, observacao, escopos, versaoFormato, chaveIdempotencia, requisicaoHash,
}) {
  const { rows } = await client.query(
    `INSERT INTO fiscalizacao_pacotes
       (empresa_id, periodo_inicio, periodo_fim, finalidade, observacao, escopos, versao_formato, usuario_id, perfil_ator,
        status, chave_idempotencia, requisicao_hash)
     VALUES ($1, $2::date, $3::date, $4, $5, $6::jsonb, $7, $8, $9, 'GERANDO', $10, $11)
     RETURNING id`,
    [empresaId, periodoInicio, periodoFim, finalidade, observacao, JSON.stringify(escopos), versaoFormato, usuarioId, perfil, chaveIdempotencia, requisicaoHash],
  );
  return buscarPorId(client, empresaId, rows[0].id);
}

/** Renova o heartbeat só enquanto a linha da empresa segue GERANDO; false = a tentativa já foi encerrada (ex.: recuperada como abandonada). */
async function renovarHeartbeat(executor, empresaId, id) {
  const { rowCount } = await executor.query(
    "UPDATE fiscalizacao_pacotes SET heartbeat_em = clock_timestamp() WHERE id = $1 AND empresa_id = $2 AND status = 'GERANDO'",
    [id, empresaId],
  );
  return rowCount === 1;
}

async function concluir(executor, empresaId, id, { contagens, nomeLogico, tamanhoBytes, sha256, chaveArmazenamento }) {
  const { rowCount } = await executor.query(
    `UPDATE fiscalizacao_pacotes
        SET status = 'CONCLUIDO', concluido_em = clock_timestamp(), contagens = $3::jsonb, nome_logico = $4, tamanho_bytes = $5,
            sha256 = $6, chave_armazenamento = $7
      WHERE id = $1 AND empresa_id = $2 AND status = 'GERANDO'`,
    [id, empresaId, JSON.stringify(contagens), nomeLogico, tamanhoBytes, sha256, chaveArmazenamento],
  );
  return rowCount === 1;
}

async function falhar(executor, empresaId, id, erroCodigo) {
  const { rowCount } = await executor.query(
    `UPDATE fiscalizacao_pacotes SET status = 'FALHA', erro_codigo = $3, concluido_em = clock_timestamp()
      WHERE id = $1 AND empresa_id = $2 AND status = 'GERANDO'`,
    [id, empresaId, erroCodigo],
  );
  return rowCount === 1;
}

/**
 * ROTINA GLOBAL INTERNA de recuperação (cron/serviço), propositalmente SEM empresa: recupera as gerações expiradas de todas as
 * empresas. Não é uma ação do usuário nem recebe empresa de requisição.
 *
 * Só RECLAMA a tentativa, sem mudar o status: seleciona as linhas GERANDO sem heartbeat há mais de `abandonoMs` com
 * FOR UPDATE SKIP LOCKED, dentro da transação do serviço. Duas rotinas concorrentes nunca assumem a mesma linha, e o heartbeat de
 * uma geração que ainda estivesse viva espera o fim da transação.
 *
 * O serviço localiza os artefatos órfãos por (empresa_id, id): é com esse par que o armazenamento nomeia o temporário e o ZIP
 * final, e por isso não é preciso persistir a chave de armazenamento enquanto o pacote está GERANDO. Remove os resíduos e SÓ
 * DEPOIS marca FALHA com falhar(...). Nunca promove a CONCLUIDO.
 */
async function reivindicarAbandonados(client, abandonoMs) {
  const { rows } = await client.query(
    `SELECT id, empresa_id FROM fiscalizacao_pacotes
      WHERE status = 'GERANDO' AND heartbeat_em < clock_timestamp() - ($1::int * interval '1 millisecond')
      ORDER BY id FOR UPDATE SKIP LOCKED`,
    [abandonoMs],
  );
  return rows;
}

async function listar(executor, empresaId, { pagina, limite }) {
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM ${DE} WHERE p.empresa_id = $1 ORDER BY p.id DESC LIMIT $2 OFFSET $3`,
    [empresaId, limite, (pagina - 1) * limite],
  );
  return rows;
}

async function contar(executor, empresaId) {
  const { rows } = await executor.query('SELECT count(*)::int AS n FROM fiscalizacao_pacotes WHERE empresa_id = $1', [empresaId]);
  return rows[0].n;
}

async function buscarEmpresa(executor, empresaId) {
  const { rows } = await executor.query('SELECT nome, cnpj FROM empresas WHERE id = $1', [empresaId]);
  return rows[0] ?? null;
}

module.exports = {
  travarEmpresa, buscarPorChave, buscarPorId, existeGerando, inserirGerando, renovarHeartbeat, concluir, falhar, reivindicarAbandonados, listar,
  contar, buscarEmpresa,
};
