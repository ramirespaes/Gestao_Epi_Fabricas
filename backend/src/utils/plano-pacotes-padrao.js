'use strict';

const crypto = require('node:crypto');
const { ErroImportacaoPadrao } = require('./pacote-padrao-erros');
const { quantidadeValida } = require('./pacote-padrao-manifesto');

/**
 * Plano dos pacotes aprovados da biblioteca padrão de imagens (JSON): quais ZIPs, com qual SHA-256 e quantas imagens cada um traz. Fica fora do Git, junto
 * dos pacotes. Quem o aprova é o SHA-256 do PRÓPRIO plano, informado de fora dele (registro de aprovação da publicação): o plano nunca se autentica sozinho.
 * Os detalhes de erro levam campo e motivo, nunca o valor lido.
 *
 *   { "versao": 1, "pacotes": [ { "arquivo": "<nome>.zip", "sha256": "<64 hex minúsculos>", "quantidade": <1 a 30> } ] }
 */

const VERSAO = 1;
const MAX_BYTES = 64 * 1024;
const MAX_PACOTES = 20;
const SHA256 = /^[0-9a-f]{64}$/;
const NOME_DO_ZIP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.zip$/;
const CHAVES_DO_PLANO = Object.freeze(['versao', 'pacotes']);
const CHAVES_DO_PACOTE = Object.freeze(['arquivo', 'sha256', 'quantidade']);

const invalido = (detalhes) => new ErroImportacaoPadrao('PLANO_INVALIDO', detalhes);
const objetoSimples = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const chavesExatas = (objeto, permitidas) => Object.keys(objeto).length === permitidas.length && permitidas.every((chave) => Object.hasOwn(objeto, chave));

/**
 * @param {Buffer} bytes conteúdo do arquivo do plano
 * @param {string} sha256Esperado SHA-256 aprovado do plano, vindo de fora dele
 * @returns {{ sha256: string, pacotes: Array<{ arquivo: string, sha256: string, quantidade: number }> }}
 */
function lerPlanoAprovado(bytes, sha256Esperado) {
  if (!Buffer.isBuffer(bytes) || typeof sha256Esperado !== 'string' || !SHA256.test(sha256Esperado)) throw new ErroImportacaoPadrao('PACOTE_ARGUMENTOS_INVALIDOS');
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw invalido([{ campo: 'arquivo', motivo: 'TAMANHO_INVALIDO' }]);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== sha256Esperado) throw new ErroImportacaoPadrao('PLANO_SHA256_DIVERGENTE', [{ motivo: 'SHA256', esperado: sha256Esperado, calculado: sha256 }]);

  let plano;
  try {
    plano = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalido([{ campo: 'arquivo', motivo: 'JSON_INVALIDO' }]);
  }
  if (!objetoSimples(plano) || !chavesExatas(plano, CHAVES_DO_PLANO)) throw invalido([{ campo: 'plano', motivo: 'CHAVES_DIFERENTES' }]);
  if (plano.versao !== VERSAO) throw invalido([{ campo: 'versao', motivo: 'VERSAO_NAO_SUPORTADA' }]);
  if (!Array.isArray(plano.pacotes) || plano.pacotes.length === 0 || plano.pacotes.length > MAX_PACOTES) throw invalido([{ campo: 'pacotes', motivo: 'QUANTIDADE_INVALIDA' }]);

  const problemas = [];
  const arquivos = new Set();
  const hashes = new Set();
  plano.pacotes.forEach((pacote, indice) => {
    const posicao = indice + 1;
    const ruim = (campo, motivo) => problemas.push({ linha: posicao, campo, motivo });
    if (!objetoSimples(pacote) || !chavesExatas(pacote, CHAVES_DO_PACOTE)) { ruim('pacote', 'CHAVES_DIFERENTES'); return; }
    if (typeof pacote.arquivo !== 'string' || !NOME_DO_ZIP.test(pacote.arquivo) || pacote.arquivo.includes('..')) ruim('arquivo', 'NOME_INVALIDO');
    else if (arquivos.has(pacote.arquivo)) ruim('arquivo', 'NOME_REPETIDO');
    else arquivos.add(pacote.arquivo);
    if (typeof pacote.sha256 !== 'string' || !SHA256.test(pacote.sha256)) ruim('sha256', 'HASH_INVALIDO');
    else if (hashes.has(pacote.sha256)) ruim('sha256', 'HASH_REPETIDO');
    else hashes.add(pacote.sha256);
    if (!quantidadeValida(pacote.quantidade)) ruim('quantidade', 'QUANTIDADE_INVALIDA');
  });
  if (problemas.length > 0) throw invalido(problemas);

  return { sha256, pacotes: plano.pacotes.map(({ arquivo, sha256: hash, quantidade }) => ({ arquivo, sha256: hash, quantidade })) };
}

module.exports = { VERSAO, MAX_BYTES, MAX_PACOTES, lerPlanoAprovado };
