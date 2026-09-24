'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const script = require('../../scripts/criar-administrador-plataforma');
const administradorPlataformaService = require('../../src/services/administrador-plataforma.service');

/**
 * Parte pura do script administrativo (Autenticação Global — Pacote 2):
 * interpretação de argumentos e a orquestração de executarComando, com
 * administrador-plataforma.service mockado (chamado por namespace no
 * script, o que torna mock.method possível). A criação REAL contra
 * PostgreSQL já é exercitada em
 * test/integracao/auth-plataforma-routes.integration.js, que chama
 * administradorPlataformaService.criarInicial diretamente.
 */

const poolFalso = () => ({
  query: async () => ({ rows: [{ banco: 'db_teste', servidor: null, porta: 5432 }] }),
});

describe('interpretarArgumentos', () => {
  test('--email é obrigatório; --confirmo é opcional na interpretação (a recusa fica em executarComando)', () => {
    assert.deepEqual(script.interpretarArgumentos(['--email', 'a@b.com']), { ok: true, email: 'a@b.com', confirmo: false });
    assert.deepEqual(script.interpretarArgumentos(['--email', 'a@b.com', '--confirmo']), { ok: true, email: 'a@b.com', confirmo: true });
    assert.equal(script.interpretarArgumentos([]).ok, false);
    assert.match(script.interpretarArgumentos([]).erro, /--email/);
  });

  test('recusa: --email sem valor, repetido, argumento desconhecido', () => {
    for (const argumentos of [['--email'], ['--email', 'a@b.com', '--email', 'c@d.com'], ['--email', 'a@b.com', '--outra-coisa']]) {
      const r = script.interpretarArgumentos(argumentos);
      assert.equal(r.ok, false, JSON.stringify(argumentos));
      assert.equal(typeof r.erro, 'string');
    }
    assert.throws(() => script.interpretarArgumentos('--email a@b.com'), TypeError);
  });

  test('códigos de saída são distintos e o texto de uso cita --email, --confirmo e a variável de senha', () => {
    assert.deepEqual(script.SAIDAS, {
      OK: 0, ERRO: 1, ARGUMENTOS: 2, SENHA_AUSENTE: 3, SENHA_INVALIDA: 4, EMAIL_INVALIDO: 5, EMAIL_EM_USO: 6,
    });
    assert.ok(script.uso().includes('--email'));
    assert.ok(script.uso().includes('--confirmo'));
    assert.ok(script.uso().includes('ADMINISTRADOR_PLATAFORMA_SENHA'));
  });

  test('recomenda "read -s" e alerta explicitamente contra a senha no histórico do terminal (correção final do Pacote 2, item 6)', () => {
    const texto = script.uso();
    const linhas = texto.split('\n');

    assert.ok(texto.includes('read -s'), 'deve recomendar leitura sem eco, sem rastro no histórico');
    assert.match(texto, /histórico/i);

    // A forma "VAR=valor node ..." pode aparecer citada só como exemplo do
    // que NÃO fazer (a própria linha precisa deixar isso explícito) — nunca
    // como o comando efetivamente recomendado no início do texto de uso.
    const linhasDeComandoRecomendado = linhas.slice(0, linhas.findIndex((l) => l.includes('NUNCA')));
    assert.ok(
      linhasDeComandoRecomendado.every((l) => !/ADMINISTRADOR_PLATAFORMA_SENHA='?\.\.\.'?\s+node/.test(l)),
      'o bloco de comando recomendado não pode conter a forma VAR=valor node ... numa única linha',
    );
    assert.ok(linhasDeComandoRecomendado.some((l) => l.includes('read -s')), 'o comando recomendado usa read -s');
  });

  test('não usa "read -s -p" como exemplo universal: -p do read é incompatível entre bash e Zsh (correção final, ajuste 1)', () => {
    const texto = script.uso();

    assert.doesNotMatch(
      texto.split('\n').find((l) => l.trim().startsWith('read ')) ?? '',
      /-p\b/,
      'a linha do comando "read" recomendado não pode usar -p (significado diferente em bash e Zsh)',
    );
    // O prompt precisa vir de um "printf" separado, portátil entre os dois shells.
    assert.ok(texto.includes('printf'), 'o prompt deve ser exibido com printf, não com read -p');
    assert.match(texto, /zsh/i, 'deve mencionar explicitamente a incompatibilidade com o Zsh');
  });
});

describe('executarComando', () => {
  test('sem --confirmo: recusa antes de ler a senha ou chamar o serviço', async (t) => {
    const criar = t.mock.method(administradorPlataformaService, 'criarInicial', async () => { throw new Error('não deveria ser chamado'); });
    const erros = [];
    const saida = { log: () => {}, error: (m) => erros.push(m) };

    const codigo = await script.executarComando({ email: 'a@b.com', confirmo: false }, { pool: poolFalso(), senha: 'qualquer', saida });

    assert.equal(codigo, script.SAIDAS.ARGUMENTOS);
    assert.equal(criar.mock.calls.length, 0);
    assert.ok(erros.some((m) => /confirmação/i.test(m)));
  });

  test('--confirmo sem ADMINISTRADOR_PLATAFORMA_SENHA definida: recusa antes de chamar o serviço', async (t) => {
    const criar = t.mock.method(administradorPlataformaService, 'criarInicial', async () => { throw new Error('não deveria ser chamado'); });
    const saida = { log: () => {}, error: () => {} };

    const semSenha = await script.executarComando({ email: 'a@b.com', confirmo: true }, { pool: poolFalso(), senha: undefined, saida });
    assert.equal(semSenha, script.SAIDAS.SENHA_AUSENTE);

    const senhaVazia = await script.executarComando({ email: 'a@b.com', confirmo: true }, { pool: poolFalso(), senha: '', saida });
    assert.equal(senhaVazia, script.SAIDAS.SENHA_AUSENTE);

    assert.equal(criar.mock.calls.length, 0);
  });

  test('sucesso: chama o serviço com email e senha, relata sem expor a senha, devolve OK', async (t) => {
    const criadoEm = new Date('2026-09-23T10:00:00Z');
    const criar = t.mock.method(administradorPlataformaService, 'criarInicial', async () => ({ id: 3, email: 'admin@safework.com.br', ativo: true, criadoEm }));
    const logs = [];
    const saida = { log: (m) => logs.push(m), error: () => {} };

    const codigo = await script.executarComando(
      { email: 'admin@safework.com.br', confirmo: true },
      { pool: poolFalso(), senha: 'uma-senha-de-teste-valida-123', saida },
    );

    assert.equal(codigo, script.SAIDAS.OK);
    assert.equal(criar.mock.calls.length, 1);
    assert.deepEqual(criar.mock.calls[0].arguments[1], { email: 'admin@safework.com.br', senha: 'uma-senha-de-teste-valida-123' });
    const textoDosLogs = logs.join('\n');
    assert.ok(textoDosLogs.includes('id=3'));
    assert.equal(textoDosLogs.includes('uma-senha-de-teste-valida-123'), false, 'a senha nunca pode ser impressa');
  });

  test('ErroSenhaInvalida: relata cada erro da política, sem a senha, devolve SENHA_INVALIDA', async (t) => {
    const erroPolitica = new administradorPlataformaService.ErroSenhaInvalida([{ codigo: 'SENHA_CURTA', mensagem: 'muito curta' }]);
    t.mock.method(administradorPlataformaService, 'criarInicial', async () => { throw erroPolitica; });
    const erros = [];
    const saida = { log: () => {}, error: (m) => erros.push(m) };

    const codigo = await script.executarComando({ email: 'a@b.com', confirmo: true }, { pool: poolFalso(), senha: '123', saida });

    assert.equal(codigo, script.SAIDAS.SENHA_INVALIDA);
    assert.ok(erros.some((m) => m.includes('SENHA_CURTA')));
    assert.equal(erros.join('\n').includes('123'), false);
  });

  test('e-mail inválido ou já em uso: propaga o código de saída correspondente', async (t) => {
    const { HttpError } = require('../../src/errors/HttpError');

    t.mock.method(administradorPlataformaService, 'criarInicial', async () => { throw HttpError.badRequest('ADMINISTRADOR_EMAIL_INVALIDO', 'E-mail inválido'); });
    const codigoInvalido = await script.executarComando({ email: 'sem-arroba', confirmo: true }, { pool: poolFalso(), senha: 'x', saida: { log: () => {}, error: () => {} } });
    assert.equal(codigoInvalido, script.SAIDAS.EMAIL_INVALIDO);

    t.mock.method(administradorPlataformaService, 'criarInicial', async () => { throw HttpError.conflict('ADMINISTRADOR_EMAIL_EM_USO', 'já existe'); });
    const codigoEmUso = await script.executarComando({ email: 'a@b.com', confirmo: true }, { pool: poolFalso(), senha: 'x', saida: { log: () => {}, error: () => {} } });
    assert.equal(codigoEmUso, script.SAIDAS.EMAIL_EM_USO);
  });

  test('erro inesperado do serviço propaga sem tradução', async (t) => {
    const erroInesperado = new Error('conexão perdida com o banco');
    t.mock.method(administradorPlataformaService, 'criarInicial', async () => { throw erroInesperado; });

    await assert.rejects(
      () => script.executarComando({ email: 'a@b.com', confirmo: true }, { pool: poolFalso(), senha: 'x', saida: { log: () => {}, error: () => {} } }),
      (erro) => erro === erroInesperado,
    );
  });
});
