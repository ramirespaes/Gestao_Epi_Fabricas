'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * E10 — fechamento da sequência E: contratos de interface que não podem
 * voltar atrás. GHE sem CA mestre, organização do menu, tema do sistema
 * operacional e nomes dos módulos.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('GHE e EPIs: sem CA mestre', () => {
  const G = require('../js/grupos-homogeneos'); // eslint-disable-line global-require
  const material = (extra = {}) => ({ id: 11, nome: 'Luva de raspa', tipo: 'Luva', categoria: 'EPI', codigoInterno: 'EPI-011', caNumero: 'CA-MESTRE-9', prazoUsoDias: 90, unidade: 'par', ativo: true, vinculado: false, ...extra });

  test('a matriz não mostra CA: nem coluna, nem valor vindo do cadastro', () => {
    const html = G.render.linhasMatriz([material()], [], { podeEditar: true });
    assert.equal(html.includes('CA-MESTRE-9'), false);
    assert.equal((html.match(/<td/g) || []).length, 6, 'Vinculado, EPI, Categoria, Tipo, Prazo de troca e Situação');
    const pagina = ler('pages/employee-groups.html');
    const cabecalho = pagina.slice(pagina.indexOf('<th>Vinculado</th>'), pagina.indexOf('<tbody id="matrizCorpo">'));
    assert.deepEqual([...cabecalho.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]), ['Vinculado', 'EPI', 'Categoria', 'Tipo', 'Prazo de troca', 'Situação']);
  });

  test('as mensagens da matriz ocupam as seis colunas', () => {
    const script = semComentarios(ler('pages/employee-groups.html'));
    const matriz = [...script.matchAll(/\$\('matrizCorpo'\)\.innerHTML = [\s\S]*?;/g)].map((m) => m[0]).join('\n');
    const colunas = [...matriz.matchAll(/G\.render\.estado\([^)]*?, (\d+)\)/g)].map((m) => m[1]);
    assert.ok(colunas.length >= 3);
    assert.deepEqual([...new Set(colunas)], ['6']);
  });

  test('nenhum código do GHE fala em CA do material', () => {
    assert.equal(/caNumero|caValidade/.test(semComentarios(ler('js/grupos-homogeneos.js'))), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Menu: a mesma organização em todas as páginas que têm o menu completo
// ═══════════════════════════════════════════════════════════════════
const VISAO_GERAL = ['Dashboard', 'Relatórios'];
const ESTOQUE = ['Gestão de estoque', 'Compras / Entradas', 'Validade de estoque', 'Análise de estoque', 'Operações de estoque', 'Gestão de GHE', 'Regras Função / Setor'];
// As seis telas de usuários e grupos foram APOSENTADAS (só redirecionam para a Gestão de Usuários): sem menu próprio.
const ADMINISTRATIVAS = ['autorizacoes-individuais.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'grupos-acesso.html', 'new-user.html', 'user-admin.html'];
const COM_MENU_COMPLETO = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html') && !ADMINISTRATIVAS.includes(f)).sort();
// Parte F: Novo Usuário e Administração de Usuários deixaram de ser protótipo.
// Bloco 10 (10G): a Ficha de EPI passou a ser integrada.
// Bloco 12 (12G-1): Pedido de EPI, Aprovação da Segurança do Trabalho e Entregas por solicitação.
const INTEGRADAS = ['available-items.html', 'config.html', 'dashboard.html', 'delivered-items.html', 'employee-groups.html', 'employee-history.html', 'epi-ficha.html', 'funcionarios.html', 'gestao-usuarios.html', 'import-employees.html', 'materials.html', 'operations.html',
  'reports.html', 'request.html', 'stock-requests.html', 'stock-validity.html', 'supervisor-approval.html'];

/** Seções do menu lateral: [{ nome, itens: [{ rotulo, html }] }]. */
function secoesDoMenu(html) {
  const nav = html.match(/<nav class="nav">([\s\S]*?)<\/nav>/)[1];
  const secoes = [];
  for (const m of nav.matchAll(/<div class="nav-section">([^<]*)<\/div>|<a [^>]*>[\s\S]*?<\/a>/g)) {
    if (m[1] !== undefined) { secoes.push({ nome: m[1], itens: [] }); continue; }
    const rotulo = m[0].replace(/<span class="nav-etiqueta">[\s\S]*?<\/span>/, '').replace(/<div class="nav-icon[^"]*">[^<]*<\/div>/, '').replace(/<[^>]+>/g, '').trim();
    secoes[secoes.length - 1].itens.push({ rotulo, html: m[0] });
  }
  return secoes;
}
const secao = (html, nome) => secoesDoMenu(html).find((s) => s.nome === nome);

describe('menu: Operações de estoque em ESTOQUE, na mesma ordem em todas as páginas', () => {
  test('as 24 páginas com menu completo: Visão geral só com Dashboard e Relatórios; Estoque na ordem aprovada', () => {
    assert.equal(COM_MENU_COMPLETO.length, 23);
    for (const arquivo of COM_MENU_COMPLETO) {
      const html = ler(`pages/${arquivo}`);
      assert.deepEqual(secao(html, 'Visão geral').itens.map((i) => i.rotulo), VISAO_GERAL, arquivo);
      assert.deepEqual(secao(html, 'Estoque').itens.map((i) => i.rotulo), ESTOQUE, arquivo);
    }
  });

  test('Operações de estoque nunca aparece fora de Estoque', () => {
    for (const arquivo of COM_MENU_COMPLETO) {
      for (const s of secoesDoMenu(ler(`pages/${arquivo}`))) {
        const tem = s.itens.some((i) => i.rotulo === 'Operações de estoque');
        assert.equal(tem, s.nome === 'Estoque', `${arquivo}: ${s.nome}`);
      }
    }
  });

  test('nas páginas integradas, Operações leva à página real e depende da permissão operations', () => {
    for (const arquivo of INTEGRADAS) {
      const item = secao(ler(`pages/${arquivo}`), 'Estoque').itens.find((i) => i.rotulo === 'Operações de estoque');
      const esperado = arquivo === 'operations.html'
        ? '<a class="active" href="javascript:void(0)" data-pagina="operations" style="display:none">'
        : '<a href="operations.html" data-pagina="operations" style="display:none">';
      assert.ok(item.html.startsWith(esperado), `${arquivo}: ${item.html}`);
    }
    assert.deepEqual(require('../js/permissoes-efetivas').PAGINAS.operations, { abrir: [{ recurso: 'operations', operacao: 'visualizar' }], alterar: [] }); // eslint-disable-line global-require
  });

  test('nos protótipos, GHE e EPIs leva à página real; os demais itens seguem a navegação do protótipo', () => {
    for (const arquivo of COM_MENU_COMPLETO.filter((f) => !INTEGRADAS.includes(f))) {
      const itens = secao(ler(`pages/${arquivo}`), 'Estoque').itens;
      assert.match(itens.find((i) => i.rotulo === 'Gestão de GHE').html, /^<a href="employee-groups\.html"><div class="nav-icon purple">group_work<\/div>/, arquivo);
      assert.match(itens.find((i) => i.rotulo === 'Operações de estoque').html, /data-page="operations"/, arquivo);
    }
  });

  test('Portal: os módulos integrados na ordem do menu', () => {
    const inicio = ler('portal/inicio.html');
    const paginas = [...inicio.matchAll(/<a href="\.\.\/pages\/[^"]+" data-pagina="([^"]+)" style="display:none">/g)].map((m) => m[1]);
    assert.deepEqual(paginas, ['dashboard', 'reports', 'materials', 'stockValidity', 'availableItems', 'operations', 'employeeGroups', 'deliveredItems', 'epiFicha', 'funcionarios', 'employeeHistory',
      'request', 'supervisorApproval', 'stockRequests',
      'grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais', 'importEmployees', 'newUser', 'userAdmin', 'config']);
    assert.match(inicio, /<a href="\.\.\/pages\/epi-ficha\.html" data-pagina="epiFicha" style="display:none">Ficha de EPI<\/a>/);
    assert.doesNotMatch(inicio, /Entregas e fichas de EPI/, 'a Ficha deixou de ser módulo futuro');
  });

  test('10I: Ficha de EPI é link real com data-pagina em todas as páginas integradas; "Em integração" só nos protótipos', () => {
    for (const arquivo of INTEGRADAS) {
      const itens = secao(ler(`pages/${arquivo}`), 'Entregas').itens;
      const item = itens.find((i) => i.rotulo === 'Ficha de EPI');
      const esperado = arquivo === 'epi-ficha.html'
        ? '<a class="active" href="javascript:void(0)" data-pagina="epiFicha" style="display:none">'
        : '<a href="epi-ficha.html" data-pagina="epiFicha" style="display:none">';
      assert.ok(item && item.html.startsWith(esperado), `${arquivo}: ${item && item.html}`);
      assert.doesNotMatch(item.html, /nav-pendente|Em integração/, arquivo);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tema: por identidade (Configurações), servidor vence; "sistema" segue o SO; sem botão nas páginas
// ═══════════════════════════════════════════════════════════════════
// As seis telas aposentadas (ADMINISTRATIVAS) não carregam CSS nem módulos: só o tema e o redirecionamento.
const PAGINAS_INTEGRADAS = [...INTEGRADAS].sort();

function janelaFalsa(escuroInicial) {
  const atributos = {};
  const ouvintes = [];
  const consulta = { matches: escuroInicial, media: '', addEventListener: (ev, fn) => { if (ev === 'change') ouvintes.push(fn); } };
  return {
    atributos,
    mudar(escuro) { consulta.matches = escuro; ouvintes.forEach((fn) => fn({ matches: escuro })); },
    matchMedia: (q) => { consulta.media = q; return consulta; },
    document: { documentElement: { style: {}, setAttribute: (k, v) => { atributos[k] = v; } } },
  };
}

describe('tema claro e escuro automático', () => {
  test('o tema segue o sistema: escuro liga data-theme="dark", claro liga "light", e acompanha a troca na sessão', () => {
    const T = require('../js/tema'); // eslint-disable-line global-require
    const escura = janelaFalsa(true);
    T.iniciar(escura);
    assert.deepEqual([escura.atributos['data-theme'], escura.document.documentElement.style.colorScheme], ['dark', 'dark']);
    escura.mudar(false);
    assert.deepEqual([escura.atributos['data-theme'], escura.document.documentElement.style.colorScheme], ['light', 'light']);
    const clara = janelaFalsa(false);
    T.iniciar(clara);
    assert.equal(clara.atributos['data-theme'], 'light');
    clara.mudar(true);
    assert.equal(clara.atributos['data-theme'], 'dark');
    assert.equal(T.CONSULTA, '(prefers-color-scheme: dark)');
  });

  test('sem matchMedia (navegador antigo) fica no claro, sem erro', () => {
    const T = require('../js/tema'); // eslint-disable-line global-require
    const janela = janelaFalsa(false);
    delete janela.matchMedia;
    T.iniciar(janela);
    assert.equal(janela.atributos['data-theme'], 'light');
  });

  test('sem botão: o módulo não usa cookie, sessionStorage nem indexedDB; o localStorage é só o cache de pintura "safework-aparencia" (Configurações)', () => {
    const codigo = semComentarios(ler('js/tema.js'));
    assert.equal(/sessionStorage|document\.cookie|indexedDB|addEventListener\('click'/.test(codigo), false);
    assert.equal((codigo.match(/localStorage/g) || []).length, 1);
    assert.equal((codigo.match(/(setItem|getItem|removeItem)\(/g) || []).length, 3);
    assert.equal((codigo.match(/(setItem|getItem|removeItem)\(CHAVE_CACHE/g) || []).length, 3);
  });

  test('as 17 páginas integradas carregam o tema no <head>, logo depois do CSS, antes de pintar', () => {
    assert.equal(PAGINAS_INTEGRADAS.length, 17);
    for (const arquivo of PAGINAS_INTEGRADAS) {
      const head = ler(`pages/${arquivo}`).split('</head>')[0];
      assert.match(head, /<link rel="stylesheet" href="\.\.\/css\/main\.css">\s*<script src="\.\.\/js\/tema\.js"><\/script>/, arquivo);
    }
    assert.ok(JSON.parse(ler('publicacao/allowlist.json')).arquivos.includes('js/tema.js'));
  });

  test('contraste no escuro: selos, avisos com cor fixa e o botão do menu no celular usam os tokens do tema', () => {
    const css = ler('css/main.css');
    for (const regra of [
      /html\[data-theme="dark"\] \.badge-ok\{color:var\(--success\)\}/,
      /html\[data-theme="dark"\] \.badge-warning\{color:var\(--warning\)\}/,
      /html\[data-theme="dark"\] \.badge-danger\{color:[^}]+\}/,
      /html\[data-theme="dark"\] \.notice\{color:var\(--on-surface\) !important\}/,
      /html\[data-theme="dark"\] \.mobile-global-menu\{[^}]*background:var\(--surface-container\)[^}]*\}/,
      /html\[data-theme="dark"\] \.mobile-global-menu svg line\{stroke:var\(--on-surface\)\}/,
    ]) assert.match(css, regra);
  });

  test('Portal: login, empresas e início seguem o sistema pelo CSS, com tokens escuros e sem fundo branco fixo', () => {
    const portal = ler('portal/portal.css');
    assert.match(portal, /@media \(prefers-color-scheme: dark\) \{\s*:root \{[^}]*--fundo:[^}]*\}/);
    assert.match(portal, /color-scheme: light dark/);
    assert.equal(/background: #fff\b/.test(portal), false);
    const login = ler('portal/index.html');
    assert.match(login, /@media \(prefers-color-scheme: dark\) \{\s*:root \{[^}]*--bg:[^}]*\}/);
    assert.equal(/color-scheme: light;/.test(login), false);
  });
});
