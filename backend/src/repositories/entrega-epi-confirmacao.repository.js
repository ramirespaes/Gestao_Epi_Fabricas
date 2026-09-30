'use strict';

const { HASH_FORMATO } = require('../utils/idempotencia');
const { ipParaGravar, dispositivoParaGravar } = require('../utils/origem-requisicao');

/**
 * Confirmação de recebimento da entrega (entregas_epi_confirmacoes, migration
 * 060): exatamente uma por entrega, DESENHO com traços ou ACEITE_PRESENCIAL
 * sem traços, com o texto exato da declaração confirmada. Só INSERT e
 * leitura. hash_conteudo é checksum calculado pelo serviço.
 */

const MODOS = Object.freeze(['DESENHO', 'ACEITE_PRESENCIAL']);
const DECLARACAO_VERSAO_FORMATO = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;
const DECLARACAO_TEXTO_MAXIMO = 4000;

const COLUNAS = 'entrega_id, empresa_id, modo, tracos, declaracao_versao, declaracao_texto, confirmada_em, ip, dispositivo, hash_conteudo';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

const mapear = (l) => (l === undefined ? null : {
  entregaId: l.entrega_id,
  empresaId: l.empresa_id,
  modo: l.modo,
  tracos: l.tracos,
  declaracaoVersao: l.declaracao_versao,
  declaracaoTexto: l.declaracao_texto,
  confirmadaEm: l.confirmada_em,
  ip: l.ip,
  dispositivo: l.dispositivo,
  hashConteudo: l.hash_conteudo,
});

async function buscarPorEntrega(executor, empresaId, entregaId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(entregaId, 'identificador de entrega');
  const { rows } = await executor.query(
    `SELECT ${COLUNAS} FROM entregas_epi_confirmacoes WHERE empresa_id = $1 AND entrega_id = $2`,
    [empresaId, entregaId],
  );
  return mapear(rows[0]);
}

/**
 * Grava a confirmação. `tracos` já validados pelo serviço (lista de traços,
 * cada um lista de pontos [x, y]); vão como JSON em texto para o JSONB.
 */
async function criar(executor, {
  empresaId, entregaId, modo, tracos = null, declaracaoVersao, declaracaoTexto, hashConteudo, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(entregaId, 'identificador de entrega');
  if (!MODOS.includes(modo)) throw new TypeError('modo de confirmação inválido');
  if ((modo === 'DESENHO') !== Array.isArray(tracos)) throw new TypeError('traços incompatíveis com o modo');
  if (typeof declaracaoVersao !== 'string' || !DECLARACAO_VERSAO_FORMATO.test(declaracaoVersao)) throw new TypeError('versão da declaração inválida');
  // Conta caracteres, como char_length no banco, não unidades UTF-16.
  const caracteres = typeof declaracaoTexto === 'string' ? Array.from(declaracaoTexto).length : 0;
  if (caracteres === 0 || caracteres > DECLARACAO_TEXTO_MAXIMO) {
    throw new TypeError('texto da declaração inválido');
  }
  if (typeof hashConteudo !== 'string' || !HASH_FORMATO.test(hashConteudo)) throw new TypeError('hash de conteúdo inválido');

  const { rows } = await executor.query(
    `INSERT INTO entregas_epi_confirmacoes
       (entrega_id, empresa_id, modo, tracos, declaracao_versao, declaracao_texto, ip, dispositivo, hash_conteudo)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
     RETURNING ${COLUNAS}`,
    [entregaId, empresaId, modo, tracos === null ? null : JSON.stringify(tracos), declaracaoVersao, declaracaoTexto,
      ipParaGravar(ip), dispositivoParaGravar(dispositivo), hashConteudo],
  );
  return mapear(rows[0]);
}

module.exports = { MODOS, DECLARACAO_VERSAO_FORMATO, DECLARACAO_TEXTO_MAXIMO, buscarPorEntrega, criar };
