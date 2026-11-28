'use strict';

/**
 * S2819 — ponte da prévia do Totem num Chrome headless REAL (v2: segredo de uso único).
 * A página real da Central (pages/atendimento-token.html) roda com `fetch` simulado (dados sintéticos) e a prévia real
 * (totem/previa.html) dentro do iframe sandbox, com um roteiro que identifica no Totem. Documentos intrusos (sem relação com a prévia)
 * tentam o handshake sem segredo, com segredo errado, reutilizado ou expirado, e registram tudo o que recebem.
 * Exposição do segredo: o servidor registra linha de requisição e Referer de cada pedido; depois do encerramento, o perfil do Chrome
 * (histórico, cache) é varrido em busca dos segredos. O previa.html sai SEM Cache-Control (pior caso de um servidor estático comum).
 * Um único servidor HTTP em 127.0.0.1, porta efêmera; Chrome e servidor são encerrados no fim, inclusive em falha. Sem Chrome: pulada.
 * Executar: node --test test/ponte-previa-s2819.navegador.js (fora do `npm test`, como funcionarios-acao-geometria.navegador.js).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { chromeDisponivel } = require('./helpers/geometria-navegador');

const RAIZ = path.join(__dirname, '..');
const LIMITE_MS = 180000;
const PRAZO_HANDSHAKE_MS = 10000;
// Cache-Control do previa.html: S2819_CACHE=no-store (mitigação), no-cache (o que a HML envia hoje) ou vazio (servidor estático comum).
const CACHE_PREVIA = process.env.S2819_CACHE || (process.env.S2819_NO_STORE === '1' ? 'no-store' : '');

const HARNESS_FETCH = String.raw`(function () {
  var original = window.fetch.bind(window);
  var S = window.__s2819 = { original: original, chamadas: [], modoIdentificar: 'ok', modoImagem: 'ok', segurados: [], abortos: [], desvio: null, cargas: [], naoMapeadas: [], relatos: [], segredos: [] };
  var area = function (v) { return { consultar: v, alterar: v }; };
  var PERM = { status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'ADMINISTRADOR',
    recursos: { atendimentoToken: { visualizar: true, criar: true, editar: true, excluir: false }, employeeHistory: { visualizar: true, criar: false, editar: false, excluir: false } },
    acoes: { TOKEN_PREVIA_CATALOGO_REAL: true },
    administracao: { gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false), autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false } } };
  var MAT = function (id, nome, imagem) { return { id: id, nome: nome, unidade: 'UN', categoria: 'EPI', grupoProtecao: null, tipo: { id: 1, nome: 'Tipo' }, exigeTamanho: false, tamanhos: [], imagem: imagem }; };
  var IDENT = { status: 'ok', previa: { funcionario: { primeiroNome: 'Dora' }, ghe: { codigo: 'GHE-102', descricao: 'Soldagem', ativo: true },
    catalogo: { estado: 'OK', total: 2, materiais: [MAT(31, 'Luva Teste', { disponivel: true, origem: 'PADRAO', id: '4', versao: 1 }), MAT(32, 'Capacete Teste', { disponivel: false })] } } };
  function json(status, corpo) { return new Response(JSON.stringify(corpo), { status: status, headers: { 'Content-Type': 'application/json' } }); }
  function webp() {
    var b = new Uint8Array([82, 73, 70, 70, 26, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 13, 0, 0, 0, 47, 0, 0, 0, 16, 7, 16, 17, 17, 136, 136, 254, 7, 0]);
    return new Response(new Blob([b], { type: 'image/webp' }), { status: 200, headers: { 'Content-Type': 'image/webp' } });
  }
  function segurar(url, sinal, entregar) {
    return new Promise(function (ok, falha) {
      var reg = { url: url, abortada: false, liberar: function () { if (!reg.abortada) ok(entregar()); } };
      S.segurados.push(reg);
      if (sinal) sinal.addEventListener('abort', function () { reg.abortada = true; S.abortos.push(url); falha(new DOMException('abortado', 'AbortError')); });
    });
  }
  var ok = function (c) { var o = { status: 'ok' }; Object.keys(c).forEach(function (k) { o[k] = c[k]; }); return json(200, o); };
  window.fetch = function (destino, opcoes) {
    var u = new URL(String(destino), location.href);
    var caminho = u.pathname.replace(/^\/api/, '');
    var metodo = (opcoes && opcoes.method) || 'GET';
    var chave = metodo + ' ' + caminho;
    S.chamadas.push(chave);
    if (chave === 'GET /auth/me') return Promise.resolve(ok({ usuario: { id: 7, nome: 'Eva', email: 'eva@example.invalid', perfil: 'ADMINISTRADOR' }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } }));
    if (chave === 'GET /auth/global/me') return Promise.resolve(ok({ empresas: [{ id: 3 }] }));
    if (chave === 'GET /auth/permissoes') return Promise.resolve(json(200, PERM));
    if (chave === 'GET /atendimento-token/visao-geral') return Promise.resolve(ok({ visaoGeral: { dispositivos: { cadastrados: 0, ativos: 0, pendentes: 0, revogados: 0 }, ativacoesPendentes: 0, situacaoGeral: 'SEM_DISPOSITIVOS' } }));
    if (chave === 'GET /atendimento-token/dispositivos') return Promise.resolve(ok({ dispositivos: [], total: 0, pagina: 1, limite: 20 }));
    if (chave === 'GET /atendimento-token/redes') return Promise.resolve(ok({ redes: [], total: 0, pagina: 1, limite: 20 }));
    if (chave === 'POST /atendimento-token/previa/identificar') {
      var r = function () { return json(200, IDENT); };
      return S.modoIdentificar === 'segurar' ? segurar(chave, opcoes && opcoes.signal, r) : Promise.resolve(r());
    }
    if (/^GET \/imagens-material\//.test(chave)) return S.modoImagem === 'segurar' ? segurar(chave, opcoes && opcoes.signal, webp) : Promise.resolve(webp());
    S.naoMapeadas.push(chave);
    return Promise.resolve(json(404, { status: 'error', codigo: 'NAO_ENCONTRADO', message: 'x' }));
  };
  // Conta os load de cada iframe da prévia desde ANTES da inserção; registra o segredo do nome (o pai conhece o nome que ele mesmo pôs);
  // com S.desvio, troca o src por um documento intruso antes de a prévia carregar. O intruso lê window.name como um atacante leria:
  // 'MESMO' mantém o nome deste iframe; sem segredo o nome é retirado; um segredo errado substitui o nome.
  var anexar = Node.prototype.appendChild;
  Node.prototype.appendChild = function (filho) {
    if (!filho || filho.tagName !== 'IFRAME' || !filho.getAttribute('sandbox')) return anexar.call(this, filho);
    var reg = { cargas: 0, durante: 0, desviado: false, segredo: filho.getAttribute('name'), srcComSegredo: /ponte=/.test(filho.getAttribute('src') || '') };
    if (reg.segredo) S.segredos.push(reg.segredo);
    var dentro = true;
    filho.addEventListener('load', function () { reg.cargas += 1; if (dentro) reg.durante += 1; reg.nomeDepoisDaCarga = filho.getAttribute('name'); });
    S.cargas.push(reg);
    if (S.desvio) {
      var d = S.desvio; S.desvio = null; reg.desviado = true;
      if (d.segredo === 'MESMO') { /* mantém o nome */ } else if (d.segredo) filho.setAttribute('name', d.segredo); else filho.removeAttribute('name');
      filho.setAttribute('src', '../totem/intrusa.html?atraso=' + (d.atraso || 0));
    }
    var res = anexar.call(this, filho);
    dentro = false;
    return res;
  };
  window.addEventListener('message', function (ev) { var d = ev.data; if (d && d.canal === 'roteiro-s2819') S.relatos.push(d); });
})();`;

const ROTEIRO_CENTRAL = String.raw`(async function () {
  var S = window.__s2819;
  var R = { cenarios: {}, erros: [] };
  var PRAZO = ${PRAZO_HANDSHAKE_MS};
  var esperar = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  async function aguardar(fn, ms) { var fim = Date.now() + ms; while (Date.now() < fim) { try { var v = fn(); if (v) return v; } catch (e) { /* ainda não */ } await esperar(50); } return null; }
  var $ = function (id) { return document.getElementById(id); };
  var relato = function (tipo, desde) { return S.relatos.slice(desde).find(function (r) { return r.tipo === tipo; }) || null; };
  var contar = function (re) { return S.chamadas.filter(function (c) { return re.test(c); }).length; };
  var quadro = function () { return document.querySelector('#totemPreviaQuadro iframe'); };
  var cartao = function () { return $('crColaborador') ? $('crColaborador').textContent.trim() : null; };
  var visivel = function () { var q = quadro(); if (q) q.scrollIntoView({ block: 'start' }); };
  async function reiniciar() {
    var r0 = S.relatos.length; var c0 = S.cargas.length;
    $('botaoReiniciarPrevia').click();
    await aguardar(function () { return S.cargas.length > c0; }, 3000);
    visivel();
    return { r0: r0, c0: c0 };
  }
  // Documento intruso em iframe novo, antes da prévia legítima. Devolve o relato dele e o que a Central serviu.
  async function intrusoAntecipado(desvio) {
    var i0 = contar(/previa\/identificar/); var m0 = contar(/imagens-material/);
    S.desvio = desvio;
    var z = await reiniciar();
    var intr = await aguardar(function () { return relato('RELATO_INTRUSA', z.r0); }, (desvio.atraso || 0) + 10000);
    await esperar(300);
    return { desviado: S.cargas[z.c0] && S.cargas[z.c0].desviado, intrusa: intr, identificarServidos: contar(/previa\/identificar/) - i0, imagensServidas: contar(/imagens-material/) - m0, cartao: cartao() };
  }
  async function controleLoad(comSrcAntes) {
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    var n = 0;
    f.addEventListener('load', function () { n += 1; });
    if (comSrcAntes) f.setAttribute('src', '../totem/vazio.html');
    document.body.appendChild(f);
    var sincronas = n;
    if (!comSrcAntes) f.setAttribute('src', '../totem/vazio.html');
    await esperar(1500);
    var total = n;
    f.remove();
    return { sincronas: sincronas, total: total };
  }
  try {
    await aguardar(function () { return $('aba-visualizarTotem') && $('aba-visualizarTotem').offsetParent !== null; }, 15000);
    $('aba-visualizarTotem').click();
    await aguardar(function () { return $('modoPreviaReal'); }, 5000);

    // 1 e 6 — handshake com segredo, identificação e fotografias visíveis.
    var r0 = S.relatos.length; var c0 = S.cargas.length; var i0 = contar(/previa\/identificar/);
    $('modoPreviaReal').checked = true;
    $('modoPreviaReal').dispatchEvent(new Event('change', { bubbles: true }));
    await aguardar(function () { return quadro(); }, 3000);
    visivel();
    var t = await aguardar(function () { return relato('RELATO_TOTEM', r0); }, 20000);
    await esperar(500);
    R.cenarios.normal = { totem: t, cartao: cartao(), identificar: contar(/previa\/identificar/) - i0, imagens: contar(/imagens-material/), cargas: S.cargas.slice(c0) };
    var segredoUsado = S.cargas[c0] && S.cargas[c0].segredo;
    // Compatibilidade entre versões (Central e adaptador de commits diferentes): só a consulta normal interessa.
    if (/[?&]compat=1/.test(location.search)) throw 'COMPAT_FIM';

    // Reutilização: o MESMO segredo já usado, apresentado por outro documento no mesmo iframe.
    var rr = S.relatos.length; var ir = contar(/previa\/identificar/);
    quadro().setAttribute('src', '../totem/intrusa.html?atraso=0&ponte=' + segredoUsado);
    var intrR = await aguardar(function () { return relato('RELATO_INTRUSA', rr); }, 10000);
    R.cenarios.reutilizacao = { segredoPresente: Boolean(segredoUsado), intrusa: intrR, identificarServidos: contar(/previa\/identificar/) - ir };

    // 2 — eventos load: o iframe da Central e dois controles (src antes da inserção; inserção sem src e src depois).
    R.cenarios.load = { central: S.cargas[c0] || null, srcAntes: await controleLoad(true), srcDepois: await controleLoad(false) };

    // 3 e 5 — navegação com identificação pendente: nada chega ao novo documento; a resposta tardia é descartada.
    S.modoIdentificar = 'segurar';
    var x = await reiniciar();
    await aguardar(function () { return S.segurados.some(function (s) { return /identificar/.test(s.url); }); }, 15000);
    var i1 = contar(/previa\/identificar/);
    var r3 = S.relatos.length;
    quadro().setAttribute('src', '../totem/intrusa.html?atraso=0');
    await esperar(800);
    S.segurados.forEach(function (s) { s.liberar(); });
    S.segurados = [];
    var intr = await aguardar(function () { return relato('RELATO_INTRUSA', r3); }, 10000);
    await esperar(300);
    R.cenarios.navegacao = { pendenteAntes: i1 >= 1, intrusa: intr, cartao: cartao(), identificarDepois: contar(/previa\/identificar/) - i1, cargas: S.cargas[x.c0] };
    S.modoIdentificar = 'ok';

    // 5 — fotografia em voo cancelada pela navegação.
    S.modoImagem = 'segurar';
    var y = await reiniciar();
    await aguardar(function () { return relato('RELATO_TOTEM', y.r0); }, 20000);
    await aguardar(function () { return S.segurados.some(function (s) { return /imagens-material/.test(s.url); }); }, 8000);
    var pendentes = S.segurados.filter(function (s) { return /imagens-material/.test(s.url) && !s.abortada; }).length;
    var a0 = S.abortos.length;
    var r5 = S.relatos.length;
    quadro().setAttribute('src', '../totem/intrusa.html?atraso=0');
    await esperar(800);
    var abortadas = S.abortos.length - a0;
    S.segurados.forEach(function (s) { s.liberar(); });
    S.segurados = [];
    var intr5 = await aguardar(function () { return relato('RELATO_INTRUSA', r5); }, 10000);
    R.cenarios.imagemEmVoo = { pendentes: pendentes, abortadas: abortadas, intrusa: intr5 };
    S.modoImagem = 'ok';

    // 4 — documento não autorizado faz o handshake ANTES da prévia legítima: sem segredo, com segredo errado e (expiração)
    // com o segredo certo depois do prazo.
    R.cenarios.antecipadoSemSegredo = await intrusoAntecipado({});
    R.cenarios.antecipadoSegredoErrado = await intrusoAntecipado({ segredo: '0123456789abcdef0123456789abcdef' });
    R.cenarios.expirado = await intrusoAntecipado({ segredo: 'MESMO', atraso: PRAZO + 1500 });
    // Controle informativo (NÃO é proteção): quem tiver o segredo vigente dentro do prazo é aceito, porque o segredo é a credencial.
    R.cenarios.controleSegredoVazado = await intrusoAntecipado({ segredo: 'MESMO', atraso: 0 });
  } catch (e) {
    if (e !== 'COMPAT_FIM') R.erros.push(String(e && e.stack || e));
  }
  R.naoMapeadas = S.naoMapeadas;
  R.segredos = S.segredos;
  R.cargas = S.cargas;
  // Segredos que só o iframe legítimo conheceu: sem desvio e nunca reapresentados por um intruso (o do cenário normal foi reusado).
  R.segredosLegitimos = S.cargas.filter(function (c) { return c.segredo && !c.desviado && c.segredo !== segredoUsado; }).map(function (c) { return c.segredo; });
  R.localStorage = Object.keys(localStorage).map(function (k) { return k + '=' + localStorage.getItem(k); });
  R.sessionStorage = Object.keys(sessionStorage).map(function (k) { return k + '=' + sessionStorage.getItem(k); });
  R.historicoCentral = { url: location.href, tamanho: history.length };
  await S.original('/__relato', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(R) });
})();`;

const ROTEIRO_TOTEM = String.raw`(function () {
  var esperar = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  async function aguardar(fn, ms) { var fim = Date.now() + ms; while (Date.now() < fim) { try { var v = fn(); if (v) return v; } catch (e) { /* ainda não */ } await esperar(50); } return null; }
  (async function () {
    var urlDepois = location.href;
    var tipo = await aguardar(function () { var b = document.getElementById('tipoMatricula'); return b && b.offsetParent !== null ? b : null; }, 8000);
    if (!tipo) { parent.postMessage({ canal: 'roteiro-s2819', tipo: 'RELATO_TOTEM', erro: 'sem tela de identificação' }, '*'); return; }
    tipo.click();
    for (var d of '2001') {
      var t = Array.from(document.querySelectorAll('#teclado .tecla')).find(function (b) { return b.textContent.trim() === d; });
      if (t) t.click();
      await esperar(30);
    }
    var cont = Array.from(document.querySelectorAll('button')).find(function (b) { return b.offsetParent !== null && b.textContent.indexOf('Continuar') !== -1; });
    if (cont) cont.click();
    var ola = await aguardar(function () { return /Olá, Dora/.test(document.body.textContent); }, 10000);
    var imgs = await aguardar(function () { var l = Array.from(document.querySelectorAll('#grade .prod-img img')).filter(function (i) { return /^data:image\/webp/.test(i.getAttribute('src') || ''); }); return l.length ? l : null; }, 8000);
    parent.postMessage({ canal: 'roteiro-s2819', tipo: 'RELATO_TOTEM', ola: Boolean(ola), imagens: imgs ? imgs.length : 0, urlSemSegredo: !/ponte=/.test(urlDepois), nomeDepois: window.name, referrer: document.referrer,
      indisponivel: /Não foi possível se comunicar com o sistema/.test(document.body.textContent) }, '*');
  })();
})();`;

// Documento intruso: tenta o handshake (com o segredo que conseguir: window.name herdado ou, simulando um vazamento, `ponte` do próprio
// endereço, após `atraso` ms) e pede identificação e imagem; registra o nome que encontrou e tudo o que recebe, pela porta e pela janela.
const INTRUSA_JS = String.raw`(function () {
  var CANAL = 'safework-previa-totem';
  var q = new URLSearchParams(location.search);
  var nomeVisto = window.name;
  var segredo = q.get('ponte') || nomeVisto;
  var atraso = Number(q.get('atraso') || 0);
  var recebidas = [];
  var resumo = function (via, d) { return { via: via, tipo: d && d.tipo, id: d && d.id, resultado: d && d.resultado, primeiroNome: d && d.primeiroNome, temBlob: Boolean(d && d.blob) }; };
  window.addEventListener('message', function (ev) { recebidas.push(resumo('janela', ev.data)); });
  setTimeout(function () {
    var c = new MessageChannel();
    c.port1.onmessage = function (ev) {
      var d = ev.data;
      recebidas.push(resumo('porta', d));
      if (d && d.tipo === 'PONTE_PRONTA') {
        c.port1.postMessage({ canal: CANAL, versao: 1, tipo: 'IDENTIFICAR', id: 'intrusa-consulta-1', tipoId: 'MATRICULA', valor: '2001' });
        c.port1.postMessage({ canal: CANAL, versao: 1, tipo: 'IMAGEM', id: 'intrusa-imagem-1', origem: 'PADRAO', imagemId: '4', versaoImagem: 1, variante: 'miniatura' });
      }
    };
    var m = { canal: CANAL, versao: 1, tipo: 'PONTE_ABRIR', id: 'intrusa-ponte-0001' };
    if (segredo) m.segredo = segredo;
    parent.postMessage(m, '*', [c.port2]);
    setTimeout(function () { parent.postMessage({ canal: 'roteiro-s2819', tipo: 'RELATO_INTRUSA', recebidas: recebidas, nomeVisto: nomeVisto }, '*'); }, 2500);
  }, atraso);
})();`;

function prepararSite() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's2819-navegador-')));
  for (const sub of ['css', 'portal', 'vendor']) fs.symlinkSync(path.join(RAIZ, sub), path.join(dir, sub));
  // Compatibilidade: S2819_TELA / S2819_ADAPTADOR trocam a Central ou o adaptador por outra versão (arquivo extraído de outro commit).
  const trocas = { 'js/atendimento-token-tela.js': process.env.S2819_TELA, 'totem/previa-adaptador.js': process.env.S2819_ADAPTADOR };
  fs.mkdirSync(path.join(dir, 'js'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'js'))) {
    const t = trocas[`js/${f}`];
    if (t) fs.copyFileSync(t, path.join(dir, 'js', f)); else fs.symlinkSync(path.join(RAIZ, 'js', f), path.join(dir, 'js', f));
  }
  fs.mkdirSync(path.join(dir, 'pages'));
  fs.mkdirSync(path.join(dir, 'totem'));
  for (const f of fs.readdirSync(path.join(RAIZ, 'totem'))) {
    if (f === 'previa.html') continue;
    const t = trocas[`totem/${f}`];
    if (t) fs.copyFileSync(t, path.join(dir, 'totem', f)); else fs.symlinkSync(path.join(RAIZ, 'totem', f), path.join(dir, 'totem', f));
  }
  const previa = fs.readFileSync(path.join(RAIZ, 'totem', 'previa.html'), 'utf8');
  assert.ok(previa.includes('<script src="totem.js"></script>'));
  fs.writeFileSync(path.join(dir, 'totem', 'previa.html'), previa.replace('<script src="totem.js"></script>', '<script src="totem.js"></script><script src="roteiro-totem.js"></script>'));
  fs.writeFileSync(path.join(dir, 'totem', 'roteiro-totem.js'), ROTEIRO_TOTEM);
  fs.writeFileSync(path.join(dir, 'totem', 'intrusa.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><p>outro documento</p><script src="intrusa.js"></script></body></html>');
  fs.writeFileSync(path.join(dir, 'totem', 'intrusa.js'), INTRUSA_JS);
  fs.writeFileSync(path.join(dir, 'totem', 'vazio.html'), '<!doctype html><html><body></body></html>');
  let central = fs.readFileSync(path.join(RAIZ, 'pages', 'atendimento-token.html'), 'utf8').replace(/<link rel="stylesheet" href="https:\/\/[^>]*>/g, '');
  assert.ok(central.includes('<script src="../js/tema.js"></script>'));
  central = central.replace('<script src="../js/tema.js"></script>', '<script src="harness-fetch.js"></script><script src="../js/tema.js"></script>');
  central = central.replace('</body>', '<script src="roteiro-central.js"></script></body>');
  fs.writeFileSync(path.join(dir, 'pages', 'atendimento-token.html'), central);
  fs.writeFileSync(path.join(dir, 'pages', 'harness-fetch.js'), HARNESS_FETCH);
  fs.writeFileSync(path.join(dir, 'pages', 'roteiro-central.js'), ROTEIRO_CENTRAL);
  return dir;
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function servir(dir, aoRelato, pedidos) {
  const raiz = fs.realpathSync(RAIZ);
  const servidor = http.createServer((req, res) => {
    pedidos.push({ metodo: req.method, url: req.url, referer: req.headers.referer || null });
    if (req.method === 'POST' && req.url === '/__relato') {
      let corpo = '';
      req.on('data', (c) => { corpo += c; if (corpo.length > 1e6) req.destroy(); });
      req.on('end', () => { res.writeHead(204); res.end(); aoRelato(corpo); });
      return;
    }
    let alvo;
    try { alvo = fs.realpathSync(path.join(dir, decodeURIComponent(req.url.split('?')[0]))); } catch { res.writeHead(404); res.end(); return; }
    if (!(alvo.startsWith(dir) || alvo.startsWith(raiz)) || fs.statSync(alvo).isDirectory()) { res.writeHead(404); res.end(); return; }
    const cabecalhos = { 'Content-Type': TIPOS[path.extname(alvo)] || 'application/octet-stream' };
    if (CACHE_PREVIA && req.url.startsWith('/totem/previa.html')) cabecalhos['Cache-Control'] = CACHE_PREVIA;
    res.writeHead(200, cabecalhos);
    fs.createReadStream(alvo).pipe(res);
  });
  return new Promise((resolve) => servidor.listen(0, '127.0.0.1', () => resolve({ servidor, porta: servidor.address().port })));
}

function arquivosCom(dir, segredos) {
  const achados = [];
  const visitar = (d) => {
    let itens = [];
    try { itens = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of itens) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) visitar(p);
      else if (it.isFile()) {
        let b;
        try { b = fs.readFileSync(p); } catch { continue; }
        for (const s of segredos) if (b.includes(s) || b.includes(Buffer.from(s, 'utf16le'))) achados.push({ arquivo: path.relative(dir, p), segredo: s.slice(0, 6) });
      }
    }
  };
  visitar(dir);
  return achados;
}

const chrome = chromeDisponivel();
const COMPAT = process.env.S2819_COMPAT === '1';
let R = null;
const pedidos = [];
let perfilVarrido = null;

describe('S2819 — compatibilidade entre versões da Central e do adaptador (S2819_COMPAT=1)', { skip: !chrome ? 'Chrome não encontrado' : (COMPAT ? false : 'só com S2819_COMPAT=1') }, () => {
  before(iniciar);
  after(encerrar);
  test('versões incompatíveis falham fechadas: nenhuma identificação é atendida, o Totem mostra indisponibilidade e nada vaza', () => {
    const c = R.cenarios.normal;
    assert.deepEqual(R.erros, []);
    assert.ok(c && c.totem, 'relato do Totem');
    assert.equal(c.totem.ola, false, 'sem "Olá"');
    assert.equal(c.totem.indisponivel, true, 'mensagem de indisponibilidade');
    assert.equal(c.identificar, 0, 'a Central não consulta o servidor');
    assert.notEqual(c.cartao, 'Dora');
  });
});

describe('S2819 — ponte da prévia em Chrome real (v2, segredo de uso único)', { skip: !chrome ? 'Chrome não encontrado' : (COMPAT ? 'modo compatibilidade' : false) }, () => {
  before(iniciar);
  after(encerrar);

  const nadaPelaPorta = (intr, nome) => {
    assert.ok(intr, `${nome}: relato do intruso`);
    assert.deepEqual(intr.recebidas.filter((r) => r.via === 'porta'), [], `${nome}: sem PONTE_PRONTA, RESULTADO ou IMAGEM_RESULTADO`);
  };
  testesPrincipais(nadaPelaPorta);
});

let dir = null; let perfil = null; let proc = null; let servidor = null;

async function iniciar() {
    dir = prepararSite();
    let receber;
    const relato = new Promise((r) => { receber = r; });
    const s = await servir(dir, (c) => receber(c), pedidos);
    servidor = s.servidor;
    perfil = fs.mkdtempSync(path.join(os.tmpdir(), 's2819-chrome-'));
    const url = `http://127.0.0.1:${s.porta}/pages/atendimento-token.html${COMPAT ? '?compat=1' : ''}`;
    proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--window-size=1400,2400', `--user-data-dir=${perfil}`, url], { stdio: 'ignore', detached: true });
    let relogio;
    const limite = new Promise((_, falha) => { relogio = setTimeout(() => falha(new Error('sem relato do navegador no prazo')), LIMITE_MS); });
    try {
      R = JSON.parse(await Promise.race([relato, limite]));
    } finally {
      clearTimeout(relogio);
      for (const matar of [() => process.kill(-proc.pid, 'SIGKILL'), () => proc.kill('SIGKILL')]) { try { matar(); } catch { /* já encerrado */ } }
      await new Promise((r) => setTimeout(r, 1500));
    }
    perfilVarrido = arquivosCom(perfil, R.segredosLegitimos || []);
    if (process.env.S2819_RELATO) fs.writeFileSync(process.env.S2819_RELATO, JSON.stringify({ modo: CACHE_PREVIA || 'sem-cache-control', compat: COMPAT ? { tela: process.env.S2819_TELA || 'atual', adaptador: process.env.S2819_ADAPTADOR || 'atual' } : null, relato: R, pedidos, perfilVarrido }, null, 2));
}

async function encerrar() {
    for (const matar of [() => process.kill(-proc.pid, 'SIGKILL'), () => proc.kill('SIGKILL')]) { try { if (proc) matar(); } catch { /* já encerrado */ } }
    if (servidor) await new Promise((r) => { servidor.closeAllConnections?.(); servidor.close(() => r()); });
    for (const d of [perfil, dir]) { if (d) fs.rmSync(d, { recursive: true, force: true }); }
}

function testesPrincipais(nadaPelaPorta) {

  test('o roteiro terminou sem erro e gerou segredos de 128 bits distintos por iframe', () => {
    assert.deepEqual(R.erros, []);
    assert.ok(R.segredos.length >= 6);
    assert.ok(R.segredos.every((s) => /^[0-9a-f]{32}$/.test(s)));
    assert.equal(new Set(R.segredos).size, R.segredos.length, 'nenhum segredo repetido');
  });

  test('1/6 — handshake e consulta real: o Totem mostra "Olá, Dora" e a fotografia; a Central atende uma identificação e a imagem', () => {
    const c = R.cenarios.normal;
    assert.ok(c && c.totem, 'relato do Totem');
    assert.equal(c.totem.ola, true);
    assert.ok(c.totem.imagens >= 1, 'fotografia data:image/webp no Totem');
    assert.equal(c.identificar, 1);
    assert.ok(c.imagens >= 1, 'a Central buscou a imagem na Biblioteca');
    assert.equal(c.cartao, 'Dora');
  });

  test('2 — load: o iframe da Central tem um único load, nenhum durante a inserção (about:blank não conta); controles registrados', () => {
    const l = R.cenarios.load;
    assert.equal(l.central.durante, 0);
    assert.ok(l.central.cargas >= 1);
    assert.equal(typeof l.srcAntes.total, 'number');
    assert.equal(typeof l.srcDepois.total, 'number');
  });

  test('3 — navegação do iframe com identificação pendente: o novo documento não recebe nada e a resposta tardia é descartada', () => {
    const n = R.cenarios.navegacao;
    assert.equal(n.pendenteAntes, true);
    assert.deepEqual(n.intrusa && n.intrusa.recebidas, [], 'nada pela porta nem pela janela');
    assert.notEqual(n.cartao, 'Dora');
    assert.equal(n.identificarDepois, 0);
  });

  test('5 — fotografia em voo é abortada na navegação e nada chega ao novo documento', () => {
    const i = R.cenarios.imagemEmVoo;
    assert.ok(i.pendentes >= 1, 'havia fotografia em voo');
    assert.ok(i.abortadas >= 1, 'a chamada foi abortada');
    assert.deepEqual(i.intrusa && i.intrusa.recebidas, []);
  });

  test('4 — documento não autorizado antes da prévia legítima: sem segredo e com segredo errado não ganha ponte nem dados', () => {
    for (const nome of ['antecipadoSemSegredo', 'antecipadoSegredoErrado']) {
      const h = R.cenarios[nome];
      assert.equal(h.desviado, true, nome);
      nadaPelaPorta(h.intrusa, nome);
      assert.equal(h.identificarServidos, 0, nome);
      assert.equal(h.imagensServidas, 0, nome);
      assert.notEqual(h.cartao, 'Dora', nome);
    }
  });

  test('reutilização — o segredo já usado, apresentado por outro documento, é recusado', () => {
    const r = R.cenarios.reutilizacao;
    assert.equal(r.segredoPresente, true);
    nadaPelaPorta(r.intrusa, 'reutilizacao');
    assert.equal(r.identificarServidos, 0);
  });

  test('expiração — o segredo certo apresentado depois do prazo é recusado', () => {
    const e = R.cenarios.expirado;
    nadaPelaPorta(e.intrusa, 'expirado');
    assert.equal(e.identificarServidos, 0);
  });

  test('isolamento — o nome é lido e apagado pela prévia, sai do iframe na primeira carga e nenhum documento seguinte o herda', () => {
    assert.equal(R.cenarios.normal.totem.nomeDepois, '', 'window.name vazio depois da leitura');
    const legitimas = R.cenarios.normal.cargas.concat([R.cenarios.navegacao.cargas]).filter(Boolean);
    for (const c of legitimas) assert.equal(c.nomeDepoisDaCarga, null, 'atributo name retirado na carga');
    assert.ok(R.cargas.length >= 6 && R.cargas.every((c) => c.srcComSegredo === false), 'nenhum src leva o segredo');
    for (const nome of ['reutilizacao', 'navegacao', 'imagemEmVoo']) assert.equal(R.cenarios[nome].intrusa && R.cenarios[nome].intrusa.nomeVisto, '', `${nome}: o documento seguinte encontra window.name vazio`);
    assert.equal(R.cenarios.antecipadoSemSegredo.intrusa.nomeVisto, '', 'iframe sem nome');
  });

  test('exposição — o segredo nunca vai na URL nem em Referer, não fica no perfil do Chrome nem no armazenamento', () => {
    assert.equal(R.cenarios.normal.totem.urlSemSegredo, true, 'a URL do documento não tem o segredo');
    // O único pedido com segredo é o do roteiro que entrega ao intruso, por query, o segredo já usado (cenário de reutilização).
    const comSegredoNaUrl = pedidos.filter((p) => R.segredos.some((s) => p.url.includes(s)));
    assert.ok(comSegredoNaUrl.every((p) => p.url.startsWith('/totem/intrusa.html?')), JSON.stringify(comSegredoNaUrl));
    assert.equal(pedidos.filter((p) => p.url.startsWith('/totem/previa.html') && /ponte=/.test(p.url)).length, 0, 'previa.html sem query de segredo');
    const comSegredoNoReferer = pedidos.filter((p) => p.referer && R.segredos.some((s) => p.referer.includes(s)));
    assert.deepEqual(comSegredoNoReferer, [], 'nenhum Referer leva o segredo');
    assert.equal(JSON.stringify([R.localStorage, R.sessionStorage]).match(/[0-9a-f]{32}/), null, 'nada em localStorage/sessionStorage');
    assert.equal(R.historicoCentral.url.includes('ponte='), false);
    assert.ok(R.segredosLegitimos.length >= 2, 'iframes legítimos dos cenários de navegação e de foto em voo');
    assert.deepEqual(perfilVarrido, [], `o perfil do Chrome (histórico, sessões, cache) não guarda o segredo do iframe legítimo [Cache-Control do previa.html: ${CACHE_PREVIA || 'ausente'}]`);
  });

  test('controle informativo — quem tiver o segredo VIGENTE dentro do prazo é aceito (o segredo é a credencial; registrado, não é proteção)', () => {
    const c = R.cenarios.controleSegredoVazado;
    assert.ok(c.intrusa, 'relato do controle');
    assert.ok(Array.isArray(c.intrusa.recebidas));
  });
}
