'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const {
  VIOLACAO_NAO_NULO, VIOLACAO_CHECK, todasAsMigrations, erroDe, constraintsDe, indicesDe, colunasDe, tabelaExiste,
} = require('./helpers/recuperacao-senha');

/**
 * Migration 063 — recuperacao_senha_solicitacoes: controle persistente do
 * limite de solicitações de recuperação por e-mail. A linha guarda só a
 * chave HMAC e o escopo; não há e-mail, conta nem resultado do envio, para
 * que a tabela nunca revele se um e-mail tem conta. PostgreSQL real, schema
 * temporário com todas as migrations do diretório.
 */

const TABELA = 'recuperacao_senha_solicitacoes';
const chave = () => crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');

describe('migration 063 — recuperacao_senha_solicitacoes', () => {
  let contexto;
  let c;

  const inserir = (valores) => {
    const colunas = Object.keys(valores);
    return c.query(
      `INSERT INTO ${TABELA} (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(valores),
    );
  };

  before(async () => {
    contexto = await abrirSchemaTemporario(todasAsMigrations());
    c = contexto.cliente;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('a migration existe e cria a tabela com colunas, constraints e índices esperados', async () => {
    assert.equal(migrationExiste('063'), true, 'arquivo da migration 063');
    assert.equal(await tabelaExiste(c, TABELA), true, `tabela ${TABELA}`);
    assert.deepEqual(await colunasDe(c, contexto.schema, TABELA), ['id', 'escopo', 'chave', 'criado_em', 'ip', 'dispositivo']);
    assert.deepEqual((await constraintsDe(c, contexto.schema, TABELA)).sort(), [
      `chk_${TABELA}_chave_formato`,
      `chk_${TABELA}_escopo`,
      `${TABELA}_pkey`,
    ].sort());
    assert.deepEqual((await indicesDe(c, contexto.schema, TABELA)).sort(), [
      `idx_${TABELA}_criado_em`,
      `idx_${TABELA}_escopo_chave_criado_em`,
      `${TABELA}_pkey`,
    ].sort());
  });

  test('nada na estrutura revela conta: sem e-mail em claro, sem FK, sem identidade, administrador ou resultado do envio', async () => {
    const { rows: fks } = await c.query("SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'", [TABELA]);
    assert.deepEqual(fks, [], 'nenhuma FK: a linha não aponta para conta alguma');
    const colunas = await colunasDe(c, contexto.schema, TABELA);
    for (const proibida of ['email', 'identidade_id', 'administrador_id', 'usuario_id', 'conta_existe', 'enviado', 'enviada', 'sucesso', 'motivo']) {
      assert.equal(colunas.includes(proibida), false, proibida);
    }
    const sql = conteudoDaMigration('063').replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /REFERENCES/i);
    assert.doesNotMatch(sql, /\bemail\b/i);
  });

  test('escopo: só PORTAL e PLATAFORMA, obrigatório', async () => {
    for (const escopo of ['PORTAL', 'PLATAFORMA']) {
      const { rows } = await inserir({ escopo, chave: chave() });
      assert.equal(rows[0].escopo, escopo);
      assert.ok(rows[0].criado_em instanceof Date);
    }
    for (const escopo of ['portal', 'CLIENTE', 'ADMIN', '']) {
      const erro = await erroDe(inserir({ escopo, chave: chave() }));
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, `chk_${TABELA}_escopo`], escopo);
    }
    const semEscopo = await erroDe(inserir({ chave: chave() }));
    assert.equal(semEscopo?.code, VIOLACAO_NAO_NULO);
  });

  test('chave: só HMAC-SHA-256 em hexadecimal minúsculo de 64 caracteres, obrigatória; um e-mail nunca cabe no formato', async () => {
    for (const valor of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`, 'pessoa@example.invalid']) {
      const erro = await erroDe(inserir({ escopo: 'PORTAL', chave: valor }));
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, `chk_${TABELA}_chave_formato`], valor);
    }
    const semChave = await erroDe(inserir({ escopo: 'PORTAL' }));
    assert.equal(semChave?.code, VIOLACAO_NAO_NULO);
  });

  test('a mesma chave pode repetir (é contagem por janela) e os escopos não se misturam', async () => {
    const k = chave();
    await inserir({ escopo: 'PORTAL', chave: k });
    await inserir({ escopo: 'PORTAL', chave: k });
    await inserir({ escopo: 'PORTAL', chave: k });
    await inserir({ escopo: 'PLATAFORMA', chave: k });
    const contar = async (escopo, janela) => (await c.query(
      `SELECT count(*)::int AS n FROM ${TABELA} WHERE escopo = $1 AND chave = $2 AND criado_em > now() - $3::interval`, [escopo, k, janela],
    )).rows[0].n;
    assert.deepEqual([await contar('PORTAL', '1 hour'), await contar('PLATAFORMA', '1 hour')], [3, 1]);
  });

  test('janela de uma hora: solicitação antiga sai da contagem; o índice (escopo, chave, criado_em) atende a consulta', async () => {
    const k = chave();
    await c.query(`INSERT INTO ${TABELA} (escopo, chave, criado_em) VALUES ('PORTAL', $1, now() - interval '61 minutes')`, [k]);
    await inserir({ escopo: 'PORTAL', chave: k });
    const { rows: [{ n }] } = await c.query(
      `SELECT count(*)::int AS n FROM ${TABELA} WHERE escopo = 'PORTAL' AND chave = $1 AND criado_em > now() - interval '1 hour'`, [k],
    );
    assert.equal(n, 1);
    const { rows: [{ indexdef }] } = await c.query(
      'SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2', [contexto.schema, `idx_${TABELA}_escopo_chave_criado_em`],
    );
    assert.match(indexdef, /\(escopo, chave, criado_em DESC\)/);
  });

  test('retenção futura: linhas antigas podem ser apagadas em lote pelo índice de criado_em', async () => {
    const k = chave();
    await c.query(`INSERT INTO ${TABELA} (escopo, chave, criado_em) VALUES ('PORTAL', $1, now() - interval '40 days')`, [k]);
    const { rowCount } = await c.query(`DELETE FROM ${TABELA} WHERE criado_em < now() - interval '30 days'`);
    assert.equal(rowCount >= 1, true);
  });
});
