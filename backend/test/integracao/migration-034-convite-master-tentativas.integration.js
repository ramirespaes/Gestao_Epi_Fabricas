'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 034 — convite_master_tentativas (Pacote 3, cooldown do aceite).
 * Espelha as garantias de 015/030 para o terceiro contexto.
 */

const MIGRATIONS = ['000', '001', '002', '005', '013', '025', '027', '033', '034'];
const VIOLACAO_CHECK = '23514';
const VIOLACAO_FK = '23503';
const CHAVE = 'a'.repeat(64);

describe('migration 034 — convite_master_tentativas', () => {
  let contexto;
  let conviteId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    await inserirEmpresa(contexto.cliente, '11222333000181', 'A');
    const { rows: e } = await contexto.cliente.query('SELECT id FROM empresas LIMIT 1');
    const { rows: a } = await contexto.cliente.query("INSERT INTO administradores_plataforma (email, senha_hash) VALUES ('adm@x.com', 'h') RETURNING id");
    const { rows: c } = await contexto.cliente.query(
      "INSERT INTO convites_master (empresa_id, email_convite, token_hash, criado_por, expira_em) VALUES ($1, 'p@x.com', $2, $3, now() + interval '1 hour') RETURNING id",
      [e[0].id, 'b'.repeat(64), a[0].id],
    );
    conviteId = c[0].id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  async function inserir(d) {
    try {
      await contexto.cliente.query(
        'INSERT INTO convite_master_tentativas (chave_cooldown, convite_id, sucesso, motivo, cooldown_ate) VALUES ($1, $2, $3, $4, $5)',
        [d.chave ?? CHAVE, d.conviteId ?? null, d.sucesso, d.motivo ?? null, d.cooldownAte ?? null],
      );
      return { ok: true };
    } catch (erro) {
      return { ok: false, code: erro.code };
    }
  }

  test('falha sem convite identificado (token desconhecido) é aceita; sucesso exige convite', async () => {
    assert.equal((await inserir({ sucesso: false, motivo: 'CONVITE_INEXISTENTE' })).ok, true);
    assert.equal((await inserir({ sucesso: true, conviteId })).ok, true);
    const r = await inserir({ sucesso: true });
    assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK]);
  });

  test('coerência motivo/sucesso e cooldown, e formato da chave', async () => {
    assert.equal((await inserir({ sucesso: false })).code, VIOLACAO_CHECK);
    assert.equal((await inserir({ sucesso: true, conviteId, motivo: 'X' })).code, VIOLACAO_CHECK);
    assert.equal((await inserir({ sucesso: false, motivo: 'SENHA_INVALIDA', cooldownAte: new Date(Date.now() + 60e3) })).code, VIOLACAO_CHECK);
    assert.equal((await inserir({ sucesso: false, motivo: 'COOLDOWN_ATIVADO', cooldownAte: new Date(Date.now() + 60e3) })).ok, true);
    assert.equal((await inserir({ chave: 'curta', sucesso: false, motivo: 'X' })).ok, false);
  });

  test('convite_id inexistente é recusado; convite com tentativas não pode ser apagado (RESTRICT)', async () => {
    assert.equal((await inserir({ sucesso: false, motivo: 'X', conviteId: '999999' })).code, VIOLACAO_FK);
    const erro = await contexto.cliente.query('DELETE FROM convites_master WHERE id = $1', [conviteId]).catch((e) => e);
    assert.equal(erro.code, VIOLACAO_FK);
  });

  test('a migration 034 existe e reaproveita o contrato de 015/030', () => {
    assert.equal(migrationExiste('034'), true);
    const sql = conteudoDaMigration('034');
    assert.match(sql, /CREATE TABLE convite_master_tentativas/i);
    assert.match(sql, /REFERENCES convites_master\(id\) ON DELETE RESTRICT/i);
    assert.match(sql, /COOLDOWN_ATIVADO/);
  });
});
