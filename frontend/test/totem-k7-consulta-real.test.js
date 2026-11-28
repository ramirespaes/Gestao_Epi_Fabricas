'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { abrirPagina, RAIZ, semComentarios } = require('./helpers/dom-pagina');
const { injetarShim } = require('./helpers/totem-i');
const { STUB_LEITOR } = require('./helpers/totem-leitor');
const DATA_URL_WEBP = /^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/;

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
// S2819: o segredo de uso único do handshake chega no nome do iframe (window.name), nunca na URL (fictício aqui).
const SEGREDO_TESTE = 'fedcba9876543210fedcba9876543210';
const BUSCA_REAL = `?modo=real&pai=${encodeURIComponent(PAI)}`;
// `null`: iframe sem nome (undefined acionaria o padrão dos parâmetros).
const NOME_DO_QUADRO = (nome) => (nome === null ? '' : `<script>window.name = ${JSON.stringify(nome)};</script>`);
const CPF_FICTICIO = '12345678901';
const lerArquivo = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const exigir = (rel) => assert.ok(fs.existsSync(path.join(RAIZ, rel)), `${rel} não existe`);


const CATALOGO = Object.freeze({
  estado: 'OK',
  total: 2,
  materiais: [
    { id: 31, nome: 'Luva Teste', unidade: 'PAR', categoria: 'EPI', grupoProtecao: null, tipo: { id: 5, nome: 'Luva' }, exigeTamanho: true, tamanhos: ['M', 'G'], imagem: { disponivel: false } },
    { id: 32, nome: 'Capacete Teste', unidade: 'UN', categoria: 'EPI', grupoProtecao: null, tipo: { id: 6, nome: 'Capacete' }, exigeTamanho: false, tamanhos: [], imagem: { disponivel: false } },
  ],
});

function abrir({ search = BUSCA_REAL, transformar = null, nome = SEGREDO_TESTE } = {}) {
  exigir(PREVIA);
  // S2819: a ponte é o MessageChannel com handshake confirmado automaticamente (STUB_PONTE, no fim do arquivo).
  const html = injetarShim(lerArquivo(PREVIA)).replace('<script src="previa-adaptador.js"></script>', `${NOME_DO_QUADRO(nome)}${STUB_PONTE(true)}<script src="previa-adaptador.js"></script>`);
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
// Pedidos ao pai: o que saiu pela porta (S2819). `alvo` 'porta' substitui a origem do pai como destino.
const enviadas = (p) => (p.janela.__canais && p.janela.__canais[0] ? JSON.parse(JSON.stringify(p.janela.__canais[0].port1.enviadas)).map((m) => ({ m, alvo: 'porta' })) : []);
const resultado = (id, extra = {}) => ({ canal: CANAL, versao: 1, tipo: 'RESULTADO', id, ...extra });
const ok = (id) => resultado(id, { resultado: 'OK', primeiroNome: 'Dora', catalogo: JSON.parse(JSON.stringify(CATALOGO)) });
// Sem `extra`, a resposta chega pela porta. Com fonte/origem forjadas, chega pela janela, caminho que o adaptador não escuta mais.
const doPai = async (p, data, extra = {}) => {
  if (Object.keys(extra).length > 0) return p.eventoDaJanela('message', { data, source: p.janela.parent, origin: PAI, ...extra });
  const c = p.janela.__canais && p.janela.__canais[0];
  if (c && typeof c.port1.onmessage === 'function') await c.port1.onmessage({ data });
  await p.esperar();
};

function semEscapes(p) {
  assert.deepEqual(p.chamadas.map((c) => c.chave), [], 'a rede real nunca é chamada');
  assert.deepEqual(p.externas, []);
  assert.deepEqual(p.storage, [], 'nenhum armazenamento');
  assert.deepEqual(p.cookiesEscritos, []);
  assert.deepEqual(p.navegacoes, []);
  // S2819: o segredo não passa pela URL, então nada é reescrito no histórico.
  assert.deepEqual(JSON.parse(JSON.stringify(p.historico)), [], 'nenhum registro de histórico');
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
    assert.equal(m[0].alvo, 'porta', 'S2819: pela porta do MessageChannel confirmada pela Central');
    assert.equal(p.janela.__paraPai.length, 1, 'pela janela do pai só o PONTE_ABRIR, com destino exato');
    assert.equal(p.janela.__paraPai[0].alvo, PAI);
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
  // S2819 (27/11/2026): antes eram UM postMessage ao pai e UM ouvinte de message na janela. Agora: UM postMessage ao pai (o handshake,
  // com destino explícito), UM pela porta e NENHUM ouvinte de message na janela.
  test('K7-E1 — o adaptador tem UM postMessage ao pai, com destino explícito, e UM pela porta; nenhum ouvinte de message; nunca "*", nunca fetch real', () => {
    exigir(ADAPTADOR);
    const codigo = semComentarios(lerArquivo(ADAPTADOR));
    assert.equal((codigo.match(/\.postMessage\s*\(/g) || []).length, 2);
    assert.equal((codigo.match(/window\.parent\.postMessage\s*\(/g) || []).length, 1);
    assert.equal((codigo.match(/porta\.postMessage\s*\(/g) || []).length, 1);
    assert.equal((codigo.match(/addEventListener\s*\(\s*'message'/g) || []).length, 0);
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
    // S7039 opção B (28/11/2026): estilos inline viram classes. Pino ANTERIOR (histórico): 6ec5236ec6673c581332468b2cb2f7b64df8467f260030b9a47b5387a78bd286.
    assert.equal(sha('totem/index.html'), '8057ee67fdf7cc4eafcf59348353b9adff3b378180374d12571cd29d0033d076');
    // GREEN-2A/2C (20/10/2026): fotografias integradas. Pino ANTERIOR (histórico): 9ee5d2f8d66e154c067c0f7a35c5214a1341fcd42899f92ac3c16cdf5a60c33e.
    // FIX-TOTEM-NUMERO (31/10/2026): confirmação do pedido com o número inteiro do backend, autorizada por Ramires. Pino ANTERIOR (histórico): c6728858e0d185cb0331c78099d47f9688ea22d7fdcbca4600bd9ba1478b6afc.
    // FIX-TOTEM-IMAGENS-DATA (11/2026): a CSP da HML bloqueia blob:; a fotografia passa a ser data:image/webp (FileReader), autorizado por Ramires. Pino ANTERIOR (histórico): caa89895eec5660db5cb9b4ca746c6590b7a15575f38a215d4a2b19c61807fc5.
    // S7039 opção B (28/11/2026): estilos inline viram classes. Pinos ANTERIORES (histórico): totem.js e44dd02a4c413b8f563c83b3e366146c862eb33af3948db34762ffb76ab1b87e;
    // totem.css 3caa1760e92f1c5feddcb211ab09c082f16db2dc4a0eb182f3f02e609d4ebe50.
    assert.equal(sha('totem/totem.js'), '19c4d1299795dde70a95fa21ac5067fb60df7367cb1733bcf83f202ecd80a099');
    assert.equal(sha('totem/totem.css'), '011d660662d2b952d5522dba7be89dfdda5cfbf812b456007e9d76ce1f7d2476');
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
    const html = injetarShim(lerArquivo(PREVIA)).replace('<script src="previa-adaptador.js"></script>', `${NOME_DO_QUADRO(SEGREDO_TESTE)}${STUB_PONTE(true)}${STUB_IMAGENS}<script>${STUB_LEITOR}</script><script src="previa-adaptador.js"></script>`);
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
    assert.ok(enviadas(p).filter((e) => e.m.tipo === 'IMAGEM').every((e) => e.alvo === 'porta'), 'S2819: só pela porta confirmada, nunca pela janela');
    assert.equal(p.janela.__paraPai.length, 1, 'pela janela do pai só o PONTE_ABRIR');
    semEscapes(p);
  });

  test('IMG-I2 — a resposta OK do pai vira <img> (data:image/webp, nunca blob:) no espaço .prod-img; o cartão sem foto mantém o placeholder', async () => {
    const p = await abrirNoCatalogo();
    await passar(p, 1500);
    for (const x of pedidos(p)) await respostaImg(p, x.id, 'OK', { blob: blobOk(p) });
    await p.esperar();
    const fotos = imgs(p);
    assert.equal(fotos.length, 2);
    for (const f of fotos) assert.match(f.getAttribute('src'), DATA_URL_WEBP);
    assert.equal(p.janela.__criadas.length, 0, 'nenhuma URL de objeto (blob:) foi criada no iframe');
    assert.deepEqual(Array.from(p.janela.__leituras, (l) => l.tipo), ['image/webp', 'image/webp'], 'o Blob do pai é lido já tipado como image/webp');
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
    assert.match(imgs(p, '#detImg img')[0].getAttribute('src'), DATA_URL_WEBP);
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
    assert.equal(p.janela.__criadas.length, 0, 'nenhuma URL de objeto (blob:) foi criada');
    assert.ok(p.janela.__leituras.every((l) => l.concluida || l.abortada), 'nenhuma leitura ficou pendente');
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

// ───────────────────────── S2819 — ponte por MessageChannel (lado do iframe) ─────────────────────────
// O adaptador cria o MessageChannel, transfere port2 ao pai num ÚNICO postMessage com destino explícito (PONTE_ABRIR) e só faz pedidos
// depois da confirmação PONTE_PRONTA na porta. Respostas só valem pela porta; mensagem pela janela, mesmo do pai e da origem certa, é ignorada.
const STUB_PONTE = (auto) => `<script>(function () {
  var paraPai = []; var canais = [];
  window.__paraPai = paraPai; window.__canais = canais;
  window.MessageChannel = function () {
    var p1 = { onmessage: null, enviadas: [], fechada: false, postMessage: function (m) { if (!p1.fechada) p1.enviadas.push(m && m.blob ? m : JSON.parse(JSON.stringify(m))); }, start: function () {}, close: function () { p1.fechada = true; } };
    var p2 = { marca: 'port2-' + canais.length };
    canais.push({ port1: p1, port2: p2 });
    this.port1 = p1; this.port2 = p2;
  };
  window.parent = { postMessage: function (m, alvo, transfer) {
    paraPai.push({ m: JSON.parse(JSON.stringify(m)), alvo: alvo, transfer: (transfer || []).map(function (t) { return t && t.marca; }) });
    if (${auto ? 'true' : 'false'} && m && m.tipo === 'PONTE_ABRIR') {
      var c = canais[canais.length - 1];
      Promise.resolve().then(function () { if (c.port1.onmessage) c.port1.onmessage({ data: { canal: m.canal, versao: 1, tipo: 'PONTE_PRONTA', id: m.id } }); });
    }
  } };
})();</script>`;

function abrirPonte({ search = BUSCA_REAL, auto = true, nome = SEGREDO_TESTE } = {}) {
  exigir(PREVIA);
  const html = injetarShim(lerArquivo(PREVIA)).replace('<script src="previa-adaptador.js"></script>', `${NOME_DO_QUADRO(nome)}${STUB_PONTE(auto)}<script src="previa-adaptador.js"></script>`);
  return abrirPagina(PREVIA, { html, search });
}
const porta1 = (p) => p.janela.__canais[0] && p.janela.__canais[0].port1;
const pelaPorta = async (p, data) => { await porta1(p).onmessage({ data }); await p.esperar(); };
const pedidos = (p) => (porta1(p) ? JSON.parse(JSON.stringify(porta1(p).enviadas)) : []);

describe('S2819 — o adaptador fala com a Central só pela porta do MessageChannel', () => {
  test('S2819-A1 — na carga sai UM PONTE_ABRIR ao pai, com destino exato e port2 transferida; não há ouvinte de message na janela', async () => {
    const p = abrirPonte({ auto: false });
    await p.esperar();
    assert.equal(p.janela.__canais.length, 1, 'um canal');
    const m = JSON.parse(JSON.stringify(p.janela.__paraPai));
    assert.equal(m.length, 1);
    assert.equal(m[0].alvo, PAI);
    assert.deepEqual(m[0].transfer, ['port2-0']);
    assert.deepEqual(Object.keys(m[0].m).sort(), ['canal', 'id', 'segredo', 'tipo', 'versao']);
    assert.deepEqual([m[0].m.canal, m[0].m.versao, m[0].m.tipo, m[0].m.segredo], [CANAL, 1, 'PONTE_ABRIR', SEGREDO_TESTE]);
    assert.match(m[0].m.id, /^[A-Za-z0-9-]{8,64}$/);
    assert.equal(typeof porta1(p).onmessage, 'function');
    assert.equal(p.ouvintesDaJanela('message'), 0);
  });

  test('S2819-A2 — sem PONTE_PRONTA nenhum pedido sai; confirmação com id errado é ignorada; com o id certo a identificação sai pela porta', async () => {
    const p = abrirPonte({ auto: false });
    await p.esperar();
    const id = p.janela.__paraPai[0].m.id;
    await identificar(p, 'MATRICULA', '2001');
    assert.deepEqual(pedidos(p), []);
    await pelaPorta(p, { canal: CANAL, versao: 1, tipo: 'PONTE_PRONTA', id: 'outro-id-0001' });
    assert.deepEqual(pedidos(p), []);
    await pelaPorta(p, { canal: CANAL, versao: 1, tipo: 'PONTE_PRONTA', id });
    const ped = pedidos(p);
    assert.equal(ped.length, 1);
    assert.deepEqual([ped[0].tipo, ped[0].tipoId, ped[0].valor], ['IDENTIFICAR', 'MATRICULA', '2001']);
    assert.equal(p.janela.__paraPai.length, 1, 'nada mais pela janela do pai');
  });

  test('S2819-A3 — sem confirmação a identificação vira indisponibilidade no tempo-limite, sem nada enviado', async () => {
    const p = abrirPonte({ auto: false });
    await p.esperar();
    await identificar(p, 'MATRICULA', '2001');
    for (let i = 0; i < 9; i += 1) { p.janela.__relogio.avancar(1000); await p.esperar(); }
    assert.match(textoDaPagina(p), /Não foi possível se comunicar com o sistema\./);
    assert.deepEqual(pedidos(p), []);
    assert.deepEqual(JSON.parse(JSON.stringify(p.janela.__paraPai)).map((e) => e.m.tipo), ['PONTE_ABRIR'], 'o identificador nunca sai pela janela');
  });

  test('S2819-A4 — o resultado só vale pela porta: pela janela (fonte e origem do pai) é ignorado', async () => {
    const p = abrirPonte();
    await p.esperar();
    await identificar(p, 'MATRICULA', '2001');
    const id = pedidos(p)[0].id;
    await p.eventoDaJanela('message', { data: ok(id), source: p.janela.parent, origin: PAI });
    assert.notDeepEqual(telaAtual(p), ['telaProdutos']);
    await pelaPorta(p, ok(id));
    assert.deepEqual(telaAtual(p), ['telaProdutos']);
    assert.match(textoDaPagina(p), /Olá, Dora/);
  });

  test('S2819-A5 — na demonstração não há canal nem mensagem ao pai', async () => {
    for (const busca of ['', '?modo=demo', `?pai=${encodeURIComponent(PAI)}`]) {
      const p = abrirPonte({ search: busca });
      await p.esperar();
      assert.equal(p.janela.__canais.length, 0, busca);
      assert.equal(p.janela.__paraPai.length, 0, busca);
    }
  });

  test('S2819-A6 — estático: um único postMessage ao pai (com transferência) e os pedidos pela porta; nenhum ouvinte de message na janela', () => {
    const codigo = semComentarios(lerArquivo(ADAPTADOR));
    assert.equal((codigo.match(/window\.parent\.postMessage\s*\(/g) || []).length, 1);
    assert.match(codigo, /new\s+(window\.)?MessageChannel\s*\(/);
    assert.match(codigo, /porta\.postMessage\s*\(/);
    assert.doesNotMatch(codigo, /addEventListener\s*\(\s*'message'/);
    assert.doesNotMatch(codigo, /postMessage\s*\([^)]*['"]\*['"]/);
  });
});

// ───────────────────────── S2819 — segredo do handshake (lado do iframe) ─────────────────────────
describe('S2819 — o adaptador apresenta o segredo do nome do iframe e o apaga', () => {
  const SEGREDO = '0123456789abcdef0123456789abcdef';

  test('S2819-A7 — o PONTE_ABRIR leva o segredo de window.name; sem segredo válido não há canal nem mensagem ao pai', async () => {
    const p = abrirPonte({ nome: SEGREDO, auto: false });
    await p.esperar();
    const m = JSON.parse(JSON.stringify(p.janela.__paraPai));
    assert.equal(m.length, 1);
    assert.deepEqual(Object.keys(m[0].m).sort(), ['canal', 'id', 'segredo', 'tipo', 'versao']);
    assert.equal(m[0].m.segredo, SEGREDO);
    for (const nome of [null, '', 'XYZ', SEGREDO.slice(1), SEGREDO.toUpperCase(), `${SEGREDO} `, `${SEGREDO}0`]) {
      const q = abrirPonte({ nome, auto: false });
      await q.esperar();
      assert.equal(q.janela.__canais.length, 0, String(nome));
      assert.equal(q.janela.__paraPai.length, 0, String(nome));
    }
  });

  test('S2819-A8 — window.name é apagado na leitura (válido ou não); a URL não é tocada e o segredo não fica em armazenamento nem console', async () => {
    for (const nome of [SEGREDO, 'XYZ']) {
      const p = abrirPonte({ nome, auto: false });
      await p.esperar();
      assert.equal(p.janela.name, '', `nome apagado (${nome})`);
      assert.deepEqual(JSON.parse(JSON.stringify(p.historico)), [], 'nenhum replaceState');
      assert.equal(JSON.stringify([p.storage, p.cookiesEscritos, p.consoleChamadas, p.janela.location.href]).includes(nome), false);
    }
  });

  test('S2819-A9 — compatibilidade: segredo na query (Central antiga) é ignorado e falha fechado; nome do iframe com query antiga continua valendo só pelo nome', async () => {
    const antiga = `?modo=real&pai=${encodeURIComponent(PAI)}&ponte=${SEGREDO}`;
    const q = abrirPonte({ search: antiga, nome: null, auto: false });
    await q.esperar();
    assert.equal(q.janela.__canais.length, 0, 'sem nome, a query não abre a ponte');
    assert.equal(q.janela.__paraPai.length, 0);
    const r = abrirPonte({ search: antiga, nome: SEGREDO_TESTE, auto: false });
    await r.esperar();
    assert.equal(JSON.parse(JSON.stringify(r.janela.__paraPai))[0].m.segredo, SEGREDO_TESTE, 'o valor vem do nome, nunca da query');
  });

  test('S2819-A10 — estático: o adaptador não lê o segredo da URL nem reescreve o histórico', () => {
    const codigo = semComentarios(lerArquivo(ADAPTADOR));
    assert.doesNotMatch(codigo, /get\(\s*'ponte'\s*\)/);
    assert.doesNotMatch(codigo, /replaceState/);
    assert.match(codigo, /window\.name\s*=\s*''/);
  });
});
