'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/material.service');
const materialRepo = require('../../src/repositories/material.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const loteRepo = require('../../src/repositories/estoque-lote.repository');
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
      empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina de segurança', prazoUsoDias: 180, exigeTamanho: true,
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

    await servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, nome: '   Botina de segurança   ', prazoUsoDias: 180, exigeTamanho: true });

    assert.equal(escritas.criar.mock.calls[0].arguments[1].nome, 'Botina de segurança');
  });

  test('campos de texto opcionais ausentes, nulos ou só espaços viram null', async (t) => {
    for (const tipo of [undefined, null, '   ']) {
      const escritas = mundoValido(t);
      await servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina', prazoUsoDias: 180, exigeTamanho: true, tipo });
      assert.equal(escritas.criar.mock.calls[0].arguments[1].tipo, null);
    }
  });

  test('unidade ausente assume "unidade"; estoqueMinimo ausente assume 0', async (t) => {
    const escritas = mundoValido(t);

    await servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina', prazoUsoDias: 180, exigeTamanho: true });

    assert.equal(escritas.criar.mock.calls[0].arguments[1].unidade, 'unidade');
    assert.equal(escritas.criar.mock.calls[0].arguments[1].estoqueMinimo, 0);
  });
});

describe('criar — recusas de validação: falham antes de abrir transação (fail fast, nenhuma conexão aberta), e ainda assim sem rastro', () => {
  test('nome vazio ou ausente: 400 MATERIAL_NOME_INVALIDO', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: '   ', prazoUsoDias: 180, exigeTamanho: true }),
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
        servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina', prazoUsoDias, exigeTamanho: true }),
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
      servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina', prazoUsoDias: 180, exigeTamanho: true, estoqueMinimo: -1 }),
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

describe('categoria, código interno e descrição — Parte C2', () => {
  test('criar normaliza os três (apara; vazio -> null), grava e audita os três', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();
    const r = await servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Luva', prazoUsoDias: 180, exigeTamanho: true, categoria: ' EPI ', codigoInterno: ' EPI-000245 ', descricao: '   ' });
    const dados = escritas.criar.mock.calls[0].arguments[1];
    assert.deepEqual([dados.categoria, dados.codigoInterno, dados.descricao], ['EPI', 'EPI-000245', null]);
    assert.deepEqual([r.categoria, r.codigoInterno], ['EPI', 'EPI-000245']);
    const auditado = escritas.registrar.mock.calls[0].arguments[1].dadosNovos;
    assert.deepEqual([auditado.categoria, auditado.codigoInterno, auditado.descricao], ['EPI', 'EPI-000245', null]);
  });

  test('violação do índice único do código interno (23505 uq_materiais_empresa_codigo_interno) vira 409 MATERIAL_CODIGO_INTERNO_DUPLICADO com ROLLBACK, em criar e em alterar', async (t) => {
    const escritas = mundoValido(t);
    const violacao = () => { const e = new Error('duplicate key'); e.code = '23505'; e.constraint = 'uq_materiais_empresa_codigo_interno'; throw e; };
    escritas.criar.mock.mockImplementation(async () => violacao());
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Luva', prazoUsoDias: 180, exigeTamanho: true, codigoInterno: 'EPI-1' }), 409, 'MATERIAL_CODIGO_INTERNO_DUPLICADO');
    assertRecusaSemRastro(cliente, escritas);

    escritas.atualizar.mock.mockImplementation(async () => violacao());
    const cliente2 = criarClienteFalso();
    await esperarHttpError(servico.alterar(criarPoolFalso(cliente2), { empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, codigoInterno: 'EPI-1', codigoInternoInformado: true }), 409, 'MATERIAL_CODIGO_INTERNO_DUPLICADO');
  });

  test('alterar: null explícito limpa o código interno via *Informado; acima do limite é 400', async (t) => {
    const escritas = mundoValido(t);
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, codigoInterno: null, codigoInternoInformado: true });
    const campos = escritas.atualizar.mock.calls[0].arguments[3];
    assert.deepEqual([campos.codigoInternoInformado, campos.codigoInterno], [true, null]);
    await esperarHttpError(servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'L', prazoUsoDias: 180, exigeTamanho: true, descricao: 'x'.repeat(501) }), 400, 'MATERIAL_DADOS_INVALIDOS');
  });
});

describe('alterar — unidade de controle imutável (ajuste pós-melhoria C2, 25/09/2026)', () => {
  test('unidade informada, mesmo igual à atual ou junto de outros campos: 400 MATERIAL_UNIDADE_NAO_EDITAVEL, sem abrir transação, sem gravar nem auditar', async (t) => {
    for (const extra of [{ unidade: 'caixa' }, { unidade: 'par' }, { unidade: 'caixa', nome: 'Botina nova' }]) {
      const escritas = mundoValido(t);
      const cliente = criarClienteFalso();
      await esperarHttpError(
        servico.alterar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, ...extra }),
        400, 'MATERIAL_UNIDADE_NAO_EDITAVEL',
      );
      assert.equal(contar(cliente.chamadas, /^BEGIN$/), 0, JSON.stringify(extra));
      assert.equal(escritas.atualizar.mock.calls.length, 0);
      assert.equal(escritas.registrar.mock.calls.length, 0);
    }
  });

  test('a edição nunca repassa unidade ao repositório', async (t) => {
    const escritas = mundoValido(t);
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, fabricante: '3M', fabricanteInformado: true });
    assert.equal(escritas.atualizar.mock.calls[0].arguments[3].unidade, null, 'null = manter a unidade atual');
  });
});

describe('prazo de uso obrigatório', () => {
  test('criar sem prazo, com null, zero ou negativo: 400 MATERIAL_DADOS_INVALIDOS antes de abrir transação', async (t) => {
    for (const prazoUsoDias of [undefined, null, 0, -30]) {
      const escritas = mundoValido(t);
      const cliente = criarClienteFalso();
      await esperarHttpError(
        servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina', prazoUsoDias, exigeTamanho: true }),
        400, 'MATERIAL_DADOS_INVALIDOS',
      );
      assert.equal(cliente.chamadas.length, 0, String(prazoUsoDias));
      assert.equal(escritas.criar.mock.calls.length, 0);
      assert.equal(escritas.registrar.mock.calls.length, 0);
    }
  });

  test('criar com prazo positivo grava o prazo informado', async (t) => {
    const escritas = mundoValido(t);
    await servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina', prazoUsoDias: 180, exigeTamanho: true });
    assert.equal(escritas.criar.mock.calls[0].arguments[1].prazoUsoDias, 180);
  });

  test('alterar para outro prazo positivo, para mais ou para menos, grava o prazo novo', async (t) => {
    for (const prazoUsoDias of [240, 90]) {
      const escritas = mundoValido(t);
      await servico.alterar(criarPoolFalso(criarClienteFalso()), {
        empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, prazoUsoDias, prazoUsoDiasInformado: true,
      });
      const campos = escritas.atualizar.mock.calls[0].arguments[3];
      assert.deepEqual([campos.prazoUsoDiasInformado, campos.prazoUsoDias], [true, prazoUsoDias]);
    }
  });

  test('alterar para null ou zero: 400 MATERIAL_DADOS_INVALIDOS com ROLLBACK, nada gravado', async (t) => {
    for (const prazoUsoDias of [null, 0]) {
      const escritas = mundoValido(t);
      const cliente = criarClienteFalso();
      await esperarHttpError(
        servico.alterar(criarPoolFalso(cliente), {
          empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, prazoUsoDias, prazoUsoDiasInformado: true,
        }),
        400, 'MATERIAL_DADOS_INVALIDOS',
      );
      assert.equal(escritas.atualizar.mock.calls.length, 0, String(prazoUsoDias));
      assertRecusaSemRastro(cliente, escritas);
    }
  });

  test('material legado sem prazo continua editável: alterar outro campo não mexe no prazo', async (t) => {
    const escritas = mundoValido(t, { existente: material({ prazoUsoDias: null }) });
    await servico.alterar(criarPoolFalso(criarClienteFalso()), {
      empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, nome: 'Botina reforçada',
    });
    assert.equal(escritas.atualizar.mock.calls[0].arguments[3].prazoUsoDiasInformado, false);
  });
});

describe('exige tamanho', () => {
  const novo = (extra) => ({ empresaId: EMPRESA, atorId: ATOR_ID, nome: 'Botina', prazoUsoDias: 180, ...extra });
  const alteracao = (extra) => ({ empresaId: EMPRESA, atorId: ATOR_ID, materialId: MATERIAL_ID, ...extra });
  const saldoIncompativel = (t, resposta) => t.mock.method(loteRepo, 'possuiSaldoIncompativel', async () => resposta);

  test('criar sem exigeTamanho, com null ou com valor que não é booleano: 400 MATERIAL_DADOS_INVALIDOS antes de abrir transação', async (t) => {
    for (const exigeTamanho of [undefined, null, 'sim']) {
      const escritas = mundoValido(t);
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.criar(criarPoolFalso(cliente), novo({ exigeTamanho })), 400, 'MATERIAL_DADOS_INVALIDOS');
      assert.equal(cliente.chamadas.length, 0, String(exigeTamanho));
      assert.equal(escritas.criar.mock.calls.length, 0);
    }
  });

  test('criar com true ou false grava a escolha e a audita', async (t) => {
    for (const exigeTamanho of [true, false]) {
      const escritas = mundoValido(t);
      await servico.criar(criarPoolFalso(criarClienteFalso()), novo({ exigeTamanho }));
      assert.equal(escritas.criar.mock.calls[0].arguments[1].exigeTamanho, exigeTamanho);
    }
  });

  test('legado sem classificação continua editável: alterar outro campo não mexe na classificação nem consulta saldo', async (t) => {
    const escritas = mundoValido(t, { existente: material({ exigeTamanho: null }) });
    const saldo = saldoIncompativel(t, true);
    await servico.alterar(criarPoolFalso(criarClienteFalso()), alteracao({ nome: 'Botina reforçada' }));
    assert.equal(escritas.atualizar.mock.calls[0].arguments[3].exigeTamanho, null, 'null = não mexer');
    assert.equal(saldo.mock.callCount(), 0);
  });

  test('primeira classificação do legado (NULL para true ou false) não depende do saldo', async (t) => {
    for (const exigeTamanho of [true, false]) {
      const escritas = mundoValido(t, { existente: material({ exigeTamanho: null }) });
      const saldo = saldoIncompativel(t, true);
      await servico.alterar(criarPoolFalso(criarClienteFalso()), alteracao({ exigeTamanho }));
      assert.equal(escritas.atualizar.mock.calls[0].arguments[3].exigeTamanho, exigeTamanho);
      assert.equal(saldo.mock.callCount(), 0);
    }
  });

  test('true para false ou false para true com saldo incompatível: 409 MATERIAL_TAMANHO_SALDO_INCOMPATIVEL, ROLLBACK, nada gravado', async (t) => {
    for (const [atual, novoValor] of [[true, false], [false, true]]) {
      const escritas = mundoValido(t, { existente: material({ exigeTamanho: atual }) });
      const saldo = saldoIncompativel(t, true);
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.alterar(criarPoolFalso(cliente), alteracao({ exigeTamanho: novoValor })), 409, 'MATERIAL_TAMANHO_SALDO_INCOMPATIVEL');
      assert.deepEqual(saldo.mock.calls[0].arguments.slice(1), [EMPRESA, MATERIAL_ID, novoValor]);
      assert.equal(escritas.atualizar.mock.calls.length, 0);
      assertRecusaSemRastro(cliente, escritas);
    }
  });

  test('mudança sem saldo incompatível é gravada; repetir o valor atual não consulta saldo', async (t) => {
    const escritas = mundoValido(t, { existente: material({ exigeTamanho: true }) });
    const saldo = saldoIncompativel(t, false);
    await servico.alterar(criarPoolFalso(criarClienteFalso()), alteracao({ exigeTamanho: false }));
    assert.equal(escritas.atualizar.mock.calls[0].arguments[3].exigeTamanho, false);
    assert.equal(saldo.mock.callCount(), 1);

    const mesmo = mundoValido(t, { existente: material({ exigeTamanho: true }) });
    const semConsulta = saldoIncompativel(t, true);
    await servico.alterar(criarPoolFalso(criarClienteFalso()), alteracao({ exigeTamanho: true }));
    assert.equal(mesmo.atualizar.mock.calls[0].arguments[3].exigeTamanho, true);
    assert.equal(semConsulta.mock.callCount(), 0);
  });

  test('alterar para null: 400 MATERIAL_DADOS_INVALIDOS, a classificação não pode ser desfeita', async (t) => {
    const escritas = mundoValido(t, { existente: material({ exigeTamanho: true }) });
    await esperarHttpError(servico.alterar(criarPoolFalso(criarClienteFalso()), alteracao({ exigeTamanho: null })), 400, 'MATERIAL_DADOS_INVALIDOS');
    assert.equal(escritas.atualizar.mock.calls.length, 0);
  });
});
