'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Sonar S2871, lote 04 (código operacional fora do backup): cada arquivo troca o sort() padrão por compararComoTexto, que aplica String() e
 * compara unidades de código UTF-16 — a mesma regra do sort() padrão para qualquer tipo de elemento. O teste lê o comparador do próprio arquivo
 * e o confronta com o sort() padrão em entradas adversariais; o comportamento das funções fica coberto pela regressão existente.
 */

const RAIZ = path.join(__dirname, '..', '..', '..');
const ARQUIVOS_DO_LOTE = [
  '.github/scripts/hml/gerar-release.js',
  'backend/scripts/imagens-completar-exibicao.js',
  'backend/src/services/material.service.js',
  'backend/src/services/usuario-administracao.service.js',
  'backend/src/storage/armazenamento-imagens.js',
  'backend/src/utils/imagem-parametros.js',
  'backend/src/utils/imagem-quadro.js',
  // Fora do lote: deploy/hml/cd/{agente,protocolo}.js, instalador/{compatibilidade,nucleo}.js e empacotar-backend.js têm SHA-256 fixado
  // em .github/scripts/hml/test (frontend-inalterado, workflow-unificado, protocolo-ordenacao). Também fora: frontend/js/materiais.js, fixado
// com o hash da main nas referências visuais (01-repositorio/gestao-epi/frontend/previews/*/protected-hashes.json).
  'deploy/hml/csp/gerar-csp.js',
  'deploy/hml/verificacao/verificar-publicacao.js',
  'frontend/js/atendimento-token-tela.js',
  'frontend/js/gestao-funcionarios.js',
  'frontend/publicacao/empacotar-painel.js',
  'frontend/publicacao/empacotar.js',
];
// Chamadas .localeCompare( já existentes na main f5ac3db, fora de qualquer sort() alterado pelo lote.
const LOCALE_COMPARE_NA_BASE = { 'frontend/js/gestao-funcionarios.js': 1 };

const DEFINICAO = /(?:const compararComoTexto = (\(a, b\) => \{[^\n]*\});|function compararComoTexto\(a, b\) (\{[^\n]*\}))/;

function comparadorDo(texto) {
  const m = DEFINICAO.exec(texto);
  assert.ok(m, 'compararComoTexto ausente ou fora do formato de uma linha');
  // eslint-disable-next-line no-new-func
  return m[1] ? new Function(`return ${m[1]};`)() : new Function('a', 'b', m[2].slice(1, -1));
}

function gerador(semente) {
  let s = semente >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const OBJ = { toString: () => 'obj' };
const ATOMOS = [
  'a', 'A', 'á', 'á', 'Á', 'b', 'B', '_a', 'a_', 'a0', 'a1', 'a10', 'a2', '', ' ', 'z', 'Z', 'ç', 'ç', '😀', '￿', '\u0000',
  'migrations/001.sql', 'migrations/010.sql', 'migrations/1.sql', 'painel', 'portal', '10', '9', '-1', '1e3',
  0, 1, 9, 10, -1, 100, 1.5, NaN, true, false, null, undefined, OBJ, [1, 2], [10],
];

describe('[ORD-L04] S2871 — comparador explícito no lote 04', () => {
  for (const relativo of ARQUIVOS_DO_LOTE) {
    const texto = fs.readFileSync(path.join(RAIZ, relativo), 'utf8');

    test(`ORD-L04-00 — ${relativo}: nenhum sort() sem comparador e nenhum localeCompare novo`, () => {
      const semComparador = texto.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\.sort\(\s*\)/.test(l)).map(([n]) => n);
      assert.deepEqual(semComparador, [], `sort() sem comparador nas linhas ${semComparador.join(', ')}`);
      assert.equal((texto.match(/\.localeCompare\(/g) || []).length, LOCALE_COMPARE_NA_BASE[relativo] || 0);
    });

    test(`ORD-L04-01 — ${relativo}: compararComoTexto reproduz o sort() padrão para qualquer tipo`, () => {
      const comparar = comparadorDo(texto);
      const aleatorio = gerador(20261127);
      for (let caso = 0; caso < 2000; caso++) {
        const tamanho = Math.floor(aleatorio() * 12);
        const lista = Array.from({ length: tamanho }, () => ATOMOS[Math.floor(aleatorio() * ATOMOS.length)]);
        assert.deepEqual([...lista].sort(comparar), [...lista].sort(), `divergência em ${String(lista)}`);
      }
    });
  }
});
