'use strict';
// O adaptador S3 do CD passa a ter um prefixo por escopo: o cliente do backend só toca hml-backend/ e o do frontend só toca hml/.
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../../../..');
const { criarS3 } = require(path.join(RAIZ, 'deploy/hml/cd/s3'));
const CRED = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
let dir, exe, antes;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-s3p-'));
  exe = path.join(dir, 'aws-falso');
  fs.writeFileSync(exe, `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.argv[1] + '.log', JSON.stringify(a) + '\\n');
if (a[0] === 'sts') console.log(JSON.stringify({ Account: '111111111111' }));
else if (a[1] === 'list-objects-v2') {
  const p = a[a.indexOf('--prefix') + 1];
  console.log(JSON.stringify({ IsTruncated: false, Contents: [{ Key: p.endsWith('/') ? p + '123-1.json' : p, LastModified: '2026-11-18T12:00:00Z' }] }));
} else if (a[1] === 'get-object') { fs.writeFileSync(a[a.indexOf('--expected-bucket-owner') + 2], '{}'); console.log('{}'); }
else console.log('{}');
`, { mode: 0o700 });
  antes = Object.fromEntries(CRED.map((n) => [n, process.env[n]]));
  for (const n of CRED) process.env[n] = 'sintetico';
});
afterEach(() => {
  for (const n of CRED) { if (antes[n] === undefined) delete process.env[n]; else process.env[n] = antes[n]; }
  fs.rmSync(dir, { recursive: true, force: true });
});
const cfg = (extra = {}) => ({ bucket: 'hml-exemplo-teste', conta: '111111111111', regiao: 'us-east-1', get executavel() { return exe; }, ...extra });
const chamadas = () => fs.readFileSync(`${exe}.log`, 'utf8').trim().split('\n').map(JSON.parse);
const recusa = (fn, codigo) => assert.throws(fn, (e) => { assert.equal(e.codigo, codigo); return true; });

describe('criarS3: prefixo por escopo', () => {
  test('sem prefixo o comportamento é o de sempre (hml/)', () => {
    const s3 = criarS3(cfg());
    s3.put('hml/blobs/123-1.json', Buffer.from('{}'));
    assert.equal(s3.get('hml/recibos/123-1.json').toString(), '{}');
    assert.deepEqual(s3.listarPedidos(), ['123-1']);
    recusa(() => s3.put('hml-backend/blobs/123-1.json', Buffer.from('{}')), 'CHAVE_INVALIDA');
    recusa(() => s3.get('hml-backend/recibos/123-1.json'), 'CHAVE_INVALIDA');
  });
  test('prefixo hml explícito equivale ao padrão', () => {
    const s3 = criarS3(cfg({ prefixo: 'hml' }));
    s3.put('hml/pedidos/123-1.json', Buffer.from('{}'));
    recusa(() => s3.put('hml-backend/pedidos/123-1.json', Buffer.from('{}')), 'CHAVE_INVALIDA');
  });
  test('cliente do backend só grava e lê em hml-backend/ e nunca em hml/', () => {
    const s3 = criarS3(cfg({ prefixo: 'hml-backend' }));
    s3.put('hml-backend/blobs/123-1.json', Buffer.from('{}'));
    s3.put('hml-backend/pedidos/123-1.json', Buffer.from('{}'));
    assert.equal(s3.get('hml-backend/recibos/123-1.json').toString(), '{}');
    for (const k of ['hml/blobs/123-1.json', 'hml/pedidos/123-1.json', 'hml/recibos/123-1.json']) {
      recusa(() => s3.put(k, Buffer.from('{}')), 'CHAVE_INVALIDA');
      recusa(() => s3.get(k), 'CHAVE_INVALIDA');
    }
    const chaves = chamadas().filter((a) => a.includes('--key')).map((a) => a[a.indexOf('--key') + 1]);
    assert.ok(chaves.length > 0 && chaves.every((k) => k.startsWith('hml-backend/')), chaves.join(','));
  });
  test('a verificação de existência do recibo usa o prefixo do próprio cliente', () => {
    const s3 = criarS3(cfg({ prefixo: 'hml-backend' }));
    s3.get('hml-backend/recibos/123-1.json');
    const lista = chamadas().find((a) => a[1] === 'list-objects-v2');
    assert.equal(lista[lista.indexOf('--prefix') + 1], 'hml-backend/recibos/123-1.json');
  });
  test('listarPedidos do cliente do backend lista só hml-backend/pedidos/', () => {
    const s3 = criarS3(cfg({ prefixo: 'hml-backend' }));
    assert.deepEqual(s3.listarPedidos(), ['123-1']);
    const lista = chamadas().filter((a) => a[1] === 'list-objects-v2').pop();
    assert.equal(lista[lista.indexOf('--prefix') + 1], 'hml-backend/pedidos/');
  });
  test('prefixo fora da lista conhecida é recusado, inclusive tentativas de travessia', () => {
    for (const prefixo of ['', 'prod', 'hml/', 'hml-backend/', '../hml', 'hml/../x', 'HML', null, 1, 'hml-backend2', ' hml']) recusa(() => criarS3(cfg({ prefixo })), 'S3_CONFIG');
  });
  test('chaves malformadas continuam recusadas em qualquer prefixo', () => {
    const s3 = criarS3(cfg({ prefixo: 'hml-backend' }));
    for (const k of ['hml-backend/outros/1-1.json', 'hml-backend/blobs/../x.json', 'hml-backend/blobs/a/b.json', 'hml-backend/blobs/x.txt', 'hml-backend//blobs/x.json', '/hml-backend/blobs/x.json']) {
      recusa(() => s3.put(k, Buffer.from('{}')), 'CHAVE_INVALIDA');
    }
  });
});
