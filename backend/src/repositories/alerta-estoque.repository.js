'use strict';

const crypto = require('node:crypto');

/**
 * Persistência do PROCESSAMENTO dos alertas de estoque (069): só o
 * agendamento consolidado por empresa e tipo. Nada de estoque, cobertura,
 * disponibilidade ou registro item a item é gravado aqui. Executor por
 * parâmetro e nenhuma regra de negócio.
 */

const FORMATO_CODIGO = /^[A-Z][A-Z0-9_]{0,39}$/;
const ESTADOS_FINAIS = Object.freeze(['ENVIADO', 'DESCARTADO', 'FALHA']);

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirIds(valores, nome) {
  if (!Array.isArray(valores)) throw new TypeError(`lista de ${nome} inválida`);
  for (const valor of valores) exigirId(valor, `identificador de ${nome}`);
}

function exigirInstante(valor, nome) {
  if (!(valor instanceof Date) || Number.isNaN(valor.getTime())) throw new TypeError(`${nome} inválido`);
}

function exigirCodigo(codigo) {
  if (codigo !== null && (typeof codigo !== 'string' || !FORMATO_CODIGO.test(codigo))) {
    throw new TypeError('código de erro inválido');
  }
}

// O id é BIGINT: fica em texto, porque Number não guarda 64 bits com segurança.
function mapearAgendamento(l) {
  return {
    id: String(l.id),
    empresaId: l.empresa_id,
    tipo: l.tipo,
    tentativas: l.tentativas,
    reivindicadoEm: l.reivindicado_em,
  };
}

/**
 * Abre ou estende o agendamento PENDENTE da empresa e tipo. O agendamento que
 * já foi reivindicado não está no índice dos PENDENTES: a entrada concorrente
 * com a reivindicação espera por ela e abre outro.
 *
 * @returns {Promise<string>} id do agendamento PENDENTE
 */
async function agendar(executor, { empresaId, tipo, janelaSegundos }) {
  exigirId(empresaId, 'identificador de empresa');
  if (!Number.isInteger(janelaSegundos) || janelaSegundos <= 0) throw new TypeError('janela inválida');

  const { rows: [agendamento] } = await executor.query(
    `INSERT INTO alertas_estoque_agendamentos (empresa_id, tipo, primeira_entrada_em, ultima_entrada_em, enviar_apos)
     VALUES ($1, $2, now(), now(), now() + make_interval(secs => $3))
     ON CONFLICT (empresa_id, tipo) WHERE estado = 'PENDENTE'
     DO UPDATE SET ultima_entrada_em = GREATEST(alertas_estoque_agendamentos.ultima_entrada_em, EXCLUDED.ultima_entrada_em),
                   enviar_apos = GREATEST(alertas_estoque_agendamentos.enviar_apos, EXCLUDED.enviar_apos)
     RETURNING id`,
    [empresaId, tipo, janelaSegundos],
  );
  return String(agendamento.id);
}

// Trava curta e global da reivindicação, em espaço próprio: serializa só a
// escolha dos lotes, nunca o envio, e não convive com nenhuma outra trava.
const LOCK_REIVINDICACAO = crypto.createHash('sha256').update('alertas_estoque_reivindicacao').digest().readBigInt64BE(0).toString();

/**
 * Reivindica, sem esperar por quem já está com eles, os agendamentos
 * vencidos: PENDENTE depois da janela, AGUARDANDO_RETRY depois da espera e
 * ENVIANDO abandonado (reivindicado há mais que a concessão) que ainda tem
 * tentativa. Cada um passa a ENVIANDO com `reivindicado_em = agora`, que é a
 * marca que só o dono atual da reivindicação apresenta ao concluir.
 *
 * Um lote por empresa e tipo de cada vez: não reivindica se a empresa e tipo
 * já têm um ENVIANDO dentro da concessão, e reivindica no máximo um (o mais
 * antigo) por execução. Chamar dentro de uma transação.
 */
async function reivindicarVencidos(executor, {
  agora, concessaoSegundos, maxTentativas, limite,
}) {
  exigirInstante(agora, 'instante');
  await executor.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_REIVINDICACAO]);
  const { rows: vencidos } = await executor.query(
    `SELECT a.id, a.empresa_id, a.tipo
       FROM alertas_estoque_agendamentos a
      WHERE ((a.estado = 'PENDENTE' AND a.enviar_apos <= $1)
          OR (a.estado = 'AGUARDANDO_RETRY' AND a.proxima_tentativa_em <= $1)
          OR (a.estado = 'ENVIANDO' AND a.reivindicado_em <= $1::timestamptz - make_interval(secs => $2) AND a.tentativas < $3))
        AND NOT EXISTS (
          SELECT 1 FROM alertas_estoque_agendamentos o
           WHERE o.empresa_id = a.empresa_id AND o.tipo = a.tipo AND o.id <> a.id
             AND o.estado = 'ENVIANDO' AND o.reivindicado_em > $1::timestamptz - make_interval(secs => $2))
      ORDER BY a.id
      LIMIT $4
      FOR UPDATE OF a SKIP LOCKED`,
    [agora, concessaoSegundos, maxTentativas, limite],
  );
  const vistos = new Set();
  const ids = [];
  for (const v of vencidos) {
    const chave = `${v.empresa_id}\n${v.tipo}`;
    if (!vistos.has(chave)) {
      vistos.add(chave);
      ids.push(v.id);
    }
  }
  if (ids.length === 0) return [];
  const { rows } = await executor.query(
    `UPDATE alertas_estoque_agendamentos a
        SET estado = 'ENVIANDO', reivindicado_em = $1, tentativas = a.tentativas + 1, proxima_tentativa_em = NULL
      WHERE a.id = ANY($2::bigint[])
     RETURNING a.id, a.empresa_id, a.tipo, a.tentativas, a.reivindicado_em`,
    [agora, ids],
  );
  return rows.map(mapearAgendamento).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** O ENVIANDO abandonado que já esgotou as tentativas termina em FALHA, sem novo envio. */
async function encerrarAbandonados(executor, {
  agora, concessaoSegundos, maxTentativas, codigo,
}) {
  exigirInstante(agora, 'instante');
  exigirCodigo(codigo);
  const { rowCount } = await executor.query(
    `WITH alvo AS (
       SELECT id
         FROM alertas_estoque_agendamentos
        WHERE estado = 'ENVIANDO' AND reivindicado_em <= $1::timestamptz - make_interval(secs => $2) AND tentativas >= $3
        FOR UPDATE SKIP LOCKED
     )
     UPDATE alertas_estoque_agendamentos a
        SET estado = 'FALHA', processado_em = $1, codigo_ultimo_erro = $4
       FROM alvo
      WHERE a.id = alvo.id`,
    [agora, concessaoSegundos, maxTentativas, codigo],
  );
  return rowCount;
}

/** Número e status do pedido na empresa, ou null. */
async function buscarPedido(executor, { empresaId, solicitacaoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(solicitacaoId, 'identificador de solicitação');
  const { rows } = await executor.query('SELECT numero, status FROM solicitacoes_epi WHERE empresa_id = $1 AND id = $2', [empresaId, solicitacaoId]);
  return rows.length === 0 ? null : { numero: rows[0].numero, status: rows[0].status };
}

/** @returns {Promise<Map<number, string>>} id do material → nome, só da empresa */
async function nomesDosMateriais(executor, { empresaId, materialIds }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirIds(materialIds, 'material');
  if (materialIds.length === 0) return new Map();
  const { rows } = await executor.query('SELECT id, nome FROM materiais WHERE empresa_id = $1 AND id = ANY($2::int[])', [empresaId, materialIds]);
  return new Map(rows.map((l) => [l.id, l.nome]));
}

async function nomeDaEmpresa(executor, empresaId) {
  exigirId(empresaId, 'identificador de empresa');
  const { rows } = await executor.query('SELECT nome FROM empresas WHERE id = $1', [empresaId]);
  return rows.length === 0 ? null : rows[0].nome;
}

/**
 * Usuários ativos da empresa ativa com e-mail de conta (o da identidade
 * ativa, ou o do modelo anterior) e, com `exigirSst`, vínculo SST. A
 * permissão efetiva é decidida pelo serviço.
 */
async function listarContasDaEmpresa(executor, { empresaId, exigirSst }) {
  exigirId(empresaId, 'identificador de empresa');
  const { rows } = await executor.query(
    `SELECT u.id, u.perfil, COALESCE(i.email, u.email) AS email
       FROM usuarios u
       JOIN empresas e ON e.id = u.empresa_id AND e.ativo
       LEFT JOIN identidades i ON i.id = u.identidade_id
      WHERE u.empresa_id = $1
        AND u.ativo
        AND (u.identidade_id IS NULL OR i.ativo)
        AND (NOT $2::boolean OR EXISTS (SELECT 1 FROM vinculo_sst v WHERE v.empresa_id = u.empresa_id AND v.usuario_id = u.id))
      ORDER BY u.id`,
    [empresaId, exigirSst === true],
  );
  return rows.map((l) => ({ id: l.id, perfil: l.perfil, email: l.email }));
}

/**
 * Conclui a reivindicação: só quem apresenta a mesma marca (`reivindicadoEm`)
 * e encontra o agendamento ainda ENVIANDO conclui; quem perdeu a concessão
 * recebe false e não toca em nada.
 */
async function concluir(executor, {
  empresaId, agendamentoId, reivindicadoEm, agora, estado, codigo = null, proximaTentativaEm = null,
  destinatariosAlcancados = null, linhasResumo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirInstante(reivindicadoEm, 'marca da reivindicação');
  exigirInstante(agora, 'instante');
  exigirCodigo(codigo);
  if (estado === 'AGUARDANDO_RETRY') exigirInstante(proximaTentativaEm, 'próxima tentativa');
  else if (!ESTADOS_FINAIS.includes(estado)) throw new TypeError('estado inválido');

  const { rowCount } = await executor.query(
    `UPDATE alertas_estoque_agendamentos
        SET estado = $4::varchar, codigo_ultimo_erro = $5, proxima_tentativa_em = $6,
            processado_em = CASE WHEN $4::varchar = 'AGUARDANDO_RETRY' THEN NULL ELSE $7::timestamptz END,
            destinatarios_alcancados = $8, linhas_resumo = $9
      WHERE empresa_id = $1 AND id = $2 AND estado = 'ENVIANDO' AND reivindicado_em = $3`,
    [empresaId, agendamentoId, reivindicadoEm, estado, codigo, proximaTentativaEm, agora, destinatariosAlcancados, linhasResumo],
  );
  return rowCount > 0;
}

module.exports = {
  agendar,
  reivindicarVencidos,
  encerrarAbandonados,
  buscarPedido,
  nomesDosMateriais,
  nomeDaEmpresa,
  listarContasDaEmpresa,
  concluir,
};
