'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/autorizacao-consulta.service');
const autorizacaoRepo = require('../../src/repositories/autorizacao-individual.repository');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do serviço de consulta de autorizações individuais
 * (Subetapa 3V), sem PostgreSQL real.
 *
 * O que precisa ficar garantido — tudo gira em torno de UMA decisão, o
 * filtro `concedidasPor`, que é onde a autoridade de leitura vira SQL:
 *
 *   1. MASTER lê sem filtro, qualquer pessoa da empresa;
 *   2. não-MASTER lendo a si mesmo lê sem filtro;
 *   3. não-MASTER lendo outra pessoa lê APENAS o que ele concedeu;
 *   4. ator inexistente ou inativo recebe 403 e nada é lido;
 *   5. perfil e `ativo` vêm do BANCO, nunca do chamador;
 *   6. nada é escrito e nada é auditado.
 */

const EMPRESA = 42;
const MASTER = 1;
const ADMIN = 5;
const OUTRO = 9;

const LINHAS = Object.freeze([
  Object.freeze({
    id: 100, empresaId: EMPRESA, usuarioId: OUTRO, acaoCodigo: 'MOVIMENTAR_ESTOQUE',
    motivo: null, autorizadoPor: MASTER, podeDelegar: true, origemId: null,
    usuarioNome: 'Ana Souza', autorizadoPorNome: 'Master', acaoNome: 'Movimentar estoque',
    acaoAtiva: true, acaoExigeSst: false, acaoModo: 'ALTERNATIVA',
  }),
]);

function criarPoolFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; },
    connect: async () => { chamadas.push('CONNECT'); throw new Error('consulta não deve abrir transação'); },
  };
}

function comAtor(t, ator) {
  const pedidos = [];
  t.mock.method(usuarioRepo, 'buscarPorId', async (executor, empresaId, id) => {
    pedidos.push({ executor, empresaId, id });
    return ator;
  });
  // A variante TRAVADA é do caminho de escrita: uma consulta que a use
  // estaria pondo lock no caminho de leitura.
  t.mock.method(usuarioRepo, 'buscarPorIdParaAtualizacao', async () => {
    throw new Error('consulta não deve usar a leitura travada');
  });
  return pedidos;
}

function comRepositorio(t, linhas = LINHAS) {
  const chamadas = [];
  t.mock.method(autorizacaoRepo, 'listarPorUsuario', async (executor, empresaId, usuarioId, opcoes) => {
    chamadas.push({ executor, empresaId, usuarioId, opcoes });
    return linhas.map((l) => ({ ...l }));
  });
  // As funções travadas da 3I não pertencem a este caminho.
  t.mock.method(autorizacaoRepo, 'listarPorUsuarioAcaoParaAtualizacao', async () => {
    throw new Error('consulta não deve usar leitura travada');
  });
  t.mock.method(autorizacaoRepo, 'criar', async () => { throw new Error('consulta não escreve'); });
  t.mock.method(autorizacaoRepo, 'excluir', async () => { throw new Error('consulta não exclui'); });
  return chamadas;
}

const usuario = (id, perfil, extra = {}) => ({
  id, empresa_id: EMPRESA, nome: `Usuário ${id}`, perfil, ativo: true, ...extra,
});

describe('autorizacao-consulta.service — autoridade de leitura', () => {
  test('MASTER lê qualquer pessoa sem filtro, e o escopo diz TOTAL', async (t) => {
    comAtor(t, usuario(MASTER, 'MASTER'));
    const chamadas = comRepositorio(t);

    const resultado = await servico.listarPorUsuario(criarPoolFalso(), {
      empresaId: EMPRESA, atorId: MASTER, usuarioId: OUTRO,
    });

    assert.equal(chamadas[0].opcoes.concedidasPor, null, 'sem restrição');
    assert.equal(chamadas[0].usuarioId, OUTRO);
    assert.equal(resultado.escopo, 'TOTAL');
    assert.equal(resultado.autorizacoes.length, 1);
  });

  test('não-MASTER lendo a si mesmo não recebe filtro: são as autorizações dele', async (t) => {
    comAtor(t, usuario(ADMIN, 'ADMINISTRADOR'));
    const chamadas = comRepositorio(t);

    const resultado = await servico.listarPorUsuario(criarPoolFalso(), {
      empresaId: EMPRESA, atorId: ADMIN, usuarioId: ADMIN,
    });

    assert.equal(chamadas[0].opcoes.concedidasPor, null);
    assert.equal(resultado.escopo, 'PROPRIAS');
  });

  test('não-MASTER lendo OUTRA pessoa recebe o filtro do que ele concedeu', async (t) => {
    comAtor(t, usuario(ADMIN, 'ADMINISTRADOR'));
    const chamadas = comRepositorio(t);

    const resultado = await servico.listarPorUsuario(criarPoolFalso(), {
      empresaId: EMPRESA, atorId: ADMIN, usuarioId: OUTRO,
    });

    assert.equal(chamadas[0].opcoes.concedidasPor, ADMIN, 'só o que ele concedeu');
    assert.equal(resultado.escopo, 'CONCEDIDAS_POR_MIM');
  });

  test('SUPERVISOR e USUARIO recebem o mesmo tratamento de não-MASTER', async (t) => {
    for (const perfil of ['SUPERVISOR', 'USUARIO', 'ADMINISTRADOR']) {
      t.mock.restoreAll();
      comAtor(t, usuario(ADMIN, perfil));
      const chamadas = comRepositorio(t);

      await servico.listarPorUsuario(criarPoolFalso(), { empresaId: EMPRESA, atorId: ADMIN, usuarioId: OUTRO });

      assert.equal(chamadas[0].opcoes.concedidasPor, ADMIN, `${perfil} não deveria ler tudo`);
    }
  });

  test('ator inativo recebe 403 e nada é lido', async (t) => {
    comAtor(t, usuario(MASTER, 'MASTER', { ativo: false }));
    const chamadas = comRepositorio(t);

    await assert.rejects(
      () => servico.listarPorUsuario(criarPoolFalso(), { empresaId: EMPRESA, atorId: MASTER, usuarioId: OUTRO }),
      (erro) => {
        assert.ok(erro instanceof HttpError);
        assert.equal(erro.status, 403);
        assert.equal(erro.codigo, 'AUTORIZACAO_CONSULTA_NAO_AUTORIZADA');
        return true;
      },
    );

    assert.equal(chamadas.length, 0, 'nenhuma autorização foi sequer buscada');
  });

  test('ator inexistente na empresa recebe 403', async (t) => {
    comAtor(t, null);
    const chamadas = comRepositorio(t);

    await assert.rejects(
      () => servico.listarPorUsuario(criarPoolFalso(), { empresaId: EMPRESA, atorId: 999, usuarioId: OUTRO }),
      (erro) => erro.status === 403,
    );

    assert.equal(chamadas.length, 0);
  });

  test('o perfil vem do banco: um MASTER forjado no argumento não existe', async (t) => {
    const pedidos = comAtor(t, usuario(ADMIN, 'ADMINISTRADOR'));
    const chamadas = comRepositorio(t);

    await servico.listarPorUsuario(criarPoolFalso(), {
      empresaId: EMPRESA, atorId: ADMIN, usuarioId: OUTRO,
      // Campos que um chamador descuidado poderia passar adiante.
      perfil: 'MASTER', isMaster: true,
    });

    assert.equal(pedidos.length, 1, 'o ator foi relido do banco');
    assert.equal(chamadas[0].opcoes.concedidasPor, ADMIN, 'o perfil forjado foi ignorado');
  });

  test('a empresa da consulta é a recebida, e vai ao repositório e à releitura do ator', async (t) => {
    const pedidos = comAtor(t, usuario(MASTER, 'MASTER'));
    const chamadas = comRepositorio(t);
    const pool = criarPoolFalso();

    await servico.listarPorUsuario(pool, { empresaId: EMPRESA, atorId: MASTER, usuarioId: OUTRO });

    assert.equal(pedidos[0].empresaId, EMPRESA);
    assert.equal(pedidos[0].executor, pool);
    assert.equal(chamadas[0].empresaId, EMPRESA);
    assert.equal(chamadas[0].executor, pool);
  });

  test('entrada inválida é recusada antes de qualquer leitura', async (t) => {
    const pedidos = comAtor(t, usuario(MASTER, 'MASTER'));
    comRepositorio(t);

    for (const argumentos of [
      { empresaId: 0, atorId: MASTER, usuarioId: OUTRO },
      { empresaId: -1, atorId: MASTER, usuarioId: OUTRO },
      { empresaId: 1.5, atorId: MASTER, usuarioId: OUTRO },
      { empresaId: null, atorId: MASTER, usuarioId: OUTRO },
      { empresaId: EMPRESA, atorId: 0, usuarioId: OUTRO },
      { empresaId: EMPRESA, atorId: MASTER, usuarioId: 0 },
      { empresaId: EMPRESA, atorId: MASTER, usuarioId: '9' },
      { empresaId: EMPRESA, atorId: MASTER, usuarioId: undefined },
    ]) {
      await assert.rejects(() => servico.listarPorUsuario(criarPoolFalso(), argumentos), TypeError);
    }

    assert.equal(pedidos.length, 0);
  });
});

describe('autorizacao-consulta.service — conteúdo e efeitos', () => {
  test('devolve as linhas do repositório, com nomes e estado da ação', async (t) => {
    comAtor(t, usuario(MASTER, 'MASTER'));
    comRepositorio(t);

    const { autorizacoes } = await servico.listarPorUsuario(criarPoolFalso(), {
      empresaId: EMPRESA, atorId: MASTER, usuarioId: OUTRO,
    });

    assert.equal(autorizacoes[0].usuarioNome, 'Ana Souza');
    assert.equal(autorizacoes[0].autorizadoPorNome, 'Master');
    assert.equal(autorizacoes[0].acaoNome, 'Movimentar estoque');
    assert.equal(autorizacoes[0].podeDelegar, true);
    assert.equal(autorizacoes[0].origemId, null, 'direta continua direta');
  });

  test('lista vazia devolve array vazio, não erro', async (t) => {
    comAtor(t, usuario(ADMIN, 'ADMINISTRADOR'));
    comRepositorio(t, []);

    const resultado = await servico.listarPorUsuario(criarPoolFalso(), {
      empresaId: EMPRESA, atorId: ADMIN, usuarioId: OUTRO,
    });

    assert.deepEqual(resultado.autorizacoes, []);
    assert.equal(resultado.escopo, 'CONCEDIDAS_POR_MIM');
  });

  test('não abre transação e não executa SQL próprio', async (t) => {
    comAtor(t, usuario(MASTER, 'MASTER'));
    comRepositorio(t);
    const pool = criarPoolFalso();

    await servico.listarPorUsuario(pool, { empresaId: EMPRESA, atorId: MASTER, usuarioId: OUTRO });

    assert.deepEqual(pool.chamadas, [], 'nem BEGIN, nem query solta');
  });

  test('erro inesperado do repositório propaga sem virar 403', async (t) => {
    comAtor(t, usuario(MASTER, 'MASTER'));
    t.mock.method(autorizacaoRepo, 'listarPorUsuario', async () => { throw new Error('conexão perdida'); });

    await assert.rejects(
      () => servico.listarPorUsuario(criarPoolFalso(), { empresaId: EMPRESA, atorId: MASTER, usuarioId: OUTRO }),
      (erro) => {
        assert.equal(erro instanceof HttpError, false);
        assert.match(erro.message, /conexão perdida/);
        return true;
      },
    );
  });
});

describe('autorizacao-consulta.service — contrato do módulo', () => {
  test('exporta somente listarPorUsuario: nenhuma escrita', () => {
    assert.deepEqual(Object.keys(servico).sort(), ['listarPorUsuario']);
  });

  test('o serviço aprovado da 3I continua com as três operações de escrita (+ o predicado de concessão direta extraído na Parte C1, sem escrita)', () => {
    const tresI = require('../../src/services/autorizacao-individual.service');

    assert.deepEqual(Object.keys(tresI).sort(), ['atorPodeConcederDireta', 'concederDireta', 'delegar', 'revogar']);
  });
});
