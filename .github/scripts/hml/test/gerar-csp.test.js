'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Gerador da Content-Security-Policy por perfil (portal, painel): calcula os
 * hashes dos scripts e estilos inline das páginas publicadas, recusa o que a
 * política não consegue cobrir sem 'unsafe-inline' e nunca deixa host externo
 * sem declaração.
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MODULO = path.join(REPO, 'deploy', 'hml', 'csp', 'gerar-csp.js');
const temporarios = [];
const b64 = (texto) => `'sha256-${crypto.createHash('sha256').update(texto).digest('base64')}'`;

function carregar() {
  try {
    return require(MODULO);
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes('gerar-csp')) assert.fail('deploy/hml/csp/gerar-csp.js ainda não existe (RED esperado)');
    throw erro;
  }
}
function pacote(arquivos) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hml-csp-'));
  temporarios.push(dir);
  for (const [rel, c] of Object.entries(arquivos)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), c);
  }
  return dir;
}
const pagina = (corpo) => `<!DOCTYPE html><html><head><meta charset="utf-8">${corpo.head || ''}</head><body>${corpo.body || ''}</body></html>`;
afterEach(() => { while (temporarios.length) fs.rmSync(temporarios.pop(), { recursive: true, force: true }); });

describe('gerar-csp — hashes de conteúdo inline', () => {
  test('hash SHA-256 em base64 do texto exato de cada <script> e <style> inline, sem duplicar, ordenado', () => {
    const { gerarCsp } = carregar();
    const js = "\n    window.x = 1;\n  ";
    const css = 'body{margin:0}';
    const dir = pacote({
      'a.html': pagina({ head: `<style>${css}</style>`, body: `<script>${js}</script><script src="app.js"></script>` }),
      'b.html': pagina({ head: `<style>${css}</style>`, body: `<script>${js}</script><script>outro()</script>` }),
      'app.js': 'x',
    });
    const r = gerarCsp({ raiz: dir, perfil: 'painel' });
    assert.deepEqual(r.problemas, []);
    assert.deepEqual(r.hashes.script, [b64(js), b64('outro()')].sort());
    assert.deepEqual(r.hashes.style, [b64(css)]);
    for (const h of [...r.hashes.script, ...r.hashes.style]) assert.ok(r.politica.includes(h), h);
    assert.equal(r.paginas, 2);
  });

  test('ignora comentários HTML, scripts externos e blocos de dados (JSON)', () => {
    const { gerarCsp } = carregar();
    const dir = pacote({ 'a.html': pagina({ body: '<!-- <script>comentado()</script> --><script src="x.js"></script><script type="application/json">{"a":1}</script><script type="application/ld+json">{}</script>' }), 'x.js': 'x' });
    const r = gerarCsp({ raiz: dir, perfil: 'painel' });
    assert.deepEqual(r.hashes.script, []);
    assert.deepEqual(r.problemas, []);
  });

  test('a política é determinística e passa na avaliação mínima de CSP', () => {
    const { gerarCsp } = carregar();
    const { avaliarCsp } = require(path.join(REPO, 'deploy', 'hml', 'verificacao', 'verificar-publicacao.js'));
    const dir = pacote({ 'a.html': pagina({ head: '<style>a{}</style>', body: '<script>1</script>' }) });
    const um = gerarCsp({ raiz: dir, perfil: 'painel' });
    assert.equal(gerarCsp({ raiz: dir, perfil: 'painel' }).politica, um.politica);
    assert.deepEqual(avaliarCsp(um.politica), []);
    assert.match(um.politica, /default-src 'none'/);
    assert.match(um.politica, /object-src 'none'/);
    assert.match(um.politica, /base-uri 'none'/);
    assert.match(um.politica, /frame-ancestors 'none'/);
    assert.doesNotMatch(um.politica, /script-src[^;]*'unsafe-inline'/);
    assert.doesNotMatch(um.politica, /style-src 'self'[^;]*'unsafe-inline'/);
  });

  test("atributos style exigem 'unsafe-inline' só em style-src-attr", () => {
    const { gerarCsp } = carregar();
    const dir = pacote({ 'a.html': pagina({ body: '<p style="color:red">x</p>' }) });
    const r = gerarCsp({ raiz: dir, perfil: 'painel' });
    assert.match(r.politica, /style-src-attr 'unsafe-inline'/);
    assert.equal(r.atributosStyle, 1);
  });
});

describe('gerar-csp — o que a política não cobre vira problema, nunca é silenciado', () => {
  test('manipulador inline vira hash em script-src-attr com unsafe-hashes; sem manipuladores, script-src-attr é none', () => {
    const { gerarCsp } = carregar();
    const com = gerarCsp({ raiz: pacote({ 'a.html': pagina({ body: '<button onclick="salvar()">x</button><a onmouseover="m()">y</a>' }) }), perfil: 'painel' });
    assert.match(com.politica, /script-src-attr 'unsafe-hashes' /);
    assert.ok(com.politica.includes(b64('salvar()')) && com.politica.includes(b64('m()')));
    assert.equal(com.manipuladoresInline, 2);
    const sem = gerarCsp({ raiz: pacote({ 'a.html': pagina({ body: '<p>x</p>' }) }), perfil: 'painel' });
    assert.match(sem.politica, /script-src-attr 'none'/);
  });

  test('javascript: em href ou action é problema JAVASCRIPT_URL', () => {
    const { gerarCsp } = carregar();
    const r = gerarCsp({ raiz: pacote({ 'a.html': pagina({ body: '<a href="javascript:void(0)">x</a>' }) }), perfil: 'painel' });
    assert.deepEqual(r.problemas.map((p) => p.codigo), ['JAVASCRIPT_URL']);
    assert.match(r.problemas[0].mensagem, /a\.html/);
  });

  test('host externo precisa estar declarado no perfil; o Painel não aceita nenhum', () => {
    const { gerarCsp } = carregar();
    const turnstile = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"></script>';
    const portal = gerarCsp({ raiz: pacote({ 'a.html': pagina({ body: turnstile }) }), perfil: 'portal' });
    assert.deepEqual(portal.problemas, []);
    assert.match(portal.politica, /script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    assert.match(portal.politica, /frame-src https:\/\/challenges\.cloudflare\.com/);
    const painel = gerarCsp({ raiz: pacote({ 'a.html': pagina({ body: turnstile }) }), perfil: 'painel' });
    assert.deepEqual(painel.problemas.map((p) => p.codigo), ['ORIGEM_EXTERNA_NAO_DECLARADA']);
    const cdn = gerarCsp({ raiz: pacote({ 'a.html': pagina({ body: '<script src="https://cdn.exemplo.test/x.js"></script><img src="https://img.exemplo.test/a.png"><link rel="stylesheet" href="https://css.exemplo.test/a.css">' }) }), perfil: 'portal' });
    assert.deepEqual(cdn.problemas.map((p) => p.codigo), ['ORIGEM_EXTERNA_NAO_DECLARADA', 'ORIGEM_EXTERNA_NAO_DECLARADA', 'ORIGEM_EXTERNA_NAO_DECLARADA']);
    assert.doesNotMatch(cdn.politica, /exemplo\.test/);
  });

  test('manipulador montado dentro de arquivo .js vira aviso, para a revisão de quem altera a interface', () => {
    const { gerarCsp } = carregar();
    const r = gerarCsp({ raiz: pacote({ 'a.html': pagina({}), 'js/x.js': "el.innerHTML = '<button onclick=\"apagar()\">x</button>';" }), perfil: 'painel' });
    assert.deepEqual(r.problemas, []);
    assert.deepEqual(r.avisos.map((a) => a.codigo), ['MANIPULADOR_EM_JS']);
    assert.match(r.avisos[0].mensagem, /js\/x\.js/);
  });

  test('perfil desconhecido, raiz inexistente, sem páginas e arquivo com caminho fora da raiz são recusados', () => {
    const { gerarCsp } = carregar();
    const dir = pacote({ 'a.html': pagina({}) });
    for (const args of [{ raiz: dir, perfil: 'outro' }, { raiz: path.join(dir, 'nao-existe'), perfil: 'painel' }, { raiz: pacote({ 'a.txt': 'x' }), perfil: 'painel' }, { raiz: dir, perfil: 'painel', arquivos: ['../fora.html'] }, { raiz: dir, perfil: 'painel', arquivos: ['/etc/hosts'] }]) {
      assert.throws(() => gerarCsp(args), (e) => e.codigo === 'CSP_ENTRADA_INVALIDA', JSON.stringify(args));
    }
  });
});

describe('gerar-csp — pacotes reais', () => {
  test('o pacote do Painel Privado não tem problema algum e a política cobre todo conteúdo inline', () => {
    const { gerarCsp } = carregar();
    const { empacotar } = require(path.join(REPO, 'frontend', 'publicacao', 'empacotar-painel.js'));
    const saida = path.join(pacote({}), 'painel');
    empacotar({ saida });
    const r = gerarCsp({ raiz: saida, perfil: 'painel' });
    assert.deepEqual(r.problemas, []);
    assert.equal(r.paginas, 8);
    assert.ok(r.hashes.script.length >= 1);
    assert.ok(r.hashes.style.length >= 1);
    assert.equal(r.manipuladoresInline, 0);
    assert.doesNotMatch(r.politica, /https?:\/\/[a-z]/);
  });

  test('o pacote do Portal é analisado e o resultado é estruturado (problemas reais ficam para a revisão da CSP)', () => {
    const { gerarCsp } = carregar();
    const { empacotar } = require(path.join(REPO, 'frontend', 'publicacao', 'empacotar.js'));
    const saida = path.join(pacote({}), 'portal');
    empacotar({ saida });
    const r = gerarCsp({ raiz: saida, perfil: 'portal' });
    assert.ok(Array.isArray(r.problemas) && Array.isArray(r.avisos));
    assert.ok(r.paginas > 30, `páginas analisadas: ${r.paginas}`);
    assert.ok(r.hashes.script.length > 0 && r.hashes.style.length > 0);
    assert.equal(typeof r.politica, 'string');
    for (const p of r.problemas) assert.ok(['JAVASCRIPT_URL', 'ORIGEM_EXTERNA_NAO_DECLARADA'].includes(p.codigo), p.codigo);
  });
});

describe('gerar-csp — linha de comando', () => {
  test('imprime JSON, sai 0 sem problemas e 1 com problemas ou entrada inválida', () => {
    carregar();
    const limpo = pacote({ 'a.html': pagina({ body: '<script>1</script>' }) });
    const ok = spawnSync(process.execPath, [MODULO, '--pacote', limpo, '--perfil', 'painel'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(typeof JSON.parse(ok.stdout).politica, 'string');
    const ruim = pacote({ 'a.html': pagina({ body: '<a href="javascript:x()">x</a>' }) });
    const falha = spawnSync(process.execPath, [MODULO, '--pacote', ruim, '--perfil', 'painel'], { encoding: 'utf8' });
    assert.equal(falha.status, 1);
    assert.match(falha.stderr, /JAVASCRIPT_URL/);
    assert.equal(spawnSync(process.execPath, [MODULO], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [MODULO, '--pacote', limpo, '--perfil', 'x'], { encoding: 'utf8' }).status, 1);
  });
});
