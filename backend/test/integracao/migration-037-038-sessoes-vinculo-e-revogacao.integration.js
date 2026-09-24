'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migrations 037 (sessoes.sessao_global_id) e 038 (triggers de revogação
 * ao inativar usuário/empresa) — Pacote 4. PostgreSQL real, schema
 * temporário exclusivo; a 013 continua intocada (só ALTER aditivo e
 * triggers).
 */

const MIGRATIONS = ['000', '001', '002', '005', '013', '025', '035', '037', '038'];
const VIOLACAO_FK = '23503';

describe('migrations 037 e 038', () => {
  let contexto;
  let c;
  let empresaA;
  let empresaB;
  let identidade;
  let uA;
  let uB;

  const sessaoEmpresarial = async (empresaId, usuarioId, hash, sessaoGlobalId = null) => {
    const { rows } = await c.query(
      "INSERT INTO sessoes (empresa_id, usuario_id, token_hash, expira_em, sessao_global_id) VALUES ($1, $2, $3, now() + interval '1 hour', $4) RETURNING id",
      [empresaId, usuarioId, hash, sessaoGlobalId],
    );
    return rows[0].id;
  };
  const estado = async (id) => (await c.query('SELECT revogada_em IS NOT NULL AS revogada, motivo_revogacao AS motivo, sessao_global_id FROM sessoes WHERE id = $1', [id])).rows[0];

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    c = contexto.cliente;
    await inserirEmpresa(c, '11222333000181', 'A');
    await inserirEmpresa(c, '22333444000100', 'B');
    const { rows: e } = await c.query('SELECT id FROM empresas ORDER BY id');
    [empresaA, empresaB] = [e[0].id, e[1].id];
    identidade = (await c.query("INSERT INTO identidades (email, senha_hash) VALUES ('p@x.com', 'h') RETURNING id")).rows[0].id;
    const usuario = async (empresaId) => (await c.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'n', NULL, NULL, 'USUARIO', $2) RETURNING id", [empresaId, identidade])).rows[0].id;
    uA = await usuario(empresaA);
    uB = await usuario(empresaB);
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('037: sessao_global_id é opcional (login legado grava NULL), aponta para sessoes_globais (FK) e vira NULL se a sessão global for apagada (SET NULL numa FK de UMA coluna: empresa_id/usuario_id intactos)', async () => {
    const semGlobal = await sessaoEmpresarial(empresaA, uA, '0'.repeat(64));
    assert.equal((await estado(semGlobal)).sessao_global_id, null);

    await assert.rejects(() => sessaoEmpresarial(empresaA, uA, '1'.repeat(64), '999999'), (e) => e.code === VIOLACAO_FK);

    const { rows: g } = await c.query("INSERT INTO sessoes_globais (identidade_id, token_hash, expira_em) VALUES ($1, $2, now() + interval '1 hour') RETURNING id", [identidade, '2'.repeat(64)]);
    const comGlobal = await sessaoEmpresarial(empresaA, uA, '3'.repeat(64), g[0].id);
    assert.equal((await estado(comGlobal)).sessao_global_id, g[0].id);

    await c.query('DELETE FROM sessoes_globais WHERE id = $1', [g[0].id]);
    const { rows: depois } = await c.query('SELECT empresa_id, usuario_id, sessao_global_id FROM sessoes WHERE id = $1', [comGlobal]);
    assert.deepEqual(depois[0], { empresa_id: empresaA, usuario_id: uA, sessao_global_id: null });

    const { rows: idx } = await c.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'sessoes' AND indexname = 'idx_sessoes_sessao_global_id_nao_revogadas'", [contexto.schema]);
    assert.equal(idx.length, 1);
  });

  test('038: inativar o vínculo revoga (USUARIO_INATIVADO) só as sessões daquele vínculo; reativar não restaura', async () => {
    const sA = await sessaoEmpresarial(empresaA, uA, '4'.repeat(64));
    const sB = await sessaoEmpresarial(empresaB, uB, '5'.repeat(64));

    await c.query('UPDATE usuarios SET ativo = false WHERE id = $1', [uA]);
    assert.deepEqual([(await estado(sA)).revogada, (await estado(sA)).motivo], [true, 'USUARIO_INATIVADO']);
    assert.equal((await estado(sB)).revogada, false, 'o vínculo em B não é afetado');

    await c.query('UPDATE usuarios SET ativo = true WHERE id = $1', [uA]);
    assert.equal((await estado(sA)).revogada, true, 'reativar não restaura a sessão revogada');
    // Atualização que NÃO é transição true->false não dispara nada.
    const sA2 = await sessaoEmpresarial(empresaA, uA, '6'.repeat(64));
    await c.query("UPDATE usuarios SET nome = 'outro' WHERE id = $1", [uA]);
    assert.equal((await estado(sA2)).revogada, false);
  });

  test('038: suspender a empresa revoga (EMPRESA_INATIVADA) todas as sessões dela e nenhuma de outra empresa; a sessão global da pessoa não é tocada', async () => {
    const { rows: g } = await c.query("INSERT INTO sessoes_globais (identidade_id, token_hash, expira_em) VALUES ($1, $2, now() + interval '1 hour') RETURNING id", [identidade, '7'.repeat(64)]);
    const sB1 = await sessaoEmpresarial(empresaB, uB, '8'.repeat(64), g[0].id);
    const sA = await sessaoEmpresarial(empresaA, uA, '9'.repeat(64), g[0].id);

    await c.query('UPDATE empresas SET ativo = false WHERE id = $1', [empresaB]);
    assert.deepEqual([(await estado(sB1)).revogada, (await estado(sB1)).motivo], [true, 'EMPRESA_INATIVADA']);
    assert.equal((await estado(sA)).revogada, false);
    const { rows: global } = await c.query('SELECT revogada_em FROM sessoes_globais WHERE id = $1', [g[0].id]);
    assert.equal(global[0].revogada_em, null);

    await c.query('UPDATE empresas SET ativo = true WHERE id = $1', [empresaB]);
    assert.equal((await estado(sB1)).revogada, true, 'reativar a empresa não restaura sessões');
  });
});

describe('estrutura declarada (sem banco)', () => {
  test('037 e 038 existem e declaram o essencial; 013 permanece a referência da tabela', () => {
    assert.equal(migrationExiste('037'), true);
    assert.equal(migrationExiste('038'), true);
    const m37 = conteudoDaMigration('037').replace(/^--.*$/gm, '');
    assert.match(m37, /ALTER TABLE sessoes\s+ADD COLUMN sessao_global_id BIGINT REFERENCES sessoes_globais\(id\) ON DELETE SET NULL/);
    assert.doesNotMatch(m37, /DROP|SET NOT NULL|BIGINT NOT NULL/);
    const m38 = conteudoDaMigration('038').replace(/^--.*$/gm, '');
    assert.match(m38, /trg_usuarios_revogar_sessoes_ao_inativar/);
    assert.match(m38, /trg_empresas_revogar_sessoes_ao_inativar/);
    assert.doesNotMatch(m38, /ALTER TABLE/);
  });
});
