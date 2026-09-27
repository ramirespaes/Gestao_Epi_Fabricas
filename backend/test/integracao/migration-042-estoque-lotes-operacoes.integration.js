'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  abrirSchemaTemporario, abrirPoolTemporario, aguardarEsperaPeloLock, inserirEmpresa,
} = require('./helpers/schema-temporario');

/**
 * Migration 042 — estoque por lote e histórico de operações. PostgreSQL real,
 * schema temporário. Aplico as migrations anteriores, crio um material que já
 * existiria antes da 042 e só então rodo a 042, para provar o padrão de
 * exige_ca nas linhas antigas.
 */

const ANTERIORES = ['000', '001', '002', '004', '005', '007', '008', '013', '039', '041'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_042 = '042_create_estoque_lotes_operacoes.sql';
const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';
const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';
const HASH = 'a'.repeat(64);
const ONTEM = "(CURRENT_DATE - 1)";

const sqlDa042 = () => fs.readFileSync(path.join(DIRETORIO, ARQUIVO_042), 'utf8');

async function erroDe(promessa) {
  try {
    await promessa;
    return null;
  } catch (erro) {
    return { code: erro.code, constraint: erro.constraint, message: erro.message };
  }
}

describe('migration 042 — estoque_lotes e estoque_operacoes', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let materialAntigo;
  let botina;
  let uniforme;
  let materialB;
  let usuarioA;
  let usuarioB;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  async function transacao(fn) {
    await q('BEGIN');
    try {
      const resultado = await fn();
      await q('COMMIT');
      return resultado;
    } catch (erro) {
      await q('ROLLBACK');
      throw erro;
    }
  }

  async function criarLote(empresaId, materialId, {
    origem = 'ENTRADA', quantidade = 10, tamanho = '40', ca = '12345', validade = '2099-12-31',
    usuarioId = usuarioA, chave = crypto.randomUUID(), quantidadeDaOperacao = quantidade, tipoDaOperacao = origem,
  } = {}) {
    return transacao(async () => {
      const { rows } = await q(
        `INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [empresaId, materialId, tamanho, ca, validade, origem, quantidade],
      );
      const inicial = tipoDaOperacao === 'SALDO_INICIAL';
      await q(
        `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, usuario_id, chave_idempotencia, requisicao_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [empresaId, rows[0].id, tipoDaOperacao, quantidadeDaOperacao, inicial ? null : usuarioId, inicial ? null : chave, inicial ? null : HASH],
      );
      return rows[0].id;
    });
  }

  function baixar(empresaId, loteId, {
    quantidade = 1, motivo = 'AVARIA', justificativa = null, usuarioId = usuarioA, chave = crypto.randomUUID(), hash = HASH,
  } = {}) {
    return q(
      `INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, motivo, justificativa, usuario_id, chave_idempotencia, requisicao_hash)
       VALUES ($1, $2, 'BAIXA', $3, $4, $5, $6, $7, $8)`,
      [empresaId, loteId, quantidade, motivo, justificativa, usuarioId, chave, hash],
    );
  }

  const lote = async (id) => (await q('SELECT *, ca_validade::text AS validade_texto FROM estoque_lotes WHERE id = $1', [id])).rows[0];
  const contarLotes = async () => (await q('SELECT count(*)::int AS n FROM estoque_lotes')).rows[0].n;

  before(async () => {
    contexto = await abrirSchemaTemporario(ANTERIORES);
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ_A, 'A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ_B, 'B'), 'ok');
    const { rows } = await q('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
    empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;
    materialAntigo = (await q(
      "INSERT INTO materiais (empresa_id, nome, ca_numero, ca_validade) VALUES ($1, 'Botina antiga', '11111', '2030-01-01') RETURNING id",
      [empresaA],
    )).rows[0].id;

    await q(sqlDa042());

    botina = (await q("INSERT INTO materiais (empresa_id, nome) VALUES ($1, 'Botina') RETURNING id", [empresaA])).rows[0].id;
    uniforme = (await q("INSERT INTO materiais (empresa_id, nome, exige_ca) VALUES ($1, 'Uniforme', false) RETURNING id", [empresaA])).rows[0].id;
    materialB = (await q("INSERT INTO materiais (empresa_id, nome) VALUES ($1, 'Luva B') RETURNING id", [empresaB])).rows[0].id;
    const usuario = async (empresaId, email) => (await q(
      "INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil) VALUES ($1, 'Usuário', $2, 'hash-de-teste', 'MASTER') RETURNING id",
      [empresaId, email],
    )).rows[0].id;
    usuarioA = await usuario(empresaA, 'a@example.invalid');
    usuarioB = await usuario(empresaB, 'b@example.invalid');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('materiais ganha exige_ca (NOT NULL, padrão true, inclusive nas linhas antigas); CA legado e estoque_tamanhos intactos', async () => {
    const { rows: [coluna] } = await q(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'materiais' AND column_name = 'exige_ca'`,
    );
    assert.deepEqual(coluna, { data_type: 'boolean', is_nullable: 'NO', column_default: 'true' });
    assert.equal((await q('SELECT exige_ca FROM materiais WHERE id = $1', [materialAntigo])).rows[0].exige_ca, true);

    const colunasDe = async (tabela) => (await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
      [tabela],
    )).rows.map((c) => c.column_name);
    assert.ok((await colunasDe('materiais')).includes('ca_numero'));
    assert.ok((await colunasDe('materiais')).includes('ca_validade'));
    assert.deepEqual(await colunasDe('estoque_tamanhos'), ['id', 'material_id', 'tamanho', 'quantidade', 'criado_em', 'atualizado_em']);
  });

  test('estrutura de estoque_lotes: colunas, saldo gerado, constraints, índices e triggers', async () => {
    const { rows: colunas } = await q(
      `SELECT column_name, data_type, is_nullable, is_generated FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'estoque_lotes' ORDER BY ordinal_position`,
    );
    assert.deepEqual(colunas.map((c) => [c.column_name, c.data_type, c.is_nullable, c.is_generated]), [
      ['id', 'integer', 'NO', 'NEVER'],
      ['empresa_id', 'integer', 'NO', 'NEVER'],
      ['material_id', 'integer', 'NO', 'NEVER'],
      ['tamanho', 'character varying', 'NO', 'NEVER'],
      ['ca_numero', 'character varying', 'YES', 'NEVER'],
      ['ca_validade', 'date', 'YES', 'NEVER'],
      ['origem', 'character varying', 'NO', 'NEVER'],
      ['quantidade_entrada', 'integer', 'NO', 'NEVER'],
      ['quantidade_baixada', 'integer', 'NO', 'NEVER'],
      ['quantidade_entregue', 'integer', 'NO', 'NEVER'],
      ['saldo', 'integer', 'YES', 'ALWAYS'],
      ['criado_em', 'timestamp with time zone', 'NO', 'NEVER'],
    ]);

    const { rows: cons } = await q(
      `SELECT conname, contype, confdeltype FROM pg_constraint
        WHERE conrelid = 'estoque_lotes'::regclass AND contype IN ('p', 'u', 'f', 'c')`,
    );
    assert.deepEqual(cons.map((c) => c.conname).sort(), [
      'chk_estoque_lotes_ca_completo', 'chk_estoque_lotes_ca_numero', 'chk_estoque_lotes_origem',
      'chk_estoque_lotes_quantidade_entrada', 'chk_estoque_lotes_quantidades', 'chk_estoque_lotes_tamanho',
      'estoque_lotes_pkey', 'fk_estoque_lotes_material_mesma_empresa', 'uq_estoque_lotes_empresa_id',
    ]);
    assert.equal(cons.find((c) => c.contype === 'f').confdeltype, 'r', 'FK com ON DELETE RESTRICT');

    const { rows: indices } = await q(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'estoque_lotes'",
    );
    assert.deepEqual(indices.map((i) => i.indexname).sort(), [
      'estoque_lotes_pkey', 'idx_estoque_lotes_material_tamanho', 'idx_estoque_lotes_validade_com_saldo', 'uq_estoque_lotes_empresa_id',
    ]);
    assert.match(indices.find((i) => i.indexname === 'idx_estoque_lotes_validade_com_saldo').indexdef, /WHERE \(saldo > 0\)/);

    const { rows: triggers } = await q(
      "SELECT tgname FROM pg_trigger WHERE tgrelid = 'estoque_lotes'::regclass AND NOT tgisinternal",
    );
    assert.deepEqual(triggers.map((t) => t.tgname).sort(), [
      'trg_estoque_lotes_bloquear_delete', 'trg_estoque_lotes_bloquear_truncate', 'trg_estoque_lotes_exigir_entrada',
      'trg_estoque_lotes_proteger_update', 'trg_estoque_lotes_validar_insercao',
    ]);
  });

  test('estrutura de estoque_operacoes: colunas, constraints, índices únicos PARCIAIS (não constraints) e triggers', async () => {
    const { rows: colunas } = await q(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'estoque_operacoes' ORDER BY ordinal_position`,
    );
    assert.deepEqual(colunas.map((c) => [c.column_name, c.data_type, c.is_nullable]), [
      ['id', 'bigint', 'NO'],
      ['empresa_id', 'integer', 'NO'],
      ['lote_id', 'integer', 'NO'],
      ['tipo', 'character varying', 'NO'],
      ['quantidade', 'integer', 'NO'],
      ['motivo', 'character varying', 'YES'],
      ['justificativa', 'text', 'YES'],
      ['usuario_id', 'integer', 'YES'],
      ['chave_idempotencia', 'uuid', 'YES'],
      ['requisicao_hash', 'character', 'YES'],
      ['criado_em', 'timestamp with time zone', 'NO'],
    ]);

    const { rows: cons } = await q(
      `SELECT conname, contype, confdeltype FROM pg_constraint
        WHERE conrelid = 'estoque_operacoes'::regclass AND contype IN ('p', 'u', 'f', 'c')`,
    );
    assert.deepEqual(cons.map((c) => c.conname).sort(), [
      'chk_estoque_operacoes_idempotencia', 'chk_estoque_operacoes_justificativa', 'chk_estoque_operacoes_motivo',
      'chk_estoque_operacoes_motivo_da_baixa', 'chk_estoque_operacoes_outro_justificado', 'chk_estoque_operacoes_quantidade',
      'chk_estoque_operacoes_requisicao_hash', 'chk_estoque_operacoes_responsavel', 'chk_estoque_operacoes_tipo',
      'estoque_operacoes_pkey', 'fk_estoque_operacoes_lote_mesma_empresa', 'fk_estoque_operacoes_usuario_mesma_empresa',
    ]);
    assert.ok(cons.filter((c) => c.contype === 'f').every((c) => c.confdeltype === 'r'), 'FKs com ON DELETE RESTRICT');
    assert.equal(cons.filter((c) => c.contype === 'u').length, 0, 'unicidade condicional é índice parcial, não constraint');

    const { rows: unicos } = await q(
      `SELECT c.relname, i.indisunique, i.indpred IS NOT NULL AS parcial
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'estoque_operacoes'::regclass AND c.relname LIKE 'uq_%'`,
    );
    assert.deepEqual([...unicos].sort((x, y) => (x.relname < y.relname ? -1 : 1)), [
      { relname: 'uq_estoque_operacoes_entrada_do_lote', indisunique: true, parcial: true },
      { relname: 'uq_estoque_operacoes_idempotencia', indisunique: true, parcial: true },
    ]);

    const { rows: indices } = await q(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'estoque_operacoes'",
    );
    assert.deepEqual(indices.map((i) => i.indexname).sort(), [
      'estoque_operacoes_pkey', 'idx_estoque_operacoes_empresa_criado_em', 'idx_estoque_operacoes_lote',
      'uq_estoque_operacoes_entrada_do_lote', 'uq_estoque_operacoes_idempotencia',
    ]);

    const { rows: triggers } = await q(
      "SELECT tgname FROM pg_trigger WHERE tgrelid = 'estoque_operacoes'::regclass AND NOT tgisinternal",
    );
    assert.deepEqual(triggers.map((t) => t.tgname).sort(), [
      'trg_estoque_operacoes_aplicar', 'trg_estoque_operacoes_bloquear_delete',
      'trg_estoque_operacoes_bloquear_truncate', 'trg_estoque_operacoes_bloquear_update',
    ]);
  });

  test('entrada: lote e operação na mesma transação; saldo nasce igual à entrada; lote sem operação é recusado no commit', async () => {
    const id = await criarLote(empresaA, botina, { quantidade: 10 });
    const l = await lote(id);
    assert.deepEqual([l.quantidade_entrada, l.quantidade_baixada, l.quantidade_entregue, l.saldo], [10, 0, 0, 10]);

    const antes = await contarLotes();
    const erro = await erroDe(transacao(() => q(
      "INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada) VALUES ($1, $2, '41', '12345', '2099-12-31', 'ENTRADA', 5)",
      [empresaA, botina],
    )));
    assert.equal(erro?.code, RECUSA_DO_TRIGGER);
    assert.equal(await contarLotes(), antes);
  });

  test('lote não nasce com contadores preenchidos: baixa e entrega só vêm de operações', async () => {
    const erro = await erroDe(transacao(() => q(
      "INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada, quantidade_baixada) VALUES ($1, $2, '40', '12345', '2099-12-31', 'ENTRADA', 10, 4)",
      [empresaA, botina],
    )));
    assert.equal(erro?.code, RECUSA_DO_TRIGGER);
  });

  test('a operação de entrada precisa ter o tipo e a quantidade do lote e é única por lote', async () => {
    const antes = await contarLotes();
    assert.equal((await erroDe(criarLote(empresaA, botina, { quantidade: 10, quantidadeDaOperacao: 9 })))?.code, RECUSA_DO_TRIGGER);
    assert.equal((await erroDe(criarLote(empresaA, botina, { origem: 'ENTRADA', tipoDaOperacao: 'SALDO_INICIAL' })))?.code, RECUSA_DO_TRIGGER);
    assert.equal(await contarLotes(), antes, 'nada foi gravado');

    const id = await criarLote(empresaA, botina, { quantidade: 3 });
    const erro = await erroDe(q(
      "INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, usuario_id, chave_idempotencia, requisicao_hash) VALUES ($1, $2, 'ENTRADA', 3, $3, $4, $5)",
      [empresaA, id, usuarioA, crypto.randomUUID(), HASH],
    ));
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_UNIQUE, 'uq_estoque_operacoes_entrada_do_lote']);
  });

  test('exige_ca: ENTRADA de material que exige CA precisa de CA; material que dispensa aceita sem CA; SALDO_INICIAL aceita sem CA e com CA vencido', async () => {
    const erro = await erroDe(criarLote(empresaA, botina, { ca: null, validade: null }));
    assert.equal(erro?.code, RECUSA_DO_TRIGGER);
    assert.match(erro.message, /CA/);

    const semCa = await criarLote(empresaA, uniforme, { ca: null, validade: null, tamanho: 'G' });
    assert.equal((await lote(semCa)).ca_numero, null);

    const legadoSemCa = await criarLote(empresaA, botina, { origem: 'SALDO_INICIAL', ca: null, validade: null });
    assert.equal((await lote(legadoSemCa)).origem, 'SALDO_INICIAL');
    const vencido = (await q(`SELECT (${ONTEM})::text AS d`)).rows[0].d;
    const legadoVencido = await criarLote(empresaA, botina, { origem: 'SALDO_INICIAL', validade: vencido });
    assert.equal((await lote(legadoVencido)).saldo, 10);
  });

  test('CA e validade andam juntos; CA, tamanho, origem e quantidade de entrada validados pelo banco', async () => {
    const casos = [
      [{ ca: '12345', validade: null }, 'chk_estoque_lotes_ca_completo'],
      [{ ca: null, validade: '2099-12-31' }, 'chk_estoque_lotes_ca_completo'],
      [{ ca: ' 12345' }, 'chk_estoque_lotes_ca_numero'],
      [{ tamanho: ' 40' }, 'chk_estoque_lotes_tamanho'],
      [{ origem: 'COMPRA', tipoDaOperacao: 'ENTRADA' }, 'chk_estoque_lotes_origem'],
      [{ quantidade: 0 }, 'chk_estoque_lotes_quantidade_entrada'],
    ];
    for (const [opcoes, constraint] of casos) {
      const erro = await erroDe(criarLote(empresaA, uniforme, opcoes));
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, constraint], JSON.stringify(opcoes));
    }
  });

  test('baixa: o trigger soma a quantidade baixada, o saldo cai e a entrada original não muda; baixa acima do saldo é recusada sem efeito', async () => {
    const id = await criarLote(empresaA, botina, { quantidade: 10, ca: '67890', validade: '2099-09-30' });
    await baixar(empresaA, id, { quantidade: 3 });
    let l = await lote(id);
    assert.deepEqual([l.quantidade_entrada, l.quantidade_baixada, l.saldo, l.ca_numero], [10, 3, 7, '67890']);

    const erro = await erroDe(baixar(empresaA, id, { quantidade: 8 }));
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, 'chk_estoque_lotes_quantidades']);
    l = await lote(id);
    assert.deepEqual([l.quantidade_baixada, l.saldo], [3, 7]);
    const { rows: [{ n }] } = await q("SELECT count(*)::int AS n FROM estoque_operacoes WHERE lote_id = $1 AND tipo = 'BAIXA'", [id]);
    assert.equal(n, 1, 'a baixa recusada não ficou no histórico');

    await baixar(empresaA, id, { quantidade: 7 });
    l = await lote(id);
    assert.deepEqual([l.saldo, l.quantidade_entrada], [0, 10], 'lote zerado continua existindo');
  });

  test('motivo e justificativa: só a baixa tem motivo; OUTRO exige justificativa; motivo fora da lista é recusado', async () => {
    const id = await criarLote(empresaA, botina, { quantidade: 10 });
    const casos = [
      [{ motivo: null }, 'chk_estoque_operacoes_motivo_da_baixa'],
      [{ motivo: 'ROUBO' }, 'chk_estoque_operacoes_motivo'],
      [{ motivo: 'OUTRO' }, 'chk_estoque_operacoes_outro_justificado'],
      [{ motivo: 'OUTRO', justificativa: ' texto ' }, 'chk_estoque_operacoes_justificativa'],
    ];
    for (const [opcoes, constraint] of casos) {
      const erro = await erroDe(baixar(empresaA, id, opcoes));
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, constraint], JSON.stringify(opcoes));
    }
    await baixar(empresaA, id, { motivo: 'OUTRO', justificativa: 'Caixa molhada no transporte' });
    await baixar(empresaA, id, { motivo: 'CA_VENCIDO' });

    const erroEntrada = await erroDe(transacao(async () => {
      const { rows } = await q(
        "INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada) VALUES ($1, $2, '40', '12345', '2099-12-31', 'ENTRADA', 2) RETURNING id",
        [empresaA, botina],
      );
      await q(
        "INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, motivo, usuario_id, chave_idempotencia, requisicao_hash) VALUES ($1, $2, 'ENTRADA', 2, 'AVARIA', $3, $4, $5)",
        [empresaA, rows[0].id, usuarioA, crypto.randomUUID(), HASH],
      );
    }));
    assert.deepEqual([erroEntrada?.code, erroEntrada?.constraint], [VIOLACAO_CHECK, 'chk_estoque_operacoes_motivo_da_baixa']);
  });

  test('responsável e idempotência: ENTRADA e BAIXA exigem usuário, chave e hash SHA-256; SALDO_INICIAL dispensa', async () => {
    const id = await criarLote(empresaA, botina, { quantidade: 10 });
    const casos = [
      [{ usuarioId: null }, 'chk_estoque_operacoes_responsavel'],
      [{ chave: null, hash: null }, 'chk_estoque_operacoes_idempotencia'],
      [{ hash: null }, 'chk_estoque_operacoes_idempotencia'],
      [{ hash: 'XYZ'.padEnd(64, 'Z') }, 'chk_estoque_operacoes_requisicao_hash'],
    ];
    for (const [opcoes, constraint] of casos) {
      const erro = await erroDe(baixar(empresaA, id, opcoes));
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, constraint], JSON.stringify(opcoes));
    }
    const inicial = await criarLote(empresaA, botina, { origem: 'SALDO_INICIAL', quantidade: 4 });
    const { rows: [op] } = await q('SELECT usuario_id, chave_idempotencia, requisicao_hash FROM estoque_operacoes WHERE lote_id = $1', [inicial]);
    assert.deepEqual(op, { usuario_id: null, chave_idempotencia: null, requisicao_hash: null });
  });

  test('idempotência: a mesma chave na mesma empresa é recusada pelo índice único parcial; outra empresa pode repetir a chave', async () => {
    const loteA = await criarLote(empresaA, botina, { quantidade: 10 });
    const loteB = await criarLote(empresaB, materialB, { quantidade: 10, usuarioId: usuarioB });
    const chave = crypto.randomUUID();
    await baixar(empresaA, loteA, { chave });
    const erro = await erroDe(baixar(empresaA, loteA, { chave }));
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_UNIQUE, 'uq_estoque_operacoes_idempotencia']);
    await baixar(empresaB, loteB, { chave, usuarioId: usuarioB });
  });

  test('isolamento: material, lote e usuário de outra empresa são recusados pelas FKs compostas', async () => {
    const erroMaterial = await erroDe(criarLote(empresaA, materialB));
    assert.deepEqual([erroMaterial?.code, erroMaterial?.constraint], [VIOLACAO_FK, 'fk_estoque_lotes_material_mesma_empresa']);

    const loteB = await criarLote(empresaB, materialB, { usuarioId: usuarioB });
    const erroLote = await erroDe(baixar(empresaA, loteB));
    assert.deepEqual([erroLote?.code, erroLote?.constraint], [VIOLACAO_FK, 'fk_estoque_operacoes_lote_mesma_empresa']);

    const loteA = await criarLote(empresaA, botina);
    const erroUsuario = await erroDe(baixar(empresaA, loteA, { usuarioId: usuarioB }));
    assert.deepEqual([erroUsuario?.code, erroUsuario?.constraint], [VIOLACAO_FK, 'fk_estoque_operacoes_usuario_mesma_empresa']);
  });

  test('histórico append-only: estoque_operacoes recusa UPDATE, DELETE e TRUNCATE', async () => {
    const id = await criarLote(empresaA, botina, { quantidade: 5 });
    await baixar(empresaA, id, { quantidade: 1 });
    const antes = (await q('SELECT count(*)::int AS n FROM estoque_operacoes')).rows[0].n;
    assert.equal((await erroDe(q('UPDATE estoque_operacoes SET quantidade = 99 WHERE lote_id = $1', [id])))?.code, RECUSA_DO_TRIGGER);
    assert.equal((await erroDe(q('DELETE FROM estoque_operacoes WHERE lote_id = $1', [id])))?.code, RECUSA_DO_TRIGGER);
    assert.equal((await erroDe(q('TRUNCATE estoque_operacoes')))?.code, RECUSA_DO_TRIGGER);
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_operacoes')).rows[0].n, antes);
  });

  test('lote: identidade e entrada imutáveis, contadores só mudam por operação, sem DELETE nem TRUNCATE', async () => {
    const id = await criarLote(empresaA, botina, { quantidade: 10, ca: '12345', validade: '2099-12-31' });
    await baixar(empresaA, id, { quantidade: 2 });
    const tentativas = [
      "UPDATE estoque_lotes SET ca_validade = '2100-01-01' WHERE id = $1",
      "UPDATE estoque_lotes SET ca_numero = '99999' WHERE id = $1",
      'UPDATE estoque_lotes SET quantidade_entrada = 50 WHERE id = $1',
      "UPDATE estoque_lotes SET tamanho = '41' WHERE id = $1",
      'UPDATE estoque_lotes SET quantidade_baixada = 0 WHERE id = $1',
      'UPDATE estoque_lotes SET quantidade_entregue = 1 WHERE id = $1',
      'DELETE FROM estoque_lotes WHERE id = $1',
    ];
    for (const sql of tentativas) {
      assert.equal((await erroDe(q(sql, [id])))?.code, RECUSA_DO_TRIGGER, sql);
    }
    assert.ok(await erroDe(q('TRUNCATE estoque_lotes')), 'TRUNCATE recusado');
    const l = await lote(id);
    assert.deepEqual([l.validade_texto, l.ca_numero, l.quantidade_entrada, l.quantidade_baixada, l.saldo],
      ['2099-12-31', '12345', 10, 2, 8]);
  });

  test('reconciliação: os contadores de todos os lotes batem com a soma das operações', async () => {
    const { rows } = await q(
      `SELECT l.id
         FROM estoque_lotes l
         LEFT JOIN estoque_operacoes o ON o.empresa_id = l.empresa_id AND o.lote_id = l.id
        GROUP BY l.id, l.quantidade_entrada, l.quantidade_baixada, l.quantidade_entregue
       HAVING l.quantidade_baixada <> COALESCE(sum(o.quantidade) FILTER (WHERE o.tipo = 'BAIXA'), 0)
           OR l.quantidade_entregue <> 0
           OR l.quantidade_entrada <> COALESCE(sum(o.quantidade) FILTER (WHERE o.tipo IN ('ENTRADA', 'SALDO_INICIAL')), 0)`,
    );
    assert.deepEqual(rows, []);
    assert.ok(await contarLotes() > 10, 'os testes anteriores criaram lotes suficientes');
  });

  test('manifesto: entrada da 042 coerente com o arquivo; algoritmo sha256', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_042))).digest('hex');
    assert.equal(manifesto.algoritmo, 'sha256');
    assert.equal(manifesto.migrations[ARQUIVO_042], sha);
  });
});

describe('migration 042 — concorrência (PostgreSQL real, conexões simultâneas)', () => {
  let contexto;
  let empresa;
  let material;
  let usuario;

  const q = (sql, params) => contexto.pool.query(sql, params);

  async function novoLote(quantidade) {
    const cliente = await contexto.pool.connect();
    try {
      await cliente.query('BEGIN');
      const { rows } = await cliente.query(
        "INSERT INTO estoque_lotes (empresa_id, material_id, tamanho, ca_numero, ca_validade, origem, quantidade_entrada) VALUES ($1, $2, '40', '12345', '2099-12-31', 'ENTRADA', $3) RETURNING id",
        [empresa, material, quantidade],
      );
      await cliente.query(
        "INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, usuario_id, chave_idempotencia, requisicao_hash) VALUES ($1, $2, 'ENTRADA', $3, $4, $5, $6)",
        [empresa, rows[0].id, quantidade, usuario, crypto.randomUUID(), HASH],
      );
      await cliente.query('COMMIT');
      return rows[0].id;
    } finally {
      cliente.release();
    }
  }

  const sqlBaixa = "INSERT INTO estoque_operacoes (empresa_id, lote_id, tipo, quantidade, motivo, usuario_id, chave_idempotencia, requisicao_hash) VALUES ($1, $2, 'BAIXA', $3, 'AVARIA', $4, $5, $6)";

  // Uma conexão segura a transação aberta; a segunda precisa ficar esperando o
  // lock de verdade antes do COMMIT da primeira — nada de espera por tempo.
  async function emParalelo(primeira, segunda) {
    const clienteA = await contexto.pool.connect();
    const clienteB = await contexto.pool.connect();
    const admin = await contexto.pool.connect();
    try {
      await clienteA.query('BEGIN');
      await clienteA.query(...primeira);
      await clienteB.query('BEGIN');
      const { rows: [{ pid }] } = await clienteB.query('SELECT pg_backend_pid() AS pid');
      const promessaB = clienteB.query(...segunda).then(() => null, (erro) => erro);
      await aguardarEsperaPeloLock(admin, pid);
      await clienteA.query('COMMIT');
      const erroB = await promessaB;
      await clienteB.query(erroB ? 'ROLLBACK' : 'COMMIT');
      return erroB;
    } finally {
      clienteA.release();
      clienteB.release();
      admin.release();
    }
  }

  before(async () => {
    contexto = await abrirPoolTemporario([...ANTERIORES, '042']);
    assert.equal(await inserirEmpresa(contexto.pool, CNPJ_A, 'A'), 'ok');
    empresa = (await q('SELECT id FROM empresas')).rows[0].id;
    material = (await q("INSERT INTO materiais (empresa_id, nome) VALUES ($1, 'Botina') RETURNING id", [empresa])).rows[0].id;
    usuario = (await q(
      "INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil) VALUES ($1, 'Usuário', 'c@example.invalid', 'hash-de-teste', 'MASTER') RETURNING id",
      [empresa],
    )).rows[0].id;
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('duas baixas simultâneas no mesmo lote não ultrapassam o saldo', async () => {
    const lote = await novoLote(10);
    const erro = await emParalelo(
      [sqlBaixa, [empresa, lote, 6, usuario, crypto.randomUUID(), HASH]],
      [sqlBaixa, [empresa, lote, 6, usuario, crypto.randomUUID(), HASH]],
    );
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, 'chk_estoque_lotes_quantidades']);
    const { rows: [l] } = await q('SELECT quantidade_baixada, saldo FROM estoque_lotes WHERE id = $1', [lote]);
    assert.deepEqual([l.quantidade_baixada, l.saldo], [6, 4]);
    const { rows: [{ n }] } = await q("SELECT count(*)::int AS n FROM estoque_operacoes WHERE lote_id = $1 AND tipo = 'BAIXA'", [lote]);
    assert.equal(n, 1);
  });

  test('a mesma chave de idempotência enviada em paralelo gera uma única operação', async () => {
    const lote = await novoLote(10);
    const chave = crypto.randomUUID();
    const erro = await emParalelo(
      [sqlBaixa, [empresa, lote, 1, usuario, chave, HASH]],
      [sqlBaixa, [empresa, lote, 1, usuario, chave, HASH]],
    );
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_UNIQUE, 'uq_estoque_operacoes_idempotencia']);
    const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM estoque_operacoes WHERE chave_idempotencia = $1', [chave]);
    assert.equal(n, 1);
    const { rows: [l] } = await q('SELECT quantidade_baixada FROM estoque_lotes WHERE id = $1', [lote]);
    assert.equal(l.quantidade_baixada, 1);
  });
});
