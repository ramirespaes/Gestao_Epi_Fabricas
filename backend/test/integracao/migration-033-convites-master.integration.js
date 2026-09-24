'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 033 — convites_master (Pacote 3). PostgreSQL real, schema
 * temporário. Dependências mínimas: empresas (001), usuarios (002/005) e
 * uq_usuarios_empresa_id (013, exigido pela FK composta), identidades
 * (025), administradores_plataforma (027).
 */

const MIGRATIONS = ['000', '001', '002', '005', '013', '025', '027', '033'];
const VIOLACAO_CHECK = '23514';
const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const HASH = (c) => c.repeat(64);

describe('migration 033 — convites_master', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let adminId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    await inserirEmpresa(contexto.cliente, '11222333000181', 'A');
    await inserirEmpresa(contexto.cliente, '44555666000162', 'B');
    const { rows } = await contexto.cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '11222333000181').id;
    empresaB = rows.find((e) => e.cnpj === '44555666000162').id;
    const { rows: a } = await contexto.cliente.query("INSERT INTO administradores_plataforma (email, senha_hash) VALUES ('adm@x.com', 'h') RETURNING id");
    adminId = a[0].id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  async function inserir(dados) {
    try {
      const { rows } = await contexto.cliente.query(
        `INSERT INTO convites_master (empresa_id, email_convite, token_hash, criado_por, expira_em, criado_em, aceito_em, cancelado_em, identidade_id, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [dados.empresaId ?? empresaA, dados.email ?? 'p@x.com', dados.hash, dados.criadoPor ?? adminId,
          dados.expiraEm ?? new Date(Date.now() + 3600e3), dados.criadoEm ?? new Date(),
          dados.aceitoEm ?? null, dados.canceladoEm ?? null, dados.identidadeId ?? null, dados.usuarioId ?? null],
      );
      return { ok: true, id: rows[0].id };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint };
    }
  }

  test('convite pendente válido é aceito', async () => {
    assert.equal((await inserir({ hash: HASH('a') })).ok, true);
  });

  test('token_hash é único e precisa ser SHA-256 hex minúsculo', async () => {
    const dup = await inserir({ hash: HASH('a') });
    assert.deepEqual([dup.ok, dup.code], [false, VIOLACAO_UNIQUE]);
    const ruim = await inserir({ hash: 'A'.repeat(64) });
    assert.deepEqual([ruim.ok, ruim.code], [false, VIOLACAO_CHECK]);
  });

  test('expira_em precisa ser posterior a criado_em', async () => {
    const agora = new Date();
    const r = await inserir({ hash: HASH('b'), criadoEm: agora, expiraEm: agora });
    assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK]);
  });

  test('aceito e cancelado são mutuamente exclusivos', async () => {
    const r = await inserir({ hash: HASH('c'), aceitoEm: new Date(), canceladoEm: new Date() });
    assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK]);
  });

  test('aceite coerente: aceito_em exige identidade_id e usuario_id (do vínculo da MESMA empresa); não aceito não pode carregá-los', async () => {
    const semVinculo = await inserir({ hash: HASH('d'), aceitoEm: new Date() });
    assert.deepEqual([semVinculo.ok, semVinculo.code], [false, VIOLACAO_CHECK]);

    const { rows: i } = await contexto.cliente.query("INSERT INTO identidades (email, senha_hash) VALUES ('p@x.com', 'h') RETURNING id");
    const { rows: uA } = await contexto.cliente.query("INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id) VALUES ($1, 'P', 'MASTER', $2) RETURNING id", [empresaA, i[0].id]);
    const { rows: uB } = await contexto.cliente.query("INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id) VALUES ($1, 'P', 'MASTER', $2) RETURNING id", [empresaB, i[0].id]);

    const outraEmpresa = await inserir({ hash: HASH('e'), empresaId: empresaA, aceitoEm: new Date(), identidadeId: i[0].id, usuarioId: uB[0].id });
    assert.deepEqual([outraEmpresa.ok, outraEmpresa.code], [false, VIOLACAO_FK], 'usuario de OUTRA empresa é recusado pela FK composta');

    const ok = await inserir({ hash: HASH('f'), empresaId: empresaA, aceitoEm: new Date(), identidadeId: i[0].id, usuarioId: uA[0].id });
    assert.equal(ok.ok, true);

    const pendenteComVinculo = await inserir({ hash: HASH('0'), identidadeId: i[0].id, usuarioId: uA[0].id });
    assert.deepEqual([pendenteComVinculo.ok, pendenteComVinculo.code], [false, VIOLACAO_CHECK]);
  });

  test('criado_por precisa existir em administradores_plataforma (RESTRICT) e empresa_id em empresas', async () => {
    const r = await inserir({ hash: HASH('1'), criadoPor: 999999 });
    assert.deepEqual([r.ok, r.code], [false, VIOLACAO_FK]);
    const erro = await contexto.cliente.query('DELETE FROM administradores_plataforma WHERE id = $1', [adminId]).catch((e) => e);
    assert.equal(erro.code, VIOLACAO_FK, 'administrador que convidou não pode ser apagado');
  });

  test('a migration 033 declara o desenho aprovado: sem coluna "status", situação derivada de timestamps', () => {
    assert.equal(migrationExiste('033'), true);
    const sql = conteudoDaMigration('033');
    assert.match(sql, /CREATE TABLE convites_master/i);
    assert.doesNotMatch(sql, /\bstatus\b\s+VARCHAR/i);
    assert.match(sql, /cancelado_em\s+TIMESTAMPTZ/i);
    assert.match(sql, /fk_convites_master_usuario_mesma_empresa/i);
  });
});
