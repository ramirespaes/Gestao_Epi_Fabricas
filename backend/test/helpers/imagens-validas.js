'use strict';

const zlib = require('node:zlib');
const { webpFicticio } = require('./imagens-ficticias');

/**
 * Imagens de TESTE estruturalmente bem formadas (Biblioteca de Imagens, Unidade 5C-1), geradas em memória: nenhuma é uma das 30 imagens reais e nenhuma
 * depende de biblioteca de imagem. Servem ao processador FALSO (que lê a assinatura, o cabeçalho e o fim do arquivo) e, mais tarde, a quem precisar de
 * bytes que "parecem" PNG, JPEG ou WebP. Para decodificação de verdade (5C-4) os testes geram suas próprias fixtures com a biblioteca escolhida.
 */

const ASSINATURA_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TABELA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = TABELA_CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pedaco = (tipo, dados) => {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const soma = Buffer.alloc(4);
  soma.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, soma]);
};
const ihdr = (largura, altura) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(largura, 0);
  d.writeUInt32BE(altura, 4);
  d[8] = 8; // profundidade
  d[9] = 6; // RGBA
  return pedaco('IHDR', d);
};

/** PNG RGBA REAL (IHDR, IDAT comprimido, IEND), com um padrão determinístico por posição. */
function png(largura, altura) {
  const linhas = Buffer.alloc((largura * 4 + 1) * altura);
  for (let y = 0; y < altura; y += 1) {
    const base = y * (largura * 4 + 1);
    linhas[base] = 0;
    for (let x = 0; x < largura; x += 1) {
      const i = base + 1 + x * 4;
      linhas[i] = (x * 7) & 255;
      linhas[i + 1] = (y * 3) & 255;
      linhas[i + 2] = 90;
      linhas[i + 3] = 255;
    }
  }
  return Buffer.concat([ASSINATURA_PNG, ihdr(largura, altura), pedaco('IDAT', zlib.deflateSync(linhas)), pedaco('IEND', Buffer.alloc(0))]);
}

/** PNG MÍNIMO (IHDR + IEND, sem pixels): pequeno e instantâneo, com as medidas pedidas no cabeçalho. Não decodifica; serve a quem só lê a estrutura. */
function pngMinimo(largura, altura) {
  return Buffer.concat([ASSINATURA_PNG, ihdr(largura, altura), pedaco('IEND', Buffer.alloc(0))]);
}

/** PNG animado (APNG): o bloco acTL entre o cabeçalho e o fim. */
function pngAnimado(largura, altura) {
  const acTL = Buffer.alloc(8);
  acTL.writeUInt32BE(2, 0); // quadros
  return Buffer.concat([ASSINATURA_PNG, ihdr(largura, altura), pedaco('acTL', acTL), pedaco('IEND', Buffer.alloc(0))]);
}

/** JPEG MÍNIMO: SOI + enchimento determinístico + EOI. Não decodifica; as medidas ficam por conta de quem o usa. */
function jpegMinimo(semente = 'j', extra = 200) {
  const miolo = Buffer.alloc(extra);
  for (let i = 0; i < extra; i += 1) miolo[i] = (semente.charCodeAt(i % semente.length) + i) & 0x7f;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), miolo, Buffer.from([0xff, 0xd9])]);
}

/** Contêiner RIFF/WEBP bem formado (um bloco VP8L). Não decodifica. */
const webpMinimo = (semente = 'w', extra = 64) => webpFicticio(semente, extra);

/** WebP ANIMADO: o contêiner com um bloco ANIM. */
function webpAnimado(semente = 'a') {
  const anim = Buffer.concat([Buffer.from('ANIM', 'ascii'), Buffer.from([6, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
  const miolo = Buffer.concat([Buffer.from('WEBP', 'ascii'), anim, webpFicticio(semente, 16).subarray(12)]);
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32LE(miolo.length);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), tamanho, miolo]);
}

/** GIF (formato NÃO aceito). */
const gif = () => Buffer.from(`GIF89a${'\0'.repeat(40)}`, 'latin1');

module.exports = { png, pngMinimo, pngAnimado, jpegMinimo, webpMinimo, webpAnimado, gif };
