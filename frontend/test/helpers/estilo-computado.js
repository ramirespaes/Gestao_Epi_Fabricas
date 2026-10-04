'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Estilo computado de um elemento de uma página aberta por dom-pagina.js: a
 * cascata real das folhas da página (o <style> embutido e os CSS locais, na
 * ordem do documento) sobre a árvore real, para as propriedades pedidas. Existe
 * porque o harness de DOM só calcula `display`, e o teste de aparência precisa
 * do valor que vence de fato, não da presença de uma regra no arquivo.
 *
 * Subconjunto suportado (o que fica fora é ignorado, como faria um navegador
 * com uma regra que não casa):
 *   - seletores com tag, #id, .classe, [atributo], [atributo="valor"],
 *     descendente, filho direto, :root, :disabled, e :hover/:focus só quando
 *     pedidos em `estado`;
 *   - cascata: !important, estilo inline, especificidade e ordem de origem;
 *   - var(--x) resolvido pelas propriedades personalizadas do elemento raiz
 *     (claro, ou escuro com data-theme="dark");
 *   - herança de color e cursor;
 *   - blocos @media e afins são ignorados (largura padrão do harness).
 */

const RAIZ = path.join(__dirname, '..', '..');
const HERDADAS = new Set(['color', 'cursor']);

function removerAtRegras(css) {
  let saida = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '@') {
      const abre = css.indexOf('{', i);
      const fimDeclaracao = css.indexOf(';', i);
      if (abre === -1 || (fimDeclaracao !== -1 && fimDeclaracao < abre)) { i = fimDeclaracao === -1 ? css.length : fimDeclaracao + 1; continue; }
      let nivel = 0;
      let j = abre;
      for (; j < css.length; j += 1) {
        if (css[j] === '{') nivel += 1;
        if (css[j] === '}') { nivel -= 1; if (nivel === 0) break; }
      }
      i = j + 1;
      continue;
    }
    saida += css[i];
    i += 1;
  }
  return saida;
}

function lerComposto(texto) {
  const c = { tag: null, id: null, classes: [], atributos: [], pseudos: [], esp: 0 };
  let resto = texto;
  const t = /^(\*|[a-zA-Z][\w-]*)/.exec(resto);
  if (t) {
    if (t[1] !== '*') { c.tag = t[1].toLowerCase(); c.esp += 1; }
    resto = resto.slice(t[1].length);
  }
  while (resto.length > 0) {
    let m;
    if ((m = /^#([\w-]+)/.exec(resto))) { c.id = m[1]; c.esp += 100; } else if ((m = /^\.([\w-]+)/.exec(resto))) { c.classes.push(m[1]); c.esp += 10; } else if ((m = /^\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/.exec(resto))) {
      c.atributos.push({ nome: m[1].toLowerCase(), valor: m[2] ?? m[3] ?? m[4] ?? null }); c.esp += 10;
    } else if ((m = /^:(root|disabled|hover|focus)\b/.exec(resto))) { c.pseudos.push(m[1]); c.esp += 10; } else {
      throw new Error(`seletor fora do subconjunto: ${texto}`);
    }
    resto = resto.slice(m[0].length);
  }
  return c;
}

function lerCadeia(texto) {
  const partes = texto.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const cadeia = [];
  let comb = null;
  for (const p of partes) {
    if (p === '>') { comb = '>'; continue; }
    cadeia.push({ comb, c: lerComposto(p) });
    comb = ' ';
  }
  return cadeia;
}

function casaComposto(el, c, estado) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  const classes = (el.getAttribute('class') || '').split(/\s+/);
  if (!c.classes.every((k) => classes.includes(k))) return false;
  for (const a of c.atributos) {
    const v = el.getAttribute(a.nome);
    if (v === null || (a.valor !== null && v !== a.valor)) return false;
  }
  for (const p of c.pseudos) {
    if (p === 'root' && el !== estado.raiz) return false;
    if (p === 'disabled' && !(el.getAttribute('disabled') !== null && ['button', 'input', 'select', 'textarea'].includes(el.localName))) return false;
    if (p === 'hover' && !estado.hover) return false;
    if (p === 'focus' && !estado.focus) return false;
  }
  return true;
}

function casaCadeia(el, cadeia, i, estado) {
  if (!casaComposto(el, cadeia[i].c, estado)) return false;
  if (i === 0) return true;
  if (cadeia[i].comb === '>') return casaCadeia(el.parentElement, cadeia, i - 1, estado);
  for (let p = el.parentElement; p; p = p.parentElement) if (casaCadeia(p, cadeia, i - 1, estado)) return true;
  return false;
}

/** As regras da página, na ordem do documento: <style> embutidos e CSS locais. */
function regrasDaPagina(pg, arquivoHtml) {
  const dir = path.posix.dirname(arquivoHtml);
  const folhas = [];
  for (const m of pg.html.matchAll(/<style>([\s\S]*?)<\/style>|<link rel="stylesheet" href="([^"]+)">/g)) {
    if (m[1] !== undefined) folhas.push(m[1]);
    else if (!/^https?:/.test(m[2])) folhas.push(fs.readFileSync(path.join(RAIZ, path.posix.normalize(path.posix.join(dir, m[2]))), 'utf8'));
  }
  const regras = [];
  const css = removerAtRegras(folhas.join('\n').replace(/\/\*[\s\S]*?\*\//g, ''));
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declaracoes = m[2].split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const k = d.indexOf(':');
      const valor = d.slice(k + 1).trim();
      return { prop: d.slice(0, k).trim().toLowerCase(), valor: valor.replace(/\s*!important$/, ''), imp: /!important$/.test(valor) };
    });
    for (const s of m[1].split(',')) {
      try { regras.push({ cadeia: lerCadeia(s), esp: 0, declaracoes, ordem: regras.length }); } catch { /* fora do subconjunto */ }
    }
  }
  for (const r of regras) r.esp = r.cadeia.reduce((t, p) => t + p.c.esp, 0);
  return regras;
}

function declarado(el, prop, regras, estado) {
  let vence = null;
  const inline = el.getAttribute('style');
  if (inline) {
    for (const d of inline.split(';')) {
      const k = d.indexOf(':');
      if (k !== -1 && d.slice(0, k).trim().toLowerCase() === prop) vence = { valor: d.slice(k + 1).replace(/!important/, '').trim(), imp: /!important/.test(d), esp: 1e6, ordem: 1e6 };
    }
  }
  for (const r of regras) {
    if (!casaCadeia(el, r.cadeia, r.cadeia.length - 1, estado)) continue;
    for (const d of r.declaracoes) {
      if (d.prop !== prop) continue;
      const cand = { valor: d.valor, imp: d.imp, esp: r.esp, ordem: r.ordem };
      if (!vence || (cand.imp && !vence.imp) || (cand.imp === vence.imp && (cand.esp > vence.esp || (cand.esp === vence.esp && cand.ordem >= vence.ordem)))) vence = cand;
    }
  }
  return vence ? vence.valor : null;
}

function resolverVariaveis(valor, raiz, regras, estado, profundidade = 0) {
  if (profundidade > 10) return valor;
  return valor.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, nome, padrao) => {
    const v = declarado(raiz, nome, regras, estado);
    return resolverVariaveis(v !== null ? v : (padrao || ''), raiz, regras, estado, profundidade + 1);
  });
}

/**
 * @param {object} pg página aberta por abrirPagina
 * @param {string} arquivoHtml o mesmo caminho dado a abrirPagina
 * @param {object} el elemento da página
 * @param {string[]} props propriedades a medir
 * @param {{hover?: boolean, focus?: boolean}} [opcoes]
 * @returns {object} propriedade -> valor resolvido (null se nada declara nem herda)
 */
function estiloComputado(pg, arquivoHtml, el, props, opcoes = {}) {
  const regras = regrasDaPagina(pg, arquivoHtml);
  const raiz = pg.documento.documentElement;
  const saida = {};
  for (const prop of props) {
    let valor = null;
    for (let no = el, proprio = true; no && no.nodeType === 1; no = no.parentElement, proprio = false) {
      const estado = { raiz, hover: proprio && opcoes.hover, focus: proprio && opcoes.focus };
      valor = declarado(no, prop, regras, estado);
      if (valor !== null || !HERDADAS.has(prop)) break;
    }
    saida[prop] = valor === null ? null : resolverVariaveis(valor, raiz, regras, { raiz });
  }
  return saida;
}

/** Valor de uma propriedade personalizada no tema atual da página (para comparar com tokens). */
function token(pg, arquivoHtml, nome) {
  const regras = regrasDaPagina(pg, arquivoHtml);
  const raiz = pg.documento.documentElement;
  return resolverVariaveis(`var(${nome})`, raiz, regras, { raiz });
}

module.exports = { estiloComputado, token };
