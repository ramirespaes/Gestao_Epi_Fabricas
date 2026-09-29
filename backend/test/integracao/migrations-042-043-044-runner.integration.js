'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { aplicarMigrations } = require('../../scripts/migrate');

/**
 * 042, 043 e 044 pelo runner real, sobre um banco que já tem saldo, junto
 * com as migrations que vieram depois.
 *
 * É o caminho de todo banco que está na 041 com estoque: o runner aplica as
 * pendentes numa transação só (singleTransaction). Monto a estrutura até
 * a 041 pelo mesmo runner, a partir de um diretório temporário com cópias dos
 * arquivos reais, gravo saldo positivo em estoque_tamanhos e só então rodo o
 * runner no diretório real. PostgreSQL real, schema temporário.
 */

const DIRETORIO_REAL = path.join(__dirname, '..', '..', 'migrations');
const ATE_A_041 = /^0([0-3]\d|4[01])_.+\.sql$/;
const PENDENTES = [
  '042_create_estoque_lotes_operacoes',
  '043_migrate_estoque_tamanhos_saldo_inicial',
  '044_alter_materiais_add_exige_tamanho',
  '045_alter_materiais_add_oculos_com_grau',
  '046_create_convites_usuario',
  '047_alter_acoes_gerenciar_usuarios_obrigatoria',
  '048_alter_logs_auditoria_plataforma_add_ator',
  '049_create_fatores_mfa_plataforma',
  '050_create_lotes_recuperacao_mfa_plataforma',
  '051_create_codigos_recuperacao_mfa_plataforma',
  '052_create_desafios_mfa_plataforma',
  '053_create_liberacoes_cadastro_mfa_plataforma',
  '054_alter_sessoes_plataforma_add_mfa',
  '055_alter_sessoes_plataforma_exigir_mfa',
  '056_create_trigger_inativacao_administrador_invalida_artefatos_mfa',
];
const GATILHO_ADIADO = 'trg_estoque_lotes_exigir_entrada';
const CNPJ = '11222333000181';

describe('runner real: 042, 043 e 044 numa transação, com saldo em estoque_tamanhos', () => {
  let contexto;
  let diretorioAteA041;
  const m = {};

  const q = (sql, params) => contexto.cliente.query(sql, params);
  const registradas = async () => (await q('SELECT name, run_on FROM pgmigrations ORDER BY id')).rows;

  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    diretorioAteA041 = fs.mkdtempSync(path.join(os.tmpdir(), 'gestao-epi-migrations-'));
    for (const nome of fs.readdirSync(DIRETORIO_REAL).filter((arquivo) => ATE_A_041.test(arquivo))) {
      fs.copyFileSync(path.join(DIRETORIO_REAL, nome), path.join(diretorioAteA041, nome));
    }
    await aplicarMigrations({ schema: contexto.schema, diretorio: diretorioAteA041 });

    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ), 'ok');
    const empresaId = (await q('SELECT id FROM empresas WHERE cnpj = $1', [CNPJ])).rows[0].id;
    const material = async (nome, ca, validade) => (await q(
      'INSERT INTO materiais (empresa_id, nome, ca_numero, ca_validade) VALUES ($1, $2, $3, $4) RETURNING id',
      [empresaId, nome, ca, validade],
    )).rows[0].id;
    m.botina = await material('Botina', '12345', '2099-12-31');
    m.luva = await material('Luva', null, null);

    const saldos = [[m.botina, '40', 10], [m.botina, '41', 3], [m.botina, '42', 0], [m.luva, 'M', 5]];
    for (const [materialId, tamanho, quantidade] of saldos) {
      await q('INSERT INTO estoque_tamanhos (material_id, tamanho, quantidade) VALUES ($1, $2, $3)',
        [materialId, tamanho, quantidade]);
    }
  });

  after(async () => {
    if (diretorioAteA041) fs.rmSync(diretorioAteA041, { recursive: true, force: true });
    if (contexto) await contexto.encerrar();
  });

  test('ponto de partida: 000 a 041 aplicadas, saldo positivo e nenhum lote ainda', async () => {
    const nomes = (await registradas()).map((linha) => linha.name);
    assert.equal(nomes.length, 42);
    assert.equal(nomes.at(-1), '041_create_ghe_materiais');
    assert.equal((await q("SELECT to_regclass('estoque_lotes') IS NULL AS ausente")).rows[0].ausente, true);
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_tamanhos WHERE quantidade > 0')).rows[0].n, 3);
  });

  test('o runner aplica 042 a 056 juntas e registra as 57', async () => {
    const aplicadas = await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_REAL });

    assert.deepEqual(aplicadas.map((migration) => migration.name), PENDENTES);
    const linhas = await registradas();
    assert.equal(linhas.length, 57);
    assert.deepEqual(linhas.slice(-PENDENTES.length).map((linha) => linha.name), PENDENTES);
  });

  // run_on é o NOW() da transação. Comparo no banco, em microssegundos.
  test('as pendentes entraram numa transação só, separada da que aplicou até a 041', async () => {
    const { rows } = await q(
      `SELECT count(DISTINCT run_on) FILTER (WHERE name = ANY($1))::int AS instantes,
              count(*) FILTER (WHERE name = ANY($1))::int AS pendentes,
              bool_and(run_on <> (SELECT run_on FROM pgmigrations WHERE name = '041_create_ghe_materiais'))
                FILTER (WHERE name = ANY($1)) AS depois_da_041
         FROM pgmigrations`,
      [PENDENTES],
    );
    assert.deepEqual(rows[0], { instantes: 1, pendentes: PENDENTES.length, depois_da_041: true });
  });

  test('cada saldo positivo virou um lote SALDO_INICIAL com a sua operação', async () => {
    const { rows } = await q(
      `SELECT l.material_id, l.tamanho, l.ca_numero, l.quantidade_entrada, l.saldo,
              (SELECT count(*)::int FROM estoque_operacoes o
                WHERE o.lote_id = l.id AND o.tipo = 'SALDO_INICIAL' AND o.quantidade = l.quantidade_entrada) AS operacoes
         FROM estoque_lotes l
        WHERE l.origem = 'SALDO_INICIAL'
        ORDER BY l.material_id, l.tamanho`,
    );
    assert.deepEqual(rows, [
      { material_id: m.botina, tamanho: '40', ca_numero: '12345', quantidade_entrada: 10, saldo: 10, operacoes: 1 },
      { material_id: m.botina, tamanho: '41', ca_numero: '12345', quantidade_entrada: 3, saldo: 3, operacoes: 1 },
      { material_id: m.luva, tamanho: 'M', ca_numero: null, quantidade_entrada: 5, saldo: 5, operacoes: 1 },
    ]);
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_lotes')).rows[0].n, 3, 'saldo zero não vira lote');
  });

  test('a 044 chegou: exige_tamanho existe e fica NULL, e o lote aceita tamanho NULL', async () => {
    const { rows } = await q('SELECT exige_tamanho FROM materiais ORDER BY id');
    assert.deepEqual(rows, [{ exige_tamanho: null }, { exige_tamanho: null }]);
    const coluna = (await q(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'estoque_lotes' AND column_name = 'tamanho'",
      [contexto.schema],
    )).rows[0];
    assert.equal(coluna.is_nullable, 'YES');
  });

  test('a 045 chegou na mesma transação: oculos_com_grau existe e fica NULL nos materiais que já existiam', async () => {
    const { rows } = await q('SELECT oculos_com_grau FROM materiais ORDER BY id');
    assert.deepEqual(rows, [{ oculos_com_grau: null }, { oculos_com_grau: null }]);
  });

  test('o gatilho de entrada do lote continua adiável e adiado por padrão', async () => {
    const { rows } = await q(
      `SELECT c.contype, c.condeferrable, c.condeferred
         FROM pg_constraint c
        WHERE c.conname = $1 AND c.connamespace = $2::regnamespace`,
      [GATILHO_ADIADO, contexto.schema],
    );
    assert.deepEqual(rows, [{ contype: 't', condeferrable: true, condeferred: true }]);
  });
});
