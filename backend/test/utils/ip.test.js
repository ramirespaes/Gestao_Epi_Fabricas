'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const ip = require('../../src/utils/ip');

/**
 * Endereço remoto canônico para a restrição por IP (077): IPv4 como veio,
 * IPv6 na forma comprimida minúscula, IPv4 mapeado em IPv6 (::ffff:a.b.c.d,
 * como o Node entrega em sockets dual-stack) reduzido ao IPv4. Qualquer
 * outra coisa é null: nunca uma string "quase IP" chega à consulta.
 */

describe('normalizarIp', () => {
  test('IPv4 válido como veio; IPv6 canônico (comprimido, minúsculo); mapeado vira IPv4', () => {
    assert.equal(ip.normalizarIp('203.0.113.10'), '203.0.113.10');
    assert.equal(ip.normalizarIp(' 203.0.113.10 '), '203.0.113.10');
    assert.equal(ip.normalizarIp('2001:0DB8:0000:0000:0000:0000:0000:0010'), '2001:db8::10');
    assert.equal(ip.normalizarIp('2001:db8::10'), '2001:db8::10');
    assert.equal(ip.normalizarIp('::1'), '::1');
    assert.equal(ip.normalizarIp('::ffff:203.0.113.10'), '203.0.113.10');
    assert.equal(ip.normalizarIp('::FFFF:127.0.0.1'), '127.0.0.1');
  });

  test('inválidos viram null: vazio, faixa, porta, texto, octeto fora de 0–255, zona de interface, objetos', () => {
    for (const ruim of ['', '   ', '203.0.113.0/24', '203.0.113.10:8080', 'localhost', '256.1.1.1', '1.2.3', 'fe80::1%eth0', '2001:db8::zz', null, undefined, 42, {}, ['203.0.113.10']]) {
      assert.equal(ip.normalizarIp(ruim), null, String(ruim));
    }
  });

  test('ipDaRequisicao lê req.ip (já resolvido pelo Express sob TRUST_PROXY_HOPS) e normaliza; sem req.ip, null', () => {
    assert.equal(ip.ipDaRequisicao({ ip: '::ffff:203.0.113.10' }), '203.0.113.10');
    assert.equal(ip.ipDaRequisicao({ ip: '2001:DB8::1' }), '2001:db8::1');
    assert.equal(ip.ipDaRequisicao({}), null);
    assert.equal(ip.ipDaRequisicao(null), null);
  });
});
