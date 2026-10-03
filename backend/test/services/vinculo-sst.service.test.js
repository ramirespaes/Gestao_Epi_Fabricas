'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Parte pura do serviço administrativo do vínculo SST, sem PostgreSQL: a
 * validação recusa antes de abrir transação. Autoridade (MASTER ativo da
 * própria empresa), isolamento entre empresas, duplicidade e auditoria são
 * provados com banco real em test/integracao/vinculo-sst-service.integration.js.
 */

const servico = () => exigirModulo('src/services/vinculo-sst.service');

const poolFechado = { connect: async () => { throw new Error('não deve abrir transação'); }, query: async () => { throw new Error('não deve consultar'); } };
const dados = (extra = {}) => ({ empresaId: 42, atorId: 7, usuarioId: 11, ...extra });

describe('concederVinculo — validação antes de qualquer acesso ao banco', () => {
  test('identificadores inteiros positivos', async () => {
    for (const extra of [{ empresaId: 0 }, { atorId: -1 }, { usuarioId: 1.5 }, { usuarioId: '11' }]) {
      await assert.rejects(servico().concederVinculo(poolFechado, dados(extra)), TypeError, JSON.stringify(extra));
    }
  });

  test('motivo opcional: de 1 a 500 caracteres, sem controle; fora disso, 400 sem devolver o valor', async () => {
    for (const motivo of ['   ', 'x'.repeat(501), 'a\u0007b', 42]) {
      await assert.rejects(servico().concederVinculo(poolFechado, dados({ motivo })), (erro) => {
        assert.ok(HttpError.ehHttpError(erro));
        assert.deepEqual([erro.status, erro.codigo], [400, 'VALIDACAO']);
        assert.deepEqual(erro.detalhes.map((d) => [d.campo, d.codigo]), [['body.motivo', 'MOTIVO_INVALIDO']]);
        assert.doesNotMatch(JSON.stringify(erro.detalhes), /xxxx|\u0007/);
        return true;
      });
    }
    await assert.rejects(servico().concederVinculo(poolFechado, dados()), /não deve abrir transação/);
    await assert.rejects(servico().concederVinculo(poolFechado, dados({ motivo: 'Técnico de segurança' })), /não deve abrir transação/);
  });
});

describe('listarVinculos — validação antes de qualquer acesso ao banco (12E-1)', () => {
  const funcao = () => {
    assert.equal(typeof servico().listarVinculos, 'function', 'função ainda não implementada: listarVinculos');
    return servico().listarVinculos;
  };
  const dadosDaLista = (extra = {}) => ({ empresaId: 42, atorId: 7, pagina: 1, limite: 20, ...extra });

  test('empresa e ator da sessão, página e limite válidos', async () => {
    for (const extra of [{ empresaId: 0 }, { atorId: -1 }, { atorId: '7' }, { pagina: 0 }, { pagina: 1.5 }, { limite: 0 }, { limite: 101 }, { limite: undefined }]) {
      await assert.rejects(funcao()(poolFechado, dadosDaLista(extra)), TypeError, JSON.stringify(extra));
    }
    await assert.rejects(funcao()(poolFechado, dadosDaLista()), /não deve abrir transação/);
  });
});

describe('removerVinculo — validação antes de qualquer acesso ao banco', () => {
  test('identificadores inteiros positivos', async () => {
    for (const extra of [{ empresaId: 0 }, { atorId: 1.5 }, { usuarioId: null }]) {
      await assert.rejects(servico().removerVinculo(poolFechado, dados(extra)), TypeError, JSON.stringify(extra));
    }
    await assert.rejects(servico().removerVinculo(poolFechado, dados()), /não deve abrir transação/);
  });
});
