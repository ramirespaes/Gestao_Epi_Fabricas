'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const {
  todasAsMigrations, erroDe, inserir, criarEmpresa, criarUsuario, criarGhe, criarFuncionario,
  criarMaterial, criarLote, proximoNumeroDaFicha, criarFicha, inserirEntrega, inserirItem, registrarEntrega,
} = require('./helpers/entrega-epi');

/**
 * Migration 058 — ficha de EPI (uma por trabalhador, numerada por empresa),
 * contador da numeração, entrega (evento dentro da ficha, com as cópias
 * congeladas do documento) e itens da entrega. PostgreSQL real, schema
 * temporário.
 *
 * A estrutura é conferida num schema que para na 058. O comportamento roda
 * num schema com todas as migrations do diretório, porque a composição
 * completa (item → operação ENTREGA → confirmação) depende das seguintes.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_058 = '058_create_fichas_entregas_epi.sql';
const TODAS = todasAsMigrations();
const ATE_A_058 = TODAS.filter((prefixo) => prefixo <= '058');
const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';
const NULO_OBRIGATORIO = '23502';
const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';
// TRUNCATE em tabela referenciada por FK cai em feature_not_supported antes do gatilho.
const RECUSAS_DE_TRUNCATE = ['0A000', RECUSA_DO_TRIGGER];
const MOTIVOS = ['ADMISSAO', 'SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO', 'OUTRO'];

const ESTRUTURA = {
  fichas_epi: {
    constraints: [
      'chk_fichas_epi_numero',
      'fichas_epi_pkey',
      'fk_fichas_epi_funcionario_mesma_empresa',
      'uq_fichas_epi_empresa_funcionario',
      'uq_fichas_epi_empresa_id',
      'uq_fichas_epi_empresa_numero',
    ],
    triggers: [
      'trg_fichas_epi_bloquear_delete',
      'trg_fichas_epi_bloquear_truncate',
      'trg_fichas_epi_bloquear_update',
    ],
  },
  fichas_epi_numeracao: {
    constraints: [
      'chk_fichas_epi_numeracao_ultimo_numero',
      'fichas_epi_numeracao_empresa_id_fkey',
      'fichas_epi_numeracao_pkey',
    ],
    triggers: [
      'trg_fichas_epi_numeracao_bloquear_delete',
      'trg_fichas_epi_numeracao_bloquear_truncate',
      'trg_fichas_epi_numeracao_iniciar_em_um',
      'trg_fichas_epi_numeracao_proteger_update',
    ],
  },
  entregas_epi: {
    constraints: [
      'chk_entregas_epi_data_operacional',
      'chk_entregas_epi_empresa_cnpj',
      'chk_entregas_epi_empresa_uf',
      'chk_entregas_epi_ghe_nome',
      'chk_entregas_epi_origem',
      'chk_entregas_epi_requisicao_hash',
      'chk_entregas_epi_snapshots_aparados',
      'entregas_epi_pkey',
      'fk_entregas_epi_ficha_mesma_empresa',
      'fk_entregas_epi_ghe_mesma_empresa',
      'fk_entregas_epi_responsavel_mesma_empresa',
      'trg_entregas_epi_exigir_item',
      'uq_entregas_epi_empresa_id',
      'uq_entregas_epi_idempotencia',
    ],
    triggers: [
      'trg_entregas_epi_bloquear_delete',
      'trg_entregas_epi_bloquear_truncate',
      'trg_entregas_epi_bloquear_update',
      'trg_entregas_epi_exigir_item',
    ],
  },
  entregas_epi_itens: {
    constraints: [
      'chk_entregas_epi_itens_fora_do_ghe',
      'chk_entregas_epi_itens_justificativa',
      'chk_entregas_epi_itens_justificativa_fora_ghe',
      'chk_entregas_epi_itens_material_oculos',
      'chk_entregas_epi_itens_material_prazo',
      'chk_entregas_epi_itens_motivo',
      'chk_entregas_epi_itens_outro_justificado',
      'chk_entregas_epi_itens_quantidade',
      'chk_entregas_epi_itens_snapshots_aparados',
      'entregas_epi_itens_pkey',
      'fk_entregas_epi_itens_entrega_mesma_empresa',
      'fk_entregas_epi_itens_lote_do_material',
      'uq_entregas_epi_itens_entrega_lote',
      'uq_entregas_epi_itens_vinculo_operacao',
    ],
    triggers: [
      'trg_entregas_epi_itens_bloquear_delete',
      'trg_entregas_epi_itens_bloquear_truncate',
      'trg_entregas_epi_itens_bloquear_update',
    ],
  },
};

// A busca de itens por entrega usa uq_entregas_epi_itens_entrega_lote; não há índice próprio.
const INDICES_058 = [
  'idx_entregas_epi_empresa_entregue_em',
  'idx_entregas_epi_ficha',
  'idx_entregas_epi_itens_material',
];

describe('migration 058 — estrutura logo após a sua aplicação', () => {
  let contexto;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  before(async () => {
    contexto = await abrirSchemaTemporario(ATE_A_058);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('as quatro tabelas existem com exatamente as constraints e os gatilhos esperados; índices da 058', async () => {
    for (const [tabela, esperado] of Object.entries(ESTRUTURA)) {
      const { rows: constraints } = await q(
        'SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname',
        [tabela],
      );
      assert.deepEqual(constraints.map((r) => r.conname), esperado.constraints, `constraints de ${tabela}`);
      const { rows: triggers } = await q(
        'SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname',
        [tabela],
      );
      assert.deepEqual(triggers.map((r) => r.tgname), esperado.triggers, `gatilhos de ${tabela}`);
    }
    const { rows: indices } = await q(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'idx_entregas_epi%' ORDER BY indexname",
    );
    assert.deepEqual(indices.map((r) => r.indexname), INDICES_058);
  });

  test('o gatilho de item mínimo é adiável e adiado por padrão', async () => {
    const { rows } = await q(
      "SELECT contype, condeferrable, condeferred FROM pg_constraint WHERE conname = 'trg_entregas_epi_exigir_item' AND connamespace = current_schema()::regnamespace",
    );
    assert.deepEqual(rows, [{ contype: 't', condeferrable: true, condeferred: true }]);
  });

  test('cópias congeladas: colunas da empresa, do trabalhador, do GHE e do responsável; CPF não é duplicado; sem coluna de status', async () => {
    const { rows } = await q(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entregas_epi' AND (column_name LIKE 'empresa\\_%' OR column_name LIKE 'trabalhador\\_%' OR column_name LIKE 'ghe\\_%' OR column_name LIKE 'responsavel\\_%') ORDER BY column_name",
    );
    assert.deepEqual(rows, [
      { column_name: 'empresa_cidade', is_nullable: 'YES' },
      { column_name: 'empresa_cnpj', is_nullable: 'NO' },
      { column_name: 'empresa_endereco', is_nullable: 'YES' },
      { column_name: 'empresa_id', is_nullable: 'NO' },
      { column_name: 'empresa_nome', is_nullable: 'NO' },
      { column_name: 'empresa_uf', is_nullable: 'YES' },
      { column_name: 'ghe_id', is_nullable: 'YES' },
      { column_name: 'ghe_nome', is_nullable: 'YES' },
      { column_name: 'responsavel_id', is_nullable: 'NO' },
      { column_name: 'responsavel_nome', is_nullable: 'NO' },
      { column_name: 'trabalhador_funcao', is_nullable: 'YES' },
      { column_name: 'trabalhador_matricula', is_nullable: 'NO' },
      { column_name: 'trabalhador_nome', is_nullable: 'NO' },
      { column_name: 'trabalhador_setor', is_nullable: 'YES' },
    ]);
    const { rows: cpf } = await q(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('entregas_epi', 'entregas_epi_itens', 'fichas_epi') AND column_name LIKE '%cpf%'",
    );
    assert.equal(cpf[0].n, 0);
    const { rows: status } = await q(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entregas_epi' AND column_name IN ('status', 'situacao', 'pendente')",
    );
    assert.equal(status[0].n, 0);
  });

  test('cópias do material nos itens: nome, tipo, código interno, unidade, prazo, óculos com grau e exige_ca; tamanho, CA e validade ficam no lote', async () => {
    const { rows } = await q(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entregas_epi_itens' AND column_name LIKE 'material\\_%' ORDER BY column_name",
    );
    assert.deepEqual(rows, [
      { column_name: 'material_codigo_interno', is_nullable: 'YES' },
      { column_name: 'material_exige_ca', is_nullable: 'NO' },
      { column_name: 'material_id', is_nullable: 'NO' },
      { column_name: 'material_nome', is_nullable: 'NO' },
      { column_name: 'material_oculos_com_grau', is_nullable: 'YES' },
      { column_name: 'material_prazo_uso_dias', is_nullable: 'NO' },
      { column_name: 'material_tipo', is_nullable: 'YES' },
      { column_name: 'material_unidade', is_nullable: 'NO' },
    ]);
    const { rows: derivados } = await q(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entregas_epi_itens' AND (column_name LIKE '%tamanho%' OR column_name LIKE '%ca\\_%' OR column_name LIKE '%validade%')",
    );
    assert.equal(derivados[0].n, 0);
  });

  test('manifesto: entrada da 058 coerente com o arquivo', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_058))).digest('hex');
    assert.equal(manifesto.migrations[ARQUIVO_058], sha);
  });
});

describe('migration 058 — comportamento, com todas as migrations do diretório', () => {
  let contexto;
  let c;
  const d = {};

  const q = (sql, params) => c.query(sql, params);

  // Aceitação imediata sem gravar: as conferências adiadas não chegam a rodar.
  async function aceitoSemGravar(fn) {
    await q('BEGIN');
    try {
      return await fn();
    } finally {
      await q('ROLLBACK');
    }
  }

  const entregaBase = () => ({
    empresa_id: d.empresaA, ficha_id: d.fichaA1.id, responsavel_id: d.usuarioA, empresa_cnpj: CNPJ_A,
    ghe_id: d.gheA, ghe_nome: 'GHE Produção',
  });
  const itemBase = (entregaId) => ({
    empresa_id: d.empresaA, entrega_id: entregaId, material_id: d.botinaA, lote_id: d.loteBotinaA,
  });
  const tentarItem = (valores, antes = null) => aceitoSemGravar(async () => {
    const entrega = await inserirEntrega(c, entregaBase());
    if (antes) await inserirItem(c, { ...itemBase(entrega.id), ...antes });
    return erroDe(inserirItem(c, { ...itemBase(entrega.id), ...valores }));
  });
  const tentarEntrega = (valores) => aceitoSemGravar(() => erroDe(inserirEntrega(c, { ...entregaBase(), ...valores })));

  before(async () => {
    contexto = await abrirSchemaTemporario(TODAS);
    c = contexto.cliente;
    d.empresaA = await criarEmpresa(c, CNPJ_A, 'Empresa A');
    d.empresaB = await criarEmpresa(c, CNPJ_B, 'Empresa B');
    d.usuarioA = await criarUsuario(c, d.empresaA, 'a@example.invalid');
    d.usuarioB = await criarUsuario(c, d.empresaB, 'b@example.invalid');
    d.gheA = await criarGhe(c, d.empresaA, 'GHE Produção');
    d.gheB = await criarGhe(c, d.empresaB, 'GHE B');
    d.funcionarioA1 = await criarFuncionario(c, d.empresaA, { matricula: 'A-1', cpf: '11111111111', gheId: d.gheA });
    d.funcionarioA2 = await criarFuncionario(c, d.empresaA, { matricula: 'A-2', cpf: '22222222222' });
    d.funcionarioB1 = await criarFuncionario(c, d.empresaB, { matricula: 'B-1', cpf: '33333333333' });
    d.botinaA = await criarMaterial(c, d.empresaA, 'Botina');
    d.luvaA = await criarMaterial(c, d.empresaA, 'Luva');
    d.botinaB = await criarMaterial(c, d.empresaB, 'Botina B');
    d.loteBotinaA = await criarLote(c, { empresaId: d.empresaA, materialId: d.botinaA, quantidade: 50 });
    d.loteLuvaA = await criarLote(c, { empresaId: d.empresaA, materialId: d.luvaA, quantidade: 50, tamanho: 'M' });
    d.loteBotinaB = await criarLote(c, { empresaId: d.empresaB, materialId: d.botinaB, quantidade: 10 });
    d.fichaA1 = await criarFicha(c, d.empresaA, d.funcionarioA1);
    d.fichaB1 = await criarFicha(c, d.empresaB, d.funcionarioB1);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('numeração: sequencial por empresa, independente entre empresas, e o ROLLBACK não deixa lacuna', async () => {
    assert.equal(d.fichaA1.numero, 1);
    assert.equal(d.fichaB1.numero, 1);
    await q('BEGIN');
    assert.equal(await proximoNumeroDaFicha(c, d.empresaA), 2);
    await q('ROLLBACK');
    assert.equal(await aceitoSemGravar(() => proximoNumeroDaFicha(c, d.empresaA)), 2);
    assert.equal((await q('SELECT ultimo_numero FROM fichas_epi_numeracao WHERE empresa_id = $1', [d.empresaA])).rows[0].ultimo_numero, 1);
  });

  test('numeração: UPDATE controlado — só o incremento de um em um; saltar, voltar, trocar a empresa, DELETE e TRUNCATE são recusados', async () => {
    const tentar = (sql, params) => erroDe(q(sql, params));
    assert.equal(await tentar('UPDATE fichas_epi_numeracao SET ultimo_numero = ultimo_numero + 1 WHERE empresa_id = $1', [d.empresaA]), null);
    assert.equal((await q('SELECT ultimo_numero FROM fichas_epi_numeracao WHERE empresa_id = $1', [d.empresaA])).rows[0].ultimo_numero, 2);
    const recusas = [
      ['UPDATE fichas_epi_numeracao SET ultimo_numero = ultimo_numero + 2 WHERE empresa_id = $1', [d.empresaA]],
      ['UPDATE fichas_epi_numeracao SET ultimo_numero = ultimo_numero - 1 WHERE empresa_id = $1', [d.empresaA]],
      ['UPDATE fichas_epi_numeracao SET ultimo_numero = 1 WHERE empresa_id = $1', [d.empresaA]],
      ['UPDATE fichas_epi_numeracao SET empresa_id = $2 WHERE empresa_id = $1', [d.empresaA, d.empresaB]],
      ['DELETE FROM fichas_epi_numeracao WHERE empresa_id = $1', [d.empresaA]],
      ['TRUNCATE fichas_epi_numeracao', []],
    ];
    for (const [sql, params] of recusas) {
      assert.equal((await tentar(sql, params))?.code, RECUSA_DO_TRIGGER, sql);
    }
    const semEmpresa = await tentar('INSERT INTO fichas_epi_numeracao (empresa_id, ultimo_numero) VALUES (999999, 1)', []);
    assert.equal(semEmpresa?.code, VIOLACAO_FK);
    const segundaLinha = await tentar('INSERT INTO fichas_epi_numeracao (empresa_id, ultimo_numero) VALUES ($1, 1)', [d.empresaA]);
    assert.equal(segundaLinha?.code, VIOLACAO_UNIQUE);
    // Deixo o contador em 3: a próxima ficha da empresa A recebe o número 4.
    await q('UPDATE fichas_epi_numeracao SET ultimo_numero = ultimo_numero + 1 WHERE empresa_id = $1', [d.empresaA]);
    d.proximoNumeroA = 4;
  });

  test('numeração: o contador de uma empresa nasce obrigatoriamente em 1; 0, 2, 5 e 100 são recusados; depois só +1; o ROLLBACK não deixa lacuna', async () => {
    const empresaC = await criarEmpresa(c, '77888999000101', 'Empresa C');
    const inserirContador = (valor) => erroDe(q('INSERT INTO fichas_epi_numeracao (empresa_id, ultimo_numero) VALUES ($1, $2)', [empresaC, valor]));
    for (const valor of [5, 100, 2, 0]) {
      assert.equal((await inserirContador(valor))?.code, RECUSA_DO_TRIGGER, `início em ${valor}`);
    }
    assert.equal((await q('SELECT count(*)::int AS n FROM fichas_epi_numeracao WHERE empresa_id = $1', [empresaC])).rows[0].n, 0);
    // O CHECK de positividade continua por trás do gatilho (DISABLE desfeito pelo ROLLBACK).
    await q('BEGIN');
    await q('ALTER TABLE fichas_epi_numeracao DISABLE TRIGGER trg_fichas_epi_numeracao_iniciar_em_um');
    const zeroSemGatilho = await inserirContador(0);
    await q('ROLLBACK');
    assert.deepEqual([zeroSemGatilho?.code, zeroSemGatilho?.constraint], [VIOLACAO_CHECK, 'chk_fichas_epi_numeracao_ultimo_numero']);

    assert.equal(await inserirContador(1), null);
    assert.equal((await erroDe(q('UPDATE fichas_epi_numeracao SET ultimo_numero = 3 WHERE empresa_id = $1', [empresaC])))?.code, RECUSA_DO_TRIGGER);
    await q('BEGIN');
    assert.equal(await proximoNumeroDaFicha(c, empresaC), 2);
    await q('ROLLBACK');
    assert.equal(await proximoNumeroDaFicha(c, empresaC), 2);
    assert.equal((await q('SELECT ultimo_numero FROM fichas_epi_numeracao WHERE empresa_id = $1', [empresaC])).rows[0].ultimo_numero, 2);
    // A primeira ficha de uma empresa nova, pelo mesmo SQL do serviço, nasce com o número 1
    // (transação revertida: as contagens dos testes seguintes não mudam).
    const empresaD = await criarEmpresa(c, '55666777000188', 'Empresa D');
    const funcionarioD = await criarFuncionario(c, empresaD, { matricula: 'D-1', cpf: '44444444444' });
    const primeiraFicha = await aceitoSemGravar(async () => {
      const numero = await proximoNumeroDaFicha(c, empresaD);
      return inserir(c, 'fichas_epi', { empresa_id: empresaD, numero, funcionario_id: funcionarioD });
    });
    assert.equal(primeiraFicha.numero, 1);
  });

  test('ficha: segunda ficha para o mesmo funcionário recusada; número repetido na empresa recusado; funcionário de outra empresa recusado; número ≤ 0 recusado', async () => {
    const inserirFicha = (valores) => erroDe(inserir(c, 'fichas_epi', valores));
    const duplicada = await inserirFicha({ empresa_id: d.empresaA, numero: d.proximoNumeroA, funcionario_id: d.funcionarioA1 });
    assert.deepEqual([duplicada?.code, duplicada?.constraint], [VIOLACAO_UNIQUE, 'uq_fichas_epi_empresa_funcionario']);
    const numeroRepetido = await inserirFicha({ empresa_id: d.empresaA, numero: 1, funcionario_id: d.funcionarioA2 });
    assert.deepEqual([numeroRepetido?.code, numeroRepetido?.constraint], [VIOLACAO_UNIQUE, 'uq_fichas_epi_empresa_numero']);
    const outraEmpresa = await inserirFicha({ empresa_id: d.empresaA, numero: d.proximoNumeroA, funcionario_id: d.funcionarioB1 });
    assert.deepEqual([outraEmpresa?.code, outraEmpresa?.constraint], [VIOLACAO_FK, 'fk_fichas_epi_funcionario_mesma_empresa']);
    const zero = await inserirFicha({ empresa_id: d.empresaA, numero: 0, funcionario_id: d.funcionarioA2 });
    assert.deepEqual([zero?.code, zero?.constraint], [VIOLACAO_CHECK, 'chk_fichas_epi_numero']);
    assert.equal((await q('SELECT count(*)::int AS n FROM fichas_epi')).rows[0].n, 2);
  });

  test('ficha: o mesmo número existe em empresas diferentes; a ficha não aceita UPDATE, DELETE nem TRUNCATE', async () => {
    const fichaA2 = await criarFicha(c, d.empresaA, d.funcionarioA2);
    assert.equal(fichaA2.numero, d.proximoNumeroA);
    const { rows } = await q('SELECT empresa_id, numero FROM fichas_epi WHERE numero = 1 ORDER BY empresa_id');
    assert.deepEqual(rows, [{ empresa_id: d.empresaA, numero: 1 }, { empresa_id: d.empresaB, numero: 1 }]);
    for (const [sql, params] of [
      ['UPDATE fichas_epi SET numero = 99 WHERE id = $1', [fichaA2.id]],
      ['UPDATE fichas_epi SET funcionario_id = $2 WHERE id = $1', [fichaA2.id, d.funcionarioA1]],
      ['DELETE FROM fichas_epi WHERE id = $1', [fichaA2.id]],
    ]) {
      assert.equal((await erroDe(q(sql, params)))?.code, RECUSA_DO_TRIGGER, sql);
    }
    // Tabela referenciada por FK: o próprio PostgreSQL recusa o TRUNCATE antes do gatilho.
    assert.ok(RECUSAS_DE_TRUNCATE.includes((await erroDe(q('TRUNCATE fichas_epi')))?.code), 'TRUNCATE recusado');
  });

  test('entrega completa: cabeçalho, item, operação ENTREGA e confirmação numa transação; entregue_em e data_operacional vêm do servidor', async () => {
    const { entrega, itens } = await registrarEntrega(c, {
      entrega: entregaBase(),
      itens: [{ ...itemBase(), quantidade: 2, motivo: 'ADMISSAO' }],
      usuarioId: d.usuarioA,
    });
    assert.equal(itens.length, 1);
    const { rows: [linha] } = await q(
      `SELECT origem, data_operacional::text AS data_operacional,
              (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS hoje_sp,
              entregue_em >= now() - interval '1 minute' AS recente
         FROM entregas_epi WHERE id = $1`,
      [entrega.id],
    );
    assert.deepEqual([linha.origem, linha.recente, linha.data_operacional], ['DIRETA', true, linha.hoje_sp]);
    d.entregaCompleta = entrega.id;
  });

  test('entrega: ficha, responsável e GHE de outra empresa recusados pelas FKs compostas', async () => {
    const ficha = await tentarEntrega({ ficha_id: d.fichaB1.id });
    assert.deepEqual([ficha?.code, ficha?.constraint], [VIOLACAO_FK, 'fk_entregas_epi_ficha_mesma_empresa']);
    const responsavel = await tentarEntrega({ responsavel_id: d.usuarioB });
    assert.deepEqual([responsavel?.code, responsavel?.constraint], [VIOLACAO_FK, 'fk_entregas_epi_responsavel_mesma_empresa']);
    const ghe = await tentarEntrega({ ghe_id: d.gheB });
    assert.deepEqual([ghe?.code, ghe?.constraint], [VIOLACAO_FK, 'fk_entregas_epi_ghe_mesma_empresa']);
    const empresaCruzada = await tentarEntrega({ empresa_id: d.empresaB, empresa_cnpj: CNPJ_B });
    assert.equal(empresaCruzada?.code, VIOLACAO_FK, 'empresa B com ficha, responsável e GHE de A');
  });

  test('entrega: origem só DIRETA; GHE e nome do GHE andam juntos; CNPJ, UF e hash no formato; cópias obrigatórias não vazias e aparadas; data operacional incoerente recusada', async () => {
    const casos = [
      [{ origem: 'SOLICITACAO' }, 'chk_entregas_epi_origem'],
      [{ ghe_id: null }, 'chk_entregas_epi_ghe_nome'],
      [{ ghe_nome: null }, 'chk_entregas_epi_ghe_nome'],
      [{ empresa_cnpj: 'a1222333000181' }, 'chk_entregas_epi_empresa_cnpj'],
      [{ empresa_cnpj: '112223330001AB' }, 'chk_entregas_epi_empresa_cnpj'],
      [{ requisicao_hash: 'A'.repeat(64) }, 'chk_entregas_epi_requisicao_hash'],
      [{ requisicao_hash: 'ab' }, 'chk_entregas_epi_requisicao_hash'],
      [{ empresa_nome: '' }, 'chk_entregas_epi_snapshots_aparados'],
      [{ trabalhador_nome: ' Fulano ' }, 'chk_entregas_epi_snapshots_aparados'],
      [{ trabalhador_matricula: '' }, 'chk_entregas_epi_snapshots_aparados'],
      [{ responsavel_nome: '' }, 'chk_entregas_epi_snapshots_aparados'],
      [{ trabalhador_setor: '' }, 'chk_entregas_epi_snapshots_aparados'],
      [{ empresa_uf: 'sp' }, 'chk_entregas_epi_empresa_uf'],
      [{ data_operacional: '2020-01-01' }, 'chk_entregas_epi_data_operacional'],
    ];
    for (const [valores, constraint] of casos) {
      const erro = await tentarEntrega(valores);
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, constraint], JSON.stringify(valores));
    }
    assert.equal(await tentarEntrega({ ghe_id: null, ghe_nome: null }), null, 'entrega sem GHE é aceita');
    assert.equal(await tentarEntrega({
      empresa_endereco: 'Rua Fictícia, 100', empresa_cidade: 'Cidade', empresa_uf: 'SP', trabalhador_funcao: 'Operador', trabalhador_setor: 'Produção',
    }), null);
  });

  // O banco só garante a coerência entre os dois campos. Que entregue_em venha do
  // relógio do servidor, e não do cliente, é regra do serviço (10D/10E).
  test('data_operacional é exatamente o dia de entregue_em em São Paulo, inclusive na virada do dia; o dia UTC vizinho é recusado', async () => {
    const casos = [
      // entregue_em                       dia em SP       dia UTC vizinho recusado
      ['2026-09-30T02:59:59Z', '2026-09-29', '2026-09-30'],
      ['2026-09-30T03:00:00Z', '2026-09-30', '2026-09-29'],
      ['2026-10-01T00:10:00Z', '2026-09-30', '2026-10-01'],
      ['2026-09-30T23:59:59-03:00', '2026-09-30', '2026-10-01'],
      ['2026-10-01T00:00:00-03:00', '2026-10-01', '2026-09-30'],
      ['2026-12-31T02:30:00Z', '2026-12-30', '2026-12-31'],
      ['2027-01-01T01:00:00Z', '2026-12-31', '2027-01-01'],
    ];
    for (const [entregueEm, diaSp, diaVizinho] of casos) {
      assert.equal(await tentarEntrega({ entregue_em: entregueEm, data_operacional: diaSp }), null, `${entregueEm} = ${diaSp}`);
      const vizinho = await tentarEntrega({ entregue_em: entregueEm, data_operacional: diaVizinho });
      assert.deepEqual([vizinho?.code, vizinho?.constraint], [VIOLACAO_CHECK, 'chk_entregas_epi_data_operacional'], `${entregueEm} ≠ ${diaVizinho}`);
      const doisDias = await tentarEntrega({ entregue_em: entregueEm, data_operacional: diaSp === '2026-09-29' ? '2026-10-01' : '2026-09-27' });
      assert.equal(doisDias?.constraint, 'chk_entregas_epi_data_operacional', `${entregueEm} longe`);
    }
    const { rows: [{ definicao }] } = await q(
      "SELECT pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conname = 'chk_entregas_epi_data_operacional' AND conrelid = 'entregas_epi'::regclass",
    );
    assert.match(definicao, /America\/Sao_Paulo/);
    assert.doesNotMatch(definicao, /UTC|- 1|\+ 1/);
  });

  test('idempotência do cabeçalho: a mesma chave na mesma empresa é recusada; outra empresa pode repetir a chave', async () => {
    const chave = crypto.randomUUID();
    await registrarEntrega(c, {
      entrega: { ...entregaBase(), chave_idempotencia: chave },
      itens: [{ ...itemBase(), quantidade: 1 }],
      usuarioId: d.usuarioA,
    });
    const repetida = await tentarEntrega({ chave_idempotencia: chave });
    assert.deepEqual([repetida?.code, repetida?.constraint], [VIOLACAO_UNIQUE, 'uq_entregas_epi_idempotencia']);
    const outraEmpresa = await aceitoSemGravar(() => erroDe(inserirEntrega(c, {
      empresa_id: d.empresaB, ficha_id: d.fichaB1.id, responsavel_id: d.usuarioB, empresa_cnpj: CNPJ_B, chave_idempotencia: chave,
    })));
    assert.equal(outraEmpresa, null);
  });

  test('itens: quantidade ≤ 0, motivo fora da lista, OUTRO sem justificativa, justificativa fora do limite ou com espaços nas pontas', async () => {
    const casos = [
      [{ quantidade: 0 }, 'chk_entregas_epi_itens_quantidade'],
      [{ quantidade: -1 }, 'chk_entregas_epi_itens_quantidade'],
      [{ motivo: 'TROCA' }, 'chk_entregas_epi_itens_motivo'],
      [{ motivo: 'admissao' }, 'chk_entregas_epi_itens_motivo'],
      [{ motivo: 'OUTRO' }, 'chk_entregas_epi_itens_outro_justificado'],
      [{ motivo: 'OUTRO', justificativa: 'x'.repeat(501) }, 'chk_entregas_epi_itens_justificativa'],
      [{ motivo: 'OUTRO', justificativa: ' com espaço ' }, 'chk_entregas_epi_itens_justificativa'],
      [{ motivo: 'OUTRO', justificativa: '' }, 'chk_entregas_epi_itens_justificativa'],
    ];
    for (const [valores, constraint] of casos) {
      const erro = await tentarItem(valores);
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, constraint], JSON.stringify(valores));
    }
    for (const motivo of MOTIVOS) {
      assert.equal(await tentarItem({ motivo, justificativa: 'Justificativa fictícia' }), null, motivo);
    }
    assert.equal(await tentarItem({ motivo: 'OUTRO', justificativa: 'x'.repeat(500) }), null);
  });

  test('itens: fora do GHE sem justificativa recusado; previsto no GHE com justificativa de exceção recusado; os dois casos coerentes aceitos', async () => {
    const foraSemJustificativa = await tentarItem({ previsto_no_ghe: false });
    assert.deepEqual([foraSemJustificativa?.code, foraSemJustificativa?.constraint], [VIOLACAO_CHECK, 'chk_entregas_epi_itens_fora_do_ghe']);
    const previstoComJustificativa = await tentarItem({ previsto_no_ghe: true, justificativa_fora_ghe: 'Exceção sem motivo' });
    assert.deepEqual([previstoComJustificativa?.code, previstoComJustificativa?.constraint], [VIOLACAO_CHECK, 'chk_entregas_epi_itens_fora_do_ghe']);
    const foraComJustificativaLonga = await tentarItem({ previsto_no_ghe: false, justificativa_fora_ghe: 'y'.repeat(501) });
    assert.deepEqual([foraComJustificativaLonga?.code, foraComJustificativaLonga?.constraint], [VIOLACAO_CHECK, 'chk_entregas_epi_itens_justificativa_fora_ghe']);
    assert.equal(await tentarItem({ previsto_no_ghe: false, justificativa_fora_ghe: 'Atividade eventual fora do GHE' }), null);
    assert.equal(await tentarItem({ previsto_no_ghe: true }), null);
  });

  test('itens: lote de outro material, lote de outra empresa e entrega de outra empresa recusados; um item por lote na entrega', async () => {
    const outroMaterial = await tentarItem({ material_id: d.luvaA });
    assert.deepEqual([outroMaterial?.code, outroMaterial?.constraint], [VIOLACAO_FK, 'fk_entregas_epi_itens_lote_do_material']);
    const outraEmpresa = await tentarItem({ material_id: d.botinaB, lote_id: d.loteBotinaB });
    assert.deepEqual([outraEmpresa?.code, outraEmpresa?.constraint], [VIOLACAO_FK, 'fk_entregas_epi_itens_lote_do_material']);
    const entregaDeOutra = await aceitoSemGravar(async () => {
      const entrega = await inserirEntrega(c, entregaBase());
      return erroDe(inserirItem(c, {
        empresa_id: d.empresaB, entrega_id: entrega.id, material_id: d.botinaB, lote_id: d.loteBotinaB,
      }));
    });
    assert.deepEqual([entregaDeOutra?.code, entregaDeOutra?.constraint], [VIOLACAO_FK, 'fk_entregas_epi_itens_entrega_mesma_empresa']);
    const mesmoLote = await tentarItem({ quantidade: 2 }, { quantidade: 1 });
    assert.deepEqual([mesmoLote?.code, mesmoLote?.constraint], [VIOLACAO_UNIQUE, 'uq_entregas_epi_itens_entrega_lote']);
  });

  test('itens: cópias do material — prazo obrigatório e > 0, óculos com grau só em óculos de proteção, textos não vazios e aparados', async () => {
    const casos = [
      [{ material_prazo_uso_dias: 0 }, 'chk_entregas_epi_itens_material_prazo'],
      [{ material_oculos_com_grau: true }, 'chk_entregas_epi_itens_material_oculos'],
      [{ material_oculos_com_grau: false, material_tipo: 'Calçado' }, 'chk_entregas_epi_itens_material_oculos'],
      [{ material_nome: '' }, 'chk_entregas_epi_itens_snapshots_aparados'],
      [{ material_unidade: ' ' }, 'chk_entregas_epi_itens_snapshots_aparados'],
      [{ material_codigo_interno: '' }, 'chk_entregas_epi_itens_snapshots_aparados'],
      [{ material_tipo: ' Calçado' }, 'chk_entregas_epi_itens_snapshots_aparados'],
    ];
    for (const [valores, constraint] of casos) {
      const erro = await tentarItem(valores);
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, constraint], JSON.stringify(valores));
    }
    assert.equal(await tentarItem({ material_oculos_com_grau: true, material_tipo: 'Óculos de proteção' }), null);
    assert.equal(await tentarItem({ material_tipo: 'Calçado', material_codigo_interno: 'BOT-01' }), null);
    const semPrazo = await tentarItem({ material_prazo_uso_dias: null });
    assert.equal(semPrazo?.code, NULO_OBRIGATORIO);
  });

  test('entrega sem item falha no COMMIT e nada fica gravado', async () => {
    const antes = (await q('SELECT count(*)::int AS n FROM entregas_epi')).rows[0].n;
    await q('BEGIN');
    await inserirEntrega(c, entregaBase());
    const erro = await erroDe(q('COMMIT'));
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, 'trg_entregas_epi_exigir_item']);
    assert.equal((await q('SELECT count(*)::int AS n FROM entregas_epi')).rows[0].n, antes);
  });

  test('histórico append-only: entregas_epi e entregas_epi_itens recusam UPDATE, DELETE e TRUNCATE', async () => {
    const itemId = (await q('SELECT id FROM entregas_epi_itens WHERE entrega_id = $1', [d.entregaCompleta])).rows[0].id;
    const tentativas = [
      ['UPDATE entregas_epi SET trabalhador_nome = $2 WHERE id = $1', [d.entregaCompleta, 'Outro']],
      ['UPDATE entregas_epi SET ficha_id = $2 WHERE id = $1', [d.entregaCompleta, d.fichaA1.id]],
      ['DELETE FROM entregas_epi WHERE id = $1', [d.entregaCompleta]],
      ['UPDATE entregas_epi_itens SET quantidade = 99 WHERE id = $1', [itemId]],
      ['UPDATE entregas_epi_itens SET material_prazo_uso_dias = 1 WHERE id = $1', [itemId]],
      ['DELETE FROM entregas_epi_itens WHERE id = $1', [itemId]],
    ];
    for (const [sql, params] of tentativas) {
      assert.equal((await erroDe(q(sql, params)))?.code, RECUSA_DO_TRIGGER, sql);
    }
    // As duas são referenciadas por FK: o próprio PostgreSQL recusa o TRUNCATE antes do gatilho.
    for (const sql of ['TRUNCATE entregas_epi_itens', 'TRUNCATE entregas_epi']) {
      assert.ok(RECUSAS_DE_TRUNCATE.includes((await erroDe(q(sql)))?.code), sql);
    }
  });

  test('o banco suporta a composição de 20 itens (o limite é regra do serviço, não do banco)', async () => {
    const lotes = [];
    for (let i = 0; i < 20; i += 1) {
      lotes.push(await criarLote(c, { empresaId: d.empresaA, materialId: d.luvaA, quantidade: 3, tamanho: `T${i}` }));
    }
    const { entrega, itens } = await registrarEntrega(c, {
      entrega: entregaBase(),
      itens: lotes.map((loteId) => ({ ...itemBase(), material_id: d.luvaA, lote_id: loteId, quantidade: 1, material_nome: 'Luva' })),
      usuarioId: d.usuarioA,
    });
    assert.equal(itens.length, 20);
    const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM entregas_epi_itens WHERE entrega_id = $1', [entrega.id]);
    assert.equal(n, 20);
    const { rows: [{ entregue }] } = await q('SELECT sum(quantidade_entregue)::int AS entregue FROM estoque_lotes WHERE id = ANY($1)', [lotes]);
    assert.equal(entregue, 20);
  });

  test('a cópia congelada não muda quando o cadastro muda', async () => {
    await q("UPDATE funcionarios SET nome = 'Nome Alterado', setor = 'Novo Setor' WHERE id = $1", [d.funcionarioA1]);
    const { rows: [linha] } = await q('SELECT trabalhador_nome, trabalhador_setor FROM entregas_epi WHERE id = $1', [d.entregaCompleta]);
    assert.deepEqual(linha, { trabalhador_nome: 'Trabalhador Fictício', trabalhador_setor: null });
  });
});
