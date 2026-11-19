'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMUM = path.join(__dirname, '..', 'lib', 'comum.sh');

function funcao(nome, args = [], env = {}) {
  return spawnSync('bash', ['-c', `source "${COMUM}"; ${nome} "$@"`, 'bash', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

function dirTemp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backup-comum-')));
}

test('sha256_arquivo coincide com o SHA-256 do Node', () => {
  const d = dirTemp();
  const arq = path.join(d, 'a.bin');
  fs.writeFileSync(arq, Buffer.from([0, 1, 2, 3, 250, 251]));
  const r = funcao('sha256_arquivo', [arq]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), crypto.createHash('sha256').update(fs.readFileSync(arq)).digest('hex'));
});

test('sha256_arquivo falha para arquivo inexistente', () => {
  const r = funcao('sha256_arquivo', ['/nao/existe/mesmo']);
  assert.notEqual(r.status, 0);
});

test('gerar_run_id: formato UTC + 8 hex, e valores distintos', () => {
  const a = funcao('gerar_run_id').stdout.trim();
  const b = funcao('gerar_run_id').stdout.trim();
  assert.match(a, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test('exigir_diretorio_privado aceita 0700 do próprio usuário', () => {
  const d = dirTemp();
  fs.chmodSync(d, 0o700);
  assert.equal(funcao('exigir_diretorio_privado', [d]).status, 0);
});

test('exigir_diretorio_privado recusa modo diferente de 0700', () => {
  const d = dirTemp();
  fs.chmodSync(d, 0o755);
  const r = funcao('exigir_diretorio_privado', [d]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /E_DESTINO_INSEGURO/);
});

test('exigir_diretorio_privado recusa caminho inexistente e arquivo comum', () => {
  const d = dirTemp();
  assert.notEqual(funcao('exigir_diretorio_privado', [path.join(d, 'nao-existe')]).status, 0);
  const arq = path.join(d, 'f');
  fs.writeFileSync(arq, 'x');
  assert.notEqual(funcao('exigir_diretorio_privado', [arq]).status, 0);
});

test('caminho_sincronizado reconhece áreas sincronizadas e aceita as demais', () => {
  const home = dirTemp();
  const env = { HOME: home };
  const sinc = [
    path.join(home, 'Desktop', 'x'),
    path.join(home, 'Documents', 'x'),
    path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'x'),
    path.join(home, 'Dropbox', 'x'),
    path.join(home, 'OneDrive - Empresa', 'x'),
    path.join(home, 'Google Drive', 'x'),
  ];
  for (const p of sinc) assert.equal(funcao('caminho_sincronizado', [p], env).status, 0, p);
  const livre = [path.join(home, 'SafeWorkDados', 'x'), path.join(os.tmpdir(), 'qualquer')];
  for (const p of livre) assert.notEqual(funcao('caminho_sincronizado', [p], env).status, 0, p);
});

test('caminho_sincronizado reconhece ~/Library/CloudStorage e subpastas (Google Drive, OneDrive, Box, Dropbox e outros provedores)', () => {
  const home = dirTemp();
  const env = { HOME: home };
  const nuvem = path.join(home, 'Library', 'CloudStorage');
  const sinc = [
    nuvem,
    path.join(nuvem, 'GoogleDrive-pessoa@exemplo.com', 'Meu Drive', 'x'),
    path.join(nuvem, 'OneDrive-Empresa', 'x'),
    path.join(nuvem, 'Box-Box', 'x'),
    path.join(nuvem, 'Dropbox', 'x'),
    path.join(nuvem, 'Outro-Provedor', 'a', 'b'),
  ];
  const aceitos = sinc.filter((p) => funcao('caminho_sincronizado', [p], env).status !== 0);
  assert.deepEqual(aceitos, [], 'caminhos sincronizados que passaram como locais');
});

test('caminho_sincronizado continua aceitando diretórios locais parecidos com CloudStorage', () => {
  const home = dirTemp();
  const env = { HOME: home };
  const livres = [
    path.join(home, 'Library', 'CloudStorageLocal', 'x'),
    path.join(home, 'Library', 'Caches', 'x'),
    path.join(home, 'Library', 'Application Support', 'x'),
    path.join(home, 'CloudStorage', 'x'),
    path.join(home, 'SafeWorkDados', 'x'),
    path.join(os.tmpdir(), 'qualquer'),
  ];
  const recusados = livres.filter((p) => funcao('caminho_sincronizado', [p], env).status === 0);
  assert.deepEqual(recusados, [], 'caminhos locais tratados como sincronizados');
});

test('run_id_livre: recusa o run_id se existir a execução final, FALHA-, NAOPUBLICAVEL-, em andamento ou link (mesmo quebrado)', () => {
  const ID = '20260101T000000Z-aabbccdd';
  const livre = dirTemp();
  assert.equal(funcao('run_id_livre', [livre, ID]).status, 0);
  for (const nome of [ID, `FALHA-${ID}`, `NAOPUBLICAVEL-${ID}`, `.em-andamento-${ID}`]) {
    const d = dirTemp();
    fs.mkdirSync(path.join(d, nome));
    assert.notEqual(funcao('run_id_livre', [d, ID]).status, 0, nome);
  }
  const comLink = dirTemp();
  fs.symlinkSync(path.join(comLink, 'inexistente'), path.join(comLink, ID));
  assert.notEqual(funcao('run_id_livre', [comLink, ID]).status, 0, 'link quebrado');
});

test('publicar_execucao: nome livre publica por rename (sem sobrar a origem)', () => {
  const d = dirTemp();
  const origem = path.join(d, '.em-andamento-X');
  fs.mkdirSync(origem);
  fs.writeFileSync(path.join(origem, 'dado.txt'), 'conteudo');
  const final = path.join(d, 'X');
  const r = funcao('publicar_execucao', [origem, final]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(final, 'dado.txt'), 'utf8'), 'conteudo');
  assert.ok(!fs.existsSync(origem));
  assert.deepEqual(fs.readdirSync(d), ['X']);
});

test('publicar_execucao: nome existente (diretório com dados, vazio, arquivo ou link) é recusado sem sobrescrever nem aninhar', () => {
  const casos = {
    'diretório com marcador': (final) => { fs.mkdirSync(final); fs.writeFileSync(path.join(final, 'marcador.txt'), 'original'); },
    'diretório vazio': (final) => { fs.mkdirSync(final); },
    arquivo: (final) => { fs.writeFileSync(final, 'original'); },
    'link quebrado': (final) => { fs.symlinkSync(`${final}-nada`, final); },
  };
  for (const [rotulo, preparar] of Object.entries(casos)) {
    const d = dirTemp();
    const origem = path.join(d, '.em-andamento-X');
    fs.mkdirSync(origem);
    fs.writeFileSync(path.join(origem, 'dado.txt'), 'conteudo');
    const final = path.join(d, 'X');
    preparar(final);
    const antes = fs.lstatSync(final).ino;
    const r = funcao('publicar_execucao', [origem, final]);
    assert.equal(r.status, 1, `${rotulo}: ${r.stderr}`);
    assert.equal(fs.readFileSync(path.join(origem, 'dado.txt'), 'utf8'), 'conteudo', `${rotulo}: a origem permanece íntegra`);
    assert.equal(fs.lstatSync(final).ino, antes, `${rotulo}: o existente não foi substituído`);
    if (rotulo === 'diretório com marcador') assert.deepEqual(fs.readdirSync(final), ['marcador.txt'], 'nada foi colocado dentro do existente');
    if (rotulo === 'diretório vazio') assert.deepEqual(fs.readdirSync(final), [], 'nada foi colocado dentro do existente');
  }
});

test('publicar_execucao: falha ao renomear (origem inexistente) devolve 2 e não deixa reserva', () => {
  const d = dirTemp();
  const r = funcao('publicar_execucao', [path.join(d, 'nao-existe'), path.join(d, 'X')]);
  assert.equal(r.status, 2, r.stderr);
  assert.ok(!fs.existsSync(path.join(d, 'X')));
});

// `mkdir` que falha sem criar nada, exceto para .em-andamento-*: simula falta de espaço ou permissão ao reservar o nome de publicação.
function pathMkdirFalha() {
  const bin = dirTemp();
  fs.writeFileSync(path.join(bin, 'mkdir'), '#!/bin/sh\nfor a in "$@"; do ultimo="$a"; done\ncase "$ultimo" in */.em-andamento-*) exec /bin/mkdir "$@";; esac\necho "mkdir: No space left on device (simulado)" >&2\nexit 1\n', { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

test('publicar_execucao: mkdir que falha sem colisão (espaço/permissão) devolve 2 e preserva a origem; colisão real continua devolvendo 1', () => {
  const PATH = pathMkdirFalha();
  const d = dirTemp();
  const origem = path.join(d, '.em-andamento-X');
  fs.mkdirSync(origem);
  fs.writeFileSync(path.join(origem, 'dado.txt'), 'conteudo');
  const final = path.join(d, 'X');
  const r = funcao('publicar_execucao', [origem, final], { PATH });
  assert.equal(r.status, 2, `falha operacional não é colisão: ${r.stderr}`);
  assert.equal(fs.readFileSync(path.join(origem, 'dado.txt'), 'utf8'), 'conteudo');
  assert.ok(!fs.existsSync(final));
  fs.mkdirSync(final);
  fs.writeFileSync(path.join(final, 'marcador.txt'), 'original');
  const r2 = funcao('publicar_execucao', [origem, final], { PATH });
  assert.equal(r2.status, 1, `colisão real com mkdir também falhando: ${r2.stderr}`);
  assert.deepEqual(fs.readdirSync(final), ['marcador.txt']);
  fs.unlinkSync(path.join(final, 'marcador.txt'));
  fs.rmdirSync(final);
  fs.symlinkSync(path.join(d, 'inexistente'), final);
  assert.equal(funcao('publicar_execucao', [origem, final], { PATH }).status, 1, 'link quebrado conta como colisão');
});

test('log_registro acrescenta linha com data UTC e a mensagem', () => {
  const d = dirTemp();
  const arq = path.join(d, 'registro.log');
  assert.equal(funcao('log_registro', [arq, 'passo um']).status, 0);
  assert.equal(funcao('log_registro', [arq, 'passo dois']).status, 0);
  const linhas = fs.readFileSync(arq, 'utf8').trim().split('\n');
  assert.equal(linhas.length, 2);
  assert.match(linhas[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z passo um$/);
});
