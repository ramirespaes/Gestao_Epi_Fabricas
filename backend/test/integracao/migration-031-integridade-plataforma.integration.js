'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 031 — correção final do Pacote 2, itens 3 e 4 da auditoria
 * independente. PostgreSQL real, schema temporário exclusivo. Migration
 * ADITIVA: 027/028/029 não são tocadas (comprovado também pelo checksum,
 * fora deste arquivo) — aqui só se prova que as constraints/índice/trigger
 * NOVOS realmente funcionam.
 */

const MIGRATIONS_NECESSARIAS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '031'];
const VIOLACAO_CHECK = '23514';

async function inserirAdministrador(cliente, email = 'admin@safework.com.br') {
  const { rows } = await cliente.query(
    'INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id',
    [email, 'hash-ficticio'],
  );
  return rows[0].id;
}

async function inserirSessao(cliente, { administradorId, tokenHash, criadoEm, expiraEm, revogadaEm = null, motivoRevogacao = null }) {
  try {
    const { rows } = await cliente.query(
      `INSERT INTO sessoes_plataforma (administrador_id, token_hash, criado_em, expira_em, revogada_em, motivo_revogacao)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [administradorId, tokenHash, criadoEm, expiraEm, revogadaEm, motivoRevogacao],
    );
    return { ok: true, id: rows[0].id };
  } catch (erro) {
    return { ok: false, code: erro.code, message: erro.message };
  }
}

describe('migration 031 — item 4: constraints de sessoes_plataforma equiparadas a sessoes (013)', () => {
  let contexto;
  let administradorId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_NECESSARIAS);
    administradorId = await inserirAdministrador(contexto.cliente);
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('expira_em precisa ser posterior a criado_em (chk_sessoes_plataforma_expira_apos_criacao)', async () => {
    const agora = new Date();
    const noPassado = new Date(agora.getTime() - 3600_000);
    const r = await inserirSessao(contexto.cliente, {
      administradorId, tokenHash: 'a'.repeat(64), criadoEm: agora, expiraEm: noPassado,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_CHECK);
  });

  test('expira_em igual a criado_em também é recusado (exige estritamente posterior)', async () => {
    const agora = new Date();
    const r = await inserirSessao(contexto.cliente, {
      administradorId, tokenHash: 'b'.repeat(64), criadoEm: agora, expiraEm: agora,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_CHECK);
  });

  test('revogada_em sem motivo_revogacao é recusado (chk_sessoes_plataforma_revogacao_coerente)', async () => {
    const agora = new Date();
    const r = await inserirSessao(contexto.cliente, {
      administradorId, tokenHash: 'c'.repeat(64), criadoEm: agora, expiraEm: new Date(agora.getTime() + 3600_000),
      revogadaEm: agora, motivoRevogacao: null,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_CHECK);
  });

  test('motivo_revogacao sem revogada_em é recusado', async () => {
    const agora = new Date();
    const r = await inserirSessao(contexto.cliente, {
      administradorId, tokenHash: 'd'.repeat(64), criadoEm: agora, expiraEm: new Date(agora.getTime() + 3600_000),
      revogadaEm: null, motivoRevogacao: 'LOGOUT',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, VIOLACAO_CHECK);
  });

  test('revogada_em e motivo_revogacao juntos são aceitos', async () => {
    const agora = new Date();
    const r = await inserirSessao(contexto.cliente, {
      administradorId, tokenHash: 'e'.repeat(64), criadoEm: agora, expiraEm: new Date(agora.getTime() + 3600_000),
      revogadaEm: agora, motivoRevogacao: 'LOGOUT',
    });
    assert.equal(r.ok, true);
  });

  test('nenhum dos dois preenchido também é aceito (sessão não revogada)', async () => {
    const agora = new Date();
    const r = await inserirSessao(contexto.cliente, {
      administradorId, tokenHash: 'f'.repeat(64), criadoEm: agora, expiraEm: new Date(agora.getTime() + 3600_000),
    });
    assert.equal(r.ok, true);
  });

  test('índice idx_sessoes_plataforma_expira_em existe (rotina de purga)', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'sessoes_plataforma' AND indexname = 'idx_sessoes_plataforma_expira_em'",
      [contexto.schema],
    );
    assert.equal(rows.length, 1);
  });
});

describe('migration 031 — item 4: constraints JSONB de logs_auditoria_plataforma equiparadas a logs_auditoria (014)', () => {
  let contexto;
  let administradorId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_NECESSARIAS);
    administradorId = await inserirAdministrador(contexto.cliente);
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  async function registrar(campo, valor) {
    try {
      await contexto.cliente.query(
        `INSERT INTO logs_auditoria_plataforma (administrador_id, acao, ${campo}) VALUES ($1, $2, $3)`,
        [administradorId, 'ACAO_TESTE', valor],
      );
      return { ok: true };
    } catch (erro) {
      return { ok: false, code: erro.code };
    }
  }

  for (const campo of ['contexto', 'dados_anteriores', 'dados_novos']) {
    test(`${campo}: array JSON é recusado (precisa ser objeto)`, async () => {
      const r = await registrar(campo, JSON.stringify(['não', 'é', 'objeto']));
      assert.equal(r.ok, false);
      assert.equal(r.code, VIOLACAO_CHECK);
    });

    test(`${campo}: escalar JSON (string/number) é recusado`, async () => {
      const r = await registrar(campo, JSON.stringify('texto solto'));
      assert.equal(r.ok, false);
      assert.equal(r.code, VIOLACAO_CHECK);
    });

    test(`${campo}: objeto JSON válido é aceito`, async () => {
      const r = await registrar(campo, JSON.stringify({ chave: 'valor' }));
      assert.equal(r.ok, true);
    });

    test(`${campo}: acima de 16 KiB é recusado`, async () => {
      const grande = { texto: 'x'.repeat(17000) };
      const r = await registrar(campo, JSON.stringify(grande));
      assert.equal(r.ok, false);
      assert.equal(r.code, VIOLACAO_CHECK);
    });

    test(`${campo}: null continua aceito (coluna opcional)`, async () => {
      const r = await registrar(campo, null);
      assert.equal(r.ok, true);
    });
  }
});

describe('migration 031 — item 3: revogação PERMANENTE de sessões ao inativar o administrador', () => {
  let contexto;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_NECESSARIAS);
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('inativar o administrador revoga TODAS as suas sessões não revogadas', async () => {
    const administradorId = await inserirAdministrador(contexto.cliente, 'inativado1@safework.com.br');
    const agora = new Date();
    const s1 = await inserirSessao(contexto.cliente, { administradorId, tokenHash: '1'.repeat(64), criadoEm: agora, expiraEm: new Date(agora.getTime() + 3600_000) });
    const s2 = await inserirSessao(contexto.cliente, { administradorId, tokenHash: '2'.repeat(64), criadoEm: agora, expiraEm: new Date(agora.getTime() + 3600_000) });
    assert.equal(s1.ok, true);
    assert.equal(s2.ok, true);

    await contexto.cliente.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [administradorId]);

    const { rows } = await contexto.cliente.query(
      'SELECT id, revogada_em, motivo_revogacao FROM sessoes_plataforma WHERE administrador_id = $1 ORDER BY id',
      [administradorId],
    );
    assert.equal(rows.length, 2);
    for (const linha of rows) {
      assert.notEqual(linha.revogada_em, null, `sessão ${linha.id} deveria ter sido revogada`);
      assert.equal(linha.motivo_revogacao, 'ADMINISTRADOR_INATIVADO');
    }
  });

  test('REATIVAR o administrador NÃO restaura as sessões: revogada_em permanece preenchido para sempre', async () => {
    const administradorId = await inserirAdministrador(contexto.cliente, 'reativado1@safework.com.br');
    const agora = new Date();
    const sessao = await inserirSessao(contexto.cliente, { administradorId, tokenHash: '3'.repeat(64), criadoEm: agora, expiraEm: new Date(agora.getTime() + 3600_000) });
    assert.equal(sessao.ok, true);

    await contexto.cliente.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [administradorId]);
    const { rows: antesReativar } = await contexto.cliente.query('SELECT revogada_em, motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [sessao.id]);
    assert.notEqual(antesReativar[0].revogada_em, null);

    // A REATIVAÇÃO em si.
    await contexto.cliente.query('UPDATE administradores_plataforma SET ativo = true WHERE id = $1', [administradorId]);

    const { rows: depoisReativar } = await contexto.cliente.query('SELECT revogada_em, motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [sessao.id]);
    assert.deepEqual(depoisReativar[0], antesReativar[0], 'reativar o administrador não pode alterar revogada_em/motivo_revogacao de forma alguma');
    assert.notEqual(depoisReativar[0].revogada_em, null, 'a sessão continua revogada para sempre, mesmo depois da reativação');
  });

  test('uma sessão criada DEPOIS da reativação (login novo) não é afetada pela revogação anterior', async () => {
    const administradorId = await inserirAdministrador(contexto.cliente, 'reativado2@safework.com.br');
    const agora = new Date();
    const sessaoAntiga = await inserirSessao(contexto.cliente, { administradorId, tokenHash: '4'.repeat(64), criadoEm: agora, expiraEm: new Date(agora.getTime() + 3600_000) });

    await contexto.cliente.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [administradorId]);
    await contexto.cliente.query('UPDATE administradores_plataforma SET ativo = true WHERE id = $1', [administradorId]);

    const sessaoNova = await inserirSessao(contexto.cliente, { administradorId, tokenHash: '5'.repeat(64), criadoEm: new Date(), expiraEm: new Date(Date.now() + 3600_000) });
    assert.equal(sessaoNova.ok, true);

    const { rows } = await contexto.cliente.query('SELECT id, revogada_em FROM sessoes_plataforma WHERE id IN ($1, $2) ORDER BY id', [sessaoAntiga.id, sessaoNova.id]);
    const antiga = rows.find((r) => r.id === sessaoAntiga.id);
    const nova = rows.find((r) => r.id === sessaoNova.id);
    assert.notEqual(antiga.revogada_em, null, 'a sessão antiga continua revogada');
    assert.equal(nova.revogada_em, null, 'uma sessão nova, criada depois da reativação, nasce válida normalmente');
  });

  test('inativar de novo um administrador já inativo não sobrescreve o motivo/instante de uma sessão já revogada por outra razão (ex.: logout antes da inativação)', async () => {
    const administradorId = await inserirAdministrador(contexto.cliente, 'logout-antes@safework.com.br');
    const agora = new Date();
    const sessao = await inserirSessao(contexto.cliente, { administradorId, tokenHash: '6'.repeat(64), criadoEm: agora, expiraEm: new Date(agora.getTime() + 3600_000) });

    await contexto.cliente.query("UPDATE sessoes_plataforma SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [sessao.id]);
    await contexto.cliente.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [administradorId]);

    const { rows } = await contexto.cliente.query('SELECT motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [sessao.id]);
    assert.equal(rows[0].motivo_revogacao, 'LOGOUT', 'o motivo original do logout não pode ser sobrescrito pela inativação subsequente');
  });

  test('UPDATE em administradores_plataforma que não muda "ativo" não dispara o trigger nem toca sessões', async () => {
    const administradorId = await inserirAdministrador(contexto.cliente, 'sem-mudanca@safework.com.br');
    const agora = new Date();
    const sessao = await inserirSessao(contexto.cliente, { administradorId, tokenHash: '7'.repeat(64), criadoEm: agora, expiraEm: new Date(agora.getTime() + 3600_000) });

    await contexto.cliente.query("UPDATE administradores_plataforma SET email = lower(email) WHERE id = $1", [administradorId]);

    const { rows } = await contexto.cliente.query('SELECT revogada_em FROM sessoes_plataforma WHERE id = $1', [sessao.id]);
    assert.equal(rows[0].revogada_em, null, 'uma atualização que não mexe em "ativo" não pode revogar sessão alguma');
  });
});

describe('estrutura declarada na migration 031 (sem banco)', () => {
  test('a migration 031 existe, é aditiva (só ALTER/CREATE INDEX/CREATE TRIGGER) e não redefine as tabelas 027/028/029', () => {
    assert.equal(migrationExiste('031'), true, 'migrations/031_*.sql deve existir');
    const sql = conteudoDaMigration('031');
    assert.doesNotMatch(sql, /CREATE TABLE/i, '031 é aditiva: não cria tabela nenhuma');
    assert.match(sql, /ALTER TABLE sessoes_plataforma/i);
    assert.match(sql, /ALTER TABLE logs_auditoria_plataforma/i);
    assert.match(sql, /CREATE INDEX idx_sessoes_plataforma_expira_em/i);
    assert.match(sql, /CREATE TRIGGER trg_administradores_plataforma_revogar_sessoes_ao_inativar/i);
    assert.match(sql, /WHEN \(OLD\.ativo = true AND NEW\.ativo = false\)/i);
  });
});
