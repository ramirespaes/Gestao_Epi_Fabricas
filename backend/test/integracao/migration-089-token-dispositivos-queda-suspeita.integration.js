'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, conteudoDaMigration } = require('./helpers/schema-temporario');
const { aplicarMigrations } = require('../../scripts/migrate');
const { montarCenario } = require('./helpers/solicitacao-epi');

/**
 * Atendimento Token — Etapa J, J2a: migration 089 (token_dispositivos.queda_suspeita_desde). PostgreSQL real, schema temporário
 * exclusivo do banco de teste; o estado anterior (000 a 087) é montado explicitamente e a 089 só é aplicada aqui. A 088 está
 * suspensa e não existe: a ordem efetiva é 087 → 089.
 *
 * A 089 acrescenta UMA coluna TIMESTAMPTZ anulável, sem DEFAULT, índice, CHECK ou gatilho; nenhum dado muda (todas as linhas
 * ficam sem suspeita) e atualizado_em não é tocado. Este arquivo não abre conexão ao ser importado.
 */

const DIRETORIO_MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const MIGRATIONS_ATE_087 = fs.readdirSync(DIRETORIO_MIGRATIONS)
  .map((nome) => nome.match(/^(\d{3})_.*\.sql$/)?.[1])
  .filter((prefixo) => prefixo !== undefined && prefixo <= '087')
  .sort();
const COLUNA = 'queda_suspeita_desde';
const TABELAS_TOKEN = ['token_dispositivos', 'token_ativacoes', 'token_atendimentos', 'token_redes_autorizadas', 'token_dispositivo_eventos', 'solicitacoes_autoatendimento'];

describe('migration 089 — coluna de suspeita de queda (PostgreSQL real, schema temporário)', () => {
  let contexto;
  let c;
  let d;
  let antes;
  let aplicada = false;

  const q = (sql, parametros) => c.query(sql, parametros);
  const estruturaDe = async (tabela) => ({
    colunas: (await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
                        WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [tabela])).rows,
    restricoes: (await q('SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY 1', [tabela])).rows,
    gatilhos: (await q('SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY 1', [tabela])).rows,
    indices: (await q('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 ORDER BY 1', [tabela])).rows,
  });
  const estruturaToken = async () => Object.fromEntries(await Promise.all(TABELAS_TOKEN.map(async (t) => [t, await estruturaDe(t)])));
  const linhas = async () => (await q('SELECT * FROM token_dispositivos ORDER BY id')).rows;
  const aplicar089 = async () => {
    if (!aplicada) { await q(conteudoDaMigration('089')); aplicada = true; }
  };

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS_ATE_087);
    c = contexto.cliente;
    d = await montarCenario(c);
    await q('INSERT INTO token_dispositivos (empresa_id, nome, criado_por) VALUES ($1, $2, $3)', [d.empresaA, 'Tablet pendente', d.solicitante]);
    await q(
      `INSERT INTO token_dispositivos (empresa_id, nome, criado_por, ativado_em, ultimo_contato_em, comunicacao_registrada)
       VALUES ($1, $2, $3, now(), now() - interval '10 minutes', 'OFFLINE')`,
      [d.empresaA, 'Tablet silencioso', d.solicitante],
    );
    await q(
      `INSERT INTO token_dispositivos (empresa_id, nome, criado_por, ativado_em, revogado_em, revogado_por)
       VALUES ($1, $2, $3, now(), now(), $3)`,
      [d.empresaB, 'Tablet revogado', d.usuarioB],
    );
    antes = { estrutura: await estruturaToken(), linhas: await linhas() };
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('ponto de partida: 000 a 087 aplicadas, a coluna não existe e há tablets para provar a preservação', async () => {
    assert.equal(MIGRATIONS_ATE_087.at(-1), '087');
    assert.equal(antes.estrutura.token_dispositivos.colunas.some((x) => x.column_name === COLUNA), false);
    assert.equal(antes.linhas.length, 3);
  });

  test('a 089 acrescenta exatamente uma coluna TIMESTAMPTZ anulável, sem DEFAULT, no fim da tabela', async () => {
    await aplicar089();
    const depois = (await estruturaDe('token_dispositivos')).colunas;
    assert.deepEqual(depois.slice(0, -1), antes.estrutura.token_dispositivos.colunas);
    assert.deepEqual(depois.at(-1), { column_name: COLUNA, data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null });
  });

  test('nenhuma restrição, índice ou gatilho novo: a estrutura de token_dispositivos muda só na coluna e as outras tabelas do Token ficam idênticas', async () => {
    await aplicar089();
    const depois = await estruturaToken();
    for (const tabela of TABELAS_TOKEN) {
      assert.deepEqual(depois[tabela].restricoes, antes.estrutura[tabela].restricoes, `${tabela}: restrições`);
      assert.deepEqual(depois[tabela].indices, antes.estrutura[tabela].indices, `${tabela}: índices`);
      assert.deepEqual(depois[tabela].gatilhos, antes.estrutura[tabela].gatilhos, `${tabela}: gatilhos`);
      if (tabela !== 'token_dispositivos') assert.deepEqual(depois[tabela].colunas, antes.estrutura[tabela].colunas, `${tabela}: colunas`);
    }
  });

  test('os dados anteriores ficam como estavam, atualizado_em inclusive, e todas as linhas nascem sem suspeita', async () => {
    await aplicar089();
    const depois = await linhas();
    assert.equal(depois.length, antes.linhas.length);
    assert.deepEqual(depois.map((l) => l[COLUNA]), [null, null, null]);
    assert.deepEqual(depois.map(({ [COLUNA]: _removida, ...resto }) => resto), antes.linhas);
  });

  test('a coluna grava e limpa sem tocar em último contato, estado registrado nem eventos; aceita tablet revogado (sem CHECK)', async () => {
    await aplicar089();
    const eventosAntes = (await q('SELECT count(*)::int AS n FROM token_dispositivo_eventos')).rows[0].n;
    const base = await linhas();
    await q(`UPDATE token_dispositivos SET ${COLUNA} = now()`);
    const marcadas = await linhas();
    assert.equal(marcadas.every((l) => l[COLUNA] instanceof Date), true, 'inclusive o revogado e o pendente');
    assert.deepEqual(marcadas.map((l) => [l.ultimo_contato_em, l.comunicacao_registrada]), base.map((l) => [l.ultimo_contato_em, l.comunicacao_registrada]));
    await q(`UPDATE token_dispositivos SET ${COLUNA} = NULL`);
    assert.deepEqual((await linhas()).map((l) => l[COLUNA]), [null, null, null]);
    assert.equal((await q('SELECT count(*)::int AS n FROM token_dispositivo_eventos')).rows[0].n, eventosAntes);
  });
});

describe('migration 089 — ordem efetiva de aplicação pelo runner real', () => {
  let contexto;

  before(async () => { contexto = await abrirSchemaTemporario([]); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('o runner aplica a 089 depois da 087 (a 088 não existe) e registra 89 migrations em ordem', async () => {
    const aplicadas = await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_MIGRATIONS });
    const nomes = aplicadas.map((migration) => migration.name);
    assert.equal(nomes.length, 89);
    assert.equal(nomes.at(-1), '089_token_dispositivos_queda_suspeita');
    assert.match(nomes.at(-2), /^087_/);
    assert.equal(nomes.some((nome) => nome.startsWith('088_')), false);
    const registradas = (await contexto.cliente.query('SELECT name FROM pgmigrations ORDER BY id')).rows.map((linha) => linha.name);
    assert.deepEqual(registradas, nomes);
    const { rows } = await contexto.cliente.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'token_dispositivos' AND column_name = $1`, [COLUNA],
    );
    assert.deepEqual(rows, [{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
  });
});
