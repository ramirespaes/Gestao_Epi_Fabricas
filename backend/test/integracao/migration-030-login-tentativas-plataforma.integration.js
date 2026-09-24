'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 030 — login_tentativas_plataforma (correção final do Pacote 2,
 * item 1: cooldown persistente por identidade para o Painel Privado).
 * PostgreSQL real, schema temporário exclusivo. Espelha as garantias de
 * `login_tentativas` (migration 015, histórica, intocada).
 */

const MIGRATIONS_NECESSARIAS = ['000', '027', '030'];
const VIOLACAO_CHECK = '23514';
const VIOLACAO_NOT_NULL = '23502';
const VIOLACAO_FK = '23503';
const CHAVE = 'a'.repeat(64);

async function inserirAdministrador(cliente, email = 'admin@safework.com.br') {
  const { rows } = await cliente.query(
    'INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id',
    [email, 'hash-ficticio'],
  );
  return rows[0].id;
}

async function inserirTentativa(cliente, dados) {
  try {
    const { rows } = await cliente.query(
      `INSERT INTO login_tentativas_plataforma (chave_cooldown, administrador_id, sucesso, motivo, cooldown_ate)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [dados.chaveCooldown ?? CHAVE, dados.administradorId ?? null, dados.sucesso, dados.motivo ?? null, dados.cooldownAte ?? null],
    );
    return { ok: true, id: rows[0].id };
  } catch (erro) {
    return { ok: false, code: erro.code };
  }
}

describe('migration 030 — login_tentativas_plataforma', () => {
  let contexto;
  let administradorId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_NECESSARIAS);
    administradorId = await inserirAdministrador(contexto.cliente);
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('registra tentativa bem-sucedida com administrador identificado', async () => {
    const r = await inserirTentativa(contexto.cliente, { administradorId, sucesso: true });
    assert.equal(r.ok, true);
  });

  test('tentativa bem-sucedida sem administrador identificado é recusada', async () => {
    const r = await inserirTentativa(contexto.cliente, { sucesso: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_CHECK);
  });

  test('tentativa malsucedida sem motivo é recusada', async () => {
    const r = await inserirTentativa(contexto.cliente, { sucesso: false });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_CHECK);
  });

  test('tentativa malsucedida sem administrador identificado é aceita (e-mail inexistente)', async () => {
    const r = await inserirTentativa(contexto.cliente, { sucesso: false, motivo: 'ADMINISTRADOR_INEXISTENTE' });
    assert.equal(r.ok, true);
  });

  test('motivo fora do formato [A-Z_]{1,30} é recusado', async () => {
    const r = await inserirTentativa(contexto.cliente, { sucesso: false, motivo: 'senha_invalida' });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_CHECK);
  });

  test('chave_cooldown fora do formato hex de 64 é recusada', async () => {
    const r = await inserirTentativa(contexto.cliente, { chaveCooldown: 'curta', sucesso: false, motivo: 'SENHA_INVALIDA' });
    assert.equal(r.ok, false);
  });

  test('chave_cooldown é obrigatória', async () => {
    const erro = await contexto.cliente
      .query('INSERT INTO login_tentativas_plataforma (sucesso, motivo) VALUES ($1, $2)', [false, 'SENHA_INVALIDA'])
      .catch((e) => e);
    assert.equal(erro.code, VIOLACAO_NOT_NULL);
  });

  test('ativação de cooldown exige motivo COOLDOWN_ATIVADO, sucesso=false e cooldown_ate no futuro', async () => {
    const semMotivoCorreto = await inserirTentativa(contexto.cliente, {
      sucesso: false, motivo: 'SENHA_INVALIDA', cooldownAte: new Date(Date.now() + 900_000),
    });
    assert.equal(semMotivoCorreto.ok, false);
    assert.equal(semMotivoCorreto.code, VIOLACAO_CHECK);

    const comCooldownNoPassado = await contexto.cliente.query(
      `INSERT INTO login_tentativas_plataforma (chave_cooldown, sucesso, motivo, cooldown_ate, criado_em)
       VALUES ($1, false, 'COOLDOWN_ATIVADO', now() - interval '1 minute', now())`,
      [CHAVE],
    ).catch((e) => e);
    assert.equal(comCooldownNoPassado.code, VIOLACAO_CHECK);

    const correta = await inserirTentativa(contexto.cliente, {
      sucesso: false, motivo: 'COOLDOWN_ATIVADO', cooldownAte: new Date(Date.now() + 900_000),
    });
    assert.equal(correta.ok, true);
  });

  test('administrador_id inexistente é recusado pela FK', async () => {
    const r = await inserirTentativa(contexto.cliente, { administradorId: 999999, sucesso: false, motivo: 'SENHA_INVALIDA' });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_FK);
  });

  test('excluir um administrador com histórico de tentativas é recusado (ON DELETE RESTRICT)', async () => {
    const admin = await inserirAdministrador(contexto.cliente, 'com-tentativa@safework.com.br');
    await inserirTentativa(contexto.cliente, { administradorId: admin, sucesso: true });

    const erro = await contexto.cliente.query('DELETE FROM administradores_plataforma WHERE id = $1', [admin]).catch((e) => e);
    assert.equal(erro.code, VIOLACAO_FK);
  });

  test('nenhuma coluna empresa_id: tentativa de plataforma não carrega contexto empresarial', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'login_tentativas_plataforma' AND column_name = 'empresa_id'",
      [contexto.schema],
    );
    assert.equal(rows.length, 0);
  });
});

describe('estrutura declarada na migration 030 (sem banco)', () => {
  test('a migration 030 existe e declara exatamente o que foi pedido', () => {
    assert.equal(migrationExiste('030'), true, 'migrations/030_*.sql deve existir');
    const sql = conteudoDaMigration('030');
    assert.match(sql, /CREATE TABLE login_tentativas_plataforma/i);
    assert.match(sql, /REFERENCES administradores_plataforma\(id\) ON DELETE RESTRICT/i);
    assert.match(sql, /CHECK \(chave_cooldown ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
    assert.doesNotMatch(sql, /REFERENCES usuarios|REFERENCES empresas/i, 'tabela própria da plataforma, sem FK para tabelas empresariais');
  });
});
