'use strict';

const { lockDaChave, ESPACO_ENTREGAS, CHAVE_FORMATO, HASH_FORMATO } = require('../utils/idempotencia');

/**
 * Cabeçalho da entrega de EPI (entregas_epi, migration 058): o evento dentro
 * da ficha, com as cópias congeladas do documento. Só INSERT e leitura; a
 * entrega não muda nem some. Toda consulta filtra pela empresa.
 *
 * entregue_em e data_operacional vêm dos DEFAULTs da tabela, isto é, do
 * relógio do banco na transação: nunca do cliente.
 */

// DIRETA é a entrega do Bloco 10; SOLICITACAO nasce de uma solicitação aprovada (066).
const ORIGENS = Object.freeze(['DIRETA', 'SOLICITACAO']);

const COLUNAS = `id, empresa_id, ficha_id, responsavel_id, ghe_id, origem, entregue_em,
  to_char(entregue_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS entregue_em_canonico,
  to_char(data_operacional, 'YYYY-MM-DD') AS data_operacional, chave_idempotencia, requisicao_hash,
  empresa_nome, empresa_cnpj, empresa_endereco, empresa_cidade, empresa_uf,
  trabalhador_nome, trabalhador_matricula, trabalhador_funcao, trabalhador_setor, ghe_nome, responsavel_nome`;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirChave(chave) {
  if (typeof chave !== 'string' || !CHAVE_FORMATO.test(chave)) {
    throw new TypeError('chave de idempotência inválida');
  }
}

function exigirTexto(valor, nome, maximo) {
  if (typeof valor !== 'string' || valor.length === 0 || valor.length > maximo) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirTextoOpcional(valor, nome, maximo) {
  if (valor !== null) exigirTexto(valor, nome, maximo);
}

const mapear = (l) => (l === undefined ? null : {
  id: l.id,
  empresaId: l.empresa_id,
  fichaId: l.ficha_id,
  responsavelId: l.responsavel_id,
  gheId: l.ghe_id,
  origem: l.origem,
  entregueEm: l.entregue_em,
  entregueEmCanonico: l.entregue_em_canonico,
  dataOperacional: l.data_operacional,
  chaveIdempotencia: l.chave_idempotencia,
  requisicaoHash: l.requisicao_hash,
  empresa: { nome: l.empresa_nome, cnpj: l.empresa_cnpj, endereco: l.empresa_endereco, cidade: l.empresa_cidade, uf: l.empresa_uf },
  trabalhador: { nome: l.trabalhador_nome, matricula: l.trabalhador_matricula, funcao: l.trabalhador_funcao, setor: l.trabalhador_setor },
  ghe: l.ghe_id === null ? null : { id: l.ghe_id, nome: l.ghe_nome },
  responsavel: { id: l.responsavel_id, nome: l.responsavel_nome },
});

/** Serializa, até o fim da transação, quem usa a mesma chave na mesma empresa (espaço das entregas). */
async function travarChave(executor, empresaId, chave) {
  exigirId(empresaId, 'identificador de empresa');
  exigirChave(chave);
  await executor.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaChave(ESPACO_ENTREGAS, empresaId, chave)]);
}

async function buscarPorChave(executor, empresaId, chave) {
  exigirId(empresaId, 'identificador de empresa');
  exigirChave(chave);
  const { rows } = await executor.query(
    `SELECT ${COLUNAS} FROM entregas_epi WHERE empresa_id = $1 AND chave_idempotencia = $2`,
    [empresaId, chave],
  );
  return mapear(rows[0]);
}

async function buscarPorId(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de entrega');
  const { rows } = await executor.query(`SELECT ${COLUNAS} FROM entregas_epi WHERE empresa_id = $1 AND id = $2`, [empresaId, id]);
  return mapear(rows[0]);
}

const DATA_FORMATO = /^\d{4}-\d{2}-\d{2}$/;
const LIMITE_MAXIMO = 100;

function filtrosDaFicha(empresaId, fichaId, { de = null, ate = null } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(fichaId, 'identificador de ficha');
  for (const data of [de, ate]) {
    if (data !== null && (typeof data !== 'string' || !DATA_FORMATO.test(data))) throw new TypeError('período inválido');
  }
  return [empresaId, fichaId, de, ate];
}

const FILTRO_FICHA = `WHERE empresa_id = $1 AND ficha_id = $2
    AND ($3::date IS NULL OR data_operacional >= $3::date)
    AND ($4::date IS NULL OR data_operacional <= $4::date)`;

/** Uma página das entregas da ficha, da mais recente para a mais antiga (entregue_em, id). */
async function listarPorFicha(executor, empresaId, fichaId, { pagina, limite, ...periodo }) {
  const filtros = filtrosDaFicha(empresaId, fichaId, periodo);
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS} FROM entregas_epi ${FILTRO_FICHA} ORDER BY entregue_em DESC, id DESC LIMIT $5 OFFSET $6`,
    [...filtros, limite, (pagina - 1) * limite],
  );
  return rows.map(mapear);
}

async function contarPorFicha(executor, empresaId, fichaId, periodo) {
  const { rows } = await executor.query(
    `SELECT count(*)::int AS total FROM entregas_epi ${FILTRO_FICHA}`,
    filtrosDaFicha(empresaId, fichaId, periodo),
  );
  return rows[0].total;
}

/** Dia operacional da transação em São Paulo: o mesmo que os DEFAULTs da entrega vão gravar. */
async function dataOperacionalDaTransacao(executor) {
  const { rows } = await executor.query("SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS hoje");
  return rows[0].hoje;
}

/**
 * Grava o cabeçalho com as cópias congeladas lidas na mesma transação. Só
 * dentro de transação. Sem `origem` a entrega é DIRETA, como sempre foi; o
 * banco confere que SOLICITACAO só tem itens ligados a uma solicitação.
 */
async function criar(executor, {
  empresaId, fichaId, responsavelId, gheId, origem = 'DIRETA', chave, requisicaoHash, empresa, trabalhador, gheNome, responsavelNome,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(fichaId, 'identificador de ficha');
  exigirId(responsavelId, 'identificador de responsável');
  if (gheId !== null) exigirId(gheId, 'identificador de GHE');
  if (!ORIGENS.includes(origem)) throw new TypeError('origem da entrega inválida');
  exigirChave(chave);
  if (typeof requisicaoHash !== 'string' || !HASH_FORMATO.test(requisicaoHash)) throw new TypeError('hash da requisição inválido');
  exigirTexto(empresa.nome, 'nome da empresa', 150);
  exigirTexto(empresa.cnpj, 'CNPJ da empresa', 14);
  exigirTextoOpcional(empresa.endereco, 'endereço da empresa', 500);
  exigirTextoOpcional(empresa.cidade, 'cidade da empresa', 100);
  exigirTextoOpcional(empresa.uf, 'UF da empresa', 2);
  exigirTexto(trabalhador.nome, 'nome do trabalhador', 150);
  exigirTextoOpcional(trabalhador.matricula ?? null, 'matrícula do trabalhador', 30);
  exigirTextoOpcional(trabalhador.funcao, 'função do trabalhador', 100);
  exigirTextoOpcional(trabalhador.setor, 'setor do trabalhador', 100);
  if ((gheId === null) !== (gheNome === null)) throw new TypeError('GHE e nome do GHE andam juntos');
  exigirTextoOpcional(gheNome, 'nome do GHE', 150);
  exigirTexto(responsavelNome, 'nome do responsável', 150);

  const { rows } = await executor.query(
    `INSERT INTO entregas_epi
       (empresa_id, ficha_id, responsavel_id, ghe_id, origem, chave_idempotencia, requisicao_hash,
        empresa_nome, empresa_cnpj, empresa_endereco, empresa_cidade, empresa_uf,
        trabalhador_nome, trabalhador_matricula, trabalhador_funcao, trabalhador_setor, ghe_nome, responsavel_nome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING ${COLUNAS}`,
    [empresaId, fichaId, responsavelId, gheId, origem, chave, requisicaoHash,
      empresa.nome, empresa.cnpj, empresa.endereco, empresa.cidade, empresa.uf,
      trabalhador.nome, trabalhador.matricula, trabalhador.funcao, trabalhador.setor, gheNome, responsavelNome],
  );
  return mapear(rows[0]);
}

module.exports = {
  ORIGENS, travarChave, buscarPorChave, buscarPorId, listarPorFicha, contarPorFicha, dataOperacionalDaTransacao, criar,
};
