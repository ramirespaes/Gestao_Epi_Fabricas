'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertSemSensiveis } = require('../helpers/sensiveis');

// authConfig é carregado uma vez por processo a partir do ambiente do setup
// (segredo aleatório em memória). Todas as regras são testadas com ambiente
// artificial via carregarConfigAuth(); o require sem segredo usa processo
// filho isolado. Nenhum teste altera process.env.
const auth = require('../../src/config/auth');
const { authConfig, obterLoginCooldownHmacSecret, carregarConfigAuth, HMAC_SECRET_BYTES_MINIMO } = auth;

const SEGREDO = process.env.LOGIN_COOLDOWN_HMAC_SECRET;
const base = { LOGIN_COOLDOWN_HMAC_SECRET: SEGREDO };
const erroDe = (env) => {
  try {
    carregarConfigAuth(env);
    return null;
  } catch (erro) {
    return erro.message;
  }
};

const PADRAO = {
  ambiente: 'development',
  sessao: { cookieNome: 'gepi_sessao', cookieNomeAdmin: 'gepi_sessao_admin', cookieSecure: false, cookieSameSite: 'lax', expiracaoMinutos: 720, inatividadeMinutos: 30 },
  argon2: { memoryKib: 65536, timeCost: 3, parallelism: 1, hashLength: 32 },
  cooldown: { niveis: [{ falhas: 5, janelaMinutos: 15, duracaoMinutos: 15 }, { falhas: 10, janelaMinutos: 60, duracaoMinutos: 60 }], retencaoDias: 30 },
  // Pacote 3 — validade do convite do MASTER.
  conviteMaster: { expiracaoMinutos: 4320 },
};

describe('configuração carregada do ambiente de teste', () => {
  test('ambiente test com os demais padrões', () => {
    assert.deepEqual(authConfig, { ...PADRAO, ambiente: 'test' });
    assert.equal(HMAC_SECRET_BYTES_MINIMO, 32);
  });

  test('configuração congelada em todos os níveis', () => {
    for (const objeto of [authConfig, authConfig.sessao, authConfig.argon2, authConfig.cooldown, authConfig.cooldown.niveis, ...authConfig.cooldown.niveis]) {
      assert.equal(Object.isFrozen(objeto), true);
    }
    assert.throws(() => { authConfig.cooldown.niveis[0].falhas = 1; }, TypeError);
    assert.throws(() => { authConfig.cooldown.niveis.push({}); }, TypeError);
    assert.throws(() => { authConfig.sessao.cookieSecure = true; }, TypeError);
  });

  test('segredo fora da configuração pública, só por cópia defensiva', () => {
    const copia1 = obterLoginCooldownHmacSecret();
    assert.equal(copia1.toString('hex'), SEGREDO);
    assert.equal(copia1.length, 32);
    const copia2 = obterLoginCooldownHmacSecret();
    assert.notEqual(copia1, copia2);
    copia1.fill(0);
    assert.equal(obterLoginCooldownHmacSecret().toString('hex'), SEGREDO);

    const sentinelas = [SEGREDO, SEGREDO.slice(0, 16)];
    assertSemSensiveis(JSON.stringify(authConfig), sentinelas, 'JSON da configuração');
    assertSemSensiveis(util.inspect(authConfig, { depth: 10, showHidden: true }), sentinelas, 'inspect da configuração');
    assertSemSensiveis(util.inspect(auth, { depth: 10, showHidden: true }), sentinelas, 'inspect do módulo');
    assert.equal(Reflect.ownKeys(authConfig.cooldown).length, 2);
  });
});

describe('carregarConfigAuth com ambiente artificial', () => {
  test('padrões com apenas o segredo definido', () => {
    assert.deepEqual(carregarConfigAuth(base), PADRAO);
  });

  test('segredo: obrigatório, hexadecimal, mínimo 64 hex, comprimento par, sem fallback', () => {
    const ruim = 'zz' + 'a'.repeat(62);
    assert.match(erroDe({}), /LOGIN_COOLDOWN_HMAC_SECRET: obrigatória/);
    assert.match(erroDe({ LOGIN_COOLDOWN_HMAC_SECRET: '   ' }), /LOGIN_COOLDOWN_HMAC_SECRET: obrigatória/);
    assert.match(erroDe({ NODE_ENV: 'test' }), /LOGIN_COOLDOWN_HMAC_SECRET: obrigatória/);
    assert.match(erroDe({ LOGIN_COOLDOWN_HMAC_SECRET: ruim }), /apenas caracteres hexadecimais/);
    assertSemSensiveis(erroDe({ LOGIN_COOLDOWN_HMAC_SECRET: ruim }), [ruim], 'erro de segredo');
    assert.match(erroDe({ LOGIN_COOLDOWN_HMAC_SECRET: 'ab'.repeat(31) }), /mínimo 64 caracteres hexadecimais \(32 bytes\)/);
    assert.match(erroDe({ LOGIN_COOLDOWN_HMAC_SECRET: 'ab'.repeat(32) + 'c' }), /deve ser par/);
    assert.equal(erroDe({ LOGIN_COOLDOWN_HMAC_SECRET: '0'.repeat(64) }), null);
    assert.equal(erroDe({ LOGIN_COOLDOWN_HMAC_SECRET: 'AB'.repeat(32) }), null);
    assert.equal(erroDe({ ...base, NODE_ENV: 'test' }), null);
  });

  test('inteiros: limites, tipo e mensagens sem o valor', () => {
    assert.match(erroDe({ ...base, ARGON2_TIME_COST: '1' }), /ARGON2_TIME_COST: abaixo do mínimo permitido \(2\)/);
    assert.match(erroDe({ ...base, ARGON2_MEMORY_KIB: '19455' }), /ARGON2_MEMORY_KIB: abaixo do mínimo permitido \(19456\)/);
    assert.match(erroDe({ ...base, ARGON2_PARALLELISM: '9' }), /ARGON2_PARALLELISM: acima do máximo permitido \(8\)/);
    assert.match(erroDe({ ...base, LOGIN_TENTATIVAS_RETENCAO_DIAS: '366' }), /acima do máximo permitido \(365\)/);
    assert.match(erroDe({ ...base, SESSAO_EXPIRACAO_MINUTOS: 'abc' }), /SESSAO_EXPIRACAO_MINUTOS: deve ser um número inteiro/);
    assert.match(erroDe({ ...base, SESSAO_EXPIRACAO_MINUTOS: '3.5' }), /deve ser um número inteiro/);
    assertSemSensiveis(erroDe({ ...base, SESSAO_EXPIRACAO_MINUTOS: 'valorEstranho123' }), ['valorEstranho123'], 'erro de inteiro');
    assert.equal(carregarConfigAuth({ ...base, ARGON2_MEMORY_KIB: '19456', ARGON2_TIME_COST: '2' }).argon2.memoryKib, 19456);
  });

  test('enums e booleano explícito', () => {
    assert.match(erroDe({ ...base, NODE_ENV: 'staging' }), /NODE_ENV: deve ser um de: development, test, production/);
    assert.match(erroDe({ ...base, SESSAO_COOKIE_SECURE: 'yes' }), /SESSAO_COOKIE_SECURE: deve ser um de: true, false/);
    assert.match(erroDe({ ...base, SESSAO_COOKIE_SAMESITE: 'None' }), /SESSAO_COOKIE_SAMESITE: deve ser um de: strict, lax, none/);
    assert.equal(carregarConfigAuth({ ...base, SESSAO_COOKIE_SECURE: 'false' }).sessao.cookieSecure, false);
    assert.equal(carregarConfigAuth({ ...base, SESSAO_COOKIE_SECURE: 'true' }).sessao.cookieSecure, true);
  });

  test('cookie: nome, prefixos e Secure em produção', () => {
    assert.match(erroDe({ ...base, SESSAO_COOKIE_NOME: 'a b' }), /SESSAO_COOKIE_NOME: formato inválido/);
    assert.match(erroDe({ ...base, SESSAO_COOKIE_NOME: '__Host-gepi' }), /prefixo __Host- exige cookie Secure/);
    assert.match(erroDe({ ...base, SESSAO_COOKIE_NOME: '__Secure-gepi' }), /prefixo __Secure- exige cookie Secure/);
    assert.equal(erroDe({ ...base, SESSAO_COOKIE_NOME: '__Host-gepi', SESSAO_COOKIE_SECURE: 'true' }), null);
    assert.equal(erroDe({ ...base, SESSAO_COOKIE_NOME: '__Host-gepi', NODE_ENV: 'production' }), null);
    assert.equal(carregarConfigAuth({ ...base, NODE_ENV: 'production' }).sessao.cookieSecure, true);
    assert.match(erroDe({ ...base, NODE_ENV: 'production', SESSAO_COOKIE_SECURE: 'false' }), /SESSAO_COOKIE_SECURE: não pode ser false em produção/);
  });

  test('cookie administrativo: nome próprio, distinto do empresarial, mesmos prefixos', () => {
    // Autenticação Global — Pacote 2: SESSAO_ADMIN_COOKIE_NOME é o cookie do
    // Painel Privado. Precisa ter formato válido, nunca coincidir com
    // SESSAO_COOKIE_NOME (garante isolamento entre os dois contextos por
    // construção) e seguir as mesmas regras de prefixo __Secure-/__Host-.
    assert.equal(carregarConfigAuth(base).sessao.cookieNomeAdmin, 'gepi_sessao_admin');
    assert.match(erroDe({ ...base, SESSAO_ADMIN_COOKIE_NOME: 'a b' }), /SESSAO_ADMIN_COOKIE_NOME: formato inválido/);
    assert.match(
      erroDe({ ...base, SESSAO_ADMIN_COOKIE_NOME: 'gepi_sessao' }),
      /SESSAO_ADMIN_COOKIE_NOME: não pode ser igual a SESSAO_COOKIE_NOME/,
    );
    assert.match(
      erroDe({ ...base, SESSAO_COOKIE_NOME: 'gepi_admin', SESSAO_ADMIN_COOKIE_NOME: 'gepi_admin' }),
      /SESSAO_ADMIN_COOKIE_NOME: não pode ser igual a SESSAO_COOKIE_NOME/,
    );
    assert.match(
      erroDe({ ...base, SESSAO_ADMIN_COOKIE_NOME: '__Host-gepi_admin' }),
      /SESSAO_ADMIN_COOKIE_NOME: prefixo __Host- exige cookie Secure/,
    );
    assert.match(
      erroDe({ ...base, SESSAO_ADMIN_COOKIE_NOME: '__Secure-gepi_admin' }),
      /SESSAO_ADMIN_COOKIE_NOME: prefixo __Secure- exige cookie Secure/,
    );
    assert.equal(
      erroDe({ ...base, SESSAO_ADMIN_COOKIE_NOME: '__Host-gepi_admin', SESSAO_COOKIE_SECURE: 'true' }),
      null,
    );
    assert.equal(
      erroDe({ ...base, SESSAO_ADMIN_COOKIE_NOME: '__Host-gepi_admin', NODE_ENV: 'production' }),
      null,
    );
    assert.equal(
      carregarConfigAuth({ ...base, SESSAO_ADMIN_COOKIE_NOME: 'painel_privado_sessao' }).sessao.cookieNomeAdmin,
      'painel_privado_sessao',
    );
  });

  test('regras cruzadas de sessão e cooldown', () => {
    assert.match(erroDe({ ...base, SESSAO_COOKIE_SAMESITE: 'none' }), /SameSite=None exige cookie Secure/);
    assert.equal(erroDe({ ...base, SESSAO_COOKIE_SAMESITE: 'none', SESSAO_COOKIE_SECURE: 'true' }), null);
    assert.match(erroDe({ ...base, SESSAO_INATIVIDADE_MINUTOS: '721' }), /não pode ser maior que SESSAO_EXPIRACAO_MINUTOS/);
    assert.equal(erroDe({ ...base, SESSAO_INATIVIDADE_MINUTOS: '720' }), null);
    assert.match(erroDe({ ...base, LOGIN_COOLDOWN_NIVEL2_FALHAS: '5' }), /deve ser maior que LOGIN_COOLDOWN_NIVEL1_FALHAS/);
    assert.match(erroDe({ ...base, LOGIN_COOLDOWN_NIVEL2_JANELA_MINUTOS: '14' }), /deve ser maior ou igual/);
  });

  test('vários problemas listados juntos; variáveis desconhecidas ignoradas', () => {
    const mensagem = erroDe({ ARGON2_TIME_COST: '99', NODE_ENV: 'x', OUTRA_VAR: 'qualquerCoisa' });
    assert.match(mensagem, /LOGIN_COOLDOWN_HMAC_SECRET: obrigatória/);
    assert.match(mensagem, /ARGON2_TIME_COST: acima do máximo permitido \(20\)/);
    assert.match(mensagem, /NODE_ENV: deve ser um de/);
    assertSemSensiveis(mensagem, ['qualquerCoisa'], 'erro combinado');
  });
});

describe('require do módulo em processo isolado', () => {
  const executar = (env) => spawnSync(process.execPath, ['-e', "require('./src/config/auth')"], {
    cwd: path.join(__dirname, '..', '..'),
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });

  test('sem segredo o processo não sobe e o erro cita só o nome da variável', () => {
    const resultado = executar({});
    assert.notEqual(resultado.status, 0);
    assert.match(resultado.stderr, /LOGIN_COOLDOWN_HMAC_SECRET: obrigatória/);
  });

  test('com segredo inválido o processo não sobe e o valor não aparece', () => {
    const resultado = executar({ LOGIN_COOLDOWN_HMAC_SECRET: 'segredoRuim123' });
    assert.notEqual(resultado.status, 0);
    assert.match(resultado.stderr, /apenas caracteres hexadecimais/);
    assertSemSensiveis(resultado.stderr, ['segredoRuim123'], 'stderr');
  });

  test('com segredo válido o processo sobe', () => {
    const resultado = executar({ LOGIN_COOLDOWN_HMAC_SECRET: crypto.randomBytes(32).toString('hex') });
    assert.equal(resultado.status, 0);
  });
});
