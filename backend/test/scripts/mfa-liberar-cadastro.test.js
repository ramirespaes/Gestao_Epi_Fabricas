'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const script = require('../../scripts/mfa-liberar-cadastro');
const liberacaoService = require('../../src/services/liberacao-cadastro-mfa-plataforma.service');

/**
 * CLI de liberação do cadastro MFA, sem PostgreSQL: o serviço é mockado
 * (chamado por namespace). Prova a exigência de --confirmo, os códigos de
 * saída de cada recusa e que o código aparece uma única vez na saída, sem
 * nenhum outro segredo.
 */

const CODIGO = 'ABCD-EFGH-JKMN-PQRS';
const poolFalso = () => ({ query: async () => ({ rows: [{ banco: 'db_teste', servidor: null, porta: 5432 }] }) });
const capturar = () => {
  const logs = [];
  const erros = [];
  return { logs, erros, saida: { log: (m) => logs.push(String(m)), error: (m) => erros.push(String(m)) } };
};

describe('interpretarArgumentos', () => {
  test('--email obrigatório; --confirmo interpretado; recusa argumento desconhecido, repetido ou sem valor', () => {
    assert.deepEqual(script.interpretarArgumentos(['--email', 'a@b.com', '--confirmo']), { ok: true, email: 'a@b.com', confirmo: true });
    assert.deepEqual(script.interpretarArgumentos(['--email', 'a@b.com']), { ok: true, email: 'a@b.com', confirmo: false });
    for (const argumentos of [[], ['--email'], ['--email', 'a@b.com', '--email', 'c@d.com'], ['--email', 'a@b.com', '--forcar']]) {
      assert.equal(script.interpretarArgumentos(argumentos).ok, false, JSON.stringify(argumentos));
    }
  });

  test('códigos de saída distintos; o uso cita o comando npm, --email e --confirmo', () => {
    const valores = Object.values(script.SAIDAS);
    assert.equal(new Set(valores).size, valores.length);
    assert.equal(script.SAIDAS.OK, 0);
    const uso = script.uso();
    assert.ok(uso.includes('db:mfa:liberar-cadastro'));
    assert.ok(uso.includes('--email'));
    assert.ok(uso.includes('--confirmo'));
  });
});

describe('executarComando', () => {
  test('sem --confirmo não chama o serviço', async (t) => {
    const liberar = t.mock.method(liberacaoService, 'liberarCadastro', async () => ({ administradorId: 9, codigo: CODIGO, expiraEm: new Date() }));
    const { saida } = capturar();

    assert.equal(await script.executarComando({ email: 'a@b.com', confirmo: false }, { pool: poolFalso(), saida }), script.SAIDAS.ARGUMENTOS);
    assert.equal(liberar.mock.calls.length, 0);
  });

  test('sucesso: o código de liberação sai uma única vez, com o prazo; nada mais sensível', async (t) => {
    const expiraEm = new Date('2026-09-28T10:30:00Z');
    const liberar = t.mock.method(liberacaoService, 'liberarCadastro', async () => ({ administradorId: 9, codigo: CODIGO, expiraEm }));
    const { logs, erros, saida } = capturar();
    const pool = poolFalso();

    const codigo = await script.executarComando({ email: 'admin@safework.com.br', confirmo: true }, { pool, saida });

    assert.equal(codigo, script.SAIDAS.OK);
    assert.deepEqual(liberar.mock.calls[0].arguments, [pool, { email: 'admin@safework.com.br' }]);
    const texto = logs.join('\n');
    assert.equal(texto.split(CODIGO).length - 1, 1);
    assert.ok(texto.includes(expiraEm.toISOString()));
    assert.equal(erros.join('\n').includes(CODIGO), false);
    assert.doesNotMatch(texto, /otpauth:|secret|segredo_cifrado|nonce/i);
  });

  test('cada recusa do serviço vira um código de saída próprio, sem imprimir código algum', async (t) => {
    const casos = [
      ['EMAIL_INVALIDO', script.SAIDAS.EMAIL_INVALIDO],
      ['ADMINISTRADOR_INEXISTENTE', script.SAIDAS.ADMINISTRADOR_INEXISTENTE],
      ['ADMINISTRADOR_INATIVO', script.SAIDAS.ADMINISTRADOR_INATIVO],
      ['TOTP_ATIVO', script.SAIDAS.TOTP_ATIVO],
    ];
    for (const [motivo, esperado] of casos) {
      t.mock.method(liberacaoService, 'liberarCadastro', async () => { throw new liberacaoService.ErroLiberacaoCadastro(motivo); });
      const { logs, erros, saida } = capturar();
      assert.equal(await script.executarComando({ email: 'admin@safework.com.br', confirmo: true }, { pool: poolFalso(), saida }), esperado, motivo);
      assert.ok(erros.join('\n').length > 0, motivo);
      assert.equal(logs.join('\n').includes(CODIGO), false);
      t.mock.restoreAll();
    }
  });

  test('erro inesperado propaga (o principal devolve ERRO)', async (t) => {
    const erro = new Error('conexão perdida');
    t.mock.method(liberacaoService, 'liberarCadastro', async () => { throw erro; });
    const { saida } = capturar();
    await assert.rejects(() => script.executarComando({ email: 'a@b.com', confirmo: true }, { pool: poolFalso(), saida }), (e) => e === erro);
  });
});
