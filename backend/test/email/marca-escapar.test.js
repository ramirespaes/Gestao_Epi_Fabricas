'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Peças pequenas do e-mail transacional (Bloco 11H): escape de HTML, limpeza
 * de texto vindo do usuário e a marca (logo) controlada pela aplicação.
 */

const escapar = () => exigirModulo('src/email/escapar');
const marca = () => exigirModulo('src/email/marca');

describe('escaparHtml', () => {
  test('neutraliza os cinco caracteres que abrem tag ou atributo', () => {
    assert.equal(escapar().escaparHtml(`<img src="x" onerror='a&b'>`), '&lt;img src=&quot;x&quot; onerror=&#39;a&amp;b&#39;&gt;');
  });

  test('só aceita texto: qualquer outro tipo é erro de programação', () => {
    for (const ruim of [undefined, null, 42, {}, ['a']]) {
      assert.throws(() => escapar().escaparHtml(ruim), TypeError, String(ruim));
    }
  });
});

describe('textoSimples', () => {
  test('troca quebras de linha e caracteres de controle por espaço e apara as pontas', () => {
    assert.equal(escapar().textoSimples('  Ana\r\nBcc: x@y.test\tSilva\u0000‮  '), 'Ana Bcc: x@y.test Silva');
  });

  test('limita o tamanho e só aceita texto', () => {
    assert.equal(escapar().textoSimples('a'.repeat(300), 10), 'aaaaaaaaaa');
    assert.throws(() => escapar().textoSimples(null), TypeError);
  });
});

describe('marca do e-mail', () => {
  test('é um PNG pequeno e quadrado, carregado do arquivo controlado pela aplicação e entregue como Buffer', () => {
    const { cid, filename, contentType, content } = marca().marca();
    assert.equal(cid, 'marca-safework');
    assert.equal(filename, 'marca-safework.png');
    assert.equal(contentType, 'image/png');
    assert.equal(Buffer.isBuffer(content), true);
    assert.equal(content.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(content.readUInt32BE(16), 96);
    assert.equal(content.readUInt32BE(20), 96);
    assert.ok(content.length < 8 * 1024, `PNG de ${content.length} bytes`);
  });

  test('o objeto devolvido é congelado: ninguém troca o conteúdo da marca por caminho ou URL', () => {
    const m = marca().marca();
    assert.equal(Object.isFrozen(m), true);
    assert.deepEqual(Object.keys(m).sort(), ['cid', 'content', 'contentType', 'filename']);
    assert.equal(marca().CID_MARCA, 'marca-safework');
  });
});
