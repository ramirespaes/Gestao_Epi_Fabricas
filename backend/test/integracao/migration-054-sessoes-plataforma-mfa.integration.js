'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, conteudoDaMigration, migrationExiste } = require('./helpers/schema-temporario');

/**
 * Migration 054 — colunas de MFA em sessoes_plataforma. PostgreSQL real,
 * schema temporário. Monto até a 031, gravo sessões no formato antigo
 * (ativa, revogada e vencida) e só então aplico a 054: as linhas antigas
 * continuam válidas e o código antigo continua criando sessão sem MFA. O
 * CHECK que exige MFA em sessão ativa NÃO existe aqui.
 */

const ATE_A_031 = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '031'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const VIOLACAO_CHECK = '23514';
const hashAleatorio = () => crypto.randomBytes(32).toString('hex');

describe('migration 054 — sessoes_plataforma com mfa_verificado_em e mfa_metodo', () => {
  let contexto;
  let admin;
  const historicas = [];

  const q = (sql, params) => contexto.cliente.query(sql, params);

  async function criarSessao({ criadoEm = new Date(), expiraEm = new Date(Date.now() + 8 * 3600e3), verificadoEm = null, metodo = null } = {}) {
    try {
      const { rows } = await q(
        `INSERT INTO sessoes_plataforma (administrador_id, token_hash, criado_em, expira_em, mfa_verificado_em, mfa_metodo)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [admin, hashAleatorio(), criadoEm, expiraEm, verificadoEm, metodo],
      );
      return { ok: true, id: rows[0].id };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint };
    }
  }

  before(async () => {
    contexto = await abrirSchemaTemporario(ATE_A_031);
    admin = (await q("INSERT INTO administradores_plataforma (email, senha_hash) VALUES ('admin@safework.com.br', 'h') RETURNING id")).rows[0].id;
    const antigas = [
      ["now() + interval '8 hours'", 'NULL', 'NULL'],
      ["now() + interval '8 hours'", 'now()', "'LOGOUT'"],
      ["now() - interval '1 hour'", 'NULL', 'NULL'],
    ];
    for (const [expira, revogada, motivo] of antigas) {
      const { rows } = await q(
        `INSERT INTO sessoes_plataforma (administrador_id, token_hash, criado_em, expira_em, revogada_em, motivo_revogacao)
         VALUES ($1, $2, now() - interval '2 hours', ${expira}, ${revogada}, ${motivo}) RETURNING id, xmin::text AS xmin`,
        [admin, hashAleatorio()],
      );
      historicas.push(rows[0]);
    }
    await q(conteudoDaMigration('054'));
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('sessões anteriores continuam válidas, intactas e sem MFA registrado', async () => {
    const { rows } = await q(
      'SELECT id, mfa_verificado_em, mfa_metodo, xmin::text AS xmin FROM sessoes_plataforma WHERE id = ANY($1) ORDER BY id',
      [historicas.map((h) => h.id)],
    );
    assert.equal(rows.length, 3);
    for (const [i, linha] of rows.entries()) {
      assert.equal(linha.mfa_verificado_em, null);
      assert.equal(linha.mfa_metodo, null);
      assert.equal(linha.xmin, historicas[i].xmin, 'a 054 não reescreve linha alguma');
    }
  });

  test('colunas novas são nulas e sem default', async () => {
    const { rows } = await q(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'sessoes_plataforma' AND column_name LIKE 'mfa_%' ORDER BY column_name`,
    );
    assert.deepEqual(rows, [
      { column_name: 'mfa_metodo', is_nullable: 'YES', column_default: null },
      { column_name: 'mfa_verificado_em', is_nullable: 'YES', column_default: null },
    ]);
  });

  test('os cinco métodos previstos são aceitos; qualquer outro, não', async () => {
    const criadoEm = new Date();
    for (const metodo of ['TOTP', 'CADASTRO', 'RECADASTRO', 'SUBSTITUICAO', 'REAUTENTICACAO']) {
      assert.equal((await criarSessao({ criadoEm, verificadoEm: criadoEm, metodo })).ok, true, metodo);
    }
    for (const metodo of ['SENHA', 'totp', 'RECUPERACAO']) {
      const r = await criarSessao({ criadoEm, verificadoEm: criadoEm, metodo });
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], metodo);
    }
  });

  test('instante e método do MFA andam juntos', async () => {
    const semMetodo = await criarSessao({ verificadoEm: new Date(Date.now() - 1000) });
    assert.deepEqual([semMetodo.ok, semMetodo.code], [false, VIOLACAO_CHECK]);
    const semInstante = await criarSessao({ metodo: 'TOTP' });
    assert.deepEqual([semInstante.ok, semInstante.code], [false, VIOLACAO_CHECK]);
  });

  test('o MFA é verificado antes (ou no instante) da criação da sessão, nunca depois', async () => {
    const criadoEm = new Date();
    const depois = await criarSessao({ criadoEm, verificadoEm: new Date(criadoEm.getTime() + 1000), metodo: 'TOTP' });
    assert.deepEqual([depois.ok, depois.code], [false, VIOLACAO_CHECK]);
    assert.equal((await criarSessao({ criadoEm, verificadoEm: new Date(criadoEm.getTime() - 1000), metodo: 'TOTP' })).ok, true);
  });

  test('ainda NÃO existe o CHECK que exige MFA em sessão ativa: o código antigo continua criando sessão', async () => {
    const r = await q(
      "INSERT INTO sessoes_plataforma (administrador_id, token_hash, expira_em) VALUES ($1, $2, now() + interval '8 hours') RETURNING id",
      [admin, hashAleatorio()],
    );
    assert.equal(r.rows.length, 1);
    const { rows } = await q(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'sessoes_plataforma'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%mfa%'
        ORDER BY conname`,
    );
    for (const { def } of rows) {
      assert.doesNotMatch(def, /revogada_em IS NOT NULL OR/i, 'o enforcement final é da 055');
    }
    assert.equal(rows.some((r) => /mfa_obrigatorio/i.test(r.conname)), false);
  });

  test('a 055 não existe neste incremento; a 054 não revoga nem atualiza sessão', () => {
    assert.equal(migrationExiste('055'), false);
    const sql = conteudoDaMigration('054').replace(/^\s*--.*$/gm, '');
    assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|INSERT)\b/im);
    assert.doesNotMatch(sql, /MFA_OBRIGATORIO/);
  });

  test('manifesto: entrada da 054 coerente com o arquivo', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivo = fs.readdirSync(DIRETORIO).find((nome) => nome.startsWith('054_') && nome.endsWith('.sql'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
    assert.equal(manifesto.migrations[arquivo], sha);
  });
});
