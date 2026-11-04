'use strict';

const fs = require('node:fs');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): VALIDAÇÃO ÚNICA do "host" dos clientes PostgreSQL (`pg_dump`, `pg_restore`) para os quatro validadores do backup. Aceita EXATAMENTE duas formas, nunca uma terceira:
 *  - NOME de host (a regra que já existia, inalterada): `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$`;
 *  - DIRETÓRIO DE SOCKET UNIX, absoluto e canônico (cada componente em `[A-Za-z0-9._+~@-]`, sem `..`, `.`, `//`, barra final nem NUL), cujo caminho FÍSICO COMPLETO do socket, `<diretório>/.s.PGSQL.<porta>`, cabe no limite efetivo de `sun_path`
 *    do sistema (em BYTES, sem o NUL final: 103 no macOS, 107 no Linux). Não vale validar só o diretório: o limite é do caminho completo, e depende da porta.
 * A validação SINTÁTICA (`hostSintaticamenteValido`) é pura. A validação FÍSICA (`socketFisicoSeguro`), exigida antes de qualquer lançamento, confere que o diretório existe, é um diretório real (não link), é o próprio caminho resolvido (nenhum
 * componente é link simbólico), pertence ao usuário do processo e não é acessível a grupo nem a outros (modo sem bits 077). Não há fallback: a ausência de host, um host implícito ou um socket padrão nunca são aceitos aqui, e nenhuma função
 * deste módulo abre conexão. LIMITES: lstat/realpath não são atômicos contra troca concorrente; as permissões dos diretórios ANTECESSORES não são avaliadas.
 */

const NOME_DE_HOST = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const LIMITE_SUN_PATH = process.platform === 'darwin' ? 103 : 107;

const portaValida = (porta) => Number.isSafeInteger(porta) && porta >= 1 && porta <= 65535;

/** Diretório absoluto e canônico, sem validar o disco. */
function diretorioDeSocketCanonico(valor) {
  if (typeof valor !== 'string' || valor.length < 2 || valor.length > 4096 || valor[0] !== '/' || valor.includes('\0')) return false;
  return valor.slice(1).split('/').every((parte) => SEGMENTO.test(parte) && parte !== '.' && parte !== '..');
}

const caminhoDoSocket = (diretorio, porta) => `${diretorio}/.s.PGSQL.${porta}`;

/** `{ tipo: 'NOME' | 'SOCKET' }` ou `null`. `porta` só importa para o socket (o limite é do caminho completo). */
function hostSintaticamenteValido(host, porta) {
  if (typeof host !== 'string') return null;
  if (NOME_DE_HOST.test(host)) return { tipo: 'NOME' };
  if (!diretorioDeSocketCanonico(host) || !portaValida(porta)) return null;
  if (Buffer.byteLength(caminhoDoSocket(host, porta), 'utf8') > LIMITE_SUN_PATH) return null;
  return { tipo: 'SOCKET' };
}

/** Item de uma lista de hosts autorizados: nome de host ou diretório de socket canônico que caiba mesmo com a porta mais longa (o limite exato é rechecado com a porta real do destino). */
function hostAutorizavel(host) {
  if (typeof host !== 'string') return false;
  if (NOME_DE_HOST.test(host)) return true;
  return diretorioDeSocketCanonico(host) && Buffer.byteLength(caminhoDoSocket(host, 65535), 'utf8') <= LIMITE_SUN_PATH;
}

/** Validação FÍSICA do diretório do socket (síncrona, só leitura). Nome de host não tem diretório: sempre verdadeiro. */
function socketFisicoSeguro(host, porta) {
  const sintaxe = hostSintaticamenteValido(host, porta);
  if (sintaxe === null) return false;
  if (sintaxe.tipo === 'NOME') return true;
  try {
    const estado = fs.lstatSync(host);
    if (estado.isSymbolicLink() || !estado.isDirectory()) return false;
    if (fs.realpathSync(host) !== host) return false;
    if ((estado.mode & 0o077) !== 0) return false;
    if (typeof process.getuid === 'function' && estado.uid !== process.getuid()) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { hostSintaticamenteValido, hostAutorizavel, socketFisicoSeguro, diretorioDeSocketCanonico, caminhoDoSocket, LIMITE_SUN_PATH };
