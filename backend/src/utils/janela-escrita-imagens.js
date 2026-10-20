'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * Trava de janela de escrita do armazenamento de imagens (Biblioteca de Imagens, P-ORF-01): exclusão mútua entre a limpeza de órfãos e o backup
 * (Documento 65, seção 7.2). É um arquivo comum, FORA da árvore de imagens, criado de forma exclusiva (O_CREAT | O_EXCL | O_NOFOLLOW, modo 0600)
 * com o documento JSON { versao, tipo, pid, hospedeiro, iniciadoEm, token }; o procedimento de backup cumpre o mesmo protocolo à mão, em shell.
 * Quem encontra o arquivo nunca o apaga nem o sobrescreve, nem de dono morto (falha fechada: quem decide é uma pessoa); só o dono, com o mesmo
 * token, o remove. O token é a prova de posse e nunca sai pela leitura. Mensagens de erro nunca levam caminho, token nem PID.
 * `confirmarPosse()` (G5) prova a posse durante o trabalho comparando o TOKEN da aquisição com o do arquivo, sem expô-lo: tipo, PID e instante iguais não bastam.
 */

const TIPOS = Object.freeze({ BACKUP: 'BACKUP', LIMPEZA: 'LIMPEZA' });
const VARIAVEL_ARQUIVO = 'IMAGENS_JANELA_ESCRITA_ARQUIVO';
const VERSAO = 1;
const CAMPOS = ['hospedeiro', 'iniciadoEm', 'pid', 'tipo', 'token', 'versao'];
const LIMITE_DO_DOCUMENTO = 4096;
const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOKEN = /^[0-9a-f]{32,128}$/;
const CONTROLE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
// O_NONBLOCK: um FIFO no lugar da trava não pode prender a leitura.
const ABRIR_PARA_LER = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const ABRIR_PARA_CRIAR = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
const OCUPANTE_ILEGIVEL = new Set(['ELOOP', 'EACCES', 'EPERM', 'ENXIO', 'ENOTDIR']);
const AUSENTE = Symbol('ausente');

const MENSAGENS = {
  JANELA_OCUPADA: 'a janela de escrita das imagens está ocupada',
  JANELA_ARQUIVO_INVALIDO: 'arquivo da janela de escrita inválido',
  JANELA_DENTRO_DO_ARMAZENAMENTO: 'o arquivo da janela de escrita não pode ficar dentro do armazenamento de imagens',
  JANELA_TIPO_INVALIDO: 'tipo de janela de escrita inválido',
  JANELA_DOCUMENTO_INVALIDO: 'documento da janela de escrita ilegível ou fora do protocolo',
};

class ErroDeJanela extends Error {
  constructor(codigo, dono = null) {
    super(MENSAGENS[codigo] ?? 'erro na janela de escrita das imagens');
    this.name = 'ErroDeJanela';
    this.codigo = codigo;
    this.dono = dono;
  }
}

const hospedeiroValido = (valor) => typeof valor === 'string' && valor.length >= 1 && valor.length <= 255 && !CONTROLE.test(valor);

const caminhoDeArquivoValido = (arquivo) => typeof arquivo === 'string' && arquivo !== '' && !arquivo.includes('\0')
  && path.isAbsolute(arquivo) && path.resolve(arquivo) === arquivo && path.dirname(arquivo) !== arquivo;

const dentroDe = (pasta, raiz) => pasta === raiz || pasta.startsWith(raiz.endsWith(path.sep) ? raiz : `${raiz}${path.sep}`);

function exigirRaiz(raizArmazenamento) {
  if (typeof raizArmazenamento !== 'string' || raizArmazenamento.includes('\0') || !path.isAbsolute(raizArmazenamento)) {
    throw new TypeError('raizArmazenamento deve ser um caminho absoluto');
  }
}

function nomeDoHospedeiro() {
  const nome = String(os.hostname()).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '?').slice(0, 255);
  return nome === '' ? 'desconhecido' : nome;
}

function instanteIso(agora) {
  const ms = typeof agora === 'function' ? agora() : Number.NaN;
  const iso = Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : '';
  if (!INSTANTE.test(iso)) throw new TypeError('relógio da janela inválido');
  return iso;
}

/** Caminho real onde a trava ficaria (pasta resolvida + nome), validado; com a raiz, também fora da árvore de imagens. Nunca cria nada. */
async function localDaTrava(arquivo, raizArmazenamento = null) {
  if (!caminhoDeArquivoValido(arquivo)) throw new ErroDeJanela('JANELA_ARQUIVO_INVALIDO');
  const pasta = await fsp.realpath(path.dirname(arquivo)).catch(() => null);
  const ehPasta = pasta !== null && await fsp.stat(pasta).then((info) => info.isDirectory(), () => false);
  if (!ehPasta) throw new ErroDeJanela('JANELA_ARQUIVO_INVALIDO');
  if (raizArmazenamento !== null) {
    // A contenção usa a pasta já resolvida (link simbólico para dentro do armazenamento conta como dentro); sem a raiz em disco, vale o caminho léxico.
    const raiz = await fsp.realpath(raizArmazenamento).catch(() => path.resolve(raizArmazenamento));
    if (dentroDe(pasta, raiz)) throw new ErroDeJanela('JANELA_DENTRO_DO_ARMAZENAMENTO');
  }
  return path.join(pasta, path.basename(arquivo));
}

function documentoValido(texto) {
  let documento;
  try { documento = JSON.parse(texto); } catch { return null; }
  if (documento === null || typeof documento !== 'object' || Array.isArray(documento)) return null;
  const chaves = Object.keys(documento).sort();
  if (chaves.length !== CAMPOS.length || chaves.some((chave, i) => chave !== CAMPOS[i])) return null;
  const { versao, tipo, pid, hospedeiro, iniciadoEm, token } = documento;
  const valido = versao === VERSAO && Object.values(TIPOS).includes(tipo) && Number.isSafeInteger(pid) && pid >= 1
    && hospedeiroValido(hospedeiro) && typeof iniciadoEm === 'string' && INSTANTE.test(iniciadoEm) && !Number.isNaN(Date.parse(iniciadoEm))
    && typeof token === 'string' && TOKEN.test(token);
  return valido ? documento : null;
}

const descrever = ({ versao, tipo, pid, hospedeiro, iniciadoEm }) => ({ versao, tipo, pid, hospedeiro, iniciadoEm });

/** Documento da trava (com o token, só para uso interno), AUSENTE se não há arquivo, ou null se há algo ilegível ou fora do protocolo. Nunca segue link simbólico. */
async function lerDocumento(alvo) {
  let aberto;
  try {
    aberto = await fsp.open(alvo, ABRIR_PARA_LER);
  } catch (e) {
    if (e.code === 'ENOENT') return AUSENTE;
    if (OCUPANTE_ILEGIVEL.has(e.code)) return null;
    throw e;
  }
  try {
    const info = await aberto.stat();
    if (!info.isFile() || info.size > LIMITE_DO_DOCUMENTO) return null;
    const { buffer, bytesRead } = await aberto.read(Buffer.alloc(LIMITE_DO_DOCUMENTO), 0, LIMITE_DO_DOCUMENTO, 0);
    return documentoValido(buffer.toString('utf8', 0, bytesRead));
  } finally {
    await aberto.close();
  }
}

/** Caminho da trava a partir do ambiente (função pura da origem recebida): null se ausente ou vazio; valor inválido é erro de configuração que não ecoa o valor. */
function lerArquivoDaJanela(origem) {
  if (origem === null || typeof origem !== 'object') throw new TypeError('origem inválida');
  const bruto = origem[VARIAVEL_ARQUIVO];
  if (bruto === undefined || bruto === null) return null;
  if (typeof bruto === 'string' && bruto.trim() === '') return null;
  if (typeof bruto !== 'string' || bruto !== bruto.trim() || !caminhoDeArquivoValido(bruto)) {
    throw Object.assign(new Error(`${VARIAVEL_ARQUIVO}: deve ser um caminho absoluto e canônico de arquivo`), { codigo: 'IMAGENS_CONFIGURACAO_INVALIDA' });
  }
  return bruto;
}

/** As mesmas regras de caminho de adquirirJanela, sem criar nada. */
async function validarArquivoDaJanela({ arquivo, raizArmazenamento } = {}) {
  exigirRaiz(raizArmazenamento);
  await localDaTrava(arquivo, raizArmazenamento);
}

/** null se não há trava; o dono (sem o token) se há; JANELA_DOCUMENTO_INVALIDO se há algo ilegível ou fora do protocolo. */
async function lerJanela({ arquivo } = {}) {
  const alvo = await localDaTrava(arquivo);
  const documento = await lerDocumento(alvo);
  if (documento === AUSENTE) return null;
  if (documento === null) throw new ErroDeJanela('JANELA_DOCUMENTO_INVALIDO');
  return descrever(documento);
}

async function adquirirJanela({ arquivo, tipo, raizArmazenamento, agora = Date.now, pid = process.pid, hospedeiro = nomeDoHospedeiro() } = {}) {
  exigirRaiz(raizArmazenamento);
  if (!Object.values(TIPOS).includes(tipo)) throw new ErroDeJanela('JANELA_TIPO_INVALIDO');
  if (!Number.isSafeInteger(pid) || pid < 1 || !hospedeiroValido(hospedeiro)) throw new TypeError('pid ou hospedeiro da janela inválido');
  const iniciadoEm = instanteIso(agora);
  const alvo = await localDaTrava(arquivo, raizArmazenamento);
  const token = crypto.randomBytes(16).toString('hex');

  let aberto;
  try {
    aberto = await fsp.open(alvo, ABRIR_PARA_CRIAR, 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const dono = await lerDocumento(alvo);
    throw new ErroDeJanela('JANELA_OCUPADA', typeof dono === 'object' && dono !== null ? descrever(dono) : null);
  }
  try {
    await aberto.chmod(0o600);
    await aberto.writeFile(`${JSON.stringify({ versao: VERSAO, tipo, pid, hospedeiro, iniciadoEm, token })}\n`);
  } finally {
    await aberto.close();
  }

  let encerrada = false;
  async function liberar() {
    if (encerrada) return { liberada: false };
    const atual = await lerDocumento(alvo);
    if (atual === null) return { liberada: false };
    if (atual === AUSENTE || atual.token !== token) {
      encerrada = true;
      return { liberada: false };
    }
    try {
      await fsp.unlink(alvo);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      encerrada = true;
      return { liberada: false };
    }
    encerrada = true;
    return { liberada: true };
  }
  /** A trava ainda é DESTA aquisição? Só lê: ausente, ilegível, link, fora do protocolo ou de outro token (mesmo com tipo, PID e instante iguais) = não. */
  async function confirmarPosse() {
    if (encerrada) return { confirmada: false };
    const atual = await lerDocumento(alvo);
    return { confirmada: atual !== null && atual !== AUSENTE && atual.token === token };
  }
  return Object.freeze({ tipo, liberar, confirmarPosse });
}

module.exports = { TIPOS, VARIAVEL_ARQUIVO, ErroDeJanela, adquirirJanela, lerJanela, lerArquivoDaJanela, validarArquivoDaJanela };
