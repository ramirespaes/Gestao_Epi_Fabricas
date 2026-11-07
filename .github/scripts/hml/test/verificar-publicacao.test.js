'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Verificação pós-publicação: identifica o commit instalado, confere o hash de cada
 * arquivo servido, os cabeçalhos de segurança, o isolamento entre origens e a saúde
 * da API. Testada contra um servidor HTTP local; nada sai da máquina.
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MODULO = path.join(REPO, 'deploy', 'hml', 'verificacao', 'verificar-publicacao.js');
const temporarios = [];
const servidores = [];
const sha256 = (c) => crypto.createHash('sha256').update(c).digest('hex');
const CSP_BOA = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'sha256-AAAA'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

function carregar() {
  try {
    return require(MODULO);
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes('verificar-publicacao')) assert.fail('deploy/hml/verificacao/verificar-publicacao.js ainda não existe (RED esperado)');
    throw erro;
  }
}
function tmp() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hml-verif-'));
  temporarios.push(dir);
  return dir;
}

const ARQUIVOS = { 'index.html': '<p>oi</p>', 'js/app.js': 'x=1', 'css/a.css': 'a{}', 'img/logo.svg': '<svg/>' };
const VERSAO = { componente: 'portal', rotulo: 'hml-20261104T101500-ddddddd', commit: 'd'.repeat(40), manifestoSha256: 'e'.repeat(64) };
const manifestoDe = (arquivos) => Object.fromEntries(Object.entries(arquivos).map(([rel, c]) => [rel, sha256(c)]));

// Servidor estático falso: serve `arquivos`, /versao.json e cabeçalhos configuráveis.
async function subir({ arquivos = ARQUIVOS, versao = VERSAO, csp = CSP_BOA, cacheControl = 'no-cache', nosniff = true, sobrescrever = {}, saude, atraso = 0 } = {}) {
  let ativas = 0; let maxAtivas = 0;
  const servidor = http.createServer(async (req, res) => {
    ativas += 1; maxAtivas = Math.max(maxAtivas, ativas);
    if (atraso) await new Promise((r) => { setTimeout(r, atraso); });
    const caminho = decodeURIComponent(req.url.split('?')[0]);
    const manda = (status, corpo, extra = {}) => { res.writeHead(status, extra); res.end(corpo); ativas -= 1; };
    if (sobrescrever[caminho]) { const o = sobrescrever[caminho]; return manda(o.status, o.corpo ?? '', o.cabecalhos); }
    if (caminho === '/api/health' && saude) return manda(saude.status, saude.corpo, { 'Content-Type': 'application/json' });
    if (caminho === '/versao.json') return versao ? manda(200, JSON.stringify(versao), { 'Content-Type': 'application/json' }) : manda(404, 'nao');
    const rel = caminho.slice(1);
    if (rel in arquivos) {
      const cabecalhos = {};
      if (/\.(html|js|css)$/.test(rel)) { if (cacheControl) cabecalhos['Cache-Control'] = cacheControl; }
      if (/\.html$/.test(rel) && csp) cabecalhos['Content-Security-Policy'] = csp;
      if (nosniff) cabecalhos['X-Content-Type-Options'] = 'nosniff';
      return manda(200, arquivos[rel], cabecalhos);
    }
    return manda(404, 'nao');
  });
  await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
  servidores.push(servidor);
  return { url: `http://127.0.0.1:${servidor.address().port}`, maxAtivas: () => maxAtivas, fechar: () => new Promise((r) => { servidor.close(r); servidor.closeAllConnections(); }) };
}
const falhas = (r) => r.verificacoes.filter((v) => !v.ok).map((v) => v.nome).sort();

afterEach(async () => {
  while (servidores.length) { const s = servidores.pop(); if (s.listening) { s.closeAllConnections(); await new Promise((r) => { s.close(r); }); } }
  while (temporarios.length) fs.rmSync(temporarios.pop(), { recursive: true, force: true });
});

describe('avaliarCsp — política mínima exigida', () => {
  test('política completa passa; cada diretiva obrigatória ausente ou enfraquecida é um problema', () => {
    const { avaliarCsp } = carregar();
    assert.deepEqual(avaliarCsp(CSP_BOA), []);
    const sem = (diretiva) => CSP_BOA.split('; ').filter((d) => !d.startsWith(diretiva)).join('; ');
    for (const d of ["object-src", "base-uri", "frame-ancestors", "default-src", "script-src"]) assert.ok(avaliarCsp(sem(d)).length > 0, `sem ${d}`);
    for (const ruim of [
      CSP_BOA.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      CSP_BOA.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
      CSP_BOA.replace("script-src 'self'", 'script-src *'),
      CSP_BOA.replace("script-src 'self'", 'script-src http:'),
      CSP_BOA.replace("script-src 'self'", 'script-src data:'),
      CSP_BOA.replace("script-src 'self'", 'script-src https://qualquer.exemplo.test *'),
      CSP_BOA.replace("object-src 'none'", "object-src 'self'"),
      CSP_BOA.replace("base-uri 'none'", "base-uri 'self'"),
      CSP_BOA.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
      CSP_BOA.replace("style-src 'self'", "style-src 'self' 'unsafe-eval'"),
      CSP_BOA.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
      CSP_BOA.replace("default-src 'none'", 'default-src *'),
    ]) assert.ok(avaliarCsp(ruim).length > 0, ruim);
    assert.ok(avaliarCsp('').length > 0);
    assert.ok(avaliarCsp(undefined).length > 0);
  });

  test("'unsafe-inline' só é aceito em style-src-attr; hashes e hosts https explícitos passam", () => {
    const { avaliarCsp } = carregar();
    assert.deepEqual(avaliarCsp(CSP_BOA.replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com")), []);
    assert.ok(avaliarCsp(CSP_BOA.replace("connect-src 'self'", "connect-src 'self'; script-src-attr 'unsafe-inline'")).length > 0);
  });
});

describe('verificarPublicacao — frontend estático', () => {
  test('publicação íntegra: identificação, hashes, cabeçalhos e isolamento passam', async () => {
    const { verificarPublicacao } = carregar();
    const s = await subir();
    const r = await verificarPublicacao({ baseUrl: s.url, tipo: 'estatico', versaoEsperada: VERSAO, manifesto: manifestoDe(ARQUIVOS), ausentes: ['portal/index.html', 'painel-privado/login.js'] });
    assert.equal(r.ok, true, JSON.stringify(r.verificacoes.filter((v) => !v.ok)));
    assert.deepEqual(r.verificacoes.map((v) => v.nome).sort(), ['ARQUIVOS', 'CABECALHOS', 'IDENTIFICACAO', 'ISOLAMENTO']);
  });

  test('arquivo servido diferente do manifesto, ausente ou com redirecionamento falha', async () => {
    const { verificarPublicacao } = carregar();
    for (const [nome, opcoes] of Object.entries({
      adulterado: { arquivos: { ...ARQUIVOS, 'js/app.js': 'x=2' } },
      ausente: { arquivos: { 'index.html': ARQUIVOS['index.html'], 'css/a.css': 'a{}', 'img/logo.svg': '<svg/>' } },
      redirecionado: { sobrescrever: { '/js/app.js': { status: 302, cabecalhos: { Location: 'http://127.0.0.1:1/x' } } } },
      erro5xx: { sobrescrever: { '/js/app.js': { status: 503, corpo: 'indisponivel' } } },
    })) {
      const s = await subir(opcoes);
      const r = await verificarPublicacao({ baseUrl: s.url, tipo: 'estatico', versaoEsperada: VERSAO, manifesto: manifestoDe(ARQUIVOS), ausentes: [] });
      assert.equal(r.ok, false, nome);
      assert.deepEqual(falhas(r), ['ARQUIVOS'], nome);
      assert.match(r.verificacoes.find((v) => v.nome === 'ARQUIVOS').detalhe, /js\/app\.js|index|css|svg/, nome);
    }
  });

  test('identificação: versao.json ausente ou de outro commit, rótulo ou manifesto falha', async () => {
    const { verificarPublicacao } = carregar();
    for (const versao of [null, { ...VERSAO, commit: 'a'.repeat(40) }, { ...VERSAO, rotulo: 'hml-20250101T000000-aaaaaaa' }, { ...VERSAO, manifestoSha256: 'f'.repeat(64) }, { ...VERSAO, componente: 'painel' }]) {
      const s = await subir({ versao });
      const r = await verificarPublicacao({ baseUrl: s.url, tipo: 'estatico', versaoEsperada: VERSAO, manifesto: manifestoDe(ARQUIVOS), ausentes: [] });
      assert.deepEqual(falhas(r), ['IDENTIFICACAO'], JSON.stringify(versao));
    }
  });

  test('cabeçalhos: sem CSP, CSP fraca, sem no-cache em html/js/css ou sem nosniff falha', async () => {
    const { verificarPublicacao } = carregar();
    for (const opcoes of [{ csp: null }, { csp: "default-src *; script-src 'unsafe-inline'" }, { cacheControl: null }, { cacheControl: 'max-age=3600' }, { nosniff: false }]) {
      const s = await subir(opcoes);
      const r = await verificarPublicacao({ baseUrl: s.url, tipo: 'estatico', versaoEsperada: VERSAO, manifesto: manifestoDe(ARQUIVOS), ausentes: [] });
      assert.deepEqual(falhas(r), ['CABECALHOS'], JSON.stringify(opcoes));
    }
  });

  test('isolamento: arquivo de outro componente, dotfiles, .releases e estado.json não podem ser servidos', async () => {
    const { verificarPublicacao } = carregar();
    for (const caminho of ['/portal/index.html', '/.env', '/.git/config', '/.releases/', '/estado.json']) {
      const s = await subir({ sobrescrever: { [caminho]: { status: 200, corpo: 'vazou' } } });
      const r = await verificarPublicacao({ baseUrl: s.url, tipo: 'estatico', versaoEsperada: VERSAO, manifesto: manifestoDe(ARQUIVOS), ausentes: ['portal/index.html'] });
      assert.deepEqual(falhas(r), ['ISOLAMENTO'], caminho);
    }
    const s = await subir({ sobrescrever: { '/.env': { status: 403 }, '/.git/config': { status: 410 } } });
    const ok = await verificarPublicacao({ baseUrl: s.url, tipo: 'estatico', versaoEsperada: VERSAO, manifesto: manifestoDe(ARQUIVOS), ausentes: [] });
    assert.equal(ok.ok, true);
  });

  test('servidor fora do ar não lança: devolve falha com detalhe', async () => {
    const { verificarPublicacao } = carregar();
    const s = await subir();
    const url = s.url;
    await s.fechar();
    const r = await verificarPublicacao({ baseUrl: url, tipo: 'estatico', versaoEsperada: VERSAO, manifesto: manifestoDe(ARQUIVOS), ausentes: [], timeoutMs: 500 });
    assert.equal(r.ok, false);
    assert.ok(r.verificacoes.every((v) => !v.ok));
    assert.ok(r.verificacoes.every((v) => typeof v.detalhe === 'string' && v.detalhe.length > 0));
  });

  test('a concorrência de pedidos respeita o limite e a verificação não segue redirecionamentos', async () => {
    const { verificarPublicacao } = carregar();
    const muitos = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`js/m${i}.js`, `x=${i}`]));
    const s = await subir({ arquivos: { ...ARQUIVOS, ...muitos }, atraso: 15 });
    const r = await verificarPublicacao({ baseUrl: s.url, tipo: 'estatico', versaoEsperada: VERSAO, manifesto: manifestoDe({ ...ARQUIVOS, ...muitos }), ausentes: [], concorrencia: 4 });
    assert.equal(r.ok, true, JSON.stringify(r.verificacoes.filter((v) => !v.ok)));
    assert.ok(s.maxAtivas() <= 4 + 1, `no máximo 4 simultâneas, vieram ${s.maxAtivas()}`);
  });

  test('entradas inválidas são recusadas: URL com credencial, esquema estranho, tipo desconhecido', async () => {
    const { verificarPublicacao } = carregar();
    for (const baseUrl of ['http://user:senha@127.0.0.1:1', 'ftp://127.0.0.1', 'file:///etc/passwd', 'não é url', '']) {
      await assert.rejects(verificarPublicacao({ baseUrl, tipo: 'estatico', versaoEsperada: VERSAO, manifesto: {}, ausentes: [] }), (e) => e.codigo === 'VERIFICACAO_ENTRADA_INVALIDA', baseUrl);
    }
    await assert.rejects(verificarPublicacao({ baseUrl: 'http://127.0.0.1:1', tipo: 'outro' }), (e) => e.codigo === 'VERIFICACAO_ENTRADA_INVALIDA');
  });
});

describe('verificarPublicacao — API', () => {
  test('/api/health com status 200 e corpo esperado passa; outras respostas falham', async () => {
    const { verificarPublicacao } = carregar();
    const ok = await subir({ saude: { status: 200, corpo: JSON.stringify({ status: 'ok', service: 'gestao-epi-api' }) } });
    assert.equal((await verificarPublicacao({ baseUrl: ok.url, tipo: 'api' })).ok, true);
    for (const saude of [{ status: 503, corpo: '{}' }, { status: 200, corpo: 'texto' }, { status: 200, corpo: JSON.stringify({ status: 'erro', service: 'gestao-epi-api' }) }, { status: 200, corpo: JSON.stringify({ status: 'ok', service: 'outro' }) }]) {
      const s = await subir({ saude });
      const r = await verificarPublicacao({ baseUrl: s.url, tipo: 'api' });
      assert.equal(r.ok, false, JSON.stringify(saude));
      assert.deepEqual(falhas(r), ['SAUDE_API']);
    }
    const sem = await subir();
    assert.deepEqual(falhas(await verificarPublicacao({ baseUrl: sem.url, tipo: 'api' })), ['SAUDE_API']);
  });
});

describe('verificar-publicacao — linha de comando', () => {
  test('lê release.json e manifesto, verifica o servidor e sai 0 ou 1', async () => {
    carregar();
    const dir = tmp();
    const manifesto = manifestoDe(ARQUIVOS);
    const texto = `${Object.keys(manifesto).sort().map((rel) => `${manifesto[rel]}  ${rel}`).join('\n')}\n`;
    fs.writeFileSync(path.join(dir, 'manifesto-portal.sha256'), texto);
    fs.writeFileSync(path.join(dir, 'manifesto-painel.sha256'), `${sha256('x')}  painel-privado/login.js\n${manifesto['index.html']}  index.html\n`);
    const release = { commit: VERSAO.commit, rotulo: VERSAO.rotulo, atual: true, portal: { arquivos: 4, manifestoSha256: sha256(texto) } };
    fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release));
    const s = await subir({ versao: { ...VERSAO, manifestoSha256: sha256(texto) } });
    const rodar = (...extra) => spawnSync(process.execPath, [MODULO, '--base-url', s.url, '--tipo', 'estatico', '--release', dir, '--componente', 'portal', ...extra], { encoding: 'utf8' });
    const ok = await new Promise((resolve) => { const p = require('node:child_process').spawn(process.execPath, [MODULO, '--base-url', s.url, '--tipo', 'estatico', '--release', dir, '--componente', 'portal', '--isolamento-de', path.join(dir, 'manifesto-painel.sha256')], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; }); p.on('close', (status) => resolve({ status, stdout: out, stderr: err })); });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.equal(JSON.parse(ok.stdout).ok, true);
    await s.fechar();
    assert.equal(rodar().status, 1);
    assert.equal(spawnSync(process.execPath, [MODULO], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [MODULO, '--base-url', 'http://127.0.0.1:1', '--tipo', 'estatico', '--lixo'], { encoding: 'utf8' }).status, 1);
  });
});
