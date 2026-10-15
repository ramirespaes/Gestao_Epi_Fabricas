'use strict';

/**
 * Redes autorizadas do Atendimento Token — escrita e listagem ADMINISTRATIVAS (Etapa H). Arquivo próprio: o `token-rede.repository.js`
 * (autenticação do tablet, Etapa C) fica como está. Tabela `token_redes_autorizadas` (086). Só IP_FIXO e só endereço EXATO (/32 ou
 * /128): faixa e TUNEL não são aceitos aqui (o TUNEL é negado pela Etapa C enquanto não houver atestação). Toda consulta filtra pela
 * empresa; a rede nunca é apagada, só desativada (a auditoria mantém o histórico). Executor por parâmetro, sem regra de negócio.
 */

const LIMITE_MAXIMO = 100;
const INDICE_REDE_ATIVA = 'uq_token_redes_empresa_rede_ativa';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const iso = (data) => (data instanceof Date ? data.toISOString() : null);

// host(rede) = o endereço sem a máscara; a máscara é sempre exata (/32 ou /128) para IP_FIXO.
const PROJECAO = `id, tipo, host(rede) AS endereco, descricao, criado_em, desativada_em`;

function mapear(l) {
  return {
    id: l.id,
    tipo: l.tipo,
    endereco: l.endereco,
    descricao: l.descricao,
    ativa: l.desativada_em === null,
    criadaEm: iso(l.criado_em),
    desativadaEm: iso(l.desativada_em),
  };
}

async function listar(executor, empresaId, { pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM token_redes_autorizadas WHERE empresa_id = $1
      ORDER BY (desativada_em IS NOT NULL), criado_em DESC, id DESC LIMIT $2 OFFSET $3`,
    [empresaId, limite, (pagina - 1) * limite],
  );
  return rows.map(mapear);
}

async function contar(executor, empresaId) {
  exigirId(empresaId, 'identificador de empresa');
  const { rows } = await executor.query('SELECT count(*)::int AS total FROM token_redes_autorizadas WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

/** A rede da empresa, travada para a desativação (outra empresa e inexistente são indistinguíveis). */
async function buscarParaDesativar(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de rede');
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM token_redes_autorizadas WHERE empresa_id = $1 AND id = $2 FOR UPDATE`, [empresaId, id]);
  return rows[0] === undefined ? null : mapear(rows[0]);
}

/** Cadastra o IP EXATO (a máscara é derivada do endereço no próprio banco: 32 para IPv4, 128 para IPv6). */
async function inserirIpFixo(executor, { empresaId, criadoPor, endereco, descricao }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(criadoPor, 'identificador de ator');
  if (typeof endereco !== 'string' || endereco.length === 0) throw new TypeError('endereço inválido');
  const { rows } = await executor.query(
    `INSERT INTO token_redes_autorizadas (empresa_id, tipo, rede, descricao, criado_por)
     VALUES ($1, 'IP_FIXO', set_masklen($2::inet, CASE family($2::inet) WHEN 4 THEN 32 ELSE 128 END)::cidr, $3, $4)
     RETURNING ${PROJECAO}`,
    [empresaId, endereco, descricao ?? null, criadoPor],
  );
  return mapear(rows[0]);
}

async function desativar(executor, empresaId, id, atorId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de rede');
  exigirId(atorId, 'identificador de ator');
  const { rows } = await executor.query(
    `UPDATE token_redes_autorizadas SET desativada_em = now(), desativada_por = $3
      WHERE empresa_id = $1 AND id = $2 AND desativada_em IS NULL RETURNING ${PROJECAO}`,
    [empresaId, id, atorId],
  );
  return rows[0] === undefined ? null : mapear(rows[0]);
}

/** true se o erro é a violação do índice único de rede ATIVA da empresa (a mesma rede já autorizada). */
function redeJaAtiva(erro) {
  return Boolean(erro) && erro.code === '23505' && erro.constraint === INDICE_REDE_ATIVA;
}

module.exports = { listar, contar, buscarParaDesativar, inserirIpFixo, desativar, redeJaAtiva };
