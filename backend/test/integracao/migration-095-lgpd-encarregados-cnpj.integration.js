'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const { todasAsMigrations, criarEmpresa, criarUsuario } = require('./helpers/entrega-epi');

/**
 * Migration 095 — CNPJ do encarregado (DPO) pessoa jurídica. PostgreSQL real, schema temporário. Aditiva sobre a 094: uma
 * coluna nula, dois CHECKs e o gatilho de histórico com o CNPJ entre os dados imutáveis. Linhas anteriores (PJ sem CNPJ) ficam
 * exatamente como estavam; a obrigatoriedade para PJ novo é da aplicação, não do banco.
 */

const TODAS = todasAsMigrations();
const ATE_A_094 = TODAS.filter((prefixo) => prefixo <= '094');
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';
const CNPJ = '12345678000195'; // fictício
const CNPJ_2 = '98765432000198'; // fictício

function exigirMigration095() {
  assert.equal(migrationExiste('095'), true, 'migration 095 ainda não implementada');
}

async function cenario(c) {
  const empresaId = await criarEmpresa(c, '11222333000181', 'Empresa Migration 095');
  const usuarioId = await criarUsuario(c, empresaId, 'master095@example.invalid');
  return { empresaId, usuarioId };
}

const inserirPj = (c, d, extra = {}) => c.query(
  `INSERT INTO lgpd_encarregados (empresa_id, funcao, tipo_pessoa, nome, razao_social, cnpj, vinculo, email, inicio_em, designado_por)
   VALUES ($1, $2, 'PJ', 'Resp Teste', 'Prestadora Teste Ltda', $3, 'EXTERNO', 'dpo@example.invalid', '2026-09-01', $4) RETURNING *`,
  [d.empresaId, extra.funcao ?? 'SUBSTITUTO', extra.cnpj ?? null, d.usuarioId],
);

describe('migration 095 — uma base na 094 recebe a 095 sem mudar nenhuma linha', () => {
  let contexto;
  before(async () => { exigirMigration095(); contexto = await abrirSchemaTemporario(ATE_A_094); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('designações PF e PJ existentes ficam iguais; a coluna nova nasce nula; o gatilho continua o mesmo objeto', async () => {
    const c = contexto.cliente;
    const d = await cenario(c);
    await c.query(
      "INSERT INTO lgpd_encarregados (empresa_id, funcao, tipo_pessoa, nome, vinculo, email, inicio_em, designado_por) VALUES ($1, 'PRINCIPAL', 'PF', 'Ana PF', 'INTERNO', 'ana@example.invalid', '2026-08-01', $2)",
      [d.empresaId, d.usuarioId],
    );
    await c.query(
      "INSERT INTO lgpd_encarregados (empresa_id, funcao, tipo_pessoa, nome, razao_social, vinculo, email, inicio_em, designado_por) VALUES ($1, 'SUBSTITUTO', 'PJ', 'Bruno PJ', 'Legado Ltda', 'EXTERNO', 'bruno@example.invalid', '2026-09-01', $2)",
      [d.empresaId, d.usuarioId],
    );
    const antes = (await c.query('SELECT * FROM lgpd_encarregados ORDER BY id')).rows;
    assert.equal(antes.length, 2);
    assert.equal('cnpj' in antes[0], false, 'antes da 095 não existe a coluna');

    await c.query(conteudoDaMigration('095'));

    const depois = (await c.query('SELECT * FROM lgpd_encarregados ORDER BY id')).rows;
    assert.deepEqual(depois.map(({ cnpj, ...resto }) => { assert.equal(cnpj, null); return resto; }), antes, 'nenhuma linha muda; cnpj nasce nulo');
    const gatilhos = (await c.query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'lgpd_encarregados'::regclass AND NOT tgisinternal ORDER BY 1")).rows.map((r) => r.tgname);
    assert.deepEqual(gatilhos, ['trg_lgpd_encarregados_atualizado_em', 'trg_lgpd_encarregados_proteger_historico']);
  });
});

describe('migration 095 — estrutura e regras no banco', () => {
  let contexto;
  let d;
  const q = (sql, params) => contexto.cliente.query(sql, params);
  const codigo = (p) => p.then(() => null, (e) => e.code);
  before(async () => { exigirMigration095(); contexto = await abrirSchemaTemporario(TODAS); d = await cenario(contexto.cliente); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('coluna cnpj CHAR(14) nula, sem default, sem unicidade; os dois CHECKs existem com a definição esperada', async () => {
    const col = (await q("SELECT data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'lgpd_encarregados' AND column_name = 'cnpj'")).rows[0];
    assert.deepEqual(col, { data_type: 'character', character_maximum_length: 14, is_nullable: 'YES', column_default: null });
    const checks = (await q("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'lgpd_encarregados'::regclass AND conname LIKE 'chk_lgpd_encarregados_cnpj%' ORDER BY 1")).rows;
    assert.deepEqual(checks.map((r) => r.conname), ['chk_lgpd_encarregados_cnpj_formato', 'chk_lgpd_encarregados_cnpj_pf']);
    assert.match(checks[0].def, /\^\[0-9A-Z\]\{12\}\[0-9\]\{2\}\$/);
    assert.equal((await q("SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'lgpd_encarregados' AND indexdef ILIKE '%cnpj%'")).rows[0].n, 0, 'sem índice/unicidade por CNPJ');
  });

  test('PJ com CNPJ canônico aceito; PJ sem CNPJ aceito (legado); PF com CNPJ recusado; formato com máscara, minúsculas ou curto recusado', async () => {
    const { rows: [pj] } = await inserirPj(contexto.cliente, d, { cnpj: CNPJ });
    assert.equal(pj.cnpj, CNPJ);
    const { rows: [legado] } = await inserirPj(contexto.cliente, d, { funcao: 'PRINCIPAL' });
    assert.equal(legado.cnpj, null);
    assert.equal(await codigo(q(
      "INSERT INTO lgpd_encarregados (empresa_id, funcao, tipo_pessoa, nome, cnpj, vinculo, email, inicio_em, designado_por) VALUES ($1, 'PRINCIPAL', 'PF', 'X', $2, 'INTERNO', 'x@example.invalid', '2026-09-01', $3)",
      [d.empresaId, CNPJ, d.usuarioId],
    )), VIOLACAO_CHECK, 'PF nunca tem CNPJ');
    // Valores de até 14 posições (um valor mais longo é recusado antes, pelo CHAR(14), com 22001).
    for (const ruim of ['12.345.678/001', '1234567800019a', '1234567800019', '123456780001AB']) {
      await q("UPDATE lgpd_encarregados SET fim_em = '2026-09-02', situacao = 'ENCERRADA', motivo_encerramento = 'ENCERRAMENTO', encerrado_por = $2 WHERE id = $1 AND fim_em IS NULL", [pj.id, d.usuarioId]).catch(() => null);
      assert.equal(await codigo(q(
        "INSERT INTO lgpd_encarregados (empresa_id, funcao, tipo_pessoa, nome, razao_social, cnpj, vinculo, email, inicio_em, designado_por) VALUES ($1, 'SUBSTITUTO', 'PJ', 'X', 'Y', $2, 'INTERNO', 'x@example.invalid', '2026-09-03', $3)",
        [d.empresaId, ruim, d.usuarioId],
      )), VIOLACAO_CHECK, ruim);
    }
    assert.equal((await q('SELECT count(*)::int AS n FROM lgpd_encarregados WHERE empresa_id = $1', [d.empresaId])).rows[0].n, 2);
  });

  test('gatilho: o CNPJ de uma vigente não muda por UPDATE (nem para completar, nem para trocar); a encerrada continua imutável', async () => {
    const { rows: [vigente] } = await q('SELECT * FROM lgpd_encarregados WHERE empresa_id = $1 AND fim_em IS NULL ORDER BY id', [d.empresaId]);
    assert.equal(vigente.cnpj, null);
    assert.equal(await codigo(q('UPDATE lgpd_encarregados SET cnpj = $2 WHERE id = $1', [vigente.id, CNPJ_2])), RECUSA_DO_TRIGGER, 'completar por UPDATE direto é recusado: só por nova versão (CORRECAO)');
    const { rows: [encerrada] } = await q('SELECT * FROM lgpd_encarregados WHERE empresa_id = $1 AND fim_em IS NOT NULL ORDER BY id', [d.empresaId]);
    assert.equal(await codigo(q('UPDATE lgpd_encarregados SET cnpj = NULL WHERE id = $1', [encerrada.id])), RECUSA_DO_TRIGGER);
    assert.equal(await codigo(q('DELETE FROM lgpd_encarregados WHERE id = $1', [encerrada.id])), RECUSA_DO_TRIGGER);
  });
});
