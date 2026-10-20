'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { lerConfiguracao } = require('../../src/config/imagens');

/**
 * Biblioteca de Imagens, Unidade 5C-4 — a seção `processamento` da configuração (src/config/imagens.js): os valores APROVADOS de mestre, tetos, fila, espera e tempo. São fixos:
 * variável de ambiente nenhuma os altera (a regra do arquivo é que só cotas, taxas e o semáforo de simultâneos são ajustáveis). Os campos antigos não mudam.
 */

const MIB = 1024 * 1024;

describe('config/imagens — processamento (D-C5 e D-C6)', () => {
  test('CFP-01 — mestre PNG 1024 (4 MiB), exibição 512 KiB, fila de 8 com espera de 10 s, Retry-After 5 e 10, tempo interno de 10 s e externo de 15 s; tudo congelado', () => {
    const p = lerConfiguracao({}).processamento;
    assert.deepEqual({ ...p.mestre }, { lado: 1024, formato: 'png', bytesMax: 4 * MIB });
    assert.equal(p.exibicaoBytesMax, 512 * 1024);
    assert.deepEqual({ ...p.fila }, { maxima: 8, esperaMaximaMs: 10000, retryAfterFilaCheiaSegundos: 5, retryAfterEsperaSegundos: 10 });
    assert.deepEqual({ ...p.tempo }, { internoSegundos: 10, externoMs: 15000 });
    for (const objeto of [p, p.mestre, p.fila, p.tempo]) assert.equal(Object.isFrozen(objeto), true);
    assert.deepEqual(Object.keys(p).sort(), ['exibicaoBytesMax', 'fila', 'mestre', 'tempo']);
  });

  test('CFP-02 — dois simultâneos continua sendo o padrão (ajustável por IMAGENS_PROCESSAMENTOS_SIMULTANEOS, como antes) e os campos antigos não mudaram', () => {
    const c = lerConfiguracao({});
    assert.equal(c.processamentosSimultaneos, 2);
    assert.equal(lerConfiguracao({ IMAGENS_PROCESSAMENTOS_SIMULTANEOS: '4' }).processamentosSimultaneos, 4);
    assert.deepEqual({ ...c.miniatura }, { lado: 320, formato: 'webp', bytesMax: 65536 });
    assert.deepEqual({ ...c.exibicao }, { lado: 640, formato: 'webp' });
    assert.equal(c.ampliar, false);
    assert.deepEqual([c.arquivoMaxBytes, c.ladoMin, c.ladoMax, c.pixelsMax], [2 * MIB, 320, 4096, 8388608]);
  });

  test('CFP-03 — variáveis de ambiente NÃO alteram o processamento: nem as que parecem óbvias, nem as de fila, espera, tempo, mestre ou tetos', () => {
    const base = lerConfiguracao({}).processamento;
    const origem = {
      IMAGENS_FILA_MAXIMA: '99', IMAGENS_ESPERA_MAXIMA_MS: '99999', IMAGENS_TEMPO_INTERNO_SEGUNDOS: '99', IMAGENS_TEMPO_EXTERNO_MS: '99999', IMAGENS_MESTRE_LADO: '2048',
      IMAGENS_MESTRE_BYTES: '9999999', IMAGENS_EXIBICAO_BYTES: '9999999', IMAGENS_PROCESSAMENTO_FILA_MAXIMA: '99', IMAGENS_PROCESSAMENTO_TEMPO: '99', UV_THREADPOOL_SIZE: '64',
    };
    const lida = lerConfiguracao(origem).processamento;
    assert.deepEqual(JSON.parse(JSON.stringify(lida)), JSON.parse(JSON.stringify(base)));
  });

  test('CFP-04 — a configuração continua pura: a mesma origem dá o mesmo resultado e a origem não é alterada', () => {
    const origem = Object.freeze({ IMAGENS_COTA_IMAGENS: '50' });
    assert.deepEqual(JSON.parse(JSON.stringify(lerConfiguracao(origem))), JSON.parse(JSON.stringify(lerConfiguracao({ ...origem }))));
    assert.deepEqual({ ...origem }, { IMAGENS_COTA_IMAGENS: '50' });
  });
});
