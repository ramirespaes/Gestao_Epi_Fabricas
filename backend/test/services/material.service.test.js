'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/material.service');
const materialRepo = require('../../src/repositories/material.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de materiais (Bloco 9, Etapa A), sem
 * PostgreSQL real. Todas as funções de repositório são substituídas via
 * t.mock.method. Só BEGIN/COMMIT/ROLLBACK passam pelo cliente falso.
 *
 * Diferente de grupo-acesso.service.test.js, não há cenário de "sem
 * autoridade": este serviço não decide autorização — é o contrato central
 * a comprovar aqui (nenhuma chamada a usuario.repository nem a
 * autoridade-administrativa.js).
 */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const ATOR_ID = 7;
const MATERIAL_ID = 30;

const material = (extra = {}) => ({
  id: MATERIAL_ID,
  empresaId: EMPRESA,
  nome: 'Botina de segurança',
  tipo: 'Sapatão / Botina',
  fabricante: 'Bracol',
  caNumero: '38271',
  caValidade: '2026-08-15',
  prazoUsoDias: 365,
  unidade: 'par',
  estoqueMinimo: 5,
  ativo: true,
  criadoEm: new Date('2026-09-23T12:00:00Z'),
  atualizadoEm: new Date('2026-09-23T12:00:00Z'),
  ...extra,
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

function mundoValido(t, { existente = material() } = {}) {
  t.mock.method(materialRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => (
    empresaId === EMPRESA && existente && id === existente.id ? existente : null
  ));
  t.mock.method(materialRepo, 'buscarPorId', async (_c, empresaId, id) => (
    empresaId === EMPRESA && existente && id === existente.id ? existente : null
  ));
  t.mock.method(materialRepo, 'listarPorEmpresa', async () => [existente].filter(Boolean));
  t.mock.method(materialRepo, 'contarPorEmpresa', async () => (existente ? 1 : 0));
  return {
    criar: t.mock.method(materialRepo, 'criar', async (_c, dados) => material({ ...dados })),
    atualizar: t.mock.method(materialRepo, 'atualizar', async (_c, _e, _id, campos) => material({
      nome: campos.nome ?? existente.nome,
      tipo: campos.tipoInformado ? campos.tipo : existente.tipo,
      ativo: campos.ativo ?? existente.ativo,
      estoqueMinimo: campos.estoqueMinimo ?? existente.estoqueMinimo,
    })),
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
  assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1, 'recusa dentro da transação termina em ROLLBACK');
  assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  assert.equal(escritas.registrar.mock.calls.length, 0, 'recusa não é auditada');
  assert.ok(cliente.chamadas.includes('RELEASE'));
}

describe('criar — caminho válido', () => {
  test('cria e audita na mesma transação, sem consultar nenhuma autoridade', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const resultado = await servico.criar(criarPoolFalso(cliente), {
      empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina de segurança',
    });

    assert.equal(resultado.id, MATERIAL_ID);
    assert.equal(escritas.criar.mock.calls[0].arguments[1].empresaId, EMPRESA);
    assert.equal(escritas.criar.mock.calls[0].arguments[1].nome, 'Botina de segurança');

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.empresaId, EMPRESA);
    assert.equal(auditoria.usuarioId, ATOR_ID);
    assert.equal(auditoria.acao, 'MATERIAL_CRIADO');

    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 0);
  });

  test('nome é aparado nas pontas, sem mexer em maiúsculas/minúsculas nem acentos', async (t) => {
    const escritas = mundoValido(t);

    await servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, nome: '   Botina de segurança   ' });

    assert.equal(escritas.criar.mock.calls[0].arguments[1].nome, 'Botina de segurança');
  });

  test('campos de texto opcionais ausentes, nulos ou só espaços viram null', async (t) => {
    for (const tipo of [undefined, null, '   ']) {
      const escritas = mundoValido(t);
      await servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina', tipo });
      assert.equal(escritas.criar.mock.calls[0].arguments[1].tipo, null);
    }
  });

  test('unidade ausente assume "unidade"; estoqueMinimo ausente assume 0', async (t) => {
    const escritas = mundoValido(t);

    await servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina' });

    assert.equal(escritas.criar.mock.calls[0].arguments[1].unidade, 'unidade');
    assert.equal(escritas.criar.mock.calls[0].arguments[1].estoqueMinimo, 0);
  });
});

describe('criar — recusas de validação: falham antes de abrir transação (fail fast, nenhuma conexão aberta), e ainda assim sem rastro', () => {
  test('nome vazio ou ausente: 400 MATERIAL_NOME_INVALIDO', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: '   ' }),
      400, 'MATERIAL_NOME_INVALIDO',
    );
    assert.equal(cliente.chamadas.length, 0, 'nenhuma consulta chega a rodar: validação recusa antes de conectar');
    assert.equal(escritas.criar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
  });

  test('prazoUsoDias inválido (zero, negativo ou fracionário): 400', async (t) => {
    for (const prazoUsoDias of [0, -5, 1.5]) {
      const escritas = mundoValido(t);
      const cliente = criarClienteFalso();
      await esperarHttpError(
        servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina', prazoUsoDias }),
        400, 'MATERIAL_DADOS_INVALIDOS',
      );
      assert.equal(cliente.chamadas.length, 0);
      assert.equal(escritas.criar.mock.calls.length, 0);
    }
  });

  test('estoqueMinimo negativo: 400', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();
    await esperarHttpError(
      servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina', estoqueMinimo: -1 }),
      400, 'MATERIAL_DADOS_INVALIDOS',
    );
    assert.equal(cliente.chamadas.length, 0);
    assert.equal(escritas.criar.mock.calls.length, 0);
  });

  test('identificadores inválidos: TypeError antes de abrir transação', async (t) => {
    mundoValido(t);
    await assert.rejects(() => servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: 0, atorId: ATOR_ID, nome: 'Botina' }), /empresa/i);
    await assert.rejects(() => servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: 0, nome: 'Botina' }), /ator/i);
  });
});

describe('buscar', () => {
  test('material existente na empresa é devolvido, sem transação', async (t) => {
    mundoValido(t);
    const material2 = await servico.buscar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, materialId: MATERIAL_ID });
    assert.equal(material2.id, MATERIAL_ID);
  });

  test('isolamento: material de outra empresa não é encontrado (404), nunca vaza existência', async (t) => {
    mundoValido(t);
    await esperarHttpError(
      servico.buscar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA_OUTRA, materialId: MATERIAL_ID }),
      404, 'MATERIAL_NAO_ENCONTRADO',
    );
  });
});

describe('listar', () => {
  test('devolve materiais, total, página e limite', async (t) => {
    mundoValido(t);
    const resultado = await servico.listar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, pagina: 2, limite: 10 });
    assert.equal(resultado.materiais.length, 1);
    assert.equal(resultado.total, 1);
    assert.equal(resultado.pagina, 2);
    assert.equal(resultado.limite, 10);
  });
});

describe('alterar', () => {
  test('altera e audita dados anteriores e novos, na mesma transação', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await servico.alterar(criarPoolFalso(cliente), {
      empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, nome: 'Botina reforçada',
    });

    assert.equal(escritas.atualizar.mock.calls[0].arguments[3].nome, 'Botina reforçada');
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'MATERIAL_ALTERADO');
    assert.equal(auditoria.dadosAnteriores.nome, 'Botina de segurança');
    assert.equal(auditoria.dadosNovos.nome, 'Botina reforçada');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('campo opcional null explícito com *Informado=true limpa o valor', async (t) => {
    const escritas = mundoValido(t);

    await servico.alterar(criarPoolFalso(criarClienteFalso()), {
      empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, tipo: null, tipoInformado: true,
    });

    assert.equal(escritas.atualizar.mock.calls[0].arguments[3].tipoInformado, true);
    assert.equal(escritas.atualizar.mock.calls[0].arguments[3].tipo, null);
  });

  test('nenhum campo informado: 400 MATERIAL_SEM_ALTERACAO, sem consultar o material', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.alterar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID }),
      400, 'MATERIAL_SEM_ALTERACAO',
    );
    assertRecusaSemRastro(cliente, escritas);
  });

  test('material inexistente nesta empresa: 404, ROLLBACK', async (t) => {
    const escritas = mundoValido(t, { existente: null });
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.alterar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, nome: 'X' }),
      404, 'MATERIAL_NAO_ENCONTRADO',
    );
    assertRecusaSemRastro(cliente, escritas);
  });
});

describe('inativar e reativar', () => {
  test('inativar material ativo: alterado=true, audita MATERIAL_INATIVADO', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const { material: atualizado, alterado } = await servico.inativar(criarPoolFalso(cliente), {
      empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID,
    });

    assert.equal(alterado, true);
    assert.equal(atualizado.ativo, false);
    assert.equal(escritas.registrar.mock.calls[0].arguments[1].acao, 'MATERIAL_INATIVADO');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('inativar material já inativo: idempotente, alterado=false, sem auditoria', async (t) => {
    const escritas = mundoValido(t, { existente: material({ ativo: false }) });
    const cliente = criarClienteFalso();

    const { alterado } = await servico.inativar(criarPoolFalso(cliente), {
      empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID,
    });

    assert.equal(alterado, false);
    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1, 'idempotência ainda commita (nada a reverter)');
  });

  test('reativar audita MATERIAL_REATIVADO', async (t) => {
    const escritas = mundoValido(t, { existente: material({ ativo: false }) });

    await servico.reativar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID });

    assert.equal(escritas.registrar.mock.calls[0].arguments[1].acao, 'MATERIAL_REATIVADO');
  });

  test('material inexistente nesta empresa: 404, ROLLBACK', async (t) => {
    const escritas = mundoValido(t, { existente: null });
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.inativar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID }),
      404, 'MATERIAL_NAO_ENCONTRADO',
    );
    assertRecusaSemRastro(cliente, escritas);
  });
});
