'use strict';

/**
 * S7039 (opção B) — o Totem não tem estilo inline: nenhum atributo style no index.html e na previa.html (corpos idênticos, K7-A4),
 * nenhum setAttribute('style') no totem.js, e as declarações que eram inline viraram regras do totem.css. A CSP da prévia fica com
 * style-src 'self', sem style-src-attr, sem 'unsafe-inline' e sem 'unsafe-hashes'.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const { avaliarCsp } = require('../../deploy/hml/verificacao/verificar-publicacao');

const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentariosHtml = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const semComentariosCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

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

// As declarações que eram inline (opção B, 28/11/2026), com a regra que as substitui.
const SUBSTITUICOES = [
  { seletor: '.acesso .ico.ico-erro', declaracoes: 'background:var(--error-soft);color:var(--error)' },
  { seletor: '.acesso .ico.ico-aviso', declaracoes: 'background:var(--warn-soft);color:var(--warn)' },
  { seletor: '.acesso .ico.ico-ok', declaracoes: 'background:var(--ok-soft);color:var(--ok)' },
  { seletor: '.acesso.acesso-espaco', declaracoes: 'margin-top:4vh' },
  { seletor: '#subtituloProdutos', declaracoes: 'font-size:14px;color:var(--on-var);margin-top:18px' },
  { seletor: '.resumo .resumo-ok', declaracoes: 'color:var(--ok)' },
];

describe('S7039 — Totem sem estilo inline', () => {
  for (const rel of ['totem/index.html', 'totem/previa.html']) {
    test(`${rel}: nenhum atributo style e nenhum bloco <style>`, () => {
      const html = semComentariosHtml(ler(rel));
      assert.deepEqual([...html.matchAll(/\sstyle\s*=/gi)].map((m) => m.index), []);
      assert.doesNotMatch(html, /<style\b/i);
    });
  }

  test('totem.js não grava estilo por atributo, cssText nem marcação', () => {
    const js = ler('totem/totem.js');
    assert.doesNotMatch(js, /setAttribute\(\s*['"]style['"]/);
    assert.doesNotMatch(js, /cssText/);
    assert.doesNotMatch(js, /style\s*=\s*\\?["']/);
  });

  test('os ícones e a tela final usam as classes novas nos dois HTMLs', () => {
    for (const rel of ['totem/index.html', 'totem/previa.html']) {
      const html = semComentariosHtml(ler(rel));
      assert.equal([...html.matchAll(/class="ico ico-erro"/g)].length, 2, `${rel}: ico-erro`);
      assert.equal([...html.matchAll(/class="ico ico-aviso"/g)].length, 1, `${rel}: ico-aviso`);
      assert.equal([...html.matchAll(/class="ico ico-ok"/g)].length, 1, `${rel}: ico-ok`);
      assert.equal([...html.matchAll(/class="acesso acesso-espaco"/g)].length, 1, `${rel}: acesso-espaco`);
    }
    assert.match(ler('totem/totem.js'), /ok\.classList\.add\('resumo-ok'\)/);
  });

  test('totem.css tem cada declaração que era inline, uma vez, no seletor que a substitui', () => {
    const css = semComentariosCss(ler('totem/totem.css'));
    for (const { seletor, declaracoes } of SUBSTITUICOES) {
      const regra = `${seletor}{${declaracoes}}`;
      assert.equal(css.split(regra).length - 1, 1, `regra ausente ou repetida: ${regra}`);
    }
  });
});

describe('S7039 — CSP da prévia do Totem', () => {
  test("style-src é só 'self'; nenhuma diretiva usa 'unsafe-inline' ou 'unsafe-hashes'; não há style-src-attr", () => {
    const csp = cspDaPrevia();
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-hashes|unsafe-eval|sha256-/);
    const d = diretivas(csp);
    assert.deepEqual(d.get('style-src'), ["'self'"]);
    assert.equal(d.has('style-src-attr'), false);
  });

  test('as demais diretivas não mudam', () => {
    const d = diretivas(cspDaPrevia());
    assert.deepEqual([...d.keys()], ['default-src', 'script-src', 'style-src', 'img-src', 'connect-src', 'base-uri', 'form-action', 'object-src']);
    for (const [nome, valor] of [['default-src', "'none'"], ['script-src', "'self'"], ['img-src', 'data:'], ['connect-src', "'none'"],
      ['base-uri', "'none'"], ['form-action', "'none'"], ['object-src', "'none'"]]) assert.deepEqual(d.get(nome), [valor], nome);
  });

  test('o verificador de publicação aceita a política (com frame-ancestors do cabeçalho da prévia)', () => {
    assert.deepEqual(avaliarCsp(`${cspDaPrevia()}; frame-ancestors 'self'`, { frameAncestorsAceitos: ["'self'"] }), []);
  });
});
