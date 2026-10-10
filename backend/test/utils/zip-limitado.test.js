'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { lerZip } = require('../helpers/zip-leitor');

/**
 * 12K-D6: o ZIP é escrito em streaming e o limite global (100 MiB no produto) é fiscalizado DURANTE a escrita: ao estourar,
 * aborta na hora, destrói o destino e nunca entrega ZIP truncado.
 */
const Z = () => exigirModulo('src/utils/zip-limitado');

function coletor() {
  const partes = [];
  const w = new Writable({ write(c, _e, cb) { partes.push(c); cb(); } });
  return { w, buffer: () => Buffer.concat(partes) };
}
async function* linhas(n, tamanho, estado) {
  for (let i = 0; i < n; i += 1) {
    estado.produzidas = i + 1;
    yield Buffer.alloc(tamanho, 0x61 + (i % 20));
    await new Promise((r) => setImmediate(r));
  }
}

describe('ZIP com limite de tamanho fiscalizado no streaming', () => {
  test('o limite do produto é 100 MiB', () => {
    assert.equal(Z().LIMITE_PADRAO_BYTES, 100 * 1024 * 1024);
  });

  test('dentro do limite: ZIP íntegro com todos os arquivos e o tamanho total real', async () => {
    const c = coletor();
    const r = await Z().escreverZipLimitado([
      { nome: 'a.csv', conteudo: (async function* () { yield Buffer.from('a;b\r\n'); yield Buffer.from('1;2\r\n'); }()) },
      { nome: 'b.json', conteudo: (async function* () { yield Buffer.from('{"ok":true}'); }()) },
    ], c.w, { limiteBytes: 1024 * 1024 });
    assert.equal(r.bytes, c.buffer().length);
    const z = lerZip(c.buffer());
    assert.equal(z['a.csv'].toString(), 'a;b\r\n1;2\r\n');
    assert.equal(z['b.json'].toString(), '{"ok":true}');
  });

  test('estoura o limite durante o streaming: aborta, destrói o destino, para de ler a origem e rejeita com código controlado', async () => {
    const c = coletor();
    const estado = { produzidas: 0 };
    await assert.rejects(
      () => Z().escreverZipLimitado([{ nome: 'grande.csv', conteudo: linhas(5000, 64 * 1024, estado) }], c.w, { limiteBytes: 256 * 1024, comprimir: false }),
      (e) => e.codigo === 'ZIP_EXCEDE_LIMITE',
    );
    assert.ok(estado.produzidas < 5000, `a origem deve parar cedo (leu ${estado.produzidas} de 5000)`);
    assert.equal(c.w.destroyed, true, 'o destino é destruído');
  });

  test('o tamanho é conferido durante a escrita, não só no fim: nunca grava muito acima do limite', async () => {
    const c = coletor();
    await assert.rejects(
      () => Z().escreverZipLimitado([{ nome: 'x.bin', conteudo: linhas(2000, 64 * 1024, { produzidas: 0 }) }], c.w, { limiteBytes: 300 * 1024, comprimir: false }),
      (e) => e.codigo === 'ZIP_EXCEDE_LIMITE',
    );
    assert.ok(c.buffer().length < 300 * 1024 + 256 * 1024, `gravou ${c.buffer().length} bytes: precisa parar perto do limite`);
  });

  test('exatamente no limite passa; um byte acima falha (sem truncar)', async () => {
    const medir = async (limite) => {
      const c = coletor();
      await Z().escreverZipLimitado([{ nome: 'k.txt', conteudo: (async function* () { yield Buffer.from('conteudo'); }()) }], c.w, { limiteBytes: limite });
      return c.buffer().length;
    };
    const tamanho = await medir(10 * 1024 * 1024);
    assert.equal(await medir(tamanho), tamanho);
    await assert.rejects(() => medir(tamanho - 1), (e) => e.codigo === 'ZIP_EXCEDE_LIMITE');
  });

  test('erro na origem também aborta, destrói o destino e propaga (nada parcial é sucesso)', async () => {
    const c = coletor();
    await assert.rejects(
      () => Z().escreverZipLimitado([{ nome: 'q.csv', conteudo: (async function* () { yield Buffer.from('a'); throw new Error('falha de leitura'); }()) }], c.w, { limiteBytes: 1024 * 1024 }),
      /falha de leitura/,
    );
    assert.equal(c.w.destroyed, true);
  });

  test('nomes de arquivo do ZIP são fixos e seguros: caminho com .., absoluto ou barra invertida é recusado', async () => {
    for (const nome of ['../x.csv', '/abs.csv', 'a\\b.csv', 'a/../b.csv', '', 'x\0.csv']) {
      await assert.rejects(() => Z().escreverZipLimitado([{ nome, conteudo: (async function* () { yield Buffer.from('a'); }()) }], coletor().w, { limiteBytes: 1024 }), /nome/i, JSON.stringify(nome));
    }
  });
});
