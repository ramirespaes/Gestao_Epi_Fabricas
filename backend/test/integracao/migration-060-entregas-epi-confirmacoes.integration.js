'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const {
  todasAsMigrations, erroDe, criarEmpresa, criarUsuario, criarFuncionario, criarMaterial, criarLote, criarFicha,
  inserirEntrega, inserirItem, inserirOperacaoEntrega, inserirConfirmacao, registrarEntrega,
} = require('./helpers/entrega-epi');

/**
 * Migration 060 — confirmação de recebimento da entrega: exatamente uma por
 * entrega, DESENHO com traços em JSON ou ACEITE_PRESENCIAL sem traços, e o
 * fechamento da composição (item só antes da confirmação; a entrega precisa
 * da confirmação no COMMIT). hash_conteudo é checksum, não assinatura.
 * PostgreSQL real, schema temporário com todas as migrations do diretório.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_060 = '060_create_entregas_epi_confirmacoes.sql';
const TODAS = todasAsMigrations();
const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';
const JSON_INVALIDO = '22P02';
const NULO_OBRIGATORIO = '23502';
const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';
const LIMITE_TRACOS_BYTES = 24576;
const TRACOS = [[[10, 10], [20, 12], [30, 15]], [[40, 40], [42, 41]]];

const DECLARACAO = 'Declaro que recebi os EPIs relacionados, fui orientado sobre o uso correto e me comprometo a utilizá-los (texto fictício de teste).';
const LIMITE_DECLARACAO = 4000;

const CONSTRAINTS = [
  'chk_entregas_epi_confirmacoes_declaracao_texto',
  'chk_entregas_epi_confirmacoes_declaracao_versao',
  'chk_entregas_epi_confirmacoes_hash_conteudo',
  'chk_entregas_epi_confirmacoes_modo',
  'chk_entregas_epi_confirmacoes_tracos_formato',
  'chk_entregas_epi_confirmacoes_tracos_por_modo',
  'entregas_epi_confirmacoes_pkey',
  'fk_entregas_epi_confirmacoes_entrega_mesma_empresa',
];
const GATILHOS = [
  'trg_entregas_epi_confirmacoes_bloquear_delete',
  'trg_entregas_epi_confirmacoes_bloquear_truncate',
  'trg_entregas_epi_confirmacoes_bloquear_update',
  'trg_entregas_epi_confirmacoes_exigir_item',
];

describe('migration 060 — entregas_epi_confirmacoes', () => {
  let contexto;
  let c;
  const d = {};

  const q = (sql, params) => c.query(sql, params);
  const entregaBase = () => ({ empresa_id: d.empresaA, ficha_id: d.fichaA.id, responsavel_id: d.usuarioA, empresa_cnpj: CNPJ_A });
  const itemBase = (entregaId) => ({ empresa_id: d.empresaA, entrega_id: entregaId, material_id: d.botinaA, lote_id: d.loteA, quantidade: 1 });

  // Entrega com um item e a sua operação, aberta numa transação; a confirmação
  // fica por conta do teste; ROLLBACK no fim.
  async function comEntregaAberta(fn) {
    await q('BEGIN');
    try {
      const entrega = await inserirEntrega(c, entregaBase());
      const item = await inserirItem(c, itemBase(entrega.id));
      await inserirOperacaoEntrega(c, { empresa_id: d.empresaA, lote_id: d.loteA, quantidade: 1, usuario_id: d.usuarioA, entrega_item_id: item.id });
      return await fn(entrega, item);
    } finally {
      await q('ROLLBACK');
    }
  }
  const tentarConfirmacao = (valores) => comEntregaAberta((entrega) => erroDe(inserirConfirmacao(c, {
    empresa_id: d.empresaA, entrega_id: entrega.id, ...valores,
  })));

  before(async () => {
    contexto = await abrirSchemaTemporario(TODAS);
    c = contexto.cliente;
    d.empresaA = await criarEmpresa(c, CNPJ_A, 'Empresa A');
    d.empresaB = await criarEmpresa(c, CNPJ_B, 'Empresa B');
    d.usuarioA = await criarUsuario(c, d.empresaA, 'a@example.invalid');
    d.funcionarioA = await criarFuncionario(c, d.empresaA, { matricula: 'A-1', cpf: '11111111111' });
    d.botinaA = await criarMaterial(c, d.empresaA, 'Botina');
    d.fichaA = await criarFicha(c, d.empresaA, d.funcionarioA);
    d.loteA = await criarLote(c, { empresaId: d.empresaA, materialId: d.botinaA, quantidade: 100 });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('estrutura: tabela com PK em entrega_id, FK composta, CHECKs e gatilhos; fechamento da composição nas outras tabelas; hash_conteudo documentado como checksum', async () => {
    const { rows: constraints } = await q("SELECT conname FROM pg_constraint WHERE conrelid = 'entregas_epi_confirmacoes'::regclass ORDER BY conname");
    assert.deepEqual(constraints.map((r) => r.conname), CONSTRAINTS);
    const { rows: gatilhos } = await q("SELECT tgname FROM pg_trigger WHERE tgrelid = 'entregas_epi_confirmacoes'::regclass AND NOT tgisinternal ORDER BY tgname");
    assert.deepEqual(gatilhos.map((r) => r.tgname), GATILHOS);

    const { rows: colunas } = await q(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entregas_epi_confirmacoes' ORDER BY ordinal_position",
    );
    assert.deepEqual(colunas, [
      { column_name: 'entrega_id', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'empresa_id', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'modo', data_type: 'character varying', is_nullable: 'NO' },
      { column_name: 'tracos', data_type: 'jsonb', is_nullable: 'YES' },
      { column_name: 'declaracao_versao', data_type: 'character varying', is_nullable: 'NO' },
      { column_name: 'declaracao_texto', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'confirmada_em', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'ip', data_type: 'character varying', is_nullable: 'YES' },
      { column_name: 'dispositivo', data_type: 'character varying', is_nullable: 'YES' },
      { column_name: 'hash_conteudo', data_type: 'character', is_nullable: 'NO' },
    ]);
    const { rows: [{ comentario }] } = await q(
      "SELECT col_description('entregas_epi_confirmacoes'::regclass, attnum) AS comentario FROM pg_attribute WHERE attrelid = 'entregas_epi_confirmacoes'::regclass AND attname = 'hash_conteudo'",
    );
    assert.match(comentario ?? '', /checksum/i);
    assert.match(comentario ?? '', /não é assinatura/i);

    const { rows: fechamento } = await q(
      `SELECT c.conname, c.condeferrable, c.condeferred, t.relname::text AS tabela
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.conname = 'trg_entregas_epi_fechar_com_confirmacao'`,
    );
    assert.deepEqual(fechamento, [{ conname: 'trg_entregas_epi_fechar_com_confirmacao', condeferrable: true, condeferred: true, tabela: 'entregas_epi' }]);
    const { rows: gatilhoDoItem } = await q(
      "SELECT tgtype FROM pg_trigger WHERE tgrelid = 'entregas_epi_itens'::regclass AND tgname = 'trg_entregas_epi_itens_bloquear_apos_confirmacao'",
    );
    assert.equal(gatilhoDoItem.length, 1);
  });

  test('confirmação completa: DESENHO com traços em JSON e ACEITE_PRESENCIAL sem traços; confirmada_em vem do servidor', async () => {
    const desenho = await registrarEntrega(c, {
      entrega: entregaBase(), itens: [itemBase()], usuarioId: d.usuarioA,
      confirmacao: { modo: 'DESENHO', tracos: JSON.stringify(TRACOS) },
    });
    const presencial = await registrarEntrega(c, {
      entrega: entregaBase(), itens: [itemBase()], usuarioId: d.usuarioA,
      confirmacao: { modo: 'ACEITE_PRESENCIAL', tracos: null },
    });
    const { rows } = await q(
      `SELECT entrega_id, modo, tracos, ip, dispositivo, declaracao_versao, confirmada_em >= now() - interval '1 minute' AS recente
         FROM entregas_epi_confirmacoes WHERE entrega_id = ANY($1) ORDER BY entrega_id`,
      [[desenho.entrega.id, presencial.entrega.id]],
    );
    assert.deepEqual(rows, [
      { entrega_id: desenho.entrega.id, modo: 'DESENHO', tracos: TRACOS, ip: '203.0.113.10', dispositivo: 'Navegador de teste', declaracao_versao: 'NR6-2026-09', recente: true },
      { entrega_id: presencial.entrega.id, modo: 'ACEITE_PRESENCIAL', tracos: null, ip: '203.0.113.10', dispositivo: 'Navegador de teste', declaracao_versao: 'NR6-2026-09', recente: true },
    ]);
    d.entregaGravada = desenho.entrega.id;
  });

  test('exatamente uma confirmação por entrega: a segunda é recusada; outra empresa ou entrega inexistente não têm item e são recusadas antes da FK', async () => {
    const segunda = await erroDe(inserirConfirmacao(c, { empresa_id: d.empresaA, entrega_id: d.entregaGravada }));
    assert.deepEqual([segunda?.code, segunda?.constraint], [VIOLACAO_UNIQUE, 'entregas_epi_confirmacoes_pkey']);
    // O gatilho BEFORE INSERT procura item da mesma empresa para a entrega e dispara antes da FK composta.
    const outraEmpresa = await tentarConfirmacao({ empresa_id: d.empresaB });
    assert.deepEqual([outraEmpresa?.code, outraEmpresa?.constraint], [VIOLACAO_CHECK, 'trg_entregas_epi_confirmacoes_exigir_item']);
    const entregaInexistente = await erroDe(inserirConfirmacao(c, { empresa_id: d.empresaA, entrega_id: 999999 }));
    assert.deepEqual([entregaInexistente?.code, entregaInexistente?.constraint], [VIOLACAO_CHECK, 'trg_entregas_epi_confirmacoes_exigir_item']);
    // Sem o gatilho, a FK composta continua sendo a barreira (o DISABLE é desfeito pelo ROLLBACK).
    const semGatilho = await comEntregaAberta(async (entrega) => {
      await q('ALTER TABLE entregas_epi_confirmacoes DISABLE TRIGGER trg_entregas_epi_confirmacoes_exigir_item');
      return erroDe(inserirConfirmacao(c, { empresa_id: d.empresaB, entrega_id: entrega.id }));
    });
    assert.deepEqual([semGatilho?.code, semGatilho?.constraint], [VIOLACAO_FK, 'fk_entregas_epi_confirmacoes_entrega_mesma_empresa']);
  });

  test('modos: DESENHO sem traços recusado; ACEITE_PRESENCIAL com traços recusado; modo desconhecido recusado; sem biometria', async () => {
    const casos = [
      [{ modo: 'DESENHO', tracos: null }, 'chk_entregas_epi_confirmacoes_tracos_por_modo'],
      [{ modo: 'ACEITE_PRESENCIAL', tracos: JSON.stringify(TRACOS) }, 'chk_entregas_epi_confirmacoes_tracos_por_modo'],
      [{ modo: 'BIOMETRIA', tracos: null }, 'chk_entregas_epi_confirmacoes_modo'],
      [{ modo: 'DIGITAL', tracos: null }, 'chk_entregas_epi_confirmacoes_modo'],
      [{ modo: 'desenho', tracos: JSON.stringify(TRACOS) }, 'chk_entregas_epi_confirmacoes_modo'],
    ];
    for (const [valores, constraint] of casos) {
      const erro = await tentarConfirmacao(valores);
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, constraint], JSON.stringify(valores));
    }
  });

  test('traços: JSON válido obrigatório, array não vazio, dentro do limite defensivo de tamanho', async () => {
    const invalido = await tentarConfirmacao({ modo: 'DESENHO', tracos: '{"a":' });
    assert.equal(invalido?.code, JSON_INVALIDO);
    const casos = [
      [{ modo: 'DESENHO', tracos: JSON.stringify({ pontos: [1, 2] }) }, 'chk_entregas_epi_confirmacoes_tracos_formato'],
      [{ modo: 'DESENHO', tracos: JSON.stringify([]) }, 'chk_entregas_epi_confirmacoes_tracos_formato'],
      [{ modo: 'DESENHO', tracos: JSON.stringify('assinatura') }, 'chk_entregas_epi_confirmacoes_tracos_formato'],
      [{ modo: 'DESENHO', tracos: JSON.stringify(Array.from({ length: 3000 }, (_, i) => [i, i])) }, 'chk_entregas_epi_confirmacoes_tracos_formato'],
    ];
    for (const [valores, constraint] of casos) {
      const erro = await tentarConfirmacao(valores);
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, constraint], valores.tracos.slice(0, 40));
    }
    const grandeMasDentro = Array.from({ length: 1500 }, (_, i) => [i, i]);
    assert.ok(Buffer.byteLength(JSON.stringify(grandeMasDentro)) < LIMITE_TRACOS_BYTES);
    assert.equal(await tentarConfirmacao({ modo: 'DESENHO', tracos: JSON.stringify(grandeMasDentro) }), null);
  });

  test('hash_conteudo é SHA-256 hexadecimal minúsculo; declaracao_versao não pode ser vazia', async () => {
    const casos = [
      [{ hash_conteudo: 'C'.repeat(64) }, 'chk_entregas_epi_confirmacoes_hash_conteudo'],
      [{ hash_conteudo: 'abc' }, 'chk_entregas_epi_confirmacoes_hash_conteudo'],
      [{ declaracao_versao: '' }, 'chk_entregas_epi_confirmacoes_declaracao_versao'],
      [{ declaracao_versao: ' NR6 ' }, 'chk_entregas_epi_confirmacoes_declaracao_versao'],
    ];
    for (const [valores, constraint] of casos) {
      const erro = await tentarConfirmacao(valores);
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, constraint], JSON.stringify(valores));
    }
    assert.equal(await tentarConfirmacao({ ip: null, dispositivo: null }), null, 'IP e dispositivo são opcionais');
  });

  test('declaracao_texto: cópia obrigatória do texto confirmado — ausente, vazio, só espaços, com espaços nas pontas e acima de 4000 recusados; limite aceito; texto persistido exatamente', async () => {
    const ausente = await tentarConfirmacao({ declaracao_texto: null });
    assert.equal(ausente?.code, NULO_OBRIGATORIO);
    const casos = ['', '   ', ' texto com espaços nas pontas ', `${DECLARACAO}\n`, 'x'.repeat(LIMITE_DECLARACAO + 1)];
    for (const texto of casos) {
      const erro = await tentarConfirmacao({ declaracao_texto: texto });
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, 'chk_entregas_epi_confirmacoes_declaracao_texto'], JSON.stringify(texto.slice(0, 40)));
    }
    assert.equal(await tentarConfirmacao({ declaracao_texto: 'x'.repeat(LIMITE_DECLARACAO) }), null, 'no limite');
    assert.equal(await tentarConfirmacao({ declaracao_texto: 'Recebi.' }), null, 'curto');

    const textoComAcentosEQuebras = 'Declaração de recebimento — 1ª via.\nRecebi os EPIs e fui orientado(a) sobre o uso.';
    const { entrega } = await registrarEntrega(c, {
      entrega: entregaBase(), itens: [itemBase()], usuarioId: d.usuarioA,
      confirmacao: { declaracao_texto: textoComAcentosEQuebras, declaracao_versao: 'NR6-2026-09.1' },
    });
    const { rows: [linha] } = await q('SELECT declaracao_texto, declaracao_versao FROM entregas_epi_confirmacoes WHERE entrega_id = $1', [entrega.id]);
    assert.deepEqual(linha, { declaracao_texto: textoComAcentosEQuebras, declaracao_versao: 'NR6-2026-09.1' });
    assert.equal((await erroDe(q('UPDATE entregas_epi_confirmacoes SET declaracao_texto = $2 WHERE entrega_id = $1', [entrega.id, 'Outro texto'])))?.code, RECUSA_DO_TRIGGER);
  });

  test('entrega sem confirmação falha no COMMIT e nada fica gravado, nem a baixa do estoque', async () => {
    const antes = (await q('SELECT count(*)::int AS n FROM entregas_epi')).rows[0].n;
    const { rows: [{ quantidade_entregue: entregueAntes }] } = await q('SELECT quantidade_entregue FROM estoque_lotes WHERE id = $1', [d.loteA]);
    await q('BEGIN');
    const entrega = await inserirEntrega(c, entregaBase());
    const item = await inserirItem(c, itemBase(entrega.id));
    await inserirOperacaoEntrega(c, { empresa_id: d.empresaA, lote_id: d.loteA, quantidade: 1, usuario_id: d.usuarioA, entrega_item_id: item.id });
    const erro = await erroDe(q('COMMIT'));
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, 'trg_entregas_epi_fechar_com_confirmacao']);
    assert.equal((await q('SELECT count(*)::int AS n FROM entregas_epi')).rows[0].n, antes);
    const { rows: [{ quantidade_entregue }] } = await q('SELECT quantidade_entregue FROM estoque_lotes WHERE id = $1', [d.loteA]);
    assert.equal(quantidade_entregue, entregueAntes);
  });

  test('a confirmação fecha a composição: não entra antes do primeiro item, e nenhum item entra depois dela (na mesma transação ou depois do COMMIT)', async () => {
    await q('BEGIN');
    const semItem = await erroDe((async () => {
      const entrega = await inserirEntrega(c, entregaBase());
      await inserirConfirmacao(c, { empresa_id: d.empresaA, entrega_id: entrega.id });
    })());
    await q('ROLLBACK');
    assert.deepEqual([semItem?.code, semItem?.constraint], [VIOLACAO_CHECK, 'trg_entregas_epi_confirmacoes_exigir_item']);

    const loteNovo = await criarLote(c, { empresaId: d.empresaA, materialId: d.botinaA, quantidade: 5, tamanho: '41' });
    const naMesmaTransacao = await comEntregaAberta(async (entrega) => {
      await inserirConfirmacao(c, { empresa_id: d.empresaA, entrega_id: entrega.id });
      return erroDe(inserirItem(c, { ...itemBase(entrega.id), lote_id: loteNovo }));
    });
    assert.deepEqual([naMesmaTransacao?.code, naMesmaTransacao?.constraint], [VIOLACAO_CHECK, 'trg_entregas_epi_itens_bloquear_apos_confirmacao']);

    const depoisDoCommit = await erroDe(inserirItem(c, { ...itemBase(d.entregaGravada), lote_id: loteNovo }));
    assert.deepEqual([depoisDoCommit?.code, depoisDoCommit?.constraint], [VIOLACAO_CHECK, 'trg_entregas_epi_itens_bloquear_apos_confirmacao']);
  });

  test('histórico append-only: a confirmação recusa UPDATE, DELETE e TRUNCATE', async () => {
    const tentativas = [
      ["UPDATE entregas_epi_confirmacoes SET modo = 'ACEITE_PRESENCIAL', tracos = NULL WHERE entrega_id = $1", [d.entregaGravada]],
      ['UPDATE entregas_epi_confirmacoes SET hash_conteudo = $2 WHERE entrega_id = $1', [d.entregaGravada, 'd'.repeat(64)]],
      ['UPDATE entregas_epi_confirmacoes SET tracos = $2 WHERE entrega_id = $1', [d.entregaGravada, JSON.stringify([[[1, 1]]])]],
      ['DELETE FROM entregas_epi_confirmacoes WHERE entrega_id = $1', [d.entregaGravada]],
      ['TRUNCATE entregas_epi_confirmacoes', []],
    ];
    for (const [sql, params] of tentativas) {
      assert.equal((await erroDe(q(sql, params)))?.code, RECUSA_DO_TRIGGER, sql);
    }
    const { rows: [linha] } = await q('SELECT modo, tracos FROM entregas_epi_confirmacoes WHERE entrega_id = $1', [d.entregaGravada]);
    assert.deepEqual(linha, { modo: 'DESENHO', tracos: TRACOS });
  });

  test('manifesto: entrada da 060 coerente com o arquivo', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_060))).digest('hex');
    assert.equal(manifesto.migrations[ARQUIVO_060], sha);
  });
});
