'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 028 — sessoes_plataforma (Autenticação Global — Pacote 2).
 * PostgreSQL real, schema temporário exclusivo. Mesmo contrato de segurança
 * de sessoes (013): só o hash do token é persistido, nunca o token em
 * claro; aqui SEM empresa_id/usuario_id, porque uma sessão de plataforma não
 * carrega contexto empresarial.
 */

const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const VIOLACAO_FK = '23503';
const HASH_VALIDO = 'a'.repeat(64);

async function inserirAdministrador(cliente, email = 'admin@safework.com.br') {
  const { rows } = await cliente.query(
    'INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id',
    [email, 'hash-ficticio'],
  );
  return rows[0].id;
}

async function inserirSessao(cliente, { administradorId, tokenHash = HASH_VALIDO, expiraEm = "now() + interval '1 hour'" }) {
  try {
    const { rows } = await cliente.query(
      `INSERT INTO sessoes_plataforma (administrador_id, token_hash, expira_em)
       VALUES ($1, $2, ${expiraEm}) RETURNING id`,
      [administradorId, tokenHash],
    );
    return { ok: true, id: rows[0].id };
  } catch (erro) {
    return { ok: false, code: erro.code };
  }
}

describe('migration 028 — sessoes_plataforma', () => {
  let contexto;
  let administradorId;

  before(async () => {
    contexto = await abrirSchemaTemporario(['000', '027', '028']);
    administradorId = await inserirAdministrador(contexto.cliente);
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cria sessão com sucesso', async () => {
    const r = await inserirSessao(contexto.cliente, { administradorId, tokenHash: 'b'.repeat(64) });
    assert.equal(r.ok, true);
  });

  test('token_hash precisa ter exatamente o formato SHA-256 hex minúsculo', async () => {
    // CHAR(64) é comprimento fixo: um valor mais curto que 64 é completado
    // com espaços à direita PELO PRÓPRIO TIPO antes da CHECK rodar — por
    // isso 'abc' e 'a'.repeat(63) ainda caem na CHECK (o espaço de
    // preenchimento não é hexadecimal). Só o valor MAIOR que 64 estoura a
    // capacidade do próprio tipo, num erro anterior à CHECK (22001).
    for (const ruim of ['abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
      const r = await inserirSessao(contexto.cliente, { administradorId, tokenHash: ruim });
      assert.equal(r.ok, false, ruim);
      assert.equal(r.code, VIOLACAO_CHECK, ruim);
    }
    const grandeDemais = await inserirSessao(contexto.cliente, { administradorId, tokenHash: 'a'.repeat(65) });
    assert.equal(grandeDemais.ok, false);
    assert.equal(grandeDemais.code, '22001', 'valor maior que CHAR(64) estoura o tipo antes da CHECK');
  });

  test('token_hash é único: duas sessões não podem compartilhar o mesmo hash', async () => {
    const hash = 'c'.repeat(64);
    assert.equal((await inserirSessao(contexto.cliente, { administradorId, tokenHash: hash })).ok, true);
    const repetida = await inserirSessao(contexto.cliente, { administradorId, tokenHash: hash });
    assert.equal(repetida.ok, false);
    assert.equal(repetida.code, VIOLACAO_UNIQUE);
  });

  test('administrador_id inexistente é recusado pela FK', async () => {
    const r = await inserirSessao(contexto.cliente, { administradorId: 999999, tokenHash: 'd'.repeat(64) });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_FK);
  });

  test('excluir o administrador remove suas sessões em cascata (ON DELETE CASCADE)', async () => {
    const outroAdmin = await inserirAdministrador(contexto.cliente, 'cascata@safework.com.br');
    const sessao = await inserirSessao(contexto.cliente, { administradorId: outroAdmin, tokenHash: 'e'.repeat(64) });
    assert.equal(sessao.ok, true);

    await contexto.cliente.query('DELETE FROM administradores_plataforma WHERE id = $1', [outroAdmin]);

    const { rows } = await contexto.cliente.query('SELECT id FROM sessoes_plataforma WHERE id = $1', [sessao.id]);
    assert.equal(rows.length, 0, 'a sessão deve ter sido removida junto do administrador');
  });

  test('nenhuma coluna empresa_id/usuario_id: sessão de plataforma não carrega contexto empresarial', async () => {
    const { rows } = await contexto.cliente.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'sessoes_plataforma'
          AND column_name IN ('empresa_id', 'usuario_id')`,
      [contexto.schema],
    );
    assert.equal(rows.length, 0);
  });

  test('índice parcial por administrador_id nas sessões não revogadas existe', async () => {
    const { rows } = await contexto.cliente.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'sessoes_plataforma'
         AND indexname = 'idx_sessoes_plataforma_administrador_id_nao_revogadas'`,
      [contexto.schema],
    );
    assert.equal(rows.length, 1);
  });
});

describe('estrutura declarada na migration 028 (sem banco)', () => {
  test('a migration 028 existe e declara exatamente o que foi pedido', () => {
    assert.equal(migrationExiste('028'), true, 'migrations/028_*.sql deve existir');
    const sql = conteudoDaMigration('028');
    assert.match(sql, /CREATE TABLE sessoes_plataforma/i);
    assert.match(sql, /REFERENCES administradores_plataforma\(id\) ON DELETE CASCADE/i);
    assert.match(sql, /UNIQUE \(token_hash\)/i);
    assert.match(sql, /CHECK \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  });
});
