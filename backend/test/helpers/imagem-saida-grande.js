'use strict';

const sharp = require('sharp');

/**
 * Entrada que obriga o filho a devolver uma resposta GRANDE (Biblioteca de Imagens, Unidade 5C-4, T-01): ruído determinístico de 1800 x 1800 suavizado e salvo em JPEG
 * (cerca de 0,5 MB, dentro dos 2 MiB), cujo quadro de resposta passa de 2 MiB. Memoizada: o ruído é caro de gerar.
 */
let memoria = null;

function jpegDeSaidaGrande() {
  if (memoria === null) {
    memoria = (async () => {
      const lado = 1800;
      const bruto = Buffer.alloc(lado * lado * 3);
      let s = 123456789;
      for (let i = 0; i < bruto.length; i += 1) { s = (s * 1103515245 + 12345) & 0x7fffffff; bruto[i] = (s >> 16) & 0xff; }
      return sharp(bruto, { raw: { width: lado, height: lado, channels: 3 } }).blur(1.4).jpeg({ quality: 70 }).toBuffer();
    })();
  }
  return memoria;
}

module.exports = { jpegDeSaidaGrande };
