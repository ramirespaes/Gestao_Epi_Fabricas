'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ_BACKUP = path.join(__dirname, '..');
const SCRIPT = path.join(RAIZ_BACKUP, 'backup-db.sh');
const REPO = path.join(RAIZ_BACKUP, '..', '..');
const PG_BIN = process.env.BACKUP_TESTE_PG_BIN || '/Applications/Postgres.app/Contents/Versions/16/bin';
const BANCO = process.env.BACKUP_TESTE_DB || 'gestao_epi_teste_local';
const BANCOS_PROTEGIDOS = /homolog|prod|^postgres$|^template[01]$/i;
const LOOPBACK = new Set(['127.0.0.1', '::1']);
// Conexão repassada às sondas e ao script (pg_dump): só host local, porta, usuário e arquivo de senha. Nunca PGPASSWORD nem configuração de serviço.
function ambienteDeConexao(env) {
  const o = {};
  for (const k of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGPASSFILE', 'PGCONNECT_TIMEOUT']) if (env[k]) o[k] = env[k];
  return o;
}
// Destino local verificável: diretório de socket com o socket existente, ou loopback literal. Devolve o motivo da recusa, ou null.
function verificarDestinoLocal(env, estatistica = fs.statSync) {
  const host = env.PGHOST;
  const porta = env.PGPORT || '5432';
  if (!/^[0-9]{1,5}$/.test(porta)) return 'PGPORT inválida';
  if (!host) return 'PGHOST não definido: informe o diretório do socket local, 127.0.0.1 ou ::1';
  if (env.PGHOSTADDR && !LOOPBACK.has(env.PGHOSTADDR)) return 'PGHOSTADDR não é loopback: conexão remota recusada';
  if (host.includes(',')) return 'PGHOST com lista de hosts recusado';
  if (host.startsWith('/')) {
    try { if (estatistica(path.join(host, `.s.PGSQL.${porta}`)).isSocket()) return null; } catch { /* sem socket */ }
    return 'PGHOST aponta para diretório sem socket local verificável';
  }
  return LOOPBACK.has(host) ? null : 'PGHOST remoto ou não verificável (aceitos: diretório de socket local, 127.0.0.1, ::1)';
}
// Os testes com pg_dump real só rodam com executáveis, banco de teste identificado e autorizado de forma explícita, destino local verificável
// e servidor acessível; senão ficam ignorados, com o motivo. Nunca inicia servidor e nunca sonda antes de todas as verificações locais.
function motivoSemPg({ env = process.env, pgBin = PG_BIN, banco = BANCO } = {}) {
  for (const exe of ['pg_dump', 'pg_restore', 'pg_isready', 'psql']) {
    if (!fs.existsSync(path.join(pgBin, exe))) return `${exe} ausente em ${pgBin}`;
  }
  if (BANCOS_PROTEGIDOS.test(banco)) return `banco "${banco}" protegido: recusado como banco de teste`;
  if (!env.BACKUP_TESTE_DB || env.BACKUP_TESTE_DB !== banco) return 'banco de teste não identificado: defina BACKUP_TESTE_DB com o nome exato do banco';
  if (env.BACKUP_TESTE_PG_AUTORIZADO !== banco) return 'uso do banco de teste não autorizado: BACKUP_TESTE_PG_AUTORIZADO deve repetir o nome exato de BACKUP_TESTE_DB';
  if (env.PGSERVICE || env.PGSERVICEFILE || env.PGSYSCONFDIR) return 'configuração de serviço PostgreSQL (PGSERVICE, PGSERVICEFILE, PGSYSCONFDIR) não é permitida nos testes';
  const recusado = verificarDestinoLocal(env);
  if (recusado) return recusado;
  const sonda = (exe, args) => spawnSync(path.join(pgBin, exe), args, { env: { PATH: process.env.PATH, PGCONNECT_TIMEOUT: '3', ...ambienteDeConexao(env) }, encoding: 'utf8', timeout: 8000 });
  if (sonda('pg_isready', ['-q']).status !== 0) return 'servidor PostgreSQL de teste inacessível no destino local informado';
  if (sonda('psql', ['-X', '-w', '-q', '-At', '-d', banco, '-c', 'select 1']).status !== 0) return `banco de teste "${banco}" inacessível`;
  return null;
}
const MOTIVO_SEM_PG = motivoSemPg();
const SKIP_PG = MOTIVO_SEM_PG === null ? false : `PostgreSQL de teste indisponível: ${MOTIVO_SEM_PG}`;
const SENTINELA = 'SENTINELA-SEGREDO-Zx9Q41';

const real = realpath(os.tmpdir());
function realpath(p) { return fs.realpathSync(p); }
function dirTemp(prefixo) { return fs.realpathSync(fs.mkdtempSync(path.join(real, prefixo))); }
function destinoPrivado() {
  const d = dirTemp('backup-db-dest-');
  fs.chmodSync(d, 0o700);
  return d;
}

function executar(env, { semBase = false } = {}) {
  const base = semBase ? {} : { PATH: process.env.PATH, BACKUP_REPO_RAIZ: REPO };
  return spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...base, ...ambienteDeConexao(process.env), ...env } });
}

function listarRecursivo(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(p, ...listarRecursivo(p));
    else out.push(p);
  }
  return out;
}

function ferramentasFalsas({ dump = 'ok', restore = 'ok' }) {
  const d = dirTemp('backup-db-fake-');
  const gravaArgs = path.join(d, 'args-pg_dump.txt');
  const pgDump = {
    ok: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.0 (falso)"; exit 0; fi\necho "$@" > "${gravaArgs}"\nwhile [ $# -gt 0 ]; do case "$1" in -f) printf 'PGDMP-falso' > "$2"; shift;; --file=*) printf 'PGDMP-falso' > "\${1#--file=}";; esac; shift; done\nexit 0\n`,
    parcial: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.0 (falso)"; exit 0; fi\nwhile [ $# -gt 0 ]; do case "$1" in -f) printf 'PARCIAL' > "$2"; shift;; --file=*) printf 'PARCIAL' > "\${1#--file=}";; esac; shift; done\necho "no space left on device" >&2\nexit 1\n`,
  }[dump];
  const pgRestore = {
    ok: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_restore (PostgreSQL) 16.0 (falso)"; exit 0; fi\nprintf "; Archive\\n1; 1259 1 TABLE public a dono\\n"\nexit 0\n',
    falha: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_restore (PostgreSQL) 16.0 (falso)"; exit 0; fi\necho "arquivo corrompido" >&2\nexit 1\n',
    vazio: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_restore (PostgreSQL) 16.0 (falso)"; exit 0; fi\nprintf "; so comentario\\n"\nexit 0\n',
  }[restore];
  fs.writeFileSync(path.join(d, 'pg_dump'), pgDump, { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'pg_restore'), pgRestore, { mode: 0o755 });
  return { bin: d, gravaArgs };
}

function execucoesGravadas(destino) {
  return fs.readdirSync(destino).filter((n) => !n.startsWith('.'));
}

// ---- Detecção do ambiente PostgreSQL de teste: só binários FALSOS, nenhuma conexão real ----
function pgBinFalso({ isready = 0, psql = 0 } = {}) {
  const d = dirTemp('backup-db-pgfalso-');
  const reg = path.join(d, 'chamadas.txt');
  for (const exe of ['pg_dump', 'pg_restore']) fs.writeFileSync(path.join(d, exe), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const linha = (nome) => `#!/bin/sh\necho "${nome} PGHOST=$PGHOST PGPORT=$PGPORT PGUSER=$PGUSER PGSERVICE=$PGSERVICE PGPASSWORD=$PGPASSWORD args=$*" >> "${reg}"\n`;
  fs.writeFileSync(path.join(d, 'pg_isready'), `${linha('pg_isready')}exit ${isready}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'psql'), `${linha('psql')}exit ${psql}\n`, { mode: 0o755 });
  return { bin: d, chamadas: () => (fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8').trim().split('\n') : []) };
}
function envAutorizado(extra = {}) {
  const env = { BACKUP_TESTE_DB: 'banco_aut_x', BACKUP_TESTE_PG_AUTORIZADO: 'banco_aut_x', PGHOST: '127.0.0.1', PGPORT: '55432', ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}
const conexaoDe = (linha) => /PGHOST=(\S*) PGPORT=(\S*) PGUSER=(\S*)/.exec(linha).slice(1).join('|');

test('detecção PostgreSQL: PGSERVICE, PGSERVICEFILE e PGSYSCONFDIR são recusados antes de qualquer sonda', () => {
  for (const [k, v] of [['PGSERVICE', 'producao'], ['PGSERVICEFILE', '/tmp/pg_service.conf'], ['PGSYSCONFDIR', '/tmp/etc']]) {
    const f = pgBinFalso();
    const motivo = motivoSemPg({ env: envAutorizado({ [k]: v }), pgBin: f.bin, banco: 'banco_aut_x' });
    assert.match(String(motivo), /servi[çc]o/i, k);
    assert.deepEqual(f.chamadas(), [], `${k}: nenhuma sonda executada`);
  }
});

test('detecção PostgreSQL: hosts remotos, localhost, lista de hosts, PGHOSTADDR remoto, socket inexistente e host ausente são recusados sem expor credenciais', () => {
  const casos = [
    { PGHOST: 'db.exemplo.com' }, { PGHOST: '10.0.0.5' }, { PGHOST: 'localhost' }, { PGHOST: '127.0.0.2' }, { PGHOST: '::2' },
    { PGHOST: '127.0.0.1,db.exemplo.com' }, { PGHOST: '127.0.0.1', PGHOSTADDR: '10.0.0.5' }, { PGHOST: '/nao/existe/dir-socket' }, { PGHOST: '' }, { PGHOST: undefined },
  ];
  for (const caso of casos) {
    const f = pgBinFalso();
    const motivo = motivoSemPg({ env: envAutorizado({ ...caso, PGPASSWORD: SENTINELA, PGUSER: 'usuario-sentinela' }), pgBin: f.bin, banco: 'banco_aut_x' });
    assert.equal(typeof motivo, 'string', JSON.stringify(caso));
    assert.match(motivo, /PGHOST/, `${JSON.stringify(caso)}: o motivo deve apontar o destino de conexão recusado`);
    assert.doesNotMatch(motivo, /SENTINELA|usuario-sentinela/, JSON.stringify(caso));
    assert.deepEqual(f.chamadas(), [], `${JSON.stringify(caso)}: nenhuma sonda executada`);
  }
  const f = pgBinFalso();
  assert.match(String(motivoSemPg({ env: envAutorizado({ PGHOST: '/nao/existe/dir-socket' }), pgBin: f.bin, banco: 'banco_aut_x' })), /socket/);
});

test('detecção PostgreSQL: sem identificação e autorização explícitas do banco (nome com "teste" não basta) não há sonda', () => {
  const casos = [
    { env: envAutorizado({ BACKUP_TESTE_DB: undefined, BACKUP_TESTE_PG_AUTORIZADO: undefined }), banco: 'gestao_epi_teste_local', motivo: /BACKUP_TESTE_DB/ },
    { env: envAutorizado({ BACKUP_TESTE_PG_AUTORIZADO: undefined }), banco: 'banco_aut_x', motivo: /autoriz/i },
    { env: envAutorizado({ BACKUP_TESTE_PG_AUTORIZADO: 'outro_banco' }), banco: 'banco_aut_x', motivo: /autoriz/i },
    { env: envAutorizado({ BACKUP_TESTE_PG_AUTORIZADO: 'banco_aut_x ' }), banco: 'banco_aut_x', motivo: /autoriz/i },
    { env: envAutorizado({ BACKUP_TESTE_PG_AUTORIZADO: 'SIM' }), banco: 'banco_aut_x', motivo: /autoriz/i },
    { env: envAutorizado({ BACKUP_TESTE_DB: 'gestao_epi_teste_local', BACKUP_TESTE_PG_AUTORIZADO: undefined }), banco: 'gestao_epi_teste_local', motivo: /autoriz/i },
    { env: envAutorizado(), banco: 'gestao_epi_teste_local', motivo: /BACKUP_TESTE_DB|autoriz/i },
  ];
  for (const c of casos) {
    const f = pgBinFalso();
    assert.match(String(motivoSemPg({ env: c.env, pgBin: f.bin, banco: c.banco })), c.motivo, JSON.stringify(c.env));
    assert.deepEqual(f.chamadas(), [], `${JSON.stringify(c.env)}: nenhuma sonda executada`);
  }
});

test('detecção PostgreSQL: bancos protegidos (homolog, prod, postgres, template) são recusados mesmo autorizados e nunca são consultados', () => {
  for (const nome of ['homolog_local', 'Homolog_X', 'gestao_prod', 'producao_x', 'postgres', 'template0', 'template1']) {
    const f = pgBinFalso();
    const motivo = motivoSemPg({ env: envAutorizado({ BACKUP_TESTE_DB: nome, BACKUP_TESTE_PG_AUTORIZADO: nome }), pgBin: f.bin, banco: nome });
    assert.match(String(motivo), /protegido/i, nome);
    assert.deepEqual(f.chamadas(), [], `${nome}: nenhuma consulta`);
  }
});

test('detecção PostgreSQL: ambiente local autorizado → sem motivo; pg_isready e psql recebem a mesma conexão, sem senha; socket local é verificado', () => {
  const f = pgBinFalso();
  const env = envAutorizado({ PGUSER: 'usuario_t', PGPASSWORD: SENTINELA });
  assert.equal(motivoSemPg({ env, pgBin: f.bin, banco: 'banco_aut_x' }), null);
  const chamadas = f.chamadas();
  assert.equal(chamadas.length, 2);
  assert.match(chamadas[0], /^pg_isready /);
  assert.match(chamadas[1], /^psql .*-d banco_aut_x/);
  assert.equal(conexaoDe(chamadas[0]), '127.0.0.1|55432|usuario_t');
  assert.equal(conexaoDe(chamadas[1]), conexaoDe(chamadas[0]));
  for (const c of chamadas) assert.match(c, /PGPASSWORD= args=/);
  assert.doesNotMatch(chamadas.join('\n'), new RegExp(SENTINELA));
  assert.equal(verificarDestinoLocal({ PGHOST: '/tmp/sock-falso', PGPORT: '5433' }, () => ({ isSocket: () => true })), null);
  assert.match(String(verificarDestinoLocal({ PGHOST: '/tmp/sock-falso' }, () => ({ isSocket: () => false }))), /socket/);
  assert.match(String(verificarDestinoLocal({ PGHOST: '/tmp/sock-falso' }, () => { throw new Error('ENOENT'); })), /socket/);
});

test('detecção PostgreSQL: o script (pg_dump) recebe exatamente a mesma conexão das sondas e nunca a senha nem o serviço', () => {
  const chaves = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGSERVICE'];
  const salvo = Object.fromEntries(chaves.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { PGHOST: '127.0.0.1', PGPORT: '55432', PGUSER: 'usuario_t', PGPASSWORD: SENTINELA, PGSERVICE: 'servico_x' });
  try {
    assert.deepEqual(ambienteDeConexao(process.env), { PGHOST: '127.0.0.1', PGPORT: '55432', PGUSER: 'usuario_t' });
    const { bin } = ferramentasFalsas({});
    const registro = path.join(bin, 'amb-pg_dump.txt');
    fs.writeFileSync(path.join(bin, 'pg_dump'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.0 (falso)"; exit 0; fi
echo "PGHOST=$PGHOST PGPORT=$PGPORT PGUSER=$PGUSER PGSERVICE=$PGSERVICE PGPASSWORD=$PGPASSWORD" > "${registro}"
for a in "$@"; do case "$a" in --file=*) printf 'PGDMP-falso' > "\${a#--file=}";; esac; done
exit 0
`, { mode: 0o755 });
    const r = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destinoPrivado(), BACKUP_PG_BIN: bin });
    assert.equal(r.status, 0, r.stderr);
    const gravado = fs.readFileSync(registro, 'utf8');
    assert.equal(conexaoDe(gravado), '127.0.0.1|55432|usuario_t');
    assert.match(gravado, /PGSERVICE= PGPASSWORD=\s*$/);
    const f = pgBinFalso();
    assert.equal(motivoSemPg({ env: { ...process.env, BACKUP_TESTE_DB: 'banco_aut_x', BACKUP_TESTE_PG_AUTORIZADO: 'banco_aut_x', PGSERVICE: undefined }, pgBin: f.bin, banco: 'banco_aut_x' }), null);
    assert.equal(conexaoDe(f.chamadas()[0]), conexaoDe(gravado));
    assert.equal(conexaoDe(f.chamadas()[1]), conexaoDe(gravado));
  } finally {
    for (const k of chaves) { if (salvo[k] === undefined) delete process.env[k]; else process.env[k] = salvo[k]; }
  }
});

test('o script só lê o banco: sem psql, DDL/DML nem pg_restore fora de --list', () => {
  const fonte = fs.readFileSync(SCRIPT, 'utf8').replace(/^\s*#.*$/gm, '');
  for (const proibido of [/\bpsql\b/, /\bCREATE\s+DATABASE\b/i, /\bDROP\b/i, /\bINSERT\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bTRUNCATE\b/i, /set\s+-x/]) {
    assert.doesNotMatch(fonte, proibido);
  }
  for (const linha of fonte.split('\n').filter((l) => /pg_restore/.test(l) && /"\$/.test(l))) {
    assert.match(linha, /--list|--version|pg_restore"?\s*$|PG_RESTORE|\bBIN\b/);
  }
});

test('configuração ausente ou inválida: código 2, sem criar nada', () => {
  const destino = destinoPrivado();
  assert.equal(executar({ BACKUP_DESTINO: destino }).status, 2);
  assert.equal(executar({ BACKUP_DB_NOME: 'x' }).status, 2);
  for (const nome of ['a;b', '-rf', 'a b', '$(id)', '']) {
    const r = executar({ BACKUP_DB_NOME: nome, BACKUP_DESTINO: destino });
    assert.equal(r.status, 2, nome);
  }
  assert.deepEqual(execucoesGravadas(destino), []);
});

test('destino inseguro: modo 0755, inexistente e área sincronizada são recusados (código 3)', () => {
  const aberto = dirTemp('backup-db-aberto-');
  fs.chmodSync(aberto, 0o755);
  assert.equal(executar({ BACKUP_DB_NOME: BANCO, BACKUP_DESTINO: aberto }).status, 3);
  assert.equal(executar({ BACKUP_DB_NOME: BANCO, BACKUP_DESTINO: path.join(aberto, 'nao-existe') }).status, 3);

  const home = dirTemp('backup-db-home-');
  const sinc = path.join(home, 'Desktop', 'bk');
  fs.mkdirSync(sinc, { recursive: true, mode: 0o700 });
  fs.chmodSync(sinc, 0o700);
  const r = executar({ BACKUP_DB_NOME: BANCO, BACKUP_DESTINO: sinc, HOME: home });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /E_DESTINO_SINCRONIZADO/);
  assert.deepEqual(execucoesGravadas(sinc), []);
});

test('pg_dump ausente: código 4 e nada gravado', () => {
  const destino = destinoPrivado();
  const r = executar({ BACKUP_DB_NOME: BANCO, BACKUP_DESTINO: destino, BACKUP_PG_BIN: '/nao/existe/bin' });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /E_FERRAMENTA_AUSENTE/);
  assert.deepEqual(execucoesGravadas(destino), []);
});

test('argumentos do pg_dump: formato custom, sem senha, sem diretório de saída fora do destino', () => {
  const destino = destinoPrivado();
  const { bin, gravaArgs } = ferramentasFalsas({});
  const r = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino, BACKUP_PG_BIN: bin, PGPASSWORD: SENTINELA });
  assert.equal(r.status, 0, r.stderr);
  const args = fs.readFileSync(gravaArgs, 'utf8');
  assert.match(args, /--format=custom/);
  assert.match(args, /--no-password/);
  assert.match(args, /banco_falso/);
  assert.doesNotMatch(args, new RegExp(SENTINELA));
});

test('pg_dump parcial/falho: código 5, dump removido, FALHA-<id> com falha.json, sem MANIFEST', () => {
  const destino = destinoPrivado();
  const { bin } = ferramentasFalsas({ dump: 'parcial' });
  const r = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino, BACKUP_PG_BIN: bin });
  assert.equal(r.status, 5);
  const nomes = execucoesGravadas(destino);
  assert.equal(nomes.length, 1);
  assert.match(nomes[0], /^FALHA-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  const arquivos = listarRecursivo(path.join(destino, nomes[0])).map((p) => path.basename(p));
  assert.ok(arquivos.includes('falha.json'));
  assert.ok(!arquivos.includes('banco.dump'));
  assert.ok(!arquivos.includes('MANIFEST.json'));
  const falha = JSON.parse(fs.readFileSync(path.join(destino, nomes[0], 'falha.json'), 'utf8'));
  assert.equal(falha.codigo, 'E_PGDUMP_FALHOU');
  assert.match(falha.run_id, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
});

test('pg_restore --list falho ou vazio: código 6 e dump descartado', () => {
  for (const restore of ['falha', 'vazio']) {
    const destino = destinoPrivado();
    const { bin } = ferramentasFalsas({ restore });
    const r = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino, BACKUP_PG_BIN: bin });
    assert.equal(r.status, 6, restore);
    const nomes = execucoesGravadas(destino);
    assert.equal(nomes.length, 1);
    assert.match(nomes[0], /^FALHA-/);
    assert.ok(!listarRecursivo(path.join(destino, nomes[0])).some((p) => p.endsWith('banco.dump')));
  }
});

// run_id previsível (date e od fixos no PATH) para provocar colisões. Com `colisao`, o 1º `node` cria esse diretório
// (simula a corrida entre a conferência inicial e a publicação).
const RUN_ID_FIXO = '20260101T000000Z-aabbccdd';
function pathRunIdFixo({ colisao = null } = {}) {
  const bin = dirTemp('backup-db-runid-');
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

test('run_id já existente (execução, FALHA- ou NAOPUBLICAVEL-): recusado com E_RUN_ID_EXISTENTE (código 3), marcador intacto e nada criado', () => {
  for (const nome of [RUN_ID_FIXO, `FALHA-${RUN_ID_FIXO}`, `NAOPUBLICAVEL-${RUN_ID_FIXO}`]) {
    const destino = destinoPrivado();
    fs.mkdirSync(path.join(destino, nome));
    fs.writeFileSync(path.join(destino, nome, 'marcador.txt'), 'original\n');
    const { bin } = ferramentasFalsas({});
    const r = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino, BACKUP_PG_BIN: bin, PATH: pathRunIdFixo() });
    assert.equal(r.status, 3, `${nome}: ${r.stderr}`);
    assert.match(r.stderr, /E_RUN_ID_EXISTENTE/, nome);
    assert.deepEqual(fs.readdirSync(destino), [nome], `${nome}: nada criado`);
    marcadorIntacto(path.join(destino, nome));
  }
});

test('colisão entre a conferência inicial e a publicação (execução final): código 3, sem aninhar nem sobrescrever; o backup íntegro permanece em andamento', () => {
  const destino = destinoPrivado();
  const final = path.join(destino, RUN_ID_FIXO);
  const { bin } = ferramentasFalsas({});
  const r = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino, BACKUP_PG_BIN: bin, PATH: pathRunIdFixo({ colisao: final }) });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /E_RUN_ID_EXISTENTE/);
  marcadorIntacto(final);
  const guardado = path.join(destino, `.em-andamento-${RUN_ID_FIXO}`);
  for (const f of ['banco.dump', 'toc.txt', 'MANIFEST.json', 'MANIFEST.json.sha256']) assert.ok(fs.existsSync(path.join(guardado, f)), f);
});

test('colisão na publicação de FALHA-<run_id>: código 3, marcador intacto, nada aninhado; a falha permanece em andamento com falha.json', () => {
  const destino = destinoPrivado();
  const { bin } = ferramentasFalsas({});
  fs.writeFileSync(path.join(bin, 'pg_dump'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.0 (falso)"; exit 0; fi
for a in "$@"; do case "$a" in --file=*) f="\${a#--file=}";; esac; done
d="$(dirname "$(dirname "$f")")"
mkdir "$d/FALHA-${RUN_ID_FIXO}" && echo original > "$d/FALHA-${RUN_ID_FIXO}/marcador.txt"
echo "erro simulado" >&2
exit 1
`, { mode: 0o755 });
  const r = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino, BACKUP_PG_BIN: bin, PATH: pathRunIdFixo() });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /E_RUN_ID_EXISTENTE/);
  marcadorIntacto(path.join(destino, `FALHA-${RUN_ID_FIXO}`));
  assert.ok(fs.existsSync(path.join(destino, `.em-andamento-${RUN_ID_FIXO}`, 'falha.json')));
});

// `mkdir` que falha sem criar nada, exceto para .em-andamento-*: simula falta de espaço ou permissão ao reservar o nome de publicação.
function pathMkdirFalha() {
  const bin = dirTemp('backup-db-mkdirfalso-');
  fs.writeFileSync(path.join(bin, 'mkdir'), '#!/bin/sh\nfor a in "$@"; do ultimo="$a"; done\ncase "$ultimo" in */.em-andamento-*) exec /bin/mkdir "$@";; esac\necho "mkdir: No space left on device (simulado)" >&2\nexit 1\n', { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

test('falha operacional ao reservar o nome de publicação (sem colisão): não vira E_RUN_ID_EXISTENTE, o erro original é preservado e o backup íntegro não é apagado', () => {
  // publicação de uma execução bem-sucedida
  const destino = destinoPrivado();
  const { bin } = ferramentasFalsas({});
  const r = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino, BACKUP_PG_BIN: bin, PATH: pathMkdirFalha() });
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stderr, /E_PUBLICACAO_LOCAL/);
  assert.doesNotMatch(r.stderr, /E_RUN_ID_EXISTENTE/);
  const emAndamento = fs.readdirSync(destino);
  assert.equal(emAndamento.length, 1);
  assert.match(emAndamento[0], /^\.em-andamento-/);
  for (const f of ['banco.dump', 'toc.txt', 'MANIFEST.json', 'MANIFEST.json.sha256']) assert.ok(fs.existsSync(path.join(destino, emAndamento[0], f)), `${f} preservado`);
  // falha original (pg_dump) seguida de falha ao publicar FALHA-<id>: o diagnóstico original prevalece
  const destino2 = destinoPrivado();
  const parcial = ferramentasFalsas({ dump: 'parcial' });
  const r2 = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino2, BACKUP_PG_BIN: parcial.bin, PATH: pathMkdirFalha() });
  assert.equal(r2.status, 5, r2.stderr);
  assert.match(r2.stderr, /E_PGDUMP_FALHOU/);
  assert.doesNotMatch(r2.stderr, /E_RUN_ID_EXISTENTE/);
  const emAndamento2 = fs.readdirSync(destino2);
  assert.equal(emAndamento2.length, 1);
  assert.ok(fs.existsSync(path.join(destino2, emAndamento2[0], 'falha.json')));
});

test('banco inexistente (pg_dump real): código 5 e nenhum dump publicável', { skip: SKIP_PG }, () => {
  const destino = destinoPrivado();
  const r = executar({ BACKUP_DB_NOME: 'banco_que_nao_existe_e1', BACKUP_DESTINO: destino, BACKUP_PG_BIN: PG_BIN });
  assert.equal(r.status, 5);
  const nomes = execucoesGravadas(destino);
  assert.equal(nomes.length, 1);
  assert.match(nomes[0], /^FALHA-/);
  assert.ok(!listarRecursivo(destino).some((p) => p.endsWith('banco.dump')));
});

test('banco sem objetos: recusado por padrão (código 6); se o banco tiver objetos, o dump é aceito', { skip: SKIP_PG }, () => {
  const destino = destinoPrivado();
  const r = executar({ BACKUP_DB_NOME: BANCO, BACKUP_DESTINO: destino, BACKUP_PG_BIN: PG_BIN });
  const nomes = execucoesGravadas(destino);
  assert.equal(nomes.length, 1);
  if (r.status === 0) {
    assert.ok(JSON.parse(fs.readFileSync(path.join(destino, nomes[0], 'MANIFEST.json'), 'utf8')).toc.entradas > 0);
  } else {
    assert.equal(r.status, 6);
    assert.match(nomes[0], /^FALHA-/);
    assert.ok(!listarRecursivo(destino).some((p) => p.endsWith('banco.dump')));
  }
});

test('sucesso real em gestao_epi_teste_local: dump válido, manifesto íntegro, permissões 0700/0600', { skip: SKIP_PG }, () => {
  const destino = destinoPrivado();
  const r = executar({ BACKUP_DB_NOME: BANCO, BACKUP_DESTINO: destino, BACKUP_PG_BIN: PG_BIN, BACKUP_PERMITIR_BANCO_VAZIO: '1' });
  assert.equal(r.status, 0, r.stderr);
  const resumo = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(resumo.status, 'OK');
  const nomes = execucoesGravadas(destino);
  assert.deepEqual(nomes, [resumo.run_id]);
  const exec = path.join(destino, resumo.run_id);
  assert.equal(fs.statSync(exec).mode & 0o777, 0o700);
  for (const nome of ['banco.dump', 'toc.txt', 'MANIFEST.json', 'MANIFEST.json.sha256', 'registro.log']) {
    assert.ok(fs.existsSync(path.join(exec, nome)), nome);
    assert.equal(fs.statSync(path.join(exec, nome)).mode & 0o777, 0o600, nome);
  }
  const dump = path.join(exec, 'banco.dump');
  const m = JSON.parse(fs.readFileSync(path.join(exec, 'MANIFEST.json'), 'utf8'));
  assert.equal(m.run_id, resumo.run_id);
  assert.equal(m.banco.nome, BANCO);
  assert.equal(m.dump.tamanho_bytes, fs.statSync(dump).size);
  assert.ok(m.dump.tamanho_bytes > 0);
  assert.equal(m.dump.sha256, crypto.createHash('sha256').update(fs.readFileSync(dump)).digest('hex'));
  assert.ok(m.aplicacao.total_migrations >= 90);
  // validação independente do dump
  const lista = spawnSync(path.join(PG_BIN, 'pg_restore'), ['--list', dump], { encoding: 'utf8' });
  assert.equal(lista.status, 0);
  assert.equal(m.toc.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(exec, 'toc.txt'))).digest('hex'));
  // verificador do manifesto
  const v = spawnSync(process.execPath, [path.join(RAIZ_BACKUP, 'lib', 'manifesto.js'), 'verificar', exec], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
});

test('segredo na variável PGPASSWORD nunca aparece em saída, registro, manifesto nem arquivos', { skip: SKIP_PG }, () => {
  const destino = destinoPrivado();
  const r = executar({ BACKUP_DB_NOME: BANCO, BACKUP_DESTINO: destino, BACKUP_PG_BIN: PG_BIN, PGPASSWORD: SENTINELA, BACKUP_PERMITIR_BANCO_VAZIO: '1' });
  // com autenticação "trust" local o dump passa; se o servidor exigir senha, falha — em ambos os casos o segredo não vaza
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SENTINELA));
  for (const arq of listarRecursivo(destino).filter((p) => fs.statSync(p).isFile())) {
    assert.ok(!fs.readFileSync(arq).includes(SENTINELA), arq);
  }
});

test('segredo também não vaza nos caminhos de falha', () => {
  const destino = destinoPrivado();
  const { bin } = ferramentasFalsas({ dump: 'parcial' });
  const r = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino, BACKUP_PG_BIN: bin, PGPASSWORD: SENTINELA });
  assert.equal(r.status, 5);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SENTINELA));
  for (const arq of listarRecursivo(destino).filter((p) => fs.statSync(p).isFile())) {
    assert.ok(!fs.readFileSync(arq).includes(SENTINELA), arq);
  }
});

test('duas execuções seguidas geram run_id e diretórios distintos, sem sobrescrever', () => {
  const destino = destinoPrivado();
  const { bin } = ferramentasFalsas({});
  const a = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino, BACKUP_PG_BIN: bin });
  const b = executar({ BACKUP_DB_NOME: 'banco_falso', BACKUP_DESTINO: destino, BACKUP_PG_BIN: bin });
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(execucoesGravadas(destino).length, 2);
});

test('sem BACKUP_REPO_RAIZ explícito o script deduz a raiz do repositório', { skip: SKIP_PG }, () => {
  const destino = destinoPrivado();
  const r = executar({ PATH: process.env.PATH, BACKUP_DB_NOME: BANCO, BACKUP_DESTINO: destino, BACKUP_PG_BIN: PG_BIN, BACKUP_PERMITIR_BANCO_VAZIO: '1' }, { semBase: true });
  assert.equal(r.status, 0, r.stderr);
  const exec = path.join(destino, execucoesGravadas(destino)[0]);
  assert.ok(JSON.parse(fs.readFileSync(path.join(exec, 'MANIFEST.json'), 'utf8')).aplicacao.total_migrations >= 90);
});
