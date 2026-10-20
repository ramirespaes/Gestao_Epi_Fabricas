'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { criarProcessadorFalso } = require('./processador-imagem-falso');
const {
  png, pngMinimo, pngAnimado, jpegMinimo, webpMinimo, webpAnimado, gif,
} = require('./imagens-validas');

/**
 * Controle do INSTRUMENTO de teste da 5C-1 (não testa produção): o processador falso e as fixtures precisam fazer o que o comentário deles diz, senão um teste
 * RED poderia falhar (ou passar) por defeito do instrumento. Estes testes ficam verdes desde já.
 */

const codigoDe = async (promessa) => {
  try { await promessa; return null; } catch (falha) { return falha.codigo ?? `SEM_CODIGO:${falha.name}`; }
};
const RIFF_WEBP = (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' && b.readUInt32LE(4) + 8 === b.length;

describe('processador de imagem FALSO — instrumento de teste da 5C-1', () => {
  test('reconhece PNG, JPEG e WebP pela assinatura; o PNG traz as medidas do cabeçalho; JPEG e WebP usam as medidas configuradas', async () => {
    const p = criarProcessadorFalso({ medidas: { largura: 640, altura: 480 } });
    const real = await p.processar(png(320, 330));
    assert.deepEqual([real.formato, real.largura, real.altura], ['PNG', 320, 330]);
    const minimo = await p.processar(pngMinimo(1000, 800));
    assert.deepEqual([minimo.formato, minimo.largura, minimo.altura], ['PNG', 1000, 800]);
    const jpeg = await p.processar(jpegMinimo('a'));
    assert.deepEqual([jpeg.formato, jpeg.largura, jpeg.altura], ['JPEG', 640, 480]);
    const webp = await p.processar(webpMinimo('a'));
    assert.deepEqual([webp.formato, webp.largura, webp.altura], ['WEBP', 640, 480]);
  });

  test('recusa pelo conteúdo: GIF, vazio, texto e valor que não é Buffer são IMAGEM_FORMATO_NAO_SUPORTADO', async () => {
    const p = criarProcessadorFalso();
    for (const entrada of [gif(), Buffer.alloc(0), Buffer.from('texto qualquer'), 'PNG', null, undefined]) {
      assert.equal(await codigoDe(p.processar(entrada)), 'IMAGEM_FORMATO_NAO_SUPORTADO', String(entrada).slice(0, 20));
    }
  });

  test('arquivo truncado (sem fim) é IMAGEM_INVALIDA nos três formatos', async () => {
    const p = criarProcessadorFalso();
    const jpeg = jpegMinimo('t');
    const webp = webpMinimo('t');
    for (const truncado of [png(320, 320).subarray(0, 200), jpeg.subarray(0, jpeg.length - 2), webp.subarray(0, webp.length - 10)]) {
      assert.equal(await codigoDe(p.processar(truncado)), 'IMAGEM_INVALIDA');
    }
  });

  test('animação (APNG com acTL, WebP com ANIM) é IMAGEM_ANIMADA_NAO_SUPORTADA', async () => {
    const p = criarProcessadorFalso();
    assert.equal(await codigoDe(p.processar(pngAnimado(320, 320))), 'IMAGEM_ANIMADA_NAO_SUPORTADA');
    assert.equal(await codigoDe(p.processar(webpAnimado('a'))), 'IMAGEM_ANIMADA_NAO_SUPORTADA');
  });

  test('lado fora de 320–4096 e mais de 8 Mpx são IMAGEM_DIMENSOES_INVALIDAS; 3000×2000 (6 Mpx) passa', async () => {
    const p = criarProcessadorFalso();
    for (const [l, a] of [[319, 320], [320, 319], [4097, 320], [320, 4097], [4096, 4096]]) {
      assert.equal(await codigoDe(p.processar(pngMinimo(l, a))), 'IMAGEM_DIMENSOES_INVALIDAS', `${l}x${a}`);
    }
    assert.deepEqual(await codigoDe(p.processar(pngMinimo(3000, 2000))), null);
  });

  test('as derivadas são contêineres RIFF/WEBP bem formados, o mestre não é o arquivo enviado, e tudo é determinístico pelo conteúdo', async () => {
    const p = criarProcessadorFalso();
    const entrada = png(321, 320);
    const a = await p.processar(entrada);
    const b = await p.processar(Buffer.from(entrada));
    assert.equal(RIFF_WEBP(a.exibicao) && RIFF_WEBP(a.miniatura), true);
    assert.equal(a.mestre.equals(entrada), false, 'o mestre é o saneado, não os bytes enviados');
    for (const v of ['mestre', 'exibicao', 'miniatura']) assert.equal(a[v].equals(b[v]), true, `${v}: mesma entrada, mesma saída`);
    const outra = await p.processar(png(322, 320));
    for (const v of ['mestre', 'exibicao', 'miniatura']) assert.equal(a[v].equals(outra[v]), false, `${v}: entradas diferentes, saídas diferentes`);
    assert.deepEqual(p.resultadoEsperado(entrada).miniatura, a.miniatura, 'resultadoEsperado devolve o mesmo que processar, sem registrar chamada');
  });

  test('registra as chamadas, o número simultâneo e os eventos; falharCom faz toda chamada falhar com o código e a mensagem pedidos', async () => {
    const eventos = [];
    const liberar = [];
    const p = criarProcessadorFalso({ eventos, aguardar: () => new Promise((resolve) => { liberar.push(resolve); }) });
    const duas = [p.processar(png(320, 320)), p.processar(png(321, 320))];
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual([p.emAndamento, p.maximoSimultaneo, p.chamadas.length], [2, 2, 2]);
    liberar.forEach((f) => f());
    await Promise.all(duas);
    assert.deepEqual([p.emAndamento, p.maximoSimultaneo], [0, 2]);
    assert.deepEqual(eventos, ['processar:inicio', 'processar:inicio', 'processar:fim', 'processar:fim']);

    const q = criarProcessadorFalso();
    q.falharCom('IMAGEM_INVALIDA', 'ISCA-DE-VAZAMENTO');
    await assert.rejects(q.processar(png(320, 320)), (falha) => falha.codigo === 'IMAGEM_INVALIDA' && falha.message === 'ISCA-DE-VAZAMENTO');
  });
});
