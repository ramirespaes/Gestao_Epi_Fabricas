'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 026 — chk_usuarios_credencial_por_modelo (Autenticação Global,
 * correção da Subetapa 1, 23/09/2026). PostgreSQL real, schema temporário
 * exclusivo por teste. Nenhuma migration histórica (000-025, já registrada
 * no manifesto de checksums) é tocada.
 *
 * O QUE ESTA MIGRATION FECHA: a 025 tornou usuarios.email e
 * usuarios.senha_hash opcionais, para as contas do modelo novo
 * (identidade_id preenchido). Sem esta CHECK, nada impedia uma conta do
 * modelo ANTERIOR (identidade_id NULO) de nascer sem NENHUMA credencial —
 * um usuário inautenticável por qualquer via, criado em silêncio.
 */

const VIOLACAO_CHECK = '23514';

const MIGRATIONS_ATE_025 = [
  '000', '001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011',
  '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024', '025',
];
const MIGRATIONS_ATE_026 = [...MIGRATIONS_ATE_025, '026'];

async function inserirIdentidade(cliente, email, senhaHash = 'hash-ficticio-de-teste') {
  const { rows } = await cliente.query(
    'INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id',
    [email, senhaHash],
  );
  return rows[0].id;
}

async function inserirUsuario(cliente, { empresaId, nome = 'Fulano', email, senhaHash, perfil = 'USUARIO', identidadeId = null }) {
  try {
    const { rows } = await cliente.query(
      `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [empresaId, nome, email ?? null, senhaHash ?? null, perfil, identidadeId],
    );
    return { ok: true, id: rows[0].id };
  } catch (erro) {
    return { ok: false, code: erro.code };
  }
}

describe('estado anterior: migrations 000-025 (documenta a lacuna que a 026 fecha)', () => {
  let contexto;
  let empresaId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_ATE_025);
    assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa A'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id FROM empresas LIMIT 1');
    empresaId = rows[0].id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('a CHECK ainda não existe', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = (quote_ident($1) || '.usuarios')::regclass AND conname = 'chk_usuarios_credencial_por_modelo'",
      [contexto.schema],
    );
    assert.equal(rows.length, 0);
  });

  test('sem a 026, uma conta sem identidade e sem NENHUMA credencial é aceita — a lacuna real', async () => {
    const r = await inserirUsuario(contexto.cliente, { empresaId, email: null, senhaHash: null, identidadeId: null });
    assert.equal(r.ok, true, 'este é exatamente o estado indevido que a migration 026 passa a recusar');
  });
});

describe('estado corrigido: migrations 000-026 — chk_usuarios_credencial_por_modelo', () => {
  let contexto;
  let empresaId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_ATE_026);
    assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa A'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id FROM empresas LIMIT 1');
    empresaId = rows[0].id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('identidade_id NULO e email/senha_hash TAMBÉM nulos: recusado (conta sem nenhuma credencial)', async () => {
    const r = await inserirUsuario(contexto.cliente, { empresaId, email: null, senhaHash: null, identidadeId: null });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_CHECK);
  });

  test('identidade_id NULO com só e-mail preenchido (senha_hash nulo): recusado — meio-migrada não é um contrato válido', async () => {
    const r = await inserirUsuario(contexto.cliente, { empresaId, email: 'so-email@safework.com.br', senhaHash: null, identidadeId: null });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_CHECK);
  });

  test('identidade_id NULO com só senha_hash preenchida (email nulo): recusado — mesma razão, na outra direção', async () => {
    const r = await inserirUsuario(contexto.cliente, { empresaId, email: null, senhaHash: 'hash-orfao', identidadeId: null });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_CHECK);
  });

  test('identidade_id NULO com as duas credenciais preenchidas continua sendo o único caminho válido do modelo antigo', async () => {
    const r = await inserirUsuario(contexto.cliente, { empresaId, email: 'legado-completo@safework.com.br', senhaHash: 'hash-legado-completo', identidadeId: null });
    assert.equal(r.ok, true);
  });

  test('identidade_id preenchido continua aceitando email/senha_hash nulos — a CHECK não reintroduz obrigatoriedade para o modelo novo', async () => {
    const identidadeId = await inserirIdentidade(contexto.cliente, 'check-modelo-novo@safework.com.br');
    const r = await inserirUsuario(contexto.cliente, { empresaId, email: null, senhaHash: null, identidadeId });
    assert.equal(r.ok, true);
  });

  test('identidade_id preenchido com email/senha_hash TAMBÉM preenchidos continua aceito (a CHECK não proíbe isso, só exige o mínimo)', async () => {
    const identidadeId = await inserirIdentidade(contexto.cliente, 'ambos-preenchidos@safework.com.br');
    const r = await inserirUsuario(contexto.cliente, { empresaId, email: 'copia@safework.com.br', senhaHash: 'hash-copia', identidadeId });
    assert.equal(r.ok, true);
  });

  test('a constraint existe com o nome esperado e a definição correta', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conrelid = (quote_ident($1) || '.usuarios')::regclass AND conname = 'chk_usuarios_credencial_por_modelo'",
      [contexto.schema],
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].definicao, /identidade_id IS NOT NULL/);
    assert.match(rows[0].definicao, /email IS NOT NULL/);
    assert.match(rows[0].definicao, /senha_hash IS NOT NULL/);
  });
});

describe('transição de um banco já populado (contas 025 sobrevivem à 026)', () => {
  test('conta legada completa e conta do modelo novo, ambas criadas sob a 025, sobrevivem à aplicação da 026', async () => {
    const contexto = await abrirSchemaTemporario(MIGRATIONS_ATE_025);
    try {
      assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa A'), 'ok');
      const { rows: empresas } = await contexto.cliente.query('SELECT id FROM empresas LIMIT 1');
      const empresaId = empresas[0].id;

      const legada = await inserirUsuario(contexto.cliente, { empresaId, email: 'sobrevive-legado@safework.com.br', senhaHash: 'hash-sobrevive', identidadeId: null });
      assert.equal(legada.ok, true);

      const identidadeId = await inserirIdentidade(contexto.cliente, 'sobrevive-novo@safework.com.br');
      const nova = await inserirUsuario(contexto.cliente, { empresaId, email: null, senhaHash: null, identidadeId });
      assert.equal(nova.ok, true);

      // Falha aqui aborta o teste com o erro real do PostgreSQL: executar
      // sem lançar já é a confirmação de que a 026 roda sobre dados vivos
      // que já satisfazem a regra (ver comentário da própria migration).
      await contexto.cliente.query(conteudoDaMigration('026'));

      const { rows } = await contexto.cliente.query(
        'SELECT id, email, senha_hash, identidade_id FROM usuarios WHERE id = ANY($1) ORDER BY id',
        [[legada.id, nova.id]],
      );
      assert.equal(rows.length, 2, 'as duas linhas continuam existindo depois da migration');
      const porId = Object.fromEntries(rows.map((l) => [l.id, l]));
      assert.deepEqual(porId[legada.id], { id: legada.id, email: 'sobrevive-legado@safework.com.br', senha_hash: 'hash-sobrevive', identidade_id: null });
      assert.equal(porId[nova.id].identidade_id, identidadeId);
      assert.equal(porId[nova.id].email, null);
    } finally {
      await contexto.encerrar();
    }
  });
});

describe('estrutura declarada na migration 026 (sem banco)', () => {
  test('a migration 026 existe e declara exatamente a CHECK esperada, sem tocar a 025', () => {
    assert.equal(migrationExiste('026'), true, 'migrations/026_*.sql deve existir');
    const sql = conteudoDaMigration('026');
    assert.match(sql, /ALTER TABLE usuarios ADD CONSTRAINT chk_usuarios_credencial_por_modelo/i);
    assert.match(sql, /CHECK \(identidade_id IS NOT NULL OR \(email IS NOT NULL AND senha_hash IS NOT NULL\)\)/i);
    assert.doesNotMatch(sql, /CREATE TABLE|DROP CONSTRAINT|UPDATE usuarios/i, 'a 026 só adiciona a CHECK — nada mais, e nada de migração automática de dados');

    const sql025 = conteudoDaMigration('025');
    assert.doesNotMatch(sql025, /chk_usuarios_credencial_por_modelo/i, 'a 025 permanece exatamente como foi registrada no manifesto — a correção mora só na 026');
  });
});
