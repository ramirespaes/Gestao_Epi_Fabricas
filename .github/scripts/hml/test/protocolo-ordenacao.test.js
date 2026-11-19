'use strict';
// SonarCloud S2871 (PR #115): as comparações de conjuntos de chaves de protocolo.js passam a usar uma ordenação alfabética
// explícita (`chavesOrdenadas`, localeCompare(b, 'en')) em vez de .sort() sem comparador. Estas provas garantem que a
// ordem canônica, os conjuntos esperados, os hashes e a serialização NÃO mudaram e que o resultado não depende do locale.
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '../../../..');
const PROTOCOLO = path.join(RAIZ, 'deploy/hml/cd/protocolo.js');
const P = require(PROTOCOLO);
const { gerarReleaseBackend } = require(path.join(RAIZ, 'deploy/hml/empacotar-backend.js'));
const fonte = fs.readFileSync(PROTOCOLO, 'utf8');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const COMMIT = 'c'.repeat(40);
const ROTULO = `hml-20261118T120000-${COMMIT.slice(0, 7)}`;
const AGORA = Date.parse('2026-11-18T12:00:00.000Z');
const temporarios = [];
afterEach(() => { while (temporarios.length) fs.rmSync(temporarios.pop(), { recursive: true, force: true }); });
const novo = (p = 'hml-ord-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temporarios.push(d); return d; };
const recusa = (fn, codigo) => assert.throws(fn, (e) => { assert.equal(e.codigo, codigo, `esperado ${codigo}, veio ${e.codigo}: ${e.message}`); return true; });

// Conjuntos de chaves canônicos (a ordem abaixo é a de sempre: ordem alfabética das chaves).
const CANONICOS = {
  pedidoV1: 'blobSha256,commit,criadoEm,expiraEm,id,permitirAnterior,releaseSha256,repositorio,rotulo,versao',
  pedidoV2: 'blobSha256,commit,criadoEm,escopo,expiraEm,id,permitirAnterior,releaseSha256,repositorio,rotulo,versao',
  releaseBackend: 'atual,backend,commit,geradoEm,rotulo',
  secaoBackend: 'arquivos,contratos,lockfileSha256,manifestoSha256,migrations,node',
};
const objetoCom = (lista) => Object.fromEntries(lista.split(',').map((k, i) => [k, i]));
const embaralhamentos = (lista) => {
  const base = lista.split(',');
  return [base, [...base].reverse(), ...base.map((_, i) => [...base.slice(i), ...base.slice(0, i)])];
};

// ---- fixtures determinísticas (para provar que hashes e serialização não mudaram)
function raizBackend() {
  const raiz = novo('hml-raiz-');
  const lock = { name: 'x', lockfileVersion: 3, packages: { '': { name: 'x', version: '1.0.0' }, 'node_modules/zod': { version: '4.0.0', resolved: 'https://registry.npmjs.org/zod/-/zod-4.0.0.tgz', integrity: 'sha512-AAAA' } } };
  const arquivos = {
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', engines: { node: '>=22' }, scripts: { start: 'node src/server.js' }, dependencies: { zod: '^4.0.0' } }),
    'package-lock.json': JSON.stringify(lock), 'src/server.js': "'use strict';\nrequire('./app');\n", 'src/app.js': "'use strict';\nmodule.exports = {};\n",
    'scripts/guarda-inicializacao.js': "'use strict';\n", 'migrations/000_a.sql': 'CREATE TABLE a (id int);\n', 'migrations/001_b.sql': 'CREATE TABLE b (id int);\n',
  };
  const migrations = {};
  for (const [rel, c] of Object.entries(arquivos)) if (/^migrations\/[^/]+\.sql$/.test(rel)) migrations[path.basename(rel)] = sha(c);
  arquivos['migrations/checksums.json'] = JSON.stringify({ algoritmo: 'sha256', migrations });
  for (const [rel, c] of Object.entries(arquivos)) { fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true }); fs.writeFileSync(path.join(raiz, rel), c); }
  return raiz;
}
function releaseBackend() {
  const dir = path.join(novo('hml-saida-'), 'release');
  gerarReleaseBackend({ saida: dir, commit: COMMIT, rotulo: ROTULO, atual: true, agora: AGORA, raiz: raizBackend() });
  return { dir, commit: COMMIT, rotulo: ROTULO, releaseSha256: sha(fs.readFileSync(path.join(dir, 'release.json'))), escopo: 'backend' };
}
function releaseFrontend() {
  const dir = novo('hml-front-');
  const release = { commit: COMMIT, rotulo: ROTULO, atual: true, geradoEm: '2026-11-18T12:00:00.000Z' };
  for (const c of ['portal', 'painel']) {
    fs.mkdirSync(path.join(dir, c)); fs.writeFileSync(path.join(dir, c, 'index.html'), c);
    const m = `${sha(c)}  index.html\n`; fs.writeFileSync(path.join(dir, `manifesto-${c}.sha256`), m);
    release[c] = { arquivos: 1, manifestoSha256: sha(m) };
  }
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release));
  return { dir, commit: COMMIT, rotulo: ROTULO, releaseSha256: sha(fs.readFileSync(path.join(dir, 'release.json'))) };
}
function reselar(dir, mutar) {
  const caminho = path.join(dir, 'release.json');
  const r = JSON.parse(fs.readFileSync(caminho, 'utf8'));
  mutar(r);
  fs.writeFileSync(caminho, `${JSON.stringify(r, null, 2)}\n`);
  return sha(fs.readFileSync(caminho));
}
const pedidoV2 = (extra = {}) => ({
  versao: 2, repositorio: P.REPO, id: '123-1', commit: COMMIT, rotulo: ROTULO, releaseSha256: 'a'.repeat(64), blobSha256: 'b'.repeat(64),
  permitirAnterior: false, criadoEm: new Date(AGORA).toISOString(), expiraEm: new Date(AGORA + 10 * 60000).toISOString(), escopo: 'backend', ...extra,
});
const sem = (o, k) => { const c = { ...o }; delete c[k]; return c; };
const pedidoV1 = () => ({ ...sem(pedidoV2(), 'escopo'), versao: 1 });

// Valores medidos com a implementação ANTERIOR à troca do .sort() (fixtures acima são determinísticas).
const OURO = {
  releaseBackendSha256: '43da362ca4e7212fad3290d01a01213e5c241b64f106938764785308db32f95c',
  blobBackendSha256: '0dac484bf7a5f02f515d024899140980d53ff1dda7d3156f68da5c3f47bd7f0f',
  releaseFrontendSha256: '93ea263e23b9210f169669e80bed3ac7aad139d998c265e2e9522372023d57e9',
  blobFrontendSha256: 'b076f98a45c9671b29ed0732fecfbc1cf43e0f5ba78d090544d53380aceeea53',
};

describe('S2871: nenhuma ordenação de chaves sem comparador em protocolo.js', () => {
  test('as três ocorrências do código novo não usam mais Object.keys(...).sort() sem comparador; só resta a do frontend anterior (não alterada)', () => {
    const restantes = fonte.split('\n').filter((l) => /Object\.keys\([^)]*\)\.sort\(\)/.test(l));
    assert.equal(restantes.length, 1, restantes.join('\n'));
    assert.match(restantes[0], /'atual,commit,geradoEm,painel,portal,rotulo'/, 'a única restante é a conferência da release de frontend, anterior à Etapa 1');
  });
  test('a ordenação das chaves vive em UM lugar: chavesOrdenadas, com localeCompare(b, \'en\')', () => {
    assert.equal(typeof P.chavesOrdenadas, 'function');
    assert.match(fonte, /const chavesOrdenadas = o => Object\.keys\(o\)\.sort\(\(a, b\) => a\.localeCompare\(b, 'en'\)\)\.join\(','\);/);
    assert.equal((fonte.match(/chavesOrdenadas\(/g) || []).length, 3, 'as três ocorrências apontadas pelo Sonar');
  });
  test('as demais ordenações não foram tocadas (listagens de diretório: 3 ocorrências, e a do frontend anterior)', () => {
    assert.equal((fonte.match(/readdirSync\([^)]*\)\.sort\(\)/g) || []).length, 3);
  });
});

describe('S2871: ordem canônica dos quatro conjuntos de chaves', () => {
  for (const [nome, canonico] of Object.entries(CANONICOS)) {
    test(`${nome}: qualquer ordem de inserção produz a ordem canônica`, () => {
      for (const entrada of embaralhamentos(canonico)) assert.equal(P.chavesOrdenadas(objetoCom(entrada.join(','))), canonico);
    });
    test(`${nome}: é a mesma ordem do .sort() padrão de antes`, () => {
      for (const entrada of embaralhamentos(canonico)) assert.equal(P.chavesOrdenadas(objetoCom(entrada.join(','))), [...entrada].sort().join(','));
    });
  }
  test('objeto vazio e chave única', () => {
    assert.equal(P.chavesOrdenadas({}), '');
    assert.equal(P.chavesOrdenadas({ x: 1 }), 'x');
  });
});

describe('S2871: rejeição de chaves extras e ausentes continua exata', () => {
  test('pedido v1 e v2: cada chave ausente e qualquer chave extra viram PEDIDO_INVALIDO', () => {
    for (const [pedido, escopo] of [[pedidoV1(), 'frontend'], [pedidoV2(), 'backend']]) {
      assert.doesNotThrow(() => P.validarPedido(pedido, AGORA, { escopo }));
      for (const chave of Object.keys(pedido)) recusa(() => P.validarPedido(sem(pedido, chave), AGORA, { escopo }), 'PEDIDO_INVALIDO');
      for (const extra of ['extra', 'Escopo', 'ZZ', 'aaa', 'versao2', '']) recusa(() => P.validarPedido({ ...pedido, [extra]: 1 }, AGORA, { escopo }), 'PEDIDO_INVALIDO');
    }
  });
  test('release do backend: cada chave ausente e chave extra, no topo e na seção backend, viram ESCOPO_INVALIDO', () => {
    const topo = Object.keys(JSON.parse(fs.readFileSync(path.join(releaseBackend().dir, 'release.json'), 'utf8')));
    for (const chave of topo) { const f = releaseBackend(); f.releaseSha256 = reselar(f.dir, (r) => { delete r[chave]; }); recusa(() => P.conferirRelease(f), 'ESCOPO_INVALIDO'); }
    for (const extra of ['extra', 'Atual', 'zz']) { const f = releaseBackend(); f.releaseSha256 = reselar(f.dir, (r) => { r[extra] = 1; }); recusa(() => P.conferirRelease(f), 'ESCOPO_INVALIDO'); }
    const secao = Object.keys(JSON.parse(fs.readFileSync(path.join(releaseBackend().dir, 'release.json'), 'utf8')).backend);
    for (const chave of secao) { const f = releaseBackend(); f.releaseSha256 = reselar(f.dir, (r) => { delete r.backend[chave]; }); recusa(() => P.conferirRelease(f), 'ESCOPO_INVALIDO'); }
    for (const extra of ['extra', 'Node', 'zz']) { const f = releaseBackend(); f.releaseSha256 = reselar(f.dir, (r) => { r.backend[extra] = 1; }); recusa(() => P.conferirRelease(f), 'ESCOPO_INVALIDO'); }
  });
});

describe('S2871: o resultado não depende do locale do processo (sem exigir locales instalados no sistema)', () => {
  const locais = ['en_US.UTF-8', 'tr_TR.UTF-8', 'sv_SE.UTF-8', 'pt_BR.UTF-8', 'lt_LT.UTF-8', 'C'];
  const roteiro = `
    const P = require(${JSON.stringify(PROTOCOLO)});
    const C = ${JSON.stringify(CANONICOS)};
    const saida = { locale: Intl.DateTimeFormat().resolvedOptions().locale, ordens: {} };
    for (const [nome, lista] of Object.entries(C)) {
      const base = lista.split(',');
      const entradas = [base, [...base].reverse(), ...base.map((_, i) => [...base.slice(i), ...base.slice(0, i)])];
      saida.ordens[nome] = entradas.map((e) => P.chavesOrdenadas(Object.fromEntries(e.map((k) => [k, 1]))));
    }
    process.stdout.write(JSON.stringify(saida));`;
  test('mesma ordem canônica sob LC_ALL/LANG de locais distintos (tr, sv, lt, pt-BR, C)', (t) => {
    const vistos = new Set();
    for (const l of locais) {
      const r = spawnSync(process.execPath, ['-e', roteiro], { env: { PATH: process.env.PATH, LC_ALL: l, LANG: l, LANGUAGE: l.slice(0, 2) }, encoding: 'utf8' });
      assert.equal(r.status, 0, `${l}: ${r.stderr}`);
      const saida = JSON.parse(r.stdout);
      vistos.add(saida.locale);
      for (const [nome, ordens] of Object.entries(saida.ordens)) for (const o of ordens) assert.equal(o, CANONICOS[nome], `${l} (${saida.locale}) ${nome}`);
    }
    t.diagnostic(`locales padrão efetivos nos processos filhos: ${[...vistos].join(', ')}`);
  });
});

describe('S2871: protocolo v1, hashes, serialização e manifestos preservados', () => {
  test('pedido v1 (fluxo atual do frontend) segue válido e é frontend', () => {
    assert.doesNotThrow(() => P.validarPedido(pedidoV1(), AGORA));
    assert.equal(P.escopoDoPedido(pedidoV1()), 'frontend');
    recusa(() => P.validarPedido(pedidoV1(), AGORA, { escopo: 'backend' }), 'ESCOPO_DIVERGENTE');
  });
  test('release de frontend: mesmo hash e mesmo blob de antes', () => {
    const f = releaseFrontend();
    assert.equal(f.releaseSha256, OURO.releaseFrontendSha256);
    assert.equal(sha(P.empacotar(f.dir, f)), OURO.blobFrontendSha256);
  });
  test('release do backend: mesmo release.json (hash), mesmos manifestos e mesmo blob de antes', () => {
    const f = releaseBackend();
    assert.equal(f.releaseSha256, OURO.releaseBackendSha256);
    assert.equal(sha(P.empacotar(f.dir, f)), OURO.blobBackendSha256);
    assert.doesNotThrow(() => P.conferirRelease(f));
  });
});
