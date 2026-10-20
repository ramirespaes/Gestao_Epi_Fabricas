'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — PINO do Totem: os quatro arquivos aprovados e congelados da interface do tablet (Etapa I, com o K4)
 * continuam byte a byte iguais. A Unidade 3 só mexe no CONTRATO do catálogo (backend); qualquer alteração futura no renderizador do Totem exige
 * autorização separada, com testes de preservação do visual aprovado (e então este pino é atualizado de propósito, junto da autorização).
 * É um CONTROLE: passa hoje e deve continuar passando durante todo o GREEN da Unidade 3.
 *
 * Referências: totem.js = depois da correção do K4 (K3K4-02, seção 7); boot.js e totem.css = Etapa I (sem alteração nos ciclos K3/K4); index.html = Etapa I mais o
 * favicon e o título do refinamento visual de 18/10/2026 (duas linhas do <head>, sem mudança de comportamento; pino atualizado na consolidação de 19/10/2026).
 */

const PASTA = path.join(__dirname, '..', '..', '..', 'frontend', 'totem');
const PINOS = Object.freeze({
  'index.html': 'e41495afa9e0e7f5b1d0b104080180821c42a7c909b5f5d7667ca213cf7ee181',
  'boot.js': '583454fe94c2ed73776fd77b4560eb70c59dd708ad582b2a61ff4878104d6899',
  'totem.js': '9ee5d2f8d66e154c067c0f7a35c5214a1341fcd42899f92ac3c16cdf5a60c33e',
  'totem.css': '9c6b3665fe47ad88543e8f59053b082544816943d5753c41980625f4b379e3ac',
});

describe('Totem congelado — os quatro arquivos da interface do tablet não mudam com a Biblioteca de Imagens', () => {
  for (const [arquivo, esperado] of Object.entries(PINOS)) {
    test(`${arquivo} mantém o SHA-256 aprovado`, () => {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(PASTA, arquivo))).digest('hex');
      assert.equal(sha, esperado);
    });
  }

  test('o renderizador do Totem ainda não consome o campo de imagem do catálogo (a exibição é decisão futura, com autorização própria)', () => {
    const js = fs.readFileSync(path.join(PASTA, 'totem.js'), 'utf8');
    assert.equal(/\.imagem\b/.test(js), false, 'totem.js não deve ler `imagem` nesta unidade');
  });
});
