'use strict';
// Publicação do backend (Etapa 1): contexto de autorização próprio, pedido v2 com escopo e chaves S3 em prefixo próprio.
// O fluxo de frontend não pode mudar: pedido v1, chaves hml/..., contexto e retorno idênticos aos de antes.
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const RAIZ = path.resolve(__dirname, '../../../..');
const P = require(path.join(RAIZ, 'deploy/hml/cd/protocolo.js'));
const publicar = require(path.join(RAIZ, 'deploy/hml/cd/publicar.js'));
const { gerarReleaseBackend } = require(path.join(RAIZ, 'deploy/hml/empacotar-backend.js'));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const COMMIT = 'c'.repeat(40);
const ROTULO = `hml-20261118T120000-${COMMIT.slice(0, 7)}`;
const REPO = 'ramirespaes/Gestao_Epi_Fabricas';
const temporarios = [];
afterEach(() => { while (temporarios.length) fs.rmSync(temporarios.pop(), { recursive: true, force: true }); });
const novo = (p = 'hml-pb-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temporarios.push(d); return d; };

function raizBackend() {
  const raiz = novo('hml-raiz-');
  const lock = { name: 'x', lockfileVersion: 3, packages: { '': { name: 'x', version: '1.0.0' }, 'node_modules/zod': { version: '4.0.0', resolved: 'https://registry.npmjs.org/zod/-/zod-4.0.0.tgz', integrity: 'sha512-AAAA' } } };
  const arquivos = {
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', engines: { node: '>=22' }, scripts: { start: 'node src/server.js' }, dependencies: { zod: '^4.0.0' } }),
    'package-lock.json': JSON.stringify(lock), 'src/server.js': "'use strict';\n", 'scripts/guarda-inicializacao.js': "'use strict';\n",
    'migrations/000_a.sql': 'CREATE TABLE a (id int);\n',
  };
  arquivos['migrations/checksums.json'] = JSON.stringify({ algoritmo: 'sha256', migrations: { '000_a.sql': sha(arquivos['migrations/000_a.sql']) } });
  for (const [rel, c] of Object.entries(arquivos)) { fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true }); fs.writeFileSync(path.join(raiz, rel), c); }
  return raiz;
}
function releaseBackend() {
  const dir = path.join(novo('hml-saida-'), 'release');
  gerarReleaseBackend({ saida: dir, commit: COMMIT, rotulo: ROTULO, atual: true, raiz: raizBackend() });
  return { dir, commit: COMMIT, rotulo: ROTULO, releaseSha256: sha(fs.readFileSync(path.join(dir, 'release.json'))) };
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
// S3 falso: registra o que foi gravado; o "agente" responde com o recibo informado (ou nenhum).
function s3Falso({ recibo = null, prefixoDoRecibo } = {}) {
  const puts = [], gets = [];
  return {
    puts, gets,
    put: async (key, b) => { puts.push({ key, b }); },
    get: async (key) => {
      gets.push(key);
      if (recibo === null || !key.includes('/recibos/')) return null;
      if (prefixoDoRecibo && !key.startsWith(`${prefixoDoRecibo}/`)) return null;
      return Buffer.from(JSON.stringify(recibo));
    },
  };
}
const AGORA = Date.parse('2026-11-18T12:00:00.000Z');
const opcoes = { id: '777-1', agora: () => AGORA, esperar: async () => {}, tentativas: 2 };
const reciboOk = (extra = {}) => ({ id: '777-1', commit: COMMIT, releaseSha256: null, estado: 'SUCESSO', verificado: true, ...extra });

describe('publicar(): backend', () => {
  test('grava blob e depois o pedido v2 com escopo backend, só no prefixo hml-backend/', async () => {
    const f = releaseBackend();
    const s3 = s3Falso({ recibo: reciboOk({ releaseSha256: f.releaseSha256, escopo: 'backend' }) });
    const recibo = await publicar.publicar({ ...f, ...opcoes, escopo: 'backend', s3 });
    assert.equal(recibo.estado, 'SUCESSO');
    assert.deepEqual(s3.puts.map((p) => p.key), ['hml-backend/blobs/777-1.json', 'hml-backend/pedidos/777-1.json']);
    assert.ok(s3.puts.every((p) => !p.key.startsWith('hml/')), 'nenhuma chave do prefixo do frontend');
    const pedido = JSON.parse(s3.puts[1].b.toString('utf8'));
    assert.equal(pedido.versao, 2);
    assert.equal(pedido.escopo, 'backend');
    assert.equal(pedido.commit, COMMIT);
    assert.equal(pedido.rotulo, ROTULO);
    assert.equal(pedido.releaseSha256, f.releaseSha256);
    assert.equal(pedido.blobSha256, sha(s3.puts[0].b), 'o pedido está vinculado ao blob exato');
    assert.equal(pedido.permitirAnterior, false);
    assert.doesNotThrow(() => P.validarPedido(pedido, AGORA, { escopo: 'backend' }));
    assert.throws(() => P.validarPedido(pedido, AGORA), (e) => e.codigo === 'ESCOPO_DIVERGENTE', 'quem espera frontend recusa');
  });
  test('o blob gravado reproduz a release aprovada (mesmo hash, mesmo commit)', async () => {
    const f = releaseBackend();
    const s3 = s3Falso({ recibo: reciboOk({ releaseSha256: f.releaseSha256, escopo: 'backend' }) });
    await publicar.publicar({ ...f, ...opcoes, escopo: 'backend', s3 });
    const destino = path.join(novo('hml-ext-'), 'x');
    P.extrair(s3.puts[0].b, destino);
    assert.doesNotThrow(() => P.conferirRelease({ ...f, dir: destino, escopo: 'backend' }));
  });
  test('lê o recibo no prefixo do backend e exige o mesmo escopo', async () => {
    const f = releaseBackend();
    const s3 = s3Falso({ recibo: reciboOk({ releaseSha256: f.releaseSha256, escopo: 'backend' }), prefixoDoRecibo: 'hml-backend' });
    await publicar.publicar({ ...f, ...opcoes, escopo: 'backend', s3 });
    assert.ok(s3.gets.every((k) => k.startsWith('hml-backend/recibos/')), s3.gets.join(','));
  });
  test('recibo sem escopo, ou de frontend, não conclui a publicação do backend', async () => {
    const f = releaseBackend();
    for (const extra of [{}, { escopo: 'frontend' }]) {
      const s3 = s3Falso({ recibo: reciboOk({ releaseSha256: f.releaseSha256, ...extra }) });
      await assert.rejects(publicar.publicar({ ...f, ...opcoes, escopo: 'backend', s3 }), (e) => e.codigo === 'RECIBO_INVALIDO');
    }
  });
  test('recibo FALHOU ou sem verificação não aprova', async () => {
    const f = releaseBackend();
    const s3 = s3Falso({ recibo: reciboOk({ releaseSha256: f.releaseSha256, escopo: 'backend', estado: 'FALHOU', verificado: false }) });
    await assert.rejects(publicar.publicar({ ...f, ...opcoes, escopo: 'backend', s3 }), (e) => e.codigo === 'DEPLOY_NAO_APROVADO');
  });
  test('sem recibo dentro das tentativas: SEM_RECIBO_CONCLUSIVO', async () => {
    const f = releaseBackend();
    await assert.rejects(publicar.publicar({ ...f, ...opcoes, escopo: 'backend', s3: s3Falso() }), (e) => e.codigo === 'SEM_RECIBO_CONCLUSIVO');
  });
  test('artefato de outro escopo é recusado ANTES de gravar qualquer coisa', async () => {
    const back = releaseBackend(), front = releaseFrontend();
    const a = s3Falso(), b = s3Falso();
    await assert.rejects(publicar.publicar({ ...front, ...opcoes, escopo: 'backend', s3: a }), (e) => e.codigo === 'ESCOPO_INVALIDO');
    await assert.rejects(publicar.publicar({ ...back, ...opcoes, escopo: 'frontend', s3: b }), (e) => e.codigo === 'ESCOPO_INVALIDO');
    assert.equal(a.puts.length + b.puts.length, 0);
  });
  test('escopo desconhecido é recusado antes de gravar qualquer coisa', async () => {
    const f = releaseBackend();
    for (const escopo of ['', 'producao', null, 3]) {
      const s3 = s3Falso();
      await assert.rejects(publicar.publicar({ ...f, ...opcoes, escopo, s3 }), (e) => ['ESCOPO_INVALIDO', 'IDENTIDADE_INVALIDA'].includes(e.codigo));
      assert.equal(s3.puts.length, 0);
    }
  });
  test('backend nunca publica com permitirAnterior', async () => {
    const f = releaseBackend();
    const s3 = s3Falso();
    await assert.rejects(publicar.publicar({ ...f, ...opcoes, escopo: 'backend', permitirAnterior: true, s3 }), (e) => e.codigo === 'RETROATIVO_BLOQUEADO');
    assert.equal(s3.puts.length, 0);
  });
});

describe('publicar(): o frontend continua exatamente como antes', () => {
  test('pedido v1 sem escopo, chaves em hml/, recibo sem escopo', async () => {
    const f = releaseFrontend();
    const s3 = s3Falso({ recibo: reciboOk({ releaseSha256: f.releaseSha256 }) });
    const recibo = await publicar.publicar({ ...f, ...opcoes, s3 });
    assert.equal(recibo.estado, 'SUCESSO');
    assert.deepEqual(s3.puts.map((p) => p.key), ['hml/blobs/777-1.json', 'hml/pedidos/777-1.json']);
    const pedido = JSON.parse(s3.puts[1].b.toString('utf8'));
    assert.equal(pedido.versao, 1);
    assert.equal('escopo' in pedido, false);
    assert.doesNotThrow(() => P.validarPedido(pedido, AGORA));
  });
  test('escopo frontend explícito produz o mesmo pedido v1', async () => {
    const f = releaseFrontend();
    const s3 = s3Falso({ recibo: reciboOk({ releaseSha256: f.releaseSha256 }) });
    await publicar.publicar({ ...f, ...opcoes, escopo: 'frontend', s3 });
    assert.equal(JSON.parse(s3.puts[1].b.toString('utf8')).versao, 1);
    assert.ok(s3.puts.every((p) => p.key.startsWith('hml/')));
  });
});

describe('prefixoDoEscopo', () => {
  test('cada escopo tem um prefixo próprio e disjunto', () => {
    assert.equal(publicar.prefixoDoEscopo('frontend'), 'hml');
    assert.equal(publicar.prefixoDoEscopo('backend'), 'hml-backend');
    for (const e of ['', 'producao', null, undefined]) assert.throws(() => publicar.prefixoDoEscopo(e), (x) => x.codigo === 'ESCOPO_INVALIDO');
  });
});

describe('decidirContexto(): backend só por disparo manual, com autorização própria', () => {
  const backend = (extra = {}) => ({
    GITHUB_REPOSITORY: REPO, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/deploy-hml-backend.yml@refs/heads/main`,
    HML_ESCOPO: 'backend', HML_BACKEND_HABILITADA: 'true', HML_PUBLICAR: 'true', HML_CONFIRMACAO: 'HOMOLOGACAO-BACKEND',
    HML_PERMITIR_ANTERIOR: 'false', HML_ROTULO: ROTULO, ...extra,
  });
  const bloqueia = (env) => assert.throws(() => publicar.decidirContexto(env), (e) => e.codigo === 'CONTEXTO_BLOQUEADO');
  test('contexto válido devolve o escopo backend', () => {
    assert.deepEqual(publicar.decidirContexto(backend()), { modo: 'manual', permitirAnterior: false, escopo: 'backend' });
  });
  test('a confirmação do frontend não autoriza o backend, nem variações', () => {
    for (const c of ['HOMOLOGACAO', 'homologacao-backend', 'HOMOLOGACAO-BACKEND ', 'HOMOLOGACAO_BACKEND', '', undefined]) bloqueia(backend({ HML_CONFIRMACAO: c }));
  });
  test('o interruptor do frontend não habilita o backend; o do backend precisa ser exatamente true', () => {
    bloqueia(backend({ HML_BACKEND_HABILITADA: undefined, HML_HABILITADA: 'true' }));
    for (const v of ['false', '', 'TRUE', '1', 'yes', undefined]) bloqueia(backend({ HML_BACKEND_HABILITADA: v }));
  });
  test('nunca é automático: só workflow_dispatch', () => {
    for (const ev of ['workflow_run', 'push', 'schedule', 'pull_request', 'repository_dispatch', undefined, '']) bloqueia(backend({ GITHUB_EVENT_NAME: ev }));
  });
  test('exige publicar=true, main, repositório, tentativa 1 e o workflow do backend', () => {
    for (const v of ['false', '', undefined, 'TRUE']) bloqueia(backend({ HML_PUBLICAR: v }));
    bloqueia(backend({ GITHUB_REF: 'refs/heads/outra' }));
    bloqueia(backend({ GITHUB_REPOSITORY: 'outro/repo' }));
    for (const t of ['2', '0', '', undefined]) bloqueia(backend({ GITHUB_RUN_ATTEMPT: t }));
    for (const w of [`${REPO}/.github/workflows/deploy-hml.yml@refs/heads/main`, `${REPO}/.github/workflows/deploy-hml-backend.yml@refs/heads/outra`,
      `outro/repo/.github/workflows/deploy-hml-backend.yml@refs/heads/main`, '', undefined]) bloqueia(backend({ GITHUB_WORKFLOW_REF: w }));
  });
  test('nunca retroativo nem com commit anterior', () => {
    bloqueia(backend({ HML_ROTULO: `${ROTULO}-retroativo` }));
    for (const v of ['true', '', undefined, 'talvez']) bloqueia(backend({ HML_PERMITIR_ANTERIOR: v }));
    for (const r of ['', undefined, 'qualquer']) bloqueia(backend({ HML_ROTULO: r }));
  });
  test('escopo desconhecido bloqueia, inclusive vazio', () => {
    for (const e of ['producao', 'Backend', 'BACKEND', '', 'backend,frontend']) bloqueia(backend({ HML_ESCOPO: e }));
  });
});

describe('decidirContexto(): o frontend não aceita o escopo ou os literais do backend', () => {
  const frontend = (extra = {}) => ({
    GITHUB_REPOSITORY: REPO, GITHUB_REF: 'refs/heads/main', HML_HABILITADA: 'true', GITHUB_RUN_ATTEMPT: '1', HML_ROTULO: ROTULO,
    GITHUB_EVENT_NAME: 'workflow_dispatch', HML_PUBLICAR: 'true', HML_CONFIRMACAO: 'HOMOLOGACAO', HML_PERMITIR_ANTERIOR: 'false', ...extra,
  });
  const bloqueia = (env) => assert.throws(() => publicar.decidirContexto(env), (e) => e.codigo === 'CONTEXTO_BLOQUEADO');
  test('retorno do frontend inalterado, sem a chave escopo, com ou sem escopo explícito', () => {
    assert.deepEqual(publicar.decidirContexto(frontend()), { modo: 'manual', permitirAnterior: false });
    assert.deepEqual(publicar.decidirContexto(frontend({ HML_ESCOPO: 'frontend' })), { modo: 'manual', permitirAnterior: false });
  });
  test('a confirmação do backend não autoriza o frontend', () => {
    bloqueia(frontend({ HML_CONFIRMACAO: 'HOMOLOGACAO-BACKEND' }));
  });
  test('o interruptor do backend não habilita o frontend', () => {
    bloqueia(frontend({ HML_HABILITADA: 'false', HML_BACKEND_HABILITADA: 'true' }));
  });
  test('escopo backend declarado no frontend obedece às regras do backend (nunca às do frontend)', () => {
    bloqueia(frontend({ HML_ESCOPO: 'backend' }));
  });
  test('o automático do frontend nunca aceita escopo backend', () => {
    const auto = { GITHUB_REPOSITORY: REPO, GITHUB_REF: 'refs/heads/main', HML_HABILITADA: 'true', GITHUB_RUN_ATTEMPT: '1', HML_ROTULO: ROTULO, GITHUB_EVENT_NAME: 'workflow_run', HML_PUBLICAR: '', HML_CONFIRMACAO: '', HML_PERMITIR_ANTERIOR: '' };
    assert.deepEqual(publicar.decidirContexto(auto), { modo: 'automatico', permitirAnterior: false });
    bloqueia({ ...auto, HML_ESCOPO: 'backend' });
    bloqueia({ ...auto, HML_ESCOPO: 'producao' });
  });
});
