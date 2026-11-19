'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ_BACKUP = path.join(__dirname, '..');
const GERAR = path.join(RAIZ_BACKUP, 'gerar-referencias.sh');
const COPIAR = path.join(RAIZ_BACKUP, 'backup-arquivos.sh');
const REFERENCIAS_JS = path.join(RAIZ_BACKUP, 'lib', 'referencias.js');
const M = require('../lib/manifesto.js');
const MA = require('../lib/manifesto-arquivos.js');
const SENTINELA = 'SENTINELA-SEGREDO-Rv5N93';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const dirTemp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const privado = (p) => { const d = dirTemp(p); fs.chmodSync(d, 0o700); return d; };

function escreverArquivo(raiz, rel, conteudo) {
  const abs = path.join(raiz, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, conteudo);
  return { sha256: sha(conteudo), tamanho: conteudo.length };
}

// Origens sintéticas coerentes com as linhas COPY sintéticas.
function cenario() {
  const imagens = dirTemp('backup-ger-imagens-');
  const fisc = dirTemp('backup-ger-fisc-');
  const envioEmpresa = sha('envio-empresa-12');
  const mestreE = crypto.randomBytes(3000);
  const exibE = crypto.randomBytes(2000);
  const miniE = crypto.randomBytes(900);
  const eM = escreverArquivo(imagens, `12/${envioEmpresa}/mestre.jpg`, mestreE);
  const eX = escreverArquivo(imagens, `12/${envioEmpresa}/exibicao.webp`, exibE);
  const eN = escreverArquivo(imagens, `12/${envioEmpresa}/miniatura.webp`, miniE);
  const mestreP = crypto.randomBytes(2500);
  const envioPadrao = sha(mestreP);
  const miniP = crypto.randomBytes(700);
  const pM = escreverArquivo(imagens, `padrao/${envioPadrao}/mestre.png`, mestreP);
  const pN = escreverArquivo(imagens, `padrao/${envioPadrao}/miniatura.webp`, miniP);
  escreverArquivo(imagens, `12/${sha('orfao')}/mestre.png`, crypto.randomBytes(100));
  const zip = escreverArquivo(fisc, '12/pacote-34.zip', crypto.randomBytes(4096));
  escreverArquivo(fisc, '12/pacote-35.zip', crypto.randomBytes(50));

  const copia = (tabela, colunas, linhas) => `COPY public.${tabela} (${colunas.join(', ')}) FROM stdin;\n${linhas.map((l) => l.map((v) => (v === null ? '\\N' : v)).join('\t')).join('\n')}\n\\.\n\n`;
  const fix = dirTemp('backup-ger-fix-');
  fs.writeFileSync(path.join(fix, 'imagens_empresa.copy'), copia('imagens_empresa',
    ['id', 'nome', 'empresa_id', 'sha256', 'sha256_mestre', 'sha256_exibicao', 'sha256_miniatura', 'formato', 'bytes_mestre', 'bytes_exibicao', 'bytes_miniatura', 'estado', 'criado_em'],
    [['7', 'logo sintetica', '12', envioEmpresa, eM.sha256, eX.sha256, eN.sha256, 'JPEG', String(eM.tamanho), String(eX.tamanho), String(eN.tamanho), 'ATIVA', '2026-11-01 10:00:00+00']]));
  fs.writeFileSync(path.join(fix, 'imagens_padrao.copy'), copia('imagens_padrao',
    ['id', 'nome', 'sha256', 'sha256_miniatura', 'sha256_exibicao', 'formato', 'bytes_mestre', 'bytes_miniatura', 'bytes_exibicao', 'ativo'],
    [['1', 'capacete sintetico', envioPadrao, pN.sha256, null, 'PNG', String(pM.tamanho), String(pN.tamanho), null, 't']]));
  fs.writeFileSync(path.join(fix, 'fiscalizacao_pacotes.copy'), copia('fiscalizacao_pacotes',
    ['id', 'empresa_id', 'status', 'chave_armazenamento', 'sha256', 'tamanho_bytes', 'nome_logico', 'escopos'],
    [['34', '12', 'CONCLUIDO', '12/pacote-34.zip', zip.sha256, String(zip.tamanho), 'pacote sintetico', '{"a": "b\\\\c"}'],
      ['35', '12', 'GERANDO', '\\N', '\\N', '\\N', '\\N', '{}']]));
  return { imagens, fisc, fix, esperadas: { empresa: { envioEmpresa, eM, eX, eN }, padrao: { envioPadrao, pM, pN }, zip } };
}

function pgRestoreFalso({ fix, modo = 'ok' }) {
  const d = privado('backup-ger-bin-');
  const args = path.join(d, 'args.txt');
  const env = path.join(d, 'env.txt');
  const corpo = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pg_restore (PostgreSQL) 16.0 (falso)"; exit 0; fi
echo "$@" >> "${args}"
env | sort > "${env}"
tabela=""
for a in "$@"; do case "$a" in --table=*) tabela="\${a#--table=}";; esac; done
${modo === 'falha' ? 'echo "arquivo corrompido" >&2; exit 1' : ''}
printf -- '--\\n-- PostgreSQL database dump\\n--\\nSET statement_timeout = 0;\\n\\n'
${modo === 'vazio' ? '' : `[ -f "${fix}/$tabela.copy" ] && cat "${fix}/$tabela.copy"`}
exit 0
`;
  fs.writeFileSync(path.join(d, 'pg_restore'), corpo, { mode: 0o755 });
  return { bin: d, args, env };
}

async function execucaoBancoSintetica({ nome = null } = {}) {
  const pasta = dirTemp('backup-ger-bd-');
  const agora = new Date(Date.now() - 5000);
  const aleatorio = crypto.randomBytes(4).toString('hex');
  const runId = `${agora.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z-${aleatorio}`;
  const dir = path.join(pasta, nome || runId);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'banco.dump'), `PGDMP-sintetico-${aleatorio}`);
  fs.writeFileSync(path.join(dir, 'toc.txt'), '; Archive\n1; 1259 1 TABLE public a dono\n');
  await M.gravarManifesto(dir, await M.construirManifesto({
    runId, criadoEm: `${agora.toISOString().slice(0, 19)}Z`, host: 'servidor-teste', bancoNome: 'banco_sintetico',
    versaoPgDump: 'pg_dump (PostgreSQL) 16.0', dumpArquivo: path.join(dir, 'banco.dump'), tocArquivo: path.join(dir, 'toc.txt'), migrations: null,
  }));
  return { dir, runId };
}

const executar = (script, env, args = []) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
const listar = (d) => fs.readdirSync(d).filter((n) => !n.startsWith('.'));
const lerNdjson = (arq) => fs.readFileSync(arq, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const todos = (d) => { const o = []; const ir = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) ir(p); else o.push(p); } }; ir(d); return o; };

async function gerarOk(c, bd, extraEnv = {}) {
  const destino = privado('backup-ger-dest-');
  const f = pgRestoreFalso({ fix: c.fix });
  const r = executar(GERAR, { BACKUP_REFS_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, BACKUP_PG_BIN: f.bin, ...extraEnv }, ['--fonte', 'imagens', '--fonte', 'fiscalizacao-pacotes']);
  return { r, destino, f };
}

test('gerar: extrai só do dump, gera NDJSON vinculado e correto para imagens e Fiscalização', async () => {
  const c = cenario();
  const bd = await execucaoBancoSintetica();
  const { r, destino, f } = await gerarOk(c, bd, { PGPASSWORD: SENTINELA, PGHOST: 'servidor.invalido' });
  assert.equal(r.status, 0, r.stderr);
  const resumo = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(resumo.status, 'OK');
  assert.deepEqual(listar(destino), [resumo.run_id]);
  const dir = path.join(destino, resumo.run_id);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const n of ['refs-imagens.ndjson', 'refs-fiscalizacao-pacotes.ndjson', 'REFERENCIAS-META.json', 'REFERENCIAS-META.json.sha256', 'registro.log']) assert.equal(fs.statSync(path.join(dir, n)).mode & 0o777, 0o600, n);

  const imagens = lerNdjson(path.join(dir, 'refs-imagens.ndjson'));
  const { empresa, padrao } = c.esperadas;
  assert.equal(imagens.length, 3 + 2);
  const por = Object.fromEntries(imagens.map((x) => [x.chave, x]));
  assert.deepEqual(por[`12/${empresa.envioEmpresa}/mestre.jpg`], { sha256: empresa.eM.sha256, tamanho_bytes: empresa.eM.tamanho, chave: `12/${empresa.envioEmpresa}/mestre.jpg` });
  assert.equal(por[`12/${empresa.envioEmpresa}/miniatura.webp`].sha256, empresa.eN.sha256);
  assert.equal(por[`padrao/${padrao.envioPadrao}/mestre.png`].tamanho_bytes, padrao.pM.tamanho);
  assert.ok(!(`padrao/${padrao.envioPadrao}/exibicao.webp` in por));
  const fisc = lerNdjson(path.join(dir, 'refs-fiscalizacao-pacotes.ndjson'));
  assert.deepEqual(fisc, [{ sha256: c.esperadas.zip.sha256, tamanho_bytes: c.esperadas.zip.tamanho, chave: '12/pacote-34.zip' }]);

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'REFERENCIAS-META.json'), 'utf8'));
  const m1 = JSON.parse(fs.readFileSync(path.join(bd.dir, 'MANIFEST.json'), 'utf8'));
  assert.equal(meta.dump.sha256, m1.dump.sha256);
  assert.equal(meta.dump.run_id, bd.runId);
  assert.equal(meta.dump.manifest_sha256, sha(fs.readFileSync(path.join(bd.dir, 'MANIFEST.json'))));
  assert.equal(meta.fontes.find((x) => x.id === 'fiscalizacao-pacotes').tabelas[0].linhas_lidas, 2);
  assert.equal(meta.fontes.find((x) => x.id === 'fiscalizacao-pacotes').tabelas[0].linhas_usadas, 1);

  // sem conexão com banco: opções do pg_restore e ambiente mínimo
  const chamadas = fs.readFileSync(f.args, 'utf8');
  for (const t of ['imagens_padrao', 'imagens_empresa', 'fiscalizacao_pacotes']) assert.match(chamadas, new RegExp(`--table=${t}`));
  assert.match(chamadas, /--data-only/);
  assert.match(chamadas, /--schema=public/);
  assert.match(chamadas, /--file=-/);
  assert.doesNotMatch(chamadas, /--dbname|\s-d\s|--host|--port|--username/);
  assert.doesNotMatch(fs.readFileSync(f.env, 'utf8'), /^PG/m);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SENTINELA));
  for (const arq of todos(destino)) assert.ok(!fs.readFileSync(arq).includes(SENTINELA), arq);

  const v = spawnSync(process.execPath, [REFERENCIAS_JS, 'verificar', dir, '--banco-exec', bd.dir], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
});

test('gerar: saída determinística (mesmo dump, bytes idênticos)', async () => {
  const c = cenario();
  const bd = await execucaoBancoSintetica();
  const a = await gerarOk(c, bd);
  const b = await gerarOk(c, bd);
  const da = path.join(a.destino, listar(a.destino)[0]);
  const db = path.join(b.destino, listar(b.destino)[0]);
  for (const n of ['refs-imagens.ndjson', 'refs-fiscalizacao-pacotes.ndjson']) assert.equal(sha(fs.readFileSync(path.join(da, n))), sha(fs.readFileSync(path.join(db, n))));
});

test('cadeia completa: referências geradas do dump → E2 publicável; arquivo removido ou trocado → código 12', async () => {
  const c = cenario();
  const bd = await execucaoBancoSintetica();
  const { r, destino } = await gerarOk(c, bd);
  assert.equal(r.status, 0, r.stderr);
  const pacote = path.join(destino, listar(destino)[0]);
  const destE2 = privado('backup-ger-e2-');
  const args = (extra = []) => ['--fonte', `imagens=${c.imagens}`, '--fonte', `fiscalizacao-pacotes=${c.fisc}`, '--referencias-dir', pacote, ...extra];

  const ok = executar(COPIAR, { BACKUP_DESTINO: destE2, BACKUP_DB_EXEC: bd.dir }, args());
  assert.equal(ok.status, 0, ok.stderr);
  const resumo = JSON.parse(ok.stdout.trim().split('\n').pop());
  const exec = path.join(destE2, resumo.run_id);
  const m = JSON.parse(fs.readFileSync(path.join(exec, 'MANIFEST-ARQUIVOS.json'), 'utf8'));
  assert.equal(m.consistencia.publicavel, true);
  assert.equal(m.consistencia.vinculo, 'VINCULADO_AO_DUMP');
  assert.ok(m.fontes.every((f) => f.referencias.vinculo === 'VINCULADO_AO_DUMP' && f.referencias.origem.dump_sha256 === m.banco.dump_sha256));
  assert.equal(m.fontes.find((f) => f.id === 'imagens').referencias.orfaos_total, 1);
  assert.deepEqual(await MA.verificarManifestoArquivos(exec), { ok: true, erros: [] });

  fs.unlinkSync(path.join(c.fisc, '12', 'pacote-34.zip'));
  const faltante = executar(COPIAR, { BACKUP_DESTINO: destE2, BACKUP_DB_EXEC: bd.dir }, args());
  assert.equal(faltante.status, 12);

  escreverArquivo(c.fisc, '12/pacote-34.zip', Buffer.from('conteudo trocado'));
  const trocado = executar(COPIAR, { BACKUP_DESTINO: destE2, BACKUP_DB_EXEC: bd.dir }, args());
  assert.equal(trocado.status, 12);
  assert.ok(listar(destE2).filter((n) => n.startsWith('NAOPUBLICAVEL-')).length >= 2);
});

test('E2 recusa referências geradas de outro dump (código 2) e pacote adulterado', async () => {
  const c = cenario();
  const bd = await execucaoBancoSintetica();
  const outro = await execucaoBancoSintetica();
  const { destino } = await gerarOk(c, bd);
  const pacote = path.join(destino, listar(destino)[0]);
  const destE2 = privado('backup-ger-e2-');
  const base = ['--fonte', `imagens=${c.imagens}`, '--referencias-dir', pacote];
  const outroDump = executar(COPIAR, { BACKUP_DESTINO: destE2, BACKUP_DB_EXEC: outro.dir }, base);
  assert.equal(outroDump.status, 2);
  assert.match(outroDump.stderr, /E_REFERENCIAS_DE_OUTRO_DUMP/);
  fs.appendFileSync(path.join(pacote, 'refs-imagens.ndjson'), '\n');
  const adulterado = executar(COPIAR, { BACKUP_DESTINO: destE2, BACKUP_DB_EXEC: bd.dir }, base);
  assert.equal(adulterado.status, 2);
  assert.match(adulterado.stderr, /E_REFERENCIAS_ADULTERADAS/);
  assert.deepEqual(listar(destE2), []);
});

test('gerar: banco ausente, adulterado, de falha ou fonte desconhecida → código 2, nada criado', async () => {
  const c = cenario();
  const destino = privado('backup-ger-dest-');
  const f = pgRestoreFalso({ fix: c.fix });
  const base = { BACKUP_REFS_DESTINO: destino, BACKUP_PG_BIN: f.bin };
  assert.equal(executar(GERAR, base, ['--fonte', 'imagens']).status, 2);
  assert.equal(executar(GERAR, { ...base, BACKUP_DB_EXEC: '/nao/existe' }, ['--fonte', 'imagens']).status, 2);
  const adulterado = await execucaoBancoSintetica();
  fs.appendFileSync(path.join(adulterado.dir, 'banco.dump'), 'x');
  assert.equal(executar(GERAR, { ...base, BACKUP_DB_EXEC: adulterado.dir }, ['--fonte', 'imagens']).status, 2);
  const falha = await execucaoBancoSintetica({ nome: 'FALHA-20261115T000000Z-0a1b2c3d' });
  assert.equal(executar(GERAR, { ...base, BACKUP_DB_EXEC: falha.dir }, ['--fonte', 'imagens']).status, 2);
  const bd = await execucaoBancoSintetica();
  assert.equal(executar(GERAR, { ...base, BACKUP_DB_EXEC: bd.dir }, ['--fonte', 'anexos']).status, 2);
  assert.equal(executar(GERAR, { ...base, BACKUP_DB_EXEC: bd.dir }, ['--fonte', 'imagens', '--fonte', 'imagens']).status, 2);
  assert.deepEqual(listar(destino), []);
});

// run_id previsível (date e od fixos no PATH) para provocar colisões. Com `colisao`, o 1º `node` cria esse diretório
// (simula a corrida entre a conferência inicial e a publicação).
const RUN_ID_FIXO = '20260101T000000Z-aabbccdd';
function pathRunIdFixo({ colisao = null } = {}) {
  const bin = dirTemp('backup-ger-runid-');
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

test('gerar: run_id já existente (execução, FALHA- ou NAOPUBLICAVEL-): E_RUN_ID_EXISTENTE (código 3), marcador intacto e nada criado', async () => {
  const c = cenario();
  const bd = await execucaoBancoSintetica();
  const f = pgRestoreFalso({ fix: c.fix });
  for (const nome of [RUN_ID_FIXO, `FALHA-${RUN_ID_FIXO}`, `NAOPUBLICAVEL-${RUN_ID_FIXO}`]) {
    const destino = privado('backup-ger-dest-');
    fs.mkdirSync(path.join(destino, nome));
    fs.writeFileSync(path.join(destino, nome, 'marcador.txt'), 'original\n');
    const r = executar(GERAR, { BACKUP_REFS_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, BACKUP_PG_BIN: f.bin, PATH: pathRunIdFixo() }, ['--fonte', 'imagens']);
    assert.equal(r.status, 3, `${nome}: ${r.stderr}`);
    assert.match(r.stderr, /E_RUN_ID_EXISTENTE/, nome);
    assert.deepEqual(fs.readdirSync(destino), [nome], `${nome}: nada criado`);
    marcadorIntacto(path.join(destino, nome));
  }
});

test('gerar: colisão entre a conferência inicial e a publicação (final e FALHA-): código 3, sem aninhar nem sobrescrever; a execução fica em andamento', async () => {
  const c = cenario();
  const bd = await execucaoBancoSintetica();
  const casos = [
    { nome: RUN_ID_FIXO, modo: 'ok', esperado: 'REFERENCIAS-META.json' },
    { nome: `FALHA-${RUN_ID_FIXO}`, modo: 'falha', esperado: 'falha.json' },
  ];
  for (const caso of casos) {
    const destino = privado('backup-ger-dest-');
    const final = path.join(destino, caso.nome);
    const f = pgRestoreFalso({ fix: c.fix, modo: caso.modo });
    const r = executar(GERAR, { BACKUP_REFS_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, BACKUP_PG_BIN: f.bin, PATH: pathRunIdFixo({ colisao: final }) }, ['--fonte', 'imagens', '--fonte', 'fiscalizacao-pacotes']);
    assert.equal(r.status, 3, `${caso.nome}: ${r.stderr}`);
    assert.match(r.stderr, /E_RUN_ID_EXISTENTE/, caso.nome);
    marcadorIntacto(final);
    assert.ok(fs.existsSync(path.join(destino, `.em-andamento-${RUN_ID_FIXO}`, caso.esperado)), `${caso.nome}: ${caso.esperado} preservado em andamento`);
  }
});

// `mkdir` que falha sem criar nada, exceto para .em-andamento-*: simula falta de espaço ou permissão ao reservar o nome de publicação.
function pathMkdirFalha() {
  const bin = dirTemp('backup-ger-mkdirfalso-');
  fs.writeFileSync(path.join(bin, 'mkdir'), '#!/bin/sh\nfor a in "$@"; do ultimo="$a"; done\ncase "$ultimo" in */.em-andamento-*) exec /bin/mkdir "$@";; esac\necho "mkdir: No space left on device (simulado)" >&2\nexit 1\n', { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

test('gerar: falha operacional ao reservar o nome de publicação (sem colisão): não vira E_RUN_ID_EXISTENTE, o erro original é preservado e as referências íntegras não são apagadas', async () => {
  const c = cenario();
  const bd = await execucaoBancoSintetica();
  const casos = [
    { rotulo: 'publicável', modo: 'ok', nome: /E_PUBLICACAO_LOCAL/, preservado: ['REFERENCIAS-META.json', 'refs-imagens.ndjson'] },
    { rotulo: 'falha original', modo: 'falha', nome: /E_EXTRACAO_FALHOU/, preservado: ['falha.json'] },
  ];
  for (const caso of casos) {
    const destino = privado('backup-ger-dest-');
    const f = pgRestoreFalso({ fix: c.fix, modo: caso.modo });
    const r = executar(GERAR, { BACKUP_REFS_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, BACKUP_PG_BIN: f.bin, PATH: pathMkdirFalha() }, ['--fonte', 'imagens']);
    assert.equal(r.status, 5, `${caso.rotulo}: ${r.stderr}`);
    assert.match(r.stderr, caso.nome, caso.rotulo);
    assert.doesNotMatch(r.stderr, /E_RUN_ID_EXISTENTE/, caso.rotulo);
    const emAndamento = fs.readdirSync(destino);
    assert.equal(emAndamento.length, 1, caso.rotulo);
    assert.match(emAndamento[0], /^\.em-andamento-/, caso.rotulo);
    for (const arq of caso.preservado) assert.ok(fs.existsSync(path.join(destino, emAndamento[0], arq)), `${caso.rotulo}: ${arq} preservado`);
  }
});

test('gerar: destino inseguro/sincronizado (3) e pg_restore ausente (4)', async () => {
  const c = cenario();
  const bd = await execucaoBancoSintetica();
  const f = pgRestoreFalso({ fix: c.fix });
  const aberto = dirTemp('backup-ger-aberto-');
  fs.chmodSync(aberto, 0o755);
  assert.equal(executar(GERAR, { BACKUP_REFS_DESTINO: aberto, BACKUP_DB_EXEC: bd.dir, BACKUP_PG_BIN: f.bin }, ['--fonte', 'imagens']).status, 3);
  const home = dirTemp('backup-ger-home-');
  const sinc = path.join(home, 'Documents', 'bk');
  fs.mkdirSync(sinc, { recursive: true, mode: 0o700 });
  fs.chmodSync(sinc, 0o700);
  const r = executar(GERAR, { BACKUP_REFS_DESTINO: sinc, BACKUP_DB_EXEC: bd.dir, BACKUP_PG_BIN: f.bin, HOME: home }, ['--fonte', 'imagens']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /E_DESTINO_SINCRONIZADO/);
  const destino = privado('backup-ger-dest-');
  const r4 = executar(GERAR, { BACKUP_REFS_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, BACKUP_PG_BIN: '/nao/existe/bin' }, ['--fonte', 'imagens']);
  assert.equal(r4.status, 4);
  assert.deepEqual(listar(destino), []);
});

test('gerar: tabela ausente no dump, pg_restore com erro e dados inválidos → código 5, FALHA-<id>, sem referências residuais', async () => {
  const casos = [
    ['vazio', null, 'E_TABELA_AUSENTE'],
    ['falha', null, 'E_EXTRACAO_FALHOU'],
    ['ok', 'invalido', 'E_REFERENCIAS_INVALIDAS'],
  ];
  for (const [modo, adulterar, esperado] of casos) {
    const c = cenario();
    if (adulterar) fs.writeFileSync(path.join(c.fix, 'imagens_empresa.copy'), fs.readFileSync(path.join(c.fix, 'imagens_empresa.copy'), 'utf8').replace(/\t[0-9a-f]{64}\t/, `\t${SENTINELA}\t`));
    const bd = await execucaoBancoSintetica();
    const destino = privado('backup-ger-dest-');
    const f = pgRestoreFalso({ fix: c.fix, modo });
    const r = executar(GERAR, { BACKUP_REFS_DESTINO: destino, BACKUP_DB_EXEC: bd.dir, BACKUP_PG_BIN: f.bin }, ['--fonte', 'imagens']);
    assert.equal(r.status, 5, modo);
    const nomes = listar(destino);
    assert.equal(nomes.length, 1);
    assert.match(nomes[0], /^FALHA-/);
    const arquivos = fs.readdirSync(path.join(destino, nomes[0]));
    assert.ok(arquivos.includes('falha.json'));
    assert.ok(!arquivos.some((n) => n.startsWith('refs-') || n.startsWith('REFERENCIAS-')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(destino, nomes[0], 'falha.json'), 'utf8')).codigo, esperado);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SENTINELA));
    for (const arq of todos(destino)) assert.ok(!fs.readFileSync(arq).includes(SENTINELA), arq);
  }
});

test('o gerador nunca conecta ao banco: sem psql, pg_dump, --dbname nem opções de conexão', () => {
  const fonte = [fs.readFileSync(GERAR, 'utf8'), fs.readFileSync(REFERENCIAS_JS, 'utf8')].join('\n').replace(/^\s*#.*$/gm, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const proibido of [/\bpsql\b/, /\bpg_dump\b/, /--dbname/, /--host/, /--username/, /process\.env/, /\$\{?PG(?:PASSWORD|HOST|USER|PORT|DATABASE|PASSFILE)/, /set\s+-x/]) assert.doesNotMatch(fonte, proibido);
});
