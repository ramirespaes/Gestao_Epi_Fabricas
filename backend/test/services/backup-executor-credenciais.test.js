'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/services/backup-executor-credenciais.service');

/** D-ORF-6, L1 (Bloco A): contrato de credenciais por papel. Só fornecedores falsos; nada lê arquivo, ambiente ou rede. */

const AGORA = 1_800_000_000_000;
const relogio = () => AGORA;
const cred = (papel, extra = {}) => ({ papel, accessKeyId: `EXEMPLOIDCHAVE${papel.slice(0, 3)}01`, secretAccessKey: 'segredo-falso-0123456789', ...extra });
const fornecedor = (papel, extra) => ({ obter: async (p) => { assert.deepEqual(p, { papel }); return cred(papel, extra); } });
const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const codigoAsync = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

describe('[CRED] provedor por papel', () => {
  test('CRED-01 — devolve credencial congelada; segredo e sessão não enumeráveis', async () => {
    const prov = C.criarProvedorDeCredenciais({ papel: 'PUBLICADOR', fornecedor: fornecedor('PUBLICADOR', { sessionToken: 'sessao-falsa-0123456789', expiration: new Date(AGORA + 3600000) }), relogio });
    const c = await prov();
    assert.ok(Object.isFrozen(c));
    assert.equal(c.secretAccessKey, 'segredo-falso-0123456789');
    assert.equal(c.sessionToken, 'sessao-falsa-0123456789');
    assert.deepEqual(Object.keys(c).sort(), ['accessKeyId', 'expiration']);
    assert.ok(!JSON.stringify(c).includes('segredo-falso') && !JSON.stringify(c).includes('sessao-falsa'));
    assert.ok(!JSON.stringify({ ...c }).includes('segredo-falso'));
  });

  test('CRED-02 — outro papel, expirada (inclusive dentro da margem), campo extra, formato ruim e fornecedor que lança: recusados com código fixo', async () => {
    const mk = (f, o = {}) => C.criarProvedorDeCredenciais({ papel: 'PUBLICADOR', fornecedor: { obter: f }, relogio, ...o });
    assert.equal(await codigoAsync(mk(async () => cred('VERIFICADOR'))()), 'CREDENCIAL_DE_OUTRO_PAPEL');
    assert.equal(await codigoAsync(mk(async () => cred('PUBLICADOR', { expiration: new Date(AGORA - 1) }))()), 'CREDENCIAL_EXPIRADA');
    assert.equal(await codigoAsync(mk(async () => cred('PUBLICADOR', { expiration: new Date(AGORA + 30000) }))()), 'CREDENCIAL_EXPIRADA');
    assert.equal(await codigoAsync(mk(async () => cred('PUBLICADOR', { expiration: new Date(AGORA + 30000) }), { margemMs: 0 })()), null);
    assert.equal(await codigoAsync(mk(async () => cred('PUBLICADOR', { extra: 1 }))()), 'CREDENCIAL_INVALIDA');
    assert.equal(await codigoAsync(mk(async () => cred('PUBLICADOR', { accessKeyId: 'minusculo' }))()), 'CREDENCIAL_INVALIDA');
    assert.equal(await codigoAsync(mk(async () => cred('PUBLICADOR', { expiration: '2030' }))()), 'CREDENCIAL_INVALIDA');
    assert.equal(await codigoAsync(mk(async () => null)()), 'CREDENCIAL_INVALIDA');
    const e = await mk(async () => { throw new Error('SEGREDO-DO-FORNECEDOR'); })().catch((x) => x);
    assert.equal(e.code, 'CREDENCIAL_INDISPONIVEL');
    assert.ok(!e.message.includes('SEGREDO') && e.cause === undefined);
  });

  test('CRED-03 — configuração estrita', () => {
    const f = fornecedor('PUBLICADOR');
    assert.equal(codigo(() => C.criarProvedorDeCredenciais({ papel: 'PUBLICADOR', fornecedor: f, relogio, extra: 1 })), 'CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => C.criarProvedorDeCredenciais({ papel: 'ADMIN', fornecedor: f, relogio })), 'CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => C.criarProvedorDeCredenciais({ papel: 'PUBLICADOR', fornecedor: {}, relogio })), 'CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => C.criarProvedorDeCredenciais({ papel: 'PUBLICADOR', fornecedor: f })), 'CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => C.criarProvedorDeCredenciais({ papel: 'PUBLICADOR', fornecedor: f, relogio, margemMs: -1 })), 'CONFIGURACAO_INVALIDA');
  });
});

describe('[CRED] conjunto por ação e modo', () => {
  const forn = (...papeis) => Object.fromEntries(papeis.map((p) => [p, fornecedor(p)]));
  const mk = (acao, modo, fornecedores) => C.criarConjuntoDeCredenciais({ acao, modo, fornecedores, relogio });

  test('CRED-04 — papéis permitidos por ação: o verificador só entra no ensaio de backup', () => {
    assert.deepEqual(mk('BACKUP', 'OPERACAO', forn('PUBLICADOR')).papeis, ['PUBLICADOR']);
    assert.deepEqual(mk('BACKUP', 'ENSAIO', forn('PUBLICADOR', 'VERIFICADOR')).papeis, ['PUBLICADOR', 'VERIFICADOR']);
    assert.equal(codigo(() => mk('BACKUP', 'OPERACAO', forn('PUBLICADOR', 'VERIFICADOR'))), 'CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk('BACKUP', 'ENSAIO', forn('RESTAURACAO'))), 'CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk('BACKUP', 'ENSAIO', {})), 'CONFIGURACAO_INVALIDA');
    assert.deepEqual(mk('RESTAURACAO', 'OPERACAO', forn('RESTAURACAO')).papeis, ['RESTAURACAO']);
    assert.equal(codigo(() => mk('RESTAURACAO', 'ENSAIO', forn('RESTAURACAO', 'PUBLICADOR'))), 'CONFIGURACAO_INVALIDA');
    assert.deepEqual(mk('VERIFICACAO_DESTINO', 'OPERACAO', forn('VERIFICADOR')).papeis, ['VERIFICADOR']);
    assert.equal(codigo(() => mk('VERIFICACAO_DESTINO', 'OPERACAO', forn('PUBLICADOR'))), 'CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk('NADA', 'OPERACAO', forn('PUBLICADOR'))), 'CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => mk('BACKUP', 'TESTE', forn('PUBLICADOR'))), 'CONFIGURACAO_INVALIDA');
  });

  test('CRED-05 — o mesmo fornecedor não serve a dois papéis; papel fora do conjunto não tem provedor', () => {
    const unico = fornecedor('PUBLICADOR');
    assert.equal(codigo(() => mk('BACKUP', 'ENSAIO', { PUBLICADOR: unico, VERIFICADOR: unico })), 'CONFIGURACAO_INVALIDA');
    const c = mk('BACKUP', 'OPERACAO', forn('PUBLICADOR'));
    assert.equal(typeof c.credenciais('PUBLICADOR'), 'function');
    assert.equal(codigo(() => c.credenciais('VERIFICADOR')), 'CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => c.credenciais('constructor')), 'CONFIGURACAO_INVALIDA');
  });

  test('CRED-06 — verificarSeparacao exige accessKeyId distintos', async () => {
    const ok = mk('BACKUP', 'ENSAIO', forn('PUBLICADOR', 'VERIFICADOR'));
    assert.deepEqual(await ok.verificarSeparacao(), { ok: true, papeis: ['PUBLICADOR', 'VERIFICADOR'] });
    const igual = { PUBLICADOR: { obter: async () => cred('PUBLICADOR', { accessKeyId: 'EXEMPLOIDCHAVEIGUAL01' }) }, VERIFICADOR: { obter: async () => cred('VERIFICADOR', { accessKeyId: 'EXEMPLOIDCHAVEIGUAL01' }) } };
    assert.equal(await codigoAsync(mk('BACKUP', 'ENSAIO', igual).verificarSeparacao()), 'CREDENCIAIS_REPETIDAS_ENTRE_PAPEIS');
  });

  test('CRED-07 — papel da porta KMS por ação', () => {
    assert.deepEqual({ ...C.PAPEL_DA_PORTA_KMS }, { BACKUP: 'PUBLICADOR', RESTAURACAO: 'RESTAURACAO' });
  });
});
