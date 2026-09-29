'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_SCRIPT = path.join(__dirname, '../../scripts/mfa-redefinir.js');
const CAMINHO_SERVICO = path.join(__dirname, '../../src/services/reset-mfa-plataforma.service.js');
const carregar = () => {
  assert.ok(fs.existsSync(CAMINHO_SCRIPT), 'script mfa-redefinir.js ausente');
  assert.ok(fs.existsSync(CAMINHO_SERVICO), 'serviço de reset operacional ausente');
  return { script: require(CAMINHO_SCRIPT), servico: require(CAMINHO_SERVICO) };
};

const CODIGO = 'ABCD-EFGH-JKMN-PQRS';
const poolFalso = () => ({ query: async () => ({ rows: [{ banco: 'db_teste', servidor: null, porta: 5432 }] }) });
const capturar = () => {
  const logs = [];
  const erros = [];
  return { logs, erros, saida: { log: (m) => logs.push(String(m)), error: (m) => erros.push(String(m)) } };
};

describe('CLI db:mfa:redefinir', () => {
  test('registrado no package.json como node --require dotenv/config scripts/mfa-redefinir.js', () => {
    const pacote = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    assert.equal(pacote.scripts['db:mfa:redefinir'], 'node --require dotenv/config scripts/mfa-redefinir.js');
    carregar();
  });

  test('argumentos: --email obrigatório, --confirmo interpretado, recusa desconhecido, repetido ou sem valor; uso cita o comando', () => {
    const { script } = carregar();
    assert.deepEqual(script.interpretarArgumentos(['--email', 'a@b.com', '--confirmo']), { ok: true, email: 'a@b.com', confirmo: true });
    assert.deepEqual(script.interpretarArgumentos(['--email', 'a@b.com']), { ok: true, email: 'a@b.com', confirmo: false });
    for (const argumentos of [[], ['--email'], ['--email', 'a@b.com', '--email', 'c@d.com'], ['--email', 'a@b.com', '--forcar']]) {
      assert.equal(script.interpretarArgumentos(argumentos).ok, false, JSON.stringify(argumentos));
    }
    const valores = Object.values(script.SAIDAS);
    assert.equal(new Set(valores).size, valores.length);
    assert.ok(script.uso().includes('db:mfa:redefinir'));
  });

  test('sem --confirmo: nada é executado', async (t) => {
    const { script, servico } = carregar();
    const redefinir = t.mock.method(servico, 'redefinirMfa', async () => { throw new Error('não deveria'); });
    const { saida } = capturar();
    assert.equal(await script.executarComando({ email: 'a@b.com', confirmo: false }, { pool: poolFalso(), saida }), script.SAIDAS.ARGUMENTOS);
    assert.equal(redefinir.mock.calls.length, 0);
  });

  test('sucesso: o código novo aparece uma única vez; nada mais sensível é impresso', async (t) => {
    const { script, servico } = carregar();
    t.mock.method(servico, 'redefinirMfa', async () => ({ administradorId: 9, codigo: CODIGO, expiraEm: new Date('2026-09-28T12:30:00Z') }));
    const { logs, erros, saida } = capturar();

    assert.equal(await script.executarComando({ email: 'admin@safework.com.br', confirmo: true }, { pool: poolFalso(), saida }), script.SAIDAS.OK);

    const texto = [...logs, ...erros].join('\n');
    assert.equal(texto.split(CODIGO).length - 1, 1);
    assert.ok(texto.includes('2026-09-28T12:30:00.000Z'));
    assert.doesNotMatch(texto, /otpauth|secret|token|hash/i);
  });

  test('recusas com saídas próprias (inativo = 8, como no CLI de liberação); erro inesperado propaga', async (t) => {
    const { script, servico } = carregar();
    assert.equal(script.SAIDAS.ADMINISTRADOR_INATIVO, 8);
    for (const [motivo, esperado] of [
      ['EMAIL_INVALIDO', script.SAIDAS.EMAIL_INVALIDO],
      ['ADMINISTRADOR_INEXISTENTE', script.SAIDAS.ADMINISTRADOR_INEXISTENTE],
      ['ADMINISTRADOR_INATIVO', script.SAIDAS.ADMINISTRADOR_INATIVO],
    ]) {
      t.mock.method(servico, 'redefinirMfa', async () => { throw new servico.ErroResetMfa(motivo); });
      const { logs, saida } = capturar();
      assert.equal(await script.executarComando({ email: 'a@b.com', confirmo: true }, { pool: poolFalso(), saida }), esperado, motivo);
      assert.doesNotMatch(logs.join('\n'), /código:/);
      t.mock.restoreAll();
    }
    t.mock.method(servico, 'redefinirMfa', async () => { throw new Error('banco fora'); });
    await assert.rejects(() => script.executarComando({ email: 'a@b.com', confirmo: true }, { pool: poolFalso(), saida: capturar().saida }), /banco fora/);
  });
});
