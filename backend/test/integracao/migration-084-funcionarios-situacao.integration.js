'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, inserirEmpresa, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 084 — situação do funcionário (RED). PostgreSQL real, schema temporário exclusivo do banco de teste.
 *
 * Contrato aprovado (Gestão de Funcionários, decisão O1):
 *   - `situacao` é a fonte da verdade: ATIVO | AFASTADO | INATIVO, NOT NULL, DEFAULT 'ATIVO' (o INSERT antigo, sem a coluna,
 *     continua válido e nasce ATIVO — é o caso do cadastro individual e da importação);
 *   - CHECK `chk_funcionarios_situacao` recusa qualquer outro valor;
 *   - `ativo` continua existindo só por compatibilidade, como coluna GERADA `situacao = 'ATIVO'` (STORED): ATIVO → true,
 *     AFASTADO → false, INATIVO → false. Não há gatilho nem duas fontes de verdade: escrever `ativo` direto é erro do
 *     PostgreSQL (SQLSTATE 428C9), então divergência é impossível;
 *   - backfill: ativo = true → ATIVO; ativo = false → INATIVO; ninguém nasce AFASTADO;
 *   - nada se perde: mesmos ids, mesmas colunas, GHE, criado_em e atualizado_em (o backfill não pode "tocar" o registro);
 *     restrições, FKs que apontam para funcionarios e índices continuam; o gatilho de atualizado_em volta habilitado.
 *
 * O estado anterior (000 a 083) é montado explicitamente e a 084 só é aplicada, uma vez, no primeiro teste que a exige. Enquanto
 * `backend/migrations/084_*.sql` não existir, cada teste falha por asserção ("a migration 084 ainda não existe"). Nunca roda em
 * banco persistente: só o schema temporário (helpers/schema-temporario.js recusa qualquer banco que não seja o de teste).
 */

const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const MIGRATIONS_ATE_083 = fs.readdirSync(DIRETORIO_MIGRATIONS)
  .map((nome) => nome.match(/^(\d{3})_.*\.sql$/)?.[1])
  .filter((prefixo) => prefixo !== undefined && prefixo <= '083')
  .sort();

const VIOLACAO_CHECK = '23514';
const VIOLACAO_NOT_NULL = '23502';
const VIOLACAO_FK = '23503';
const ESCRITA_EM_COLUNA_GERADA = '428C9';

const COLUNAS_SNAPSHOT = `id, empresa_id, grupo_homogeneo_id, matricula, nome, cpf,
  to_char(data_nascimento, 'YYYY-MM-DD') AS data_nascimento, to_char(data_admissao, 'YYYY-MM-DD') AS data_admissao,
  setor, funcao, cracha, telefone,
  to_char(criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS criado_em,
  to_char(atualizado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS atualizado_em`;

describe('migration 084 — funcionarios.situacao (ATIVO | AFASTADO | INATIVO) e ativo gerado', () => {
  let contexto;
  let c;
  let empresaA;
  let empresaB;
  let gheA;
  let gheB;
  let antes;
  let aplicada = false;
  let sequencia = 0;

  const fotografia = async () => (await c.query(`SELECT ${COLUNAS_SNAPSHOT}, ativo FROM funcionarios ORDER BY id`)).rows;
  const nomesDe = async (sql, parametros = []) => (await c.query(sql, parametros)).rows;
  const estrutura = async () => ({
    restricoes: (await nomesDe("SELECT conname FROM pg_constraint WHERE conrelid = 'funcionarios'::regclass ORDER BY 1")).map((r) => r.conname),
    apontamEmFuncionarios: (await nomesDe("SELECT conrelid::regclass::text AS tabela, conname FROM pg_constraint WHERE confrelid = 'funcionarios'::regclass ORDER BY 1, 2")).map((r) => `${r.tabela}.${r.conname}`),
    indices: (await nomesDe('SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY 1', [contexto.schema, 'funcionarios'])).map((r) => r.indexname),
    gatilhos: (await nomesDe("SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'funcionarios'::regclass AND NOT tgisinternal ORDER BY 1")).map((r) => `${r.tgname}:${r.tgenabled}`),
  });

  /** Aplica a 084 uma única vez; sem o arquivo, falha por asserção (o comportamento que falta). */
  const aplicar084 = async () => {
    assert.ok(migrationExiste('084'), 'a migration 084 (situação do funcionário) ainda não existe em backend/migrations');
    if (!aplicada) {
      await c.query(conteudoDaMigration('084'));
      aplicada = true;
    }
  };

  /** INSERT com colunas escolhidas; devolve a linha ou o SQLSTATE/constraint do erro. */
  const inserir = async (extra = {}) => {
    sequencia += 1;
    const colunas = ['empresa_id', 'matricula', 'nome', 'cpf'];
    const valores = [empresaA, `S-${sequencia}`, `Situação ${sequencia}`, String(30000000000 + sequencia)];
    for (const chave of ['situacao', 'ativo']) {
      if (chave in extra) { colunas.push(chave); valores.push(extra[chave]); }
    }
    try {
      const { rows } = await c.query(
        `INSERT INTO funcionarios (${colunas.join(', ')}) VALUES (${valores.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, situacao, ativo`,
        valores,
      );
      return { ok: true, linha: rows[0] };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint, coluna: erro.column };
    }
  };

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_ATE_083);
    c = contexto.cliente;
    assert.equal(await inserirEmpresa(c, '11222333000181', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(c, '11444777000161', 'Empresa B'), 'ok');
    [empresaA, empresaB] = (await c.query('SELECT id FROM empresas ORDER BY id')).rows.map((r) => r.id);
    gheA = (await c.query("INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome) VALUES ($1, 'GHE A') RETURNING id", [empresaA])).rows[0].id;
    gheB = (await c.query("INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome) VALUES ($1, 'GHE B') RETURNING id", [empresaB])).rows[0].id;

    // Funcionários "de hoje" (antes da 084): a coluna `ativo` ainda é gravável. Cobre ativo/inativo, com e sem GHE, completos e legados.
    const legados = [
      [empresaA, gheA, 'M-1', 'Ana Ativa', '52998224725', '1990-03-15', '2020-06-01', 'Produção', 'Operadora', 'C-1', '(47) 99999-0001', true],
      [empresaA, gheA, 'M-2', 'Ivo Inativo', '11144477735', '1985-07-22', '2019-02-10', 'Manutenção', 'Mecânico', null, null, false],
      [empresaA, null, null, 'Lia Legada Ativa', '39053344705', null, '2018-01-05', null, null, null, null, true],
      [empresaA, null, null, 'Leo Legado Inativo', '86288366757', null, '2017-09-09', null, null, null, null, false],
      [empresaB, gheB, 'M-9', 'Bia da Outra Empresa', '71428793860', null, '2021-04-12', 'Expedição', 'Auxiliar', null, null, true],
    ];
    for (const l of legados) {
      await c.query(
        `INSERT INTO funcionarios (empresa_id, grupo_homogeneo_id, matricula, nome, cpf, data_nascimento, data_admissao, setor, funcao, cracha, telefone, ativo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        l,
      );
    }
    antes = { linhas: await fotografia(), estrutura: await estrutura() };
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  // ─── Premissas que NÃO dependem da 084 (caracterização do ambiente) ───
  test('premissa: o PostgreSQL do projeto suporta a estratégia (coluna gerada STORED); versão mínima 12', async () => {
    const versao = Number((await c.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(versao >= 120000, `PostgreSQL ${versao}: coluna gerada STORED exige 12 ou superior`);
    await c.query("CREATE TABLE sonda_coluna_gerada (situacao VARCHAR(10) NOT NULL, ativo BOOLEAN GENERATED ALWAYS AS (situacao = 'ATIVO') STORED)");
    await c.query("INSERT INTO sonda_coluna_gerada (situacao) VALUES ('ATIVO'), ('AFASTADO'), ('INATIVO')");
    const { rows } = await c.query('SELECT situacao, ativo FROM sonda_coluna_gerada ORDER BY situacao');
    assert.deepEqual(rows.map((r) => [r.situacao, r.ativo]), [['ATIVO', true], ['AFASTADO', false], ['INATIVO', false]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    await c.query('DROP TABLE sonda_coluna_gerada');
  });

  test('premissa: o estado anterior é a 000–083 contígua, `situacao` não existe e `ativo` é uma coluna comum e gravável', async () => {
    assert.equal(MIGRATIONS_ATE_083.length, 84);
    assert.equal(MIGRATIONS_ATE_083[0], '000');
    assert.equal(MIGRATIONS_ATE_083.at(-1), '083');
    const colunas = (await nomesDe(
      "SELECT column_name, is_generated FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'funcionarios' AND column_name IN ('situacao', 'ativo') ORDER BY 1",
      [contexto.schema],
    ));
    assert.deepEqual(colunas, [{ column_name: 'ativo', is_generated: 'NEVER' }]);
    assert.equal(antes.linhas.length, 5);
    assert.deepEqual(antes.linhas.map((l) => l.ativo), [true, false, true, false, true]);
  });

  // ─── Contrato da 084 ───
  test('existe `situacao`: texto curto, NOT NULL, DEFAULT ATIVO', async () => {
    await aplicar084();
    const { rows } = await c.query(
      `SELECT data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'funcionarios' AND column_name = 'situacao'`,
      [contexto.schema],
    );
    assert.equal(rows.length, 1, 'coluna situacao ausente');
    assert.equal(rows[0].data_type, 'character varying');
    assert.ok(rows[0].character_maximum_length >= 8, 'comporta AFASTADO');
    assert.equal(rows[0].is_nullable, 'NO');
    assert.match(String(rows[0].column_default), /'ATIVO'/);
  });

  test('backfill: ativo = true → ATIVO, ativo = false → INATIVO; ninguém nasce AFASTADO', async () => {
    await aplicar084();
    const { rows } = await c.query('SELECT id, situacao, ativo FROM funcionarios WHERE id = ANY($1::int[]) ORDER BY id', [antes.linhas.map((l) => l.id)]);
    assert.deepEqual(
      rows.map((r) => [r.id, r.situacao]),
      antes.linhas.map((l) => [l.id, l.ativo ? 'ATIVO' : 'INATIVO']),
    );
    assert.equal(rows.some((r) => r.situacao === 'AFASTADO'), false);
  });

  test('`ativo` vira coluna GERADA a partir de `situacao` (não gravável, sem gatilho)', async () => {
    await aplicar084();
    const { rows } = await c.query(
      `SELECT is_generated, generation_expression, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'funcionarios' AND column_name = 'ativo'`,
      [contexto.schema],
    );
    assert.equal(rows.length, 1, 'a coluna ativo precisa continuar existindo (compatibilidade)');
    assert.equal(rows[0].is_generated, 'ALWAYS');
    assert.match(rows[0].generation_expression, /situacao/);
    assert.match(rows[0].generation_expression, /ATIVO/);
    assert.equal(rows[0].data_type, 'boolean');
    assert.equal(rows[0].is_nullable, 'NO');
    const gatilhosDeSincronizacao = await nomesDe(
      "SELECT tgname FROM pg_trigger WHERE tgrelid = 'funcionarios'::regclass AND NOT tgisinternal AND tgname <> 'trg_funcionarios_atualizado_em'",
    );
    assert.deepEqual(gatilhosDeSincronizacao, [], 'nada de gatilho: situacao é a única fonte da verdade');
  });

  test('`ativo` reflete `situacao`: ATIVO → true; AFASTADO → false; INATIVO → false; todas as transições são aceitas pelo banco', async () => {
    await aplicar084();
    const novo = await inserir();
    assert.equal(novo.ok, true);
    for (const [situacao, ativo] of [['AFASTADO', false], ['INATIVO', false], ['ATIVO', true], ['INATIVO', false], ['ATIVO', true], ['AFASTADO', false], ['ATIVO', true]]) {
      await c.query('UPDATE funcionarios SET situacao = $1 WHERE id = $2', [situacao, novo.linha.id]);
      const { rows } = await c.query('SELECT situacao, ativo FROM funcionarios WHERE id = $1', [novo.linha.id]);
      assert.deepEqual([rows[0].situacao, rows[0].ativo], [situacao, ativo]);
    }
  });

  test('`situacao` aceita só ATIVO, AFASTADO e INATIVO (chk_funcionarios_situacao)', async () => {
    await aplicar084();
    for (const valida of ['ATIVO', 'AFASTADO', 'INATIVO']) {
      const r = await inserir({ situacao: valida });
      assert.equal(r.ok, true, valida);
      assert.equal(r.linha.situacao, valida);
    }
    for (const invalida of ['ATIVA', 'ativo', 'Afastado', 'AFASTADA', 'DESLIGADO', '', ' ATIVO', 'ATIVO ', 'INATIVA']) {
      const r = await inserir({ situacao: invalida });
      assert.deepEqual([r.ok, r.code, r.constraint], [false, VIOLACAO_CHECK, 'chk_funcionarios_situacao'], JSON.stringify(invalida));
    }
  });

  test('`situacao` é NOT NULL: INSERT e UPDATE com NULL são recusados', async () => {
    await aplicar084();
    const r = await inserir({ situacao: null });
    assert.deepEqual([r.ok, r.code, r.coluna], [false, VIOLACAO_NOT_NULL, 'situacao']);
    const existente = await inserir();
    assert.equal(existente.ok, true);
    await assert.rejects(c.query('UPDATE funcionarios SET situacao = NULL WHERE id = $1', [existente.linha.id]), (erro) => erro.code === VIOLACAO_NOT_NULL);
  });

  test('o INSERT antigo (sem `situacao` nem `ativo`: cadastro individual e importação) continua válido e nasce ATIVO', async () => {
    await aplicar084();
    const r = await inserir();
    assert.equal(r.ok, true);
    assert.deepEqual([r.linha.situacao, r.linha.ativo], ['ATIVO', true]);
  });

  test('divergência é impossível: escrever `ativo` diretamente (INSERT ou UPDATE) é recusado pelo PostgreSQL', async () => {
    await aplicar084();
    for (const valor of [true, false]) {
      const r = await inserir({ ativo: valor });
      assert.deepEqual([r.ok, r.code], [false, ESCRITA_EM_COLUNA_GERADA], `INSERT ativo=${valor}`);
    }
    const existente = await inserir();
    assert.equal(existente.ok, true);
    for (const valor of [true, false]) {
      await assert.rejects(c.query('UPDATE funcionarios SET ativo = $1 WHERE id = $2', [valor, existente.linha.id]), (erro) => erro.code === ESCRITA_EM_COLUNA_GERADA, `UPDATE ativo=${valor}`);
    }
  });

  test('os registros existentes são preservados: mesmos ids e colunas, GHE, criado_em e atualizado_em (o backfill não "toca" o registro)', async () => {
    await aplicar084();
    const depois = (await c.query(`SELECT ${COLUNAS_SNAPSHOT} FROM funcionarios WHERE id = ANY($1::int[]) ORDER BY id`, [antes.linhas.map((l) => l.id)])).rows;
    const esperado = antes.linhas.map(({ ativo, ...resto }) => resto);
    assert.deepEqual(depois, esperado);
    assert.deepEqual(depois.map((l) => l.grupo_homogeneo_id), [gheA, gheA, null, null, gheB], 'GHE preservado; os legados sem GHE continuam sem GHE');
  });

  test('a estrutura é preservada: nenhuma restrição, FK que aponta para funcionarios ou índice some; entra só chk_funcionarios_situacao; o gatilho de atualizado_em segue habilitado', async () => {
    await aplicar084();
    const depois = await estrutura();
    assert.deepEqual([...depois.restricoes].sort(), [...antes.estrutura.restricoes, 'chk_funcionarios_situacao'].sort());
    assert.deepEqual(depois.apontamEmFuncionarios, antes.estrutura.apontamEmFuncionarios, 'FKs de usuarios, entregas, solicitações etc. continuam apontando');
    assert.deepEqual(antes.estrutura.indices.filter((i) => !depois.indices.includes(i)), [], 'nenhum índice removido');
    assert.deepEqual(depois.gatilhos, antes.estrutura.gatilhos, 'trg_funcionarios_atualizado_em existe e continua habilitado (O)');
    assert.ok(depois.gatilhos.includes('trg_funcionarios_atualizado_em:O'));
  });

  test('as regras de integridade existentes continuam valendo depois da 084 (GHE de outra empresa, CPF e matrícula únicos)', async () => {
    await aplicar084();
    const alvo = (await c.query('SELECT id FROM funcionarios WHERE empresa_id = $1 ORDER BY id LIMIT 1', [empresaA])).rows[0].id;
    await assert.rejects(c.query('UPDATE funcionarios SET grupo_homogeneo_id = $1 WHERE id = $2', [gheB, alvo]), (erro) => erro.code === VIOLACAO_FK && erro.constraint === 'fk_funcionarios_ghe_mesma_empresa');
    await assert.rejects(
      c.query("INSERT INTO funcionarios (empresa_id, matricula, nome, cpf) VALUES ($1, 'OUTRA', 'Duplicado', '52998224725')", [empresaA]),
      (erro) => erro.code === '23505' && erro.constraint === 'uq_funcionarios_empresa_cpf',
    );
  });

  test('ao final, `ativo` e `situacao` nunca divergem em nenhuma linha (filtros por ativo seguem equivalentes a ATIVO)', async () => {
    await aplicar084();
    const divergentes = (await c.query("SELECT count(*)::int AS n FROM funcionarios WHERE ativo IS DISTINCT FROM (situacao = 'ATIVO')")).rows[0].n;
    assert.equal(divergentes, 0);
    const porAtivo = (await c.query('SELECT count(*)::int AS n FROM funcionarios WHERE ativo')).rows[0].n;
    const porSituacao = (await c.query("SELECT count(*)::int AS n FROM funcionarios WHERE situacao = 'ATIVO'")).rows[0].n;
    assert.equal(porAtivo, porSituacao);
  });
});
