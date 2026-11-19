'use strict';
// Protocolo v2 do CD de homologação: escopo explícito (frontend | backend) vinculado ao pedido, ao recibo e ao artefato.
// O fluxo atual de Portal e Painel (pedido v1, sem escopo) continua válido e continua sendo SOMENTE frontend.
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_RAIZ = path.resolve(__dirname, '../../../..');
const P = require(path.join(REPO_RAIZ, 'deploy/hml/cd/protocolo.js'));
const { gerarReleaseBackend } = require(path.join(REPO_RAIZ, 'deploy/hml/empacotar-backend.js'));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const COMMIT = 'c'.repeat(40);
const ROTULO = `hml-20261118T120000-${COMMIT.slice(0, 7)}`;
const temporarios = [];
afterEach(() => { while (temporarios.length) fs.rmSync(temporarios.pop(), { recursive: true, force: true }); });
const novo = (prefixo = 'hml-v2-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefixo)); temporarios.push(d); return d; };
function recusa(fn, codigo) {
  assert.throws(fn, (e) => { assert.equal(e.codigo, codigo, `esperado ${codigo}, veio ${e.codigo}: ${e.message}`); return true; });
}

// ---- backend sintético com a forma do real, empacotado pelo empacotador oficial
function criarRaizBackend() {
  const raiz = novo('hml-raiz-');
  const lock = { name: 'x', lockfileVersion: 3, packages: { '': { name: 'x', version: '1.0.0' }, 'node_modules/zod': { version: '4.0.0', resolved: 'https://registry.npmjs.org/zod/-/zod-4.0.0.tgz', integrity: 'sha512-AAAA' } } };
  const pacote = { name: 'x', version: '1.0.0', engines: { node: '>=22' }, scripts: { start: 'node src/server.js' }, dependencies: { zod: '^4.0.0' } };
  const arquivos = {
    'package.json': JSON.stringify(pacote), 'package-lock.json': JSON.stringify(lock),
    'src/server.js': "'use strict';\nrequire('./app');\n", 'src/app.js': "'use strict';\nmodule.exports = {};\n",
    'scripts/guarda-inicializacao.js': "'use strict';\n",
    'migrations/000_a.sql': 'CREATE TABLE a (id int);\n', 'migrations/001_b.sql': 'CREATE TABLE b (id int);\n',
  };
  const migrations = {};
  for (const [rel, conteudo] of Object.entries(arquivos)) if (/^migrations\/[^/]+\.sql$/.test(rel)) migrations[path.basename(rel)] = sha(conteudo);
  arquivos['migrations/checksums.json'] = JSON.stringify({ algoritmo: 'sha256', migrations });
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
    fs.writeFileSync(path.join(raiz, rel), conteudo);
  }
  return raiz;
}
function releaseBackend() {
  const saida = path.join(novo('hml-saida-'), 'release');
  gerarReleaseBackend({ saida, commit: COMMIT, rotulo: ROTULO, atual: true, raiz: criarRaizBackend() });
  return { dir: saida, commit: COMMIT, rotulo: ROTULO, releaseSha256: sha(fs.readFileSync(path.join(saida, 'release.json'))), escopo: 'backend' };
}
// ---- release de frontend com a forma que o fluxo atual produz
function releaseFrontend() {
  const dir = novo('hml-front-');
  const release = { commit: COMMIT, rotulo: ROTULO, atual: true, geradoEm: '2026-11-18T12:00:00.000Z' };
  for (const c of ['portal', 'painel']) {
    fs.mkdirSync(path.join(dir, c));
    fs.writeFileSync(path.join(dir, c, 'index.html'), c);
    const m = `${sha(c)}  index.html\n`;
    fs.writeFileSync(path.join(dir, `manifesto-${c}.sha256`), m);
    release[c] = { arquivos: 1, manifestoSha256: sha(m) };
  }
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release));
  return { dir, commit: COMMIT, rotulo: ROTULO, releaseSha256: sha(fs.readFileSync(path.join(dir, 'release.json'))) };
}
// Regrava release.json e devolve o novo hash (isola a regra testada do HASH_RELEASE)
function reselar(dir, mutar) {
  const caminho = path.join(dir, 'release.json');
  const r = JSON.parse(fs.readFileSync(caminho, 'utf8'));
  mutar(r);
  fs.writeFileSync(caminho, `${JSON.stringify(r, null, 2)}\n`);
  return sha(fs.readFileSync(caminho));
}

const AGORA = Date.parse('2026-11-18T12:00:00.000Z');
const pedidoV2 = (extra = {}) => ({
  versao: 2, repositorio: P.REPO, id: '123-1', commit: COMMIT, rotulo: ROTULO, releaseSha256: 'a'.repeat(64), blobSha256: 'b'.repeat(64),
  permitirAnterior: false, criadoEm: new Date(AGORA).toISOString(), expiraEm: new Date(AGORA + 10 * 60000).toISOString(), escopo: 'backend', ...extra,
});
const sem = (obj, chave) => { const c = { ...obj }; delete c[chave]; return c; };
const pedidoV1 = (extra = {}) => ({ ...sem(pedidoV2(), 'escopo'), versao: 1, ...extra });

describe('protocolo v2: pedido com escopo explícito', () => {
  test('exporta o contrato do escopo e mantém os componentes do frontend', () => {
    assert.deepEqual(P.ESCOPOS, ['frontend', 'backend']);
    assert.deepEqual(P.COMPONENTES, ['portal', 'painel']);
    assert.equal(typeof P.escopoDoPedido, 'function');
  });
  test('pedido v2 de backend é válido SOMENTE quando o chamador declara o escopo backend', () => {
    assert.doesNotThrow(() => P.validarPedido(pedidoV2(), AGORA, { escopo: 'backend' }));
    assert.equal(P.escopoDoPedido(pedidoV2()), 'backend');
  });
  test('pedido v2 de frontend também é válido, e só para o escopo frontend', () => {
    assert.doesNotThrow(() => P.validarPedido(pedidoV2({ escopo: 'frontend' }), AGORA, { escopo: 'frontend' }));
    recusa(() => P.validarPedido(pedidoV2({ escopo: 'frontend' }), AGORA, { escopo: 'backend' }), 'ESCOPO_DIVERGENTE');
  });
  test('pedido v1 (fluxo atual, sem escopo) continua válido e é frontend por definição', () => {
    assert.doesNotThrow(() => P.validarPedido(pedidoV1(), AGORA));
    assert.doesNotThrow(() => P.validarPedido(pedidoV1(), AGORA, { escopo: 'frontend' }));
    assert.equal(P.escopoDoPedido(pedidoV1()), 'frontend');
  });
  test('pedido v1 nunca autoriza backend', () => {
    recusa(() => P.validarPedido(pedidoV1(), AGORA, { escopo: 'backend' }), 'ESCOPO_DIVERGENTE');
  });
  test('sem escopo declarado pelo chamador o padrão é frontend: um pedido de backend não passa por quem não o espera', () => {
    recusa(() => P.validarPedido(pedidoV2(), AGORA), 'ESCOPO_DIVERGENTE');
    recusa(() => P.validarPedido(pedidoV2(), AGORA, {}), 'ESCOPO_DIVERGENTE');
    recusa(() => P.validarPedido(pedidoV2(), AGORA, { escopo: 'frontend' }), 'ESCOPO_DIVERGENTE');
  });
  test('pedido v2 sem escopo é recusado', () => {
    recusa(() => P.validarPedido(sem(pedidoV2(), 'escopo'), AGORA, { escopo: 'backend' }), 'PEDIDO_INVALIDO');
    recusa(() => P.validarPedido(sem(pedidoV2(), 'escopo'), AGORA), 'PEDIDO_INVALIDO');
  });
  test('escopo inválido, vazio, em outra caixa ou de outro tipo é recusado', () => {
    for (const escopo of ['', 'Backend', 'BACKEND', 'producao', 'backend ', 'front', null, undefined, 1, true, ['backend'], { x: 1 }]) {
      recusa(() => P.validarPedido(pedidoV2({ escopo }), AGORA, { escopo: 'backend' }), 'PEDIDO_INVALIDO');
    }
  });
  test('o escopo pedido ao validador também precisa ser conhecido', () => {
    for (const escopo of ['', 'producao', null, 1]) recusa(() => P.validarPedido(pedidoV2(), AGORA, { escopo }), 'ESCOPO_INVALIDO');
  });
  test('pedido v1 com a chave escopo, versão desconhecida ou chave extra é recusado', () => {
    recusa(() => P.validarPedido({ ...pedidoV1(), escopo: 'backend' }, AGORA, { escopo: 'backend' }), 'PEDIDO_INVALIDO');
    recusa(() => P.validarPedido({ ...pedidoV1(), escopo: 'frontend' }, AGORA), 'PEDIDO_INVALIDO');
    for (const versao of [0, 3, '2', null, undefined]) recusa(() => P.validarPedido(pedidoV2({ versao }), AGORA, { escopo: 'backend' }), 'PEDIDO_INVALIDO');
    recusa(() => P.validarPedido(pedidoV2({ extra: 1 }), AGORA, { escopo: 'backend' }), 'PEDIDO_INVALIDO');
  });
  test('pedido adulterado: repositório, commit, rótulo, hashes, id e tipos', () => {
    const ruins = [
      { repositorio: 'outro/repositorio' }, { commit: 'x'.repeat(40) }, { commit: 'c'.repeat(39) }, { rotulo: 'qualquer' }, { releaseSha256: 'g'.repeat(64) },
      { blobSha256: 'a'.repeat(63) }, { id: '0-1' }, { id: 'abc' }, { permitirAnterior: 'false' }, { permitirAnterior: undefined },
    ];
    for (const ruim of ruins) recusa(() => P.validarPedido(pedidoV2(ruim), AGORA, { escopo: 'backend' }), 'PEDIDO_INVALIDO');
  });
  test('pedido expirado, do futuro ou com validade acima de 15 min é recusado', () => {
    const iso = (ms) => new Date(ms).toISOString();
    recusa(() => P.validarPedido(pedidoV2({ criadoEm: iso(AGORA - 20 * 60000), expiraEm: iso(AGORA - 5 * 60000) }), AGORA, { escopo: 'backend' }), 'PEDIDO_EXPIRADO');
    recusa(() => P.validarPedido(pedidoV2({ criadoEm: iso(AGORA + 5 * 60000), expiraEm: iso(AGORA + 9 * 60000) }), AGORA, { escopo: 'backend' }), 'PEDIDO_EXPIRADO');
    recusa(() => P.validarPedido(pedidoV2({ expiraEm: iso(AGORA + 16 * 60000) }), AGORA, { escopo: 'backend' }), 'PEDIDO_EXPIRADO');
    recusa(() => P.validarPedido(pedidoV2({ criadoEm: 'ontem', expiraEm: 'amanhã' }), AGORA, { escopo: 'backend' }), 'PEDIDO_EXPIRADO');
    recusa(() => P.validarPedido(pedidoV2({ expiraEm: iso(AGORA - 1) }), AGORA, { escopo: 'backend' }), 'PEDIDO_EXPIRADO');
  });
  test('backend nunca é retroativo nem aceita commit anterior', () => {
    recusa(() => P.validarPedido(pedidoV2({ permitirAnterior: true }), AGORA, { escopo: 'backend' }), 'RETROATIVO_BLOQUEADO');
    recusa(() => P.validarPedido(pedidoV2({ rotulo: `${ROTULO}-retroativo`, permitirAnterior: true }), AGORA, { escopo: 'backend' }), 'RETROATIVO_BLOQUEADO');
    recusa(() => P.validarPedido(pedidoV2({ rotulo: `${ROTULO}-retroativo` }), AGORA, { escopo: 'backend' }), 'RETROATIVO_BLOQUEADO');
  });
  test('o frontend mantém a regra anterior: retroativo só com permitirAnterior', () => {
    recusa(() => P.validarPedido(pedidoV1({ rotulo: `${ROTULO}-retroativo` }), AGORA), 'RETROATIVO_BLOQUEADO');
    assert.doesNotThrow(() => P.validarPedido(pedidoV1({ rotulo: `${ROTULO}-retroativo`, permitirAnterior: true }), AGORA));
  });
});

describe('protocolo v2: recibo vinculado ao escopo do pedido', () => {
  const recibo = (extra = {}) => ({ id: '123-1', commit: COMMIT, releaseSha256: 'a'.repeat(64), estado: 'SUCESSO', verificado: true, ...extra });
  test('pedido v2 exige recibo com o MESMO escopo', () => {
    assert.doesNotThrow(() => P.validarRecibo(recibo({ escopo: 'backend' }), pedidoV2()));
    recusa(() => P.validarRecibo(recibo(), pedidoV2()), 'RECIBO_INVALIDO');
    recusa(() => P.validarRecibo(recibo({ escopo: 'frontend' }), pedidoV2()), 'RECIBO_INVALIDO');
    recusa(() => P.validarRecibo(recibo({ escopo: 'Backend' }), pedidoV2()), 'RECIBO_INVALIDO');
  });
  test('recibo de backend não satisfaz pedido v1, e o recibo v1 continua igual', () => {
    assert.doesNotThrow(() => P.validarRecibo(recibo(), pedidoV1()));
    recusa(() => P.validarRecibo(recibo({ escopo: 'backend' }), pedidoV1()), 'RECIBO_INVALIDO');
  });
  test('as demais regras do recibo seguem valendo', () => {
    recusa(() => P.validarRecibo(recibo({ escopo: 'backend', id: '9-9' }), pedidoV2()), 'RECIBO_INVALIDO');
    recusa(() => P.validarRecibo(recibo({ escopo: 'backend', commit: 'd'.repeat(40) }), pedidoV2()), 'RECIBO_INVALIDO');
    recusa(() => P.validarRecibo(recibo({ escopo: 'backend', estado: 'FALHOU', verificado: false }), pedidoV2()), 'DEPLOY_NAO_APROVADO');
    recusa(() => P.validarRecibo(recibo({ escopo: 'backend', verificado: false }), pedidoV2()), 'DEPLOY_NAO_APROVADO');
  });
});

describe('protocolo v2: release do backend vinculada ao commit e ao hash aprovados', () => {
  test('release gerada pelo empacotador oficial é conferida', () => {
    const f = releaseBackend();
    const r = P.conferirRelease(f);
    assert.equal(r.release.commit, COMMIT);
    assert.deepEqual(Object.keys(r.release).sort(), ['atual', 'backend', 'commit', 'geradoEm', 'rotulo']);
  });
  test('o escopo é obrigatório para o backend: sem ele a release é lida como frontend e recusada', () => {
    const { escopo, ...semEscopo } = releaseBackend();
    recusa(() => P.conferirRelease(semEscopo), 'ESCOPO_INVALIDO');
  });
  test('escopo desconhecido na conferência é recusado', () => {
    for (const escopo of ['', 'producao', null, 7]) recusa(() => P.conferirRelease({ ...releaseBackend(), escopo }), 'IDENTIDADE_INVALIDA');
  });
  test('artefato de outro escopo não serve: frontend como backend e backend como frontend', () => {
    recusa(() => P.conferirRelease({ ...releaseFrontend(), escopo: 'backend' }), 'ESCOPO_INVALIDO');
    recusa(() => P.conferirRelease({ ...releaseBackend(), escopo: 'frontend' }), 'ESCOPO_INVALIDO');
    assert.doesNotThrow(() => P.conferirRelease({ ...releaseFrontend(), escopo: 'frontend' }));
    assert.doesNotThrow(() => P.conferirRelease(releaseFrontend()));
  });
  test('hash externo, commit e rótulo divergentes são recusados', () => {
    const f = releaseBackend();
    recusa(() => P.conferirRelease({ ...f, releaseSha256: 'b'.repeat(64) }), 'HASH_RELEASE');
    recusa(() => P.conferirRelease({ ...f, commit: 'd'.repeat(40) }), 'COMMIT_DIVERGENTE');
    recusa(() => P.conferirRelease({ ...f, rotulo: 'hml-20261118T120001-ddddddd' }), 'COMMIT_DIVERGENTE');
    recusa(() => P.conferirRelease({ ...f, releaseSha256: 'nao-e-hash' }), 'IDENTIDADE_INVALIDA');
  });
  test('arquivo do backend adulterado, removido ou acrescentado é recusado', () => {
    const adulterado = releaseBackend();
    fs.appendFileSync(path.join(adulterado.dir, 'backend/src/server.js'), '// x\n');
    assert.throws(() => P.conferirRelease(adulterado), (e) => /DIVERGENTE|DIVERGE/i.test(`${e.codigo} ${e.message}`));
    const removido = releaseBackend();
    fs.rmSync(path.join(removido.dir, 'backend/src/app.js'));
    assert.throws(() => P.conferirRelease(removido), (e) => /DIVERGENTE|DIVERGE/i.test(`${e.codigo} ${e.message}`));
    const extra = releaseBackend();
    fs.writeFileSync(path.join(extra.dir, 'backend/src/extra.js'), 'x');
    assert.throws(() => P.conferirRelease(extra), (e) => /DIVERGENTE|DIVERGE/i.test(`${e.codigo} ${e.message}`));
  });
  test('manifesto adulterado é recusado', () => {
    const f = releaseBackend();
    fs.appendFileSync(path.join(f.dir, 'manifesto-backend.sha256'), `${'0'.repeat(64)}  src/falso.js\n`);
    assert.throws(() => P.conferirRelease(f), (e) => /DIVERGENTE|DIVERGE/i.test(`${e.codigo} ${e.message}`));
  });
  test('release.json com chave extra, sem a seção backend ou com portal/painel é recusada mesmo com o hash recalculado', () => {
    for (const mutar of [(r) => { r.extra = 1; }, (r) => { delete r.backend; }, (r) => { r.portal = { arquivos: 1, manifestoSha256: 'a'.repeat(64) }; }]) {
      const f = releaseBackend();
      f.releaseSha256 = reselar(f.dir, mutar);
      recusa(() => P.conferirRelease(f), 'ESCOPO_INVALIDO');
    }
  });
  test('seção backend com chaves diferentes das do empacotador é recusada', () => {
    const f = releaseBackend();
    f.releaseSha256 = reselar(f.dir, (r) => { r.backend.extra = 1; });
    recusa(() => P.conferirRelease(f), 'ESCOPO_INVALIDO');
  });
  test('o rótulo "atual" precisa ser coerente com o sufixo retroativo e o backend nunca é retroativo', () => {
    const f = releaseBackend();
    f.releaseSha256 = reselar(f.dir, (r) => { r.atual = false; });
    recusa(() => P.conferirRelease(f), 'RETROATIVO_BLOQUEADO');
  });
  test('estrutura do diretório: item a mais, link simbólico e diretório inexistente', () => {
    const extra = releaseBackend();
    fs.writeFileSync(path.join(extra.dir, 'LEIAME.txt'), 'x');
    recusa(() => P.conferirRelease(extra), 'ESCOPO_INVALIDO');
    const ligado = releaseBackend();
    fs.symlinkSync('src/server.js', path.join(ligado.dir, 'backend/atalho'));
    recusa(() => P.conferirRelease(ligado), 'TIPO_INVALIDO');
    assert.throws(() => P.conferirRelease({ ...releaseBackend(), dir: path.join(novo(), 'nao-existe') }));
  });
});

describe('protocolo v2: blob do backend (empacotar e extrair)', () => {
  test('ida e volta preserva a release e continua conferível', () => {
    const f = releaseBackend();
    const blob = P.empacotar(f.dir, { commit: f.commit, rotulo: f.rotulo, releaseSha256: f.releaseSha256, escopo: 'backend' });
    const destino = path.join(novo(), 'extraida');
    P.extrair(blob, destino);
    assert.doesNotThrow(() => P.conferirRelease({ ...f, dir: destino }));
    assert.deepEqual(P.arquivos(destino), P.arquivos(f.dir));
    for (const rel of P.arquivos(f.dir)) assert.equal(sha(fs.readFileSync(path.join(destino, rel))), sha(fs.readFileSync(path.join(f.dir, rel))), rel);
  });
  test('empacotar exige o mesmo escopo da release: backend sem escopo e frontend como backend são recusados', () => {
    const b = releaseBackend();
    recusa(() => P.empacotar(b.dir, { commit: b.commit, rotulo: b.rotulo, releaseSha256: b.releaseSha256 }), 'ESCOPO_INVALIDO');
    const fr = releaseFrontend();
    recusa(() => P.empacotar(fr.dir, { commit: fr.commit, rotulo: fr.rotulo, releaseSha256: fr.releaseSha256, escopo: 'backend' }), 'ESCOPO_INVALIDO');
  });
  test('blob adulterado depois de empacotado não passa na conferência do conteúdo extraído', () => {
    const f = releaseBackend();
    const pares = JSON.parse(P.empacotar(f.dir, { commit: f.commit, rotulo: f.rotulo, releaseSha256: f.releaseSha256, escopo: 'backend' }).toString('utf8'));
    const i = pares.findIndex(([nome]) => nome === 'backend/src/server.js');
    pares[i][1] = Buffer.from('process.exit(0)\n').toString('base64');
    const destino = path.join(novo(), 'adulterada');
    P.extrair(Buffer.from(JSON.stringify(pares)), destino);
    assert.throws(() => P.conferirRelease({ ...f, dir: destino }), (e) => /DIVERGENTE|DIVERGE/i.test(`${e.codigo} ${e.message}`));
  });
});

describe('protocolo v2: o fluxo atual do frontend não muda', () => {
  test('release de frontend é conferida e empacotada exatamente como antes', () => {
    const f = releaseFrontend();
    assert.equal(P.conferirRelease(f).release.commit, COMMIT);
    const blob = P.empacotar(f.dir, f);
    const destino = path.join(novo(), 'front');
    P.extrair(blob, destino);
    assert.equal(P.conferirRelease({ ...f, dir: destino }).release.commit, COMMIT);
  });
  test('destino AWS segue validado como antes', () => {
    const e = { HML_CONTA: '123456789012', HML_REGIAO: 'us-east-1', HML_BUCKET: 'hml-exemplo', HML_ROLE: 'arn:aws:iam::123456789012:role/exemplo' };
    assert.doesNotThrow(() => P.validarDestino(e));
    recusa(() => P.validarDestino({ ...e, HML_ROLE: 'arn:aws:iam::999999999999:role/exemplo' }), 'ROLE_INVALIDA');
  });
});
