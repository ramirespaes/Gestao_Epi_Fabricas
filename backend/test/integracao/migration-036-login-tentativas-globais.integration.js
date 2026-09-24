'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 036 — login_tentativas_globais (Pacote 4, cooldown do login
 * global). Espelha as garantias de 015/030 para o quarto contexto.
 */

const MIGRATIONS = ['000', '001', '002', '005', '025', '036'];
const VIOLACAO_CHECK = '23514';
const VIOLACAO_FK = '23503';
const CHAVE = 'a'.repeat(64);

describe('migration 036 — login_tentativas_globais', () => {
  let contexto;
  let identidadeId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    const { rows } = await contexto.cliente.query("INSERT INTO identidades (email, senha_hash) VALUES ('p@x.com', 'h') RETURNING id");
    identidadeId = rows[0].id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  async function inserir(d) {
    try {
      await contexto.cliente.query(
        'INSERT INTO login_tentativas_globais (chave_cooldown, identidade_id, sucesso, motivo, cooldown_ate) VALUES ($1, $2, $3, $4, $5)',
        [d.chave ?? CHAVE, d.identidadeId ?? null, d.sucesso, d.motivo ?? null, d.cooldownAte ?? null],
      );
      return { ok: true };
    } catch (erro) {
      return { ok: false, code: erro.code };
    }
  }

  test('falha sem identidade (e-mail desconhecido) é aceita; sucesso exige identidade', async () => {
    assert.equal((await inserir({ sucesso: false, motivo: 'IDENTIDADE_INEXISTENTE' })).ok, true);
    assert.equal((await inserir({ sucesso: true, identidadeId })).ok, true);
    const r = await inserir({ sucesso: true });
    assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK]);
  });

  test('motivo coerente com sucesso; formato do motivo e da chave; FK de identidade', async () => {
    for (const d of [
      { sucesso: true, identidadeId, motivo: 'SENHA_INVALIDA' },
      { sucesso: false },
      { sucesso: false, motivo: 'minusculo' },
      { chave: 'x'.repeat(64), sucesso: false, motivo: 'SENHA_INVALIDA' },
    ]) {
      const r = await inserir(d);
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(d));
    }
    const fk = await inserir({ sucesso: false, motivo: 'SENHA_INVALIDA', identidadeId: 999999 });
    assert.deepEqual([fk.ok, fk.code], [false, VIOLACAO_FK]);
  });

  test('cooldown_ate só com motivo COOLDOWN_ATIVADO, falha, e prazo no futuro', async () => {
    assert.equal((await inserir({ sucesso: false, motivo: 'COOLDOWN_ATIVADO', cooldownAte: new Date(Date.now() + 60_000) })).ok, true);
    for (const d of [
      { sucesso: false, motivo: 'COOLDOWN_ATIVADO' },
      { sucesso: false, motivo: 'SENHA_INVALIDA', cooldownAte: new Date(Date.now() + 60_000) },
      { sucesso: false, motivo: 'COOLDOWN_ATIVADO', cooldownAte: new Date(Date.now() - 60_000) },
    ]) {
      const r = await inserir(d);
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(d));
    }
  });

  test('identidade referenciada em tentativa não pode ser excluída (RESTRICT); índices existem', async () => {
    await assert.rejects(() => contexto.cliente.query('DELETE FROM identidades WHERE id = $1', [identidadeId]), (e) => e.code === VIOLACAO_FK);
    const { rows } = await contexto.cliente.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'login_tentativas_globais'", [contexto.schema]);
    const nomes = rows.map((r) => r.indexname);
    for (const esperado of ['idx_login_tentativas_globais_chave_criado_em', 'idx_login_tentativas_globais_chave_cooldown_ate', 'idx_login_tentativas_globais_identidade_id', 'idx_login_tentativas_globais_criado_em']) {
      assert.ok(nomes.includes(esperado), esperado);
    }
  });
});

describe('estrutura declarada na migration 036 (sem banco)', () => {
  test('existe e não tem empresa_id/usuario_id/administrador_id', () => {
    assert.equal(migrationExiste('036'), true);
    const sql = conteudoDaMigration('036').replace(/^--.*$/gm, '');
    assert.match(sql, /CREATE TABLE login_tentativas_globais/);
    assert.match(sql, /identidade_id\s+INTEGER REFERENCES identidades\(id\) ON DELETE RESTRICT/);
    assert.doesNotMatch(sql, /empresa_id|usuario_id|administrador_id/);
  });
});
