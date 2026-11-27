'use strict';
// 3B-3: conferência conjunta das releases do frontend (Portal e Painel) e do backend, do mesmo commit. As releases são
// geradas de verdade pelos empacotadores oficiais, em diretório temporário; cada caso adultera uma cópia.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '../../../..');
const ARQ = path.join(RAIZ, '.github/scripts/hml/conferir-conjunto.js');
const { gerarRelease } = require(path.join(RAIZ, '.github/scripts/hml/gerar-release.js'));
const { gerarReleaseBackend } = require(path.join(RAIZ, 'deploy/hml/empacotar-backend.js'));

const COMMIT = 'c'.repeat(40);
const OUTRO = 'd'.repeat(40);
const ROTULO = 'hml-20261121T101500-ccccccc';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const shaDe = (dir) => sha(fs.readFileSync(path.join(dir, 'release.json')));

let base;
let modelo;
let n = 0;
before(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conjunto-'));
  modelo = { frontend: path.join(base, 'modelo-frontend'), backend: path.join(base, 'modelo-backend') };
  gerarRelease({ saida: modelo.frontend, commit: COMMIT, rotulo: ROTULO, atual: true });
  gerarReleaseBackend({ saida: modelo.backend, commit: COMMIT, rotulo: ROTULO, atual: true });
});
after(() => { fs.rmSync(base, { recursive: true, force: true }); });

// Cópia independente do par de releases, para adulterar sem afetar os outros casos.
function copia() {
  n += 1;
  const dir = path.join(base, `caso-${n}`);
  fs.cpSync(modelo.frontend, path.join(dir, 'frontend'), { recursive: true });
  fs.cpSync(modelo.backend, path.join(dir, 'backend'), { recursive: true });
  return { dir, frontendDir: path.join(dir, 'frontend'), backendDir: path.join(dir, 'backend') };
}
const pedido = (c, extra = {}) => ({ frontendDir: c.frontendDir, backendDir: c.backendDir, commit: COMMIT, rotulo: ROTULO, frontendSha256: shaDe(c.frontendDir), ...extra });
const recusa = (fn, codigo) => assert.throws(fn, (e) => { assert.equal(e.codigo, codigo, `${e.codigo}: ${e.message}`); return true; });
const reescrever = (arquivo, mudar) => { const o = JSON.parse(fs.readFileSync(arquivo, 'utf8')); mudar(o); fs.writeFileSync(arquivo, `${JSON.stringify(o, null, 2)}\n`); };
const primeiroArquivo = (dir) => { const e = fs.readdirSync(dir, { withFileTypes: true }).find((x) => x.isFile()); return path.join(dir, e.name); };

describe('conjunto íntegro', () => {
  test('aceita as duas releases do mesmo commit e devolve a identidade do conjunto', () => {
    const C = require(ARQ);
    const c = copia();
    const r = C.conferirConjunto(pedido(c));
    const fe = shaDe(c.frontendDir), be = shaDe(c.backendDir);
    assert.equal(r.versao, 1);
    assert.equal(r.commit, COMMIT);
    assert.equal(r.rotulo, ROTULO);
    assert.equal(r.frontend.releaseSha256, fe);
    assert.equal(r.backend.releaseSha256, be);
    assert.match(r.frontend.portal.manifestoSha256, /^[0-9a-f]{64}$/);
    assert.match(r.frontend.painel.manifestoSha256, /^[0-9a-f]{64}$/);
    assert.match(r.backend.manifestoSha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(r.backend.migrations) && r.backend.migrations > 0);
    assert.equal(r.conjuntoSha256, sha(`safework-hml-conjunto-v1\n${COMMIT}\n${ROTULO}\nfrontend ${fe}\nbackend ${be}\n`));
    assert.deepEqual(Object.keys(r).sort(), ['backend', 'commit', 'comprovaInstalacao', 'comprovaPublicacao', 'conjuntoSha256', 'frontend', 'rotulo', 'tipo', 'versao']);
  });

  test('P2: o registro descreve só releases PREPARADAS e nega, para todos os componentes, comprovar instalação ou publicação', () => {
    const C = require(ARQ);
    const r = C.conferirConjunto(pedido(copia()));
    assert.equal(r.tipo, 'RELEASES_PREPARADAS');
    assert.equal(r.comprovaPublicacao, false);
    assert.equal(r.comprovaInstalacao, false);
    // Nenhum componente carrega marca própria de publicado/instalado: uma marca só no backend sugeriria o contrário dos outros.
    assert.doesNotMatch(JSON.stringify(r), /publicado|instalado|"estado"|SUCESSO|recibo/i);
    assert.deepEqual(Object.keys(r.frontend).sort(), ['painel', 'portal', 'releaseSha256']);
    assert.deepEqual(Object.keys(r.backend).sort(), ['manifestoSha256', 'migrations', 'releaseSha256']);
  });

  test('o identificador do conjunto muda com qualquer um dos dois release.json e é estável para o mesmo par', () => {
    const C = require(ARQ);
    const a = copia();
    const id = C.conferirConjunto(pedido(a)).conjuntoSha256;
    assert.equal(C.conferirConjunto(pedido(a)).conjuntoSha256, id);
    assert.equal(C.identificadorDoConjunto({ commit: COMMIT, rotulo: ROTULO, frontendSha256: 'a'.repeat(64), backendSha256: 'b'.repeat(64) }),
      sha(`safework-hml-conjunto-v1\n${COMMIT}\n${ROTULO}\nfrontend ${'a'.repeat(64)}\nbackend ${'b'.repeat(64)}\n`));
    assert.notEqual(C.identificadorDoConjunto({ commit: COMMIT, rotulo: ROTULO, frontendSha256: 'a'.repeat(64), backendSha256: 'b'.repeat(64) }),
      C.identificadorDoConjunto({ commit: COMMIT, rotulo: ROTULO, frontendSha256: 'b'.repeat(64), backendSha256: 'a'.repeat(64) }), 'trocar os papéis muda o identificador');
  });

  test('a conferência não escreve nada nos diretórios das releases', () => {
    const C = require(ARQ);
    const c = copia();
    const listar = (d) => fs.readdirSync(d, { recursive: true }).sort().join('\n');
    const antes = [listar(c.frontendDir), listar(c.backendDir), shaDe(c.frontendDir), shaDe(c.backendDir)];
    C.conferirConjunto(pedido(c));
    assert.deepEqual([listar(c.frontendDir), listar(c.backendDir), shaDe(c.frontendDir), shaDe(c.backendDir)], antes);
  });
});

describe('SHA divergente', () => {
  test('backend gerado de outro commit: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    fs.rmSync(c.backendDir, { recursive: true });
    gerarReleaseBackend({ saida: c.backendDir, commit: OUTRO, rotulo: 'hml-20261121T101500-ddddddd', atual: true });
    recusa(() => C.conferirConjunto(pedido(c)), 'COMMIT_DIVERGENTE');
  });
  test('frontend gerado de outro commit: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    fs.rmSync(c.frontendDir, { recursive: true });
    gerarRelease({ saida: c.frontendDir, commit: OUTRO, rotulo: 'hml-20261121T101500-ddddddd', atual: true });
    recusa(() => C.conferirConjunto(pedido(c)), 'COMMIT_DIVERGENTE');
  });
  test('commit validado diferente do das duas releases: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    recusa(() => C.conferirConjunto(pedido(c, { commit: OUTRO, rotulo: 'hml-20261121T101500-ddddddd' })), 'COMMIT_DIVERGENTE');
  });
  test('identidade fora do formato: recusada antes de ler qualquer release', () => {
    const C = require(ARQ);
    const c = copia();
    for (const ruim of [{ commit: 'abc' }, { commit: undefined }, { rotulo: 'hml-qualquer' }, { frontendSha256: 'x' }, { frontendDir: '' }, { backendDir: undefined }]) {
      recusa(() => C.conferirConjunto(pedido(c, ruim)), 'IDENTIDADE_INVALIDA');
    }
  });
});

describe('rótulo incompatível', () => {
  test('backend com rótulo de outro instante, mesmo commit: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    fs.rmSync(c.backendDir, { recursive: true });
    gerarReleaseBackend({ saida: c.backendDir, commit: COMMIT, rotulo: 'hml-20261121T101501-ccccccc', atual: true });
    recusa(() => C.conferirConjunto(pedido(c)), 'COMMIT_DIVERGENTE');
  });
  test('rótulo validado diferente do das releases: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    recusa(() => C.conferirConjunto(pedido(c, { rotulo: 'hml-20261121T101501-ccccccc' })), 'COMMIT_DIVERGENTE');
  });
});

describe('release retroativa', () => {
  test('rótulo retroativo: o conjunto é recusado (o backend nunca é retroativo)', () => {
    const C = require(ARQ);
    const c = copia();
    fs.rmSync(c.frontendDir, { recursive: true });
    gerarRelease({ saida: c.frontendDir, commit: COMMIT, rotulo: `${ROTULO}-retroativo`, atual: false });
    recusa(() => C.conferirConjunto(pedido(c, { rotulo: `${ROTULO}-retroativo` })), 'CONJUNTO_RETROATIVO');
  });
  test('frontend retroativo com backend atual, conferido contra o rótulo atual: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    fs.rmSync(c.frontendDir, { recursive: true });
    gerarRelease({ saida: c.frontendDir, commit: COMMIT, rotulo: `${ROTULO}-retroativo`, atual: false });
    recusa(() => C.conferirConjunto(pedido(c)), 'COMMIT_DIVERGENTE');
  });
});

describe('manifesto ou release adulterado', () => {
  test('release.json do frontend alterado depois de fixado o hash: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    const fixado = shaDe(c.frontendDir);
    reescrever(path.join(c.frontendDir, 'release.json'), (o) => { o.geradoEm = '2026-01-01T00:00:00.000Z'; });
    recusa(() => C.conferirConjunto(pedido(c, { frontendSha256: fixado })), 'HASH_RELEASE');
  });
  test('arquivo do Portal alterado: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    fs.appendFileSync(primeiroArquivo(path.join(c.frontendDir, 'portal')), '\n<!-- adulterado -->');
    assert.throws(() => C.conferirConjunto(pedido(c)), (e) => typeof e.codigo === 'string' && /DIVERGENTE|INVALID/.test(e.codigo));
  });
  test('manifesto do Painel alterado: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    fs.appendFileSync(path.join(c.frontendDir, 'manifesto-painel.sha256'), `${'0'.repeat(64)}  intruso.html\n`);
    assert.throws(() => C.conferirConjunto(pedido(c)), (e) => typeof e.codigo === 'string' && /DIVERGENTE|INVALID/.test(e.codigo));
  });
  test('arquivo do backend alterado: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    fs.appendFileSync(path.join(c.backendDir, 'backend', 'package.json'), '\n');
    recusa(() => C.conferirConjunto(pedido(c)), 'RELEASE_DIVERGENTE');
  });
  test('manifesto do backend alterado: recusado', () => {
    const C = require(ARQ);
    const c = copia();
    fs.appendFileSync(path.join(c.backendDir, 'manifesto-backend.sha256'), `${'0'.repeat(64)}  intruso.js\n`);
    recusa(() => C.conferirConjunto(pedido(c)), 'RELEASE_DIVERGENTE');
  });
  test('release.json do backend com a lista de migrations encurtada ou com hash trocado: recusado', () => {
    const C = require(ARQ);
    const a = copia();
    reescrever(path.join(a.backendDir, 'release.json'), (o) => { o.backend.migrations.pop(); });
    recusa(() => C.conferirConjunto(pedido(a)), 'CONJUNTO_MIGRATIONS_DIVERGENTES');
    const b = copia();
    reescrever(path.join(b.backendDir, 'release.json'), (o) => { o.backend.migrations[0].sha256 = '0'.repeat(64); });
    recusa(() => C.conferirConjunto(pedido(b)), 'CONJUNTO_MIGRATIONS_DIVERGENTES');
    const d = copia();
    reescrever(path.join(d.backendDir, 'release.json'), (o) => { o.backend.migrations = []; });
    recusa(() => C.conferirConjunto(pedido(d)), 'CONJUNTO_MIGRATIONS_DIVERGENTES');
  });
  test('arquivo a mais na raiz de qualquer das releases, ou release do backend ausente: recusado', () => {
    const C = require(ARQ);
    const a = copia();
    fs.writeFileSync(path.join(a.frontendDir, 'extra.txt'), 'x');
    recusa(() => C.conferirConjunto(pedido(a)), 'ESCOPO_INVALIDO');
    const b = copia();
    fs.writeFileSync(path.join(b.backendDir, 'extra.txt'), 'x');
    recusa(() => C.conferirConjunto(pedido(b)), 'ESCOPO_INVALIDO');
    const d = copia();
    fs.rmSync(path.join(d.backendDir, 'release.json'));
    recusa(() => C.conferirConjunto(pedido(d)), 'RELEASE_BACKEND_ILEGIVEL');
  });
  test('os papéis trocados (backend no lugar do frontend) são recusados', () => {
    const C = require(ARQ);
    const c = copia();
    recusa(() => C.conferirConjunto({ ...pedido(c), frontendDir: c.backendDir, backendDir: c.frontendDir, frontendSha256: shaDe(c.backendDir) }), 'ESCOPO_INVALIDO');
  });
});

describe('linha de comando', () => {
  const rodar = (c, extra = {}) => {
    const saida = path.join(c.dir, 'conjunto.json'), resumo = path.join(c.dir, 'resumo.md'), outputs = path.join(c.dir, 'outputs.txt');
    const env = {
      PATH: process.env.PATH, HML_COMMIT: COMMIT, HML_ROTULO: ROTULO, HML_RELEASE_SHA256: shaDe(c.frontendDir), HML_FRONTEND_DIR: c.frontendDir,
      HML_RELEASE_BACKEND_DIR: c.backendDir, HML_CONJUNTO_SAIDA: saida, GITHUB_STEP_SUMMARY: resumo, GITHUB_OUTPUT: outputs, ...extra,
    };
    const r = spawnSync(process.execPath, [ARQ], { env, encoding: 'utf8', timeout: 60000 });
    return { r, saida, resumo, outputs };
  };

  test('sucesso: grava conjunto.json de releases preparadas, expõe o identificador e o resumo não atribui publicação nem instalação', () => {
    const c = copia();
    const { r, saida, resumo, outputs } = rodar(c);
    assert.equal(r.status, 0, r.stderr);
    const conjunto = JSON.parse(fs.readFileSync(saida, 'utf8'));
    assert.equal(conjunto.tipo, 'RELEASES_PREPARADAS');
    assert.equal(conjunto.comprovaPublicacao, false);
    assert.equal(conjunto.comprovaInstalacao, false);
    assert.equal(fs.readFileSync(outputs, 'utf8'), `conjunto_sha256=${conjunto.conjuntoSha256}\n`);
    const texto = fs.readFileSync(resumo, 'utf8');
    assert.match(texto, /Status: `PREPARACAO_CONJUNTO_CONFERIDA`[^\n]*conferência concluída[^\n]*não indica[^\n]*armazenamento do artefato/, 'o status vale só para a conferência');
    assert.match(texto, /passo seguinte[^\n]*PREPARACAO_CONJUNTO_FALHOU/, 'diz o que acontece se o armazenamento falhar');
    assert.match(texto, /Backend[^\n]*NÃO publicado/);
    assert.match(texto, /não comprova instalação nem publicação de nenhum componente/);
    assert.match(texto, new RegExp(conjunto.conjuntoSha256));
    assert.doesNotMatch(texto, /três componentes (foram )?publicados|backend publicado/i);
    assert.deepEqual(texto.match(/^- Status: .*$/gm).map((l) => l.split('`')[1]), ['PREPARACAO_CONJUNTO_CONFERIDA'], 'um único status, o de conferência; a falha só é citada como hipótese');
  });

  test('divergência: código de saída 1, código da recusa na saída de erro e nenhum conjunto gravado', () => {
    const c = copia();
    const { r, saida, outputs } = rodar(c, { HML_COMMIT: OUTRO, HML_ROTULO: 'hml-20261121T101500-ddddddd' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PREPARACAO_CONJUNTO_FALHOU: conjunto recusado \(COMMIT_DIVERGENTE\)/);
    assert.doesNotMatch(r.stdout + r.stderr, /PREPARACAO_CONJUNTO_CONFERIDA/);
    assert.equal(fs.existsSync(saida), false);
    assert.equal(fs.existsSync(outputs), false);
    assert.equal(fs.existsSync(path.join(c.dir, 'resumo.md')), false, 'na falha o script não escreve resumo de sucesso');
  });

  test('não sobrescreve um conjunto já gravado e recusa variáveis ausentes', () => {
    const c = copia();
    fs.writeFileSync(path.join(c.dir, 'conjunto.json'), 'anterior');
    assert.equal(rodar(c).r.status, 1);
    assert.equal(fs.readFileSync(path.join(c.dir, 'conjunto.json'), 'utf8'), 'anterior');
    const d = copia();
    assert.equal(rodar(d, { HML_RELEASE_BACKEND_DIR: '' }).r.status, 1);
  });
});

describe('invariantes do código', () => {
  test('reutiliza os validadores oficiais e não fala com rede, nuvem, banco, agente ou instalador', () => {
    const fonte = fs.readFileSync(ARQ, 'utf8');
    assert.match(fonte, /deploy\/hml\/cd\/protocolo/);
    assert.match(fonte, /gerar-release/);
    assert.doesNotMatch(fonte, /publicar\.js|require\([^)]*(?:publicar|s3|agente|instalar-release|coordenacao)['"]\)|child_process|node:https?|node:net|\bfetch\(|aws|migrate/i);
  });
});
