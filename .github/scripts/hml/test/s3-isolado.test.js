'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const raiz = path.resolve(__dirname, '../../../..');
const { criarS3 } = require(path.join(raiz, 'deploy/hml/cd/s3'));
test('adaptador usa criação exclusiva, owner, TLS padrão e credencial temporária sem herdar endpoint/profile', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-52-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'aws-falso');
  fs.writeFileSync(exe, `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2), base = process.argv[1];
const modo = fs.readFileSync(base + '.modo','utf8');
fs.appendFileSync(base + '.log', JSON.stringify({args:a, endpoint:process.env.AWS_ENDPOINT_URL, perfil:process.env.AWS_PROFILE, config:process.env.AWS_CONFIG_FILE})+'\\n');
if(a[0]==='sts') { console.log(JSON.stringify({Account:modo==='conta'?'222222222222':'111111111111'})); }
else if(modo==='ausente') { console.log(JSON.stringify({Contents:[]})); }
else if(modo==='negado') { console.error('SENTINELA_PRIVADA'); process.exit(1); }
else if(a[1]==='get-object') { fs.writeFileSync(a[a.indexOf('--expected-bucket-owner')+2], '{}'); console.log('{}'); }
else if(a[1]==='list-objects-v2') { console.log(JSON.stringify({IsTruncated:modo==='fila',Contents:[{Key:a[a.indexOf('--prefix')+1]==='hml/pedidos/'?'hml/pedidos/123-1.json':a[a.indexOf('--prefix')+1],LastModified:'2026-11-07T12:00:00Z'}]})); }
else console.log('{}');
`, { mode: 0o700 });
  fs.writeFileSync(exe + '.modo', 'ok');
  const nomes = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_ENDPOINT_URL', 'AWS_PROFILE'];
  const antes = Object.fromEntries(nomes.map(n => [n, process.env[n]]));
  t.after(() => { for (const n of nomes) if (antes[n] === undefined) delete process.env[n]; else process.env[n] = antes[n]; });
  for (const n of nomes) process.env[n] = 'sintetico';
  const cfg = { bucket: 'hml-example-test', conta: '111111111111', regiao: 'us-east-1', executavel: exe };
  const s3 = criarS3(cfg);
  s3.put('hml/blobs/123-1.json', Buffer.from('{}'));
  assert.equal(s3.get('hml/recibos/123-1.json').toString(), '{}');
  assert.deepEqual(s3.listarPedidos(), ['123-1']);
  fs.writeFileSync(exe + '.modo', 'fila');
  assert.throws(() => s3.listarPedidos(), /FILA_EXCEDE_LIMITE/);
  const eventos = fs.readFileSync(exe + '.log', 'utf8').trim().split('\n').map(JSON.parse);
  for (const e of eventos) { assert.equal(e.endpoint, undefined); assert.equal(e.perfil, undefined); assert.equal(e.config, '/dev/null'); }
  const put = eventos.find(e => e.args[1] === 'put-object').args;
  assert.equal(put[put.indexOf('--if-none-match') + 1], '*');
  assert.equal(put[put.indexOf('--expected-bucket-owner') + 1], cfg.conta);
  assert.equal(put[put.indexOf('--server-side-encryption') + 1], 'AES256');
  fs.writeFileSync(exe + '.modo', 'ausente');
  assert.equal(s3.get('hml/recibos/123-1.json'), null);
  fs.writeFileSync(exe + '.modo', 'negado');
  assert.throws(() => s3.get('hml/recibos/123-1.json'), e => e.message === 'S3_OPERACAO_FALHOU' && !e.message.includes('SENTINELA'));
  fs.writeFileSync(exe + '.modo', 'conta');
  assert.throws(() => criarS3(cfg), /CONTA_DIVERGENTE/);
  delete process.env.AWS_SESSION_TOKEN;
  assert.throws(() => criarS3(cfg), /CREDENCIAL_TEMPORARIA/);
  assert.throws(() => s3.put('hml/pedidos/../x.json', Buffer.from('{}')), /CHAVE_INVALIDA/);
});
test('entrypoints bloqueados não chamam AWS nem instalador fora de contexto autorizado', () => {
  for (const [arquivo, args] of [['publicar.js', []], ['agente.js', ['--config', '/inexistente', '--pendentes']]]) {
    assert.throws(() => execFileSync(process.execPath, [path.join(raiz, 'deploy/hml/cd', arquivo), ...args], { env: { PATH: process.env.PATH }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), e => e.status === 1 && /CONTEXTO_BLOQUEADO|LINUX_OBRIGATORIO|CONFIG_INSEGURA|ROOT/.test(e.stderr));
  }
});
