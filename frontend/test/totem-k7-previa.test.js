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
  // VISUAL-03A (20/10/2026): identidade verde aprovada por Ramires. Pinos ANTERIORES (histórico): index.html e41495afa9e0e7f5b1d0b104080180821c42a7c909b5f5d7667ca213cf7ee181;
  // totem.css 9c6b3665fe47ad88543e8f59053b082544816943d5753c41980625f4b379e3ac.
  'totem/index.html': '6ec5236ec6673c581332468b2cb2f7b64df8467f260030b9a47b5387a78bd286',
  // GREEN-2A/2C (20/10/2026): fotografias integradas. Pino ANTERIOR (histórico): 9ee5d2f8d66e154c067c0f7a35c5214a1341fcd42899f92ac3c16cdf5a60c33e.
  // FIX-TOTEM-NUMERO (31/10/2026): confirmação do pedido com o número inteiro do backend, autorizada por Ramires. Pino ANTERIOR (histórico): c6728858e0d185cb0331c78099d47f9688ea22d7fdcbca4600bd9ba1478b6afc.
  'totem/totem.js': 'caa89895eec5660db5cb9b4ca746c6590b7a15575f38a215d4a2b19c61807fc5',
  'totem/totem.css': '3caa1760e92f1c5feddcb211ab09c082f16db2dc4a0eb182f3f02e609d4ebe50',
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

// DEMO-FOTOS (21/10/2026): o catálogo da Ana (1001) é um recorte do GHE-017 FORNO FUSÃO com nomes limpos, em ordem alfabética.
const NOMES_DA_DEMO = ['Calça de Segurança', 'Capacete de Segurança', 'Luva de Segurança', 'Óculos de Proteção Incolor', 'Protetor Auricular Concha', 'Respirador PFF2', 'Sapato de Segurança', 'Vestimenta para Proteção do Tronco'];

describe('K7 — arquivos, ordem dos scripts e isolamento declarado', () => {
  test('K7-A1 — previa.html e previa-adaptador.js existem', () => {
    exigir(PREVIA);
    exigir(ADAPTADOR);
  });

  test('K7-A2 — scripts na ordem boot.js, previa-imagens-demo.js, previa-adaptador.js, totem.js; nada de configuração, protótipo ou API real', () => {
    exigir(PREVIA);
    const scripts = scriptsDoHtml(lerArquivo(PREVIA));
    // DEMO-FOTOS (21/10/2026): os dados estáticos das fotografias da demonstração vêm antes do adaptador, que os lê; nenhum outro script.
    assert.deepEqual(scripts.map((s) => s.src), ['boot.js', 'previa-imagens-demo.js', 'previa-adaptador.js', 'totem.js'], 'os dados e o adaptador vêm antes do totem.js; nenhum outro script');
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
    // IMG-PRÉVIA-01 (20/10/2026): única abertura nova, só para a URL de objeto da fotografia recebida pela ponte; nada de data:, http(s) ou curinga.
    assert.equal(diretivas['img-src'], 'blob:');
    assert.doesNotMatch(csp, /data:|\bhttps?:|\*/i);
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

  // VISUAL-03B (20/10/2026, opção A aprovada por Ramires): o ícone da marca da prévia acompanha o VERDE do Totem funcional. Antes (K7): a prévia trazia um bloco
  // <style> próprio que fixava .brand i no azul da Central (#007AFF claro / #0A84FF escuro) e o Totem oficial tinha --brand:#1a3a6b.
  test('K7-A4b — o ícone do cabeçalho "Retirada de EPI" acompanha o verde do Totem: a prévia não tem estilo próprio, usa só a folha compartilhada e o Totem oficial não recebe CSS da prévia', () => {
    exigir(PREVIA);
    const previa = lerArquivo(PREVIA);
    const limpa = semComentariosHtml(previa);
    // Nenhum estilo próprio da prévia (nem bloco, nem regra da marca, nem o azul antigo da Central).
    assert.equal([...limpa.matchAll(/<style\b/gi)].length, 0, 'a prévia não tem bloco de estilo próprio');
    assert.doesNotMatch(limpa, /\.brand\s+i\s*\{|#007AFF|#0A84FF/i, 'a prévia não força a cor da marca');
    // Só a folha compartilhada do Totem, exatamente a mesma do Totem real.
    assert.equal([...limpa.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)].length, 1, 'uma única folha de estilo');
    assert.match(limpa, /<link rel="stylesheet" href="totem\.css">/);
    // Metadados visuais alinhados ao Totem real.
    assert.match(limpa, /<meta name="theme-color" content="#1F7563" media="\(prefers-color-scheme: light\)">/);
    assert.match(limpa, /<meta name="theme-color" content="#101c18" media="\(prefers-color-scheme: dark\)">/);
    // O Totem oficial não recebe CSS exclusivo da prévia e aplica a identidade verde aprovada (marca igual nos dois temas, claro e escuro).
    assert.doesNotMatch(lerArquivo('totem/index.html'), /<style\b/i);
    const css = lerArquivo('totem/totem.css');
    assert.match(css, /--brand:#1F7563/);
    assert.match(css, /prefers-color-scheme:dark\)\{\s*:root\{[^}]*--brand:#26806B/);
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
    for (const rel of ['totem/previa.html', 'totem/previa-adaptador.js', 'totem/previa-imagens-demo.js', 'totem/index.html', 'totem/boot.js', 'totem/totem.js', 'totem/totem.css']) {
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
    assert.deepEqual(produtos(p), NOMES_DA_DEMO);
    await adicionar(p, 'Sapato de Segurança', '40');
    await adicionar(p, 'Protetor Auricular Concha');
    await clicarTexto(p, 'Revisar e enviar pedido');
    assert.deepEqual(telaAtual(p), ['telaRevisao']);
    assert.equal(p.consulta('#telaRevisao [data-item]').length, 2);
    for (let i = 0; i < 2; i += 1) {
      const linha = p.consulta(`#telaRevisao [data-item="${i}"]`)[0];
      await clicar(p, linha.querySelectorAll('button').find((b) => b.getAttribute('data-motivo') === 'DESGASTE_DANO'));
    }
    await clicarTexto(p, 'Enviar pedido');
    assert.deepEqual(telaAtual(p), ['telaConfirma']);
    assert.doesNotMatch(textoDaPagina(p), /Ana|Sapato|Protetor|PREVIA/, 'a confirmação é neutra');
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
    await adicionar(p, 'Capacete de Segurança');
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

// ───────────────────────── DEMO-FOTOS — a Demonstração da Ana (1001) com fotografias, sem rede e sem ponte ─────────────────────────
// O catálogo da Ana é um recorte do GHE-017 (FORNO FUSÃO) com 8 EPIs. As fotografias são as da Biblioteca de Imagens padrão já corrigidas (miniatura para a 1ª
// tela, exibição 640x640 para a 2ª), embutidas em `totem/previa-imagens-demo.js` como dados estáticos. O adaptador as serve em memória pelo MESMO caminho de imagem
// do Totem; nada sai da página e a Consulta Real (modo real, ponte com a Central) não muda.

const IMAGENS_DEMO = 'totem/previa-imagens-demo.js';
// id da Biblioteca -> nome limpo e os SHA-256/tamanhos registrados em imagens_padrao (sha256_miniatura/sha256_exibicao e bytes_*).
const FOTOS_DEMO = Object.freeze({
  4: { nome: 'Calça de Segurança', min: ['5789dc15fd69c6f1e55e1c6c86958db962864c3feced4b065dc2ca8f06ef1578', 8958], exib: ['d07dd5f65a09777bd909738fa4c4c86df336eb2e32e03ba5ecbf9278cfbca373', 23304] },
  6: { nome: 'Capacete de Segurança', min: ['64eee911e51bea2d47036f0a6f596074da18a391af5ab1b3816e4d20b277a432', 15438], exib: ['1c5f2b7ba130b4ada67c60e3a546d4aa670872b8a6b6e37fdeb459c7d5518ff3', 41036] },
  12: { nome: 'Luva de Segurança', min: ['22015fd8f0151e4ae5d406916bddf65a6a03853bbc39f86aab9d30d9054e7dac', 19468], exib: ['fdc985bd90d288948c826b250db88256f2ddc7a5f3ad75f807ef3b2127ca3bd1', 76550] },
  18: { nome: 'Protetor Auricular Concha', min: ['f03716a19b015f8871fe1823005291ce3a91276ea340f22f6a97d13bdc91b699', 19248], exib: ['5f5fa82285ac9165ed9a144c4dedc05b9b4b88698c13c01d36c062145e817b6c', 49028] },
  21: { nome: 'Respirador PFF2', min: ['504ccac7087e6da7f84e57bb1dd9d4e95244cfe2a7e984e19ab65c1ee4e3ea76', 17194], exib: ['43690e73b9faebef7f981c02a0aef9b631979b708a7d869cdfa2e652694550f4', 42258] },
  22: { nome: 'Sapato de Segurança', min: ['def0023206e3343ade5c65610e04873c31047f3ed85977406a219e5cbf9b701d', 12302], exib: ['864dd72a08daf7c7176e88967dd479db34b2d5642ecc012e5a663daacadf5a94', 41486] },
  23: { nome: 'Vestimenta para Proteção do Tronco', min: ['d613bd30cb292c70f2261df38c94e4d98d2e3dd5b3bccc6bf95c54b2d91bf19c', 13086], exib: ['802826e75ac5238e686d3b93481ce912d154663a1a0806f50ea38893e76b3179', 33928] },
  29: { nome: 'Óculos de Proteção Incolor', min: ['2282553789083f8752d776cccab5e8a94000c9c64e4b5793f7067641106505a4', 11650], exib: ['7b953db63847243a76e8b5822da306f1e3bb23a5a50a1ec9cf35847597b838f5', 31464] },
});
const API_IMG = `${API}/atendimento/imagens/padrao`;

describe('DEMO-FOTOS — dados estáticos das fotografias da demonstração', () => {
  const carregar = () => {
    const sandbox = { window: {} };
    require('node:vm').runInNewContext(lerArquivo(IMAGENS_DEMO), sandbox, { filename: IMAGENS_DEMO });
    return sandbox.window.TOTEM_PREVIA_IMAGENS;
  };
  const dimensoes = (b) => {
    const tipo = b.toString('latin1', 12, 16);
    if (tipo === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (tipo === 'VP8L') { const x = b.readUInt32LE(21); return [(x & 0x3fff) + 1, ((x >> 14) & 0x3fff) + 1]; }
    if (tipo === 'VP8X') return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
    return [0, 0];
  };

  test('DEMO-D1 — previa-imagens-demo.js existe, é só uma atribuição de dados (sem rede, execução dinâmica ou endereço) e está congelado', () => {
    exigir(IMAGENS_DEMO);
    const codigo = semComentarios(lerArquivo(IMAGENS_DEMO));
    assert.doesNotMatch(codigo, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|eval|Function|import|require|postMessage|cookie|document)\b/);
    assert.doesNotMatch(codigo, /https?:/i);
    assert.equal((codigo.match(/window\.TOTEM_PREVIA_IMAGENS\s*=/g) || []).length, 1, 'uma única atribuição');
    const dados = carregar();
    assert.ok(Object.isFrozen(dados));
    for (const v of Object.values(dados)) assert.ok(Object.isFrozen(v));
  });

  test('DEMO-D2 — exatamente as 8 imagens padrão do GHE-017 escolhidas, cada uma com miniatura e exibição que conferem com o registro (SHA-256 e bytes)', () => {
    exigir(IMAGENS_DEMO);
    const dados = carregar();
    assert.deepEqual(Object.keys(dados).sort((a, b) => Number(a) - Number(b)), Object.keys(FOTOS_DEMO));
    for (const [id, esperado] of Object.entries(FOTOS_DEMO)) {
      assert.deepEqual(Object.keys(dados[id]).sort(), ['exibicao', 'miniatura'], id);
      for (const [variante, [hash, bytes]] of [['miniatura', esperado.min], ['exibicao', esperado.exib]]) {
        assert.match(dados[id][variante], /^[A-Za-z0-9+/]+={0,2}$/, `${id}/${variante} é base64`);
        const b = Buffer.from(dados[id][variante], 'base64');
        assert.equal(b.length, bytes, `${id}/${variante}: bytes`);
        assert.equal(crypto.createHash('sha256').update(b).digest('hex'), hash, `${id}/${variante}: SHA-256 do registro`);
        assert.equal(b.toString('latin1', 0, 4) + b.toString('latin1', 8, 12), 'RIFFWEBP', `${id}/${variante}: WebP`);
      }
      assert.deepEqual(dimensoes(Buffer.from(dados[id].exibicao, 'base64')), [640, 640], `${id}: a exibição é 640x640`);
      const [mw, mh] = dimensoes(Buffer.from(dados[id].miniatura, 'base64'));
      assert.ok(mw === mh && mw >= 128 && mw < 640, `${id}: a miniatura é quadrada e menor que a exibição (${mw}x${mh})`);
    }
  });
});

describe('DEMO-FOTOS — a Demonstração da Ana (1001) mostra os 8 EPIs com fotografias', () => {
  const STUB = '<script>(function (g) { g.__blobs = []; g.Blob = function Blob2(partes, opcoes) { var n = 0; for (var i = 0; i < partes.length; i += 1) n += partes[i].length; this.size = n; this.type = (opcoes && opcoes.type) || ""; g.__blobs.push(n); }; var Base = g.URL; function U(a, b) { return b === undefined ? new Base(a) : new Base(a, b); } U.prototype = Base.prototype; g.__criadas = []; g.__revogadas = []; U.createObjectURL = function () { var u = "blob:demo/" + (g.__criadas.length + 1); g.__criadas.push(u); return u; }; U.revokeObjectURL = function (u) { g.__revogadas.push(String(u)); }; g.URL = U; })(globalThis)</script>';
  const abrirDemo = () => {
    exigir(PREVIA);
    const html = injetarShim(lerArquivo(PREVIA)).replace('<script src="previa-adaptador.js"></script>', `${STUB}<script src="previa-adaptador.js"></script>`);
    assert.match(html, /blob:demo/, 'o STUB foi injetado');
    return abrirPagina(PREVIA, { html });
  };
  const passar = async (p, ms, passo = 300) => { let resto = ms; while (resto > 0) { const d = Math.min(passo, resto); p.janela.__relogio.avancar(d); await p.esperar(); resto -= d; } };
  const fotos = (p, sel = '#grade .prod-img img') => p.consulta(sel);
  const bytesMiniatura = Object.values(FOTOS_DEMO).map((f) => f.min[1]).sort((a, b) => a - b);
  async function ana() {
    const p = abrirDemo();
    await p.esperar();
    await identificar(p, 'MATRICULA', '1001');
    return p;
  }

  test('DEMO-D3 — 1ª tela: os 8 EPIs do GHE-017 aparecem com miniaturas (URL de objeto), uma por produto, e nada escapa da página', async () => {
    const p = await ana();
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    assert.deepEqual(produtos(p), NOMES_DA_DEMO);
    await passar(p, 4000);
    const imgs = fotos(p);
    assert.equal(imgs.length, 8, 'uma fotografia por produto');
    for (const f of imgs) assert.match(f.getAttribute('src'), /^blob:/);
    assert.deepEqual(imgs.map((f) => f.getAttribute('alt')).sort(), [...NOMES_DA_DEMO].sort());
    assert.deepEqual([...p.janela.__blobs].sort((a, b) => a - b), bytesMiniatura, 'a 1ª tela usa as miniaturas (tamanhos exatos do registro)');
    assert.equal(p.consulta('#grade .prod-img .vazio').length, 0, 'nenhum placeholder sobra');
    assert.deepEqual(registro(p).filter((c) => c.caminho.startsWith('/atendimento/imagens')).map((c) => c.caminho), Array(8).fill('/atendimento/imagens/:origem/:id/:variante'));
    semEscapes(p);
  });

  test('DEMO-D4 — 2ª tela: ao abrir um EPI, a fotografia AMPLIADA (exibição 640x640) ocupa o #detImg, com os tamanhos do produto', async () => {
    const p = await ana();
    await passar(p, 4000);
    const antes = p.janela.__blobs.length;
    await clicar(p, p.consulta('#grade .prod').find((c) => c.querySelector('.prod-nome').textContent.trim() === 'Sapato de Segurança'));
    await passar(p, 1500);
    assert.deepEqual(telaAtual(p), ['telaTamanhos']);
    assert.equal(fotos(p, '#detImg img').length, 1);
    assert.match(fotos(p, '#detImg img')[0].getAttribute('src'), /^blob:/);
    assert.equal(fotos(p, '#detImg img')[0].getAttribute('alt'), 'Sapato de Segurança');
    assert.deepEqual([...p.janela.__blobs.slice(antes)], [FOTOS_DEMO[22].exib[1]], 'a ampliada é a exibição do Sapato (41486 bytes)');
    assert.equal(p.consulta('#tams .tam').length, 14, 'tamanhos 33 a 46');
    semEscapes(p);
  });

  test('DEMO-D5 — cada um dos 8 produtos abre com a SUA fotografia ampliada (tamanho exato da exibição registrada)', async () => {
    const p = await ana();
    await passar(p, 4000);
    for (const f of Object.values(FOTOS_DEMO)) {
      const antes = p.janela.__blobs.length;
      await clicar(p, p.consulta('#grade .prod').find((c) => c.querySelector('.prod-nome').textContent.trim() === f.nome));
      await passar(p, 1500);
      assert.deepEqual([...p.janela.__blobs.slice(antes)], [f.exib[1]], f.nome);
      assert.equal(fotos(p, '#detImg img').length, 1, f.nome);
      await clicarTexto(p, 'Voltar');
      await p.esperar();
    }
    semEscapes(p);
  });

  test('DEMO-D6 — o adaptador só serve as 8 fotografias, em padrao, com ?v=1 e as variantes miniatura/exibição; o resto é 404 e nada sai', async () => {
    const p = abrirDemo();
    await p.esperar();
    const buscar = (rota, o = {}) => p.janela.fetch(`${API_IMG}${rota}`, { method: 'GET', ...o });
    const ok = await buscar('/22/exibicao?v=1');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('Content-Type'), 'image/webp');
    assert.equal((await ok.blob()).size, FOTOS_DEMO[22].exib[1]);
    for (const [rota, alvo] of [['/999/miniatura?v=1', 'id desconhecido'], ['/22/miniatura', 'sem versão'], ['/22/outra?v=1', 'variante inválida'], ['/22/miniatura?v=0', 'versão inválida']]) {
      const r = await buscar(rota);
      assert.equal(r.status === 404 || r.status === 400, true, alvo);
    }
    const empresa = await p.janela.fetch(`${API}/atendimento/imagens/empresa/22/miniatura?v=1`, { method: 'GET' });
    assert.equal(empresa.status, 404, 'a origem empresa não existe na demonstração');
    semEscapes(p);
  });

  test('DEMO-D7 — matrícula 1002 (sem GHE) não pede fotografia; 1003 (pedidos em aberto) mostra as mesmas 8 fotografias depois do aviso', async () => {
    const p = abrirDemo();
    await p.esperar();
    await identificar(p, 'MATRICULA', '1002');
    await passar(p, 2000);
    assert.equal(registro(p).filter((c) => c.caminho.startsWith('/atendimento/imagens')).length, 0);
    const q = abrirDemo();
    await q.esperar();
    await identificar(q, 'MATRICULA', '1003');
    await clicarTexto(q, 'OK — Solicitar novos EPIs');
    await passar(q, 4000);
    assert.equal(fotos(q).length, 8);
    semEscapes(p);
    semEscapes(q);
  });
});
