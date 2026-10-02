'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Abre uma página do Portal ou do Painel Privado como o navegador abriria: lê
 * o HTML real, monta a árvore de elementos, aplica as regras de display das
 * folhas de estilo locais e executa, na ordem, os scripts da página (externos
 * locais e embutidos). O script oficial do Turnstile só é "carregado" pela URL
 * exata; qualquer outro script de fora faz o teste falhar. Rede, console,
 * storage, cookie, histórico, navegação e temporizadores são espiões: o teste
 * vê tudo o que a página tentou fazer, na ordem em que aconteceu.
 *
 * Limites conhecidos: sem layout, sem eventos de teclado, seletores só com
 * tag, #id, .classe, [atributo], descendente e filho direto.
 */

const RAIZ = path.join(__dirname, '..', '..');
const URL_TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SVG_NS = 'http://www.w3.org/2000/svg';
const COM_ESQUEMA = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

const AMBIENTES = {
  portal: { origem: 'http://localhost:5500', api: 'http://localhost:3000/api' },
  painel: { origem: 'http://localhost:5501', api: 'http://localhost:3000/api/plataforma' },
};

const VAZIOS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const TEXTO_BRUTO = new Set(['script', 'style']);
const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decodificar = (texto) => texto.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const codigo = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(codigo) ? String.fromCodePoint(codigo) : m;
  }
  return Object.hasOwn(ENTIDADES, e.toLowerCase()) ? ENTIDADES[e.toLowerCase()] : m;
});

const kebab = (camel) => camel.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// ───────────────────────── seletores ─────────────────────────

function lerComposto(texto) {
  const composto = { tag: null, id: null, classes: [], atributos: [], especificidade: 0 };
  let i = 0;
  const m = /^(\*|[a-zA-Z][\w-]*)/.exec(texto);
  if (m) {
    composto.tag = m[1] === '*' ? null : m[1].toLowerCase();
    if (composto.tag !== null) composto.especificidade += 1;
    i = m[1].length;
  }
  while (i < texto.length) {
    const resto = texto.slice(i);
    let r;
    if ((r = /^#([\w-]+)/.exec(resto))) {
      composto.id = r[1];
      composto.especificidade += 100;
    } else if ((r = /^\.([\w-]+)/.exec(resto))) {
      composto.classes.push(r[1]);
      composto.especificidade += 10;
    } else if ((r = /^\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/.exec(resto))) {
      composto.atributos.push({ nome: r[1].toLowerCase(), valor: r[2] ?? r[3] ?? r[4] ?? null });
      composto.especificidade += 10;
    } else {
      throw new Error(`seletor não suportado pelo harness: ${texto}`);
    }
    i += r[0].length;
  }
  return composto;
}

/** "a b > c" -> cadeia [{comb: null, c}, {comb: ' ', c}, {comb: '>', c}] */
function lerCadeia(texto) {
  const cadeia = [];
  let atual = '';
  let comb = null;
  let profundidade = 0;
  let aspas = null;
  const fechar = () => {
    if (atual !== '') cadeia.push({ comb, c: lerComposto(atual) });
    atual = '';
  };
  for (const ch of texto.trim()) {
    if (aspas) {
      atual += ch;
      if (ch === aspas) aspas = null;
    } else if (ch === '"' || ch === "'") {
      aspas = ch;
      atual += ch;
    } else if (ch === '[') {
      profundidade += 1;
      atual += ch;
    } else if (ch === ']') {
      profundidade -= 1;
      atual += ch;
    } else if (profundidade === 0 && (ch === ' ' || ch === '>')) {
      fechar();
      if (cadeia.length > 0) comb = ch === '>' ? '>' : (comb === '>' ? '>' : ' ');
    } else {
      atual += ch;
    }
  }
  fechar();
  assert.ok(cadeia.length > 0, `seletor vazio: ${texto}`);
  return cadeia;
}

function lerSeletor(texto) {
  const partes = [];
  let atual = '';
  let profundidade = 0;
  for (const ch of String(texto)) {
    if (ch === '[') profundidade += 1;
    if (ch === ']') profundidade -= 1;
    if (ch === ',' && profundidade === 0) {
      partes.push(atual);
      atual = '';
    } else {
      atual += ch;
    }
  }
  partes.push(atual);
  return partes.map(lerCadeia);
}

function combinaComposto(el, c) {
  if (el.nodeType !== 1) return false;
  if (c.tag !== null && el.localName !== c.tag) return false;
  if (c.id !== null && el.id !== c.id) return false;
  const classes = el.className.split(/\s+/).filter(Boolean);
  if (!c.classes.every((x) => classes.includes(x))) return false;
  return c.atributos.every((a) => (a.valor === null ? el.hasAttribute(a.nome) : el.getAttribute(a.nome) === a.valor));
}

function combinaCadeia(el, cadeia, i) {
  if (!combinaComposto(el, cadeia[i].c)) return false;
  if (i === 0) return true;
  if (cadeia[i].comb === '>') {
    const pai = el.parentElement;
    return pai !== null && combinaCadeia(pai, cadeia, i - 1);
  }
  for (let pai = el.parentElement; pai !== null; pai = pai.parentElement) {
    if (combinaCadeia(pai, cadeia, i - 1)) return true;
  }
  return false;
}

const combinaSeletor = (el, seletor) => lerSeletor(seletor).some((cadeia) => combinaCadeia(el, cadeia, cadeia.length - 1));

// ───────────────────────── nós ─────────────────────────

class No {
  constructor(documento) {
    this.ownerDocument = documento;
    this.parentNode = null;
  }

  get parentElement() { return this.parentNode !== null && this.parentNode.nodeType === 1 ? this.parentNode : null; }
}

class Texto extends No {
  constructor(documento, texto) {
    super(documento);
    this.nodeType = 3;
    this.dados = String(texto);
  }

  get textContent() { return this.dados; }

  set textContent(valor) { this.dados = String(valor); }
}

// Propriedade do DOM -> atributo HTML que ela reflete.
const ATRIBUTOS_REFLETIDOS = {
  href: 'href', src: 'src', name: 'name', title: 'title', placeholder: 'placeholder', autocomplete: 'autocomplete', inputMode: 'inputmode', target: 'target', rel: 'rel', role: 'role', lang: 'lang', action: 'action', method: 'method', htmlFor: 'for',
};

class Elemento extends No {
  constructor(documento, tag, ns = null) {
    super(documento);
    this.nodeType = 1;
    this.namespaceURI = ns;
    this.localName = ns === null ? tag.toLowerCase() : tag;
    this.tagName = ns === null ? tag.toUpperCase() : tag;
    this.atributos = {};
    this.filhos = [];
    this.ouvintes = {};
    this.style = {};
    this.valor = '';
    this.marcado = false;
  }

  get id() { return this.atributos.id ?? ''; }

  set id(v) { this.setAttribute('id', v); }

  get className() { return this.atributos.class ?? ''; }

  set className(v) { this.setAttribute('class', v); }

  get classList() {
    const el = this;
    const lista = () => el.className.split(/\s+/).filter(Boolean);
    const gravar = (novas) => { el.className = novas.join(' '); };
    return {
      add: (...c) => { const l = lista(); c.forEach((x) => { if (!l.includes(x)) l.push(x); }); gravar(l); },
      remove: (...c) => gravar(lista().filter((x) => !c.includes(x))),
      contains: (c) => lista().includes(c),
      toggle: (c, forcar) => {
        const tem = lista().includes(c);
        const quer = forcar === undefined ? !tem : Boolean(forcar);
        if (quer && !tem) gravar([...lista(), c]);
        if (!quer && tem) gravar(lista().filter((x) => x !== c));
        return quer;
      },
      toString: () => el.className,
    };
  }

  get dataset() {
    const el = this;
    return new Proxy({}, {
      get: (_, chave) => (typeof chave === 'string' ? el.getAttribute(`data-${kebab(chave)}`) ?? undefined : undefined),
      set: (_, chave, valor) => { el.setAttribute(`data-${kebab(chave)}`, valor); return true; },
      has: (_, chave) => typeof chave === 'string' && el.hasAttribute(`data-${kebab(chave)}`),
      deleteProperty: (_, chave) => { el.removeAttribute(`data-${kebab(chave)}`); return true; },
    });
  }

  get hidden() { return Object.hasOwn(this.atributos, 'hidden'); }

  set hidden(v) { if (v) this.atributos.hidden = ''; else delete this.atributos.hidden; }

  get disabled() { return Object.hasOwn(this.atributos, 'disabled'); }

  set disabled(v) { if (v) this.atributos.disabled = ''; else delete this.atributos.disabled; }

  get readOnly() { return Object.hasOwn(this.atributos, 'readonly'); }

  set readOnly(v) { if (v) this.atributos.readonly = ''; else delete this.atributos.readonly; }

  get required() { return Object.hasOwn(this.atributos, 'required'); }

  get value() { return this.valor; }

  set value(v) { this.valor = String(v); }

  get checked() { return this.marcado; }

  set checked(v) { this.marcado = Boolean(v); }

  get type() { return (this.atributos.type ?? (this.localName === 'button' ? 'submit' : 'text')).toLowerCase(); }

  set type(v) { this.setAttribute('type', v); }

  get maxLength() { return Object.hasOwn(this.atributos, 'maxlength') ? Number(this.atributos.maxlength) : -1; }

  setAttribute(nome, valor) { this.atributos[String(nome).toLowerCase()] = String(valor); }

  getAttribute(nome) { const n = String(nome).toLowerCase(); return Object.hasOwn(this.atributos, n) ? this.atributos[n] : null; }

  hasAttribute(nome) { return Object.hasOwn(this.atributos, String(nome).toLowerCase()); }

  removeAttribute(nome) { delete this.atributos[String(nome).toLowerCase()]; }

  toggleAttribute(nome, forcar) {
    const quer = forcar === undefined ? !this.hasAttribute(nome) : Boolean(forcar);
    if (quer) this.setAttribute(nome, ''); else this.removeAttribute(nome);
    return quer;
  }

  appendChild(no) {
    if (no.parentNode) no.parentNode.removeChild(no);
    no.parentNode = this;
    this.filhos.push(no);
    return no;
  }

  append(...nos) { nos.forEach((no) => this.appendChild(typeof no === 'string' ? new Texto(this.ownerDocument, no) : no)); }

  insertBefore(no, referencia) {
    if (referencia === null || referencia === undefined) return this.appendChild(no);
    if (no.parentNode) no.parentNode.removeChild(no);
    const i = this.filhos.indexOf(referencia);
    assert.notEqual(i, -1, 'insertBefore com referência que não é filha');
    no.parentNode = this;
    this.filhos.splice(i, 0, no);
    return no;
  }

  removeChild(no) {
    const i = this.filhos.indexOf(no);
    assert.notEqual(i, -1, 'removeChild de nó que não é filho');
    this.filhos.splice(i, 1);
    no.parentNode = null;
    return no;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  replaceChildren(...nos) {
    this.filhos.forEach((f) => { f.parentNode = null; });
    this.filhos = [];
    nos.forEach((no) => this.appendChild(typeof no === 'string' ? new Texto(this.ownerDocument, no) : no));
  }

  get firstChild() { return this.filhos[0] ?? null; }

  get lastChild() { return this.filhos[this.filhos.length - 1] ?? null; }

  get childNodes() { return this.filhos.slice(); }

  get children() { return this.filhos.filter((f) => f.nodeType === 1); }

  get textContent() { return this.filhos.map((f) => f.textContent).join(''); }

  set textContent(texto) {
    this.replaceChildren();
    if (String(texto) !== '') this.appendChild(new Texto(this.ownerDocument, texto));
  }

  get innerText() { return this.textContent; }

  set innerText(texto) { this.textContent = texto; }

  get innerHTML() { return ''; }

  set innerHTML(valor) {
    this.ownerDocument.usosDeInnerHTML.push({ id: this.id, valor: String(valor) });
    this.replaceChildren();
  }

  set outerHTML(valor) { this.ownerDocument.usosDeInnerHTML.push({ id: this.id, valor: String(valor), outer: true }); }

  get form() {
    for (let p = this.parentElement; p !== null; p = p.parentElement) if (p.localName === 'form') return p;
    return null;
  }

  get elements() { return this.querySelectorAll('input, select, textarea, button'); }

  contains(no) {
    for (let p = no; p; p = p.parentNode) if (p === this) return true;
    return false;
  }

  matches(seletor) { return combinaSeletor(this, seletor); }

  closest(seletor) {
    for (let p = this; p !== null; p = p.parentElement) if (combinaSeletor(p, seletor)) return p;
    return null;
  }

  querySelectorAll(seletor) {
    const cadeias = lerSeletor(seletor);
    const achados = [];
    const visitar = (no) => {
      for (const filho of no.filhos) {
        if (filho.nodeType !== 1) continue;
        if (cadeias.some((c) => combinaCadeia(filho, c, c.length - 1))) achados.push(filho);
        visitar(filho);
      }
    };
    visitar(this);
    return achados;
  }

  querySelector(seletor) { return this.querySelectorAll(seletor)[0] ?? null; }

  getElementsByTagName(tag) { return this.querySelectorAll(tag); }

  getElementsByClassName(classe) { return this.querySelectorAll(`.${classe}`); }

  getBoundingClientRect() {
    const largura = this.larguraDoLayout ?? this.ownerDocument.larguraPadrao;
    return { width: largura, height: 0, top: 0, left: 0, right: largura, bottom: 0 };
  }

  focus() { this.ownerDocument.activeElement = this; }

  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }

  select() { this.selecionado = true; }

  scrollIntoView() {}

  checkValidity() { return true; }

  reportValidity() { return true; }

  reset() {
    this.reinicios = (this.reinicios || 0) + 1;
    for (const campo of this.elements) {
      campo.valor = campo.atributos.value ?? '';
      campo.marcado = Object.hasOwn(campo.atributos, 'checked');
    }
  }

  requestSubmit() { return this.disparar('submit'); }

  click() { return this.disparar('click'); }

  addEventListener(tipo, fn) { (this.ouvintes[tipo] = this.ouvintes[tipo] || []).push(fn); }

  removeEventListener(tipo, fn) { this.ouvintes[tipo] = (this.ouvintes[tipo] || []).filter((f) => f !== fn); }

  /**
   * Dispara o evento no elemento, sobe pelos ancestrais e pelo documento (como
   * o navegador faz com submit, click, input e change) e, se ninguém cancelar,
   * executa a ação padrão: clique em botão de envio envia o formulário e
   * clique em caixa de marcação a alterna. Elemento desabilitado não recebe
   * clique.
   */
  async disparar(tipo, extra = {}) {
    const doc = this.ownerDocument;
    const evento = {
      type: tipo,
      target: this,
      currentTarget: this,
      bubbles: true,
      defaultPrevented: false,
      propagacaoParada: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagacaoParada = true; },
      ...extra,
    };
    if (tipo === 'click' && this.disabled) return evento;
    const caminho = [];
    for (let no = this; no !== null; no = no.parentElement) caminho.push(no);
    for (const no of caminho) {
      evento.currentTarget = no;
      for (const fn of (no.ouvintes[tipo] || []).slice()) await fn(evento);
      if (evento.propagacaoParada) break;
    }
    if (!evento.propagacaoParada) {
      evento.currentTarget = doc;
      for (const fn of (doc.ouvintes[tipo] || []).slice()) await fn(evento);
    }
    if (!evento.defaultPrevented) await this.acaoPadrao(tipo);
    return evento;
  }

  async acaoPadrao(tipo) {
    if (tipo === 'click') {
      if (this.localName === 'button' && ['submit', ''].includes(this.getAttribute('type') ?? 'submit') && this.form !== null) {
        const envio = await this.form.disparar('submit');
        if (!envio.defaultPrevented) this.ownerDocument.enviosNaoInterceptados.push(this.form.id);
      } else if (this.localName === 'input' && this.type === 'checkbox') {
        this.marcado = !this.marcado;
        await this.disparar('input');
        await this.disparar('change');
      }
    }
  }
}

for (const [propriedade, atributo] of Object.entries(ATRIBUTOS_REFLETIDOS)) {
  Object.defineProperty(Elemento.prototype, propriedade, {
    get() { return this.getAttribute(atributo) ?? ''; },
    set(valor) { this.setAttribute(atributo, valor); },
    configurable: true,
  });
}

// ───────────────────────── HTML ─────────────────────────

const REGEX_TAG = /<([a-zA-Z][^\s/>]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const REGEX_FIM = /<\/([a-zA-Z][^\s>]*)\s*>/y;
const REGEX_ATRIBUTO = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function atributosDe(texto) {
  const atributos = {};
  for (const m of texto.matchAll(REGEX_ATRIBUTO)) atributos[m[1].toLowerCase()] = decodificar(m[2] ?? m[3] ?? m[4] ?? '');
  return atributos;
}

function construirArvore(documento, html) {
  const raiz = new Elemento(documento, 'raiz');
  const pilha = [raiz];
  let i = 0;
  const n = html.length;
  const acrescentarTexto = (texto, bruto = false) => {
    if (texto === '') return;
    pilha[pilha.length - 1].appendChild(new Texto(documento, bruto ? texto : decodificar(texto)));
  };
  while (i < n) {
    if (html.startsWith('<!--', i)) {
      const fim = html.indexOf('-->', i + 4);
      i = fim === -1 ? n : fim + 3;
    } else if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const fim = html.indexOf('>', i);
      i = fim === -1 ? n : fim + 1;
    } else if (html.startsWith('</', i)) {
      REGEX_FIM.lastIndex = i;
      const m = REGEX_FIM.exec(html);
      if (m === null) { acrescentarTexto('<'); i += 1; continue; }
      const nome = m[1].toLowerCase();
      for (let k = pilha.length - 1; k > 0; k -= 1) {
        if (pilha[k].localName === nome) { pilha.length = k; break; }
      }
      i += m[0].length;
    } else if (html[i] === '<' && /[a-zA-Z]/.test(html[i + 1] ?? '')) {
      REGEX_TAG.lastIndex = i;
      const m = REGEX_TAG.exec(html);
      if (m === null) { acrescentarTexto('<'); i += 1; continue; }
      const el = new Elemento(documento, m[1], null);
      el.atributos = atributosDe(m[2]);
      el.valor = el.atributos.value ?? '';
      el.marcado = Object.hasOwn(el.atributos, 'checked');
      for (const d of (el.atributos.style ?? '').matchAll(/([a-z-]+)\s*:\s*([^;]+)/gi)) {
        el.style[d[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = d[2].trim();
      }
      pilha[pilha.length - 1].appendChild(el);
      i += m[0].length;
      if (TEXTO_BRUTO.has(el.localName) && m[3] === '') {
        const fim = html.toLowerCase().indexOf(`</${el.localName}`, i);
        const corpo = fim === -1 ? html.slice(i) : html.slice(i, fim);
        pilha.push(el);
        acrescentarTexto(corpo, true);
        pilha.pop();
        i = fim === -1 ? n : html.indexOf('>', fim) + 1;
      } else if (!VAZIOS.has(el.localName) && m[3] === '') {
        pilha.push(el);
      }
    } else {
      let fim = i + 1;
      while (fim < n && !(html[fim] === '<' && /[a-zA-Z/!?]/.test(html[fim + 1] ?? ''))) fim += 1;
      acrescentarTexto(html.slice(i, fim));
      i = fim;
    }
  }
  return raiz;
}

// ───────────────────────── CSS (só display) ─────────────────────────

function removerBlocosDeAtRegra(css) {
  let saida = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '@') {
      const abre = css.indexOf('{', i);
      const termina = css.indexOf(';', i);
      if (abre === -1 || (termina !== -1 && termina < abre)) { i = termina === -1 ? css.length : termina + 1; continue; }
      let profundidade = 1;
      let j = abre + 1;
      while (j < css.length && profundidade > 0) {
        if (css[j] === '{') profundidade += 1;
        if (css[j] === '}') profundidade -= 1;
        j += 1;
      }
      i = j;
    } else {
      saida += css[i];
      i += 1;
    }
  }
  return saida;
}

function regrasDeDisplay(css) {
  const limpo = removerBlocosDeAtRegra(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const regras = [];
  for (const m of limpo.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declaracoes = [...m[2].matchAll(/(?:^|;)\s*display\s*:\s*([a-z-]+)/gi)];
    if (declaracoes.length === 0) continue;
    const display = declaracoes[declaracoes.length - 1][1].toLowerCase();
    for (const parte of m[1].split(',')) {
      try {
        const [cadeia] = lerSeletor(parte);
        regras.push({ cadeia, display, especificidade: cadeia.reduce((s, p) => s + p.c.especificidade, 0), ordem: regras.length });
      } catch {
        // seletor que o harness não entende (pseudo-classe etc.): a regra é ignorada
      }
    }
  }
  return regras;
}

// ───────────────────────── abrirPagina ─────────────────────────

function turnstileFalso() {
  const t = {
    renders: [],
    resets: [],
    render(elemento, opcoes) { t.renders.push({ elemento, opcoes }); return `widget-${t.renders.length}`; },
    reset(id) { t.resets.push(id); },
    remove() {},
    getResponse() { return undefined; },
  };
  t.emitir = (evento, ...args) => t.renders[t.renders.length - 1].opcoes[evento](...args);
  return t;
}

function respostaHttp({ status = 200, corpo, texto }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (texto !== undefined ? texto : (corpo === undefined ? '' : JSON.stringify(corpo))),
  };
}

const existePagina = (rel) => fs.existsSync(path.join(RAIZ, rel));

function ler(rel) {
  const arquivo = path.join(RAIZ, rel);
  if (!fs.existsSync(arquivo)) assert.fail(`arquivo ainda não existe: ${rel}`);
  return fs.readFileSync(arquivo, 'utf8');
}

const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const semComentariosHtml = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/** Scripts da página, na ordem: { src } para externos e locais, { inline } para embutidos. */
function scriptsDe(html) {
  return [...semComentariosHtml(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[1]);
    return src ? { src: src[1] ?? src[2], atributos: m[1] } : { inline: m[2], atributos: m[1] };
  });
}

/** Arquivos locais carregados pela página (scripts com src e folhas de estilo), relativos a frontend/. */
function arquivosLocaisDe(rel, html = ler(rel)) {
  const dir = path.posix.dirname(rel);
  const referencias = [
    ...scriptsDe(html).filter((s) => s.src).map((s) => s.src),
    ...[...semComentariosHtml(html).matchAll(/<link\b[^>]*\bhref\s*=\s*"([^"]+)"/gi)].map((m) => m[1]),
  ];
  return referencias.filter((r) => !COM_ESQUEMA.test(r)).map((r) => path.posix.normalize(path.posix.join(dir, r.split(/[?#]/)[0])));
}

/**
 * @param {string} arquivoHtml caminho relativo a frontend/ (ex.: 'portal/index.html')
 * @param {object} [opcoes]
 * @param {object} [opcoes.rotas] 'METODO /caminho' (relativo à base da API) -> { status, corpo } | função(chamada) que a devolve (ou uma Promise dela) | Error
 * @param {string} [opcoes.hash] fragmento inicial da URL ('#token=...')
 * @param {string} [opcoes.search] query inicial ('?x=1')
 * @param {object|null} [opcoes.turnstile] null simula o script do Turnstile bloqueado; padrão: widget falso
 * @param {number} [opcoes.largura] largura do contêiner do widget (padrão 342)
 * @param {Function} [opcoes.transformar] altera um script só em memória, para provas por mutação
 * @param {string} [opcoes.html] HTML dado no lugar do arquivo (controle do próprio harness)
 * @param {object} [opcoes.arquivos] conteúdo de scripts e folhas dado no lugar do disco
 */
function abrirPagina(arquivoHtml, opcoes = {}) {
  const {
    rotas = {}, hash = '', search = '', transformar = null, html: htmlDado, arquivos: arquivosDados = {}, largura = 342,
  } = opcoes;
  const turnstile = Object.hasOwn(opcoes, 'turnstile') ? opcoes.turnstile : turnstileFalso();
  const painel = arquivoHtml.startsWith('painel-privado/');
  const { origem, api } = painel ? AMBIENTES.painel : AMBIENTES.portal;
  const caminhoHtml = path.join(RAIZ, arquivoHtml);
  if (htmlDado === undefined) assert.ok(fs.existsSync(caminhoHtml), `a página ${arquivoHtml} ainda não existe`);
  const html = htmlDado !== undefined ? htmlDado : fs.readFileSync(caminhoHtml, 'utf8');

  const documento = {
    usosDeInnerHTML: [],
    enviosNaoInterceptados: [],
    activeElement: null,
    ouvintes: {},
    readyState: 'loading',
    referrer: '',
    larguraPadrao: largura,
  };
  const raiz = construirArvore(documento, html);
  documento.raiz = raiz;
  documento.documentElement = raiz.children.find((e) => e.localName === 'html') ?? raiz;
  documento.getElementById = (id) => raiz.querySelector(`[id="${String(id).replace(/"/g, '')}"]`);
  documento.querySelector = (s) => raiz.querySelector(s);
  documento.querySelectorAll = (s) => raiz.querySelectorAll(s);
  documento.getElementsByTagName = (t) => raiz.querySelectorAll(t);
  documento.getElementsByClassName = (c) => raiz.querySelectorAll(`.${c}`);
  documento.createElement = (tag) => new Elemento(documento, tag);
  documento.createElementNS = (ns, tag) => new Elemento(documento, tag, ns);
  documento.createTextNode = (texto) => new Texto(documento, texto);
  documento.addEventListener = (tipo, fn) => { (documento.ouvintes[tipo] = documento.ouvintes[tipo] || []).push(fn); };
  documento.removeEventListener = (tipo, fn) => { documento.ouvintes[tipo] = (documento.ouvintes[tipo] || []).filter((f) => f !== fn); };
  Object.defineProperty(documento, 'body', { get: () => raiz.querySelector('body') });
  Object.defineProperty(documento, 'head', { get: () => raiz.querySelector('head') });
  Object.defineProperty(documento, 'title', {
    get: () => raiz.querySelector('title')?.textContent ?? '',
    set: (v) => { const t = raiz.querySelector('title'); if (t) t.textContent = v; },
  });

  const chamadas = [];
  const externas = [];
  const consoleChamadas = [];
  const navegacoes = [];
  const copiados = [];
  const storage = [];
  const cookiesEscritos = [];
  const historico = [];
  const eventos = [];
  const alertas = [];
  const eventosDaJanela = {};
  const temporizadores = [];
  let proximoTemporizador = 1;

  Object.defineProperty(documento, 'cookie', {
    get: () => { storage.push({ storage: 'cookie', operacao: 'leitura' }); return ''; },
    set: (v) => { cookiesEscritos.push(String(v)); storage.push({ storage: 'cookie', operacao: 'escrita' }); },
  });

  const estado = { pathname: painel ? `/${arquivoHtml.replace(/^painel-privado\//, '')}` : `/${arquivoHtml}`, search, hash };
  const navegar = (destino) => { navegacoes.push(String(destino)); eventos.push({ tipo: 'navegacao', destino: String(destino) }); };
  const atualizarUrl = (url) => {
    if (url === undefined || url === null) return;
    const alvo = new URL(String(url), `${origem}${estado.pathname}${estado.search}`);
    estado.pathname = alvo.pathname;
    estado.search = alvo.search;
    estado.hash = alvo.hash;
  };
  const location = {
    hostname: 'localhost',
    host: new URL(origem).host,
    port: new URL(origem).port,
    protocol: 'http:',
    origin: origem,
    get pathname() { return estado.pathname; },
    set pathname(v) { estado.pathname = String(v); },
    get search() { return estado.search; },
    set search(v) { estado.search = String(v); },
    get hash() { return estado.hash; },
    set hash(v) { estado.hash = v === '' || String(v).startsWith('#') ? String(v) : `#${v}`; },
    get href() { return navegacoes.length > 0 ? navegacoes[navegacoes.length - 1] : `${origem}${estado.pathname}${estado.search}${estado.hash}`; },
    set href(destino) { navegar(destino); },
    assign(destino) { navegar(destino); },
    replace(destino) { navegar(destino); },
    reload() { navegar('(reload)'); },
    toString() { return this.href; },
  };

  const registrarConsole = (nivel) => (...args) => {
    consoleChamadas.push({ nivel, texto: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
  };
  const espiaoDeStorage = (nome) => ({
    getItem(chave) { storage.push({ storage: nome, operacao: 'getItem', chave: String(chave) }); return null; },
    setItem(chave, valor) { storage.push({ storage: nome, operacao: 'setItem', chave: String(chave), valor: String(valor) }); },
    removeItem(chave) { storage.push({ storage: nome, operacao: 'removeItem', chave: String(chave) }); },
    clear() { storage.push({ storage: nome, operacao: 'clear' }); },
  });

  const sandbox = {
    document: documento,
    location,
    console: { log: registrarConsole('log'), info: registrarConsole('info'), warn: registrarConsole('warn'), error: registrarConsole('error'), debug: registrarConsole('debug') },
    navigator: { userAgent: 'Navegador de Teste', clipboard: { writeText: async (texto) => { copiados.push(String(texto)); } } },
    localStorage: espiaoDeStorage('localStorage'),
    sessionStorage: espiaoDeStorage('sessionStorage'),
    history: {
      length: 1,
      state: null,
      pushState: (e, t, u) => { historico.push({ metodo: 'pushState', estado: e, titulo: t, url: u }); eventos.push({ tipo: 'pushState' }); atualizarUrl(u); },
      replaceState: (e, t, u) => { historico.push({ metodo: 'replaceState', estado: e, titulo: t, url: u }); eventos.push({ tipo: 'replaceState' }); atualizarUrl(u); },
      back: () => historico.push({ metodo: 'back' }),
      forward: () => historico.push({ metodo: 'forward' }),
      go: () => historico.push({ metodo: 'go' }),
    },
    URL,
    URLSearchParams,
    TextEncoder,
    alert: (m) => { alertas.push(String(m)); },
    setTimeout: (fn, ms = 0, ...args) => { const id = proximoTemporizador; proximoTemporizador += 1; temporizadores.push({ id, fn, ms: Number(ms) || 0, args }); return id; },
    clearTimeout: (id) => { const i = temporizadores.findIndex((t) => t.id === id); if (i !== -1) temporizadores.splice(i, 1); },
    setInterval: (fn, ms = 0, ...args) => { const id = proximoTemporizador; proximoTemporizador += 1; temporizadores.push({ id, fn, ms: Number(ms) || 0, args, repetir: true }); return id; },
    clearInterval: (id) => { const i = temporizadores.findIndex((t) => t.id === id); if (i !== -1) temporizadores.splice(i, 1); },
    addEventListener(tipo, fn) { (eventosDaJanela[tipo] = eventosDaJanela[tipo] || []).push(fn); },
    removeEventListener(tipo, fn) { eventosDaJanela[tipo] = (eventosDaJanela[tipo] || []).filter((f) => f !== fn); },
    async fetch(destino, opcoesFetch = {}) {
      const alvo = String(destino);
      if (!alvo.startsWith(`${api}/`)) {
        externas.push(alvo);
        throw new Error('rede externa bloqueada no teste');
      }
      const url = new URL(alvo);
      const caminho = url.pathname.slice(new URL(api).pathname.length);
      const chamada = {
        chave: `${opcoesFetch.method} ${caminho}`,
        metodo: opcoesFetch.method,
        caminho,
        url: alvo,
        corpoBruto: opcoesFetch.body ?? null,
        corpo: opcoesFetch.body === undefined ? null : JSON.parse(opcoesFetch.body),
        credentials: opcoesFetch.credentials,
        cabecalhos: { ...(opcoesFetch.headers || {}) },
        temQuery: alvo.includes('?'),
      };
      chamadas.push(chamada);
      eventos.push({ tipo: 'fetch', chave: chamada.chave });
      let r = rotas[chamada.chave];
      if (typeof r === 'function') r = await r(chamada);
      if (r instanceof Error) throw r;
      if (r === undefined) return respostaHttp({ status: 404, corpo: { status: 'error', codigo: 'NAO_ENCONTRADO', message: 'Recurso não encontrado' } });
      return respostaHttp(r);
    },
  };
  Object.defineProperty(sandbox, 'indexedDB', { get: () => { storage.push({ storage: 'indexedDB', operacao: 'acesso' }); return undefined; }, configurable: true });
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const contexto = vm.createContext(sandbox);

  // ── folhas de estilo locais e embutidas: só as regras de display
  const lerLocal = (relativo) => {
    if (Object.hasOwn(arquivosDados, relativo)) return arquivosDados[relativo];
    const arquivo = path.join(RAIZ, relativo);
    assert.ok(arquivo.startsWith(RAIZ + path.sep), `arquivo fora de frontend/: ${relativo}`);
    assert.ok(fs.existsSync(arquivo), `${arquivoHtml} referencia ${relativo}, que não existe`);
    return fs.readFileSync(arquivo, 'utf8');
  };
  const dirHtml = path.posix.dirname(arquivoHtml);
  const css = [
    ...raiz.querySelectorAll('style').map((s) => s.textContent),
    ...raiz.querySelectorAll('link[rel="stylesheet"]').map((l) => {
      const href = l.getAttribute('href') ?? '';
      return COM_ESQUEMA.test(href) ? '' : lerLocal(path.posix.normalize(path.posix.join(dirHtml, href.split(/[?#]/)[0])));
    }),
  ].join('\n');
  const regras = regrasDeDisplay(css);

  /**
   * O atributo hidden é só a folha do navegador: um display do autor (inline ou
   * de uma regra que case com o elemento) vale mais que ele, como no navegador
   * de verdade. Por isso `.caixa { display: flex }` desfaz o hidden de uma
   * .caixa, a menos que exista uma regra `.caixa[hidden] { display: none }`.
   */
  function displayDe(el) {
    if (typeof el.style.display === 'string' && el.style.display !== '') return el.style.display;
    let melhor = null;
    for (const regra of regras) {
      if (!combinaCadeia(el, regra.cadeia, regra.cadeia.length - 1)) continue;
      if (melhor === null || regra.especificidade > melhor.especificidade || (regra.especificidade === melhor.especificidade && regra.ordem > melhor.ordem)) melhor = regra;
    }
    if (melhor !== null) return melhor.display;
    return el.hidden ? 'none' : 'block';
  }
  const visivelNo = (el) => { for (let n = el; n !== null && n.nodeType === 1; n = n.parentElement) if (displayDe(n) === 'none') return false; return true; };

  // ── scripts, na ordem do documento
  const scripts = [];
  for (const el of raiz.querySelectorAll('script')) {
    const src = el.getAttribute('src');
    assert.notEqual(el.getAttribute('type'), 'module', 'script type=module não é suportado pelo harness');
    if (src === null) {
      vm.runInContext(el.textContent, contexto, { filename: `${arquivoHtml}#embutido` });
      continue;
    }
    scripts.push(src);
    if (COM_ESQUEMA.test(src)) {
      externas.push(src);
      assert.equal(src, URL_TURNSTILE, `script de fora da aplicação: ${src}`);
      if (turnstile !== null) sandbox.turnstile = turnstile;
      continue;
    }
    const relativo = path.posix.normalize(path.posix.join(dirHtml, src.split(/[?#]/)[0]));
    const codigo = lerLocal(relativo);
    vm.runInContext(transformar ? transformar(relativo, codigo) : codigo, contexto, { filename: path.join(RAIZ, relativo) });
  }
  documento.readyState = 'complete';
  for (const fn of (documento.ouvintes.DOMContentLoaded || []).slice()) fn({ type: 'DOMContentLoaded' });
  for (const fn of (eventosDaJanela.load || []).slice()) fn({ type: 'load' });

  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => { setImmediate(r); }); };
  const el = (id) => {
    const elemento = documento.getElementById(id);
    assert.ok(elemento, `${arquivoHtml} não tem o elemento #${id}`);
    return elemento;
  };
  const nos = (no, saida = []) => {
    saida.push(no);
    for (const f of no.filhos ?? []) nos(f, saida);
    return saida;
  };
  const todosOsNos = () => nos(raiz);

  return {
    html,
    scripts,
    documento,
    janela: sandbox,
    turnstile,
    api,
    origem,
    chamadas,
    externas,
    consoleChamadas,
    navegacoes,
    copiados,
    storage,
    cookiesEscritos,
    historico,
    eventos,
    alertas,
    enviosNaoInterceptados: documento.enviosNaoInterceptados,
    esperar,
    el,
    existe: (id) => documento.getElementById(id) !== null,
    foco: () => documento.activeElement?.id ?? null,
    visivel: (id) => visivelNo(el(id)),
    visivelNo,
    location,
    texto: (id) => el(id).textContent,
    consulta: (seletor) => documento.querySelectorAll(seletor),
    /** Etapas (data-etapa) visíveis, considerando também o contêiner. */
    etapasVisiveis: () => documento.querySelectorAll('[data-etapa]').filter(visivelNo).map((e) => e.getAttribute('data-etapa')),
    /** Tudo o que está no DOM: atributos, textos e valores dos campos; sem o código dos scripts e das folhas. */
    textoDoDom: () => todosOsNos().filter((n) => !(n.nodeType === 3 && n.parentNode && TEXTO_BRUTO.has(n.parentNode.localName))).map((n) => (n.nodeType === 3
      ? n.textContent
      : `${n.localName} ${Object.entries(n.atributos).map(([k, v]) => `${k}=${v}`).join(' ')} ${n.valor ?? ''}`)).join('\n'),
    async digitar(id, texto) {
      el(id).value = String(texto);
      await el(id).disparar('input');
    },
    async enviar(id) {
      const evento = await el(id).disparar('submit');
      assert.equal(evento.defaultPrevented, true, `o envio de #${id} recarregaria a página`);
      await esperar();
    },
    /** Dispara sem esperar a rede: para observar o estado com a requisição pendente. */
    enviarSemEsperar: (id) => el(id).disparar('submit'),
    async clicar(id) {
      const evento = await el(id).disparar('click');
      await esperar();
      return evento;
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
    temporizadoresPendentes: () => temporizadores.map((t) => ({ id: t.id, ms: t.ms, repetir: Boolean(t.repetir) })),
    /** Executa os temporizadores pendentes com atraso até `ms` (todos, se omitido), do menor para o maior. */
    async avancar(ms = Infinity) {
      const vencidos = temporizadores.filter((t) => t.ms <= ms).sort((a, b) => a.ms - b.ms || a.id - b.id);
      for (const t of vencidos) {
        if (!t.repetir) temporizadores.splice(temporizadores.indexOf(t), 1);
        await t.fn(...t.args);
      }
      await esperar();
    },
  };
}

module.exports = {
  abrirPagina, turnstileFalso, existePagina, ler, semComentarios, semComentariosHtml, scriptsDe, arquivosLocaisDe, RAIZ, SVG_NS, URL_TURNSTILE, COM_ESQUEMA,
};
