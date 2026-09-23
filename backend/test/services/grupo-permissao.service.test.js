'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/grupo-permissao.service');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const grupoRepo = require('../../src/repositories/grupo-acesso.repository');
const grupoPermissaoRepo = require('../../src/repositories/grupo-permissao.repository');
const permissaoRepo = require('../../src/repositories/permissao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de configuração das permissões de grupo,
 * sem PostgreSQL real. Repositórios substituídos por t.mock.method; só
 * BEGIN/COMMIT/ROLLBACK passam pelo cliente falso.
 *
 * Pontos centrais: o tri-state atravessa intacto; alteração parcial não
 * mexe nas outras operações; toda recusa termina em ROLLBACK sem gravar
 * nem auditar; e nada aqui escreve em grupos_acesso (editar permissão
 * nunca reativa um grupo).
 */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const MASTER_ID = 1;
const ADMIN_ID = 5;
const GRUPO_ID = 30;
const RECURSO = 'materials';
const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE';

const usuario = (id, extra = {}) => Object.freeze({
  id, empresa_id: EMPRESA, nome: `Usuário ${id}`, email: `u${id}@demo.safeworkengenharia.com.br`,
  perfil: 'ADMINISTRADOR', ativo: true, biometria_cadastrada: false, ...extra,
});
const master = usuario(MASTER_ID, { perfil: 'MASTER' });
const administrador = usuario(ADMIN_ID);

const grupo = (extra = {}) => ({
  id: GRUPO_ID, empresaId: EMPRESA, nome: 'Almoxarifado', descricao: null, ativo: true,
  criadoPor: MASTER_ID, criadoEm: new Date('2026-09-21T10:00:00Z'), atualizadoEm: new Date('2026-09-21T10:00:00Z'),
  ...extra,
});

const configuracaoAcao = (extra = {}) => ({ ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA', ...extra });

const recursoSalvo = (campos) => ({
  id: 9, empresaId: EMPRESA, grupoAcessoId: GRUPO_ID, recurso: RECURSO,
  podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null,
  criadoEm: new Date(), atualizadoEm: new Date(), ...campos,
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

function mundoValido(t, {
  usuarios = {}, grupoExistente = grupo(), recursoAtual = null, acaoAtual = null, config = configuracaoAcao(),
} = {}) {
  const porId = { [MASTER_ID]: master, [ADMIN_ID]: administrador, ...usuarios };
  t.mock.method(usuarioRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => (
    empresaId === EMPRESA && porId[id] ? porId[id] : null
  ));
  t.mock.method(usuarioRepo, 'buscarPorId', async (_c, empresaId, id) => (
    empresaId === EMPRESA && porId[id] ? porId[id] : null
  ));
  t.mock.method(grupoRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => (
    empresaId === EMPRESA && grupoExistente && id === grupoExistente.id ? grupoExistente : null
  ));
  t.mock.method(grupoRepo, 'buscarPorId', async (_c, empresaId, id) => (
    empresaId === EMPRESA && grupoExistente && id === grupoExistente.id ? grupoExistente : null
  ));
  t.mock.method(grupoRepo, 'atualizar', async () => { throw new Error('grupos_acesso não pode ser alterado por este serviço'); });
  t.mock.method(grupoPermissaoRepo, 'buscarRecurso', async () => recursoAtual);
  t.mock.method(grupoPermissaoRepo, 'buscarAcao', async () => acaoAtual);
  t.mock.method(grupoPermissaoRepo, 'listarRecursosDoGrupo', async () => []);
  t.mock.method(grupoPermissaoRepo, 'listarAcoesDoGrupo', async () => []);
  t.mock.method(permissaoRepo, 'buscarConfiguracaoAcao', async () => config);
  return {
    salvarRecurso: t.mock.method(grupoPermissaoRepo, 'salvarRecurso', async (_c, dados) => recursoSalvo(dados)),
    salvarAcao: t.mock.method(grupoPermissaoRepo, 'salvarAcao', async (_c, dados) => ({
      id: 4, empresaId: EMPRESA, grupoAcessoId: GRUPO_ID, acaoCodigo: dados.acaoCodigo, permitido: dados.permitido,
      criadoEm: new Date(), atualizadoEm: new Date(),
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
  assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  assert.equal(escritas.salvarRecurso.mock.calls.length, 0);
  assert.equal(escritas.salvarAcao.mock.calls.length, 0);
  assert.equal(escritas.registrar.mock.calls.length, 0, 'recusa não é auditada');
  assert.ok(cliente.chamadas.includes('RELEASE'));
}

const dadosRecurso = (extra = {}) => ({ empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID, recurso: RECURSO, ...extra });
const dadosAcao = (extra = {}) => ({ empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID, acaoCodigo: ACAO_ALTERNATIVA, permitido: true, ...extra });

describe('configurarRecurso — criação e tri-state', () => {
  test('configuração inexistente é criada; operações não informadas nascem null (herdam)', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const { configuracao, alterado } = await servico.configurarRecurso(criarPoolFalso(cliente), dadosRecurso({ podeVisualizar: true }));

    assert.equal(alterado, true);
    assert.deepEqual(escritas.salvarRecurso.mock.calls[0].arguments[1], {
      empresaId: EMPRESA, grupoAcessoId: GRUPO_ID, recurso: RECURSO,
      podeVisualizar: true, podeCriar: null, podeEditar: null, podeExcluir: null,
    });
    assert.equal(configuracao.podeVisualizar, true);

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'GRUPO_PERMISSAO_RECURSO_CONFIGURADA');
    assert.equal(auditoria.usuarioId, MASTER_ID);
    assert.equal(auditoria.referencia, String(GRUPO_ID));
    assert.deepEqual(auditoria.contexto, { recurso: RECURSO, operacoesInformadas: ['podeVisualizar'], criouConfiguracao: true });
    assert.equal(auditoria.dadosAnteriores, null, 'não havia configuração anterior');
    assert.deepEqual(auditoria.dadosNovos, { podeVisualizar: true, podeCriar: null, podeEditar: null, podeExcluir: null });
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('TRUE, FALSE e NULL atravessam intactos numa mesma chamada', async (t) => {
    const escritas = mundoValido(t);

    await servico.configurarRecurso(criarPoolFalso(criarClienteFalso()), dadosRecurso({
      podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: false,
    }));

    const gravado = escritas.salvarRecurso.mock.calls[0].arguments[1];
    assert.equal(gravado.podeVisualizar, true);
    assert.equal(gravado.podeCriar, false);
    assert.equal(gravado.podeEditar, null);
    assert.equal(gravado.podeExcluir, false);
  });

  test('alteração parcial preserva as demais operações e NÃO converte FALSE em NULL', async (t) => {
    const atual = recursoSalvo({ podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: false });
    const escritas = mundoValido(t, { recursoAtual: atual });

    await servico.configurarRecurso(criarPoolFalso(criarClienteFalso()), dadosRecurso({ podeExcluir: true }));

    const gravado = escritas.salvarRecurso.mock.calls[0].arguments[1];
    assert.equal(gravado.podeExcluir, true, 'só a operação informada muda');
    assert.equal(gravado.podeVisualizar, true, 'preservada');
    assert.equal(gravado.podeCriar, false, 'FALSE preservado como FALSE — nunca vira NULL');
    assert.equal(gravado.podeEditar, true, 'preservada');

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.deepEqual(auditoria.dadosAnteriores, { podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: false });
    assert.deepEqual(auditoria.dadosNovos, { podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true });
    assert.deepEqual(auditoria.contexto.operacoesInformadas, ['podeExcluir']);
  });

  test('informar null explicitamente passa a herdar, sem tocar as outras', async (t) => {
    const atual = recursoSalvo({ podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: true });
    const escritas = mundoValido(t, { recursoAtual: atual });

    await servico.configurarRecurso(criarPoolFalso(criarClienteFalso()), dadosRecurso({ podeVisualizar: null }));

    const gravado = escritas.salvarRecurso.mock.calls[0].arguments[1];
    assert.equal(gravado.podeVisualizar, null, 'passou a herdar do perfil');
    assert.equal(gravado.podeCriar, false);
    assert.equal(gravado.podeExcluir, true);
  });

  test('undefined explícito equivale a ausência: não altera a operação', async (t) => {
    const atual = recursoSalvo({ podeVisualizar: true, podeCriar: true, podeEditar: true, podeExcluir: true });
    const escritas = mundoValido(t, { recursoAtual: atual });

    await servico.configurarRecurso(criarPoolFalso(criarClienteFalso()), dadosRecurso({ podeCriar: undefined, podeEditar: false }));

    const gravado = escritas.salvarRecurso.mock.calls[0].arguments[1];
    assert.equal(gravado.podeCriar, true, 'undefined não é uma instrução');
    assert.equal(gravado.podeEditar, false);
  });

  test('sem mudança efetiva: não grava, não audita, e devolve alterado=false com COMMIT', async (t) => {
    const atual = recursoSalvo({ podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null });
    const escritas = mundoValido(t, { recursoAtual: atual });
    const cliente = criarClienteFalso();

    const { alterado } = await servico.configurarRecurso(criarPoolFalso(cliente), dadosRecurso({ podeVisualizar: true, podeCriar: false }));

    assert.equal(alterado, false);
    assert.equal(escritas.salvarRecurso.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });
});

describe('configurarRecurso — recusas', () => {
  test('não-MASTER (inclusive ADMINISTRADOR) recebe 403 sem rastro', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.configurarRecurso(criarPoolFalso(cliente), dadosRecurso({ atorId: ADMIN_ID, podeVisualizar: true })), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('MASTER inativo recebe 403', async (t) => {
    const escritas = mundoValido(t, { usuarios: { [MASTER_ID]: usuario(MASTER_ID, { perfil: 'MASTER', ativo: false }) } });
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.configurarRecurso(criarPoolFalso(cliente), dadosRecurso({ podeVisualizar: true })), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('perfil/isMaster enviados junto dos dados são ignorados: o perfil é relido do banco', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.configurarRecurso(criarPoolFalso(cliente), dadosRecurso({ atorId: ADMIN_ID, podeVisualizar: true, perfil: 'MASTER', isMaster: true })),
      403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA',
    );

    assertRecusaSemRastro(cliente, escritas);
  });

  test('grupo de outra empresa é inacessível mesmo conhecendo o id', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    // A empresa autenticada é outra: nem o ator é encontrado nela.
    await esperarHttpError(servico.configurarRecurso(criarPoolFalso(cliente), dadosRecurso({ empresaId: EMPRESA_OUTRA, podeVisualizar: true })), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
    assertRecusaSemRastro(cliente, escritas);

    // Ator legítimo, mas grupo inexistente nesta empresa: 404.
    const semGrupo = mundoValido(t, { grupoExistente: null });
    const outroCliente = criarClienteFalso();
    await esperarHttpError(servico.configurarRecurso(criarPoolFalso(outroCliente), dadosRecurso({ podeVisualizar: true })), 404, 'GRUPO_NAO_ENCONTRADO');
    assertRecusaSemRastro(outroCliente, semGrupo);
  });

  test('nenhuma operação informada: 400, sem rastro', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.configurarRecurso(criarPoolFalso(cliente), dadosRecurso()), 400, 'GRUPO_PERMISSAO_SEM_ALTERACAO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('valores fora do tri-state e ids malformados lançam TypeError antes de conectar', async (t) => {
    mundoValido(t);
    const pool = { connect: async () => { throw new Error('não deveria conectar'); } };

    await assert.rejects(servico.configurarRecurso(pool, dadosRecurso({ podeVisualizar: 'sim' })), TypeError);
    await assert.rejects(servico.configurarRecurso(pool, dadosRecurso({ podeCriar: 1 })), TypeError);
    await assert.rejects(servico.configurarRecurso(pool, dadosRecurso({ empresaId: 0, podeVisualizar: true })), TypeError);
    await assert.rejects(servico.configurarRecurso(pool, dadosRecurso({ grupoId: 0, podeVisualizar: true })), TypeError);
  });

  test('falha na auditoria depois da gravação: ROLLBACK', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('conexão perdida'); });
    const cliente = criarClienteFalso();

    await assert.rejects(servico.configurarRecurso(criarPoolFalso(cliente), dadosRecurso({ podeVisualizar: true })), /conexão perdida/);

    assert.equal(escritas.salvarRecurso.mock.calls.length, 1, 'a gravação chegou a acontecer...');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1, '...e foi desfeita');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  });
});

describe('configurarAcao', () => {
  test('MASTER configura ação ALTERNATIVA: grava e audita com o modo no contexto', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const { alterado } = await servico.configurarAcao(criarPoolFalso(cliente), dadosAcao({ permitido: true }));

    assert.equal(alterado, true);
    assert.deepEqual(escritas.salvarAcao.mock.calls[0].arguments[1], {
      empresaId: EMPRESA, grupoAcessoId: GRUPO_ID, acaoCodigo: ACAO_ALTERNATIVA, permitido: true,
    });

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'GRUPO_PERMISSAO_ACAO_CONFIGURADA');
    assert.deepEqual(auditoria.contexto, { acaoCodigo: ACAO_ALTERNATIVA, modoAutorizacaoIndividual: 'ALTERNATIVA', criouConfiguracao: true });
    assert.equal(auditoria.dadosAnteriores, null);
    assert.deepEqual(auditoria.dadosNovos, { permitido: true });
  });

  test('FALSE é gravado como FALSE, e a configuração existente é atualizada com anterior no log', async (t) => {
    const escritas = mundoValido(t, {
      acaoAtual: { id: 4, empresaId: EMPRESA, grupoAcessoId: GRUPO_ID, acaoCodigo: ACAO_ALTERNATIVA, permitido: true },
    });

    await servico.configurarAcao(criarPoolFalso(criarClienteFalso()), dadosAcao({ permitido: false }));

    assert.equal(escritas.salvarAcao.mock.calls[0].arguments[1].permitido, false);
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.deepEqual(auditoria.dadosAnteriores, { permitido: true });
    assert.deepEqual(auditoria.dadosNovos, { permitido: false });
    assert.equal(auditoria.contexto.criouConfiguracao, false);
  });

  test('ação NENHUMA não recebe concessão nem negação por grupo: 409, sem rastro', async (t) => {
    for (const permitido of [true, false]) {
      const escritas = mundoValido(t, { config: configuracaoAcao({ modoAutorizacaoIndividual: 'NENHUMA' }) });
      const cliente = criarClienteFalso();

      await esperarHttpError(servico.configurarAcao(criarPoolFalso(cliente), dadosAcao({ permitido })), 409, 'GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA');

      assertRecusaSemRastro(cliente, escritas);
    }
  });

  test('ação OBRIGATORIA não recebe concessão por grupo: 409 — grupo não substitui autorização individual nem SST', async (t) => {
    const escritas = mundoValido(t, { config: configuracaoAcao({ modoAutorizacaoIndividual: 'OBRIGATORIA', exigeSst: true }) });
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.configurarAcao(criarPoolFalso(cliente), dadosAcao({ permitido: true })), 409, 'GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('gravar NULL (retirar a opinião) é permitido mesmo fora de ALTERNATIVA: é como se limpa configuração obsoleta', async (t) => {
    const escritas = mundoValido(t, {
      config: configuracaoAcao({ modoAutorizacaoIndividual: 'OBRIGATORIA', exigeSst: true }),
      acaoAtual: { id: 4, empresaId: EMPRESA, grupoAcessoId: GRUPO_ID, acaoCodigo: ACAO_ALTERNATIVA, permitido: true },
    });

    const { alterado } = await servico.configurarAcao(criarPoolFalso(criarClienteFalso()), dadosAcao({ permitido: null }));

    assert.equal(alterado, true);
    assert.equal(escritas.salvarAcao.mock.calls[0].arguments[1].permitido, null);
  });

  test('ação inexistente, inativa ou com configuração irreconhecível: 400, sem rastro', async (t) => {
    const casos = [
      ['inexistente', null],
      ['inativa', configuracaoAcao({ ativo: false })],
      ['modo desconhecido', configuracaoAcao({ modoAutorizacaoIndividual: 'VALOR_INESPERADO' })],
      ['exigeSst não booleano', configuracaoAcao({ exigeSst: 'false' })],
    ];

    for (const [, config] of casos) {
      const escritas = mundoValido(t, { config });
      const cliente = criarClienteFalso();

      await esperarHttpError(servico.configurarAcao(criarPoolFalso(cliente), dadosAcao({ permitido: true })), 400, 'GRUPO_PERMISSAO_ACAO_INVALIDA');

      assertRecusaSemRastro(cliente, escritas);
    }
  });

  test('sem mudança efetiva: não grava nem audita', async (t) => {
    const escritas = mundoValido(t, {
      acaoAtual: { id: 4, empresaId: EMPRESA, grupoAcessoId: GRUPO_ID, acaoCodigo: ACAO_ALTERNATIVA, permitido: true },
    });
    const cliente = criarClienteFalso();

    const { alterado } = await servico.configurarAcao(criarPoolFalso(cliente), dadosAcao({ permitido: true }));

    assert.equal(alterado, false);
    assert.equal(escritas.salvarAcao.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('não-MASTER, grupo inexistente e permitido fora do tri-state', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.configurarAcao(criarPoolFalso(cliente), dadosAcao({ atorId: ADMIN_ID })), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
    assertRecusaSemRastro(cliente, escritas);

    const semGrupo = mundoValido(t, { grupoExistente: null });
    const outro = criarClienteFalso();
    await esperarHttpError(servico.configurarAcao(criarPoolFalso(outro), dadosAcao()), 404, 'GRUPO_NAO_ENCONTRADO');
    assertRecusaSemRastro(outro, semGrupo);

    mundoValido(t);
    await assert.rejects(servico.configurarAcao({ connect: async () => { throw new Error('x'); } }, dadosAcao({ permitido: 'sim' })), TypeError);
  });

  test('falha na auditoria depois da gravação: ROLLBACK', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('conexão perdida'); });
    const cliente = criarClienteFalso();

    await assert.rejects(servico.configurarAcao(criarPoolFalso(cliente), dadosAcao()), /conexão perdida/);

    assert.equal(escritas.salvarAcao.mock.calls.length, 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });
});

describe('grupo inativo e não-interferência', () => {
  test('configurar permissões de grupo INATIVO é permitido e não o reativa', async (t) => {
    const escritas = mundoValido(t, { grupoExistente: grupo({ ativo: false }) });

    const { alterado } = await servico.configurarRecurso(criarPoolFalso(criarClienteFalso()), dadosRecurso({ podeVisualizar: true }));

    assert.equal(alterado, true, 'a configuração é gravada normalmente');
    // grupoRepo.atualizar está mockado para explodir: se o serviço tentasse
    // mexer em grupos_acesso, este teste falharia.
    assert.equal(grupoRepo.atualizar.mock.calls.length, 0, 'nenhuma escrita em grupos_acesso');
    assert.equal(escritas.salvarRecurso.mock.calls.length, 1);
  });

  test('o grupo é sempre travado com FOR UPDATE antes de configurar (disciplina da 3J)', async (t) => {
    mundoValido(t);
    const travado = grupoRepo.buscarPorIdParaAtualizacao;
    const semTrava = grupoRepo.buscarPorId;

    await servico.configurarRecurso(criarPoolFalso(criarClienteFalso()), dadosRecurso({ podeVisualizar: true }));
    await servico.configurarAcao(criarPoolFalso(criarClienteFalso()), dadosAcao());

    assert.equal(travado.mock.calls.length, 2, 'as duas escritas travam o grupo');
    assert.equal(semTrava.mock.calls.length, 0, 'nenhuma escrita usa a leitura destravada');
    assert.deepEqual(travado.mock.calls[0].arguments.slice(1), [EMPRESA, GRUPO_ID]);
  });

  test('nenhuma operação escreve em grupos_acesso, em usuarios ou no catálogo de ações', async (t) => {
    const escritas = mundoValido(t);
    const pool = criarPoolFalso(criarClienteFalso());

    await servico.configurarRecurso(pool, dadosRecurso({ podeVisualizar: true }));
    await servico.configurarAcao(pool, dadosAcao());

    assert.equal(grupoRepo.atualizar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 2, 'uma auditoria por operação efetiva');
    for (const chamada of escritas.registrar.mock.calls) {
      const { contexto } = chamada.arguments[1];
      assert.doesNotMatch(JSON.stringify(contexto), /senha|token|hash|secret/i, 'nada sensível na auditoria');
    }
  });
});

describe('listagens', () => {
  test('listam por grupo da própria empresa, sem transação', async (t) => {
    mundoValido(t);
    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await servico.listarRecursos(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID });
    await servico.listarAcoes(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID });

    assert.equal(contar(cliente.chamadas, /^BEGIN$/), 0, 'leitura não abre transação');
    assert.deepEqual(grupoPermissaoRepo.listarRecursosDoGrupo.mock.calls[0].arguments.slice(1), [EMPRESA, GRUPO_ID]);
    assert.deepEqual(grupoPermissaoRepo.listarAcoesDoGrupo.mock.calls[0].arguments.slice(1), [EMPRESA, GRUPO_ID]);
  });

  // Ajuste da Subetapa 3N: as duas listagens passaram a exigir autoridade
  // administrativa (mesma decisão da 3M para grupo-acesso.service.js).
  test('não-MASTER (inclusive ADMINISTRADOR) recebe 403 nas duas listagens, sem sequer consultar o grupo', async (t) => {
    mundoValido(t);
    const pool = criarPoolFalso(criarClienteFalso());

    await esperarHttpError(servico.listarRecursos(pool, { empresaId: EMPRESA, atorId: ADMIN_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
    await esperarHttpError(servico.listarAcoes(pool, { empresaId: EMPRESA, atorId: ADMIN_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
    assert.equal(grupoRepo.buscarPorId.mock.calls.length, 0, 'autoridade é checada antes de buscar o grupo');
  });

  test('MASTER inativo recebe 403 nas duas listagens', async (t) => {
    mundoValido(t, { usuarios: { [MASTER_ID]: usuario(MASTER_ID, { perfil: 'MASTER', ativo: false }) } });
    const pool = criarPoolFalso(criarClienteFalso());

    await esperarHttpError(servico.listarRecursos(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
    await esperarHttpError(servico.listarAcoes(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
  });

  test('ator de outra empresa (não encontrado nesta): 403 antes de qualquer 404', async (t) => {
    mundoValido(t);
    const pool = criarPoolFalso(criarClienteFalso());

    await esperarHttpError(servico.listarRecursos(pool, { empresaId: EMPRESA_OUTRA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
    await esperarHttpError(servico.listarAcoes(pool, { empresaId: EMPRESA_OUTRA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
  });

  test('grupo inexistente nesta empresa, com ator legítimo: 404 nas duas listagens', async (t) => {
    mundoValido(t, { grupoExistente: null });
    const pool = criarPoolFalso(criarClienteFalso());

    await esperarHttpError(servico.listarRecursos(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 404, 'GRUPO_NAO_ENCONTRADO');
    await esperarHttpError(servico.listarAcoes(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 404, 'GRUPO_NAO_ENCONTRADO');
  });
});
