'use strict';

const { analisarCsv } = require('./csv-simples');
const { ErroImportacaoPadrao } = require('./pacote-padrao-erros');

/**
 * Manifesto do pacote aprovado das imagens padrão (MANIFESTO_SHA256.csv): vírgula, cabeçalho exato, uma linha por imagem. A leitura só
 * decide se o ARQUIVO é um manifesto válido; quem confere os hashes contra os bytes é o serviço. Os detalhes de erro levam linha, campo e
 * motivo, nunca o valor lido.
 */

const CABECALHO = Object.freeze([
  'nome', 'sha256_original', 'sha256_png_padronizado', 'sha256_miniatura_webp', 'bytes_original', 'bytes_padronizado', 'bytes_miniatura', 'bbox_original',
]);
const QUANTIDADE_DE_IMAGENS = 30;
const NOME_BASE_MAXIMO = 100;
const SHA256 = /^[0-9a-f]{64}$/;
const TAMANHO = /^[1-9][0-9]{0,15}$/;
const NOME_DE_ARQUIVO = /^[^/\\\p{Cc}]+\.png$/u;

const invalido = (detalhes) => new ErroImportacaoPadrao('PACOTE_MANIFESTO_INVALIDO', detalhes);

/** Quantidade declarada de imagens: inteiro de 1 a 30. O pacote completo (30) é o padrão; um menor, como o da 31ª imagem, declara a sua. */
const quantidadeValida = (valor) => Number.isSafeInteger(valor) && valor >= 1 && valor <= QUANTIDADE_DE_IMAGENS;

function exigirQuantidade(opcoes) {
  if (opcoes === undefined) return QUANTIDADE_DE_IMAGENS;
  if (opcoes === null || typeof opcoes !== 'object' || Array.isArray(opcoes) || Object.keys(opcoes).some((chave) => chave !== 'quantidadeEsperada')) {
    throw new ErroImportacaoPadrao('PACOTE_ARGUMENTOS_INVALIDOS');
  }
  if (opcoes.quantidadeEsperada === undefined) return QUANTIDADE_DE_IMAGENS;
  if (!quantidadeValida(opcoes.quantidadeEsperada)) throw new ErroImportacaoPadrao('PACOTE_ARGUMENTOS_INVALIDOS');
  return opcoes.quantidadeEsperada;
}

/** @returns {{ itens: Array<{ nome: string, base: string, sha256Original: string, sha256Padronizado: string, sha256Miniatura: string, bytesOriginal: number, bytesPadronizado: number, bytesMiniatura: number }> }} */
function lerManifesto(bytes, opcoes = undefined) {
  const quantidade = exigirQuantidade(opcoes);
  let texto;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalido([{ campo: 'arquivo', motivo: 'CODIFICACAO_INVALIDA' }]);
  }
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  let linhas;
  try {
    linhas = analisarCsv(texto, ',');
  } catch {
    throw invalido([{ campo: 'arquivo', motivo: 'CSV_MALFORMADO' }]);
  }
  if (linhas.length === 0 || linhas[0].length !== CABECALHO.length || linhas[0].some((coluna, k) => coluna !== CABECALHO[k])) {
    throw invalido([{ campo: 'cabecalho', motivo: 'DIFERENTE_DO_APROVADO' }]);
  }
  const dados = linhas.slice(1);
  if (dados.length !== quantidade) {
    throw invalido([{ campo: 'linhas', motivo: 'QUANTIDADE_DIFERENTE', esperado: quantidade, calculado: dados.length }]);
  }

  const problemas = [];
  const nomes = new Set();
  const hashesDosPng = new Set();
  const itens = [];
  dados.forEach((campos, indice) => {
    const linha = indice + 2;
    if (campos.length !== CABECALHO.length) { problemas.push({ linha, campo: 'linha', motivo: 'COLUNAS_DIFERENTES' }); return; }
    const [nomeBruto, sha256Original, sha256Padronizado, sha256Miniatura, bytesOriginal, bytesPadronizado, bytesMiniatura] = campos;
    const nome = nomeBruto.normalize('NFC');
    const base = nome.replace(/\.png$/, '');
    const ruim = (campo, motivo) => problemas.push({ linha, campo, motivo });
    if (!NOME_DE_ARQUIVO.test(nome) || base !== base.trim() || base.length === 0 || Array.from(base).length > NOME_BASE_MAXIMO) ruim('nome', 'NOME_INVALIDO');
    else if (nomes.has(nome)) ruim('nome', 'NOME_REPETIDO');
    nomes.add(nome);
    for (const [campo, valor] of [['sha256_original', sha256Original], ['sha256_png_padronizado', sha256Padronizado], ['sha256_miniatura_webp', sha256Miniatura]]) {
      if (!SHA256.test(valor)) ruim(campo, 'HASH_INVALIDO');
    }
    for (const [campo, valor] of [['bytes_original', bytesOriginal], ['bytes_padronizado', bytesPadronizado], ['bytes_miniatura', bytesMiniatura]]) {
      if (!TAMANHO.test(valor) || !Number.isSafeInteger(Number(valor))) ruim(campo, 'TAMANHO_INVALIDO');
    }
    if (SHA256.test(sha256Padronizado)) {
      if (hashesDosPng.has(sha256Padronizado)) ruim('sha256_png_padronizado', 'HASH_REPETIDO');
      hashesDosPng.add(sha256Padronizado);
    }
    itens.push({
      nome, base, sha256Original, sha256Padronizado, sha256Miniatura, bytesOriginal: Number(bytesOriginal), bytesPadronizado: Number(bytesPadronizado), bytesMiniatura: Number(bytesMiniatura),
    });
  });
  if (problemas.length > 0) throw invalido(problemas);
  return { itens };
}

module.exports = { CABECALHO, QUANTIDADE_DE_IMAGENS, quantidadeValida, lerManifesto };
