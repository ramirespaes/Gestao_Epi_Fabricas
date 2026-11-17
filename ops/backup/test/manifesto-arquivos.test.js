'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const A = require('../lib/arquivos.js');
const MA = require('../lib/manifesto-arquivos.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const dirTemp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

const DUMP_SHA = 'd'.repeat(64);
const vinculoDe = () => ({ vinculo: 'VINCULADO_AO_DUMP', dumpSha256: DUMP_SHA, referenciasSha256: '1'.repeat(64), metaSha256: '2'.repeat(64), refsRunId: '20261115T115950Z-55667788' });

async function execucaoCopiada({ referencias = true, vinculado = true } = {}) {
  const raiz = dirTemp('backup-ma-origem-');
  fs.mkdirSync(path.join(raiz, 'p'));
  fs.writeFileSync(path.join(raiz, 'p', 'a.bin'), 'AAAA');
  fs.writeFileSync(path.join(raiz, 'b.bin'), 'BBBBBB');
  const run = dirTemp('backup-ma-run-');
  const copia = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run });
  const refs = referencias ? [{ sha256: sha('AAAA') }, { sha256: sha('BBBBBB'), chave: 'b.bin' }] : null;
  const dados = {
    runId: '20261115T120000Z-abcdef01',
    criadoEm: '2026-11-15T12:00:05Z',
    inicioCopia: '2026-11-15T12:00:01Z',
    fimCopia: '2026-11-15T12:00:04Z',
    host: 'servidor-teste',
    banco: { runId: '20261115T115900Z-11223344', manifestSha256: 'e'.repeat(64), dumpSha256: DUMP_SHA, criadoEm: '2026-11-15T11:59:00Z' },
    copia,
    referencias: refs ? { imagens: A.verificarReferencias(copia.fontes[0].arquivos, refs) } : {},
    vinculos: refs && vinculado ? { imagens: vinculoDe() } : {},
  };
  return { run, dados, copia };
}

test('construir: execução estável com referências completas é publicável', async () => {
  const { dados } = await execucaoCopiada();
  const m = MA.construirManifestoArquivos(dados);
  assert.equal(m.esquema, 2);
  assert.equal(m.etapa, 'E2');
  assert.equal(m.escopo, 'ARQUIVOS');
  assert.equal(m.banco.dump_sha256, DUMP_SHA);
  assert.equal(m.consistencia.vinculo, 'VINCULADO_AO_DUMP');
  assert.deepEqual(m.fontes[0].referencias.origem, { dump_sha256: DUMP_SHA, referencias_sha256: '1'.repeat(64), meta_sha256: '2'.repeat(64), refs_run_id: '20261115T115950Z-55667788' });
  assert.equal(m.escolhida, 1);
  assert.equal(m.fontes[0].diretorio, 'tentativas/1/imagens');
  assert.equal(m.fontes[0].total_arquivos, 2);
  assert.equal(m.fontes[0].total_bytes, 10);
  assert.equal(m.consistencia.concorrencia, 'SEM_ALTERACAO');
  assert.equal(m.consistencia.referencias, 'VERIFICADO_COMPLETO');
  assert.equal(m.consistencia.publicavel, true);
  assert.deepEqual(m.consistencia.bloqueios, []);
  assert.deepEqual(MA.validarManifestoArquivos(m), { ok: true, erros: [] });
});

test('construir: sem referências a execução NÃO é publicável', async () => {
  const { dados } = await execucaoCopiada({ referencias: false });
  const m = MA.construirManifestoArquivos(dados);
  assert.equal(m.consistencia.referencias, 'NAO_VERIFICADO');
  assert.equal(m.consistencia.publicavel, false);
  assert.deepEqual(m.consistencia.bloqueios, ['REFERENCIAS_NAO_VERIFICADAS']);
  assert.ok(m.pendente.includes('referencias-do-banco'));
});

test('construir: referências completas mas NÃO vinculadas ao dump bloqueiam a publicação', async () => {
  const { dados } = await execucaoCopiada({ vinculado: false });
  const m = MA.construirManifestoArquivos(dados);
  assert.equal(m.consistencia.referencias, 'VERIFICADO_COMPLETO');
  assert.equal(m.consistencia.vinculo, 'NAO_VINCULADO');
  assert.equal(m.fontes[0].referencias.vinculo, 'NAO_VINCULADO');
  assert.equal(m.fontes[0].referencias.origem, null);
  assert.equal(m.consistencia.publicavel, false);
  assert.deepEqual(m.consistencia.bloqueios, ['REFERENCIAS_NAO_VINCULADAS']);
  assert.ok(m.pendente.includes('vinculo-das-referencias'));
  assert.deepEqual(MA.validarManifestoArquivos(m), { ok: true, erros: [] });
});

test('construir: vínculo declarado com dump diferente do banco da execução é recusado', async () => {
  const { dados } = await execucaoCopiada();
  dados.vinculos.imagens.dumpSha256 = '0'.repeat(64);
  assert.throws(() => MA.construirManifestoArquivos(dados), /E_VINCULO_INCOERENTE/);
});

test('validar: esquema legado 1, publicável sem vínculo e origem de outro dump são recusados', async () => {
  const { dados } = await execucaoCopiada();
  const base = MA.construirManifestoArquivos(dados);
  const clone = () => JSON.parse(JSON.stringify(base));
  let m = clone(); m.esquema = 1;
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
  m = clone(); m.consistencia.vinculo = 'NAO_VINCULADO';
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
  m = clone(); m.fontes[0].referencias.vinculo = 'NAO_VINCULADO'; m.fontes[0].referencias.origem = null;
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
  m = clone(); m.fontes[0].referencias.origem.dump_sha256 = '0'.repeat(64);
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
  m = clone(); m.banco.dump_sha256 = 'xyz';
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
});

test('construir: referência faltante bloqueia', async () => {
  const { dados, copia } = await execucaoCopiada();
  dados.referencias = { imagens: A.verificarReferencias(copia.fontes[0].arquivos, [{ sha256: 'f'.repeat(64) }]) };
  const m = MA.construirManifestoArquivos(dados);
  assert.equal(m.consistencia.publicavel, false);
  assert.deepEqual(m.consistencia.bloqueios, ['REFERENCIAS_FALTANTES']);
});

test('construir: alteração concorrente bloqueia mesmo com referências completas', async () => {
  const { dados } = await execucaoCopiada();
  dados.copia = { ...dados.copia, concorrencia: 'COM_ALTERACAO_CONCORRENTE' };
  const m = MA.construirManifestoArquivos(dados);
  assert.equal(m.consistencia.publicavel, false);
  assert.ok(m.consistencia.bloqueios.includes('ALTERACAO_CONCORRENTE'));
});

test('validar: recusa publicável inconsistente, caminho inseguro, hash inválido e segredo', async () => {
  const { dados } = await execucaoCopiada();
  const base = MA.construirManifestoArquivos(dados);
  const clone = () => JSON.parse(JSON.stringify(base));
  let m = clone(); m.consistencia.bloqueios = ['REFERENCIAS_NAO_VERIFICADAS'];
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
  m = clone(); m.consistencia.concorrencia = 'COM_ALTERACAO_CONCORRENTE';
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
  m = clone(); m.fontes[0].arquivos[0].caminho = '../fora';
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
  m = clone(); m.fontes[0].arquivos[0].sha256 = 'xyz';
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
  m = clone(); m.senha = 'x';
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
  m = clone(); m.host = 'PGPASSWORD=abc';
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
  m = clone(); m.fontes[0].diretorio = 'tentativas/9/imagens';
  assert.equal(MA.validarManifestoArquivos(m).ok, false);
});

test('gravar: MANIFEST-ARQUIVOS.json e .sha256 com 0600; verificar aprova', async () => {
  const { run, dados } = await execucaoCopiada();
  const m = MA.construirManifestoArquivos(dados);
  await MA.gravarManifestoArquivos(run, m);
  const arq = path.join(run, 'MANIFEST-ARQUIVOS.json');
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(`${arq}.sha256`, 'utf8'), `${sha(fs.readFileSync(arq))}  MANIFEST-ARQUIVOS.json\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, 'utf8')), m);
  assert.deepEqual(await MA.verificarManifestoArquivos(run), { ok: true, erros: [] });
});

test('verificar: detecta arquivo adulterado, ausente, extra e manifesto alterado', async () => {
  const casos = {
    adulterado: (run) => fs.appendFileSync(path.join(run, 'tentativas', '1', 'imagens', 'b.bin'), 'x'),
    ausente: (run) => fs.unlinkSync(path.join(run, 'tentativas', '1', 'imagens', 'p', 'a.bin')),
    extra: (run) => fs.writeFileSync(path.join(run, 'tentativas', '1', 'imagens', 'intruso.bin'), 'i'),
    manifesto: (run) => fs.appendFileSync(path.join(run, 'MANIFEST-ARQUIVOS.json'), ' '),
  };
  for (const [nome, estraga] of Object.entries(casos)) {
    const { run, dados } = await execucaoCopiada();
    await MA.gravarManifestoArquivos(run, MA.construirManifestoArquivos(dados));
    estraga(run);
    const r = await MA.verificarManifestoArquivos(run);
    assert.equal(r.ok, false, nome);
    assert.ok(r.erros.length > 0);
  }
});

test('gravar recusa manifesto inválido', async () => {
  const { run, dados } = await execucaoCopiada();
  const m = MA.construirManifestoArquivos(dados);
  m.run_id = 'ruim';
  await assert.rejects(MA.gravarManifestoArquivos(run, m), /E_MANIFESTO_INVALIDO/);
});
