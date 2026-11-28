'use strict';

/**
 * S7039 — CSP da prévia do Totem sem 'unsafe-inline'. Os atributos style do corpo (idêntico ao index.html, K7-A4) e o único
 * setAttribute('style') do totem.js (fixado, K7-A5) entram por hash em style-src-attr com 'unsafe-hashes'; style-src fica 'self'.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const { avaliarCsp } = require('../../deploy/hml/verificacao/verificar-publicacao');

const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentariosHtml = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const hash = (valor) => `'sha256-${crypto.createHash('sha256').update(valor, 'utf8').digest('base64')}'`;

function cspDaPrevia() {
  const html = semComentariosHtml(ler('totem/previa.html'));
  const meta = /<meta\b[^>]*http-equiv\s*=\s*"Content-Security-Policy"[^>]*>/i.exec(html);
  assert.ok(meta, 'meta CSP ausente');
  return /content\s*=\s*"([^"]*)"/i.exec(meta[0])[1];
}

function diretivas(csp) {
  return new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [nome, ...valores] = d.split(/\s+/);
    return [nome, valores];
  }));
}

// Valores legítimos: os atributos style do HTML e as chamadas setAttribute('style', '...') do totem.js.
function estilosLegitimos() {
  const html = semComentariosHtml(ler('totem/previa.html'));
  const doHtml = [...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]);
  const doJs = [...ler('totem/totem.js').matchAll(/setAttribute\(\s*'style'\s*,\s*'([^']*)'\s*\)/g)].map((m) => m[1]);
  return { doHtml, doJs, todos: new Set([...doHtml, ...doJs]) };
}

describe('S7039 — CSP da prévia do Totem', () => {
  test('nenhuma diretiva usa unsafe-inline, e style-src é só self', () => {
    const csp = cspDaPrevia();
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.deepEqual(diretivas(csp).get('style-src'), ["'self'"]);
  });

  test('style-src-attr libera exatamente os estilos legítimos, por hash, e nada além', () => {
    const { doHtml, doJs, todos } = estilosLegitimos();
    assert.equal(doHtml.length, 6, 'seis atributos style no corpo');
    assert.deepEqual(doJs, ['color:var(--ok)'], 'um setAttribute(style) no totem.js');
    assert.equal(todos.size, 6, 'seis valores distintos');
    const attr = diretivas(cspDaPrevia()).get('style-src-attr');
    assert.ok(attr, 'style-src-attr ausente');
    assert.equal(attr[0], "'unsafe-hashes'");
    assert.deepEqual(new Set(attr.slice(1)), new Set([...todos].map(hash)));
    assert.equal(attr.length, 7, 'sem hash repetido ou sobrando');
  });

  test('os seis hashes aprovados no diagnóstico', () => {
    const attr = diretivas(cspDaPrevia()).get('style-src-attr') ?? [];
    assert.deepEqual(new Set(attr.slice(1)), new Set([
      "'sha256-WL7MlD/wMXx8MRDRvHfde4djiRTttvJ1ZyRo8zqJk9s='",
      "'sha256-ZByJOzfW2xGYPJW5i7tw972NNGyD7bTKtW3x7ossrHQ='",
      "'sha256-iTrtcWgGiLeUtPwj8yvZuGS8ThSKzhHGh0GAawlivvY='",
      "'sha256-jvCQSPZHTbxE8YTQQ8HXOMfbQlNpDSIM+GPfatmqKCY='",
      "'sha256-itQGpmtJZ0+msnGqhFwenEgYMKqYST0TDaHA659DCnc='",
      "'sha256-sPNDXPb9g4m+wSc75WDX/7Rnk7apMe20uV1aEHstIAE='",
    ]));
  });

  test('as demais diretivas não mudam', () => {
    const d = diretivas(cspDaPrevia());
    assert.deepEqual([...d.keys()], ['default-src', 'script-src', 'style-src', 'style-src-attr', 'img-src', 'connect-src', 'base-uri', 'form-action', 'object-src']);
    for (const [nome, valor] of [['default-src', "'none'"], ['script-src', "'self'"], ['img-src', 'data:'], ['connect-src', "'none'"],
      ['base-uri', "'none'"], ['form-action', "'none'"], ['object-src', "'none'"]]) assert.deepEqual(d.get(nome), [valor], nome);
  });

  test('o verificador de publicação aceita a política (com frame-ancestors do cabeçalho da prévia)', () => {
    assert.deepEqual(avaliarCsp(`${cspDaPrevia()}; frame-ancestors 'self'`, { frameAncestorsAceitos: ["'self'"] }), []);
  });
});
