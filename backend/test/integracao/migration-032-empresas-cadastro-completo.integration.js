'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 032 — campos cadastrais completos de empresas (Pacote 3).
 * PostgreSQL real, schema temporário. Aditiva sobre 001/016.
 */

const VIOLACAO_CHECK = '23514';

describe('migration 032 — empresas: cadastro completo', () => {
  let contexto;
  before(async () => { contexto = await abrirSchemaTemporario(['000', '001', '016', '032']); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('todas as colunas novas existem e são nuláveis; as antigas permanecem', async () => {
    const { rows } = await contexto.cliente.query(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'empresas'",
      [contexto.schema],
    );
    const porNome = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
    for (const nova of ['nome_fantasia', 'inscricao_estadual', 'situacao_inscricao_estadual', 'numero', 'complemento', 'bairro',
      'representante_nome', 'representante_cargo', 'representante_email', 'representante_telefone',
      'financeiro_nome', 'financeiro_email', 'financeiro_telefone']) {
      assert.equal(porNome[nova], 'YES', `${nova} deve existir e ser nulável`);
    }
    for (const antiga of ['nome', 'cnpj', 'ativo']) {
      assert.equal(porNome[antiga], 'NO', `${antiga} preservada como NOT NULL`);
    }
    for (const antiga of ['cidade', 'uf', 'cep', 'endereco', 'telefone', 'email', 'dpo_nome', 'dpo_email', 'dpo_tel']) {
      assert.ok(antiga in porNome, `${antiga} preservada`);
    }
  });

  test('empresa cadastrada só com nome e CNPJ continua válida: nenhuma coluna nova é obrigatória; IE nasce NULL, nunca "ISENTO"', async () => {
    assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Mínima'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT inscricao_estadual, situacao_inscricao_estadual, nome_fantasia FROM empresas LIMIT 1');
    assert.deepEqual(rows[0], { inscricao_estadual: null, situacao_inscricao_estadual: null, nome_fantasia: null });
  });

  test('situacao_inscricao_estadual: só formato [A-Z_]{1,30} (nunca lista fechada no banco)', async () => {
    for (const ok of ['CONTRIBUINTE', 'ISENTO', 'NAO_CONTRIBUINTE', 'ROTULO_NOVO']) {
      await contexto.cliente.query("UPDATE empresas SET situacao_inscricao_estadual = $1", [ok]);
    }
    const erro = await contexto.cliente.query("UPDATE empresas SET situacao_inscricao_estadual = 'isento'").catch((e) => e);
    assert.equal(erro.code, VIOLACAO_CHECK);
  });

  test('CNPJ alfanumérico (016) continua aceito após a 032', async () => {
    assert.equal(await inserirEmpresa(contexto.cliente, '12ABC345GH0199', 'Alfa'), 'ok');
  });

  test('a migration 032 é aditiva: nenhum DROP, RENAME ou ALTER COLUMN', () => {
    assert.equal(migrationExiste('032'), true);
    const sql = conteudoDaMigration('032');
    assert.doesNotMatch(sql, /DROP |RENAME |ALTER COLUMN/i);
    assert.match(sql, /ADD COLUMN nome_fantasia/i);
    assert.match(sql, /ADD COLUMN inscricao_estadual/i);
    assert.match(sql, /ADD COLUMN financeiro_email/i);
  });
});
