'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { abrirPagina, RAIZ, semComentarios } = require('./helpers/dom-pagina');
const { injetarShim } = require('./helpers/totem-i');

/**
 * K7 — Consulta real da prévia do Totem (RED), lado do iframe: no modo `?modo=real&pai=<origem da Central>` o adaptador NÃO fala com a API.
 * A identificação sai por `postMessage` para a janela pai, com a origem do pai como DESTINO (nunca '*'); a resposta só vale se vier da
 * janela pai, da origem esperada, com o formato estrito e o id da consulta pendente. Catálogo, carrinho, revisão e pedido ficam em memória,
 * simulados. Valores fictícios: nenhum CPF ou matrícula real.
 */

const PREVIA = 'totem/previa.html';
const ADAPTADOR = 'totem/previa-adaptador.js';
const API = 'https://previa.invalid/api/atendimento-token/tablet';
const CANAL = 'safework-previa-totem';
const PAI = 'http://central.teste:5800';
const BUSCA_REAL = `?modo=real&pai=${encodeURIComponent(PAI)}`;
const CPF_FICTICIO = '12345678901';
const lerArquivo = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const exigir = (rel) => assert.ok(fs.existsSync(path.join(RAIZ, rel)), `${rel} não existe`);

const STUB_DO_PAI = '<script>(function () { var enviadas = []; window.__paraPai = enviadas; window.parent = { postMessage: function (m, alvo) { enviadas.push({ m: JSON.parse(JSON.stringify(m)), alvo: alvo }); } }; })();</script>';

const CATALOGO = Object.freeze({
  estado: 'OK',
  total: 2,
  materiais: [
    { id: 31, nome: 'Luva Teste', unidade: 'PAR', categoria: 'EPI', grupoProtecao: null, tipo: { id: 5, nome: 'Luva' }, exigeTamanho: true, tamanhos: ['M', 'G'], imagem: { disponivel: false } },
    { id: 32, nome: 'Capacete Teste', unidade: 'UN', categoria: 'EPI', grupoProtecao: null, tipo: { id: 6, nome: 'Capacete' }, exigeTamanho: false, tamanhos: [], imagem: { disponivel: false } },
  ],
});

function abrir({ search = BUSCA_REAL, transformar = null } = {}) {
  exigir(PREVIA);
  const html = injetarShim(lerArquivo(PREVIA)).replace('<script src="previa-adaptador.js"></script>', `${STUB_DO_PAI}<script src="previa-adaptador.js"></script>`);
  return abrirPagina(PREVIA, { html, search, transformar });
}

const telaAtual = (p) => p.consulta('.tela').filter(p.visivelNo).map((e) => e.id);
const clicar = async (p, el) => { assert.ok(el, 'elemento a clicar não encontrado'); await el.disparar('click'); await p.esperar(); };
const botao = (p, texto) => p.consulta('button').filter(p.visivelNo).find((b) => b.textContent.includes(texto));
const clicarTexto = async (p, texto) => { const b = botao(p, texto); assert.ok(b, `botão "${texto}" não encontrado`); await clicar(p, b); };
const digitar = async (p, texto) => { for (const d of texto) await clicar(p, p.consulta('#teclado .tecla').find((b) => b.textContent.trim() === d)); };
async function identificar(p, tipo, valor) {
  await clicar(p, p.el(tipo === 'CPF' ? 'tipoCpf' : 'tipoMatricula'));
  await digitar(p, valor);
  await clicarTexto(p, 'Continuar');
  await p.esperar();
}
const textoDaPagina = (p) => p.consulta('.tela').filter(p.visivelNo).map((e) => e.textContent).join(' ').replace(/\s+/g, ' ');
const enviadas = (p) => JSON.parse(JSON.stringify(p.janela.__paraPai));
const resultado = (id, extra = {}) => ({ canal: CANAL, versao: 1, tipo: 'RESULTADO', id, ...extra });
const ok = (id) => resultado(id, { resultado: 'OK', primeiroNome: 'Dora', catalogo: JSON.parse(JSON.stringify(CATALOGO)) });
const doPai = (p, data, extra = {}) => p.eventoDaJanela('message', { data, source: p.janela.parent, origin: PAI, ...extra });

function semEscapes(p) {
  assert.deepEqual(p.chamadas.map((c) => c.chave), [], 'a rede real nunca é chamada');
  assert.deepEqual(p.externas, []);
  assert.deepEqual(p.storage, [], 'nenhum armazenamento');
  assert.deepEqual(p.cookiesEscritos, []);
  assert.deepEqual(p.navegacoes, []);
  assert.deepEqual(p.historico, []);
  assert.deepEqual(p.consoleChamadas, []);
}
const vazou = (p, valor) => JSON.stringify({ s: p.storage, c: p.cookiesEscritos, h: p.historico, n: p.navegacoes, k: p.consoleChamadas, r: p.janela.TotemPrevia.chamadas(), u: p.janela.location.href ?? '' }).includes(valor);

describe('K7 — consulta real: o adaptador identifica pela janela pai', () => {
  test('K7-P1 — a identificação por matrícula sai como UMA mensagem estrita, com o destino exato da origem do pai; nada vai à rede', async () => {
    const p = abrir();
    await p.esperar();
    await identificar(p, 'MATRICULA', '2001');
    const m = enviadas(p);
    assert.equal(m.length, 1, 'uma única mensagem');
    assert.equal(m[0].alvo, PAI, 'destino exato: a origem do pai, nunca *');
    assert.deepEqual(Object.keys(m[0].m).sort(), ['canal', 'id', 'tipo', 'tipoId', 'valor', 'versao']);
    assert.equal(m[0].m.canal, CANAL);
    assert.equal(m[0].m.versao, 1);
    assert.equal(m[0].m.tipo, 'IDENTIFICAR');
    assert.match(m[0].m.id, /^[A-Za-z0-9-]{8,64}$/);
    assert.deepEqual([m[0].m.tipoId, m[0].m.valor], ['MATRICULA', '2001']);
    semEscapes(p);
  });

  test('K7-P2 — o resultado do pai libera o catálogo REAL recebido: nome, produtos e tamanhos vêm da mensagem, sem fixture', async () => {
    const p = abrir();
    await p.esperar();
    await identificar(p, 'MATRICULA', '2001');
    await doPai(p, ok(enviadas(p)[0].m.id));
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    assert.match(textoDaPagina(p), /Olá, Dora/);
    assert.deepEqual(p.consulta('#grade .prod-nome').map((e) => e.textContent.trim()), ['Luva Teste', 'Capacete Teste']);
    await clicar(p, p.consulta('#grade .prod').find((e) => e.querySelector('.prod-nome')?.textContent.trim() === 'Luva Teste'));
    assert.deepEqual(p.consulta('#tams .tam').map((e) => (e.querySelector('b')?.textContent ?? e.textContent).trim()), ['M', 'G']);
    semEscapes(p);
  });

  test('K7-P3 — carrinho, revisão, motivos e envio continuam SIMULADOS: nenhuma outra mensagem sai e o pedido nunca chega ao pai', async () => {
    const p = abrir();
    await p.esperar();
    await identificar(p, 'MATRICULA', '2001');
    await doPai(p, ok(enviadas(p)[0].m.id));
    await clicar(p, p.consulta('#grade .prod').find((e) => e.querySelector('.prod-nome')?.textContent.trim() === 'Luva Teste'));
    await clicar(p, p.consulta('#tams .tam').find((e) => (e.querySelector('b')?.textContent ?? e.textContent).trim() === 'M'));
    await clicar(p, p.el('btnSolicitar'));
    await clicar(p, p.consulta('#grade .prod').find((e) => e.querySelector('.prod-nome')?.textContent.trim() === 'Capacete Teste'));
    await clicar(p, p.el('btnSolicitar'));
    await clicarTexto(p, 'Revisar e enviar pedido');
    for (let i = 0; i < 2; i += 1) await clicar(p, p.consulta(`#telaRevisao [data-item="${i}"]`)[0].querySelectorAll('button').find((b) => b.getAttribute('data-motivo') === 'DESGASTE_DANO'));
    await clicarTexto(p, 'Enviar pedido');
    assert.deepEqual(telaAtual(p), ['telaConfirma']);
    assert.equal(enviadas(p).length, 1, 'só a identificação saiu; o pedido ficou em memória');
    assert.ok(p.janela.TotemPrevia.chamadas().some((c) => c.metodo === 'POST' && c.caminho === '/atendimento/pedido'));
    assert.doesNotMatch(textoDaPagina(p), /Dora|Luva|Capacete/, 'a confirmação continua neutra');
    semEscapes(p);
  });

  test('K7-P4 — CPF: sai como tipoId CPF só na mensagem; não identificado volta à tela de identificação e o CPF não fica em lugar nenhum', async () => {
    const p = abrir();
    await p.esperar();
    await identificar(p, 'CPF', CPF_FICTICIO);
    const m = enviadas(p);
    assert.deepEqual([m.length, m[0].m.tipoId, m[0].m.valor], [1, 'CPF', CPF_FICTICIO]);
    await doPai(p, resultado(m[0].m.id, { resultado: 'NAO_IDENTIFICADO' }));
    assert.deepEqual(telaAtual(p), ['telaAcesso']);
    assert.match(textoDaPagina(p), /Não encontramos esse CPF ou matrícula\./);
    assert.equal(vazou(p, CPF_FICTICIO), false, 'sem CPF em storage, cookie, histórico, console, registro do adaptador ou URL');
    semEscapes(p);
  });

  test('K7-P5 — limite e indisponibilidade do pai viram as mensagens do Totem, sem expor nada', async () => {
    const p = abrir();
    await p.esperar();
    await identificar(p, 'MATRICULA', '2001');
    await doPai(p, resultado(enviadas(p)[0].m.id, { resultado: 'LIMITE' }));
    assert.match(textoDaPagina(p), /Muitas tentativas\./);
    const q = abrir();
    await q.esperar();
    await identificar(q, 'MATRICULA', '2001');
    await doPai(q, resultado(enviadas(q)[0].m.id, { resultado: 'INDISPONIVEL' }));
    assert.match(textoDaPagina(q), /Não foi possível se comunicar com o sistema\./);
  });
});

describe('K7 — consulta real: só mensagem verdadeira do pai é aceita', () => {
  const invalidas = (id) => [
    ['origem diferente', ok(id), { origin: 'http://atacante.exemplo' }],
    ['origem nula', ok(id), { origin: 'null' }],
    ['origem ausente', ok(id), { origin: undefined }],
    ['fonte que não é o pai', ok(id), { source: {} }],
    ['sem fonte', ok(id), { source: undefined }],
    ['campo extra (valor devolvido)', { ...ok(id), valor: '2001' }, {}],
    ['campo extra (cpf)', { ...ok(id), cpf: CPF_FICTICIO }, {}],
    ['canal errado', { ...ok(id), canal: 'outro' }, {}],
    ['versão errada', { ...ok(id), versao: 2 }, {}],
    ['tipo errado', { ...ok(id), tipo: 'IDENTIFICAR' }, {}],
    ['id de outra consulta', ok('OUTRO-ID-QUALQUER-1'), {}],
    ['resultado desconhecido', resultado(id, { resultado: 'QUALQUER' }), {}],
    ['OK sem nome', resultado(id, { resultado: 'OK', catalogo: JSON.parse(JSON.stringify(CATALOGO)) }), {}],
    ['OK sem catálogo', resultado(id, { resultado: 'OK', primeiroNome: 'Dora' }), {}],
    ['OK com materiais demais', resultado(id, { resultado: 'OK', primeiroNome: 'Dora', catalogo: { estado: 'OK', total: 201, materiais: Array.from({ length: 201 }, (_, i) => ({ ...CATALOGO.materiais[1], id: i + 1 })) } }), {}],
    ['dados não objeto', 'texto', {}],
    ['dados nulos', null, {}],
    ['dados lista', [1, 2], {}],
  ];

  test('K7-Q1 — mensagem de origem, fonte, formato, canal, versão, tipo, id ou conteúdo inválidos é ignorada, e a consulta segue pendente', async () => {
    const p = abrir();
    await p.esperar();
    await identificar(p, 'MATRICULA', '2001');
    const id = enviadas(p)[0].m.id;
    for (const [rotulo, data, extra] of invalidas(id)) {
      await doPai(p, data, extra);
      assert.deepEqual(telaAtual(p), ['telaAcesso'], `${rotulo}: não pode liberar nada`);
      assert.equal(p.consulta('#grade .prod').length, 0, rotulo);
    }
    await doPai(p, ok(id));
    assert.deepEqual(telaAtual(p), ['telaProdutos'], 'a mensagem verdadeira ainda é aceita depois das falsas');
    semEscapes(p);
  });

  test('K7-Q2 — a mesma resposta não vale duas vezes e uma resposta tardia (depois do prazo) é ignorada', async () => {
    const p = abrir();
    await p.esperar();
    await identificar(p, 'MATRICULA', '2001');
    const id = enviadas(p)[0].m.id;
    await doPai(p, ok(id));
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    await clicarTexto(p, 'Sair');
    assert.deepEqual(telaAtual(p), ['telaAcesso']);
    await doPai(p, ok(id));
    assert.deepEqual(telaAtual(p), ['telaAcesso'], 'repetição ignorada');

    const q = abrir();
    await q.esperar();
    await identificar(q, 'MATRICULA', '2001');
    const idQ = enviadas(q)[0].m.id;
    for (let i = 0; i < 20; i += 1) { q.janela.__relogio.avancar(1000); await q.esperar(); }
    assert.match(textoDaPagina(q), /Não foi possível se comunicar com o sistema\./, 'o prazo esgotado vira indisponibilidade');
    await doPai(q, ok(idQ));
    assert.deepEqual(telaAtual(q), ['telaAcesso'], 'resposta tardia ignorada');
  });

  test('K7-Q3 — uma segunda identificação enquanto há uma pendente não sai (uma consulta por vez)', async () => {
    const p = abrir();
    await p.esperar();
    const corpo = JSON.stringify({ tipo: 'MATRICULA', valor: '2001' });
    const a = p.janela.fetch(`${API}/atendimento`, { method: 'POST', body: corpo });
    const b = await p.janela.fetch(`${API}/atendimento`, { method: 'POST', body: corpo });
    assert.equal(b.status, 429);
    assert.equal(enviadas(p).length, 1);
    await doPai(p, resultado(enviadas(p)[0].m.id, { resultado: 'NAO_IDENTIFICADO' }));
    assert.equal((await a).status, 404);
  });

  test('K7-Q4 — a sessão de 60 s vale no modo real: sem ação, o catálogo recebido é descartado', async () => {
    const p = abrir();
    await p.esperar();
    await identificar(p, 'MATRICULA', '2001');
    await doPai(p, ok(enviadas(p)[0].m.id));
    for (let i = 0; i < 65; i += 1) { p.janela.__relogio.avancar(1000); await p.esperar(); }
    assert.deepEqual(telaAtual(p), ['telaAcesso']);
    const r = await p.janela.fetch(`${API}/atendimento/catalogo`, { method: 'GET' });
    assert.equal(r.status, 401, 'nada do colaborador fica depois da sessão');
  });
});

describe('K7 — consulta real: o modo é travado na carga e a demonstração não muda', () => {
  test('K7-M1 — sem `pai` válido o modo real não funciona: não envia nada e responde indisponível', async () => {
    for (const busca of ['?modo=real', '?modo=real&pai=', '?modo=real&pai=javascript%3Aalert(1)', '?modo=real&pai=http%3A%2F%2Fa%20b', '?modo=real&pai=http%3A%2F%2Fcentral.teste%2Fcaminho', `?modo=real&pai=${encodeURIComponent('*')}`]) {
      const p = abrir({ search: busca });
      await p.esperar();
      await identificar(p, 'MATRICULA', '2001');
      assert.equal(enviadas(p).length, 0, busca);
      assert.deepEqual(telaAtual(p), ['telaAcesso'], busca);
      assert.equal(p.consulta('#grade .prod').length, 0, busca);
    }
  });

  test('K7-M2 — na demonstração (sem modo ou modo=demo) não há ouvinte de mensagem, nada é enviado ao pai e 1001 continua funcionando', async () => {
    for (const busca of ['', '?modo=demo', '?modo=outro', `?pai=${encodeURIComponent(PAI)}`]) {
      const p = abrir({ search: busca });
      await p.esperar();
      assert.equal(p.ouvintesDaJanela('message'), 0, `sem ouvinte: "${busca}"`);
      await identificar(p, 'MATRICULA', '1001');
      assert.deepEqual(telaAtual(p), ['telaProdutos'], busca);
      assert.match(textoDaPagina(p), /Olá, Ana/);
      assert.equal(enviadas(p).length, 0, busca);
      semEscapes(p);
    }
  });

  test('K7-M3 — no modo real as matrículas fictícias da demonstração NÃO identificam (nada de fixture misturado)', async () => {
    const p = abrir();
    await p.esperar();
    await identificar(p, 'MATRICULA', '1001');
    const m = enviadas(p);
    assert.equal(m.length, 1, 'a 1001 foi perguntada ao pai, não resolvida localmente');
    assert.deepEqual(telaAtual(p), ['telaAcesso']);
  });

  test('K7-M4 — o modo é lido uma vez na carga: mudar a URL depois não altera o provedor', async () => {
    const p = abrir({ search: '?modo=demo' });
    await p.esperar();
    p.janela.location.search = BUSCA_REAL;
    await identificar(p, 'MATRICULA', '1001');
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    assert.equal(enviadas(p).length, 0);
  });
});

describe('K7 — consulta real: estático', () => {
  test('K7-E1 — o adaptador tem UM postMessage, para o pai e com destino explícito; UM ouvinte de message; nunca "*", nunca fetch real', () => {
    exigir(ADAPTADOR);
    const codigo = semComentarios(lerArquivo(ADAPTADOR));
    assert.equal((codigo.match(/\.postMessage\s*\(/g) || []).length, 1);
    assert.match(codigo, /window\.parent\.postMessage\s*\(/);
    assert.equal((codigo.match(/addEventListener\s*\(\s*'message'/g) || []).length, 1);
    assert.doesNotMatch(codigo, /postMessage\s*\([^)]*['"]\*['"]/, 'o destino nunca é *');
    assert.doesNotMatch(codigo, /(?<![.\w])fetch\s*\(|\.fetch\s*\(|=\s*(window\.|self\.|globalThis\.)?fetch\b/);
    assert.doesNotMatch(codigo, /\b(localStorage|sessionStorage|indexedDB|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|Worker)\b|document\.cookie|\beval\s*\(|new\s+Function/);
  });

  test('K7-E2 — os arquivos do Totem real não mudaram (hashes)', () => {
    const crypto = require('node:crypto');
    const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(RAIZ, rel))).digest('hex');
    // index.html: Etapa I mais o favicon e o título do refinamento visual de 18/10/2026 (pino atualizado na consolidação de 19/10/2026).
    // VISUAL-03A (20/10/2026): identidade verde aprovada por Ramires. Pinos ANTERIORES (histórico): index.html e41495afa9e0e7f5b1d0b104080180821c42a7c909b5f5d7667ca213cf7ee181;
    // totem.css 9c6b3665fe47ad88543e8f59053b082544816943d5753c41980625f4b379e3ac.
    assert.equal(sha('totem/index.html'), '6ec5236ec6673c581332468b2cb2f7b64df8467f260030b9a47b5387a78bd286');
    // GREEN-2A/2C (20/10/2026): fotografias integradas. Pino ANTERIOR (histórico): 9ee5d2f8d66e154c067c0f7a35c5214a1341fcd42899f92ac3c16cdf5a60c33e.
    assert.equal(sha('totem/totem.js'), 'c6728858e0d185cb0331c78099d47f9688ea22d7fdcbca4600bd9ba1478b6afc');
    assert.equal(sha('totem/totem.css'), '3caa1760e92f1c5feddcb211ab09c082f16db2dc4a0eb182f3f02e609d4ebe50');
    assert.equal(sha('totem/boot.js'), '583454fe94c2ed73776fd77b4560eb70c59dd708ad582b2a61ff4878104d6899');
  });
});

// ───────────────────────── IMG-PRÉVIA-01 — fotografias no iframe da Consulta Real (adaptador) ─────────────────────────
// O iframe não tem rede nem credencial: o Totem (inalterado) pede a foto pelo seu fetch; o adaptador converte o pedido numa mensagem ao pai e
// devolve ao Totem uma resposta compatível. Erros administrativos (sem acesso, não encontrada) NUNCA viram 401/403 para o Totem, que os trataria
// como tablet/rede não autorizados.

describe('IMG-PRÉVIA — fotografias no iframe da Consulta Real (adaptador)', () => {
  const IMG = (origem, id, versao) => ({ disponivel: true, origem, id, versao });
  const MAT = (id, nome, imagem) => ({ id, nome, unidade: 'UN', categoria: 'EPI', grupoProtecao: null, tipo: null, exigeTamanho: false, tamanhos: [], imagem });
  const CAT = { estado: 'OK', total: 3, materiais: [MAT(31, 'Luva Teste', IMG('PADRAO', '9007199254740993', 3)), MAT(32, 'Capacete Teste', { disponivel: false }), MAT(33, 'Bota Teste', IMG('EMPRESA', '7', 1))] };
  const STUB_IMAGENS = '<script>(function (g) { if (typeof g.Blob === "undefined") { g.Blob = function Blob2(partes, opcoes) { this.size = 8; this.type = (opcoes && opcoes.type) || ""; }; } var Base = g.URL; function U(a, b) { return b === undefined ? new Base(a) : new Base(a, b); } U.prototype = Base.prototype; g.__criadas = []; g.__revogadas = []; U.createObjectURL = function () { var u = "blob:previa/" + (g.__criadas.length + 1); g.__criadas.push(u); return u; }; U.revokeObjectURL = function (u) { g.__revogadas.push(String(u)); }; g.URL = U; })(globalThis)</script>';

  function abrirImg(search = BUSCA_REAL) {
    exigir(PREVIA);
    const html = injetarShim(lerArquivo(PREVIA)).replace('<script src="previa-adaptador.js"></script>', `${STUB_DO_PAI}${STUB_IMAGENS}<script src="previa-adaptador.js"></script>`);
    return abrirPagina(PREVIA, { html, search });
  }
  const passar = async (p, ms, passo = 300) => { let resto = ms; while (resto > 0) { const d = Math.min(passo, resto); p.janela.__relogio.avancar(d); await p.esperar(); resto -= d; } };
  const mensagens = (p, tipo) => enviadas(p).map((e) => e.m).filter((m) => m.tipo === tipo);
  const pedidos = (p) => mensagens(p, 'IMAGEM');
  async function abrirNoCatalogo(search) {
    const p = abrirImg(search);
    await p.esperar();
    await identificar(p, 'MATRICULA', '2001');
    await doPai(p, resultado(enviadas(p)[0].m.id, { resultado: 'OK', primeiroNome: 'Dora', catalogo: JSON.parse(JSON.stringify(CAT)) }));
    return p;
  }
  const respostaImg = (p, id, res, extra = {}) => doPai(p, { canal: CANAL, versao: 1, tipo: 'IMAGEM_RESULTADO', id, resultado: res, ...extra });
  const blobOk = (p) => new p.janela.Blob(['x'], { type: 'image/webp' });
  const imgs = (p, sel = '#grade .prod-img img') => p.consulta(sel);
  const CHAVES_PEDIDO = ['canal', 'id', 'imagemId', 'origem', 'tipo', 'variante', 'versao', 'versaoImagem'];

  test('IMG-I1 — o Totem pede a miniatura só dos materiais com fotografia: uma mensagem estrita por foto, destino exato do pai, nenhuma rede', async () => {
    const p = await abrirNoCatalogo();
    await passar(p, 1500);
    const m = pedidos(p);
    assert.equal(m.length, 2, 'Capacete Teste (sem foto) não gera pedido');
    for (const x of m) {
      assert.deepEqual(Object.keys(x).sort(), [...CHAVES_PEDIDO].sort());
      assert.deepEqual([x.canal, x.versao, x.tipo, x.variante], [CANAL, 1, 'IMAGEM', 'miniatura']);
      assert.match(x.id, /^[A-Za-z0-9-]{8,64}$/);
    }
    assert.deepEqual(m.map((x) => [x.origem, x.imagemId, x.versaoImagem]).sort(), [['EMPRESA', '7', 1], ['PADRAO', '9007199254740993', 3]]);
    assert.equal(new Set(m.map((x) => x.id)).size, 2, 'um identificador por pedido');
    assert.ok(enviadas(p).filter((e) => e.m.tipo === 'IMAGEM').every((e) => e.alvo === PAI), 'destino exato: a origem do pai, nunca *');
    semEscapes(p);
  });

  test('IMG-I2 — a resposta OK do pai vira <img> (URL de objeto) no espaço .prod-img; o cartão sem foto mantém o placeholder', async () => {
    const p = await abrirNoCatalogo();
    await passar(p, 1500);
    for (const x of pedidos(p)) await respostaImg(p, x.id, 'OK', { blob: blobOk(p) });
    await p.esperar();
    const fotos = imgs(p);
    assert.equal(fotos.length, 2);
    for (const f of fotos) assert.match(f.getAttribute('src'), /^blob:/);
    assert.deepEqual(fotos.map((f) => f.getAttribute('alt')).sort(), ['Bota Teste', 'Luva Teste']);
    const sem = p.consulta('#grade .prod').find((c) => c.querySelector('.prod-nome').textContent.trim() === 'Capacete Teste');
    assert.ok(sem.querySelector('.prod-img .vazio'));
    assert.equal(sem.querySelectorAll('img').length, 0);
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    semEscapes(p);
  });

  test('IMG-I3 — no detalhe o Totem pede a variante de EXIBIÇÃO do material escolhido e a fotografia ampliada ocupa o #detImg', async () => {
    const p = await abrirNoCatalogo();
    await passar(p, 1500);
    for (const x of pedidos(p)) await respostaImg(p, x.id, 'OK', { blob: blobOk(p) });
    await clicar(p, p.consulta('#grade .prod').find((c) => c.querySelector('.prod-nome').textContent.trim() === 'Luva Teste'));
    await passar(p, 1000);
    const exib = pedidos(p).filter((x) => x.variante === 'exibicao');
    assert.equal(exib.length, 1);
    assert.deepEqual([exib[0].origem, exib[0].imagemId, exib[0].versaoImagem], ['PADRAO', '9007199254740993', 3]);
    await respostaImg(p, exib[0].id, 'OK', { blob: blobOk(p) });
    await p.esperar();
    assert.equal(imgs(p, '#detImg img').length, 1);
    assert.match(imgs(p, '#detImg img')[0].getAttribute('src'), /^blob:/);
    semEscapes(p);
  });

  test('IMG-I4 — erro administrativo (sem acesso à Biblioteca ou não encontrada) mantém o placeholder e NUNCA leva à tela de tablet ou de rede não autorizados', async () => {
    for (const res of ['SEM_ACESSO', 'NAO_ENCONTRADA']) {
      const p = await abrirNoCatalogo();
      await passar(p, 1500);
      for (const x of pedidos(p)) await respostaImg(p, x.id, res);
      await passar(p, 6000);
      assert.deepEqual(telaAtual(p), ['telaProdutos'], res);
      assert.equal(imgs(p).length, 0, res);
      assert.equal(p.consulta('#grade .prod-img .vazio').length, 3, res);
      assert.equal(pedidos(p).length, 2, `${res}: falha definitiva não é repetida`);
      for (const tela of ['telaRede', 'telaNaoAutorizado', 'telaAcesso']) assert.equal(p.visivelNo(p.el(tela)), false, `${res}: ${tela}`);
    }
  });

  test('IMG-I5 — indisponibilidade transitória repete no máximo 3 vezes por foto e mantém o placeholder, sem mudar a tela', async () => {
    const p = await abrirNoCatalogo();
    const respondidos = new Set();
    for (let i = 0; i < 8; i += 1) {
      await passar(p, 3000);
      for (const x of pedidos(p)) if (!respondidos.has(x.id)) { respondidos.add(x.id); await respostaImg(p, x.id, 'INDISPONIVEL'); }
    }
    await passar(p, 3000);
    const porFoto = {};
    for (const x of pedidos(p)) porFoto[x.imagemId] = (porFoto[x.imagemId] || 0) + 1;
    assert.deepEqual(Object.values(porFoto).sort(), [3, 3]);
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    assert.equal(imgs(p).length, 0);
  });

  test('IMG-I6 — LIMITE com espera: o Totem pausa pelo prazo informado e só então repete; a tela não muda', async () => {
    const p = await abrirNoCatalogo();
    await passar(p, 1000);
    const [primeiro] = pedidos(p);
    await respostaImg(p, primeiro.id, 'LIMITE', { espera: 5 });
    const depoisDe = pedidos(p).length;
    await passar(p, 3000);
    assert.equal(pedidos(p).length, depoisDe, 'nada novo antes do prazo');
    await passar(p, 4000);
    assert.ok(pedidos(p).length > depoisDe, 'repete depois do prazo');
    assert.equal(pedidos(p).filter((x) => x.imagemId === primeiro.imagemId).length >= 2, true);
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
  });

  test('IMG-I7 — resposta do pai inválida, de outra fonte ou origem, ou de pedido desconhecido é ignorada: nenhuma fotografia aparece e o pedido segue pendente', async () => {
    const p = await abrirNoCatalogo();
    await passar(p, 1500);
    const [x] = pedidos(p);
    const base = { canal: CANAL, versao: 1, tipo: 'IMAGEM_RESULTADO', id: x.id };
    const casos = [
      ['id desconhecido', { ...base, id: 'img-desconhecido', resultado: 'OK', blob: blobOk(p) }], ['OK sem blob', { ...base, resultado: 'OK' }],
      ['blob não é objeto', { ...base, resultado: 'OK', blob: 'texto' }], ['blob vazio', { ...base, resultado: 'OK', blob: { size: 0, type: 'image/webp' } }],
      ['chave extra', { ...base, resultado: 'OK', blob: blobOk(p), url: 'https://x.invalido/a.png' }], ['resultado desconhecido', { ...base, resultado: 'TALVEZ' }],
      ['LIMITE sem espera', { ...base, resultado: 'LIMITE' }], ['LIMITE com espera absurda', { ...base, resultado: 'LIMITE', espera: 100000 }], ['canal errado', { ...base, canal: 'outro', resultado: 'NAO_ENCONTRADA' }],
      ['NAO_ENCONTRADA com blob', { ...base, resultado: 'NAO_ENCONTRADA', blob: blobOk(p) }],
    ];
    for (const [nome, data] of casos) { await doPai(p, data); await p.esperar(); assert.equal(imgs(p).length, 0, nome); }
    await doPai(p, { ...base, resultado: 'OK', blob: blobOk(p) }, { origin: 'http://outra.origem:1' });
    await doPai(p, { ...base, resultado: 'OK', blob: blobOk(p) }, { source: {} });
    assert.equal(imgs(p).length, 0);
    await respostaImg(p, x.id, 'OK', { blob: blobOk(p) });
    await p.esperar();
    assert.equal(imgs(p).length, 1, 'o pedido seguia pendente e a resposta válida é aplicada');
  });

  test('IMG-I8 — ao sair, o adaptador cancela cada pedido pendente no pai (mensagem estrita) e uma resposta tardia não aparece na tela do próximo funcionário', async () => {
    const p = await abrirNoCatalogo();
    await passar(p, 1500);
    const pend = pedidos(p).map((x) => x.id);
    assert.equal(pend.length, 2);
    await clicar(p, p.el('btnSair'));
    const canc = mensagens(p, 'IMAGEM_CANCELAR');
    assert.deepEqual(canc.map((c) => c.id).sort(), [...pend].sort());
    for (const c of canc) assert.deepEqual(Object.keys(c).sort(), ['canal', 'id', 'tipo', 'versao']);
    for (const id of pend) await respostaImg(p, id, 'OK', { blob: blobOk(p) });
    await p.esperar();
    assert.equal(imgs(p, 'img').length, 0, 'resposta tardia ignorada');
    assert.ok(p.janela.__criadas.length === 0 || p.janela.__criadas.every((u) => p.janela.__revogadas.includes(u)));
  });

  // DEMO-FOTOS (21/10/2026): a demonstração agora mostra as 8 fotografias EMBUTIDAS (previa-imagens-demo.js), servidas em memória pelo adaptador. O isolamento
  // continua o mesmo: nenhuma mensagem à janela pai, nenhuma rota não suportada, nada fora da página (semEscapes). Antes (histórico): esperava 0 fotografias.
  test('IMG-I9 — a demonstração (sem modo real) nunca pede fotografias ao pai: nenhuma mensagem; as 8 fotografias embutidas aparecem sem rede nem ponte', async () => {
    const p = abrirImg('');
    await p.esperar();
    await identificar(p, 'MATRICULA', '1001');
    await passar(p, 5000);
    assert.equal(enviadas(p).length, 0);
    assert.equal(imgs(p, 'img').length, 8);
    assert.equal(p.janela.TotemPrevia.naoSuportadas(), 0);
    semEscapes(p);
  });

  test('IMG-I10 — o iframe continua isolado: nenhuma credencial, rede, armazenamento, cookie ou navegação, e o Totem pede imagem só por mensagem', async () => {
    const p = await abrirNoCatalogo();
    await passar(p, 1500);
    for (const x of pedidos(p)) await respostaImg(p, x.id, 'OK', { blob: blobOk(p) });
    await p.esperar();
    semEscapes(p);
    const texto = JSON.stringify(enviadas(p));
    assert.doesNotMatch(texto, /cookie|authorization|token|gepi_|senha|cpf/i);
  });
});
