'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buscarPorCnpj,
  buscarPorId,
  existeAtiva,
  CAMPOS_PUBLICOS,
} = require('../../src/repositories/empresa.repository');

/**
 * Contrato do repositório de empresas.
 *
 * O executor de consultas chega por parâmetro, nunca é importado. Isso é o que
 * permite trocar um pool único por uma conexão escolhida por empresa sem
 * reescrever repositório algum, e é também o que torna estes testes possíveis
 * sem banco: o executor aqui é um dublê que apenas registra o que recebeu.
 *
 * O repositório não decide regra de negócio. Ele consulta, devolve o que
 * encontrou e devolve null quando não encontra. Quem interpreta ausência é o
 * serviço de autenticação, que precisa responder de forma indistinguível para
 * empresa inexistente e senha errada.
 */

const CNPJ_NUMERICO = '12345678000195';
const CNPJ_ALFANUMERICO = '00000000E08G12';

const executorFalso = (linhas = []) => {
  const chamadas = [];
  const executor = {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: linhas.length };
    },
  };
  return executor;
};

const linhaEmpresa = (extra = {}) => ({
  id: 1,
  nome: 'Empresa Demonstração',
  cnpj: CNPJ_NUMERICO,
  ativo: true,
  ...extra,
});

describe('buscarPorCnpj', () => {
  test('consulta de forma parametrizada, sem concatenar o CNPJ no SQL', async () => {
    const executor = executorFalso([linhaEmpresa()]);

    await buscarPorCnpj(executor, CNPJ_NUMERICO);

    assert.equal(executor.chamadas.length, 1);
    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [CNPJ_NUMERICO], 'o CNPJ deve viajar como parâmetro');
    assert.equal(texto.includes(CNPJ_NUMERICO), false, 'o CNPJ não pode aparecer no texto da consulta');
    assert.match(texto, /\$1/, 'a consulta deve usar placeholder posicional');
    assert.match(texto, /from\s+empresas/i);
  });

  test('aceita CNPJ alfanumérico já normalizado', async () => {
    const executor = executorFalso([linhaEmpresa({ cnpj: CNPJ_ALFANUMERICO })]);

    const empresa = await buscarPorCnpj(executor, CNPJ_ALFANUMERICO);

    assert.equal(empresa.cnpj, CNPJ_ALFANUMERICO);
    assert.deepEqual(executor.chamadas[0].valores, [CNPJ_ALFANUMERICO]);
  });

  test('devolve null quando não encontra, em vez de lançar', async () => {
    const executor = executorFalso([]);

    assert.equal(await buscarPorCnpj(executor, CNPJ_NUMERICO), null);
  });

  test('devolve somente os campos públicos, sem vazar coluna inesperada', async () => {
    const executor = executorFalso([
      linhaEmpresa({ dpo_email: 'dpo@demo.test', telefone: '4700000000' }),
    ]);

    const empresa = await buscarPorCnpj(executor, CNPJ_NUMERICO);

    assert.deepEqual(Object.keys(empresa).sort(), [...CAMPOS_PUBLICOS].sort());
    assert.equal('dpo_email' in empresa, false);
    assert.equal('telefone' in empresa, false);
  });

  test('recusa CNPJ que não esteja normalizado, sem consultar o banco', async () => {
    const executor = executorFalso([linhaEmpresa()]);

    await assert.rejects(() => buscarPorCnpj(executor, '12.345.678/0001-95'), /cnpj/i);
    await assert.rejects(() => buscarPorCnpj(executor, '00000000e08g12'), /cnpj/i);
    await assert.rejects(() => buscarPorCnpj(executor, null), /cnpj/i);

    assert.equal(executor.chamadas.length, 0, 'nenhuma consulta deve ser emitida');
  });
});

describe('buscarPorId', () => {
  test('consulta de forma parametrizada pelo identificador', async () => {
    const executor = executorFalso([linhaEmpresa()]);

    const empresa = await buscarPorId(executor, 1);

    assert.deepEqual(executor.chamadas[0].valores, [1]);
    assert.match(executor.chamadas[0].texto, /\$1/);
    assert.equal(empresa.id, 1);
  });

  test('devolve null quando não encontra', async () => {
    assert.equal(await buscarPorId(executorFalso([]), 999), null);
  });

  test('recusa identificador que não seja inteiro positivo', async () => {
    const executor = executorFalso([linhaEmpresa()]);

    await assert.rejects(() => buscarPorId(executor, 0), /identificador/i);
    await assert.rejects(() => buscarPorId(executor, -1), /identificador/i);
    await assert.rejects(() => buscarPorId(executor, 1.5), /identificador/i);
    await assert.rejects(() => buscarPorId(executor, '1'), /identificador/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('existeAtiva', () => {
  test('devolve true para empresa ativa e false para inativa', async () => {
    assert.equal(await existeAtiva(executorFalso([{ existe: true }]), 1), true);
    assert.equal(await existeAtiva(executorFalso([{ existe: false }]), 1), false);
  });

  test('devolve false quando a empresa não existe', async () => {
    assert.equal(await existeAtiva(executorFalso([]), 999), false);
  });

  test('a condição de empresa ativa está na própria consulta', async () => {
    const executor = executorFalso([{ existe: true }]);

    await existeAtiva(executor, 1);

    assert.match(executor.chamadas[0].texto, /ativo/i, 'a consulta deve considerar a coluna ativo');
    assert.deepEqual(executor.chamadas[0].valores, [1]);
  });
});
