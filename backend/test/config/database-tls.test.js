'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { opcoesDeTls, ERROS } = require('../../src/config/database-tls');

/** D-F7: TLS do banco por opt-in explícito (DB_SSL_MODE=verify-full). Sem banco, sem rede; certificado é um arquivo temporário sintético. */

let pasta;
let cert;
before(() => {
  pasta = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'db-tls-'));
  cert = path.join(pasta, 'ca.pem');
  fs.writeFileSync(cert, '-----BEGIN CERTIFICATE-----\nsintetico\n-----END CERTIFICATE-----\n', { mode: 0o600 });
});
after(() => fs.rmSync(pasta, { recursive: true, force: true }));

const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

describe('[DB-TLS] opcoesDeTls', () => {
  test('TLS-01 — sem DB_SSL_MODE nada muda: objeto vazio, sem chave ssl', () => {
    for (const modo of [undefined, null, '', '  ']) {
      const r = opcoesDeTls({ modo, host: 'db.exemplo', pgsslmode: 'require' });
      assert.deepEqual({ ...r }, {});
      assert.equal(Object.hasOwn(r, 'ssl'), false);
    }
  });

  test('TLS-02 — verify-full sem certificado: cadeia do sistema, rejectUnauthorized true', () => {
    const r = opcoesDeTls({ modo: 'verify-full', host: 'db.exemplo' });
    assert.deepEqual({ ...r.ssl }, { rejectUnauthorized: true });
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.ssl));
  });

  test('TLS-03 — com certificado seguro: ca é o conteúdo do arquivo', () => {
    const r = opcoesDeTls({ modo: 'verify-full', raizCa: cert, host: 'db.exemplo', pgsslmode: 'verify-full' });
    assert.equal(r.ssl.rejectUnauthorized, true);
    assert.ok(Buffer.isBuffer(r.ssl.ca) && r.ssl.ca.toString().includes('sintetico'));
  });

  test('TLS-04 — falha fechada com códigos fixos e mensagens sem valores', () => {
    assert.equal(codigo(() => opcoesDeTls({ modo: 'require' })), 'TLS_MODO_INVALIDO');
    assert.equal(codigo(() => opcoesDeTls({ modo: 'no-verify' })), 'TLS_MODO_INVALIDO');
    assert.equal(codigo(() => opcoesDeTls({ modo: 'disable' })), 'TLS_MODO_INVALIDO');
    assert.equal(codigo(() => opcoesDeTls({ modo: 'verify-full', host: '/var/run/postgresql' })), 'TLS_INCOMPATIVEL_COM_SOCKET');
    assert.equal(codigo(() => opcoesDeTls({ modo: 'verify-full', pgsslmode: 'require' })), 'TLS_CONFLITO_COM_PGSSLMODE');
    assert.equal(codigo(() => opcoesDeTls({ raizCa: cert })), 'TLS_CERTIFICADO_SEM_MODO');
    assert.equal(codigo(() => opcoesDeTls({ modo: 'verify-full', raizCa: path.join(pasta, 'nao-existe.pem') })), 'TLS_CERTIFICADO_INVALIDO');
    assert.equal(codigo(() => opcoesDeTls({ modo: 'verify-full', raizCa: 'relativo/ca.pem' })), 'TLS_CERTIFICADO_INVALIDO');
    try { opcoesDeTls({ modo: 'segredo-xyz' }); } catch (e) { assert.ok(!e.message.includes('segredo-xyz')); assert.equal(e.message, ERROS.TLS_MODO_INVALIDO); }
  });

  test('TLS-05 — certificado: permissões frouxas, symlink e tamanho fora do limite são recusados', () => {
    const aberto = path.join(pasta, 'aberto.pem');
    fs.writeFileSync(aberto, 'x', { mode: 0o666 }); fs.chmodSync(aberto, 0o666);
    assert.equal(codigo(() => opcoesDeTls({ modo: 'verify-full', raizCa: aberto })), 'TLS_CERTIFICADO_INVALIDO');
    const elo = path.join(pasta, 'elo.pem');
    fs.symlinkSync(cert, elo);
    assert.equal(codigo(() => opcoesDeTls({ modo: 'verify-full', raizCa: elo })), 'TLS_CERTIFICADO_INVALIDO');
    const grande = path.join(pasta, 'grande.pem');
    fs.writeFileSync(grande, Buffer.alloc(64 * 1024 + 1, 65), { mode: 0o600 });
    assert.equal(codigo(() => opcoesDeTls({ modo: 'verify-full', raizCa: grande })), 'TLS_CERTIFICADO_INVALIDO');
    const vazio = path.join(pasta, 'vazio.pem');
    fs.writeFileSync(vazio, '', { mode: 0o600 });
    assert.equal(codigo(() => opcoesDeTls({ modo: 'verify-full', raizCa: vazio })), 'TLS_CERTIFICADO_INVALIDO');
  });

  test('TLS-06 — portas injetadas: leitura que falha ou devolve não-Buffer é recusada', () => {
    const seguro = () => true;
    assert.equal(codigo(() => opcoesDeTls({ modo: 'verify-full', raizCa: '/x/ca.pem' }, { certificadoSeguro: seguro, lerArquivo: () => { throw new Error('boom'); } })), 'TLS_CERTIFICADO_INVALIDO');
    assert.equal(codigo(() => opcoesDeTls({ modo: 'verify-full', raizCa: '/x/ca.pem' }, { certificadoSeguro: seguro, lerArquivo: () => 'texto' })), 'TLS_CERTIFICADO_INVALIDO');
  });
});
