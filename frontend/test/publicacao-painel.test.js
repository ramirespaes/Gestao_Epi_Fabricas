'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { arquivosLocaisDe } = require('./helpers/dom-pagina');

/**
 * Publicação do Painel Privado por allowlist explícita e independente da do
 * cliente. O Painel é servido em outra origem (allowlist de CORS disjunta), por
 * isso tem empacotador próprio: publicacao/empacotar-painel.js com
 * publicacao/allowlist-painel.json. O pacote contém SOMENTE os arquivos de
 * painel-privado/ mais o conjunto fixo de compartilhados; Portal, Totem,
 * institucional, páginas integradas, protótipos e material de desenvolvimento
 * nunca entram. Tudo é fail-closed: qualquer dúvida recusa o pacote inteiro,
 * antes de escrever qualquer arquivo. O empacotador do cliente não é alterado.
 */

const RAIZ = path.resolve(__dirname, '..');
const MODULO = path.join(RAIZ, 'publicacao', 'empacotar-painel.js');
const ALLOWLIST = path.join(RAIZ, 'publicacao', 'allowlist-painel.json');
const temporarios = [];

const PROPRIOS = [
  'painel-privado/aceitar-convite.html', 'painel-privado/aceitar-convite.js',
  'painel-privado/config.js',
  'painel-privado/empresas.html', 'painel-privado/empresas.js',
  'painel-privado/index.html', 'painel-privado/login.js',
  'painel-privado/mfa.css', 'painel-privado/mfa.js',
  'painel-privado/painel.html', 'painel-privado/painel.js',
  'painel-privado/recuperar-senha.html', 'painel-privado/recuperar-senha.js',
  'painel-privado/redefinir-senha.html', 'painel-privado/redefinir-senha.js',
  'painel-privado/sair.js',
  'painel-privado/seguranca.html', 'painel-privado/seguranca.js',
  'painel-privado/suporte.html', 'painel-privado/suporte.js',
];
const COMPARTILHADOS = [
  'favicon.svg',
  'js/api-http.js',
  'js/senha-ciclo.js',
  'vendor/LICENSE-qrcode-generator.txt',
  'vendor/qrcode-generator-2.0.4.js',
];
const ESPERADOS = [...PROPRIOS, ...COMPARTILHADOS].sort();
// Mesmo valor registrado em vendor/README.md e conferido por painel-privado-mfa.test.js.
const SHA256_QRCODE = '79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c';

const PROIBIDOS_EXISTENTES = [
  'index.html', 'package.json', 'POPUPS-VISUAL.md', 'SWITCHES-VISUAL.md',
  'js/main.js', 'js/db-api.js', 'js/auth-session.js', 'js/inspecao-visual.js',
  'js/pagina-base.js', 'js/tema.js', 'js/portal-cliente.js', 'js/sessao-empresarial.js',
  'css/main.css', 'css/support.css',
  'pages/dashboard.html', 'pages/support.html', 'pages/emails-gestao.html',
  'portal/index.html', 'portal/login.js', 'portal/portal.css', 'portal/config.js',
  'totem/index.html', 'totem/totem.js', 'totem/boot.js',
  'institucional/safework_engenharia_pagina_inicial.html',
  'vendor/README.md', 'vendor/read-excel-file-9.3.10.min.js', 'vendor/LICENSE-read-excel-file.txt',
  'test/publicacao.test.js', 'test/helpers/dom-painel.js',
  'publicacao/empacotar.js', 'publicacao/allowlist.json', 'publicacao/README.md',
];
const PREFIXOS_PROIBIDOS = ['portal/', 'pages/', 'totem/', 'institucional/', 'css/', 'test/', 'publicacao/', 'IMAGEN/', 'node_modules/'];

function carregarEmpacotador() {
  try {
    return require('../publicacao/empacotar-painel');
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && /empacotar-painel/.test(erro.message)) {
      assert.fail('empacotador do Painel ausente: publicacao/empacotar-painel.js ainda não existe (RED esperado)');
    }
    throw erro;
  }
}
function diretorioTemporario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epi-publicacao-painel-'));
  temporarios.push(dir);
  return dir;
}
function listar(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    return e.isDirectory() ? listar(abs, base) : [path.relative(base, abs).split(path.sep).join('/')];
  }).sort();
}
function recusa(fn, codigo) {
  assert.throws(fn, (erro) => {
    assert.equal(erro.codigo, codigo, `esperado ${codigo}, veio ${erro.codigo}: ${erro.message}`);
    return true;
  });
}
const sha256 = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
const semComentariosHtml = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const lerFrontend = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// Frontend sintético mínimo com a forma do Painel real: a página carrega os
// compartilhados por ../ e um script próprio. Os compartilhados são copiados do
// repositório para que a integridade fixa do vendor continue válida.
function frontendSintetico(extras = {}, { copiarCompartilhados = true } = {}) {
  const raiz = diretorioTemporario();
  const arquivos = {};
  if (copiarCompartilhados) for (const rel of COMPARTILHADOS) arquivos[rel] = fs.readFileSync(path.join(RAIZ, rel));
  Object.assign(arquivos, extras);
  for (const [relativo, conteudo] of Object.entries(arquivos)) {
    if (conteudo === null) continue;
    fs.mkdirSync(path.dirname(path.join(raiz, relativo)), { recursive: true });
    fs.writeFileSync(path.join(raiz, relativo), conteudo);
  }
  return { raiz, arquivos: Object.keys(arquivos).filter((k) => arquivos[k] !== null).sort(), saida: path.join(diretorioTemporario(), 'pacote') };
}
const paginaPainel = ({ head = '', scripts = [], corpo = '' } = {}) =>
  `<!DOCTYPE html><html><head><link rel="icon" href="../favicon.svg">${head}</head><body>${corpo}`
  + `<script src="../js/api-http.js"></script><script src="config.js"></script>`
  + scripts.map((s) => `<script src="${s}"></script>`).join('')
  + `<script src="login.js"></script></body></html>`;
const PAINEL_MINIMO = () => ({
  'painel-privado/index.html': paginaPainel(),
  'painel-privado/config.js': '',
  'painel-privado/login.js': '',
});

afterEach(() => {
  while (temporarios.length) fs.rmSync(temporarios.pop(), { recursive: true, force: true });
});

describe('Painel Privado — fatos do repositório que o empacotador assume (independentes do módulo)', () => {
  test('painel-privado/ tem exatamente os 20 arquivos próprios previstos', () => {
    const emDisco = fs.readdirSync(path.join(RAIZ, 'painel-privado'), { withFileTypes: true })
      .filter((e) => e.isFile() && !/ 2\./.test(e.name))
      .map((e) => `painel-privado/${e.name}`).sort();
    assert.deepEqual(emDisco, PROPRIOS);
  });

  test('os cinco compartilhados existem e o vendor do QR Code tem o SHA-256 registrado', () => {
    for (const rel of COMPARTILHADOS) assert.ok(fs.statSync(path.join(RAIZ, rel)).isFile(), `${rel} precisa existir`);
    assert.equal(sha256(path.join(RAIZ, 'vendor/qrcode-generator-2.0.4.js')), SHA256_QRCODE);
    assert.match(lerFrontend('vendor/README.md'), new RegExp(SHA256_QRCODE), 'hash registrado no vendor/README.md');
  });

  test('nenhuma página do Painel carrega script, folha, imagem ou fonte externa, nem usa <base>, <iframe>, <object> ou <embed>', () => {
    for (const pagina of PROPRIOS.filter((f) => f.endsWith('.html'))) {
      const html = semComentariosHtml(lerFrontend(pagina));
      assert.doesNotMatch(html, /<(script|link|img)\b[^>]*\b(src|href)\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i, `${pagina} carrega recurso externo`);
      assert.doesNotMatch(html, /<(base|iframe|object|embed)\b/i, `${pagina} usa tag proibida no pacote administrativo`);
      assert.doesNotMatch(html, /@import|url\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i, `${pagina} importa estilo ou url externa`);
    }
    assert.doesNotMatch(lerFrontend('painel-privado/mfa.css'), /@import|url\(/i, 'mfa.css não referencia nada');
  });

  test('o fechamento de dependências diretas e indiretas das páginas do Painel é exatamente a lista de 25 arquivos', () => {
    const fechamento = new Set(PROPRIOS.filter((f) => f.endsWith('.html')));
    const fila = [...fechamento];
    while (fila.length) {
      const atual = fila.pop();
      const conteudo = lerFrontend(atual);
      const dependencias = atual.endsWith('.html')
        ? [...arquivosLocaisDe(atual, conteudo),
          ...[...semComentariosHtml(conteudo).matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"'#?]+\.html)(?:[?#][^"']*)?["']/gi)]
            .map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(atual), m[1])))]
        : atual.endsWith('.css')
          ? [...conteudo.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(atual), m[1].split(/[?#]/)[0])))
          : [];
      for (const dep of dependencias) if (!fechamento.has(dep)) { fechamento.add(dep); fila.push(dep); }
    }
    // A licença acompanha o vendor por decisão, não por carregamento.
    fechamento.add('vendor/LICENSE-qrcode-generator.txt');
    assert.deepEqual([...fechamento].sort(), ESPERADOS);
  });

  test('o empacotador do cliente continua intacto: NUNCA_PUBLICAR com painel-privado/ e allowlist do Portal sem o Painel', () => {
    const cliente = require('../publicacao/empacotar');
    assert.ok(cliente.NUNCA_PUBLICAR.includes('painel-privado/'));
    const allowlistCliente = cliente.lerAllowlist();
    assert.ok(allowlistCliente.length > 0);
    assert.equal(allowlistCliente.some((f) => f.startsWith('painel-privado/')), false);
  });
});

describe('publicação do Painel Privado por allowlist explícita e independente', () => {
  test('o módulo expõe a mesma superfície do empacotador do cliente e não depende dele', () => {
    const m = carregarEmpacotador();
    for (const nome of ['empacotar', 'verificarPacote', 'lerAllowlist', 'ErroPublicacao']) assert.equal(typeof m[nome], 'function', `${nome} exportado`);
    assert.deepEqual([...m.COMPARTILHADOS_PERMITIDOS].sort(), COMPARTILHADOS);
    assert.equal(m.HASHES_FIXOS['vendor/qrcode-generator-2.0.4.js'], SHA256_QRCODE);
    assert.doesNotMatch(fs.readFileSync(MODULO, 'utf8'), /require\(\s*['"][^'"]*empacotar['"]\s*\)/, 'não reutiliza empacotar.js do cliente');
  });

  test('a allowlist do Painel é um arquivo próprio com exatamente os 25 arquivos previstos', () => {
    const { lerAllowlist } = carregarEmpacotador();
    assert.ok(fs.existsSync(ALLOWLIST), 'publicacao/allowlist-painel.json precisa existir');
    assert.deepEqual([...lerAllowlist()].sort(), ESPERADOS);
    const cliente = require('../publicacao/empacotar').lerAllowlist();
    const intersecao = lerAllowlist().filter((f) => cliente.includes(f)).sort();
    for (const f of intersecao) assert.ok(COMPARTILHADOS.includes(f), `${f} está nos dois pacotes e não é um compartilhado declarado`);
  });

  test('o pacote contém exatamente a allowlist, byte a byte igual ao repositório, com manifesto SHA-256 fora do pacote', () => {
    const { empacotar } = carregarEmpacotador();
    const saida = path.join(diretorioTemporario(), 'pacote');
    const resultado = empacotar({ saida });

    const publicados = listar(saida);
    assert.deepEqual(publicados, ESPERADOS);
    assert.deepEqual(resultado.arquivos, publicados);
    for (const rel of ESPERADOS) {
      assert.deepEqual(fs.readFileSync(path.join(saida, rel)), fs.readFileSync(path.join(RAIZ, rel)), `${rel} publicado sem alteração`);
      assert.equal(resultado.manifesto[rel], sha256(path.join(RAIZ, rel)), `manifesto de ${rel}`);
    }
    assert.deepEqual(Object.keys(resultado.manifesto).sort(), ESPERADOS);
    assert.equal(fs.existsSync(path.join(saida, 'manifesto.json')), false, 'o manifesto não entra no pacote');
  });

  test('isolamento: nada do Portal, Totem, institucional, páginas integradas, protótipos ou desenvolvimento no pacote', () => {
    const { empacotar } = carregarEmpacotador();
    const saida = path.join(diretorioTemporario(), 'pacote');
    const publicados = empacotar({ saida }).arquivos;
    for (const fora of PROIBIDOS_EXISTENTES) assert.ok(!publicados.includes(fora), `${fora} não pode ser publicado`);
    for (const prefixo of PREFIXOS_PROIBIDOS) assert.ok(!publicados.some((f) => f.startsWith(prefixo)), `nada de ${prefixo} no pacote`);
    assert.equal(publicados.filter((f) => !f.startsWith('painel-privado/')).length, COMPARTILHADOS.length);
  });

  test('fail-closed: qualquer arquivo fora de painel-privado/ e do conjunto compartilhado é recusado mesmo listado, sem escrever nada', () => {
    const { empacotar, lerAllowlist } = carregarEmpacotador();
    const saida = path.join(diretorioTemporario(), 'pacote');
    const allowlist = lerAllowlist();
    for (const proibido of PROIBIDOS_EXISTENTES) {
      assert.ok(fs.existsSync(path.join(RAIZ, proibido)), `${proibido} precisa existir para o cenário valer`);
      recusa(() => empacotar({ saida, arquivos: [...allowlist, proibido] }), 'NUNCA_PUBLICAR');
    }
    assert.equal(fs.existsSync(saida), false, 'nenhum arquivo escrito quando o pacote é recusado');
  });

  test('fail-closed: um sexto compartilhado de js/ ou vendor/ exige mudança de código, não só da allowlist', () => {
    const { empacotar } = carregarEmpacotador();
    const f = frontendSintetico({ ...PAINEL_MINIMO(), 'js/pagina-base.js': '', 'vendor/outro.js': '' });
    recusa(() => empacotar({ ...f, arquivos: f.arquivos.filter((a) => a !== 'vendor/outro.js') }), 'NUNCA_PUBLICAR');
    recusa(() => empacotar({ ...f, arquivos: f.arquivos.filter((a) => a !== 'js/pagina-base.js') }), 'NUNCA_PUBLICAR');
    assert.equal(fs.existsSync(f.saida), false);
  });

  test('fail-closed: entradas fora do frontend, absolutas, não canônicas, diretórios, ausentes, duplicadas ou vazias', () => {
    const { empacotar, lerAllowlist } = carregarEmpacotador();
    const saida = path.join(diretorioTemporario(), 'pacote');
    const allowlist = lerAllowlist();

    recusa(() => empacotar({ saida, arquivos: [...allowlist, '../backend/package.json'] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'painel-privado/../js/main.js'] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, '/etc/hosts'] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'painel-privado/./index.html'] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'painel-privado\\index.html'] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'painel-privado'] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'painel-privado/nao-existe.html'] }), 'ARQUIVO_AUSENTE');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, allowlist[0]] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 42] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [] }), 'ENTRADA_INVALIDA');
    assert.equal(fs.existsSync(saida), false);
  });

  test('fail-closed: link simbólico dentro de painel-privado/ é recusado, mesmo apontando para arquivo permitido', () => {
    const { empacotar } = carregarEmpacotador();
    const f = frontendSintetico(PAINEL_MINIMO());
    fs.symlinkSync(path.join(f.raiz, 'painel-privado', 'login.js'), path.join(f.raiz, 'painel-privado', 'atalho.js'));
    recusa(() => empacotar({ ...f, arquivos: [...f.arquivos, 'painel-privado/atalho.js'] }), 'ENTRADA_INVALIDA');

    const externo = path.join(diretorioTemporario(), 'fora.js');
    fs.writeFileSync(externo, '');
    fs.symlinkSync(externo, path.join(f.raiz, 'painel-privado', 'fora.js'));
    recusa(() => empacotar({ ...f, arquivos: [...f.arquivos, 'painel-privado/fora.js'] }), 'ENTRADA_INVALIDA');
    assert.equal(fs.existsSync(f.saida), false);
  });

  test('fail-closed: todo script externo é recusado, sem exceção, inclusive a URL exata do Turnstile aceita no Portal', () => {
    const { empacotar } = carregarEmpacotador();
    for (const src of [
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
      'https://cdn.jsdelivr.net/npm/qualquer@1/index.js',
      'http://localhost:5501/x.js',
      '//cdn.example.test/x.js',
      'HTTPS://CDN.EXAMPLE.TEST/x.js',
      'data:text/javascript,alert(1)',
      'javascript:alert(1)',
    ]) {
      const f = frontendSintetico({ ...PAINEL_MINIMO(), 'painel-privado/index.html': paginaPainel({ scripts: [src] }) });
      recusa(() => empacotar(f), 'SCRIPT_EXTERNO');
      assert.equal(fs.existsSync(f.saida), false, src);
    }
  });

  test('fail-closed: folha, imagem, fonte ou url() externa também é recusada', () => {
    const { empacotar } = carregarEmpacotador();
    for (const head of [
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
      '<link rel="preload" as="font" href="//fonts.gstatic.com/x.woff2">',
      '<style>body{background:url(https://cdn.example.test/fundo.png)}</style>',
      '<style>@import url("https://cdn.example.test/x.css");</style>',
    ]) {
      const f = frontendSintetico({ ...PAINEL_MINIMO(), 'painel-privado/index.html': paginaPainel({ head }) });
      recusa(() => empacotar(f), 'RECURSO_EXTERNO');
      assert.equal(fs.existsSync(f.saida), false, head);
    }
    const css = frontendSintetico({ ...PAINEL_MINIMO(), 'painel-privado/index.html': paginaPainel({ head: '<link rel="stylesheet" href="mfa.css">' }), 'painel-privado/mfa.css': 'body{background:url("https://cdn.example.test/f.png")}' });
    recusa(() => empacotar(css), 'RECURSO_EXTERNO');
    for (const corpo of ['<img src="https://cdn.example.test/logo.png">', '<img src="//cdn.example.test/logo.png">']) {
      const f = frontendSintetico({ ...PAINEL_MINIMO(), 'painel-privado/index.html': paginaPainel({ corpo }) });
      recusa(() => empacotar(f), 'RECURSO_EXTERNO');
    }
  });

  test('fail-closed: <base>, <iframe>, <object>, <embed> e a forma anômala <script/src> são recusados', () => {
    const { empacotar } = carregarEmpacotador();
    for (const trecho of [
      '<base href="https://mal.test/">',
      '<base href="/outro/">',
      '<iframe src="about:blank"></iframe>',
      '<object data="x.swf"></object>',
      '<embed src="x.pdf">',
      '<script/src="https://mal.test/x.js"></script>',
      '<SCRIPT\tsrc="https://mal.test/x.js"></SCRIPT>',
    ]) {
      const f = frontendSintetico({ ...PAINEL_MINIMO(), 'painel-privado/index.html': paginaPainel({ corpo: trecho }) });
      assert.throws(() => empacotar(f), (erro) => {
        assert.ok(['HTML_PERIGOSO', 'SCRIPT_EXTERNO'].includes(erro.codigo), `${trecho}: código ${erro.codigo}`);
        return true;
      });
      assert.equal(fs.existsSync(f.saida), false, trecho);
    }
  });

  test('fail-closed: recurso local carregado por página ou folha precisa estar na allowlist (direto e indireto)', () => {
    const { empacotar, lerAllowlist } = carregarEmpacotador();
    const saida = path.join(diretorioTemporario(), 'pacote');
    recusa(() => empacotar({ saida, arquivos: lerAllowlist().filter((f) => f !== 'js/api-http.js') }), 'RECURSO_FORA_DA_ALLOWLIST');
    recusa(() => empacotar({ saida, arquivos: lerAllowlist().filter((f) => f !== 'painel-privado/mfa.css') }), 'RECURSO_FORA_DA_ALLOWLIST');
    recusa(() => empacotar({ saida, arquivos: lerAllowlist().filter((f) => f !== 'favicon.svg') }), 'RECURSO_FORA_DA_ALLOWLIST');
    recusa(() => empacotar({ saida, arquivos: lerAllowlist().filter((f) => f !== 'vendor/qrcode-generator-2.0.4.js') }), 'RECURSO_FORA_DA_ALLOWLIST');
    assert.equal(fs.existsSync(saida), false);

    const indireto = frontendSintetico({ ...PAINEL_MINIMO(), 'painel-privado/index.html': paginaPainel({ head: '<link rel="stylesheet" href="mfa.css">' }), 'painel-privado/mfa.css': '.x{background:url(../favicon.svg)} .y{background:url("fundo.png")}', 'painel-privado/fundo.png': '' });
    recusa(() => empacotar({ ...indireto, arquivos: indireto.arquivos.filter((a) => a !== 'painel-privado/fundo.png') }), 'RECURSO_FORA_DA_ALLOWLIST');
  });

  test('fail-closed: link de navegação para página fora do pacote é recusado; links do Painel real fecham dentro dele', () => {
    const { empacotar, lerAllowlist } = carregarEmpacotador();
    for (const href of ['../portal/index.html', '../pages/dashboard.html', 'inexistente.html', '/totem/index.html']) {
      const f = frontendSintetico({ ...PAINEL_MINIMO(), 'painel-privado/index.html': paginaPainel({ corpo: `<a href="${href}">ir</a>` }) });
      recusa(() => empacotar(f), 'LINK_FORA_DO_PACOTE');
      assert.equal(fs.existsSync(f.saida), false, href);
    }
    const allowlist = new Set(lerAllowlist());
    for (const origem of [...allowlist].filter((f) => f.endsWith('.html'))) {
      for (const m of semComentariosHtml(lerFrontend(origem)).matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"'#?]+\.html)(?:[?#][^"']*)?["']/gi)) {
        const alvo = path.posix.normalize(m[1].startsWith('/') ? m[1].slice(1) : path.posix.join(path.posix.dirname(origem), m[1]));
        assert.ok(allowlist.has(alvo), `${origem} -> ${alvo} sai do pacote`);
      }
    }
  });

  test('fail-closed: vendor com SHA-256 diferente do fixado é recusado', () => {
    const { empacotar } = carregarEmpacotador();
    const f = frontendSintetico({ ...PAINEL_MINIMO(), 'painel-privado/index.html': paginaPainel({ scripts: ['../vendor/qrcode-generator-2.0.4.js'] }) });
    fs.appendFileSync(path.join(f.raiz, 'vendor', 'qrcode-generator-2.0.4.js'), '\n;window.x=1;');
    recusa(() => empacotar(f), 'INTEGRIDADE_DIVERGENTE');
    assert.equal(fs.existsSync(f.saida), false);

    const intacto = frontendSintetico({ ...PAINEL_MINIMO(), 'painel-privado/index.html': paginaPainel({ scripts: ['../vendor/qrcode-generator-2.0.4.js'] }) });
    assert.deepEqual(empacotar(intacto).arquivos, intacto.arquivos);
  });

  test('fail-closed: saída com conteúdo, saída dentro do código-fonte ou saída ausente são recusadas', () => {
    const { empacotar } = carregarEmpacotador();
    const ocupada = diretorioTemporario();
    fs.writeFileSync(path.join(ocupada, 'sobra.html'), '<p>resto de outra publicação</p>');
    recusa(() => empacotar({ saida: ocupada }), 'SAIDA_INVALIDA');
    assert.deepEqual(listar(ocupada), ['sobra.html']);

    recusa(() => empacotar({ saida: path.join(RAIZ, 'dist-painel') }), 'SAIDA_INVALIDA');
    assert.equal(fs.existsSync(path.join(RAIZ, 'dist-painel')), false);
    recusa(() => empacotar({ saida: path.join(RAIZ, 'painel-privado', 'dist') }), 'SAIDA_INVALIDA');
    recusa(() => empacotar({}), 'SAIDA_INVALIDA');
    recusa(() => empacotar({ saida: '   ' }), 'SAIDA_INVALIDA');
  });

  test('verificação do pacote: arquivo a mais, a menos, alterado ou não regular é detectado', () => {
    const { empacotar, verificarPacote } = carregarEmpacotador();
    const saida = path.join(diretorioTemporario(), 'pacote');
    const { manifesto } = empacotar({ saida });
    assert.doesNotThrow(() => verificarPacote(saida));
    assert.doesNotThrow(() => verificarPacote(saida, { manifesto }));

    fs.writeFileSync(path.join(saida, 'portal-index.html'), '<p>intruso</p>');
    recusa(() => verificarPacote(saida), 'PACOTE_DIVERGENTE');
    fs.rmSync(path.join(saida, 'portal-index.html'));

    fs.mkdirSync(path.join(saida, 'portal'));
    fs.writeFileSync(path.join(saida, 'portal', 'index.html'), '<p>intruso</p>');
    recusa(() => verificarPacote(saida), 'PACOTE_DIVERGENTE');
    fs.rmSync(path.join(saida, 'portal'), { recursive: true });

    fs.appendFileSync(path.join(saida, 'painel-privado', 'login.js'), '\n;');
    recusa(() => verificarPacote(saida, { manifesto }), 'PACOTE_DIVERGENTE');
    fs.copyFileSync(path.join(RAIZ, 'painel-privado', 'login.js'), path.join(saida, 'painel-privado', 'login.js'));
    assert.doesNotThrow(() => verificarPacote(saida, { manifesto }));

    fs.rmSync(path.join(saida, 'js', 'api-http.js'));
    recusa(() => verificarPacote(saida), 'PACOTE_DIVERGENTE');
    fs.symlinkSync(path.join(RAIZ, 'js', 'api-http.js'), path.join(saida, 'js', 'api-http.js'));
    recusa(() => verificarPacote(saida), 'PACOTE_DIVERGENTE');
  });

  test('linha de comando: sai com 0 ao gerar o pacote e com 1 quando recusa, sem escrever nada na recusa', () => {
    carregarEmpacotador();
    const saida = path.join(diretorioTemporario(), 'pacote');
    const ok = spawnSync(process.execPath, [MODULO, '--saida', saida], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(listar(saida), ESPERADOS);
    assert.match(ok.stdout, /25 arquivos/);

    const repetida = spawnSync(process.execPath, [MODULO, '--saida', saida], { encoding: 'utf8' });
    assert.equal(repetida.status, 1);
    assert.match(repetida.stderr, /SAIDA_INVALIDA/);
    assert.deepEqual(listar(saida), ESPERADOS, 'pacote anterior intacto');

    const semSaida = spawnSync(process.execPath, [MODULO], { encoding: 'utf8' });
    assert.equal(semSaida.status, 1);
    const dentro = spawnSync(process.execPath, [MODULO, '--saida', path.join(RAIZ, 'dist-painel')], { encoding: 'utf8' });
    assert.equal(dentro.status, 1);
    assert.equal(fs.existsSync(path.join(RAIZ, 'dist-painel')), false);
    const argumentoExtra = spawnSync(process.execPath, [MODULO, '--saida', path.join(diretorioTemporario(), 'p'), '--forcar'], { encoding: 'utf8' });
    assert.equal(argumentoExtra.status, 1);
  });
});
