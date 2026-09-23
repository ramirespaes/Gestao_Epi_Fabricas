'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/grupo-homogeneo-exposicao.service');
const gheRepo = require('../../src/repositories/grupo-homogeneo-exposicao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/** Serviço de GHE (Bloco 9, Etapa B), sem PostgreSQL. Nenhuma decisão de autorização aqui. */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const ATOR_ID = 7;
const GHE_ID = 50;

const ghe = (extra = {}) => ({
  id: GHE_ID, empresaId: EMPRESA, nome: 'Manutenção — Mecânicos', descricao: null, setor: 'Manutenção',
  funcao: 'Mecânico', riscos: null, ativo: true, criadoEm: new Date('2026-09-23T12:00:00Z'), atualizadoEm: new Date('2026-09-23T12:00:00Z'), ...extra,
});

function criarClienteFalso() {
  const chamadas = [];
  return { chamadas, query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; }, release: () => { chamadas.push('RELEASE'); } };
}
const criarPoolFalso = (cliente) => ({ connect: async () => cliente, query: (...args) => cliente.query(...args) });
const contar = (chamadas, padrao) => chamadas.filter((c) => padrao.test(c)).length;

function mundoValido(t, { existente = ghe() } = {}) {
  const localizar = async (_c, empresaId, id) => (empresaId === EMPRESA && existente && id === existente.id ? existente : null);
  t.mock.method(gheRepo, 'buscarPorIdParaAtualizacao', localizar);
  t.mock.method(gheRepo, 'buscarPorId', localizar);
  t.mock.method(gheRepo, 'listarPorEmpresa', async () => [existente].filter(Boolean));
  t.mock.method(gheRepo, 'contarPorEmpresa', async () => (existente ? 1 : 0));
  return {
    criar: t.mock.method(gheRepo, 'criar', async (_c, dados) => ghe({ ...dados })),
    atualizar: t.mock.method(gheRepo, 'atualizar', async (_c, _e, _id, campos) => ghe({
      nome: campos.nome ?? existente.nome, setor: campos.setorInformado ? campos.setor : existente.setor, ativo: campos.ativo ?? existente.ativo,
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

describe('criar', () => {
  test('cria e audita GHE_CRIADO na mesma transação; nome aparado; opcionais vazios viram null', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const resultado = await servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: '  Manutenção — Mecânicos  ', riscos: '   ' });

    assert.equal(resultado.id, GHE_ID);
    assert.equal(escritas.criar.mock.calls[0].arguments[1].nome, 'Manutenção — Mecânicos');
    assert.equal(escritas.criar.mock.calls[0].arguments[1].riscos, null);
    assert.equal(escritas.registrar.mock.calls[0].arguments[1].acao, 'GHE_CRIADO');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('nome vazio: 400 GHE_NOME_INVALIDO antes de abrir transação', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: '  ' }), 400, 'GHE_NOME_INVALIDO');
    assert.equal(cliente.chamadas.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
  });

  test('nome já usado nesta empresa (UNIQUE): 409 GHE_NOME_EM_USO, ROLLBACK, sem auditoria', async (t) => {
    const escritas = mundoValido(t);
    escritas.criar.mock.mockImplementation(async () => { throw Object.assign(new Error('dup'), { code: '23505' }); });
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, nome: 'X' }), 409, 'GHE_NOME_EM_USO');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
    assert.equal(escritas.registrar.mock.calls.length, 0);
  });
});

describe('buscar e listar', () => {
  test('isolamento: GHE de outra empresa é 404', async (t) => {
    mundoValido(t);
    await esperarHttpError(servico.buscar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA_OUTRA, gheId: GHE_ID }), 404, 'GHE_NAO_ENCONTRADO');
  });

  test('listar devolve grupos, total, página e limite', async (t) => {
    mundoValido(t);
    const r = await servico.listar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, pagina: 2, limite: 5 });
    assert.equal(r.grupos.length, 1);
    assert.deepEqual([r.total, r.pagina, r.limite], [1, 2, 5]);
  });
});

describe('alterar, inativar e reativar', () => {
  test('altera e audita anterior/novo', async (t) => {
    const escritas = mundoValido(t);
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, gheId: GHE_ID, setor: null, setorInformado: true });
    assert.equal(escritas.atualizar.mock.calls[0].arguments[3].setorInformado, true);
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'GHE_ALTERADO');
    assert.equal(auditoria.dadosAnteriores.setor, 'Manutenção');
    assert.equal(auditoria.dadosNovos.setor, null);
  });

  test('nenhum campo: 400 GHE_SEM_ALTERACAO', async (t) => {
    mundoValido(t);
    await esperarHttpError(servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, gheId: GHE_ID }), 400, 'GHE_SEM_ALTERACAO');
  });

  test('inativar é idempotente e não desvincula funcionários (nenhuma escrita além do próprio GHE)', async (t) => {
    const escritas = mundoValido(t);
    const primeiro = await servico.inativar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, gheId: GHE_ID });
    assert.equal(primeiro.alterado, true);
    assert.equal(escritas.registrar.mock.calls[0].arguments[1].acao, 'GHE_INATIVADO');
    assert.equal(escritas.atualizar.mock.calls.length, 1, 'uma única escrita: a do próprio GHE');

    const repetido = mundoValido(t, { existente: ghe({ ativo: false }) });
    const segundo = await servico.inativar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, gheId: GHE_ID });
    assert.equal(segundo.alterado, false);
    assert.equal(repetido.registrar.mock.calls.length, 0);
  });

  test('reativar audita GHE_REATIVADO; inexistente é 404 com ROLLBACK', async (t) => {
    const escritas = mundoValido(t, { existente: ghe({ ativo: false }) });
    await servico.reativar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, gheId: GHE_ID });
    assert.equal(escritas.registrar.mock.calls[0].arguments[1].acao, 'GHE_REATIVADO');

    mundoValido(t, { existente: null });
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.reativar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, gheId: GHE_ID }), 404, 'GHE_NAO_ENCONTRADO');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });
});
