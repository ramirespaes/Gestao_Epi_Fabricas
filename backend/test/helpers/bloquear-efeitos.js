'use strict';

/**
 * Pré-carregamento de TESTE (`node --require`): faz qualquer ESCRITA em arquivo, criação de diretório, remoção, renomeação, criação de processo ou
 * conexão de rede lançar EFEITO_PROIBIDO. Abrir arquivo só é permitido para LEITURA. Serve para provar, em um processo real, que o modo
 * `--verificar` do executor do backup não produz nenhum efeito além de ler metadados. Quem usa este arquivo acrescenta os testes ao final.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const cp = require('node:child_process');
const net = require('node:net');

function proibido(nome) {
  return () => { throw Object.assign(new Error(`EFEITO_PROIBIDO: ${nome}`), { code: 'EFEITO_PROIBIDO' }); };
}

const BITS_DE_ESCRITA = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC | fs.constants.O_EXCL;
/** Leitura: sem flags, 'r' ou 'rs', ou número sem nenhum bit de escrita (O_RDONLY com O_NOFOLLOW, O_NONBLOCK etc. continua leitura). */
const SOMENTE_LEITURA = (flags) => flags === undefined || flags === null || flags === 'r' || flags === 'rs' || (typeof flags === 'number' && (flags & BITS_DE_ESCRITA) === 0);

function guardarAbertura(objeto, nome, indiceFlags) {
  const original = objeto[nome];
  objeto[nome] = function aberturaGuardada(...args) {
    if (!SOMENTE_LEITURA(args[indiceFlags])) throw Object.assign(new Error(`EFEITO_PROIBIDO: ${nome} com escrita`), { code: 'EFEITO_PROIBIDO' });
    return original.apply(this, args);
  };
}

for (const nome of [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'unlink', 'unlinkSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'createWriteStream', 'truncate', 'truncateSync',
  'symlink', 'symlinkSync', 'link', 'linkSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync',
]) fs[nome] = proibido(`fs.${nome}`);
for (const nome of [
  'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'truncate', 'symlink', 'link', 'chmod', 'chown', 'utimes',
]) fsp[nome] = proibido(`fs.promises.${nome}`);
guardarAbertura(fs, 'openSync', 1);
guardarAbertura(fs, 'open', 1);
guardarAbertura(fsp, 'open', 0 + 1);

for (const nome of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[nome] = proibido(`child_process.${nome}`);
net.Socket.prototype.connect = proibido('net.Socket.connect');
net.connect = proibido('net.connect');
net.createConnection = proibido('net.createConnection');
net.Server.prototype.listen = proibido('net.Server.listen');
