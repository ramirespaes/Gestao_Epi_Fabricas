'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migrations 050 e 051 — lotes e códigos de recuperação do MFA. PostgreSQL
 * real, schema temporário. Dependências mínimas: 000 e
 * administradores_plataforma (027).
 */

const MIGRATIONS = ['000', '027', '050', '051'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const VIOLACAO_CHECK = '23514';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';
const hashAleatorio = () => crypto.randomBytes(32).toString('hex');

describe('migrations 050 e 051 — recuperação do MFA', () => {
  let contexto;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  const novoAdministrador = async () => (await q(
    'INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id',
    [`adm-${crypto.randomBytes(4).toString('hex')}@safework.com.br`, 'hash-ficticio'],
  )).rows[0].id;

  async function inserirLote({ administradorId, estado = 'ATIVO', revogadoEm = null, motivo = null }) {
    try {
      const { rows } = await q(
        'INSERT INTO lotes_recuperacao_mfa_plataforma (administrador_id, estado, revogado_em, motivo_revogacao) VALUES ($1, $2, $3, $4) RETURNING id',
        [administradorId, estado, revogadoEm, motivo],
      );
      return { ok: true, id: rows[0].id };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint };
    }
  }

  async function inserirCodigo({ loteId, administradorId, hash = hashAleatorio(), formato = 1, consumidoEm = null }) {
    try {
      const { rows } = await q(
        `INSERT INTO codigos_recuperacao_mfa_plataforma (lote_id, administrador_id, codigo_hash, formato_versao, consumido_em)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [loteId, administradorId, hash, formato, consumidoEm],
      );
      return { ok: true, id: rows[0].id };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint };
    }
  }

  before(async () => { contexto = await abrirSchemaTemporario(MIGRATIONS); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('lotes_recuperacao_mfa_plataforma', () => {
    test('um único lote ATIVO por administrador; revogados convivem; outro administrador é independente', async () => {
      const a = await novoAdministrador();
      assert.equal((await inserirLote({ administradorId: a })).ok, true);
      const segundo = await inserirLote({ administradorId: a });
      assert.deepEqual([segundo.ok, segundo.code, segundo.constraint], [false, VIOLACAO_UNIQUE, 'uq_lotes_recuperacao_mfa_plataforma_ativo']);
      assert.equal((await inserirLote({ administradorId: a, estado: 'REVOGADO', revogadoEm: new Date(), motivo: 'REGENERADO' })).ok, true);
      assert.equal((await inserirLote({ administradorId: a, estado: 'REVOGADO', revogadoEm: new Date(), motivo: 'REGENERADO' })).ok, true);
      assert.equal((await inserirLote({ administradorId: await novoAdministrador() })).ok, true);
    });

    test('estado e revogação coerentes', async () => {
      const a = await novoAdministrador();
      const casos = [
        { estado: 'SUSPENSO' },
        { estado: 'ATIVO', revogadoEm: new Date() },
        { estado: 'ATIVO', motivo: 'REGENERADO' },
        { estado: 'REVOGADO', motivo: 'REGENERADO' },
        { estado: 'REVOGADO', revogadoEm: new Date() },
        { estado: 'REVOGADO', revogadoEm: new Date(), motivo: 'regenerado' },
      ];
      for (const caso of casos) {
        const r = await inserirLote({ administradorId: a, ...caso });
        assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(caso));
      }
    });

    test('administrador precisa existir', async () => {
      const r = await inserirLote({ administradorId: 999999 });
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_FK]);
    });
  });

  describe('codigos_recuperacao_mfa_plataforma', () => {
    test('código válido é aceito; o hash é único em toda a tabela', async () => {
      const a = await novoAdministrador();
      const b = await novoAdministrador();
      const loteA = (await inserirLote({ administradorId: a })).id;
      const loteB = (await inserirLote({ administradorId: b })).id;
      const hash = hashAleatorio();
      assert.equal((await inserirCodigo({ loteId: loteA, administradorId: a, hash })).ok, true);
      const dup = await inserirCodigo({ loteId: loteB, administradorId: b, hash });
      assert.deepEqual([dup.ok, dup.code], [false, VIOLACAO_UNIQUE]);
    });

    test('hash precisa ser SHA-256 hexadecimal minúsculo; formato_versao dentro da faixa', async () => {
      const a = await novoAdministrador();
      const lote = (await inserirLote({ administradorId: a })).id;
      for (const hash of [hashAleatorio().toUpperCase(), 'z'.repeat(64), hashAleatorio().slice(1)]) {
        const r = await inserirCodigo({ loteId: lote, administradorId: a, hash });
        assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK]);
      }
      for (const formato of [0, 10000]) {
        const r = await inserirCodigo({ loteId: lote, administradorId: a, formato });
        assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK]);
      }
    });

    test('o código pertence ao mesmo administrador do lote (FK composta)', async () => {
      const a = await novoAdministrador();
      const b = await novoAdministrador();
      const loteA = (await inserirLote({ administradorId: a })).id;
      const cruzado = await inserirCodigo({ loteId: loteA, administradorId: b });
      assert.deepEqual([cruzado.ok, cruzado.code, cruzado.constraint], [false, VIOLACAO_FK, 'fk_codigos_recuperacao_mfa_plataforma_lote_mesmo_administrador']);
      const inexistente = await inserirCodigo({ loteId: '999999', administradorId: a });
      assert.deepEqual([inexistente.ok, inexistente.code], [false, VIOLACAO_FK]);
    });

    test('lote com códigos não pode ser apagado', async () => {
      const a = await novoAdministrador();
      const lote = (await inserirLote({ administradorId: a })).id;
      await inserirCodigo({ loteId: lote, administradorId: a });
      const erro = await q('DELETE FROM lotes_recuperacao_mfa_plataforma WHERE id = $1', [lote]).catch((e) => e);
      assert.equal(erro.code, VIOLACAO_FK);
    });

    test('não existe coluna para o código em claro', async () => {
      const { rows } = await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'codigos_recuperacao_mfa_plataforma' ORDER BY ordinal_position`,
      );
      assert.deepEqual(rows.map((r) => r.column_name), ['id', 'lote_id', 'administrador_id', 'codigo_hash', 'formato_versao', 'criado_em', 'consumido_em']);
    });

    test('índice parcial dos códigos ainda disponíveis por lote', async () => {
      const { rows } = await q(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_codigos_recuperacao_mfa_plataforma_lote_disponiveis'",
      );
      assert.equal(rows.length, 1);
      assert.match(rows[0].indexdef, /\(lote_id\)/);
      assert.match(rows[0].indexdef, /consumido_em IS NULL/);
    });
  });

  test('manifesto: entradas da 050 e da 051 coerentes com os arquivos', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    for (const prefixo of ['050', '051']) {
      const arquivo = fs.readdirSync(DIRETORIO).find((nome) => nome.startsWith(`${prefixo}_`) && nome.endsWith('.sql'));
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
      assert.equal(manifesto.migrations[arquivo], sha, prefixo);
    }
    assert.match(conteudoDaMigration('050'), /CREATE TABLE lotes_recuperacao_mfa_plataforma/i);
    assert.match(conteudoDaMigration('051'), /CREATE TABLE codigos_recuperacao_mfa_plataforma/i);
  });
});
