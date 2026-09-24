'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 027 — administradores_plataforma (Autenticação Global —
 * Pacote 2, "Primeiro acesso administrativo", 23/09/2026). PostgreSQL real,
 * schema temporário exclusivo, conforme o contrato da seção 11 do
 * CLAUDE.md. Nenhuma migration histórica (000-026) é tocada; nenhuma
 * aplicação ao schema `public`.
 */

const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_NOT_NULL = '23502';

async function inserirAdministrador(cliente, { email, senhaHash = 'hash-ficticio-de-teste', ativo } = {}) {
  try {
    const colunas = ['email', 'senha_hash'];
    const valores = [email, senhaHash];
    if (ativo !== undefined) {
      colunas.push('ativo');
      valores.push(ativo);
    }
    const marcadores = valores.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await cliente.query(
      `INSERT INTO administradores_plataforma (${colunas.join(', ')}) VALUES (${marcadores}) RETURNING id, ativo`,
      valores,
    );
    return { ok: true, id: rows[0].id, ativo: rows[0].ativo };
  } catch (erro) {
    return { ok: false, code: erro.code };
  }
}

describe('migration 027 — administradores_plataforma', () => {
  let contexto;

  before(async () => { contexto = await abrirSchemaTemporario(['000', '027']); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cria administrador com sucesso, ativo=true por padrão', async () => {
    const r = await inserirAdministrador(contexto.cliente, { email: 'admin1@safework.com.br' });
    assert.equal(r.ok, true);
    assert.equal(r.ativo, true, 'DEFAULT true da migration — não há caminho para nascer inativo');
  });

  test('e-mail e senha_hash são obrigatórios', async () => {
    const semEmail = await contexto.cliente.query('INSERT INTO administradores_plataforma (senha_hash) VALUES ($1)', ['h']).catch((e) => e);
    assert.equal(semEmail.code, VIOLACAO_NOT_NULL);
    const semSenha = await contexto.cliente.query('INSERT INTO administradores_plataforma (email) VALUES ($1)', ['x@safework.com.br']).catch((e) => e);
    assert.equal(semSenha.code, VIOLACAO_NOT_NULL);
  });

  test('unicidade de e-mail, sem diferenciar maiúsculas de minúsculas', async () => {
    assert.equal((await inserirAdministrador(contexto.cliente, { email: 'unico@safework.com.br' })).ok, true);
    const repetido = await inserirAdministrador(contexto.cliente, { email: 'unico@safework.com.br' });
    assert.equal(repetido.ok, false);
    assert.equal(repetido.code, VIOLACAO_UNIQUE);
    const outraCaixa = await inserirAdministrador(contexto.cliente, { email: 'UNICO@SafeWork.com.br' });
    assert.equal(outraCaixa.ok, false);
    assert.equal(outraCaixa.code, VIOLACAO_UNIQUE, 'unico@ e UNICO@ (outra caixa) contam como o mesmo e-mail');
  });

  test('é possível criar um administrador já inativo, explicitamente', async () => {
    const r = await inserirAdministrador(contexto.cliente, { email: 'inativo@safework.com.br', ativo: false });
    assert.equal(r.ok, true);
    assert.equal(r.ativo, false);
  });

  test('trigger de atualizado_em: UPDATE avança atualizado_em', async () => {
    const { id } = await inserirAdministrador(contexto.cliente, { email: 'toca@safework.com.br' });
    const antes = await contexto.cliente.query('SELECT atualizado_em FROM administradores_plataforma WHERE id = $1', [id]);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    await contexto.cliente.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [id]);
    const depois = await contexto.cliente.query('SELECT atualizado_em FROM administradores_plataforma WHERE id = $1', [id]);
    assert.ok(depois.rows[0].atualizado_em > antes.rows[0].atualizado_em);
  });

  test('nenhuma coluna empresa_id: um administrador de plataforma não pertence a nenhuma empresa', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'administradores_plataforma' AND column_name = 'empresa_id'",
      [contexto.schema],
    );
    assert.equal(rows.length, 0);
  });
});

describe('estrutura declarada na migration 027 (sem banco)', () => {
  test('a migration 027 existe e declara exatamente o que foi pedido', () => {
    assert.equal(migrationExiste('027'), true, 'migrations/027_*.sql deve existir');
    const sql = conteudoDaMigration('027');
    assert.match(sql, /CREATE TABLE administradores_plataforma/i);
    assert.match(sql, /CREATE UNIQUE INDEX uq_administradores_plataforma_email_lower[\s\S]*lower\(email\)/i);
    assert.match(sql, /EXECUTE FUNCTION set_atualizado_em\(\)/i);
    assert.doesNotMatch(sql, /REFERENCES usuarios/i, 'não reaproveita usuarios como base de administradores globais');
  });
});
