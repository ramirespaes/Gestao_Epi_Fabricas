'use strict';

const sharp = require('sharp');

/**
 * Fixtures de imagem para o PROCESSADOR REAL (Biblioteca de Imagens, Unidade 5C-4), todas geradas em memória.
 *  - REAIS: feitas pelos codificadores do próprio sharp (PNG, JPEG, WebP, e também GIF, TIFF e AVIF para provar que são recusados), com os metadados que o
 *    processador tem de remover (EXIF com GPS, XMP, ICC, IPTC, comentários) e a orientação EXIF que ele tem de aplicar.
 *  - HOSTIS: bytes montados à mão (PDF, ZIP, ELF, HTML, SVG, BMP, HEIC), arquivos truncados ou com CRC corrompido, dimensões gigantes declaradas no cabeçalho,
 *    APNG, polyglots e PNG/JPEG/WebP bem formados seguidos de carga extra.
 * Nenhuma é uma das 30 imagens padrão. O autoteste (imagens-reais.test.js) prova que cada fixture é o que diz ser, para nenhum teste de segurança passar no vazio.
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
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

const SEGREDOS = Object.freeze({ copyright: 'Segredo Ltda', xmp: 'AUTOR-SECRETO', iptc: 'TITULO-IPTC-SECRETO', comentario: 'COMENTARIO-SECRETO', carga: 'CARGA-EXTRA-DO-POLIGLOTA' });

// ---------------------------------------------------------------- pixels
/** RGBA bruto determinístico. 'quadrantes': vermelho, verde, azul e amarelo (orientação e proporção). 'alfa': esquerda transparente, centro opaco, direita meio transparente. */
function pixelsBrutos(largura, altura, padrao = 'quadrantes') {
  const buf = Buffer.alloc(largura * altura * 4);
  let s = 0x9e3779b9;
  const prox = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  for (let y = 0; y < altura; y += 1) {
    for (let x = 0; x < largura; x += 1) {
      const i = (y * largura + x) * 4;
      let cor = [200, 50, 50, 255];
      if (padrao === 'quadrantes') {
        const dir = x >= largura / 2;
        const baixo = y >= altura / 2;
        if (!dir && !baixo) cor = [255, 0, 0, 255];
        else if (dir && !baixo) cor = [0, 255, 0, 255];
        else if (!dir && baixo) cor = [0, 0, 255, 255];
        else cor = [255, 255, 0, 255];
      } else if (padrao === 'alfa') {
        const terco = Math.floor((x * 3) / largura);
        cor = terco === 0 ? [10, 200, 10, 0] : terco === 1 ? [10, 200, 10, 255] : [200, 10, 200, 128];
      } else if (padrao === 'ruido') {
        const r = prox();
        cor = [r & 255, (r >>> 8) & 255, (r >>> 16) & 255, 255];
      }
      buf[i] = cor[0]; buf[i + 1] = cor[1]; buf[i + 2] = cor[2]; buf[i + 3] = cor[3];
    }
  }
  return buf;
}

const EXIF_COM_GPS = Object.freeze({
  IFD0: { Copyright: SEGREDOS.copyright, Make: 'CameraSecreta' },
  IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '23/1 32/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '46/1 38/1 0/1' },
});
const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${SEGREDOS.xmp}</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`;

/**
 * Codifica um padrão. Opções: formato ('png'|'jpeg'|'webp'), orientacao (1 a 8), exif (true = EXIF com GPS e copyright), xmp, icc ('p3' | 'cmyk'),
 * cmyk (JPEG em CMYK), qualidade.
 */
async function codificar(largura, altura, { padrao = 'quadrantes', formato = 'png', orientacao, exif = false, xmp = false, icc, cmyk = false, qualidade = 90 } = {}) {
  let img = sharp(pixelsBrutos(largura, altura, padrao), { raw: { width: largura, height: altura, channels: 4 } });
  if (formato === 'jpeg') img = img.flatten({ background: '#ffffff' });
  if (exif) img = img.withExif(EXIF_COM_GPS);
  if (xmp) img = img.withXmp(XMP);
  if (icc) img = img.withIccProfile(icc);
  if (orientacao) img = img.withMetadata({ orientation: orientacao });
  if (cmyk) img = img.toColourspace('cmyk');
  if (formato === 'jpeg') return img.jpeg({ quality: qualidade }).toBuffer();
  if (formato === 'webp') return img.webp({ quality: qualidade }).toBuffer();
  return img.png().toBuffer();
}
const png = (l = 400, a = 300, opcoes = {}) => codificar(l, a, { ...opcoes, formato: 'png' });
const jpeg = (l = 400, a = 300, opcoes = {}) => codificar(l, a, { ...opcoes, formato: 'jpeg' });
const webp = (l = 400, a = 300, opcoes = {}) => codificar(l, a, { ...opcoes, formato: 'webp' });

async function webpAnimado(lado = 320) {
  const quadro = async (cor) => sharp({ create: { width: lado, height: lado, channels: 3, background: cor } }).png().toBuffer();
  return sharp([await quadro('#ff0000'), await quadro('#0000ff')], { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
}
async function gif(lado = 64) { return sharp(pixelsBrutos(lado, lado), { raw: { width: lado, height: lado, channels: 4 } }).gif().toBuffer(); }
async function tiff(lado = 64) { return sharp(pixelsBrutos(lado, lado), { raw: { width: lado, height: lado, channels: 4 } }).tiff().toBuffer(); }
async function avif(lado = 64) { return sharp(pixelsBrutos(lado, lado), { raw: { width: lado, height: lado, channels: 4 } }).avif({ effort: 0 }).toBuffer(); }
/** PNG válido em CORES sólidas enorme em pixels e minúsculo em bytes (a "bomba" de verdade, sem enganar o cabeçalho). */
async function pngDePixelsEnormes(largura, altura) {
  return sharp({ create: { width: largura, height: altura, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer();
}

// ---------------------------------------------------------------- pedaços e segmentos
const pedacoPng = (tipo, dados) => { const t = Buffer.from(tipo, 'ascii'); return Buffer.concat([u32be(dados.length), t, dados, u32be(crc32(Buffer.concat([t, dados])))]); };

/** Insere um pedaço logo depois do IHDR. */
function inserirPedacoPng(arquivo, tipo, dados) {
  const fimIhdr = 8 + 12 + 13;
  return Buffer.concat([arquivo.subarray(0, fimIhdr), pedacoPng(tipo, dados), arquivo.subarray(fimIhdr)]);
}
function pedacosPng(arquivo) {
  const r = [];
  let o = 8;
  while (o + 8 <= arquivo.length) {
    const tam = arquivo.readUInt32BE(o);
    const tipo = arquivo.toString('ascii', o + 4, o + 8);
    r.push(tipo);
    o += 12 + tam;
    if (tipo === 'IEND') break;
  }
  return r;
}
function pedacosWebp(arquivo) {
  const r = [];
  let o = 12;
  while (o + 8 <= arquivo.length) {
    const tam = arquivo.readUInt32LE(o + 4);
    r.push(arquivo.toString('ascii', o, o + 4));
    o += 8 + tam + (tam & 1);
  }
  return r;
}
/** Marcadores dos segmentos de um JPEG até o início da varredura (SOS). */
function segmentosJpeg(arquivo) {
  const r = [];
  let o = 2;
  while (o + 4 <= arquivo.length && arquivo[o] === 0xff) {
    const marcador = arquivo[o + 1];
    r.push(marcador.toString(16).padStart(2, '0'));
    if (marcador === 0xda) break;
    o += 2 + arquivo.readUInt16BE(o + 2);
  }
  return r;
}
/** Insere um segmento logo depois do SOI. */
function inserirSegmentoJpeg(arquivo, marcador, dados) {
  return Buffer.concat([arquivo.subarray(0, 2), Buffer.from([0xff, marcador]), u16be(dados.length + 2), dados, arquivo.subarray(2)]);
}
function iptcApp13(titulo = SEGREDOS.iptc) {
  const registro = Buffer.concat([Buffer.from([0x1c, 0x02, 0x05]), u16be(titulo.length), Buffer.from(titulo, 'latin1')]);
  const irb = Buffer.concat([Buffer.from('8BIM', 'ascii'), Buffer.from([0x04, 0x04, 0x00, 0x00]), u32be(registro.length), registro, registro.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
  return Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), irb]);
}

// ---------------------------------------------------------------- hostis montados à mão
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'), Buffer.alloc(200, 0x20)]);
function zip(nome = 'dentro.txt', conteudo = SEGREDOS.carga) {
  const n = Buffer.from(nome, 'ascii');
  const d = Buffer.from(conteudo, 'ascii');
  const crc = crc32(d);
  const local = Buffer.concat([u32le(0x04034b50), Buffer.from([20, 0, 0, 0, 0, 0, 0, 0, 0, 0]), u32le(crc), u32le(d.length), u32le(d.length), Buffer.from([n.length, 0, 0, 0]), n, d]);
  const central = Buffer.concat([u32le(0x02014b50), Buffer.from([20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]), u32le(crc), u32le(d.length), u32le(d.length), Buffer.from([n.length, 0, 0, 0, 0, 0, 0, 0, 0, 0]), u32le(0), u32le(0), n]);
  const fim = Buffer.concat([u32le(0x06054b50), Buffer.from([0, 0, 0, 0, 1, 0, 1, 0]), u32le(central.length), u32le(local.length), Buffer.from([0, 0])]);
  return Buffer.concat([local, central, fim]);
}
const elf = () => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(120)]);
const exe = () => Buffer.concat([Buffer.from('MZ', 'ascii'), Buffer.alloc(58), Buffer.from('This program cannot be run in DOS mode.', 'ascii')]);
const html = () => Buffer.from('<!DOCTYPE html><html><body><script>alert("xss")</script></body></html>', 'utf8');
const htmlSemDoctype = () => Buffer.from('   \n<HTML><script>alert(1)</script></HTML>', 'utf8');
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script><rect width="64" height="64" fill="red"/></svg>', 'utf8');
const svgComXml = () => Buffer.from('<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', 'utf8');
function bmp(lado = 4) {
  const dados = Buffer.alloc(lado * lado * 3, 0x80);
  const cab = Buffer.concat([Buffer.from('BM', 'ascii'), u32le(54 + dados.length), u32le(0), u32le(54)]);
  const dib = Buffer.concat([u32le(40), u32le(lado), u32le(lado), Buffer.from([1, 0, 24, 0]), u32le(0), u32le(dados.length), u32le(2835), u32le(2835), u32le(0), u32le(0)]);
  return Buffer.concat([cab, dib, dados]);
}
const heic = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic', 'ascii'), Buffer.alloc(64, 7)]);
const texto = (t = 'isto nao e uma imagem') => Buffer.from(t, 'utf8');
function aleatorio(n, semente = 12345) {
  const b = Buffer.alloc(n);
  let s = semente >>> 0;
  for (let i = 0; i < n; i += 1) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; b[i] = s & 255; }
  return b;
}

// ---------------------------------------------------------------- estragos
const truncar = (arquivo, fracao) => arquivo.subarray(0, Math.max(1, Math.floor(arquivo.length * fracao)));
/**
 * JPEG cortado no meio dos dados e "fechado" com um EOI: estruturalmente parece inteiro, e o libvips só o recusa com failOn: 'warning'
 * ("premature end of data segment"). É o fixture que prova que a política estrita está ligada.
 */
const jpegCortadoComEoi = (arquivo, fracao = 0.7) => Buffer.concat([arquivo.subarray(0, Math.floor(arquivo.length * fracao)), Buffer.from([0xff, 0xd9])]);
/** Troca um byte DENTRO do primeiro IDAT: o CRC do pedaço deixa de bater (corrupção que a leitura tem de recusar). */
function pngComCrcCorrompido(arquivo) {
  const copia = Buffer.from(arquivo);
  const i = copia.indexOf(Buffer.from('IDAT', 'ascii')) + 8;
  copia[i] ^= 0xff;
  return copia;
}
/** Acrescenta um pedaço acTL (APNG) logo depois do IHDR de um PNG real. */
function apng(arquivo) {
  const acTL = Buffer.concat([u32be(2), u32be(0)]);
  return inserirPedacoPng(arquivo, 'acTL', acTL);
}
/** PNG com cabeçalho válido, dimensões declaradas arbitrárias e quase nenhum dado: a "bomba" que mente no cabeçalho. */
function pngComDimensoesDeclaradas(largura, altura) {
  const ihdr = Buffer.concat([u32be(largura), u32be(altura), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([ASSINATURA_PNG, pedacoPng('IHDR', ihdr), pedacoPng('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), pedacoPng('IEND', Buffer.alloc(0))]);
}
function jpegComDimensoesDeclaradas(largura, altura) {
  const sof = Buffer.concat([Buffer.from([8]), u16be(altura), u16be(largura), Buffer.from([3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc0]), u16be(sof.length + 2), sof, Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00]), Buffer.from([0xff, 0xd9])]);
}
function webpComDimensoesDeclaradas(largura, altura) {
  const vp8x = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from([(largura - 1) & 255, ((largura - 1) >> 8) & 255, ((largura - 1) >> 16) & 255]), Buffer.from([(altura - 1) & 255, ((altura - 1) >> 8) & 255, ((altura - 1) >> 16) & 255])]);
  const vp8l = Buffer.from([0x2f, 0, 0, 0, 0, 0, 0, 0]);
  const miolo = Buffer.concat([Buffer.from('WEBP', 'ascii'), Buffer.from('VP8X', 'ascii'), u32le(vp8x.length), vp8x, Buffer.from('VP8L', 'ascii'), u32le(vp8l.length), vp8l]);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), u32le(miolo.length), miolo]);
}

// ---------------------------------------------------------------- análise das saídas
async function metadados(arquivo) { return sharp(arquivo).metadata(); }
async function rgbaBruto(arquivo) { return sharp(arquivo).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); }
async function pixel(arquivo, x, y) {
  const { data, info } = await rgbaBruto(arquivo);
  const i = (y * info.width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}
/** Caixa que envolve todos os pixels com alfa acima do limiar. */
async function caixaOpaca(arquivo, limiar = 0) {
  const { data, info } = await rgbaBruto(arquivo);
  let x0 = info.width; let y0 = info.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] > limiar) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, largura: x1 - x0 + 1, altura: y1 - y0 + 1 };
}

module.exports = {
  SEGREDOS, EXIF_COM_GPS, XMP, ASSINATURA_PNG, crc32, pixelsBrutos, codificar, png, jpeg, webp, webpAnimado, gif, tiff, avif, pngDePixelsEnormes,
  pedacoPng, inserirPedacoPng, pedacosPng, pedacosWebp, segmentosJpeg, inserirSegmentoJpeg, iptcApp13,
  pdf, zip, elf, exe, html, htmlSemDoctype, svg, svgComXml, bmp, heic, texto, aleatorio,
  truncar, jpegCortadoComEoi, pngComCrcCorrompido, apng, pngComDimensoesDeclaradas, jpegComDimensoesDeclaradas, webpComDimensoesDeclaradas,
  metadados, rgbaBruto, pixel, caixaOpaca,
};
