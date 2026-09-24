'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 035 — sessoes_globais (Pacote 4). PostgreSQL real, schema
 * temporário exclusivo. Mesmo contrato de 013/028: só o hash do token;
 * SEM empresa_id/usuario_id; e o trigger de inativação da identidade
 * revoga, com motivo, a sessão global E as sessões empresariais (013) dos
 * vínculos daquela identidade.
 */

const MIGRATIONS = ['000', '001', '002', '005', '013', '025', '035'];
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const VIOLACAO_FK = '23503';

async function inserirIdentidade(cliente, email) {
  const { rows } = await cliente.query('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, 'hash-ficticio']);
  return rows[0].id;
}

async function inserirSessaoGlobal(cliente, { identidadeId, tokenHash, expiraEm = "now() + interval '1 hour'", extra = '' }) {
  try {
    const { rows } = await cliente.query(
      `INSERT INTO sessoes_globais (identidade_id, token_hash, expira_em${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1, $2, ${expiraEm}${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`,
      [identidadeId, tokenHash],
    );
    return { ok: true, id: rows[0].id };
  } catch (erro) {
    return { ok: false, code: erro.code };
  }
}

describe('migration 035 — sessoes_globais', () => {
  let contexto;
  let identidadeId;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    identidadeId = await inserirIdentidade(contexto.cliente, 'pessoa@exemplo-cliente.com.br');
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cria sessão global com sucesso; token_hash precisa ser SHA-256 hex minúsculo e único', async () => {
    assert.equal((await inserirSessaoGlobal(contexto.cliente, { identidadeId, tokenHash: 'a'.repeat(64) })).ok, true);
    for (const ruim of ['A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
      const r = await inserirSessaoGlobal(contexto.cliente, { identidadeId, tokenHash: ruim });
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], ruim);
    }
    const repetida = await inserirSessaoGlobal(contexto.cliente, { identidadeId, tokenHash: 'a'.repeat(64) });
    assert.deepEqual([repetida.ok, repetida.code], [false, VIOLACAO_UNIQUE]);
  });

  test('identidade inexistente é recusada pela FK; expira_em precisa ser posterior a criado_em; revogação exige motivo (e vice-versa)', async () => {
    const fk = await inserirSessaoGlobal(contexto.cliente, { identidadeId: 999999, tokenHash: 'b'.repeat(64) });
    assert.deepEqual([fk.ok, fk.code], [false, VIOLACAO_FK]);
    const passado = await inserirSessaoGlobal(contexto.cliente, { identidadeId, tokenHash: 'c'.repeat(64), expiraEm: "now() - interval '1 minute'" });
    assert.deepEqual([passado.ok, passado.code], [false, VIOLACAO_CHECK]);

    const ok = await inserirSessaoGlobal(contexto.cliente, { identidadeId, tokenHash: 'd'.repeat(64) });
    for (const sql of [
      'UPDATE sessoes_globais SET revogada_em = now() WHERE id = $1',
      "UPDATE sessoes_globais SET motivo_revogacao = 'LOGOUT' WHERE id = $1",
      "UPDATE sessoes_globais SET revogada_em = now(), motivo_revogacao = 'logout' WHERE id = $1",
    ]) {
      await assert.rejects(() => contexto.cliente.query(sql, [ok.id]), (e) => e.code === VIOLACAO_CHECK, sql);
    }
    await contexto.cliente.query("UPDATE sessoes_globais SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [ok.id]);
  });

  test('nenhuma coluna empresa_id/usuario_id; índices parciais/expira_em existem', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'sessoes_globais' AND column_name IN ('empresa_id', 'usuario_id')",
      [contexto.schema],
    );
    assert.equal(rows.length, 0);
    const { rows: idx } = await contexto.cliente.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'sessoes_globais' ORDER BY indexname",
      [contexto.schema],
    );
    const nomes = idx.map((i) => i.indexname);
    assert.ok(nomes.includes('idx_sessoes_globais_identidade_id_nao_revogadas'));
    assert.ok(nomes.includes('idx_sessoes_globais_expira_em'));
  });

  test('trigger: inativar a identidade revoga (IDENTIDADE_INATIVADA) a sessão global E as sessões empresariais dos vínculos dela, em todas as empresas; outras identidades intactas', async () => {
    const c = contexto.cliente;
    await inserirEmpresa(c, '11222333000181', 'A');
    await inserirEmpresa(c, '22333444000100', 'B');
    const { rows: e } = await c.query('SELECT id FROM empresas ORDER BY id');
    const alvo = await inserirIdentidade(c, 'alvo@exemplo-cliente.com.br');
    const outra = await inserirIdentidade(c, 'outra@exemplo-cliente.com.br');
    const usuario = async (empresaId, identidade) => {
      const { rows } = await c.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'n', NULL, NULL, 'USUARIO', $2) RETURNING id", [empresaId, identidade]);
      return rows[0].id;
    };
    const uAlvoA = await usuario(e[0].id, alvo);
    const uAlvoB = await usuario(e[1].id, alvo);
    const uOutraA = await usuario(e[0].id, outra);
    const sessao = async (empresaId, usuarioId, hash) => c.query("INSERT INTO sessoes (empresa_id, usuario_id, token_hash, expira_em) VALUES ($1, $2, $3, now() + interval '1 hour')", [empresaId, usuarioId, hash]);
    await sessao(e[0].id, uAlvoA, '1'.repeat(64));
    await sessao(e[1].id, uAlvoB, '2'.repeat(64));
    await sessao(e[0].id, uOutraA, '3'.repeat(64));
    const gAlvo = await inserirSessaoGlobal(c, { identidadeId: alvo, tokenHash: '4'.repeat(64) });
    const gOutra = await inserirSessaoGlobal(c, { identidadeId: outra, tokenHash: '5'.repeat(64) });

    await c.query('UPDATE identidades SET ativo = false WHERE id = $1', [alvo]);

    const { rows: globais } = await c.query('SELECT id, revogada_em IS NOT NULL AS revogada, motivo_revogacao FROM sessoes_globais WHERE id IN ($1, $2) ORDER BY id', [gAlvo.id, gOutra.id]);
    assert.deepEqual(globais.map((g) => [g.revogada, g.motivo_revogacao]), [[true, 'IDENTIDADE_INATIVADA'], [false, null]]);
    const { rows: empresariais } = await c.query('SELECT token_hash, revogada_em IS NOT NULL AS revogada, motivo_revogacao FROM sessoes ORDER BY token_hash');
    assert.deepEqual(empresariais.map((s) => [s.token_hash[0], s.revogada, s.motivo_revogacao]), [['1', true, 'IDENTIDADE_INATIVADA'], ['2', true, 'IDENTIDADE_INATIVADA'], ['3', false, null]]);

    // Reativar NÃO restaura nada: as linhas continuam revogadas.
    await c.query('UPDATE identidades SET ativo = true WHERE id = $1', [alvo]);
    const { rows: depois } = await c.query('SELECT count(*)::int AS total FROM sessoes WHERE revogada_em IS NOT NULL');
    assert.equal(depois[0].total, 2);
  });
});

describe('estrutura declarada na migration 035 (sem banco)', () => {
  test('existe e declara o essencial', () => {
    assert.equal(migrationExiste('035'), true);
    const sql = conteudoDaMigration('035');
    assert.match(sql, /CREATE TABLE sessoes_globais/);
    assert.match(sql, /identidade_id\s+INTEGER NOT NULL REFERENCES identidades\(id\) ON DELETE CASCADE/);
    assert.match(sql, /token_hash\s+CHAR\(64\) NOT NULL/);
    assert.match(sql, /trg_identidades_revogar_sessoes_ao_inativar/);
    const tabela = sql.slice(sql.indexOf('CREATE TABLE sessoes_globais'), sql.indexOf(');', sql.indexOf('CREATE TABLE sessoes_globais')));
    assert.doesNotMatch(tabela, /empresa_id|usuario_id/);
  });
});
