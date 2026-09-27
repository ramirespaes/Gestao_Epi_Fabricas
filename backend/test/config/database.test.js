'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseError } = require('pg');

const { pool } = require('../../src/config/database');

/**
 * SEC-007: o listener de erro do pool registra só metadados de formato
 * controlado. O objeto do pg carrega mensagem, detail, hint, where, query
 * interna e, em falha de rede, endereço e porta do servidor; nada disso
 * pode ir para o log. O pool conecta sob demanda: emitir o evento aqui não
 * abre conexão.
 */

const PREFIXO = '[db] erro inesperado em cliente ocioso do pool';

function capturarErroDoPool(t, err) {
  const linhas = [];
  t.mock.method(console, 'error', (...args) => { linhas.push(args); });
  pool.emit('error', err);
  return linhas;
}

describe('pool.on(error) — SEC-007', () => {
  test('erro do servidor: registra só nome e SQLSTATE, nunca mensagem, detail, hint, where, query ou stack', (t) => {
    const err = new DatabaseError('terminating connection due to administrator command', 120, 'error');
    Object.assign(err, {
      severity: 'FATAL',
      code: '57P01',
      detail: 'Chave (cpf)=(52998224725) já existe.',
      hint: 'dica com pessoa.convidada@exemplo-cliente.com.br',
      where: 'SQL statement "SELECT senha_hash FROM usuarios"',
      schema: 'public',
      table: 'funcionarios',
      constraint: 'uq_funcionarios_empresa_cpf',
      internalQuery: 'SELECT 1 FROM funcionarios WHERE cpf = $1',
      routine: 'ProcessInterrupts',
    });

    const linhas = capturarErroDoPool(t, err);

    assert.equal(linhas.length, 1);
    assert.equal(linhas[0][0], PREFIXO);
    assert.deepEqual(linhas[0][1], { nome: 'DatabaseError', codigo: '57P01' });
    assert.equal(linhas[0].length, 2);
    const texto = JSON.stringify(linhas);
    for (const vazamento of [
      'terminating connection', '52998224725', 'pessoa.convidada', 'senha_hash',
      'uq_funcionarios_empresa_cpf', 'internalQuery', 'ProcessInterrupts', 'funcionarios', 'at ',
    ]) {
      assert.equal(texto.includes(vazamento), false, vazamento);
    }
  });

  test('erro de rede: registra só nome e código do Node, nunca endereço, porta ou syscall', (t) => {
    const err = Object.assign(new Error('read ECONNRESET 10.20.30.40:5432'), {
      code: 'ECONNRESET', errno: -54, syscall: 'read', address: '10.20.30.40', port: 5432,
    });

    const linhas = capturarErroDoPool(t, err);

    assert.deepEqual(linhas, [[PREFIXO, { nome: 'Error', codigo: 'ECONNRESET' }]]);
  });

  test('código fora do formato controlado não é registrado; valor que não é Error vira só NaoErro', (t) => {
    const comCodigoLivre = Object.assign(new Error('x'), { code: 'senha=segredo; host=db.interno' });
    const naoErro = { message: 'password authentication failed for user "epi"', code: '28P01' };

    const linhas = [
      ...capturarErroDoPool(t, comCodigoLivre),
      ...capturarErroDoPool(t, naoErro),
    ];

    assert.deepEqual(linhas, [
      [PREFIXO, { nome: 'Error' }],
      [PREFIXO, { nome: 'NaoErro' }],
    ]);
  });
});
