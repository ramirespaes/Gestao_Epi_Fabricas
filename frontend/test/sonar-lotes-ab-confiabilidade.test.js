'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Lotes A e B de confiabilidade (Sonar S7773 e S7727): trocas mecânicas, sem mudança de comportamento.
const RAIZ = path.join(__dirname, '..');
const ARQUIVOS_S7773 = [
  'js/atendimento-token.js', 'js/relatorios.js', 'js/imagens-envio.js', 'js/lgpd.js', 'js/dashboard.js',
  'js/dashboard-graficos.js', 'js/gestao-usuarios.js', 'js/imagens-material.js', 'js/permissoes-usuario.js',
  'js/suporte-notificacoes.js', 'js/entregas-solicitacao.js', 'js/historico-funcionarios.js', 'painel-privado/suporte.js',
];
const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const GLOBAL_NUMERICO = /(^|[^.\w$])(isNaN|isFinite|parseInt|parseFloat)\s*\(|(^|[^.\w$'"`])NaN\b/m;

describe('Lote A — S7773 no frontend', () => {
  for (const rel of ARQUIVOS_S7773) {
    test(`${rel} não usa isNaN, isFinite, parseInt ou NaN globais`, () => {
      const codigo = semComentarios(fs.readFileSync(path.join(RAIZ, rel), 'utf8'));
      assert.doesNotMatch(codigo, GLOBAL_NUMERICO);
    });
  }

  // Equivalência: nos pontos trocados o argumento já é número (typeof guardado, getTime() ou Date().getTime()).
  const ADVERSARIAIS = [0, -0, 1, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE, 2 ** 53];
  test('isFinite e Number.isFinite coincidem para todo número', () => {
    for (const v of ADVERSARIAIS) assert.equal(Number.isFinite(v), isFinite(v), String(v));
  });
  test('isNaN e Number.isNaN coincidem para todo número, inclusive getTime() inválido', () => {
    const datas = ['', 'x', '2026-11-27', '2026-13-40', 'NaN', null].map((s) => new Date(s).getTime());
    for (const v of [...ADVERSARIAIS, ...datas]) assert.equal(Number.isNaN(v), isNaN(v), String(v));
  });
  test('Number.NaN é o mesmo valor de NaN', () => {
    assert.ok(Object.is(Number.NaN, NaN));
  });
});

describe('Lote B — S7727 no painel privado', () => {
  for (const rel of ['painel-privado/login.js', 'painel-privado/seguranca.js']) {
    test(`${rel} não passa prepararCampoTotp direto ao forEach`, () => {
      assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, rel), 'utf8'), /\.forEach\(mfa\.prepararCampoTotp\)/);
    });
  }
  test('prepararCampoTotp recebe um parâmetro e não usa this', () => {
    const fonte = fs.readFileSync(path.join(RAIZ, 'painel-privado/mfa.js'), 'utf8');
    assert.match(fonte, /function prepararCampoTotp\(\s*\w+\s*\)/);
    const corpo = fonte.slice(fonte.indexOf('function prepararCampoTotp'));
    assert.doesNotMatch(corpo.slice(0, corpo.indexOf('\n}') + 2), /\bthis\b/);
  });
});
