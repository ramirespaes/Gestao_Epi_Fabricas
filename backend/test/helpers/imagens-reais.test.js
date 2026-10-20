'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const F = require('./imagens-reais');

/**
 * Autoteste das FIXTURES do processador real (Unidade 5C-4): cada uma é o que diz ser. Sem isto, um teste de segurança poderia passar "no vazio" (por exemplo, um WebP
 * "animado" que na verdade não é animado, ou um PNG "truncado" que ainda decodifica). Também documenta o que o libvips, sozinho, NÃO recusa — e por isso o processador
 * precisa de verificações próprias (APNG, carga depois do fim do arquivo).
 */

const decodifica = (arquivo, opcoes = {}) => sharp(arquivo, { failOn: 'warning', ...opcoes }).raw().toBuffer({ resolveWithObject: true });

describe('fixtures reais', () => {
  test('FIX-01 — PNG, JPEG e WebP têm assinatura e medidas pedidas', async () => {
    const p = await F.png(400, 300);
    const j = await F.jpeg(400, 300);
    const w = await F.webp(400, 300);
    assert.deepEqual([...p.subarray(0, 8)], [...F.ASSINATURA_PNG]);
    assert.deepEqual([...j.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.equal(w.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(w.subarray(8, 12).toString('ascii'), 'WEBP');
    for (const [arquivo, formato] of [[p, 'png'], [j, 'jpeg'], [w, 'webp']]) {
      const m = await F.metadados(arquivo);
      assert.deepEqual([m.format, m.width, m.height], [formato, 400, 300]);
    }
  });

  test('FIX-02 — o padrão "quadrantes" tem quatro cores distintas e o "alfa" tem três faixas de transparência', async () => {
    const q = await F.png(8, 8);
    assert.deepEqual(await F.pixel(q, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(await F.pixel(q, 7, 0), [0, 255, 0, 255]);
    assert.deepEqual(await F.pixel(q, 0, 7), [0, 0, 255, 255]);
    assert.deepEqual(await F.pixel(q, 7, 7), [255, 255, 0, 255]);
    const a = await F.png(9, 3, { padrao: 'alfa' });
    assert.equal((await F.pixel(a, 0, 0))[3], 0);
    assert.equal((await F.pixel(a, 4, 0))[3], 255);
    assert.equal((await F.pixel(a, 8, 0))[3], 128);
  });

  test('FIX-03 — caixaOpaca mede o conteúdo opaco dentro de uma tela transparente', async () => {
    const tela = await sharp({ create: { width: 100, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await F.png(30, 20), left: 10, top: 5 }]).png().toBuffer();
    assert.deepEqual(await F.caixaOpaca(tela), { x0: 10, y0: 5, x1: 39, y1: 24, largura: 30, altura: 20 });
  });

  test('FIX-04 — a orientação EXIF pedida é gravada no arquivo (1 a 8)', async () => {
    for (const o of [3, 6, 8]) assert.equal((await F.metadados(await F.jpeg(400, 300, { orientacao: o }))).orientation, o);
  });

  test('FIX-05 — EXIF com GPS, XMP e ICC estão REALMENTE presentes nos três formatos', async () => {
    for (const formato of ['png', 'jpeg', 'webp']) {
      const arquivo = await F.codificar(400, 300, { formato, exif: true, xmp: true, icc: 'p3' });
      const m = await F.metadados(arquivo);
      assert.ok(m.exif && m.xmp && m.icc, `${formato}: exif, xmp e icc presentes`);
    }
    const j = await F.jpeg(400, 300, { exif: true, xmp: true, icc: 'p3' });
    assert.ok(j.includes(Buffer.from(F.SEGREDOS.copyright)) && j.includes(Buffer.from(F.SEGREDOS.xmp)), 'os textos secretos estão nos bytes do JPEG');
    assert.ok(F.segmentosJpeg(j).includes('e1') && F.segmentosJpeg(j).includes('e2'), 'JPEG com APP1 (EXIF/XMP) e APP2 (ICC)');
    assert.ok(F.pedacosPng(await F.png(400, 300, { exif: true, icc: 'p3' })).includes('eXIf'));
    assert.deepEqual(F.pedacosWebp(await F.webp(400, 300, { exif: true, xmp: true, icc: 'p3' })).filter((c) => ['EXIF', 'XMP ', 'ICCP'].includes(c)).sort(), ['EXIF', 'ICCP', 'XMP ']);
  });

  test('FIX-06 — IPTC (APP13), comentário (COM) e pedaço tEXt inseridos à mão são legíveis e a imagem continua decodificando', async () => {
    const j = F.inserirSegmentoJpeg(F.inserirSegmentoJpeg(await F.jpeg(400, 300), 0xed, F.iptcApp13()), 0xfe, Buffer.from(F.SEGREDOS.comentario));
    assert.ok(F.segmentosJpeg(j).includes('ed') && F.segmentosJpeg(j).includes('fe'));
    assert.ok(j.includes(Buffer.from(F.SEGREDOS.iptc)) && j.includes(Buffer.from(F.SEGREDOS.comentario)));
    await decodifica(j);
    const p = F.inserirPedacoPng(await F.png(400, 300), 'tEXt', Buffer.from(`Comment\0${F.SEGREDOS.comentario}`, 'latin1'));
    assert.ok(F.pedacosPng(p).includes('tEXt') && p.includes(Buffer.from(F.SEGREDOS.comentario)));
    await decodifica(p);
  });

  test('FIX-07 — o JPEG CMYK é CMYK de verdade e o PNG "P3" guarda valores diferentes do sRGB', async () => {
    const c = await F.jpeg(400, 300, { cmyk: true });
    assert.deepEqual([(await F.metadados(c)).space, (await F.metadados(c)).channels], ['cmyk', 4]);
    const p3 = await F.png(320, 320, { padrao: 'solido', icc: 'p3' });
    const bruto = await decodifica(p3, { ignoreIcc: true });
    const convertido = await sharp(p3, { failOn: 'warning' }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
    assert.notDeepEqual([...bruto.data.subarray(0, 3)], [...convertido.subarray(0, 3)], 'o perfil muda os valores gravados');
  });
});

describe('fixtures hostis', () => {
  test('FIX-08 — o libvips sozinho NÃO recusa o APNG nem o arquivo com carga depois do fim: o processador precisa de verificação própria', async () => {
    const base = await F.png(400, 300);
    const a = F.apng(base);
    assert.ok(F.pedacosPng(a).includes('acTL'));
    const info = await F.metadados(a);
    assert.equal(info.pages ?? 1, 1, 'o libvips lê o APNG como imagem de um quadro só');
    await decodifica(a);
    const comCarga = Buffer.concat([base, F.zip()]);
    await decodifica(comCarga);
    assert.ok(comCarga.length > base.length);
  });

  test('FIX-09 — o WebP animado tem dois quadros e o sinal de animação no VP8X', async () => {
    const w = await F.webpAnimado();
    assert.equal((await F.metadados(w)).pages, 2);
    assert.equal(F.pedacosWebp(w)[0], 'VP8X');
    assert.equal(w[20] & 0x02, 0x02);
  });

  test('FIX-10 — GIF, TIFF e AVIF reais são lidos como o que são (antes de qualquer bloqueio)', async () => {
    assert.equal((await F.metadados(await F.gif())).format, 'gif');
    assert.equal((await F.metadados(await F.tiff())).format, 'tiff');
    assert.equal((await F.metadados(await F.avif())).format, 'heif');
    assert.equal((await F.metadados(F.svg())).format, 'svg');
  });

  test('FIX-11 — os formatos montados à mão têm a assinatura certa', () => {
    assert.ok(F.pdf().subarray(0, 5).toString('latin1') === '%PDF-');
    assert.deepEqual([...F.zip().subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    assert.deepEqual([...F.elf().subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
    assert.equal(F.exe().subarray(0, 2).toString('ascii'), 'MZ');
    assert.ok(F.html().toString().startsWith('<!DOCTYPE html>') && F.svg().toString().startsWith('<svg'));
    assert.equal(F.bmp().subarray(0, 2).toString('ascii'), 'BM');
    assert.equal(F.heic().subarray(4, 12).toString('ascii'), 'ftypheic');
  });

  test('FIX-12 — o PNG truncado e o PNG com CRC corrompido são realmente recusados pelo libvips', async () => {
    const base = await F.png(400, 300, { padrao: 'ruido' });
    await assert.rejects(decodifica(F.truncar(base, 0.5)));
    await assert.rejects(decodifica(F.pngComCrcCorrompido(base)));
    await decodifica(base);
  });

  test('FIX-15 — o JPEG cortado e fechado com EOI só é recusado com failOn "warning": é o fixture que prova a política estrita', async () => {
    const base = await F.jpeg(400, 300, { padrao: 'ruido' });
    const cortado = F.jpegCortadoComEoi(base);
    assert.deepEqual([...cortado.subarray(cortado.length - 2)], [0xff, 0xd9], 'termina em EOI');
    assert.ok(cortado.length < base.length);
    await decodifica(cortado, { failOn: 'error' });
    await assert.rejects(decodifica(cortado, { failOn: 'warning' }), /premature end|Corrupt JPEG/i);
  });

  test('FIX-13 — as dimensões declaradas gigantes cabem em poucos bytes e o cabeçalho PNG diz o que declara', async () => {
    const p = F.pngComDimensoesDeclaradas(60000, 60000);
    assert.ok(p.length < 200);
    assert.deepEqual([p.readUInt32BE(16), p.readUInt32BE(20)], [60000, 60000], 'o IHDR declara 60000 x 60000');
    // o próprio libvips recusa essa declaração (3,6 bilhões de pixels) já no metadata(), por causa do limitInputPixels padrão
    await assert.rejects(F.metadados(p), /pixel limit/);
    assert.ok(F.jpegComDimensoesDeclaradas(65535, 65535).length < 100);
    assert.ok(F.webpComDimensoesDeclaradas(16000, 16000).length < 100);
    assert.equal(F.webpComDimensoesDeclaradas(16000, 16000).subarray(12, 16).toString('ascii'), 'VP8X');
  });

  test('FIX-14 — o PNG de pixels enormes é válido, passa de 8 Mpx e é pequeno em bytes', async () => {
    const p = await F.pngDePixelsEnormes(3000, 2800);
    const m = await F.metadados(p);
    assert.equal(m.width * m.height, 8400000);
    assert.ok(p.length < 100000);
  });
});
