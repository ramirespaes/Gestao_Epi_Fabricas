'use strict';

const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');

/**
 * ZIP em streaming com limite de tamanho fiscalizado DURANTE a escrita (12K-D6). A biblioteca (yazl) monta o ZIP; aqui só se
 * conta cada bloco que sai antes de chegar ao destino. Ao passar do limite a escrita aborta na hora: o destino é destruído, a
 * origem para de ser lida e nada truncado é entregue. Os arquivos do ZIP têm nomes fixos do servidor e são validados.
 */

const LIMITE_PADRAO_BYTES = 100 * 1024 * 1024;
const NOME_FORMATO = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

class ErroZip extends Error {
  constructor(codigo, message) {
    super(message);
    this.name = 'ErroZip';
    this.codigo = codigo;
  }
}

function nomeSeguro(nome) {
  return typeof nome === 'string' && NOME_FORMATO.test(nome) && !nome.split('/').some((parte) => parte === '..' || parte === '.');
}

/**
 * @param {{ nome: string, conteudo: AsyncIterable<Buffer> }[]} arquivos
 * @param {import('node:stream').Writable} destino
 * @returns {Promise<{ bytes: number }>} total de bytes do ZIP; rejeita com ErroZip('ZIP_EXCEDE_LIMITE') ao estourar o limite
 */
async function escreverZipLimitado(arquivos, destino, { limiteBytes = LIMITE_PADRAO_BYTES, comprimir = true } = {}) {
  for (const a of arquivos) {
    if (!nomeSeguro(a.nome)) throw new ErroZip('ZIP_NOME_INVALIDO', 'nome de arquivo inválido no ZIP');
  }
  const zip = new yazl.ZipFile();
  const fontes = [];
  let total = 0;
  let falha = null;

  const abortar = (erro) => {
    if (!falha) falha = erro;
    for (const fonte of fontes) fonte.destroy();
    zip.outputStream.destroy(erro);
  };
  const contador = new Transform({
    transform(bloco, _codificacao, proximo) {
      total += bloco.length;
      if (total > limiteBytes) {
        const erro = new ErroZip('ZIP_EXCEDE_LIMITE', 'o ZIP excede o tamanho máximo permitido');
        abortar(erro);
        return proximo(erro);
      }
      return proximo(null, bloco);
    },
  });

  zip.on('error', abortar);
  for (const a of arquivos) {
    const fonte = Readable.from(a.conteudo, { objectMode: false });
    fonte.on('error', abortar);
    fontes.push(fonte);
    zip.addReadStream(fonte, a.nome, { compress: comprimir });
  }
  zip.end();

  try {
    await pipeline(zip.outputStream, contador, destino);
  } catch (erro) {
    for (const fonte of fontes) fonte.destroy();
    throw falha ?? erro;
  }
  return { bytes: total };
}

module.exports = { LIMITE_PADRAO_BYTES, ErroZip, escreverZipLimitado, nomeSeguro };
