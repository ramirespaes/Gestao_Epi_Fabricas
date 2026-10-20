'use strict';

/**
 * Inspetor de contêiner de imagem (Biblioteca de Imagens, Unidade 5C-4).
 *
 *   inspecionarContainer(bytes, { ladoMin, ladoMax, pixelsMax }) -> { formato, largura, altura, fim, bytesExtras, pedacos }
 *
 * Função PURA sobre os bytes do envio: não decodifica pixels, não usa biblioteca de imagem, arquivo, rede nem ambiente. Decide, antes de qualquer decodificação:
 *  - o FORMATO, só pela assinatura (PNG, JPEG ou WebP; nome e tipo declarado nunca entram);
 *  - a ESTRUTURA (PNG: pedaços até o IEND; JPEG: segmentos e varredura até o EOI; WebP: RIFF coerente); arquivo cortado ou incoerente é IMAGEM_INVALIDA;
 *  - se é ANIMADA (APNG; WebP com animação) — IMAGEM_ANIMADA_NAO_SUPORTADA;
 *  - as DIMENSÕES DECLARADAS no cabeçalho, conferidas ANTES de percorrer o resto (dimensão gigante nunca chega a alocar memória): IMAGEM_DIMENSOES_INVALIDAS;
 *  - o que sobra DEPOIS do fim do arquivo (`bytesExtras`): carga benigna passa e é contada (a recodificação a descarta); carga com assinatura de arquivo ativo
 *    (ZIP, PDF, HTML/SVG/script, executáveis, GIF...) é recusada como poliglota perigoso (IMAGEM_FORMATO_NAO_SUPORTADO). A busca de assinatura é heurística de defesa em
 *    profundidade: a garantia de verdade é que NADA do arquivo original sobrevive, porque o mestre é recodificado do zero.
 * Toda leitura passa por leitores com verificação de limite: bytes truncados ou corrompidos terminam em ErroDeImagem, nunca em RangeError.
 * Nenhuma mensagem leva byte do envio: cada código tem uma mensagem fixa.
 */

const MENSAGENS = Object.freeze({
  IMAGEM_FORMATO_NAO_SUPORTADO: 'Formato de imagem não suportado',
  IMAGEM_ANIMADA_NAO_SUPORTADA: 'Imagem animada não suportada',
  IMAGEM_INVALIDA: 'Imagem inválida',
  IMAGEM_DIMENSOES_INVALIDAS: 'Dimensões da imagem fora do permitido',
  IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO: 'Tempo máximo de processamento excedido',
  IMAGEM_SAIDA_EXCEDE_LIMITE: 'Saída do processamento acima dos limites',
});

const CODIGOS = Object.freeze({
  FORMATO_NAO_SUPORTADO: 'IMAGEM_FORMATO_NAO_SUPORTADO',
  ANIMADA: 'IMAGEM_ANIMADA_NAO_SUPORTADA',
  INVALIDA: 'IMAGEM_INVALIDA',
  DIMENSOES: 'IMAGEM_DIMENSOES_INVALIDAS',
  TEMPO: 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO',
  SAIDA: 'IMAGEM_SAIDA_EXCEDE_LIMITE',
});

class ErroDeImagem extends Error {
  constructor(codigo) {
    if (typeof codigo !== 'string' || !Object.hasOwn(MENSAGENS, codigo)) throw new TypeError('código de recusa de imagem desconhecido');
    super(MENSAGENS[codigo]);
    this.name = 'ErroDeImagem';
    this.codigo = codigo;
  }

  static mensagemDe(codigo) {
    return MENSAGENS[codigo];
  }
}

/** Pedaços e blocos que carregam metadados ou animação: nenhuma saída do processador pode ter um deles. */
const PEDACOS_DE_METADADOS = Object.freeze(new Set(['eXIf', 'iCCP', 'tEXt', 'iTXt', 'zTXt', 'tIME', 'acTL', 'EXIF', 'XMP ', 'ICCP', 'ANIM', 'ANMF']));

const recusar = (codigo) => { throw new ErroDeImagem(codigo); };
const invalida = () => recusar(CODIGOS.INVALIDA);

// ---------------------------------------------------------------- leitores com limite
const ler8 = (b, o) => { if (o < 0 || o + 1 > b.length) invalida(); return b[o]; };
const ler16be = (b, o) => { if (o < 0 || o + 2 > b.length) invalida(); return b.readUInt16BE(o); };
const ler16le = (b, o) => { if (o < 0 || o + 2 > b.length) invalida(); return b.readUInt16LE(o); };
const ler24le = (b, o) => { if (o < 0 || o + 3 > b.length) invalida(); return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); };
const ler32be = (b, o) => { if (o < 0 || o + 4 > b.length) invalida(); return b.readUInt32BE(o); };
const ler32le = (b, o) => { if (o < 0 || o + 4 > b.length) invalida(); return b.readUInt32LE(o); };
const texto4 = (b, o) => { if (o < 0 || o + 4 > b.length) invalida(); return b.toString('latin1', o, o + 4); };

const ASSINATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function verificarLimites(limites) {
  const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;
  if (limites === null || typeof limites !== 'object' || !inteiroPositivo(limites.ladoMin) || !inteiroPositivo(limites.ladoMax) || !inteiroPositivo(limites.pixelsMax) || limites.ladoMin > limites.ladoMax) {
    throw new TypeError('limites de inspeção de imagem inválidos');
  }
}

function verificarDimensoes(largura, altura, limites) {
  if (largura === 0 || altura === 0) invalida();
  const fora = (lado) => lado < limites.ladoMin || lado > limites.ladoMax;
  if (fora(largura) || fora(altura) || largura * altura > limites.pixelsMax) recusar(CODIGOS.DIMENSOES);
}

// ---------------------------------------------------------------- PNG
function analisarPng(bytes, limites) {
  if (ler32be(bytes, 8) !== 13 || texto4(bytes, 12) !== 'IHDR') invalida();
  const largura = ler32be(bytes, 16);
  const altura = ler32be(bytes, 20);
  verificarDimensoes(largura, altura, limites);
  let o = 8;
  let viuIdat = false;
  const pedacos = [];
  for (;;) {
    const tamanho = ler32be(bytes, o);
    const tipo = texto4(bytes, o + 4);
    if (tamanho > 0x7fffffff) invalida();
    const proximo = o + 12 + tamanho;
    if (proximo > bytes.length) invalida();
    pedacos.push(tipo);
    if (tipo === 'acTL' && !viuIdat) recusar(CODIGOS.ANIMADA);
    if (tipo === 'IDAT') viuIdat = true;
    if (tipo === 'IEND') {
      if (tamanho !== 0 || !viuIdat) invalida();
      return { largura, altura, fim: proximo, pedacos };
    }
    o = proximo;
  }
}

// ---------------------------------------------------------------- JPEG
const ehSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function analisarJpeg(bytes, limites) {
  let o = 2;
  let largura = null;
  let altura = null;
  const pedacos = [];
  for (;;) {
    if (ler8(bytes, o) !== 0xff) invalida();
    while (ler8(bytes, o) === 0xff) o += 1;
    const marcador = ler8(bytes, o);
    o += 1;
    if (marcador === 0x00 || marcador === 0xd8) invalida();
    if (marcador === 0xd9) {
      if (largura === null) invalida();
      return { largura, altura, fim: o, pedacos };
    }
    pedacos.push(marcador.toString(16));
    if (marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) continue;
    const tamanho = ler16be(bytes, o);
    if (tamanho < 2 || o + tamanho > bytes.length) invalida();
    if (ehSof(marcador)) {
      if (largura !== null || tamanho < 8) invalida();
      altura = ler16be(bytes, o + 3);
      largura = ler16be(bytes, o + 5);
      verificarDimensoes(largura, altura, limites);
    }
    o += tamanho;
    if (marcador === 0xda) {
      if (largura === null) invalida();
      for (;;) {
        const i = bytes.indexOf(0xff, o);
        if (i < 0 || i + 1 >= bytes.length) invalida();
        const n = bytes[i + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { o = i + 2; continue; }
        if (n === 0xff) { o = i + 1; continue; }
        o = i;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- WebP
function dimensoesDoPrimeiroPedacoWebp(bytes, tipo, dados, tamanho) {
  if (tipo === 'VP8 ') {
    if (tamanho < 10 || ler8(bytes, dados + 3) !== 0x9d || ler8(bytes, dados + 4) !== 0x01 || ler8(bytes, dados + 5) !== 0x2a) invalida();
    return { largura: ler16le(bytes, dados + 6) & 0x3fff, altura: ler16le(bytes, dados + 8) & 0x3fff, animada: false };
  }
  if (tipo === 'VP8L') {
    if (tamanho < 5 || ler8(bytes, dados) !== 0x2f) invalida();
    const bits = ler32le(bytes, dados + 1);
    return { largura: (bits & 0x3fff) + 1, altura: ((bits >>> 14) & 0x3fff) + 1, animada: false };
  }
  if (tipo === 'VP8X') {
    if (tamanho < 10) invalida();
    return { largura: ler24le(bytes, dados + 4) + 1, altura: ler24le(bytes, dados + 7) + 1, animada: (ler8(bytes, dados) & 0x02) !== 0 };
  }
  return invalida();
}

function analisarWebp(bytes, limites) {
  const tamanhoRiff = ler32le(bytes, 4);
  const fim = 8 + tamanhoRiff;
  if (tamanhoRiff < 4 || fim > bytes.length) invalida();
  let o = 12;
  let largura = 0;
  let altura = 0;
  let viuImagem = false;
  let primeiro = true;
  const pedacos = [];
  while (o < fim) {
    if (o + 8 > fim) invalida();
    const tipo = texto4(bytes, o);
    const tamanho = ler32le(bytes, o + 4);
    if (o + 8 + tamanho > fim) invalida();
    pedacos.push(tipo);
    if (primeiro) {
      const d = dimensoesDoPrimeiroPedacoWebp(bytes, tipo, o + 8, tamanho);
      largura = d.largura;
      altura = d.altura;
      verificarDimensoes(largura, altura, limites);
      if (d.animada) recusar(CODIGOS.ANIMADA);
      primeiro = false;
    }
    if (tipo === 'ANIM' || tipo === 'ANMF') recusar(CODIGOS.ANIMADA);
    if (tipo === 'VP8 ' || tipo === 'VP8L') viuImagem = true;
    o += 8 + tamanho + (tamanho & 1);
  }
  if (o !== fim || !viuImagem) invalida();
  return { largura, altura, fim, pedacos };
}

// ---------------------------------------------------------------- formato e carga depois do fim
function identificar(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(ASSINATURA_PNG)) return 'PNG';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'WEBP';
  return recusar(CODIGOS.FORMATO_NAO_SUPORTADO);
}

const ASSINATURAS_BINARIAS = Object.freeze([
  Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('PK\x05\x06', 'latin1'), Buffer.from('%PDF-', 'latin1'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from('GIF87a', 'latin1'), Buffer.from('GIF89a', 'latin1'), Buffer.from('Rar!\x1a\x07', 'latin1'), Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
]);
const MARCAS_DE_TEXTO = Object.freeze(['<script', '<html', '<!doctype', '<svg', '<?xml', '<?php', '<iframe', '<object', '<embed', '<body', 'this program cannot be run in dos mode']);

/** Heurística: a carga depois do fim do arquivo parece outro arquivo ou conteúdo ativo? (JPEG seguido de outro JPEG é aceito: formatos com várias imagens.) */
function cargaPerigosa(extra, formato) {
  if (formato === 'JPEG' && extra.length >= 3 && extra[0] === 0xff && extra[1] === 0xd8 && extra[2] === 0xff) return false;
  if (extra.length >= 2 && extra[0] === 0x23 && extra[1] === 0x21) return true;
  if (ASSINATURAS_BINARIAS.some((assinatura) => extra.includes(assinatura))) return true;
  const texto = extra.toString('latin1').toLowerCase();
  return MARCAS_DE_TEXTO.some((marca) => texto.includes(marca));
}

function inspecionarContainer(bytes, limites) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('os bytes da imagem devem ser um Buffer');
  verificarLimites(limites);
  const formato = identificar(bytes);
  const analise = formato === 'PNG' ? analisarPng(bytes, limites) : formato === 'JPEG' ? analisarJpeg(bytes, limites) : analisarWebp(bytes, limites);
  const bytesExtras = bytes.length - analise.fim;
  if (bytesExtras > 0 && cargaPerigosa(bytes.subarray(analise.fim), formato)) recusar(CODIGOS.FORMATO_NAO_SUPORTADO);
  return { formato, largura: analise.largura, altura: analise.altura, fim: analise.fim, bytesExtras, pedacos: analise.pedacos };
}

module.exports = { inspecionarContainer, ErroDeImagem, CODIGOS, PEDACOS_DE_METADADOS };
