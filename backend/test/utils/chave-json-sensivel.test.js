'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/utils/chave-json-sensivel');
const { CAMPOS_DO_CONTEXTO } = require('../../src/services/backup-executor-auditoria.service');

/**
 * PENDENCIA-SEG-TRG04 (Rodada A, R2) [CJS]: espelho em JS da função do banco (014 endurecida pela 097). RED→GREEN sem PostgreSQL: os quatro nomes
 * confirmados aceitos em banco real (PGPASSWORD, DBPASSWORD, ACCESSTOKEN, CLIENTSECRET) passam a ser recusados; o que a 014 já recusava continua
 * recusado; identificadores legítimos continuam aceitos. A igualdade das listas com o SQL é provada no teste estático da 097.
 */

const RECUSADAS_PELA_014 = ['senha', 'senhaHash', 'refresh_token', 'api-key', 'chave_privada', 'password', 'PG_PASSWORD', 'sessionToken', 'secretAccessKey', 'accessKey', 'credential', 'authorization', 'cookie', 'otp', 'totp', 'jwt', 'bearer', 'senha_alterada_em', 'Authorization', 'X-Api-Key', 'chaveAcesso', 'private.key'];
const RECUSADAS_PELA_097 = ['PGPASSWORD', 'DBPASSWORD', 'ACCESSTOKEN', 'CLIENTSECRET', 'secretkey', 'accesskey', 'privatekey', 'senhahash', 'passwordhash', 'dbsenha', 'appsegredo', 'usercredential', 'sessioncookie', 'tokenid', 'tokenhash', 'segredoatual', 'credencialexterna', 'cookiesessao', 'apikeyid', 'xapikey', 'chaveprivada', 'chavesecreta', 'chaveapi', 'chaveacesso', 'basicauthorization', 'pgpasswd', 'mypassphrase', 'clientcredentials'];
const LEGITIMAS = ['secretaria_id', 'hashtag', 'hash_arquivo', 'chave_primaria', 'chave', 'key', 'id', 'usuarioId', 'acaoCodigo', 'tipo', 'motivo', 'rota', 'alterada_em', 'empresaId', 'conjuntoId', 'sha256', 'estado', 'codigo', 'etiqueta', 'contagem', 'monkey', 'turkey', 'optional', 'secretariado', 'hotplate', 'pulso', 'autorizacao', 'cookbook', 'authorized', 'bearing', 'tokyo', 'totem', 'totem_id', 'perfil_ator', 'criado_em', 'referencia', ...CAMPOS_DO_CONTEXTO];

describe('[CJS] chave JSON sensível (espelho da 097)', () => {
  test('CJS-01 — o que a 014 recusava continua recusado (palavras inteiras, camelCase, separadores, pares adjacentes)', () => {
    for (const k of RECUSADAS_PELA_014) assert.equal(C.chaveJsonSensivel(k), true, k);
  });

  test('CJS-02 — RED→GREEN: os quatro nomes compostos sem separador confirmados aceitos em banco real e os demais compostos/sufixos/prefixos são recusados', () => {
    for (const k of RECUSADAS_PELA_097) assert.equal(C.chaveJsonSensivel(k), true, k);
  });

  test('CJS-03 — identificadores legítimos continuam aceitos, inclusive secretaria_id, hashtag, hash_arquivo, chave_primaria e as 15 chaves do contexto do executor', () => {
    assert.equal(CAMPOS_DO_CONTEXTO.length, 15);
    for (const k of LEGITIMAS) assert.equal(C.chaveJsonSensivel(k), false, k);
    for (const k of [null, undefined, 5, '', '___', '---']) assert.equal(C.chaveJsonSensivel(k), false, String(k));
  });

  test('CJS-04 — normalização idêntica à 014: camelCase vira snake, tudo minúsculo, separadores não alfanuméricos quebram, segmentos vazios somem', () => {
    assert.deepEqual(C.segmentosDe('refreshTokenV2'), ['refresh_token_v2'.split('_')].flat());
    assert.deepEqual(C.segmentosDe('X-Api-Key'), ['x', 'api', 'key']);
    assert.deepEqual(C.segmentosDe('__a..b__'), ['a', 'b']);
    assert.deepEqual(C.segmentosDe('PGPASSWORD'), ['pgpassword']);
  });

  test('CJS-05 — objetos: caminho da primeira chave sensível em qualquer profundidade, inclusive dentro de arrays; objeto limpo devolve null', () => {
    assert.equal(C.caminhoDaChaveSensivel({ a: { b: [{ c: 1 }, { PGPASSWORD: 'x' }] } }), 'a.b[1].PGPASSWORD');
    assert.equal(C.caminhoDaChaveSensivel({ tipo: 'DIRETA', dados: { usuarioId: 9 } }), null);
    assert.equal(C.objetoPossuiChaveSensivel({ x: [[{ clientsecret: 1 }]] }), true);
    assert.equal(C.objetoPossuiChaveSensivel(null), false);
    assert.equal(C.objetoPossuiChaveSensivel('texto'), false);
  });

  test('CJS-06 — exigirSemChaveSensivel: TypeError com o NOME do campo e o caminho da chave, nunca o valor; objeto limpo e null passam', () => {
    assert.doesNotThrow(() => C.exigirSemChaveSensivel(null, 'contexto'));
    assert.doesNotThrow(() => C.exigirSemChaveSensivel({ tipo: 'DIRETA' }, 'contexto'));
    const e = (() => { try { C.exigirSemChaveSensivel({ db: { DBPASSWORD: 'VALOR-SECRETO-123' } }, 'dadosNovos'); } catch (x) { return x; } return null; })();
    assert.ok(e instanceof TypeError);
    assert.match(e.message, /^dadosNovos contém chave JSON sensível \(db\.DBPASSWORD\)/);
    assert.ok(!e.message.includes('VALOR-SECRETO'));
  });

  test('CJS-07 — listas congeladas e versão da regra', () => {
    for (const lista of [C.PALAVRAS_INTEIRAS, C.PARES_ADJACENTES, C.COMPOSTOS, C.SUFIXOS, C.PREFIXOS]) assert.ok(Object.isFrozen(lista));
    assert.equal(C.MIGRATION_DA_REGRA, '097');
    assert.ok(!C.PREFIXOS.includes('secret'), "'secret' como prefixo bloquearia secretaria_id");
  });
});
