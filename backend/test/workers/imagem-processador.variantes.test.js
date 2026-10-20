'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const servico = require('../../src/services/imagem-processador.service');
const worker = require('../../src/workers/imagem-processador.worker');
const { ErroDeImagem, CODIGOS } = require('../../src/utils/imagem-container');
const F = require('../helpers/imagens-reais');

/**
 * Biblioteca de Imagens, Unidade 5C-4 (T-03, mutantes W24, W44, W45, W46 e W47) — a VALIDAÇÃO DAS VARIANTES dentro de processarImagem. O sharp real nunca devolve uma variante
 * fora do contrato, então a chamada a verificarSaida para o mestre, a exibição e a miniatura (e o que ela recusa) só se mostra com um sharp defeituoso: aqui o toBuffer do
 * Sharp é trocado, só durante o teste, para entregar uma variante adulterada ou para falhar. A leitura da entrada (toBuffer com resolveWithObject) segue normal; as gerações
 * de variante chegam sempre nesta ordem: 0 mestre, 1 exibição, 2 miniatura. Falha inesperada propaga como está (nunca vira recusa de imagem); erro de tempo vira TEMPO.
 */

const MIB = 1024 * 1024;
const teste = (nome, fn) => test(nome, { timeout: 60000 }, fn);
const VARIANTES = ['mestre', 'exibicao', 'miniatura'];

/** `tratar(indice, gerar)` decide o que entregar no lugar da variante `indice`; `gerar()` produz a variante verdadeira. Devolve o contador de variantes geradas. */
function simularVariantes(t, tratar) {
  const original = sharp.prototype.toBuffer;
  let geradas = 0;
  t.mock.method(sharp.prototype, 'toBuffer', async function toBuffer(opcoes) {
    if (opcoes && opcoes.resolveWithObject) return original.call(this, opcoes);
    const indice = geradas;
    geradas += 1;
    return tratar(indice, () => original.call(this, opcoes));
  });
  return () => geradas;
}
const comByteExtra = (b) => Buffer.concat([b, Buffer.from([0])]);
const adulterar = (alvo, funcao) => async (indice, gerar) => { const b = await gerar(); return indice === alvo ? funcao(b) : b; };
const defeitoDaSaida = (e) => {
  assert.equal(e.codigo, 'IMAGEM_FILHO_SAIDA_INVALIDA');
  assert.ok(!(e instanceof ErroDeImagem), 'é defeito interno, nunca recusa de imagem');
  return true;
};
let ENTRADA = null;
const processar = () => worker.processarImagem(ENTRADA, servico.parametrosDoProcessamento());

describe('validação das variantes dentro de processarImagem (T-03)', () => {
  // A entrada é fabricada com o toBuffer verdadeiro, ANTES de qualquer teste trocá-lo: senão a própria fixture contaria como uma variante.
  before(async () => { ENTRADA = await F.png(400, 320); });

  teste('VAR-01 — controle: com o toBuffer simulado sem adulterar nada, o resultado é o do contrato e são geradas exatamente três variantes', async (t) => {
    const geradas = simularVariantes(t, (_indice, gerar) => gerar());
    const r = await processar();
    assert.deepEqual([r.formato, r.largura, r.altura], ['PNG', 1024, 1024]);
    assert.equal(geradas(), 3);
  });

  teste('VAR-02 — o MESTRE com um byte depois do fim é recusado como defeito interno: verificarSaida é chamada para ele', async (t) => {
    simularVariantes(t, adulterar(0, comByteExtra));
    await assert.rejects(processar(), defeitoDaSaida);
  });

  teste('VAR-03 — a EXIBIÇÃO com um byte depois do fim é recusada como defeito interno: verificarSaida é chamada para ela', async (t) => {
    simularVariantes(t, adulterar(1, comByteExtra));
    await assert.rejects(processar(), defeitoDaSaida);
  });

  teste('VAR-04 — a MINIATURA com um byte depois do fim é recusada como defeito interno: verificarSaida é chamada para ela', async (t) => {
    simularVariantes(t, adulterar(2, comByteExtra));
    await assert.rejects(processar(), defeitoDaSaida);
  });

  teste('VAR-05 — pedaço de metadado que SÓ o inspetor de contêiner conhece (tIME no mestre; o sharp não o reporta) também é recusado', async (t) => {
    const comTime = (b) => F.inserirPedacoPng(b, 'tIME', Buffer.alloc(7));
    const amostra = comTime(await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
    const meta = await sharp(amostra).metadata();
    assert.ok(!meta.exif && !meta.icc && !meta.xmp && !meta.iptc && !(meta.comments && meta.comments.length), 'o sharp não enxerga o tIME: só o inspetor o recusa');
    simularVariantes(t, adulterar(0, comTime));
    await assert.rejects(processar(), defeitoDaSaida);
  });

  teste('VAR-06 — falha inesperada ao gerar QUALQUER variante propaga como está: o mesmo erro, nunca convertido em recusa de imagem', async (t) => {
    for (const indice of [0, 1, 2]) {
      const inesperado = Object.assign(new Error(`vips: sem memória na variante ${VARIANTES[indice]}`), { codigo: 'FALHA_INESPERADA_DE_TESTE' });
      simularVariantes(t, async (i, gerar) => { if (i === indice) throw inesperado; return gerar(); });
      const erro = await processar().then(() => null, (e) => e);
      assert.equal(erro, inesperado, `variante ${VARIANTES[indice]}`);
      assert.ok(!(erro instanceof ErroDeImagem));
      t.mock.restoreAll();
    }
  });

  teste('VAR-07 — erro de TEMPO do sharp ao gerar uma variante vira IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO; ErroDeImagem lançado na geração passa como está', async (t) => {
    simularVariantes(t, async (i, gerar) => { if (i === 1) throw new Error('timeout: 61% complete\nVipsImage: killed'); return gerar(); });
    await assert.rejects(processar(), (e) => { assert.ok(e instanceof ErroDeImagem); assert.equal(e.codigo, CODIGOS.TEMPO); return true; });
    t.mock.restoreAll();
    const proprio = new ErroDeImagem(CODIGOS.SAIDA);
    simularVariantes(t, async (i, gerar) => { if (i === 2) throw proprio; return gerar(); });
    assert.equal(await processar().then(() => null, (e) => e), proprio);
  });

  teste('VAR-08 — verificarSaida nas bordas: o teto vale exatamente (no teto passa, um byte acima é recusa pública) e entrada que não é Buffer, vazia ou contrato ausente é defeito interno', async () => {
    const { verificarSaida } = worker;
    const r = await processar();
    const contrato = { formato: 'png', lado: 1024 };
    await verificarSaida(r.mestre, { ...contrato, bytesMax: r.mestre.length });
    await assert.rejects(verificarSaida(r.mestre, { ...contrato, bytesMax: r.mestre.length - 1 }), (e) => { assert.ok(e instanceof ErroDeImagem); assert.equal(e.codigo, CODIGOS.SAIDA); return true; });
    for (const ruim of ['texto', null, undefined, Buffer.alloc(0), new Uint8Array(8)]) await assert.rejects(verificarSaida(ruim, { ...contrato, bytesMax: 4 * MIB }), defeitoDaSaida);
    for (const ruim of [null, undefined, 'png', 42]) await assert.rejects(verificarSaida(r.mestre, ruim), defeitoDaSaida);
  });
});
