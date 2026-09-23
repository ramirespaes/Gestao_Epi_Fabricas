'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/estoque.service');
const materialRepo = require('../../src/repositories/material.repository');
const estoqueRepo = require('../../src/repositories/estoque-tamanho.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de estoque por tamanho (Bloco 9, Etapa A),
 * sem PostgreSQL real. Ponto central: movimentar() nunca consulta
 * permissao.repository.js nem autoridade-administrativa.js — a autorização
 * por AÇÃO (MOVIMENTAR_ESTOQUE) é inteiramente do middleware da rota.
 */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const ATOR_ID = 7;
const MATERIAL_ID = 30;

const material = (extra = {}) => ({
  id: MATERIAL_ID, empresaId: EMPRESA, nome: 'Botina de segurança', ativo: true, ...extra,
});

const saldo = (extra = {}) => ({
  id: 100, materialId: MATERIAL_ID, tamanho: '40', quantidade: 12,
  criadoEm: new Date('2026-09-23T12:00:00Z'), atualizadoEm: new Date('2026-09-23T12:00:00Z'), ...extra,
});

function criarClienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; },
    release: () => { chamadas.push('RELEASE'); },
  };
}

const criarPoolFalso = (cliente) => ({ connect: async () => cliente, query: (...args) => cliente.query(...args) });
const contar = (chamadas, padrao) => chamadas.filter((c) => padrao.test(c)).length;

function mundoValido(t, { materialExistente = material(), saldoExistente = saldo() } = {}) {
  t.mock.method(materialRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => (
    empresaId === EMPRESA && materialExistente && id === materialExistente.id ? materialExistente : null
  ));
  t.mock.method(materialRepo, 'buscarPorId', async (_c, empresaId, id) => (
    empresaId === EMPRESA && materialExistente && id === materialExistente.id ? materialExistente : null
  ));
  t.mock.method(estoqueRepo, 'listarPorMaterial', async () => [saldoExistente].filter(Boolean));
  t.mock.method(estoqueRepo, 'buscarPorMaterialTamanhoParaAtualizacao', async (_c, empresaId, materialId, tamanho) => (
    empresaId === EMPRESA && saldoExistente && materialId === MATERIAL_ID && tamanho === saldoExistente.tamanho ? saldoExistente : null
  ));
  return {
    criar: t.mock.method(estoqueRepo, 'criar', async (_c, dados) => (
      dados.empresaId === EMPRESA ? saldo({ id: 200, tamanho: dados.tamanho, quantidade: dados.quantidade }) : null
    )),
    atualizarQuantidade: t.mock.method(estoqueRepo, 'atualizarQuantidade', async (_c, empresaId, id, quantidade) => (
      empresaId === EMPRESA ? saldo({ id, quantidade }) : null
    )),
    registrar: t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: new Date() })),
  };
}

async function esperarHttpError(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.equal(erro.status, status);
    assert.equal(erro.codigo, codigo);
    return true;
  });
}

function assertRecusaSemRastro(cliente, escritas) {
  assert.equal(contar(cliente.chamadas, /^BEGIN$/), 1);
  assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  assert.equal(escritas.criar.mock.calls.length, 0);
  assert.equal(escritas.atualizarQuantidade.mock.calls.length, 0);
  assert.equal(escritas.registrar.mock.calls.length, 0, 'recusa não é auditada');
  assert.ok(cliente.chamadas.includes('RELEASE'));
}

describe('consultar', () => {
  test('devolve material e saldos, sem transação', async (t) => {
    mundoValido(t);
    const resultado = await servico.consultar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, materialId: MATERIAL_ID });
    assert.equal(resultado.material.id, MATERIAL_ID);
    assert.equal(resultado.saldos.length, 1);
  });

  test('isolamento: material de outra empresa não é encontrado (404)', async (t) => {
    mundoValido(t);
    await esperarHttpError(
      servico.consultar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA_OUTRA, materialId: MATERIAL_ID }),
      404, 'MATERIAL_NAO_ENCONTRADO',
    );
  });
});

describe('movimentar — ENTRADA', () => {
  test('soma ao saldo existente, audita quantidade anterior e nova, commita', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const resultado = await servico.movimentar(criarPoolFalso(cliente), {
      empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', tipo: 'ENTRADA', quantidade: 8,
    });

    assert.equal(escritas.atualizarQuantidade.mock.calls[0].arguments[1], EMPRESA, 'empresaId viaja também para a escrita — isolamento reforçado no SQL');
    assert.equal(escritas.atualizarQuantidade.mock.calls[0].arguments[2], 100);
    assert.equal(escritas.atualizarQuantidade.mock.calls[0].arguments[3], 20, '12 existentes + 8 de entrada');
    assert.equal(resultado.quantidade, 20);

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'ESTOQUE_MOVIMENTADO');
    assert.equal(auditoria.dadosAnteriores.quantidade, 12);
    assert.equal(auditoria.dadosNovos.quantidade, 20);
    assert.equal(auditoria.contexto.tipo, 'ENTRADA');
    assert.equal(auditoria.contexto.quantidadeMovimentada, 8);

    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('tamanho ainda não cadastrado: cria a linha de saldo a partir de zero', async (t) => {
    const escritas = mundoValido(t, { saldoExistente: null });

    const resultado = await servico.movimentar(criarPoolFalso(criarClienteFalso()), {
      empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '99', tipo: 'ENTRADA', quantidade: 5,
    });

    assert.equal(escritas.criar.mock.calls[0].arguments[1].tamanho, '99');
    assert.equal(escritas.criar.mock.calls[0].arguments[1].quantidade, 5);
    assert.equal(resultado.quantidade, 5);
    assert.equal(escritas.registrar.mock.calls[0].arguments[1].dadosAnteriores.quantidade, 0);
  });
});

describe('movimentar — SAIDA', () => {
  test('subtrai do saldo existente', async (t) => {
    const escritas = mundoValido(t);

    const resultado = await servico.movimentar(criarPoolFalso(criarClienteFalso()), {
      empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', tipo: 'SAIDA', quantidade: 5,
    });

    assert.equal(escritas.atualizarQuantidade.mock.calls[0].arguments[3], 7, '12 existentes - 5 de saída');
    assert.equal(resultado.quantidade, 7);
  });

  test('saldo insuficiente: 409 ESTOQUE_INSUFICIENTE, ROLLBACK, nada gravado', async (t) => {
    const escritas = mundoValido(t, { saldoExistente: saldo({ quantidade: 3 }) });
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.movimentar(criarPoolFalso(cliente), {
        empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', tipo: 'SAIDA', quantidade: 10,
      }),
      409, 'ESTOQUE_INSUFICIENTE',
    );
    assertRecusaSemRastro(cliente, escritas);
  });

  test('saída de tamanho sem nenhum saldo cadastrado: 409 ESTOQUE_INSUFICIENTE (zero disponível)', async (t) => {
    const escritas = mundoValido(t, { saldoExistente: null });
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.movimentar(criarPoolFalso(cliente), {
        empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '99', tipo: 'SAIDA', quantidade: 1,
      }),
      409, 'ESTOQUE_INSUFICIENTE',
    );
    assertRecusaSemRastro(cliente, escritas);
  });
});

describe('movimentar — recusas estruturais, todas com ROLLBACK e sem rastro', () => {
  test('material inexistente nesta empresa: 404 MATERIAL_NAO_ENCONTRADO', async (t) => {
    const escritas = mundoValido(t, { materialExistente: null });
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.movimentar(criarPoolFalso(cliente), {
        empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', tipo: 'ENTRADA', quantidade: 1,
      }),
      404, 'MATERIAL_NAO_ENCONTRADO',
    );
    assertRecusaSemRastro(cliente, escritas);
  });

  test('material inativo: 409 MATERIAL_INATIVO, mesmo se o ator for MASTER — restrição estrutural, não de permissão', async (t) => {
    const escritas = mundoValido(t, { materialExistente: material({ ativo: false }) });
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.movimentar(criarPoolFalso(cliente), {
        empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', tipo: 'ENTRADA', quantidade: 1,
      }),
      409, 'MATERIAL_INATIVO',
    );
    assertRecusaSemRastro(cliente, escritas);
  });

  test('tipo inválido: 400 ESTOQUE_TIPO_INVALIDO, antes de abrir transação', async (t) => {
    mundoValido(t);
    await esperarHttpError(
      servico.movimentar(criarPoolFalso(criarClienteFalso()), {
        empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', tipo: 'AJUSTE', quantidade: 1,
      }),
      400, 'ESTOQUE_TIPO_INVALIDO',
    );
  });

  test('quantidade zero, negativa, fracionária ou acima do teto do INTEGER: 400 ESTOQUE_QUANTIDADE_INVALIDA', async (t) => {
    mundoValido(t);
    for (const quantidade of [0, -1, 1.5, 2147483648]) {
      await esperarHttpError(
        servico.movimentar(criarPoolFalso(criarClienteFalso()), {
          empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', tipo: 'ENTRADA', quantidade,
        }),
        400, 'ESTOQUE_QUANTIDADE_INVALIDA',
      );
    }
  });

  test('soma (saldo atual + entrada) ultrapassa o teto do INTEGER: 409 ESTOQUE_LIMITE_EXCEDIDO, ROLLBACK, nada gravado', async (t) => {
    const escritas = mundoValido(t, { saldoExistente: saldo({ quantidade: 2147483640 }) });
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.movimentar(criarPoolFalso(cliente), {
        empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', tipo: 'ENTRADA', quantidade: 100,
      }),
      409, 'ESTOQUE_LIMITE_EXCEDIDO',
    );
    assertRecusaSemRastro(cliente, escritas);
  });

  test('isolamento reforçado na escrita: se o repositório devolver null (material deixou de pertencer à empresa entre o lock e a escrita), 404 — defesa em profundidade, não deveria ser alcançável em uso normal', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(estoqueRepo, 'atualizarQuantidade', async () => null);
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.movimentar(criarPoolFalso(cliente), {
        empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', tipo: 'ENTRADA', quantidade: 1,
      }),
      404, 'MATERIAL_NAO_ENCONTRADO',
    );
    assert.equal(escritas.registrar.mock.calls.length, 0, 'não audita uma escrita que não aconteceu');
  });

  test('tamanho vazio: 400 ESTOQUE_TAMANHO_INVALIDO', async (t) => {
    mundoValido(t);
    await esperarHttpError(
      servico.movimentar(criarPoolFalso(criarClienteFalso()), {
        empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '   ', tipo: 'ENTRADA', quantidade: 1,
      }),
      400, 'ESTOQUE_TAMANHO_INVALIDO',
    );
  });

  test('identificadores inválidos: TypeError antes de abrir transação', async (t) => {
    mundoValido(t);
    await assert.rejects(() => servico.movimentar(criarPoolFalso(criarClienteFalso()), {
      empresaId: 0, atorId: ATOR_ID, materialId: MATERIAL_ID, tamanho: '40', tipo: 'ENTRADA', quantidade: 1,
    }), /empresa/i);
    await assert.rejects(() => servico.movimentar(criarPoolFalso(criarClienteFalso()), {
      empresaId: EMPRESA, atorId: 0, materialId: MATERIAL_ID, tamanho: '40', tipo: 'ENTRADA', quantidade: 1,
    }), /ator/i);
  });
});
