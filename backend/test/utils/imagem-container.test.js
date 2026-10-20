'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const F = require('../helpers/imagens-reais');

/**
 * Biblioteca de Imagens, Unidade 5C-4 — INSPETOR DE CONTÊINER (src/utils/imagem-container.js): função pura, sem sharp e sem rede, que olha SÓ os bytes do envio e decide, antes
 * de qualquer decodificação: o formato (PNG, JPEG ou WebP, pelos bytes e nunca por nome ou tipo declarado), a estrutura, se é animada, as dimensões DECLARADAS no cabeçalho
 * (recusadas antes de alocar memória) e o que sobra depois do fim do arquivo (carga extra: benigna é descartada na recodificação; com assinatura de arquivo ativo é recusada).
 * Contratos: VAL-01, VAL-02, VAL-03, VAL-04, VAL-05 e VAL-08 do Documento 14. Nenhuma mensagem leva byte do envio.
 */

const carregar = (caminho) => {
  try { return require(caminho); } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && String(erro.message).includes('imagem-container')) throw new Error(`módulo ainda não implementado: ${caminho}`);
    throw erro;
  }
};
const modulo = () => carregar('../../src/utils/imagem-container');
const LIMITES = Object.freeze({ ladoMin: 320, ladoMax: 4096, pixelsMax: 8388608 });
const inspecionar = (bytes) => modulo().inspecionarContainer(bytes, LIMITES);
const recusaCom = (codigo) => (erro) => {
  assert.ok(erro instanceof modulo().ErroDeImagem, `esperava ErroDeImagem e veio ${erro?.name}: ${erro?.message}`);
  assert.equal(erro.codigo, codigo);
  return true;
};
const CODIGO = Object.freeze({
  FORMATO: 'IMAGEM_FORMATO_NAO_SUPORTADO', ANIMADA: 'IMAGEM_ANIMADA_NAO_SUPORTADA', INVALIDA: 'IMAGEM_INVALIDA', DIMENSOES: 'IMAGEM_DIMENSOES_INVALIDAS',
});

describe('inspecionarContainer — formato pelos bytes (VAL-01)', () => {
  test('IC-01 — reconhece PNG, JPEG e WebP reais e devolve formato, medidas e o fim do arquivo', async () => {
    const casos = [[await F.png(400, 320), 'PNG'], [await F.jpeg(400, 320), 'JPEG'], [await F.webp(400, 320), 'WEBP']];
    for (const [arquivo, formato] of casos) {
      const r = inspecionar(arquivo);
      assert.deepEqual([r.formato, r.largura, r.altura, r.fim, r.bytesExtras], [formato, 400, 320, arquivo.length, 0], formato);
    }
  });

  test('IC-02 — as variantes reais de cada formato passam: JPEG progressivo e com metadados, WebP sem perda, com alfa e com EXIF/ICC, PNG com metadados', async () => {
    const jp = await sharp(F.pixelsBrutos(500, 400), { raw: { width: 500, height: 400, channels: 4 } }).flatten({ background: '#fff' }).jpeg({ progressive: true }).toBuffer();
    const amostras = [
      [jp, 'JPEG'], [await F.jpeg(500, 400, { exif: true, xmp: true, icc: 'p3' }), 'JPEG'], [await F.jpeg(500, 400, { cmyk: true }), 'JPEG'],
      [await sharp(F.pixelsBrutos(500, 400), { raw: { width: 500, height: 400, channels: 4 } }).webp({ lossless: true }).toBuffer(), 'WEBP'],
      [await F.webp(500, 400, { padrao: 'alfa' }), 'WEBP'], [await F.webp(500, 400, { exif: true, xmp: true, icc: 'p3' }), 'WEBP'],
      [await F.png(500, 400, { exif: true, xmp: true, icc: 'p3', padrao: 'alfa' }), 'PNG'],
      [F.inserirSegmentoJpeg(F.inserirSegmentoJpeg(await F.jpeg(500, 400), 0xed, F.iptcApp13()), 0xfe, Buffer.from('c')), 'JPEG'],
    ];
    for (const [arquivo, formato] of amostras) {
      const r = inspecionar(arquivo);
      assert.deepEqual([r.formato, r.largura, r.altura, r.bytesExtras], [formato, 500, 400, 0], formato);
    }
  });

  test('IC-03 — o resultado só depende dos bytes: o mesmo conteúdo dá o mesmo resultado em qualquer Buffer (cópia, fatia, outro byteOffset)', async () => {
    const arquivo = await F.png(400, 320);
    const deslocado = Buffer.concat([Buffer.alloc(7), arquivo]).subarray(7);
    assert.deepEqual(inspecionar(deslocado), inspecionar(Buffer.from(arquivo)));
  });
});

describe('inspecionarContainer — formatos não aceitos (VAL-02)', () => {
  const NAO_ACEITOS = {
    vazio: () => Buffer.alloc(0), 'um byte': () => Buffer.from([0x89]), texto: () => F.texto(), aleatório: () => F.aleatorio(5000),
    SVG: () => F.svg(), 'SVG com XML': () => F.svgComXml(), HTML: () => F.html(), 'HTML sem doctype': () => F.htmlSemDoctype(), PDF: () => F.pdf(), ZIP: () => F.zip(),
    ELF: () => F.elf(), EXE: () => F.exe(), BMP: () => F.bmp(), HEIC: () => F.heic(),
  };
  for (const [nome, fabricar] of Object.entries(NAO_ACEITOS)) {
    test(`IC-04 — ${nome} → IMAGEM_FORMATO_NAO_SUPORTADO`, () => {
      assert.throws(() => inspecionar(fabricar()), recusaCom(CODIGO.FORMATO));
    });
  }

  test('IC-05 — GIF, TIFF e AVIF reais → IMAGEM_FORMATO_NAO_SUPORTADO', async () => {
    for (const arquivo of [await F.gif(), await F.tiff(), await F.avif()]) assert.throws(() => inspecionar(arquivo), recusaCom(CODIGO.FORMATO));
  });

  test('IC-06 — só Buffer: qualquer outra coisa é erro de programação (TypeError), nunca uma recusa de imagem', () => {
    for (const invalido of [null, undefined, 'texto', 42, [], { length: 3 }, new Uint8Array(10)]) assert.throws(() => inspecionar(invalido), TypeError);
  });
});

describe('inspecionarContainer — truncadas e corrompidas (VAL-03)', () => {
  test('IC-07 — assinatura certa e nada mais → IMAGEM_INVALIDA', () => {
    assert.throws(() => inspecionar(F.ASSINATURA_PNG), recusaCom(CODIGO.INVALIDA));
    assert.throws(() => inspecionar(Buffer.from([0xff, 0xd8, 0xff])), recusaCom(CODIGO.INVALIDA));
    assert.throws(() => inspecionar(Buffer.from('RIFF\x04\0\0\0WEBP', 'latin1')), recusaCom(CODIGO.INVALIDA));
    assert.throws(() => inspecionar(Buffer.concat([F.ASSINATURA_PNG, F.aleatorio(200)])), recusaCom(CODIGO.INVALIDA));
  });

  test('IC-08 — PNG, JPEG e WebP reais cortados em 30%, 60% e 95% → IMAGEM_INVALIDA', async () => {
    const reais = [await F.png(500, 400, { padrao: 'ruido' }), await F.jpeg(500, 400, { padrao: 'ruido' }), await F.webp(500, 400, { padrao: 'ruido' })];
    for (const arquivo of reais) {
      for (const fracao of [0.3, 0.6, 0.95]) assert.throws(() => inspecionar(F.truncar(arquivo, fracao)), recusaCom(CODIGO.INVALIDA), `${arquivo.length} bytes cortados em ${fracao}`);
    }
  });

  test('IC-09 — PNG malformado: sem IDAT, IHDR fora do lugar, IHDR com tamanho errado, pedaço que passa do fim, sem IEND → IMAGEM_INVALIDA', async () => {
    const base = await F.png(400, 320);
    const semIdat = Buffer.concat([F.ASSINATURA_PNG, base.subarray(8, 8 + 12 + 13), F.pedacoPng('IEND', Buffer.alloc(0))]);
    assert.throws(() => inspecionar(semIdat), recusaCom(CODIGO.INVALIDA));
    const ihdrDepois = Buffer.concat([F.ASSINATURA_PNG, F.pedacoPng('tEXt', Buffer.from('a\0b')), base.subarray(8)]);
    assert.throws(() => inspecionar(ihdrDepois), recusaCom(CODIGO.INVALIDA));
    const ihdrCurto = Buffer.concat([F.ASSINATURA_PNG, F.pedacoPng('IHDR', Buffer.alloc(12)), F.pedacoPng('IEND', Buffer.alloc(0))]);
    assert.throws(() => inspecionar(ihdrCurto), recusaCom(CODIGO.INVALIDA));
    const passaDoFim = Buffer.from(base);
    passaDoFim.writeUInt32BE(0x7fffffff, 8 + 12 + 13);
    assert.throws(() => inspecionar(passaDoFim), recusaCom(CODIGO.INVALIDA));
    assert.throws(() => inspecionar(base.subarray(0, base.length - 12)), recusaCom(CODIGO.INVALIDA));
  });

  test('IC-10 — WebP: tamanho RIFF maior que o arquivo, pedaço que passa do fim e primeiro pedaço desconhecido → IMAGEM_INVALIDA', async () => {
    const base = await F.webp(400, 320);
    const maior = Buffer.from(base);
    maior.writeUInt32LE(base.length + 1000, 4);
    assert.throws(() => inspecionar(maior), recusaCom(CODIGO.INVALIDA));
    const pedacoGrande = Buffer.from(base);
    pedacoGrande.writeUInt32LE(0x7ffffff0, 16);
    assert.throws(() => inspecionar(pedacoGrande), recusaCom(CODIGO.INVALIDA));
    const desconhecido = Buffer.from(base);
    desconhecido.write('XXXX', 12, 'ascii');
    assert.throws(() => inspecionar(desconhecido), recusaCom(CODIGO.INVALIDA));
  });

  test('IC-11 — JPEG sem EOI, sem SOF e com segmento de tamanho absurdo → IMAGEM_INVALIDA', async () => {
    const base = await F.jpeg(400, 320);
    assert.throws(() => inspecionar(base.subarray(0, base.length - 2)), recusaCom(CODIGO.INVALIDA));
    assert.throws(() => inspecionar(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xd9])), recusaCom(CODIGO.INVALIDA));
    const absurdo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), F.aleatorio(50)]);
    assert.throws(() => inspecionar(absurdo), recusaCom(CODIGO.INVALIDA));
  });
});

describe('inspecionarContainer — animadas (VAL-03)', () => {
  test('IC-12 — APNG (pedaço acTL) → IMAGEM_ANIMADA_NAO_SUPORTADA', async () => {
    const animado = F.apng(await F.png(400, 320));
    assert.throws(() => inspecionar(animado), recusaCom(CODIGO.ANIMADA));
  });

  test('IC-13 — WebP animado real (VP8X com animação, ANIM, ANMF) → IMAGEM_ANIMADA_NAO_SUPORTADA', async () => {
    const animado = await F.webpAnimado(320);
    assert.throws(() => inspecionar(animado), recusaCom(CODIGO.ANIMADA));
  });
});

describe('inspecionarContainer — dimensões declaradas (VAL-04)', () => {
  test('IC-14 — lado fora de [320, 4096] → IMAGEM_DIMENSOES_INVALIDAS, nos três formatos; o limite é inclusivo', () => {
    const proibidos = [[319, 400], [400, 319], [4097, 400], [400, 4097], [1, 1], [320, 100]];
    for (const [l, a] of proibidos) {
      assert.throws(() => inspecionar(F.pngComDimensoesDeclaradas(l, a)), recusaCom(CODIGO.DIMENSOES), `png ${l}x${a}`);
      assert.throws(() => inspecionar(F.jpegComDimensoesDeclaradas(l, a)), recusaCom(CODIGO.DIMENSOES), `jpeg ${l}x${a}`);
      assert.throws(() => inspecionar(F.webpComDimensoesDeclaradas(l, a)), recusaCom(CODIGO.DIMENSOES), `webp ${l}x${a}`);
    }
    for (const [l, a] of [[320, 320], [4096, 2048], [2048, 4096], [320, 4096]]) {
      const r = inspecionar(F.pngComDimensoesDeclaradas(l, a));
      assert.deepEqual([r.largura, r.altura], [l, a]);
    }
  });

  test('IC-15 — mais de 8.388.608 pixels → IMAGEM_DIMENSOES_INVALIDAS (3000 x 2800 e 4096 x 2049), exatamente 8.388.608 passa', () => {
    assert.throws(() => inspecionar(F.pngComDimensoesDeclaradas(3000, 2800)), recusaCom(CODIGO.DIMENSOES));
    assert.throws(() => inspecionar(F.pngComDimensoesDeclaradas(4096, 2049)), recusaCom(CODIGO.DIMENSOES));
    assert.equal(inspecionar(F.pngComDimensoesDeclaradas(4096, 2048)).largura, 4096);
  });

  test('IC-16 — dimensão declarada gigante é recusada pelo cabeçalho, sem percorrer o resto e sem alocar memória proporcional ao declarado', () => {
    const antes = process.memoryUsage().arrayBuffers;
    const t0 = process.hrtime.bigint();
    for (const gigante of [F.pngComDimensoesDeclaradas(60000, 60000), F.pngComDimensoesDeclaradas(0x7fffffff, 0x7fffffff), F.jpegComDimensoesDeclaradas(65535, 65535), F.webpComDimensoesDeclaradas(16384, 16384)]) {
      assert.throws(() => inspecionar(gigante), recusaCom(CODIGO.DIMENSOES));
    }
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 50, 'recusa em milissegundos');
    assert.ok(process.memoryUsage().arrayBuffers - antes < 5 * 1024 * 1024, 'sem alocação proporcional às dimensões declaradas');
  });

  test('IC-17 — largura ou altura zero no cabeçalho → IMAGEM_INVALIDA (não é dimensão, é cabeçalho quebrado)', () => {
    assert.throws(() => inspecionar(F.pngComDimensoesDeclaradas(0, 400)), recusaCom(CODIGO.INVALIDA));
    assert.throws(() => inspecionar(F.pngComDimensoesDeclaradas(400, 0)), recusaCom(CODIGO.INVALIDA));
  });
});

describe('inspecionarContainer — carga depois do fim do arquivo (VAL-05)', () => {
  test('IC-18 — carga benigna (zeros, texto sem assinatura) depois do fim passa e é CONTADA em bytesExtras: a recodificação a descarta', async () => {
    const lixo = Buffer.from('lixo qualquer sem assinatura de arquivo ativo 0123456789');
    for (const [arquivo, formato] of [[await F.png(400, 320), 'PNG'], [await F.jpeg(400, 320), 'JPEG']]) {
      for (const extra of [Buffer.alloc(16), lixo, F.aleatorio(300, 99)]) {
        const r = inspecionar(Buffer.concat([arquivo, extra]));
        assert.deepEqual([r.formato, r.fim, r.bytesExtras], [formato, arquivo.length, extra.length], formato);
      }
    }
    const webp = await F.webp(400, 320);
    const r = inspecionar(Buffer.concat([webp, lixo]));
    assert.deepEqual([r.formato, r.fim, r.bytesExtras], ['WEBP', webp.length, lixo.length]);
  });

  test('IC-19 — carga com assinatura de arquivo ativo depois do fim (poliglota perigoso) → IMAGEM_FORMATO_NAO_SUPORTADO, nos três formatos', async () => {
    const cargas = {
      zip: F.zip(), pdf: F.pdf(), html: F.html(), 'html sem doctype': F.htmlSemDoctype(), svg: F.svg(), 'svg xml': F.svgComXml(), elf: F.elf(), exe: F.exe(),
      gif: await F.gif(), 'php': Buffer.from('<?php system($_GET["c"]); ?>'), 'script em maiúsculas': Buffer.from('xx<SCRIPT>alert(1)</SCRIPT>'), shebang: Buffer.from('#!/bin/sh\nrm -rf /\n'),
      'zip depois de texto': Buffer.concat([Buffer.from('enchimento\n'), F.zip()]),
    };
    const hospedeiros = [['png', await F.png(400, 320)], ['jpeg', await F.jpeg(400, 320)], ['webp', await F.webp(400, 320)]];
    for (const [nomeH, hospedeiro] of hospedeiros) {
      for (const [nomeC, carga] of Object.entries(cargas)) {
        assert.throws(() => inspecionar(Buffer.concat([hospedeiro, carga])), recusaCom(CODIGO.FORMATO), `${nomeH} + ${nomeC}`);
      }
    }
  });

  test('IC-20 — JPEG seguido de OUTRO JPEG (como os formatos com várias imagens, p. ex. MPF) é aceito: a recodificação descarta o segundo', async () => {
    const a = await F.jpeg(400, 320);
    const b = await F.jpeg(320, 320, { padrao: 'ruido' });
    const r = inspecionar(Buffer.concat([a, b]));
    assert.deepEqual([r.formato, r.largura, r.altura, r.fim, r.bytesExtras], ['JPEG', 400, 320, a.length, b.length]);
    // a exceção vale para a imagem seguinte INTEIRA, mesmo que os bytes dela contenham uma assinatura por acaso (aqui, um comentário com "PK\x03\x04")
    const comAssinatura = F.inserirSegmentoJpeg(b, 0xfe, Buffer.from('PK\x03\x04', 'latin1'));
    assert.equal(inspecionar(Buffer.concat([a, comAssinatura])).bytesExtras, comAssinatura.length);
    // fora do JPEG a mesma carga é recusada
    assert.throws(() => inspecionar(Buffer.concat([a, Buffer.from([0, 0]), comAssinatura])), recusaCom(CODIGO.FORMATO));
  });

  test('IC-27 — estrutura JPEG incoerente: dois SOF na mesma imagem, SOI repetido e marcador 0x00 fora dos dados → IMAGEM_INVALIDA; marcadores de reinício DENTRO da varredura não a encerram', async () => {
    const base = await F.jpeg(400, 320);
    const inicioSof = base.indexOf(Buffer.from([0xff, 0xc0]));
    const tamanhoSof = base.readUInt16BE(inicioSof + 2);
    const sof = base.subarray(inicioSof, inicioSof + 2 + tamanhoSof);
    assert.throws(() => inspecionar(Buffer.concat([base.subarray(0, inicioSof + 2 + tamanhoSof), sof, base.subarray(inicioSof + 2 + tamanhoSof)])), recusaCom(CODIGO.INVALIDA));
    assert.throws(() => inspecionar(Buffer.concat([base.subarray(0, 2), Buffer.from([0xff, 0xd8]), base.subarray(2)])), recusaCom(CODIGO.INVALIDA));
    assert.throws(() => inspecionar(Buffer.concat([base.subarray(0, 2), Buffer.from([0xff, 0x00]), base.subarray(2)])), recusaCom(CODIGO.INVALIDA));
    const inicioSos = base.indexOf(Buffer.from([0xff, 0xda]));
    const fimCabecalhoSos = inicioSos + 2 + base.readUInt16BE(inicioSos + 2);
    const comReinicio = Buffer.concat([base.subarray(0, fimCabecalhoSos), Buffer.from([0x11, 0x22, 0xff, 0xd0, 0x33, 0xff, 0xd7, 0x44, 0xff, 0xff, 0xff, 0x00]), base.subarray(fimCabecalhoSos)]);
    const r = inspecionar(comReinicio);
    assert.deepEqual([r.formato, r.fim], ['JPEG', comReinicio.length]);
  });

  test('IC-28 — WebP montado: o sinal de animação do VP8X recusa sozinho; um bloco ANIM sem o sinal também; VP8X sem dados de imagem é inválido', async () => {
    const montarWebp = (flags, extras = []) => {
      const vp8x = Buffer.concat([Buffer.from('VP8X', 'ascii'), Buffer.from([10, 0, 0, 0, flags, 0, 0, 0, 0x8f, 0x01, 0x00, 0x3f, 0x01, 0x00])]);
      const miolo = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8x, ...extras]);
      const tam = Buffer.alloc(4);
      tam.writeUInt32LE(miolo.length);
      return Buffer.concat([Buffer.from('RIFF', 'ascii'), tam, miolo]);
    };
    const imagem = Buffer.concat([Buffer.from('VP8L', 'ascii'), Buffer.from([8, 0, 0, 0, 0x2f, 0x8f, 0xc1, 0x4f, 0x00, 0, 0, 0])]);
    const anim = Buffer.concat([Buffer.from('ANIM', 'ascii'), Buffer.from([6, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
    assert.equal(inspecionar(montarWebp(0, [imagem])).largura, 400);
    assert.throws(() => inspecionar(montarWebp(0x02, [imagem])), recusaCom(CODIGO.ANIMADA));
    assert.throws(() => inspecionar(montarWebp(0, [imagem, anim])), recusaCom(CODIGO.ANIMADA));
    assert.throws(() => inspecionar(montarWebp(0, [Buffer.from('JUNK\0\0\0\0', 'latin1')])), recusaCom(CODIGO.INVALIDA));
  });

  test('IC-21 — assinatura escondida DENTRO de um pedaço auxiliar (antes do fim) não é carga extra: o arquivo é aceito e a recodificação remove o pedaço', async () => {
    const png = F.inserirPedacoPng(await F.png(400, 320), 'tEXt', Buffer.from('Comment\0<script>alert(1)</script>PK\x03\x04', 'latin1'));
    const r = inspecionar(png);
    assert.deepEqual([r.formato, r.bytesExtras], ['PNG', 0]);
  });
});

describe('inspecionarContainer — robustez e mensagens', () => {
  test('IC-22 — qualquer prefixo de arquivos reais termina em resultado ou ErroDeImagem; nunca em RangeError, loop ou outra exceção', async () => {
    const reais = [await F.png(400, 320), await F.jpeg(400, 320), await F.webp(400, 320), await F.webp(400, 320, { exif: true, icc: 'p3' })];
    const M = modulo();
    for (const arquivo of reais) {
      const cortes = new Set();
      for (let n = 0; n <= Math.min(arquivo.length, 300); n += 1) cortes.add(n);
      for (let n = 300; n < arquivo.length; n += Math.max(1, Math.floor(arquivo.length / 60))) cortes.add(n);
      for (const n of cortes) {
        try { inspecionar(arquivo.subarray(0, n)); } catch (erro) { assert.ok(erro instanceof M.ErroDeImagem, `corte ${n}: ${erro?.name}: ${erro?.message}`); }
      }
    }
  });

  test('IC-23 — byte corrompido no cabeçalho (300 mutações determinísticas) termina em resultado ou ErroDeImagem, rápido', async () => {
    const M = modulo();
    const reais = [await F.png(400, 320), await F.jpeg(400, 320), await F.webp(400, 320)];
    const aleat = F.aleatorio(2000, 777);
    const t0 = Date.now();
    for (let i = 0; i < 300; i += 1) {
      const arquivo = Buffer.from(reais[i % 3]);
      for (let k = 0; k < 1 + (i % 3); k += 1) arquivo[aleat.readUInt16LE((i * 6 + k * 2) % 1990) % Math.min(arquivo.length, 200)] ^= (aleat[(i + k) % 2000] | 1);
      try { inspecionar(arquivo); } catch (erro) { assert.ok(erro instanceof M.ErroDeImagem, `mutação ${i}: ${erro?.name}: ${erro?.message}`); }
    }
    assert.ok(Date.now() - t0 < 3000, 'sem laço longo');
  });

  test('IC-24 — nenhuma mensagem de erro leva byte do envio (VAL-08): a mensagem é fixa por código', async () => {
    const M = modulo();
    const marcador = 'MARCADOR-SECRETO-9f3a';
    const entradas = [Buffer.from(marcador), Buffer.concat([F.ASSINATURA_PNG, Buffer.from(marcador)]), Buffer.concat([await F.png(400, 320), Buffer.from(`<script>${marcador}</script>`)]),
      F.apng(await F.png(400, 320)), F.pngComDimensoesDeclaradas(60000, 60000), F.truncar(await F.jpeg(400, 320), 0.5)];
    for (const entrada of entradas) {
      try { inspecionar(entrada); assert.fail('deveria recusar'); } catch (erro) {
        assert.ok(erro instanceof M.ErroDeImagem);
        assert.ok(!erro.message.includes(marcador) && !String(erro.stack).includes(marcador), 'sem eco do envio');
        assert.equal(erro.message, M.ErroDeImagem.mensagemDe(erro.codigo));
      }
    }
  });

  test('IC-25 — ErroDeImagem: é Error, tem código estável, nome e mensagem fixos; os códigos cobrem os quatro públicos e os dois novos', () => {
    const M = modulo();
    const erro = new M.ErroDeImagem('IMAGEM_INVALIDA');
    assert.ok(erro instanceof Error);
    assert.deepEqual([erro.name, erro.codigo], ['ErroDeImagem', 'IMAGEM_INVALIDA']);
    assert.deepEqual(Object.values(M.CODIGOS).sort(), ['IMAGEM_ANIMADA_NAO_SUPORTADA', 'IMAGEM_DIMENSOES_INVALIDAS', 'IMAGEM_FORMATO_NAO_SUPORTADO', 'IMAGEM_INVALIDA', 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO', 'IMAGEM_SAIDA_EXCEDE_LIMITE']);
    assert.throws(() => new M.ErroDeImagem('CODIGO_QUE_NAO_EXISTE'), TypeError);
    assert.equal(Object.isFrozen(M.CODIGOS), true);
  });

  test('IC-26 — estruturas patológicas de 2 MiB (175 mil pedaços PNG, 2 milhões de bytes 0xFF00 num JPEG, 260 mil blocos WebP) são percorridas em tempo linear', async () => {
    const pedaco = (tipo) => Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from(tipo, 'ascii'), Buffer.alloc(4)]);
    const base = await F.png(400, 320);
    const ihdrFim = 8 + 12 + 13;
    const tantosPedacos = Buffer.concat([base.subarray(0, ihdrFim), ...Array.from({ length: 170000 }, () => pedaco('tEXt')), base.subarray(ihdrFim)]);
    const jpegBase = await F.jpeg(400, 320);
    const iniciaVarredura = jpegBase.indexOf(Buffer.from([0xff, 0xda]));
    const tamanhoCabecalhoSos = jpegBase.readUInt16BE(iniciaVarredura + 2);
    const jpegPatologico = Buffer.concat([jpegBase.subarray(0, iniciaVarredura + 2 + tamanhoCabecalhoSos), Buffer.from(Array.from({ length: 1000000 }, (_, i) => (i % 2 === 0 ? 0xff : 0x00))), Buffer.from([0xff, 0xd9])]);
    const webpBase = await F.webp(400, 320);
    const vp8x = Buffer.concat([Buffer.from('VP8X', 'ascii'), Buffer.from([10, 0, 0, 0, 0, 0, 0, 0, 0x8f, 0x01, 0x00, 0x3f, 0x01, 0x00])]);
    const junk = Buffer.from('JUNK\0\0\0\0', 'latin1');
    const restoWebp = webpBase.subarray(12);
    const miolo = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8x, ...Array.from({ length: 250000 }, () => junk), restoWebp]);
    const tamanhoRiff = Buffer.alloc(4);
    tamanhoRiff.writeUInt32LE(miolo.length);
    const webpPatologico = Buffer.concat([Buffer.from('RIFF', 'ascii'), tamanhoRiff, miolo]);
    for (const [nome, arquivo] of [['png', tantosPedacos], ['jpeg', jpegPatologico], ['webp', webpPatologico]]) {
      const t0 = process.hrtime.bigint();
      try { inspecionar(arquivo); } catch (erro) { assert.ok(erro instanceof modulo().ErroDeImagem, `${nome}: ${erro?.name}: ${erro?.message}`); }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 1500, `${nome}: ${ms.toFixed(0)} ms para ${arquivo.length} bytes`);
    }
    assert.equal(inspecionar(tantosPedacos).formato, 'PNG');
  });
});
