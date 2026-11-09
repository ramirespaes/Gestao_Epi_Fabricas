'use strict';
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = path.resolve(__dirname, '..', '..', '..', '..', 'deploy', 'hml', 'instalador');
const ancora = require(path.join(DIR, 'ancora.js'));
const nucleo = require(path.join(DIR, 'nucleo.js'));

const modo = (p) => (fs.lstatSync(p).mode & 0o777);
const META = { rotulo: 'hml-20261107T224415-f6f5623', commit: 'f6f5623', manifestoSha256: 'a'.repeat(64) };

function cenario(umask, fn) {
  const antigo = process.umask(umask);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versao-modo-'));
  try {
    const A = ancora.criarAncora({ modo: 'caminho', semGarantiaDeCorrida: true });
    fn({ A, dir, ctx: { A, raiz: A.abrirBase(dir) } });
  } finally { process.umask(antigo); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('versao.json sai 0644 mesmo sob umask 077 (instalação)', () => cenario(0o077, ({ ctx, dir }) => {
  nucleo.escreverVersao(ctx, 'portal', META);
  assert.equal(modo(path.join(dir, 'versao.json')).toString(8), '644');
}));

test('versao.json sai 0644 sob umask 022, 027 e 000 (sem alargar além do pedido)', () => {
  for (const u of [0o022, 0o027, 0o000]) cenario(u, ({ ctx, dir }) => {
    nucleo.escreverVersao(ctx, 'painel', META);
    assert.equal(modo(path.join(dir, 'versao.json')).toString(8), '644', `umask ${u.toString(8)}`);
  });
});

test('regravação (rollback) corrige um versao.json antigo 0600 e atualiza o conteúdo', () => cenario(0o077, ({ ctx, dir }) => {
  const p = path.join(dir, 'versao.json');
  fs.writeFileSync(p, '{}\n', { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  nucleo.escreverVersao(ctx, 'portal', { ...META, rotulo: 'anterior' });
  assert.equal(modo(p).toString(8), '644');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).rotulo, 'anterior');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(p, 'utf8'))).sort(), ['commit', 'componente', 'manifestoSha256', 'rotulo']);
}));

test('arquivos privados continuam 0600 sob umask 077 (estado, meta, info)', () => cenario(0o077, ({ ctx, A, dir }) => {
  A.escreverAtomico(ctx.raiz, 'estado.json', '{}\n');
  A.escreverAtomico(ctx.raiz, 'x.json', '{}\n', 0o600);
  assert.equal(modo(path.join(dir, 'estado.json')).toString(8), '600');
  assert.equal(modo(path.join(dir, 'x.json')).toString(8), '600');
}));

test('link pré-existente com o nome de versao.json é substituído, nunca seguido', () => cenario(0o077, ({ ctx, dir }) => {
  const alvo = path.join(dir, 'alvo-privado');
  fs.writeFileSync(alvo, 'segredo\n', { mode: 0o600 });
  fs.symlinkSync(alvo, path.join(dir, 'versao.json'));
  nucleo.escreverVersao(ctx, 'portal', META);
  assert.equal(fs.lstatSync(path.join(dir, 'versao.json')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(alvo, 'utf8'), 'segredo\n');
  assert.equal(modo(alvo).toString(8), '600');
}));

test('link no nome do temporário não é seguido e não sobra temporário', () => cenario(0o077, ({ ctx, dir }) => {
  const alvo = path.join(dir, 'alvo-privado');
  fs.writeFileSync(alvo, 'segredo\n', { mode: 0o600 });
  fs.symlinkSync(alvo, path.join(dir, `versao.json.tmp-${process.pid}`));
  nucleo.escreverVersao(ctx, 'portal', META);
  assert.equal(fs.readFileSync(alvo, 'utf8'), 'segredo\n');
  assert.equal(modo(alvo).toString(8), '600');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
}));

test('falha no fchmod não deixa temporário nem versao.json parcial', () => {
  const antigo = process.umask(0o077);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versao-modo-'));
  try {
    const real = { ...fs };
    const fsFalho = { ...real, fchmodSync: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } };
    const A = ancora.criarAncora({ modo: 'caminho', semGarantiaDeCorrida: true, fsImpl: fsFalho });
    const ctx = { A, raiz: A.abrirBase(dir) };
    assert.throws(() => nucleo.escreverVersao(ctx, 'portal', META), /EPERM/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { process.umask(antigo); fs.rmSync(dir, { recursive: true, force: true }); }
});
