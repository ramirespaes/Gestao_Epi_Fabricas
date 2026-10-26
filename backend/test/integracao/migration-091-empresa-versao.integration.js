'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');

/**
 * Migration 091 (Dados da Empresa, F1) em PostgreSQL real, schema temporário com todas as migrations: colunas novas,
 * CHECKs e o gatilho de versão (só avança quando um valor cadastral muda; o cliente nunca a define).
 */
describe('migration 091 — e-mails de SST/Almoxarifado e versão do cadastro (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let n = 0;
  before(async () => { contexto = await abrirPoolTemporario(todasAsMigrations()); pool = contexto.pool; });
  after(async () => { if (contexto) await contexto.encerrar(); });

  const cnpj = () => { n += 1; return String(11000000000000 + n).padStart(14, '0'); };
  const nova = async () => (await pool.query('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING *', [`Empresa ${n}`, cnpj()])).rows[0];
  const ler = async (id) => (await pool.query('SELECT * FROM empresas WHERE id = $1', [id])).rows[0];

  test('empresa nova nasce com versão 1 e e-mails nulos; as colunas têm o tipo previsto', async () => {
    const e = await nova();
    assert.equal(e.versao, 1);
    assert.equal(e.email_sst, null);
    assert.equal(e.email_almoxarifado, null);
    const { rows } = await pool.query(
      "SELECT column_name, data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = 'empresas' AND column_name IN ('email_sst', 'email_almoxarifado', 'versao') ORDER BY column_name",
    );
    assert.deepEqual(rows.map((r) => [r.column_name, r.data_type, r.character_maximum_length, r.is_nullable]), [
      ['email_almoxarifado', 'character varying', 150, 'YES'],
      ['email_sst', 'character varying', 150, 'YES'],
      ['versao', 'integer', null, 'NO'],
    ]);
  });

  test('mudar um valor cadastral avança a versão em 1; vários campos no mesmo UPDATE também avançam só 1', async () => {
    const e = await nova();
    await pool.query("UPDATE empresas SET telefone = '1140000000' WHERE id = $1", [e.id]);
    assert.equal((await ler(e.id)).versao, 2);
    await pool.query("UPDATE empresas SET email_sst = 'sst@e.com', email_almoxarifado = 'alm@e.com', cidade = 'SP' WHERE id = $1", [e.id]);
    assert.equal((await ler(e.id)).versao, 3);
  });

  test('UPDATE sem mudança de valor não avança a versão (nem pela razão social ou pelo estado `ativo`: eles também são cadastro)', async () => {
    const e = await nova();
    await pool.query("UPDATE empresas SET telefone = NULL, nome = nome WHERE id = $1", [e.id]);
    assert.equal((await ler(e.id)).versao, 1);
    await pool.query('UPDATE empresas SET ativo = false WHERE id = $1', [e.id]);
    assert.equal((await ler(e.id)).versao, 2, 'inativar altera o cadastro e conta como alteração (o Painel também passa pelo gatilho)');
  });

  test('o cliente não consegue definir a versão: valor enviado é sobrescrito pelo gatilho', async () => {
    const e = await nova();
    await pool.query("UPDATE empresas SET versao = 99, telefone = '1' WHERE id = $1", [e.id]);
    assert.equal((await ler(e.id)).versao, 2);
    await pool.query('UPDATE empresas SET versao = 50 WHERE id = $1', [e.id]);
    assert.equal((await ler(e.id)).versao, 2, 'sem mudança cadastral, mesmo versao=50 explícito mantém a versão');
  });

  test('a versão é monotônica: dez alterações seguidas somam dez', async () => {
    const e = await nova();
    for (let i = 0; i < 10; i += 1) await pool.query('UPDATE empresas SET telefone = $2 WHERE id = $1', [e.id, `11${i}`]);
    assert.equal((await ler(e.id)).versao, 11);
  });

  test('CHECKs: versão ≥ 1; e-mail vazio ou acima de 150 recusados; NULL aceito', async () => {
    const e = await nova();
    // No UPDATE o gatilho neutraliza qualquer versão enviada; o CHECK é a barreira do INSERT.
    await assert.rejects(pool.query('INSERT INTO empresas (nome, cnpj, versao) VALUES ($1, $2, 0)', ['Sem versão', cnpj()]), (err) => err.code === '23514');
    await pool.query('UPDATE empresas SET versao = 0 WHERE id = $1', [e.id]);
    assert.equal((await ler(e.id)).versao, 1);
    await assert.rejects(pool.query("UPDATE empresas SET email_sst = '' WHERE id = $1", [e.id]), (err) => err.code === '23514');
    await assert.rejects(pool.query('UPDATE empresas SET email_almoxarifado = $2 WHERE id = $1', [e.id, `${'a'.repeat(150)}@x.com`]), (err) => err.code === '22001');
    await pool.query("UPDATE empresas SET email_sst = 'a@b.co' WHERE id = $1", [e.id]);
    await pool.query('UPDATE empresas SET email_sst = NULL WHERE id = $1', [e.id]);
  });

  test('reversível: o desfazer documentado remove só o que a 091 criou, sem perder os demais dados (feito numa transação revertida)', async () => {
    const e = await nova();
    await pool.query("UPDATE empresas SET telefone = '1140', email_sst = 'sst@e.com' WHERE id = $1", [e.id]);
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query('DROP TRIGGER trg_empresas_controlar_versao ON empresas');
      await cliente.query('DROP FUNCTION empresas_controlar_versao()');
      await cliente.query('ALTER TABLE empresas DROP CONSTRAINT chk_empresas_email_sst, DROP CONSTRAINT chk_empresas_email_almoxarifado, DROP CONSTRAINT chk_empresas_versao');
      await cliente.query('ALTER TABLE empresas DROP COLUMN email_sst, DROP COLUMN email_almoxarifado, DROP COLUMN versao');
      const { rows } = await cliente.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'empresas' AND column_name IN ('email_sst', 'email_almoxarifado', 'versao')");
      assert.deepEqual(rows, []);
      const restante = (await cliente.query('SELECT nome, cnpj, telefone FROM empresas WHERE id = $1', [e.id])).rows[0];
      assert.equal(restante.telefone, '1140');
      assert.equal(restante.cnpj, e.cnpj);
      await cliente.query("UPDATE empresas SET telefone = '1141' WHERE id = $1", [e.id]);
    } finally {
      await cliente.query('ROLLBACK');
      cliente.release();
    }
    assert.equal((await ler(e.id)).versao, 2, 'depois do ROLLBACK a 091 está intacta');
  });

  test('atualizado_em continua sendo mantido pelo gatilho existente e a empresa existente não perde dado', async () => {
    const e = await nova();
    const antes = (await ler(e.id)).atualizado_em;
    await pool.query("UPDATE empresas SET telefone = '1' WHERE id = $1", [e.id]);
    assert.ok((await ler(e.id)).atualizado_em >= antes);
    assert.equal((await ler(e.id)).cnpj, e.cnpj);
  });
});
