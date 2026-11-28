'use strict';
// S6505: o CI instala as dependências sem scripts de ciclo de vida, como o instalador de homologação
// (deploy/hml/instalador/nucleo.js). argon2 e sharp carregam binários pré-compilados sem esses scripts.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const yaml = fs.readFileSync(path.resolve(__dirname, '../../../../.github/workflows/ci.yml'), 'utf8');
const semComentarios = yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const instalacoes = [...semComentarios.matchAll(/^\s*run:\s*(npm (?:ci|install|i)\b.*)$/gm)].map((m) => m[1].trim());

describe('ci.yml: instalação de dependências sem scripts de ciclo de vida (S6505)', () => {
  test('os dois jobs instalam com npm ci --ignore-scripts', () => {
    assert.deepEqual(instalacoes, ['npm ci --ignore-scripts', 'npm ci --ignore-scripts']);
  });
  test('nenhum npm install nem npm rebuild', () => {
    assert.doesNotMatch(semComentarios, /\bnpm (install|i|rebuild)\b/);
  });
  test('as permissões globais do CI continuam só contents: read', () => {
    assert.match(yaml, /^permissions:\n {2}contents: read\n(?! )/m);
  });
});
