'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buscarPorEmail,
  buscarPorId,
  buscarPorIdParaAtualizacao,
  buscarVinculoGrupoParaAtualizacao,
  atualizarGrupoAcesso,
  listarPorGrupoAcesso,
  listarDaEmpresa,
  buscarCredencialPorEmail,
  CAMPOS_PUBLICOS,
  CAMPOS_VINCULO,
} = require('../../src/repositories/usuario.repository');

/**
 * Contrato do repositório de usuários.
 *
 * Este é o primeiro repositório que recebe filtro de empresa, e por isso o
 * que fixa o padrão de isolamento: nenhuma busca é global. O identificador da
 * empresa é sempre o primeiro parâmetro, nunca opcional, e entra na cláusula
 * de filtro junto com o critério pedido.
 *
 * O hash da senha só sai por uma função, cujo nome diz isso. As demais
 * projetam apenas os campos públicos, para que um objeto de usuário devolvido
 * ao contexto de sessão ou à apresentação não possa carregar credencial.
 *
 * Verificação de senha, decisão sobre usuário ativo e resposta ao cliente não
 * pertencem aqui. São do serviço de autenticação.
 */

// Valores altos de propósito: com empresa 1, a verificação de concatenação
// casaria com o marcador $1 da própria consulta e não provaria nada.
const EMPRESA_A = 4242;
const EMPRESA_B = 8888;
const EMAIL = 'ana.souza@demo.safeworkengenharia.com.br';
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsZ2Fkb2RlbW9uc3RyYQ$aGFzaGRlbW9uc3RyYWNhb3NpbnRldGljbw';

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

const linhaUsuario = (extra = {}) => ({
  id: 10,
  empresa_id: EMPRESA_A,
  nome: 'Ana Souza',
  email: EMAIL,
  perfil: 'ADMINISTRADOR',
  ativo: true,
  biometria_cadastrada: false,
  ...extra,
});

describe('buscarPorEmail', () => {
  test('filtra pela empresa e pelo e-mail, de forma parametrizada', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await buscarPorEmail(executor, EMPRESA_A, EMAIL);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [EMPRESA_A, EMAIL], 'a empresa deve ser o primeiro parâmetro');
    assert.equal(texto.includes(EMAIL), false, 'o e-mail não pode aparecer no texto da consulta');
    assert.equal(texto.includes(String(EMPRESA_A)), false, 'o identificador não pode ser concatenado');
    assert.match(texto, /empresa_id\s*=\s*\$1/i, 'o filtro de empresa é obrigatório');
    assert.match(texto, /lower\(email\)\s*=\s*\$2/i, 'deve casar com o índice único por empresa e e-mail');
  });

  test('não devolve o hash da senha', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH })]);

    const usuario = await buscarPorEmail(executor, EMPRESA_A, EMAIL);

    assert.deepEqual(Object.keys(usuario).sort(), [...CAMPOS_PUBLICOS].sort());
    assert.equal('senha_hash' in usuario, false);
    assert.equal(JSON.stringify(usuario).includes(HASH), false);
    assert.equal(CAMPOS_PUBLICOS.includes('senha_hash'), false);
  });

  test('a projeção da consulta não pede a coluna de senha', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await buscarPorEmail(executor, EMPRESA_A, EMAIL);

    assert.equal(/senha_hash/i.test(executor.chamadas[0].texto), false);
  });

  test('usuário inexistente devolve null', async () => {
    assert.equal(await buscarPorEmail(executorFalso([]), EMPRESA_A, EMAIL), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await assert.rejects(() => buscarPorEmail(executor, 0, EMAIL), /empresa/i);
    await assert.rejects(() => buscarPorEmail(executor, -1, EMAIL), /empresa/i);
    await assert.rejects(() => buscarPorEmail(executor, '1', EMAIL), /empresa/i);
    await assert.rejects(() => buscarPorEmail(executor, null, EMAIL), /empresa/i);
    await assert.rejects(() => buscarPorEmail(executor, EMPRESA_A, 'Ana.Souza@Demo.Test'), /e-mail/i);
    await assert.rejects(() => buscarPorEmail(executor, EMPRESA_A, '  espaco@demo.test  '), /e-mail/i);
    await assert.rejects(() => buscarPorEmail(executor, EMPRESA_A, null), /e-mail/i);

    assert.equal(executor.chamadas.length, 0, 'nenhuma consulta deve ser emitida');
  });
});

describe('buscarPorId', () => {
  test('filtra pela empresa junto com o identificador', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await buscarPorId(executor, EMPRESA_A, 10);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [EMPRESA_A, 10]);
    assert.match(texto, /empresa_id\s*=\s*\$1/i, 'sem o filtro de empresa a busca alcançaria outra contratante');
    assert.match(texto, /id\s*=\s*\$2/i);
  });

  test('não devolve o hash da senha', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH })]);

    const usuario = await buscarPorId(executor, EMPRESA_A, 10);

    assert.equal('senha_hash' in usuario, false);
    assert.equal(/senha_hash/i.test(executor.chamadas[0].texto), false);
  });

  test('devolve null quando não encontra', async () => {
    assert.equal(await buscarPorId(executorFalso([]), EMPRESA_A, 999), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await assert.rejects(() => buscarPorId(executor, 0, 10), /empresa/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, 0), /identificador/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, 1.5), /identificador/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, '10'), /identificador/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarPorIdParaAtualizacao', () => {
  test('mesma projeção pública e mesmo filtro de buscarPorId, com FOR UPDATE ao final', async () => {
    const executor = executorFalso([linhaUsuario()]);

    const usuario = await buscarPorIdParaAtualizacao(executor, EMPRESA_A, 10);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+usuarios/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /\bid\s*=\s*\$2/i);
    assert.match(texto, /for\s+update\s*$/i, 'a variante travada precisa terminar em FOR UPDATE');
    assert.deepEqual(valores, [EMPRESA_A, 10]);
    assert.deepEqual(Object.keys(usuario).sort(), [...CAMPOS_PUBLICOS].sort());
    assert.equal('senha_hash' in usuario, false, 'a variante travada tampouco traz credencial');
  });

  test('buscarPorId (sem trava) continua sem FOR UPDATE — as duas não se confundem', async () => {
    const executor = executorFalso([linhaUsuario()]);

    await buscarPorId(executor, EMPRESA_A, 10);

    assert.doesNotMatch(executor.chamadas[0].texto, /for\s+update/i);
  });

  test('registro ausente devolve null', async () => {
    assert.equal(await buscarPorIdParaAtualizacao(executorFalso([]), EMPRESA_A, 999), null);
  });

  test('usuário inativo é devolvido como está — a decisão é do serviço', async () => {
    const usuario = await buscarPorIdParaAtualizacao(executorFalso([linhaUsuario({ ativo: false })]), EMPRESA_A, 10);

    assert.equal(usuario.ativo, false);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => buscarPorIdParaAtualizacao(executor, 0, 10), /empresa/i);
    await assert.rejects(() => buscarPorIdParaAtualizacao(executor, EMPRESA_A, 0), /identificador/i);
    await assert.rejects(() => buscarPorIdParaAtualizacao(executor, EMPRESA_A, '10'), /identificador/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarVinculoGrupoParaAtualizacao', () => {
  test('traz perfil, ativo e grupo_acesso_id da própria empresa, travado, sem credencial', async () => {
    const executor = executorFalso([{ id: 10, empresa_id: EMPRESA_A, perfil: 'ADMINISTRADOR', ativo: true, grupo_acesso_id: 55 }]);

    const vinculo = await buscarVinculoGrupoParaAtualizacao(executor, EMPRESA_A, 10);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+usuarios/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /\bid\s*=\s*\$2/i);
    assert.match(texto, /for\s+update\s*$/i);
    assert.doesNotMatch(texto, /senha_hash/i, 'administração de grupo nunca pede credencial');
    assert.deepEqual(valores, [EMPRESA_A, 10]);
    assert.deepEqual(vinculo, { id: 10, empresaId: EMPRESA_A, perfil: 'ADMINISTRADOR', ativo: true, grupoAcessoId: 55 });
  });

  test('usuário sem grupo devolve grupoAcessoId null; usuário de outra empresa devolve null', async () => {
    const semGrupo = await buscarVinculoGrupoParaAtualizacao(
      executorFalso([{ id: 10, empresa_id: EMPRESA_A, perfil: 'USUARIO', ativo: true, grupo_acesso_id: null }]),
      EMPRESA_A, 10,
    );
    assert.equal(semGrupo.grupoAcessoId, null);

    assert.equal(await buscarVinculoGrupoParaAtualizacao(executorFalso([]), EMPRESA_B, 10), null);
  });

  test('usuário inativo é devolvido como está — a decisão é do serviço', async () => {
    const vinculo = await buscarVinculoGrupoParaAtualizacao(
      executorFalso([{ id: 10, empresa_id: EMPRESA_A, perfil: 'USUARIO', ativo: false, grupo_acesso_id: 55 }]),
      EMPRESA_A, 10,
    );

    assert.equal(vinculo.ativo, false);
    assert.equal(vinculo.grupoAcessoId, 55, 'o vínculo histórico continua visível');
  });

  test('grupo_acesso_id não vaza para as consultas públicas', async () => {
    const publico = await buscarPorId(executorFalso([linhaUsuario()]), EMPRESA_A, 10);

    assert.equal('grupo_acesso_id' in publico, false);
    assert.equal('grupoAcessoId' in publico, false);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => buscarVinculoGrupoParaAtualizacao(executor, 0, 10), /empresa/i);
    await assert.rejects(() => buscarVinculoGrupoParaAtualizacao(executor, EMPRESA_A, 0), /identificador/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('atualizarGrupoAcesso', () => {
  test('o SET alcança apenas grupo_acesso_id — nunca ativo, perfil, nome, email ou senha', async () => {
    const executor = executorFalso([{ id: 10, grupo_acesso_id: 55 }]);

    const resultado = await atualizarGrupoAcesso(executor, EMPRESA_A, 10, 55);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+usuarios/i);
    const set = texto.slice(texto.search(/\bset\b/i), texto.search(/\bwhere\b/i));
    assert.match(set, /grupo_acesso_id\s*=\s*\$3/i);
    assert.doesNotMatch(set, /\bativo\b/i, 'operação de grupo nunca altera o estado do usuário');
    assert.doesNotMatch(set, /perfil|nome|email|senha_hash|empresa_id/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.deepEqual(valores, [EMPRESA_A, 10, 55]);
    assert.deepEqual(resultado, { id: 10, grupoAcessoId: 55 });
  });

  test('null retira o usuário do grupo', async () => {
    const executor = executorFalso([{ id: 10, grupo_acesso_id: null }]);

    const resultado = await atualizarGrupoAcesso(executor, EMPRESA_A, 10, null);

    assert.equal(executor.chamadas[0].valores[2], null);
    assert.equal(resultado.grupoAcessoId, null);
  });

  test('usuário inexistente nesta empresa devolve null', async () => {
    assert.equal(await atualizarGrupoAcesso(executorFalso([]), EMPRESA_B, 10, 55), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => atualizarGrupoAcesso(executor, 0, 10, 55), /empresa/i);
    await assert.rejects(() => atualizarGrupoAcesso(executor, EMPRESA_A, 0, 55), /identificador/i);
    await assert.rejects(() => atualizarGrupoAcesso(executor, EMPRESA_A, 10, 0), /grupo/i);
    await assert.rejects(() => atualizarGrupoAcesso(executor, EMPRESA_A, 10, 'x'), /grupo/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('violação da FK composta de grupo propaga com SQLSTATE original', async () => {
    const erro = Object.assign(new Error('fk'), { code: '23503' });
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(() => atualizarGrupoAcesso(executor, EMPRESA_A, 10, 999), (e) => e.code === '23503');
  });
});

describe('listarPorGrupoAcesso', () => {
  test('filtra por empresa e grupo, na projeção pública, ordenado por nome', async () => {
    const executor = executorFalso([linhaUsuario(), linhaUsuario({ id: 11, nome: 'bruno' })]);

    const usuarios = await listarPorGrupoAcesso(executor, EMPRESA_A, 55);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /grupo_acesso_id\s*=\s*\$2/i);
    assert.match(texto, /order\s+by\s+lower\(nome\)/i);
    assert.doesNotMatch(texto, /senha_hash/i);
    assert.deepEqual(valores, [EMPRESA_A, 55]);
    assert.equal(usuarios.length, 2);
    assert.deepEqual(Object.keys(usuarios[0]).sort(), [...CAMPOS_PUBLICOS].sort());
  });

  test('grupo sem usuários devolve lista vazia; entrada inválida é recusada', async () => {
    assert.deepEqual(await listarPorGrupoAcesso(executorFalso([]), EMPRESA_A, 55), []);

    const executor = executorFalso([]);
    await assert.rejects(() => listarPorGrupoAcesso(executor, EMPRESA_A, 0), /grupo/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarCredencialPorEmail', () => {
  test('devolve o hash, que é o motivo de esta função existir', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH })]);

    const credencial = await buscarCredencialPorEmail(executor, EMPRESA_A, EMAIL);

    assert.equal(credencial.senha_hash, HASH);
    assert.match(executor.chamadas[0].texto, /senha_hash/i);
    assert.deepEqual(
      Object.keys(credencial).sort(),
      [...CAMPOS_PUBLICOS, 'senha_hash', 'identidade_id'].sort(),
      'traz os campos públicos mais o hash, e nada além',
    );
  });

  test('também é delimitada por empresa', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH })]);

    await buscarCredencialPorEmail(executor, EMPRESA_B, EMAIL);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [EMPRESA_B, EMAIL]);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /lower\(email\)\s*=\s*\$2/i);
  });

  test('devolve null quando não encontra, sem revelar o motivo', async () => {
    assert.equal(await buscarCredencialPorEmail(executorFalso([]), EMPRESA_A, EMAIL), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH })]);

    await assert.rejects(() => buscarCredencialPorEmail(executor, 0, EMAIL), /empresa/i);
    await assert.rejects(() => buscarCredencialPorEmail(executor, EMPRESA_A, 'MAIUSCULA@demo.test'), /e-mail/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('o repositório não decide se o usuário pode entrar', async () => {
    const executor = executorFalso([linhaUsuario({ senha_hash: HASH, ativo: false })]);

    const credencial = await buscarCredencialPorEmail(executor, EMPRESA_A, EMAIL);

    assert.notEqual(credencial, null, 'usuário inativo é devolvido; quem decide é o serviço');
    assert.equal(credencial.ativo, false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// listarDaEmpresa — a consulta que a tela de vínculos (3U) usa
// ─────────────────────────────────────────────────────────────────────

/**
 * Esta função faz DUAS consultas: a contagem total e a página. O
 * executor falso comum devolve as mesmas linhas para qualquer query e
 * não serviria — a contagem precisa responder {total}, a página precisa
 * responder linhas de usuário.
 */
const executorDeListagem = ({ total = 0, linhas = [] } = {}) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return /count\(\*\)/.test(texto)
        ? { rows: [{ total }], rowCount: 1 }
        : { rows: linhas, rowCount: linhas.length };
    },
  };
};

const linhaVinculo = (extra = {}) => ({
  id: 10, nome: 'Ana Souza', email: EMAIL, perfil: 'USUARIO', ativo: true, grupo_acesso_id: null, ...extra,
});

describe('listarDaEmpresa', () => {
  test('devolve a projeção de vínculo em camelCase, com o total separado', async () => {
    const executor = executorDeListagem({ total: 3, linhas: [linhaVinculo({ grupo_acesso_id: 55 })] });

    const resultado = await listarDaEmpresa(executor, EMPRESA_A, {});

    assert.deepEqual(resultado, {
      usuarios: [{ id: 10, nome: 'Ana Souza', email: EMAIL, perfil: 'USUARIO', ativo: true, grupoAcessoId: 55 }],
      total: 3,
    });
  });

  test('não projeta biometria nem senha: a lista de vínculos não precisa delas', async () => {
    const executor = executorDeListagem({ total: 1, linhas: [linhaVinculo()] });

    const resultado = await listarDaEmpresa(executor, EMPRESA_A, {});

    assert.deepEqual(Object.keys(resultado.usuarios[0]).sort(), ['ativo', 'email', 'grupoAcessoId', 'id', 'nome', 'perfil']);
    for (const { texto } of executor.chamadas) {
      assert.doesNotMatch(texto, /senha_hash/i);
      assert.doesNotMatch(texto, /biometria/i);
    }
  });

  test('a projeção declarada em CAMPOS_VINCULO é menor que a pública', () => {
    assert.equal(CAMPOS_VINCULO.includes('biometria_cadastrada'), false);
    assert.equal(CAMPOS_VINCULO.includes('grupo_acesso_id'), true);
    assert.ok(CAMPOS_VINCULO.length < CAMPOS_PUBLICOS.length + 1);
  });

  test('grupoAcessoId null é preservado: é como "sem grupo" se distingue', async () => {
    const executor = executorDeListagem({ total: 1, linhas: [linhaVinculo({ grupo_acesso_id: null })] });

    const [usuario] = (await listarDaEmpresa(executor, EMPRESA_A, {})).usuarios;

    assert.equal(usuario.grupoAcessoId, null);
  });

  test('inclui usuários inativos: o vínculo deles continua existindo', async () => {
    const executor = executorDeListagem({ total: 1, linhas: [linhaVinculo({ ativo: false })] });

    const [usuario] = (await listarDaEmpresa(executor, EMPRESA_A, {})).usuarios;

    assert.equal(usuario.ativo, false);
    for (const { texto } of executor.chamadas) {
      assert.doesNotMatch(texto, /ativo\s*=\s*true/i);
    }
  });

  test('a empresa é sempre o primeiro parâmetro das duas consultas', async () => {
    const executor = executorDeListagem({ total: 0, linhas: [] });

    await listarDaEmpresa(executor, EMPRESA_B, {});

    assert.equal(executor.chamadas.length, 2, 'contagem e página');
    for (const { texto, valores } of executor.chamadas) {
      assert.match(texto, /empresa_id\s*=\s*\$1/i);
      assert.equal(valores[0], EMPRESA_B);
    }
  });

  test('sem busca, o parâmetro de texto vai null e o filtro não se aplica', async () => {
    const executor = executorDeListagem({ total: 0, linhas: [] });

    await listarDaEmpresa(executor, EMPRESA_A, {});

    assert.equal(executor.chamadas[0].valores[1], null);
  });

  test('a busca vira padrão LIKE minúsculo, casando nome OU e-mail', async () => {
    const executor = executorDeListagem({ total: 0, linhas: [] });

    await listarDaEmpresa(executor, EMPRESA_A, { busca: '  Ana  ' });

    const { texto, valores } = executor.chamadas[0];
    assert.equal(valores[1], '%ana%', 'trim e minúsculas aplicados');
    assert.match(texto, /lower\(nome\)\s+like/i);
    assert.match(texto, /lower\(email\)\s+like/i);
  });

  test('curingas digitados por quem pesquisa são escapados, não interpretados', async () => {
    const executor = executorDeListagem({ total: 0, linhas: [] });

    await listarDaEmpresa(executor, EMPRESA_A, { busca: '100%_teste\\fim' });

    assert.equal(executor.chamadas[0].valores[1], '%100\\%\\_teste\\\\fim%');
    assert.match(executor.chamadas[0].texto, /escape\s+'\\'/i);
  });

  test('o filtro de vínculo viaja como parâmetro, sem SQL dinâmico', async () => {
    for (const vinculo of ['todos', 'sem_grupo', 'com_grupo']) {
      const executor = executorDeListagem({ total: 0, linhas: [] });

      await listarDaEmpresa(executor, EMPRESA_A, { vinculo });

      const { texto, valores } = executor.chamadas[0];
      assert.equal(valores[2], vinculo, 'o modo é parâmetro');
      assert.match(texto, /\$3::text/, 'comparado dentro do WHERE');
      assert.equal(texto.includes(`'${vinculo}' AND`), vinculo !== 'todos' ? true : false);
    }
  });

  test('sem_grupo e com_grupo consultam grupo_acesso_id IS NULL / IS NOT NULL', async () => {
    const executor = executorDeListagem({ total: 0, linhas: [] });

    await listarDaEmpresa(executor, EMPRESA_A, { vinculo: 'sem_grupo' });

    assert.match(executor.chamadas[0].texto, /grupo_acesso_id\s+is\s+null/i);
    assert.match(executor.chamadas[0].texto, /grupo_acesso_id\s+is\s+not\s+null/i);
  });

  test('a paginação vira LIMIT e OFFSET parametrizados, ordenados por nome', async () => {
    const executor = executorDeListagem({ total: 0, linhas: [] });

    await listarDaEmpresa(executor, EMPRESA_A, { pagina: 3, limite: 25 });

    const pagina = executor.chamadas[1];
    assert.match(pagina.texto, /order\s+by\s+lower\(nome\),\s*id/i);
    assert.match(pagina.texto, /limit\s+\$4\s+offset\s+\$5/i);
    assert.equal(pagina.valores[3], 25);
    assert.equal(pagina.valores[4], 50, 'página 3 com limite 25 pula 50');
  });

  test('a contagem não é paginada: o total é o do filtro inteiro', async () => {
    const executor = executorDeListagem({ total: 137, linhas: [linhaVinculo()] });

    const resultado = await listarDaEmpresa(executor, EMPRESA_A, { pagina: 1, limite: 20 });

    assert.equal(resultado.total, 137);
    assert.equal(resultado.usuarios.length, 1);
    assert.doesNotMatch(executor.chamadas[0].texto, /limit/i);
  });

  test('é somente leitura: nenhuma escrita em nenhuma das duas consultas', async () => {
    const executor = executorDeListagem({ total: 0, linhas: [] });

    await listarDaEmpresa(executor, EMPRESA_A, { busca: 'x', vinculo: 'sem_grupo' });

    for (const { texto } of executor.chamadas) {
      assert.doesNotMatch(texto, /\b(insert|update|delete|drop|alter)\b/i);
    }
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const invalidas = [
      [0, {}], [-1, {}], [null, {}],
    ];
    for (const [empresa, opcoes] of invalidas) {
      const executor = executorDeListagem();
      await assert.rejects(() => listarDaEmpresa(executor, empresa, opcoes), TypeError);
      assert.equal(executor.chamadas.length, 0);
    }

    for (const opcoes of [
      { vinculo: 'qualquer' }, { vinculo: '' },
      { pagina: 0 }, { pagina: -1 }, { pagina: 1.5 },
      { limite: 0 }, { limite: -5 },
      { busca: 42 }, { busca: {} },
    ]) {
      const executor = executorDeListagem();
      await assert.rejects(() => listarDaEmpresa(executor, EMPRESA_A, opcoes), TypeError);
      assert.equal(executor.chamadas.length, 0, `${JSON.stringify(opcoes)} não deveria consultar`);
    }
  });

  test('erro inesperado do banco propaga', async () => {
    const executor = { query: async () => { throw new Error('falha ao consultar usuarios'); } };

    await assert.rejects(() => listarDaEmpresa(executor, EMPRESA_A, {}), /falha ao consultar/);
  });
});

describe('vínculos de uma identidade global (Pacote 4)', () => {
  const { listarVinculosAtivosDaIdentidade, buscarVinculoAtivoDaIdentidade } = require('../../src/repositories/usuario.repository');
  const linha = { usuario_id: 70, usuario_nome: 'Pessoa', usuario_perfil: 'MASTER', empresa_id: 3, empresa_nome: 'Empresa A', empresa_cnpj: '11222333000181' };

  test('listar: vínculo ativo + empresa ativa NA consulta, parametrizado, sem credencial, ordenado', async () => {
    const executor = executorFalso([linha]);
    const r = await listarVinculosAtivosDaIdentidade(executor, 9);
    assert.deepEqual(r, [{ usuarioId: 70, nome: 'Pessoa', perfil: 'MASTER', empresa: { id: 3, nome: 'Empresa A', cnpj: '11222333000181' } }]);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /u\.identidade_id\s*=\s*\$1/i);
    assert.match(texto, /u\.ativo/i);
    assert.match(texto, /e\.ativo/i);
    assert.match(texto, /order\s+by/i);
    assert.doesNotMatch(texto, /senha_hash/i);
    assert.deepEqual(valores, [9]);
  });

  test('buscar: exige o par (identidade, empresa) e as duas atividades; null quando não há', async () => {
    const executor = executorFalso([linha]);
    assert.equal((await buscarVinculoAtivoDaIdentidade(executor, 9, 3)).usuarioId, 70);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /u\.identidade_id\s*=\s*\$1/i);
    assert.match(texto, /e\.id\s*=\s*\$2/i);
    assert.match(texto, /u\.ativo/i);
    assert.match(texto, /e\.ativo/i);
    assert.doesNotMatch(texto, /senha_hash/i);
    assert.deepEqual(valores, [9, 3]);
    assert.equal(await buscarVinculoAtivoDaIdentidade(executorFalso([]), 9, 3), null);
  });

  test('recusa identificadores inválidos antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => listarVinculosAtivosDaIdentidade(executor, '9'), /identidade/i);
    await assert.rejects(() => buscarVinculoAtivoDaIdentidade(executor, 9, 0), /empresa/i);
    await assert.rejects(() => buscarVinculoAtivoDaIdentidade(executor, 0, 3), /identidade/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('buscarCredencialPorEmail devolve identidade_id (null no modelo anterior) para o login legado recusar o modelo global', async () => {
    const { buscarCredencialPorEmail: buscar } = require('../../src/repositories/usuario.repository');
    const r = await buscar(executorFalso([linhaUsuario({ senha_hash: HASH })]), EMPRESA_A, EMAIL);
    assert.equal(r.identidade_id, null);
    const g = await buscar(executorFalso([linhaUsuario({ senha_hash: null, identidade_id: 12 })]), EMPRESA_A, EMAIL);
    assert.equal(g.identidade_id, 12);
  });
});
