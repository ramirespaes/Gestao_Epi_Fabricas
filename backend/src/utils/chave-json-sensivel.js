'use strict';

/**
 * Nome de chave JSON sensível — PRIMEIRA barreira da aplicação para os três repositórios de auditoria (logs_auditoria, logs_auditoria_plataforma,
 * logs_auditoria_identidade). Espelha, regra por regra e lista por lista, a função `logs_auditoria_chave_json_e_sensivel` do banco (migration 014
 * endurecida pela 097); o teste estático da 097 exige que as listas daqui sejam idênticas às do SQL. A segunda barreira continua sendo o gatilho de INSERT.
 *
 * Decide pelo NOME da chave, nunca pelo valor: camelCase e separadores não alfanuméricos viram segmentos minúsculos [a-z0-9]+; um segmento igual a uma
 * palavra sensível, um par adjacente proibido, um composto conhecido sem separador, ou um segmento com SUFIXO/PREFIXO sensível bloqueiam a chave.
 * `secretaria_id`, `hashtag`, `chave_primaria`, `key` e `chave` sozinhos continuam legítimos.
 */

const PALAVRAS_INTEIRAS = Object.freeze([
  'senha', 'senhas', 'password', 'passwords', 'passwd', 'pwd', 'passphrase',
  'token', 'tokens', 'jwt', 'bearer',
  'cookie', 'cookies',
  'secret', 'secrets', 'segredo', 'segredos',
  'credencial', 'credenciais', 'credential', 'credentials',
  'authorization', 'apikey', 'otp', 'totp',
]);
const PARES_ADJACENTES = Object.freeze([
  ['api', 'key'], ['private', 'key'], ['secret', 'key'], ['access', 'key'],
  ['chave', 'privada'], ['chave', 'secreta'], ['chave', 'api'], ['chave', 'acesso'],
].map((p) => Object.freeze(p)));
const COMPOSTOS = Object.freeze([
  'accesskey', 'privatekey', 'secretkey', 'senhahash', 'passwordhash',
  'chaveprivada', 'chavesecreta', 'chaveapi', 'chaveacesso',
]);
const SUFIXOS = Object.freeze([
  'senha', 'password', 'passwd', 'passphrase',
  'token', 'secret', 'segredo',
  'credencial', 'credential', 'credentials',
  'cookie', 'apikey', 'authorization',
]);
const PREFIXOS = Object.freeze([
  'senha', 'password', 'passwd', 'passphrase',
  'token', 'segredo',
  'credencial', 'credential',
  'cookie', 'apikey',
]);
const MIGRATION_DA_REGRA = '097';

/** Mesma normalização da 014: camelCase -> snake_case, minúsculas, quebra em [a-z0-9]+, sem segmentos vazios. */
function segmentosDe(chave) {
  return chave.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter((s) => s !== '');
}

function chaveJsonSensivel(chave) {
  if (typeof chave !== 'string') return false;
  const segmentos = segmentosDe(chave);
  if (segmentos.length === 0) return false;
  if (segmentos.some((s) => PALAVRAS_INTEIRAS.includes(s))) return true;
  for (let i = 0; i < segmentos.length - 1; i += 1) {
    if (PARES_ADJACENTES.some(([a, b]) => segmentos[i] === a && segmentos[i + 1] === b)) return true;
  }
  for (const s of segmentos) {
    if (COMPOSTOS.includes(s)) return true;
    if (SUFIXOS.some((p) => s.length > p.length && s.endsWith(p))) return true;
    if (PREFIXOS.some((p) => s.length > p.length && s.startsWith(p))) return true;
  }
  return false;
}

/** Percorre objetos e arrays em qualquer profundidade; devolve o caminho da primeira chave sensível ou null. */
function caminhoDaChaveSensivel(valor, prefixo = '') {
  if (valor === null || typeof valor !== 'object') return null;
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i += 1) {
      const achado = caminhoDaChaveSensivel(valor[i], `${prefixo}[${i}]`);
      if (achado !== null) return achado;
    }
    return null;
  }
  for (const k of Object.keys(valor)) {
    const caminho = prefixo === '' ? k : `${prefixo}.${k}`;
    if (chaveJsonSensivel(k)) return caminho;
    const achado = caminhoDaChaveSensivel(valor[k], caminho);
    if (achado !== null) return achado;
  }
  return null;
}

const objetoPossuiChaveSensivel = (valor) => caminhoDaChaveSensivel(valor) !== null;

/** Para os repositórios: lança TypeError (erro de programação do chamador) antes de qualquer INSERT. O nome da chave não é segredo; o valor nunca entra na mensagem. */
function exigirSemChaveSensivel(valor, nome) {
  const caminho = caminhoDaChaveSensivel(valor);
  if (caminho !== null) {
    throw new TypeError(`${nome} contém chave JSON sensível (${caminho.slice(0, 80)}): senha, token, cookie, secret, credencial ou chave de acesso nunca entram na auditoria`);
  }
}

module.exports = { chaveJsonSensivel, objetoPossuiChaveSensivel, caminhoDaChaveSensivel, exigirSemChaveSensivel, segmentosDe, PALAVRAS_INTEIRAS, PARES_ADJACENTES, COMPOSTOS, SUFIXOS, PREFIXOS, MIGRATION_DA_REGRA };
