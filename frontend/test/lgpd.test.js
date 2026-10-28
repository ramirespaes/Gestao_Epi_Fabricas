'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * EpiLgpd (js/lgpd.js) sem navegador: caminho da única rota, validação estrita do resumo (nada fora do contrato vira número na
 * tela), formatação do CNPJ e os textos que a página usa.
 */

const RAIZ = path.join(__dirname, '..');

function carregar(respostas = []) {
  const chamadas = [];
  const fila = respostas.slice();
  const sandbox = {
    EpiHttp: {
      requisitar: async (metodo, caminho) => { chamadas.push([metodo, caminho]); return fila.shift() || { ok: true, status: 200, dados: null }; },
      ehNaoAutenticado: (r) => r.ok === false && r.status === 401,
      ehSemAutorizacao: (r) => r.ok === false && r.status === 403,
      ehFalhaDeRede: (r) => r.ok === false && r.status === 0,
    },
    console, Promise, String, Object, Array, Number, Math, TypeError, Error, JSON,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(RAIZ, 'js', 'lgpd.js'), 'utf8'), sandbox);
  return { L: sandbox.EpiLgpd, chamadas };
}

const resumoValido = () => ({
  controladora: { razaoSocial: 'Empresa Alfa Ltda', cnpj: '11222333000181' },
  titulares: { funcionarios: { total: 12, ativos: 9, afastados: 1, inativos: 2 }, usuarios: { total: 4, ativos: 3 } },
});

describe('EpiLgpd — ações e modelo', () => {
  test('acoes.resumo consulta GET /lgpd/resumo sem parâmetro algum (a empresa é a da sessão)', async () => {
    const { L, chamadas } = carregar([{ ok: true, status: 200, dados: { status: 'ok', resumo: resumoValido() } }]);
    await L.acoes.resumo();
    assert.deepEqual(chamadas, [['GET', '/lgpd/resumo']]);
  });

  test('modelo.resumo aceita só o contrato exato e copia campo a campo', () => {
    const { L } = carregar();
    const m = L.modelo.resumo({ ok: true, status: 200, dados: { status: 'ok', resumo: resumoValido() } });
    // LGPD-1: o resumo ganhou `encarregado` (opcional na entrada; sempre presente na saída, nulos quando não há designação).
    assert.deepEqual(JSON.parse(JSON.stringify(m)), { ...resumoValido(), encarregado: { principal: null, substituto: null } }); // objeto de outro contexto (vm): compara o conteúdo
    assert.equal(L.modelo.resumo({ ok: false, status: 500, dados: null }), null);
    assert.equal(L.modelo.resumo({ ok: true, status: 200, dados: null }), null);
    assert.equal(L.modelo.resumo({ ok: true, status: 200, dados: { status: 'ok', resumo: { controladora: { razaoSocial: 'X', cnpj: '1' } } } }), null, 'sem titulares');
    const semUsuarios = resumoValido(); delete semUsuarios.titulares.usuarios;
    assert.equal(L.modelo.resumo({ ok: true, status: 200, dados: { status: 'ok', resumo: semUsuarios } }), null);
    const negativo = resumoValido(); negativo.titulares.funcionarios.ativos = -1;
    assert.equal(L.modelo.resumo({ ok: true, status: 200, dados: { status: 'ok', resumo: negativo } }), null);
    const fracao = resumoValido(); fracao.titulares.usuarios.total = 1.5;
    assert.equal(L.modelo.resumo({ ok: true, status: 200, dados: { status: 'ok', resumo: fracao } }), null);
    const texto = resumoValido(); texto.titulares.funcionarios.total = '12';
    assert.equal(L.modelo.resumo({ ok: true, status: 200, dados: { status: 'ok', resumo: texto } }), null, 'número como texto não é aceito');
    const semRazao = resumoValido(); semRazao.controladora.razaoSocial = '';
    assert.equal(L.modelo.resumo({ ok: true, status: 200, dados: { status: 'ok', resumo: semRazao } }), null);
  });

  test('formatarCnpj: 14 posições viram 00.000.000/0000-00; qualquer outra coisa volta como texto puro', () => {
    const { L } = carregar();
    assert.equal(L.formatarCnpj('11222333000181'), '11.222.333/0001-81');
    assert.equal(L.formatarCnpj('12ABC345010A91'), '12.ABC.345/010A-91');
    assert.equal(L.formatarCnpj('123'), '123');
    assert.equal(L.formatarCnpj(''), '');
    assert.equal(L.formatarCnpj(null), '');
  });

  test('textos: plural correto nos detalhes das contagens', () => {
    const { L } = carregar();
    assert.equal(L.TEXTOS.detalheFuncionarios({ total: 1, ativos: 1, afastados: 0, inativos: 0 }), '1 ativo · 0 afastados · 0 inativos');
    assert.equal(L.TEXTOS.detalheFuncionarios({ total: 12, ativos: 9, afastados: 1, inativos: 2 }), '9 ativos · 1 afastado · 2 inativos');
    assert.equal(L.TEXTOS.detalheUsuarios({ total: 4, ativos: 3 }), '3 ativos');
    assert.equal(L.TEXTOS.detalheUsuarios({ total: 1, ativos: 1 }), '1 ativo');
  });

  test('o módulo não grava nada no navegador, não interpreta HTML e não conhece o protótipo', () => {
    const codigo = fs.readFileSync(path.join(RAIZ, 'js', 'lgpd.js'), 'utf8');
    assert.doesNotMatch(codigo, /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|document\.cookie|EpiAPI|showView|setActiveNav/);
    // LGPD-1: as únicas escritas são os POST do encarregado (CAMINHO_ENCARREGADOS); nunca PUT, PATCH ou DELETE, nunca outro caminho.
    assert.doesNotMatch(codigo, /requisitar\('(PUT|PATCH|DELETE)'/, 'nenhuma escrita além dos POST do encarregado');
    for (const m of codigo.matchAll(/requisitar\('POST',\s*([^,]+),/g)) assert.match(m[1], /^CAMINHO_ENCARREGADOS/, m[1]);
  });
});
