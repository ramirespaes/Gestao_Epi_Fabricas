'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const consulta = require('../../src/services/entrega-epi-consulta.service');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');
const materialRepo = require('../../src/repositories/material.repository');
const contextoRepo = require('../../src/repositories/entrega-epi-contexto.repository');
const posicaoRepo = require('../../src/repositories/posicao-estoque.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Contexto da entrega DIRETA (10E) com a posição agregada do par (12D-2): o
 * operador vê, por tamanho, o físico utilizável, o comprometido, o saldo livre,
 * a demanda sem cobertura e o mínimo. Só números agregados: nunca quais
 * solicitações compõem a demanda nem quem as pediu. Os lotes e o contrato
 * anterior seguem como estavam.
 */

const EMPRESA = 42;
const FUNCIONARIO = 5;
const MATERIAL = 30;
const HOJE = '2026-10-02';

const LOTES = [{ loteId: 1, tamanho: '40', caNumero: '123', caValidade: '2027-01-31', saldo: 8, situacaoCa: 'VALIDO' }];
const POSICOES = [{
  tamanho: '40', fisicoUtilizavel: 8, comprometido: 2, saldoLivre: 6, semCobertura: 0, estoqueMinimo: 5, minimoOrigem: 'PADRAO', abaixoDoMinimo: false,
}];

function simular(t, { material = { id: MATERIAL, nome: 'Botina', ativo: true, exigeTamanho: true, oculosComGrau: null, prazoUsoDias: 180 }, posicoes = POSICOES } = {}) {
  const chamadas = {};
  t.mock.method(funcionarioRepo, 'buscarPorId', async () => ({ id: FUNCIONARIO, ativo: true, grupoHomogeneoId: null }));
  t.mock.method(materialRepo, 'buscarPorId', async () => material);
  t.mock.method(contextoRepo, 'listarLotes', async (_p, empresaId, materialId, hoje) => { chamadas.lotes = [empresaId, materialId, hoje]; return LOTES; });
  t.mock.method(posicaoRepo, 'listarPosicoesDoMaterial', async (_p, empresaId, materialId, ref) => { chamadas.posicao = [empresaId, materialId, ref]; return posicoes; });
  return chamadas;
}

describe('listarLotesDoContexto — lotes e posição agregada por tamanho (12D-2)', () => {
  test('devolve os lotes como antes e, ao lado, a posição por par, lida da empresa da sessão na data operacional', async (t) => {
    const chamadas = simular(t);
    const r = await consulta.listarLotesDoContexto({}, { empresaId: EMPRESA, funcionarioId: FUNCIONARIO, materialId: MATERIAL, hoje: HOJE });
    assert.deepEqual(r.material, { id: MATERIAL, nome: 'Botina', ativo: true, exigeTamanho: true, oculosComGrau: null, prazoUsoDias: 180 });
    assert.deepEqual([r.hoje, r.lotes], [HOJE, LOTES]);
    assert.deepEqual(r.posicoes, POSICOES);
    assert.deepEqual(chamadas.posicao, [EMPRESA, MATERIAL, { hoje: HOJE }]);
    assert.deepEqual(chamadas.lotes, [EMPRESA, MATERIAL, HOJE]);
  });

  test('a posição é só agregada: nenhum campo de solicitação, solicitante, justificativa ou demanda por pessoa', async (t) => {
    simular(t);
    const r = await consulta.listarLotesDoContexto({}, { empresaId: EMPRESA, funcionarioId: FUNCIONARIO, materialId: MATERIAL, hoje: HOJE });
    const texto = JSON.stringify(r.posicoes);
    assert.doesNotMatch(texto, /solicit|justific|nome|funcionario|trabalhador|demanda/i);
    assert.deepEqual(Object.keys(r.posicoes[0]).sort(), ['abaixoDoMinimo', 'comprometido', 'estoqueMinimo', 'fisicoUtilizavel', 'minimoOrigem', 'saldoLivre', 'semCobertura', 'tamanho']);
  });

  test('material sem nenhum par na posição (por exemplo, inativo): lista vazia, sem erro', async (t) => {
    simular(t, { posicoes: [] });
    const r = await consulta.listarLotesDoContexto({}, { empresaId: EMPRESA, funcionarioId: FUNCIONARIO, materialId: MATERIAL, hoje: HOJE });
    assert.deepEqual(r.posicoes, []);
    assert.deepEqual(r.lotes, LOTES);
  });

  test('material inexistente ou de outra empresa continua 404 e a posição nem é consultada', async (t) => {
    simular(t, { material: null });
    const posicao = t.mock.method(posicaoRepo, 'listarPosicoesDoMaterial', async () => []);
    await assert.rejects(
      () => consulta.listarLotesDoContexto({}, { empresaId: EMPRESA, funcionarioId: FUNCIONARIO, materialId: MATERIAL, hoje: HOJE }),
      (erro) => HttpError.ehHttpError(erro) && erro.status === 404 && erro.codigo === 'MATERIAL_NAO_ENCONTRADO',
    );
    assert.equal(posicao.mock.callCount(), 0);
  });
});
