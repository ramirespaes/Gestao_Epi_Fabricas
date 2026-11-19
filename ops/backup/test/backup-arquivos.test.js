'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ_BACKUP = path.join(__dirname, '..');
const SCRIPT = path.join(RAIZ_BACKUP, 'backup-arquivos.sh');
const M = require('../lib/manifesto.js');
const MA = require('../lib/manifesto-arquivos.js');
const R = require('../lib/referencias.js');
const SENTINELA = 'SENTINELA-SEGREDO-Qw7K22';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const dirTemp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function destinoPrivado() { const d = dirTemp('backup-arq-dest-'); fs.chmodSync(d, 0o700); return d; }

function origem() {
  const raiz = dirTemp('backup-arq-fonte-');
  fs.mkdirSync(path.join(raiz, 'empresa-1'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'empresa-1', 'img-a.webp'), crypto.randomBytes(5000));
  fs.writeFileSync(path.join(raiz, 'empresa-1', 'img-b.webp'), crypto.randomBytes(7000));
  fs.writeFileSync(path.join(raiz, 'solto.bin'), 'sintetico');
  return raiz;
}

function hashesDaArvore(raiz) {
  const out = [];
  const ir = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const st = fs.lstatSync(p, { bigint: true }); if (st.isDirectory()) ir(p); else out.push(`${path.relative(raiz, p)} ${st.size} ${st.mtimeNs} ${st.ino} ${sha(fs.readFileSync(p))}`); } };
  ir(raiz);
  return out;
}

// Backup de banco (E1) sintético já concluído, para a ordem banco → arquivos.
async function execucaoBancoSintetica({ idadeSegundos = 5, nome = null } = {}) {
  const pasta = dirTemp('backup-arq-bd-');
  const aleatorio = crypto.randomBytes(4).toString('hex');
  const runId = `${new Date(Date.now() - idadeSegundos * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace(/^(\d{8})(\d{6})Z$/, '$1T$2Z')}-${aleatorio}`;
  const dir = path.join(pasta, nome || runId);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'banco.dump'), `PGDMP-sintetico-${aleatorio}`);
  fs.writeFileSync(path.join(dir, 'toc.txt'), '; Archive\n1; 1259 1 TABLE public a dono\n');
  const m = await M.construirManifesto({
    runId,
    criadoEm: new Date(Date.now() - idadeSegundos * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    host: 'servidor-teste',
    bancoNome: 'banco_sintetico',
    versaoPgDump: 'pg_dump (PostgreSQL) 16.0',
    dumpArquivo: path.join(dir, 'banco.dump'),
    tocArquivo: path.join(dir, 'toc.txt'),
    migrations: null,
  });
  await M.gravarManifesto(dir, m);
  return { dir, runId };
}

function executar(env, args = []) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
}

const listarDestino = (d) => fs.readdirSync(d).filter((n) => !n.startsWith('.'));

function refsNdjson(raiz) {
  const linhas = [];
  for (const rel of ['empresa-1/img-a.webp', 'empresa-1/img-b.webp', 'solto.bin']) {
    const buf = fs.readFileSync(path.join(raiz, rel));
    linhas.push(JSON.stringify({ sha256: sha(buf), tamanho_bytes: buf.length, chave: rel }));
  }
  const arq = path.join(dirTemp('backup-arq-refs-'), 'refs.ndjson');
  fs.writeFileSync(arq, `${linhas.join('\n')}\n`);
  return arq;
}

// Pacote de referências vinculado ao dump (como o gerador produz), a partir de uma origem sintética.
async function pacoteDeReferencias(raiz, bd) {
  const m1 = JSON.parse(fs.readFileSync(path.join(bd.dir, 'MANIFEST.json'), 'utf8'));
  const diretorio = dirTemp('backup-arq-pacote-');
  fs.chmodSync(diretorio, 0o700);
  const refs = ['empresa-1/img-a.webp', 'empresa-1/img-b.webp', 'solto.bin'].map((rel) => {
    const buf = fs.readFileSync(path.join(raiz, rel));
    return { sha256: sha(buf), tamanho_bytes: buf.length, chave: rel };
  });
  await R.gravarPacoteReferencias({
    diretorio,
    refsRunId: '20261115T130000Z-99aa88bb',
    geradoEm: '2026-11-15T13:00:00Z',
    host: 'servidor-teste',
    banco: { runId: bd.runId, dumpSha256: m1.dump.sha256, manifestSha256: sha(fs.readFileSync(path.join(bd.dir, 'MANIFEST.json'))) },
    versaoPgRestore: 'pg_restore (PostgreSQL) 16.0',
    fontes: [{ id: 'imagens', tabelas: [{ nome: 'imagens_empresa', linhas_lidas: 3, linhas_usadas: 3 }], refs }],
  });
  return diretorio;
}

test('referências avulsas (--referencias) completas, mas sem vínculo ao dump: NAOPUBLICAVEL- e código 10', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const r = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir }, ['--fonte', `imagens=${raiz}`, '--referencias', `imagens=${refsNdjson(raiz)}`]);
  assert.equal(r.status, 10);
  const nomes = listarDestino(destino);
  assert.match(nomes[0], /^NAOPUBLICAVEL-/);
  const m = JSON.parse(fs.readFileSync(path.join(destino, nomes[0], 'MANIFEST-ARQUIVOS.json'), 'utf8'));
  assert.equal(m.consistencia.referencias, 'VERIFICADO_COMPLETO');
  assert.equal(m.consistencia.vinculo, 'NAO_VINCULADO');
  assert.deepEqual(m.consistencia.bloqueios, ['REFERENCIAS_NAO_VINCULADAS']);
  assert.equal(m.consistencia.publicavel, false);
});

test('pacote de referências de outro dump ou adulterado: código 2, nada criado; duplicidade com --referencias: código 2', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const outro = await execucaoBancoSintetica();
  const pacote = await pacoteDeReferencias(raiz, bd);
  const base = ['--fonte', `imagens=${raiz}`, '--referencias-dir', pacote];
  const r1 = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: outro.dir }, base);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /E_REFERENCIAS_DE_OUTRO_DUMP/);
  const r2 = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir }, [...base, '--referencias', `imagens=${refsNdjson(raiz)}`]);
  assert.equal(r2.status, 2);
  fs.appendFileSync(path.join(pacote, 'refs-imagens.ndjson'), '\n');
  const r3 = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir }, base);
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /E_REFERENCIAS_ADULTERADAS/);
  assert.deepEqual(listarDestino(destino), []);
});

test('sucesso com referências completas e vinculadas ao dump: publicável, íntegro, origem intacta (exit 0)', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const antes = hashesDaArvore(raiz);
  const r = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir }, ['--fonte', `imagens=${raiz}`, '--referencias-dir', await pacoteDeReferencias(raiz, bd)]);
  assert.equal(r.status, 0, r.stderr);
  const resumo = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(resumo.status, 'OK');
  assert.deepEqual(listarDestino(destino), [resumo.run_id]);
  const exec = path.join(destino, resumo.run_id);
  assert.equal(fs.statSync(exec).mode & 0o777, 0o700);
  const m = JSON.parse(fs.readFileSync(path.join(exec, 'MANIFEST-ARQUIVOS.json'), 'utf8'));
  assert.equal(m.consistencia.publicavel, true);
  assert.equal(m.consistencia.vinculo, 'VINCULADO_AO_DUMP');
  assert.equal(m.banco.dump_sha256, JSON.parse(fs.readFileSync(path.join(bd.dir, 'MANIFEST.json'), 'utf8')).dump.sha256);
  assert.equal(m.fontes[0].referencias.origem.dump_sha256, m.banco.dump_sha256);
  assert.equal(m.banco.run_id, bd.runId);
  assert.equal(m.fontes[0].total_arquivos, 3);
  assert.ok(Date.parse(m.inicio_copia) >= Date.parse(m.banco.criado_em));
  assert.deepEqual(await MA.verificarManifestoArquivos(exec), { ok: true, erros: [] });
  const v = spawnSync(process.execPath, [path.join(RAIZ_BACKUP, 'lib', 'arquivos.js'), 'verificar', exec], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.deepEqual(hashesDaArvore(raiz), antes);
});

test('sem referências: cópia íntegra, mas NAOPUBLICAVEL- e código 10', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const r = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir }, ['--fonte', `imagens=${raiz}`]);
  assert.equal(r.status, 10);
  const nomes = listarDestino(destino);
  assert.equal(nomes.length, 1);
  assert.match(nomes[0], /^NAOPUBLICAVEL-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  const exec = path.join(destino, nomes[0]);
  const m = JSON.parse(fs.readFileSync(path.join(exec, 'MANIFEST-ARQUIVOS.json'), 'utf8'));
  assert.equal(m.consistencia.publicavel, false);
  assert.deepEqual(m.consistencia.bloqueios, ['REFERENCIAS_NAO_VERIFICADAS']);
  assert.ok(m.pendente.includes('referencias-do-banco'));
  assert.equal((await MA.verificarManifestoArquivos(exec)).ok, true);
});

test('referência sem arquivo copiado: código 12 e NAOPUBLICAVEL-', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const refs = path.join(dirTemp('backup-arq-refs-'), 'refs.ndjson');
  fs.writeFileSync(refs, `${JSON.stringify({ sha256: 'f'.repeat(64) })}\n`);
  const r = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir }, ['--fonte', `imagens=${raiz}`, '--referencias', `imagens=${refs}`]);
  assert.equal(r.status, 12);
  assert.match(listarDestino(destino)[0], /^NAOPUBLICAVEL-/);
});

test('arquivo de referências inválido: código 2, nada criado', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const refs = path.join(dirTemp('backup-arq-refs-'), 'refs.ndjson');
  fs.writeFileSync(refs, 'isto nao e json\n');
  const r = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir }, ['--fonte', `imagens=${raiz}`, '--referencias', `imagens=${refs}`]);
  assert.equal(r.status, 2);
  assert.deepEqual(listarDestino(destino), []);
});

test('ordem banco → arquivos: sem backup de banco, adulterado, antigo ou de falha é recusado (código 2)', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const args = ['--fonte', `imagens=${raiz}`];
  assert.equal(executar({ BACKUP_DESTINO: destino }, args).status, 2);
  assert.equal(executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: '/nao/existe' }, args).status, 2);

  const adulterado = await execucaoBancoSintetica();
  fs.appendFileSync(path.join(adulterado.dir, 'banco.dump'), 'x');
  assert.equal(executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: adulterado.dir }, args).status, 2);

  const antigo = await execucaoBancoSintetica({ idadeSegundos: 7200 });
  assert.equal(executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: antigo.dir }, args).status, 2);
  assert.equal(executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: antigo.dir, BACKUP_DB_IDADE_MAX_S: '86400' }, args).status, 10);

  const falha = await execucaoBancoSintetica({ nome: 'FALHA-20261115T000000Z-0a1b2c3d' });
  assert.equal(executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: falha.dir }, args).status, 2);
});

test('destino inseguro ou sincronizado: código 3', async () => {
  const raiz = origem();
  const bd = await execucaoBancoSintetica();
  const args = ['--fonte', `imagens=${raiz}`];
  const aberto = dirTemp('backup-arq-aberto-');
  fs.chmodSync(aberto, 0o755);
  assert.equal(executar({ BACKUP_DESTINO: aberto, BACKUP_DB_EXEC: bd.dir }, args).status, 3);
  const home = dirTemp('backup-arq-home-');
  const sinc = path.join(home, 'Desktop', 'bk');
  fs.mkdirSync(sinc, { recursive: true, mode: 0o700 });
  fs.chmodSync(sinc, 0o700);
  const r = executar({ BACKUP_DESTINO: sinc, BACKUP_DB_EXEC: bd.dir, HOME: home }, args);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /E_DESTINO_SINCRONIZADO/);
});

test('fontes inválidas: relativa, inexistente, link, id ruim, repetida, destino dentro da fonte (código 2)', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const env = { BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir };
  assert.equal(executar(env, []).status, 2);
  assert.equal(executar(env, ['--fonte', 'imagens=relativo/dir']).status, 2);
  assert.equal(executar(env, ['--fonte', 'imagens=/nao/existe/mesmo']).status, 2);
  assert.equal(executar(env, ['--fonte', `Imagens=${raiz}`]).status, 2);
  assert.equal(executar(env, ['--fonte', `imagens=${raiz}`, '--fonte', `imagens=${raiz}`]).status, 2);
  const link = path.join(dirTemp('backup-arq-lk-'), 'ln');
  fs.symlinkSync(raiz, link);
  assert.equal(executar(env, ['--fonte', `imagens=${link}`]).status, 2);
  const dentro = path.join(raiz, 'sub-destino');
  fs.mkdirSync(dentro, { mode: 0o700 });
  fs.chmodSync(dentro, 0o700);
  assert.equal(executar({ BACKUP_DESTINO: dentro, BACKUP_DB_EXEC: bd.dir }, ['--fonte', `imagens=${raiz}`]).status, 2);
  assert.equal(executar(env, ['--opcao-desconhecida', 'x']).status, 2);
  assert.deepEqual(listarDestino(destino), []);
});

test('tentativas fora de 1..3 em BACKUP_TENTATIVAS: código 2', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  for (const n of ['0', '4', 'x', '']) {
    const r = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, BACKUP_TENTATIVAS: n }, ['--fonte', `imagens=${raiz}`]);
    assert.equal(r.status, n === '' ? 10 : 2, `tentativas=${n}`);
  }
});

test('BACKUP_LIMITE_BYTES inválido: código 2 com E_CONFIG e nada criado; vazio é ignorado, válido funciona e limite menor que a origem continua falhando (5)', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const base = { BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir };
  for (const n of ['abc', '0', '-5', '1.5', '1e3', '0x10', ' 100', '1_000']) {
    const r = executar({ ...base, BACKUP_LIMITE_BYTES: n }, ['--fonte', `imagens=${raiz}`]);
    assert.equal(r.status, 2, `limite=${JSON.stringify(n)}`);
    assert.match(r.stderr, /E_CONFIG/, `limite=${JSON.stringify(n)}`);
  }
  assert.deepEqual(listarDestino(destino), []);
  for (const n of ['', '10485760']) {
    assert.equal(executar({ ...base, BACKUP_LIMITE_BYTES: n }, ['--fonte', `imagens=${raiz}`]).status, 10, `limite=${JSON.stringify(n)}`);
  }
  assert.equal(executar({ ...base, BACKUP_LIMITE_BYTES: '100' }, ['--fonte', `imagens=${raiz}`]).status, 5);
});

// run_id previsível (date e od fixos no PATH) para provocar colisões. Com `colisao`, o 1º `node` cria esse diretório
// (simula a corrida entre a conferência inicial e a publicação).
const RUN_ID_FIXO = '20260101T000000Z-aabbccdd';
function pathRunIdFixo({ colisao = null } = {}) {
  const bin = dirTemp('backup-arq-runid-');
  fs.writeFileSync(path.join(bin, 'date'), '#!/bin/sh\nif [ "$1 $2" = "-u +%Y%m%dT%H%M%SZ" ]; then echo 20260101T000000Z; exit 0; fi\nexec /bin/date "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'od'), '#!/bin/sh\necho " aa bb cc dd"\n', { mode: 0o755 });
  if (colisao) {
    const sentinela = path.join(bin, 'sentinela');
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nif [ ! -e "${sentinela}" ]; then : > "${sentinela}"; mkdir "${colisao}" && echo original > "${colisao}/marcador.txt"; fi\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  }
  return `${bin}:${process.env.PATH}`;
}
function marcadorIntacto(dir) {
  assert.deepEqual(fs.readdirSync(dir), ['marcador.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'marcador.txt'), 'utf8'), 'original\n');
}

test('run_id já existente (execução, FALHA- ou NAOPUBLICAVEL-): E_RUN_ID_EXISTENTE (código 3), marcador intacto e nada criado', async () => {
  const raiz = origem();
  const bd = await execucaoBancoSintetica();
  for (const nome of [RUN_ID_FIXO, `FALHA-${RUN_ID_FIXO}`, `NAOPUBLICAVEL-${RUN_ID_FIXO}`]) {
    const destino = destinoPrivado();
    fs.mkdirSync(path.join(destino, nome));
    fs.writeFileSync(path.join(destino, nome, 'marcador.txt'), 'original\n');
    const r = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, PATH: pathRunIdFixo() }, ['--fonte', `imagens=${raiz}`]);
    assert.equal(r.status, 3, `${nome}: ${r.stderr}`);
    assert.match(r.stderr, /E_RUN_ID_EXISTENTE/, nome);
    assert.deepEqual(fs.readdirSync(destino), [nome], `${nome}: nada criado`);
    marcadorIntacto(path.join(destino, nome));
  }
});

test('colisão entre a conferência inicial e a publicação (final, NAOPUBLICAVEL- e FALHA-): código 3, sem aninhar nem sobrescrever; a execução fica em andamento', async () => {
  const bd = await execucaoBancoSintetica();
  const casos = [
    { nome: RUN_ID_FIXO, esperado: 'MANIFEST-ARQUIVOS.json', args: async (raiz) => ['--fonte', `imagens=${raiz}`, '--referencias-dir', await pacoteDeReferencias(raiz, bd)] },
    { nome: `NAOPUBLICAVEL-${RUN_ID_FIXO}`, esperado: 'MANIFEST-ARQUIVOS.json', args: async (raiz) => ['--fonte', `imagens=${raiz}`] },
    { nome: `FALHA-${RUN_ID_FIXO}`, esperado: 'falha.json', args: async (raiz) => { fs.symlinkSync('/etc/hosts', path.join(raiz, 'ln')); return ['--fonte', `imagens=${raiz}`]; } },
  ];
  for (const c of casos) {
    const raiz = origem();
    const destino = destinoPrivado();
    const final = path.join(destino, c.nome);
    const r = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, PATH: pathRunIdFixo({ colisao: final }) }, await c.args(raiz));
    assert.equal(r.status, 3, `${c.nome}: ${r.stderr}`);
    assert.match(r.stderr, /E_RUN_ID_EXISTENTE/, c.nome);
    marcadorIntacto(final);
    assert.ok(fs.existsSync(path.join(destino, `.em-andamento-${RUN_ID_FIXO}`, c.esperado)), `${c.nome}: ${c.esperado} preservado em andamento`);
  }
});

// `mkdir` que falha sem criar nada, exceto para .em-andamento-*: simula falta de espaço ou permissão ao reservar o nome de publicação.
function pathMkdirFalha() {
  const bin = dirTemp('backup-arq-mkdirfalso-');
  fs.writeFileSync(path.join(bin, 'mkdir'), '#!/bin/sh\nfor a in "$@"; do ultimo="$a"; done\ncase "$ultimo" in */.em-andamento-*) exec /bin/mkdir "$@";; esac\necho "mkdir: No space left on device (simulado)" >&2\nexit 1\n', { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

test('falha operacional ao reservar o nome de publicação (sem colisão): não vira E_RUN_ID_EXISTENTE, o erro original é preservado e a cópia íntegra não é apagada', async () => {
  const bd = await execucaoBancoSintetica();
  const casos = [
    { rotulo: 'publicável', status: 5, nome: /E_PUBLICACAO_LOCAL/, preservado: ['MANIFEST-ARQUIVOS.json', 'tentativas'], args: async (raiz) => ['--fonte', `imagens=${raiz}`, '--referencias-dir', await pacoteDeReferencias(raiz, bd)] },
    { rotulo: 'NAOPUBLICAVEL', status: 5, nome: /E_PUBLICACAO_LOCAL/, preservado: ['MANIFEST-ARQUIVOS.json', 'tentativas'], args: async (raiz) => ['--fonte', `imagens=${raiz}`] },
    { rotulo: 'falha original', status: 5, nome: /E_ANOMALIA_ORIGEM/, preservado: ['falha.json'], args: async (raiz) => { fs.symlinkSync('/etc/hosts', path.join(raiz, 'ln')); return ['--fonte', `imagens=${raiz}`]; } },
  ];
  for (const c of casos) {
    const raiz = origem();
    const destino = destinoPrivado();
    const r = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, PATH: pathMkdirFalha() }, await c.args(raiz));
    assert.equal(r.status, c.status, `${c.rotulo}: ${r.stderr}`);
    assert.match(r.stderr, c.nome, c.rotulo);
    assert.doesNotMatch(r.stderr, /E_RUN_ID_EXISTENTE/, c.rotulo);
    const emAndamento = fs.readdirSync(destino);
    assert.equal(emAndamento.length, 1, c.rotulo);
    assert.match(emAndamento[0], /^\.em-andamento-/, c.rotulo);
    for (const f of c.preservado) assert.ok(fs.existsSync(path.join(destino, emAndamento[0], f)), `${c.rotulo}: ${f} preservado`);
  }
});

test('link simbólico dentro da fonte: falha fatal (5), FALHA-<id> com falha.json e sem cópia residual', async () => {
  const raiz = origem();
  fs.symlinkSync('/etc/hosts', path.join(raiz, 'ln'));
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const r = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir }, ['--fonte', `imagens=${raiz}`]);
  assert.equal(r.status, 5);
  const nomes = listarDestino(destino);
  assert.equal(nomes.length, 1);
  assert.match(nomes[0], /^FALHA-/);
  const arquivos = fs.readdirSync(path.join(destino, nomes[0]));
  assert.ok(arquivos.includes('falha.json'));
  assert.ok(!arquivos.includes('tentativas'));
  assert.ok(!arquivos.includes('MANIFEST-ARQUIVOS.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(destino, nomes[0], 'falha.json'), 'utf8')).codigo, 'E_ANOMALIA_ORIGEM');
});

test('execuções repetidas não se sobrescrevem e a origem permanece intacta', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const antes = hashesDaArvore(raiz);
  const args = ['--fonte', `imagens=${raiz}`, '--referencias-dir', await pacoteDeReferencias(raiz, bd)];
  const a = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir }, args);
  const b = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir }, args);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(listarDestino(destino).length, 2);
  assert.deepEqual(hashesDaArvore(raiz), antes);
});

test('segredo no ambiente não vaza para saída, registro, manifesto nem falha', async () => {
  const raiz = origem();
  const destino = destinoPrivado();
  const bd = await execucaoBancoSintetica();
  const r1 = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, PGPASSWORD: SENTINELA }, ['--fonte', `imagens=${raiz}`]);
  fs.symlinkSync('/etc/hosts', path.join(raiz, 'ln'));
  const r2 = executar({ BACKUP_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, PGPASSWORD: SENTINELA }, ['--fonte', `imagens=${raiz}`]);
  assert.equal(r1.status, 10);
  assert.equal(r2.status, 5);
  const todos = [];
  const ir = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) ir(p); else todos.push(p); } };
  ir(destino);
  for (const arq of todos) assert.ok(!fs.readFileSync(arq).includes(SENTINELA), arq);
  assert.doesNotMatch(r1.stdout + r1.stderr + r2.stdout + r2.stderr, new RegExp(SENTINELA));
});

test('o script de arquivos nunca grava, move ou apaga na origem: sem comandos destrutivos fora do diretório da execução', () => {
  const fonte = fs.readFileSync(SCRIPT, 'utf8').replace(/^\s*#.*$/gm, '');
  for (const proibido of [/\brsync\b/, /\bmv\s+[^\n]*\$\{?RAIZ/, /\brm\s+-rf\s+"?\$\{?FONTE/, /set\s+-x/, /\bpsql\b/, /\bpg_dump\b/]) assert.doesNotMatch(fonte, proibido);
});
