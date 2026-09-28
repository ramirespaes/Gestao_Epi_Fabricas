'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 053 — liberacoes_cadastro_mfa_plataforma. PostgreSQL real,
 * schema temporário. Dependências mínimas: 000 e 027.
 */

const MIGRATIONS = ['000', '027', '053'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const VIOLACAO_CHECK = '23514';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';
const hashAleatorio = () => crypto.randomBytes(32).toString('hex');

describe('migration 053 — liberacoes_cadastro_mfa_plataforma', () => {
  let contexto;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  const novoAdministrador = async () => (await q(
    'INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id',
    [`adm-${crypto.randomBytes(4).toString('hex')}@safework.com.br`, 'hash-ficticio'],
  )).rows[0].id;

  async function inserir(d) {
    try {
      const { rows } = await q(
        `INSERT INTO liberacoes_cadastro_mfa_plataforma
           (administrador_id, codigo_hash, origem, criado_em, expira_em, consumida_em, revogada_em, motivo_revogacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [d.administradorId, d.hash ?? hashAleatorio(), d.origem ?? 'CLI_LIBERACAO', d.criadoEm ?? new Date(),
          d.expiraEm ?? new Date(Date.now() + 30 * 60e3), d.consumidaEm ?? null, d.revogadaEm ?? null, d.motivo ?? null],
      );
      return { ok: true, id: rows[0].id };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint };
    }
  }

  before(async () => { contexto = await abrirSchemaTemporario(MIGRATIONS); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('as três origens de CLI são aceitas; qualquer outra, não', async () => {
    const a = await novoAdministrador();
    for (const origem of ['CLI_LIBERACAO', 'CLI_CRIACAO', 'CLI_RESET']) {
      assert.equal((await inserir({ administradorId: a, origem, consumidaEm: new Date() })).ok, true, origem);
    }
    for (const origem of ['MANUAL', 'cli_reset', 'HTTP']) {
      const r = await inserir({ administradorId: a, origem });
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], origem);
    }
  });

  test('no máximo uma liberação aberta por administrador', async () => {
    const a = await novoAdministrador();
    assert.equal((await inserir({ administradorId: a })).ok, true);
    const segunda = await inserir({ administradorId: a });
    assert.deepEqual([segunda.ok, segunda.code, segunda.constraint], [false, VIOLACAO_UNIQUE, 'uq_liberacoes_cadastro_mfa_plataforma_aberta']);
    // Vencida mas não resolvida continua "aberta": precisa ser revogada antes.
    const b = await novoAdministrador();
    const vencida = await inserir({ administradorId: b, criadoEm: new Date(Date.now() - 60 * 60e3), expiraEm: new Date(Date.now() - 30 * 60e3) });
    assert.equal(vencida.ok, true);
    const outra = await inserir({ administradorId: b });
    assert.deepEqual([outra.ok, outra.code], [false, VIOLACAO_UNIQUE]);
    await q("UPDATE liberacoes_cadastro_mfa_plataforma SET revogada_em = now(), motivo_revogacao = 'SUBSTITUIDA' WHERE id = $1", [vencida.id]);
    assert.equal((await inserir({ administradorId: b })).ok, true);
    assert.equal((await inserir({ administradorId: await novoAdministrador() })).ok, true);
  });

  test('consumida e revogada ao mesmo tempo é impossível; revogação coerente', async () => {
    const a = await novoAdministrador();
    const casos = [
      { consumidaEm: new Date(), revogadaEm: new Date(), motivo: 'SUBSTITUIDA' },
      { revogadaEm: new Date() },
      { motivo: 'SUBSTITUIDA' },
      { revogadaEm: new Date(), motivo: 'substituida' },
    ];
    for (const caso of casos) {
      const r = await inserir({ administradorId: a, ...caso });
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(caso));
    }
  });

  test('prazo posterior à criação; hash único e hexadecimal minúsculo; administrador existente', async () => {
    const a = await novoAdministrador();
    const agora = new Date();
    const semPrazo = await inserir({ administradorId: a, criadoEm: agora, expiraEm: agora });
    assert.deepEqual([semPrazo.ok, semPrazo.code], [false, VIOLACAO_CHECK]);
    const maiusculo = await inserir({ administradorId: a, hash: hashAleatorio().toUpperCase() });
    assert.deepEqual([maiusculo.ok, maiusculo.code], [false, VIOLACAO_CHECK]);
    const hash = hashAleatorio();
    assert.equal((await inserir({ administradorId: a, hash, consumidaEm: new Date() })).ok, true);
    const dup = await inserir({ administradorId: await novoAdministrador(), hash });
    assert.deepEqual([dup.ok, dup.code], [false, VIOLACAO_UNIQUE]);
    const semAdmin = await inserir({ administradorId: 999999 });
    assert.deepEqual([semAdmin.ok, semAdmin.code], [false, VIOLACAO_FK]);
  });

  test('não existe coluna para o código em claro', async () => {
    const { rows } = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'liberacoes_cadastro_mfa_plataforma' ORDER BY ordinal_position`,
    );
    assert.deepEqual(rows.map((r) => r.column_name), [
      'id', 'administrador_id', 'codigo_hash', 'origem', 'criado_em', 'expira_em', 'consumida_em', 'revogada_em', 'motivo_revogacao',
    ]);
  });

  test('manifesto: entrada da 053 coerente com o arquivo', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivo = fs.readdirSync(DIRETORIO).find((nome) => nome.startsWith('053_') && nome.endsWith('.sql'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
    assert.equal(manifesto.migrations[arquivo], sha);
    assert.match(conteudoDaMigration('053'), /CREATE TABLE liberacoes_cadastro_mfa_plataforma/i);
  });
});
