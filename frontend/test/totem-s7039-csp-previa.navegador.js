'use strict';

/**
 * S7039 — a CSP da prévia do Totem num navegador REAL, por HTTP. Um único servidor em 127.0.0.1 (porta efêmera) serve o frontend;
 * na previa.html servida entra só uma sonda (<script src> da mesma origem, sem tocar na CSP). Opção B: o corpo não tem atributo style
 * e nenhum estilo inline é aceito. A sonda confere que o corpo não tem [style] além do #teclado (CSSOM do totem.js, fora do alcance da
 * CSP), que o antigo setAttribute('style', 'color:var(--ok)') agora é BLOQUEADO, tenta estilos não autorizados (atributo, <style> e
 * innerHTML) e devolve o resultado navegando para /__s7039/resultado (connect-src 'none' impede fetch).
 *
 * Chrome headless, temas claro e escuro. Safari: S7039_SAFARI=1 abre o Safari do usuário (tema do sistema). Sem Chrome: pulada.
 * S7039_PREVIA=<arquivo> serve outra previa.html (ex.: a original, para o RED). Fora do `npm test`.
 * Executar: node --test test/totem-s7039-csp-previa.navegador.js
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { chromeDisponivel } = require('./helpers/geometria-navegador');

const RAIZ = path.join(__dirname, '..');
const PREVIA = process.env.S7039_PREVIA || path.join(RAIZ, 'totem/previa.html');
const SAIDA = process.env.S7039_SAIDA || null;
const LIMITE_MS = 60000;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };

const SONDA = String.raw`(function () {
  var violacoes = [];
  document.addEventListener('securitypolicyviolation', function (e) { violacoes.push({ diretiva: e.effectiveDirective, amostra: e.sample || '' }); });
  function medir() {
    var legitimos = Array.prototype.map.call(document.querySelectorAll('body [style]'), function (el) {
      var c = getComputedStyle(el);
      return { id: el.id, estilo: el.getAttribute('style'), aplicado: el.style.cssText !== '', cor: c.color, fundo: c.backgroundColor, margemTopo: c.marginTop, fonte: c.fontSize };
    });
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'mi');
    document.body.appendChild(svg);
    svg.setAttribute('style', 'color:var(--ok)');
    var ok = getComputedStyle(document.documentElement).getPropertyValue('--ok').trim();
    var js = { aplicado: svg.style.color !== '', cor: getComputedStyle(svg).color };

    var a = document.createElement('div'); a.id = 's7039a'; document.body.appendChild(a);
    a.setAttribute('style', 'color: rgb(1, 2, 3)');
    var b = document.createElement('div'); b.id = 's7039b'; document.body.appendChild(b);
    var st = document.createElement('style'); st.textContent = '#s7039b{color: rgb(4, 5, 6)}'; document.head.appendChild(st);
    var c = document.createElement('div'); document.body.appendChild(c);
    c.innerHTML = '<p id="s7039c" style="color: rgb(7, 8, 9)">x</p>';
    setTimeout(function () {
      var intrusos = {
        atributo: getComputedStyle(a).color === 'rgb(1, 2, 3)',
        blocoStyle: getComputedStyle(b).color === 'rgb(4, 5, 6)',
        innerHTML: getComputedStyle(document.getElementById('s7039c')).color === 'rgb(7, 8, 9)',
      };
      var r = { escuro: matchMedia('(prefers-color-scheme: dark)').matches, varOk: ok, legitimos: legitimos, js: js, intrusos: intrusos, violacoes: violacoes, agente: navigator.userAgent };
      location.href = '/__s7039/resultado?d=' + encodeURIComponent(JSON.stringify(r));
    }, 600);
  }
  if (document.readyState === 'complete') medir(); else addEventListener('load', medir);
})();`;

function servidor() {
  let aoReceber;
  const recebido = new Promise((r) => { aoReceber = r; });
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__s7039/sonda.js') { res.writeHead(200, { 'Content-Type': TIPOS['.js'] }); return res.end(SONDA); }
    if (url.pathname === '/__s7039/resultado') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return aoReceber(JSON.parse(url.searchParams.get('d'))); }
    if (url.pathname === '/totem/previa.html') {
      let html = fs.readFileSync(PREVIA, 'utf8');
      if (!url.searchParams.has('sem-sonda')) html = html.replace('</body>', '<script src="/__s7039/sonda.js"></script>\n</body>');
      res.writeHead(200, { 'Content-Type': TIPOS['.html'], 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    const arquivo = path.normalize(path.join(RAIZ, url.pathname));
    if (!arquivo.startsWith(RAIZ + path.sep) || !fs.existsSync(arquivo) || !fs.statSync(arquivo).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream' });
    fs.createReadStream(arquivo).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, porta: srv.address().port, recebido })));
}

const perfis = [];
after(() => { for (const p of perfis) fs.rmSync(p, { recursive: true, force: true }); });

async function noChrome(chrome, escuro, extra = [], url) {
  const { srv, porta, recebido } = await servidor();
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 's7039-'));
  perfis.push(perfil);
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-extensions', '--hide-scrollbars', '--window-size=1024,1366', `--user-data-dir=${perfil}`, ...(escuro ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1']), ...extra,
    `http://127.0.0.1:${porta}${url || '/totem/previa.html'}`];
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  const fim = new Promise((r) => proc.on('exit', r));
  try {
    if (extra.length) { await Promise.race([fim, new Promise((r) => setTimeout(r, LIMITE_MS))]); return null; }
    return await Promise.race([recebido, new Promise((_, rej) => setTimeout(() => rej(new Error('sem resultado da sonda')), LIMITE_MS))]);
  } finally { proc.kill('SIGKILL'); srv.close(); }
}

function conferir(r, rotulo) {
  if (SAIDA) fs.writeFileSync(path.join(SAIDA, `resultado-${rotulo}.json`), JSON.stringify(r, null, 2));
  // #teclado recebe .style.display do totem.js (CSSOM, fora do alcance da CSP); nenhum outro elemento do corpo tem atributo style.
  const doHtml = r.legitimos.filter((l) => l.id !== 'teclado');
  assert.deepEqual(doHtml, [], 'o corpo não tem atributo style');
  assert.equal(r.js.aplicado, false, "setAttribute('style') precisa ser bloqueado");
  assert.deepEqual(r.intrusos, { atributo: false, blocoStyle: false, innerHTML: false }, 'estilo não autorizado aplicado');
  const diretivas = new Set(r.violacoes.map((v) => v.diretiva));
  assert.ok(diretivas.has('style-src-attr'), 'violação de atributo registrada');
  assert.ok(diretivas.has('style-src-elem'), 'violação de <style> registrada');
}

const chrome = chromeDisponivel();

describe('S7039 — CSP da prévia no navegador (HTTP 127.0.0.1)', { skip: chrome ? false : 'Chrome indisponível', timeout: LIMITE_MS * 6 }, () => {
  for (const escuro of [false, true]) {
    const tema = escuro ? 'escuro' : 'claro';
    test(`Chrome, tema ${tema}: legítimos aplicados, não autorizados bloqueados`, async () => {
      const r = await noChrome(chrome, escuro);
      assert.equal(r.escuro, escuro, 'tema aplicado');
      conferir(r, `chrome-${tema}`);
    });
    test(`Chrome, tema ${tema}: captura da tela inicial`, { skip: SAIDA ? false : 'sem S7039_SAIDA' }, async () => {
      const png = path.join(SAIDA, `tela-chrome-${tema}.png`);
      await noChrome(chrome, escuro, [`--screenshot=${png}`, '--virtual-time-budget=4000'], '/totem/previa.html?sem-sonda');
      assert.ok(fs.statSync(png).size > 1000);
    });
  }
});

describe('S7039 — CSP da prévia no Safari (HTTP 127.0.0.1)', { skip: process.env.S7039_SAFARI === '1' ? false : 'S7039_SAFARI≠1', timeout: LIMITE_MS * 2 }, () => {
  test('Safari, tema do sistema: legítimos aplicados, não autorizados bloqueados', async () => {
    const { srv, porta, recebido } = await servidor();
    try {
      execFile('open', ['-g', '-a', 'Safari', `http://127.0.0.1:${porta}/totem/previa.html`]);
      const r = await Promise.race([recebido, new Promise((_, rej) => setTimeout(() => rej(new Error('sem resultado do Safari')), LIMITE_MS))]);
      conferir(r, `safari-${r.escuro ? 'escuro' : 'claro'}`);
    } finally { srv.close(); }
  });
});
