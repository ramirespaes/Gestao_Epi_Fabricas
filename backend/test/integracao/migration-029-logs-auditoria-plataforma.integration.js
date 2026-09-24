'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 029 — logs_auditoria_plataforma (Autenticação Global —
 * Pacote 2). PostgreSQL real, schema temporário exclusivo. Reaproveita, SEM
 * ALTERAR, as funções genéricas já definidas por 012
 * (bloquear_alteracao_logs_auditoria) e 014
 * (logs_auditoria_bloquear_dado_sensivel) — este arquivo prova que a
 * reutilização funciona, não redefine as funções.
 *
 * Prefixos mínimos para aplicar 029: 001 (empresas), 002 (perfis) e 005
 * (usuarios) só existem porque 012 referencia usuarios(id); 012 e 014
 * fornecem as funções e a proteção que 029 reaproveita; 027 fornece
 * administradores_plataforma, referenciada por administrador_id.
 */

const MIGRATIONS_NECESSARIAS = ['000', '001', '002', '005', '012', '014', '027', '029'];
const VIOLACAO_FK = '23503';

async function inserirAdministrador(cliente, email = 'admin@safework.com.br') {
  const { rows } = await cliente.query(
    'INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id',
    [email, 'hash-ficticio'],
  );
  return rows[0].id;
}

async function registrarLog(cliente, { administradorId, empresaAfetadaId = null, acao = 'ACAO_TESTE', contexto = null }) {
  try {
    const { rows } = await cliente.query(
      `INSERT INTO logs_auditoria_plataforma (administrador_id, empresa_afetada_id, acao, contexto)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [administradorId, empresaAfetadaId, acao, contexto],
    );
    return { ok: true, id: rows[0].id };
  } catch (erro) {
    return { ok: false, code: erro.code, message: erro.message };
  }
}

describe('migration 029 — logs_auditoria_plataforma', () => {
  let contexto;
  let administradorId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_NECESSARIAS);
    administradorId = await inserirAdministrador(contexto.cliente);
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('registra log com sucesso, sem empresa afetada', async () => {
    const r = await registrarLog(contexto.cliente, { administradorId });
    assert.equal(r.ok, true);
  });

  test('administrador_id é obrigatório: toda ação de plataforma tem autor identificado', async () => {
    const erro = await contexto.cliente
      .query('INSERT INTO logs_auditoria_plataforma (acao) VALUES ($1)', ['SEM_ADMIN'])
      .catch((e) => e);
    assert.equal(erro.code, '23502');
  });

  test('administrador_id inexistente é recusado pela FK', async () => {
    const r = await registrarLog(contexto.cliente, { administradorId: 999999 });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_FK);
  });

  test('empresa_afetada_id é opcional, mas quando informada precisa existir', async () => {
    const semEmpresa = await registrarLog(contexto.cliente, { administradorId });
    assert.equal(semEmpresa.ok, true);

    const empresaInexistente = await registrarLog(contexto.cliente, { administradorId, empresaAfetadaId: 999999 });
    assert.equal(empresaInexistente.ok, false);
    assert.equal(empresaInexistente.code, VIOLACAO_FK);

    assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa Afetada'), 'ok');
    const { rows: empresas } = await contexto.cliente.query('SELECT id FROM empresas LIMIT 1');
    const comEmpresa = await registrarLog(contexto.cliente, { administradorId, empresaAfetadaId: empresas[0].id });
    assert.equal(comEmpresa.ok, true);
  });

  test('excluir um administrador com log de auditoria é recusado (ON DELETE RESTRICT)', async () => {
    const admin = await inserirAdministrador(contexto.cliente, 'com-log@safework.com.br');
    await registrarLog(contexto.cliente, { administradorId: admin, acao: 'QUALQUER' });

    const erro = await contexto.cliente.query('DELETE FROM administradores_plataforma WHERE id = $1', [admin]).catch((e) => e);
    assert.equal(erro.code, VIOLACAO_FK, 'auditoria de plataforma nunca pode ficar órfã por exclusão física do autor');
  });

  test('append-only: UPDATE é bloqueado pela função reaproveitada de 012 (bloquear_alteracao_logs_auditoria)', async () => {
    const { id } = await registrarLog(contexto.cliente, { administradorId });
    const erro = await contexto.cliente
      .query('UPDATE logs_auditoria_plataforma SET acao = $1 WHERE id = $2', ['ALTERADA', id])
      .catch((e) => e);
    assert.match(erro.message, /append-only/);
  });

  test('append-only: DELETE é bloqueado', async () => {
    const { id } = await registrarLog(contexto.cliente, { administradorId });
    const erro = await contexto.cliente.query('DELETE FROM logs_auditoria_plataforma WHERE id = $1', [id]).catch((e) => e);
    assert.match(erro.message, /append-only/);
  });

  test('append-only: TRUNCATE é bloqueado', async () => {
    const erro = await contexto.cliente.query('TRUNCATE logs_auditoria_plataforma').catch((e) => e);
    assert.match(erro.message, /append-only/);
  });

  test('dado sensível em contexto é rejeitado pela função reaproveitada de 014 (chave "senha")', async () => {
    const r = await registrarLog(contexto.cliente, { administradorId, contexto: { senha: 'qualquercoisa' } });
    assert.equal(r.ok, false);
    assert.match(r.message, /chave sensível/);
  });

  test('dado sensível aninhado (dentro de um objeto) também é rejeitado', async () => {
    const r = await registrarLog(contexto.cliente, { administradorId, contexto: { detalhe: { tokenSessao: 'x' } } });
    assert.equal(r.ok, false);
    assert.match(r.message, /chave sensível/);
  });

  test('contexto sem chave sensível é aceito normalmente', async () => {
    const r = await registrarLog(contexto.cliente, { administradorId, contexto: { origem: 'script_administrativo_bootstrap' } });
    assert.equal(r.ok, true);
  });
});

describe('estrutura declarada na migration 029 (sem banco)', () => {
  test('a migration 029 existe, reaproveita as funções de 012/014 e não as redefine', () => {
    assert.equal(migrationExiste('029'), true, 'migrations/029_*.sql deve existir');
    const sql = conteudoDaMigration('029');
    assert.match(sql, /CREATE TABLE logs_auditoria_plataforma/i);
    assert.match(sql, /REFERENCES administradores_plataforma\(id\) ON DELETE RESTRICT/i);
    assert.match(sql, /REFERENCES empresas\(id\) ON DELETE RESTRICT/i);
    assert.match(sql, /EXECUTE FUNCTION bloquear_alteracao_logs_auditoria\(\)/i);
    assert.match(sql, /EXECUTE FUNCTION logs_auditoria_bloquear_dado_sensivel\(\)/i);
    assert.doesNotMatch(sql, /CREATE (OR REPLACE )?FUNCTION/i, '029 reaproveita as funções existentes, nunca redefine');
  });
});
