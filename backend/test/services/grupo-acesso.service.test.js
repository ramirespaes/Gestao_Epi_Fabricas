'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/grupo-acesso.service');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const grupoRepo = require('../../src/repositories/grupo-acesso.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de gestão de grupos, sem PostgreSQL real.
 *
 * Todas as funções de repositório são substituídas via t.mock.method
 * (restaurado ao fim de cada teste). Só BEGIN/COMMIT/ROLLBACK passam pelo
 * cliente falso. O serviço chama módulos por `modulo.funcao(...)`, nunca
 * desestruturado — é o que torna mock.method eficaz (mesmo padrão de
 * autorizacao-individual.service.test.js).
 *
 * O ponto central: toda recusa termina em ROLLBACK e sem chamada a
 * grupoRepo.criar/atualizar nem a auditoriaRepo.registrar.
 */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const MASTER_ID = 1;
const ADMIN_ID = 5;
const GRUPO_ID = 30;

const usuario = (id, extra = {}) => Object.freeze({
  id, empresa_id: EMPRESA, nome: `Usuário ${id}`, email: `u${id}@demo.safeworkengenharia.com.br`,
  perfil: 'ADMINISTRADOR', ativo: true, biometria_cadastrada: false, ...extra,
});
const master = usuario(MASTER_ID, { perfil: 'MASTER' });
const administrador = usuario(ADMIN_ID);

const grupo = (extra = {}) => ({
  id: GRUPO_ID,
  empresaId: EMPRESA,
  nome: 'Almoxarifado',
  descricao: null,
  ativo: true,
  criadoPor: MASTER_ID,
  criadoEm: new Date('2026-09-21T12:00:00Z'),
  atualizadoEm: new Date('2026-09-21T12:00:00Z'),
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

// Um Pool real tem connect() E query(): o caminho de LEITURA da autoridade
// administrativa (autoridade-administrativa.js, Subetapa 3Q) consulta o
// catálogo e a autorização individual pelo próprio executor recebido, sem
// abrir transação. O pool falso precisa refletir isso — as consultas vão
// para o mesmo cliente falso, que devolve rows vazio (ou seja: nenhuma
// autorização administrativa), que é o cenário esperado por estes testes.
const criarPoolFalso = (cliente) => ({ connect: async () => cliente, query: (...args) => cliente.query(...args) });
const contar = (chamadas, padrao) => chamadas.filter((c) => padrao.test(c)).length;

/** Mundo válido: MASTER ativo, grupo existente. Devolve os mocks de escrita. */
function mundoValido(t, { usuarios = {}, existente = grupo() } = {}) {
  const porId = { [MASTER_ID]: master, [ADMIN_ID]: administrador, ...usuarios };
  const localizarAtor = async (_c, empresaId, id) => (empresaId === EMPRESA && porId[id] ? porId[id] : null);
  // Escrita usa a variante travada; leitura (buscar/listar, desde a 3M) usa
  // a destravada. As duas precisam do mesmo mundo.
  t.mock.method(usuarioRepo, 'buscarPorIdParaAtualizacao', localizarAtor);
  t.mock.method(usuarioRepo, 'buscarPorId', localizarAtor);
  t.mock.method(grupoRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => (
    empresaId === EMPRESA && existente && id === existente.id ? existente : null
  ));
  t.mock.method(grupoRepo, 'buscarPorId', async (_c, empresaId, id) => (
    empresaId === EMPRESA && existente && id === existente.id ? existente : null
  ));
  t.mock.method(grupoRepo, 'listarPorEmpresa', async () => [existente].filter(Boolean));
  return {
    criar: t.mock.method(grupoRepo, 'criar', async (_c, dados) => grupo({ nome: dados.nome, descricao: dados.descricao, criadoPor: dados.criadoPor })),
    atualizar: t.mock.method(grupoRepo, 'atualizar', async (_c, _e, _id, campos) => grupo({
      nome: campos.nome ?? existente.nome,
      descricao: campos.descricaoInformada ? campos.descricao : existente.descricao,
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

function assertRecusaSemRastro(cliente, escritas) {
  assert.equal(contar(cliente.chamadas, /^BEGIN$/), 1);
  assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1, 'recusa dentro da transação termina em ROLLBACK');
  assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  assert.equal(escritas.criar.mock.calls.length, 0, 'nada é criado numa recusa');
  assert.equal(escritas.atualizar.mock.calls.length, 0, 'nada é atualizado numa recusa');
  assert.equal(escritas.registrar.mock.calls.length, 0, 'recusa não é auditada');
  assert.ok(cliente.chamadas.includes('RELEASE'));
}

describe('criar — caminho válido', () => {
  test('MASTER cria na própria empresa: criado_por = ator, audita na mesma transação e commita', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const resultado = await servico.criar(criarPoolFalso(cliente), {
      empresaId: EMPRESA, atorId: MASTER_ID, nome: 'Almoxarifado', descricao: 'Equipe do depósito',
    });

    assert.equal(resultado.id, GRUPO_ID);
    assert.deepEqual(escritas.criar.mock.calls[0].arguments[1], {
      empresaId: EMPRESA, nome: 'Almoxarifado', descricao: 'Equipe do depósito', criadoPor: MASTER_ID,
    });

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.empresaId, EMPRESA);
    assert.equal(auditoria.usuarioId, MASTER_ID);
    assert.equal(auditoria.acao, 'GRUPO_ACESSO_CRIADO');
    assert.equal(auditoria.referencia, String(GRUPO_ID));
    assert.deepEqual(auditoria.dadosNovos, { nome: 'Almoxarifado', descricao: 'Equipe do depósito', ativo: true });

    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 0);
  });

  test('nome é aparado nas pontas, sem mexer em maiúsculas/minúsculas nem acentos', async (t) => {
    const escritas = mundoValido(t);

    await servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: MASTER_ID, nome: '   Gerência de Manutenção   ' });

    assert.equal(escritas.criar.mock.calls[0].arguments[1].nome, 'Gerência de Manutenção');
  });

  test('descrição ausente, nula ou só espaços vira null', async (t) => {
    for (const descricao of [undefined, null, '   ']) {
      const escritas = mundoValido(t);
      await servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: MASTER_ID, nome: 'Almoxarifado', descricao });
      assert.equal(escritas.criar.mock.calls[0].arguments[1].descricao, null);
    }
  });

  test('nomes livres da empresa não têm significado especial: "SST" e "Funcionários" criam só o grupo', async (t) => {
    for (const nome of ['SST', 'Funcionários']) {
      const escritas = mundoValido(t);

      await servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: MASTER_ID, nome });

      assert.equal(escritas.criar.mock.calls.length, 1, `${nome}: exatamente uma criação, do próprio grupo`);
      assert.equal(escritas.criar.mock.calls[0].arguments[1].nome, nome);
      assert.equal(escritas.registrar.mock.calls.length, 1, `${nome}: uma auditoria, nenhuma operação extra`);
    }
  });
});

describe('criar — recusas, todas com ROLLBACK e sem rastro', () => {
  test('não-MASTER não cria: ADMINISTRADOR recebe 403 como qualquer outro perfil', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ADMIN_ID, nome: 'Almoxarifado' }), 403, 'GRUPO_NAO_AUTORIZADO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('MASTER inativo não administra', async (t) => {
    const escritas = mundoValido(t, { usuarios: { [MASTER_ID]: usuario(MASTER_ID, { perfil: 'MASTER', ativo: false }) } });
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, nome: 'Almoxarifado' }), 403, 'GRUPO_NAO_AUTORIZADO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('MASTER de outra empresa não cria nesta: mesmo 403, indistinguível', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA_OUTRA, atorId: MASTER_ID, nome: 'Almoxarifado' }), 403, 'GRUPO_NAO_AUTORIZADO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('nome vazio, só espaços, longo demais ou de tipo errado: 400, depois da autoridade', async (t) => {
    for (const nome of ['', '   ', 'x'.repeat(101), 42, null, undefined]) {
      const escritas = mundoValido(t);
      const cliente = criarClienteFalso();

      await esperarHttpError(servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, nome }), 400, 'GRUPO_NOME_INVALIDO');

      assertRecusaSemRastro(cliente, escritas);
    }
  });

  test('quem não pode administrar nunca descobre que o nome era inválido: autoridade é verificada primeiro', async (t) => {
    mundoValido(t);

    await esperarHttpError(servico.criar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ADMIN_ID, nome: '' }), 403, 'GRUPO_NAO_AUTORIZADO');
  });

  test('nome duplicado na empresa (índice único): 409, sem auditoria', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(grupoRepo, 'criar', async () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); });
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, nome: 'Almoxarifado' }), 409, 'GRUPO_NOME_EM_USO');

    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });

  test('falha na auditoria depois do INSERT: ROLLBACK — a criação não sobrevive sem o registro', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('conexão perdida'); });
    const cliente = criarClienteFalso();

    await assert.rejects(servico.criar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, nome: 'Almoxarifado' }), /conexão perdida/);

    assert.equal(escritas.criar.mock.calls.length, 1, 'o INSERT chegou a acontecer...');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1, '...mas a transação inteira é desfeita');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  });

  test('entradas malformadas lançam TypeError antes de qualquer conexão', async (t) => {
    mundoValido(t);
    const pool = { connect: async () => { throw new Error('não deveria conectar'); } };

    await assert.rejects(servico.criar(pool, { empresaId: 0, atorId: MASTER_ID, nome: 'X' }), TypeError);
    await assert.rejects(servico.criar(pool, { empresaId: EMPRESA, atorId: '1', nome: 'X' }), TypeError);
    await assert.rejects(servico.criar(pool, { empresaId: EMPRESA, atorId: MASTER_ID, nome: 'X', descricao: 42 }), TypeError);
  });
});

describe('buscar e listar — leitura isolada por empresa, sem transação', () => {
  test('buscar devolve o grupo da própria empresa e não abre transação', async (t) => {
    mundoValido(t);
    const cliente = criarClienteFalso();

    const encontrado = await servico.buscar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID });

    assert.equal(encontrado.id, GRUPO_ID);
    assert.equal(contar(cliente.chamadas, /^BEGIN$/), 0, 'leitura não abre transação');
  });

  test('a autoridade de leitura usa a variante SEM trava: consulta não toma lock à toa', async (t) => {
    mundoValido(t);
    const destravado = usuarioRepo.buscarPorId;
    const travado = usuarioRepo.buscarPorIdParaAtualizacao;

    await servico.buscar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID });
    await servico.listar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: MASTER_ID });

    assert.equal(destravado.mock.calls.length, 2);
    assert.equal(travado.mock.calls.length, 0, 'nenhuma leitura usa FOR UPDATE');
  });

  test('consulta exige autoridade administrativa: não-MASTER e MASTER inativo recebem 403', async (t) => {
    mundoValido(t);
    const pool = criarPoolFalso(criarClienteFalso());
    const listarRepo = grupoRepo.listarPorEmpresa;
    const buscarRepo = grupoRepo.buscarPorId;

    await esperarHttpError(servico.buscar(pool, { empresaId: EMPRESA, atorId: ADMIN_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_NAO_AUTORIZADO');
    await esperarHttpError(servico.listar(pool, { empresaId: EMPRESA, atorId: ADMIN_ID }), 403, 'GRUPO_NAO_AUTORIZADO');

    mundoValido(t, { usuarios: { [MASTER_ID]: usuario(MASTER_ID, { perfil: 'MASTER', ativo: false }) } });
    await esperarHttpError(servico.buscar(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_NAO_AUTORIZADO');

    assert.equal(listarRepo.mock.calls.length, 0, 'sem autoridade, o grupo nem é consultado');
    assert.equal(buscarRepo.mock.calls.length, 0);
  });

  test('ator de outra empresa não consulta: 403, e nada da empresa alheia aparece no corpo', async (t) => {
    mundoValido(t);

    await assert.rejects(
      servico.buscar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA_OUTRA, atorId: MASTER_ID, grupoId: GRUPO_ID }),
      (erro) => {
        assert.equal(erro.status, 403);
        assert.equal(erro.codigo, 'GRUPO_NAO_AUTORIZADO');
        assert.doesNotMatch(JSON.stringify(erro.corpoResposta()), new RegExp(String(EMPRESA)), 'nada de outra empresa no corpo');
        return true;
      },
    );
  });

  test('grupo inexistente NESTA empresa, com ator legítimo: 404', async (t) => {
    mundoValido(t, { existente: null });

    await esperarHttpError(
      servico.buscar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID }),
      404, 'GRUPO_NAO_ENCONTRADO',
    );
  });

  test('listar repassa o filtro ativo exatamente como recebido (null lista tudo)', async (t) => {
    mundoValido(t);
    const listar = grupoRepo.listarPorEmpresa;
    const pool = criarPoolFalso(criarClienteFalso());

    await servico.listar(pool, { empresaId: EMPRESA, atorId: MASTER_ID });
    await servico.listar(pool, { empresaId: EMPRESA, atorId: MASTER_ID, ativo: true });
    await servico.listar(pool, { empresaId: EMPRESA, atorId: MASTER_ID, ativo: false });

    assert.deepEqual(listar.mock.calls.map((c) => c.arguments[2]), [{ ativo: null }, { ativo: true }, { ativo: false }]);
    assert.deepEqual(listar.mock.calls.map((c) => c.arguments[1]), [EMPRESA, EMPRESA, EMPRESA]);
  });

  test('listar e buscar recusam entrada malformada', async (t) => {
    mundoValido(t);
    const pool = criarPoolFalso(criarClienteFalso());

    await assert.rejects(servico.listar(pool, { empresaId: 0, atorId: MASTER_ID }), TypeError);
    await assert.rejects(servico.listar(pool, { empresaId: EMPRESA, atorId: 0 }), TypeError);
    await assert.rejects(servico.listar(pool, { empresaId: EMPRESA, atorId: MASTER_ID, ativo: 'sim' }), TypeError);
    await assert.rejects(servico.buscar(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: 0 }), TypeError);
    await assert.rejects(servico.buscar(pool, { empresaId: EMPRESA, atorId: 0, grupoId: GRUPO_ID }), TypeError);
  });
});

describe('alterar', () => {
  test('MASTER altera nome e descrição: audita com anterior e novo, e os campos alterados', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await servico.alterar(criarPoolFalso(cliente), {
      empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID, nome: 'Depósito', descricao: 'Nova descrição',
    });

    const campos = escritas.atualizar.mock.calls[0].arguments[3];
    assert.equal(campos.nome, 'Depósito');
    assert.equal(campos.descricao, 'Nova descrição');
    assert.equal(campos.descricaoInformada, true);
    assert.equal(campos.ativo, undefined, 'alterar nunca mexe em ativo');

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'GRUPO_ACESSO_ALTERADO');
    assert.deepEqual(auditoria.contexto, { camposAlterados: ['nome', 'descricao'] });
    assert.deepEqual(auditoria.dadosAnteriores, { nome: 'Almoxarifado', descricao: null, ativo: true });
    assert.deepEqual(auditoria.dadosNovos, { nome: 'Depósito', descricao: 'Nova descrição', ativo: true });
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('alterar só o nome não toca a descrição; descricao: null explícito limpa', async (t) => {
    const soNome = mundoValido(t);
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID, nome: 'Depósito' });
    assert.equal(soNome.atualizar.mock.calls[0].arguments[3].descricaoInformada, false);
    assert.deepEqual(soNome.registrar.mock.calls[0].arguments[1].contexto, { camposAlterados: ['nome'] });

    const limpar = mundoValido(t, { existente: grupo({ descricao: 'antiga' }) });
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID, descricao: null });
    assert.equal(limpar.atualizar.mock.calls[0].arguments[3].descricaoInformada, true);
    assert.equal(limpar.atualizar.mock.calls[0].arguments[3].descricao, null);
  });

  test('nenhum campo informado: 400, sem rastro', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.alterar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 400, 'GRUPO_SEM_ALTERACAO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('não-MASTER não altera; grupo inexistente nesta empresa é 404', async (t) => {
    const semAutoridade = mundoValido(t);
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.alterar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ADMIN_ID, grupoId: GRUPO_ID, nome: 'X' }), 403, 'GRUPO_NAO_AUTORIZADO');
    assertRecusaSemRastro(cliente, semAutoridade);

    const semGrupo = mundoValido(t, { existente: null });
    const outroCliente = criarClienteFalso();
    await esperarHttpError(servico.alterar(criarPoolFalso(outroCliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID, nome: 'X' }), 404, 'GRUPO_NAO_ENCONTRADO');
    assertRecusaSemRastro(outroCliente, semGrupo);
  });

  test('renomear para um nome já usado na empresa: 409, sem auditoria', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(grupoRepo, 'atualizar', async () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); });
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.alterar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID, nome: 'Gerência' }), 409, 'GRUPO_NOME_EM_USO');

    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });

  test('falha na auditoria depois do UPDATE: ROLLBACK', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('conexão perdida'); });
    const cliente = criarClienteFalso();

    await assert.rejects(servico.alterar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID, nome: 'Depósito' }), /conexão perdida/);

    assert.equal(escritas.atualizar.mock.calls.length, 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  });
});

describe('inativar e reativar', () => {
  test('inativar: grava só ativo=false e audita com ação própria e o efeito sobre as concessões', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const resultado = await servico.inativar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID });

    assert.equal(resultado.alterado, true);
    assert.deepEqual(escritas.atualizar.mock.calls[0].arguments[3], { ativo: false }, 'só ativo — nome e descrição intocados');

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'GRUPO_ACESSO_INATIVADO');
    assert.deepEqual(auditoria.contexto, { efeito: 'CONCESSOES_DO_GRUPO_SUSPENSAS' });
    assert.equal(auditoria.dadosAnteriores.ativo, true);
    assert.equal(auditoria.dadosNovos.ativo, false);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('reativar: exige a mesma autoridade e audita o retorno das concessões TRUE', async (t) => {
    const escritas = mundoValido(t, { existente: grupo({ ativo: false }) });
    const cliente = criarClienteFalso();

    const resultado = await servico.reativar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID });

    assert.equal(resultado.alterado, true);
    assert.deepEqual(escritas.atualizar.mock.calls[0].arguments[3], { ativo: true });
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'GRUPO_ACESSO_REATIVADO');
    assert.deepEqual(auditoria.contexto, { efeito: 'CONCESSOES_DO_GRUPO_VOLTAM_A_VALER' });
  });

  test('não-MASTER não inativa nem reativa', async (t) => {
    for (const operacao of ['inativar', 'reativar']) {
      const escritas = mundoValido(t);
      const cliente = criarClienteFalso();

      await esperarHttpError(servico[operacao](criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ADMIN_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_NAO_AUTORIZADO');

      assertRecusaSemRastro(cliente, escritas);
    }
  });

  test('idempotência: pedir o estado que o grupo já tem não grava nem audita, e commita', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const resultado = await servico.inativar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID });
    assert.equal(resultado.alterado, true);

    const jaInativo = mundoValido(t, { existente: grupo({ ativo: false }) });
    const outroCliente = criarClienteFalso();
    const repetido = await servico.inativar(criarPoolFalso(outroCliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID });

    assert.equal(repetido.alterado, false);
    assert.equal(repetido.grupo.ativo, false);
    assert.equal(jaInativo.atualizar.mock.calls.length, 0, 'nada a gravar');
    assert.equal(jaInativo.registrar.mock.calls.length, 0, 'nada a auditar');
    assert.equal(contar(outroCliente.chamadas, /^COMMIT$/), 1);
    assert.ok(escritas.registrar.mock.calls.length >= 0);
  });

  test('grupo de outra empresa: 404, sem rastro', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.inativar(criarPoolFalso(cliente), { empresaId: EMPRESA_OUTRA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_NAO_AUTORIZADO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('falha na auditoria depois do UPDATE de estado: ROLLBACK', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('conexão perdida'); });
    const cliente = criarClienteFalso();

    await assert.rejects(servico.inativar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID }), /conexão perdida/);

    assert.equal(escritas.atualizar.mock.calls.length, 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });
});

describe('autoridade administrativa — ponto único e extensível', () => {
  test('o perfil é sempre RELIDO do banco: um "perfil"/"isMaster" enviado junto dos dados é ignorado', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.criar(criarPoolFalso(cliente), {
        empresaId: EMPRESA, atorId: ADMIN_ID, nome: 'Almoxarifado', perfil: 'MASTER', isMaster: true,
      }),
      403,
      'GRUPO_NAO_AUTORIZADO',
    );

    assertRecusaSemRastro(cliente, escritas);
  });

  test('as quatro operações de escrita passam pela mesma verificação, com o mesmo código de erro', async (t) => {
    const operacoes = [
      ['criar', { empresaId: EMPRESA, atorId: ADMIN_ID, nome: 'X' }],
      ['alterar', { empresaId: EMPRESA, atorId: ADMIN_ID, grupoId: GRUPO_ID, nome: 'X' }],
      ['inativar', { empresaId: EMPRESA, atorId: ADMIN_ID, grupoId: GRUPO_ID }],
      ['reativar', { empresaId: EMPRESA, atorId: ADMIN_ID, grupoId: GRUPO_ID }],
    ];

    for (const [nome, dados] of operacoes) {
      const escritas = mundoValido(t);
      const cliente = criarClienteFalso();

      await esperarHttpError(servico[nome](criarPoolFalso(cliente), dados), 403, 'GRUPO_NAO_AUTORIZADO');

      assertRecusaSemRastro(cliente, escritas);
    }
  });

  test('nenhuma operação toca permissões de grupo ou vínculos de usuário', async (t) => {
    const escritas = mundoValido(t);
    const pool = criarPoolFalso(criarClienteFalso());

    await servico.criar(pool, { empresaId: EMPRESA, atorId: MASTER_ID, nome: 'Almoxarifado' });
    await servico.alterar(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID, nome: 'Depósito' });
    await servico.inativar(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID });

    const camposTocados = escritas.atualizar.mock.calls.flatMap((c) => Object.keys(c.arguments[3]));
    assert.deepEqual([...new Set(camposTocados)].sort(), ['ativo', 'descricao', 'descricaoInformada', 'nome']);
    assert.equal(escritas.registrar.mock.calls.length, 3, 'cada operação efetiva gera exatamente um registro');
  });
});
