'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');

/**
 * RED-2A (20/10/2026) — fotografias dos EPIs no Totem funcional. Só testes: NENHUM código funcional existe ainda. O Totem lê hoje `material.imagem` do
 * catálogo e ignora o campo (cartão e detalhe só têm o placeholder `.vazio`); estes testes descrevem o comportamento futuro (GREEN-2).
 *
 * Contrato da API já implementado no backend (nada novo é inventado):
 *   GET /atendimento-token/tablet/atendimento/imagens/:origem/:id/:variante?v=<versao>
 *   origem da rota: empresa|padrao (o catálogo traz EMPRESA|PADRAO); variante: miniatura|exibicao; id: BIGINT em TEXTO; v: inteiro de 1 a 2147483647;
 *   200 image/webp, sem cache e sem ETag; erros 401/403/404/429/503 (Retry-After no 429). Autentica pelos cookies do tablet e do atendimento.
 *
 * Como o harness é montado (tudo dentro deste arquivo; helpers e testes existentes não mudam): o `fetch` da página é encapsulado por um script anexado ao
 * boot.js SÓ nesta suíte. Ele intercepta APENAS a rota de imagens (o resto segue para o servidor falso), registra cada chamada (método, credenciais, cabeçalhos,
 * início e fim no relógio virtual, aborto) e devolve uma resposta com `blob()`. Também fornece `Blob`, `URL.createObjectURL` e `URL.revokeObjectURL`
 * observáveis, sem tocar nos globais do Node. Falhas de PREPARAÇÃO (o instalador não rodou, a interceptação não funciona) são testadas à parte ([IMG-P*]) e
 * devem passar já; as demais falham hoje porque a funcionalidade não existe (RED legítimo).
 *
 * Limites operacionais PROVISÓRIOS (não aprovados como definitivos por Ramires): concorrência de até 4 e, por dispositivo, no máximo 240 inícios por minuto.
 * São constantes nomeadas abaixo; mudar o valor definitivo é mudar uma linha.
 * Limitação do harness: ele só dispara ouvintes registrados por addEventListener (não chama as propriedades onerror/onload), e não tem IntersectionObserver.
 */

const LIMITE_CONCORRENCIA_PROVISORIO = 4;
const LIMITE_POR_MINUTO_PROVISORIO = 240;
const ROTA_IMAGENS = `${H.BASE}/atendimento/imagens`;

const INSTALADOR = String.raw`(function (g) {
  'use strict';
  var E = g.__img = { chamadas: [], emVoo: 0, maxEmVoo: 0, aborts: 0, criadas: [], revogadas: [], regras: [], segurados: [] };
  var baseFetch = g.fetch;
  var ER = /\/atendimento\/imagens\/(empresa|padrao)\/([^\/?#]+)\/(miniatura|exibicao)(?:\?(.*))?$/;
  function Blob2(partes, opcoes) { this.partes = partes || []; this.type = (opcoes && opcoes.type) || ''; this.tag = null; this.size = 0; }
  if (typeof g.Blob === 'undefined') g.Blob = Blob2;
  var Base = g.URL;
  function U(a, b) { return b === undefined ? new Base(a) : new Base(a, b); }
  U.prototype = Base.prototype;
  U.createObjectURL = function (b) { var url = 'blob:totem/' + (E.criadas.length + 1); E.criadas.push({ url: url, tag: b ? b.tag : null }); return url; };
  U.revokeObjectURL = function (u) { E.revogadas.push(String(u)); };
  g.URL = U;
  function agora() { return g.__relogio ? g.__relogio.agora() : 0; }
  function cabecalhos(mapa) {
    return { get: function (n) { var l = String(n).toLowerCase(); for (var k in mapa) { if (k.toLowerCase() === l) return String(mapa[k]); } return null; } };
  }
  function resposta(status, mapa, corpoJson, tag) {
    var texto = corpoJson === null ? '' : JSON.stringify(corpoJson);
    return {
      status: status, ok: status >= 200 && status < 300, headers: cabecalhos(mapa),
      blob: function () { var b = new g.Blob([], { type: 'image/webp' }); b.tag = tag; b.size = 8; return Promise.resolve(b); },
      arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(8)); },
      text: function () { return Promise.resolve(texto); },
      json: function () { return Promise.resolve(texto === '' ? null : JSON.parse(texto)); },
    };
  }
  function regraDe(c) {
    for (var i = 0; i < E.regras.length; i++) {
      var r = E.regras[i];
      if (r.restantes === 0) continue;
      if ((r.id === undefined || r.id === c.id) && (r.origem === undefined || r.origem === c.origem) && (r.variante === undefined || r.variante === c.variante)) {
        if (r.restantes !== undefined) r.restantes -= 1;
        return r;
      }
    }
    return null;
  }
  E.liberarUm = function () { var f = E.segurados.shift(); if (f) f(); return !!f; };
  E.liberarTodos = function () { E.segurados.splice(0).forEach(function (f) { f(); }); };
  g.fetch = function (destino, opcoes) {
    var alvo = String(destino); var m = ER.exec(alvo);
    if (!m) return baseFetch.apply(this, arguments);
    var o = opcoes || {};
    var c = { n: E.chamadas.length + 1, url: alvo, origem: m[1], id: m[2], variante: m[3], consulta: m[4] === undefined ? '' : m[4],
      metodo: String(o.method || 'GET').toUpperCase(), credentials: o.credentials, cabecalhos: Object.assign({}, o.headers || {}),
      corpo: o.body === undefined ? null : o.body, inicio: agora(), fim: null, abortada: false, resultado: null };
    E.chamadas.push(c);
    E.emVoo += 1; if (E.emVoo > E.maxEmVoo) E.maxEmVoo = E.emVoo;
    var sinal = o.signal;
    return new Promise(function (resolver, rejeitar) {
      var fim = false;
      function terminar(fn, resultado) { if (fim) return; fim = true; E.emVoo -= 1; c.fim = agora(); c.resultado = resultado; fn(); }
      function abortar() {
        if (fim) return;
        c.abortada = true; E.aborts += 1;
        terminar(function () { var e = new Error('abortado'); e.name = 'AbortError'; rejeitar(e); }, 'abortada');
      }
      if (sinal && sinal.aborted) { abortar(); return; }
      if (sinal && sinal.addEventListener) sinal.addEventListener('abort', abortar);
      var r = regraDe(c);
      function entregar() {
        if (r && r.modo === 'rede') { terminar(function () { rejeitar(new Error('falha de rede simulada')); }, 'rede'); return; }
        if (r && r.modo === 'status') {
          var cab = {}; if (r.retryAfter !== undefined) cab['Retry-After'] = String(r.retryAfter);
          terminar(function () { resolver(resposta(r.status, cab, { status: 'error', codigo: r.codigo || 'ERRO', message: 'm' }, null)); }, String(r.status));
          return;
        }
        terminar(function () { resolver(resposta(200, { 'Content-Type': 'image/webp' }, null, 'T' + c.n)); }, '200');
      }
      if (r && r.modo === 'segurar') E.segurados.push(function () { if (!fim) entregar(); });
      else Promise.resolve().then(entregar);
    });
  };
})(globalThis);`;

// O instalador é ANEXADO ao boot.js (primeiro script local): roda antes do totem.js e não tira o 'use strict' do início do boot.js.
const transformar = (relativo, codigo) => (relativo === 'totem/boot.js' ? `${codigo}\n${INSTALADOR}` : codigo);

const imagem = (i, extra = {}) => ({ disponivel: true, origem: 'EMPRESA', id: String(1000 + i), versao: 1, ...extra });
const material = (i, extra = {}) => ({ id: i, nome: `Item ${i}`, unidade: 'UN', categoria: 'EPI', grupoProtecao: null, tipo: null, exigeTamanho: false, tamanhos: [], imagem: imagem(i), ...extra });
const catalogo = (n, ajuste = () => ({})) => Array.from({ length: n }, (_, i) => material(i + 1, ajuste(i)));

async function abrir({ materiais, regras = [], servidorOpcoes = {}, ate = 'catalogo', funcionario = H.FUNCIONARIOS[0] } = {}) {
  const servidor = H.criarServidor({ materiais, ...servidorOpcoes });
  const t = await H.abrirTotem({ servidor, transformar });
  const E = t.janela.__img;
  assert.ok(E, 'PREPARAÇÃO: o instalador de imagens da suíte não rodou');
  for (const r of regras) E.regras.push(r);
  if (ate === 'catalogo') {
    await t.identificar({ tipo: 'CPF', valor: funcionario.cpf });
    await t.irAoCatalogo();
  }
  return { t, E, servidor };
}

const cartao = (t, nome) => t.consulta('#grade .prod').find((c) => c.querySelector('.prod-nome')?.textContent.trim() === nome);
const imgsDe = (t, seletor) => t.consulta(seletor);
const srcDe = (el) => el.getAttribute('src') ?? el.src ?? null;
const contagem = (E, variante, id) => E.chamadas.filter((c) => c.variante === variante && (id === undefined || c.id === id)).length;
const apiBase = (t) => t.janela.SAFEWORK_PORTAL_API_BASE_URL;

// ═══════════════════ preparação do próprio harness (devem passar já; separam falha de preparação de RED legítimo) ═══════════════════
describe('[IMG-P] preparação do harness desta suíte', () => {
  test('[IMG-P1] o instalador intercepta só a rota de imagens, devolve blob() e registra a chamada; outras rotas seguem para o servidor falso', async () => {
    const { t, E, servidor } = await abrir({ materiais: catalogo(2), ate: 'abertura' });
    const r = await t.janela.fetch(`${apiBase(t)}${ROTA_IMAGENS}/empresa/1001/miniatura?v=1`, { credentials: 'include', headers: { Accept: 'image/webp' } });
    assert.equal(r.status, 200);
    assert.ok(typeof r.blob === 'function' && (await r.blob()).type === 'image/webp');
    assert.equal(E.chamadas.length, 1);
    assert.deepEqual([E.chamadas[0].origem, E.chamadas[0].id, E.chamadas[0].variante, E.chamadas[0].consulta, E.chamadas[0].credentials], ['empresa', '1001', 'miniatura', 'v=1', 'include']);
    const estado = await t.janela.fetch(`${apiBase(t)}${H.BASE}/estado`, { method: 'GET', credentials: 'include' });
    assert.equal(estado.status, 200);
    assert.equal(E.chamadas.length, 1, 'o /estado não passou pelo interceptador de imagens');
    assert.equal(servidor.contar(`GET ${H.BASE}/estado`) >= 1, true);
  });

  test('[IMG-P2] URL.createObjectURL/revokeObjectURL da página são observáveis e `new URL` continua funcionando', async () => {
    const { t, E } = await abrir({ materiais: catalogo(1), ate: 'abertura' });
    const url = t.janela.URL.createObjectURL(new t.janela.Blob([], { type: 'image/webp' }));
    t.janela.URL.revokeObjectURL(url);
    assert.deepEqual([E.criadas.length, E.revogadas.length, E.revogadas[0] === url], [1, 1, true]);
    assert.equal(new t.janela.URL('http://localhost:3000/api/x?y=1').pathname, '/api/x');
  });

  test('[IMG-P3] o placeholder aprovado está presente enquanto a resposta está pendente; a fotografia o substitui só após resposta válida; resposta inválida o mantém', async () => {
    const { t, E } = await abrir({ materiais: catalogo(3), regras: [{ modo: 'segurar' }] });
    const cartoes = t.consulta('#grade .prod');
    assert.equal(cartoes.length, 3);
    await t.passar(3000);
    assert.ok(E.chamadas.length >= 1 && E.emVoo >= 1, 'há respostas pendentes');
    for (const c of t.consulta('#grade .prod')) {
      assert.ok(c.querySelector('.prod-img .vazio'), 'placeholder ausente enquanto pendente');
      assert.equal(c.querySelectorAll('img').length, 0);
    }
    E.liberarTodos();
    await t.passar(1000);
    assert.equal(t.consulta('#grade .prod-img img').length, 3, 'a fotografia substituiu o placeholder após a resposta válida');
    assert.equal(t.consulta('#grade .prod-img .vazio').length, 0);

    const falha = await abrir({ materiais: catalogo(3), regras: [{ modo: 'status', status: 404, codigo: 'IMAGEM_NAO_ENCONTRADA' }] });
    await falha.t.passar(3000);
    assert.ok(falha.E.chamadas.length >= 1);
    assert.equal(falha.t.consulta('#grade .prod-img img').length, 0);
    assert.equal(falha.t.consulta('#grade .prod-img .vazio').length, 3, 'resposta inválida mantém o placeholder');
  });
});

// ═══════════════════ 1 a 4. reconhecimento do contrato, miniatura nos cartões, exibição no detalhe, placeholder ═══════════════════
describe('[IMG-A] fotografias nos espaços de imagem existentes', () => {
  test('[IMG-A1] material com imagem válida: UMA miniatura por cartão, pela rota de imagens, com o id e a versão do catálogo; o <img> usa URL de objeto (blob:)', async () => {
    const { t, E, servidor } = await abrir({ materiais: [material(7, { imagem: imagem(7, { versao: 3 }) })] });
    await t.passar(3000);
    assert.equal(E.chamadas.length, 1, 'uma requisição de miniatura');
    const c = E.chamadas[0];
    assert.equal(c.url, `${apiBase(t)}${ROTA_IMAGENS}/empresa/1007/miniatura?v=3`);
    assert.equal(c.metodo, 'GET');
    const imgs = imgsDe(t, '#grade .prod-img img');
    assert.equal(imgs.length, 1);
    assert.match(srcDe(imgs[0]), /^blob:/);
    assert.equal(imgs[0].getAttribute('alt'), 'Item 7');
    assert.deepEqual(servidor.violacoes, []);
  });

  test('[IMG-A2] origem PADRAO vira /padrao/ e o id BIGINT segue como TEXTO, sem perda de precisão (acima de 2^53 e no limite do PostgreSQL)', async () => {
    const materiais = [
      material(1, { imagem: { disponivel: true, origem: 'PADRAO', id: '9007199254740993', versao: 2147483647 } }),
      material(2, { imagem: { disponivel: true, origem: 'EMPRESA', id: '9223372036854775807', versao: 1 } }),
    ];
    const { t, E } = await abrir({ materiais });
    await t.passar(3000);
    // `E.chamadas` nasce no contexto da página: o array do map tem outro prototype; Array.from copia as mesmas strings para este contexto.
    const urls = Array.from(E.chamadas, (c) => c.url.slice(apiBase(t).length)).sort();
    assert.deepEqual(urls, [
      `${ROTA_IMAGENS}/empresa/9223372036854775807/miniatura?v=1`,
      `${ROTA_IMAGENS}/padrao/9007199254740993/miniatura?v=2147483647`,
    ]);
  });

  test('[IMG-A3] só imagem VÁLIDA vira requisição: disponivel=false, origem/id/versão inválidos, URL externa e tipos errados mantêm o placeholder e não geram chamada', async () => {
    const invalidas = [
      { disponivel: false },
      { disponivel: true, origem: 'OUTRA', id: '5', versao: 1 },
      { disponivel: true, origem: 'empresa', id: '5', versao: 1 },
      { disponivel: true, origem: 'EMPRESA', id: 5, versao: 1 },
      { disponivel: true, origem: 'EMPRESA', id: '007', versao: 1 },
      { disponivel: true, origem: 'EMPRESA', id: '0', versao: 1 },
      { disponivel: true, origem: 'EMPRESA', id: '9223372036854775808', versao: 1 },
      { disponivel: true, origem: 'EMPRESA', id: '5/../9', versao: 1 },
      { disponivel: true, origem: 'EMPRESA', id: '5', versao: 0 },
      { disponivel: true, origem: 'EMPRESA', id: '5', versao: '3' },
      { disponivel: true, origem: 'EMPRESA', id: '5', versao: 1.5 },
      { disponivel: true, origem: 'EMPRESA', id: '5', versao: 2147483648 },
      { disponivel: true, url: 'https://externo.invalido/foto.png' },
      null, 'texto', 7, [],
    ];
    const materiais = [material(1), ...invalidas.map((imagemInvalida, i) => material(i + 2, { imagem: imagemInvalida }))];
    const { t, E, servidor } = await abrir({ materiais });
    await t.passar(3000);
    assert.equal(E.chamadas.length, 1, 'só o material com imagem válida gera requisição');
    assert.equal(E.chamadas[0].id, '1001');
    for (let i = 2; i <= invalidas.length + 1; i += 1) {
      const c = cartao(t, `Item ${i}`);
      assert.ok(c.querySelector('.prod-img .vazio'), `Item ${i}: placeholder preservado`);
      assert.equal(c.querySelectorAll('img').length, 0, `Item ${i}: sem <img>`);
    }
    assert.deepEqual(t.externas, []);
    assert.deepEqual(servidor.violacoes, []);
  });

  test('[IMG-A4] na tela de detalhe a variante é a de EXIBIÇÃO (id e versão do catálogo) e o <img> usa blob:; a miniatura e a exibição de um mesmo material não se repetem na mesma sessão', async () => {
    const { t, E } = await abrir({ materiais: catalogo(3) });
    await t.passar(2000);
    assert.equal(contagem(E, 'exibicao'), 0, 'na listagem só miniaturas');
    await t.abrirProduto('Item 3');
    await t.passar(2000);
    assert.equal(contagem(E, 'exibicao', '1003'), 1);
    const imgs = imgsDe(t, '#detImg img');
    assert.equal(imgs.length, 1);
    assert.match(srcDe(imgs[0]), /^blob:/);
    assert.ok(E.chamadas.find((c) => c.variante === 'exibicao').url.endsWith(`${ROTA_IMAGENS}/empresa/1003/exibicao?v=1`));
    await t.clicarEl(t.el('btnVoltarProdutos'));
    const miniaturasAntes = contagem(E, 'miniatura', '1003');
    await t.abrirProduto('Item 3');
    await t.passar(2000);
    assert.equal(contagem(E, 'exibicao', '1003'), 1, 'reabrir o mesmo produto não busca de novo (cache em memória da sessão)');
    assert.equal(contagem(E, 'miniatura', '1003'), miniaturasAntes);
  });

  test('[IMG-A5] [controle] sem fotografia (disponivel=false) o cartão e o detalhe ficam com o placeholder e nenhuma requisição de imagem sai', async () => {
    const { t, E } = await abrir({ materiais: catalogo(2, () => ({ imagem: { disponivel: false } })) });
    await t.passar(3000);
    await t.abrirProduto('Item 1');
    await t.passar(2000);
    assert.equal(E.chamadas.length, 0);
    assert.ok(t.consulta('#detImg .vazio').length >= 1);
    assert.equal(t.consulta('#detImg img').length, 0);
  });

  test('[IMG-A6] a estrutura aprovada do cartão é preservada: o <img> fica DENTRO do .prod-img, ANTES do selo "✓ Solicitado", que continua presente', async () => {
    const solicitacoes = [{ materialId: 3, nome: 'Item 3', tamanho: null, situacao: 'AGUARDANDO_APROVACAO', quantidade: 1 }];
    const { t } = await abrir({ materiais: catalogo(3), servidorOpcoes: { solicitacoes } });
    await t.passar(3000);
    const prodImg = cartao(t, 'Item 3').querySelector('.prod-img');
    const filhos = [...prodImg.filhos].filter((f) => f.nodeType === 1);
    const iImg = filhos.findIndex((f) => f.localName === 'img');
    const iMarca = filhos.findIndex((f) => f.classList.contains('marca'));
    assert.ok(iImg >= 0, 'a fotografia está no .prod-img');
    assert.ok(iMarca > iImg, 'o selo vem depois da fotografia (fica por cima)');
    assert.equal(filhos[iMarca].textContent.trim(), H.TEXTOS.solicitado);
  });
});

// ═══════════════════ 5 e 6. falhas e transporte ═══════════════════
describe('[IMG-B] falhas de carregamento e transporte autenticado', () => {
  test('[IMG-B1] 404 mantém o placeholder, sem mensagem de erro e sem travar o fluxo (abrir produto, escolher e adicionar continuam)', async () => {
    const { t, E } = await abrir({ materiais: catalogo(3), regras: [{ modo: 'status', status: 404, codigo: 'IMAGEM_NAO_ENCONTRADA' }] });
    await t.passar(3000);
    assert.ok(E.chamadas.length >= 1, 'as imagens foram pedidas');
    assert.equal(t.consulta('#grade img').length, 0);
    for (const c of t.consulta('#grade .prod')) assert.ok(c.querySelector('.prod-img .vazio'));
    assert.ok(!/imagem/i.test(t.textoVisivel()), 'nenhum texto sobre a imagem');
    await t.adicionarItem('Item 2');
    assert.ok(t.telaAtual().includes('telaProdutos'));
    assert.deepEqual(t.consoleChamadas, []);
  });

  test('[IMG-B2] erro 5xx e falha de rede mantêm o placeholder e não geram laço de repetição (no máximo 3 tentativas por imagem em 30 s)', async () => {
    for (const regra of [{ modo: 'status', status: 503, codigo: 'IMAGENS_INDISPONIVEL' }, { modo: 'rede' }]) {
      const { t, E } = await abrir({ materiais: catalogo(2), regras: [regra] });
      await t.passar(30000);
      assert.ok(E.chamadas.length >= 1, `${regra.modo}: as imagens foram pedidas`);
      for (const id of ['1001', '1002']) assert.ok(E.chamadas.filter((c) => c.id === id && c.variante === 'miniatura').length <= 3, `${regra.modo}: tentativas de ${id}`);
      assert.equal(t.consulta('#grade img').length, 0);
      assert.ok(t.consulta('#grade .prod .vazio').length === 2);
    }
  });

  test('[IMG-B3] imagem que o navegador não consegue decodificar (evento error do <img>) volta ao placeholder aprovado', async () => {
    const { t } = await abrir({ materiais: catalogo(1) });
    await t.passar(3000);
    const [img] = imgsDe(t, '#grade .prod-img img');
    assert.ok(img, 'a fotografia foi aplicada');
    await img.disparar('error');
    await t.esperar();
    assert.equal(t.consulta('#grade .prod-img img').length, 0, 'o <img> quebrado foi removido');
    assert.ok(t.consulta('#grade .prod-img .vazio').length >= 1, 'o placeholder voltou');
  });

  test('[IMG-C1] toda requisição de imagem é GET com credentials: include, só com o cabeçalho Accept permitido, sem corpo, só a query v e só pela rota de imagens', async () => {
    const { t, E, servidor } = await abrir({ materiais: catalogo(4) });
    await t.passar(3000);
    await t.abrirProduto('Item 2');
    await t.passar(2000);
    assert.ok(E.chamadas.length >= 2);
    for (const c of E.chamadas) {
      assert.equal(c.metodo, 'GET');
      assert.equal(c.credentials, 'include');
      assert.equal(c.corpo, null);
      assert.ok(Object.keys(c.cabecalhos).every((k) => ['accept'].includes(k.toLowerCase())), `cabeçalhos: ${Object.keys(c.cabecalhos)}`);
      assert.match(c.consulta, /^v=\d+$/);
      assert.ok(c.url.startsWith(`${apiBase(t)}${ROTA_IMAGENS}/`));
    }
    assert.deepEqual(servidor.violacoes, []);
    assert.deepEqual(t.externas, []);
  });

  test('[IMG-C2] nenhuma fotografia usa armazenamento do navegador, cookie escrito pela página, console ou histórico', async () => {
    const { t, E } = await abrir({ materiais: catalogo(3) });
    await t.passar(3000);
    assert.ok(E.chamadas.length >= 1);
    assert.deepEqual(t.storage, []);
    assert.deepEqual(t.cookiesEscritos, []);
    assert.deepEqual(t.consoleChamadas, []);
    assert.deepEqual(H.plano(t.navegacoes), []);
  });
});

// ═══════════════════ 8 e 9. concorrência, ritmo, 429 e perda de autorização ═══════════════════
describe('[IMG-D] concorrência, ritmo e erros de autorização', () => {
  test(`[IMG-D1] [limite provisório ${LIMITE_CONCORRENCIA_PROVISORIO}] nunca há mais de ${LIMITE_CONCORRENCIA_PROVISORIO} imagens em voo e, conforme terminam, todas as 40 acabam sendo pedidas`, async () => {
    const { t, E } = await abrir({ materiais: catalogo(40), regras: [{ modo: 'segurar' }] });
    await t.passar(3000);
    assert.ok(E.emVoo >= 1 && E.emVoo <= LIMITE_CONCORRENCIA_PROVISORIO, `em voo: ${E.emVoo}`);
    for (let i = 0; i < 60 && E.chamadas.length < 40; i += 1) {
      E.liberarUm();
      await t.passar(500, 500);
    }
    const ids = new Set(E.chamadas.filter((c) => c.variante === 'miniatura').map((c) => c.id));
    assert.equal(ids.size, 40, 'todas as miniaturas foram pedidas');
    assert.ok(E.maxEmVoo <= LIMITE_CONCORRENCIA_PROVISORIO, `máximo em voo: ${E.maxEmVoo}`);
  });

  test(`[IMG-D2] [limite provisório ${LIMITE_POR_MINUTO_PROVISORIO}/min] com um catálogo de 500 materiais, em 59 s no máximo ${LIMITE_POR_MINUTO_PROVISORIO} imagens começam (o limite do dispositivo no backend não é estourado)`, async () => {
    const { t, E } = await abrir({ materiais: catalogo(500) });
    await t.passar(59000);
    assert.ok(E.chamadas.length >= 1, 'houve carregamento');
    assert.ok(E.chamadas.length <= LIMITE_POR_MINUTO_PROVISORIO, `iniciadas em 59 s: ${E.chamadas.length}`);
  });

  test('[IMG-D3] 429 respeita o Retry-After: nada novo começa antes do prazo, o placeholder fica e nenhum erro aparece; depois o carregamento continua', async () => {
    const regras = [{ modo: 'status', status: 429, codigo: 'LIMITE_REQUISICOES_EXCEDIDO', retryAfter: 5, restantes: 1 }];
    const { t, E } = await abrir({ materiais: catalogo(8), regras });
    await t.passar(1000);
    const barrada = E.chamadas.find((c) => c.resultado === '429');
    assert.ok(barrada, 'houve uma resposta 429');
    await t.passar(20000);
    const depois = E.chamadas.filter((c) => c.inicio > barrada.fim);
    assert.ok(depois.length >= 1, 'o carregamento continua depois do prazo');
    for (const c of depois) assert.ok(c.inicio >= barrada.fim + 5000, `começou ${c.inicio - barrada.fim} ms depois do 429`);
    assert.ok(t.telaAtual().includes('telaProdutos'));
    assert.ok(!t.textoVisivel().includes(H.TEXTOS.limite) && !t.textoVisivel().includes(H.TEXTOS.comunicacao));
  });

  test('[IMG-D4] 401 ATENDIMENTO_INVALIDO numa imagem leva à identificação com a mensagem de sessão encerrada (mesma semântica das demais operações)', async () => {
    const { t } = await abrir({ materiais: catalogo(3), regras: [{ modo: 'status', status: 401, codigo: 'ATENDIMENTO_INVALIDO' }] });
    await t.passar(2000);
    assert.ok(t.telaAtual().includes('telaAcesso'));
    assert.ok(t.textoVisivel().includes(H.TEXTOS.expirada));
  });

  test('[IMG-D5] 401 DISPOSITIVO_NAO_AUTORIZADO mostra a tela de tablet não autorizado; 403 mostra a de rede não autorizada', async () => {
    for (const [regra, tela] of [
      [{ modo: 'status', status: 401, codigo: 'DISPOSITIVO_NAO_AUTORIZADO' }, 'telaNaoAutorizado'],
      [{ modo: 'status', status: 403, codigo: 'REDE_NAO_AUTORIZADA' }, 'telaRede'],
    ]) {
      const { t } = await abrir({ materiais: catalogo(3), regras: [regra] });
      await t.passar(2000);
      assert.ok(t.telaAtual().includes(tela), `${regra.status} deveria mostrar ${tela}: ${t.telaAtual()}`);
    }
  });
});

// ═══════════════════ 10 a 13. encerramento, limpeza e isolamento ═══════════════════
describe('[IMG-E] encerramento do atendimento, limpeza de recursos e isolamento entre funcionários', () => {
  test('[IMG-E1] ao Sair, todas as imagens pendentes são ABORTADAS e nada chega depois à tela', async () => {
    const { t, E } = await abrir({ materiais: catalogo(10), regras: [{ modo: 'segurar' }] });
    await t.passar(3000);
    const pendentes = E.emVoo;
    assert.ok(pendentes >= 1, 'há imagens em voo');
    await t.clicarEl(t.el('btnSair'));
    assert.equal(E.emVoo, 0);
    assert.ok(E.aborts >= pendentes, `abortos: ${E.aborts} de ${pendentes}`);
    E.liberarTodos();
    await t.esperar();
    assert.equal(t.consulta('img').length, 0);
    assert.ok(E.criadas.every((c) => E.revogadas.includes(c.url)), 'nenhuma URL de objeto sobrou');
  });

  test('[IMG-E2] ao expirar a sessão (60 s sem ação), as imagens pendentes são abortadas e a tela volta à identificação', async () => {
    const { t, E } = await abrir({ materiais: catalogo(10), regras: [{ modo: 'segurar' }] });
    await t.passar(3000);
    const pendentes = E.emVoo;
    assert.ok(pendentes >= 1, 'há imagens em voo');
    await t.passar(60000);
    assert.ok(t.telaAtual().includes('telaAcesso'));
    assert.equal(E.emVoo, 0);
    assert.ok(E.aborts >= pendentes);
  });

  test('[IMG-E3] ao encerrar, TODA URL de objeto criada é revogada e a grade é esvaziada', async () => {
    const { t, E } = await abrir({ materiais: catalogo(6) });
    await t.passar(3000);
    assert.ok(E.criadas.length >= 1, 'houve fotografias aplicadas');
    await t.abrirProduto('Item 2');
    await t.passar(2000);
    await t.clicarEl(t.el('btnSair'));
    assert.ok(E.criadas.every((c) => E.revogadas.includes(c.url)), `criadas ${E.criadas.length}, revogadas ${E.revogadas.length}`);
    assert.equal(t.consulta('#grade').length === 0 ? 0 : t.consulta('#grade').reduce((n, g) => n + g.filhos.length, 0), 0);
    assert.equal(t.consulta('#detImg img').length, 0);
  });

  test('[IMG-E4] funcionários diferentes não compartilham fotografias: respostas atrasadas do funcionário A nunca aparecem na tela do funcionário B', async () => {
    const { t, E } = await abrir({ materiais: catalogo(3), regras: [{ modo: 'segurar' }] });
    await t.passar(2000);
    const chamadasDeA = E.chamadas.length;
    assert.ok(chamadasDeA >= 1, 'o funcionário A pediu imagens');
    await t.clicarEl(t.el('btnSair'));
    E.regras.length = 0;
    await t.identificar({ tipo: 'MATRICULA', valor: H.FUNCIONARIOS[1].matricula });
    await t.irAoCatalogo();
    await t.passar(3000);
    E.liberarTodos();
    await t.passar(1000);
    const imgs = imgsDe(t, '#grade .prod-img img');
    assert.ok(imgs.length >= 1, 'o funcionário B recebeu as próprias fotografias');
    for (const img of imgs) {
      const criada = E.criadas.find((c) => c.url === srcDe(img));
      assert.ok(criada, 'a fotografia veio de uma URL de objeto observada');
      assert.ok(Number(String(criada.tag).slice(1)) > chamadasDeA, `a fotografia ${criada.tag} é de uma requisição anterior (do funcionário A)`);
    }
  });

  test('[IMG-E5] imagens em voo do funcionário anterior NÃO seguram a identificação do próximo (não entram na barreira do atendimento)', async () => {
    const { t, E } = await abrir({ materiais: catalogo(5), regras: [{ modo: 'segurar' }] });
    await t.passar(2000);
    assert.ok(E.emVoo >= 1);
    await t.clicarEl(t.el('btnSair'));
    await t.identificar({ tipo: 'MATRICULA', valor: H.FUNCIONARIOS[1].matricula });
    assert.ok(t.telaAtual().includes('telaProdutos') || t.telaAtual().includes('telaAviso'), `tela: ${t.telaAtual()}`);
  });
});

// ═══════════════════ 13 e 14. sessão não renovada e fluxo preservado ═══════════════════
describe('[IMG-F] a sessão do funcionário e o pedido não são afetados pelas fotografias', () => {
  test('[IMG-F1] carregar imagens NÃO renova a sessão: nenhuma atividade é enviada e, sem ação do funcionário, a sessão acaba em 60 s', async () => {
    const { t, E, servidor } = await abrir({ materiais: catalogo(6) });
    await t.passar(30000);
    assert.ok(E.chamadas.length >= 1, 'houve carregamento de imagens');
    assert.equal(servidor.atividades, 0);
    assert.equal(servidor.contar(`POST ${H.BASE}/atendimento/atividade`), 0);
    await t.passar(31000);
    assert.ok(t.telaAtual().includes('telaAcesso'), `tela: ${t.telaAtual()}`);
  });

  test('[IMG-F2] [controle] com fotografias no catálogo, o fluxo de pedido segue igual: o corpo enviado tem só chaveIdempotencia e itens (sem campos de imagem) e o servidor não registra violações', async () => {
    const { t, servidor } = await abrir({ materiais: catalogo(3) });
    await t.passar(2000);
    await t.irARevisao([['Item 1', null], ['Item 2', null]]);
    await t.motivoParaTodos('DESGASTE_DANO');
    await t.enviar();
    const posts = t.pedidosPost();
    assert.equal(posts.length, 1);
    assert.deepEqual(Object.keys(posts[0].corpo).sort(), ['chaveIdempotencia', 'itens']);
    for (const item of posts[0].corpo.itens) assert.deepEqual(Object.keys(item).sort(), ['materialId', 'motivo', 'quantidade']);
    assert.deepEqual(servidor.violacoes, []);
    assert.ok(t.textoVisivel().includes(H.TEXTOS.confirmacao1));
  });

  test('[IMG-F3] [controle] a seleção de tamanhos e a navegação do detalhe continuam iguais com fotografia no detalhe', async () => {
    const materiais = [material(1, { nome: 'Item 1', exigeTamanho: true, tamanhos: ['P', 'M', 'G'] })];
    const { t } = await abrir({ materiais });
    await t.passar(2000);
    await t.abrirProduto('Item 1');
    await t.passar(2000);
    assert.deepEqual(t.tamanhos(), ['P', 'M', 'G']);
    await t.escolherTamanho('M');
    assert.equal(t.el('btnSolicitar').disabled, false);
    await t.clicarEl(t.el('btnVoltarProdutos'));
    assert.ok(t.telaAtual().includes('telaProdutos'));
  });
});
