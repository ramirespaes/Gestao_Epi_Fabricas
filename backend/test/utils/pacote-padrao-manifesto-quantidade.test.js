'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/pacote-padrao-ficticio');
const { lerManifesto, QUANTIDADE_DE_IMAGENS } = require('../../src/utils/pacote-padrao-manifesto');
const { ErroImportacaoPadrao } = require('../../src/utils/pacote-padrao-erros');

// 31ª imagem padrão: o pacote das 30 continua o padrão; `quantidadeEsperada` (inteiro de 1 a 30) aceita um pacote menor.

const pacote = h.montarPacote();
const extra = h.recomporItem('Item Extra', { original: h.originalFicticio('extra'), padronizado: h.pngFicticio({ semente: 'extra' }), miniatura: h.webpFicticio({ semente: 'extra' }) });
const csv = (itens) => Buffer.from(h.manifestoCsv(itens), 'utf8');

function falha(fn) {
  try { fn(); } catch (erro) { return erro; }
  return assert.fail('deveria ter sido recusado');
}
const recusaCom = (fn, codigo) => {
  const erro = falha(fn);
  assert.ok(erro instanceof ErroImportacaoPadrao, String(erro));
  assert.equal(erro.codigo, codigo, `${erro.codigo}: ${erro.message}`);
  return erro;
};
const quantidadeDiferente = (esperado, calculado) => [{ campo: 'linhas', motivo: 'QUANTIDADE_DIFERENTE', esperado, calculado }];

describe('[QTD-MAN] lerManifesto: quantidade esperada de imagens', () => {
  test('QTD-MAN-01 — o padrão continua 30: 30 linhas passam; 29 e 31 são QUANTIDADE_DIFERENTE com esperado 30', () => {
    assert.equal(QUANTIDADE_DE_IMAGENS, 30);
    assert.equal(lerManifesto(csv(pacote.itens)).itens.length, 30);
    assert.deepEqual(recusaCom(() => lerManifesto(csv(pacote.itens.slice(0, 29))), 'PACOTE_MANIFESTO_INVALIDO').detalhes, quantidadeDiferente(30, 29));
    assert.deepEqual(recusaCom(() => lerManifesto(csv([...pacote.itens, extra])), 'PACOTE_MANIFESTO_INVALIDO').detalhes, quantidadeDiferente(30, 31));
  });

  test('QTD-MAN-02 — com quantidadeEsperada 1, um manifesto de uma linha é lido com todos os campos', () => {
    const i = pacote.itens[3];
    const { itens } = lerManifesto(csv([i]), { quantidadeEsperada: 1 });
    assert.deepEqual(itens, [{
      nome: `${i.nome}.png`, base: i.nome, sha256Original: i.sha256Original, sha256Padronizado: i.sha256Padronizado, sha256Miniatura: i.sha256Miniatura,
      bytesOriginal: i.bytesOriginal, bytesPadronizado: i.bytesPadronizado, bytesMiniatura: i.bytesMiniatura,
    }]);
  });

  test('QTD-MAN-03 — sem o parâmetro, um manifesto de uma linha continua recusado (padrão 30)', () => {
    assert.deepEqual(recusaCom(() => lerManifesto(csv([pacote.itens[0]])), 'PACOTE_MANIFESTO_INVALIDO').detalhes, quantidadeDiferente(30, 1));
    assert.deepEqual(recusaCom(() => lerManifesto(csv([pacote.itens[0]]), {}), 'PACOTE_MANIFESTO_INVALIDO').detalhes, quantidadeDiferente(30, 1));
  });

  test('QTD-MAN-04 — a quantidade declarada vale nos dois sentidos: a mais e a menos são recusadas; 30 explícito é o padrão', () => {
    assert.deepEqual(recusaCom(() => lerManifesto(csv(pacote.itens.slice(0, 2)), { quantidadeEsperada: 1 }), 'PACOTE_MANIFESTO_INVALIDO').detalhes, quantidadeDiferente(1, 2));
    assert.deepEqual(recusaCom(() => lerManifesto(csv(pacote.itens), { quantidadeEsperada: 29 }), 'PACOTE_MANIFESTO_INVALIDO').detalhes, quantidadeDiferente(29, 30));
    assert.equal(lerManifesto(csv(pacote.itens.slice(0, 3)), { quantidadeEsperada: 3 }).itens.length, 3);
    assert.equal(lerManifesto(csv(pacote.itens), { quantidadeEsperada: 30 }).itens.length, 30);
  });

  test('QTD-MAN-05 — valores inválidos de quantidadeEsperada e opções desconhecidas são PACOTE_ARGUMENTOS_INVALIDOS', () => {
    const bytes = csv([pacote.itens[0]]);
    for (const valor of [0, 31, 100, -1, 1.5, '1', null, Number.NaN, Infinity, true, 2 ** 53, {}, [1]]) {
      recusaCom(() => lerManifesto(bytes, { quantidadeEsperada: valor }), 'PACOTE_ARGUMENTOS_INVALIDOS');
    }
    for (const opcoes of [{ quantidade: 1 }, { quantidadeEsperada: 1, outra: 1 }, null, '1', [], 1]) {
      recusaCom(() => lerManifesto(bytes, opcoes), 'PACOTE_ARGUMENTOS_INVALIDOS');
    }
  });

  test('QTD-MAN-06 — com quantidadeEsperada 1 as demais regras do manifesto continuam valendo (cabeçalho, hash, tamanho, nome)', () => {
    const i = pacote.itens[0];
    const unico = { manifesto: h.manifestoCsv([i]) };
    const opcoes = { quantidadeEsperada: 1 };
    const lido = (texto) => () => lerManifesto(Buffer.from(texto, 'utf8'), opcoes);
    assert.deepEqual(recusaCom(lido(h.manifestoComCelula(unico, 0, 'sha256_png_padronizado', 'abc')), 'PACOTE_MANIFESTO_INVALIDO').detalhes, [{ linha: 2, campo: 'sha256_png_padronizado', motivo: 'HASH_INVALIDO' }]);
    assert.deepEqual(recusaCom(lido(h.manifestoComCelula(unico, 0, 'bytes_miniatura', 0)), 'PACOTE_MANIFESTO_INVALIDO').detalhes, [{ linha: 2, campo: 'bytes_miniatura', motivo: 'TAMANHO_INVALIDO' }]);
    assert.deepEqual(recusaCom(lido(unico.manifesto.replace('nome,', 'nomes,')), 'PACOTE_MANIFESTO_INVALIDO').detalhes, [{ campo: 'cabecalho', motivo: 'DIFERENTE_DO_APROVADO' }]);
    assert.deepEqual(recusaCom(lido(unico.manifesto.replace(`${i.nome}.png`, `pasta/${i.nome}.png`)), 'PACOTE_MANIFESTO_INVALIDO').detalhes, [{ linha: 2, campo: 'nome', motivo: 'NOME_INVALIDO' }]);
  });
});
