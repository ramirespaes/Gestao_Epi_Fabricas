'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { buscarPorCnpj, buscarPorId, existeAtiva } = require('../../src/repositories/empresa.repository');

/**
 * Repositório de empresas contra PostgreSQL real.
 *
 * Os testes unitários provam o contrato com um dublê. Aqui se prova que as
 * consultas realmente funcionam no banco: projeção correta, CNPJ alfanumérico
 * aceito pela constraint da migration 016 e a coluna ativo sendo respeitada.
 *
 * Tudo acontece em schema temporário exclusivo, removido em cascata ao final.
 * O schema public não é lido nem escrito.
 */

const NUMERICO = '12345678000195';
const ALFANUMERICO = '00000000E08G12';

describe('repositório de empresas em PostgreSQL real', () => {
  let contexto;
  before(async () => {
    contexto = await abrirSchemaTemporario(['000', '001', '016']);
    assert.equal(await inserirEmpresa(contexto.cliente, NUMERICO, 'Empresa Numérica'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, ALFANUMERICO, 'Empresa Alfanumérica'), 'ok');
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('encontra empresa por CNPJ numérico e alfanumérico', async () => {
    const numerica = await buscarPorCnpj(contexto.cliente, NUMERICO);
    const alfanumerica = await buscarPorCnpj(contexto.cliente, ALFANUMERICO);

    assert.equal(numerica.cnpj, NUMERICO);
    assert.equal(numerica.nome, 'Empresa Numérica');
    assert.equal(alfanumerica.cnpj, ALFANUMERICO);
    assert.equal(alfanumerica.ativo, true);
  });

  test('a projeção traz somente os campos públicos', async () => {
    const empresa = await buscarPorCnpj(contexto.cliente, NUMERICO);

    assert.deepEqual(Object.keys(empresa).sort(), ['ativo', 'cnpj', 'id', 'nome']);
  });

  test('CNPJ inexistente devolve null', async () => {
    assert.equal(await buscarPorCnpj(contexto.cliente, '99999999000199'), null);
  });

  test('busca por identificador devolve a mesma empresa', async () => {
    const porCnpj = await buscarPorCnpj(contexto.cliente, NUMERICO);
    const porId = await buscarPorId(contexto.cliente, porCnpj.id);

    assert.deepEqual(porId, porCnpj);
    assert.equal(await buscarPorId(contexto.cliente, 999999), null);
  });

  test('existeAtiva distingue empresa ativa de inativa', async () => {
    const empresa = await buscarPorCnpj(contexto.cliente, NUMERICO);
    assert.equal(await existeAtiva(contexto.cliente, empresa.id), true);

    await contexto.cliente.query('UPDATE empresas SET ativo = false WHERE id = $1', [empresa.id]);
    assert.equal(await existeAtiva(contexto.cliente, empresa.id), false, 'empresa inativa não pode ser considerada apta');

    assert.equal(await existeAtiva(contexto.cliente, 999999), false, 'empresa inexistente não pode ser considerada apta');
  });
});
