'use strict';

/**
 * Dispositivos do Atendimento Token (token_dispositivos, migration 086). Executor por parâmetro, nenhuma regra de negócio,
 * toda consulta filtra pela empresa. A projeção NUNCA devolve credencial_hash nem credencial_anterior_hash: o hash existe no
 * banco para a autenticação do tablet (Etapa C) e não sai por esta API.
 *
 * Inclui as duas escritas em cascata da revogação (cancelar ativação pendente e encerrar atendimento aberto), porque dependem
 * da mesma trava de linha do dispositivo.
 */

const LIMITE_MAXIMO = 100;
const INDICE_NOME = 'uq_token_dispositivos_empresa_nome';
const RESTRICAO_SERIE = 'uq_token_dispositivos_empresa_numero_serie';

const PROJECAO = `id, empresa_id, identificador, nome, unidade, setor, local_instalacao, fabricante, modelo, numero_serie,
  ativado_em, revogado_em, revogado_por, ultimo_contato_em, comunicacao_registrada, criado_por, criado_em, atualizado_em`;

// Campo da API -> coluna. É a única fonte dos nomes de coluna que o UPDATE aceita (nunca vem do cliente).
const COLUNAS_EDITAVEIS = Object.freeze({
  nome: 'nome', unidade: 'unidade', setor: 'setor', localInstalacao: 'local_instalacao',
  fabricante: 'fabricante', modelo: 'modelo', numeroSerie: 'numero_serie',
});

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const iso = (data) => (data instanceof Date ? data.toISOString() : null);

/** Linha do banco -> dispositivo público. A situação administrativa é DERIVADA dos carimbos; a comunicação vem separada. */
function mapear(l) {
  if (l === undefined || l === null) return null;
  let situacao = 'PENDENTE';
  if (l.revogado_em !== null) situacao = 'REVOGADO';
  else if (l.ativado_em !== null) situacao = 'ATIVO';
  return {
    id: l.id,
    identificador: l.identificador,
    nome: l.nome,
    unidade: l.unidade,
    setor: l.setor,
    localInstalacao: l.local_instalacao,
    fabricante: l.fabricante,
    modelo: l.modelo,
    numeroSerie: l.numero_serie,
    situacao,
    comunicacao: { registrada: l.comunicacao_registrada, ultimoContatoEm: iso(l.ultimo_contato_em) },
    ativadoEm: iso(l.ativado_em),
    revogadoEm: iso(l.revogado_em),
    criadoPor: l.criado_por,
    revogadoPor: l.revogado_por,
    criadoEm: iso(l.criado_em),
    atualizadoEm: iso(l.atualizado_em),
  };
}

/** 'NOME' | 'NUMERO_SERIE' | null: qual unicidade a violação 23505 quebrou. */
function unicidadeViolada(erro) {
  if (!erro || erro.code !== '23505') return null;
  if (erro.constraint === INDICE_NOME) return 'NOME';
  if (erro.constraint === RESTRICAO_SERIE) return 'NUMERO_SERIE';
  return null;
}

async function inserir(executor, { empresaId, criadoPor, nome, unidade = null, setor = null, localInstalacao = null, fabricante = null, modelo = null, numeroSerie = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(criadoPor, 'identificador de usuário');
  const { rows } = await executor.query(
    `INSERT INTO token_dispositivos (empresa_id, criado_por, nome, unidade, setor, local_instalacao, fabricante, modelo, numero_serie)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${PROJECAO}`,
    [empresaId, criadoPor, nome, unidade, setor, localInstalacao, fabricante, modelo, numeroSerie],
  );
  return rows[0];
}

async function buscarPorId(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de dispositivo');
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM token_dispositivos WHERE empresa_id = $1 AND id = $2`, [empresaId, id]);
  return rows[0] ?? null;
}

/** Leitura com FOR UPDATE (dentro de transação): edição e revogação se serializam por dispositivo. */
async function buscarParaAtualizacao(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de dispositivo');
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM token_dispositivos WHERE empresa_id = $1 AND id = $2 FOR UPDATE`, [empresaId, id]);
  return rows[0] ?? null;
}

async function listar(executor, empresaId, { pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM token_dispositivos WHERE empresa_id = $1 ORDER BY lower(nome), id LIMIT $2 OFFSET $3`,
    [empresaId, limite, (pagina - 1) * limite],
  );
  return rows;
}

async function contar(executor, empresaId) {
  exigirId(empresaId, 'identificador de empresa');
  const { rows } = await executor.query('SELECT count(*)::int AS total FROM token_dispositivos WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

/** Atualiza só as colunas dos campos recebidos (nomes da API, mapeados por COLUNAS_EDITAVEIS). */
async function atualizar(executor, empresaId, id, campos) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de dispositivo');
  const nomes = Object.keys(campos);
  if (nomes.length === 0) throw new TypeError('nada a atualizar');
  const atribuicoes = nomes.map((campo, i) => {
    if (!Object.hasOwn(COLUNAS_EDITAVEIS, campo)) throw new TypeError(`campo não editável: ${campo}`);
    return `${COLUNAS_EDITAVEIS[campo]} = $${i + 3}`;
  });
  const { rows } = await executor.query(
    `UPDATE token_dispositivos SET ${atribuicoes.join(', ')} WHERE empresa_id = $1 AND id = $2 RETURNING ${PROJECAO}`,
    [empresaId, id, ...nomes.map((campo) => campos[campo])],
  );
  return rows[0] ?? null;
}

/** Carimba a revogação e ZERA a credencial (e a anterior): revogado nunca tem credencial válida (chk_..._revogado_sem_credencial). */
async function revogar(executor, empresaId, id, revogadoPor) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de dispositivo');
  exigirId(revogadoPor, 'identificador de usuário');
  const { rows } = await executor.query(
    `UPDATE token_dispositivos
        SET revogado_em = now(), revogado_por = $3, credencial_hash = NULL, credencial_anterior_hash = NULL
      WHERE empresa_id = $1 AND id = $2 AND revogado_em IS NULL
      RETURNING ${PROJECAO}`,
    [empresaId, id, revogadoPor],
  );
  return rows[0] ?? null;
}

/** Cancela as ativações ainda pendentes do dispositivo; devolve quantas. */
async function cancelarAtivacoesPendentes(executor, empresaId, dispositivoId) {
  const { rowCount } = await executor.query(
    `UPDATE token_ativacoes SET cancelado_em = now()
      WHERE empresa_id = $1 AND dispositivo_id = $2 AND usado_em IS NULL AND cancelado_em IS NULL`,
    [empresaId, dispositivoId],
  );
  return rowCount;
}

/** Encerra o atendimento aberto do dispositivo (DISPOSITIVO_REVOGADO); devolve quantos. */
async function encerrarAtendimentosAbertos(executor, empresaId, dispositivoId) {
  const { rowCount } = await executor.query(
    `UPDATE token_atendimentos SET encerrado_em = now(), motivo_encerramento = 'DISPOSITIVO_REVOGADO'
      WHERE empresa_id = $1 AND dispositivo_id = $2 AND encerrado_em IS NULL`,
    [empresaId, dispositivoId],
  );
  return rowCount;
}

module.exports = {
  LIMITE_MAXIMO,
  COLUNAS_EDITAVEIS,
  mapear,
  unicidadeViolada,
  inserir,
  buscarPorId,
  buscarParaAtualizacao,
  listar,
  contar,
  atualizar,
  revogar,
  cancelarAtivacoesPendentes,
  encerrarAtendimentosAbertos,
};
