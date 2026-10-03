'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  abrirSchemaTemporario, abrirPoolTemporario, aguardarEsperaPeloLock, migrationExiste,
} = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe, transacao, criarEmpresa, criarMaterial } = require('./helpers/entrega-epi');
const {
  montarCenario, criarSolicitacao, decidirSolicitacao, cancelarSolicitacao, criarSolicitacaoAprovada, aprovar, reprovar,
  inserirSolicitacao, inserirItemDaSolicitacao, proximoNumeroDaSolicitacao,
} = require('./helpers/solicitacao-epi');

/**
 * Migration 065 — solicitação de EPI: contador por empresa, cabeçalho com
 * ciclo de vida controlado e itens com decisão por item. PostgreSQL real,
 * schema temporário.
 *
 * A estrutura e o comportamento da 065 são conferidos num schema que para na
 * 065; só a concorrência do contador roda com todas as migrations. A
 * migration 066 acrescenta barreiras à entrega (fechar a solicitação exige
 * entrega real) e tem teste próprio.
 *
 * Ordem das conferências: BEFORE (identidade e transição) → CHECK → FK →
 * gatilhos adiados no COMMIT (itens selados e decisão coerente com o
 * cabeçalho). Por isso o que depende de itens e cabeçalho juntos é provado
 * numa transação com COMMIT, e o que é só CHECK numa transação revertida.
 *
 * A reserva de estoque é lógica e derivada (por empresa, material e tamanho):
 * a migration só guarda o compromisso, que é a quantidade aprovada. Nenhuma
 * alocação, contador de reserva ou quantidade entregue é gravado aqui.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_065 = '065_create_solicitacoes_epi.sql';
const TODAS = todasAsMigrations();
const ATE_A_065 = TODAS.filter((prefixo) => prefixo <= '065');
const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';
// TRUNCATE em tabela referenciada por FK cai em feature_not_supported antes do gatilho.
const RECUSAS_DE_TRUNCATE = ['0A000', RECUSA_DO_TRIGGER];
const MOTIVOS = ['ADMISSAO', 'SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO', 'OUTRO'];
const COERENCIA = 'trg_solicitacoes_epi_coerencia_decisao';
const ITENS_SELADOS = 'trg_solicitacoes_epi_exigir_item';

const ESTRUTURA = {
  solicitacoes_epi_numeracao: {
    constraints: [
      'chk_solicitacoes_epi_numeracao_ultimo_numero',
      'solicitacoes_epi_numeracao_empresa_id_fkey',
      'solicitacoes_epi_numeracao_pkey',
    ],
    triggers: [
      'trg_solicitacoes_epi_numeracao_bloquear_delete',
      'trg_solicitacoes_epi_numeracao_bloquear_truncate',
      'trg_solicitacoes_epi_numeracao_iniciar_em_um',
      'trg_solicitacoes_epi_numeracao_proteger_update',
    ],
  },
  solicitacoes_epi: {
    constraints: [
      'chk_solicitacoes_epi_cancelamento',
      'chk_solicitacoes_epi_decisao',
      'chk_solicitacoes_epi_decisor_diferente_do_solicitante',
      'chk_solicitacoes_epi_entrega',
      'chk_solicitacoes_epi_numero',
      'chk_solicitacoes_epi_observacao',
      'chk_solicitacoes_epi_ordem_dos_carimbos',
      'chk_solicitacoes_epi_origem',
      'chk_solicitacoes_epi_origem_solicitante',
      'chk_solicitacoes_epi_quantidade_itens',
      'chk_solicitacoes_epi_requisicao_hash',
      'chk_solicitacoes_epi_status',
      'fk_solicitacoes_epi_cancelador_mesma_empresa',
      'fk_solicitacoes_epi_decisor_mesma_empresa',
      'fk_solicitacoes_epi_funcionario_mesma_empresa',
      'fk_solicitacoes_epi_ghe_mesma_empresa',
      'fk_solicitacoes_epi_solicitante_mesma_empresa',
      'solicitacoes_epi_pkey',
      COERENCIA,
      ITENS_SELADOS,
      'uq_solicitacoes_epi_empresa_id',
      'uq_solicitacoes_epi_empresa_numero',
      'uq_solicitacoes_epi_idempotencia',
    ],
    triggers: [
      'trg_solicitacoes_epi_bloquear_truncate',
      COERENCIA,
      ITENS_SELADOS,
      'trg_solicitacoes_epi_proteger',
    ],
  },
  solicitacoes_epi_itens: {
    constraints: [
      'chk_solicitacoes_epi_itens_decisao',
      'chk_solicitacoes_epi_itens_decisao_completa',
      'chk_solicitacoes_epi_itens_fora_do_ghe_justificado',
      'chk_solicitacoes_epi_itens_justificativa',
      'chk_solicitacoes_epi_itens_justificativa_decisao',
      'chk_solicitacoes_epi_itens_motivo',
      'chk_solicitacoes_epi_itens_outro_justificado',
      'chk_solicitacoes_epi_itens_quantidade',
      'chk_solicitacoes_epi_itens_quantidade_aprovada',
      'chk_solicitacoes_epi_itens_reducao_justificada',
      'chk_solicitacoes_epi_itens_reprovado_justificado',
      'chk_solicitacoes_epi_itens_tamanho',
      'fk_solicitacoes_epi_itens_material_mesma_empresa',
      'fk_solicitacoes_epi_itens_solicitacao_mesma_empresa',
      'solicitacoes_epi_itens_pkey',
      'trg_solicitacoes_epi_itens_coerencia_decisao',
      'trg_solicitacoes_epi_itens_exigir_item',
      'uq_solicitacoes_epi_itens_empresa_id',
    ],
    triggers: [
      'trg_solicitacoes_epi_itens_bloquear_truncate',
      'trg_solicitacoes_epi_itens_coerencia_decisao',
      'trg_solicitacoes_epi_itens_exigir_item',
      'trg_solicitacoes_epi_itens_proteger',
    ],
  },
};

const INDICES_065 = [
  'idx_solicitacoes_epi_aprovadas',
  'idx_solicitacoes_epi_funcionario',
  'idx_solicitacoes_epi_itens_demanda_par',
  'idx_solicitacoes_epi_pendentes',
];

const porNome = (lista) => [...lista].sort();

describe('migration 065 — estrutura logo após a sua aplicação', () => {
  let contexto;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  before(async () => {
    contexto = await abrirSchemaTemporario(ATE_A_065);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('o arquivo da migration 065 existe', () => {
    assert.equal(migrationExiste('065'), true, 'arquivo da migration 065');
  });

  test('as três tabelas existem com exatamente as constraints e os gatilhos esperados', async () => {
    for (const [tabela, esperado] of Object.entries(ESTRUTURA)) {
      const { rows: constraints } = await q('SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass', [tabela]);
      assert.deepEqual(porNome(constraints.map((r) => r.conname)), porNome(esperado.constraints), `constraints de ${tabela}`);
      const { rows: triggers } = await q('SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal', [tabela]);
      assert.deepEqual(porNome(triggers.map((r) => r.tgname)), porNome(esperado.triggers), `gatilhos de ${tabela}`);
    }
  });

  test('índices: os da 065 são parciais ou compostos; a demanda por par e a unicidade de material e tamanho são índices por expressão com COALESCE', async () => {
    const { rows: indices } = await q(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'idx\\_solicitacoes\\_epi%'",
    );
    assert.deepEqual(indices.map((r) => r.indexname).sort(), INDICES_065);
    const definicao = (nome) => indices.find((r) => r.indexname === nome).indexdef;
    assert.match(definicao('idx_solicitacoes_epi_aprovadas'), /WHERE .*status.*APROVADA.*APROVADA_PARCIAL/s);
    assert.match(definicao('idx_solicitacoes_epi_pendentes'), /WHERE .*status.*PENDENTE/s);
    assert.match(definicao('idx_solicitacoes_epi_funcionario'), /empresa_id, funcionario_id, criada_em DESC, id DESC/);
    // Demanda por par (empresa, material, tamanho): só itens aprovados, com o mesmo tamanho canônico dos lotes sem tamanho.
    assert.doesNotMatch(definicao('idx_solicitacoes_epi_itens_demanda_par'), /UNIQUE/);
    assert.match(definicao('idx_solicitacoes_epi_itens_demanda_par'), /\(empresa_id, material_id, COALESCE\(tamanho, ''::character varying\)\)/);
    assert.match(definicao('idx_solicitacoes_epi_itens_demanda_par'), /WHERE .*decisao.*APROVADO/s);

    const { rows: [unico] } = await q(
      `SELECT i.indisunique, pg_get_indexdef(i.indexrelid) AS definicao,
              EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) AS por_constraint
         FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
        WHERE ic.relname = 'uq_solicitacoes_epi_itens_material_tamanho' AND ic.relnamespace = current_schema()::regnamespace`,
    );
    assert.equal(unico.indisunique, true);
    assert.equal(unico.por_constraint, false, 'unicidade por expressão não é UNIQUE constraint');
    assert.match(unico.definicao, /\(solicitacao_id, material_id, COALESCE\(tamanho, ''::character varying\)\)/);
  });

  test('as conferências do COMMIT são gatilhos de constraint adiáveis e adiados por padrão', async () => {
    const { rows } = await q(
      `SELECT conname, contype, condeferrable, condeferred FROM pg_constraint
        WHERE conname LIKE 'trg\\_solicitacoes\\_epi%' AND connamespace = current_schema()::regnamespace`,
    );
    assert.deepEqual(rows.map((r) => r.conname).sort(), [
      'trg_solicitacoes_epi_coerencia_decisao',
      'trg_solicitacoes_epi_exigir_item',
      'trg_solicitacoes_epi_itens_coerencia_decisao',
      'trg_solicitacoes_epi_itens_exigir_item',
    ]);
    for (const linha of rows) assert.deepEqual([linha.contype, linha.condeferrable, linha.condeferred], ['t', true, true], linha.conname);
  });

  test('colunas: solicitante, GHE, decisão, cancelamento e entrega são opcionais; nada de alocação em lote, contador de reserva, quantidade entregue ou CPF', async () => {
    const colunas = async (tabela) => Object.fromEntries((await q(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
      [tabela],
    )).rows.map((r) => [r.column_name, r.is_nullable]));
    const cabecalho = await colunas('solicitacoes_epi');
    for (const nome of ['solicitante_usuario_id', 'ghe_id', 'observacao', 'decidida_por', 'decidida_em', 'cancelada_por', 'cancelada_em', 'justificativa_cancelamento', 'entregue_em']) {
      assert.equal(cabecalho[nome], 'YES', `solicitacoes_epi.${nome} é opcional`);
    }
    for (const nome of ['empresa_id', 'numero', 'funcionario_id', 'origem_solicitacao', 'status', 'quantidade_itens', 'chave_idempotencia', 'requisicao_hash', 'criada_em']) {
      assert.equal(cabecalho[nome], 'NO', `solicitacoes_epi.${nome} é obrigatório`);
    }
    assert.equal('justificativa_decisao' in cabecalho, false, 'a justificativa da decisão é do item');
    const itens = await colunas('solicitacoes_epi_itens');
    for (const nome of ['tamanho', 'justificativa', 'decisao', 'quantidade_aprovada', 'justificativa_decisao']) {
      assert.equal(itens[nome], 'YES', `solicitacoes_epi_itens.${nome} é opcional`);
    }
    for (const nome of ['empresa_id', 'solicitacao_id', 'material_id', 'quantidade', 'motivo', 'previsto_no_ghe']) {
      assert.equal(itens[nome], 'NO', `solicitacoes_epi_itens.${nome} é obrigatório`);
    }
    const { rows: indevidas } = await q(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name IN ('solicitacoes_epi', 'solicitacoes_epi_itens')
          AND (column_name LIKE '%lote%' OR column_name LIKE '%reserva%' OR column_name LIKE '%alocad%'
               OR column_name = 'quantidade_entregue' OR column_name LIKE '%cpf%')`,
    );
    assert.deepEqual(indevidas, []);
    const { rows: tabelas } = await q(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'solicitacoes\\_epi%'",
    );
    assert.deepEqual(tabelas.map((r) => r.table_name).sort(), ['solicitacoes_epi', 'solicitacoes_epi_itens', 'solicitacoes_epi_numeracao'], 'sem quarta tabela de reserva');
  });

  test('manifesto: entrada da 065 coerente com o arquivo; uma entrada por arquivo', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_065))).digest('hex');
    assert.equal(manifesto.migrations[ARQUIVO_065], sha);
    const arquivos = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
  });
});

describe('migration 065 — comportamento, com todas as migrations do diretório', () => {
  let contexto;
  let c;
  let d;

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

  const item = (materialId, extra = {}) => ({ material_id: materialId, ...extra });
  const nova = (parametros) => criarSolicitacao(c, d, parametros);
  const tentarNova = (parametros) => erroDe(nova(parametros));
  const par = (erro) => [erro?.code, erro?.constraint];
  const base = () => ({ empresa_id: d.empresaA, funcionario_id: d.trabalhadorA });
  const comItem = (valores) => ({ itens: [item(d.botina)], ...valores });

  // Uma solicitação PENDENTE com dois itens: botina 4 e luva 2 (ambas tamanho 40).
  const doisItens = () => nova({
    itens: [item(d.botina, { quantidade: 4 }), item(d.luva, { quantidade: 2 })],
  });

  before(async () => {
    // O comportamento da 065 roda no schema que para na 065: as barreiras da entrega por solicitação (066), que
    // exigem entrega real para fechar uma solicitação, têm teste próprio na migration 066.
    contexto = await abrirSchemaTemporario(ATE_A_065);
    c = contexto.cliente;
    d = await montarCenario(c);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('numeração: nasce em 1, avança de um em um, é independente entre empresas e o ROLLBACK não deixa lacuna', async () => {
    assert.equal(await proximoNumeroDaSolicitacao(c, d.empresaA), 1);
    assert.equal(await proximoNumeroDaSolicitacao(c, d.empresaB), 1);
    await q('BEGIN');
    assert.equal(await proximoNumeroDaSolicitacao(c, d.empresaA), 2);
    await q('ROLLBACK');
    assert.equal(await aceitoSemGravar(() => proximoNumeroDaSolicitacao(c, d.empresaA)), 2);
    assert.equal((await q('SELECT ultimo_numero FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [d.empresaA])).rows[0].ultimo_numero, 1);
  });

  test('numeração: só o incremento de um em um; saltar, voltar, trocar a empresa, DELETE e TRUNCATE são recusados; início diferente de 1 também', async () => {
    const tentar = (sql, params) => erroDe(q(sql, params));
    assert.equal(await tentar('UPDATE solicitacoes_epi_numeracao SET ultimo_numero = ultimo_numero + 1 WHERE empresa_id = $1', [d.empresaA]), null);
    const recusas = [
      ['UPDATE solicitacoes_epi_numeracao SET ultimo_numero = ultimo_numero + 2 WHERE empresa_id = $1', [d.empresaA]],
      ['UPDATE solicitacoes_epi_numeracao SET ultimo_numero = ultimo_numero - 1 WHERE empresa_id = $1', [d.empresaA]],
      ['UPDATE solicitacoes_epi_numeracao SET ultimo_numero = 1 WHERE empresa_id = $1', [d.empresaA]],
      ['UPDATE solicitacoes_epi_numeracao SET empresa_id = $2 WHERE empresa_id = $1', [d.empresaA, d.empresaB]],
      ['DELETE FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [d.empresaA]],
      ['TRUNCATE solicitacoes_epi_numeracao', []],
    ];
    for (const [sql, params] of recusas) {
      assert.equal((await tentar(sql, params))?.code, RECUSA_DO_TRIGGER, sql);
    }
    const empresaC = await criarEmpresa(c, '77888999000101', 'Empresa C Fictícia');
    const inserirContador = (empresaId, valor) => tentar('INSERT INTO solicitacoes_epi_numeracao (empresa_id, ultimo_numero) VALUES ($1, $2)', [empresaId, valor]);
    for (const valor of [0, 2, 5, 100]) {
      assert.equal((await inserirContador(empresaC, valor))?.code, RECUSA_DO_TRIGGER, `início em ${valor}`);
    }
    assert.equal((await q('SELECT count(*)::int AS n FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [empresaC])).rows[0].n, 0);
    // O CHECK de positividade continua por trás do gatilho (DISABLE desfeito pelo ROLLBACK).
    await q('BEGIN');
    await q('ALTER TABLE solicitacoes_epi_numeracao DISABLE TRIGGER trg_solicitacoes_epi_numeracao_iniciar_em_um');
    const zeroSemGatilho = await inserirContador(empresaC, 0);
    await q('ROLLBACK');
    assert.deepEqual(par(zeroSemGatilho), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_numeracao_ultimo_numero']);
    assert.equal(await inserirContador(empresaC, 1), null);
    assert.equal((await inserirContador(empresaC, 1))?.code, VIOLACAO_UNIQUE);
    assert.equal((await inserirContador(999999, 1))?.code, VIOLACAO_FK);
  });

  test('criação: USUARIO_INTERNO nasce PENDENTE, sem decisão, cancelamento nem entrega; criada_em vem do servidor; o GHE é informativo', async () => {
    const { solicitacao, itens } = await nova({ gheId: d.gheA, itens: [item(d.botina), item(d.capacete, { tamanho: null, previsto_no_ghe: false })] });
    assert.equal(itens.length, 2);
    const { rows: [linha] } = await q(
      `SELECT status, origem_solicitacao, solicitante_usuario_id, ghe_id, quantidade_itens, decidida_por, decidida_em, cancelada_por,
              cancelada_em, justificativa_cancelamento, entregue_em, criada_em >= now() - interval '1 minute' AS recente
         FROM solicitacoes_epi WHERE id = $1`,
      [solicitacao.id],
    );
    assert.deepEqual(linha, {
      status: 'PENDENTE', origem_solicitacao: 'USUARIO_INTERNO', solicitante_usuario_id: d.solicitante, ghe_id: d.gheA, quantidade_itens: 2,
      decidida_por: null, decidida_em: null, cancelada_por: null, cancelada_em: null, justificativa_cancelamento: null, entregue_em: null, recente: true,
    });
    const { rows: decididos } = await q('SELECT decisao, quantidade_aprovada, justificativa_decisao FROM solicitacoes_epi_itens WHERE solicitacao_id = $1', [solicitacao.id]);
    assert.deepEqual(decididos, [
      { decisao: null, quantidade_aprovada: null, justificativa_decisao: null },
      { decisao: null, quantidade_aprovada: null, justificativa_decisao: null },
    ]);
  });

  test('criação: AUTOATENDIMENTO sem solicitante interno é aceito; USUARIO_INTERNO sem solicitante e AUTOATENDIMENTO com solicitante são recusados', async () => {
    const auto = await nova({ origem: 'AUTOATENDIMENTO', itens: [item(d.botina)] });
    assert.equal(auto.solicitacao.solicitante_usuario_id, null);
    assert.equal(auto.solicitacao.origem_solicitacao, 'AUTOATENDIMENTO');
    const semSolicitante = await tentarNova({ cabecalho: { solicitante_usuario_id: null }, ...comItem({}) });
    assert.deepEqual(par(semSolicitante), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_origem_solicitante']);
    const autoComSolicitante = await erroDe(transacao(c, async (t) => {
      const numero = await proximoNumeroDaSolicitacao(t, d.empresaA);
      await inserirSolicitacao(t, { ...base(), numero, origem_solicitacao: 'AUTOATENDIMENTO', solicitante_usuario_id: d.solicitante });
    }));
    assert.deepEqual(par(autoComSolicitante), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_origem_solicitante']);
  });

  test('criação: a solicitação só nasce PENDENTE, mesmo com os campos de uma decisão preenchidos', async () => {
    for (const status of ['APROVADA', 'APROVADA_PARCIAL', 'REPROVADA']) {
      const erro = await aceitoSemGravar(async () => {
        const numero = await proximoNumeroDaSolicitacao(c, d.empresaA);
        return erroDe(inserirSolicitacao(c, {
          ...base(), numero, solicitante_usuario_id: d.solicitante, status, decidida_por: d.aprovador, decidida_em: new Date(),
        }));
      });
      assert.equal(erro?.code, RECUSA_DO_TRIGGER, status);
      assert.match(erro.message, /nasce PENDENTE/, status);
    }
  });

  test('cabeçalho: CHECKs de domínio — origem, status, número, itens, hash, observação', async () => {
    const casos = [
      [{ origem_solicitacao: 'TOTEM' }, 'chk_solicitacoes_epi_origem'],
      [{ numero: 0 }, 'chk_solicitacoes_epi_numero'],
      [{ numero: -3 }, 'chk_solicitacoes_epi_numero'],
      [{ quantidade_itens: 0 }, 'chk_solicitacoes_epi_quantidade_itens'],
      [{ requisicao_hash: 'A'.repeat(64) }, 'chk_solicitacoes_epi_requisicao_hash'],
      [{ requisicao_hash: 'ab' }, 'chk_solicitacoes_epi_requisicao_hash'],
      [{ observacao: '' }, 'chk_solicitacoes_epi_observacao'],
      [{ observacao: ' com espaço' }, 'chk_solicitacoes_epi_observacao'],
      [{ observacao: 'x'.repeat(501) }, 'chk_solicitacoes_epi_observacao'],
    ];
    for (const [valores, constraint] of casos) {
      const erro = await aceitoSemGravar(async () => {
        const numero = await proximoNumeroDaSolicitacao(c, d.empresaA);
        return erroDe(inserirSolicitacao(c, { ...base(), numero, solicitante_usuario_id: d.solicitante, ...valores }));
      });
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, constraint], JSON.stringify(valores));
    }
    // O gatilho "nasce PENDENTE" recusa antes do CHECK de domínio; com ele desligado (DISABLE desfeito pelo ROLLBACK) o CHECK ainda barra.
    const statusForaDoDominio = await aceitoSemGravar(async () => {
      await q('ALTER TABLE solicitacoes_epi DISABLE TRIGGER trg_solicitacoes_epi_proteger');
      const numero = await proximoNumeroDaSolicitacao(c, d.empresaA);
      return erroDe(inserirSolicitacao(c, { ...base(), numero, solicitante_usuario_id: d.solicitante, status: 'ABERTA' }));
    });
    assert.deepEqual(par(statusForaDoDominio), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_status']);
    const ok = await tentarNova({ cabecalho: { observacao: 'x'.repeat(500) }, ...comItem({}) });
    assert.equal(ok, null, 'observação de 500 caracteres é aceita');
    const astral = await tentarNova({ cabecalho: { observacao: '\u{1D400}'.repeat(500) }, ...comItem({}) });
    assert.equal(astral, null, 'o limite conta caracteres, não unidades UTF-16');
  });

  test('unicidade: número e chave são únicos por empresa; outra empresa pode repetir os dois; o id composto existe para as FKs futuras', async () => {
    const primeira = await nova(comItem({}));
    const numeroRepetido = await tentarNova({ ...comItem({}), cabecalho: { numero: primeira.solicitacao.numero } });
    assert.deepEqual(par(numeroRepetido), [VIOLACAO_UNIQUE, 'uq_solicitacoes_epi_empresa_numero']);
    const chaveRepetida = await tentarNova({ ...comItem({}), cabecalho: { chave_idempotencia: primeira.solicitacao.chave_idempotencia } });
    assert.deepEqual(par(chaveRepetida), [VIOLACAO_UNIQUE, 'uq_solicitacoes_epi_idempotencia']);
    const outraEmpresa = await tentarNova({
      empresaId: d.empresaB, funcionarioId: d.trabalhadorB, solicitanteId: d.usuarioB,
      itens: [item(d.botinaB)], cabecalho: { numero: primeira.solicitacao.numero, chave_idempotencia: primeira.solicitacao.chave_idempotencia },
    });
    assert.equal(outraEmpresa, null);
    const { rows } = await q(
      `SELECT conname FROM pg_constraint WHERE conname IN ('uq_solicitacoes_epi_empresa_id', 'uq_solicitacoes_epi_itens_empresa_id')
        AND connamespace = current_schema()::regnamespace AND contype = 'u' ORDER BY conname`,
    );
    assert.deepEqual(rows.map((r) => r.conname), ['uq_solicitacoes_epi_empresa_id', 'uq_solicitacoes_epi_itens_empresa_id']);
  });

  test('isolamento: trabalhador, GHE, solicitante, decisor e cancelador de outra empresa são recusados pelas FKs compostas', async () => {
    const trabalhador = await tentarNova({ ...comItem({}), funcionarioId: d.trabalhadorB });
    assert.deepEqual(par(trabalhador), [VIOLACAO_FK, 'fk_solicitacoes_epi_funcionario_mesma_empresa']);
    const ghe = await tentarNova({ ...comItem({}), gheId: d.gheB });
    assert.deepEqual(par(ghe), [VIOLACAO_FK, 'fk_solicitacoes_epi_ghe_mesma_empresa']);
    const solicitante = await tentarNova({ ...comItem({}), solicitanteId: d.usuarioB });
    assert.deepEqual(par(solicitante), [VIOLACAO_FK, 'fk_solicitacoes_epi_solicitante_mesma_empresa']);
    const material = await tentarNova({ itens: [item(d.botinaB)] });
    assert.deepEqual(par(material), [VIOLACAO_FK, 'fk_solicitacoes_epi_itens_material_mesma_empresa']);

    const { solicitacao, itens } = await nova(comItem({}));
    const decisor = await aceitoSemGravar(() => erroDe(q(
      'UPDATE solicitacoes_epi SET status = $1, decidida_por = $2, decidida_em = clock_timestamp() WHERE id = $3',
      ['REPROVADA', d.usuarioB, solicitacao.id],
    )));
    assert.deepEqual(par(decisor), [VIOLACAO_FK, 'fk_solicitacoes_epi_decisor_mesma_empresa']);
    const cancelador = await aceitoSemGravar(() => erroDe(q(
      "UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $1, cancelada_em = clock_timestamp() WHERE id = $2",
      [d.usuarioB, solicitacao.id],
    )));
    assert.deepEqual(par(cancelador), [VIOLACAO_FK, 'fk_solicitacoes_epi_cancelador_mesma_empresa']);
    assert.equal(itens.length, 1);

    // Item de uma empresa apontando para a solicitação de outra.
    const itemCruzado = await aceitoSemGravar(() => erroDe(inserirItemDaSolicitacao(c, {
      empresa_id: d.empresaB, solicitacao_id: solicitacao.id, material_id: d.botinaB,
    })));
    assert.deepEqual(par(itemCruzado), [VIOLACAO_FK, 'fk_solicitacoes_epi_itens_solicitacao_mesma_empresa']);
  });

  test('itens selados: solicitação sem item, com menos ou com mais itens que o declarado, ou com item inserido depois, não passa do COMMIT', async () => {
    const semItem = await erroDe(transacao(c, async (t) => {
      const numero = await proximoNumeroDaSolicitacao(t, d.empresaA);
      await inserirSolicitacao(t, { ...base(), numero, solicitante_usuario_id: d.solicitante });
    }));
    assert.deepEqual(par(semItem), [VIOLACAO_CHECK, ITENS_SELADOS]);

    const menos = await tentarNova({ cabecalho: { quantidade_itens: 2 }, itens: [item(d.botina)] });
    assert.deepEqual(par(menos), [VIOLACAO_CHECK, ITENS_SELADOS]);
    const mais = await tentarNova({ cabecalho: { quantidade_itens: 1 }, itens: [item(d.botina), item(d.luva)] });
    assert.deepEqual(par(mais), [VIOLACAO_CHECK, ITENS_SELADOS]);

    const { solicitacao } = await nova(comItem({}));
    const depois = await erroDe(transacao(c, (t) => inserirItemDaSolicitacao(t, {
      empresa_id: d.empresaA, solicitacao_id: solicitacao.id, material_id: d.luva,
    })));
    assert.deepEqual(par(depois), [VIOLACAO_CHECK, ITENS_SELADOS]);
    assert.equal((await q('SELECT count(*)::int AS n FROM solicitacoes_epi_itens WHERE solicitacao_id = $1', [solicitacao.id])).rows[0].n, 1);

    const vinte = await tentarNova({ itens: Array.from({ length: 20 }, (_, i) => item(d.botina, { tamanho: String(30 + i) })) });
    assert.equal(vinte, null, 'o banco não limita em 20; o limite é do serviço');
  });

  test('itens: quantidade, tamanho, motivo e justificativa do pedido; tamanho ausente é aceito', async () => {
    const casos = [
      [{ quantidade: 0 }, 'chk_solicitacoes_epi_itens_quantidade'],
      [{ quantidade: -1 }, 'chk_solicitacoes_epi_itens_quantidade'],
      [{ tamanho: '' }, 'chk_solicitacoes_epi_itens_tamanho'],
      [{ tamanho: ' 40' }, 'chk_solicitacoes_epi_itens_tamanho'],
      [{ motivo: 'CAPRICHO' }, 'chk_solicitacoes_epi_itens_motivo'],
      [{ motivo: 'OUTRO' }, 'chk_solicitacoes_epi_itens_outro_justificado'],
      [{ justificativa: '' }, 'chk_solicitacoes_epi_itens_justificativa'],
      [{ justificativa: ' x' }, 'chk_solicitacoes_epi_itens_justificativa'],
      [{ justificativa: 'x'.repeat(501) }, 'chk_solicitacoes_epi_itens_justificativa'],
    ];
    for (const [valores, constraint] of casos) {
      const erro = await tentarNova({ itens: [item(d.botina, valores)] });
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, constraint], JSON.stringify(valores));
    }
    for (const motivo of MOTIVOS) {
      assert.equal(await tentarNova({ itens: [item(d.botina, { motivo, justificativa: 'Motivo informado' })] }), null, motivo);
    }
    assert.equal(await tentarNova({ itens: [item(d.capacete, { tamanho: null })] }), null, 'sem tamanho');
  });

  test('unicidade do item: o mesmo material e tamanho na mesma solicitação é recusado, inclusive com tamanho ausente; tamanhos diferentes e outra solicitação passam', async () => {
    const igual = await tentarNova({ itens: [item(d.botina, { tamanho: '40' }), item(d.botina, { tamanho: '40' })] });
    assert.deepEqual(par(igual), [VIOLACAO_UNIQUE, 'uq_solicitacoes_epi_itens_material_tamanho']);
    const semTamanho = await tentarNova({ itens: [item(d.capacete, { tamanho: null }), item(d.capacete, { tamanho: null })] });
    assert.deepEqual(par(semTamanho), [VIOLACAO_UNIQUE, 'uq_solicitacoes_epi_itens_material_tamanho']);
    assert.equal(await tentarNova({ itens: [item(d.botina, { tamanho: '40' }), item(d.botina, { tamanho: '41' })] }), null);
    assert.equal(await tentarNova({ itens: [item(d.capacete, { tamanho: null }), item(d.capacete, { tamanho: 'Único' })] }), null);
    assert.equal(await tentarNova({ itens: [item(d.botina, { tamanho: '40' }), item(d.luva, { tamanho: '40' })] }), null);
    assert.equal(await tentarNova({ itens: [item(d.botina, { tamanho: '40' })] }), null, 'outra solicitação pode repetir material e tamanho');
  });

  test('o item nasce sem decisão: a decisão só entra por UPDATE', async () => {
    const { solicitacao } = await nova(comItem({}));
    for (const decidido of [
      { decisao: 'APROVADO', quantidade_aprovada: 1 },
      { quantidade_aprovada: 1 },
      { justificativa_decisao: 'Texto' },
    ]) {
      const erro = await aceitoSemGravar(() => erroDe(inserirItemDaSolicitacao(c, {
        empresa_id: d.empresaA, solicitacao_id: solicitacao.id, material_id: d.luva, ...decidido,
      })));
      assert.equal(erro?.code, RECUSA_DO_TRIGGER, JSON.stringify(decidido));
      assert.match(erro.message, /nasce sem decisão/);
    }
  });

  test('identidade do cabeçalho: nenhum campo estrutural muda depois da criação', async () => {
    const { solicitacao } = await nova({ gheId: d.gheA, itens: [item(d.botina)], cabecalho: { observacao: 'Observação original' } });
    const alteracoes = [
      ['numero', 999],
      ['funcionario_id', d.trabalhadorA2],
      ['ghe_id', null],
      ['origem_solicitacao', 'AUTOATENDIMENTO'],
      ['solicitante_usuario_id', d.aprovador],
      ['quantidade_itens', 2],
      ['observacao', 'Outra observação'],
      ['chave_idempotencia', crypto.randomUUID()],
      ['requisicao_hash', 'c'.repeat(64)],
      ['criada_em', new Date('2020-01-01T00:00:00Z')],
      ['empresa_id', d.empresaB],
    ];
    for (const [coluna, valor] of alteracoes) {
      const erro = await aceitoSemGravar(() => erroDe(q(`UPDATE solicitacoes_epi SET ${coluna} = $1 WHERE id = $2`, [valor, solicitacao.id])));
      assert.equal(erro?.code, RECUSA_DO_TRIGGER, coluna);
      assert.match(erro.message, /identidade da solicitação/, coluna);
    }
  });

  test('identidade do item: material, tamanho, quantidade, motivo, justificativa, previsão no GHE e vínculo com a solicitação não mudam', async () => {
    const { solicitacao, itens: [primeiro] } = await nova({ itens: [item(d.botina, { justificativa: 'Pedido original' })] });
    const outra = await nova(comItem({}));
    const alteracoes = [
      ['material_id', d.luva],
      ['tamanho', '41'],
      ['quantidade', 3],
      ['motivo', 'DESGASTE_DANO'],
      ['justificativa', 'Outra justificativa'],
      ['previsto_no_ghe', false],
      ['solicitacao_id', outra.solicitacao.id],
      ['empresa_id', d.empresaB],
    ];
    for (const [coluna, valor] of alteracoes) {
      const erro = await aceitoSemGravar(() => erroDe(q(`UPDATE solicitacoes_epi_itens SET ${coluna} = $1 WHERE id = $2`, [valor, primeiro.id])));
      assert.equal(erro?.code, RECUSA_DO_TRIGGER, coluna);
      assert.match(erro.message, /pedido do item/, coluna);
    }
    assert.equal(solicitacao.id, primeiro.solicitacao_id);
  });

  test('DELETE e TRUNCATE são recusados no cabeçalho e nos itens', async () => {
    const { solicitacao, itens: [primeiro] } = await nova(comItem({}));
    for (const [sql, params] of [
      ['DELETE FROM solicitacoes_epi WHERE id = $1', [solicitacao.id]],
      ['DELETE FROM solicitacoes_epi_itens WHERE id = $1', [primeiro.id]],
    ]) {
      const erro = await erroDe(q(sql, params));
      assert.equal(erro?.code, RECUSA_DO_TRIGGER, sql);
      assert.match(erro.message, /não aceita DELETE/);
    }
    for (const tabela of ['solicitacoes_epi', 'solicitacoes_epi_itens']) {
      assert.ok(RECUSAS_DE_TRUNCATE.includes((await erroDe(q(`TRUNCATE ${tabela}`)))?.code), `TRUNCATE ${tabela}`);
    }
  });

  test('decisão do item — CHECKs: aprovado entre 1 e a quantidade pedida; reprovado com zero e justificativa; redução e item fora do GHE justificados', async () => {
    const { itens: [dentro, fora] } = await nova({
      itens: [item(d.botina, { quantidade: 4 }), item(d.luva, { quantidade: 4, previsto_no_ghe: false })],
    });
    const decidir = (alvo, decisao, quantidade, justificativa) => aceitoSemGravar(() => erroDe(q(
      'UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2, justificativa_decisao = $3 WHERE id = $4',
      [decisao, quantidade, justificativa, alvo.id],
    )));
    const recusas = [
      [dentro, 'APROVADO', 0, null, 'chk_solicitacoes_epi_itens_quantidade_aprovada'],
      [dentro, 'APROVADO', 5, 'Mais que o pedido', 'chk_solicitacoes_epi_itens_quantidade_aprovada'],
      [dentro, 'APROVADO', -1, null, 'chk_solicitacoes_epi_itens_quantidade_aprovada'],
      [dentro, 'APROVADO', null, null, 'chk_solicitacoes_epi_itens_decisao_completa'],
      [dentro, 'REPROVADO', 1, 'Justificado', 'chk_solicitacoes_epi_itens_quantidade_aprovada'],
      [dentro, 'REPROVADO', 0, null, 'chk_solicitacoes_epi_itens_reprovado_justificado'],
      [dentro, 'APROVADO', 2, null, 'chk_solicitacoes_epi_itens_reducao_justificada'],
      [dentro, 'TALVEZ', 4, null, 'chk_solicitacoes_epi_itens_decisao'],
      [dentro, 'APROVADO', 4, '', 'chk_solicitacoes_epi_itens_justificativa_decisao'],
      [dentro, 'APROVADO', 4, ' com espaço', 'chk_solicitacoes_epi_itens_justificativa_decisao'],
      [dentro, 'REPROVADO', 0, 'x'.repeat(501), 'chk_solicitacoes_epi_itens_justificativa_decisao'],
      [fora, 'APROVADO', 4, null, 'chk_solicitacoes_epi_itens_fora_do_ghe_justificado'],
    ];
    for (const [alvo, decisao, quantidade, justificativa, constraint] of recusas) {
      const erro = await decidir(alvo, decisao, quantidade, justificativa);
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, constraint], JSON.stringify([decisao, quantidade, justificativa]));
    }
    const aceitas = [
      [dentro, 'APROVADO', 4, null],
      [dentro, 'APROVADO', 3, 'Estoque mínimo do setor'],
      [dentro, 'APROVADO', 1, 'Quantidade reduzida'],
      [dentro, 'REPROVADO', 0, 'Sem necessidade'],
      [fora, 'APROVADO', 4, 'Risco da função justifica o EPI fora do GHE'],
      [fora, 'REPROVADO', 0, 'Fora do GHE'],
    ];
    for (const [alvo, decisao, quantidade, justificativa] of aceitas) {
      assert.equal(await decidir(alvo, decisao, quantidade, justificativa), null, JSON.stringify([decisao, quantidade, justificativa]));
    }
  });

  test('decisão do item: é definitiva e o UPDATE do item só pode registrar a decisão', async () => {
    const { itens: [alvo] } = await nova(comItem({}));
    const definitiva = await aceitoSemGravar(async () => {
      await q('UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2 WHERE id = $3', ['APROVADO', 2, alvo.id]);
      return erroDe(q('UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2, justificativa_decisao = $3 WHERE id = $4', ['REPROVADO', 0, 'Mudei de ideia', alvo.id]));
    });
    assert.equal(definitiva?.code, RECUSA_DO_TRIGGER);
    assert.match(definitiva.message, /definitiva/);
    const mesmaDecisao = await aceitoSemGravar(async () => {
      await q('UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2 WHERE id = $3', ['APROVADO', 2, alvo.id]);
      return erroDe(q('UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2 WHERE id = $3', ['APROVADO', 2, alvo.id]));
    });
    assert.match(mesmaDecisao?.message ?? '', /definitiva/, 'repetir a mesma decisão também é recusado');
    const semDecisao = await aceitoSemGravar(() => erroDe(q('UPDATE solicitacoes_epi_itens SET quantidade = quantidade WHERE id = $1', [alvo.id])));
    assert.equal(semDecisao?.code, RECUSA_DO_TRIGGER);
    assert.match(semDecisao.message, /só registra a decisão/);
  });

  // Estados do cabeçalho × decisões dos itens, conferidos no COMMIT.
  describe('coerência entre o cabeçalho e as decisões dos itens (COMMIT)', () => {
    const sucesso = null;
    const casos = [
      ['todos aprovados integralmente + APROVADA', 'APROVADA', (i) => [aprovar(i[0]), aprovar(i[1])], sucesso],
      ['todos aprovados integralmente + APROVADA_PARCIAL', 'APROVADA_PARCIAL', (i) => [aprovar(i[0]), aprovar(i[1])], COERENCIA],
      ['um reprovado + APROVADA', 'APROVADA', (i) => [aprovar(i[0]), reprovar(i[1])], COERENCIA],
      ['um reprovado + APROVADA_PARCIAL', 'APROVADA_PARCIAL', (i) => [aprovar(i[0]), reprovar(i[1])], sucesso],
      ['quantidade reduzida + APROVADA', 'APROVADA', (i) => [aprovar(i[0], 2, 'Estoque curto'), aprovar(i[1])], COERENCIA],
      ['quantidade reduzida + APROVADA_PARCIAL', 'APROVADA_PARCIAL', (i) => [aprovar(i[0], 2, 'Estoque curto'), aprovar(i[1])], sucesso],
      ['todos reprovados + REPROVADA', 'REPROVADA', (i) => [reprovar(i[0]), reprovar(i[1])], sucesso],
      ['todos reprovados + APROVADA_PARCIAL', 'APROVADA_PARCIAL', (i) => [reprovar(i[0]), reprovar(i[1])], COERENCIA],
      ['todos reprovados + APROVADA', 'APROVADA', (i) => [reprovar(i[0]), reprovar(i[1])], COERENCIA],
      ['um aprovado e um reprovado + REPROVADA', 'REPROVADA', (i) => [aprovar(i[0]), reprovar(i[1])], COERENCIA],
      ['todos aprovados + REPROVADA', 'REPROVADA', (i) => [aprovar(i[0]), aprovar(i[1])], COERENCIA],
      ['só um item decidido + APROVADA_PARCIAL', 'APROVADA_PARCIAL', (i) => [aprovar(i[0])], COERENCIA],
      ['só um item decidido + APROVADA', 'APROVADA', (i) => [aprovar(i[0])], COERENCIA],
      ['nenhum item decidido + APROVADA', 'APROVADA', () => [], COERENCIA],
      ['nenhum item decidido + REPROVADA', 'REPROVADA', () => [], COERENCIA],
    ];

    for (const [nome, status, decisoes, esperado] of casos) {
      test(nome, async () => {
        const { solicitacao, itens } = await doisItens();
        const erro = await erroDe(decidirSolicitacao(c, solicitacao, { status, decididaPor: d.aprovador, decisoes: decisoes(itens) }));
        assert.deepEqual(par(erro), esperado === null ? [undefined, undefined] : [VIOLACAO_CHECK, esperado]);
        const { rows: [{ status: gravado }] } = await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [solicitacao.id]);
        assert.equal(gravado, esperado === null ? status : 'PENDENTE', 'o que falha no COMMIT não grava nada');
      });
    }

    test('a ordem dentro da transação não importa: cabeçalho antes dos itens também passa', async () => {
      const { solicitacao, itens } = await doisItens();
      await transacao(c, async (t) => {
        await t.query(
          "UPDATE solicitacoes_epi SET status = 'APROVADA_PARCIAL', decidida_por = $1, decidida_em = clock_timestamp() WHERE id = $2",
          [d.aprovador, solicitacao.id],
        );
        for (const decisao of [aprovar(itens[0]), reprovar(itens[1])]) {
          await t.query(
            'UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2, justificativa_decisao = $3 WHERE id = $4',
            [decisao.decisao, decisao.quantidade_aprovada, decisao.justificativa_decisao, decisao.id],
          );
        }
      });
      assert.equal((await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [solicitacao.id])).rows[0].status, 'APROVADA_PARCIAL');
    });

    test('não existe decisão em duas chamadas: itens decididos sozinhos, ou cabeçalho decidido sozinho, não passam do COMMIT', async () => {
      const { solicitacao, itens } = await doisItens();
      const soItens = await erroDe(transacao(c, async (t) => {
        for (const decisao of [aprovar(itens[0]), aprovar(itens[1])]) {
          await t.query(
            'UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2 WHERE id = $3',
            [decisao.decisao, decisao.quantidade_aprovada, decisao.id],
          );
        }
      }));
      assert.deepEqual(par(soItens), [VIOLACAO_CHECK, COERENCIA]);
      const soCabecalho = await erroDe(transacao(c, (t) => t.query(
        "UPDATE solicitacoes_epi SET status = 'APROVADA', decidida_por = $1, decidida_em = clock_timestamp() WHERE id = $2",
        [d.aprovador, solicitacao.id],
      )));
      assert.deepEqual(par(soCabecalho), [VIOLACAO_CHECK, COERENCIA]);
      const metade = await erroDe(transacao(c, (t) => t.query(
        'UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2 WHERE id = $3', ['APROVADO', 4, itens[0].id],
      )));
      assert.deepEqual(par(metade), [VIOLACAO_CHECK, COERENCIA]);
      const { rows } = await q('SELECT decisao FROM solicitacoes_epi_itens WHERE solicitacao_id = $1', [solicitacao.id]);
      assert.deepEqual(rows, [{ decisao: null }, { decisao: null }]);
    });

    test('cancelar com item já decidido não passa do COMMIT; cancelar sem decisão passa', async () => {
      const { solicitacao, itens } = await doisItens();
      const incoerente = await erroDe(transacao(c, async (t) => {
        await t.query('UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2 WHERE id = $3', ['APROVADO', 4, itens[0].id]);
        await cancelarSolicitacao(t, solicitacao, { canceladaPor: d.solicitante });
      }));
      assert.deepEqual(par(incoerente), [VIOLACAO_CHECK, COERENCIA]);
      const cancelada = await cancelarSolicitacao(c, solicitacao, { canceladaPor: d.solicitante });
      assert.equal(cancelada.status, 'CANCELADA');
    });

    test('decidir item de solicitação já cancelada não passa do COMMIT', async () => {
      const { solicitacao, itens } = await doisItens();
      await cancelarSolicitacao(c, solicitacao, { canceladaPor: d.solicitante });
      const erro = await erroDe(transacao(c, (t) => t.query(
        'UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2 WHERE id = $3', ['APROVADO', 4, itens[0].id],
      )));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, COERENCIA]);
    });
  });

  describe('transições do cabeçalho', () => {
    const transicao = (solicitacao, sql, params = []) => erroDe(q(sql, [solicitacao.id, ...params]));
    const aprovadaParcial = async () => {
      const { solicitacao, itens } = await doisItens();
      const decidida = await decidirSolicitacao(c, solicitacao, {
        status: 'APROVADA_PARCIAL', decididaPor: d.aprovador, decisoes: [aprovar(itens[0]), reprovar(itens[1])],
      });
      return { solicitacao: decidida, itens };
    };

    test('PENDENTE vai para APROVADA, APROVADA_PARCIAL, REPROVADA ou CANCELADA; cancelamento grava quem, quando e a justificativa', async () => {
      const { solicitacao } = await nova(comItem({}));
      const cancelada = await cancelarSolicitacao(c, solicitacao, { canceladaPor: d.solicitante, justificativa: 'Pedido em duplicidade' });
      assert.deepEqual(
        [cancelada.status, cancelada.cancelada_por, cancelada.justificativa_cancelamento, cancelada.decidida_por, cancelada.decidida_em],
        ['CANCELADA', d.solicitante, 'Pedido em duplicidade', null, null],
      );
      assert.notEqual(cancelada.cancelada_em, null);
      const semJustificativa = await nova(comItem({}));
      assert.equal((await cancelarSolicitacao(c, semJustificativa.solicitacao, { canceladaPor: d.solicitante })).justificativa_cancelamento, null);
      const aprovada = await criarSolicitacaoAprovada(c, d, comItem({}));
      assert.equal(aprovada.solicitacao.status, 'APROVADA');
      assert.equal(aprovada.solicitacao.decidida_por, d.aprovador);
    });

    test('o cancelamento exige os três campos coerentes e a justificativa segue o formato', async () => {
      const { solicitacao } = await nova(comItem({}));
      const casos = [
        ["UPDATE solicitacoes_epi SET status = 'CANCELADA' WHERE id = $1", []],
        ["UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $2 WHERE id = $1", [d.solicitante]],
        ["UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_em = clock_timestamp() WHERE id = $1", []],
        ["UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $2, cancelada_em = clock_timestamp(), justificativa_cancelamento = '' WHERE id = $1", [d.solicitante]],
        ["UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $2, cancelada_em = clock_timestamp(), justificativa_cancelamento = ' x' WHERE id = $1", [d.solicitante]],
        ["UPDATE solicitacoes_epi SET status = 'REPROVADA', decidida_por = $2, decidida_em = clock_timestamp(), cancelada_por = $2, cancelada_em = clock_timestamp() WHERE id = $1", [d.aprovador]],
        ["UPDATE solicitacoes_epi SET status = 'REPROVADA', decidida_por = $2, decidida_em = clock_timestamp(), justificativa_cancelamento = 'Texto' WHERE id = $1", [d.aprovador]],
      ];
      for (const [sql, params] of casos) {
        const erro = await aceitoSemGravar(() => transicao(solicitacao, sql, params));
        assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_cancelamento'], sql);
      }
    });

    test('decidida_por e decidida_em andam juntos e só existem nos estados decididos', async () => {
      const { solicitacao } = await nova(comItem({}));
      const casos = [
        ["UPDATE solicitacoes_epi SET status = 'REPROVADA', decidida_por = $2 WHERE id = $1", [d.aprovador]],
        ["UPDATE solicitacoes_epi SET status = 'REPROVADA', decidida_em = clock_timestamp() WHERE id = $1", []],
        ["UPDATE solicitacoes_epi SET status = 'REPROVADA' WHERE id = $1", []],
        ["UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $2, cancelada_em = clock_timestamp(), decidida_por = $2, decidida_em = clock_timestamp() WHERE id = $1", [d.aprovador]],
      ];
      for (const [sql, params] of casos) {
        const erro = await aceitoSemGravar(() => transicao(solicitacao, sql, params));
        assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_decisao'], sql);
      }
    });

    test('transições ilegais são recusadas: a partir de estado final, saltos e atualização sem mudar de estado', async () => {
      const pendente = (await nova(comItem({}))).solicitacao;
      const cancelada = await cancelarSolicitacao(c, (await nova(comItem({}))).solicitacao, { canceladaPor: d.solicitante });
      const reprovada = await (async () => {
        const { solicitacao, itens } = await nova(comItem({}));
        return decidirSolicitacao(c, solicitacao, { status: 'REPROVADA', decididaPor: d.aprovador, decisoes: [reprovar(itens[0])] });
      })();
      const aprovada = (await criarSolicitacaoAprovada(c, d, comItem({}))).solicitacao;
      const parcial = (await aprovadaParcial()).solicitacao;

      const decide = (status) => `UPDATE solicitacoes_epi SET status = '${status}', decidida_por = $2, decidida_em = clock_timestamp() WHERE id = $1`;
      const cancela = "UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $2, cancelada_em = clock_timestamp() WHERE id = $1";
      const entrega = "UPDATE solicitacoes_epi SET status = 'ENTREGUE', entregue_em = clock_timestamp() WHERE id = $1";
      const ilegais = [
        [cancelada, decide('APROVADA'), [d.aprovador]],
        [cancelada, decide('REPROVADA'), [d.aprovador]],
        [cancelada, entrega, []],
        [reprovada, decide('APROVADA'), [d.aprovador]],
        [reprovada, cancela, [d.solicitante]],
        [reprovada, entrega, []],
        [aprovada, cancela, [d.solicitante]],
        [aprovada, decide('REPROVADA'), [d.aprovador]],
        [parcial, cancela, [d.solicitante]],
        [parcial, decide('APROVADA'), [d.aprovador]],
        [pendente, entrega, []],
        [pendente, "UPDATE solicitacoes_epi SET status = 'PENDENTE' WHERE id = $1", []],
        [aprovada, "UPDATE solicitacoes_epi SET status = 'APROVADA' WHERE id = $1", []],
        [aprovada, "UPDATE solicitacoes_epi SET status = 'APROVADA', decidida_por = $2 WHERE id = $1", [d.solicitante]],
      ];
      for (const [solicitacao, sql, params] of ilegais) {
        const erro = await aceitoSemGravar(() => transicao(solicitacao, sql, params));
        assert.equal(erro?.code, RECUSA_DO_TRIGGER, `${solicitacao.status} → ${sql}`);
        assert.match(erro.message, /transição/, `${solicitacao.status} → ${sql}`);
      }
    });

    test('quem decidiu ou cancelou não pode ser trocado depois, nem na entrega', async () => {
      const aprovada = (await criarSolicitacaoAprovada(c, d, comItem({}))).solicitacao;
      const erro = await aceitoSemGravar(() => transicao(
        aprovada,
        "UPDATE solicitacoes_epi SET status = 'ENTREGUE', entregue_em = clock_timestamp(), decidida_por = $2 WHERE id = $1",
        [d.usuarioB],
      ));
      assert.equal(erro?.code, RECUSA_DO_TRIGGER);
      assert.match(erro.message, /já gravados/);
    });

    test('ENTREGUE: preparado estruturalmente — só a partir de APROVADA ou APROVADA_PARCIAL, com entregue_em; os itens continuam como foram decididos', async () => {
      const aprovada = (await criarSolicitacaoAprovada(c, d, comItem({}))).solicitacao;
      const entregue = await erroDe(transicao(aprovada, "UPDATE solicitacoes_epi SET status = 'ENTREGUE', entregue_em = clock_timestamp() WHERE id = $1"));
      assert.equal(entregue, null);
      const parcial = (await aprovadaParcial()).solicitacao;
      assert.equal(await transicao(parcial, "UPDATE solicitacoes_epi SET status = 'ENTREGUE', entregue_em = clock_timestamp() WHERE id = $1"), null);
      const { rows: [{ n }] } = await q("SELECT count(*)::int AS n FROM solicitacoes_epi WHERE status = 'ENTREGUE' AND entregue_em IS NOT NULL");
      assert.equal(n, 2);

      const outra = (await criarSolicitacaoAprovada(c, d, comItem({}))).solicitacao;
      const semData = await aceitoSemGravar(() => transicao(outra, "UPDATE solicitacoes_epi SET status = 'ENTREGUE' WHERE id = $1"));
      assert.deepEqual(par(semData), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_entrega']);
      const dataSemEstado = await aceitoSemGravar(() => transicao(outra, 'UPDATE solicitacoes_epi SET entregue_em = clock_timestamp() WHERE id = $1'));
      assert.equal(dataSemEstado?.code, RECUSA_DO_TRIGGER, 'sem mudar de estado a transição é ilegal');
      for (const [sql, params] of [
        ["UPDATE solicitacoes_epi SET status = 'APROVADA' WHERE id = $1", []],
        ["UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $2, cancelada_em = clock_timestamp() WHERE id = $1", [d.solicitante]],
        ["UPDATE solicitacoes_epi SET status = 'PENDENTE', entregue_em = NULL WHERE id = $1", []],
      ]) {
        const erro = await transicao(aprovada, sql, params);
        assert.equal(erro?.code, RECUSA_DO_TRIGGER, sql);
      }
    });

    test('quem decide não é quem pediu: o banco recusa decisão do próprio solicitante; AUTOATENDIMENTO não tem esse conflito', async () => {
      const { solicitacao, itens } = await nova(comItem({}));
      const propria = await erroDe(decidirSolicitacao(c, solicitacao, {
        status: 'APROVADA', decididaPor: d.solicitante, decisoes: itens.map((i) => aprovar(i)),
      }));
      assert.deepEqual(par(propria), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_decisor_diferente_do_solicitante']);
      const { solicitacao: auto, itens: itensAuto } = await nova({ origem: 'AUTOATENDIMENTO', itens: [item(d.botina)] });
      const decidida = await decidirSolicitacao(c, auto, {
        status: 'APROVADA', decididaPor: d.solicitante, decisoes: itensAuto.map((i) => aprovar(i)),
      });
      assert.equal(decidida.status, 'APROVADA');
    });

    test('a ordem dos carimbos é coerente: decisão e cancelamento não anteriores à criação, entrega não anterior à decisão', async () => {
      const { solicitacao, itens } = await nova(comItem({}));
      const decisaoAntes = await aceitoSemGravar(async () => {
        await q('UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2 WHERE id = $3', ['APROVADO', 2, itens[0].id]);
        return transicao(solicitacao, "UPDATE solicitacoes_epi SET status = 'APROVADA', decidida_por = $2, decidida_em = criada_em - interval '1 second' WHERE id = $1", [d.aprovador]);
      });
      assert.deepEqual(par(decisaoAntes), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_ordem_dos_carimbos']);
      const cancelamentoAntes = await aceitoSemGravar(() => transicao(
        solicitacao,
        "UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $2, cancelada_em = criada_em - interval '1 second' WHERE id = $1",
        [d.solicitante],
      ));
      assert.deepEqual(par(cancelamentoAntes), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_ordem_dos_carimbos']);
      const aprovada = (await criarSolicitacaoAprovada(c, d, comItem({}))).solicitacao;
      const entregaAntes = await aceitoSemGravar(() => transicao(
        aprovada, "UPDATE solicitacoes_epi SET status = 'ENTREGUE', entregue_em = decidida_em - interval '1 second' WHERE id = $1",
      ));
      assert.deepEqual(par(entregaAntes), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_ordem_dos_carimbos']);
    });
  });

  test('um material sem tamanho e um com tamanho convivem no mesmo pedido; material de outra empresa nunca entra', async () => {
    const extra = await criarMaterial(c, d.empresaA, 'Protetor auricular', { exigeTamanho: false });
    const { itens } = await nova({ itens: [item(extra, { tamanho: null }), item(d.botina, { tamanho: '42' })] });
    assert.deepEqual(itens.map((i) => i.tamanho), [null, '42']);
    const cruzado = await tentarNova({ itens: [item(extra, { tamanho: null }), item(d.botinaB)] });
    assert.equal(cruzado?.constraint, 'fk_solicitacoes_epi_itens_material_mesma_empresa');
  });
});

describe('migration 065 — concorrência, com conexões distintas', () => {
  let contexto;
  let d;

  const pool = () => contexto.pool;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    d = await montarCenario(contexto.pool);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('numeração: criações simultâneas recebem 1..N sem repetir nem pular, mesmo com transações que falham depois de pegar o número', async () => {
    const empresa = d.empresaB;
    const sucessos = Array.from({ length: 12 }, () => transacao(pool(), async (t) => {
      const numero = await proximoNumeroDaSolicitacao(t, empresa);
      const s = await inserirSolicitacao(t, {
        empresa_id: empresa, numero, funcionario_id: d.trabalhadorB, solicitante_usuario_id: d.usuarioB,
      });
      await inserirItemDaSolicitacao(t, { empresa_id: empresa, solicitacao_id: s.id, material_id: d.botinaB });
      return numero;
    }));
    const falhas = Array.from({ length: 4 }, () => transacao(pool(), async (t) => {
      await proximoNumeroDaSolicitacao(t, empresa);
      throw new Error('falha depois de pegar o número');
    }));
    const resultados = await Promise.allSettled([...sucessos, ...falhas]);
    const numeros = resultados.slice(0, 12).map((r) => r.value).sort((a, b) => a - b);
    assert.deepEqual(numeros, Array.from({ length: 12 }, (_, i) => i + 1));
    assert.equal(resultados.slice(12).every((r) => r.status === 'rejected'), true);
    const { rows } = await pool().query('SELECT numero FROM solicitacoes_epi WHERE empresa_id = $1 ORDER BY numero', [empresa]);
    assert.deepEqual(rows.map((r) => r.numero), numeros);
    assert.equal((await pool().query('SELECT ultimo_numero FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [empresa])).rows[0].ultimo_numero, 12);
  });

  test('idempotência: duas transações com a mesma chave na mesma empresa — uma grava e a outra recebe a violação da unicidade', async () => {
    const chave = crypto.randomUUID();
    // Os números saem antes, em transações próprias: a espera que importa aqui é a da chave, não a do contador.
    const numeros = [await proximoNumeroDaSolicitacao(pool(), d.empresaA), await proximoNumeroDaSolicitacao(pool(), d.empresaA)];
    const dados = (numero) => ({
      empresa_id: d.empresaA, numero, funcionario_id: d.trabalhadorA, solicitante_usuario_id: d.solicitante, chave_idempotencia: chave,
    });
    const um = await pool().connect();
    const dois = await pool().connect();
    try {
      const { rows: [{ pid }] } = await dois.query('SELECT pg_backend_pid() AS pid');
      await um.query('BEGIN');
      await dois.query('BEGIN');
      const gravada = await inserirSolicitacao(um, dados(numeros[0]));
      await inserirItemDaSolicitacao(um, { empresa_id: d.empresaA, solicitacao_id: gravada.id, material_id: d.botina });
      const concorrente = erroDe(inserirSolicitacao(dois, dados(numeros[1])));
      await aguardarEsperaPeloLock(contexto.pool, pid);
      await um.query('COMMIT');
      const erro = await concorrente;
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_UNIQUE, 'uq_solicitacoes_epi_idempotencia']);
      await dois.query('ROLLBACK');
    } finally {
      um.release();
      dois.release();
    }
    const { rows: [{ n }] } = await pool().query('SELECT count(*)::int AS n FROM solicitacoes_epi WHERE chave_idempotencia = $1', [chave]);
    assert.equal(n, 1);
  });

  test('decisão × cancelamento da mesma PENDENTE: o UPDATE protegido por estado deixa um só vencedor; sem a proteção o banco recusa a transição', async () => {
    const { solicitacao, itens } = await criarSolicitacao(pool(), d, { itens: [{ material_id: d.botina }] });
    const decisor = await pool().connect();
    const cancelador = await pool().connect();
    const semProtecao = await pool().connect();
    try {
      const { rows: [{ pid: pidCancelador }] } = await cancelador.query('SELECT pg_backend_pid() AS pid');
      const { rows: [{ pid: pidSemProtecao }] } = await semProtecao.query('SELECT pg_backend_pid() AS pid');
      await decisor.query('BEGIN');
      await decisor.query('UPDATE solicitacoes_epi_itens SET decisao = $1, quantidade_aprovada = $2 WHERE id = $3', ['APROVADO', 2, itens[0].id]);
      await decisor.query(
        "UPDATE solicitacoes_epi SET status = 'APROVADA', decidida_por = $1, decidida_em = clock_timestamp() WHERE id = $2 AND status = 'PENDENTE'",
        [d.aprovador, solicitacao.id],
      );

      await cancelador.query('BEGIN');
      const cancelamento = cancelador.query(
        "UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $1, cancelada_em = clock_timestamp() WHERE id = $2 AND status = 'PENDENTE'",
        [d.solicitante, solicitacao.id],
      );
      await semProtecao.query('BEGIN');
      const semGuarda = erroDe(semProtecao.query(
        "UPDATE solicitacoes_epi SET status = 'CANCELADA', cancelada_por = $1, cancelada_em = clock_timestamp() WHERE id = $2",
        [d.solicitante, solicitacao.id],
      ));
      await aguardarEsperaPeloLock(contexto.pool, pidCancelador);
      await aguardarEsperaPeloLock(contexto.pool, pidSemProtecao);
      await decisor.query('COMMIT');

      const resultado = await cancelamento;
      assert.equal(resultado.rowCount, 0, 'o cancelamento não encontra mais a solicitação PENDENTE');
      await cancelador.query('COMMIT');
      const recusa = await semGuarda;
      assert.equal(recusa?.code, RECUSA_DO_TRIGGER);
      assert.match(recusa.message, /transição/);
      await semProtecao.query('ROLLBACK');
    } finally {
      decisor.release();
      cancelador.release();
      semProtecao.release();
    }
    const { rows: [final] } = await pool().query('SELECT status, cancelada_por, cancelada_em FROM solicitacoes_epi WHERE id = $1', [solicitacao.id]);
    assert.deepEqual(final, { status: 'APROVADA', cancelada_por: null, cancelada_em: null });
  });
});
