'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

/**
 * Medição de geometria da página de Cadastro de Colaboradores num Chrome headless REAL (layout de verdade, não o DOM
 * simulado dos testes de página). A página real é copiada para um site temporário com `fetch` substituído por respostas
 * fixas (sessão, permissões, GHEs e 40 colaboradores com textos de tamanho típico) e um medidor que grava, num <pre>, a
 * geometria do documento, do contêiner da tabela, das colunas e dos botões da coluna Ação. Sem Chrome, `chromeDisponivel()`
 * devolve null e as suítes que dependem disto se marcam como puladas.
 */

const RAIZ = path.join(__dirname, '..', '..');
const CANDIDATOS = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

function chromeDisponivel() {
  for (const c of CANDIDATOS) {
    if (!c) continue;
    if (c.startsWith('/')) { if (fs.existsSync(c)) return c; continue; }
    const r = spawnSync('which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const GHES = [{ id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' }, { id: 20, codigo: 'GHE-020', descricao: 'Soldagem' }];
// Dois conjuntos de conteúdo: textos típicos e textos longos (nome, setor e cargo compridos, matrícula como a real).
const CONJUNTOS = {
  tipicos: {
    nomes: ['Mauro Teste Silva', 'Ana Souza', 'João Pereira', 'Maria Fernandes', 'Carlos Nogueira', 'Zeca Legado'],
    setores: ['Manutenção', 'Produção'], funcoes: ['Mecânico', 'Operador'], matricula: (i) => `MAT-${1000 + i}`,
  },
  longos: {
    nomes: ['Mauro Teste Silva de Albuquerque Neto', 'Ana Carolina Souza de Oliveira', 'João Pereira dos Santos Filho', 'Maria Aparecida Fernandes Rodrigues', 'Carlos Eduardo Nogueira Cavalcanti', 'Francisco das Chagas Albuquerque'],
    setores: ['Manutenção Industrial Mecânica', 'Produção e Acabamento de Peças'], funcoes: ['Mecânico de Manutenção Industrial', 'Operador de Máquinas Operatrizes'], matricula: (i) => `MAT-${String(171 + i).padStart(6, '0')}`,
  },
};
function gerarFuncionarios(conjunto) {
  const c = CONJUNTOS[conjunto];
  return Array.from({ length: 40 }, (_, i) => ({
    id: i + 1, empresaId: 3, matricula: c.matricula(i), nome: `${c.nomes[i % c.nomes.length]}`, cpfMascarado: '***.***.***-45',
    setor: c.setores[i % 2], funcao: c.funcoes[i % 2], telefone: '47991110001', dataNascimento: '1990-03-15',
    dataAdmissao: '2025-03-10', cracha: null, situacao: ['ATIVO', 'AFASTADO', 'INATIVO'][i % 3], ativo: i % 3 === 0,
    grupoHomogeneoId: GHES[i % 2].id, grupoHomogeneo: GHES[i % 2],
  }));
}
const TUDO = { visualizar: true, criar: true, editar: true, excluir: false };
const AREA = { consultar: true, alterar: true };
const permissoes = {
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'MASTER',
  recursos: { employeeHistory: TUDO, dashboard: TUDO, materials: TUDO, request: TUDO, reports: TUDO }, acoes: {},
  administracao: { gruposAcesso: AREA, permissoesGrupo: AREA, vinculosGrupo: AREA, usuarios: AREA, autorizacoesIndividuais: { consultar: true, concederDireta: true, delegar: true }, vinculosSst: AREA },
};
const contexto = {
  status: 'ok', usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@validacao-epi.invalid', perfil: 'MASTER' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
};

const fetchSimulado = (funcionarios) => `<script>
(function () {
  var dados = ${JSON.stringify({ funcionarios, ghes: GHES, permissoes, contexto })};
  function resp(corpo, status) {
    return Promise.resolve({ ok: (status || 200) < 400, status: status || 200, headers: { get: function () { return 'application/json'; } },
      text: function () { return Promise.resolve(JSON.stringify(corpo)); }, json: function () { return Promise.resolve(corpo); } });
  }
  window.fetch = function (url) {
    var caminho = String(url).replace(/^https?:\\/\\/[^/]+\\/api/, '').split('?')[0];
    if (caminho === '/auth/me') return resp(dados.contexto);
    if (caminho === '/auth/global/me') return resp({ status: 'ok', empresas: [{ id: 3 }] });
    if (caminho === '/auth/permissoes') return resp(dados.permissoes);
    if (caminho === '/funcionarios/ghes') return resp({ status: 'ok', ghes: dados.ghes });
    if (caminho === '/funcionarios') return resp({ status: 'ok', funcionarios: dados.funcionarios, total: dados.funcionarios.length, pagina: 1, limite: 100 });
    return resp({ status: 'error', codigo: 'NAO_ENCONTRADO', message: 'x' }, 404);
  };
})();
</script>`;

// Sem rede: o ícone vira uma caixa do tamanho do glifo, em vez do nome da ligadura (que seria mais largo).
const ESTILO_ICONES = '<style>.material-symbols-outlined{font-size:0 !important;width:20px;height:20px;display:inline-block;overflow:hidden}.nav-icon,.brand-badge,.mobile-topbar-icon{font-size:0 !important}</style>';

const MEDIDOR = `<pre id="medidas" style="position:fixed;left:-9999px"></pre><script>
window.addEventListener('load', function () { setTimeout(medir, 1500); });
function medir() {
  var d = document.documentElement;
  var r = function (s) { var e = document.querySelector(s); if (!e) return null; var b = e.getBoundingClientRect();
    return { esq: Math.round(b.left), dir: Math.round(b.right), larg: Math.round(b.width), sw: e.scrollWidth, cw: e.clientWidth }; };
  var wrap = document.querySelector('.table-wrap');
  var visivelAte = wrap ? Math.round(wrap.getBoundingClientRect().left + wrap.clientWidth) : null;
  var colunas = [].slice.call(document.querySelectorAll('thead th')).map(function (th) { var b = th.getBoundingClientRect(); return { nome: th.textContent.trim(), esq: Math.round(b.left), dir: Math.round(b.right), larg: Math.round(b.width) }; });
  var linha = document.querySelector('#tbody tr');
  var tds = linha ? [].slice.call(linha.children) : [];
  var ultima = tds.length ? tds[tds.length - 1].getBoundingClientRect() : null;
  var botoes = [].slice.call(document.querySelectorAll('#tbody tr:first-child .acoes button')).map(function (b) { var q = b.getBoundingClientRect(); return { texto: b.textContent.trim(), esq: Math.round(q.left), dir: Math.round(q.right), larg: Math.round(q.width) }; });
  var maxBotaoDir = botoes.length ? Math.max.apply(null, botoes.map(function (b) { return b.dir; })) : null;
  var out = { vw: window.innerWidth, linhas: document.querySelectorAll('#tbody tr').length, docSW: d.scrollWidth, docCW: d.clientWidth,
    content: r('main.content'), card: r('.fn .card'), tabelaWrap: r('.table-wrap'), tabela: r('.table-wrap table'),
    acao: { visivelAte: visivelAte, ultimaCelulaDir: ultima ? Math.round(ultima.right) : null, maxBotaoDir: maxBotaoDir, botoes: botoes, colunas: colunas,
      // Tolerância de 1 px SÓ para o arredondamento da borda de 0,5 px do contêiner (a última célula fecha 1 px além de clientWidth sem cortar nada).
      colunaDentro: ultima && visivelAte !== null ? Math.round(ultima.right) <= visivelAte + 1 : null,
      botoesDentro: maxBotaoDir !== null && visivelAte !== null ? maxBotaoDir <= visivelAte + 1 : null } };
  document.getElementById('medidas').textContent = JSON.stringify(out);
}
</script>`;

/** Site temporário: css/js/portal reais (links simbólicos) e uma página medível por conjunto de dados, a partir de pages/funcionarios.html. */
function prepararSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geometria-funcionarios-'));
  fs.mkdirSync(path.join(dir, 'pages'));
  for (const sub of ['css', 'js', 'portal']) fs.symlinkSync(path.join(RAIZ, sub), path.join(dir, sub));
  const base = fs.readFileSync(path.join(RAIZ, 'pages', 'funcionarios.html'), 'utf8').replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '');
  for (const conjunto of Object.keys(CONJUNTOS)) {
    let html = base.replace('<script src="../js/tema.js"></script>', `<script src="../js/tema.js"></script>${ESTILO_ICONES}${fetchSimulado(gerarFuncionarios(conjunto))}`);
    html = html.replace('</body>', `${MEDIDOR}</body>`);
    fs.writeFileSync(path.join(dir, 'pages', `medida-${conjunto}.html`), html);
  }
  return dir;
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function servir(dir) {
  const servidor = http.createServer((req, res) => {
    const alvo = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!alvo.startsWith(dir) || !fs.existsSync(alvo) || fs.statSync(alvo).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(alvo)] || 'application/octet-stream' });
    fs.createReadStream(alvo).pipe(res);
  });
  return new Promise((resolve) => servidor.listen(0, '127.0.0.1', () => resolve({ servidor, porta: servidor.address().port })));
}

/**
 * O Chrome escreve o DOM e não encerra sozinho em alguns ambientes (e com stdout em pipe pode nem descarregar): a saída vai
 * para um arquivo, lido a cada 300 ms até aparecer </html>; então o processo (e o grupo dele) é finalizado.
 */
function dumpDom(chrome, url, largura, limiteMs = 60000) {
  return new Promise((resolve) => {
    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-geometria-'));
    const arquivo = path.join(perfil, 'dom.html');
    const fd = fs.openSync(arquivo, 'w');
    const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-background-networking', `--user-data-dir=${perfil}`, `--window-size=${largura},900`, '--virtual-time-budget=6000', '--dump-dom', url], { stdio: ['ignore', fd, 'ignore'], detached: true });
    let pronto = false;
    const ler = () => { try { return fs.readFileSync(arquivo, 'utf8'); } catch { return ''; } };
    const terminar = () => {
      if (pronto) return;
      pronto = true;
      clearInterval(relogio);
      clearTimeout(limite);
      const saida = ler();
      for (const matar of [() => process.kill(-p.pid, 'SIGKILL'), () => p.kill('SIGKILL')]) { try { matar(); } catch { /* já encerrado */ } }
      try { fs.closeSync(fd); } catch { /* já fechado */ }
      setTimeout(() => { fs.rmSync(perfil, { recursive: true, force: true }); resolve(saida); }, 200);
    };
    const relogio = setInterval(() => { if (ler().includes('</html>')) terminar(); }, 300);
    const limite = setTimeout(terminar, limiteMs);
    p.on('exit', () => setTimeout(terminar, 100));
  });
}

/** Mede as larguras pedidas com o conjunto de dados escolhido ('tipicos' ou 'longos'). Devolve um resultado por largura. */
async function medirGeometria(larguras, { chrome = chromeDisponivel(), tentativas = 3, dados = 'tipicos' } = {}) {
  if (!chrome) throw new Error('Chrome não encontrado');
  if (!CONJUNTOS[dados]) throw new TypeError(`conjunto de dados desconhecido: ${dados}`);
  const dir = prepararSite();
  const { servidor, porta } = await servir(dir);
  try {
    const resultados = [];
    for (const largura of larguras) {
      let medida = { vw: largura, erro: 'sem medidas' };
      for (let i = 0; i < tentativas; i += 1) {
        const dom = await dumpDom(chrome, `http://127.0.0.1:${porta}/pages/medida-${dados}.html`, largura);
        const m = /<pre id="medidas"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
        if (m && m[1].trim()) {
          medida = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
          if (medida.linhas > 0) break;
        }
      }
      resultados.push(medida);
    }
    return resultados;
  } finally {
    servidor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { chromeDisponivel, medirGeometria, prepararSite, CONJUNTOS };
