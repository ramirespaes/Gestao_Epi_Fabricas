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
  // VISUAL-03A (20/10/2026): identidade verde aprovada por Ramires em index.html e totem.css. Pinos ANTERIORES (histórico): index.html
  // e41495afa9e0e7f5b1d0b104080180821c42a7c909b5f5d7667ca213cf7ee181; totem.css 9c6b3665fe47ad88543e8f59053b082544816943d5753c41980625f4b379e3ac.
  'index.html': '6ec5236ec6673c581332468b2cb2f7b64df8467f260030b9a47b5387a78bd286',
  'boot.js': '583454fe94c2ed73776fd77b4560eb70c59dd708ad582b2a61ff4878104d6899',
  // GREEN-2A/2C (20/10/2026): fotografias integradas, autorizadas por Ramires. Pino ANTERIOR (histórico): 9ee5d2f8d66e154c067c0f7a35c5214a1341fcd42899f92ac3c16cdf5a60c33e.
  // FIX-TOTEM-NUMERO (31/10/2026): confirmação do pedido com o número inteiro do backend, autorizada por Ramires. Pino ANTERIOR (histórico): c6728858e0d185cb0331c78099d47f9688ea22d7fdcbca4600bd9ba1478b6afc.
  'totem.js': 'caa89895eec5660db5cb9b4ca746c6590b7a15575f38a215d4a2b19c61807fc5',
  'totem.css': '3caa1760e92f1c5feddcb211ab09c082f16db2dc4a0eb182f3f02e609d4ebe50',
});

describe('Totem congelado — os quatro arquivos da interface do tablet não mudam com a Biblioteca de Imagens', () => {
  for (const [arquivo, esperado] of Object.entries(PINOS)) {
    test(`${arquivo} mantém o SHA-256 aprovado`, () => {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(PASTA, arquivo))).digest('hex');
      assert.equal(sha, esperado);
    });
  }

  // GREEN-2C (20/10/2026): substitui a proibição histórica de ler `imagem` (a exibição foi autorizada). Agora o campo só é lido por UMA validação estrita
  // e a fotografia só vem da rota existente de imagens; o catálogo nunca fornece URL.
  test('o renderizador do Totem lê `imagem` só por validação estrita e usa apenas a rota existente de imagens', () => {
    const js = fs.readFileSync(path.join(PASTA, 'totem.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal((js.match(/\.imagem\b/g) || []).length, 1, '`.imagem` é lido em um único ponto (a validação)');
    assert.match(js, /function referenciaDaImagem\(m\) \{\s*var i = m\.imagem;/);
    for (const regra of [/i\.disponivel !== true/, /ORIGENS_IMAGEM, i\.origem/, /\^\[1-9\]\[0-9\]\{0,18\}\$/, /i\.id > ID_IMAGEM_MAXIMO/, /Number\.isInteger\(i\.versao\)/, /i\.versao > 2147483647/]) {
      assert.match(js, regra);
    }
    assert.equal(/\b(i|imagem)\.url\b|\.imagem\.url\b/.test(js), false, 'o catálogo não fornece URL de imagem');
    assert.equal((js.match(/\/atendimento\/imagens\//g) || []).length, 1, 'uma única rota de imagens');
    assert.match(js, /API_BASE \+ TABLET \+ '\/atendimento\/imagens\/'/);
    assert.equal(/https?:\/\//i.test(js.replace(/'http:\/\/www\.w3\.org\/2000\/svg'/g, '')), false, 'nenhuma URL externa');
  });
});
