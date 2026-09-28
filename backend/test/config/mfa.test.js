'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const crypto = require('node:crypto');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const mfa = require('../../src/config/mfa');

const hex = () => crypto.randomBytes(32).toString('hex');
const SEGREDO_COOLDOWN = Buffer.from(hex(), 'hex');

function carregar(origem, segredoCooldown = SEGREDO_COOLDOWN) {
  return mfa.carregarConfigMfa(origem, { segredoCooldown });
}

function recusa(origem, nomeVariavel, valoresQueNaoPodemAparecer = [], segredoCooldown) {
  assert.throws(() => carregar(origem, segredoCooldown), (erro) => {
    assert.match(erro.message, /^Configuração MFA inválida/);
    assert.ok(erro.message.includes(nomeVariavel), erro.message);
    assertSemSensiveis(erro.message, valoresQueNaoPodemAparecer, 'mensagem de erro');
    return true;
  });
}

describe('configuração das chaves MFA', () => {
  test('versão atual ausente, vazia ou fora do formato é recusada', () => {
    const chave = hex();
    recusa({ MFA_TOTP_KEY_V1: chave }, 'MFA_TOTP_KEY_CURRENT_VERSION', [chave]);
    recusa({ MFA_TOTP_KEY_CURRENT_VERSION: '   ', MFA_TOTP_KEY_V1: chave }, 'MFA_TOTP_KEY_CURRENT_VERSION', [chave]);
    for (const ruim of ['0', '01', '-1', '1.0', 'v1', '10000', 'um']) {
      recusa({ MFA_TOTP_KEY_CURRENT_VERSION: ruim, MFA_TOTP_KEY_V1: chave }, 'MFA_TOTP_KEY_CURRENT_VERSION', [chave]);
    }
  });

  test('versão atual sem a chave correspondente é recusada, sem fallback para outra versão', () => {
    const chave = hex();
    recusa({ MFA_TOTP_KEY_CURRENT_VERSION: '2', MFA_TOTP_KEY_V1: chave }, 'MFA_TOTP_KEY_V2', [chave]);
  });

  test('chave com tamanho errado ou fora do hexadecimal é recusada sem ecoar o valor', () => {
    for (const ruim of ['ab'.repeat(31), 'ab'.repeat(33), `${'ab'.repeat(31)}zz`, `${'ab'.repeat(31)} 0`]) {
      recusa({ MFA_TOTP_KEY_CURRENT_VERSION: '1', MFA_TOTP_KEY_V1: ruim }, 'MFA_TOTP_KEY_V1', [ruim]);
    }
  });

  test('nome de versão fora do formato é recusado', () => {
    const chave = hex();
    for (const nome of ['MFA_TOTP_KEY_V0', 'MFA_TOTP_KEY_V01', 'MFA_TOTP_KEY_VX', 'MFA_TOTP_KEY_V10000']) {
      recusa({ MFA_TOTP_KEY_CURRENT_VERSION: '1', MFA_TOTP_KEY_V1: hex(), [nome]: chave }, nome, [chave]);
    }
  });

  test('a mesma chave em duas versões é recusada', () => {
    const chave = hex();
    recusa({ MFA_TOTP_KEY_CURRENT_VERSION: '2', MFA_TOTP_KEY_V1: chave, MFA_TOTP_KEY_V2: chave.toUpperCase() }, 'MFA_TOTP_KEY_V2', [chave, chave.toUpperCase()]);
  });

  test('chave MFA igual ao LOGIN_COOLDOWN_HMAC_SECRET é recusada', () => {
    const chave = hex();
    recusa({ MFA_TOTP_KEY_CURRENT_VERSION: '1', MFA_TOTP_KEY_V1: chave }, 'LOGIN_COOLDOWN_HMAC_SECRET', [chave], Buffer.from(chave, 'hex'));
  });

  test('configuração válida com uma versão: objeto público só com versões, congelado', () => {
    const chave = hex();
    const config = carregar({ MFA_TOTP_KEY_CURRENT_VERSION: '1', MFA_TOTP_KEY_V1: chave });
    assert.deepEqual(config, { chaveVersaoAtual: 1, versoesDisponiveis: [1] });
    assert.ok(Object.isFrozen(config) && Object.isFrozen(config.versoesDisponiveis));
    assertSemSensiveis(JSON.stringify(config), [chave], 'JSON');
    assertSemSensiveis(util.inspect(config, { depth: null }), [chave], 'inspect');
  });

  test('múltiplas versões válidas, em qualquer ordem de declaração', () => {
    const config = carregar({ MFA_TOTP_KEY_V3: hex(), MFA_TOTP_KEY_CURRENT_VERSION: '3', MFA_TOTP_KEY_V1: hex(), MFA_TOTP_KEY_V12: hex() });
    assert.deepEqual(config, { chaveVersaoAtual: 3, versoesDisponiveis: [1, 3, 12] });
  });

  test('variáveis vazias contam como ausentes, como no restante da configuração', () => {
    const config = carregar({ MFA_TOTP_KEY_CURRENT_VERSION: '1', MFA_TOTP_KEY_V1: hex(), MFA_TOTP_KEY_V2: '  ' });
    assert.deepEqual(config.versoesDisponiveis, [1]);
  });
});

describe('acesso às chaves carregadas no processo', () => {
  test('a configuração do processo vem do ambiente de teste e não expõe a chave', () => {
    const chave = process.env.MFA_TOTP_KEY_V1;
    assert.equal(mfa.mfaConfig.chaveVersaoAtual, 1);
    assert.deepEqual(mfa.mfaConfig.versoesDisponiveis, [1]);
    assertSemSensiveis(JSON.stringify(mfa.mfaConfig), [chave], 'JSON');
    assertSemSensiveis(util.inspect(mfa, { depth: null }), [chave], 'inspect do módulo');
  });

  test('obterChaveMfa devolve 32 bytes, cópia defensiva a cada chamada', () => {
    const chave = mfa.obterChaveMfa(1);
    assert.ok(Buffer.isBuffer(chave));
    assert.equal(chave.length, 32);
    assert.equal(chave.toString('hex'), process.env.MFA_TOTP_KEY_V1.toLowerCase());
    chave.fill(0);
    assert.notEqual(mfa.obterChaveMfa(1).toString('hex'), chave.toString('hex'), 'alterar a cópia não altera a chave interna');
  });

  test('versão inexistente ou inválida falha fechado, sem tentar outra versão e sem valor no erro', () => {
    const chave = process.env.MFA_TOTP_KEY_V1;
    for (const versao of [2, 0, -1, 1.5, '1', null, undefined, NaN]) {
      assert.throws(() => mfa.obterChaveMfa(versao), (erro) => {
        assert.ok(erro instanceof mfa.ErroChaveMfaIndisponivel, String(versao));
        assert.equal(erro.codigo, 'MFA_CHAVE_INDISPONIVEL');
        assertSemSensiveis(erro.message, [chave], 'erro');
        return true;
      });
    }
  });
});
