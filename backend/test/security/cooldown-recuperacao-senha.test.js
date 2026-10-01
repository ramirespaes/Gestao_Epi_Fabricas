'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const cooldown = require('../../src/security/cooldown');
const { obterLoginCooldownHmacSecret } = require('../../src/config/auth');
const { assertSemSensiveis } = require('../helpers/sensiveis');

/**
 * Chave do limite de solicitações de recuperação de senha por e-mail. Mesmo
 * HMAC-SHA-256 e mesmo segredo das chaves de cooldown, com um rótulo por
 * namespace. É o único valor derivado do e-mail que vai para
 * recuperacao_senha_solicitacoes (migration 063).
 */

const SEGREDO_HEX = process.env.LOGIN_COOLDOWN_HMAC_SECRET;
const hmac = (mensagem) => crypto.createHmac('sha256', Buffer.from(SEGREDO_HEX, 'hex')).update(mensagem, 'utf8').digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const EMAIL = 'pessoa@exemplo-cliente.com.br';

describe('gerarChaveRecuperacaoSenha', () => {
  test('HMAC-SHA-256 sobre o rótulo do namespace + 0x0A + e-mail normalizado, em 64 hex minúsculos', () => {
    const portal = cooldown.gerarChaveRecuperacaoSenha('PORTAL', EMAIL);
    const plataforma = cooldown.gerarChaveRecuperacaoSenha('PLATAFORMA', EMAIL);
    assert.equal(portal, hmac(`RECUPERACAO_SENHA_PORTAL\n${EMAIL}`));
    assert.equal(plataforma, hmac(`RECUPERACAO_SENHA_PLATAFORMA\n${EMAIL}`));
    for (const chave of [portal, plataforma]) {
      assert.match(chave, HEX64);
      assert.equal(chave.length, cooldown.CHAVE_COOLDOWN_TAMANHO);
      assert.equal(cooldown.chaveCooldownTemFormatoValido(chave), true);
    }
  });

  test('a mesma entrada no mesmo namespace gera sempre a mesma chave; a normalização do e-mail vale (espaço e caixa)', () => {
    const chave = cooldown.gerarChaveRecuperacaoSenha('PORTAL', EMAIL);
    for (let i = 0; i < 20; i += 1) assert.equal(cooldown.gerarChaveRecuperacaoSenha('PORTAL', EMAIL), chave);
    assert.equal(cooldown.gerarChaveRecuperacaoSenha('PORTAL', '  Pessoa@Exemplo-Cliente.com.br  '), chave);
    assert.notEqual(cooldown.gerarChaveRecuperacaoSenha('PORTAL', 'outra@exemplo-cliente.com.br'), chave);
  });

  test('namespaces não colidem entre si nem com as chaves de cooldown de login do mesmo e-mail', () => {
    const portal = cooldown.gerarChaveRecuperacaoSenha('PORTAL', EMAIL);
    const plataforma = cooldown.gerarChaveRecuperacaoSenha('PLATAFORMA', EMAIL);
    const chaves = [portal, plataforma, cooldown.gerarChaveCooldownGlobal(EMAIL), cooldown.gerarChaveCooldownPlataforma(EMAIL)];
    assert.equal(new Set(chaves).size, chaves.length, 'cada contexto tem a própria chave');
  });

  test('os escopos aceitos são exatamente os da migration 063', () => {
    assert.deepEqual(cooldown.ESCOPOS_RECUPERACAO_SENHA, { PORTAL: 'PORTAL', PLATAFORMA: 'PLATAFORMA' });
    assert.equal(Object.isFrozen(cooldown.ESCOPOS_RECUPERACAO_SENHA), true);
  });

  test('escopo desconhecido e e-mail não normalizável: TypeError fixo, sem o valor', () => {
    for (const escopo of ['portal', 'CLIENTE', 'ADMIN', '', null, undefined, 1, 'PORTAL\n']) {
      assert.throws(() => cooldown.gerarChaveRecuperacaoSenha(escopo, EMAIL), (erro) => {
        assert.ok(erro instanceof TypeError);
        assert.equal(erro.message, 'escopo de recuperação de senha inválido');
        return true;
      }, String(escopo));
    }
    for (const email of ['semarroba.com', 'josé@empresa.com', null, 12345, undefined, '']) {
      assert.throws(() => cooldown.gerarChaveRecuperacaoSenha('PORTAL', email), (erro) => {
        assert.ok(erro instanceof TypeError);
        assert.equal(erro.message, 'e-mail não normalizável');
        return true;
      }, String(email));
    }
  });

  test('só a cópia do segredo é zerada; a chave não contém o e-mail nem o segredo e não é reversível para o e-mail', () => {
    const chave = cooldown.gerarChaveRecuperacaoSenha('PORTAL', EMAIL);
    assert.equal(obterLoginCooldownHmacSecret().toString('hex'), SEGREDO_HEX);
    assertSemSensiveis(chave, ['pessoa', 'exemplo', 'cliente', SEGREDO_HEX.slice(0, 12)], 'chave de recuperação');
    // Sem o segredo, o SHA-256 simples do e-mail (com ou sem rótulo) não reproduz a chave.
    const sha = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
    assert.notEqual(chave, sha(EMAIL));
    assert.notEqual(chave, sha(`RECUPERACAO_SENHA_PORTAL\n${EMAIL}`));
  });

  test('reaproveita as mesmas derivações de advisory lock e correlação das outras chaves', () => {
    const chave = cooldown.gerarChaveRecuperacaoSenha('PLATAFORMA', EMAIL);
    assert.match(cooldown.derivarAdvisoryLock64(chave), /^-?[0-9]+$/);
    assert.equal(cooldown.idCorrelacaoCooldown(chave), chave.slice(0, 16));
  });
});
