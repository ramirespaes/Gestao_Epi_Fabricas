'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Reaproveitamento e separação dos dois services da troca de senha (Bloco
 * 11E). Eles não trazem criptografia, verificação de TOTP nem cifrador do MFA
 * próprios: a chave de cooldown e a trava vêm do módulo que o login usa e o
 * código do autenticador só é verificado pelo caminho que a reautenticação do
 * MFA já tem. E cada um fica no seu domínio: o do Portal não toca nada do
 * Painel Privado e o do Painel não toca nada do Portal.
 */

const RAIZ = path.join(__dirname, '..', '..');
const GLOBAL = 'src/services/troca-senha-global.service.js';
const PLATAFORMA = 'src/services/troca-senha-plataforma.service.js';

/** Código do módulo sem comentários; se o módulo não existe, o teste diz isso. */
function fonteDe(rel) {
  const arquivo = path.join(RAIZ, rel);
  if (!fs.existsSync(arquivo)) assert.fail(`módulo ainda não implementado: ${rel}`);
  return fs.readFileSync(arquivo, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('troca de senha — reaproveitamento da infraestrutura existente', () => {
  for (const rel of [GLOBAL, PLATAFORMA]) {
    test(`${rel}: sem primitivas de criptografia, sem verificador de TOTP e sem cifrador do MFA próprios`, () => {
      const fonte = fonteDe(rel);
      assert.doesNotMatch(fonte, /require\(\s*['"](?:node:)?crypto['"]\s*\)/, 'importa o crypto do Node');
      assert.doesNotMatch(fonte, /\b(createHmac|createHash|randomBytes|randomUUID|timingSafeEqual|pbkdf2|scrypt)\b/, 'usa primitiva criptográfica direta');
      assert.doesNotMatch(fonte, /require\(\s*['"]argon2['"]\s*\)/, 'importa o argon2 direto: a senha passa por security/password');
      assert.doesNotMatch(fonte, /security\/(?:totp|mfa-cripto|codigos-mfa)['"]/, 'importa o TOTP ou o cifrador do MFA: o código só é verificado pelo caminho existente da reautenticação');
    });
  }
});

describe('troca de senha — cada service fica no seu domínio', () => {
  test('o do Portal não importa nada do Painel Privado', () => {
    assert.doesNotMatch(
      fonteDe(GLOBAL),
      /(?:administrador-plataforma|sessao-plataforma|fator-mfa|desafio-mfa|lote-recuperacao-mfa|codigo-recuperacao-mfa|trava-mfa|etapa-mfa|auditoria-plataforma|login-plataforma)/,
    );
  });

  test('o do Painel Privado não importa nada do Portal nem das sessões de empresa', () => {
    assert.doesNotMatch(
      fonteDe(PLATAFORMA),
      /(?:identidade\.repository|sessao-global|sessao\.repository|auditoria-identidade|contexto-empresarial|login-global|usuario\.repository)/,
    );
  });
});
