'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { VARIAVEL, enderecoDeEscuta, escutar } = require('../../src/config/bind');

/** G-B (D-ORF-6): BIND_ADDRESS opcional, IP literal, sem eco de valor, comportamento anterior preservado quando ausente. */

describe('[BIND] validação de BIND_ADDRESS', () => {
  test('BIND-01 — ausente, nula ou vazia: undefined (todas as interfaces, como antes)', () => {
    assert.equal(VARIAVEL, 'BIND_ADDRESS');
    assert.equal(enderecoDeEscuta({}), undefined);
    assert.equal(enderecoDeEscuta({ BIND_ADDRESS: undefined }), undefined);
    assert.equal(enderecoDeEscuta({ BIND_ADDRESS: null }), undefined);
    assert.equal(enderecoDeEscuta({ BIND_ADDRESS: '' }), undefined);
  });

  test('BIND-02 — IPv4 e IPv6 literais válidos são devolvidos sem alteração', () => {
    for (const valido of ['127.0.0.1', '0.0.0.0', '10.0.0.5', '192.168.1.20', '::1', '::', '2001:db8::1', 'fe80::1', '::ffff:127.0.0.1']) {
      assert.equal(enderecoDeEscuta({ BIND_ADDRESS: valido }), valido, valido);
    }
  });

  test('BIND-03 — entradas inválidas são recusadas com BIND_ADDRESS_INVALIDO e a mensagem nunca ecoa o valor', () => {
    const invalidos = [
      'localhost', 'example.com', '127.0.0.1:3000', '[::1]', '[::1]:3000', '::1%lo', 'fe80::1%eth0', '999.1.1.1', '127.1', '0x7f.0.0.1', '2130706433',
      ' 127.0.0.1', '127.0.0.1 ', '127.0.0.1\n', 'http://127.0.0.1', '127.0.0.1;ls', '   ', '*', 'all', '1.2.3', '::g',
    ];
    for (const invalido of invalidos) {
      assert.throws(() => enderecoDeEscuta({ BIND_ADDRESS: invalido }), (erro) => {
        assert.equal(erro instanceof TypeError, true, JSON.stringify(invalido));
        assert.equal(erro.code, 'BIND_ADDRESS_INVALIDO', JSON.stringify(invalido));
        assert.equal(erro.message.includes(invalido.trim() === '' ? '\u0000' : invalido.trim()), false, `eco do valor ${JSON.stringify(invalido)}`);
        return true;
      }, JSON.stringify(invalido));
    }
  });

  test('BIND-04 — tipos que não são texto são recusados; origem inválida é erro de programação', () => {
    for (const valor of [127, true, {}, [], ['127.0.0.1']]) {
      assert.throws(() => enderecoDeEscuta({ BIND_ADDRESS: valor }), (erro) => erro.code === 'BIND_ADDRESS_INVALIDO');
    }
    for (const origem of [null, undefined, 'x', 1]) assert.throws(() => enderecoDeEscuta(origem), /origem inválida/);
  });

  test('BIND-05 — escutar: sem endereço chama listen(porta, callback); com endereço, listen(porta, endereco, callback)', () => {
    const chamadas = [];
    const app = { listen: (...args) => { chamadas.push(args); return 'servidor'; } };
    const aoOuvir = () => {};
    assert.equal(escutar(app, 3000, undefined, aoOuvir), 'servidor');
    assert.equal(escutar(app, 3000, '127.0.0.1', aoOuvir), 'servidor');
    assert.deepEqual(chamadas[0], [3000, aoOuvir]);
    assert.deepEqual(chamadas[1], [3000, '127.0.0.1', aoOuvir]);
  });
});
