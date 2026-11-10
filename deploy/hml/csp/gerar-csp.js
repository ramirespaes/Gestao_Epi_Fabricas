'use strict';

/**
 * Gera a Content-Security-Policy de um pacote publicado (perfil portal ou painel).
 *
 * Calcula o hash SHA-256 de cada <script> e <style> inline, recusa o que a política
 * não consegue cobrir sem 'unsafe-inline' (javascript: em links) e exige que todo
 * host externo esteja declarado no perfil. Atributos style="" são cobertos só em
 * style-src-attr; manipuladores on*="" entram por hash em script-src-attr com
 * 'unsafe-hashes'. Manipuladores montados dentro de .js viram aviso: o gerador não
 * consegue prová-los, e a CSP os bloquearia.
 *
 * Uso: node gerar-csp.js --pacote <dir> --perfil <portal|painel>
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Origens externas que cada perfil aceita, por tipo de uso. Painel: nenhuma.
const PERFIS = {
  painel: { origens: [] },
  portal: {
    origens: [
      { origem: 'https://challenges.cloudflare.com', usos: ['script', 'frame', 'connect'] },
      { origem: 'https://fonts.googleapis.com', usos: ['style'], implica: ['https://fonts.gstatic.com'] },
      { origem: 'https://fonts.gstatic.com', usos: ['font'] },
    ],
  },
};
const TIPOS_JS = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript']);
const MANIPULADOR_EM_JS = /\son(?:click|change|submit|load|error|input|keydown|keyup|keypress|focus|blur|mouse[a-z]+|dblclick|select|toggle)\s*=\s*\\?["']/i;

class ErroCsp extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroCsp';
    this.codigo = codigo;
  }
}
const invalida = (m) => new ErroCsp('CSP_ENTRADA_INVALIDA', m);
const hash = (texto) => `'sha256-${crypto.createHash('sha256').update(texto).digest('base64')}'`;

function decodificar(valor) {
  return valor.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function listarPor(raiz, extensao, rel = '') {
  return fs.readdirSync(path.join(raiz, rel), { withFileTypes: true }).flatMap((e) => {
    const relFilho = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) return [];
    if (e.isDirectory()) return listarPor(raiz, extensao, relFilho);
    return e.name.endsWith(extensao) ? [relFilho] : [];
  }).sort();
}

function origemDe(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

function usosExternos(html) {
  const usos = [];
  const adicionar = (tipo, valor) => { if (valor && /^(?:https?:)?\/\//i.test(valor.trim())) usos.push({ tipo, url: valor.trim().startsWith('//') ? `https:${valor.trim()}` : valor.trim() }); };
  for (const m of html.matchAll(/<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) adicionar('script', m[1] ?? m[2]);
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) adicionar('img', m[1] ?? m[2]);
  for (const m of html.matchAll(/<iframe\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) adicionar('frame', m[1] ?? m[2]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!href) continue;
    const rel = (/\srel\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag) || [])[1] || '';
    const como = (/\sas\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag) || [])[1] || '';
    adicionar(/stylesheet/i.test(rel) ? 'style' : (/preload/i.test(rel) && como === 'font' ? 'font' : 'img'), href[1] ?? href[2]);
  }
  return usos;
}

function gerarCsp({ raiz, perfil, arquivos } = {}) {
  const config = PERFIS[perfil];
  if (!config) throw invalida(`perfil desconhecido: ${perfil}`);
  if (typeof raiz !== 'string' || !fs.existsSync(raiz) || !fs.statSync(raiz).isDirectory()) throw invalida('raiz do pacote inexistente');
  const real = fs.realpathSync(raiz);
  let paginas = arquivos;
  if (paginas === undefined) paginas = listarPor(real, '.html');
  else {
    for (const a of paginas) {
      if (typeof a !== 'string' || a.startsWith('/') || a.includes('\\') || path.posix.normalize(a) !== a || a.split('/').includes('..')) throw invalida(`caminho inválido: ${a}`);
      if (!fs.existsSync(path.join(real, ...a.split('/')))) throw invalida(`página inexistente: ${a}`);
    }
  }
  if (paginas.length === 0) throw invalida('o pacote não tem páginas HTML');

  const scripts = new Set(); const estilos = new Set(); const manipuladores = new Set();
  const problemas = []; const avisos = [];
  const origensUsadas = new Map();
  let atributosStyle = 0; let totalManipuladores = 0;

  for (const rel of paginas) {
    const html = fs.readFileSync(path.join(real, ...rel.split('/')), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\ssrc\s*=/i.test(m[1])) continue;
      const tipo = ((/\stype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]) || [])[1] || '').toLowerCase();
      if (TIPOS_JS.has(tipo) && m[2].trim() !== '') scripts.add(hash(m[2]));
    }
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) if (m[1].trim() !== '') estilos.add(hash(m[1]));
    const resto = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    atributosStyle += [...resto.matchAll(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi)].length;
    for (const m of resto.matchAll(/\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      totalManipuladores += 1;
      manipuladores.add(hash(decodificar(m[1] ?? m[2])));
    }
    if (/\b(?:href|action|formaction|src)\s*=\s*["']?\s*javascript:/i.test(resto)) problemas.push({ codigo: 'JAVASCRIPT_URL', mensagem: `${rel} usa javascript: em link ou formulário, que a CSP bloqueia` });
    for (const { tipo, url } of usosExternos(html)) {
      const origem = origemDe(url);
      const chave = `${tipo}|${origem}`;
      if (!origensUsadas.has(chave)) origensUsadas.set(chave, { tipo, origem, onde: rel });
    }
  }

  const permitidos = new Map(config.origens.map((o) => [o.origem, o]));
  const emitir = { script: new Set(), style: new Set(), font: new Set(), img: new Set(), connect: new Set(), frame: new Set() };
  const incluir = (origem, usos) => { for (const uso of usos) emitir[uso].add(origem); };
  for (const { tipo, origem, onde } of origensUsadas.values()) {
    const regra = origem && permitidos.get(origem);
    if (!regra || !regra.usos.includes(tipo)) {
      problemas.push({ codigo: 'ORIGEM_EXTERNA_NAO_DECLARADA', mensagem: `${onde} carrega ${tipo} de ${origem || 'origem inválida'}, fora do perfil ${perfil}` });
      continue;
    }
    incluir(origem, regra.usos);
    for (const implicada of regra.implica || []) incluir(implicada, permitidos.get(implicada).usos);
  }

  for (const js of listarPor(real, '.js')) {
    if (MANIPULADOR_EM_JS.test(fs.readFileSync(path.join(real, ...js.split('/')), 'utf8'))) avisos.push({ codigo: 'MANIPULADOR_EM_JS', mensagem: `${js} monta manipulador on*= em texto; a CSP o bloquearia` });
  }

  const lista = (conjunto) => [...conjunto].sort();
  const fonte = (...partes) => partes.filter((p) => p.length > 0).join(' ');
  const diretivas = [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    fonte("script-src 'self'", lista(emitir.script).join(' '), lista(scripts).join(' ')),
    manipuladores.size > 0 ? fonte("script-src-attr 'unsafe-hashes'", lista(manipuladores).join(' ')) : "script-src-attr 'none'",
    fonte("style-src 'self'", lista(emitir.style).join(' '), lista(estilos).join(' ')),
    atributosStyle > 0 ? "style-src-attr 'unsafe-inline'" : "style-src-attr 'none'",
    fonte("img-src 'self' data:", lista(emitir.img).join(' ')),
    fonte("font-src 'self'", lista(emitir.font).join(' ')),
    fonte("connect-src 'self'", lista(emitir.connect).join(' ')),
    emitir.frame.size > 0 ? fonte('frame-src', lista(emitir.frame).join(' ')) : "frame-src 'none'",
    'upgrade-insecure-requests',
  ];
  return {
    politica: diretivas.join('; '),
    hashes: { script: lista(scripts), style: lista(estilos), manipuladores: lista(manipuladores) },
    problemas, avisos, paginas: paginas.length, atributosStyle, manipuladoresInline: totalManipuladores,
  };
}

function principal(argv) {
  const v = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--pacote', '--perfil'].includes(argv[i]) || argv[i + 1] === undefined) throw invalida(`argumento inválido: ${argv[i]}`);
    v[argv[i].slice(2)] = argv[i + 1];
  }
  if (!v.pacote || !v.perfil) throw invalida('--pacote e --perfil são obrigatórios');
  return gerarCsp({ raiz: v.pacote, perfil: v.perfil });
}

if (require.main === module) {
  try {
    const r = principal(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(r)}\n`);
    for (const p of r.problemas) console.error(`${p.codigo}: ${p.mensagem}`);
    process.exitCode = r.problemas.length ? 1 : 0;
  } catch (falha) {
    console.error(`CSP recusada (${falha.codigo || 'ERRO'}): ${falha.message}`);
    process.exitCode = 1;
  }
}

// A prévia do Totem é um iframe criado por JavaScript na mesma origem, que o gerador não enxerga no HTML.
// Variantes derivadas (nunca digitadas à mão) da política do Portal: a página que hospeda o iframe ganha 'self' em frame-src
// (mantendo o Turnstile); a prévia aceita ser enquadrada só pela mesma origem. O resto da política não muda.
function derivarCspTotem(politica) {
  const partes = String(politica).split('; ');
  const trocar = (nome, novo) => {
    const i = partes.findIndex((p) => p === nome || p.startsWith(`${nome} `));
    if (i < 0) throw invalida(`diretiva ausente: ${nome}`);
    return [i, novo(partes[i])];
  };
  const atendimento = partes.slice();
  if (partes.some((p) => p.startsWith('frame-src '))) {
    const [iFrame, frame] = trocar('frame-src', (p) => (p === "frame-src 'none'" ? "frame-src 'self'" : p.replace('frame-src ', "frame-src 'self' ")));
    atendimento[iFrame] = frame;
  } else atendimento.push("frame-src 'self'");
  const previa = partes.slice();
  const [iAnc, anc] = trocar('frame-ancestors', (p) => {
    if (p !== "frame-ancestors 'none'") throw invalida('frame-ancestors do Portal precisa ser \'none\'');
    return "frame-ancestors 'self'";
  });
  previa[iAnc] = anc;
  return { atendimento: atendimento.join('; '), previa: previa.join('; ') };
}

module.exports = { gerarCsp, derivarCspTotem, PERFIS, ErroCsp };
