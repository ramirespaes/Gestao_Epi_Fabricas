'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../../src/services/backup-aws-sdk-carregador.service');
const { criarSdkFalso } = require('../helpers/sdk-aws-falso');
const { fichaDeTeste } = require('../helpers/fichas-duraveis');

/**
 * DEP-2 [LDR]: o carregador do SDK da AWS. Enquanto `VERSOES_APROVADAS` estiver vazia (DEP-2 fechado), nada do SDK é carregado, mesmo que os pacotes sejam instalados por engano.
 * Depois da aprovação, só carrega a VERSÃO EXATA aprovada de cada pacote e devolve apenas os símbolos de que os adaptadores precisam.
 */

const VERSAO = '3.1152.0';
const APROVADAS = L.PACOTES_DO_SDK.map((pacote) => ({ pacote, versao: VERSAO }));
const sdkFalso = () => criarSdkFalso({ ficha: fichaDeTeste('HOMOLOGACAO') }).sdk;
const SDK = sdkFalso();

/** `requerer` falso: package.json com a versão e o módulo com os símbolos do SDK falso. */
function requererFalso({ versoes = {}, ausentes = [], semSimbolo = null, erroNoPacote = null } = {}) {
  const chamadas = [];
  const requerer = (nome) => {
    chamadas.push(nome);
    const pacote = L.PACOTES_DO_SDK.find((p) => nome === p || nome === `${p}/package.json`);
    if (pacote === undefined) throw Object.assign(new Error('fora do conjunto'), { code: 'MODULE_NOT_FOUND' });
    if (ausentes.includes(pacote)) throw Object.assign(new Error('ausente'), { code: 'MODULE_NOT_FOUND' });
    if (erroNoPacote === pacote) throw Object.assign(new Error('quebrado'), { code: 'ERR_QUALQUER' });
    if (nome.endsWith('/package.json')) return { name: pacote, version: versoes[pacote] ?? VERSAO };
    const modulo = { ...SDK };
    if (semSimbolo !== null) delete modulo[semSimbolo];
    return modulo;
  };
  return { requerer, chamadas };
}
const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

/** Pacotes que o cenário C2 do gate DEP-2 acrescenta ao lock: nome, versão e integridade revisadas (cutoff 2026-10-31, maturidade de 7 dias, 0 scripts, 0 depreciados). */
const PACOTES_DO_LOCK_C2 = [
  ['@aws-sdk/checksums', '3.1002.1', 'sha512-CXNESwkQC9jdrUG6cKXBfudVt1frGcYQykcCYbNclVrsewuGMbo3PlFjRteMe4OftNAqhyc3xC2jTz7SUqLasQ=='],
  ['@aws-sdk/client-kms', '3.1152.0', 'sha512-hQ9HoblAMUloJD+/uP0CJ/w0wAWrGNBtwJe5obXY8FzuZ8c1S1Vis0/l3lE2SMnmRi0ziY9+b2RpMr1x/O0A9A=='],
  ['@aws-sdk/client-s3', '3.1152.0', 'sha512-oI1+ZaM6pSOwZazu4nAb7rL8ug7LSjg31tDoJqRB9MooRqqWCf/qvkIZqne1mRA3xK3slg6K0RNWXaJYHbWLvg=='],
  ['@aws-sdk/client-sts', '3.1152.0', 'sha512-dLvk02UzZPRTeLLh8C86OpJBRzsJZ+fSxGqqdzoWOXACwZOf3xH6d4rQn54eZNPKYWaQNlt4VmfA5mZsfItbgw=='],
  ['@aws-sdk/core', '3.979.1', 'sha512-ayOlV1VhLNMiq8PW9ZkVobG4gkldnUoHjG69yy2b8j+VYFlhz/uAL7ZdYQAoQ+eShtGUdNDnnG5rxDg6yUJrOg=='],
  ['@aws-sdk/credential-provider-env', '3.972.80', 'sha512-uO5TiSvb6j1w9RTe5z28OaOmsrOxVQUPaC5+wZl50RfOXcrYD/KgnS8I9lfyGXc7sGbkCopK6VnhNIAoLqfewQ=='],
  ['@aws-sdk/credential-provider-http', '3.972.82', 'sha512-vQzlDHlC24Yz42p+rT4NBoP/5VdetkBoujbOLq9h6QYWC8THuZSPYnXIR9OP3XcOrdMgPBBipOrdssfxnIiWUg=='],
  ['@aws-sdk/credential-provider-ini', '3.973.25', 'sha512-b5xl71uCRdWsu7P1VeGpiGuCf6zfYETsSNOv8AmYVTrsgbvTJRXdmmOPVfxkvGGVNsiKkGctClQW3jAn0SZLug=='],
  ['@aws-sdk/credential-provider-login', '3.972.87', 'sha512-C4ZFmcwM+Zj14Z8huVUk54Gv4uzT1ZdzG9cY3Gdh8FePakq7Bss1OFsgZjAhWFOkFOGpBvFBeu0OWjWf8HNKRQ=='],
  ['@aws-sdk/credential-provider-node', '3.972.92', 'sha512-jC3zmOo7Qxlk+oBivvSsS1Ph7sFGm0QfuhqDGbqgRXi4cxUYMG+dWtBwS2XYYXgc8TIVXJiwgQ65sbNpbYupTA=='],
  ['@aws-sdk/credential-provider-process', '3.972.80', 'sha512-xqfixO5aclje7tbQJDias+iNND5wp/3QZixCdZcVQpgWPTZ0V5DfTW9A804A5Z7ezu7sH3WRO+vzUjtiJBA8yg=='],
  ['@aws-sdk/credential-provider-sso', '3.973.24', 'sha512-nlg3BKG03Cgzvv/dMnhxvDJPhAhQSpaN0RUdwgU7ziwkasoev7iI8el8Xy4Rd5sqzgaDUbV269fOXck5SargqA=='],
  ['@aws-sdk/credential-provider-web-identity', '3.972.86', 'sha512-zKTyLJBEyfQBVlYqT6Jt+mYV4r8kGbWM7dn6v4Y4MRARizhYafjDXP/iMu76UMRhToSPNmIKX1XAb24gtpBFIA=='],
  ['@aws-sdk/middleware-sdk-s3', '3.972.85', 'sha512-Kyl2G6zhIS9qFoeLdlxvXFrWyc6g9D9ZCIRJnGkkfX6JZhxCZB5ebXBc7GKEeetrnhXcail6ALZT0lKbojcaNA=='],
  ['@aws-sdk/nested-clients', '3.997.54', 'sha512-/OczlavsS7U5sOodRO10Ug4R/AKFVZiXTstKipWe68EfjPkmdDFNXNl9FCJyXWkg1DG6RBm3qAuVB8FNW9O8KQ=='],
  ['@aws-sdk/signature-v4-multi-region', '3.996.51', 'sha512-+aHvUugVBuMPXxgkPfWnTMyGdE/yWS8GHi5+qQ37HowS0YqzrbuaDLznj+Dtmtu5jgCdqz36gXmujOToUhNNWw=='],
  ['@aws-sdk/token-providers', '3.1161.0', 'sha512-ypbXSofNcSHwf/KA40bFCXJb0MLaAKrfT7sot4dFaA+2lsuXNah4zLRJIAU7Qmvs9PFJ6rnY0bZFEC+mE7attA=='],
  ['@aws-sdk/types', '3.975.0', 'sha512-WQlhs6juByzWOzj5fwxOx0mPJaEqMcG/sDpl3Id61B3XhKE63xY+0QWcnG+sWR/sCfprmreyUo1lM7IKZmHMzw=='],
  ['@aws-sdk/xml-builder', '3.972.42', 'sha512-smX8/gNP8Kjq+CWTBMZQLQ912vOQjiWExzwzvMO+eujPB5RY8IbtF0AGdUUXHKN7KoDWK9dIcuW0WG269kiP6w=='],
  ['@aws/lambda-invoke-store', '0.3.0', 'sha512-sl4Bm6yiMNYrZKkqqDFWN0UfnWhlS8ivKxrYl+6t0gCLrqr8y3B2IqZZbFRkfaVVp7C/baApyh71P+LeE1A2sQ=='],
  ['@smithy/core', '3.38.1', 'sha512-U/mB2XiwTLaf+NSgLSWwJfptsMT/H8aBi0aTAA/E5e2/TagFeGCqAyhKGG0w0A9IWTkm4qYEmLoD/HB6aYfnRA=='],
  ['@smithy/credential-provider-imds', '4.5.2', 'sha512-A9uSdn72ozbRUSit0eib0TW7nXuNPlaeM0zcGkJ+nE6tFcSDbnmtwoxbTCFBukVQcszDAyvsd7+rTduPTXpygg=='],
  ['@smithy/fetch-http-handler', '5.8.0', 'sha512-ycSJu3tFAQ4v04CBB0agqFMVsSQ1iG3yw+SpgxRqKfaURpQD4CZ8Wn0zPMmSnOuTpTh65Vz+EA0rMrw089wvkA=='],
  ['@smithy/node-http-handler', '4.14.1', 'sha512-/T6E1jzCL0fErS9uq8JqES/5yYQQ4ppVmmYHwXw2nlov8KFzLb+3QqHR5iAun1BsuAB50IPxZliV8YMgghLwhA=='],
  ['@smithy/signature-v4', '5.7.5', 'sha512-WPjdr5oWOk1LArpI4pavu+fSo+/evi0Re1olxGvqwuZopd4gYR1UGCi+Soyn/IjmafqbWs+ZC+3AKxJS3ZpwUg=='],
  ['@smithy/types', '4.19.0', 'sha512-r7jh49VJxGerfAcTQA6gXcKc+98zOp/tqRwzYjgOE+iSQsP6cEU1hq2QzbuipmP68QtYdY9wKEhiCQZIzHgZ4Q=='],
  ['bowser', '2.15.0', 'sha512-xic6KSZglg/I4ymp45fdM4GWfYpBK79Fxd/TOvJktlaPgQqqDxvmGwOPZl2V0dyeS3Lj5c180bLhXF43iyAjZQ=='],
];
const CLIENTES_EXATOS = { '@aws-sdk/client-kms': VERSAO, '@aws-sdk/client-s3': VERSAO, '@aws-sdk/client-sts': VERSAO };

describe('[LDR] DEP-2 aprovado no código, fechado por lista vazia', () => {
  test('LDR-01 — `VERSOES_APROVADAS` é congelada e lista os três clientes em 3.1152.0; com a lista injetada vazia (só em NODE_ENV=test) nada é carregado: SDK_NAO_APROVADO e o `requerer` nunca é chamado', () => {
    assert.ok(Object.isFrozen(L.VERSOES_APROVADAS));
    assert.ok(L.VERSOES_APROVADAS.every((v) => Object.isFrozen(v)));
    assert.deepEqual(L.VERSOES_APROVADAS.map((v) => ({ ...v })), [
      { pacote: '@aws-sdk/client-s3', versao: '3.1152.0' },
      { pacote: '@aws-sdk/client-kms', versao: '3.1152.0' },
      { pacote: '@aws-sdk/client-sts', versao: '3.1152.0' },
    ]);
    const { requerer, chamadas } = requererFalso();
    assert.equal(codigo(() => L.carregarSdkAws({ requerer, versoesAprovadas: [] })), 'SDK_NAO_APROVADO');
    assert.deepEqual(chamadas, []);
  });

  test('LDR-02 — package.json declara só os três clientes, em versão exata; o lock fixa os 27 pacotes do cenário C2 com a integridade revisada, sem script de instalação nem depreciação; os pacotes resolvem', () => {
    const raiz = path.join(__dirname, '..', '..');
    const pacote = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
    const doSdk = (n) => /^@(aws-sdk|smithy|aws)\//.test(n) || n === 'aws-sdk';
    const direto = (grupo) => Object.fromEntries(Object.entries(grupo ?? {}).filter(([n]) => doSdk(n)));
    assert.deepEqual(direto(pacote.dependencies), CLIENTES_EXATOS);
    assert.deepEqual(direto(pacote.devDependencies), {});
    assert.deepEqual(direto(pacote.optionalDependencies), {});
    const lock = JSON.parse(fs.readFileSync(path.join(raiz, 'package-lock.json'), 'utf8'));
    assert.deepEqual(direto(lock.packages[''].dependencies), CLIENTES_EXATOS);
    assert.equal(PACOTES_DO_LOCK_C2.length, 27);
    for (const [nome, versao, integridade] of PACOTES_DO_LOCK_C2) {
      const entrada = lock.packages[`node_modules/${nome}`];
      assert.ok(entrada, nome);
      assert.deepEqual({ versao: entrada.version, integridade: entrada.integrity, script: entrada.hasInstallScript ?? false, depreciado: entrada.deprecated ?? null, dev: entrada.dev ?? false, opcional: entrada.optional ?? false }, { versao, integridade, script: false, depreciado: null, dev: false, opcional: false }, nome);
    }
    const nomesC2 = new Set(PACOTES_DO_LOCK_C2.map(([n]) => `node_modules/${n}`));
    assert.deepEqual(Object.keys(lock.packages).filter((k) => /^node_modules\/(?:@(?:aws-sdk|smithy|aws|aws-crypto)\/|aws-sdk$)/.test(k) && !nomesC2.has(k)), []);
    for (const p of L.PACOTES_DO_SDK) assert.doesNotThrow(() => require.resolve(p), p);
  });
});

describe('[LDR] depois da aprovação (versões injetadas só em NODE_ENV=test)', () => {
  test('LDR-03 — carrega a versão exata e devolve SÓ os símbolos exigidos, congelados; não expõe o módulo inteiro', () => {
    const { requerer, chamadas } = requererFalso();
    const sdk = L.carregarSdkAws({ requerer, versoesAprovadas: APROVADAS });
    assert.ok(Object.isFrozen(sdk));
    assert.deepEqual(Object.keys(sdk).sort(), [...L.SIMBOLOS_EXIGIDOS].sort());
    for (const s of L.SIMBOLOS_EXIGIDOS) assert.equal(typeof sdk[s], 'function', s);
    assert.equal(chamadas.filter((c) => c.endsWith('/package.json')).length, 3);
  });

  test('LDR-04 — pacote ausente: SDK_NAO_INSTALADO; outro erro de carga: SDK_INCOMPATIVEL; versão diferente da aprovada: SDK_VERSAO_DIVERGENTE; símbolo ausente ou que não é função: SDK_INCOMPATIVEL', () => {
    const c = (req) => codigo(() => L.carregarSdkAws({ requerer: req, versoesAprovadas: APROVADAS }));
    assert.equal(c(requererFalso({ ausentes: ['@aws-sdk/client-kms'] }).requerer), 'SDK_NAO_INSTALADO');
    assert.equal(c(requererFalso({ erroNoPacote: '@aws-sdk/client-sts' }).requerer), 'SDK_INCOMPATIVEL');
    assert.equal(c(requererFalso({ versoes: { '@aws-sdk/client-s3': '3.1156.0' } }).requerer), 'SDK_VERSAO_DIVERGENTE');
    assert.equal(c(requererFalso({ semSimbolo: 'PutObjectCommand' }).requerer), 'SDK_INCOMPATIVEL');
    const quebrado = requererFalso().requerer;
    assert.equal(c((n) => (n === '@aws-sdk/client-s3' ? { ...SDK, S3Client: 'não é função' } : quebrado(n))), 'SDK_INCOMPATIVEL');
  });

  test('LDR-05 — o erro traz só código e pacote fixos, nunca a mensagem do erro original', () => {
    const { requerer } = requererFalso({ ausentes: ['@aws-sdk/client-s3'] });
    try { L.carregarSdkAws({ requerer, versoesAprovadas: APROVADAS }); assert.fail('deveria falhar'); } catch (e) {
      assert.deepEqual({ code: e.code, pacote: e.pacote }, { code: 'SDK_NAO_INSTALADO', pacote: '@aws-sdk/client-s3' });
      assert.doesNotMatch(e.message, /ausente|MODULE/);
    }
  });
});

describe('[LDR] configuração estrita', () => {
  test('LDR-06 — opções desconhecidas, `requerer` ausente ou não-função, e lista de versões incompleta, duplicada, com intervalo ou de outro pacote: CONFIGURACAO_INVALIDA', () => {
    const { requerer } = requererFalso();
    const c = (o) => codigo(() => L.carregarSdkAws(o));
    assert.equal(c(undefined), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({}), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ requerer: 'x' }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ requerer, extra: 1 }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ requerer, versoesAprovadas: APROVADAS.slice(0, 2) }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ requerer, versoesAprovadas: [...APROVADAS, APROVADAS[0]] }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ requerer, versoesAprovadas: APROVADAS.map((v) => ({ ...v, versao: `^${VERSAO}` })) }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ requerer, versoesAprovadas: APROVADAS.map((v) => ({ ...v, versao: 'latest' })) }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ requerer, versoesAprovadas: [{ pacote: 'aws-sdk', versao: VERSAO }, APROVADAS[1], APROVADAS[2]] }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ requerer, versoesAprovadas: [{ ...APROVADAS[0], extra: 1 }, APROVADAS[1], APROVADAS[2]] }), 'CONFIGURACAO_INVALIDA');
  });

  test('LDR-07 — fora de NODE_ENV=test a lista de versões NÃO pode ser injetada (só o código aprova o SDK)', () => {
    const anterior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.equal(codigo(() => L.carregarSdkAws({ requerer: requererFalso().requerer, versoesAprovadas: APROVADAS })), 'CONFIGURACAO_INVALIDA');
    } finally { process.env.NODE_ENV = anterior; }
  });
});
