'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Migration 089 (Atendimento Token, Etapa J, J2a): leitura de arquivos, sem banco e sem executar o SQL. Protege o que a 089
 * é: UMA coluna anulável em token_dispositivos, sem DEFAULT, índice, CHECK, gatilho nem dado; a 088 continua suspensa
 * (sem arquivo e sem entrada) e o manifesto confere com os bytes do arquivo.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO = '089_token_dispositivos_queda_suspeita.sql';
const bytes = (nome) => fs.readFileSync(path.join(DIRETORIO, nome));
const sha256 = (conteudo) => crypto.createHash('sha256').update(conteudo).digest('hex');
const manifesto = () => JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8')).migrations;
const arquivosSql = () => fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
const semComentarios = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

describe('migration 089 — estático', () => {
  test('o arquivo existe com o nome aprovado e vem logo depois da 087', () => {
    assert.equal(fs.existsSync(path.join(DIRETORIO, ARQUIVO)), true);
    const arquivos = arquivosSql();
    assert.equal(arquivos.at(-1), ARQUIVO);
    assert.match(arquivos.at(-2), /^087_.+\.sql$/);
  });

  test('o manifesto tem exatamente uma entrada da 089, igual ao SHA-256 dos bytes do arquivo', () => {
    const entradas = Object.keys(manifesto()).filter((n) => n.startsWith('089_'));
    assert.deepEqual(entradas, [ARQUIVO]);
    assert.equal(manifesto()[ARQUIVO], sha256(bytes(ARQUIVO)));
    assert.deepEqual(Object.keys(manifesto()).sort(), arquivosSql());
  });

  test('a 088 continua suspensa: sem arquivo e sem entrada no manifesto', () => {
    assert.deepEqual(arquivosSql().filter((n) => n.startsWith('088_')), []);
    assert.deepEqual(Object.keys(manifesto()).filter((n) => n.startsWith('088_')), []);
  });

  test('o SQL é um único ALTER TABLE que adiciona queda_suspeita_desde TIMESTAMPTZ anulável a token_dispositivos', () => {
    assert.equal(
      semComentarios(bytes(ARQUIVO).toString('utf8')),
      'ALTER TABLE token_dispositivos ADD COLUMN queda_suspeita_desde TIMESTAMPTZ;',
    );
  });

  test('sem DEFAULT, NOT NULL, índice, CHECK, restrição, gatilho, dado nem DDL de outro objeto', () => {
    const sql = semComentarios(bytes(ARQUIVO).toString('utf8')).toUpperCase();
    for (const proibido of ['DEFAULT', 'NOT NULL', 'INDEX', 'CHECK', 'CONSTRAINT', 'TRIGGER', 'UPDATE', 'INSERT', 'DELETE', 'DROP', 'CREATE', 'REFERENCES', 'GENERATED']) {
      assert.equal(sql.includes(proibido), false, `a 089 não pode conter ${proibido}`);
    }
    assert.equal((sql.match(/;/g) ?? []).length, 1, 'um único comando');
  });
});
