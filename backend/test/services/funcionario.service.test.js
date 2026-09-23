'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/funcionario.service');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');
const gheRepo = require('../../src/repositories/grupo-homogeneo-exposicao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Serviço de funcionários (Bloco 9, Etapa B), sem PostgreSQL. Pontos
 * centrais: CPF validado por DV e persistido só com dígitos; vínculo só a
 * GHE existente e ativo da mesma empresa; matrícula/CPF duplicados
 * distinguidos pela constraint; CPF/nascimento/telefone NUNCA na
 * auditoria; nenhuma leitura ou escrita em `usuarios`.
 */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const ATOR_ID = 7;
const FUNC_ID = 70;
const GHE_ATIVO = 50;
const GHE_INATIVO = 51;

const funcionario = (extra = {}) => ({
  id: FUNC_ID, empresaId: EMPRESA, grupoHomogeneoId: GHE_ATIVO, matricula: 'MAT-000171', nome: 'Marcos Silva',
  cpf: '52998224725', dataNascimento: '1990-03-15', setor: 'Manutenção', funcao: 'Mecânico', cracha: 'CR-001284',
  telefone: '47999990000', ativo: true, criadoEm: new Date('2026-09-23T12:00:00Z'), atualizadoEm: new Date('2026-09-23T12:00:00Z'), ...extra,
});

function criarClienteFalso() {
  const chamadas = [];
  return { chamadas, query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; }, release: () => { chamadas.push('RELEASE'); } };
}
const criarPoolFalso = (cliente) => ({ connect: async () => cliente, query: (...args) => cliente.query(...args) });
const contar = (chamadas, padrao) => chamadas.filter((c) => padrao.test(c)).length;

function mundoValido(t, { existente = funcionario() } = {}) {
  const localizar = async (_c, empresaId, id) => (empresaId === EMPRESA && existente && id === existente.id ? existente : null);
  t.mock.method(funcionarioRepo, 'buscarPorIdParaAtualizacao', localizar);
  t.mock.method(funcionarioRepo, 'buscarPorId', localizar);
  t.mock.method(funcionarioRepo, 'listarPorEmpresa', async () => [existente].filter(Boolean));
  t.mock.method(funcionarioRepo, 'contarPorEmpresa', async () => (existente ? 1 : 0));
  const ghes = { [GHE_ATIVO]: { id: GHE_ATIVO, empresaId: EMPRESA, ativo: true }, [GHE_INATIVO]: { id: GHE_INATIVO, empresaId: EMPRESA, ativo: false } };
  // Correção pós-auditoria da Etapa B: a verificação do GHE para vínculo
  // usa a leitura TRAVADA (buscarPorIdParaVinculo, FOR SHARE), nunca a
  // leitura sem lock (buscarPorId) — esta última fica mockada só para
  // comprovar que não é chamada.
  const buscarGhe = t.mock.method(gheRepo, 'buscarPorIdParaVinculo', async (_c, empresaId, id) => (empresaId === EMPRESA ? (ghes[id] ?? null) : null));
  t.mock.method(gheRepo, 'buscarPorId', async () => { throw new Error('vínculo não pode usar leitura sem lock (buscarPorId)'); });
  return {
    buscarGhe,
    criar: t.mock.method(funcionarioRepo, 'criar', async (_c, dados) => funcionario({ ...dados })),
    atualizar: t.mock.method(funcionarioRepo, 'atualizar', async (_c, _e, _id, campos) => funcionario({
      nome: campos.nome ?? existente.nome, cpf: existente.cpf, telefone: campos.telefoneInformado ? campos.telefone : existente.telefone,
      grupoHomogeneoId: campos.grupoHomogeneoIdInformado ? campos.grupoHomogeneoId : existente.grupoHomogeneoId,
      ativo: campos.ativo ?? existente.ativo,
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

const base = { empresaId: EMPRESA, atorId: ATOR_ID, matricula: 'MAT-000171', nome: 'Marcos Silva', cpf: '529.982.247-25' };

function assertSemDadosSensiveis(auditoria) {
  for (const chave of ['cpf', 'dataNascimento', 'telefone']) {
    assert.ok(!(auditoria.dadosNovos && chave in auditoria.dadosNovos), `${chave} não pode estar em dadosNovos`);
    assert.ok(!(auditoria.dadosAnteriores && chave in auditoria.dadosAnteriores), `${chave} não pode estar em dadosAnteriores`);
  }
  assert.ok(!JSON.stringify(auditoria).includes('52998224725'), 'o CPF em si nunca aparece na auditoria');
}

describe('criar', () => {
  test('CPF com máscara é normalizado e validado; cria, audita FUNCIONARIO_CRIADO sem dados sensíveis, commita', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const r = await servico.criar(criarPoolFalso(cliente), { ...base, grupoHomogeneoId: GHE_ATIVO, telefone: '47999990000' });

    assert.equal(r.id, FUNC_ID);
    assert.equal(escritas.criar.mock.calls[0].arguments[1].cpf, '52998224725');
    assert.equal(escritas.buscarGhe.mock.calls.length, 1, 'GHE informado é verificado');
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'FUNCIONARIO_CRIADO');
    assertSemDadosSensiveis(auditoria);
    assert.deepEqual(auditoria.contexto.camposSensiveisOmitidos, ['cpf', 'dataNascimento', 'telefone']);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('sem GHE não consulta o repositório de GHE', async (t) => {
    const escritas = mundoValido(t);
    await servico.criar(criarPoolFalso(criarClienteFalso()), base);
    assert.equal(escritas.buscarGhe.mock.calls.length, 0);
  });

  test('CPF com DV inválido ou sequência repetida: 400 FUNCIONARIO_CPF_INVALIDO antes de abrir transação', async (t) => {
    mundoValido(t);
    for (const cpf of ['529.982.247-26', '11111111111', '123']) {
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.criar(criarPoolFalso(cliente), { ...base, cpf }), 400, 'FUNCIONARIO_CPF_INVALIDO');
      assert.equal(cliente.chamadas.length, 0);
    }
  });

  test('matrícula ou nome vazios: 400 específicos', async (t) => {
    mundoValido(t);
    await esperarHttpError(servico.criar(criarPoolFalso(criarClienteFalso()), { ...base, matricula: '  ' }), 400, 'FUNCIONARIO_MATRICULA_INVALIDA');
    await esperarHttpError(servico.criar(criarPoolFalso(criarClienteFalso()), { ...base, nome: '' }), 400, 'FUNCIONARIO_NOME_INVALIDO');
  });

  test('GHE inexistente nesta empresa: 400 FUNCIONARIO_GHE_INVALIDO; GHE inativo: 409 FUNCIONARIO_GHE_INATIVO — ROLLBACK, nada gravado', async (t) => {
    const escritas = mundoValido(t);
    const inexistente = criarClienteFalso();
    await esperarHttpError(servico.criar(criarPoolFalso(inexistente), { ...base, grupoHomogeneoId: 999 }), 400, 'FUNCIONARIO_GHE_INVALIDO');
    assert.equal(contar(inexistente.chamadas, /^ROLLBACK$/), 1);

    const inativo = criarClienteFalso();
    await esperarHttpError(servico.criar(criarPoolFalso(inativo), { ...base, grupoHomogeneoId: GHE_INATIVO }), 409, 'FUNCIONARIO_GHE_INATIVO');
    assert.equal(contar(inativo.chamadas, /^ROLLBACK$/), 1);
    assert.equal(escritas.criar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
  });

  test('duplicidade distinguida pela constraint: matrícula → 409 MATRICULA_EM_USO; CPF → 409 CPF_EM_USO; FK → 400 GHE_INVALIDO', async (t) => {
    const casos = [
      ['uq_funcionarios_empresa_matricula', '23505', 409, 'FUNCIONARIO_MATRICULA_EM_USO'],
      ['uq_funcionarios_empresa_cpf', '23505', 409, 'FUNCIONARIO_CPF_EM_USO'],
      ['fk_funcionarios_ghe_mesma_empresa', '23503', 400, 'FUNCIONARIO_GHE_INVALIDO'],
    ];
    for (const [constraint, code, status, codigo] of casos) {
      const escritas = mundoValido(t);
      escritas.criar.mock.mockImplementation(async () => { throw Object.assign(new Error('violação'), { code, constraint }); });
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.criar(criarPoolFalso(cliente), base), status, codigo);
      assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
      assert.equal(escritas.registrar.mock.calls.length, 0);
    }
  });
});

describe('buscar e listar', () => {
  test('isolamento: funcionário de outra empresa é 404', async (t) => {
    mundoValido(t);
    await esperarHttpError(servico.buscar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA_OUTRA, funcionarioId: FUNC_ID }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
  });

  test('listar repassa filtro por GHE e devolve total/página/limite', async (t) => {
    const escritas = mundoValido(t);
    const r = await servico.listar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, grupoHomogeneoId: GHE_ATIVO, pagina: 1, limite: 10 });
    assert.equal(r.funcionarios.length, 1);
    assert.equal(r.total, 1);
    assert.equal(funcionarioRepo.listarPorEmpresa.mock.calls[0].arguments[2].grupoHomogeneoId, GHE_ATIVO);
    assert.ok(escritas);
  });
});

describe('alterar', () => {
  test('troca de GHE verifica o novo GHE; audita anterior/novo sem dados sensíveis', async (t) => {
    const escritas = mundoValido(t, { existente: funcionario({ grupoHomogeneoId: null }) });
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, grupoHomogeneoId: GHE_ATIVO, grupoHomogeneoIdInformado: true });
    assert.equal(escritas.buscarGhe.mock.calls.length, 1);
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'FUNCIONARIO_ALTERADO');
    assert.equal(auditoria.dadosAnteriores.grupoHomogeneoId, null);
    assert.equal(auditoria.dadosNovos.grupoHomogeneoId, GHE_ATIVO);
    assertSemDadosSensiveis(auditoria);
  });

  test('desvincular (grupoHomogeneoId null) não consulta GHE; manter o mesmo GHE também não', async (t) => {
    const escritas = mundoValido(t);
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, grupoHomogeneoId: null, grupoHomogeneoIdInformado: true });
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, grupoHomogeneoId: GHE_ATIVO, grupoHomogeneoIdInformado: true });
    assert.equal(escritas.buscarGhe.mock.calls.length, 0);
  });

  test('troca para GHE inativo: 409 FUNCIONARIO_GHE_INATIVO', async (t) => {
    mundoValido(t);
    await esperarHttpError(
      servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, grupoHomogeneoId: GHE_INATIVO, grupoHomogeneoIdInformado: true }),
      409, 'FUNCIONARIO_GHE_INATIVO',
    );
  });

  test('CPF imutável: alterar NÃO aceita cpf — igual, diferente, inválido, null ou undefined EXPLÍCITO é erro de programação (TypeError), sem transação, sem escrita, sem auditoria', async (t) => {
    const escritas = mundoValido(t);
    // 'undefined' aqui vira cpf: undefined como PROPRIEDADE PRÓPRIA do objeto
    // literal (shorthand `{ cpf }` sempre cria a chave, mesmo quando o valor
    // é undefined) — é exatamente o caso que Object.hasOwn(dados, 'cpf')
    // precisa reconhecer e que uma checagem `cpf !== undefined` sobre o
    // valor já desestruturado NÃO reconheceria (correção pós-auditoria
    // independente de 23/09/2026).
    for (const cpf of ['52998224725', '529.982.247-25', '111.444.777-35', '00000000000', null, undefined]) {
      const dados = { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, nome: 'Marcos S.', cpf };
      assert.ok(Object.hasOwn(dados, 'cpf'), 'pré-condição do teste: a chave cpf precisa estar presente no objeto');
      const cliente = criarClienteFalso();
      await assert.rejects(
        servico.alterar(criarPoolFalso(cliente), dados),
        (erro) => erro instanceof TypeError && !HttpError.ehHttpError(erro) && /cpf/i.test(erro.message),
        String(cpf),
      );
      assert.equal(cliente.chamadas.length, 0, 'nenhum BEGIN: recusado antes da transação');
    }
    assert.equal(escritas.atualizar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
  });

  test('CPF imutável: cpf: undefined explícito é recusado mesmo isolado (sem outro campo), antes de qualquer leitura do funcionário', async (t) => {
    const escritas = mundoValido(t);
    const dados = { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, cpf: undefined };
    assert.ok(Object.hasOwn(dados, 'cpf'));
    await assert.rejects(
      servico.alterar(criarPoolFalso(criarClienteFalso()), dados),
      (erro) => erro instanceof TypeError && /cpf/i.test(erro.message),
    );
    assert.equal(escritas.atualizar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
    // buscarPorIdParaAtualizacao é chamado DENTRO da transação; sem transação, não é chamado.
    assert.equal(funcionarioRepo.buscarPorIdParaAtualizacao.mock.calls.length, 0);
  });

  test('campo sensível alterado (telefone) é registrado só pelo nome; o repositório nunca recebe chave cpf e "cpf" nunca entra em camposSensiveisAlterados', async (t) => {
    const escritas = mundoValido(t);
    const auditorias = [];
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, telefone: '47988887777', telefoneInformado: true });
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, nome: 'Marcos S.', dataNascimento: '1990-03-16', dataNascimentoInformado: true });
    for (const chamada of escritas.atualizar.mock.calls) {
      assert.ok(!Object.hasOwn(chamada.arguments[3], 'cpf'), 'atualizar não recebe cpf nem como null');
    }
    for (const chamada of escritas.registrar.mock.calls) {
      auditorias.push(chamada.arguments[1]);
    }
    assert.deepEqual(auditorias.map((a) => a.contexto.camposSensiveisAlterados), [['telefone'], ['dataNascimento']]);
    assert.ok(!JSON.stringify(auditorias).includes('47988887777'));
    for (const a of auditorias) assertSemDadosSensiveis(a);
  });

  test('nenhum campo: 400 FUNCIONARIO_SEM_ALTERACAO', async (t) => {
    mundoValido(t);
    await esperarHttpError(servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID }), 400, 'FUNCIONARIO_SEM_ALTERACAO');
  });
});

describe('inativar e reativar', () => {
  test('inativar audita FUNCIONARIO_INATIVADO; repetido é idempotente sem auditoria; reativar audita FUNCIONARIO_REATIVADO', async (t) => {
    const escritas = mundoValido(t);
    const r = await servico.inativar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID });
    assert.equal(r.alterado, true);
    assert.equal(escritas.registrar.mock.calls[0].arguments[1].acao, 'FUNCIONARIO_INATIVADO');
    assertSemDadosSensiveis(escritas.registrar.mock.calls[0].arguments[1]);

    const repetido = mundoValido(t, { existente: funcionario({ ativo: false }) });
    const r2 = await servico.inativar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID });
    assert.equal(r2.alterado, false);
    assert.equal(repetido.registrar.mock.calls.length, 0);

    const reativado = mundoValido(t, { existente: funcionario({ ativo: false }) });
    await servico.reativar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID });
    assert.equal(reativado.registrar.mock.calls[0].arguments[1].acao, 'FUNCIONARIO_REATIVADO');
  });

  test('inexistente nesta empresa: 404 com ROLLBACK', async (t) => {
    mundoValido(t, { existente: null });
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.inativar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });
});
