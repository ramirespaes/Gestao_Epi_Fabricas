'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../src/utils/chave-json-sensivel');

/**
 * Migration 097 (PENDENCIA-SEG-TRG04, Rodada A R2): leitura de arquivos, sem banco e sem executar o SQL. Protege o que a 097 é: UM `CREATE OR REPLACE FUNCTION`
 * da função da 014, sem tocar tabelas, gatilhos, demais funções ou migrations históricas; o manifesto confere com os bytes; a 014 permanece byte a byte; e as
 * listas do SQL são IDÊNTICAS às do espelho JS (`src/utils/chave-json-sensivel.js`), para que a primeira barreira (aplicação) e a segunda (banco) nunca divirjam.
 * Também garante que a migration não carrega sinais que a guarda P2 (G5) classificaria como referência a coluna de conteúdo.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO = '097_alter_logs_auditoria_chave_sensivel_sem_separador.sql';
const ARQUIVO_014 = '014_alter_logs_auditoria_add_dados.sql';
const bytes = (nome) => fs.readFileSync(path.join(DIRETORIO, nome));
const sha256 = (conteudo) => crypto.createHash('sha256').update(conteudo).digest('hex');
const manifesto = () => JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8')).migrations;
const arquivosSql = () => fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
const semComentarios = (sql) => sql.replace(/--[^\n]*/g, '');
/** Lê `nome CONSTANT TEXT[] := ARRAY[ ... ];` do SQL e devolve a lista de literais. */
function listaDoSql(sql, nome) {
  const m = semComentarios(sql).match(new RegExp(`${nome}\\s+CONSTANT\\s+TEXT\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\];`));
  assert.ok(m, `lista ${nome} ausente no SQL`);
  return [...m[1].matchAll(/'([a-z0-9]+)'/g)].map((x) => x[1]);
}
function paresDoSql(sql) {
  const m = semComentarios(sql).match(/IN \(([\s\S]*?)\) THEN/);
  assert.ok(m, 'pares adjacentes ausentes');
  return [...m[1].matchAll(/\('([a-z]+)',\s*'([a-z]+)'\)/g)].map((x) => [x[1], x[2]]);
}

describe('migration 097 — estático', () => {
  const sql = () => bytes(ARQUIVO).toString('utf8');

  test('o arquivo existe com o nome aprovado, vem logo depois da 096 e é a última migration', () => {
    const arquivos = arquivosSql();
    assert.equal(arquivos.at(-1), ARQUIVO);
    assert.match(arquivos.at(-2), /^096_.+\.sql$/);
  });

  test('o manifesto tem exatamente uma entrada da 097, igual ao SHA-256 dos bytes; as chaves do manifesto são exatamente os arquivos do diretório', () => {
    const entradas = Object.keys(manifesto()).filter((n) => n.startsWith('097_'));
    assert.deepEqual(entradas, [ARQUIVO]);
    assert.equal(manifesto()[ARQUIVO], sha256(bytes(ARQUIVO)));
    assert.deepEqual(Object.keys(manifesto()).sort(), arquivosSql());
  });

  test('a 014 é histórica e continua byte a byte igual ao manifesto', () => {
    assert.equal(manifesto()[ARQUIVO_014], sha256(bytes(ARQUIVO_014)));
  });

  test('o SQL contém UM único comando, CREATE OR REPLACE FUNCTION logs_auditoria_chave_json_e_sensivel(chave TEXT) IMMUTABLE, e nada mais (sem tabela, gatilho, DROP, GRANT, schema ou outra função)', () => {
    const corpo = semComentarios(sql());
    assert.equal((corpo.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
    assert.match(corpo, /CREATE OR REPLACE FUNCTION logs_auditoria_chave_json_e_sensivel\(chave TEXT\)\s*RETURNS BOOLEAN/);
    assert.match(corpo, /\$\$ LANGUAGE plpgsql IMMUTABLE;\s*$/);
    for (const proibido of [/\bCREATE (?:TABLE|TRIGGER|INDEX|SCHEMA|ROLE|EXTENSION|DATABASE)\b/i, /\bALTER\b/i, /\bDROP\b/i, /\bGRANT\b|\bREVOKE\b/i, /search_path/i, /\bpublic\./i, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/i, /jsonb_possui_chave_sensivel|bloquear_dado_sensivel/]) {
      assert.doesNotMatch(corpo, proibido, String(proibido));
    }
  });

  test('a normalização e as regras da 014 são preservadas textualmente (regex de camelCase, quebra em [^a-z0-9]+, palavras inteiras e pares adjacentes)', () => {
    const corpo = semComentarios(sql());
    assert.match(corpo, /regexp_replace\(chave, '\(\[a-z0-9\]\)\(\[A-Z\]\)', '\\1_\\2', 'g'\)/);
    assert.match(corpo, /'\[\^a-z0-9\]\+'/);
    assert.deepEqual(listaDoSql(sql(), 'palavras_inteiras'), [...C.PALAVRAS_INTEIRAS]);
    assert.deepEqual(paresDoSql(sql()), C.PARES_ADJACENTES.map((p) => [...p]));
    assert.deepEqual(listaDoSql(bytes(ARQUIVO_014).toString('utf8').replace(/IF segmentos && ARRAY\[/, 'palavras_inteiras CONSTANT TEXT[] := ARRAY[').replace(/\] THEN/, '];'), 'palavras_inteiras'), [...C.PALAVRAS_INTEIRAS], 'as palavras inteiras da 097 são as mesmas da 014');
  });

  test('as listas novas (compostos, sufixos, prefixos) são idênticas às do espelho JS; "secret" não é prefixo; nenhuma lista tem repetição', () => {
    assert.deepEqual(listaDoSql(sql(), 'compostos'), [...C.COMPOSTOS]);
    assert.deepEqual(listaDoSql(sql(), 'sufixos'), [...C.SUFIXOS]);
    assert.deepEqual(listaDoSql(sql(), 'prefixos'), [...C.PREFIXOS]);
    assert.ok(!listaDoSql(sql(), 'prefixos').includes('secret'));
    for (const lista of [C.PALAVRAS_INTEIRAS, C.COMPOSTOS, C.SUFIXOS, C.PREFIXOS]) assert.equal(new Set(lista).size, lista.length);
  });

  test('a migration não carrega sinais de coluna de conteúdo nem de escrita pelo banco (guarda P2, G5): nenhuma entrada nova na linha de base é necessária', () => {
    const texto = sql();
    assert.doesNotMatch(texto, /(?:^|[^A-Za-z0-9_])(sha256|bytea|chave_armazenamento|caminho[a-z_]*|bucket|url[a-z_]*|arquivo[a-z_]*|anexo[a-z_]*|blob)(?![A-Za-z0-9_])/i);
    assert.doesNotMatch(texto, /\b(?:lo_import|lo_export|pg_file_write|COPY\s)/i);
  });
});
