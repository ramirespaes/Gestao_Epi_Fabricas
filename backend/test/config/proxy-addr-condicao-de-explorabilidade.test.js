'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { carregarConfigHttp } = require('../../src/config/http');

/**
 * Alerta CRÍTICO do npm audit (GHSA do `proxy-addr` <= 2.0.7): falsificação de IP quando `trust proxy` é configurado com SUB-REDE/lista e o endereço chega como IPv4 mapeado em IPv6.
 * Tratamento local, sem atualizar dependência (a atualização é do gate de dependências): a condição de explorabilidade NÃO PODE existir. O SafeWork só aceita `trust proxy` = false ou um
 * número inteiro de saltos (0 a 10), nunca endereço, sub-rede, lista ou nome. Se alguém tentar abrir isso, estes testes quebram. Quando o `proxy-addr` instalado for >= 2.0.8, a
 * superfície fechada deixa de ser a única defesa, mas o teste continua valendo como regra de configuração.
 */

const RAIZ = path.join(__dirname, '..', '..');
const semComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
const percorrer = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? percorrer(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
const erroDe = (env) => { try { carregarConfigHttp(env); } catch (e) { return String(e.message); } return null; };

describe('[PROXY-ADDR] a configuração não aceita sub-rede, lista, endereço nem nome', () => {
  test('TPX-01 — TRUST_PROXY_HOPS só aceita inteiro de 0 a 10: CIDR, IPv4, IPv6, IPv4 mapeado, lista, "loopback", "true" e números fora da faixa são recusados', () => {
    for (const ruim of ['10.0.0.0/8', '192.168.0.0/16', '127.0.0.1', '::1', '::ffff:10.0.0.1', '::ffff:10.0.0.0/104', '10.0.0.1,10.0.0.2', 'loopback', 'linklocal', 'uniquelocal', 'true', 'false', '1,2', '0x1', '1e1', '-1', '11', '1.5']) {
      assert.notEqual(erroDe({ TRUST_PROXY_HOPS: ruim }), null, JSON.stringify(ruim));
    }
    for (const bom of ['0', '1', '2', '10']) assert.equal(carregarConfigHttp({ TRUST_PROXY_HOPS: bom }).proxy.hops, Number(bom));
    assert.equal(carregarConfigHttp({}).proxy.hops, 0);
  });

  test('TPX-02 — no código de produção há UMA configuração de `trust proxy` (em app.js) e o valor é false ou o número de saltos validado; nenhum outro arquivo a altera', () => {
    const achados = percorrer(path.join(RAIZ, 'src')).flatMap((arquivo) => (semComentarios(fs.readFileSync(arquivo, 'utf8')).match(/\.(?:set|enable|disable)\(\s*['"]trust proxy['"][^;\n]*/g) ?? []).map((t) => [path.relative(RAIZ, arquivo), t.replace(/\s+/g, ' ')]));
    assert.deepEqual(achados, [['src/app.js', ".set('trust proxy', httpConfig.proxy.hops === 0 ? false : httpConfig.proxy.hops)"]]);
  });

  test('TPX-03 — nenhum código de produção lê X-Forwarded-For ou req.ips por conta própria: a origem de rede é só o req.ip que o Express resolveu sob a configuração acima', () => {
    for (const arquivo of percorrer(path.join(RAIZ, 'src'))) {
      const fonte = semComentarios(fs.readFileSync(arquivo, 'utf8'));
      assert.equal(/x-forwarded-for|x-real-ip|\breq\.ips\b|['"]forwarded['"]/i.test(fonte), false, path.relative(RAIZ, arquivo));
    }
  });

  test('TPX-04 — a versão instalada do proxy-addr é conhecida: vulnerável (<= 2.0.7) só é aceitável porque a superfície está fechada; corrigida (>= 2.0.8) também passa; qualquer outra coisa, não', () => {
    const versao = require('proxy-addr/package.json').version.split('.').map(Number);
    const corrigida = versao[0] > 2 || (versao[0] === 2 && (versao[1] > 0 || versao[2] >= 8));
    const vulneravel = versao[0] === 2 && versao[1] === 0 && versao[2] <= 7;
    assert.ok(corrigida || vulneravel, `versão inesperada: ${versao.join('.')}`);
    const express = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).dependencies.express;
    assert.match(express, /^\d+\.\d+\.\d+$|^[\^~]\d+\.\d+\.\d+$/);
  });
});
