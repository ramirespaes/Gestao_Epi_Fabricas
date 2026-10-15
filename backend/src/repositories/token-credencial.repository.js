'use strict';

/**
 * Credencial persistente do tablet (token_dispositivos.credencial_hash / credencial_anterior_hash / credencial_emitida_em,
 * migration 086). Só o SHA-256 existe no banco. Os critérios de tempo (carência da anterior, rotação devida, expiração) são
 * calculados pelo relógio do BANCO na própria consulta, para que a decisão e o instante sejam do mesmo relógio.
 *
 * A rotação é UM UPDATE condicionado à credencial que o chamador apresentou: sob concorrência, a linha é travada e a
 * condição é reavaliada, então exatamente uma requisição rotaciona e as demais perdem a corrida sem erro.
 *
 * Executor por parâmetro; nenhuma regra de negócio aqui.
 */

const HASH = /^[0-9a-f]{64}$/;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}
function exigirHash(valor) {
  if (typeof valor !== 'string' || !HASH.test(valor)) throw new TypeError('hash inválido');
}

/** Trava a linha do dispositivo (sempre a primeira trava de qualquer operação de ativação) e traz a situação da empresa. */
async function travarDispositivo(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de dispositivo');
  const { rows } = await executor.query(
    `SELECT d.id, d.empresa_id, d.nome, d.unidade, d.setor, d.local_instalacao, d.credencial_hash, d.revogado_em, e.ativo AS empresa_ativa
       FROM token_dispositivos d JOIN empresas e ON e.id = d.empresa_id
      WHERE d.empresa_id = $1 AND d.id = $2
        FOR UPDATE OF d`,
    [empresaId, id],
  );
  return rows[0] ?? null;
}

/** Emite a credencial na ativação (ou na recuperação): substitui a atual e NÃO deixa anterior, então nada fica como autorização paralela. */
async function emitirNaAtivacao(executor, { empresaId, id, credencialHash }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de dispositivo');
  exigirHash(credencialHash);
  const { rowCount } = await executor.query(
    `UPDATE token_dispositivos
        SET ativado_em = COALESCE(ativado_em, now()), credencial_hash = $3, credencial_anterior_hash = NULL, credencial_emitida_em = now()
      WHERE empresa_id = $1 AND id = $2 AND revogado_em IS NULL`,
    [empresaId, id, credencialHash],
  );
  return rowCount === 1;
}

/**
 * Localiza o tablet pela credencial apresentada: primeiro como ATUAL, depois como ANTERIOR. Devolve os critérios de tempo já
 * decididos pelo relógio do banco. `anterior` não tem índice (tabela pequena, uma linha por tablet).
 */
async function buscarPorCredencial(executor, credencialHash, { carenciaSegundos, rotacaoHoras, cookieDias }) {
  exigirHash(credencialHash);
  const colunas = `d.id, d.empresa_id, d.nome, d.unidade, d.setor, d.local_instalacao, d.revogado_em, e.ativo AS empresa_ativa,
       (d.credencial_hash = $1) AS atual,
       (d.credencial_emitida_em + make_interval(secs => $2::int) > now()) AS na_carencia,
       (d.credencial_emitida_em + make_interval(hours => $3::int) <= now()) AS rotacao_devida,
       (d.credencial_emitida_em + make_interval(days => $4::int) <= now()) AS expirada`;
  const parametros = [credencialHash, carenciaSegundos, rotacaoHoras, cookieDias];
  const comoAtual = await executor.query(`SELECT ${colunas} FROM token_dispositivos d JOIN empresas e ON e.id = d.empresa_id WHERE d.credencial_hash = $1`, parametros);
  if (comoAtual.rows.length > 0) return comoAtual.rows[0];
  const comoAnterior = await executor.query(`SELECT ${colunas} FROM token_dispositivos d JOIN empresas e ON e.id = d.empresa_id WHERE d.credencial_anterior_hash = $1`, parametros);
  return comoAnterior.rows[0] ?? null;
}

/**
 * Rotaciona SE ainda for a credencial atual, não revogada e com a rotação devida (condições reavaliadas sob a trava da linha).
 * A atual vira "anterior" e o instante de emissão é renovado. Devolve true só para quem ganhou a corrida.
 */
async function rotacionar(executor, { id, credencialAtualHash, novaCredencialHash, rotacaoHoras }) {
  exigirId(id, 'identificador de dispositivo');
  exigirHash(credencialAtualHash);
  exigirHash(novaCredencialHash);
  const { rowCount } = await executor.query(
    `UPDATE token_dispositivos
        SET credencial_anterior_hash = credencial_hash, credencial_hash = $3, credencial_emitida_em = now()
      WHERE id = $1 AND credencial_hash = $2 AND revogado_em IS NULL
        AND credencial_emitida_em + make_interval(hours => $4::int) <= now()`,
    [id, credencialAtualHash, novaCredencialHash, rotacaoHoras],
  );
  return rowCount === 1;
}

module.exports = { travarDispositivo, emitirNaAtivacao, buscarPorCredencial, rotacionar };
