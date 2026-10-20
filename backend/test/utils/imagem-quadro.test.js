'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Biblioteca de Imagens, Unidade 5C-4 — o QUADRO: o formato binário em que o processo filho devolve o resultado ao processo da API (src/utils/imagem-quadro.js).
 *   'GIMG' | versão (1 byte) | tamanho do JSON (4 bytes, big-endian) | JSON | mestre | exibição | miniatura
 * Sucesso: {"ok":true,"formato":"PNG","largura":L,"altura":A,"tamanhos":[m,e,i]}; recusa: {"ok":false,"codigo":"IMAGEM_..."}. Quem lê (o lado da API) NÃO confia em nada: magia, versão,
 * tamanho do JSON, chaves exatas, tipos, tamanhos, tetos, soma exata dos bytes e código de recusa da lista combinada. Qualquer violação é o MESMO erro interno.
 */

const carregar = (caminho, trecho) => {
  try { return require(caminho); } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && String(erro.message).includes(trecho)) throw new Error(`módulo ainda não implementado: ${caminho}`);
    throw erro;
  }
};
const Q = () => carregar('../../src/utils/imagem-quadro', 'imagem-quadro');
const TETOS = Object.freeze({ mestreMax: 4 * 1024 * 1024, exibicaoMax: 512 * 1024, miniaturaMax: 65536 });
const resultado = (extra = {}) => ({ formato: 'PNG', largura: 1024, altura: 1024, mestre: Buffer.from('mestre-png'), exibicao: Buffer.from('exibicao-webp'), miniatura: Buffer.from('miniatura-webp'), ...extra });
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const quadroCru = (json, ...cargas) => { const j = Buffer.from(typeof json === 'string' ? json : JSON.stringify(json)); return Buffer.concat([Buffer.from('GIMG', 'ascii'), Buffer.from([1]), u32(j.length), j, ...cargas]); };
const invalido = (erro) => { assert.ok(erro instanceof Error); assert.equal(erro.codigo, 'IMAGEM_FILHO_RESPOSTA_INVALIDA'); return true; };

describe('quadro — ida e volta', () => {
  test('QDR-01 — sucesso: serializar e ler devolve exatamente o que foi enviado, com as três cargas na ordem', () => {
    const r = resultado();
    const lido = Q().lerQuadro(Q().serializarSucesso(r), TETOS);
    assert.equal(lido.ok, true);
    assert.deepEqual([lido.formato, lido.largura, lido.altura], ['PNG', 1024, 1024]);
    assert.ok(lido.mestre.equals(r.mestre) && lido.exibicao.equals(r.exibicao) && lido.miniatura.equals(r.miniatura));
  });

  test('QDR-02 — recusa: cada um dos seis códigos combinados faz a ida e volta; fora da lista não se serializa', () => {
    for (const codigo of ['IMAGEM_FORMATO_NAO_SUPORTADO', 'IMAGEM_ANIMADA_NAO_SUPORTADA', 'IMAGEM_INVALIDA', 'IMAGEM_DIMENSOES_INVALIDAS', 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO', 'IMAGEM_SAIDA_EXCEDE_LIMITE']) {
      assert.deepEqual(Q().lerQuadro(Q().serializarRecusa(codigo), TETOS), { ok: false, codigo });
    }
    assert.throws(() => Q().serializarRecusa('ERRO_QUALQUER'), TypeError);
    assert.throws(() => Q().serializarRecusa(undefined), TypeError);
  });

  test('QDR-03 — serializarSucesso exige formato PNG, medidas inteiras positivas e três Buffers não vazios (erro de programação: TypeError)', () => {
    for (const ruim of [{ formato: 'JPEG' }, { largura: 0 }, { altura: -1 }, { largura: 1.5 }, { mestre: Buffer.alloc(0) }, { exibicao: 'texto' }, { miniatura: null }]) {
      assert.throws(() => Q().serializarSucesso(resultado(ruim)), TypeError, JSON.stringify(Object.keys(ruim)));
    }
  });
});

describe('quadro — quem lê não confia em nada', () => {
  test('QDR-04 — magia, versão, tamanho do JSON e JSON quebrados', () => {
    const bom = Q().serializarSucesso(resultado());
    assert.throws(() => Q().lerQuadro(Buffer.alloc(0), TETOS), invalido);
    assert.throws(() => Q().lerQuadro(Buffer.from('GIM'), TETOS), invalido);
    assert.throws(() => Q().lerQuadro(Buffer.concat([Buffer.from('XXXX'), bom.subarray(4)]), TETOS), invalido);
    const outraVersao = Buffer.from(bom); outraVersao[4] = 2;
    assert.throws(() => Q().lerQuadro(outraVersao, TETOS), invalido);
    assert.throws(() => Q().lerQuadro(quadroCru('{nao e json'), TETOS), invalido);
    assert.throws(() => Q().lerQuadro(Buffer.concat([Buffer.from('GIMG'), Buffer.from([1]), u32(5000), Buffer.alloc(5000, 0x20)]), TETOS), invalido, 'JSON acima de 1 KiB');
    assert.throws(() => Q().lerQuadro(Buffer.concat([Buffer.from('GIMG'), Buffer.from([1]), u32(0xffffffff)]), TETOS), invalido, 'tamanho do JSON maior que o quadro');
    const jsonValido = '{"ok":false,"codigo":"IMAGEM_INVALIDA"}';
    assert.deepEqual(Q().lerQuadro(quadroCru(jsonValido + ' '.repeat(1024 - jsonValido.length)), TETOS), { ok: false, codigo: 'IMAGEM_INVALIDA' }, 'JSON de exatamente 1 KiB passa');
    assert.throws(() => Q().lerQuadro(quadroCru(jsonValido + ' '.repeat(1025 - jsonValido.length)), TETOS), invalido, 'um byte acima do teto de 1 KiB, mesmo sendo JSON válido');
    assert.throws(() => Q().lerQuadro(Buffer.concat([Buffer.from('GIMG'), Buffer.from([1]), u32(0)]), TETOS), invalido, 'JSON vazio');
  });

  test('QDR-05 — chaves, tipos e valores do JSON de sucesso: faltando, sobrando, tipo errado, formato diferente de PNG, medidas ruins, tamanhos ruins', () => {
    const ok = { ok: true, formato: 'PNG', largura: 1024, altura: 1024, tamanhos: [1, 1, 1] };
    const cargas = Buffer.alloc(3, 1);
    const variacoes = {
      'sem formato': { ...ok, formato: undefined }, 'chave extra': { ...ok, extra: 1 }, 'formato JPEG': { ...ok, formato: 'JPEG' }, 'largura em texto': { ...ok, largura: '1024' },
      'altura zero': { ...ok, altura: 0 }, 'tamanhos com 2': { ...ok, tamanhos: [1, 1] }, 'tamanhos com 4': { ...ok, tamanhos: [1, 1, 1, 1] }, 'tamanho zero': { ...ok, tamanhos: [0, 1, 1] },
      'tamanho fracionário': { ...ok, tamanhos: [1.5, 1, 1] }, 'tamanho negativo': { ...ok, tamanhos: [-1, 1, 2] }, 'tamanho em texto': { ...ok, tamanhos: ['1', 1, 1] }, 'ok em texto': { ...ok, ok: 'true' },
    };
    for (const [nome, json] of Object.entries(variacoes)) assert.throws(() => Q().lerQuadro(quadroCru(json, cargas), TETOS), invalido, nome);
    Q().lerQuadro(quadroCru(ok, cargas), TETOS);
  });

  test('QDR-06 — a soma dos bytes tem de bater EXATAMENTE: faltando ou sobrando uma carga é inválido', () => {
    const json = { ok: true, formato: 'PNG', largura: 1024, altura: 1024, tamanhos: [4, 4, 4] };
    Q().lerQuadro(quadroCru(json, Buffer.alloc(12)), TETOS);
    assert.throws(() => Q().lerQuadro(quadroCru(json, Buffer.alloc(11)), TETOS), invalido);
    assert.throws(() => Q().lerQuadro(quadroCru(json, Buffer.alloc(13)), TETOS), invalido);
    assert.throws(() => Q().lerQuadro(quadroCru(json), TETOS), invalido);
  });

  test('QDR-07 — cada carga tem o seu teto: acima de qualquer um é inválido, no teto exato é aceito', () => {
    const make = (m, e, i) => quadroCru({ ok: true, formato: 'PNG', largura: 1024, altura: 1024, tamanhos: [m, e, i] }, Buffer.alloc(m + e + i));
    const t = { mestreMax: 100, exibicaoMax: 50, miniaturaMax: 20 };
    Q().lerQuadro(make(100, 50, 20), t);
    assert.throws(() => Q().lerQuadro(make(101, 50, 20), t), invalido);
    assert.throws(() => Q().lerQuadro(make(100, 51, 20), t), invalido);
    assert.throws(() => Q().lerQuadro(make(100, 50, 21), t), invalido);
  });

  test('QDR-08 — recusa: chave extra, código fora da lista ou de tipo errado, carga depois do JSON → inválido', () => {
    assert.throws(() => Q().lerQuadro(quadroCru({ ok: false, codigo: 'ERRO_QUALQUER' }), TETOS), invalido);
    assert.throws(() => Q().lerQuadro(quadroCru({ ok: false, codigo: 42 }), TETOS), invalido);
    assert.throws(() => Q().lerQuadro(quadroCru({ ok: false, codigo: 'IMAGEM_INVALIDA', motivo: 'x' }), TETOS), invalido);
    assert.throws(() => Q().lerQuadro(quadroCru({ ok: false }), TETOS), invalido);
    assert.throws(() => Q().lerQuadro(quadroCru({ ok: false, codigo: 'IMAGEM_INVALIDA' }, Buffer.from('x')), TETOS), invalido);
  });

  test('QDR-09 — o argumento de leitura precisa ser Buffer e os tetos precisam existir (erro de programação: TypeError)', () => {
    const bom = Q().serializarRecusa('IMAGEM_INVALIDA');
    for (const ruim of ['texto', null, undefined, 42, new Uint8Array(4)]) assert.throws(() => Q().lerQuadro(ruim, TETOS), TypeError);
    for (const ruins of [undefined, {}, { mestreMax: 1 }, { mestreMax: 0, exibicaoMax: 1, miniaturaMax: 1 }, { mestreMax: '1', exibicaoMax: 1, miniaturaMax: 1 }]) assert.throws(() => Q().lerQuadro(bom, ruins), TypeError);
  });

  test('QDR-10 — nenhuma mensagem de erro repete o conteúdo do quadro recebido', () => {
    const marcador = 'MARCADOR-SECRETO-5d1e';
    for (const entrada of [Buffer.from(marcador), quadroCru({ ok: false, codigo: marcador }), quadroCru(`{"x":"${marcador}"`), Buffer.concat([Buffer.from('GIMG'), Buffer.from([1]), u32(9), Buffer.from(marcador)])]) {
      const erro = (() => { try { Q().lerQuadro(entrada, TETOS); return null; } catch (e) { return e; } })();
      invalido(erro);
      assert.ok(!String(erro.message).includes(marcador) && !String(erro.stack).includes(marcador));
    }
  });
});
