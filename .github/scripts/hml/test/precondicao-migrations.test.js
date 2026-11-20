'use strict';
// Etapa 2B: verificador PURO de pré-condições de migrations. Só lê evidências e produz um laudo; nunca toca no banco,
// não executa processos e não restaura nada. Um recibo de backup isolado nunca basta: exige restauração do MESMO dump.
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../../../..');
const ARQ = path.join(RAIZ, 'deploy/hml/cd/precondicao-migrations.js');
const V = require(ARQ);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

const AGORA = Date.parse('2026-11-19T12:00:00.000Z');
const HORA = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000;
const COLETA = iso(AGORA - 5 * MIN);
const COMMIT = 'a'.repeat(40);
const ROTULO = `hml-20261119T110000-${COMMIT.slice(0, 7)}`;
const RELEASE_SHA = 'b'.repeat(64);
const DUMP = 'd'.repeat(64);

const SQL = {
  '001_base.sql': 'CREATE TABLE a (id int);\n',
  '002_dois.sql': 'ALTER TABLE a ADD COLUMN x int;\n',
  '003_tres.sql': '-- CREATE INDEX CONCURRENTLY num comentário não conta\nALTER TABLE a ADD COLUMN y int;\n',
};
const decl = (nome) => ({ nome, sha256: sha(SQL[nome]) });
function cenario(sobre = {}) {
  return {
    release: { commit: COMMIT, rotulo: ROTULO, atual: true, geradoEm: iso(AGORA - HORA), backend: { migrations: Object.keys(SQL).map(decl) } },
    releaseSha256: RELEASE_SHA,
    estado: { banco: 'safework_hml', coletadoEm: COLETA, aplicadas: ['001_base.sql'].map(decl) },
    backup: { tipo: 'backup', dumpSha256: DUMP, tamanhoBytes: 4096, banco: 'safework_hml', criadoEm: iso(AGORA - 2 * HORA), ultimaMigration: '001_base.sql', migrationsAplicadas: 1 },
    restauracao: {
      tipo: 'restauracao', dumpSha256: DUMP, bancoOrigem: 'safework_hml', bancoRestaurado: 'safework_hml_restauracao', instanciaNova: true, restauradoEm: iso(AGORA - HORA),
      ultimaMigration: '001_base.sql', migrationsAplicadas: 1, integridadeDump: true, sentinelas: { ok: true, verificadas: 3 },
    },
    sqlPendentes: { ...SQL },
    agora: AGORA,
    ...sobre,
  };
}
const codigos = (laudo) => laudo.problemas.map((p) => p.codigo).sort();

describe('aprovação', () => {
  test('backup e restauração do mesmo dump, banco coerente e migrations íntegras aprovam e vinculam o laudo', () => {
    const l = V.verificar(cenario());
    assert.deepEqual(codigos(l), []);
    assert.equal(l.resultado, 'APROVADO');
    assert.deepEqual(l.pendentes, ['002_dois.sql', '003_tres.sql']);
    assert.deepEqual(l.vinculos, { commit: COMMIT, rotulo: ROTULO, releaseSha256: RELEASE_SHA, dumpSha256: DUMP });
    assert.equal(l.geradoEm, iso(AGORA));
    assert.ok(Date.parse(l.validoAte) > AGORA && Date.parse(l.validoAte) <= AGORA + 4 * HORA);
  });

  test('sem migrations pendentes não há alteração de banco e o laudo aprova sem exigir backup', () => {
    const l = V.verificar(cenario({ estado: { banco: 'safework_hml', coletadoEm: COLETA, aplicadas: Object.keys(SQL).map(decl) }, backup: undefined, restauracao: undefined }));
    assert.equal(l.resultado, 'APROVADO');
    assert.deepEqual(l.pendentes, []);
  });

  test('o laudo é determinístico e o selo detecta adulteração', () => {
    const a = V.verificar(cenario());
    const b = V.verificar(cenario());
    assert.equal(a.laudoSha256, b.laudoSha256);
    assert.equal(V.selo(a), a.laudoSha256);
    assert.notEqual(V.selo({ ...a, resultado: 'REPROVADO' }), a.laudoSha256);
    assert.notEqual(V.selo({ ...a, vinculos: { ...a.vinculos, dumpSha256: 'e'.repeat(64) } }), a.laudoSha256);
  });
});

describe('um recibo de backup isolado não prova recuperabilidade', () => {
  test('sem recibo de restauração: reprovado', () => {
    const l = V.verificar(cenario({ restauracao: undefined }));
    assert.equal(l.resultado, 'REPROVADO');
    assert.ok(codigos(l).includes('RESTAURACAO_AUSENTE'));
  });
  test('sem recibo de backup: reprovado', () => {
    const l = V.verificar(cenario({ backup: undefined }));
    assert.ok(codigos(l).includes('BACKUP_AUSENTE'));
  });
  test('restauração de outro dump: reprovado', () => {
    const l = V.verificar(cenario({ restauracao: { ...cenario().restauracao, dumpSha256: 'e'.repeat(64) } }));
    assert.ok(codigos(l).includes('DUMP_DIVERGENTE'));
  });
  test('restauração sobre o próprio banco de origem ou fora de instância nova: reprovado', () => {
    const base = cenario().restauracao;
    assert.ok(codigos(V.verificar(cenario({ restauracao: { ...base, bancoRestaurado: base.bancoOrigem } }))).includes('RESTAURACAO_SOBRE_ORIGEM'));
    assert.ok(codigos(V.verificar(cenario({ restauracao: { ...base, instanciaNova: false } }))).includes('RESTAURACAO_SOBRE_ORIGEM'));
  });
  test('dump sem integridade verificada ou sentinelas reprovadas: reprovado', () => {
    const base = cenario().restauracao;
    assert.ok(codigos(V.verificar(cenario({ restauracao: { ...base, integridadeDump: false } }))).includes('INTEGRIDADE_NAO_COMPROVADA'));
    assert.ok(codigos(V.verificar(cenario({ restauracao: { ...base, sentinelas: { ok: false, verificadas: 3 } } }))).includes('INTEGRIDADE_NAO_COMPROVADA'));
    assert.ok(codigos(V.verificar(cenario({ restauracao: { ...base, sentinelas: { ok: true, verificadas: 0 } } }))).includes('INTEGRIDADE_NAO_COMPROVADA'));
  });
  test('a restauração precisa reproduzir o estado do banco: última migration e contagem', () => {
    const base = cenario().restauracao;
    assert.ok(codigos(V.verificar(cenario({ restauracao: { ...base, ultimaMigration: '002_dois.sql' } }))).includes('RESTAURACAO_DEFASADA'));
    assert.ok(codigos(V.verificar(cenario({ restauracao: { ...base, migrationsAplicadas: 5 } }))).includes('RESTAURACAO_DEFASADA'));
  });
  test('restauração anterior ao backup ou no futuro: reprovado', () => {
    const base = cenario().restauracao;
    assert.ok(codigos(V.verificar(cenario({ restauracao: { ...base, restauradoEm: iso(AGORA - 3 * HORA) } }))).includes('CRONOLOGIA_INVALIDA'));
    assert.ok(codigos(V.verificar(cenario({ restauracao: { ...base, restauradoEm: iso(AGORA + HORA) } }))).includes('CRONOLOGIA_INVALIDA'));
  });
});

describe('frescor e coerência do backup', () => {
  test('backup com mais de 24 h ou restauração com mais de 72 h: reprovado', () => {
    assert.ok(codigos(V.verificar(cenario({ backup: { ...cenario().backup, criadoEm: iso(AGORA - 25 * HORA) }, restauracao: { ...cenario().restauracao, restauradoEm: iso(AGORA - 24 * HORA) } }))).includes('BACKUP_VENCIDO'));
    assert.ok(codigos(V.verificar(cenario({ backup: { ...cenario().backup, criadoEm: iso(AGORA - 73 * HORA) }, restauracao: { ...cenario().restauracao, restauradoEm: iso(AGORA - 72 * HORA - 1000) } }))).includes('RESTAURACAO_VENCIDA'));
  });
  test('backup de outro banco ou defasado em relação ao estado atual: reprovado', () => {
    assert.ok(codigos(V.verificar(cenario({ backup: { ...cenario().backup, banco: 'outro' } }))).includes('BACKUP_DE_OUTRO_BANCO'));
    assert.ok(codigos(V.verificar(cenario({ backup: { ...cenario().backup, ultimaMigration: '000_antiga.sql', migrationsAplicadas: 0 } }))).includes('BACKUP_DEFASADO'));
  });
  test('o laudo expira antes do vencimento do backup, do menor prazo', () => {
    const l = V.verificar(cenario({ backup: { ...cenario().backup, criadoEm: iso(AGORA - 23 * HORA - 45 * 60000) }, restauracao: { ...cenario().restauracao, restauradoEm: iso(AGORA - 23 * HORA) } }));
    assert.equal(l.resultado, 'APROVADO');
    assert.equal(Date.parse(l.validoAte), AGORA + 15 * 60000);
  });
});

describe('release, estado do banco e SQL', () => {
  test('migration aplicada com hash diferente do release: reprovado', () => {
    const l = V.verificar(cenario({ estado: { banco: 'safework_hml', coletadoEm: COLETA, aplicadas: [{ nome: '001_base.sql', sha256: 'f'.repeat(64) }] } }));
    assert.ok(codigos(l).includes('APLICADA_DIVERGENTE'));
  });
  test('banco à frente do release ou pendentes fora de ordem: reprovado', () => {
    const adiante = { banco: 'safework_hml', coletadoEm: COLETA, aplicadas: [...['001_base.sql', '002_dois.sql', '003_tres.sql'].map(decl), { nome: '004_extra.sql', sha256: 'c'.repeat(64) }] };
    assert.ok(codigos(V.verificar(cenario({ estado: adiante }))).includes('BANCO_A_FRENTE_DO_RELEASE'));
    const furo = { banco: 'safework_hml', coletadoEm: COLETA, aplicadas: [decl('002_dois.sql')] };
    assert.ok(codigos(V.verificar(cenario({ estado: furo }))).includes('PENDENTES_FORA_DE_ORDEM'));
  });
  test('SQL ausente, SQL com hash diferente do declarado e SQL que não roda em transação: reprovado', () => {
    const faltando = { ...SQL }; delete faltando['002_dois.sql'];
    assert.ok(codigos(V.verificar(cenario({ sqlPendentes: faltando }))).includes('SQL_NAO_FORNECIDO'));
    assert.ok(codigos(V.verificar(cenario({ sqlPendentes: { ...SQL, '002_dois.sql': 'SELECT 1;' } }))).includes('SQL_DIVERGENTE'));
    for (const perigoso of ['CREATE INDEX CONCURRENTLY i ON a (x);', 'VACUUM a;', 'CREATE DATABASE x;', 'DROP DATABASE x;', 'ALTER SYSTEM SET work_mem = 1;', 'SELECT 1;\nCOMMIT;']) {
      const novo = { ...SQL, '002_dois.sql': perigoso };
      const release = cenario().release;
      release.backend.migrations = Object.keys(novo).map((n) => ({ nome: n, sha256: sha(novo[n]) }));
      assert.ok(codigos(V.verificar(cenario({ release, sqlPendentes: novo }))).includes('SQL_NAO_TRANSACIONAL'), perigoso);
    }
  });
  test('BEGIN dentro de bloco procedural não é falso positivo', () => {
    const novo = { ...SQL, '002_dois.sql': 'DO $$ BEGIN PERFORM 1; END $$;' };
    const release = cenario().release;
    release.backend.migrations = Object.keys(novo).map((n) => ({ nome: n, sha256: sha(novo[n]) }));
    assert.equal(V.verificar(cenario({ release, sqlPendentes: novo })).resultado, 'APROVADO');
  });
  test('release malformado ou com identidade inválida: reprovado, sem exceção', () => {
    assert.ok(codigos(V.verificar(cenario({ release: { commit: 'x' } }))).includes('RELEASE_INVALIDO'));
    assert.ok(codigos(V.verificar(cenario({ releaseSha256: 'curto' }))).includes('RELEASE_INVALIDO'));
    assert.ok(codigos(V.verificar(cenario({ estado: null }))).includes('ESTADO_INVALIDO'));
    assert.equal(V.verificar({}).resultado, 'REPROVADO');
  });
});

describe('B2: atualidade do estado do banco (máximo de 30 minutos)', () => {
  const comColeta = (valor) => cenario({ estado: { ...cenario().estado, coletadoEm: valor } });
  test('sem carimbo, com texto que não é data ou com tipo errado: ESTADO_INVALIDO', () => {
    const { coletadoEm, ...semCarimbo } = cenario().estado;
    assert.ok(codigos(V.verificar(cenario({ estado: semCarimbo }))).includes('ESTADO_INVALIDO'));
    for (const v of ['ontem', '', 12345, null, {}]) assert.ok(codigos(V.verificar(comColeta(v))).includes('ESTADO_INVALIDO'), JSON.stringify(v));
  });
  test('data futura além da tolerância de 1 minuto: CRONOLOGIA_INVALIDA; dentro da tolerância é aceita', () => {
    assert.ok(codigos(V.verificar(comColeta(iso(AGORA + 5 * MIN)))).includes('CRONOLOGIA_INVALIDA'));
    assert.equal(V.verificar(comColeta(iso(AGORA + 30000))).resultado, 'APROVADO');
  });
  test('exatamente 30 minutos é aceito; um segundo a mais vence', () => {
    assert.equal(V.verificar(comColeta(iso(AGORA - 30 * MIN))).resultado, 'APROVADO');
    assert.ok(codigos(V.verificar(comColeta(iso(AGORA - 30 * MIN - 1000)))).includes('ESTADO_VENCIDO'));
    assert.ok(codigos(V.verificar(comColeta(iso(AGORA - 31 * MIN)))).includes('ESTADO_VENCIDO'));
  });
  test('estado vencido reprova mesmo sem migrations pendentes', () => {
    const todas = Object.keys(SQL).map(decl);
    const l = V.verificar(cenario({ estado: { banco: 'safework_hml', coletadoEm: iso(AGORA - 2 * HORA), aplicadas: todas }, backup: undefined, restauracao: undefined }));
    assert.equal(l.resultado, 'REPROVADO');
    assert.ok(codigos(l).includes('ESTADO_VENCIDO'));
  });
  test('o laudo nunca vale além de 30 minutos da coleta do estado', () => {
    const l = V.verificar(comColeta(iso(AGORA - 20 * MIN)));
    assert.equal(l.resultado, 'APROVADO');
    assert.equal(Date.parse(l.validoAte), AGORA + 10 * MIN);
  });
  test('o CLI rejeita estado sem carimbo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-pre2-'));
    try {
      const c = cenario();
      const { coletadoEm, ...sem } = c.estado;
      fs.mkdirSync(path.join(dir, 'migrations'));
      for (const [n, t] of Object.entries(c.sqlPendentes)) fs.writeFileSync(path.join(dir, 'migrations', n), t);
      const grava = (n, o) => { fs.writeFileSync(path.join(dir, n), JSON.stringify(o)); return path.join(dir, n); };
      const rel = grava('release.json', c.release);
      const args = ['--release', rel, '--release-sha256', sha(fs.readFileSync(rel)), '--estado', grava('estado.json', sem), '--migrations', path.join(dir, 'migrations'), '--backup', grava('b.json', c.backup), '--restauracao', grava('r.json', c.restauracao)];
      let err = '';
      assert.equal(V.principal(args, { saida: () => {}, erro: (t) => { err += t; }, agora: () => AGORA }), 2);
      assert.match(err, /ESTADO_INVALIDO/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('B1: scanner SQL consciente de comentários, literais e corpos', () => {
  const CASOS = [
    ["select 'a--b'; CREATE INDEX CONCURRENTLY i ON t(x);", 'SQL_NAO_TRANSACIONAL'],
    ['-- CONCURRENTLY num comentário\nselect 1;', 'OK'],
    ['/* CONCURRENTLY /* aninhado */ ainda comentário */ select 1;', 'OK'],
    ['select 1;\nCOMMIT', 'SQL_NAO_TRANSACIONAL'],
    ['select 1;\ncommit ;  ', 'SQL_NAO_TRANSACIONAL'],
    ['BEGIN;\nselect 1;', 'SQL_NAO_TRANSACIONAL'],
    ['select 1; ROLLBACK', 'SQL_NAO_TRANSACIONAL'],
    ['DO $$ BEGIN PERFORM 1; END $$;', 'OK'],
    ['CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN COMMIT; END $$;', 'OK'],
    ["CREATE TABLESPACE x LOCATION '/tmp';", 'SQL_NAO_TRANSACIONAL'],
    ['DROP TABLESPACE IF EXISTS x;', 'SQL_NAO_TRANSACIONAL'],
    ['ALTER TABLE t SET TABLESPACE x;', 'OK'],
    ["select E'it\\'s -- nao e comentario'; select 1 -- CONCURRENTLY real comentario", 'OK'],
    ["select 'COMMIT;';", 'OK'],
    ['select $tag$ -- x ; COMMIT; $tag$;', 'OK'],
    ["DO $x$ BEGIN EXECUTE 'CREATE INDEX CONCURRENTLY i ON t(a)'; END $x$;", 'SQL_NAO_TRANSACIONAL'],
    ["select 'aberto", 'SQL_MALFORMADO'],
    ['/* aberto', 'SQL_MALFORMADO'],
    ['select $$ aberto', 'SQL_MALFORMADO'],
    ['ALTER SYSTEM SET work_mem = 1;', 'SQL_NAO_TRANSACIONAL'],
    ['VACUUM a;', 'SQL_NAO_TRANSACIONAL'],
    ['CREATE TABLE a (id int);', 'OK'],
    ['select a$b$c;', 'OK'],
    ['SELECT 1; -- COMMIT;', 'OK'],
  ];
  test('os 24 casos adversariais', () => {
    assert.equal(CASOS.length, 24);
    for (const [sql, esperado] of CASOS) assert.equal(V.classificarSql(sql), esperado, JSON.stringify(sql));
  });
  test('palavra proibida dentro de literal ou corpo é falso positivo documentado: reprova (conservador)', () => {
    assert.equal(V.classificarSql("COMMENT ON TABLE t IS 'build index concurrently depois';"), 'SQL_NAO_TRANSACIONAL');
  });
  test('as 97 migrations existentes continuam classificadas como OK', () => {
    const dir = path.join(RAIZ, 'backend/migrations');
    const todas = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    assert.ok(todas.length >= 97, `esperadas ao menos 97 migrations, achadas ${todas.length}`);
    for (const f of todas) assert.equal(V.classificarSql(fs.readFileSync(path.join(dir, f), 'utf8')), 'OK', f);
  });
  test('o verificador reprova o literal que escondia CONCURRENTLY, COMMIT sem ponto e vírgula, TABLESPACE e SQL malformado', () => {
    const exemplos = [
      ["select 'a--b'; CREATE INDEX CONCURRENTLY i ON a (x);", 'SQL_NAO_TRANSACIONAL'],
      ['select 1;\nCOMMIT', 'SQL_NAO_TRANSACIONAL'],
      ["CREATE TABLESPACE x LOCATION '/tmp';", 'SQL_NAO_TRANSACIONAL'],
      ['DROP TABLESPACE x;', 'SQL_NAO_TRANSACIONAL'],
      ["select 'aberto", 'SQL_MALFORMADO'],
    ];
    for (const [sql, codigo] of exemplos) {
      const novo = { ...SQL, '002_dois.sql': sql };
      const release = cenario().release;
      release.backend.migrations = Object.keys(novo).map((n) => ({ nome: n, sha256: sha(novo[n]) }));
      const l = V.verificar(cenario({ release, sqlPendentes: novo }));
      assert.equal(l.resultado, 'REPROVADO', sql);
      assert.ok(codigos(l).includes(codigo), `${sql}: ${codigos(l)}`);
    }
  });
});

describe('falsos negativos do scanner: controle de transação, CALL, REINDEX e subscriptions', () => {
  const NT = 'SQL_NAO_TRANSACIONAL';
  // Os 19 casos adicionais da conferência de 19/11/2026, com o esperado pelas decisões 1 a 6.
  const DEZENOVE = [
    ['BEGIN;', 'BEGIN;\nCREATE TABLE t(a int);\nCOMMIT;', NT],
    ['BEGIN TRANSACTION', 'BEGIN TRANSACTION;\nCREATE TABLE t(a int);', NT],
    ['BEGIN WORK', 'BEGIN WORK;\nSELECT 1;', NT],
    ['BEGIN ISOLATION', 'BEGIN ISOLATION LEVEL SERIALIZABLE;\nSELECT 1;', NT],
    ['START ISOLATION', 'START TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nSELECT 1;', NT],
    ['END;', 'CREATE TABLE t(a int);\nEND;', NT],
    ['COMMIT WORK', 'CREATE TABLE t(a int);\nCOMMIT WORK;', NT],
    ['COMMIT AND CHAIN', 'CREATE TABLE t(a int);\nCOMMIT AND CHAIN;', NT],
    ['ROLLBACK', 'CREATE TABLE t(a int);\nROLLBACK;', NT],
    ['PREPARE TRANSACTION', 'CREATE TABLE t(a int);\nPREPARE TRANSACTION $$x$$;', NT],
    ['CALL proc', 'CALL meu_proc();', NT],
    ['REINDEX DATABASE', 'REINDEX DATABASE x;', NT],
    ['CREATE SUBSCRIPTION', 'CREATE SUBSCRIPTION s CONNECTION $$x$$ PUBLICATION p;', NT],
    ['VACUUM', 'VACUUM t;', NT],
    ['CONCURRENTLY', 'CREATE INDEX CONCURRENTLY i ON t(a);', NT],
    ['ok simples', 'CREATE TABLE t(a int);\nINSERT INTO t VALUES (1);', 'OK'],
    ['COMMIT em comentário', '-- COMMIT;\nCREATE TABLE t(a int);', 'OK'],
    ['COMMIT em DO', 'DO $$ BEGIN PERFORM 1; END $$;', 'OK'],
    ['COMMENT ON falso+', 'COMMENT ON TABLE t IS $$vacuum$$;', NT],
  ];
  const DEZ = ['BEGIN TRANSACTION', 'BEGIN WORK', 'BEGIN ISOLATION', 'START ISOLATION', 'END;', 'COMMIT WORK', 'COMMIT AND CHAIN', 'PREPARE TRANSACTION', 'REINDEX DATABASE', 'CREATE SUBSCRIPTION'];
  // Devolvem a lista completa do que divergiu, para o RED mostrar todos os casos de uma vez.
  const naoReprovados = (lista) => lista.filter((sql) => V.classificarSql(sql) !== NT);
  const naoAceitos = (lista) => lista.map((sql) => [sql, V.classificarSql(sql)]).filter(([, obtido]) => obtido !== 'OK');

  test('os 10 falsos negativos identificados na conferência passam a ser reprovados', () => {
    const dez = DEZENOVE.filter(([nome]) => DEZ.includes(nome));
    assert.equal(dez.length, 10);
    assert.deepEqual(dez.filter(([, sql]) => V.classificarSql(sql) !== NT).map(([nome]) => nome), []);
  });

  test('os 19 casos adicionais têm a classificação decidida (CALL reprovado; COMMENT ON é falso positivo documentado)', () => {
    assert.equal(DEZENOVE.length, 19);
    assert.deepEqual(DEZENOVE.map(([nome, sql, esperado]) => [nome, V.classificarSql(sql), esperado]).filter(([, obtido, esperado]) => obtido !== esperado), []);
    const contagem = {};
    for (const [, sql] of DEZENOVE) { const c = V.classificarSql(sql); contagem[c] = (contagem[c] || 0) + 1; }
    assert.deepEqual(contagem, { SQL_NAO_TRANSACIONAL: 16, OK: 3 });
  });

  test('decisão 3: variantes de BEGIN e START TRANSACTION, com argumentos e sem ponto e vírgula final', () => {
    assert.deepEqual(naoReprovados([
      'BEGIN', 'begin;', 'BEGIN WORK;', 'BEGIN TRANSACTION;', 'BEGIN ISOLATION LEVEL SERIALIZABLE;', 'BEGIN READ ONLY;',
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY, DEFERRABLE;', 'BEGIN/* c */WORK;', 'BEGIN -- c\nWORK;',
      'SELECT 1; BEGIN WORK', 'SELECT 1;\n\n  begin\n  transaction', 'START TRANSACTION;', 'START TRANSACTION ISOLATION LEVEL SERIALIZABLE;',
      'start\n transaction read only', 'START/**/TRANSACTION', 'SELECT 1; START TRANSACTION READ WRITE, NOT DEFERRABLE',
    ]), []);
  });

  test('decisão 3: variantes de COMMIT e END, com argumentos e sem ponto e vírgula final', () => {
    assert.deepEqual(naoReprovados([
      'COMMIT', 'COMMIT;', 'commit work;', 'COMMIT TRANSACTION;', 'COMMIT AND CHAIN;', 'COMMIT AND NO CHAIN;', 'COMMIT WORK AND CHAIN',
      "COMMIT PREPARED 'x';", 'SELECT 1;COMMIT/* c */WORK;', 'END', 'END;', 'end work;', 'END TRANSACTION;', 'END AND CHAIN;', 'END AND NO CHAIN',
      'SELECT 1;\nEND -- c\n;', 'SELECT 1; END WORK',
    ]), []);
  });

  test('decisão 3: variantes de ROLLBACK, ABORT e PREPARE TRANSACTION', () => {
    assert.deepEqual(naoReprovados([
      'ROLLBACK', 'ROLLBACK;', 'rollback work;', 'ROLLBACK TRANSACTION;', 'ROLLBACK AND CHAIN;', 'ROLLBACK AND NO CHAIN', "ROLLBACK PREPARED 'x';",
      'ABORT', 'ABORT;', 'abort work;', 'ABORT TRANSACTION;', 'ABORT AND CHAIN', 'SELECT 1; ABORT WORK',
      "PREPARE TRANSACTION 'x';", 'prepare\ttransaction $$x$$', "SELECT 1;\nPREPARE/* c */TRANSACTION 'x'",
    ]), []);
  });

  test('decisão 2: SAVEPOINT, ROLLBACK TO SAVEPOINT e RELEASE SAVEPOINT são reprovados', () => {
    assert.deepEqual(naoReprovados([
      'SAVEPOINT s;', 'savepoint s', 'SELECT 1; SAVEPOINT ponto;', 'ROLLBACK TO SAVEPOINT s;', 'ROLLBACK TO s;', 'ROLLBACK WORK TO SAVEPOINT s',
      'ROLLBACK TRANSACTION TO s;', 'RELEASE SAVEPOINT s;', 'RELEASE s;', 'release savepoint s',
    ]), []);
  });

  test('decisão 1: CALL é reprovado preventivamente', () => {
    assert.deepEqual(naoReprovados(['CALL p();', 'call esquema.p(1, $$a$$);', 'SELECT 1; CALL p()', 'CALL\n  p ( )', 'CALL/* c */p();']), []);
  });

  test('decisão 4: REINDEX DATABASE e REINDEX SYSTEM, inclusive com lista de opções', () => {
    assert.deepEqual(naoReprovados([
      'REINDEX DATABASE x;', 'reindex system x;', 'REINDEX DATABASE;', 'REINDEX SYSTEM', 'REINDEX (VERBOSE) DATABASE x;', 'REINDEX (VERBOSE, TABLESPACE ts) SYSTEM x;',
      'REINDEX (TABLESPACE "a)b;c") DATABASE x;', 'REINDEX\n  DATABASE\n  x', 'SELECT 1; REINDEX/* c */SYSTEM x',
    ]), []);
    assert.deepEqual(naoAceitos(['REINDEX TABLE t;', 'REINDEX INDEX i;', 'REINDEX (VERBOSE) TABLE t;']), []);
  });

  test('decisão 4: criação, alteração e exclusão de subscriptions', () => {
    assert.deepEqual(naoReprovados([
      'CREATE SUBSCRIPTION s CONNECTION $$x$$ PUBLICATION p;', "create subscription s connection 'host=x' publication p with (connect = false);",
      'ALTER SUBSCRIPTION s REFRESH PUBLICATION;', 'ALTER SUBSCRIPTION s DISABLE;', 'ALTER SUBSCRIPTION s SET (slot_name = NONE);',
      'DROP SUBSCRIPTION s;', 'DROP SUBSCRIPTION IF EXISTS s;', 'SELECT 1; drop\n subscription s', 'ALTER/* c */SUBSCRIPTION s ENABLE',
    ]), []);
    assert.deepEqual(naoAceitos(['CREATE PUBLICATION p FOR ALL TABLES;']), []);
  });

  test('decisão 5: comentários, literais, identificadores e corpos de função continuam preservados', () => {
    assert.deepEqual(naoAceitos([
      'DO $$ BEGIN PERFORM 1; END $$;',
      'DO $corpo$ BEGIN IF true THEN PERFORM 1; END IF; END; $corpo$;',
      "CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF TG_OP = 'INSERT' THEN RETURN NEW; END IF; RETURN NULL; END; $f$;",
      "CREATE FUNCTION g() RETURNS void AS 'BEGIN PERFORM 1; END;' LANGUAGE plpgsql;",
      'CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN COMMIT; END $$;',
      'SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t;',
      'UPDATE t SET x = CASE WHEN a THEN 1 END; SELECT 1;',
      '-- COMMIT;\n/* END; ROLLBACK; CALL p(); */ SELECT 1;',
      "INSERT INTO t VALUES ('; COMMIT; '), ('END;'), ('CALL p();'), ($$; ROLLBACK; SAVEPOINT s;$$);",
      'CREATE TABLE "END" (id int); INSERT INTO "COMMIT" VALUES (1); SELECT * FROM "CALL";',
      'CREATE TABLE commits (id int); CREATE INDEX end_idx ON commits (id); SELECT begin_at, call_count, release, savepoint_id FROM t;',
      'ALTER TABLE t ADD COLUMN release text, ADD COLUMN "start" int;',
      'CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();',
      'CREATE TRIGGER trg2 BEFORE INSERT ON t FOR EACH ROW EXECUTE PROCEDURE f();',
      'PREPARE plano AS SELECT 1; EXECUTE plano; DEALLOCATE plano;',
    ]), []);
  });

  test('decisão 6: falsos positivos conservadores documentados (BEGIN ATOMIC e palavras em literais)', () => {
    assert.deepEqual(naoReprovados([
      'CREATE FUNCTION soma(a int, b int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT a + b; END;',
      'CREATE PROCEDURE q() LANGUAGE sql BEGIN ATOMIC INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); END;',
      "COMMENT ON TABLE t IS 'use DROP SUBSCRIPTION s antes';",
      "COMMENT ON TABLE t IS 'rodar REINDEX DATABASE no fim de semana';",
      'PREPARE transaction AS SELECT 1;',
    ]), []);
  });

  test('o verificador reprova migrations pendentes com as formas que antes escapavam', () => {
    for (const sql of ['CREATE TABLE z (id int);\nCOMMIT WORK;', 'SELECT 1;\nEND;', 'CALL p();', 'SAVEPOINT s;', 'REINDEX (VERBOSE) DATABASE x;', 'ALTER SUBSCRIPTION s DISABLE;']) {
      const novo = { ...SQL, '002_dois.sql': sql };
      const release = cenario().release;
      release.backend.migrations = Object.keys(novo).map((n) => ({ nome: n, sha256: sha(novo[n]) }));
      const l = V.verificar(cenario({ release, sqlPendentes: novo }));
      assert.equal(l.resultado, 'REPROVADO', sql);
      assert.ok(codigos(l).includes('SQL_NAO_TRANSACIONAL'), `${sql}: ${codigos(l)}`);
    }
  });

  test('as migrations existentes: todas OK, nenhuma SQL_MALFORMADO nem SQL_NAO_TRANSACIONAL', () => {
    const dir = path.join(RAIZ, 'backend/migrations');
    const todas = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const contagem = {};
    for (const f of todas) { const c = V.classificarSql(fs.readFileSync(path.join(dir, f), 'utf8')); contagem[c] = (contagem[c] || 0) + 1; }
    assert.ok(todas.length >= 97, `esperadas ao menos 97 migrations, achadas ${todas.length}`);
    assert.deepEqual(contagem, { OK: todas.length });
  });
});

describe('rodada consolidada: fidelidade ao lexer do PostgreSQL e ao recorte do executor (A a E)', () => {
  const NT = 'SQL_NAO_TRANSACIONAL';
  const RECORTAVEL = 'SQL_RECORTAVEL';
  const marca = (n) => 'a'.repeat(n);
  const divergentes = (casos) => casos.map(([sql, esperado]) => [sql.length > 120 ? `${sql.slice(0, 60)}…(${sql.length})` : sql, V.classificarSql(sql), esperado]).filter(([, obtido, esperado]) => obtido !== esperado);

  test('A: o comentário de linha termina em \\n ou em \\r, como no PostgreSQL', () => {
    assert.deepEqual(divergentes([
      ['SELECT 1; -- nota\rCOMMIT;\nSELECT 2;', NT],
      ['CREATE TABLE t (a int); -- x\rEND;\nCREATE TABLE u (a int);', NT],
      ['-- só comentário\rROLLBACK', NT],
      ['SELECT 1; -- nota\r\nCOMMIT;\r\n', NT],
      ['SELECT 1; -- COMMIT;\rSELECT 2; -- END;\r\nSELECT 3; -- ROLLBACK;\n', 'OK'],
      ['SELECT 1; -- CONCURRENTLY\rSELECT 2;', 'OK'],
    ]), []);
  });

  test('B: a continuação de um literal em outra linha mantém o modo do literal (E com escapes)', () => {
    assert.deepEqual(divergentes([
      ["SELECT E'a'\n'b\\''; COMMIT; SELECT 'x'; -- '", NT],
      ["SELECT E'a'\r\n  'b\\''; END; SELECT 'x'; -- '", NT],
      ["SELECT E'a' \t\n -- nota\n 'b\\''; ROLLBACK; SELECT 'x'; -- '", NT],
      // Continuações legítimas: o texto depois da quebra de linha é parte do mesmo literal, no mesmo modo.
      ["SELECT 'a'\n'b; COMMIT; c';", 'OK'],
      ["SELECT E'a\\'b'\n'; COMMIT; ';", 'OK'],
      ["SELECT E'a'\n'b\\'; COMMIT; c';", 'OK'],
      ["SELECT E'x\\\\'; COMMIT;", NT],
    ]), []);
  });

  test('C: a marca de cifrão não tem limite de comprimento', () => {
    for (const n of [78, 79, 100, 5000]) {
      const m = marca(n);
      assert.deepEqual(divergentes([
        [`SELECT $${m}$ ' $${m}$; COMMIT; SELECT ' '; -- '`, NT],
        [`SELECT $${m}$ ; COMMIT; $${m}$;`, 'OK'],
        [`DO $${m}$ BEGIN PERFORM 1; END $${m}$;`, 'OK'],
        [`SELECT $${m}$ sem fechamento; COMMIT;`, 'SQL_MALFORMADO'],
      ]), [], `marca de ${n} caracteres`);
    }
  });

  test('C: entradas grandes e malformadas são classificadas de forma conservadora e em tempo limitado', () => {
    const inicio = Date.now();
    const casos = [
      [`$${marca(200000)}`, 'OK'],
      [`SELECT $${marca(200000)}$ x`, 'SQL_MALFORMADO'],
      [`${'$a '.repeat(100000)}; COMMIT`, NT],
      [`${'$$x$$ '.repeat(50000)}; COMMIT`, NT],
      [`SELECT '${"''".repeat(100000)}`, 'SQL_MALFORMADO'],
      [`/* ${'/* '.repeat(50000)}`, 'SQL_MALFORMADO'],
      [`SELECT 'a'${'\n  '.repeat(50000)}; COMMIT`, NT],
      [`SELECT "a${'""'.repeat(100000)}`, 'SQL_MALFORMADO'],
      ["SELECT E'a\\", 'SQL_MALFORMADO'],
      ["SELECT 'a'\n", 'OK'],
      ["SELECT 'a'\n-- fim", 'OK'],
    ];
    assert.deepEqual(divergentes(casos), []);
    assert.ok(Date.now() - inicio < 10000, `classificação demorou ${Date.now() - inicio} ms`);
  });

  test('D: arquivo que o executor recortaria por marcador de seção é reprovado; comentário comum não', () => {
    assert.deepEqual(divergentes([
      ["SELECT '\n-- up migration\nSELECT 1 AS x, ' , '; COMMIT; SELECT ', ' || ';\n-- '", RECORTAVEL],
      ['-- Up Migration\nCREATE TABLE t (a int);\n-- Down Migration\nDROP TABLE t;', RECORTAVEL],
      ['CREATE TABLE t (a int);\n  --- DOWN   MIGRATION\nDROP TABLE t;', RECORTAVEL],
      ['CREATE TABLE t (a int);\r--\tup\tmigration\rSELECT 1;', RECORTAVEL],
      ['/*\n-- up migration\n*/ SELECT 1;', RECORTAVEL],
      ['-- migration up: cria a tabela\nCREATE TABLE t (a int);', 'OK'],
      ['-- Sobe a migration de dados\nCREATE TABLE t (a int); -- up migration no fim da linha não é marcador', 'OK'],
      ['-- setup migration\n-- down-migration\n-- upmigration\nSELECT 1;', 'OK'],
      ["SELECT 'up migration'; -- nota comum", 'OK'],
    ]), []);
  });

  test('D: o critério é exatamente o do node-pg-migrate 9.0.0 (mesma expressão, mesmo recorte)', () => {
    const marcador = (direcao) => new RegExp(`^\\s*--[\\s-]*${direcao}\\s+migration`, 'im');
    const recortaria = (sql) => sql.search(marcador('up')) >= 0 || sql.search(marcador('down')) >= 0;
    for (const sql of ['-- up migration\nSELECT 1;', 'SELECT 1;\n-- down migration\n', ' \n\t-- - - Up\n\nMigration', 'SELECT 1; -- up migration', '--up migration', 'x -- down migration']) {
      assert.equal(V.classificarSql(sql) === RECORTAVEL, recortaria(sql), JSON.stringify(sql));
    }
  });

  test('E: REINDEX SCHEMA é reprovado, inclusive com lista de opções', () => {
    assert.deepEqual(divergentes([
      ['REINDEX SCHEMA s;', NT], ['reindex (verbose) schema s', NT], ['SELECT 1; REINDEX/* c */SCHEMA public;', NT],
      ['REINDEX TABLE t;', 'OK'], ['CREATE SCHEMA s; REINDEX INDEX s.i;', 'OK'],
    ]), []);
  });

  test('o verificador reprova as classes A a E com o código de problema correspondente', () => {
    const exemplos = [
      ['SELECT 1; -- nota\rCOMMIT;\nSELECT 2;', 'SQL_NAO_TRANSACIONAL'],
      ["SELECT E'a'\n'b\\''; COMMIT; SELECT 'x'; -- '", 'SQL_NAO_TRANSACIONAL'],
      [`SELECT $${marca(100)}$ ' $${marca(100)}$; COMMIT; SELECT ' '; -- '`, 'SQL_NAO_TRANSACIONAL'],
      ["SELECT '\n-- up migration\nSELECT 1 AS x, ' , '; COMMIT; SELECT ', ' || ';\n-- '", 'SQL_RECORTAVEL'],
      ['REINDEX SCHEMA s;', 'SQL_NAO_TRANSACIONAL'],
    ];
    for (const [sql, codigo] of exemplos) {
      const novo = { ...SQL, '002_dois.sql': sql };
      const release = cenario().release;
      release.backend.migrations = Object.keys(novo).map((n) => ({ nome: n, sha256: sha(novo[n]) }));
      const l = V.verificar(cenario({ release, sqlPendentes: novo }));
      assert.equal(l.resultado, 'REPROVADO', codigo);
      assert.ok(codigos(l).includes(codigo), `${codigo}: ${codigos(l)}`);
    }
  });

  test('identificadores e marcas não ASCII continuam reconhecidos; o fonte não tem o caractere U+FFFF literal', () => {
    const extremos = [String.fromCharCode(0x80), 'é', String.fromCharCode(0xffff)];
    for (const ch of extremos) {
      assert.equal(V.classificarSql(`SELECT a${ch}$$ FROM t; COMMIT;`), NT, `cifrão depois de identificador não ASCII (${ch.charCodeAt(0)}) não abre corpo`);
      assert.equal(V.classificarSql(`SELECT a${ch}$$ FROM t; SELECT 1;`), 'OK', `identificador não ASCII com cifrão (${ch.charCodeAt(0)})`);
      assert.equal(V.classificarSql(`SELECT $${ch}$ ; COMMIT; $${ch}$;`), 'OK', `marca não ASCII (${ch.charCodeAt(0)})`);
    }
    assert.equal(fs.readFileSync(ARQ, 'utf8').includes(String.fromCharCode(0xffff)), false);
  });
});

describe('o verificador não opera: só lê e diagnostica', () => {
  const fonte = fs.readFileSync(ARQ, 'utf8');
  test('não importa processos, rede, banco nem o executor de migrations', () => {
    assert.doesNotMatch(fonte, /child_process|node:(net|http|https|tls|dgram|worker_threads)|require\(['"](pg|node-pg-migrate)['"]\)|migrate-cli|scripts\/migrate/);
  });
  test('não escreve em disco e não executa nada', () => {
    assert.doesNotMatch(fonte, /writeFile|appendFile|mkdir|rmSync|unlink|rename|spawn|exec\(|execFile|eval\(|new Function/);
  });
});

describe('linha de comando', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-pre-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  function gravar(c) {
    const f = (n, o) => { fs.writeFileSync(path.join(dir, n), JSON.stringify(o)); return path.join(dir, n); };
    fs.mkdirSync(path.join(dir, 'migrations'));
    for (const [n, t] of Object.entries(c.sqlPendentes)) fs.writeFileSync(path.join(dir, 'migrations', n), t);
    const arquivoRelease = f('release.json', c.release);
    const hashReal = sha(fs.readFileSync(arquivoRelease));
    const args = ['--release', arquivoRelease, '--release-sha256', c.hashInformado || hashReal, '--estado', f('estado.json', c.estado), '--migrations', path.join(dir, 'migrations')];
    if (c.backup) args.push('--backup', f('backup.json', c.backup));
    if (c.restauracao) args.push('--restauracao', f('restauracao.json', c.restauracao));
    return args;
  }
  const captura = () => { const s = { out: '', err: '' }; return { s, io: { saida: (t) => { s.out += t; }, erro: (t) => { s.err += t; }, agora: () => AGORA } }; };

  test('aprovado: código 0 e laudo selado na saída', () => {
    const { s, io } = captura();
    const args = gravar(cenario());
    const antes = JSON.stringify(fs.readdirSync(dir).sort());
    assert.equal(V.principal(args, io), 0);
    const laudo = JSON.parse(s.out);
    assert.equal(laudo.resultado, 'APROVADO');
    assert.equal(V.selo(laudo), laudo.laudoSha256);
    assert.equal(JSON.stringify(fs.readdirSync(dir).sort()), antes, 'o verificador não cria arquivos');
  });
  test('reprovado: código 2, diagnóstico legível e nenhuma ação corretiva', () => {
    const { s, io } = captura();
    const args = gravar(cenario({ restauracao: undefined }));
    const antes = JSON.stringify(fs.readdirSync(dir).sort());
    assert.equal(V.principal(args, io), 2);
    assert.match(s.err, /REPROVADO/);
    assert.match(s.err, /RESTAURACAO_AUSENTE/);
    assert.match(s.err, /nenhuma restauração foi executada/i);
    assert.equal(JSON.stringify(fs.readdirSync(dir).sort()), antes);
  });
  test('hash informado diferente do arquivo release.json: reprovado', () => {
    const { s, io } = captura();
    assert.equal(V.principal(gravar(cenario({ hashInformado: 'e'.repeat(64) })), io), 2);
    assert.match(s.err, /RELEASE_INVALIDO/);
  });
  test('uso incorreto: código 64; arquivo ilegível vira reprovação, não exceção', () => {
    const { io } = captura();
    assert.equal(V.principal([], io), 64);
    const { s, io: io2 } = captura();
    assert.equal(V.principal(['--release', path.join(dir, 'nao-existe.json'), '--release-sha256', RELEASE_SHA, '--estado', path.join(dir, 'x.json'), '--migrations', dir], io2), 2);
    assert.match(s.err, /REPROVADO/);
  });
});
