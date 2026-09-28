'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const codigos = require('../../src/security/codigos-mfa');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Referência independente: 10 bytes -> 80 bits -> 16 símbolos de 5 bits.
function crockfordReferencia(bytes) {
  const bits = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
  let saida = '';
  for (let i = 0; i < 80; i += 5) saida += CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  return saida;
}
const agrupar = (s) => s.match(/.{4}/g).join('-');
const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

describe('gerarCodigo', () => {
  test('usa randomBytes(10) e codifica os 80 bits em 16 símbolos Crockford, no formato XXXX-XXXX-XXXX-XXXX', (t) => {
    const bytes = Buffer.from('a37f0c9e5512d4ee0b61', 'hex');
    const chamadas = [];
    t.mock.method(crypto, 'randomBytes', (n) => { chamadas.push(n); return Buffer.from(bytes); });
    const codigo = codigos.gerarCodigo();
    assert.deepEqual(chamadas, [10]);
    assert.equal(codigo, agrupar(crockfordReferencia(bytes)));
    assert.match(codigo, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  });

  test('extremos: todos os bits 0 e todos os bits 1', (t) => {
    // Um único mock: mockar duas vezes o mesmo método vaza para o teste seguinte.
    const fila = [Buffer.alloc(10, 0x00), Buffer.alloc(10, 0xff)];
    t.mock.method(crypto, 'randomBytes', () => fila.shift());
    assert.equal(codigos.gerarCodigo(), '0000-0000-0000-0000');
    assert.equal(codigos.gerarCodigo(), 'ZZZZ-ZZZZ-ZZZZ-ZZZZ');
  });

  test('nunca gera caracteres ambíguos (I, L, O, U) e não repete em amostra grande', () => {
    const vistos = new Set();
    for (let i = 0; i < 3000; i += 1) {
      const c = codigos.gerarCodigo();
      assert.equal(/[ILOU]/.test(c), false, c);
      vistos.add(c);
    }
    assert.equal(vistos.size, 3000);
  });
});

describe('normalizarCodigo', () => {
  test('aceita minúsculas, hífens e espaços e devolve os 16 símbolos canônicos', () => {
    const canonico = '7ZQ3K9M2W4X8H6TD';
    for (const entrada of ['7ZQ3-K9M2-W4X8-H6TD', '7zq3-k9m2-w4x8-h6td', ' 7ZQ3 K9M2 W4X8 H6TD ', '7ZQ3K9M2W4X8H6TD', '7ZQ3-K9M2 W4X8-h6td']) {
      assert.equal(codigos.normalizarCodigo(entrada), canonico, entrada);
    }
  });

  test('aliases de Crockford: O vira 0; I e L viram 1 (a entropia não muda: eles nunca são gerados)', () => {
    assert.equal(codigos.normalizarCodigo('O0II-LL11-AAAA-BBBB'), '00111111AAAABBBB');
    assert.equal(codigos.normalizarCodigo('oiLl-0000-0000-0000'), '0111000000000000');
  });

  test('formato inválido é null: tamanho errado, U, símbolos, controle ou entrada que não é texto', () => {
    for (const entrada of ['7ZQ3-K9M2-W4X8-H6T', '7ZQ3-K9M2-W4X8-H6TDD', '7ZQ3-K9M2-W4X8-H6TU', '7ZQ3_K9M2_W4X8_H6TD', '7ZQ3-K9M2-W4X8-H6T*', '7ZQ3-K9M2-W4X8\u0000H6TD', '', null, undefined, 1234, 'A'.repeat(200)]) {
      assert.equal(codigos.normalizarCodigo(entrada), null, JSON.stringify(entrada));
    }
  });
});

describe('hash contextualizado', () => {
  const codigo = '7ZQ3K9M2W4X8H6TD';

  test('SHA-256 de "safework|mfa|<dominio>|f1|a<admin>|<codigo>", em hexadecimal minúsculo', () => {
    assert.equal(codigos.hashCodigo({ dominio: 'recuperacao', administradorId: 42, codigo }), sha256(`safework|mfa|recuperacao|f1|a42|${codigo}`));
    assert.equal(codigos.hashCodigo({ dominio: 'liberacao', administradorId: 42, codigo }), sha256(`safework|mfa|liberacao|f1|a42|${codigo}`));
  });

  test('administrador diferente, domínio diferente: hashes diferentes', () => {
    const r42 = codigos.hashCodigo({ dominio: 'recuperacao', administradorId: 42, codigo });
    assert.notEqual(codigos.hashCodigo({ dominio: 'recuperacao', administradorId: 43, codigo }), r42);
    assert.notEqual(codigos.hashCodigo({ dominio: 'liberacao', administradorId: 42, codigo }), r42);
  });

  test('o mesmo texto usado como recovery e como liberação nunca coincide', () => {
    const gerado = codigos.gerarCodigo();
    const normalizado = codigos.normalizarCodigo(gerado);
    const rec = codigos.hashCodigo({ dominio: 'recuperacao', administradorId: 7, codigo: normalizado });
    const lib = codigos.hashCodigo({ dominio: 'liberacao', administradorId: 7, codigo: normalizado });
    assert.match(rec, /^[0-9a-f]{64}$/);
    assert.match(lib, /^[0-9a-f]{64}$/);
    assert.notEqual(rec, lib);
  });

  test('só aceita código canônico, domínio conhecido e administrador positivo; o erro nunca leva o código', () => {
    const canonico = '7ZQ3K9M2W4X8H6TD';
    for (const [dados, valores] of [
      [{ dominio: 'recuperacao', administradorId: 42, codigo: '7ZQ3-K9M2-W4X8-H6TD' }, ['7ZQ3-K9M2-W4X8-H6TD']],
      [{ dominio: 'recuperacao', administradorId: 42, codigo: '7zq3k9m2w4x8h6td' }, ['7zq3k9m2w4x8h6td']],
      [{ dominio: 'outro', administradorId: 42, codigo: canonico }, [canonico]],
      [{ dominio: 'recuperacao', administradorId: 0, codigo: canonico }, [canonico]],
      [{ dominio: 'recuperacao', administradorId: '42', codigo: canonico }, [canonico]],
    ]) {
      assert.throws(() => codigos.hashCodigo(dados), (erro) => {
        assert.ok(erro instanceof TypeError);
        assertSemSensiveis(erro.message, valores, 'erro');
        return true;
      }, JSON.stringify(dados));
    }
  });

  test('atalhos por domínio: recuperação e liberação', () => {
    assert.equal(codigos.hashCodigoRecuperacao({ administradorId: 42, codigo }), codigos.hashCodigo({ dominio: 'recuperacao', administradorId: 42, codigo }));
    assert.equal(codigos.hashCodigoLiberacao({ administradorId: 42, codigo }), codigos.hashCodigo({ dominio: 'liberacao', administradorId: 42, codigo }));
  });
});
