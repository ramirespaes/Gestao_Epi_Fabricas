'use strict';

const { escaparCoringasLike } = require('../utils/like');
const { lockDaChave, ESPACO_ESTOQUE } = require('../utils/idempotencia');
const { TIPOS_OPERACAO, ORIGENS_ENTREGA } = require('../utils/operacoes-estoque');

/**
 * Escrita do estoque por lote e leitura do histórico de operações. Eu só
 * insiro lote e operação, nunca altero nem apago uma operação: os contadores do
 * lote mudam pelo trigger da migration 042 quando a operação entra, e nunca
 * por UPDATE daqui. Toda consulta filtra pela empresa.
 *
 * Quem chama abre a transação: o lote novo só é aceito no COMMIT se a sua
 * operação de entrada estiver na mesma transação.
 */

const CHAVE_FORMATO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_FORMATO = /^[0-9a-f]{64}$/;
const DATA_FORMATO = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER_MAXIMO = 2147483647;
const TAMANHO_MAXIMO = 20;
const CA_NUMERO_MAXIMO = 20;

const COLUNAS_LOTE = `id, material_id, tamanho, ca_numero, to_char(ca_validade, 'YYYY-MM-DD') AS ca_validade, origem,
       quantidade_entrada, quantidade_baixada, quantidade_entregue, saldo`;
const COLUNAS_OPERACAO = 'id, tipo, lote_id, quantidade, motivo, justificativa, usuario_id, requisicao_hash, criado_em';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`identificador de ${nome} inválido`);
  }
}

function exigirChave(chave) {
  if (typeof chave !== 'string' || !CHAVE_FORMATO.test(chave)) {
    throw new TypeError('chave de idempotência inválida');
  }
}

function exigirTexto(valor, maximo, mensagem) {
  if (typeof valor !== 'string' || valor.trim() !== valor || valor.length === 0 || Array.from(valor).length > maximo) {
    throw new TypeError(mensagem);
  }
}

function exigirOperacao({ empresaId, usuarioId, quantidade, chave, requisicaoHash }) {
  exigirId(empresaId, 'empresa');
  exigirId(usuarioId, 'usuário');
  if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > INTEGER_MAXIMO) {
    throw new TypeError('quantidade inválida');
  }
  exigirChave(chave);
  if (typeof requisicaoHash !== 'string' || !HASH_FORMATO.test(requisicaoHash)) {
    throw new TypeError('hash da requisição inválido');
  }
}

function mapearLote(l) {
  return {
    loteId: l.id,
    materialId: l.material_id,
    tamanho: l.tamanho,
    caNumero: l.ca_numero,
    caValidade: l.ca_validade,
    origem: l.origem,
    quantidadeEntrada: l.quantidade_entrada,
    quantidadeBaixada: l.quantidade_baixada,
    quantidadeEntregue: l.quantidade_entregue,
    saldo: l.saldo,
  };
}

// O id é BIGINT: fica em texto, porque Number não guarda 64 bits com segurança.
function mapearOperacao(o) {
  return {
    id: String(o.id),
    tipo: o.tipo,
    loteId: o.lote_id,
    quantidade: o.quantidade,
    motivo: o.motivo,
    justificativa: o.justificativa,
    usuarioId: o.usuario_id,
    criadoEm: o.criado_em,
  };
}

/**
 * Serializa, até o fim da transação, quem usa a mesma chave na mesma empresa.
 * Entrada e baixa usam o mesmo espaço, porque a chave vale uma vez só por
 * empresa, qualquer que seja a operação.
 */
async function travarChave(executor, empresaId, chave) {
  exigirId(empresaId, 'empresa');
  exigirChave(chave);
  await executor.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaChave(ESPACO_ESTOQUE, empresaId, chave)]);
}

/** Operação já registrada com a chave, com o hash da requisição que a criou. */
async function buscarPorChave(executor, empresaId, chave) {
  exigirId(empresaId, 'empresa');
  exigirChave(chave);
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_OPERACAO} FROM estoque_operacoes WHERE empresa_id = $1 AND chave_idempotencia = $2`,
    [empresaId, chave],
  );
  return rows[0] ? { ...mapearOperacao(rows[0]), requisicaoHash: rows[0].requisicao_hash } : null;
}

async function buscarLote(executor, empresaId, loteId) {
  exigirId(empresaId, 'empresa');
  exigirId(loteId, 'lote');
  const { rows } = await executor.query(`SELECT ${COLUNAS_LOTE} FROM estoque_lotes WHERE empresa_id = $1 AND id = $2`, [empresaId, loteId]);
  return rows[0] ? mapearLote(rows[0]) : null;
}

/** Trava o lote para decidir a baixa sobre o saldo atual; baixas simultâneas esperam. */
async function buscarLoteParaBaixa(executor, empresaId, loteId) {
  exigirId(empresaId, 'empresa');
  exigirId(loteId, 'lote');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_LOTE} FROM estoque_lotes WHERE empresa_id = $1 AND id = $2 FOR UPDATE`,
    [empresaId, loteId],
  );
  return rows[0] ? mapearLote(rows[0]) : null;
}

/** Cria o lote ENTRADA e a sua operação. CA e validade são obrigatórios; o tamanho pode ser null. */
async function registrarEntrada(executor, dados) {
  const {
    empresaId, materialId, usuarioId, tamanho, quantidade, caNumero, caValidade, chave, requisicaoHash,
  } = dados;
  exigirOperacao(dados);
  exigirId(materialId, 'material');
  if (tamanho !== null) exigirTexto(tamanho, TAMANHO_MAXIMO, 'tamanho inválido');
  exigirTexto(caNumero, CA_NUMERO_MAXIMO, 'número do CA inválido');
  if (typeof caValidade !== 'string' || !DATA_FORMATO.test(caValidade)) {
    throw new TypeError('validade do CA inválida');
  }

  const lote = await executor.query(
    `INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada)
     VALUES ($1, $2, $3, $4, $5, 'ENTRADA', $6)
     RETURNING ${COLUNAS_LOTE}`,
    [empresaId, materialId, tamanho, caNumero, caValidade, quantidade],
  );
  const operacao = await executor.query(
    `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, usuario_id, chave_idempotencia, requisicao_hash)
     VALUES ($1, $2, 'ENTRADA', $3, $4, $5, $6)
     RETURNING ${COLUNAS_OPERACAO}`,
    [empresaId, lote.rows[0].id, quantidade, usuarioId, chave, requisicaoHash],
  );
  return { operacao: mapearOperacao(operacao.rows[0]), lote: mapearLote(lote.rows[0]) };
}

function exigirIds(ids, nome) {
  if (!Array.isArray(ids) || ids.length === 0) throw new TypeError(`lista de ${nome} inválida`);
  for (const id of ids) exigirId(id, nome);
}

/**
 * Trava os lotes da entrega, em ordem crescente de id, para decidir cada
 * quantidade sobre o saldo atual. Devolve só os lotes da empresa; quem
 * chama confere o que faltou.
 */
async function travarLotesParaEntrega(executor, empresaId, loteIds) {
  exigirId(empresaId, 'empresa');
  exigirIds(loteIds, 'lote');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_LOTE} FROM estoque_lotes WHERE empresa_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`,
    [empresaId, loteIds],
  );
  return rows.map(mapearLote);
}

/** Os lotes, sem trava, em ordem de id. */
async function listarLotes(executor, empresaId, loteIds) {
  exigirId(empresaId, 'empresa');
  exigirIds(loteIds, 'lote');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_LOTE} FROM estoque_lotes WHERE empresa_id = $1 AND id = ANY($2::int[]) ORDER BY id`,
    [empresaId, loteIds],
  );
  return rows.map(mapearLote);
}

/**
 * Grava a ENTREGA de um item; o trigger soma a quantidade entregue do lote.
 * Sem chave nem hash próprios: a idempotência é do cabeçalho da entrega, e a
 * FK composta da 059 prende a operação ao item, ao lote e à quantidade.
 */
async function registrarEntrega(executor, { empresaId, loteId, usuarioId, quantidade, entregaItemId }) {
  exigirId(empresaId, 'empresa');
  exigirId(loteId, 'lote');
  exigirId(usuarioId, 'usuário');
  exigirId(entregaItemId, 'item da entrega');
  if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > INTEGER_MAXIMO) {
    throw new TypeError('quantidade inválida');
  }
  const { rows } = await executor.query(
    `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, usuario_id, entrega_item_id)
     VALUES ($1, $2, 'ENTREGA', $3, $4, $5)
     RETURNING ${COLUNAS_OPERACAO}`,
    [empresaId, loteId, quantidade, usuarioId, entregaItemId],
  );
  return mapearOperacao(rows[0]);
}

/** Grava a BAIXA; o trigger soma a quantidade baixada do lote. */
async function registrarBaixa(executor, dados) {
  const {
    empresaId, loteId, usuarioId, quantidade, motivo, justificativa = null, chave, requisicaoHash,
  } = dados;
  exigirOperacao(dados);
  exigirId(loteId, 'lote');

  const { rows } = await executor.query(
    `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, motivo, justificativa, usuario_id, chave_idempotencia, requisicao_hash)
     VALUES ($1, $2, 'BAIXA', $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUNAS_OPERACAO}`,
    [empresaId, loteId, quantidade, motivo, justificativa, usuarioId, chave, requisicaoHash],
  );
  return mapearOperacao(rows[0]);
}

// ── Histórico (E8) ──────────────────────────────────────────────────
// Só leitura de estoque_operacoes, sempre da empresa recebida. O período é
// em dias de São Paulo. A ordem é fixa, mais recente primeiro e o id como
// desempate, e segue o índice (empresa_id, criado_em DESC, id DESC).

// A lista de tipos e a de origens vivem em utils/operacoes-estoque.js, a mesma do schema da rota.
const LIMITE_HISTORICO_MAXIMO = 100;

// A operação ENTREGA aponta o item da entrega (1:1, índice único da 059); o item, a sua
// entrega, e a entrega, a ficha: tudo N:1 e sempre pela empresa, então uma operação é
// uma linha. As outras operações não têm item e ficam com a entrega nula.
const ORIGEM_HISTORICO = `FROM estoque_operacoes o
       JOIN estoque_lotes l ON l.empresa_id = o.empresa_id AND l.id = o.lote_id
       JOIN materiais m ON m.empresa_id = l.empresa_id AND m.id = l.material_id
       LEFT JOIN entregas_epi_itens ei ON ei.empresa_id = o.empresa_id AND ei.id = o.entrega_item_id
       LEFT JOIN entregas_epi en ON en.empresa_id = ei.empresa_id AND en.id = ei.entrega_id`;

// Só entra na consulta de quem pode ver a ficha: trabalhador pelo snapshot da entrega
// (nome e matrícula; o cadastro e o CPF nunca são lidos), a ficha e a solicitação de origem.
const DETALHE_ENTREGA = `LEFT JOIN fichas_epi fi ON fi.empresa_id = en.empresa_id AND fi.id = en.ficha_id
       LEFT JOIN solicitacoes_epi_itens si ON si.empresa_id = ei.empresa_id AND si.id = ei.solicitacao_item_id
       LEFT JOIN solicitacoes_epi s ON s.empresa_id = si.empresa_id AND s.id = si.solicitacao_id`;

const COLUNAS_DETALHE_ENTREGA = `,
            fi.id AS ficha_id, fi.numero AS ficha_numero, fi.funcionario_id AS trabalhador_id,
            en.trabalhador_nome, en.trabalhador_matricula, s.id AS solicitacao_id, s.numero AS solicitacao_numero`;

// $6 é a origem: só uma linha de ENTREGA tem origem, então pedir a origem exclui as demais.
const FILTRO_HISTORICO = `WHERE o.empresa_id = $1
        AND ($2::text IS NULL OR o.tipo = $2::text)
        AND ($3::date IS NULL OR o.criado_em >= ($3::date)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND ($4::date IS NULL OR o.criado_em < ($4::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND ($5::text IS NULL OR m.nome ILIKE '%' || $5::text || '%' OR l.ca_numero ILIKE '%' || $5::text || '%')
        AND ($6::text IS NULL OR en.origem = $6::text)`;

function filtrosHistorico({
  tipo = null, origem = null, de = null, ate = null, busca = null,
} = {}) {
  if (tipo !== null && !TIPOS_OPERACAO.includes(tipo)) throw new TypeError('tipo de operação inválido');
  if (origem !== null && !ORIGENS_ENTREGA.includes(origem)) throw new TypeError('origem da entrega inválida');
  for (const data of [de, ate]) {
    if (data !== null && (typeof data !== 'string' || !DATA_FORMATO.test(data))) throw new TypeError('período inválido');
  }
  if (busca !== null && (typeof busca !== 'string' || busca.length === 0)) throw new TypeError('busca inválida');
  return [tipo, de, ate, busca === null ? null : escaparCoringasLike(busca), origem];
}

// O bloco da entrega: só a origem para quem não vê a ficha; com o detalhe, a ficha, o trabalhador e a solicitação (null na DIRETA).
function entregaDaLinha(o, detalhe) {
  if (o.tipo !== 'ENTREGA') return null;
  const entrega = { origem: o.entrega_origem };
  if (!detalhe) return entrega;
  return {
    ...entrega,
    fichaId: o.ficha_id,
    fichaNumero: o.ficha_numero,
    trabalhador: { id: o.trabalhador_id, nome: o.trabalhador_nome, matricula: o.trabalhador_matricula },
    solicitacao: o.solicitacao_id === null || o.solicitacao_id === undefined ? null : { id: o.solicitacao_id, numero: o.solicitacao_numero },
  };
}

/**
 * Uma página do histórico, com o lote, o material, o nome de quem registrou e,
 * nas linhas de ENTREGA, a origem; com `detalheEntrega`, também a ficha, o
 * trabalhador e a solicitação. Tudo da mesma empresa.
 */
async function listarHistorico(executor, empresaId, {
  pagina, limite, detalheEntrega = false, ...filtros
}) {
  exigirId(empresaId, 'empresa');
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_HISTORICO_MAXIMO) {
    throw new TypeError('limite inválido');
  }
  if (typeof detalheEntrega !== 'boolean') throw new TypeError('detalhe da entrega deve ser booleano');
  const { rows } = await executor.query(
    `SELECT o.id, o.tipo, o.quantidade, o.motivo, o.justificativa, o.criado_em, o.lote_id,
            l.material_id, m.nome, m.codigo_interno, l.tamanho, l.ca_numero,
            to_char(l.ca_validade, 'YYYY-MM-DD') AS ca_validade, u.nome AS responsavel,
            en.origem AS entrega_origem${detalheEntrega ? COLUNAS_DETALHE_ENTREGA : ''}
       ${ORIGEM_HISTORICO}
       LEFT JOIN usuarios u ON u.empresa_id = o.empresa_id AND u.id = o.usuario_id
       ${detalheEntrega ? DETALHE_ENTREGA : ''}
       ${FILTRO_HISTORICO}
      ORDER BY o.criado_em DESC, o.id DESC
      LIMIT $7 OFFSET $8`,
    [empresaId, ...filtrosHistorico(filtros), limite, (pagina - 1) * limite],
  );
  return rows.map((o) => ({
    operacaoId: String(o.id),
    tipo: o.tipo,
    quantidade: o.quantidade,
    motivo: o.motivo,
    justificativa: o.justificativa,
    responsavel: o.responsavel,
    criadoEm: o.criado_em,
    loteId: o.lote_id,
    materialId: o.material_id,
    material: o.nome,
    codigoInterno: o.codigo_interno,
    tamanho: o.tamanho,
    caNumero: o.ca_numero,
    caValidade: o.ca_validade,
    entrega: entregaDaLinha(o, detalheEntrega),
  }));
}

async function contarHistorico(executor, empresaId, filtros) {
  exigirId(empresaId, 'empresa');
  const { rows } = await executor.query(
    `SELECT count(*)::int AS total ${ORIGEM_HISTORICO} ${FILTRO_HISTORICO}`,
    [empresaId, ...filtrosHistorico(filtros)],
  );
  return rows[0].total;
}

module.exports = {
  TIPOS_OPERACAO,
  ORIGENS_ENTREGA,
  listarHistorico,
  contarHistorico,
  travarChave,
  buscarPorChave,
  buscarLote,
  buscarLoteParaBaixa,
  travarLotesParaEntrega,
  listarLotes,
  registrarEntrada,
  registrarBaixa,
  registrarEntrega,
};
