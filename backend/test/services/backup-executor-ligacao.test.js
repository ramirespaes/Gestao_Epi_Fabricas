'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../src/services/backup-executor-ligacao.service');
const C = require('../../src/services/backup-executor-credenciais.service');
const { criarSdkFalso } = require('../helpers/sdk-aws-falso');
const { fichaDeTeste } = require('../helpers/fichas-duraveis');

/** D-ORF-6, L1 (Bloco A): ligação local do executor (portas por papel, KMS, auditoria) com SDK e credenciais falsos. */

const ficha = fichaDeTeste('HOMOLOGACAO');
const AGORA = 1_800_000_000_000;
const forn = (papel) => ({ obter: async () => ({ papel, accessKeyId: `EXEMPLOIDCHAVE${papel.slice(0, 3)}01`, secretAccessKey: 'segredo-falso-0123456789' }) });
const conjunto = (acao, modo, papeis) => C.criarConjuntoDeCredenciais({ acao, modo, fornecedores: Object.fromEntries(papeis.map((p) => [p, forn(p)])), relogio: () => AGORA });
const auditoria = { registrar: async (e) => ({ gravado: true, id: '1', recebido: e }) };
const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const mk = (acao, modo, papeis, extra = {}) => {
  const f = criarSdkFalso({ ficha, relogio: () => AGORA });
  return { f, lig: L.criarLigacaoDoExecutor({ acao, modo, sdk: f.sdk, regiao: ficha.regiao, credenciais: conjunto(acao, modo, papeis), auditoria, ...extra }) };
};

describe('[LIG] ligação do executor', () => {
  test('LIG-01 — BACKUP em operação: só publicador e KMS', () => {
    const { lig } = mk('BACKUP', 'OPERACAO', ['PUBLICADOR']);
    assert.deepEqual(Object.keys(lig.portas), ['publicador']);
    assert.ok(lig.kms && typeof lig.kms.decifrar === 'function');
    assert.ok(Object.isFrozen(lig) && Object.isFrozen(lig.portas));
  });

  test('LIG-02 — BACKUP em ensaio com verificador; RESTAURACAO só restauração+KMS; VERIFICACAO_DESTINO só verificador sem KMS', () => {
    assert.deepEqual(Object.keys(mk('BACKUP', 'ENSAIO', ['PUBLICADOR', 'VERIFICADOR']).lig.portas).sort(), ['publicador', 'verificador']);
    const r = mk('RESTAURACAO', 'OPERACAO', ['RESTAURACAO']).lig;
    assert.deepEqual(Object.keys(r.portas), ['restauracao']);
    assert.ok(r.kms);
    const v = mk('VERIFICACAO_DESTINO', 'OPERACAO', ['VERIFICADOR']).lig;
    assert.deepEqual(Object.keys(v.portas), ['verificador']);
    assert.equal(v.kms, null);
  });

  test('LIG-03 — cada porta cria clientes com a credencial do SEU papel (uma função por cliente, distintas entre papéis)', async () => {
    const { f } = mk('BACKUP', 'ENSAIO', ['PUBLICADOR', 'VERIFICADOR']);
    const cs = f.estado.clientes;
    assert.ok(cs.length >= 4 && cs.every((c) => typeof c.config.credentials === 'function'));
    const ids = new Set();
    for (const c of cs) ids.add((await c.config.credentials()).accessKeyId);
    assert.deepEqual([...ids].sort(), ['EXEMPLOIDCHAVEPUB01', 'EXEMPLOIDCHAVEVER01']);
  });

  test('LIG-04 — papéis incoerentes com a ação/modo e opções fora da forma são recusados', () => {
    const f = criarSdkFalso({ ficha, relogio: () => AGORA });
    const base = { acao: 'RESTAURACAO', modo: 'OPERACAO', sdk: f.sdk, regiao: ficha.regiao, credenciais: conjunto('BACKUP', 'OPERACAO', ['PUBLICADOR']), auditoria };
    assert.equal(codigo(() => L.criarLigacaoDoExecutor(base)), 'LIGACAO_INVALIDA');
    assert.equal(codigo(() => L.criarLigacaoDoExecutor({ ...base, acao: 'BACKUP', extra: 1 })), 'LIGACAO_INVALIDA');
    assert.equal(codigo(() => L.criarLigacaoDoExecutor({ ...base, acao: 'BACKUP', auditoria: {} })), 'LIGACAO_INVALIDA');
    assert.equal(codigo(() => L.criarLigacaoDoExecutor({ ...base, acao: 'BACKUP', modo: 'PRODUCAO' })), 'LIGACAO_INVALIDA');
    assert.equal(codigo(() => L.criarLigacaoDoExecutor(undefined)), 'LIGACAO_INVALIDA');
  });

  test('LIG-05 — finalizar repassa a entrada à auditoria', async () => {
    const { lig } = mk('BACKUP', 'OPERACAO', ['PUBLICADOR']);
    const r = await lig.finalizar({ linha: 'x\n' });
    assert.equal(r.gravado, true);
    assert.deepEqual(r.recebido, { linha: 'x\n' });
  });
});
