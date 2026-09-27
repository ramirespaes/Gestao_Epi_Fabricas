'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { abrirSchemaTemporario, inserirEmpresa, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 044 — exigência explícita de tamanho no material. PostgreSQL
 * real, schema temporário. Monto materiais e lotes como estão antes da 044
 * (inclusive um saldo legado "Único"), tiro uma fotografia e só então aplico
 * a 044.
 */

const ANTERIORES = ['000', '001', '002', '004', '005', '007', '008', '013', '039', '041', '042', '043'];
const CNPJ = '11222333000181';
const RECUSA_DO_TRIGGER = 'P0001';
const VIOLACAO_CHECK = '23514';

describe('migration 044 — materiais.exige_tamanho e lote sem tamanho', () => {
  let contexto;
  let empresa;
  let usuario;
  const m = {};
  let fotoLotes;
  let fotoMateriais;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  const fotografarLotes = async () => (await q(
    `SELECT id, empresa_id, material_id, tamanho, ca_numero, ca_validade::text, origem, quantidade_entrada,
            quantidade_baixada, quantidade_entregue, saldo, criado_em::text
       FROM estoque_lotes ORDER BY id`,
  )).rows;
  const fotografarMateriais = async () => (await q(
    'SELECT id, nome, prazo_uso_dias, exige_ca, ativo, atualizado_em::text FROM materiais ORDER BY id',
  )).rows;

  // Lote e operação na mesma transação, como a aplicação faz. Devolve 'ok' ou o erro.
  async function lote(materialId, { origem, tamanho }) {
    await q('BEGIN');
    try {
      const ca = origem === 'ENTRADA' ? ['12345', '2099-12-31'] : [null, null];
      const { rows } = await q(
        `INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada)
         VALUES ($1, $2, $3, $4, $5, $6, 5) RETURNING id`,
        [empresa, materialId, tamanho, ...ca, origem],
      );
      await q(
        `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, usuario_id, chave_idempotencia, requisicao_hash)
         VALUES ($1, $2, $3, 5, $4, $5, $6)`,
        origem === 'ENTRADA'
          ? [empresa, rows[0].id, origem, usuario, crypto.randomUUID(), 'a'.repeat(64)]
          : [empresa, rows[0].id, origem, null, null, null],
      );
      await q('COMMIT');
      return 'ok';
    } catch (erro) {
      await q('ROLLBACK');
      return { code: erro.code, message: erro.message };
    }
  }

  const classificar = (chave, valor) => q('UPDATE materiais SET exige_tamanho = $2 WHERE id = $1', [m[chave], valor]);

  before(async () => {
    contexto = await abrirSchemaTemporario(ANTERIORES);
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ, 'Empresa'), 'ok');
    empresa = (await q('SELECT id FROM empresas')).rows[0].id;
    usuario = (await q(
      "INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil) VALUES ($1, 'Usuário', 'u@example.invalid', 'hash-de-teste', 'MASTER') RETURNING id",
      [empresa],
    )).rows[0].id;
    for (const [chave, nome] of [['botina', 'Botina'], ['oculos', 'Óculos'], ['exige', 'Exige'], ['dispensa', 'Dispensa'], ['semClasse', 'Sem classe']]) {
      m[chave] = (await q('INSERT INTO materiais (empresa_id, nome, prazo_uso_dias) VALUES ($1, $2, 180) RETURNING id', [empresa, nome])).rows[0].id;
    }
    assert.equal(await lote(m.botina, { origem: 'SALDO_INICIAL', tamanho: '40' }), 'ok');
    assert.equal(await lote(m.oculos, { origem: 'SALDO_INICIAL', tamanho: 'Único' }), 'ok');
    fotoLotes = await fotografarLotes();
    fotoMateriais = await fotografarMateriais();

    await q(conteudoDaMigration('044'));
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('materiais.exige_tamanho é boolean, aceita NULL e não tem padrão', async () => {
    const { rows } = await q(
      "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'materiais' AND column_name = 'exige_tamanho'",
    );
    assert.deepEqual(rows, [{ data_type: 'boolean', is_nullable: 'YES', column_default: null }]);
  });

  test('materiais que já existiam ficam sem classificação (NULL) e com o resto intacto', async () => {
    const { rows } = await q('SELECT id, exige_tamanho FROM materiais ORDER BY id');
    assert.equal(rows.every((r) => r.exige_tamanho === null), true);
    assert.deepEqual(await fotografarMateriais(), fotoMateriais);
  });

  test('lotes que já existiam não são reescritos, inclusive o "Único"', async () => {
    assert.deepEqual(await fotografarLotes(), fotoLotes);
    assert.deepEqual(fotoLotes.map((l) => l.tamanho), ['40', 'Único']);
  });

  test('estoque_lotes.tamanho aceita NULL; preenchido, precisa estar aparado e não vazio', async () => {
    const { rows } = await q(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'estoque_lotes' AND column_name = 'tamanho'",
    );
    assert.equal(rows[0].is_nullable, 'YES');
    assert.equal(await lote(m.semClasse, { origem: 'SALDO_INICIAL', tamanho: null }), 'ok');
    for (const tamanho of ['', ' 40', '40 ', '   ']) {
      const erro = await lote(m.semClasse, { origem: 'SALDO_INICIAL', tamanho });
      assert.equal(erro.code, VIOLACAO_CHECK, JSON.stringify(tamanho));
      assert.match(erro.message, /chk_estoque_lotes_tamanho/);
    }
  });

  test('entrada operacional de material que exige tamanho: sem tamanho é recusada, com tamanho passa', async () => {
    await classificar('exige', true);
    const semTamanho = await lote(m.exige, { origem: 'ENTRADA', tamanho: null });
    assert.equal(semTamanho.code, RECUSA_DO_TRIGGER);
    assert.match(semTamanho.message, /exige tamanho/);
    assert.equal(await lote(m.exige, { origem: 'ENTRADA', tamanho: '42' }), 'ok');
  });

  test('entrada operacional de material sem tamanho: sem tamanho passa, com tamanho é recusada', async () => {
    await classificar('dispensa', false);
    assert.equal(await lote(m.dispensa, { origem: 'ENTRADA', tamanho: null }), 'ok');
    const comTamanho = await lote(m.dispensa, { origem: 'ENTRADA', tamanho: 'Único' });
    assert.equal(comTamanho.code, RECUSA_DO_TRIGGER);
    assert.match(comTamanho.message, /não usa tamanho/);
  });

  test('entrada operacional de material não classificado é recusada, com ou sem tamanho', async () => {
    for (const tamanho of [null, '40']) {
      const erro = await lote(m.semClasse, { origem: 'ENTRADA', tamanho });
      assert.equal(erro.code, RECUSA_DO_TRIGGER, String(tamanho));
      assert.match(erro.message, /não foi classificado/);
    }
  });

  test('SALDO_INICIAL continua aceito para qualquer classificação, com ou sem tamanho', async () => {
    for (const [chave, tamanho] of [['semClasse', '40'], ['exige', null], ['dispensa', 'U']]) {
      assert.equal(await lote(m[chave], { origem: 'SALDO_INICIAL', tamanho }), 'ok', `${chave} ${tamanho}`);
    }
  });
});
