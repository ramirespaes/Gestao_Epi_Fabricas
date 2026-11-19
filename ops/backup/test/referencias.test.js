'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R = require('../lib/referencias.js');
const A = require('../lib/arquivos.js');
// Função pura de produção, lida só para provar equivalência da fórmula da chave (não é importada pelo código de ops).
const { chaveDe } = require('../../../backend/src/storage/armazenamento-imagens.js');

const H = (c) => c.repeat(64);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const dirTemp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const codigo = (c) => (e) => e.codigo === c;

function copia(tabela, colunas, linhas, esquema = 'public') {
  const corpo = linhas.map((l) => l.map((v) => (v === null ? '\\N' : v)).join('\t')).join('\n');
  return `--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;\n\nCOPY ${esquema}.${tabela} (${colunas.join(', ')}) FROM stdin;\n${corpo}${corpo ? '\n' : ''}\\.\n\n`;
}

test('parseCopy: colunas por nome, nulos e preâmbulo ignorado', () => {
  const t = copia('t', ['b', 'a', 'c'], [['2', 'x', null], ['3', 'y', 'z']]);
  const r = R.parseCopy(t, 't');
  assert.deepEqual(r.colunas, ['b', 'a', 'c']);
  assert.deepEqual(r.linhas, [{ b: '2', a: 'x', c: null }, { b: '3', a: 'y', c: 'z' }]);
});

test('parseCopy: escapes do formato texto (\\\\, \\t, \\n, \\r, octal, \\x) e \\N só quando o campo inteiro é \\N', () => {
  const t = copia('t', ['v'], [['a\\\\b'], ['a\\tb'], ['l1\\nl2'], ['x\\ry'], ['\\101\\102'], ['\\x41\\x4a'], ['\\\\N'], ['\\N']]);
  const r = R.parseCopy(t, 't').linhas.map((l) => l.v);
  assert.deepEqual(r, ['a\\b', 'a\tb', 'l1\nl2', 'x\ry', 'AB', 'AJ', '\\N', null]);
});

test('parseCopy: tabela vazia (cabeçalho + \\.) devolve zero linhas; ausente falha fechado', () => {
  assert.deepEqual(R.parseCopy(copia('t', ['a'], []), 't').linhas, []);
  assert.throws(() => R.parseCopy('--\nSET x = 1;\n', 't'), codigo('E_TABELA_AUSENTE'));
  assert.throws(() => R.parseCopy(copia('outra', ['a'], [['1']]), 't'), codigo('E_TABELA_AUSENTE'));
});

test('parseCopy: ignora outros esquemas e outras tabelas; recusa campos a mais/menos e bloco duplicado ou sem fim', () => {
  const misto = copia('outra', ['a'], [['1']]) + copia('t', ['a', 'b'], [['1', '2']]) + copia('t', ['a'], [['9']], 'outro_esquema');
  assert.deepEqual(R.parseCopy(misto, 't').linhas, [{ a: '1', b: '2' }]);
  assert.throws(() => R.parseCopy(copia('t', ['a', 'b'], [['1']]), 't'), codigo('E_COPY_INVALIDO'));
  assert.throws(() => R.parseCopy(copia('t', ['a'], [['1', '2']]), 't'), codigo('E_COPY_INVALIDO'));
  assert.throws(() => R.parseCopy(copia('t', ['a'], [['1']]) + copia('t', ['a'], [['2']]), 't'), codigo('E_COPY_INVALIDO'));
  assert.throws(() => R.parseCopy('COPY public.t (a) FROM stdin;\n1\n', 't'), codigo('E_COPY_INVALIDO'));
  assert.throws(() => R.parseCopy(copia('t', ['a', 'a'], [['1', '2']]), 't'), codigo('E_COPY_INVALIDO'));
});

test('chaveDeImagem é idêntica ao chaveDe de produção em todas as combinações', () => {
  const sha1 = H('a');
  for (const [segmento, escopo, empresaId] of [['1', 'EMPRESA', 1], ['42', 'EMPRESA', 42], ['999999999999999', 'EMPRESA', 999999999999999], ['padrao', 'PADRAO', undefined]]) {
    for (const formato of ['PNG', 'JPEG', 'WEBP']) {
      assert.equal(R.chaveDeImagem({ segmento, sha256: sha1, variante: 'mestre', formato }), chaveDe({ escopo, empresaId, sha256: sha1, variante: 'mestre', formato }));
    }
    for (const variante of ['exibicao', 'miniatura']) {
      assert.equal(R.chaveDeImagem({ segmento, sha256: sha1, variante, formato: 'WEBP' }), chaveDe({ escopo, empresaId, sha256: sha1, variante, formato: 'WEBP' }));
    }
  }
  assert.throws(() => R.chaveDeImagem({ segmento: '1', sha256: sha1, variante: 'exibicao', formato: 'PNG' }), codigo('E_REFERENCIAS_INVALIDAS'));
  assert.throws(() => R.chaveDeImagem({ segmento: '0', sha256: sha1, variante: 'mestre', formato: 'PNG' }), codigo('E_REFERENCIAS_INVALIDAS'));
  assert.throws(() => R.chaveDeImagem({ segmento: '../x', sha256: sha1, variante: 'mestre', formato: 'PNG' }), codigo('E_REFERENCIAS_INVALIDAS'));
});

const linhaPadrao = (o = {}) => ({ id: '1', sha256: H('a'), formato: 'PNG', sha256_miniatura: H('b'), sha256_exibicao: H('c'), bytes_mestre: '100', bytes_miniatura: '10', bytes_exibicao: '50', ...o });
const linhaEmpresa = (o = {}) => ({ id: '7', empresa_id: '12', sha256: H('1'), sha256_mestre: H('2'), sha256_exibicao: H('3'), sha256_miniatura: H('4'), formato: 'JPEG', bytes_mestre: '200', bytes_exibicao: '90', bytes_miniatura: '20', estado: 'ATIVA', ...o });

test('referenciasImagens: padrão (com e sem exibição) e empresa (inclusive INATIVA), com chaves e hashes de conteúdo corretos', () => {
  const refs = R.referenciasImagens({
    padrao: [linhaPadrao(), linhaPadrao({ sha256: H('d'), sha256_miniatura: H('e'), sha256_exibicao: null, bytes_exibicao: null })],
    empresa: [linhaEmpresa(), linhaEmpresa({ sha256: H('5'), sha256_mestre: H('6'), sha256_exibicao: H('7'), sha256_miniatura: H('8'), estado: 'INATIVA' })],
  });
  const por = Object.fromEntries(refs.map((r) => [r.chave, r]));
  assert.equal(refs.length, 3 + 2 + 3 + 3);
  assert.deepEqual(por[`padrao/${H('a')}/mestre.png`], { sha256: H('a'), tamanho_bytes: 100, chave: `padrao/${H('a')}/mestre.png` });
  assert.deepEqual(por[`padrao/${H('a')}/exibicao.webp`], { sha256: H('c'), tamanho_bytes: 50, chave: `padrao/${H('a')}/exibicao.webp` });
  assert.deepEqual(por[`padrao/${H('a')}/miniatura.webp`], { sha256: H('b'), tamanho_bytes: 10, chave: `padrao/${H('a')}/miniatura.webp` });
  assert.ok(!(`padrao/${H('d')}/exibicao.webp` in por));
  assert.deepEqual(por[`12/${H('1')}/mestre.jpg`], { sha256: H('2'), tamanho_bytes: 200, chave: `12/${H('1')}/mestre.jpg` });
  assert.equal(por[`12/${H('1')}/exibicao.webp`].sha256, H('3'));
  assert.equal(por[`12/${H('5')}/miniatura.webp`].sha256, H('8'));
});

test('referenciasImagens: linhas idênticas deduplicam; mesma chave com conteúdo diferente é conflito', () => {
  assert.equal(R.referenciasImagens({ padrao: [linhaPadrao(), linhaPadrao()], empresa: [] }).length, 3);
  assert.throws(() => R.referenciasImagens({ padrao: [linhaPadrao(), linhaPadrao({ sha256_miniatura: H('f') })], empresa: [] }), codigo('E_REFERENCIA_CONFLITANTE'));
});

test('referenciasImagens: recusa dados inválidos sem ecoar valores', () => {
  const ruins = [
    ['padrao', linhaPadrao({ sha256: 'SENTINELA-INVALIDA' })],
    ['padrao', linhaPadrao({ formato: 'GIF' })],
    ['padrao', linhaPadrao({ bytes_mestre: '-1' })],
    ['padrao', linhaPadrao({ bytes_mestre: '1.5' })],
    ['padrao', linhaPadrao({ sha256_exibicao: H('c'), bytes_exibicao: null })],
    ['padrao', linhaPadrao({ sha256_miniatura: null })],
    ['empresa', linhaEmpresa({ empresa_id: '0' })],
    ['empresa', linhaEmpresa({ empresa_id: '1000000000000000' })],
    ['empresa', linhaEmpresa({ empresa_id: 'abc' })],
    ['empresa', linhaEmpresa({ sha256_mestre: null })],
    ['empresa', linhaEmpresa({ estado: 'OUTRO' })],
    ['empresa', linhaEmpresa({ bytes_miniatura: '99999999999999999999' })],
  ];
  for (const [onde, linha] of ruins) {
    const entrada = { padrao: [], empresa: [] };
    entrada[onde].push(linha);
    assert.throws(() => R.referenciasImagens(entrada), (e) => e.codigo === 'E_REFERENCIAS_INVALIDAS' && !String(e.message).includes('SENTINELA'), JSON.stringify(linha));
  }
});

const linhaFisc = (o = {}) => ({ id: '34', empresa_id: '12', status: 'CONCLUIDO', chave_armazenamento: '12/pacote-34.zip', sha256: H('9'), tamanho_bytes: '4096', ...o });

test('referenciasFiscalizacao: só CONCLUIDO vira referência; GERANDO e FALHA são ignorados sem validação', () => {
  const refs = R.referenciasFiscalizacao([
    linhaFisc(),
    linhaFisc({ id: '35', status: 'GERANDO', chave_armazenamento: null, sha256: null, tamanho_bytes: null }),
    linhaFisc({ id: '36', status: 'FALHA', chave_armazenamento: 'lixo', sha256: 'lixo' }),
  ]);
  assert.deepEqual(refs, [{ sha256: H('9'), tamanho_bytes: 4096, chave: '12/pacote-34.zip' }]);
});

test('referenciasFiscalizacao: CONCLUIDO inválido falha fechado (chave, empresa divergente, hash, tamanho)', () => {
  const ruins = [
    linhaFisc({ chave_armazenamento: '../x/pacote-1.zip' }),
    linhaFisc({ chave_armazenamento: '12/pacote-34.tar' }),
    linhaFisc({ chave_armazenamento: '13/pacote-34.zip' }),
    linhaFisc({ chave_armazenamento: null }),
    linhaFisc({ sha256: 'curto' }),
    linhaFisc({ tamanho_bytes: '-5' }),
    linhaFisc({ tamanho_bytes: '9007199254740993' }),
    linhaFisc({ tamanho_bytes: null }),
  ];
  for (const l of ruins) assert.throws(() => R.referenciasFiscalizacao([l]), codigo('E_REFERENCIAS_INVALIDAS'), JSON.stringify(l));
});

test('serializarNdjson: determinístico, ordenado por chave, sem duplicatas, aceito pelo validador do E2', () => {
  const a = { sha256: H('a'), tamanho_bytes: 1, chave: 'b/x' };
  const b = { sha256: H('b'), tamanho_bytes: 2, chave: 'a/y' };
  const c = { sha256: H('c'), tamanho_bytes: 3, chave: 'c/z' };
  const um = R.serializarNdjson([a, b, c, a]);
  const dois = R.serializarNdjson([c, a, b]);
  assert.equal(um, dois);
  assert.equal(um, [b, a, c].map((r) => `{"sha256":"${r.sha256}","tamanho_bytes":${r.tamanho_bytes},"chave":"${r.chave}"}`).join('\n') + '\n');
  assert.equal(R.serializarNdjson([]), '');
  assert.deepEqual(A.parseReferencias(um), [b, a, c]);
  assert.equal(A.verificarReferencias([{ caminho: 'b/x', tamanho_bytes: 1, sha256: H('a') }, { caminho: 'a/y', tamanho_bytes: 2, sha256: H('b') }, { caminho: 'c/z', tamanho_bytes: 3, sha256: H('c') }], A.parseReferencias(um)).status, 'VERIFICADO_COMPLETO');
  assert.throws(() => R.serializarNdjson([a, { ...a, sha256: H('d') }]), codigo('E_REFERENCIA_CONFLITANTE'));
});

async function pacote({ dumpSha256 = H('d'), runId = '20261115T100000Z-aabbccdd', refs = [{ sha256: H('a'), tamanho_bytes: 1, chave: 'x/y' }] } = {}) {
  const diretorio = dirTemp('backup-ref-pacote-');
  fs.chmodSync(diretorio, 0o700);
  const meta = await R.gravarPacoteReferencias({
    diretorio,
    refsRunId: '20261115T101000Z-11223344',
    geradoEm: '2026-11-15T10:10:00Z',
    host: 'servidor-teste',
    banco: { runId, dumpSha256, manifestSha256: H('e') },
    versaoPgRestore: 'pg_restore (PostgreSQL) 16.0',
    fontes: [{ id: 'imagens', tabelas: [{ nome: 'imagens_empresa', linhas_lidas: 1, linhas_usadas: 1 }], refs }],
  });
  return { diretorio, meta };
}

const esperado = { runId: '20261115T100000Z-aabbccdd', dumpSha256: H('d'), manifestSha256: H('e') };

test('pacote: grava com permissões 0600 e verifica íntegro, vinculado ao dump esperado', async () => {
  const { diretorio, meta } = await pacote();
  for (const n of ['REFERENCIAS-META.json', 'REFERENCIAS-META.json.sha256', 'refs-imagens.ndjson']) assert.equal(fs.statSync(path.join(diretorio, n)).mode & 0o777, 0o600, n);
  assert.equal(meta.dump.sha256, H('d'));
  assert.equal(meta.fontes[0].sha256, sha(fs.readFileSync(path.join(diretorio, 'refs-imagens.ndjson'))));
  const v = await R.verificarPacoteReferencias(diretorio, esperado, A.parseReferencias);
  assert.deepEqual(Object.keys(v.fontes), ['imagens']);
  assert.equal(v.fontes.imagens.refs.length, 1);
  assert.equal(v.fontes.imagens.origem.dump_sha256, H('d'));
  assert.equal(v.fontes.imagens.origem.referencias_sha256, meta.fontes[0].sha256);
  assert.equal(v.fontes.imagens.origem.meta_sha256, sha(fs.readFileSync(path.join(diretorio, 'REFERENCIAS-META.json'))));
});

test('pacote: dump, run_id ou manifesto de outra execução são recusados (E_REFERENCIAS_DE_OUTRO_DUMP)', async () => {
  const { diretorio } = await pacote();
  for (const diferente of [{ dumpSha256: H('0') }, { runId: '20261115T100000Z-00000000' }, { manifestSha256: H('0') }]) {
    await assert.rejects(R.verificarPacoteReferencias(diretorio, { ...esperado, ...diferente }, A.parseReferencias), codigo('E_REFERENCIAS_DE_OUTRO_DUMP'));
  }
});

test('pacote: adulteração do NDJSON, da meta, do .sha256, ausência de arquivo e contagem divergente são detectadas', async () => {
  const casos = {
    ndjson: (d) => fs.appendFileSync(path.join(d, 'refs-imagens.ndjson'), `{"sha256":"${H('f')}"}\n`),
    meta: (d) => fs.appendFileSync(path.join(d, 'REFERENCIAS-META.json'), ' '),
    sha: (d) => fs.writeFileSync(path.join(d, 'REFERENCIAS-META.json.sha256'), `${H('0')}  REFERENCIAS-META.json\n`),
    ausente: (d) => fs.unlinkSync(path.join(d, 'refs-imagens.ndjson')),
    metaausente: (d) => fs.unlinkSync(path.join(d, 'REFERENCIAS-META.json')),
  };
  for (const [nome, estraga] of Object.entries(casos)) {
    const { diretorio } = await pacote();
    estraga(diretorio);
    await assert.rejects(R.verificarPacoteReferencias(diretorio, esperado, A.parseReferencias), codigo('E_REFERENCIAS_ADULTERADAS'), nome);
  }
});

test('pacote: meta consistente mas com total divergente do NDJSON é recusada', async () => {
  const { diretorio } = await pacote();
  const arq = path.join(diretorio, 'REFERENCIAS-META.json');
  const m = JSON.parse(fs.readFileSync(arq, 'utf8'));
  m.fontes[0].total = 5;
  fs.writeFileSync(arq, `${JSON.stringify(m, null, 2)}\n`);
  fs.writeFileSync(`${arq}.sha256`, `${sha(fs.readFileSync(arq))}  REFERENCIAS-META.json\n`);
  await assert.rejects(R.verificarPacoteReferencias(diretorio, esperado, A.parseReferencias), codigo('E_REFERENCIAS_ADULTERADAS'));
});

test('pacote: gravação recusa meta com segredo e fonte repetida; verificação sem esperado só confere a integridade', async () => {
  const diretorio = dirTemp('backup-ref-seg-');
  await assert.rejects(R.gravarPacoteReferencias({ diretorio, refsRunId: '20261115T101000Z-11223344', geradoEm: '2026-11-15T10:10:00Z', host: 'PGPASSWORD=abc', banco: { runId: '20261115T100000Z-aabbccdd', dumpSha256: H('d'), manifestSha256: H('e') }, versaoPgRestore: 'v', fontes: [] }), codigo('E_REFERENCIAS_INVALIDAS'));
  const fonteRepetida = { id: 'imagens', tabelas: [], refs: [] };
  await assert.rejects(R.gravarPacoteReferencias({ diretorio: dirTemp('backup-ref-dup-'), refsRunId: '20261115T101000Z-11223344', geradoEm: '2026-11-15T10:10:00Z', host: 'h', banco: { runId: '20261115T100000Z-aabbccdd', dumpSha256: H('d'), manifestSha256: H('e') }, versaoPgRestore: 'v', fontes: [fonteRepetida, fonteRepetida] }), codigo('E_REFERENCIAS_INVALIDAS'));
  const { diretorio: ok } = await pacote();
  const v = await R.verificarPacoteReferencias(ok, null, A.parseReferencias);
  assert.equal(Object.keys(v.fontes).length, 1);
});
