'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, inserirEmpresa, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 045 — óculos de proteção com ou sem grau. PostgreSQL real,
 * schema temporário com a cadeia real 000 a 044, o banco como está logo
 * antes da 045. Monto materiais de vários tipos e classificações de
 * tamanho, tiro uma fotografia e só então aplico a 045.
 */

const ANTERIORES = Array.from({ length: 45 }, (_, i) => String(i).padStart(3, '0'));
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const CNPJ = '11222333000181';
const OCULOS = 'Óculos de proteção';
const VIOLACAO_CHECK = '23514';

describe('migration 045 — materiais.oculos_com_grau', () => {
  let contexto;
  let empresa;
  const m = {};
  let fotoMateriais;

  const q = (sql, params) => contexto.cliente.query(sql, params);
  const fotografarMateriais = async () => (await q(
    'SELECT id, nome, tipo, prazo_uso_dias, exige_tamanho, ativo, atualizado_em::text FROM materiais ORDER BY id',
  )).rows;
  const erroDe = async (sql, params) => {
    try {
      await q(sql, params);
      return 'ok';
    } catch (erro) {
      return { code: erro.code, message: erro.message };
    }
  };
  const gravar = (chave, valor) => erroDe('UPDATE materiais SET oculos_com_grau = $2 WHERE id = $1', [m[chave], valor]);

  before(async () => {
    contexto = await abrirSchemaTemporario(ANTERIORES);
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ, 'Empresa'), 'ok');
    empresa = (await q('SELECT id FROM empresas')).rows[0].id;
    const materiais = [
      ['oculos', 'Óculos incolor', OCULOS, false], ['botina', 'Botina', 'Sapatão / Botina', true], ['semTipo', 'Sem tipo', null, null],
      ['minusculo', 'Óculos antigo', 'óculos de proteção', null], ['comEspaco', 'Óculos com espaço', 'Óculos de proteção ', false], ['curto', 'Óculos genérico', 'Óculos', false],
    ];
    for (const [chave, nome, tipo, exigeTamanho] of materiais) {
      m[chave] = (await q(
        'INSERT INTO materiais (empresa_id, nome, tipo, prazo_uso_dias, exige_tamanho) VALUES ($1, $2, $3, 180, $4) RETURNING id',
        [empresa, nome, tipo, exigeTamanho],
      )).rows[0].id;
    }
    // Ponto de partida: 042 e 044 já aplicadas, 045 ainda não.
    const { rows: [partida] } = await q(
      `SELECT to_regclass('estoque_lotes') IS NOT NULL AS lotes,
              to_regclass('estoque_operacoes') IS NOT NULL AS operacoes,
              count(*) FILTER (WHERE column_name = 'exige_tamanho')::int AS exige_tamanho,
              count(*) FILTER (WHERE column_name = 'oculos_com_grau')::int AS oculos_com_grau
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'materiais'`,
    );
    assert.deepEqual(partida, { lotes: true, operacoes: true, exige_tamanho: 1, oculos_com_grau: 0 });
    fotoMateriais = await fotografarMateriais();

    await q(conteudoDaMigration('045'));
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('materiais.oculos_com_grau é boolean, aceita NULL e não tem padrão', async () => {
    const { rows } = await q(
      "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'materiais' AND column_name = 'oculos_com_grau'",
    );
    assert.deepEqual(rows, [{ data_type: 'boolean', is_nullable: 'YES', column_default: null }]);
  });

  test('materiais que já existiam, inclusive os óculos, ficam NULL e com o resto intacto', async () => {
    const { rows } = await q('SELECT oculos_com_grau FROM materiais ORDER BY id');
    assert.equal(rows.every((r) => r.oculos_com_grau === null), true);
    assert.deepEqual(await fotografarMateriais(), fotoMateriais);
  });

  test('óculos de proteção guarda true, false e volta a NULL', async () => {
    for (const valor of [true, false, null]) {
      assert.equal(await gravar('oculos', valor), 'ok', String(valor));
      assert.equal((await q('SELECT oculos_com_grau FROM materiais WHERE id = $1', [m.oculos])).rows[0].oculos_com_grau, valor);
    }
  });

  test('outro tipo, sem tipo ou texto parecido com óculos não guarda true nem false', async () => {
    for (const chave of ['botina', 'semTipo', 'minusculo', 'comEspaco', 'curto']) {
      for (const valor of [true, false]) {
        const erro = await gravar(chave, valor);
        assert.equal(erro.code, VIOLACAO_CHECK, `${chave} = ${valor}`);
        assert.match(erro.message, /chk_materiais_oculos_com_grau_so_oculos/);
      }
      assert.equal(await gravar(chave, null), 'ok');
    }
  });

  test('trocar o tipo de óculos classificados exige limpar a informação no mesmo comando', async () => {
    assert.equal(await gravar('oculos', true), 'ok');
    const semLimpar = await erroDe("UPDATE materiais SET tipo = 'Luva' WHERE id = $1", [m.oculos]);
    assert.equal(semLimpar.code, VIOLACAO_CHECK);
    assert.equal(await erroDe("UPDATE materiais SET tipo = 'Luva', oculos_com_grau = NULL WHERE id = $1", [m.oculos]), 'ok');
  });

  test('manifesto: entrada da 045 coerente com o arquivo; algoritmo sha256', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivo = fs.readdirSync(DIRETORIO).find((nome) => nome.startsWith('045_') && nome.endsWith('.sql'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
    assert.equal(manifesto.algoritmo, 'sha256');
    assert.equal(manifesto.migrations[arquivo], sha);
  });
});
