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
    assert.equal(sha('totem/index.html'), '517e08e4d9ba17a31a2773b632bdc21b89d54f8bd8e06b9bc5bed3ad4d62b70c');
    assert.equal(sha('totem/totem.js'), '9ee5d2f8d66e154c067c0f7a35c5214a1341fcd42899f92ac3c16cdf5a60c33e');
    assert.equal(sha('totem/totem.css'), '9c6b3665fe47ad88543e8f59053b082544816943d5753c41980625f4b379e3ac');
    assert.equal(sha('totem/boot.js'), '583454fe94c2ed73776fd77b4560eb70c59dd708ad582b2a61ff4878104d6899');
  });
});
