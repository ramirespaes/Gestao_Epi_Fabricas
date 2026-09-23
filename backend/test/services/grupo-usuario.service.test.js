'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/grupo-usuario.service');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const grupoRepo = require('../../src/repositories/grupo-acesso.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de vinculação de usuários a grupos, sem
 * PostgreSQL real. Repositórios substituídos por t.mock.method; só
 * BEGIN/COMMIT/ROLLBACK passam pelo cliente falso.
 *
 * Pontos centrais: a única coluna escrita é usuarios.grupo_acesso_id;
 * toda recusa termina em ROLLBACK sem gravar nem auditar; e nada aqui
 * toca grupos_acesso, permissões, SST, bloqueios ou autorizações.
 */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const MASTER_ID = 1;
const ADMIN_ID = 5;
const USUARIO_ID = 9;
const GRUPO_ID = 30;
const OUTRO_GRUPO_ID = 31;

const master = Object.freeze({
  id: MASTER_ID, empresa_id: EMPRESA, nome: 'Master', email: 'master@demo.safeworkengenharia.com.br',
  perfil: 'MASTER', ativo: true, biometria_cadastrada: false,
});
const administrador = Object.freeze({ ...master, id: ADMIN_ID, perfil: 'ADMINISTRADOR' });

const vinculo = (extra = {}) => ({
  id: USUARIO_ID, empresaId: EMPRESA, perfil: 'ADMINISTRADOR', ativo: true, grupoAcessoId: null, ...extra,
});

const grupo = (extra = {}) => ({
  id: GRUPO_ID, empresaId: EMPRESA, nome: 'Almoxarifado', descricao: null, ativo: true,
  criadoPor: MASTER_ID, criadoEm: new Date(), atualizadoEm: new Date(), ...extra,
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

function mundoValido(t, { usuarios = {}, alvo = vinculo(), grupoDestino = grupo() } = {}) {
  const porId = { [MASTER_ID]: master, [ADMIN_ID]: administrador, ...usuarios };
  t.mock.method(usuarioRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => (
    empresaId === EMPRESA && porId[id] ? porId[id] : null
  ));
  t.mock.method(usuarioRepo, 'buscarPorId', async (_c, empresaId, id) => (
    empresaId === EMPRESA && porId[id] ? porId[id] : null
  ));
  t.mock.method(usuarioRepo, 'buscarVinculoGrupoParaAtualizacao', async (_c, empresaId, id) => (
    empresaId === EMPRESA && alvo && id === alvo.id ? alvo : null
  ));
  t.mock.method(grupoRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => (
    empresaId === EMPRESA && grupoDestino && id === grupoDestino.id ? grupoDestino : null
  ));
  t.mock.method(grupoRepo, 'buscarPorId', async (_c, empresaId, id) => (
    empresaId === EMPRESA && grupoDestino && id === grupoDestino.id ? grupoDestino : null
  ));
  t.mock.method(grupoRepo, 'atualizar', async () => { throw new Error('grupos_acesso não pode ser alterado por este serviço'); });
  t.mock.method(usuarioRepo, 'listarPorGrupoAcesso', async () => []);
  return {
    atualizar: t.mock.method(usuarioRepo, 'atualizarGrupoAcesso', async (_c, _e, id, grupoAcessoId) => ({ id, grupoAcessoId })),
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
  assert.equal(escritas.atualizar.mock.calls.length, 0, 'nenhum vínculo alterado numa recusa');
  assert.equal(escritas.registrar.mock.calls.length, 0, 'recusa não é auditada');
  assert.ok(cliente.chamadas.includes('RELEASE'));
}

const dadosVincular = (extra = {}) => ({ empresaId: EMPRESA, atorId: MASTER_ID, usuarioId: USUARIO_ID, grupoId: GRUPO_ID, ...extra });
const dadosDesvincular = (extra = {}) => ({ empresaId: EMPRESA, atorId: MASTER_ID, usuarioId: USUARIO_ID, ...extra });

describe('vincular — caminho válido', () => {
  test('MASTER vincula usuário sem grupo: grava só grupo_acesso_id e audita como vínculo novo', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const resultado = await servico.vincular(criarPoolFalso(cliente), dadosVincular());

    assert.deepEqual(resultado, { usuarioId: USUARIO_ID, grupoAnteriorId: null, grupoAtualId: GRUPO_ID, alterado: true });
    assert.deepEqual(escritas.atualizar.mock.calls[0].arguments.slice(1), [EMPRESA, USUARIO_ID, GRUPO_ID]);

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.empresaId, EMPRESA);
    assert.equal(auditoria.usuarioId, MASTER_ID, 'o ator é quem agiu');
    assert.equal(auditoria.acao, 'USUARIO_VINCULADO_A_GRUPO');
    assert.equal(auditoria.referencia, String(USUARIO_ID), 'a referência é o usuário afetado');
    assert.deepEqual(auditoria.contexto, { usuarioAfetado: USUARIO_ID, grupoAnteriorId: null, grupoAtualId: GRUPO_ID });
    assert.deepEqual(auditoria.dadosAnteriores, { grupoAcessoId: null });
    assert.deepEqual(auditoria.dadosNovos, { grupoAcessoId: GRUPO_ID });

    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 0);
  });

  test('troca de grupo substitui o vínculo anterior e audita como transferência', async (t) => {
    const escritas = mundoValido(t, { alvo: vinculo({ grupoAcessoId: OUTRO_GRUPO_ID }) });

    const resultado = await servico.vincular(criarPoolFalso(criarClienteFalso()), dadosVincular());

    assert.deepEqual(resultado, { usuarioId: USUARIO_ID, grupoAnteriorId: OUTRO_GRUPO_ID, grupoAtualId: GRUPO_ID, alterado: true });
    assert.equal(escritas.atualizar.mock.calls.length, 1, 'uma única escrita: a substituição');
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'USUARIO_TRANSFERIDO_DE_GRUPO');
    assert.deepEqual(auditoria.dadosAnteriores, { grupoAcessoId: OUTRO_GRUPO_ID });
    assert.deepEqual(auditoria.dadosNovos, { grupoAcessoId: GRUPO_ID });
  });

  test('vincular ao grupo em que já está: não grava, não audita, alterado=false e COMMIT', async (t) => {
    const escritas = mundoValido(t, { alvo: vinculo({ grupoAcessoId: GRUPO_ID }) });
    const cliente = criarClienteFalso();

    const resultado = await servico.vincular(criarPoolFalso(cliente), dadosVincular());

    assert.equal(resultado.alterado, false);
    assert.equal(escritas.atualizar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('usuário e grupo são travados com FOR UPDATE, nunca pela leitura destravada', async (t) => {
    mundoValido(t);
    const usuarioTravado = usuarioRepo.buscarVinculoGrupoParaAtualizacao;
    const grupoTravado = grupoRepo.buscarPorIdParaAtualizacao;
    const grupoDestravado = grupoRepo.buscarPorId;

    await servico.vincular(criarPoolFalso(criarClienteFalso()), dadosVincular());

    assert.equal(usuarioTravado.mock.calls.length, 1);
    assert.deepEqual(usuarioTravado.mock.calls[0].arguments.slice(1), [EMPRESA, USUARIO_ID]);
    assert.equal(grupoTravado.mock.calls.length, 1);
    assert.equal(grupoDestravado.mock.calls.length, 0, 'escrita nunca usa a leitura destravada');
  });
});

describe('vincular — recusas, todas com ROLLBACK e sem rastro', () => {
  test('não-MASTER (inclusive ADMINISTRADOR) recebe 403', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.vincular(criarPoolFalso(cliente), dadosVincular({ atorId: ADMIN_ID })), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('MASTER inativo recebe 403', async (t) => {
    const escritas = mundoValido(t, { usuarios: { [MASTER_ID]: { ...master, ativo: false } } });
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.vincular(criarPoolFalso(cliente), dadosVincular()), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('perfil/isMaster enviados junto dos dados são ignorados: o perfil vem do banco', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(
      servico.vincular(criarPoolFalso(cliente), dadosVincular({ atorId: ADMIN_ID, perfil: 'MASTER', isMaster: true })),
      403, 'GRUPO_VINCULO_NAO_AUTORIZADO',
    );

    assertRecusaSemRastro(cliente, escritas);
  });

  test('autovinculação é recusada antes de qualquer conexão', async (t) => {
    mundoValido(t);
    let conectou = false;
    const pool = { connect: async () => { conectou = true; return criarClienteFalso(); } };

    await esperarHttpError(servico.vincular(pool, dadosVincular({ usuarioId: MASTER_ID })), 409, 'AUTOVINCULO_NAO_PERMITIDO');

    assert.equal(conectou, false, 'nem conecta: o ator nunca altera o próprio grupo');
  });

  test('usuário de perfil MASTER não recebe grupo', async (t) => {
    const escritas = mundoValido(t, { alvo: vinculo({ perfil: 'MASTER' }) });
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.vincular(criarPoolFalso(cliente), dadosVincular()), 409, 'USUARIO_MASTER_SEM_GRUPO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('usuário inativo não recebe vínculo novo — e seu vínculo histórico não é tocado', async (t) => {
    const escritas = mundoValido(t, { alvo: vinculo({ ativo: false, grupoAcessoId: OUTRO_GRUPO_ID }) });
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.vincular(criarPoolFalso(cliente), dadosVincular()), 409, 'USUARIO_INATIVO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('usuário de outra empresa é inacessível mesmo conhecendo o id', async (t) => {
    const semUsuario = mundoValido(t, { alvo: null });
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.vincular(criarPoolFalso(cliente), dadosVincular()), 404, 'USUARIO_NAO_ENCONTRADO');
    assertRecusaSemRastro(cliente, semUsuario);

    // Agir dentro da outra empresa: nem o ator existe lá.
    const escritas = mundoValido(t);
    const outro = criarClienteFalso();
    await esperarHttpError(servico.vincular(criarPoolFalso(outro), dadosVincular({ empresaId: EMPRESA_OUTRA })), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');
    assertRecusaSemRastro(outro, escritas);
  });

  test('grupo de outra empresa (ou inexistente) é 404', async (t) => {
    const escritas = mundoValido(t, { grupoDestino: null });
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.vincular(criarPoolFalso(cliente), dadosVincular()), 404, 'GRUPO_NAO_ENCONTRADO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('grupo inativo não recebe vínculo novo', async (t) => {
    const escritas = mundoValido(t, { grupoDestino: grupo({ ativo: false }) });
    const cliente = criarClienteFalso();

    await esperarHttpError(servico.vincular(criarPoolFalso(cliente), dadosVincular()), 409, 'GRUPO_INATIVO');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('falha na auditoria depois da gravação: ROLLBACK', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('conexão perdida'); });
    const cliente = criarClienteFalso();

    await assert.rejects(servico.vincular(criarPoolFalso(cliente), dadosVincular()), /conexão perdida/);

    assert.equal(escritas.atualizar.mock.calls.length, 1, 'a gravação chegou a acontecer...');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1, '...e foi desfeita');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  });

  test('ids malformados lançam TypeError antes de conectar', async (t) => {
    mundoValido(t);
    const pool = { connect: async () => { throw new Error('não deveria conectar'); } };

    await assert.rejects(servico.vincular(pool, dadosVincular({ empresaId: 0 })), TypeError);
    await assert.rejects(servico.vincular(pool, dadosVincular({ atorId: '1' })), TypeError);
    await assert.rejects(servico.vincular(pool, dadosVincular({ usuarioId: -1 })), TypeError);
    await assert.rejects(servico.vincular(pool, dadosVincular({ grupoId: 0 })), TypeError);
  });
});

describe('desvincular', () => {
  test('MASTER retira do grupo: grava null e audita o retorno ao piso do perfil', async (t) => {
    const escritas = mundoValido(t, { alvo: vinculo({ grupoAcessoId: GRUPO_ID }) });
    const cliente = criarClienteFalso();

    const resultado = await servico.desvincular(criarPoolFalso(cliente), dadosDesvincular());

    assert.deepEqual(resultado, { usuarioId: USUARIO_ID, grupoAnteriorId: GRUPO_ID, grupoAtualId: null, alterado: true });
    assert.deepEqual(escritas.atualizar.mock.calls[0].arguments.slice(1), [EMPRESA, USUARIO_ID, null]);

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'USUARIO_DESVINCULADO_DE_GRUPO');
    assert.deepEqual(auditoria.contexto, {
      usuarioAfetado: USUARIO_ID, grupoAnteriorId: GRUPO_ID, grupoAtualId: null, efeito: 'VOLTA_AO_PISO_DO_PERFIL',
    });
    assert.deepEqual(auditoria.dadosAnteriores, { grupoAcessoId: GRUPO_ID });
    assert.deepEqual(auditoria.dadosNovos, { grupoAcessoId: null });
  });

  test('retirar de grupo INATIVO é permitido: o grupo de destino nem é consultado', async (t) => {
    const escritas = mundoValido(t, { alvo: vinculo({ grupoAcessoId: GRUPO_ID }), grupoDestino: grupo({ ativo: false }) });
    const grupoTravado = grupoRepo.buscarPorIdParaAtualizacao;

    const resultado = await servico.desvincular(criarPoolFalso(criarClienteFalso()), dadosDesvincular());

    assert.equal(resultado.alterado, true);
    assert.equal(grupoTravado.mock.calls.length, 0, 'desvincular não depende do estado do grupo de origem');
    assert.equal(escritas.atualizar.mock.calls[0].arguments[3], null);
  });

  test('usuário já sem grupo: não grava, não audita, alterado=false', async (t) => {
    const escritas = mundoValido(t, { alvo: vinculo({ grupoAcessoId: null }) });
    const cliente = criarClienteFalso();

    const resultado = await servico.desvincular(criarPoolFalso(cliente), dadosDesvincular());

    assert.equal(resultado.alterado, false);
    assert.equal(escritas.atualizar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('não-MASTER, autodesvinculação, usuário MASTER, inativo e de outra empresa são recusados', async (t) => {
    const semAutoridade = mundoValido(t, { alvo: vinculo({ grupoAcessoId: GRUPO_ID }) });
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.desvincular(criarPoolFalso(cliente), dadosDesvincular({ atorId: ADMIN_ID })), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');
    assertRecusaSemRastro(cliente, semAutoridade);

    mundoValido(t);
    await esperarHttpError(
      servico.desvincular({ connect: async () => { throw new Error('não deveria conectar'); } }, dadosDesvincular({ usuarioId: MASTER_ID })),
      409, 'AUTOVINCULO_NAO_PERMITIDO',
    );

    const alvoMaster = mundoValido(t, { alvo: vinculo({ perfil: 'MASTER', grupoAcessoId: GRUPO_ID }) });
    const c2 = criarClienteFalso();
    await esperarHttpError(servico.desvincular(criarPoolFalso(c2), dadosDesvincular()), 409, 'USUARIO_MASTER_SEM_GRUPO');
    assertRecusaSemRastro(c2, alvoMaster);

    const alvoInativo = mundoValido(t, { alvo: vinculo({ ativo: false, grupoAcessoId: GRUPO_ID }) });
    const c3 = criarClienteFalso();
    await esperarHttpError(servico.desvincular(criarPoolFalso(c3), dadosDesvincular()), 409, 'USUARIO_INATIVO');
    assertRecusaSemRastro(c3, alvoInativo);

    const semUsuario = mundoValido(t, { alvo: null });
    const c4 = criarClienteFalso();
    await esperarHttpError(servico.desvincular(criarPoolFalso(c4), dadosDesvincular()), 404, 'USUARIO_NAO_ENCONTRADO');
    assertRecusaSemRastro(c4, semUsuario);
  });

  test('falha na auditoria depois da gravação: ROLLBACK', async (t) => {
    const escritas = mundoValido(t, { alvo: vinculo({ grupoAcessoId: GRUPO_ID }) });
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('conexão perdida'); });
    const cliente = criarClienteFalso();

    await assert.rejects(servico.desvincular(criarPoolFalso(cliente), dadosDesvincular()), /conexão perdida/);

    assert.equal(escritas.atualizar.mock.calls.length, 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });
});

describe('listarUsuariosDoGrupo', () => {
  test('lista os usuários do grupo da própria empresa, sem transação', async (t) => {
    mundoValido(t);
    const cliente = criarClienteFalso();

    await servico.listarUsuariosDoGrupo(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID });

    assert.equal(contar(cliente.chamadas, /^BEGIN$/), 0, 'leitura não abre transação');
    assert.deepEqual(usuarioRepo.listarPorGrupoAcesso.mock.calls[0].arguments.slice(1), [EMPRESA, GRUPO_ID]);
  });

  // Ajuste da Subetapa 3O: a listagem passou a exigir autoridade
  // administrativa (mesma decisão da 3M/3N para as demais leituras).
  test('não-MASTER (inclusive ADMINISTRADOR) recebe 403, sem sequer consultar o grupo', async (t) => {
    mundoValido(t);

    await esperarHttpError(servico.listarUsuariosDoGrupo(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ADMIN_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');

    assert.equal(grupoRepo.buscarPorId.mock.calls.length, 0, 'autoridade é checada antes de buscar o grupo');
  });

  test('MASTER inativo recebe 403', async (t) => {
    mundoValido(t, { usuarios: { [MASTER_ID]: { ...master, ativo: false } } });

    await esperarHttpError(servico.listarUsuariosDoGrupo(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');
  });

  test('ator de outra empresa (não encontrado nesta): 403 antes de qualquer 404', async (t) => {
    mundoValido(t);

    await esperarHttpError(servico.listarUsuariosDoGrupo(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA_OUTRA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');
  });

  test('grupo inexistente nesta empresa, com ator legítimo: 404', async (t) => {
    mundoValido(t, { grupoDestino: null });

    await esperarHttpError(servico.listarUsuariosDoGrupo(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: GRUPO_ID }), 404, 'GRUPO_NAO_ENCONTRADO');

    assert.equal(usuarioRepo.listarPorGrupoAcesso.mock.calls.length, 0);
  });

  test('entrada malformada é recusada', async (t) => {
    mundoValido(t);
    const pool = criarPoolFalso(criarClienteFalso());

    await assert.rejects(servico.listarUsuariosDoGrupo(pool, { empresaId: 0, atorId: MASTER_ID, grupoId: GRUPO_ID }), TypeError);
    await assert.rejects(servico.listarUsuariosDoGrupo(pool, { empresaId: EMPRESA, atorId: 0, grupoId: GRUPO_ID }), TypeError);
    await assert.rejects(servico.listarUsuariosDoGrupo(pool, { empresaId: EMPRESA, atorId: MASTER_ID, grupoId: 0 }), TypeError);
  });
});

describe('não-interferência', () => {
  test('nenhuma operação escreve em grupos_acesso: a única coluna tocada é usuarios.grupo_acesso_id', async (t) => {
    const escritas = mundoValido(t, { alvo: vinculo({ grupoAcessoId: OUTRO_GRUPO_ID }) });
    const pool = criarPoolFalso(criarClienteFalso());

    await servico.vincular(pool, dadosVincular());
    await servico.desvincular(pool, dadosDesvincular());

    // grupoRepo.atualizar está mockado para explodir: nenhuma chamada.
    assert.equal(grupoRepo.atualizar.mock.calls.length, 0);
    assert.equal(escritas.atualizar.mock.calls.length, 2, 'só atualizarGrupoAcesso escreve');
    assert.equal(escritas.registrar.mock.calls.length, 2, 'uma auditoria por operação efetiva');
    for (const chamada of escritas.registrar.mock.calls) {
      assert.doesNotMatch(JSON.stringify(chamada.arguments[1]), /senha|token|hash|secret/i, 'nada sensível na auditoria');
    }
  });
});
