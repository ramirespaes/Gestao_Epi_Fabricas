'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const I = require('../../src/repositories/backup-fontes-postgres-inventario.repository');

/** D-ORF-6, P4a — INVENTÁRIO somente leitura com executor SIMULADO: nenhuma conexão real; o que se prova é a porta de SQL, a validação das linhas e a forma da saída. */

const LINHAS = {
  RELACOES: [
    { esquema: 'public', nome: 'empresas', relkind: 'r', sustenta_restricao: false, sequencia_implicita: false },
    { esquema: 'public', nome: 'empresas_id_seq', relkind: 'S', sustenta_restricao: false, sequencia_implicita: true },
    { esquema: 'public', nome: 'empresas_pkey', relkind: 'i', sustenta_restricao: true, sequencia_implicita: false },
    { esquema: 'public', nome: 'idx_empresas_cnpj', relkind: 'i', sustenta_restricao: false, sequencia_implicita: false },
  ],
  OUTROS: I.CATEGORIAS_DE_OUTROS.map((categoria, i) => ({ categoria, quantidade: String(i) })),
  EXTENSOES: [{ nome: 'plpgsql', versao: '1.0' }],
  SERVIDOR: [{ versao: '16.4 (Ubuntu 16.4-1)', encoding: 'UTF8', collate: 'en_US.UTF-8', ctype: 'en_US.UTF-8' }],
  MIGRATIONS: [{ name: '000_create_function_set_atualizado_em' }, { name: '001_create_empresas' }],
};

function executorFalso(sobrescritas = {}) {
  const consultas = [];
  return {
    consultas,
    query: async (sql) => {
      consultas.push(sql);
      const base = { ...LINHAS, ...sobrescritas };
      if (sql === I.SQL.RELACOES) return { rows: base.RELACOES };
      if (sql === I.SQL.OUTROS) return { rows: base.OUTROS };
      if (sql === I.SQL.EXTENSOES) return { rows: base.EXTENSOES };
      if (sql === I.SQL.SERVIDOR) return { rows: base.SERVIDOR };
      if (sql === I.SQL.migrations('public')) return { rows: base.MIGRATIONS };
      throw new Error('SQL inesperado');
    },
  };
}
const invalido = (e) => e instanceof Error && e.code === 'INVENTARIO_INVALIDO' && !/public|empresas|secreto/.test(e.message);

describe('[IN] inventário do banco (executor simulado)', () => {
  test('IN-01 — cinco consultas SELECT, nessa ordem, no executor recebido; saída congelada e normalizada', async () => {
    const ex = executorFalso();
    const inv = await I.inventariar(ex);
    assert.equal(ex.consultas.length, 5);
    assert.ok(ex.consultas.every((sql) => /^\s*SELECT\b/i.test(sql) && !sql.includes(';')), 'só SELECT, sem ; interno');
    assert.deepEqual(ex.consultas, [I.SQL.RELACOES, I.SQL.OUTROS, I.SQL.EXTENSOES, I.SQL.SERVIDOR, I.SQL.migrations('public')]);
    assert.deepEqual(inv.relacoes[1], { esquema: 'public', nome: 'empresas_id_seq', relkind: 'S', sustentaRestricao: false, sequenciaImplicita: true });
    assert.deepEqual(inv.outros, Object.fromEntries(I.CATEGORIAS_DE_OUTROS.map((c, i) => [c, i])));
    assert.deepEqual(inv.extensoes, [{ nome: 'plpgsql', versao: '1.0' }]);
    assert.deepEqual(inv.servidor, { versao: '16.4', encoding: 'UTF8', collate: 'en_US.UTF-8', ctype: 'en_US.UTF-8' });
    assert.deepEqual(inv.migrations, ['000_create_function_set_atualizado_em', '001_create_empresas']);
    assert.ok([inv, inv.relacoes, inv.relacoes[0], inv.outros, inv.extensoes, inv.servidor, inv.migrations].every(Object.isFrozen));
  });

  test('IN-02 — o SQL exclui esquemas de sistema, usa o esquema das migrations validado e nunca contém escrita', async (t) => {
    for (const sql of [I.SQL.RELACOES, I.SQL.OUTROS, I.SQL.EXTENSOES, I.SQL.SERVIDOR, I.SQL.migrations('public')]) {
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COPY|TRUNCATE|GRANT|lo_import|lo_export|pg_file_write)\b/i);
    }
    assert.match(I.SQL.RELACOES, /pg_catalog.*information_schema.*pg\\_toast.*pg\\_temp/s);
    assert.equal(I.SQL.migrations('outro'), 'SELECT name FROM "outro"."pgmigrations" ORDER BY run_on, id');
    const ENTRADAS_INVALIDAS = [
      ['esquema das migrations com injeção', () => I.inventariar(executorFalso(), { esquemaDasMigrations: 'x"; DROP' })],
      ['opção desconhecida', () => I.inventariar(executorFalso(), { outra: 1 })],
      ['executor sem query', () => I.inventariar({})],
      ['executor nulo', () => I.inventariar(null)],
    ];
    for (const [rotulo, chamar] of ENTRADAS_INVALIDAS) {
      await t.test(rotulo, async () => { await assert.rejects(chamar(), TypeError); });
    }
  });

  test('IN-03 — falha fechada: linha com chave a mais, relkind desconhecido, booleano em texto, relação duplicada, categoria faltante, versão ilegível ou migration fora do padrão', async () => {
    const casos = [
      { RELACOES: [{ ...LINHAS.RELACOES[0], extra: 1 }] },
      { RELACOES: [{ ...LINHAS.RELACOES[0], relkind: 'z' }] },
      { RELACOES: [{ ...LINHAS.RELACOES[0], sustenta_restricao: 'false' }] },
      { RELACOES: [LINHAS.RELACOES[0], LINHAS.RELACOES[0]] },
      { RELACOES: [{ ...LINHAS.RELACOES[0], nome: 'Nome Com Espaco' }] },
      { OUTROS: LINHAS.OUTROS.slice(1) },
      { OUTROS: [...LINHAS.OUTROS.slice(1), { categoria: 'FUNCTION', quantidade: '-1' }] },
      { OUTROS: [...LINHAS.OUTROS.slice(1), { categoria: 'FUNCTION', quantidade: 3 }] },
      { EXTENSOES: [{ nome: 'ok', versao: 7 }] },
      { SERVIDOR: [{ ...LINHAS.SERVIDOR[0], versao: 'desconhecida' }] },
      { SERVIDOR: [] },
      { SERVIDOR: [LINHAS.SERVIDOR[0], LINHAS.SERVIDOR[0]] },
      { MIGRATIONS: [{ name: '1_sem_tres_digitos' }] },
      { MIGRATIONS: [{ name: '001_a' }, { name: '001_a' }] },
      { MIGRATIONS: [{ nome: '001_a' }] },
    ];
    for (const [i, caso] of casos.entries()) {
      await assert.rejects(I.inventariar(executorFalso(caso)), invalido, `caso ${i}`);
    }
    await assert.rejects(I.inventariar({ query: async () => ({ linhas: [] }) }), invalido, 'resposta sem rows');
    await assert.rejects(I.inventariar({ query: async () => null }), invalido);
  });

  test('IN-04 — tetos de linhas: relações, migrations e extensões acima do limite reprovam em vez de crescer', async () => {
    const relacoes = Array.from({ length: I.LIMITES.relacoes + 1 }, (_, i) => ({ ...LINHAS.RELACOES[0], nome: `t_${i}` }));
    await assert.rejects(I.inventariar(executorFalso({ RELACOES: relacoes })), invalido);
    const migrations = Array.from({ length: I.LIMITES.migrations + 1 }, (_, i) => ({ name: `${String(i % 1000).padStart(3, '0')}_m_${i}` }));
    await assert.rejects(I.inventariar(executorFalso({ MIGRATIONS: migrations })), invalido);
    const extensoes = Array.from({ length: I.LIMITES.extensoes + 1 }, (_, i) => ({ nome: `e_${i}`, versao: '1' }));
    await assert.rejects(I.inventariar(executorFalso({ EXTENSOES: extensoes })), invalido);
    assert.equal((await I.inventariar(executorFalso({ RELACOES: [], EXTENSOES: [], MIGRATIONS: [] }))).relacoes.length, 0, 'vazio é válido (quem decide é a cobertura)');
  });
});
