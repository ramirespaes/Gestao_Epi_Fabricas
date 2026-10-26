'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { TOGGLES } = require('../../src/rbac/toggles');
const avisos = require('../../src/rbac/avisos-acessos');

/**
 * Dados da Empresa — controle único (`dadosEmpresa`): sem dependência entre Editar e Visualizar, o aviso
 * DADOS_EMPRESA_SEM_CONSULTAR deixou de existir. O único aviso do controle é ACESSO_PARCIAL_LEGADO (só informa).
 */
const acessos = (mapa, parciais = []) => TOGGLES.map((t) => ({ id: t.id, ligado: mapa[t.id] === true, ...(parciais.includes(t.id) ? { parcial: true } : {}) }));
const codigos = (mapa, parciais) => avisos.avisosDosAcessos(acessos(mapa, parciais)).map((a) => a.codigo);

describe('Dados da Empresa — avisos', () => {
  test('o código antigo não é mais exportado', () => {
    assert.equal(avisos.DADOS_EMPRESA_SEM_CONSULTAR, undefined);
  });

  test('ligado ou desligado (sem parcial), o controle não gera aviso', () => {
    assert.deepEqual(codigos({ dadosEmpresa: true }), []);
    assert.deepEqual(codigos({}), []);
  });

  test('parcial legado: um aviso com o rótulo do acesso; nada é revogado nem concedido', () => {
    assert.deepEqual(avisos.avisosDosAcessos(acessos({}, ['dadosEmpresa'])), [{ codigo: 'ACESSO_PARCIAL_LEGADO', acessos: ['Dados da Empresa'] }]);
  });

  test('não interfere nos demais avisos', () => {
    assert.deepEqual(codigos({ exportarHistoricoFuncionarios: true, dadosEmpresa: true }), ['EXPORTAR_HISTORICO_SEM_VISUALIZAR']);
  });
});
