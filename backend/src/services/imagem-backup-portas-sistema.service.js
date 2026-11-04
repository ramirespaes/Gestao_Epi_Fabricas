'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): PORTAS REAIS DO SISTEMA para a composição de produção. Cada porta é uma função/fábrica PEQUENA e sem estado global; nenhuma é executada ao carregar o módulo, e nada aqui lê ambiente.
 *  - `criarSpawnReal()`: o `spawn` do Node, escolhido só quando chamado (o `require('node:child_process')` é adiado);
 *  - `observarGrupoReal(pgid)`: `true` (grupo com membros), `false` (ESRCH: grupo vazio), exceção em qualquer outra resposta (o controle de processo trata exceção como INCONCLUSIVO, nunca como "vazio"). É uma OBSERVAÇÃO, não prova de identidade do grupo;
 *  - `temporizadorReal`: `prazo(ms)` -> `{ promessa, cancelar }`; `intervalo(ms)` -> promessa;
 *  - `criarCriadorExclusivoDeArquivo()` -> `{ criarExclusivo(spec), ultimoCaminho() }`: cria o arquivo do dump SOMENTE de forma exclusiva e sem seguir link (`O_CREAT|O_EXCL|O_NOFOLLOW`), modo 0600, em diretório absoluto, canônico (realpath igual), real e próprio; confere depois da abertura que é arquivo regular, com um único vínculo e do usuário do processo. Arquivo existente, link, diretório inseguro,
 *    modo diferente de 0600 ou nome fora do padrão são recusados (EEXIST/ELOOP/códigos fixos), sem reaproveitar nem truncar nada.
 * LIMITES: a observação de grupo e o `kill` do filho não eliminam reutilização de PID (documentado no controle de processo); a exclusividade é do nome do arquivo no instante da criação.
 */

const NOME_DO_ARQUIVO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function criarSpawnReal() {
  return require('node:child_process').spawn;
}

/**
 * `spawn` GENUÍNO = a própria função do Node (identidade) ou o `spawn` de um supervisor de sentinelas que usa o `child_process.spawn` real interno (marca guardada em módulo, sem acesso externo; imagem-backup-sentinela-lancador.service).
 * Uma função injetada, mesmo que imite o filho, nunca é.
 */
const ehSpawnReal = (fn) => typeof fn === 'function' && (fn === require('node:child_process').spawn || require('./imagem-backup-sentinela-lancador.service').ehSpawnDeSentinelaGenuino(fn));

async function observarGrupoReal(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new TypeError('pgid inválido');
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (falha) {
    if (falha && falha.code === 'ESRCH') return false;
    if (falha && falha.code === 'EPERM') return true; // existe, mas não é nosso para sinalizar: tratado como povoado
    throw falha;
  }
}

const temporizadorReal = Object.freeze({
  prazo(ms) {
    let t;
    const promessa = new Promise((resolver) => { t = setTimeout(resolver, ms); });
    return { promessa, cancelar() { clearTimeout(t); } };
  },
  intervalo: (ms) => new Promise((resolver) => { setTimeout(resolver, ms); }),
});

function erro(codigo) {
  const falha = new Error('falha na criação exclusiva do arquivo');
  falha.code = codigo;
  return falha;
}

function diretorioCanonico(diretorio) {
  if (typeof diretorio !== 'string' || diretorio.length < 2 || diretorio.length > 4096 || diretorio[0] !== '/' || diretorio.includes('\0')) return false;
  if (!diretorio.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..')) return false;
  try {
    const estado = fs.lstatSync(diretorio);
    if (estado.isSymbolicLink() || !estado.isDirectory()) return false;
    if (fs.realpathSync(diretorio) !== diretorio) return false;
    if (typeof process.getuid === 'function' && estado.uid !== process.getuid()) return false;
    return true;
  } catch {
    return false;
  }
}

function criarCriadorExclusivoDeArquivo() {
  let ultimo = null;
  function criarExclusivo(spec) {
    if (!ehObjeto(spec)) throw erro('SPEC_INVALIDO');
    const { diretorio, nome, modo, semSeguirLinks } = spec;
    if (modo !== 0o600 || semSeguirLinks !== true || typeof nome !== 'string' || !NOME_DO_ARQUIVO.test(nome) || !diretorioCanonico(diretorio)) throw erro('SPEC_INVALIDO');
    const alvo = path.join(diretorio, nome);
    let descritor;
    try {
      descritor = fs.openSync(alvo, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    } catch (falha) {
      throw erro(falha && falha.code === 'EEXIST' ? 'ARQUIVO_EXISTENTE' : 'CRIACAO_FALHOU');
    }
    try {
      const estado = fs.fstatSync(descritor);
      if (!estado.isFile() || estado.nlink !== 1 || (typeof process.getuid === 'function' && estado.uid !== process.getuid()) || (estado.mode & 0o077) !== 0) throw erro('ARQUIVO_INSEGURO');
    } catch (falha) {
      try { fs.closeSync(descritor); } catch { /* já fechado */ }
      throw falha;
    }
    ultimo = alvo;
    let fechado = false;
    return { descritor, fechar() { if (!fechado) { fechado = true; fs.closeSync(descritor); } } };
  }
  return Object.freeze({ criarExclusivo, ultimoCaminho: () => ultimo });
}

module.exports = { ehSpawnReal, criarSpawnReal, observarGrupoReal, temporizadorReal, criarCriadorExclusivoDeArquivo };
