'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * 12K-D6: armazenamento do ZIP atrás de uma interface (hoje o disco local; amanhã um driver S3). Chave gerada pelo servidor,
 * sem path traversal, sem sobrescrita, publicação atômica e hash calculado durante a escrita.
 */
const A = () => exigirModulo('src/storage/armazenamento-local');

describe('armazenamento local do pacote', () => {
  let raiz;
  beforeEach(() => { raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'fisc-arm-')); });
  afterEach(() => { fs.rmSync(raiz, { recursive: true, force: true }); });

  const escrever = (g, texto) => new Promise((resolve, reject) => {
    g.escrita.on('error', reject);
    g.escrita.end(Buffer.from(texto), resolve);
  });

  test('a interface expõe iniciar, abrir, existe e remover (o que um driver S3 também implementaria)', () => {
    const a = A().criarArmazenamentoLocal({ diretorio: raiz });
    for (const m of ['iniciar', 'abrir', 'existe', 'remover', 'removerResiduos']) assert.equal(typeof a[m], 'function', m);
  });

  test('publica atomicamente: o arquivo só aparece na chave definitiva depois de publicar, com tamanho e SHA-256 corretos', async () => {
    const a = A().criarArmazenamentoLocal({ diretorio: raiz });
    const g = await a.iniciar({ empresaId: 7, pacoteId: 42 });
    await escrever(g, 'conteúdo do pacote');
    assert.equal(await a.existe(g.chave), false, 'antes de publicar não existe na chave final');
    const r = await g.publicar();
    assert.equal(r.chave, g.chave);
    assert.equal(r.tamanhoBytes, Buffer.byteLength('conteúdo do pacote'));
    assert.equal(r.sha256, crypto.createHash('sha256').update('conteúdo do pacote').digest('hex'));
    assert.equal(await a.existe(g.chave), true);
    const lido = [];
    for await (const parte of (await a.abrir(g.chave))) lido.push(parte);
    assert.equal(Buffer.concat(lido).toString(), 'conteúdo do pacote');
  });

  test('a chave é montada só com inteiros do servidor (empresa e pacote), nunca com texto do cliente', async () => {
    const a = A().criarArmazenamentoLocal({ diretorio: raiz });
    const g = await a.iniciar({ empresaId: 7, pacoteId: 42 });
    assert.match(g.chave, /^7\/pacote-42\.zip$/);
    await g.abortar();
    for (const ruim of [{ empresaId: '7/../8', pacoteId: 1 }, { empresaId: 7, pacoteId: '../../x' }, { empresaId: -1, pacoteId: 1 }, { empresaId: 7.5, pacoteId: 1 }, { empresaId: 7, pacoteId: 0 }]) {
      await assert.rejects(() => a.iniciar(ruim), /chave|inválid/i);
    }
  });

  test('path traversal: abrir, existir e remover recusam qualquer chave fora do formato e fora da raiz', async () => {
    const a = A().criarArmazenamentoLocal({ diretorio: raiz });
    fs.writeFileSync(path.join(path.dirname(raiz), 'fora-da-raiz.txt'), 'segredo');
    for (const ruim of ['../fora-da-raiz.txt', '/etc/passwd', '7/../../fora-da-raiz.txt', '7/pacote-1.zip/../../x', '7\\pacote-1.zip', '7/pacote-1.zip\0', 'qualquer/coisa.zip', '']) {
      await assert.rejects(() => a.abrir(ruim), /chave|inválid/i, `abrir ${JSON.stringify(ruim)}`);
      await assert.rejects(() => a.existe(ruim), /chave|inválid/i);
      await assert.rejects(() => a.remover(ruim), /chave|inválid/i);
    }
    fs.rmSync(path.join(path.dirname(raiz), 'fora-da-raiz.txt'), { force: true });
  });

  test('nunca sobrescreve: publicar duas vezes na mesma chave falha e o primeiro arquivo permanece intacto', async () => {
    const a = A().criarArmazenamentoLocal({ diretorio: raiz });
    const g1 = await a.iniciar({ empresaId: 1, pacoteId: 9 });
    await escrever(g1, 'primeiro');
    await g1.publicar();
    const g2 = await a.iniciar({ empresaId: 1, pacoteId: 9 });
    await escrever(g2, 'segundo');
    await assert.rejects(() => g2.publicar(), /existe|sobrescrever|EEXIST/i);
    const lido = [];
    for await (const parte of (await a.abrir('1/pacote-9.zip'))) lido.push(parte);
    assert.equal(Buffer.concat(lido).toString(), 'primeiro');
  });

  test('abortar remove o temporário e não publica nada', async () => {
    const a = A().criarArmazenamentoLocal({ diretorio: raiz });
    const g = await a.iniciar({ empresaId: 2, pacoteId: 3 });
    g.escrita.write(Buffer.from('parcial'));
    await g.abortar();
    assert.equal(await a.existe('2/pacote-3.zip'), false);
    const restos = fs.readdirSync(raiz, { recursive: true }).filter((n) => String(n).includes('tmp') || String(n).endsWith('.zip'));
    assert.deepEqual(restos, [], 'nenhum temporário residual');
  });

  test('removerResiduos apaga o temporário e o arquivo final órfãos de um pacote', async () => {
    const a = A().criarArmazenamentoLocal({ diretorio: raiz });
    const g = await a.iniciar({ empresaId: 4, pacoteId: 5 });
    g.escrita.write(Buffer.from('temp'));
    await a.removerResiduos({ empresaId: 4, pacoteId: 5 });
    const g2 = await a.iniciar({ empresaId: 4, pacoteId: 6 });
    await escrever(g2, 'final');
    await g2.publicar();
    await a.removerResiduos({ empresaId: 4, pacoteId: 6 });
    assert.equal(await a.existe('4/pacote-6.zip'), false);
    assert.deepEqual(fs.readdirSync(raiz, { recursive: true }).filter((n) => String(n).includes('.')), []);
  });

  test('o diretório é obrigatório, absoluto e, quando criado, só do dono (0700)', () => {
    assert.throws(() => A().criarArmazenamentoLocal({}), /diretório/i);
    assert.throws(() => A().criarArmazenamentoLocal({ diretorio: 'relativo' }), /absoluto/i);
    const novo = path.join(raiz, 'novo');
    A().criarArmazenamentoLocal({ diretorio: novo });
    if (process.platform !== 'win32') assert.equal(fs.statSync(novo).mode & 0o777, 0o700);
  });
});
