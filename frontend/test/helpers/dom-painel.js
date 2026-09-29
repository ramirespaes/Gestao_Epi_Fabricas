'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Abre uma página do Painel Privado como o navegador abriria: lê o HTML
 * real, cria os elementos que têm id e executa, na ordem, os scripts que a
 * página referencia. Rede, console, storage, área de transferência e
 * navegação são espiões: o teste vê tudo o que a página tentou fazer.
 */

const RAIZ = path.join(__dirname, '..', '..');
const API = 'http://localhost:3000/api/plataforma';
const SVG_NS = 'http://www.w3.org/2000/svg';

class Texto {
  constructor(texto) {
    this.nodeType = 3;
    this.parentNode = null;
    this.textContent = String(texto);
  }
}

class Elemento {
  constructor(documento, tag, ns = null) {
    this.nodeType = 1;
    this.ownerDocument = documento;
    this.namespaceURI = ns;
    this.tagName = ns === null ? tag.toUpperCase() : tag;
    this.atributos = {};
    this.filhos = [];
    this.parentNode = null;
    this.ouvintes = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.style = {};
  }

  get id() { return this.atributos.id ?? ''; }

  get hidden() { return Object.hasOwn(this.atributos, 'hidden'); }

  set hidden(valor) {
    if (valor) this.atributos.hidden = '';
    else delete this.atributos.hidden;
  }

  setAttribute(nome, valor) { this.atributos[nome] = String(valor); }

  getAttribute(nome) { return Object.hasOwn(this.atributos, nome) ? this.atributos[nome] : null; }

  hasAttribute(nome) { return Object.hasOwn(this.atributos, nome); }

  removeAttribute(nome) { delete this.atributos[nome]; }

  appendChild(no) {
    if (no.parentNode) no.parentNode.removeChild(no);
    no.parentNode = this;
    this.filhos.push(no);
    return no;
  }

  removeChild(no) {
    const i = this.filhos.indexOf(no);
    assert.notEqual(i, -1, 'removeChild de nó que não é filho');
    this.filhos.splice(i, 1);
    no.parentNode = null;
    return no;
  }

  replaceChildren(...nos) {
    for (const f of this.filhos) f.parentNode = null;
    this.filhos = [];
    for (const no of nos) this.appendChild(no);
  }

  get firstChild() { return this.filhos[0] ?? null; }

  get childNodes() { return this.filhos.slice(); }

  get children() { return this.filhos.filter((f) => f.nodeType === 1); }

  get textContent() { return this.filhos.map((f) => f.textContent).join(''); }

  set textContent(texto) {
    this.replaceChildren();
    if (String(texto) !== '') this.appendChild(new Texto(texto));
  }

  get innerHTML() { return ''; }

  set innerHTML(valor) {
    this.ownerDocument.usosDeInnerHTML.push({ id: this.id, valor: String(valor) });
    this.replaceChildren();
  }

  focus() { this.ownerDocument.activeElement = this; }

  reset() { this.reinicios = (this.reinicios || 0) + 1; }

  addEventListener(tipo, fn) { (this.ouvintes[tipo] = this.ouvintes[tipo] || []).push(fn); }

  removeEventListener(tipo, fn) { this.ouvintes[tipo] = (this.ouvintes[tipo] || []).filter((f) => f !== fn); }

  async disparar(tipo, extra = {}) {
    const evento = { type: tipo, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of (this.ouvintes[tipo] || []).slice()) await fn(evento);
    return evento;
  }
}

function atributosDe(texto) {
  const atributos = {};
  for (const m of texto.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)) atributos[m[1]] = m[2] ?? '';
  return atributos;
}

function criarDocumento(html) {
  const documento = {
    porId: new Map(),
    activeElement: null,
    usosDeInnerHTML: [],
    getElementById(id) { return documento.porId.get(id) ?? null; },
    createElement(tag) { return new Elemento(documento, tag); },
    createElementNS(ns, tag) { return new Elemento(documento, tag, ns); },
    createTextNode(texto) { return new Texto(texto); },
  };
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*\bid="[^"]+"[^<>]*)>(?:([^<]*)<\/\1>)?/g)) {
    const elemento = new Elemento(documento, m[1]);
    elemento.atributos = atributosDe(m[2]);
    elemento.disabled = Object.hasOwn(elemento.atributos, 'disabled');
    if (m[3] !== undefined && m[3].trim() !== '') elemento.textContent = m[3].trim();
    assert.equal(documento.porId.has(elemento.id), false, `id duplicado na página: ${elemento.id}`);
    documento.porId.set(elemento.id, elemento);
  }
  return documento;
}

function espiaoDeStorage(nome, usos) {
  return {
    getItem(chave) { usos.push({ storage: nome, operacao: 'getItem', chave: String(chave) }); return null; },
    setItem(chave, valor) { usos.push({ storage: nome, operacao: 'setItem', chave: String(chave), valor: String(valor) }); },
    removeItem(chave) { usos.push({ storage: nome, operacao: 'removeItem', chave: String(chave) }); },
    clear() { usos.push({ storage: nome, operacao: 'clear' }); },
  };
}

function respostaHttp({ status = 200, corpo, texto }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (texto !== undefined ? texto : (corpo === undefined ? '' : JSON.stringify(corpo))),
  };
}

/**
 * @param {string} arquivoHtml caminho relativo a frontend/
 * @param {{rotas?: object, transformar?: Function}} opcoes rotas:
 *   'METODO /caminho' -> resposta ({status, corpo}), função que a devolve
 *   (ou uma Promise dela) ou Error para falha de rede. transformar(src,
 *   codigo) altera um script só em memória, para provas por mutação.
 */
function abrirPagina(arquivoHtml, { rotas = {}, transformar = null } = {}) {
  const caminhoHtml = path.join(RAIZ, arquivoHtml);
  assert.ok(fs.existsSync(caminhoHtml), `a página ${arquivoHtml} ainda não existe`);
  const html = fs.readFileSync(caminhoHtml, 'utf8');
  const documento = criarDocumento(html);

  const chamadas = [];
  const externas = [];
  const consoleChamadas = [];
  const navegacoes = [];
  const copiados = [];
  const storage = [];
  const historico = [];
  const eventosDaJanela = {};
  const url = `http://localhost:5501/${arquivoHtml.replace(/^painel-privado\//, '')}`;

  const location = {
    hostname: 'localhost',
    origin: 'http://localhost:5501',
    pathname: new URL(url).pathname,
    search: '',
    hash: '',
    get href() { return navegacoes.length > 0 ? navegacoes[navegacoes.length - 1] : url; },
    set href(destino) { navegacoes.push(String(destino)); },
    assign(destino) { navegacoes.push(String(destino)); },
    replace(destino) { navegacoes.push(String(destino)); },
    reload() { navegacoes.push('(reload)'); },
  };

  const registrarConsole = (nivel) => (...args) => { consoleChamadas.push({ nivel, texto: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') }); };

  const sandbox = {
    document: documento,
    location,
    console: { log: registrarConsole('log'), info: registrarConsole('info'), warn: registrarConsole('warn'), error: registrarConsole('error'), debug: registrarConsole('debug') },
    navigator: { clipboard: { writeText: async (texto) => { copiados.push(String(texto)); } } },
    localStorage: espiaoDeStorage('localStorage', storage),
    sessionStorage: espiaoDeStorage('sessionStorage', storage),
    history: {
      pushState: (...a) => historico.push(['pushState', ...a.map(String)]),
      replaceState: (...a) => historico.push(['replaceState', ...a.map(String)]),
      back: () => historico.push(['back']),
      go: () => historico.push(['go']),
    },
    setTimeout,
    clearTimeout,
    addEventListener(tipo, fn) { (eventosDaJanela[tipo] = eventosDaJanela[tipo] || []).push(fn); },
    removeEventListener(tipo, fn) { eventosDaJanela[tipo] = (eventosDaJanela[tipo] || []).filter((f) => f !== fn); },
    async fetch(destino, opcoes = {}) {
      const alvo = String(destino);
      if (!alvo.startsWith(`${API}/`)) {
        externas.push(alvo);
        throw new Error('rede externa bloqueada no teste');
      }
      const caminho = new URL(alvo).pathname.replace(/^\/api\/plataforma/, '');
      const chamada = {
        chave: `${opcoes.method} ${caminho}`,
        corpoBruto: opcoes.body ?? null,
        corpo: opcoes.body === undefined ? null : JSON.parse(opcoes.body),
        credentials: opcoes.credentials,
        temQuery: alvo.includes('?'),
      };
      chamadas.push(chamada);
      let r = rotas[chamada.chave];
      if (typeof r === 'function') r = await r(chamada);
      if (r instanceof Error) throw r;
      if (r === undefined) return respostaHttp({ status: 404, corpo: { status: 'error', codigo: 'NAO_ENCONTRADO', message: 'Recurso não encontrado' } });
      return respostaHttp(r);
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const contexto = vm.createContext(sandbox);

  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g)].map((m) => m[1]);
  for (const src of scripts) {
    assert.equal(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src), false, `script de fora da aplicação: ${src}`);
    const arquivo = path.resolve(path.dirname(caminhoHtml), src.split('?')[0]);
    assert.ok(arquivo.startsWith(RAIZ + path.sep), `script fora de frontend/: ${src}`);
    assert.ok(fs.existsSync(arquivo), `${arquivoHtml} referencia ${src}, que não existe`);
    const codigo = fs.readFileSync(arquivo, 'utf8');
    vm.runInContext(transformar ? transformar(src.split('?')[0], codigo) : codigo, contexto, { filename: arquivo });
  }

  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => { setImmediate(r); }); };
  const el = (id) => {
    const elemento = documento.getElementById(id);
    assert.ok(elemento, `${arquivoHtml} não tem o elemento #${id}`);
    return elemento;
  };

  function nos(raiz, saida = []) {
    saida.push(raiz);
    for (const f of raiz.filhos ?? []) nos(f, saida);
    return saida;
  }
  const todosOsNos = () => [...documento.porId.values()].flatMap((e) => nos(e));

  return {
    html,
    scripts,
    documento,
    janela: sandbox,
    chamadas,
    externas,
    consoleChamadas,
    navegacoes,
    copiados,
    storage,
    historico,
    esperar,
    el,
    existe: (id) => documento.getElementById(id) !== null,
    foco: () => documento.activeElement?.id ?? null,
    /** Etapas (data-etapa) que não estão ocultas. */
    etapasVisiveis: () => [...documento.porId.values()].filter((e) => e.hasAttribute('data-etapa') && !e.hidden).map((e) => e.getAttribute('data-etapa')),
    /** Tudo o que está no DOM: atributos, textos e valores dos campos. */
    textoDoDom: () => todosOsNos().map((n) => (n.nodeType === 3
      ? n.textContent
      : `${Object.entries(n.atributos).map(([k, v]) => `${k}=${v}`).join(' ')} ${n.value ?? ''}`)).join('\n'),
    async digitar(id, texto) {
      el(id).value = String(texto);
      await el(id).disparar('input');
    },
    async colar(id, texto) {
      const evento = await el(id).disparar('paste', { clipboardData: { getData: () => String(texto) } });
      if (!evento.defaultPrevented) {
        const limite = Number(el(id).getAttribute('maxlength') ?? Infinity);
        el(id).value = (el(id).value + String(texto)).slice(0, limite);
        await el(id).disparar('input');
      }
    },
    async enviar(id) {
      const evento = await el(id).disparar('submit');
      assert.equal(evento.defaultPrevented, true, `o envio de #${id} recarregaria a página`);
      await esperar();
    },
    /** Dispara sem esperar a rede: para observar o estado com a requisição pendente. */
    enviarSemEsperar: (id) => el(id).disparar('submit'),
    async clicar(id) {
      assert.equal(el(id).disabled, false, `#${id} está desabilitado`);
      await el(id).disparar('click');
      await esperar();
    },
    async marcar(id, valor = true) {
      el(id).checked = valor;
      await el(id).disparar('change');
    },
    async eventoDaJanela(tipo, evento = {}) {
      const resultados = [];
      for (const fn of (eventosDaJanela[tipo] || []).slice()) resultados.push(await fn({ type: tipo, preventDefault() { this.defaultPrevented = true; }, ...evento }));
      await esperar();
      return resultados;
    },
    ouvintesDaJanela: (tipo) => (eventosDaJanela[tipo] || []).length,
  };
}

module.exports = { abrirPagina, RAIZ, API, SVG_NS };
