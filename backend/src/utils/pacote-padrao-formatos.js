'use strict';

const { crc32 } = require('./crc32');

/**
 * Validação ESTRUTURAL das imagens que a biblioteca padrão importa, sem decodificar pixels (a importação é byte a byte, sem recodificar):
 * PNG padronizado 1024x1024 e miniatura WebP 320x320, sem metadados e sem animação. Cada função devolve null (válida) ou o motivo:
 * ASSINATURA, ESTRUTURA, DIMENSOES, METADADOS, ANIMADA (e TAMANHO, só para a miniatura).
 */

const ASSINATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LADO_PNG = 1024;
const LADO_MINIATURA = 320;
const BLOCOS_PNG = new Set(['IHDR', 'IDAT', 'IEND']);
const BLOCOS_WEBP = new Set(['VP8X', 'ALPH', 'VP8 ', 'VP8L']);
const PROFUNDIDADES_PNG = Object.freeze({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] });
const FLAG_ANIMACAO = 0x02;
const FLAGS_METADADOS = 0x20 | 0x08 | 0x04;

function validarPng(b) {
  if (b.length < 8 || !b.subarray(0, 8).equals(ASSINATURA_PNG)) return 'ASSINATURA';
  let posicao = 8;
  let primeiro = true;
  let dadosDaImagem = 0;
  while (posicao < b.length) {
    if (posicao + 12 > b.length) return 'ESTRUTURA';
    const tamanho = b.readUInt32BE(posicao);
    const tipo = b.toString('latin1', posicao + 4, posicao + 8);
    const fim = posicao + 12 + tamanho;
    if (fim > b.length) return 'ESTRUTURA';
    if (crc32(b.subarray(posicao + 4, posicao + 8 + tamanho)) !== b.readUInt32BE(posicao + 8 + tamanho)) return 'ESTRUTURA';
    if (primeiro) {
      if (tipo !== 'IHDR' || tamanho !== 13) return 'ESTRUTURA';
      const largura = b.readUInt32BE(posicao + 8);
      const altura = b.readUInt32BE(posicao + 12);
      const [profundidade, tipoDeCor, compressao, filtro, entrelacamento] = b.subarray(posicao + 16, posicao + 21);
      const permitidas = PROFUNDIDADES_PNG[tipoDeCor] ?? [];
      if (!permitidas.includes(profundidade) || compressao !== 0 || filtro !== 0 || entrelacamento > 1) return 'ESTRUTURA';
      if (largura !== LADO_PNG || altura !== LADO_PNG) return 'DIMENSOES';
      primeiro = false;
    } else if (tipo === 'IHDR') {
      return 'ESTRUTURA';
    } else if (!BLOCOS_PNG.has(tipo)) {
      return 'METADADOS';
    }
    if (tipo === 'IDAT') dadosDaImagem += 1;
    if (tipo === 'IEND') return tamanho === 0 && dadosDaImagem > 0 && fim === b.length ? null : 'ESTRUTURA';
    posicao = fim;
  }
  return 'ESTRUTURA';
}

/** Medidas do quadro de imagem de um bloco "VP8 " (com perda, quadro-chave) ou "VP8L" (sem perda), ou null se o cabeçalho do quadro for inválido. */
function medidasDoQuadro(b, tipo, inicio, tamanho) {
  if (tipo === 'VP8 ') {
    if (tamanho < 10 || (b[inicio] & 1) !== 0 || b[inicio + 3] !== 0x9d || b[inicio + 4] !== 0x01 || b[inicio + 5] !== 0x2a) return null;
    return { largura: b.readUInt16LE(inicio + 6) & 0x3fff, altura: b.readUInt16LE(inicio + 8) & 0x3fff };
  }
  if (tamanho < 5 || b[inicio] !== 0x2f) return null;
  const bits = b.readUInt32LE(inicio + 1);
  return { largura: (bits & 0x3fff) + 1, altura: ((bits >>> 14) & 0x3fff) + 1 };
}

function validarWebp(b, { bytesMax }) {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return 'ASSINATURA';
  if (b.length > bytesMax) return 'TAMANHO';
  if (b.readUInt32LE(4) + 8 !== b.length) return 'ESTRUTURA';
  let posicao = 12;
  let primeiro = true;
  let canvas = null;
  let quadro = null;
  while (posicao < b.length) {
    if (posicao + 8 > b.length) return 'ESTRUTURA';
    const tipo = b.toString('latin1', posicao, posicao + 4);
    const tamanho = b.readUInt32LE(posicao + 4);
    const inicio = posicao + 8;
    const fim = inicio + tamanho + (tamanho % 2);
    if (fim > b.length) return 'ESTRUTURA';
    if (tipo === 'ANIM' || tipo === 'ANMF') return 'ANIMADA';
    if (!BLOCOS_WEBP.has(tipo)) return 'METADADOS';
    if (tipo === 'VP8X') {
      if (!primeiro || tamanho !== 10) return 'ESTRUTURA';
      canvas = { flags: b[inicio], largura: 1 + b.readUIntLE(inicio + 4, 3), altura: 1 + b.readUIntLE(inicio + 7, 3) };
    } else if (tipo === 'VP8 ' || tipo === 'VP8L') {
      if (quadro !== null) return 'ESTRUTURA';
      quadro = medidasDoQuadro(b, tipo, inicio, tamanho);
      if (quadro === null) return 'ESTRUTURA';
    }
    primeiro = false;
    posicao = fim;
  }
  if (quadro === null) return 'ESTRUTURA';
  if (canvas !== null) {
    if (canvas.flags & FLAG_ANIMACAO) return 'ANIMADA';
    if (canvas.flags & FLAGS_METADADOS) return 'METADADOS';
  }
  const medidas = canvas === null ? [quadro.largura, quadro.altura] : [canvas.largura, canvas.altura, quadro.largura, quadro.altura];
  return medidas.every((lado) => lado === LADO_MINIATURA) ? null : 'DIMENSOES';
}

module.exports = { LADO_PNG, LADO_MINIATURA, validarPng, validarWebp };
