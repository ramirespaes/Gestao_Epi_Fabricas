'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TOGGLES } = require('../../src/rbac/toggles');
const avisos = require('../../src/rbac/avisos-acessos');

/**
 * Dados da Empresa (F2) — aviso informativo DADOS_EMPRESA_SEM_CONSULTAR: Editar ligado e Visualizar desligado. Só informa
 * (nada é revogado ou ativado): o servidor continua recusando o PATCH, que exige as duas permissões.
 */
const CODIGO = 'DADOS_EMPRESA_SEM_CONSULTAR';
const acessos = (mapa) => TOGGLES.map((t) => ({ id: t.id, ligado: mapa[t.id] === true }));
const codigos = (mapa) => avisos.avisosDosAcessos(acessos(mapa)).map((a) => a.codigo);

describe('aviso DADOS_EMPRESA_SEM_CONSULTAR', () => {
  test('o código é exportado', () => {
    assert.equal(avisos.DADOS_EMPRESA_SEM_CONSULTAR, CODIGO);
  });

  test('Editar ligado e Visualizar desligado: aviso (ligado não é autorizado)', () => {
    assert.deepEqual(codigos({ dadosEmpresaEditar: true }), [CODIGO]);
  });

  test('os dois ligados, só Visualizar, ou nenhum: sem aviso', () => {
    assert.deepEqual(codigos({ dadosEmpresaEditar: true, dadosEmpresaVisualizar: true }), []);
    assert.deepEqual(codigos({ dadosEmpresaVisualizar: true }), []);
    assert.deepEqual(codigos({}), []);
  });

  test('é independente dos demais avisos e não aparece para outros acessos', () => {
    assert.deepEqual(codigos({ exportarHistoricoFuncionarios: true, dadosEmpresaEditar: true }).sort(), ['DADOS_EMPRESA_SEM_CONSULTAR', 'EXPORTAR_HISTORICO_SEM_VISUALIZAR']);
    assert.equal(codigos({ tokenCadastrar: true }).includes(CODIGO), false);
  });

  test('uma lista sem os toggles de Dados da Empresa não gera o aviso (não presume)', () => {
    assert.deepEqual(avisos.avisosDosAcessos([{ id: 'dashboard', ligado: true }]), []);
  });
});
