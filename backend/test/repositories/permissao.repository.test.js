'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buscarPermissaoRecurso,
  buscarPermissaoAcao,
  usuarioTemBloqueio,
  buscarConfiguracaoAcao,
  listarAcoes,
  usuarioIntegraSst,
  usuarioTemAutorizacaoIndividual,
  buscarGrupoAcessoDoUsuario,
  buscarPermissaoRecursoGrupo,
  buscarPermissaoAcaoGrupo,
  buscarPermissaoRecursoIndividual,
} = require('../../src/repositories/permissao.repository');

/**
 * Contrato do repositório de permissões (RBAC).
 *
 * Este repositório não decide autorização: só lê o que está persistido, e
 * devolve `null` quando não há registro, sem presumir permissão nem negação
 * nesse caso. Nenhum perfil, incluindo MASTER, recebe tratamento especial
 * aqui — isso é responsabilidade de uma camada acima, ainda não construída.
 */

const EMPRESA_A = 4242;
const EMPRESA_B = 8888;
const USUARIO = 77;
const USUARIO_B = 88;
const PERFIL = 'ADMINISTRADOR';
const RECURSO = 'materials';
const ACAO = 'MOVIMENTAR_ESTOQUE';
const GRUPO = 55;

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: linhas.length };
    },
  };
};

const executorComErro = (erro) => ({
  query: async () => { throw erro; },
});

describe('buscarPermissaoRecurso', () => {
  test('devolve os quatro booleanos preservados, inclusive quando false', async () => {
    const executor = executorFalso([{
      pode_visualizar: true, pode_criar: false, pode_editar: false, pode_excluir: false,
    }]);

    const permissao = await buscarPermissaoRecurso(executor, EMPRESA_A, PERFIL, RECURSO);

    assert.deepEqual(permissao, {
      podeVisualizar: true, podeCriar: false, podeEditar: false, podeExcluir: false,
    });
  });

  test('registro ausente devolve null, não false', async () => {
    const permissao = await buscarPermissaoRecurso(executorFalso([]), EMPRESA_A, PERFIL, RECURSO);

    assert.equal(permissao, null);
  });

  test('consulta é filtrada por empresa, perfil e recurso, com parâmetros separados', async () => {
    const executor = executorFalso([{
      pode_visualizar: true, pode_criar: true, pode_editar: true, pode_excluir: true,
    }]);

    await buscarPermissaoRecurso(executor, EMPRESA_A, PERFIL, RECURSO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+permissoes_recurso/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /perfil\s*=\s*\$2/i);
    assert.match(texto, /recurso\s*=\s*\$3/i);
    assert.deepEqual(valores, [EMPRESA_A, PERFIL, RECURSO]);
    assert.equal(texto.includes(RECURSO), false, 'o valor não pode estar concatenado no texto do SQL');
  });

  test('nenhum tratamento especial para MASTER: mesma consulta, mesmo contrato', async () => {
    const executor = executorFalso([]);

    const permissao = await buscarPermissaoRecurso(executor, EMPRESA_A, 'MASTER', RECURSO);

    assert.equal(permissao, null, 'MASTER sem registro também recebe null, não um bypass automático');
    assert.equal(executor.chamadas[0].valores[1], 'MASTER');
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => buscarPermissaoRecurso(executor, 0, PERFIL, RECURSO), /empresa/i);
    await assert.rejects(() => buscarPermissaoRecurso(executor, EMPRESA_A, 'minusculo', RECURSO), /perfil/i);
    await assert.rejects(() => buscarPermissaoRecurso(executor, EMPRESA_A, '', RECURSO), /perfil/i);
    await assert.rejects(() => buscarPermissaoRecurso(executor, EMPRESA_A, PERFIL, ''), /recurso/i);
    await assert.rejects(() => buscarPermissaoRecurso(executor, EMPRESA_A, PERFIL, 'x'.repeat(61)), /recurso/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('erro inesperado do banco propaga, não vira null', async () => {
    const executor = executorComErro(new Error('conexão perdida com o banco'));

    await assert.rejects(
      () => buscarPermissaoRecurso(executor, EMPRESA_A, PERFIL, RECURSO),
      /conexão perdida/,
    );
  });
});

describe('buscarPermissaoAcao', () => {
  test('devolve permitido = true', async () => {
    const permissao = await buscarPermissaoAcao(executorFalso([{ permitido: true }]), EMPRESA_A, PERFIL, ACAO);

    assert.deepEqual(permissao, { permitido: true });
  });

  test('devolve permitido = false, sem confundir com registro ausente', async () => {
    const permissao = await buscarPermissaoAcao(executorFalso([{ permitido: false }]), EMPRESA_A, PERFIL, ACAO);

    assert.deepEqual(permissao, { permitido: false });
  });

  test('registro ausente devolve null', async () => {
    const permissao = await buscarPermissaoAcao(executorFalso([]), EMPRESA_A, PERFIL, ACAO);

    assert.equal(permissao, null);
  });

  test('consulta é filtrada por empresa, perfil e ação, com parâmetros separados', async () => {
    const executor = executorFalso([{ permitido: true }]);

    await buscarPermissaoAcao(executor, EMPRESA_A, PERFIL, ACAO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+permissoes_acao/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /perfil\s*=\s*\$2/i);
    assert.match(texto, /acao_codigo\s*=\s*\$3/i);
    assert.deepEqual(valores, [EMPRESA_A, PERFIL, ACAO]);
  });

  test('nenhum tratamento especial para MASTER: mesma consulta, mesmo contrato', async () => {
    const executor = executorFalso([]);

    const permissao = await buscarPermissaoAcao(executor, EMPRESA_A, 'MASTER', ACAO);

    assert.equal(permissao, null, 'MASTER sem registro também recebe null, não um bypass automático');
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => buscarPermissaoAcao(executor, -1, PERFIL, ACAO), /empresa/i);
    await assert.rejects(() => buscarPermissaoAcao(executor, EMPRESA_A, 'minusculo', ACAO), /perfil/i);
    await assert.rejects(() => buscarPermissaoAcao(executor, EMPRESA_A, PERFIL, 'minuscula'), /ação/i);
    await assert.rejects(() => buscarPermissaoAcao(executor, EMPRESA_A, PERFIL, ''), /ação/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('erro inesperado do banco propaga', async () => {
    const executor = executorComErro(new Error('timeout de statement'));

    await assert.rejects(() => buscarPermissaoAcao(executor, EMPRESA_A, PERFIL, ACAO), /timeout/);
  });
});

describe('usuarioTemBloqueio', () => {
  test('bloqueio encontrado devolve true', async () => {
    const bloqueado = await usuarioTemBloqueio(executorFalso([{ '?column?': 1 }]), EMPRESA_A, USUARIO, ACAO);

    assert.equal(bloqueado, true);
  });

  test('bloqueio inexistente devolve false', async () => {
    const bloqueado = await usuarioTemBloqueio(executorFalso([]), EMPRESA_A, USUARIO, ACAO);

    assert.equal(bloqueado, false);
  });

  test('consulta vincula usuarios pela identidade e filtra por usuarios.empresa_id, com parâmetros separados', async () => {
    const executor = executorFalso([{ '?column?': 1 }]);

    await usuarioTemBloqueio(executor, EMPRESA_A, USUARIO, ACAO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+usuario_bloqueios/i);
    assert.match(texto, /join\s+usuarios/i);
    assert.match(texto, /u\.empresa_id\s*=\s*\$1/i, 'sem esse filtro, o usuario_id bastaria para atravessar empresas');
    assert.match(texto, /ub\.usuario_id\s*=\s*\$2/i);
    assert.match(texto, /ub\.acao_codigo\s*=\s*\$3/i);
    assert.deepEqual(valores, [EMPRESA_A, USUARIO, ACAO]);
  });

  test('nenhuma exceção automática para MASTER: a consulta roda igual para qualquer usuário', async () => {
    const executor = executorFalso([]);

    const bloqueado = await usuarioTemBloqueio(executor, EMPRESA_A, USUARIO, ACAO);

    assert.equal(bloqueado, false);
    assert.equal(executor.chamadas.length, 1, 'não há atalho que pule a consulta para nenhum caso');
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => usuarioTemBloqueio(executor, 0, USUARIO, ACAO), /empresa/i);
    await assert.rejects(() => usuarioTemBloqueio(executor, EMPRESA_A, 0, ACAO), /usuário/i);
    await assert.rejects(() => usuarioTemBloqueio(executor, EMPRESA_A, -1, ACAO), /usuário/i);
    await assert.rejects(() => usuarioTemBloqueio(executor, EMPRESA_A, USUARIO, 'minuscula'), /ação/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('erro inesperado do banco propaga, não vira false', async () => {
    const executor = executorComErro(new Error('falha ao consultar usuario_bloqueios'));

    await assert.rejects(() => usuarioTemBloqueio(executor, EMPRESA_A, USUARIO, ACAO), /falha ao consultar/);
  });

  test('empresa B nunca é confundida com empresa A: parâmetro repassado tal como recebido', async () => {
    const executor = executorFalso([]);

    await usuarioTemBloqueio(executor, EMPRESA_B, USUARIO, ACAO);

    assert.equal(executor.chamadas[0].valores[0], EMPRESA_B);
  });
});

describe('buscarConfiguracaoAcao', () => {
  test('devolve ativo/exigeSst/modoAutorizacaoIndividual, tal como persistidos', async () => {
    const executor = executorFalso([{ ativo: true, exige_sst: true, modo_autorizacao_individual: 'OBRIGATORIA' }]);

    const configuracao = await buscarConfiguracaoAcao(executor, 'APROVAR_SOLICITACAO');

    assert.deepEqual(configuracao, { ativo: true, exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
  });

  test('preserva ativo=false e exigeSst=false, sem confundir com ausência', async () => {
    const executor = executorFalso([{ ativo: false, exige_sst: false, modo_autorizacao_individual: 'NENHUMA' }]);

    const configuracao = await buscarConfiguracaoAcao(executor, 'ALTERAR_CONFIGURACOES');

    assert.deepEqual(configuracao, { ativo: false, exigeSst: false, modoAutorizacaoIndividual: 'NENHUMA' });
  });

  test('ação inexistente no catálogo devolve null', async () => {
    const configuracao = await buscarConfiguracaoAcao(executorFalso([]), 'ACAO_QUE_NAO_EXISTE');

    assert.equal(configuracao, null);
  });

  test('não é filtrada por empresa: um único parâmetro, o código da ação', async () => {
    const executor = executorFalso([{ ativo: true, exige_sst: false, modo_autorizacao_individual: 'ALTERNATIVA' }]);

    await buscarConfiguracaoAcao(executor, 'MOVIMENTAR_ESTOQUE');

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+acoes/i);
    assert.deepEqual(valores, ['MOVIMENTAR_ESTOQUE']);
  });

  test('recusa código de ação inválido antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => buscarConfiguracaoAcao(executor, ''), /ação/i);
    await assert.rejects(() => buscarConfiguracaoAcao(executor, 'minuscula'), /ação/i);
    await assert.rejects(() => buscarConfiguracaoAcao(executor, null), /ação/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('erro inesperado do banco propaga', async () => {
    const executor = executorComErro(new Error('falha ao consultar acoes'));

    await assert.rejects(() => buscarConfiguracaoAcao(executor, ACAO), /falha ao consultar/);
  });
});

describe('listarAcoes', () => {
  test('devolve o catálogo inteiro traduzido para camelCase', async () => {
    const executor = executorFalso([
      { codigo: 'ADMINISTRAR_GRUPOS_ACESSO', nome: 'Administrar grupos', descricao: null, ativo: true, exige_sst: false, modo_autorizacao_individual: 'OBRIGATORIA' },
      { codigo: 'MOVIMENTAR_ESTOQUE', nome: 'Movimentar estoque', descricao: 'Entradas e saídas', ativo: true, exige_sst: false, modo_autorizacao_individual: 'ALTERNATIVA' },
    ]);

    const acoes = await listarAcoes(executor);

    assert.deepEqual(acoes, [
      { codigo: 'ADMINISTRAR_GRUPOS_ACESSO', nome: 'Administrar grupos', descricao: null, ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'OBRIGATORIA' },
      { codigo: 'MOVIMENTAR_ESTOQUE', nome: 'Movimentar estoque', descricao: 'Entradas e saídas', ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' },
    ]);
  });

  test('preserva ativo=false: a tela precisa distinguir desativada de ausente', async () => {
    const executor = executorFalso([
      { codigo: 'ACAO_DESATIVADA', nome: 'Desativada', descricao: null, ativo: false, exige_sst: false, modo_autorizacao_individual: 'NENHUMA' },
    ]);

    const [acao] = await listarAcoes(executor);

    assert.equal(acao.ativo, false);
    assert.equal(acao.modoAutorizacaoIndividual, 'NENHUMA');
  });

  test('catálogo vazio devolve lista vazia, não null', async () => {
    assert.deepEqual(await listarAcoes(executorFalso([])), []);
  });

  test('não é filtrada por empresa e ordena pelo código, sem parâmetros', async () => {
    const executor = executorFalso([]);

    await listarAcoes(executor);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+acoes/i);
    assert.match(texto, /order\s+by\s+codigo/i);
    assert.doesNotMatch(texto, /empresa_id/i);
    assert.equal(valores, undefined);
  });

  test('é somente leitura: nenhuma escrita na tabela do catálogo', async () => {
    const executor = executorFalso([]);

    await listarAcoes(executor);

    assert.doesNotMatch(executor.chamadas[0].texto, /insert|update|delete/i);
  });

  test('erro inesperado do banco propaga', async () => {
    const executor = executorComErro(new Error('falha ao consultar acoes'));

    await assert.rejects(() => listarAcoes(executor), /falha ao consultar/);
  });
});

describe('usuarioIntegraSst', () => {
  test('participação encontrada devolve true', async () => {
    const integra = await usuarioIntegraSst(executorFalso([{ '?column?': 1 }]), EMPRESA_A, USUARIO);

    assert.equal(integra, true);
  });

  test('participação inexistente devolve false', async () => {
    const integra = await usuarioIntegraSst(executorFalso([]), EMPRESA_A, USUARIO);

    assert.equal(integra, false);
  });

  test('consulta filtra por empresa_id e usuario_id, com parâmetros separados', async () => {
    const executor = executorFalso([{ '?column?': 1 }]);

    await usuarioIntegraSst(executor, EMPRESA_A, USUARIO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+vinculo_sst/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /usuario_id\s*=\s*\$2/i);
    assert.deepEqual(valores, [EMPRESA_A, USUARIO]);
  });

  test('nenhuma exceção automática para MASTER: a consulta roda igual para qualquer usuário', async () => {
    const executor = executorFalso([]);

    const integra = await usuarioIntegraSst(executor, EMPRESA_A, USUARIO);

    assert.equal(integra, false);
    assert.equal(executor.chamadas.length, 1, 'não há atalho que pule a consulta para nenhum caso');
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => usuarioIntegraSst(executor, 0, USUARIO), /empresa/i);
    await assert.rejects(() => usuarioIntegraSst(executor, EMPRESA_A, 0), /usuário/i);
    await assert.rejects(() => usuarioIntegraSst(executor, EMPRESA_A, -1), /usuário/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('erro inesperado do banco propaga, não vira false', async () => {
    const executor = executorComErro(new Error('falha ao consultar vinculo_sst'));

    await assert.rejects(() => usuarioIntegraSst(executor, EMPRESA_A, USUARIO), /falha ao consultar/);
  });

  test('empresa B nunca é confundida com empresa A', async () => {
    const executor = executorFalso([]);

    await usuarioIntegraSst(executor, EMPRESA_B, USUARIO);

    assert.equal(executor.chamadas[0].valores[0], EMPRESA_B);
  });
});

describe('usuarioTemAutorizacaoIndividual', () => {
  test('autorização encontrada devolve true', async () => {
    const autorizado = await usuarioTemAutorizacaoIndividual(executorFalso([{ '?column?': 1 }]), EMPRESA_A, USUARIO, ACAO);

    assert.equal(autorizado, true);
  });

  test('autorização inexistente devolve false', async () => {
    const autorizado = await usuarioTemAutorizacaoIndividual(executorFalso([]), EMPRESA_A, USUARIO, ACAO);

    assert.equal(autorizado, false);
  });

  test('consulta filtra por empresa_id, usuario_id e acao_codigo, com parâmetros separados', async () => {
    const executor = executorFalso([{ '?column?': 1 }]);

    await usuarioTemAutorizacaoIndividual(executor, EMPRESA_A, USUARIO, ACAO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+usuario_autorizacoes/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /usuario_id\s*=\s*\$2/i);
    assert.match(texto, /acao_codigo\s*=\s*\$3/i);
    assert.deepEqual(valores, [EMPRESA_A, USUARIO, ACAO]);
  });

  test('uma autorização para uma ação não é presumida para outra', async () => {
    const executor = executorFalso([]);

    await usuarioTemAutorizacaoIndividual(executor, EMPRESA_A, USUARIO, 'REALIZAR_ENTREGA');

    assert.equal(executor.chamadas[0].valores[2], 'REALIZAR_ENTREGA');
  });

  test('nenhuma exceção automática para MASTER: a consulta roda igual para qualquer usuário', async () => {
    const executor = executorFalso([]);

    const autorizado = await usuarioTemAutorizacaoIndividual(executor, EMPRESA_A, USUARIO, ACAO);

    assert.equal(autorizado, false);
    assert.equal(executor.chamadas.length, 1);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => usuarioTemAutorizacaoIndividual(executor, 0, USUARIO, ACAO), /empresa/i);
    await assert.rejects(() => usuarioTemAutorizacaoIndividual(executor, EMPRESA_A, 0, ACAO), /usuário/i);
    await assert.rejects(() => usuarioTemAutorizacaoIndividual(executor, EMPRESA_A, USUARIO, 'minuscula'), /ação/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('erro inesperado do banco propaga, não vira false', async () => {
    const executor = executorComErro(new Error('falha ao consultar usuario_autorizacoes'));

    await assert.rejects(() => usuarioTemAutorizacaoIndividual(executor, EMPRESA_A, USUARIO, ACAO), /falha ao consultar/);
  });
});

describe('buscarGrupoAcessoDoUsuario', () => {
  test('devolve id e ativo tal como persistidos', async () => {
    const grupo = await buscarGrupoAcessoDoUsuario(executorFalso([{ id: GRUPO, ativo: true }]), EMPRESA_A, USUARIO);

    assert.deepEqual(grupo, { id: GRUPO, ativo: true });
  });

  test('preserva ativo=false, sem confundir com ausência de grupo', async () => {
    const grupo = await buscarGrupoAcessoDoUsuario(executorFalso([{ id: GRUPO, ativo: false }]), EMPRESA_A, USUARIO);

    assert.deepEqual(grupo, { id: GRUPO, ativo: false });
  });

  test('usuário sem grupo devolve null', async () => {
    const grupo = await buscarGrupoAcessoDoUsuario(executorFalso([]), EMPRESA_A, USUARIO);

    assert.equal(grupo, null);
  });

  test('consulta faz JOIN com grupos_acesso e filtra por empresa em ambas as tabelas, com parâmetros separados', async () => {
    const executor = executorFalso([{ id: GRUPO, ativo: true }]);

    await buscarGrupoAcessoDoUsuario(executor, EMPRESA_A, USUARIO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+usuarios/i);
    assert.match(texto, /join\s+grupos_acesso/i);
    assert.match(texto, /g\.empresa_id\s*=\s*u\.empresa_id/i, 'o grupo precisa pertencer à mesma empresa do usuário, mesmo a FK já garantindo isso');
    assert.match(texto, /u\.empresa_id\s*=\s*\$1/i);
    assert.match(texto, /u\.id\s*=\s*\$2/i);
    assert.deepEqual(valores, [EMPRESA_A, USUARIO]);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => buscarGrupoAcessoDoUsuario(executor, 0, USUARIO), /empresa/i);
    await assert.rejects(() => buscarGrupoAcessoDoUsuario(executor, EMPRESA_A, 0), /usuário/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('empresa B nunca é confundida com empresa A', async () => {
    const executor = executorFalso([]);

    await buscarGrupoAcessoDoUsuario(executor, EMPRESA_B, USUARIO);

    assert.equal(executor.chamadas[0].valores[0], EMPRESA_B);
  });

  test('erro inesperado do banco propaga, não vira null', async () => {
    const executor = executorComErro(new Error('falha ao consultar grupos_acesso'));

    await assert.rejects(() => buscarGrupoAcessoDoUsuario(executor, EMPRESA_A, USUARIO), /falha ao consultar/);
  });
});

describe('buscarPermissaoRecursoGrupo', () => {
  test('devolve os quatro campos tri-state tal como persistidos, incluindo mistura de true/false/null', async () => {
    const executor = executorFalso([{ pode_visualizar: true, pode_criar: false, pode_editar: null, pode_excluir: null }]);

    const permissao = await buscarPermissaoRecursoGrupo(executor, EMPRESA_A, GRUPO, RECURSO);

    assert.deepEqual(permissao, { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null });
  });

  test('registro ausente (nenhuma configuração do grupo para este recurso) devolve null', async () => {
    const permissao = await buscarPermissaoRecursoGrupo(executorFalso([]), EMPRESA_A, GRUPO, RECURSO);

    assert.equal(permissao, null);
  });

  test('todos os campos NULL (grupo sem opinião nenhuma) é devolvido como tal, não confundido com registro ausente', async () => {
    const permissao = await buscarPermissaoRecursoGrupo(
      executorFalso([{ pode_visualizar: null, pode_criar: null, pode_editar: null, pode_excluir: null }]),
      EMPRESA_A, GRUPO, RECURSO,
    );

    assert.deepEqual(permissao, { podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null });
    assert.notEqual(permissao, null, 'a linha existe, mesmo que todos os campos sejam NULL — não é o mesmo que ausência de linha');
  });

  test('consulta é filtrada por empresa, grupo e recurso, com parâmetros separados', async () => {
    const executor = executorFalso([{ pode_visualizar: true, pode_criar: true, pode_editar: true, pode_excluir: true }]);

    await buscarPermissaoRecursoGrupo(executor, EMPRESA_A, GRUPO, RECURSO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+grupo_permissoes_recurso/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /grupo_acesso_id\s*=\s*\$2/i);
    assert.match(texto, /recurso\s*=\s*\$3/i);
    assert.deepEqual(valores, [EMPRESA_A, GRUPO, RECURSO]);
  });

  test('um recurso não é confundido com outro', async () => {
    const executor = executorFalso([]);

    await buscarPermissaoRecursoGrupo(executor, EMPRESA_A, GRUPO, 'stockValidity');

    assert.equal(executor.chamadas[0].valores[2], 'stockValidity');
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => buscarPermissaoRecursoGrupo(executor, 0, GRUPO, RECURSO), /empresa/i);
    await assert.rejects(() => buscarPermissaoRecursoGrupo(executor, EMPRESA_A, 0, RECURSO), /grupo/i);
    await assert.rejects(() => buscarPermissaoRecursoGrupo(executor, EMPRESA_A, GRUPO, ''), /recurso/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('erro inesperado do banco propaga', async () => {
    const executor = executorComErro(new Error('falha ao consultar grupo_permissoes_recurso'));

    await assert.rejects(() => buscarPermissaoRecursoGrupo(executor, EMPRESA_A, GRUPO, RECURSO), /falha ao consultar/);
  });
});

describe('buscarPermissaoAcaoGrupo', () => {
  test('devolve permitido=true', async () => {
    const permissao = await buscarPermissaoAcaoGrupo(executorFalso([{ permitido: true }]), EMPRESA_A, GRUPO, ACAO);

    assert.deepEqual(permissao, { permitido: true });
  });

  test('devolve permitido=false, sem confundir com registro ausente', async () => {
    const permissao = await buscarPermissaoAcaoGrupo(executorFalso([{ permitido: false }]), EMPRESA_A, GRUPO, ACAO);

    assert.deepEqual(permissao, { permitido: false });
  });

  test('devolve permitido=null (grupo sem opinião), distinto de registro ausente', async () => {
    const permissao = await buscarPermissaoAcaoGrupo(executorFalso([{ permitido: null }]), EMPRESA_A, GRUPO, ACAO);

    assert.deepEqual(permissao, { permitido: null });
    assert.notEqual(permissao, null);
  });

  test('registro ausente devolve null', async () => {
    const permissao = await buscarPermissaoAcaoGrupo(executorFalso([]), EMPRESA_A, GRUPO, ACAO);

    assert.equal(permissao, null);
  });

  test('consulta é filtrada por empresa, grupo e ação, com parâmetros separados', async () => {
    const executor = executorFalso([{ permitido: true }]);

    await buscarPermissaoAcaoGrupo(executor, EMPRESA_A, GRUPO, ACAO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+grupo_permissoes_acao/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /grupo_acesso_id\s*=\s*\$2/i);
    assert.match(texto, /acao_codigo\s*=\s*\$3/i);
    assert.deepEqual(valores, [EMPRESA_A, GRUPO, ACAO]);
  });

  test('uma ação não é confundida com outra', async () => {
    const executor = executorFalso([]);

    await buscarPermissaoAcaoGrupo(executor, EMPRESA_A, GRUPO, 'REALIZAR_ENTREGA');

    assert.equal(executor.chamadas[0].valores[2], 'REALIZAR_ENTREGA');
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => buscarPermissaoAcaoGrupo(executor, 0, GRUPO, ACAO), /empresa/i);
    await assert.rejects(() => buscarPermissaoAcaoGrupo(executor, EMPRESA_A, 0, ACAO), /grupo/i);
    await assert.rejects(() => buscarPermissaoAcaoGrupo(executor, EMPRESA_A, GRUPO, 'minuscula'), /ação/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('erro inesperado do banco propaga', async () => {
    const executor = executorComErro(new Error('falha ao consultar grupo_permissoes_acao'));

    await assert.rejects(() => buscarPermissaoAcaoGrupo(executor, EMPRESA_A, GRUPO, ACAO), /falha ao consultar/);
  });
});

describe('buscarPermissaoRecursoIndividual', () => {
  test('devolve os quatro campos tri-state tal como persistidos, incluindo mistura de true/false/null', async () => {
    const executor = executorFalso([{ pode_visualizar: true, pode_criar: false, pode_editar: null, pode_excluir: null }]);

    const permissao = await buscarPermissaoRecursoIndividual(executor, EMPRESA_A, USUARIO, RECURSO);

    assert.deepEqual(permissao, { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null });
  });

  test('registro ausente (usuário sem exceção individual para este recurso) devolve null', async () => {
    const permissao = await buscarPermissaoRecursoIndividual(executorFalso([]), EMPRESA_A, USUARIO, RECURSO);

    assert.equal(permissao, null);
  });

  test('todos os campos NULL (usuário sem opinião nenhuma) é devolvido como tal, não confundido com registro ausente', async () => {
    const permissao = await buscarPermissaoRecursoIndividual(
      executorFalso([{ pode_visualizar: null, pode_criar: null, pode_editar: null, pode_excluir: null }]),
      EMPRESA_A, USUARIO, RECURSO,
    );

    assert.deepEqual(permissao, { podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null });
    assert.notEqual(permissao, null, 'a linha existe, mesmo que todos os campos sejam NULL — não é o mesmo que ausência de linha');
  });

  test('false é preservado e não é convertido em ausência de permissão', async () => {
    const permissao = await buscarPermissaoRecursoIndividual(
      executorFalso([{ pode_visualizar: false, pode_criar: null, pode_editar: null, pode_excluir: null }]),
      EMPRESA_A, USUARIO, RECURSO,
    );

    assert.equal(permissao.podeVisualizar, false);
    assert.notEqual(permissao.podeVisualizar, null, 'false não pode ser confundido com ausência de opinião (null)');
  });

  test('cada uma das quatro operações é independente das demais', async () => {
    const executor = executorFalso([{ pode_visualizar: true, pode_criar: null, pode_editar: false, pode_excluir: true }]);

    const permissao = await buscarPermissaoRecursoIndividual(executor, EMPRESA_A, USUARIO, RECURSO);

    assert.equal(permissao.podeVisualizar, true);
    assert.equal(permissao.podeCriar, null);
    assert.equal(permissao.podeEditar, false);
    assert.equal(permissao.podeExcluir, true);
  });

  test('consulta é filtrada por empresa, usuário e recurso, com parâmetros separados', async () => {
    const executor = executorFalso([{ pode_visualizar: true, pode_criar: true, pode_editar: true, pode_excluir: true }]);

    await buscarPermissaoRecursoIndividual(executor, EMPRESA_A, USUARIO, RECURSO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+usuario_permissoes_recurso/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /usuario_id\s*=\s*\$2/i);
    assert.match(texto, /recurso\s*=\s*\$3/i);
    assert.deepEqual(valores, [EMPRESA_A, USUARIO, RECURSO]);
  });

  test('usuarioId nunca é usado sozinho: empresaId sempre acompanha o filtro', async () => {
    const executor = executorFalso([]);

    await buscarPermissaoRecursoIndividual(executor, EMPRESA_B, USUARIO, RECURSO);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i, 'a consulta precisa sempre filtrar por empresa, nunca só por usuario_id');
    assert.deepEqual(valores, [EMPRESA_B, USUARIO, RECURSO]);
  });

  test('usuários diferentes no mesmo recurso não são confundidos', async () => {
    const executor = executorFalso([]);

    await buscarPermissaoRecursoIndividual(executor, EMPRESA_A, USUARIO_B, RECURSO);

    assert.equal(executor.chamadas[0].valores[1], USUARIO_B);
  });

  test('mesmo usuário em recursos diferentes não é confundido', async () => {
    const executor = executorFalso([]);

    await buscarPermissaoRecursoIndividual(executor, EMPRESA_A, USUARIO, 'stockValidity');

    assert.equal(executor.chamadas[0].valores[2], 'stockValidity');
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => buscarPermissaoRecursoIndividual(executor, 0, USUARIO, RECURSO), /empresa/i);
    await assert.rejects(() => buscarPermissaoRecursoIndividual(executor, EMPRESA_A, 0, RECURSO), /usuário/i);
    await assert.rejects(() => buscarPermissaoRecursoIndividual(executor, EMPRESA_A, USUARIO, ''), /recurso/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('erro inesperado do banco propaga', async () => {
    const executor = executorComErro(new Error('falha ao consultar usuario_permissoes_recurso'));

    await assert.rejects(() => buscarPermissaoRecursoIndividual(executor, EMPRESA_A, USUARIO, RECURSO), /falha ao consultar/);
  });
});
