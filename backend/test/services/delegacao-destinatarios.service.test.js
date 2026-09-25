'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/delegacao-destinatarios.service');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const autorizacaoRepo = require('../../src/repositories/autorizacao-individual.repository');
const permissaoRepo = require('../../src/repositories/permissao.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de destinatários para delegação (3V —
 * complemento), sem PostgreSQL real.
 *
 * A autoridade desta consulta é "pode delegar ao menos uma autorização
 * AGORA", espelhando a 3I passo a passo. Cada passo do espelho tem um
 * teste que o derruba isoladamente: sem linha, sem pode_delegar, ação
 * inativa, modo NENHUMA, sem concessão efetiva, fora da SST quando
 * exigida, bloqueado, MASTER, inativo. E um teste prova que basta UMA
 * origem passar.
 */

const EMPRESA = 42;
const ATOR = 5;

const origem = (extra = {}) => ({
  id: 70, empresaId: EMPRESA, usuarioId: ATOR, acaoCodigo: 'MOVIMENTAR_ESTOQUE',
  autorizadoPor: 1, podeDelegar: true, origemId: null,
  acaoAtiva: true, acaoExigeSst: false, acaoModo: 'ALTERNATIVA', ...extra,
});

function criarPoolFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (t) => { chamadas.push(t); return { rows: [], rowCount: 0 }; },
    connect: async () => { throw new Error('consulta não deve abrir transação'); },
  };
}

function montar(t, {
  ator = { id: ATOR, empresa_id: EMPRESA, perfil: 'ADMINISTRADOR', ativo: true },
  minhas = [origem()],
  concedido = true,
  integraSst = true,
  bloqueado = false,
} = {}) {
  const registro = { destinatarios: [], sst: 0, bloqueio: 0, concessao: 0 };
  t.mock.method(usuarioRepo, 'buscarPorId', async () => ator);
  t.mock.method(usuarioRepo, 'buscarPorIdParaAtualizacao', async () => { throw new Error('leitura travada no caminho de consulta'); });
  t.mock.method(autorizacaoRepo, 'listarPorUsuario', async () => minhas.map((m) => ({ ...m })));
  t.mock.method(permissaoRepo, 'usuarioTemAutorizacaoIndividual', async () => { registro.concessao += 1; return concedido; });
  t.mock.method(permissaoRepo, 'usuarioIntegraSst', async () => { registro.sst += 1; return integraSst; });
  t.mock.method(permissaoRepo, 'usuarioTemBloqueio', async () => { registro.bloqueio += 1; return bloqueado; });
  t.mock.method(usuarioRepo, 'listarDestinatariosAtivos', async (executor, empresaId, opcoes) => {
    registro.destinatarios.push({ executor, empresaId, opcoes });
    return { destinatarios: [{ id: 9, nome: 'Ana Souza', email: 'ana@x' }], total: 1 };
  });
  return registro;
}

const chamar = (busca) => servico.listarDestinatarios(criarPoolFalso(), { empresaId: EMPRESA, atorId: ATOR, busca });

const esperar403 = (promessa) => assert.rejects(promessa, (erro) => {
  assert.ok(erro instanceof HttpError);
  assert.equal(erro.status, 403);
  assert.equal(erro.codigo, 'CONSULTA_DESTINATARIOS_NAO_AUTORIZADA');
  return true;
});

describe('delegacao-destinatarios — quem pode consultar', () => {
  test('com uma origem própria, repassável e efetiva: devolve a lista', async (t) => {
    const registro = montar(t);

    const resultado = await chamar(null);

    assert.deepEqual(resultado.destinatarios, [{ id: 9, nome: 'Ana Souza', email: 'ana@x' }]);
    assert.equal(resultado.total, 1);
    assert.equal(registro.destinatarios[0].opcoes.excluirId, ATOR, 'o próprio ator fica de fora');
    assert.equal(registro.destinatarios[0].opcoes.limite, 50);
  });

  test('a busca atravessa até o repositório', async (t) => {
    const registro = montar(t);

    await chamar('ana');

    assert.equal(registro.destinatarios[0].opcoes.busca, 'ana');
    assert.equal(registro.destinatarios[0].empresaId, EMPRESA);
  });

  test('MASTER não delega: 403, sem consultar origem nenhuma', async (t) => {
    const registro = montar(t, { ator: { id: ATOR, empresa_id: EMPRESA, perfil: 'MASTER', ativo: true } });

    await esperar403(chamar(null));
    assert.equal(registro.destinatarios.length, 0);
  });

  test('ator inativo ou inexistente: 403', async (t) => {
    montar(t, { ator: { id: ATOR, empresa_id: EMPRESA, perfil: 'ADMINISTRADOR', ativo: false } });
    await esperar403(chamar(null));

    t.mock.restoreAll();
    montar(t, { ator: null });
    await esperar403(chamar(null));
  });

  test('sem nenhuma autorização própria: 403', async (t) => {
    const registro = montar(t, { minhas: [] });

    await esperar403(chamar(null));
    assert.equal(registro.destinatarios.length, 0, 'a lista de pessoas nunca foi lida');
  });

  test('linha sem pode_delegar não conta: poder executar não é poder delegar', async (t) => {
    montar(t, { minhas: [origem({ podeDelegar: false })] });

    await esperar403(chamar(null));
  });

  test('ação inativa, modo NENHUMA ou configuração irreconhecível não contam', async (t) => {
    for (const extra of [{ acaoAtiva: false }, { acaoModo: 'NENHUMA' }, { acaoModo: 'OUTRO' }, { acaoExigeSst: 'sim' }]) {
      t.mock.restoreAll();
      montar(t, { minhas: [origem(extra)] });
      await esperar403(chamar(null));
    }
  });

  test('sem concessão efetiva (a linha some entre a listagem e a checagem): 403', async (t) => {
    montar(t, { concedido: false });

    await esperar403(chamar(null));
  });

  test('H. ação que exige SST, ator fora da SST: 403; dentro: 200', async (t) => {
    const fora = montar(t, { minhas: [origem({ acaoExigeSst: true })], integraSst: false });
    await esperar403(chamar(null));
    assert.equal(fora.sst, 1, 'a SST foi consultada');

    t.mock.restoreAll();
    montar(t, { minhas: [origem({ acaoExigeSst: true })], integraSst: true });
    assert.equal((await chamar(null)).total, 1);
  });

  test('ação que NÃO exige SST não consulta a SST', async (t) => {
    const registro = montar(t, { minhas: [origem({ acaoExigeSst: false })] });

    await chamar(null);

    assert.equal(registro.sst, 0);
  });

  test('H. bloqueio individual na ação: 403', async (t) => {
    montar(t, { bloqueado: true });

    await esperar403(chamar(null));
  });

  test('basta UMA origem passar: a primeira falha, a segunda serve', async (t) => {
    const registro = montar(t, {
      minhas: [origem({ id: 1, podeDelegar: false }), origem({ id: 2, acaoCodigo: 'OUTRA' })],
    });

    const resultado = await chamar(null);

    assert.equal(resultado.total, 1);
    assert.equal(registro.concessao, 1, 'a primeira nem chegou à checagem de concessão');
  });

  test('para na primeira que serve: não consulta as demais', async (t) => {
    const registro = montar(t, { minhas: [origem({ id: 1 }), origem({ id: 2 }), origem({ id: 3 })] });

    await chamar(null);

    assert.equal(registro.concessao, 1);
    assert.equal(registro.bloqueio, 1);
  });

  test('entrada inválida é recusada antes de qualquer leitura', async (t) => {
    const registro = montar(t);
    for (const args of [
      { empresaId: 0, atorId: ATOR }, { empresaId: EMPRESA, atorId: 0 },
      { empresaId: '42', atorId: ATOR }, { empresaId: EMPRESA, atorId: null },
    ]) {
      await assert.rejects(() => servico.listarDestinatarios(criarPoolFalso(), args), TypeError);
    }
    assert.equal(registro.destinatarios.length, 0);
  });

  test('não abre transação e não executa SQL próprio', async (t) => {
    montar(t);
    const pool = criarPoolFalso();

    await servico.listarDestinatarios(pool, { empresaId: EMPRESA, atorId: ATOR });

    assert.deepEqual(pool.chamadas, []);
  });

  test('exporta listarDestinatarios e o predicado atorPodeDelegar (Parte C1); a 3I segue com as três de escrita + o predicado de concessão direta', () => {
    assert.deepEqual(Object.keys(servico).sort(), ['atorPodeDelegar', 'listarDestinatarios']);
    const tresI = require('../../src/services/autorizacao-individual.service');
    assert.deepEqual(Object.keys(tresI).sort(), ['atorPodeConcederDireta', 'concederDireta', 'delegar', 'revogar']);
  });
});
