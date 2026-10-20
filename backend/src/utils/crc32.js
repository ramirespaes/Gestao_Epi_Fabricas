'use strict';

const zlib = require('node:zlib');

/** CRC-32 incremental (o `anterior` é o resultado do bloco anterior). `zlib.crc32` existe desde o Node 22.2; sem ele a conferência falha de forma explícita, nunca em silêncio. */
function crc32(dados, anterior = 0) {
  if (typeof zlib.crc32 !== 'function') throw new Error('zlib.crc32 indisponível: use Node 22.2 ou superior');
  return zlib.crc32(dados, anterior);
}

module.exports = { crc32 };
