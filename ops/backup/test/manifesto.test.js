'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const M = require('../lib/manifesto.js');
const CLI = path.join(__dirname, '..', 'lib', 'manifesto.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const dirTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backup-manifesto-'));

function execucao() {
  const d = dirTemp();
  fs.writeFileSync(path.join(d, 'banco.dump'), Buffer.from('PGDMP-conteudo-sintetico'));
  fs.writeFileSync(path.join(d, 'toc.txt'), '; Archive\n1; 1259 1 TABLE public a dono\n2; 1259 2 TABLE public b dono\n');
  return d;
}

function migrationsFixture() {
  const raiz = dirTemp();
  const mig = path.join(raiz, 'backend', 'migrations');
  fs.mkdirSync(mig, { recursive: true });
  for (const n of ['001_a.sql', '002_b.sql', '010_c.sql']) fs.writeFileSync(path.join(mig, n), 'select 1;');
  fs.writeFileSync(path.join(mig, 'checksums.json'), '{"001_a.sql":"x"}');
  return raiz;
}

const baseDados = (d) => ({
  runId: '20261114T120000Z-abcdef01',
  criadoEm: '2026-11-14T12:00:00Z',
  host: 'servidor-teste',
  bancoNome: 'banco_x',
  versaoPgDump: 'pg_dump (PostgreSQL) 16.15',
  dumpArquivo: path.join(d, 'banco.dump'),
  tocArquivo: path.join(d, 'toc.txt'),
  migrations: { ultima: '010_c.sql', total: 3, checksumsSha256: 'a'.repeat(64) },
});

test('sha256Arquivo calcula o SHA-256 por leitura em fluxo', async () => {
  const d = execucao();
  assert.equal(await M.sha256Arquivo(path.join(d, 'banco.dump')), sha(fs.readFileSync(path.join(d, 'banco.dump'))));
});

test('inspecionarMigrations: última, total e hash do checksums.json', () => {
  const raiz = migrationsFixture();
  const r = M.inspecionarMigrations(path.join(raiz, 'backend', 'migrations'));
  assert.equal(r.ultima, '010_c.sql');
  assert.equal(r.total, 3);
  assert.equal(r.checksumsSha256, sha('{"001_a.sql":"x"}'));
});

test('inspecionarMigrations devolve null quando o diretório não existe', () => {
  assert.equal(M.inspecionarMigrations('/nao/existe/migrations'), null);
});

test('construirManifesto produz o esquema esperado, parcial e só do banco', async () => {
  const d = execucao();
  const m = await M.construirManifesto(baseDados(d));
  assert.equal(m.esquema, 1);
  assert.equal(m.etapa, 'E1');
  assert.equal(m.escopo, 'BANCO');
  assert.equal(m.status, 'PARCIAL');
  assert.equal(m.run_id, '20261114T120000Z-abcdef01');
  assert.equal(m.banco.nome, 'banco_x');
  assert.equal(m.dump.arquivo, 'banco.dump');
  assert.equal(m.dump.formato, 'custom');
  assert.equal(m.dump.tamanho_bytes, fs.statSync(path.join(d, 'banco.dump')).size);
  assert.equal(m.dump.sha256, sha(fs.readFileSync(path.join(d, 'banco.dump'))));
  assert.equal(m.toc.entradas, 2);
  assert.equal(m.toc.sha256, sha(fs.readFileSync(path.join(d, 'toc.txt'))));
  assert.deepEqual(m.pendente, ['arquivos', 'fingerprints', 'armazenamento-remoto']);
  assert.equal(M.validarManifesto(m).ok, true);
});

test('validarManifesto recusa campos ausentes, hash inválido e run_id malformado', async () => {
  const d = execucao();
  const m = await M.construirManifesto(baseDados(d));
  const semDump = { ...m };
  delete semDump.dump;
  assert.equal(M.validarManifesto(semDump).ok, false);
  assert.equal(M.validarManifesto({ ...m, dump: { ...m.dump, sha256: 'xyz' } }).ok, false);
  assert.equal(M.validarManifesto({ ...m, run_id: 'qualquer coisa' }).ok, false);
});

test('validarManifesto recusa chaves e valores que sugerem segredo', async () => {
  const d = execucao();
  const m = await M.construirManifesto(baseDados(d));
  assert.equal(M.validarManifesto({ ...m, senha: 'x' }).ok, false);
  assert.equal(M.validarManifesto({ ...m, host: 'PGPASSWORD=abc' }).ok, false);
});

test('validarManifesto exige dump.arquivo = banco.dump e toc.arquivo = toc.txt (recusa absoluto, ../, subdiretório e outros nomes)', async () => {
  const d = execucao();
  const m = await M.construirManifesto(baseDados(d));
  assert.equal(M.validarManifesto(m).ok, true);
  const dumpsMaus = ['/etc/passwd', '../fora.bin', '../../x', 'sub/banco.dump', './banco.dump', 'banco.dump/', 'outro.dump', 'BANCO.DUMP', 'toc.txt', '', null, 42];
  for (const v of dumpsMaus) {
    const r = M.validarManifesto({ ...m, dump: { ...m.dump, arquivo: v } });
    assert.equal(r.ok, false, `dump.arquivo=${JSON.stringify(v)}`);
    assert.ok(r.erros.includes('dump'), `dump.arquivo=${JSON.stringify(v)}`);
  }
  const tocsMaus = ['/etc/passwd', '../fora.bin', '../../x', 'sub/toc.txt', './toc.txt', 'toc.txt/', 'outro.txt', 'TOC.TXT', 'banco.dump', '', null, 42];
  for (const v of tocsMaus) {
    const r = M.validarManifesto({ ...m, toc: { ...m.toc, arquivo: v } });
    assert.equal(r.ok, false, `toc.arquivo=${JSON.stringify(v)}`);
    assert.ok(r.erros.includes('toc'), `toc.arquivo=${JSON.stringify(v)}`);
  }
});

test('verificarManifesto recusa manifesto adulterado que aponta para arquivo fora da pasta, mesmo com .sha256 recalculado', async () => {
  const d = execucao();
  await M.gravarManifesto(d, await M.construirManifesto(baseDados(d)));
  const fora = path.join(path.dirname(d), `fora-${path.basename(d)}.bin`);
  fs.writeFileSync(fora, 'conteudo-fora-da-pasta');
  const arq = path.join(d, 'MANIFEST.json');
  const m = JSON.parse(fs.readFileSync(arq, 'utf8'));
  m.dump = { ...m.dump, arquivo: `../${path.basename(fora)}`, tamanho_bytes: fs.statSync(fora).size, sha256: sha(fs.readFileSync(fora)) };
  fs.writeFileSync(arq, `${JSON.stringify(m, null, 2)}\n`);
  fs.writeFileSync(`${arq}.sha256`, `${sha(fs.readFileSync(arq))}  MANIFEST.json\n`);
  const r = await M.verificarManifesto(d);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => /campo inválido: dump/.test(e)), JSON.stringify(r.erros));
});

test('gravarManifesto grava MANIFEST.json e o .sha256 com permissão 0600', async () => {
  const d = execucao();
  const m = await M.construirManifesto(baseDados(d));
  await M.gravarManifesto(d, m);
  const arq = path.join(d, 'MANIFEST.json');
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${arq}.sha256`).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(`${arq}.sha256`, 'utf8'), `${sha(fs.readFileSync(arq))}  MANIFEST.json\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, 'utf8')), m);
});

test('verificarManifesto aprova a execução íntegra', async () => {
  const d = execucao();
  await M.gravarManifesto(d, await M.construirManifesto(baseDados(d)));
  assert.deepEqual(await M.verificarManifesto(d), { ok: true, erros: [] });
});

test('verificarManifesto detecta dump alterado, toc alterado e manifesto adulterado', async () => {
  for (const alvo of ['banco.dump', 'toc.txt', 'MANIFEST.json']) {
    const d = execucao();
    await M.gravarManifesto(d, await M.construirManifesto(baseDados(d)));
    fs.appendFileSync(path.join(d, alvo), 'x');
    const r = await M.verificarManifesto(d);
    assert.equal(r.ok, false, alvo);
    assert.ok(r.erros.length > 0);
  }
});

test('verificarManifesto detecta arquivo ausente', async () => {
  const d = execucao();
  await M.gravarManifesto(d, await M.construirManifesto(baseDados(d)));
  fs.unlinkSync(path.join(d, 'banco.dump'));
  assert.equal((await M.verificarManifesto(d)).ok, false);
});

test('CLI gerar e verificar: código 0 e manifesto válido', () => {
  const d = execucao();
  const raiz = migrationsFixture();
  const g = spawnSync(process.execPath, [CLI, 'gerar', d, '--run-id', '20261114T120000Z-abcdef01', '--banco', 'banco_x',
    '--versao-pg-dump', 'pg_dump (PostgreSQL) 16.15', '--host', 'servidor-teste', '--repo-raiz', raiz], { encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  const v = spawnSync(process.execPath, [CLI, 'verificar', d], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(d, 'MANIFEST.json'), 'utf8'));
  assert.equal(m.aplicacao.ultima_migration, '010_c.sql');
});

test('CLI gerar sem repo-raiz registra aplicação como null e ainda é válido', () => {
  const d = execucao();
  const g = spawnSync(process.execPath, [CLI, 'gerar', d, '--run-id', '20261114T120000Z-abcdef01', '--banco', 'banco_x',
    '--versao-pg-dump', 'pg_dump (PostgreSQL) 16.15', '--host', 'servidor-teste'], { encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'MANIFEST.json'), 'utf8')).aplicacao, null);
});

test('CLI recusa subcomando desconhecido e verificar de diretório adulterado', async () => {
  assert.equal(spawnSync(process.execPath, [CLI, 'x'], { encoding: 'utf8' }).status, 2);
  const d = execucao();
  await M.gravarManifesto(d, await M.construirManifesto(baseDados(d)));
  fs.appendFileSync(path.join(d, 'banco.dump'), 'x');
  assert.equal(spawnSync(process.execPath, [CLI, 'verificar', d], { encoding: 'utf8' }).status, 1);
});
