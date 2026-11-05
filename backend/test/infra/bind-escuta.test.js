'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const express = require('express');
const { enderecoDeEscuta, escutar } = require('../../src/config/bind');

/**
 * G-B (D-ORF-6): prova DINÂMICA da escuta. Cada servidor usa porta efêmera (0) e fecha ao fim; nenhuma porta fixa é tocada.
 * O teste que depende de uma interface não-loopback ou de IPv6 é pulado quando o ambiente não as tem.
 */

const abertos = [];
after(async () => { await Promise.all(abertos.map((s) => new Promise((resolver) => s.close(resolver)))); });

function iniciar(endereco) {
  return new Promise((resolver, rejeitar) => {
    const servidor = escutar(express(), 0, endereco);
    abertos.push(servidor);
    servidor.once('error', rejeitar);
    if (servidor.listening) return resolver(servidor);
    servidor.once('listening', () => resolver(servidor));
    return undefined;
  });
}

/** 'ABERTA' | 'RECUSADA' | 'SEM_RESPOSTA' | código do erro. Só conecta, não envia nada. */
function conectar(host, porta) {
  return new Promise((resolver) => {
    const soquete = net.connect({ host, port: porta });
    const encerrar = (resultado) => { soquete.destroy(); resolver(resultado); };
    soquete.setTimeout(2000, () => encerrar('SEM_RESPOSTA'));
    soquete.once('connect', () => encerrar('ABERTA'));
    soquete.once('error', (erro) => encerrar(erro.code === 'ECONNREFUSED' ? 'RECUSADA' : erro.code));
  });
}

function ipv4ExternoDoHospedeiro() {
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const i of lista ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

describe('[BIND-DIN] escuta real com BIND_ADDRESS', () => {
  test('BIND-10 — 127.0.0.1: o endereço efetivo é 127.0.0.1/IPv4, o loopback conecta e uma interface não-loopback é recusada', async (t) => {
    const servidor = await iniciar(enderecoDeEscuta({ BIND_ADDRESS: '127.0.0.1' }));
    const { address, family, port } = servidor.address();
    assert.equal(address, '127.0.0.1');
    assert.equal(family, 'IPv4');
    assert.equal(await conectar('127.0.0.1', port), 'ABERTA');
    const externo = ipv4ExternoDoHospedeiro();
    if (externo === null) { t.diagnostic('sem interface IPv4 não-loopback: parte "recusada" pulada'); return; }
    assert.equal(await conectar(externo, port), 'RECUSADA', `a porta ${port} não pode atender ${externo}`);
  });

  test('BIND-11 — ::1: escuta só em IPv6 loopback; o IPv4 do loopback não alcança a porta', async (t) => {
    let servidor;
    try { servidor = await iniciar('::1'); } catch (erro) {
      if (erro.code === 'EADDRNOTAVAIL' || erro.code === 'EAFNOSUPPORT') { t.skip('sem IPv6 loopback neste ambiente'); return; }
      throw erro;
    }
    const { address, family, port } = servidor.address();
    assert.equal(address, '::1');
    assert.equal(family, 'IPv6');
    assert.equal(await conectar('::1', port), 'ABERTA');
    assert.equal(await conectar('127.0.0.1', port), 'RECUSADA');
  });

  test('BIND-12 — sem BIND_ADDRESS: comportamento anterior, todas as interfaces (:: em dual-stack ou 0.0.0.0)', async () => {
    const servidor = await iniciar(enderecoDeEscuta({}));
    const { address, port } = servidor.address();
    assert.ok(['::', '0.0.0.0'].includes(address), `endereço efetivo ${address}`);
    assert.equal(await conectar('127.0.0.1', port), 'ABERTA');
  });

  test('BIND-13 — valor inválido nunca chega a abrir porta: a validação falha antes de escutar', () => {
    assert.throws(() => enderecoDeEscuta({ BIND_ADDRESS: 'localhost' }), (erro) => erro.code === 'BIND_ADDRESS_INVALIDO');
  });
});
