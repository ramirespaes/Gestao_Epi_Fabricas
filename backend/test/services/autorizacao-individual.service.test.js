'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { concederDireta, delegar, revogar } = require('../../src/services/autorizacao-individual.service');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const permissaoRepo = require('../../src/repositories/permissao.repository');
const autorizacaoRepo = require('../../src/repositories/autorizacao-individual.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de concessão/revogação, sem PostgreSQL real.
 *
 * Todas as funções de repositório são substituídas via t.mock.method
 * (restaurado ao fim de cada teste). Só BEGIN/COMMIT/ROLLBACK passam pelo
 * cliente falso — nenhuma consulta de repositório chega a ele, porque as
 * funções mockadas nunca delegam ao client.query() real. O serviço chama
 * módulos por `modulo.funcao(...)`, nunca desestruturado — é o que torna
 * mock.method eficaz aqui (mesmo padrão de login.service.test.js).
 *
 * O ponto central: toda recusa termina em ROLLBACK e sem chamada a
 * auditoriaRepo.registrar nem a autorizacaoRepo.criar/excluir — "nada
 * aconteceu" nunca deixa rastro.
 */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const MASTER_ID = 1;
const DELEGADOR_ID = 7;
const BENEFICIARIO_ID = 9;
const OUTRO_ID = 11;
const ORIGEM_ID = 100;
const ACAO = 'MOVIMENTAR_ESTOQUE';

const usuario = (id, extra = {}) => Object.freeze({
  id, empresa_id: EMPRESA, nome: `Usuário ${id}`, email: `u${id}@demo.safeworkengenharia.com.br`,
  perfil: 'SUPERVISOR', ativo: true, biometria_cadastrada: false, ...extra,
});
const master = usuario(MASTER_ID, { perfil: 'MASTER' });
const delegador = usuario(DELEGADOR_ID);
const beneficiario = usuario(BENEFICIARIO_ID, { perfil: 'USUARIO' });

const configuracao = (extra = {}) => ({ ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA', ...extra });

const origemValida = (extra = {}) => ({
  id: ORIGEM_ID, empresaId: EMPRESA, usuarioId: DELEGADOR_ID, acaoCodigo: ACAO, motivo: null,
  autorizadoPor: MASTER_ID, podeDelegar: true, origemId: null, criadoEm: new Date('2026-09-21T10:00:00Z'), ...extra,
});

const criada = (extra = {}) => ({
  id: 200, empresaId: EMPRESA, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO, motivo: null,
  autorizadoPor: MASTER_ID, podeDelegar: false, origemId: null, criadoEm: new Date('2026-09-21T12:00:00Z'), ...extra,
});

function criarClienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; },
    release: () => { chamadas.push('RELEASE'); },
  };
}

function criarPoolFalso(cliente) {
  return { connect: async () => cliente };
}

const contar = (chamadas, padrao) => chamadas.filter((c) => padrao.test(c)).length;

/**
 * Mocks padrão: um mundo em que tudo é válido. Cada teste sobrescreve só o
 * que precisa quebrar. Devolve os mocks de escrita para inspeção.
 */
function mundoValido(t, { usuarios = {}, config = configuracao(), origem = origemValida() } = {}) {
  const porId = { [MASTER_ID]: master, [DELEGADOR_ID]: delegador, [BENEFICIARIO_ID]: beneficiario, ...usuarios };
  t.mock.method(usuarioRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => (
    empresaId === EMPRESA && porId[id] ? porId[id] : null
  ));
  t.mock.method(permissaoRepo, 'buscarConfiguracaoAcao', async () => config);
  t.mock.method(permissaoRepo, 'buscarPermissaoAcao', async () => null);
  t.mock.method(permissaoRepo, 'usuarioTemAutorizacaoIndividual', async () => true);
  t.mock.method(permissaoRepo, 'usuarioIntegraSst', async () => false);
  t.mock.method(permissaoRepo, 'usuarioTemBloqueio', async () => false);
  t.mock.method(autorizacaoRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => (
    empresaId === EMPRESA && id === ORIGEM_ID ? origem : null
  ));
  t.mock.method(autorizacaoRepo, 'listarDescendentes', async () => []);
  return {
    criar: t.mock.method(autorizacaoRepo, 'criar', async (_c, dados) => criada(dados)),
    excluir: t.mock.method(autorizacaoRepo, 'excluir', async () => origemValida()),
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
  assert.equal(escritas.excluir.mock.calls.length, 0, 'nada é excluído numa recusa');
  assert.equal(escritas.registrar.mock.calls.length, 0, 'recusa não é auditada — nada aconteceu');
  assert.ok(cliente.chamadas.includes('RELEASE'));
}

describe('concederDireta — caminho válido', () => {
  test('MASTER concede: cria com origem_id NULL, pode_delegar false por padrão, audita na mesma transação e commita', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const resultado = await concederDireta(criarPoolFalso(cliente), {
      empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO,
    });

    assert.equal(resultado.id, 200);
    const dadosCriar = escritas.criar.mock.calls[0].arguments[1];
    assert.deepEqual(dadosCriar, {
      empresaId: EMPRESA, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO, autorizadoPor: MASTER_ID, podeDelegar: false, origemId: null, motivo: null,
    });

    assert.equal(escritas.registrar.mock.calls.length, 1);
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.empresaId, EMPRESA);
    assert.equal(auditoria.usuarioId, MASTER_ID, 'quem agiu é o concedente');
    assert.equal(auditoria.acao, 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA');
    assert.equal(auditoria.referencia, '200');
    assert.deepEqual(auditoria.contexto, { tipo: 'DIRETA' });
    assert.deepEqual(auditoria.dadosNovos, { usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO, autorizadoPor: MASTER_ID, podeDelegar: false, origemId: null });

    assert.equal(contar(cliente.chamadas, /^BEGIN$/), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 0);
    assert.ok(cliente.chamadas.indexOf('COMMIT') < cliente.chamadas.indexOf('RELEASE'));
  });

  test('pode_delegar=true só quando explicitamente pedido', async (t) => {
    const escritas = mundoValido(t);

    await concederDireta(criarPoolFalso(criarClienteFalso()), {
      empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO, podeDelegar: true, motivo: 'chefe do almoxarifado',
    });

    assert.equal(escritas.criar.mock.calls[0].arguments[1].podeDelegar, true);
    assert.equal(escritas.criar.mock.calls[0].arguments[1].motivo, 'chefe do almoxarifado');
    assert.equal(escritas.registrar.mock.calls[0].arguments[1].dadosNovos.podeDelegar, true);
  });

  test('autorizado_por é sempre o concedente autenticado — nunca um valor vindo dos dados', async (t) => {
    const escritas = mundoValido(t);

    await concederDireta(criarPoolFalso(criarClienteFalso()), {
      empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO, autorizadoPor: OUTRO_ID, origemId: 55,
    });

    const dados = escritas.criar.mock.calls[0].arguments[1];
    assert.equal(dados.autorizadoPor, MASTER_ID, 'autorizadoPor extra nos dados é ignorado');
    assert.equal(dados.origemId, null, 'origemId extra nos dados é ignorado: concessão direta nunca tem origem');
  });

  test('ALTERNATIVA e OBRIGATORIA aceitam a concessão; exige_sst não é dispensado nem exigido no ato de conceder', async (t) => {
    for (const config of [configuracao({ modoAutorizacaoIndividual: 'ALTERNATIVA' }), configuracao({ modoAutorizacaoIndividual: 'OBRIGATORIA', exigeSst: true })]) {
      const escritas = mundoValido(t, { config });
      await concederDireta(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO });
      assert.equal(escritas.criar.mock.calls.length, 1, `modo ${config.modoAutorizacaoIndividual} deve permitir a concessão`);
    }
  });
});

describe('modo NENHUMA e configuração inválida — nenhuma autorização individual é criada', () => {
  const configsInvalidas = [
    ['modo desconhecido', configuracao({ modoAutorizacaoIndividual: 'VALOR_INESPERADO' })],
    ['modo ausente', configuracao({ modoAutorizacaoIndividual: undefined })],
    ['exigeSst não booleano', configuracao({ exigeSst: 'false' })],
    ['exigeSst ausente', configuracao({ exigeSst: undefined })],
    ['exigeSst nulo', configuracao({ exigeSst: null })],
  ];

  test('concessão direta para ação em modo NENHUMA: 400, ROLLBACK e sem rastro', async (t) => {
    const escritas = mundoValido(t, { config: configuracao({ modoAutorizacaoIndividual: 'NENHUMA' }) });
    const cliente = criarClienteFalso();

    await esperarHttpError(concederDireta(criarPoolFalso(cliente), { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO }), 400, 'CONCESSAO_INVALIDA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('delegação a partir de origem cuja ação está em modo NENHUMA: 403, ROLLBACK e sem rastro', async (t) => {
    const escritas = mundoValido(t, { config: configuracao({ modoAutorizacaoIndividual: 'NENHUMA' }) });
    const cliente = criarClienteFalso();

    await esperarHttpError(delegar(criarPoolFalso(cliente), { empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, origemId: ORIGEM_ID, usuarioId: BENEFICIARIO_ID }), 403, 'DELEGACAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('concessão direta com configuração de ação inválida: 400, mesmo com a ação ATIVA', async (t) => {
    for (const [descricao, config] of configsInvalidas) {
      const escritas = mundoValido(t, { config });
      const cliente = criarClienteFalso();

      await esperarHttpError(concederDireta(criarPoolFalso(cliente), { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO }), 400, 'CONCESSAO_INVALIDA');

      assert.equal(config.ativo, true, `${descricao}: o cenário precisa manter a ação ativa para ter valor`);
      assertRecusaSemRastro(cliente, escritas);
    }
  });

  test('delegação com configuração de ação inválida: 403, mesmo com a ação ATIVA', async (t) => {
    for (const [, config] of configsInvalidas) {
      const escritas = mundoValido(t, { config });
      const cliente = criarClienteFalso();

      await esperarHttpError(delegar(criarPoolFalso(cliente), { empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, origemId: ORIGEM_ID, usuarioId: BENEFICIARIO_ID }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      assertRecusaSemRastro(cliente, escritas);
    }
  });
});

describe('concederDireta — recusas, todas com ROLLBACK e sem rastro', () => {
  test('autoconcessão é recusada antes de qualquer conexão', async (t) => {
    const escritas = mundoValido(t);
    let conectou = false;
    const pool = { connect: async () => { conectou = true; return criarClienteFalso(); } };

    await esperarHttpError(concederDireta(pool, { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: MASTER_ID, acaoCodigo: ACAO }), 400, 'AUTOCONCESSAO_NAO_PERMITIDA');

    assert.equal(conectou, false);
    assert.equal(escritas.criar.mock.calls.length, 0);
  });

  test('concedente não-MASTER: 403 CONCESSAO_NAO_AUTORIZADA', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(concederDireta(criarPoolFalso(cliente), { empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO }), 403, 'CONCESSAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('concedente inexistente, inativo ou de outra empresa: mesmo 403, indistinguível', async (t) => {
    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    const escritasInexistente = mundoValido(t);
    await esperarHttpError(concederDireta(pool, { empresaId: EMPRESA, concedidoPor: 555, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO }), 403, 'CONCESSAO_NAO_AUTORIZADA');
    assert.equal(escritasInexistente.criar.mock.calls.length, 0);

    const escritasInativo = mundoValido(t, { usuarios: { [MASTER_ID]: usuario(MASTER_ID, { perfil: 'MASTER', ativo: false }) } });
    await esperarHttpError(concederDireta(pool, { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO }), 403, 'CONCESSAO_NAO_AUTORIZADA');
    assert.equal(escritasInativo.criar.mock.calls.length, 0);

    const escritasOutraEmpresa = mundoValido(t);
    await esperarHttpError(concederDireta(pool, { empresaId: EMPRESA_OUTRA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO }), 403, 'CONCESSAO_NAO_AUTORIZADA');
    assert.equal(escritasOutraEmpresa.criar.mock.calls.length, 0, 'o MASTER de A não concede na empresa B');
  });

  test('beneficiário inexistente, inativo ou de outra empresa: 400 CONCESSAO_INVALIDA, indistinguível', async (t) => {
    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    let escritas = mundoValido(t);
    await esperarHttpError(concederDireta(pool, { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: 555, acaoCodigo: ACAO }), 400, 'CONCESSAO_INVALIDA');
    assertRecusaSemRastro(cliente, escritas);

    escritas = mundoValido(t, { usuarios: { [BENEFICIARIO_ID]: usuario(BENEFICIARIO_ID, { ativo: false }) } });
    await esperarHttpError(concederDireta(pool, { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO }), 400, 'CONCESSAO_INVALIDA');
    assert.equal(escritas.criar.mock.calls.length, 0);
  });

  test('ação inexistente no catálogo ou inativa: 400 CONCESSAO_INVALIDA', async (t) => {
    const pool = criarPoolFalso(criarClienteFalso());

    let escritas = mundoValido(t, { config: null });
    await esperarHttpError(concederDireta(pool, { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: 'ACAO_QUE_NAO_EXISTE' }), 400, 'CONCESSAO_INVALIDA');
    assert.equal(escritas.criar.mock.calls.length, 0);

    escritas = mundoValido(t, { config: configuracao({ ativo: false }) });
    await esperarHttpError(concederDireta(pool, { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO }), 400, 'CONCESSAO_INVALIDA');
    assert.equal(escritas.criar.mock.calls.length, 0);
  });

  test('duplicidade (UNIQUE parcial de autorização direta): 409 AUTORIZACAO_JA_EXISTE, sem auditoria', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(autorizacaoRepo, 'criar', async () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); });
    const cliente = criarClienteFalso();

    await esperarHttpError(concederDireta(criarPoolFalso(cliente), { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO }), 409, 'AUTORIZACAO_JA_EXISTE');

    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });

  test('falha na auditoria depois do INSERT: ROLLBACK — a concessão não sobrevive sem o seu registro', async (t) => {
    const escritas = mundoValido(t);
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('conexão perdida'); });
    const cliente = criarClienteFalso();

    await assert.rejects(concederDireta(criarPoolFalso(cliente), { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO }), /conexão perdida/);

    assert.equal(escritas.criar.mock.calls.length, 1, 'o INSERT chegou a acontecer dentro da transação...');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1, '...mas a transação inteira é desfeita');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  });

  test('entradas malformadas lançam TypeError antes de qualquer conexão', async (t) => {
    mundoValido(t);
    const pool = { connect: async () => { throw new Error('não deveria conectar'); } };
    const base = { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO };

    await assert.rejects(concederDireta(pool, { ...base, empresaId: 0 }), TypeError);
    await assert.rejects(concederDireta(pool, { ...base, concedidoPor: '1' }), TypeError);
    await assert.rejects(concederDireta(pool, { ...base, usuarioId: -1 }), TypeError);
    await assert.rejects(concederDireta(pool, { ...base, podeDelegar: 'sim' }), TypeError);
    await assert.rejects(concederDireta(pool, { ...base, motivo: 42 }), TypeError);
  });
});

describe('delegar — caminho válido', () => {
  test('delegador com origem própria e pode_delegar=true: cria com origem_id, ação da origem, autorizado_por = delegador, audita e commita', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const resultado = await delegar(criarPoolFalso(cliente), {
      empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, origemId: ORIGEM_ID, usuarioId: BENEFICIARIO_ID,
    });

    assert.equal(resultado.id, 200);
    const dados = escritas.criar.mock.calls[0].arguments[1];
    assert.deepEqual(dados, {
      empresaId: EMPRESA, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO, autorizadoPor: DELEGADOR_ID, podeDelegar: false, origemId: ORIGEM_ID, motivo: null,
    });

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.usuarioId, DELEGADOR_ID);
    assert.equal(auditoria.acao, 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA');
    assert.deepEqual(auditoria.contexto, { tipo: 'DELEGADA', origemId: ORIGEM_ID });
    assert.equal(auditoria.dadosNovos.origemId, ORIGEM_ID);

    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 0);
  });

  test('a ação da delegação vem SEMPRE da origem — um acaoCodigo extra nos dados é ignorado (origem de outra ação é impossível por construção)', async (t) => {
    const escritas = mundoValido(t);

    await delegar(criarPoolFalso(criarClienteFalso()), {
      empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, origemId: ORIGEM_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: 'APROVAR_SOLICITACAO',
    });

    assert.equal(escritas.criar.mock.calls[0].arguments[1].acaoCodigo, ACAO, 'a ação é a da origem, nunca a informada');
  });

  test('a origem é lida com FOR UPDATE (variante travada), nunca com a leitura comum', async (t) => {
    mundoValido(t);
    const semTrava = t.mock.method(autorizacaoRepo, 'buscarPorId', async () => origemValida());
    const comTrava = autorizacaoRepo.buscarPorIdParaAtualizacao;

    await delegar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, origemId: ORIGEM_ID, usuarioId: BENEFICIARIO_ID });

    assert.equal(semTrava.mock.calls.length, 0);
    assert.equal(comTrava.mock.calls.length, 1);
    assert.deepEqual(comTrava.mock.calls[0].arguments.slice(1), [EMPRESA, ORIGEM_ID]);
  });

  test('delegador pode repassar pode_delegar=true explicitamente (subdelegação)', async (t) => {
    const escritas = mundoValido(t);

    await delegar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, origemId: ORIGEM_ID, usuarioId: BENEFICIARIO_ID, podeDelegar: true });

    assert.equal(escritas.criar.mock.calls[0].arguments[1].podeDelegar, true);
  });

  test('a autorização efetiva vem da linha própria do delegador (usuario_autorizacoes), não de permissoes_acao', async (t) => {
    const escritas = mundoValido(t);
    const porPerfil = t.mock.method(permissaoRepo, 'buscarPermissaoAcao', async () => ({ permitido: false }));
    const individual = t.mock.method(permissaoRepo, 'usuarioTemAutorizacaoIndividual', async () => true);

    await delegar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, origemId: ORIGEM_ID, usuarioId: BENEFICIARIO_ID });

    assert.equal(individual.mock.calls.length, 1);
    assert.deepEqual(individual.mock.calls[0].arguments.slice(1), [EMPRESA, DELEGADOR_ID, ACAO]);
    assert.equal(porPerfil.mock.calls.length, 0, 'ALTERNATIVA/OBRIGATORIA não dependem do perfil aqui; NENHUMA nem chega a esta etapa');
    assert.equal(escritas.criar.mock.calls.length, 1);
  });

  test('exige_sst=true com delegador na SST: permite', async (t) => {
    const escritas = mundoValido(t, { config: configuracao({ modoAutorizacaoIndividual: 'OBRIGATORIA', exigeSst: true }) });
    t.mock.method(permissaoRepo, 'usuarioIntegraSst', async () => true);

    await delegar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, origemId: ORIGEM_ID, usuarioId: BENEFICIARIO_ID });

    assert.equal(escritas.criar.mock.calls.length, 1);
  });
});

describe('delegar — recusas, todas 403 DELEGACAO_NAO_AUTORIZADA (indistinguíveis), com ROLLBACK e sem rastro', () => {
  const dadosValidos = { empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, origemId: ORIGEM_ID, usuarioId: BENEFICIARIO_ID };

  async function esperarDelegacaoNegada(t, cliente, { usuarios, config, origem } = {}, dados = dadosValidos) {
    const escritas = mundoValido(t, { usuarios, config, origem });
    await esperarHttpError(delegar(criarPoolFalso(cliente), dados), 403, 'DELEGACAO_NAO_AUTORIZADA');
    assertRecusaSemRastro(cliente, escritas);
  }

  test('autoconcessão é recusada antes de qualquer conexão', async (t) => {
    mundoValido(t);
    const pool = { connect: async () => { throw new Error('não deveria conectar'); } };
    await esperarHttpError(delegar(pool, { ...dadosValidos, usuarioId: DELEGADOR_ID }), 400, 'AUTOCONCESSAO_NAO_PERMITIDA');
  });

  test('origem inexistente', async (t) => {
    await esperarDelegacaoNegada(t, criarClienteFalso(), {}, { ...dadosValidos, origemId: 999 });
  });

  test('origem de outra empresa: o filtro de empresa da leitura travada não a encontra', async (t) => {
    await esperarDelegacaoNegada(t, criarClienteFalso(), { usuarios: { [DELEGADOR_ID]: delegador } }, { ...dadosValidos, empresaId: EMPRESA_OUTRA });
  });

  test('origem cujo beneficiário não é o delegador (tentativa de delegar autoridade alheia)', async (t) => {
    await esperarDelegacaoNegada(t, criarClienteFalso(), { origem: origemValida({ usuarioId: OUTRO_ID }) });
  });

  test('origem própria mas com pode_delegar=false: executar não é delegar', async (t) => {
    await esperarDelegacaoNegada(t, criarClienteFalso(), { origem: origemValida({ podeDelegar: false }) });
  });

  test('grupo ou perfil não fornecem direito de delegar: sem linha própria com pode_delegar, nada mais é sequer consultado', async (t) => {
    const cliente = criarClienteFalso();
    const escritas = mundoValido(t, { origem: null });
    const porPerfil = permissaoRepo.buscarPermissaoAcao;
    const grupo = t.mock.method(permissaoRepo, 'buscarGrupoAcessoDoUsuario', async () => ({ id: 1, ativo: true }));

    await esperarHttpError(delegar(criarPoolFalso(cliente), dadosValidos), 403, 'DELEGACAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
    assert.equal(porPerfil.mock.calls.length, 0);
    assert.equal(grupo.mock.calls.length, 0, 'grupo nunca é consultado para decidir delegação');
  });

  test('delegador inexistente, inativo ou de outra empresa', async (t) => {
    await esperarDelegacaoNegada(t, criarClienteFalso(), {}, { ...dadosValidos, concedidoPor: 555 });
    await esperarDelegacaoNegada(t, criarClienteFalso(), { usuarios: { [DELEGADOR_ID]: usuario(DELEGADOR_ID, { ativo: false }) } });
  });

  test('beneficiário inexistente ou inativo', async (t) => {
    await esperarDelegacaoNegada(t, criarClienteFalso(), {}, { ...dadosValidos, usuarioId: 555 });
    await esperarDelegacaoNegada(t, criarClienteFalso(), { usuarios: { [BENEFICIARIO_ID]: usuario(BENEFICIARIO_ID, { ativo: false }) } });
  });

  test('ação da origem desativada no catálogo depois de concedida', async (t) => {
    await esperarDelegacaoNegada(t, criarClienteFalso(), { config: configuracao({ ativo: false }) });
    await esperarDelegacaoNegada(t, criarClienteFalso(), { config: null });
  });

  test('delegador bloqueado individualmente para a ação: sem autorização efetiva, não delega', async (t) => {
    const cliente = criarClienteFalso();
    const escritas = mundoValido(t);
    t.mock.method(permissaoRepo, 'usuarioTemBloqueio', async () => true);

    await esperarHttpError(delegar(criarPoolFalso(cliente), dadosValidos), 403, 'DELEGACAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('exige_sst=true e delegador fora da SST: não delega (aprovar/reprovar continuam exigindo SST real)', async (t) => {
    const cliente = criarClienteFalso();
    const escritas = mundoValido(t, { config: configuracao({ modoAutorizacaoIndividual: 'OBRIGATORIA', exigeSst: true }) });
    t.mock.method(permissaoRepo, 'usuarioIntegraSst', async () => false);

    await esperarHttpError(delegar(criarPoolFalso(cliente), dadosValidos), 403, 'DELEGACAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('delegador que perdeu a autorização efetiva (linha própria já não é mais vista): 403', async (t) => {
    const cliente = criarClienteFalso();
    const escritas = mundoValido(t);
    t.mock.method(permissaoRepo, 'usuarioTemAutorizacaoIndividual', async () => false);

    await esperarHttpError(delegar(criarPoolFalso(cliente), dadosValidos), 403, 'DELEGACAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('MASTER não delega: o caminho dele é concederDireta — 403, sem rastro, mesmo com origem válida', async (t) => {
    const cliente = criarClienteFalso();
    const escritas = mundoValido(t, { origem: origemValida({ usuarioId: MASTER_ID }) });

    await esperarHttpError(delegar(criarPoolFalso(cliente), { ...dadosValidos, concedidoPor: MASTER_ID }), 403, 'DELEGACAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('MASTER é recusado pelo perfil relido do banco, antes mesmo de a origem ser consultada', async (t) => {
    const cliente = criarClienteFalso();
    mundoValido(t);
    const origem = autorizacaoRepo.buscarPorIdParaAtualizacao;

    await esperarHttpError(delegar(criarPoolFalso(cliente), { ...dadosValidos, concedidoPor: MASTER_ID }), 403, 'DELEGACAO_NAO_AUTORIZADA');

    assert.equal(origem.mock.calls.length, 0, 'a separação de caminhos é decidida pelo perfil, não pela origem');
  });

  test('violação da FK composta de origem no INSERT (origem mudou entre leitura e gravação): nega sem gravar', async (t) => {
    const cliente = criarClienteFalso();
    const escritas = mundoValido(t);
    t.mock.method(autorizacaoRepo, 'criar', async () => { throw Object.assign(new Error('fk'), { code: '23503' }); });

    await esperarHttpError(delegar(criarPoolFalso(cliente), dadosValidos), 403, 'DELEGACAO_NAO_AUTORIZADA');

    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });

  test('mesma origem delegando de novo para o mesmo usuário: 409 AUTORIZACAO_JA_EXISTE', async (t) => {
    mundoValido(t);
    t.mock.method(autorizacaoRepo, 'criar', async () => { throw Object.assign(new Error('dup'), { code: '23505' }); });

    await esperarHttpError(delegar(criarPoolFalso(criarClienteFalso()), dadosValidos), 409, 'AUTORIZACAO_JA_EXISTE');
  });
});

describe('revogar', () => {
  const alvoDelegada = origemValida({ id: 300, usuarioId: BENEFICIARIO_ID, autorizadoPor: DELEGADOR_ID, podeDelegar: false, origemId: ORIGEM_ID });

  function mundoRevogacao(t, { alvo = alvoDelegada, descendentes = [], usuarios } = {}) {
    const escritas = mundoValido(t, { usuarios });
    t.mock.method(autorizacaoRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => (empresaId === EMPRESA && alvo && id === alvo.id ? alvo : null));
    const listar = t.mock.method(autorizacaoRepo, 'listarDescendentes', async () => descendentes);
    const excluir = t.mock.method(autorizacaoRepo, 'excluir', async () => alvo);
    return { ...escritas, listar, excluir };
  }

  test('MASTER revoga qualquer autorização da empresa: enumera descendentes ANTES de excluir, exclui uma vez, audita com total e amostra, commita', async (t) => {
    const descendentes = [{ id: 301 }, { id: 302 }, { id: 303 }];
    const escritas = mundoRevogacao(t, { descendentes });
    const cliente = criarClienteFalso();

    const resultado = await revogar(criarPoolFalso(cliente), { empresaId: EMPRESA, revogadoPor: MASTER_ID, autorizacaoId: 300, motivo: 'reorganização' });

    assert.equal(resultado.descendentesObservados, 3);
    assert.equal(resultado.revogada.id, 300);
    assert.equal(escritas.listar.mock.calls.length, 1);
    assert.equal(escritas.excluir.mock.calls.length, 1, 'um único DELETE — a cascata é da FK');
    assert.deepEqual(escritas.excluir.mock.calls[0].arguments.slice(1), [EMPRESA, 300]);

    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.usuarioId, MASTER_ID);
    assert.equal(auditoria.acao, 'AUTORIZACAO_INDIVIDUAL_REVOGADA');
    assert.equal(auditoria.referencia, '300');
    assert.equal(auditoria.descricao, 'reorganização');
    assert.deepEqual(auditoria.contexto, { descendentesObservados: { total: 3, ids: [301, 302, 303], amostraLimitadaA: 50 } });
    assert.deepEqual(auditoria.dadosAnteriores, { usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO, autorizadoPor: DELEGADOR_ID, podeDelegar: false, origemId: ORIGEM_ID });

    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 0);
  });

  test('a amostra de ids auditados é limitada a 50, mas o total é sempre exato', async (t) => {
    const descendentes = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i }));
    const escritas = mundoRevogacao(t, { descendentes });

    await revogar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, revogadoPor: MASTER_ID, autorizacaoId: 300 });

    const { descendentesObservados } = escritas.registrar.mock.calls[0].arguments[1].contexto;
    assert.equal(descendentesObservados.total, 120);
    assert.equal(descendentesObservados.ids.length, 50);
    assert.equal(descendentesObservados.ids[0], 1000);
  });

  test('concedente não-MASTER revoga a autorização que ele mesmo concedeu', async (t) => {
    const escritas = mundoRevogacao(t);

    const resultado = await revogar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, revogadoPor: DELEGADOR_ID, autorizacaoId: 300 });

    assert.equal(resultado.revogada.id, 300);
    assert.equal(escritas.excluir.mock.calls.length, 1);
  });

  test('não-MASTER que NÃO concedeu aquela linha: 403 REVOGACAO_NAO_AUTORIZADA, sem rastro', async (t) => {
    const escritas = mundoRevogacao(t, { usuarios: { [OUTRO_ID]: usuario(OUTRO_ID) } });
    const cliente = criarClienteFalso();

    await esperarHttpError(revogar(criarPoolFalso(cliente), { empresaId: EMPRESA, revogadoPor: OUTRO_ID, autorizacaoId: 300 }), 403, 'REVOGACAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
    assert.equal(escritas.listar.mock.calls.length, 0);
  });

  test('o beneficiário não revoga a própria autorização só por ser beneficiário', async (t) => {
    const escritas = mundoRevogacao(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(revogar(criarPoolFalso(cliente), { empresaId: EMPRESA, revogadoPor: BENEFICIARIO_ID, autorizacaoId: 300 }), 403, 'REVOGACAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('autorização inexistente nesta empresa (inclusive de outra empresa): 404 AUTORIZACAO_NAO_ENCONTRADA', async (t) => {
    const escritas = mundoRevogacao(t);
    const cliente = criarClienteFalso();

    await esperarHttpError(revogar(criarPoolFalso(cliente), { empresaId: EMPRESA, revogadoPor: MASTER_ID, autorizacaoId: 999 }), 404, 'AUTORIZACAO_NAO_ENCONTRADA');

    assertRecusaSemRastro(cliente, escritas);
  });

  test('revogador inexistente/inativo/de outra empresa: 403, antes de sequer procurar a autorização', async (t) => {
    const escritas = mundoRevogacao(t, { usuarios: { [MASTER_ID]: usuario(MASTER_ID, { perfil: 'MASTER', ativo: false }) } });
    const cliente = criarClienteFalso();
    const buscarAlvo = autorizacaoRepo.buscarPorIdParaAtualizacao;

    await esperarHttpError(revogar(criarPoolFalso(cliente), { empresaId: EMPRESA, revogadoPor: MASTER_ID, autorizacaoId: 300 }), 403, 'REVOGACAO_NAO_AUTORIZADA');

    assertRecusaSemRastro(cliente, escritas);
    assert.equal(buscarAlvo.mock.calls.length, 0);
  });

  test('falha na auditoria depois do DELETE: ROLLBACK — a revogação não sobrevive sem o seu registro', async (t) => {
    const escritas = mundoRevogacao(t);
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('conexão perdida'); });
    const cliente = criarClienteFalso();

    await assert.rejects(revogar(criarPoolFalso(cliente), { empresaId: EMPRESA, revogadoPor: MASTER_ID, autorizacaoId: 300 }), /conexão perdida/);

    assert.equal(escritas.excluir.mock.calls.length, 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 0);
  });

  test('entradas malformadas lançam TypeError antes de qualquer conexão', async (t) => {
    mundoRevogacao(t);
    const pool = { connect: async () => { throw new Error('não deveria conectar'); } };

    await assert.rejects(revogar(pool, { empresaId: 0, revogadoPor: MASTER_ID, autorizacaoId: 300 }), TypeError);
    await assert.rejects(revogar(pool, { empresaId: EMPRESA, revogadoPor: MASTER_ID, autorizacaoId: '300' }), TypeError);
    await assert.rejects(revogar(pool, { empresaId: EMPRESA, revogadoPor: MASTER_ID, autorizacaoId: 300, motivo: {} }), TypeError);
  });
});

describe('isolamento e não-interferência', () => {
  test('nenhuma das três operações chama o middleware nem consulta grupo/permissões de recurso', async (t) => {
    const escritas = mundoValido(t);
    const grupo = t.mock.method(permissaoRepo, 'buscarGrupoAcessoDoUsuario', async () => null);
    const recurso = t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => null);
    const recursoIndividual = t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => null);
    const pool = criarPoolFalso(criarClienteFalso());

    await concederDireta(pool, { empresaId: EMPRESA, concedidoPor: MASTER_ID, usuarioId: BENEFICIARIO_ID, acaoCodigo: ACAO });
    await delegar(pool, { empresaId: EMPRESA, concedidoPor: DELEGADOR_ID, origemId: ORIGEM_ID, usuarioId: BENEFICIARIO_ID });
    t.mock.method(autorizacaoRepo, 'buscarPorIdParaAtualizacao', async () => origemValida());
    await revogar(pool, { empresaId: EMPRESA, revogadoPor: MASTER_ID, autorizacaoId: ORIGEM_ID });

    assert.equal(grupo.mock.calls.length, 0);
    assert.equal(recurso.mock.calls.length, 0);
    assert.equal(recursoIndividual.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 3, 'cada operação bem-sucedida gera exatamente um registro de auditoria');
  });
});
