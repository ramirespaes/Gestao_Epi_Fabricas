'use strict';

const net = require('node:net');

/**
 * Endereço remoto canônico para a restrição de acesso por IP (migration 077).
 *
 * O endereço comparado com a lista do usuário é SEMPRE o que o servidor
 * resolveu (`req.ip`, sob `TRUST_PROXY_HOPS`): nenhum cabeçalho do cliente é
 * lido aqui. A forma canônica garante que o mesmo endereço escrito de dois
 * jeitos seja um só: IPv6 comprimido e minúsculo (a serialização WHATWG) e o
 * IPv4 mapeado em IPv6 (`::ffff:a.b.c.d`, como o Node entrega em sockets
 * dual-stack) reduzido ao IPv4. Faixa, porta, zona de interface ou texto
 * viram null — nunca uma string "quase IP" chega ao banco.
 */

const TAMANHO_MAXIMO = 45;
const MAPEADO_IPV4_DECIMAL = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const MAPEADO_IPV4_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

function ipv4DeHex(alto, baixo) {
  const a = parseInt(alto, 16);
  const b = parseInt(baixo, 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

function normalizarIp(valor) {
  if (typeof valor !== 'string') {
    return null;
  }
  const texto = valor.trim();
  if (texto.length === 0 || texto.length > TAMANHO_MAXIMO || texto.includes('%')) {
    return null;
  }
  const mapeado = MAPEADO_IPV4_DECIMAL.exec(texto);
  if (mapeado !== null) {
    return net.isIPv4(mapeado[1]) ? mapeado[1] : null;
  }
  if (net.isIPv4(texto)) {
    return texto;
  }
  if (!net.isIPv6(texto)) {
    return null;
  }
  let canonico;
  try {
    canonico = new URL(`http://[${texto}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const hex = MAPEADO_IPV4_HEX.exec(canonico);
  return hex === null ? canonico : ipv4DeHex(hex[1], hex[2]);
}

/** `req.ip` já resolvido pelo Express; null quando não há endereço utilizável. */
function ipDaRequisicao(req) {
  return req && typeof req.ip === 'string' ? normalizarIp(req.ip) : null;
}

module.exports = { normalizarIp, ipDaRequisicao };
