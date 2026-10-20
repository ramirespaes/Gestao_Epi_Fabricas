'use strict';

const crypto = require('node:crypto');

/**
 * Bytes FICTÍCIOS de imagem para os testes da Biblioteca de Imagens (Unidade 5A-1). Sem dependência de nenhum módulo do projeto, para servir
 * tanto aos testes unitários quanto aos de integração. Nada aqui é uma imagem decodificável nem uma das 30 imagens reais: a entrega de
 * arquivos não decodifica nada, só confere SHA-256, tamanho e assinatura.
 */

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

function enchimento(semente, tamanho) {
  const base = crypto.createHash('sha256').update(semente).digest();
  const miolo = Buffer.alloc(tamanho);
  for (let i = 0; i < tamanho; i += 1) miolo[i] = base[i % base.length];
  return miolo;
}

/** Contêiner RIFF/WEBP bem formado (assinatura, tamanhos e um chunk VP8L), determinístico pela semente. */
function webpFicticio(semente, extra = 64) {
  const chunk = Buffer.concat([Buffer.from('VP8L', 'ascii'), le32(extra), enchimento(`webp-${semente}`, extra), Buffer.alloc(extra % 2)]);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), le32(4 + chunk.length), Buffer.from('WEBP', 'ascii'), chunk]);
}

/** Bytes que começam com a assinatura PNG: o "mestre" de teste e, também, o conteúdo que NÃO é WebP. */
function pngFicticio(semente, extra = 120) {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), enchimento(`png-${semente}`, extra)]);
}

module.exports = { sha256Hex, webpFicticio, pngFicticio };
