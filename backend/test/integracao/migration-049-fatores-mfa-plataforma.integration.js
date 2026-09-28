'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 049 — fatores_mfa_plataforma. PostgreSQL real, schema
 * temporário. Dependências mínimas: set_atualizado_em (000) e
 * administradores_plataforma (027).
 */

const MIGRATIONS = ['000', '027', '049'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const VIOLACAO_CHECK = '23514';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';

describe('migration 049 — fatores_mfa_plataforma', () => {
  let contexto;
  let admin;
  let outro;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  async function inserirAdministrador(email) {
    return (await q('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, 'hash-ficticio'])).rows[0].id;
  }

  const agora = () => new Date();
  const pendente = (extra = {}) => ({
    fatorUid: crypto.randomUUID(),
    administradorId: admin,
    tipo: 'TOTP',
    estado: 'PENDENTE',
    formato: 1,
    chave: 1,
    nonce: crypto.randomBytes(12),
    cifrado: crypto.randomBytes(36),
    algoritmo: 'SHA1',
    digitos: 6,
    periodo: 30,
    step: null,
    criadoEm: agora(),
    pendenteExpiraEm: new Date(Date.now() + 15 * 60e3),
    ativadoEm: null,
    revogadoEm: null,
    motivo: null,
    ...extra,
  });
  const ativo = (extra = {}) => pendente({ estado: 'ATIVO', ativadoEm: agora(), step: 59000000, ...extra });
  const revogado = (extra = {}) => pendente({ estado: 'REVOGADO', nonce: null, cifrado: null, revogadoEm: agora(), motivo: 'SUBSTITUIDO', ...extra });

  async function inserir(d) {
    try {
      const { rows } = await q(
        `INSERT INTO fatores_mfa_plataforma
           (fator_uid, administrador_id, tipo, estado, totp_formato_versao, totp_chave_versao, totp_nonce, totp_segredo_cifrado,
            totp_algoritmo, totp_digitos, totp_periodo, totp_ultimo_step_aceito, criado_em, pendente_expira_em, ativado_em,
            revogado_em, motivo_revogacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
        [d.fatorUid, d.administradorId, d.tipo, d.estado, d.formato, d.chave, d.nonce, d.cifrado, d.algoritmo, d.digitos, d.periodo,
          d.step, d.criadoEm, d.pendenteExpiraEm, d.ativadoEm, d.revogadoEm, d.motivo],
      );
      return { ok: true, id: rows[0].id };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint };
    }
  }

  // Cada teste de unicidade usa administradores próprios, para não depender da ordem.
  const novoAdministrador = () => inserirAdministrador(`adm-${crypto.randomBytes(4).toString('hex')}@safework.com.br`);

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    admin = await inserirAdministrador('admin@safework.com.br');
    outro = await inserirAdministrador('outro@safework.com.br');
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('PENDENTE, ATIVO e REVOGADO coerentes são aceitos', async () => {
    const a = await novoAdministrador();
    assert.equal((await inserir(pendente({ administradorId: a }))).ok, true);
    assert.equal((await inserir(ativo({ administradorId: a }))).ok, true);
    assert.equal((await inserir(revogado({ administradorId: a }))).ok, true);
  });

  test('fator_uid é único; tipo só TOTP por ora; estado só os três previstos', async () => {
    const uid = crypto.randomUUID();
    assert.equal((await inserir(revogado({ fatorUid: uid }))).ok, true);
    const dup = await inserir(revogado({ fatorUid: uid }));
    assert.deepEqual([dup.ok, dup.code], [false, VIOLACAO_UNIQUE]);
    for (const extra of [{ tipo: 'WEBAUTHN' }, { tipo: 'totp' }, { estado: 'SUSPENSO' }]) {
      const r = await inserir(revogado(extra));
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(extra));
    }
  });

  test('coerência de estado e ciclo de vida', async () => {
    const casos = [
      pendente({ pendenteExpiraEm: null }),
      pendente({ ativadoEm: agora() }),
      pendente({ revogadoEm: agora() }),
      pendente({ motivo: 'SUBSTITUIDO' }),
      ativo({ ativadoEm: null }),
      ativo({ revogadoEm: agora() }),
      ativo({ motivo: 'SUBSTITUIDO' }),
      revogado({ revogadoEm: null }),
      revogado({ motivo: null }),
      pendente({ pendenteExpiraEm: new Date(Date.now() - 60e3) }),
    ];
    for (const caso of casos) {
      const r = await inserir(caso);
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify({ ...caso, nonce: undefined, cifrado: undefined }));
    }
  });

  test('TOTP PENDENTE ou ATIVO exige envelope e parâmetros completos', async () => {
    for (const campo of ['formato', 'chave', 'nonce', 'cifrado', 'algoritmo', 'digitos', 'periodo']) {
      for (const base of [pendente, ativo]) {
        const r = await inserir(base({ [campo]: null }));
        assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], `${campo} nulo`);
      }
    }
  });

  test('REVOGADO não guarda nonce nem ciphertext (crypto-shredding)', async () => {
    for (const extra of [{ nonce: crypto.randomBytes(12) }, { cifrado: crypto.randomBytes(36) }, { nonce: crypto.randomBytes(12), cifrado: crypto.randomBytes(36) }]) {
      const r = await inserir(revogado(extra));
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK]);
    }
  });

  test('formato do envelope e parâmetros fixos do TOTP', async () => {
    const casos = [
      { nonce: crypto.randomBytes(11) },
      { nonce: crypto.randomBytes(13) },
      { cifrado: crypto.randomBytes(35) },
      { cifrado: crypto.randomBytes(37) },
      { formato: 2 },
      { formato: 0 },
      { chave: 0 },
      { chave: 10000 },
      { algoritmo: 'SHA256' },
      { digitos: 8 },
      { periodo: 60 },
      { step: -1 },
    ];
    for (const extra of casos) {
      const r = await inserir(ativo({ administradorId: await novoAdministrador(), ...extra }));
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], Object.keys(extra)[0]);
    }
    const motivoRuim = await inserir(revogado({ motivo: 'substituido' }));
    assert.deepEqual([motivoRuim.ok, motivoRuim.code], [false, VIOLACAO_CHECK]);
  });

  test('um único TOTP ATIVO por administrador; revogados não contam; outro administrador é independente', async () => {
    const a = await novoAdministrador();
    assert.equal((await inserir(ativo({ administradorId: a }))).ok, true);
    const segundo = await inserir(ativo({ administradorId: a }));
    assert.deepEqual([segundo.ok, segundo.code, segundo.constraint], [false, VIOLACAO_UNIQUE, 'uq_fatores_mfa_plataforma_totp_ativo']);
    assert.equal((await inserir(revogado({ administradorId: a }))).ok, true);
    assert.equal((await inserir(revogado({ administradorId: a }))).ok, true);
    assert.equal((await inserir(ativo({ administradorId: await novoAdministrador() }))).ok, true);
  });

  test('um único TOTP PENDENTE por administrador, que convive com o ATIVO', async () => {
    const a = await novoAdministrador();
    assert.equal((await inserir(ativo({ administradorId: a }))).ok, true);
    assert.equal((await inserir(pendente({ administradorId: a }))).ok, true);
    const segundo = await inserir(pendente({ administradorId: a }));
    assert.deepEqual([segundo.ok, segundo.code, segundo.constraint], [false, VIOLACAO_UNIQUE, 'uq_fatores_mfa_plataforma_totp_pendente']);
  });

  test('a unicidade é específica de tipo = TOTP (não fecha a porta para vários WebAuthn)', async () => {
    const { rows } = await q(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'fatores_mfa_plataforma' AND indexname LIKE 'uq_fatores_mfa_plataforma_totp_%'
        ORDER BY indexname`,
    );
    assert.deepEqual(rows.map((r) => r.indexname), ['uq_fatores_mfa_plataforma_totp_ativo', 'uq_fatores_mfa_plataforma_totp_pendente']);
    for (const { indexdef } of rows) {
      assert.match(indexdef, /UNIQUE INDEX/);
      assert.match(indexdef, /\(administrador_id\)/);
      assert.match(indexdef, /tipo\)::text = 'TOTP'/);
    }
  });

  test('administrador precisa existir e, com fator, não pode ser apagado', async () => {
    const r = await inserir(revogado({ administradorId: 999999 }));
    assert.deepEqual([r.ok, r.code], [false, VIOLACAO_FK]);
    const erro = await q('DELETE FROM administradores_plataforma WHERE id = $1', [outro]).catch((e) => e);
    assert.equal(erro instanceof Error, false, 'sem fator, o administrador ainda pode ser apagado');
    const a = await novoAdministrador();
    await inserir(revogado({ administradorId: a }));
    const bloqueado = await q('DELETE FROM administradores_plataforma WHERE id = $1', [a]).catch((e) => e);
    assert.equal(bloqueado.code, VIOLACAO_FK);
  });

  test('(id, administrador_id) é único, base das FKs compostas das tabelas filhas', async () => {
    const { rows } = await q(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'fatores_mfa_plataforma'::regclass AND conname = 'uq_fatores_mfa_plataforma_id_administrador'`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].def, /UNIQUE \(id, administrador_id\)/);
  });

  test('índice da versão de chave cobre só PENDENTE e ATIVO', async () => {
    const { rows } = await q(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_fatores_mfa_plataforma_chave_versao'",
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /\(totp_chave_versao\)/);
    assert.match(rows[0].indexdef, /PENDENTE/);
    assert.match(rows[0].indexdef, /ATIVO/);
  });

  test('atualizado_em acompanha UPDATE', async () => {
    const a = await novoAdministrador();
    const { id } = await inserir(pendente({ administradorId: a }));
    await q("UPDATE fatores_mfa_plataforma SET atualizado_em = '2000-01-01' WHERE id = $1", [id]);
    const { rows } = await q('SELECT atualizado_em > $2::timestamptz AS atualizou FROM fatores_mfa_plataforma WHERE id = $1', [id, '2001-01-01']);
    assert.equal(rows[0].atualizou, true);
  });

  test('manifesto: entrada da 049 coerente com o arquivo', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivo = fs.readdirSync(DIRETORIO).find((nome) => nome.startsWith('049_') && nome.endsWith('.sql'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
    assert.equal(manifesto.migrations[arquivo], sha);
    assert.match(conteudoDaMigration('049'), /CREATE TABLE fatores_mfa_plataforma/i);
  });
});
