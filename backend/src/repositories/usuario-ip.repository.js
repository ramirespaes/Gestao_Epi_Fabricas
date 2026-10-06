'use strict';

const { normalizarIp } = require('../utils/ip');

/**
 * IPs permitidos por usuário administrativo (usuario_ips_permitidos, 077).
 *
 * Sem linhas, o usuário acessa de qualquer endereço; com linhas, só dos
 * cadastrados. A decisão é do middleware de sessão e da seleção de empresa;
 * aqui só consulta e gravação, sempre filtradas por empresa e usuário, com
 * endereços já canônicos (utils/ip.js) — o INET do banco faz a comparação.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirIps(ips) {
  if (!Array.isArray(ips) || ips.some((ip) => typeof ip !== 'string' || normalizarIp(ip) !== ip)) {
    throw new TypeError('endereços devem chegar canônicos');
  }
}

function exigirIpOpcional(ip) {
  if (ip !== null && (typeof ip !== 'string' || normalizarIp(ip) !== ip)) {
    throw new TypeError('endereço deve chegar canônico ou null');
  }
}

/** Grava os endereços do usuário; lista vazia não toca o banco. Devolve os gravados, em ordem. */
async function inserir(executor, { empresaId, usuarioId, ips }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  exigirIps(ips);
  if (ips.length === 0) {
    return [];
  }

  const { rows } = await executor.query(
    `INSERT INTO usuario_ips_permitidos (empresa_id, usuario_id, ip)
     SELECT $1, $2, unnest($3::inet[])
     RETURNING host(ip) AS ip`,
    [empresaId, usuarioId, ips],
  );

  return rows.map((linha) => linha.ip);
}

/** Substitui TODA a lista do usuário (vazia = sem restrição); o chamador está numa transação. */
async function substituir(executor, { empresaId, usuarioId, ips }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  exigirIps(ips);
  await executor.query('DELETE FROM usuario_ips_permitidos WHERE empresa_id = $1 AND usuario_id = $2', [empresaId, usuarioId]);
  return inserir(executor, { empresaId, usuarioId, ips });
}

async function listar(executor, empresaId, usuarioId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');

  const { rows } = await executor.query(
    'SELECT host(ip) AS ip FROM usuario_ips_permitidos WHERE empresa_id = $1 AND usuario_id = $2 ORDER BY id',
    [empresaId, usuarioId],
  );

  return rows.map((linha) => linha.ip);
}

/**
 * true quando o usuário não tem restrição OU o endereço está na lista. `ip`
 * null (endereço remoto indisponível) só passa sem restrição.
 */
async function acessoPermitido(executor, empresaId, usuarioId, ip) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  exigirIpOpcional(ip);

  const { rows } = await executor.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE ip = $3::inet)::int AS iguais
       FROM usuario_ips_permitidos
      WHERE empresa_id = $1 AND usuario_id = $2`,
    [empresaId, usuarioId, ip],
  );

  const linha = rows[0];
  return linha === undefined || linha.total === 0 || linha.iguais > 0;
}

module.exports = { inserir, substituir, listar, acessoPermitido };
