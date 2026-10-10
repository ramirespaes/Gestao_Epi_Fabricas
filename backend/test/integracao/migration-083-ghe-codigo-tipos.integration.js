'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe, inserir, criarGhe } = require('./helpers/entrega-epi');
const {
  CNPJ_A, montarCenario, criarSolicitacao, criarSolicitacaoAprovada, criarLoteDeEntrada, entregarDireta,
} = require('./helpers/solicitacao-epi');

/**
 * Migration 083 — código do GHE e vínculo GHE × tipo do catálogo (Incremento 1 da evolução GHE/importação GHE-EPI).
 * PostgreSQL real, schema temporário exclusivo (o cleanup é o `DROP SCHEMA ... CASCADE` do helper, inclusive quando o teste falha).
 *
 * A 083 é ADITIVA: acrescenta `grupos_homogeneos_exposicao.codigo` (NULL nos GHEs legados) e cria `ghe_tipos_material`
 * (GHE × tipo de `tipos_material`, com classificação OBRIGATORIO / NAO_OBRIGATORIO). Não toca `ghe_materiais`, funcionários,
 * entregas, solicitações nem snapshots históricos, não move dado algum e não cria backfill.
 *
 * O formato `GHE-` + 3 a 6 dígitos é regra do serviço/API (Incremento 2); no banco vale só a forma canônica do código
 * (aparado, maiúsculo, 1 a 30 caracteres, sem caractere de controle).
 *
 * RED: nenhum teste falha por quebra do próprio harness. O cenário legado é semeado ANTES da 083 (sem ela); a 083 só é
 * aplicada se o arquivo existir, e cada verificação exige a migration com uma asserção explícita.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const VIOLACAO_CHECK = '23514';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';
const NULO_OBRIGATORIO = '23502';
const ERRO_VALOR_LONGO_DEMAIS = '22001';
// Digest consolidado de "<arquivo>  <sha256>\n" das migrations 000–082, do repositório antes da 083 (baseline do Incremento 0).
const DIGEST_000_A_082 = '2d8c679d72c05f3b4de1148d49c32df0555cd050e312dafd10dbb4886b962154';
const PRESERVADAS = [
  'empresas', 'usuarios', 'funcionarios', 'materiais', 'tipos_material', 'ghe_materiais', 'estoque_lotes', 'estoque_operacoes',
  'fichas_epi', 'entregas_epi', 'entregas_epi_itens', 'entregas_epi_confirmacoes', 'solicitacoes_epi', 'solicitacoes_epi_itens',
];

const par = (erro) => [erro?.code, erro?.constraint];

function exigir083() {
  assert.equal(migrationExiste('083'), true, 'migration 083 ainda não implementada (código do GHE e ghe_tipos_material)');
}

describe('migration 083 — código do GHE e GHE × tipo do catálogo', () => {
  let ctx;
  let d;
  let tipoA;
  let tipoA2;
  let tipoB;
  let erroDoCenario = null;
  let erroAoAplicar = 'não aplicada: o arquivo da 083 não existe';
  let antes = null;
  let estruturaAntes = null;
  let seq = 0;

  const q = (sql, params) => ctx.cliente.query(sql, params);
  const gheNovo = (empresaId, extra = {}) => {
    seq += 1;
    return inserir(ctx.cliente, 'grupos_homogeneos_exposicao', { empresa_id: empresaId, nome: `GHE de teste ${seq} ${crypto.randomUUID().slice(0, 6)}`, ...extra });
  };
  const tipoNovo = async (empresaId) => {
    seq += 1;
    return (await inserir(ctx.cliente, 'tipos_material', {
      empresa_id: empresaId, grupo: 'EPI', grupo_protecao: 'Proteção auditiva', nome: `Tipo de teste ${seq} ${crypto.randomUUID().slice(0, 6)}`, origem: 'MANUAL',
    })).id;
  };
  const vincularTipo = (valores) => inserir(ctx.cliente, 'ghe_tipos_material', { classificacao: 'OBRIGATORIO', ...valores });

  /** Retrato (md5 + contagem) de uma tabela, na ordem do próprio conteúdo (nem toda tabela tem `id`); `sem` tira chaves do JSON (a coluna nova do GHE). */
  const retrato = async (tabela, sem = []) => {
    const retirar = sem.map((c) => ` - '${c}'`).join('');
    const { rows } = await q(
      `SELECT md5(COALESCE(string_agg(j, '|' ORDER BY j), '')) AS md5, count(*)::int AS n FROM (SELECT ((to_jsonb(t)${retirar}))::text AS j FROM ${tabela} t) s`,
    );
    return rows[0];
  };
  const retratos = async () => {
    const r = {};
    for (const tabela of PRESERVADAS) r[tabela] = await retrato(tabela);
    r.grupos_homogeneos_exposicao = await retrato('grupos_homogeneos_exposicao', ['codigo']);
    return r;
  };
  const estrutura = async () => {
    const tabelas = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1")).rows.map((x) => x.table_name);
    const colunas = {};
    for (const x of (await q(
      `SELECT table_name, column_name, data_type, is_nullable, character_maximum_length FROM information_schema.columns
        WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`,
    )).rows) {
      (colunas[x.table_name] = colunas[x.table_name] || []).push(`${x.column_name}:${x.data_type}:${x.is_nullable}:${x.character_maximum_length ?? ''}`);
    }
    return { tabelas, colunas };
  };

  before(async () => {
    // Schema com tudo até a 082, SEM a 083 (mesmo depois de ela existir): o cenário legado nasce antes da migration.
    ctx = await abrirSchemaTemporario(todasAsMigrations().filter((prefixo) => prefixo !== '083'));
    try {
      d = await montarCenario(ctx.cliente);
      d.gheA2 = await criarGhe(ctx.cliente, d.empresaA, 'GHE A sem EPI');
      for (const [gheId, materialId] of [[d.gheA, d.botina], [d.gheA, d.capacete], [d.gheB, d.botinaB]]) {
        await inserir(ctx.cliente, 'ghe_materiais', { empresa_id: gheId === d.gheB ? d.empresaB : d.empresaA, grupo_homogeneo_id: gheId, material_id: materialId });
      }
      tipoA = await tipoNovo(d.empresaA);
      tipoA2 = await tipoNovo(d.empresaA);
      tipoB = await tipoNovo(d.empresaB);
      const lote = await criarLoteDeEntrada(ctx.cliente, { empresaId: d.empresaA, materialId: d.botina, quantidade: 10, usuarioId: d.aprovador });
      await entregarDireta(ctx.cliente, {
        empresaId: d.empresaA, funcionarioId: d.trabalhadorA, usuarioId: d.aprovador, materialId: d.botina, loteId: lote, quantidade: 1, cnpj: CNPJ_A,
      });
      await criarSolicitacaoAprovada(ctx.cliente, d, { gheId: d.gheA, itens: [{ material_id: d.botina, quantidade: 2, previsto_no_ghe: true }] });
      await criarSolicitacao(ctx.cliente, d, { gheId: d.gheA, itens: [{ material_id: d.luva, quantidade: 1, previsto_no_ghe: false, tamanho: '40' }] });
      antes = await retratos();
      estruturaAntes = await estrutura();
    } catch (erro) {
      erroDoCenario = erro;
    }
    // A falha da aplicação vira asserção abaixo (e não cancelamento da suíte).
    if (erroDoCenario === null && migrationExiste('083')) erroAoAplicar = await erroDe(q(conteudoDaMigration('083')));
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('sanidade do próprio teste: o cenário legado foi semeado (GHEs sem código, vínculos diretos, entrega e solicitações com snapshots)', () => {
    assert.equal(erroDoCenario, null, erroDoCenario ? `${erroDoCenario.message}` : '');
    assert.ok(antes.grupos_homogeneos_exposicao.n >= 3, 'GHEs');
    assert.equal(antes.ghe_materiais.n, 3);
    assert.ok(antes.entregas_epi_itens.n >= 1, 'item de entrega com snapshot');
    assert.ok(antes.solicitacoes_epi_itens.n >= 2, 'itens de solicitação com snapshot');
    assert.ok(antes.funcionarios.n >= 1, 'funcionários');
    assert.equal(antes.tipos_material.n, 3, 'os três tipos semeados pelo teste (nenhum "Outros")');
  });

  test('a 083 existe e aplica sobre o schema com dados legados sem erro', () => {
    exigir083();
    assert.equal(erroAoAplicar, null, JSON.stringify(erroAoAplicar));
  });

  test('só os objetos da 083 aparecem: uma tabela nova (ghe_tipos_material) e uma coluna nova (grupos_homogeneos_exposicao.codigo)', async () => {
    exigir083();
    const depois = await estrutura();
    assert.deepEqual(depois.tabelas.filter((t) => !estruturaAntes.tabelas.includes(t)), ['ghe_tipos_material']);
    assert.deepEqual(estruturaAntes.tabelas.filter((t) => !depois.tabelas.includes(t)), [], 'nenhuma tabela removida');
    for (const tabela of estruturaAntes.tabelas) {
      const esperado = tabela === 'grupos_homogeneos_exposicao'
        ? [...estruturaAntes.colunas[tabela], 'codigo:character varying:YES:30']
        : estruturaAntes.colunas[tabela];
      assert.deepEqual(depois.colunas[tabela], esperado, `colunas de ${tabela}`);
    }
  });

  test('GHE legado permanece com codigo NULL e nenhuma linha existente muda (retrato idêntico, sem a coluna nova)', async () => {
    exigir083();
    assert.equal((await q('SELECT count(*)::int AS n FROM grupos_homogeneos_exposicao WHERE codigo IS NOT NULL')).rows[0].n, 0);
    assert.deepEqual(await retrato('grupos_homogeneos_exposicao', ['codigo']), antes.grupos_homogeneos_exposicao);
  });

  test('preservação integral: ghe_materiais, funcionários, estoque, fichas, entregas, solicitações e snapshots idênticos; nada movido para ghe_tipos_material', async () => {
    exigir083();
    const depois = await retratos();
    for (const tabela of PRESERVADAS) assert.deepEqual(depois[tabela], antes[tabela], tabela);
    assert.equal((await q('SELECT count(*)::int AS n FROM ghe_tipos_material')).rows[0].n, 0, 'sem backfill: nenhum vínculo por tipo é inventado');
    const snapshots = (await q('SELECT previsto_no_ghe, count(*)::int AS n FROM solicitacoes_epi_itens GROUP BY 1 ORDER BY 1')).rows;
    assert.deepEqual(snapshots, [{ previsto_no_ghe: false, n: 1 }, { previsto_no_ghe: true, n: 1 }], 'previsto_no_ghe das solicitações permanece como estava');
  });

  test('codigo: VARCHAR(30) nulo; a forma canônica é exigida (aparado, maiúsculo, 1 a 30 caracteres, sem controle)', async () => {
    exigir083();
    const coluna = (await q(
      "SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'grupos_homogeneos_exposicao' AND column_name = 'codigo'",
    )).rows[0];
    assert.deepEqual(coluna, { data_type: 'character varying', character_maximum_length: 30, is_nullable: 'YES' });
    for (const invalido of ['', ' GHE-001', 'GHE-001 ', 'ghe-001', 'Ghe-001', 'GHE-0\n01', 'GHE-0\t01']) {
      const erro = await erroDe(gheNovo(d.empresaA, { codigo: invalido }));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'chk_ghe_codigo_canonico'], JSON.stringify(invalido));
    }
    // Excesso de comprimento: a capacidade física da coluna VARCHAR(30) barra antes do CHECK (string_data_right_truncation).
    for (const longo of ['A'.repeat(31), `GHE-${'0'.repeat(30)}`]) {
      assert.equal((await erroDe(gheNovo(d.empresaA, { codigo: longo })))?.code, ERRO_VALOR_LONGO_DEMAIS, `${longo.length} caracteres`);
    }
    for (const valido of ['GHE-001', 'GHE-123456', 'X', 'A'.repeat(30)]) {
      const ghe = await gheNovo(d.empresaA, { codigo: valido });
      assert.equal(ghe.codigo, valido);
    }
  });

  test('codigo: único por empresa SOMENTE quando não nulo; empresas diferentes podem repetir; vários NULL convivem', async () => {
    exigir083();
    const indice = (await q("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uq_ghe_empresa_codigo'")).rows[0]?.indexdef;
    assert.match(indice ?? '', /UNIQUE INDEX .*\(empresa_id, codigo\)/);
    assert.match(indice ?? '', /WHERE \(?codigo IS NOT NULL\)?/);
    await gheNovo(d.empresaA, { codigo: 'GHE-801' });
    assert.deepEqual(par(await erroDe(gheNovo(d.empresaA, { codigo: 'GHE-801' }))), [VIOLACAO_UNIQUE, 'uq_ghe_empresa_codigo']);
    await gheNovo(d.empresaB, { codigo: 'GHE-801' });
    await gheNovo(d.empresaA);
    await gheNovo(d.empresaA);
    await gheNovo(d.empresaA, { codigo: null });
    const legado = await gheNovo(d.empresaA);
    await q('UPDATE grupos_homogeneos_exposicao SET codigo = $1 WHERE id = $2', ['GHE-802', legado.id]);
    assert.equal((await q('SELECT codigo FROM grupos_homogeneos_exposicao WHERE id = $1', [legado.id])).rows[0].codigo, 'GHE-802', 'o legado pode receber código depois');
    assert.deepEqual(par(await erroDe(q('UPDATE grupos_homogeneos_exposicao SET codigo = $1 WHERE id = $2', ['GHE-801', legado.id]))), [VIOLACAO_UNIQUE, 'uq_ghe_empresa_codigo']);
  });

  test('ghe_tipos_material: colunas, chave única por empresa + GHE + tipo e índice pelo lado do tipo', async () => {
    exigir083();
    const colunas = (await q(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'ghe_tipos_material' ORDER BY ordinal_position`,
    )).rows.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`);
    assert.deepEqual(colunas, [
      'id:integer:NO', 'empresa_id:integer:NO', 'grupo_homogeneo_id:integer:NO', 'tipo_material_id:integer:NO',
      'classificacao:character varying:NO', 'criado_em:timestamp with time zone:NO', 'atualizado_em:timestamp with time zone:NO',
    ]);
    const ghe = await gheNovo(d.empresaA);
    const outro = await gheNovo(d.empresaA);
    await vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: ghe.id, tipo_material_id: tipoA });
    assert.deepEqual(par(await erroDe(vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: ghe.id, tipo_material_id: tipoA }))), [VIOLACAO_UNIQUE, 'uq_ghe_tipos_material']);
    await vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: ghe.id, tipo_material_id: tipoA2 });
    await vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: outro.id, tipo_material_id: tipoA });
    const indice = (await q("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_ghe_tipos_material_tipo'")).rows[0]?.indexdef;
    assert.match(indice ?? '', /\(empresa_id, tipo_material_id\)/);
  });

  test('classificação: somente OBRIGATORIO e NAO_OBRIGATORIO; qualquer outro valor, vazio ou nulo é recusado', async () => {
    exigir083();
    for (const valida of ['OBRIGATORIO', 'NAO_OBRIGATORIO']) {
      const ghe = await gheNovo(d.empresaA);
      const linha = await vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: ghe.id, tipo_material_id: tipoA, classificacao: valida });
      assert.equal(linha.classificacao, valida);
    }
    for (const invalida of ['OBRIGATÓRIO', 'obrigatorio', 'Obrigatorio', 'NÃO_OBRIGATORIO', 'NAO OBRIGATORIO', 'OPCIONAL', '']) {
      const ghe = await gheNovo(d.empresaA);
      const erro = await erroDe(vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: ghe.id, tipo_material_id: tipoA, classificacao: invalida }));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'chk_ghe_tipos_material_classificacao'], JSON.stringify(invalida));
    }
    const ghe = await gheNovo(d.empresaA);
    const nulo = await erroDe(vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: ghe.id, tipo_material_id: tipoA, classificacao: null }));
    assert.equal(nulo?.code, NULO_OBRIGATORIO);
  });

  test('FKs compostas: GHE e tipo precisam ser da MESMA empresa da linha', async () => {
    exigir083();
    const gheA = await gheNovo(d.empresaA);
    const gheB = await gheNovo(d.empresaB);
    assert.deepEqual(par(await erroDe(vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: gheA.id, tipo_material_id: tipoB }))), [VIOLACAO_FK, 'fk_ghe_tipos_material_tipo_mesma_empresa']);
    assert.deepEqual(par(await erroDe(vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: gheB.id, tipo_material_id: tipoA }))), [VIOLACAO_FK, 'fk_ghe_tipos_material_ghe_mesma_empresa']);
    assert.deepEqual(par(await erroDe(vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: 2147483000, tipo_material_id: tipoA }))), [VIOLACAO_FK, 'fk_ghe_tipos_material_ghe_mesma_empresa']);
    assert.deepEqual(par(await erroDe(vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: gheA.id, tipo_material_id: 2147483000 }))), [VIOLACAO_FK, 'fk_ghe_tipos_material_tipo_mesma_empresa']);
    await vincularTipo({ empresa_id: d.empresaB, grupo_homogeneo_id: gheB.id, tipo_material_id: tipoB });
  });

  test('ON DELETE RESTRICT: GHE e tipo com vínculo não podem ser apagados', async () => {
    exigir083();
    const ghe = await gheNovo(d.empresaA);
    const tipo = await tipoNovo(d.empresaA);
    await vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: ghe.id, tipo_material_id: tipo });
    assert.deepEqual(par(await erroDe(q('DELETE FROM grupos_homogeneos_exposicao WHERE id = $1', [ghe.id]))), [VIOLACAO_FK, 'fk_ghe_tipos_material_ghe_mesma_empresa']);
    assert.deepEqual(par(await erroDe(q('DELETE FROM tipos_material WHERE id = $1', [tipo]))), [VIOLACAO_FK, 'fk_ghe_tipos_material_tipo_mesma_empresa']);
    const acoes = (await q(
      `SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'ghe_tipos_material'::regclass AND contype = 'f' ORDER BY conname`,
    )).rows.filter((c) => c.conname.startsWith('fk_ghe_tipos_material_'));
    assert.deepEqual(acoes.map((c) => [c.conname, c.confdeltype]), [['fk_ghe_tipos_material_ghe_mesma_empresa', 'r'], ['fk_ghe_tipos_material_tipo_mesma_empresa', 'r']]);
  });

  test('gatilho de atualizado_em: alterar a classificação avança atualizado_em e preserva criado_em', async () => {
    exigir083();
    const gatilho = (await q(
      `SELECT pg_get_triggerdef(oid) AS definicao FROM pg_trigger WHERE tgrelid = 'ghe_tipos_material'::regclass AND NOT tgisinternal`,
    )).rows.map((t) => t.definicao);
    assert.ok(gatilho.some((t) => /BEFORE UPDATE ON .*ghe_tipos_material/.test(t) && /set_atualizado_em/.test(t)), JSON.stringify(gatilho));
    const ghe = await gheNovo(d.empresaA);
    const criada = await vincularTipo({ empresa_id: d.empresaA, grupo_homogeneo_id: ghe.id, tipo_material_id: tipoA });
    await q('SELECT pg_sleep(0.05)');
    const { rows: [alterada] } = await q("UPDATE ghe_tipos_material SET classificacao = 'NAO_OBRIGATORIO' WHERE id = $1 RETURNING criado_em, atualizado_em", [criada.id]);
    assert.equal(new Date(alterada.criado_em).getTime(), new Date(criada.criado_em).getTime());
    assert.ok(new Date(alterada.atualizado_em).getTime() > new Date(criada.atualizado_em).getTime(), 'atualizado_em avançou');
  });

  test('a 083 é só aditiva: nenhum DROP, DELETE, UPDATE, INSERT ou TRUNCATE; o único ALTER sobre tabela existente é o do código em grupos_homogeneos_exposicao', () => {
    exigir083();
    const sql = conteudoDaMigration('083').replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /(^|;)\s*(UPDATE\s+\w|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE|DROP\s)/im);
    const instrucoes = sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

    // ALTER TABLE: em grupos_homogeneos_exposicao SOMENTE adicionar a coluna `codigo` e o CHECK canônico do código;
    // em ghe_tipos_material (tabela criada aqui) SOMENTE constraints; em qualquer outra tabela, NUNCA.
    const alteracoes = instrucoes.filter((s) => /^ALTER TABLE\b/i.test(s));
    for (const instrucao of alteracoes) {
      const analise = /^ALTER TABLE (?:ONLY )?(\w+) (.*)$/i.exec(instrucao);
      assert.ok(analise, `ALTER TABLE não reconhecido: ${instrucao}`);
      const [, tabela, corpo] = analise;
      const acoes = corpo.split(/,\s*(?=(?:ADD|ALTER|DROP|RENAME|SET|OWNER|VALIDATE)\b)/i);
      if (tabela === 'grupos_homogeneos_exposicao') {
        for (const acao of acoes) {
          assert.match(acao, /^ADD COLUMN codigo\b|^ADD CONSTRAINT chk_ghe_codigo_canonico\b/i, `ação não autorizada em grupos_homogeneos_exposicao: ${acao}`);
        }
      } else if (tabela === 'ghe_tipos_material') {
        for (const acao of acoes) assert.match(acao, /^ADD CONSTRAINT\b/i, `ação não autorizada em ghe_tipos_material: ${acao}`);
      } else {
        assert.fail(`ALTER TABLE em ${tabela}: a 083 não pode alterar outra tabela`);
      }
    }
    assert.ok(alteracoes.some((s) => /^ALTER TABLE grupos_homogeneos_exposicao ADD COLUMN codigo\b/i.test(s)), 'falta adicionar a coluna codigo ao GHE');

    // CREATE: só a tabela nova, o gatilho dela e os dois índices (o único parcial do código e o do lado do tipo).
    const criacoesDeTabela = instrucoes.filter((s) => /^CREATE TABLE\b/i.test(s)).map((s) => /^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(s)?.[1]);
    assert.deepEqual(criacoesDeTabela, ['ghe_tipos_material']);
    const gatilhos = instrucoes.filter((s) => /^CREATE (?:OR REPLACE )?TRIGGER\b/i.test(s));
    assert.ok(gatilhos.length >= 1 && gatilhos.every((s) => /\bON ghe_tipos_material\b/i.test(s)), 'gatilhos só na tabela nova');
    const indices = instrucoes.filter((s) => /^CREATE (?:UNIQUE )?INDEX\b/i.test(s))
      .map((s) => /^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+) ON (\w+)/i.exec(s)?.slice(1, 3).join('@'));
    assert.deepEqual(indices.sort(), ['idx_ghe_tipos_material_tipo@ghe_tipos_material', 'uq_ghe_empresa_codigo@grupos_homogeneos_exposicao']);
  });

  test('manifesto: as migrations 000–082 continuam idênticas; a 083 vem logo depois, coerente com o arquivo (a 084 é posterior)', () => {
    exigir083();
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8')).migrations;
    const arquivos = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
    assert.equal(arquivos.length, 85);
    assert.deepEqual(Object.keys(manifesto).sort(), arquivos);
    const sha = (nome) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, nome))).digest('hex');
    for (const nome of arquivos) assert.equal(sha(nome), manifesto[nome], nome);
    const antigas = arquivos.filter((n) => n.slice(0, 3) <= '082');
    assert.equal(antigas.length, 83);
    const digest = crypto.createHash('sha256').update(`${antigas.map((n) => `${n}  ${sha(n)}`).join('\n')}\n`).digest('hex');
    assert.equal(digest, DIGEST_000_A_082, 'alguma migration 000–082 foi editada');
    const novas = arquivos.filter((n) => n.slice(0, 3) > '082');
    assert.equal(novas.length, 2);
    assert.match(novas[0], /^083_.+\.sql$/);
    assert.match(novas[1], /^084_.+\.sql$/);
  });
});
