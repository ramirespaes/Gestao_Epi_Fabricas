'use strict';

/**
 * D-ORF-6, P4a (R2 seção 6.2): INVENTÁRIO somente leitura do banco da aplicação, pensado para rodar DENTRO da transação `REPEATABLE READ READ ONLY`
 * do snapshot do backup (o mesmo snapshot do `pg_dump`). Executor por parâmetro (nunca o pool global). Cada SQL passa por uma porta que só admite
 * um `SELECT` sem `;` interno; nada aqui escreve, cria transação ou encerra conexão.
 *
 * O inventário cobre os esquemas não-sistema (`pg_catalog`, `information_schema`, `pg_toast*` e `pg_temp*` excluídos): relações por `relkind`, com
 * a marca de índice que sustenta restrição (PK/UNIQUE/EXCLUDE: aparece no sumário como `CONSTRAINT`, não `INDEX`) e de sequência implícita
 * (IDENTITY/serial); contagens separadas de outros objetos; extensões; versão, encoding e collation do servidor; e a lista de migrations aplicadas.
 *
 * Toda linha devolvida pelo banco é validada; forma inesperada é `INVENTARIO_INVALIDO` (falha fechada, sem valores na mensagem). As consultas e os
 * significados de `pg_depend.deptype` são conhecimento geral do PostgreSQL 16 e permanecem [NV] até a observação real do P4b.
 */

const ESQUEMAS_EXCLUIDOS = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'";

const SQL = Object.freeze({
  RELACOES: `SELECT n.nspname AS esquema, c.relname AS nome, c.relkind::text AS relkind,
    EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = c.oid AND k.contype IN ('p', 'u', 'x')) AS sustenta_restricao,
    (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
      AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i'))) AS sequencia_implicita
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${ESQUEMAS_EXCLUIDOS} ORDER BY n.nspname, c.relname`,
  OUTROS: `SELECT 'FUNCTION' AS categoria, count(*)::text AS quantidade FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${ESQUEMAS_EXCLUIDOS}
    UNION ALL SELECT 'TRIGGER', count(*)::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND ${ESQUEMAS_EXCLUIDOS}
    UNION ALL SELECT 'TYPE', count(*)::text FROM pg_type y JOIN pg_namespace n ON n.oid = y.typnamespace WHERE y.typtype IN ('e', 'd', 'r', 'm') AND ${ESQUEMAS_EXCLUIDOS}
    UNION ALL SELECT 'EXTENSION', count(*)::text FROM pg_extension WHERE extname <> 'plpgsql'
    UNION ALL SELECT 'RULE', count(*)::text FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace WHERE r.rulename <> '_RETURN' AND ${ESQUEMAS_EXCLUIDOS}
    UNION ALL SELECT 'POLICY', count(*)::text FROM pg_policy
    UNION ALL SELECT 'PUBLICATION', count(*)::text FROM pg_publication
    UNION ALL SELECT 'EVENT TRIGGER', count(*)::text FROM pg_event_trigger
    UNION ALL SELECT 'SCHEMA', count(*)::text FROM pg_namespace n WHERE ${ESQUEMAS_EXCLUIDOS} AND n.nspname <> 'public'`,
  EXTENSOES: 'SELECT extname AS nome, extversion AS versao FROM pg_extension ORDER BY extname',
  SERVIDOR: `SELECT current_setting('server_version') AS versao, pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collate, d.datctype AS ctype
    FROM pg_database d WHERE d.datname = current_database()`,
  migrations: (esquema) => `SELECT name FROM "${esquema}"."pgmigrations" ORDER BY run_on, id`,
});

const CATEGORIAS_DE_OUTROS = Object.freeze(['FUNCTION', 'TRIGGER', 'TYPE', 'EXTENSION', 'RULE', 'POLICY', 'PUBLICATION', 'EVENT TRIGGER', 'SCHEMA']);
const RELKINDS = Object.freeze(['r', 'p', 'i', 'I', 'S', 'v', 'm', 'f', 'c', 't']);
const SQL_PERMITIDO = /^\s*SELECT\b[^;]*$/i;
const IDENTIFICADOR = /^[a-z_][a-z0-9_]{0,62}$/;
const NOME_DE_MIGRATION = /^[0-9]{3}_[a-z0-9_]+$/;
const VERSAO = /^\d{1,3}(?:\.\d{1,3}){0,2}/;
const TEXTO_CURTO = /^[\x20-\x7e]{1,128}$/;
const CONTAGEM = /^(?:0|[1-9][0-9]{0,9})$/;
const LIMITES = Object.freeze({ relacoes: 5000, migrations: 2000, extensoes: 200 });

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function invalido() {
  const e = new Error('inventário inválido');
  e.code = 'INVENTARIO_INVALIDO';
  return e;
}

async function consultar(executor, sql) {
  if (!SQL_PERMITIDO.test(sql)) throw invalido();
  const resposta = await executor.query(sql);
  if (!ehObjeto(resposta) || !Array.isArray(resposta.rows)) throw invalido();
  return resposta.rows;
}

const chavesExatas = (o, esperadas) => ehObjeto(o) && Object.keys(o).length === esperadas.length && esperadas.every((c) => Object.hasOwn(o, c));

function lerRelacoes(rows) {
  if (rows.length > LIMITES.relacoes) throw invalido();
  const vistos = new Set();
  return rows.map((r) => {
    if (!chavesExatas(r, ['esquema', 'nome', 'relkind', 'sustenta_restricao', 'sequencia_implicita'])) throw invalido();
    if (!IDENTIFICADOR.test(r.esquema) || !IDENTIFICADOR.test(r.nome) || !RELKINDS.includes(r.relkind)) throw invalido();
    if (typeof r.sustenta_restricao !== 'boolean' || typeof r.sequencia_implicita !== 'boolean') throw invalido();
    const chave = `${r.esquema}.${r.nome}`;
    if (vistos.has(chave)) throw invalido();
    vistos.add(chave);
    return Object.freeze({ esquema: r.esquema, nome: r.nome, relkind: r.relkind, sustentaRestricao: r.sustenta_restricao, sequenciaImplicita: r.sequencia_implicita });
  });
}

function lerOutros(rows) {
  if (rows.length !== CATEGORIAS_DE_OUTROS.length) throw invalido();
  const saida = {};
  for (const r of rows) {
    if (!chavesExatas(r, ['categoria', 'quantidade']) || !CATEGORIAS_DE_OUTROS.includes(r.categoria) || Object.hasOwn(saida, r.categoria)) throw invalido();
    if (typeof r.quantidade !== 'string' || !CONTAGEM.test(r.quantidade)) throw invalido();
    saida[r.categoria] = Number(r.quantidade);
  }
  return Object.freeze(saida);
}

function lerExtensoes(rows) {
  if (rows.length > LIMITES.extensoes) throw invalido();
  return rows.map((r) => {
    if (!chavesExatas(r, ['nome', 'versao']) || !IDENTIFICADOR.test(r.nome) || typeof r.versao !== 'string' || !TEXTO_CURTO.test(r.versao)) throw invalido();
    return Object.freeze({ nome: r.nome, versao: r.versao });
  });
}

function lerServidor(rows) {
  if (rows.length !== 1 || !chavesExatas(rows[0], ['versao', 'encoding', 'collate', 'ctype'])) throw invalido();
  const r = rows[0];
  for (const c of ['versao', 'encoding', 'collate', 'ctype']) if (typeof r[c] !== 'string' || !TEXTO_CURTO.test(r[c])) throw invalido();
  const versao = VERSAO.exec(r.versao);
  if (versao === null) throw invalido();
  return Object.freeze({ versao: versao[0], encoding: r.encoding, collate: r.collate, ctype: r.ctype });
}

function lerMigrations(rows) {
  if (rows.length > LIMITES.migrations) throw invalido();
  const vistos = new Set();
  return rows.map((r) => {
    if (!chavesExatas(r, ['name']) || typeof r.name !== 'string' || !NOME_DE_MIGRATION.test(r.name) || vistos.has(r.name)) throw invalido();
    vistos.add(r.name);
    return r.name;
  });
}

/**
 * Lê o inventário no executor recebido (cliente já dentro da transação do snapshot). `opcoes.esquemaDasMigrations` (padrão `public`).
 * Devolve objeto congelado `{ relacoes, outros, extensoes, servidor, migrations }` ou lança `INVENTARIO_INVALIDO`.
 */
async function inventariar(executor, opcoes) {
  if (!ehObjeto(executor) || typeof executor.query !== 'function') throw new TypeError('executor inválido');
  if (opcoes !== undefined && (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((c) => c === 'esquemaDasMigrations'))) throw new TypeError('opções do inventário inválidas');
  const esquema = opcoes?.esquemaDasMigrations ?? 'public';
  if (!IDENTIFICADOR.test(esquema)) throw new TypeError('opções do inventário inválidas');
  const relacoes = lerRelacoes(await consultar(executor, SQL.RELACOES));
  const outros = lerOutros(await consultar(executor, SQL.OUTROS));
  const extensoes = lerExtensoes(await consultar(executor, SQL.EXTENSOES));
  const servidor = lerServidor(await consultar(executor, SQL.SERVIDOR));
  const migrations = lerMigrations(await consultar(executor, SQL.migrations(esquema)));
  return Object.freeze({ relacoes: Object.freeze(relacoes), outros, extensoes: Object.freeze(extensoes), servidor, migrations: Object.freeze(migrations) });
}

module.exports = { inventariar, SQL, CATEGORIAS_DE_OUTROS, RELKINDS, LIMITES };
