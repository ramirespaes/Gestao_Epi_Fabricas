'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Área temporária EXCLUSIVA por execução do processador de imagens (D-12). O filho recebe TMPDIR e pasta atual apontando para um diretório
 * privado (0700, nome aleatório, criação exclusiva) que nasce e morre aqui: a remoção só acontece se o caminho ainda for o MESMO diretório
 * criado (tipo, dispositivo, inode e dono), nunca segue link simbólico e nunca varre a base (os.tmpdir()) fora do diretório criado.
 * O que sobrar dentro dele é inventariado antes da remoção: sobra = evidência de escrita temporária do decodificador. Nada aqui é dado de
 * negócio nem fonte de backup (NAO_PERSISTENTE).
 */

const PREFIXO = 'safework-imagem-';
const TENTATIVAS_DE_NOME = 5;
const SOBRAS_MAX = 100;
const { O_RDONLY, O_DIRECTORY = 0, O_NOFOLLOW = 0 } = fs.constants;

const ehArea = (a) => a !== null && typeof a === 'object' && typeof a.caminho === 'string' && path.isAbsolute(a.caminho)
  && path.basename(a.caminho).startsWith(PREFIXO) && Number.isInteger(a.dev) && Number.isInteger(a.ino) && Number.isInteger(a.uid)
  && Number.isInteger(a.fd) && a.fd >= 0;
const mesmoObjeto = (st, area) => Number(st.dev) === area.dev && Number(st.ino) === area.ino;
/** Tokens cujo descritor já foi fechado por este módulo: nunca fechar duas vezes (o número pode já pertencer a outro arquivo). */
const descritoresFechados = new WeakSet();

function criarAreaExclusiva({ base = os.tmpdir() } = {}) {
  if (typeof base !== 'string' || !path.isAbsolute(base)) throw new TypeError('base da área temporária deve ser um caminho absoluto');
  for (let tentativa = 0; tentativa < TENTATIVAS_DE_NOME; tentativa += 1) {
    const caminho = path.join(base, `${PREFIXO}${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    try {
      // Não recursivo: qualquer coisa já usando o nome (inclusive um link plantado) dá EEXIST e o nome é descartado.
      fs.mkdirSync(caminho, { mode: 0o700 });
    } catch (erro) {
      if (erro && erro.code === 'EEXIST') continue;
      throw erro;
    }
    // O descritor aberto prende o inode até a remoção: um diretório recriado com o mesmo nome nunca recebe a mesma identidade (Linux reutiliza inodes livres).
    const fd = fs.openSync(caminho, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const porDescritor = fs.fstatSync(fd);
    const porCaminho = fs.lstatSync(caminho);
    if (!porCaminho.isDirectory() || Number(porCaminho.dev) !== Number(porDescritor.dev) || Number(porCaminho.ino) !== Number(porDescritor.ino)) {
      fs.closeSync(fd);
      throw new Error('identidade da área temporária divergente logo após a criação');
    }
    return Object.freeze({ caminho, dev: Number(porDescritor.dev), ino: Number(porDescritor.ino), uid: Number(porDescritor.uid), fd });
  }
  throw new Error('não foi possível criar a área temporária exclusiva');
}

function inventariar(raiz) {
  const sobras = [];
  let truncado = false;
  const andar = (dir, rel) => {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (sobras.length >= SOBRAS_MAX) { truncado = true; return; }
      const relativo = rel ? `${rel}/${e.name}` : e.name;
      const tipo = e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'diretorio' : e.isFile() ? 'arquivo' : 'outro';
      let bytes = null;
      if (tipo === 'arquivo') { try { bytes = fs.lstatSync(path.join(dir, e.name)).size; } catch { bytes = null; } }
      sobras.push(Object.freeze({ caminho: relativo, tipo, bytes }));
      if (tipo === 'diretorio') andar(path.join(dir, e.name), relativo);
    }
  };
  andar(raiz, '');
  return { sobras: Object.freeze(sobras), truncado };
}

const resultado = (removida, motivo, inventario = { sobras: Object.freeze([]), truncado: false }) => Object.freeze({ removida, motivo, ...inventario });

/**
 * Prova de identidade pelo descritor guardado: só vale se ele ainda estiver aberto e apontar para o objeto registrado. Descritor fechado,
 * inválido ou reaproveitado por outro arquivo não prova nada e, por isso, nunca é fechado aqui (fechar número alheio seria pior).
 */
function descritorProvaIdentidade(area) {
  if (descritoresFechados.has(area)) return false;
  let porDescritor;
  try { porDescritor = fs.fstatSync(area.fd); } catch { return false; }
  return porDescritor.isDirectory() && mesmoObjeto(porDescritor, area);
}

function fecharDescritor(area) {
  if (descritoresFechados.has(area)) return;
  descritoresFechados.add(area);
  try { fs.closeSync(area.fd); } catch { /* já fechado */ }
}

/** Remove SÓ o diretório descrito pelo token devolvido por criarAreaExclusiva; se o caminho foi trocado, não toca em nada e relata. */
function removerAreaExclusiva(area) {
  if (!ehArea(area)) throw new TypeError('área temporária inválida');
  const provado = descritorProvaIdentidade(area);
  try {
    let st;
    try { st = fs.lstatSync(area.caminho); } catch (erro) {
      return resultado(false, erro && erro.code === 'ENOENT' ? 'INEXISTENTE' : 'INACESSIVEL');
    }
    if (!provado || !st.isDirectory() || !mesmoObjeto(st, area) || Number(st.uid) !== area.uid) return resultado(false, 'TROCADA');
    const inventario = inventariar(area.caminho);
    try {
      // Links dentro da área são removidos como links, nunca seguidos.
      fs.rmSync(area.caminho, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    } catch {
      return resultado(false, 'FALHA_AO_REMOVER', inventario);
    }
    return resultado(true, null, inventario);
  } finally {
    if (provado) fecharDescritor(area);
  }
}

module.exports = { criarAreaExclusiva, removerAreaExclusiva, PREFIXO, SOBRAS_MAX };
