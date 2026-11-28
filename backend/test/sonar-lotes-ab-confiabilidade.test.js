'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Lotes A e B de confiabilidade (Sonar S7773, S7727, S7737, S5850): as trocas não podem mudar comportamento.
const SRC = path.join(__dirname, '..', 'src');
const ler = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const GLOBAL_NUMERICO = /(^|[^.\w$])(isNaN|isFinite|parseInt|parseFloat)\s*\(|(^|[^.\w$'"`])NaN\b/;

describe('Lote A — S7773 no backend', () => {
  test('config/imagens.js não usa NaN global', () => {
    assert.doesNotMatch(semComentarios(ler('config/imagens.js')), GLOBAL_NUMERICO);
  });
});

describe('Lote B — S7727, S7737, S5850', () => {
  test('S7727: avisos-acessos não passa o predicado direto ao find', () => {
    assert.doesNotMatch(ler('rbac/avisos-acessos.js'), /\.find\(cond\)/);
  });

  test('S7727: os avisos que dependem dos ids derivados não mudam', () => {
    const { TOGGLES } = require('../src/rbac/toggles');
    const avisos = require('../src/rbac/avisos-acessos');
    const id = (cond) => TOGGLES.find((t) => cond(t)).id;
    const tokenLeitura = id((t) => t.regra.tipo === 'RECURSO' && t.regra.recurso === 'atendimentoToken' && t.regra.operacoes.join() === 'visualizar');
    const tokenPrevia = id((t) => t.regra.tipo === 'ACAO' && t.regra.codigo === 'TOKEN_PREVIA_CATALOGO_REAL');
    const leituraFuncionarios = id((t) => t.regra.tipo === 'RECURSO' && t.regra.recurso === 'employeeHistory'
      && t.regra.operacoes.length === 1 && t.regra.operacoes[0] === 'visualizar');
    const dependenteToken = TOGGLES.find((t) => (t.dependencias ?? []).some((d) => d.tipo === 'RECURSO' && d.recurso === 'atendimentoToken')).id;
    const codigos = avisos.avisosDosAcessos([
      { id: tokenLeitura, ligado: false }, { id: dependenteToken, ligado: true },
      { id: leituraFuncionarios, ligado: false }, { id: tokenPrevia, ligado: true },
    ]).map((a) => a.codigo);
    assert.ok(codigos.includes(avisos.TOKEN_SEM_CONSULTAR));
    assert.ok(codigos.includes(avisos.PREVIA_SEM_HISTORICO_FUNCIONARIOS));
    assert.deepEqual(avisos.avisosDosAcessos([{ id: tokenLeitura, ligado: true }, { id: tokenPrevia, ligado: true }]), []);
  });

  test('S7737: o padrão de inventário não é um literal no parâmetro', () => {
    assert.doesNotMatch(ler('services/imagem-processador-area.service.js'), /inventario\s*=\s*\{/);
  });

  test('S7737: o resultado padrão segue com sobras congeladas e vazias, sem compartilhar estado', () => {
    const os = require('node:os');
    const A = require('../src/services/imagem-processador-area.service');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sonar-ab-'));
    try {
      const area = A.criarAreaExclusiva({ base });
      const alheia = path.join(base, `${A.PREFIXO}alheia`);
      fs.mkdirSync(alheia);
      const r1 = A.removerAreaExclusiva({ ...area, caminho: alheia });
      const r2 = A.removerAreaExclusiva(area);
      assert.deepEqual(r1, { removida: false, motivo: 'TROCADA', sobras: [], truncado: false });
      assert.ok(Object.isFrozen(r1) && Object.isFrozen(r1.sobras));
      assert.notEqual(r1, r2);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('S5850: a regex de timeout deixa a precedência explícita', () => {
    assert.match(ler('workers/imagem-processador.worker.js'), /\/\(\?:\^timeout\\b\)\|\(\?:timeout:\)\/i/);
  });

  test('S5850: classificação idêntica à da regex original', () => {
    const { classificarFalhaDoSharp } = require('../src/workers/imagem-processador.worker');
    const original = /^timeout\b|timeout:/i;
    const amostras = ['timeout', 'Timeout expired', 'timeoutx', 'xtimeout', 'read timeout: 10s', 'TIMEOUT:', ' timeout',
      'pixel limit', 'Input buffer has corrupt header', '', 'timeouts', 'falha timeout:abc', 'timeout\nx'];
    const { CODIGOS } = require('../src/utils/imagem-container');
    for (const m of amostras) {
      const tempo = classificarFalhaDoSharp(new Error(m)).codigo === CODIGOS.TEMPO;
      assert.equal(tempo, original.test(m), JSON.stringify(m));
    }
  });
});
