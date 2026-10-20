'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { abrirPagina, RAIZ, semComentarios } = require('./helpers/dom-pagina');
const { injetarShim } = require('./helpers/totem-i');

/**
 * K7 — Prévia visual do Totem (modalidade 1). A página `totem/previa.html` tem o mesmo corpo do `totem/index.html` e o mesmo
 * `totem.js`/`totem.css`, mas NUNCA fala com a API: `totem/previa-adaptador.js` define o `fetch` da página e responde tudo em
 * memória, com dados fictícios (matrículas 1001, 1002 e 1003). Sem CPF, sem cookie, sem credencial de tablet, sem armazenamento.
 *
 * Os testes de execução trocam o `fetch` e o armazenamento do harness por SENTINELAS: se qualquer operação simulada escapar para
 * a rede, o teste falha (e há um mutante que prova isso).
 */

const PREVIA = 'totem/previa.html';
const ADAPTADOR = 'totem/previa-adaptador.js';
const API = 'https://previa.invalid/api/atendimento-token/tablet';
const lerArquivo = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const existe = (rel) => fs.existsSync(path.join(RAIZ, rel));
const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(RAIZ, rel))).digest('hex');
const exigir = (rel) => assert.ok(existe(rel), `RED K7: ${rel} ainda não existe (comportamento ausente)`);

// Os arquivos do Totem real não podem mudar (decisão do K7): hashes de 15/10/2026; index.html com o favicon e o título do refinamento visual de 18/10/2026
// (pino atualizado na consolidação de 19/10/2026).
const PINOS = Object.freeze({
  'totem/index.html': 'e41495afa9e0e7f5b1d0b104080180821c42a7c909b5f5d7667ca213cf7ee181',
  'totem/totem.js': '9ee5d2f8d66e154c067c0f7a35c5214a1341fcd42899f92ac3c16cdf5a60c33e',
  'totem/totem.css': '9c6b3665fe47ad88543e8f59053b082544816943d5753c41980625f4b379e3ac',
  'totem/boot.js': '583454fe94c2ed73776fd77b4560eb70c59dd708ad582b2a61ff4878104d6899',
});

const semComentariosHtml = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const scriptsDoHtml = (html) => [...semComentariosHtml(html).matchAll(/<script\b[^>]*>/gi)].map((m) => ({ tag: m[0], src: /\bsrc\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? null }));
const corpoDe = (html) => (/<body[^>]*>([\s\S]*)<\/body>/i.exec(semComentariosHtml(html))?.[1] ?? '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/\s+/g, ' ').trim();

// ───────────────────────── execução no harness, com sentinelas de rede ─────────────────────────

function abrirPrevia({ transformar = null } = {}) {
  exigir(PREVIA);
  exigir(ADAPTADOR);
  const p = abrirPagina(PREVIA, { html: injetarShim(lerArquivo(PREVIA)), transformar });
  return p;
}

const telaAtual = (p) => p.consulta('.tela').filter(p.visivelNo).map((e) => e.id);
const clicar = async (p, el) => { assert.ok(el, 'elemento a clicar não encontrado'); await el.disparar('click'); await p.esperar(); };
const botao = (p, texto) => p.consulta('button').filter(p.visivelNo).find((b) => b.textContent.includes(texto));
const clicarTexto = async (p, texto) => {
  const b = botao(p, texto);
  assert.ok(b, `botão "${texto}" não encontrado entre os visíveis: ${JSON.stringify(p.consulta('button').filter(p.visivelNo).map((x) => x.textContent.replace(/\s+/g, ' ').trim()))}`);
  await clicar(p, b);
};
const digitar = async (p, texto) => {
  for (const d of texto) await clicar(p, p.consulta('#teclado .tecla').find((b) => b.textContent.trim() === d));
};
async function identificar(p, tipo, valor) {
  await clicar(p, p.el(tipo === 'CPF' ? 'tipoCpf' : 'tipoMatricula'));
  await digitar(p, valor);
  await clicarTexto(p, 'Continuar');
  await p.esperar();
}
const produtos = (p) => p.consulta('#grade .prod-nome').map((e) => e.textContent.trim());
async function adicionar(p, nome, tamanho = null) {
  await clicar(p, p.consulta('#grade .prod').find((e) => e.querySelector('.prod-nome')?.textContent.trim() === nome));
  if (tamanho !== null) await clicar(p, p.consulta('#tams .tam').find((e) => (e.querySelector('b')?.textContent ?? e.textContent).trim() === tamanho));
  await clicar(p, p.el('btnSolicitar'));
}
const passarSegundos = async (p, s) => { for (let i = 0; i < s; i += 1) { p.janela.__relogio.avancar(1000); await p.esperar(); } };
const textoDaPagina = (p) => p.consulta('.tela').filter(p.visivelNo).map((e) => e.textContent).join(' ').replace(/\s+/g, ' ');

/** A sentinela: nada de rede, armazenamento, cookie, histórico ou console originado pela prévia. */
function semEscapes(p) {
  assert.deepEqual(p.chamadas.map((c) => c.chave), [], 'o fetch do harness (a rede real) não pode ser chamado');
  assert.deepEqual(p.externas, [], 'nenhum destino fora do adaptador');
  assert.deepEqual(p.storage, [], 'nenhum acesso a localStorage/sessionStorage/indexedDB');
  assert.deepEqual(p.cookiesEscritos, [], 'nenhum cookie escrito');
  assert.deepEqual(p.navegacoes, [], 'nenhuma navegação');
  assert.deepEqual(p.historico, [], 'nenhuma alteração do histórico');
  assert.deepEqual(p.consoleChamadas, [], 'nada no console');
}

const registro = (p) => JSON.parse(JSON.stringify(p.janela.TotemPrevia.chamadas()));

describe('K7 — arquivos, ordem dos scripts e isolamento declarado', () => {
  test('K7-A1 — previa.html e previa-adaptador.js existem', () => {
    exigir(PREVIA);
    exigir(ADAPTADOR);
  });

  test('K7-A2 — scripts na ordem boot.js, previa-adaptador.js, totem.js; nada de configuração, protótipo ou API real', () => {
    exigir(PREVIA);
    const scripts = scriptsDoHtml(lerArquivo(PREVIA));
    assert.deepEqual(scripts.map((s) => s.src), ['boot.js', 'previa-adaptador.js', 'totem.js'], 'o adaptador vem antes do totem.js; nenhum outro script');
    for (const s of scripts) assert.doesNotMatch(s.tag, /\b(type\s*=\s*"module"|async|defer)\b/i, `script com carregamento fora de ordem: ${s.tag}`);
    const html = lerArquivo(PREVIA);
    assert.doesNotMatch(html, /portal\/config\.js|main\.js|db-api\.js|inspecao-visual\.js|painel-privado|<iframe|<form|<img/i);
    assert.doesNotMatch(semComentariosHtml(html), /<script\b(?![^>]*\bsrc=)[^>]*>/i, 'nenhum script embutido (a CSP não os permite)');
  });

  test('K7-A3 — CSP restritiva por meta, antes de qualquer script, com connect-src \'none\'', () => {
    exigir(PREVIA);
    const html = semComentariosHtml(lerArquivo(PREVIA));
    const meta = /<meta\b[^>]*http-equiv\s*=\s*"Content-Security-Policy"[^>]*>/i.exec(html);
    assert.ok(meta, 'meta CSP ausente');
    assert.ok(meta.index < html.search(/<script\b/i), 'a CSP precisa vir antes de qualquer script');
    const csp = /content\s*=\s*"([^"]*)"/i.exec(meta[0])[1];
    const diretivas = Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1).join(' ')]));
    assert.equal(diretivas['default-src'], "'none'");
    assert.equal(diretivas['connect-src'], "'none'");
    assert.equal(diretivas['script-src'], "'self'");
    assert.equal(diretivas['base-uri'], "'none'");
    assert.equal(diretivas['form-action'], "'none'");
    assert.equal(diretivas['object-src'], "'none'");
    assert.doesNotMatch(csp, /unsafe-eval|\bhttps?:|\*/i, 'sem eval, sem host externo, sem curinga');
    assert.doesNotMatch(diretivas['script-src'], /unsafe-inline/);
  });

  test('K7-A4 — paridade: o corpo da previa.html é idêntico ao do index.html (o visual aprovado não deriva)', () => {
    exigir(PREVIA);
    const real = corpoDe(lerArquivo('totem/index.html'));
    const previa = corpoDe(lerArquivo(PREVIA));
    assert.ok(real.length > 5000, 'corpo do Totem real lido');
    assert.equal(previa, real);
    const folha = (html) => /<link\b[^>]*rel="stylesheet"[^>]*>/i.exec(semComentariosHtml(html))?.[0];
    assert.equal(folha(lerArquivo(PREVIA)), folha(lerArquivo('totem/index.html')), 'a mesma folha de estilo (totem.css)');
  });

  test('K7-A4b — o ícone do cabeçalho "Retirada de EPI" usa o azul da Central, ajustado SÓ na camada da prévia (o Totem oficial continua azul-marinho)', () => {
    exigir(PREVIA);
    const previa = lerArquivo(PREVIA);
    const estilos = [...semComentariosHtml(previa).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    assert.equal(estilos.length, 1, 'um único bloco de estilo, só com o ajuste da prévia');
    assert.equal(estilos[0], '.brand i{background:#007AFF} @media (prefers-color-scheme:dark){.brand i{background:#0A84FF}}');
    // O ajuste vem DEPOIS da folha oficial, para vencer a cascata sem tocar nela.
    assert.ok(previa.indexOf('href="totem.css"') < previa.indexOf('<style>'));
    // Mesmo azul do ícone "Gestão de EPIs" da Central (--primary do main.css, claro e escuro).
    const central = fs.readFileSync(path.join(RAIZ, 'css/main.css'), 'utf8');
    assert.match(central, /--primary:#007AFF;/);
    assert.match(central, /html\[data-theme="dark"\][^{]*\{[^}]*--primary:#0A84FF;/);
    assert.match(central, /\.brand-badge\{[^}]*background:var\(--primary\)/);
    // O Totem oficial não ganhou nada e segue com o azul-marinho próprio.
    assert.doesNotMatch(lerArquivo('totem/index.html'), /<style\b/i);
    assert.match(lerArquivo('totem/totem.css'), /--brand:#1a3a6b/);
    assert.equal(sha('totem/totem.css'), PINOS['totem/totem.css']);
  });

  test('K7-A5 — o Totem real não mudou: index.html, totem.js, totem.css e boot.js com os hashes de antes', () => {
    for (const [rel, hash] of Object.entries(PINOS)) assert.equal(sha(rel), hash, rel);
    assert.doesNotMatch(lerArquivo('totem/index.html'), /previa/i, 'o Totem real não conhece a prévia');
    assert.doesNotMatch(lerArquivo('totem/totem.js'), /TotemPrevia|previa-adaptador/);
  });

  test('K7-A6 — o adaptador não tem rede, armazenamento, cookie nem execução dinâmica, e não guarda o fetch original', () => {
    exigir(ADAPTADOR);
    const codigo = semComentarios(lerArquivo(ADAPTADOR));
    assert.doesNotMatch(codigo, /\b(localStorage|sessionStorage|indexedDB|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|Worker)\b/);
    // Consulta real (K7): a única saída é UM postMessage para a janela pai, com destino explícito (provas em totem-k7-consulta-real.test.js).
    assert.equal((codigo.match(/\.postMessage\s*\(/g) || []).length <= 1, true, 'no máximo um postMessage');
    assert.doesNotMatch(codigo, /document\.cookie|\beval\s*\(|new\s+Function|\bimport\s*\(|\brequire\s*\(|\bXMLHttp/);
    assert.doesNotMatch(codigo, /(?<![.\w])fetch\s*\(|\.fetch\s*\(|=\s*(window\.|self\.|globalThis\.)?fetch\b/, 'nunca chama nem copia o fetch original');
    assert.equal((codigo.match(/window\.fetch\s*=/g) || []).length, 1, 'define o fetch da página uma única vez');
    assert.doesNotMatch(codigo, /https?:\/\/(?!previa\.invalid)/i, 'nenhum endereço real');
    assert.doesNotMatch(codigo, /\/api\b(?!\s*['"`])/, 'nenhum caminho de API além da base fictícia');
  });

  test('K7-A7 — fixtures fictícias: só as matrículas 1001, 1002 e 1003; nenhum CPF, e-mail ou telefone no adaptador', () => {
    exigir(ADAPTADOR);
    const codigo = lerArquivo(ADAPTADOR);
    assert.deepEqual([...new Set([...codigo.matchAll(/matricula\s*:\s*'([^']+)'/g)].map((m) => m[1]))].sort(), ['1001', '1002', '1003']);
    assert.doesNotMatch(codigo, /\b\d{11}\b|\d{3}\.\d{3}\.\d{3}-\d{2}|@[a-z0-9-]+\.[a-z]|\(\d{2}\)\s*\d{4,5}-?\d{4}/i);
  });

  test('K7-A8 — a prévia e o adaptador estão na allowlist de publicação, e o Totem real continua nela', () => {
    const lista = JSON.parse(lerArquivo('publicacao/allowlist.json')).arquivos;
    for (const rel of ['totem/previa.html', 'totem/previa-adaptador.js', 'totem/index.html', 'totem/boot.js', 'totem/totem.js', 'totem/totem.css']) {
      assert.ok(lista.includes(rel), `${rel} fora da allowlist`);
    }
  });
});

describe('K7 — execução: tudo em memória, nenhuma operação escapa', () => {
  test('K7-B1 — abrir a prévia não chama nada fora do adaptador e mostra a identificação', async () => {
    const p = abrirPrevia();
    await p.esperar();
    assert.deepEqual(telaAtual(p), ['telaAcesso']);
    semEscapes(p);
    assert.equal(p.janela.SAFEWORK_PORTAL_API_BASE_URL, 'https://previa.invalid/api', 'a base da API é um domínio que nunca resolve');
  });

  test('K7-B2 — matrícula 1001: identificação, catálogo, tamanhos, carrinho, motivos e confirmação, sem nenhuma operação real', async () => {
    const p = abrirPrevia();
    await p.esperar();
    await identificar(p, 'MATRICULA', '1001');
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    assert.match(textoDaPagina(p), /Olá, Ana/);
    assert.deepEqual(produtos(p), ['Botina de Segurança', 'Protetor Auricular', 'Camiseta', 'Capacete', 'Luva de Proteção', 'Óculos de Proteção']);
    await adicionar(p, 'Botina de Segurança', '40');
    await adicionar(p, 'Protetor Auricular');
    await clicarTexto(p, 'Revisar e enviar pedido');
    assert.deepEqual(telaAtual(p), ['telaRevisao']);
    assert.equal(p.consulta('#telaRevisao [data-item]').length, 2);
    for (let i = 0; i < 2; i += 1) {
      const linha = p.consulta(`#telaRevisao [data-item="${i}"]`)[0];
      await clicar(p, linha.querySelectorAll('button').find((b) => b.getAttribute('data-motivo') === 'DESGASTE_DANO'));
    }
    await clicarTexto(p, 'Enviar pedido');
    assert.deepEqual(telaAtual(p), ['telaConfirma']);
    assert.doesNotMatch(textoDaPagina(p), /Ana|Botina|Protetor|PREVIA/, 'a confirmação é neutra');
    semEscapes(p);
    const feitas = registro(p).map((c) => `${c.metodo} ${c.caminho}`);
    assert.ok(feitas.includes('POST /atendimento'));
    assert.ok(feitas.includes('GET /atendimento/catalogo'));
    assert.ok(feitas.includes('POST /atendimento/pedido'));
  });

  test('K7-B3 — matrícula 1002 (sem GHE): mensagem própria e catálogo vazio', async () => {
    const p = abrirPrevia();
    await p.esperar();
    await identificar(p, 'MATRICULA', '1002');
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    assert.match(textoDaPagina(p), /Olá, Bruno/);
    assert.match(textoDaPagina(p), /Seu cadastro ainda não tem materiais liberados\. Procure a Segurança do Trabalho\./);
    assert.deepEqual(produtos(p), []);
    semEscapes(p);
  });

  test('K7-B4 — matrícula 1003 (pedidos em aberto): aviso com as situações e depois o catálogo', async () => {
    const p = abrirPrevia();
    await p.esperar();
    await identificar(p, 'MATRICULA', '1003');
    assert.deepEqual(telaAtual(p), ['telaAviso']);
    assert.match(textoDaPagina(p), /Você possui EPIs disponíveis para retirada\./);
    assert.match(textoDaPagina(p), /Aguardando aprovação/);
    await clicarTexto(p, 'OK — Solicitar novos EPIs');
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    assert.match(textoDaPagina(p), /Olá, Carla/);
    semEscapes(p);
  });

  test('K7-B5 — matrícula desconhecida e CPF (qualquer um) não identificam; nada é enviado e o valor digitado não é registrado', async () => {
    const p = abrirPrevia();
    await p.esperar();
    await identificar(p, 'MATRICULA', '9999');
    assert.deepEqual(telaAtual(p), ['telaAcesso']);
    assert.match(textoDaPagina(p), /Não encontramos esse CPF ou matrícula\./);
    const cpf = '52998224725';
    await identificar(p, 'CPF', cpf);
    assert.deepEqual(telaAtual(p), ['telaAcesso']);
    assert.match(textoDaPagina(p), /Não encontramos esse CPF ou matrícula\./);
    semEscapes(p);
    const vistos = JSON.stringify(registro(p));
    assert.equal(vistos.includes(cpf), false, 'o CPF digitado não aparece no registro do adaptador');
    assert.equal(vistos.includes('9999'), false, 'nem a matrícula desconhecida');
    assert.equal(p.janela.TotemPrevia.naoSuportadas(), 0);
  });

  test('K7-B6 — a sessão de 60 s é simulada em memória: sem ação, volta à identificação; o heartbeat também é local', async () => {
    const p = abrirPrevia();
    await p.esperar();
    await identificar(p, 'MATRICULA', '1001');
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    await passarSegundos(p, 65);
    assert.deepEqual(telaAtual(p), ['telaAcesso']);
    assert.ok(registro(p).some((c) => c.metodo === 'POST' && c.caminho === '/heartbeat'), 'a presença do tablet é respondida localmente');
    semEscapes(p);
  });

  test('K7-B7 — contrato do adaptador: destino fora da base rejeita, rota desconhecida é 404 e fica contada, tudo sem rede', async () => {
    const p = abrirPrevia();
    await p.esperar();
    await assert.rejects(p.janela.fetch('https://api.exemplo.com/x', { method: 'GET' }));
    await assert.rejects(p.janela.fetch('/api/atendimento-token/tablet/estado', { method: 'GET' }));
    const r = await p.janela.fetch(`${API}/rota-que-nao-existe`, { method: 'GET' });
    assert.equal(r.status, 404);
    assert.ok(p.janela.TotemPrevia.naoSuportadas() >= 1);
    const sem = await p.janela.fetch(`${API}/atendimento/catalogo`, { method: 'GET', credentials: 'include' });
    assert.equal(sem.status, 401, 'sem atendimento aberto não há catálogo');
    semEscapes(p);
  });

  test('K7-B8 — a credencial do tablet nunca é lida nem enviada: nenhuma chamada leva cookie, cabeçalho de autorização ou corpo com dados pessoais', async () => {
    const p = abrirPrevia();
    await p.esperar();
    await identificar(p, 'MATRICULA', '1001');
    await adicionar(p, 'Capacete');
    await clicarTexto(p, 'Revisar e enviar pedido');
    await clicar(p, p.consulta('#telaRevisao [data-item="0"]')[0].querySelectorAll('button').find((b) => b.getAttribute('data-motivo') === 'PERDA_EXTRAVIO'));
    await clicarTexto(p, 'Enviar pedido');
    const texto = JSON.stringify(registro(p));
    assert.doesNotMatch(texto, /cookie|authorization|gepi_tablet|gepi_atendimento|senha|cpf/i);
    semEscapes(p);
  });
});

describe('K7 — a sentinela acusa o escape (prova por mutação)', () => {
  const comEscape = (relativo, codigo) => (relativo === ADAPTADOR
    ? codigo.replace(/window\.fetch\s*=/, 'var __real = window.fetch; window.fetch = function (d, o) { __real(d, o).catch(function () {}); return Promise.reject(new Error("x")); }; window.__apagado =')
    : codigo);

  test('K7-C1 — um adaptador que repassa ao fetch real é detectado pela sentinela', async () => {
    const p = abrirPrevia({ transformar: comEscape });
    await p.esperar();
    await identificar(p, 'MATRICULA', '1001').catch(() => {});
    assert.throws(() => semEscapes(p), /fetch do harness|destino fora/, 'a sentinela precisa falhar quando a operação vaza');
  });

  test('K7-C2 — sem o adaptador (a página chamando a API real) a sentinela também acusa', async () => {
    exigir(PREVIA);
    const html = lerArquivo(PREVIA).replace(/<script src="previa-adaptador\.js"><\/script>/, '<script>window.SAFEWORK_PORTAL_API_BASE_URL = "http://localhost:3000/api";</script>');
    assert.notEqual(html, lerArquivo(PREVIA), 'a troca do adaptador por uma base real foi aplicada');
    const p = abrirPagina(PREVIA, { html: injetarShim(html) });
    await p.esperar();
    assert.throws(() => semEscapes(p), /fetch do harness|destino fora/);
  });
});
