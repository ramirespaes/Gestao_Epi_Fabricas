'use strict';

const crypto = require('node:crypto');
const yauzl = require('yauzl');
const { crc32 } = require('./crc32');
const { ErroImportacaoPadrao, nomeSeguro } = require('./pacote-padrao-erros');

/**
 * Leitura do ZIP do pacote aprovado das imagens padrão, em memória. O contêiner (registro de fim, ZIP64, diretório central, cabeçalhos locais,
 * descompressão e conferência do tamanho descompactado) é do yauzl; a POLÍTICA é daqui: nome cru perigoso, link simbólico e tipos especiais,
 * entrada duplicada, limites de bytes e de entradas, e a conferência do CRC-32 (o yauzl não a faz). Nada é extraído para o disco.
 * `decodeStrings: false` entrega o nome como bytes crus, para a análise não depender de decodificação silenciosa.
 */

const OPCOES_YAUZL = Object.freeze({ lazyEntries: true, decodeStrings: false, validateEntrySizes: true, strictFileNames: false });
const MASCARA_TIPO = 0o170000;
const TIPO_COMUM = 0o100000;
const TIPO_LINK = 0o120000;
const NOME_MAXIMO_EM_BYTES = 255;
const DECODIFICADOR = new TextDecoder('utf-8', { fatal: true });

const invalido = (detalhes) => new ErroImportacaoPadrao('PACOTE_INVALIDO', detalhes);

/** Nome em NFC e se é perigoso: vazio, grande, UTF-8 inválido, controle, barra invertida, absoluto, unidade de disco ou segmento "", "." ou "..". */
function analisarNome(bruto) {
  if (bruto.length === 0 || bruto.length > NOME_MAXIMO_EM_BYTES) return { nome: null, perigoso: true };
  let texto;
  try {
    texto = DECODIFICADOR.decode(bruto);
  } catch {
    return { nome: null, perigoso: true };
  }
  const nome = texto.normalize('NFC');
  const segmentos = nome.split('/');
  if (segmentos.at(-1) === '') segmentos.pop();
  const perigoso = /[\p{Cc}\\]/u.test(nome) || nome.startsWith('/') || /^[A-Za-z]:/.test(nome) || segmentos.some((s) => s === '' || s === '.' || s === '..');
  return { nome, perigoso };
}

/**
 * Abre o ZIP e aplica a política às entradas. Devolve `{ zip, entradas }`, cada entrada com o nome em NFC, o nome imprimível, o tamanho e o CRC-32
 * declarados. Qualquer problema vira PACOTE_INVALIDO com o relatório COMPLETO por entrada.
 */
async function abrirPacoteZip(bytes, limites) {
  let zip;
  try {
    zip = await yauzl.fromBufferPromise(bytes, OPCOES_YAUZL);
  } catch {
    throw invalido([{ motivo: 'ZIP_CORROMPIDO', detalhe: 'ESTRUTURA' }]);
  }
  if (zip.entryCount > limites.maxEntradas) {
    throw invalido([{ motivo: 'ENTRADAS_DEMAIS', esperado: limites.maxEntradas, calculado: zip.entryCount }]);
  }
  const brutas = [];
  try {
    for await (const entry of zip.eachEntry()) brutas.push(entry);
  } catch {
    throw invalido([{ motivo: 'ZIP_CORROMPIDO', detalhe: 'DIRETORIO_CENTRAL' }]);
  }

  const problemas = [];
  const vistos = new Set();
  const entradas = [];
  let total = 0;
  for (const entry of brutas) {
    const bruto = entry.fileName;
    const { nome, perigoso } = analisarNome(bruto);
    const entrada = nomeSeguro(bruto);
    if (perigoso) problemas.push({ entrada, motivo: 'CAMINHO_PERIGOSO' });
    const tipo = (entry.externalFileAttributes >>> 16) & MASCARA_TIPO;
    if (tipo === TIPO_LINK) problemas.push({ entrada, motivo: 'LINK_SIMBOLICO' });
    else if (tipo !== 0 && tipo !== TIPO_COMUM) problemas.push({ entrada, motivo: 'TIPO_ESPECIAL' });
    if (entry.isEncrypted()) problemas.push({ entrada, motivo: 'CIFRADA' });
    else if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) problemas.push({ entrada, motivo: 'COMPRESSAO_NAO_SUPORTADA' });
    if (entry.uncompressedSize > limites.maxBytesPorArquivo) {
      problemas.push({ entrada, motivo: 'TAMANHO_EXCEDIDO', esperado: limites.maxBytesPorArquivo, calculado: entry.uncompressedSize });
    }
    total += entry.uncompressedSize;
    if (nome !== null) {
      if (vistos.has(nome)) problemas.push({ entrada, motivo: 'NOME_DUPLICADO' });
      vistos.add(nome);
    }
    entradas.push({ entry, nome, entrada, tamanho: entry.uncompressedSize, crc32: entry.crc32 });
  }
  if (total > limites.maxBytesTotal) problemas.push({ motivo: 'TAMANHO_EXCEDIDO', esperado: limites.maxBytesTotal, calculado: total });
  if (problemas.length > 0) throw invalido(problemas);
  return { zip, entradas };
}

/**
 * Lê UMA entrada: SHA-256 e CRC-32 dos bytes descompactados, no máximo o tamanho declarado (o yauzl já recusa o excesso; o teto daqui é a segunda
 * barreira). `reter` guarda os bytes, e são esses mesmos bytes que o importador grava. Falha esperada volta como `{ ok: false, motivo, detalhe }`.
 */
async function lerEntradaDoPacote(zip, entrada, { reter }) {
  let fluxo;
  try {
    fluxo = await zip.openReadStreamPromise(entrada.entry);
  } catch {
    return { ok: false, motivo: 'ZIP_CORROMPIDO', detalhe: 'CABECALHO_LOCAL' };
  }
  const hash = crypto.createHash('sha256');
  const blocos = [];
  let crc = 0;
  let total = 0;
  try {
    for await (const bloco of fluxo) {
      total += bloco.length;
      if (total > entrada.tamanho) return { ok: false, motivo: 'ZIP_CORROMPIDO', detalhe: 'TAMANHO_DECLARADO' };
      hash.update(bloco);
      crc = crc32(bloco, crc);
      if (reter) blocos.push(bloco);
    }
  } catch (erro) {
    if (erro instanceof Error && erro.message.startsWith('zlib.crc32')) throw erro;
    return { ok: false, motivo: 'ZIP_CORROMPIDO', detalhe: 'DESCOMPRESSAO' };
  } finally {
    fluxo.destroy();
  }
  if (total !== entrada.tamanho) return { ok: false, motivo: 'ZIP_CORROMPIDO', detalhe: 'TAMANHO_DECLARADO' };
  if ((crc >>> 0) !== (entrada.crc32 >>> 0)) return { ok: false, motivo: 'ZIP_CORROMPIDO', detalhe: 'CRC32' };
  return { ok: true, sha256: hash.digest('hex'), bytes: total, dados: reter ? Buffer.concat(blocos, total) : null };
}

module.exports = { abrirPacoteZip, lerEntradaDoPacote };
