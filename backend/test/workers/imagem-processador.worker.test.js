'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const F = require('../helpers/imagens-reais');

/**
 * Biblioteca de Imagens, Unidade 5C-4 — O PIPELINE DO PROCESSADOR (src/workers/imagem-processador.worker.js), executado AQUI no mesmo processo para medir o que ele produz
 * e recusa. O que ele é: bytes do envio → mestre PNG 1024x1024, exibição WebP 640x640 e miniatura WebP 320x320 (fundo transparente, proporção preservada, sem ampliar,
 * sem metadados, sRGB, orientação aplicada). Contratos: VAL-01 a VAL-08 do Documento 14, VAL-10 (tempo) e VAL-11 (tetos) do Documento 56 e a decisão D-C5 do Documento 59.
 * Os mesmos casos passam também pelo processo filho real em imagem-processador.service.test.js.
 */

const MIB = 1024 * 1024;
const carregar = (caminho, trecho) => {
  try { return require(caminho); } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && String(erro.message).includes(trecho)) throw new Error(`módulo ainda não implementado: ${caminho}`);
    throw erro;
  }
};
const servico = () => carregar('../../src/services/imagem-processador.service', 'imagem-processador.service');
const worker = () => carregar('../../src/workers/imagem-processador.worker', 'imagem-processador.worker');
const container = () => carregar('../../src/utils/imagem-container', 'imagem-container');
const parametros = (sobrescritas) => servico().parametrosDoProcessamento(undefined, sobrescritas);
const processar = (bytes, sobrescritas) => worker().processarImagem(bytes, parametros(sobrescritas));
const teste = (nome, fn) => test(nome, { timeout: 60000 }, fn);
const recusaCom = (codigo) => (erro) => {
  assert.ok(erro instanceof container().ErroDeImagem, `esperava ErroDeImagem e veio ${erro?.name}: ${erro?.message}`);
  assert.equal(erro.codigo, codigo);
  return true;
};
const CODIGO = Object.freeze({
  FORMATO: 'IMAGEM_FORMATO_NAO_SUPORTADO', ANIMADA: 'IMAGEM_ANIMADA_NAO_SUPORTADA', INVALIDA: 'IMAGEM_INVALIDA', DIMENSOES: 'IMAGEM_DIMENSOES_INVALIDAS',
  TEMPO: 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO', SAIDA: 'IMAGEM_SAIDA_EXCEDE_LIMITE',
});
const SEGREDOS = [F.SEGREDOS.copyright, F.SEGREDOS.xmp, F.SEGREDOS.iptc, F.SEGREDOS.comentario, 'CameraSecreta'];

/** Onde o conteúdo deve cair na tela quadrada de lado `lado`: nunca ampliado, centralizado, proporção intacta. */
function esperado(l, a, lado) {
  const esc = Math.min(1, lado / l, lado / a);
  const w = Math.round(l * esc);
  const h = Math.round(a * esc);
  return { w, h, x0: Math.floor((lado - w) / 2), y0: Math.floor((lado - h) / 2) };
}
const perto = (obtido, alvo, tol, rotulo) => assert.ok(Math.abs(obtido - alvo) <= tol, `${rotulo}: obtido ${obtido}, esperado ${alvo} ± ${tol}`);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const nomeDaCor = (px) => Object.entries({ R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255], Y: [255, 255, 0] }).sort((x, y) => dist(px, x[1]) - dist(px, y[1]))[0][0];
/** Cor (R, G, B, Y) no centro de cada quarto do conteúdo opaco: topo-esq, topo-dir, base-esq, base-dir. */
async function arranjo(arquivo) {
  const b = await F.caixaOpaca(arquivo, 8);
  const pontos = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  const cores = await Promise.all(pontos.map(async ([fx, fy]) => nomeDaCor(await F.pixel(arquivo, Math.floor(b.x0 + fx * b.largura), Math.floor(b.y0 + fy * b.altura)))));
  return { texto: cores.join(''), caixa: b };
}

describe('processarImagem — o conjunto de saída (D-C5)', () => {
  teste('PRW-01 — PNG, JPEG e WebP válidos viram: mestre PNG 1024x1024, exibição WebP 640x640 e miniatura WebP 320x320, dentro dos tetos', async () => {
    for (const entrada of [await F.png(640, 480), await F.jpeg(640, 480), await F.webp(640, 480)]) {
      const r = await processar(entrada);
      assert.deepEqual(Object.keys(r).sort(), ['altura', 'exibicao', 'formato', 'largura', 'mestre', 'miniatura']);
      assert.deepEqual([r.formato, r.largura, r.altura], ['PNG', 1024, 1024]);
      const [mm, me, mi] = await Promise.all([F.metadados(r.mestre), F.metadados(r.exibicao), F.metadados(r.miniatura)]);
      assert.deepEqual([mm.format, mm.width, mm.height, mm.hasAlpha], ['png', 1024, 1024, true]);
      assert.deepEqual([me.format, me.width, me.height, me.hasAlpha], ['webp', 640, 640, true]);
      assert.deepEqual([mi.format, mi.width, mi.height, mi.hasAlpha], ['webp', 320, 320, true]);
      for (const variante of [r.mestre, r.exibicao, r.miniatura]) assert.ok(Buffer.isBuffer(variante) && variante.length > 0);
      assert.ok(r.mestre.length <= 4 * MIB && r.exibicao.length <= 512 * 1024 && r.miniatura.length <= 65536);
    }
  });

  teste('PRW-02 — proporção preservada, centralizado e SEM AMPLIAR (D-C5, config.ampliar = false): imagem menor que a tela não é esticada; maior é reduzida', async () => {
    for (const [l, a] of [[400, 320], [2000, 1000], [1000, 2000], [320, 320], [1100, 1100], [4000, 2000], [700, 500]]) {
      const r = await processar(await F.png(l, a));
      for (const [arquivo, lado, tol] of [[r.mestre, 1024, 2], [r.exibicao, 640, 2], [r.miniatura, 320, 2]]) {
        const e = esperado(l, a, lado);
        const b = await F.caixaOpaca(arquivo, 8);
        perto(b.largura, e.w, tol, `${l}x${a} em ${lado}: largura`);
        perto(b.altura, e.h, tol, `${l}x${a} em ${lado}: altura`);
        perto(b.x0, e.x0, tol, `${l}x${a} em ${lado}: x0`);
        perto(b.y0, e.y0, tol, `${l}x${a} em ${lado}: y0`);
        assert.ok(Math.abs(b.largura / b.altura - l / a) < 0.02, `${l}x${a} em ${lado}: proporção ${b.largura}/${b.altura}`);
      }
    }
  });

  teste('PRW-03 — transparência: faixa transparente continua transparente, opaca continua opaca, meio-transparente fica meio-transparente; o preenchimento é transparente', async () => {
    const r = await processar(await F.png(600, 320, { padrao: 'alfa' }));
    const em = async (arquivo, x, y) => F.pixel(arquivo, x, y);
    // mestre: conteúdo 600x320 em (212, 352)
    assert.equal((await em(r.mestre, 312, 512))[3], 0);
    const opaco = await em(r.mestre, 512, 512);
    assert.deepEqual(opaco.slice(0, 3).map((v, i) => Math.abs(v - [10, 200, 10][i]) <= 2), [true, true, true]);
    assert.equal(opaco[3], 255);
    const meio = await em(r.mestre, 712, 512);
    perto(meio[3], 128, 2, 'alfa do terço direito');
    assert.ok(dist(meio, [200, 10, 200]) <= 6, `cor do terço direito ${meio}`);
    assert.equal((await em(r.mestre, 50, 50))[3], 0, 'canto da tela');
    assert.equal((await em(r.mestre, 512, 100))[3], 0, 'acima do conteúdo');
    // exibição: conteúdo 600x320 em (20, 160)
    assert.equal((await em(r.exibicao, 120, 320))[3], 0);
    assert.equal((await em(r.exibicao, 320, 320))[3], 255);
    perto((await em(r.exibicao, 520, 320))[3], 128, 8, 'alfa do terço direito (WebP)');
    assert.equal((await em(r.exibicao, 320, 40))[3], 0);
    // miniatura: conteúdo 320x160 em (0, 80)
    assert.equal((await em(r.miniatura, 53, 160))[3], 0);
    assert.equal((await em(r.miniatura, 160, 160))[3], 255);
    perto((await em(r.miniatura, 267, 160))[3], 128, 8, 'alfa do terço direito (miniatura)');
    assert.equal((await em(r.miniatura, 160, 20))[3], 0);
  });

  teste('PRW-04 — JPEG opaco: o conteúdo sai opaco e o preenchimento sai transparente nas três variantes', async () => {
    const r = await processar(await F.jpeg(500, 320));
    for (const [arquivo, lado] of [[r.mestre, 1024], [r.exibicao, 640], [r.miniatura, 320]]) {
      assert.equal((await F.pixel(arquivo, lado / 2, lado / 2))[3], 255, `centro ${lado}`);
      assert.equal((await F.pixel(arquivo, 2, 2))[3], 0, `canto ${lado}`);
      assert.equal((await F.pixel(arquivo, lado / 2, 2))[3], 0, `topo ${lado}`);
    }
  });

  teste('PRW-05 — variedade real de PNG, JPEG e WebP é aceita: paleta, cinza, 16 bits, entrelaçado, JPEG progressivo, em cinza e CMYK, WebP sem perda', async () => {
    const base = (l = 500, a = 400) => sharp(F.pixelsBrutos(l, a), { raw: { width: l, height: a, channels: 4 } });
    const amostras = {
      'PNG paleta': await base().png({ palette: true }).toBuffer(),
      'PNG cinza': await base().flatten({ background: '#fff' }).toColourspace('b-w').png().toBuffer(),
      'PNG 16 bits': await base().toColourspace('rgb16').png().toBuffer(),
      'PNG entrelaçado': await base().png({ progressive: true }).toBuffer(),
      'JPEG progressivo': await base().flatten({ background: '#fff' }).jpeg({ progressive: true }).toBuffer(),
      'JPEG cinza': await base().flatten({ background: '#fff' }).toColourspace('b-w').jpeg().toBuffer(),
      'JPEG CMYK': await F.jpeg(500, 400, { cmyk: true }),
      'WebP sem perda': await base().webp({ lossless: true }).toBuffer(),
    };
    for (const [nome, arquivo] of Object.entries(amostras)) {
      const r = await processar(arquivo);
      const [mm, me, mi] = await Promise.all([F.metadados(r.mestre), F.metadados(r.exibicao), F.metadados(r.miniatura)]);
      assert.deepEqual([mm.format, mm.width, mm.height, mm.space], ['png', 1024, 1024, 'srgb'], nome);
      assert.deepEqual([me.format, me.width, me.height, mi.format, mi.width, mi.height], ['webp', 640, 640, 'webp', 320, 320], nome);
    }
  });
});

describe('processarImagem — metadados, orientação e cor (VAL-06)', () => {
  teste('PRW-06 — EXIF com GPS, XMP, ICC, IPTC e comentários somem das TRÊS variantes, nos três formatos', async () => {
    const entradas = {
      jpeg: F.inserirSegmentoJpeg(F.inserirSegmentoJpeg(await F.jpeg(500, 400, { exif: true, xmp: true, icc: 'p3' }), 0xed, F.iptcApp13()), 0xfe, Buffer.from(F.SEGREDOS.comentario)),
      png: F.inserirPedacoPng(await F.png(500, 400, { exif: true, xmp: true, icc: 'p3' }), 'tEXt', Buffer.from(`Comment\0${F.SEGREDOS.comentario}`, 'latin1')),
      webp: await F.webp(500, 400, { exif: true, xmp: true, icc: 'p3' }),
    };
    for (const [nome, entrada] of Object.entries(entradas)) {
      const r = await processar(entrada);
      for (const [rotulo, arquivo] of [['mestre', r.mestre], ['exibicao', r.exibicao], ['miniatura', r.miniatura]]) {
        const m = await F.metadados(arquivo);
        assert.deepEqual([m.exif, m.xmp, m.icc, m.iptc, m.tifftagPhotoshop], [undefined, undefined, undefined, undefined, undefined], `${nome}/${rotulo}`);
        for (const segredo of SEGREDOS) assert.ok(!arquivo.includes(Buffer.from(segredo)), `${nome}/${rotulo}: "${segredo}" não pode aparecer`);
      }
      const proibidosPng = ['eXIf', 'iCCP', 'tEXt', 'iTXt', 'zTXt', 'tIME'];
      assert.deepEqual(F.pedacosPng(r.mestre).filter((c) => proibidosPng.includes(c)), [], `${nome}: pedaços do PNG`);
      for (const arquivo of [r.exibicao, r.miniatura]) assert.deepEqual(F.pedacosWebp(arquivo).filter((c) => ['EXIF', 'XMP ', 'ICCP'].includes(c)), [], `${nome}: pedaços do WebP`);
    }
  });

  teste('PRW-07 — a orientação EXIF é APLICADA antes de gerar as variantes (JPEG, WebP e PNG; orientações 1, 3, 6 e 8): o arranjo das cores e as medidas confirmam', async () => {
    const ESPERADO = { 1: 'RGBY', 3: 'YBGR', 6: 'BRYG', 8: 'GYRB' };
    for (const formato of ['jpeg', 'webp', 'png']) {
      for (const [orientacao, texto] of Object.entries(ESPERADO)) {
        const r = await processar(await F.codificar(480, 360, { formato, orientacao: Number(orientacao) }));
        const trocou = orientacao === '6' || orientacao === '8';
        for (const [rotulo, arquivo, lado] of [['mestre', r.mestre, 1024], ['exibicao', r.exibicao, 640], ['miniatura', r.miniatura, 320]]) {
          const { texto: obtido, caixa } = await arranjo(arquivo);
          assert.equal(obtido, texto, `${formato} orientação ${orientacao} ${rotulo}`);
          const e = esperado(trocou ? 360 : 480, trocou ? 480 : 360, lado);
          perto(caixa.largura, e.w, 2, `${formato} ${orientacao} ${rotulo}: largura`);
          perto(caixa.altura, e.h, 2, `${formato} ${orientacao} ${rotulo}: altura`);
        }
      }
    }
  });

  teste('PRW-08 — sRGB: o perfil P3 incorporado é CONVERTIDO (não só apagado) e o CMYK vira sRGB; nenhuma variante leva perfil', async () => {
    const p3 = await F.png(320, 320, { padrao: 'solido', icc: 'p3' });
    const gravado = await sharp(p3, { ignoreIcc: true }).ensureAlpha().raw().toBuffer();
    const r = await processar(p3);
    const centro = await F.pixel(r.mestre, 512, 512);
    assert.ok(dist(centro, [200, 50, 50]) <= 4, `o vermelho sRGB original volta: ${centro}`);
    assert.ok(dist(centro, [gravado[0], gravado[1], gravado[2]]) >= 8, 'não é o valor cru gravado no arquivo P3');
    for (const arquivo of [r.mestre, r.exibicao, r.miniatura]) assert.equal((await F.metadados(arquivo)).icc, undefined);
    assert.equal((await F.metadados(r.mestre)).space, 'srgb');
    const cmyk = await processar(await F.jpeg(500, 400, { cmyk: true, padrao: 'solido' }));
    const m = await F.metadados(cmyk.mestre);
    assert.deepEqual([m.space, m.icc], ['srgb', undefined]);
    const px = await F.pixel(cmyk.mestre, 512, 512);
    assert.ok(px[0] > 150 && px[1] < 120 && px[2] < 120, `vermelho continua vermelho depois do CMYK: ${px}`);
  });
});

describe('processarImagem — formatos recusados (VAL-01, VAL-02)', () => {
  const NAO_ACEITOS = {
    vazio: () => Buffer.alloc(0), texto: () => F.texto(), aleatório: () => F.aleatorio(4000), SVG: () => F.svg(), HTML: () => F.html(), PDF: () => F.pdf(), ZIP: () => F.zip(),
    ELF: () => F.elf(), EXE: () => F.exe(), BMP: () => F.bmp(), HEIC: () => F.heic(),
  };
  for (const [nome, fabricar] of Object.entries(NAO_ACEITOS)) {
    teste(`PRW-09 — ${nome} → IMAGEM_FORMATO_NAO_SUPORTADO`, async () => {
      await assert.rejects(processar(fabricar()), recusaCom(CODIGO.FORMATO));
    });
  }

  teste('PRW-10 — GIF, TIFF e AVIF reais → IMAGEM_FORMATO_NAO_SUPORTADO', async () => {
    for (const arquivo of [await F.gif(), await F.tiff(), await F.avif()]) await assert.rejects(processar(arquivo), recusaCom(CODIGO.FORMATO));
  });

  teste('PRW-11 — animadas → IMAGEM_ANIMADA_NAO_SUPORTADA: APNG e WebP animado', async () => {
    await assert.rejects(processar(F.apng(await F.png(400, 320))), recusaCom(CODIGO.ANIMADA));
    await assert.rejects(processar(await F.webpAnimado(320)), recusaCom(CODIGO.ANIMADA));
  });
});

describe('processarImagem — dimensões (VAL-04)', () => {
  teste('PRW-12 — lado fora de [320, 4096] e mais de 8.388.608 pixels → IMAGEM_DIMENSOES_INVALIDAS, em arquivos reais', async () => {
    for (const [l, a] of [[319, 400], [400, 319], [4097, 400], [400, 4097]]) await assert.rejects(processar(await F.png(l, a)), recusaCom(CODIGO.DIMENSOES), `${l}x${a}`);
    await assert.rejects(processar(await F.pngDePixelsEnormes(3000, 2800)), recusaCom(CODIGO.DIMENSOES));
    await assert.rejects(processar(await F.pngDePixelsEnormes(4096, 4096)), recusaCom(CODIGO.DIMENSOES));
  });

  teste('PRW-13 — a bomba de pixels e a dimensão gigante declarada são recusadas pelo cabeçalho, em milissegundos, sem decodificar', async () => {
    const t0 = process.hrtime.bigint();
    await assert.rejects(processar(await F.pngDePixelsEnormes(3000, 2800)), recusaCom(CODIGO.DIMENSOES));
    for (const gigante of [F.pngComDimensoesDeclaradas(60000, 60000), F.jpegComDimensoesDeclaradas(65535, 65535), F.webpComDimensoesDeclaradas(16384, 16384)]) {
      await assert.rejects(processar(gigante), recusaCom(CODIGO.DIMENSOES));
    }
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1500, 'sem decodificar nada');
  });

  teste('PRW-14 — o limite de pixels vem dos parâmetros (não de constante escondida): com o teto reduzido, uma imagem comum passa a ser recusada', async () => {
    const arquivo = await F.png(400, 320);
    await processar(arquivo);
    await assert.rejects(processar(arquivo, { pixelsMax: 100000 }), recusaCom(CODIGO.DIMENSOES));
    await assert.rejects(processar(arquivo, { ladoMin: 500 }), recusaCom(CODIGO.DIMENSOES));
  });

  teste('PRW-15 — a entrada acima do tamanho máximo é recusada sem ser decodificada (IMAGEM_INVALIDA)', async () => {
    const arquivo = await F.png(400, 320);
    await assert.rejects(processar(arquivo, { entradaMaxBytes: arquivo.length - 1 }), recusaCom(CODIGO.INVALIDA));
    await processar(arquivo, { entradaMaxBytes: arquivo.length });
  });
});

describe('processarImagem — truncadas, corrompidas e estritas (VAL-03)', () => {
  teste('PRW-16 — PNG, JPEG e WebP cortados, e assinatura seguida de lixo → IMAGEM_INVALIDA', async () => {
    const reais = [await F.png(500, 400, { padrao: 'ruido' }), await F.jpeg(500, 400, { padrao: 'ruido' }), await F.webp(500, 400, { padrao: 'ruido' })];
    for (const arquivo of reais) for (const fracao of [0.4, 0.8]) await assert.rejects(processar(F.truncar(arquivo, fracao)), recusaCom(CODIGO.INVALIDA));
    await assert.rejects(processar(Buffer.concat([F.ASSINATURA_PNG, F.aleatorio(500)])), recusaCom(CODIGO.INVALIDA));
    await assert.rejects(processar(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), F.aleatorio(500)])), recusaCom(CODIGO.INVALIDA));
  });

  teste('PRW-17 — PNG com CRC do IDAT corrompido (estrutura íntegra, dados ruins) → IMAGEM_INVALIDA: o erro da leitura vira recusa pública, sem a mensagem do libvips', async () => {
    const ruim = F.pngComCrcCorrompido(await F.png(400, 320, { padrao: 'ruido' }));
    await assert.rejects(processar(ruim), (erro) => { recusaCom(CODIGO.INVALIDA)(erro); assert.ok(!/png|vips/i.test(erro.message)); return true; });
  });

  teste('PRW-18 — failOn "warning" está LIGADO: um JPEG cortado e fechado com EOI, que o libvips aceitaria com failOn "error", é recusado (IMAGEM_INVALIDA)', async () => {
    const cortado = F.jpegCortadoComEoi(await F.jpeg(400, 320, { padrao: 'ruido' }));
    await sharp(cortado, { failOn: 'error' }).raw().toBuffer();
    await assert.rejects(processar(cortado), recusaCom(CODIGO.INVALIDA));
  });
});

describe('processarImagem — carga depois do fim do arquivo (VAL-05)', () => {
  teste('PRW-19 — carga benigna depois do fim é aceita e NÃO chega a nenhuma variante; carga com assinatura de arquivo ativo é recusada', async () => {
    const marcador = Buffer.from('LIXO-BENIGNO-QUE-NAO-PODE-SAIR');
    for (const base of [await F.png(400, 320), await F.jpeg(400, 320), await F.webp(400, 320)]) {
      const r = await processar(Buffer.concat([base, marcador, F.aleatorio(200, 5)]));
      for (const arquivo of [r.mestre, r.exibicao, r.miniatura]) assert.ok(!arquivo.includes(marcador));
      for (const perigosa of [F.zip(), F.pdf(), F.html(), F.elf()]) await assert.rejects(processar(Buffer.concat([base, perigosa])), recusaCom(CODIGO.FORMATO));
    }
  });

  teste('PRW-20 — carga escondida em pedaço auxiliar (tEXt com script) é aceita e removida: o mestre sai sem o pedaço', async () => {
    const entrada = F.inserirPedacoPng(await F.png(400, 320), 'tEXt', Buffer.from('Comment\0<script>alert(1)</script>', 'latin1'));
    const r = await processar(entrada);
    for (const arquivo of [r.mestre, r.exibicao, r.miniatura]) assert.ok(!arquivo.includes(Buffer.from('<script>')));
  });
});

describe('processarImagem — tetos de saída (VAL-11) e qualidade adaptativa', () => {
  teste('PRW-21 — saída acima do teto é recusada de forma controlada (IMAGEM_SAIDA_EXCEDE_LIMITE), para cada variante', async () => {
    const arquivo = await F.png(500, 400, { padrao: 'ruido' });
    await assert.rejects(processar(arquivo, { mestre: { bytesMax: 1000 } }), recusaCom(CODIGO.SAIDA));
    await assert.rejects(processar(arquivo, { exibicao: { bytesMax: 1000 } }), recusaCom(CODIGO.SAIDA));
    await assert.rejects(processar(arquivo, { miniatura: { bytesMax: 300 } }), recusaCom(CODIGO.SAIDA));
  });

  teste('PRW-22 — a miniatura de uma imagem ruidosa cabe nos 64 KiB baixando a qualidade, em vez de ser recusada', async () => {
    const r = await processar(await F.png(320, 320, { padrao: 'ruido' }));
    assert.ok(r.miniatura.length <= 65536, `miniatura ${r.miniatura.length}`);
    assert.ok(r.miniatura.length > 30000, 'continua sendo uma imagem de verdade');
  });

  teste('PRW-23 — a exibição respeita o teto dos parâmetros baixando a qualidade; sem fôlego, recusa', async () => {
    const arquivo = await F.png(640, 640, { padrao: 'ruido' });
    const folgado = await processar(arquivo);
    const apertado = await processar(arquivo, { exibicao: { bytesMax: 280000 } });
    assert.ok(folgado.exibicao.length > 280000, `sem aperto: ${folgado.exibicao.length}`);
    assert.ok(apertado.exibicao.length <= 280000 && apertado.exibicao.length > 150000, `com aperto: ${apertado.exibicao.length}`);
    await assert.rejects(processar(arquivo, { exibicao: { bytesMax: 100000 } }), recusaCom(CODIGO.SAIDA));
  });
});

describe('processarImagem — controles do sharp (limites, lista de carregadores, tempo)', () => {
  teste('PRW-24 — a entrada do sharp é aberta com os controles aprovados: failOn warning, limitInputPixels, canais, sem modo ilimitado, leitura sequencial, uma página, orientação automática e tempo', () => {
    const p = parametros();
    const instancia = worker().abrirEntrada(sharp, Buffer.alloc(16), p);
    assert.deepEqual(
      { ...Object.fromEntries(['failOn', 'limitInputPixels', 'limitInputChannels', 'unlimited', 'sequentialRead', 'autoOrient', 'pages'].map((k) => [k, instancia.options.input[k]])), timeout: instancia.options.timeoutSeconds },
      { failOn: 'warning', limitInputPixels: p.pixelsMax, limitInputChannels: 4, unlimited: false, sequentialRead: true, autoOrient: true, pages: 1, timeout: p.timeoutSegundos },
    );
    assert.equal(p.pixelsMax, 8388608);
    assert.equal(p.timeoutSegundos, 10);
  });

  teste('PRW-25 — configurarSharp: lista restrita de carregadores (PNG, JPEG e WebP reais passam; GIF, TIFF, AVIF e SVG são recusados pelo libvips), um fio, sem cache; é idempotente', async () => {
    const gif = await F.gif();
    const tiff = await F.tiff();
    const avif = await F.avif();
    const reais = [await F.png(64, 48), await F.jpeg(64, 48), await F.webp(64, 48)];
    worker().configurarSharp(sharp);
    worker().configurarSharp(sharp);
    for (const arquivo of reais) await sharp(arquivo).resize(8, 8).png().toBuffer();
    for (const arquivo of [gif, tiff, avif, F.svg()]) await assert.rejects(sharp(arquivo).metadata(), /unsupported image format/i);
    assert.equal(sharp.concurrency(), 1);
    assert.equal(sharp.cache().memory.max, 0);
  });

  teste('PRW-26 — classificarFalhaDoSharp: erro de tempo vira TEMPO; limite de pixels vira DIMENSOES; erro de leitura vira INVALIDA; ErroDeImagem passa como está', () => {
    const { classificarFalhaDoSharp } = worker();
    const { ErroDeImagem } = container();
    assert.equal(classificarFalhaDoSharp(new Error('timeout: 42% complete\nVipsImage: killed')).codigo, CODIGO.TEMPO);
    assert.equal(classificarFalhaDoSharp(new Error('Input image exceeds pixel limit')).codigo, CODIGO.DIMENSOES);
    assert.equal(classificarFalhaDoSharp(new Error('vipspng: libpng read error')).codigo, CODIGO.INVALIDA);
    assert.equal(classificarFalhaDoSharp(new Error('VipsJpeg: Corrupt JPEG data')).codigo, CODIGO.INVALIDA);
    const proprio = new ErroDeImagem(CODIGO.ANIMADA);
    assert.equal(classificarFalhaDoSharp(proprio), proprio);
    assert.ok(classificarFalhaDoSharp(new Error('qualquer')) instanceof ErroDeImagem);
  });

  teste('PRW-27 — o erro de tempo que o sharp 0.35.5 REALMENTE devolve é reconhecido pela classificação (pipeline lento de verdade, 1 s de limite)', async () => {
    const bruto = Buffer.alloc(4000 * 2000 * 4, 120);
    const erro = await sharp(bruto, { raw: { width: 4000, height: 2000, channels: 4 } }).blur(250).timeout({ seconds: 1 }).png().toBuffer().then(() => null, (e) => e);
    assert.ok(erro, 'o pipeline pesado precisava estourar o tempo');
    assert.equal(worker().classificarFalhaDoSharp(erro).codigo, CODIGO.TEMPO);
  });
});

describe('processarImagem — parâmetros, mensagens e verificação da saída', () => {
  teste('PRW-28 — lerParametros: texto JSON estrito; chave desconhecida, número fora de faixa, tipo errado ou JSON ruim → TypeError', () => {
    const { lerParametros } = worker();
    const bons = JSON.stringify(parametros());
    assert.deepEqual(lerParametros(bons), parametros());
    const objeto = JSON.parse(bons);
    const variacoes = {
      'JSON ruim': '{', 'não é objeto': '[]', 'chave extra': JSON.stringify({ ...objeto, extra: 1 }), 'sem chave': JSON.stringify({ ...objeto, pixelsMax: undefined }),
      'pixelsMax como texto': JSON.stringify({ ...objeto, pixelsMax: '8388608' }), 'timeout zero': JSON.stringify({ ...objeto, timeoutSegundos: 0 }),
      'timeout enorme': JSON.stringify({ ...objeto, timeoutSegundos: 100000 }), 'lado do mestre negativo': JSON.stringify({ ...objeto, mestre: { ...objeto.mestre, lado: -1 } }),
      'seção com chave extra': JSON.stringify({ ...objeto, exibicao: { ...objeto.exibicao, formato: 'png' } }), 'ladoMin maior que ladoMax': JSON.stringify({ ...objeto, ladoMin: 5000 }),
    };
    for (const [nome, texto] of Object.entries(variacoes)) assert.throws(() => lerParametros(texto), TypeError, nome);
    assert.throws(() => lerParametros(undefined), TypeError);
  });

  teste('PRW-29 — processarImagem recusa argumentos errados como erro de programação (TypeError), nunca como recusa de imagem', async () => {
    await assert.rejects(worker().processarImagem('texto', parametros()), TypeError);
    await assert.rejects(worker().processarImagem(new Uint8Array(10), parametros()), TypeError);
    await assert.rejects(worker().processarImagem(await F.png(400, 320), { ...parametros(), extra: 1 }), TypeError);
    await assert.rejects(worker().processarImagem(await F.png(400, 320)), TypeError);
  });

  teste('PRW-30 — nenhuma recusa leva byte do envio nem mensagem do libvips (VAL-08): as mensagens são fixas por código', async () => {
    const marcador = 'MARCADOR-SECRETO-77aa';
    const entradas = [Buffer.from(marcador), Buffer.concat([await F.png(400, 320), Buffer.from(`<script>${marcador}</script>`)]), F.pngComCrcCorrompido(await F.png(400, 320)),
      F.truncar(await F.jpeg(400, 320), 0.5), F.apng(await F.png(400, 320)), F.jpegCortadoComEoi(await F.jpeg(400, 320))];
    for (const entrada of entradas) {
      const erro = await processar(entrada).then(() => null, (e) => e);
      assert.ok(erro instanceof container().ErroDeImagem, String(erro?.message));
      assert.ok(!erro.message.includes(marcador) && !String(erro.stack).includes(marcador));
      assert.equal(erro.message, container().ErroDeImagem.mensagemDe(erro.codigo));
    }
  });

  teste('PRW-31 — verificarSaida aceita a saída correta e recusa (como defeito interno) medidas, formato, metadados ou carga fora do contrato; teto estourado vira recusa pública', async () => {
    const { verificarSaida } = worker();
    const ok = await processar(await F.png(400, 320));
    const contrato = { mestre: { formato: 'png', lado: 1024 }, exibicao: { formato: 'webp', lado: 640 }, miniatura: { formato: 'webp', lado: 320 } };
    await verificarSaida(ok.mestre, { ...contrato.mestre, bytesMax: 4 * MIB });
    await verificarSaida(ok.exibicao, { ...contrato.exibicao, bytesMax: 512 * 1024 });
    await verificarSaida(ok.miniatura, { ...contrato.miniatura, bytesMax: 65536 });
    const defeituoso = (promessa) => assert.rejects(promessa, (e) => { assert.equal(e.codigo, 'IMAGEM_FILHO_SAIDA_INVALIDA'); assert.ok(!(e instanceof container().ErroDeImagem)); return true; });
    await defeituoso(verificarSaida(await sharp({ create: { width: 1000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(), { ...contrato.mestre, bytesMax: 4 * MIB }));
    await defeituoso(verificarSaida(ok.exibicao, { ...contrato.mestre, bytesMax: 4 * MIB }));
    await defeituoso(verificarSaida(F.inserirPedacoPng(ok.mestre, 'tEXt', Buffer.from('k\0v')), { ...contrato.mestre, bytesMax: 4 * MIB }));
    await defeituoso(verificarSaida(Buffer.concat([ok.mestre, Buffer.from('depois-do-fim')]), { ...contrato.mestre, bytesMax: 4 * MIB }));
    await defeituoso(verificarSaida(await sharp(ok.exibicao).withExif({ IFD0: { Copyright: 'x' } }).webp().toBuffer(), { ...contrato.exibicao, bytesMax: 512 * 1024 }));
    await assert.rejects(verificarSaida(ok.mestre, { ...contrato.mestre, bytesMax: 1000 }), recusaCom(CODIGO.SAIDA));
  });
});
