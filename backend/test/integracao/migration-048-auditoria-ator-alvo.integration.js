'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 048 — ator e alvo em logs_auditoria_plataforma. PostgreSQL
 * real, schema temporário. Monto a tabela até a 031, gravo linhas no
 * formato antigo e só então aplico a 048, para provar o que acontece com o
 * histórico: nenhuma linha é reescrita, todas passam a ler ADMINISTRADOR
 * pelo default, e append-only e bloqueio de chave sensível continuam.
 */

const ATE_A_031 = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '031'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const VIOLACAO_CHECK = '23514';
const VIOLACAO_NOT_NULL = '23502';
const VIOLACAO_FK = '23503';

describe('migration 048 — ator e alvo em logs_auditoria_plataforma', () => {
  let contexto;
  let admin;
  let outro;
  const historicas = [];

  const q = (sql, params) => contexto.cliente.query(sql, params);

  async function inserirAdministrador(email) {
    return (await q('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, 'hash-ficticio'])).rows[0].id;
  }

  async function inserir({ ator, administradorId = null, alvo = null, acao = 'ACAO_TESTE', contexto: ctx = null }) {
    try {
      const { rows } = await q(
        `INSERT INTO logs_auditoria_plataforma (ator_tipo, administrador_id, administrador_afetado_id, acao, contexto)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ator, administradorId, alvo, acao, ctx],
      );
      return { ok: true, id: rows[0].id };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint, message: erro.message };
    }
  }

  before(async () => {
    contexto = await abrirSchemaTemporario(ATE_A_031);
    admin = await inserirAdministrador('admin@safework.com.br');
    outro = await inserirAdministrador('outro@safework.com.br');
    for (const acao of ['ADMINISTRADOR_PLATAFORMA_CRIADO', 'EMPRESA_CADASTRADA']) {
      const { rows } = await q(
        'INSERT INTO logs_auditoria_plataforma (administrador_id, acao, contexto) VALUES ($1, $2, $3) RETURNING id, xmin::text AS xmin',
        [admin, acao, { origem: 'historico' }],
      );
      historicas.push(rows[0]);
    }
    await q(conteudoDaMigration('048'));
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('linhas históricas continuam lá, intactas, e passam a ler ADMINISTRADOR pelo default', async () => {
    const { rows } = await q(
      `SELECT id, ator_tipo, administrador_id, administrador_afetado_id, xmin::text AS xmin
         FROM logs_auditoria_plataforma WHERE id = ANY($1) ORDER BY id`,
      [historicas.map((h) => h.id)],
    );
    assert.equal(rows.length, historicas.length);
    for (const [i, linha] of rows.entries()) {
      assert.equal(linha.ator_tipo, 'ADMINISTRADOR');
      assert.equal(linha.administrador_id, admin);
      assert.equal(linha.administrador_afetado_id, null);
      assert.equal(linha.xmin, historicas[i].xmin, 'a 048 não reescreve nem atualiza linha alguma');
    }
  });

  test('ator_tipo é NOT NULL com default ADMINISTRADOR; administrador_id deixou de ser NOT NULL', async () => {
    const { rows } = await q(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'logs_auditoria_plataforma'
          AND column_name IN ('ator_tipo', 'administrador_id', 'administrador_afetado_id')
        ORDER BY column_name`,
    );
    const porNome = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    assert.equal(porNome.ator_tipo.is_nullable, 'NO');
    assert.match(porNome.ator_tipo.column_default, /'ADMINISTRADOR'/);
    assert.equal(porNome.administrador_id.is_nullable, 'YES');
    assert.equal(porNome.administrador_afetado_id.is_nullable, 'YES');
  });

  test('OPERACAO_CLI grava com administrador_id nulo, com e sem alvo', async () => {
    assert.equal((await inserir({ ator: 'OPERACAO_CLI', alvo: outro, acao: 'MFA_RESET_OPERACIONAL' })).ok, true);
    assert.equal((await inserir({ ator: 'OPERACAO_CLI' })).ok, true);
  });

  test('SISTEMA grava com administrador_id nulo, com e sem alvo', async () => {
    assert.equal((await inserir({ ator: 'SISTEMA', alvo: admin, acao: 'MFA_CHAVE_INDISPONIVEL', contexto: { operacao: 'cadastro', chaveVersao: 1 } })).ok, true);
    assert.equal((await inserir({ ator: 'SISTEMA' })).ok, true);
  });

  test('ADMINISTRADOR sem administrador_id é recusado', async () => {
    const r = await inserir({ ator: 'ADMINISTRADOR' });
    assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK]);
  });

  test('CLI ou SISTEMA com administrador_id é recusado: operação sem ator humano nunca é atribuída a um administrador', async () => {
    for (const ator of ['OPERACAO_CLI', 'SISTEMA']) {
      const comoAlvo = await inserir({ ator, administradorId: outro, alvo: null });
      assert.deepEqual([comoAlvo.ok, comoAlvo.code], [false, VIOLACAO_CHECK], ator);
      const comAlvo = await inserir({ ator, administradorId: admin, alvo: outro });
      assert.deepEqual([comAlvo.ok, comAlvo.code], [false, VIOLACAO_CHECK], ator);
    }
  });

  test('ator_tipo fora da lista é recusado; nulo explícito também', async () => {
    for (const ator of ['OPERADOR', 'administrador', '']) {
      const r = await inserir({ ator, administradorId: admin });
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], ator);
    }
    const nulo = await inserir({ ator: null, administradorId: admin });
    assert.deepEqual([nulo.ok, nulo.code], [false, VIOLACAO_NOT_NULL]);
  });

  test('alvo não se confunde com ator: sobre si mesmo o id não se repete; sobre outro administrador, aceito', async () => {
    const sobreSi = await inserir({ ator: 'ADMINISTRADOR', administradorId: admin, alvo: admin });
    assert.deepEqual([sobreSi.ok, sobreSi.code], [false, VIOLACAO_CHECK]);
    assert.equal((await inserir({ ator: 'ADMINISTRADOR', administradorId: admin, alvo: outro })).ok, true);
    assert.equal((await inserir({ ator: 'ADMINISTRADOR', administradorId: admin })).ok, true);
  });

  test('alvo precisa existir e, com auditoria, não pode ser apagado', async () => {
    const inexistente = await inserir({ ator: 'OPERACAO_CLI', alvo: 999999 });
    assert.deepEqual([inexistente.ok, inexistente.code], [false, VIOLACAO_FK]);
    const soAlvo = await inserirAdministrador(`alvo-${crypto.randomBytes(3).toString('hex')}@safework.com.br`);
    assert.equal((await inserir({ ator: 'OPERACAO_CLI', alvo: soAlvo })).ok, true);
    const erro = await q('DELETE FROM administradores_plataforma WHERE id = $1', [soAlvo]).catch((e) => e);
    assert.equal(erro.code, VIOLACAO_FK);
  });

  test('append-only continua: UPDATE, DELETE e TRUNCATE recusados, no histórico e nas linhas novas', async () => {
    const nova = await inserir({ ator: 'OPERACAO_CLI', alvo: outro });
    const tentativas = [
      ["UPDATE logs_auditoria_plataforma SET ator_tipo = 'SISTEMA', administrador_id = NULL WHERE id = $1", [historicas[0].id]],
      ['UPDATE logs_auditoria_plataforma SET administrador_afetado_id = NULL WHERE id = $1', [nova.id]],
      ['DELETE FROM logs_auditoria_plataforma WHERE id = $1', [historicas[1].id]],
      ['DELETE FROM logs_auditoria_plataforma WHERE id = $1', [nova.id]],
      ['TRUNCATE logs_auditoria_plataforma', []],
    ];
    for (const [sql, params] of tentativas) {
      const erro = await q(sql, params).catch((e) => e);
      assert.match(erro.message, /append-only/, sql);
    }
  });

  test('chave sensível continua bloqueada para qualquer ator; chaves neutras passam', async () => {
    for (const [ator, administradorId] of [['OPERACAO_CLI', null], ['SISTEMA', null], ['ADMINISTRADOR', admin]]) {
      for (const ctx of [{ totp: 'x' }, { segredo: 'x' }, { detalhe: { tokenDesafio: 'x' } }]) {
        const r = await inserir({ ator, administradorId, contexto: ctx });
        assert.equal(r.ok, false, `${ator} ${JSON.stringify(ctx)}`);
        assert.match(r.message, /chave sensível/);
      }
      assert.equal((await inserir({ ator, administradorId, contexto: { origem: 'cli', chaveVersao: 2, fatorUid: crypto.randomUUID() } })).ok, true, ator);
    }
  });

  test('índice do alvo existe', async () => {
    const { rows } = await q(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_logs_auditoria_plataforma_administrador_afetado_id'",
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /\(administrador_afetado_id\)/);
  });
});

describe('estrutura declarada na migration 048 (sem banco)', () => {
  test('só ALTER aditivo: não recria a tabela, não mexe em linha nem em trigger', () => {
    const sql = conteudoDaMigration('048').replace(/^\s*--.*$/gm, '');
    assert.match(sql, /ALTER TABLE logs_auditoria_plataforma/i);
    assert.doesNotMatch(sql, /CREATE TABLE/i);
    assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|INSERT)\b/im);
    assert.doesNotMatch(sql, /TRIGGER/i);
  });

  test('manifesto: entrada da 048 coerente com o arquivo', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivo = fs.readdirSync(DIRETORIO).find((nome) => nome.startsWith('048_') && nome.endsWith('.sql'));
    assert.ok(arquivo, 'migrations/048_*.sql deve existir');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
    assert.equal(manifesto.migrations[arquivo], sha);
  });
});
