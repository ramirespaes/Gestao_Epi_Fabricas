'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  CHAVE_COOLDOWN_TAMANHO,
  gerarChaveCooldown,
  gerarChaveCooldownPlataforma,
  gerarChaveCooldownConvite,
  chaveCooldownTemFormatoValido,
  derivarAdvisoryLock64,
  idCorrelacaoCooldown,
} = require('../../src/security/cooldown');
const { obterLoginCooldownHmacSecret } = require('../../src/config/auth');
const { cnpjTemDigitosVerificadoresValidos } = require('../../src/utils/normalizacao');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const SEGREDO_HEX = process.env.LOGIN_COOLDOWN_HMAC_SECRET;
const hmac = (mensagem) => crypto.createHmac('sha256', Buffer.from(SEGREDO_HEX, 'hex')).update(mensagem, 'utf8').digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

describe('gerarChaveCooldown', () => {
  const chave = gerarChaveCooldown('12345678000195', 'luis@empresa.com');

  test('HMAC-SHA-256 sobre cnpj + 0x0A + email, em 64 hex minúsculos', () => {
    assert.equal(chave, hmac('12345678000195\nluis@empresa.com'));
    assert.notEqual(chave, hmac('12345678000195luis@empresa.com'));
    assert.equal(chave.length, CHAVE_COOLDOWN_TAMANHO);
    assert.match(chave, HEX64);
    assert.equal(chaveCooldownTemFormatoValido(chave), true);
  });

  test('a mesma entrada produz sempre a mesma chave', () => {
    for (let i = 0; i < 100; i += 1) {
      assert.equal(gerarChaveCooldown('12345678000195', 'luis@empresa.com'), chave);
    }
  });

  test('normalização torna a chave idempotente para máscara, espaços, caixa e CNPJ alfanumérico', () => {
    assert.equal(gerarChaveCooldown('12.345.678/0001-95', '  Luis@Empresa.COM '), chave);
    assert.equal(gerarChaveCooldown(' 12345678000195 ', 'LUIS@EMPRESA.COM'), chave);
    const alfa = gerarChaveCooldown('00.000.000/e08g-12', 'Ana@Empresa.com');
    assert.equal(gerarChaveCooldown('00000000E08G12', 'ana@empresa.com'), alfa);
    assert.equal(alfa, hmac('00000000E08G12\nana@empresa.com'));
    assert.notEqual(alfa, chave);
    assert.notEqual(gerarChaveCooldown('12345678000195', 'outro@empresa.com'), chave);
    assert.notEqual(gerarChaveCooldown('12345678000196', 'luis@empresa.com'), chave);
  });

  test('CNPJ estruturalmente válido com DV inválido gera chave determinística', () => {
    assert.equal(cnpjTemDigitosVerificadoresValidos('12345678000196'), false);
    const dvRuim = gerarChaveCooldown('12.345.678/0001-96', 'luis@empresa.com');
    assert.match(dvRuim, HEX64);
    assert.equal(gerarChaveCooldown('12345678000196', 'luis@empresa.com'), dvRuim);
    assert.equal(gerarChaveCooldown('00000000e08g13', 'ana@empresa.com'), gerarChaveCooldown('00.000.000/E08G-13', 'ana@empresa.com'));
    assert.equal(gerarChaveCooldown('99999999999999', 'ninguem@nada.com').length, 64);
  });

  test('só a cópia do segredo é zerada; a chave não contém identificadores nem segredo', () => {
    assert.equal(obterLoginCooldownHmacSecret().toString('hex'), SEGREDO_HEX);
    assertSemSensiveis(chave, ['12345678', 'luis', SEGREDO_HEX.slice(0, 12)], 'chave');
  });

  test('segredo diferente em outro processo produz chave diferente', () => {
    const executar = (segredo) => spawnSync(process.execPath, ['-e', "console.log(require('./src/security/cooldown').gerarChaveCooldown('12345678000195', 'luis@empresa.com'))"], {
      cwd: path.join(__dirname, '..', '..'),
      env: { PATH: process.env.PATH, LOGIN_COOLDOWN_HMAC_SECRET: segredo },
      encoding: 'utf8',
    }).stdout.trim();
    const a = executar('ab'.repeat(32));
    const b = executar('cd'.repeat(32));
    assert.match(a, HEX64);
    assert.match(b, HEX64);
    assert.notEqual(a, b);
    assert.notEqual(a, chave);
  });

  test('entradas inválidas: TypeError fixo, sem o valor', () => {
    const casos = [
      ['1234567800019', 'luis@empresa.com', 'cnpj não normalizável', '1234567'],
      ['00000000E08GA2', 'luis@empresa.com', 'cnpj não normalizável', 'E08GA2'],
      ['12345678000195', 'semarroba.com', 'e-mail não normalizável', 'semarroba'],
      ['12345678000195', 'josé@empresa.com', 'e-mail não normalizável', 'josé'],
      [null, 'luis@empresa.com', 'cnpj não normalizável', 'null'],
      ['12345678000195', 12345, 'e-mail não normalizável', '12345'],
    ];
    for (const [cnpj, email, mensagem, valor] of casos) {
      assert.throws(() => gerarChaveCooldown(cnpj, email), (erro) => {
        assert.ok(erro instanceof TypeError);
        assert.equal(erro.message, mensagem);
        assertSemSensiveis(erro.message, [valor], 'mensagem');
        return true;
      });
    }
  });
});

describe('gerarChaveCooldownPlataforma (correção final do Pacote 2 — cooldown do Painel Privado)', () => {
  const chave = gerarChaveCooldownPlataforma('admin@safework.com.br');

  test('HMAC-SHA-256 sobre o rótulo PLATAFORMA + 0x0A + email, em 64 hex minúsculos', () => {
    assert.equal(chave, hmac('PLATAFORMA\nadmin@safework.com.br'));
    assert.equal(chave.length, CHAVE_COOLDOWN_TAMANHO);
    assert.match(chave, HEX64);
    assert.equal(chaveCooldownTemFormatoValido(chave), true);
  });

  test('a mesma entrada produz sempre a mesma chave; normalização de e-mail se aplica (espaço, caixa)', () => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal(gerarChaveCooldownPlataforma('admin@safework.com.br'), chave);
    }
    assert.equal(gerarChaveCooldownPlataforma('  Admin@SafeWork.com.br  '), chave);
  });

  test('NUNCA colide com a chave do cliente para o mesmo e-mail — domínios separados por rótulo', () => {
    const chaveCliente = gerarChaveCooldown('12345678000195', 'admin@safework.com.br');
    assert.notEqual(chave, chaveCliente);
    // Mesmo se um CNPJ (impossível na prática — CNPJ tem 14 posições fixas)
    // pudesse coincidir com o literal 'PLATAFORMA', o separador 0x0A e a
    // igualdade byte a byte do restante da mensagem HMAC evitam qualquer
    // ambiguidade: são mensagens de tamanho e composição estruturalmente
    // diferentes.
    assert.notEqual(gerarChaveCooldownPlataforma('outro@empresa.com'), chave);
  });

  test('e-mail não normalizável: TypeError fixo, sem o valor', () => {
    for (const ruim of ['semarroba.com', 'josé@empresa.com', null, 12345, undefined]) {
      assert.throws(() => gerarChaveCooldownPlataforma(ruim), (erro) => {
        assert.ok(erro instanceof TypeError);
        assert.equal(erro.message, 'e-mail não normalizável');
        return true;
      });
    }
  });

  test('só a cópia do segredo é zerada; a chave não contém o e-mail nem o segredo', () => {
    assert.equal(obterLoginCooldownHmacSecret().toString('hex'), SEGREDO_HEX);
    assertSemSensiveis(chave, ['admin', 'safework', SEGREDO_HEX.slice(0, 12)], 'chave de plataforma');
  });

  test('reaproveita as MESMAS derivações de advisory lock e correlação, sem duplicar lógica', () => {
    assert.match(derivarAdvisoryLock64(chave), /^-?[0-9]+$/);
    assert.equal(idCorrelacaoCooldown(chave), chave.slice(0, 16));
  });
});

describe('gerarChaveCooldownConvite (Pacote 3 — aceite de convite do MASTER)', () => {
  const TOKEN = 'Zm9ybWF0b2Jhc2U2NHVybGRldG9rZW5jb21fNDNjaGFy'.slice(0, 43);
  const chave = gerarChaveCooldownConvite(TOKEN);

  test('HMAC-SHA-256 sobre CONVITE_MASTER + 0x0A + token, 64 hex; rótulo separa dos outros dois contextos', () => {
    assert.equal(chave, hmac(`CONVITE_MASTER\n${TOKEN}`));
    assert.match(chave, HEX64);
    assert.equal(chaveCooldownTemFormatoValido(chave), true);
    assert.notEqual(chave, hmac(`PLATAFORMA\n${TOKEN}`));
  });

  test('determinística; tokens diferentes geram chaves diferentes', () => {
    assert.equal(gerarChaveCooldownConvite(TOKEN), chave);
    assert.notEqual(gerarChaveCooldownConvite(`${TOKEN.slice(0, 42)}x`), chave);
  });

  test('exige o formato canônico do token (43 chars base64url): TypeError fixo, sem o valor', () => {
    for (const ruim of ['abc', `${TOKEN}=`, TOKEN.slice(0, 42), null, 123, undefined, `${TOKEN}a`]) {
      assert.throws(() => gerarChaveCooldownConvite(ruim), { name: 'TypeError', message: 'token de convite com formato inválido' });
    }
  });

  test('a chave não contém o token nem o segredo', () => {
    assertSemSensiveis(chave, [TOKEN.slice(0, 12), SEGREDO_HEX.slice(0, 12)], 'chave de convite');
  });
});

describe('gerarChaveCooldownGlobal (Pacote 4 — login global do Portal do Cliente)', () => {
  const { gerarChaveCooldownGlobal } = require('../../src/security/cooldown');
  const chave = gerarChaveCooldownGlobal('  Pessoa@Exemplo-Cliente.com.br ');

  test('HMAC-SHA-256 sobre IDENTIDADE_GLOBAL + 0x0A + e-mail normalizado, 64 hex; rótulo separa dos outros três contextos', () => {
    assert.equal(chave, hmac('IDENTIDADE_GLOBAL\npessoa@exemplo-cliente.com.br'));
    assert.match(chave, HEX64);
    assert.equal(chaveCooldownTemFormatoValido(chave), true);
    assert.notEqual(chave, hmac('PLATAFORMA\npessoa@exemplo-cliente.com.br'));
    assert.notEqual(chave, gerarChaveCooldownPlataforma('pessoa@exemplo-cliente.com.br'), 'mesmo e-mail como administrador tem contador próprio');
  });

  test('determinística e normalizada; e-mail não normalizável: TypeError fixo, sem o valor', () => {
    assert.equal(gerarChaveCooldownGlobal('pessoa@exemplo-cliente.com.br'), chave);
    for (const ruim of ['', 'sem-arroba', null, 42]) {
      assert.throws(() => gerarChaveCooldownGlobal(ruim), { name: 'TypeError', message: 'e-mail não normalizável' });
    }
  });

  test('a chave não contém o e-mail nem o segredo', () => {
    assertSemSensiveis(chave, ['pessoa@exemplo', SEGREDO_HEX.slice(0, 12)], 'chave global');
  });
});

describe('derivarAdvisoryLock64', () => {
  const resto = 'a'.repeat(48);
  const lock = (hex16) => derivarAdvisoryLock64(hex16 + resto);

  test('respostas conhecidas: int64 com sinal em string decimal', () => {
    assert.equal(lock('0000000000000000'), '0');
    assert.equal(lock('7fffffffffffffff'), '9223372036854775807');
    assert.equal(lock('8000000000000000'), '-9223372036854775808');
    assert.equal(lock('ffffffffffffffff'), '-1');
    assert.equal(lock('0123456789abcdef'), '81985529216486895');
    assert.equal(lock('0123456789abcdef'), BigInt.asIntN(64, BigInt('0x0123456789abcdef')).toString());
  });

  test('usa só os 8 primeiros bytes e cabe no bigint do PostgreSQL para 1.000 chaves', () => {
    const chave = gerarChaveCooldown('12345678000195', 'luis@empresa.com');
    assert.equal(typeof derivarAdvisoryLock64(chave), 'string');
    assert.equal(derivarAdvisoryLock64(chave), derivarAdvisoryLock64(chave.slice(0, 16) + 'f'.repeat(48)));
    for (let i = 0; i < 1000; i += 1) {
      const k = gerarChaveCooldown('12345678000195', `u${i}@empresa.com`);
      const l = derivarAdvisoryLock64(k);
      assert.match(l, /^-?[0-9]+$/);
      assert.equal(BigInt.asIntN(64, BigInt(l)).toString(), l);
      assert.equal(l, BigInt.asIntN(64, BigInt('0x' + k.slice(0, 16))).toString());
    }
  });
});

describe('idCorrelacaoCooldown e validação da chave', () => {
  const chave = gerarChaveCooldown('12345678000195', 'luis@empresa.com');

  test('16 primeiros hex, sem CNPJ nem e-mail', () => {
    const id = idCorrelacaoCooldown(chave);
    assert.equal(id.length, 16);
    assert.equal(id, chave.slice(0, 16));
    assert.match(id, /^[0-9a-f]{16}$/);
    assertSemSensiveis(id, ['12345678', 'luis', 'empresa'], 'id de correlação');
  });

  test('chave inválida: false na validação e TypeError fixo nas derivações', () => {
    for (const ruim of [chave.slice(0, 63), chave + 'a', chave.toUpperCase(), 'g' + chave.slice(1), '', null, undefined, 123, Buffer.from(chave, 'hex'), {}]) {
      assert.equal(chaveCooldownTemFormatoValido(ruim), false);
      assert.throws(() => derivarAdvisoryLock64(ruim), { name: 'TypeError', message: 'chave de cooldown com formato inválido' });
      assert.throws(() => idCorrelacaoCooldown(ruim), { name: 'TypeError', message: 'chave de cooldown com formato inválido' });
    }
  });
});
