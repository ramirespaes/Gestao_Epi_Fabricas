'use strict';

const zlib = require('node:zlib');

/**
 * Leitor mínimo de ZIP para os testes (sem dependência): lê o diretório central e devolve { nome: Buffer }.
 * Aceita entradas armazenadas (0) e deflate (8), sem ZIP64 nem criptografia — o que o gerador do pacote produz.
 */
function lerZip(buffer) {
  let fim = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  }
  if (fim < 0) throw new Error('ZIP inválido: fim do diretório central ausente');
  const total = buffer.readUInt16LE(fim + 10);
  let pos = buffer.readUInt32LE(fim + 16);
  const arquivos = {};
  for (let n = 0; n < total; n += 1) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('ZIP inválido: diretório central corrompido');
    const metodo = buffer.readUInt16LE(pos + 10);
    const tamanhoComprimido = buffer.readUInt32LE(pos + 20);
    const tamanhoNome = buffer.readUInt16LE(pos + 28);
    const tamanhoExtra = buffer.readUInt16LE(pos + 30);
    const tamanhoComentario = buffer.readUInt16LE(pos + 32);
    const deslocamento = buffer.readUInt32LE(pos + 42);
    const nome = buffer.toString('utf8', pos + 46, pos + 46 + tamanhoNome);
    const nomeLocal = buffer.readUInt16LE(deslocamento + 26);
    const extraLocal = buffer.readUInt16LE(deslocamento + 28);
    const inicio = deslocamento + 30 + nomeLocal + extraLocal;
    const dados = buffer.subarray(inicio, inicio + tamanhoComprimido);
    arquivos[nome] = metodo === 8 ? zlib.inflateRawSync(dados) : Buffer.from(dados);
    pos += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }
  return arquivos;
}

module.exports = { lerZip };
