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

describe('[LDR] DEP-2 fechado por padrão', () => {
  test('LDR-01 — sem versões aprovadas, nada é carregado: SDK_NAO_APROVADO e o `requerer` nunca é chamado', () => {
    assert.ok(Object.isFrozen(L.VERSOES_APROVADAS));
    assert.deepEqual([...L.VERSOES_APROVADAS], []);
    const { requerer, chamadas } = requererFalso();
    assert.equal(codigo(() => L.carregarSdkAws({ requerer })), 'SDK_NAO_APROVADO');
    assert.deepEqual(chamadas, []);
  });

  test('LDR-02 — o repositório continua sem o SDK: nem package.json, nem lockfile, nem o pacote resolvível (mudar isto é o ato do gate DEP-2)', () => {
    const raiz = path.join(__dirname, '..', '..');
    const pacote = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
    const nomes = [...Object.keys(pacote.dependencies ?? {}), ...Object.keys(pacote.devDependencies ?? {}), ...Object.keys(pacote.optionalDependencies ?? {})];
    assert.deepEqual(nomes.filter((n) => /^@(aws-sdk|smithy|aws)\//.test(n) || n === 'aws-sdk'), []);
    const lock = JSON.parse(fs.readFileSync(path.join(raiz, 'package-lock.json'), 'utf8'));
    assert.deepEqual(Object.keys(lock.packages).filter((k) => /node_modules\/@(aws-sdk|smithy|aws)\//.test(k)), []);
    for (const p of L.PACOTES_DO_SDK) assert.throws(() => require.resolve(p), { code: 'MODULE_NOT_FOUND' }, p);
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
