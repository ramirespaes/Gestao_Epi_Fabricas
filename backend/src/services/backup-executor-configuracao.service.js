'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { objetoPossuiChaveSensivel } = require('../utils/chave-json-sensivel');
const { PAPEIS } = require('./backup-executor-credenciais.service');

/**
 * D-ORF-6, Rodada B (B1): LEITOR DA CONFIGURAÇÃO DO EXECUTOR. Lê UM arquivo JSON apontado por `BACKUP_EXECUTOR_CONFIG` e devolve a configuração validada; não abre rede, não cria processo e
 * não escreve nada. O arquivo só contém caminhos (um arquivo de credencial sintética por papel), nunca segredos: qualquer chave sensível reprova. Valores, caminhos e conteúdo nunca entram em um código de erro.
 *
 * `lerConfiguracaoOperacional({ ambiente, lerArquivo?, uid? })` -> `{ ok: true, configuracao, sha256 }` | `{ ok: false, codigo }`.
 *  - variável ausente ou vazia: `CONFIGURACAO_AUSENTE` (não é erro: o CLI mantém o comportamento sem ligação);
 *  - forma exata: `{ versao: 1, finalidade: 'ENSAIO_ISOLADO', ambiente: 'HOMOLOGACAO', regiao, papeis: { PUBLICADOR?, VERIFICADOR?, RESTAURACAO? } }`, `papeis` com caminhos absolutos canônicos e distintos.
 * `lerArquivoRestrito` é o leitor seguro compartilhado com o fornecedor de credenciais: caminho canônico sem link em nenhum componente, diretório pai do dono e sem escrita por grupo ou outros,
 * abertura só de leitura sem seguir link, arquivo comum com um único vínculo, do dono, com permissão EXATAMENTE 0600 e tamanho limitado.
 */

const VARIAVEL = 'BACKUP_EXECUTOR_CONFIG';
const LIMITE_CONFIGURACAO_BYTES = 64 * 1024;
const REGIAO = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/;
const CHAVES = Object.freeze(['versao', 'finalidade', 'ambiente', 'regiao', 'papeis']);
const CODIGOS = Object.freeze([
  'CONFIGURACAO_AUSENTE', 'CONFIGURACAO_CAMINHO_INVALIDO', 'CONFIGURACAO_ARQUIVO_INSEGURO', 'CONFIGURACAO_ARQUIVO_INDISPONIVEL', 'CONFIGURACAO_FORMA_INVALIDA', 'CONFIGURACAO_FINALIDADE_NAO_AUTORIZADA',
]);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const recusa = (codigo) => Object.freeze({ ok: false, codigo });
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.includes('\0') && !c.endsWith('/') && !c.split('/').includes('..');

/** Leitura restrita: `{ ok: true, texto }` ou `{ ok: false, codigo: 'CAMINHO_INVALIDO' | 'ARQUIVO_INSEGURO' | 'ARQUIVO_INDISPONIVEL' }`. Nunca lança por causa do arquivo. */
function lerArquivoRestrito(caminho, { uid, limiteBytes }) {
  if (!Number.isInteger(uid) || uid < 0 || !Number.isSafeInteger(limiteBytes) || limiteBytes < 1) throw new TypeError('parâmetros da leitura restrita inválidos');
  if (!caminhoCanonico(caminho)) return recusa('CAMINHO_INVALIDO');
  let fd;
  try {
    if (fs.realpathSync(caminho) !== caminho) return recusa('ARQUIVO_INSEGURO');
    const pai = fs.lstatSync(path.dirname(caminho));
    if (!pai.isDirectory() || pai.isSymbolicLink() || pai.uid !== uid || (pai.mode & 0o022) !== 0) return recusa('ARQUIVO_INSEGURO');
    fd = fs.openSync(caminho, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const estado = fs.fstatSync(fd);
    if (!estado.isFile() || estado.nlink !== 1 || estado.uid !== uid || (estado.mode & 0o777) !== 0o600 || estado.size > limiteBytes) return recusa('ARQUIVO_INSEGURO');
    const texto = fs.readFileSync(fd, 'utf8');
    if (Buffer.byteLength(texto, 'utf8') > limiteBytes) return recusa('ARQUIVO_INSEGURO');
    return Object.freeze({ ok: true, texto });
  } catch {
    return recusa('ARQUIVO_INDISPONIVEL');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* sem efeito: o descritor era só de leitura */ } }
  }
}

function validarForma(objeto, caminhoDaConfiguracao) {
  if (!ehObjeto(objeto) || objetoPossuiChaveSensivel(objeto)) return recusa('CONFIGURACAO_FORMA_INVALIDA');
  const proprias = Reflect.ownKeys(objeto);
  if (proprias.length !== CHAVES.length || !CHAVES.every((k) => proprias.includes(k))) return recusa('CONFIGURACAO_FORMA_INVALIDA');
  const { versao, finalidade, ambiente, regiao, papeis } = objeto;
  if (versao !== 1 || typeof finalidade !== 'string' || typeof ambiente !== 'string' || typeof regiao !== 'string' || !REGIAO.test(regiao) || !ehObjeto(papeis)) return recusa('CONFIGURACAO_FORMA_INVALIDA');
  const nomes = Reflect.ownKeys(papeis);
  if (nomes.length < 1 || !nomes.every((n) => typeof n === 'string' && PAPEIS.includes(n))) return recusa('CONFIGURACAO_FORMA_INVALIDA');
  const caminhos = nomes.map((n) => papeis[n]);
  if (!caminhos.every(caminhoCanonico)) return recusa('CONFIGURACAO_FORMA_INVALIDA');
  const normalizados = caminhos.map((c) => c.toLowerCase());
  if (new Set(normalizados).size !== normalizados.length || normalizados.includes(caminhoDaConfiguracao.toLowerCase())) return recusa('CONFIGURACAO_FORMA_INVALIDA');
  if (finalidade !== 'ENSAIO_ISOLADO' || ambiente !== 'HOMOLOGACAO') return recusa('CONFIGURACAO_FINALIDADE_NAO_AUTORIZADA');
  return null;
}

function lerConfiguracaoOperacional(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['ambiente', 'lerArquivo', 'uid'].includes(k)) || !ehObjeto(opcoes.ambiente)) throw new TypeError('opções do leitor de configuração inválidas');
  const { ambiente, lerArquivo = lerArquivoRestrito, uid = typeof process.getuid === 'function' ? process.getuid() : -1 } = opcoes;
  if (typeof lerArquivo !== 'function') throw new TypeError('opções do leitor de configuração inválidas');
  const caminho = ambiente[VARIAVEL];
  if (caminho === undefined || caminho === '') return recusa('CONFIGURACAO_AUSENTE');
  const lido = lerArquivo(caminho, { uid, limiteBytes: LIMITE_CONFIGURACAO_BYTES });
  if (!ehObjeto(lido) || lido.ok !== true || typeof lido.texto !== 'string') {
    const falha = ehObjeto(lido) ? lido.codigo : undefined;
    return recusa(falha === 'CAMINHO_INVALIDO' ? 'CONFIGURACAO_CAMINHO_INVALIDO' : falha === 'ARQUIVO_INSEGURO' ? 'CONFIGURACAO_ARQUIVO_INSEGURO' : 'CONFIGURACAO_ARQUIVO_INDISPONIVEL');
  }
  let objeto;
  try { objeto = JSON.parse(lido.texto); } catch { return recusa('CONFIGURACAO_FORMA_INVALIDA'); }
  const problema = validarForma(objeto, caminho);
  if (problema !== null) return problema;
  const configuracao = Object.freeze({
    versao: objeto.versao, finalidade: objeto.finalidade, ambiente: objeto.ambiente, regiao: objeto.regiao, papeis: Object.freeze({ ...objeto.papeis }),
  });
  return Object.freeze({ ok: true, configuracao, sha256: crypto.createHash('sha256').update(lido.texto).digest('hex') });
}

module.exports = { lerConfiguracaoOperacional, lerArquivoRestrito, VARIAVEL, CODIGOS, LIMITE_CONFIGURACAO_BYTES };
