'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const recursos = require('../../src/rbac/recursos');
const { TOGGLES, PENDENCIAS, GRUPOS, buscar } = require('../../src/rbac/toggles');

/**
 * Bloco A1 — dois toggles independentes em ADMINISTRACAO, cada um sobre a operação `visualizar` do recurso histórico
 * correspondente (`lgpd`, `emailsGestao`), protegendo UMA rota real e somente de leitura por módulo. Nada de editar, criar,
 * excluir, ação nova ou dependência: o que não tem rota nesta etapa não vira controle.
 */
const ROTAS = path.join(__dirname, '..', '..', 'src', 'routes');
const fonte = (arquivo) => fs.readFileSync(path.join(ROTAS, arquivo), 'utf8');

describe('Bloco A1 — toggles Privacidade e LGPD e Gestão de E-mails', () => {
  test('os dois toggles existem, em ADMINISTRACAO, só com visualizar do recurso próprio, sem dependências e sem flags especiais', () => {
    assert.deepEqual(
      [buscar('privacidadeLgpd').rotulo, buscar('privacidadeLgpd').grupo, buscar('privacidadeLgpd').regra, buscar('privacidadeLgpd').dependencias],
      ['Privacidade e LGPD', 'ADMINISTRACAO', { tipo: 'RECURSO', recurso: 'lgpd', operacoes: ['visualizar'] }, undefined],
    );
    assert.deepEqual(
      [buscar('gestaoEmail').rotulo, buscar('gestaoEmail').grupo, buscar('gestaoEmail').regra, buscar('gestaoEmail').dependencias],
      ['Gestão de E-mails', 'ADMINISTRACAO', { tipo: 'RECURSO', recurso: 'emailsGestao', operacoes: ['visualizar'] }, undefined],
    );
    assert.ok(GRUPOS.includes('ADMINISTRACAO'));
  });

  test('são independentes: recursos distintos, um toggle por recurso, nenhum outro toggle toca lgpd ou emailsGestao', () => {
    assert.notEqual(buscar('privacidadeLgpd').regra.recurso, buscar('gestaoEmail').regra.recurso);
    for (const recurso of ['lgpd', 'emailsGestao']) {
      assert.equal(TOGGLES.filter((t) => t.regra.tipo === 'RECURSO' && t.regra.recurso === recurso).length, 1, recurso);
      assert.equal(TOGGLES.some((t) => (t.dependencias ?? []).some((d) => d.tipo === 'RECURSO' && d.recurso === recurso)), false, `${recurso} nunca é dependência`);
    }
  });

  test('deixam de ser pendência; as demais pendências continuam (6 do A1 + a retenção do LGPD-1)', () => {
    assert.equal(PENDENCIAS.some((p) => p.id === 'privacidadeLgpd' || p.id === 'gestaoEmail'), false);
    assert.equal(PENDENCIAS.length, 7);
    assert.equal(TOGGLES.length + PENDENCIAS.length, 37, 'A1: duas pendências viraram controle (35); LGPD-1: + toggle do encarregado e + pendência da retenção (37)');
  });

  test('os recursos entram no catálogo com efeito e no escopo do MASTER SÓ com visualizar, com rótulo próprio', () => {
    for (const [recurso, rotulo] of [['lgpd', 'Privacidade e LGPD'], ['emailsGestao', 'Gestão de E-mails']]) {
      assert.ok(recursos.recursoConhecido(recurso));
      assert.equal(recursos.ROTULOS_RECURSOS[recurso], rotulo);
      assert.deepEqual([...recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.find((r) => r.recurso === recurso).operacoes], ['visualizar']);
      assert.deepEqual([...recursos.RECURSOS_COM_EFEITO.find((r) => r.recurso === recurso).operacoes], ['visualizar']);
    }
    assert.deepEqual([...recursos.ESCOPO_PROVISIONAMENTO_MASTER.acoes].filter((a) => /LGPD|EMAIL/.test(a)), [], 'nenhuma ação nova');
  });

  test('cada rota é um único GET somente de leitura, atrás da sessão e de criarExigirPermissaoRecurso(recurso, visualizar)', () => {
    for (const [arquivo, recurso] of [['lgpd.routes.js', 'lgpd'], ['email-gestao.routes.js', 'emailsGestao']]) {
      const codigo = fonte(arquivo);
      assert.match(codigo, new RegExp(`const RECURSO = '${recurso}'`));
      assert.match(codigo, /criarExigirPermissaoRecurso\(\{ pool: poolInjetado \}, RECURSO, 'visualizar'\)/);
      assert.equal((codigo.match(/router\.get\(/g) ?? []).length, 1, `${arquivo}: um só GET`);
      assert.doesNotMatch(codigo, /router\.(post|put|patch|delete)\(/, `${arquivo}: sem escrita nesta etapa`);
      const get = codigo.slice(codigo.indexOf('router.get('));
      assert.ok(get.indexOf('exigirSessaoInjetado') < get.indexOf('exigirVisualizar'), 'sessão antes da permissão');
    }
  });
});
