'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { decidirContexto } = require('../../../../deploy/hml/cd/publicar');

const SHA = 'a'.repeat(40);
const base = {
  GITHUB_REPOSITORY: 'ramirespaes/Gestao_Epi_Fabricas', GITHUB_REF: 'refs/heads/main', HML_HABILITADA: 'true',
  GITHUB_RUN_ATTEMPT: '1', HML_ROTULO: `hml-20261109T120000-${SHA.slice(0, 7)}`,
};
const manual = (extra = {}) => ({ ...base, GITHUB_EVENT_NAME: 'workflow_dispatch', HML_PUBLICAR: 'true', HML_CONFIRMACAO: 'HOMOLOGACAO', HML_PERMITIR_ANTERIOR: 'false', ...extra });
const auto = (extra = {}) => ({ ...base, GITHUB_EVENT_NAME: 'workflow_run', HML_PUBLICAR: '', HML_CONFIRMACAO: '', HML_PERMITIR_ANTERIOR: '', ...extra });
const bloqueia = (env) => assert.throws(() => decidirContexto(env), (e) => e.codigo === 'CONTEXTO_BLOQUEADO');

describe('publicar.js — contexto de publicação', () => {
  test('manual: preserva publicar=true, confirmação literal e decisão explícita sobre commit anterior', () => {
    assert.deepEqual(decidirContexto(manual()), { modo: 'manual', permitirAnterior: false });
    assert.deepEqual(decidirContexto(manual({ HML_PERMITIR_ANTERIOR: 'true' })), { modo: 'manual', permitirAnterior: true });
  });

  test('manual: sem publicar, sem confirmação exata ou com anterior indefinido, bloqueia', () => {
    bloqueia(manual({ HML_PUBLICAR: 'false' }));
    bloqueia(manual({ HML_PUBLICAR: '' }));
    bloqueia(manual({ HML_CONFIRMACAO: 'homologacao' }));
    bloqueia(manual({ HML_CONFIRMACAO: '' }));
    bloqueia(manual({ HML_PERMITIR_ANTERIOR: '' }));
    bloqueia(manual({ HML_PERMITIR_ANTERIOR: 'talvez' }));
  });

  test('automático: dispensa publicar e confirmação, nunca permite commit anterior', () => {
    assert.deepEqual(decidirContexto(auto()), { modo: 'automatico', permitirAnterior: false });
  });

  test('automático: não há bypass por variáveis forjadas (anterior, retroativo, nova tentativa)', () => {
    bloqueia(auto({ HML_PERMITIR_ANTERIOR: 'true' }));
    bloqueia(auto({ HML_PERMITIR_ANTERIOR: 'false' }));
    bloqueia(auto({ HML_ROTULO: `hml-20261109T120000-${SHA.slice(0, 7)}-retroativo` }));
    bloqueia(auto({ GITHUB_RUN_ATTEMPT: '2' }));
    bloqueia(auto({ GITHUB_RUN_ATTEMPT: undefined }));
  });

  test('qualquer modo: interruptor desligado, repositório, ref ou evento indevidos bloqueiam', () => {
    for (const fabrica of [manual, auto]) {
      bloqueia(fabrica({ HML_HABILITADA: 'false' }));
      bloqueia(fabrica({ HML_HABILITADA: undefined }));
      bloqueia(fabrica({ GITHUB_REPOSITORY: 'intruso/Gestao_Epi_Fabricas' }));
      bloqueia(fabrica({ GITHUB_REF: 'refs/heads/feature' }));
      bloqueia(fabrica({ GITHUB_REF: 'refs/pull/1/merge' }));
    }
    for (const evento of ['push', 'pull_request', 'pull_request_target', 'schedule', 'repository_dispatch', '', undefined]) {
      bloqueia(auto({ GITHUB_EVENT_NAME: evento }));
      bloqueia(manual({ GITHUB_EVENT_NAME: evento }));
    }
  });

  test('um evento manual não herda o atalho do automático e vice-versa', () => {
    bloqueia({ ...auto(), GITHUB_EVENT_NAME: 'workflow_dispatch' });
    bloqueia({ ...manual(), GITHUB_EVENT_NAME: 'workflow_run' });
  });
});
