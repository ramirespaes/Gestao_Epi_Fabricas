'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertSemSensiveis } = require('./helpers/sensiveis');

/**
 * Com o cadastro do TOTP, o app passa a cifrar secrets: a configuração das
 * chaves MFA é obrigatória na subida, como o segredo do cooldown. Sem ela,
 * ou com ela malformada, o processo não sobe, e o erro cita só o NOME da
 * variável. Processo filho isolado, sem .env: o ambiente é só o daqui.
 */

const RAIZ = path.join(__dirname, '..');
const CHAVE = crypto.randomBytes(32).toString('hex');

function subirApp(extra) {
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    LOGIN_COOLDOWN_HMAC_SECRET: process.env.LOGIN_COOLDOWN_HMAC_SECRET,
    ...extra,
  };
  return spawnSync(process.execPath, ['-e', "require('./src/app'); process.exit(0)"], { cwd: RAIZ, env, encoding: 'utf8', timeout: 20000 });
}

describe('subida do app e configuração MFA', () => {
  test('sem nenhuma chave MFA o app não sobe e o erro nomeia as variáveis', () => {
    const r = subirApp({});
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /MFA_TOTP_KEY_CURRENT_VERSION/);
  });

  test('com chave malformada o app não sobe e o valor não aparece', () => {
    const valorRuim = 'nao-hex-'.repeat(8);
    const r = subirApp({ MFA_TOTP_KEY_CURRENT_VERSION: '1', MFA_TOTP_KEY_V1: valorRuim });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /MFA_TOTP_KEY_V1/);
    assertSemSensiveis(r.stderr + r.stdout, [valorRuim], 'saída do processo');
  });

  test('com a configuração válida o app sobe', () => {
    const r = subirApp({ MFA_TOTP_KEY_CURRENT_VERSION: '1', MFA_TOTP_KEY_V1: CHAVE });
    assert.equal(r.status, 0, r.stderr);
    assertSemSensiveis(r.stderr + r.stdout, [CHAVE], 'saída do processo');
  });
});
