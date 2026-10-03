'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Ajustes de interface da E6: os nomes "Gestão de estoque" e "Análise de
 * estoque", o subtítulo da Gestão de estoque, as páginas internas sem o
 * cabeçalho repetido de conta e o bloco compacto de conta só no Dashboard.
 * Inspeção estática; o comportamento do bloco está em dashboard.test.js e o
 * do módulo de sessão em sessao-empresarial.test.js.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const PAGINAS = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html')).sort();
const INTERNAS = ['materials', 'available-items', 'employee-groups', 'employee-history', 'import-employees', 'grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais'];
const SUBTITULO = 'Cadastre materiais e gerencie entradas, lotes, validade de CA, saldos e baixas de estoque.';
// 12D-3: a página passou a mostrar a posição (físico utilizável, comprometido e saldo livre).
const SUBTITULO_ANALISE = 'Consulte a posição do estoque por categoria, tipo e tamanho: o que está fisicamente utilizável, o que já está comprometido com solicitações aprovadas e o saldo livre. Filtre pela validade do CA e identifique itens abaixo do mínimo, sem estoque ou sem cobertura.';

const rotulosDoMenu = (html, icone) => [...html.matchAll(new RegExp(`<div class="nav-icon [a-z]+">${icone}</div>([^<]*)</a>`, 'g'))].map((m) => m[1]);

describe('nomes: Gestão de estoque e Análise de estoque', () => {
  // As quatro páginas de Administração têm menu próprio, sem a seção Estoque.
  const MENU_ADMINISTRATIVO = ['autorizacoes-individuais.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'grupos-acesso.html'];

  test('o menu usa os nomes novos em todas as páginas que têm a seção Estoque, e nenhuma página usa os antigos', () => {
    for (const arquivo of PAGINAS) {
      const html = ler(`pages/${arquivo}`);
      assert.equal(/inventory_2<\/div>Materiais<\/a>|checklist<\/div>Itens Disponíveis<\/a>/.test(html), false, arquivo);
      const estoque = rotulosDoMenu(html, 'inventory_2');
      const analise = rotulosDoMenu(html, 'checklist');
      if (MENU_ADMINISTRATIVO.includes(arquivo)) {
        assert.deepEqual([estoque, analise], [[], []], arquivo);
        continue;
      }
      assert.ok(estoque.length >= 1 && estoque.every((r) => r === 'Gestão de estoque'), `${arquivo}: ${JSON.stringify(estoque)}`);
      assert.ok(analise.length >= 1 && analise.every((r) => r === 'Análise de estoque'), `${arquivo}: ${JSON.stringify(analise)}`);
    }
    assert.equal(PAGINAS.length - MENU_ADMINISTRATIVO.length, 23);
  });

  test('título e cabeçalho das duas páginas', () => {
    const estoque = ler('pages/materials.html');
    assert.match(estoque, /<title>Gestão de estoque — Gestão de EPIs<\/title>/);
    assert.match(estoque, /font-weight:500">Gestão de estoque<\/h2>/);
    assert.equal(/Cadastro de Materiais/.test(semComentarios(estoque)), false);
    const analise = ler('pages/available-items.html');
    assert.match(analise, /<title>Análise de estoque — Gestão de EPIs<\/title>/);
    assert.match(analise, /font-weight:500">Análise de estoque<\/h2>/);
    assert.equal(/Itens Disponíveis/.test(semComentarios(analise)), false);
  });

  test('o subtítulo da Gestão de estoque descreve o fluxo atual: sem CA no cadastro e sem grade configurável', () => {
    const subtitulo = ler('pages/materials.html').match(/font-weight:500">Gestão de estoque<\/h2>\s*<p[^>]*>([^<]*)<\/p>/)[1];
    assert.equal(subtitulo, SUBTITULO);
    assert.equal(/grade/i.test(subtitulo), false);
    assert.equal(/por categoria, tipo, CA/.test(subtitulo), false);
  });

  test('Análise de estoque: subtítulo e título do cartão sem o nome antigo da página e sem "grade de tamanho"', () => {
    const html = ler('pages/available-items.html');
    const subtitulo = html.match(/font-weight:500">Análise de estoque<\/h2>\s*<p[^>]*>([^<]*)<\/p>/)[1];
    assert.equal(subtitulo, SUBTITULO_ANALISE);
    assert.match(html, /<h2>Consulta de estoque<\/h2>\s*<p>Posição do estoque por categoria, tipo e tamanho\.<\/p>/);
    const visivel = semComentarios(html);
    assert.equal(/itens disponíveis em estoque|Consulta de itens disponíveis|grade de tamanho/i.test(visivel), false);
    assert.match(html, /<th>Físico utilizável<\/th>/, 'o físico utilizável continua visível (o antigo "disponível" é o mesmo número)');
    assert.match(html, /<th>Saldo livre<\/th>/);
  });

  test('Portal do Cliente e Permissões do Grupo usam os nomes novos', () => {
    const inicio = ler('portal/inicio.html');
    assert.match(inicio, /<a href="\.\.\/pages\/materials\.html" data-pagina="materials" style="display:none">Gestão de estoque<\/a>/);
    assert.match(inicio, /<a href="\.\.\/pages\/available-items\.html" data-pagina="availableItems" style="display:none">Análise de estoque<\/a>/);
    const nomes = Object.fromEntries(require('../js/grupo-permissoes').RECURSOS.map((r) => [r.id, r.nome])); // eslint-disable-line global-require
    assert.deepEqual([nomes.materials, nomes.availableItems], ['Gestão de estoque', 'Análise de estoque']);
  });

  test('protótipo: main.js acha o item do menu pelo nome novo', () => {
    const main = ler('js/main.js');
    assert.match(main, /textContent\.includes\('Análise de estoque'\)/);
    assert.equal(/textContent\.includes\('Itens Disponíveis'\)/.test(main), false);
  });
});

describe('páginas internas sem o cabeçalho repetido de conta', () => {
  for (const pagina of INTERNAS) {
    test(`${pagina}: sem nome, empresa, perfil, selo, Trocar de empresa e Sair no topo; a sessão continua confirmada no servidor`, () => {
      const html = ler(`pages/${pagina}.html`);
      const codigo = semComentarios(html);
      for (const id of ['identidade', 'botaoSair', 'botaoTrocarEmpresa']) assert.equal(html.includes(`id="${id}"`), false, `#${id}`);
      assert.equal(/badge role-master/.test(html), false);
      assert.equal(/identificacao:|botaoSair:|botaoTrocar:|aoFalharSaida/.test(codigo), false);
      assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
      assert.match(html, /id="telaSessao"/);
      assert.match(html, /<a href="\.\.\/portal\/inicio\.html">/, 'o Início do Portal, que tem Sair, continua no menu');
    });
  }
});

describe('Dashboard: bloco compacto de conta no canto superior direito', () => {
  const html = ler('pages/dashboard.html');
  const codigo = semComentarios(html);

  test('nome do usuário e empresa numa única área clicável, que abre o menu com Trocar de empresa e Sair', () => {
    assert.equal(html.includes('id="identidade"'), false);
    const bloco = html.slice(html.indexOf('<div id="contaUsuario"'), html.indexOf('<!-- fim do bloco de conta -->'));
    assert.match(bloco, /^<div id="contaUsuario" class="conta-usuario">/);
    assert.match(bloco, /<button id="botaoEmpresa" class="conta-botao" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="menuEmpresa">\s*<span id="contaNome" class="conta-nome"><\/span>\s*<span class="conta-empresa"><span id="contaEmpresa"><\/span>/);
    assert.match(bloco, /<div id="menuEmpresa" class="conta-menu" role="menu" style="display:none">/);
    assert.match(bloco, /<button id="botaoTrocarEmpresa" type="button" role="menuitem" style="display:none">[\s\S]*Trocar de empresa<\/button>/);
    assert.match(bloco, /<button id="botaoSair" type="button" role="menuitem">[\s\S]*Sair<\/button>/);
    assert.ok(html.indexOf('<div id="contaUsuario"') > html.indexOf('<section class="dashboard-hero'), 'dentro do topo do Dashboard');
  });

  test('o script entrega nome, empresa, Trocar e Sair ao módulo de sessão; nenhuma identificação antiga', () => {
    assert.match(codigo, /usuario: \$\('contaNome'\)/);
    assert.match(codigo, /empresa: \$\('contaEmpresa'\)/);
    assert.match(codigo, /botaoSair: \$\('botaoSair'\)/);
    assert.match(codigo, /botaoTrocar: \$\('botaoTrocarEmpresa'\)/);
    assert.match(codigo, /aoFalharSaida: function \(mensagem\) \{ mostrarAviso\(mensagem, 'erro'\); \}/);
    assert.equal(/identificacao:/.test(codigo), false);
  });

  test('estilo do bloco: no canto superior direito, e no fluxo normal em tela estreita', () => {
    assert.match(html, /\.conta-usuario\{position:absolute;top:16px;right:18px;/);
    assert.match(html, /@media \(max-width: 900px\)\{\.conta-usuario\{position:static;/);
  });
});

describe('segurança: innerHTML só com texto fixo ou HTML escapado', () => {
  const atribuicoes = (arquivo) => {
    const html = ler(arquivo);
    return [...html.slice(html.lastIndexOf('<script>')).matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  };
  // Cada origem aceita é texto fixo, uma constante da página ou uma função
  // que escapa todo valor vindo da API (js/materiais.js e js/dashboard.js).
  const ORIGENS_GESTAO = [
    /^''$/,
    /^'<div class="notice" style="' \+ cor \+ '">' \+ render\.escaparHtml\(texto\) \+ '<\/div>'$/,
    /^render\.opcoesTamanhos\(lista\)$/,
    /^'<span class="material-symbols-outlined">save<\/span>' \+ t\.salvar$/,
    /^\$\(id\)\.innerHTML \+ '<option value="' \+ render\.escaparHtml\(extra\.valor\) \+ '">' \+ render\.escaparHtml\(extra\.rotulo\) \+ '<\/option>'$/,
    /^OPCOES_ORIGINAIS\[id\]$/,
    /^'<option value="">Falha ao listar os materiais<\/option>'$/,
    /^\(lista\.length \? '<option value="">Selecione um material<\/option>' : '<option value="">Nenhum material cadastrado nesta empresa<\/option>'\) \+ render\.opcoesMateriais\(lista\)$/,
    /^dados \? estoque\.linhasLotes\(dados\.lotes\) : ''$/,
    /^estoque\.opcoesLotes\(dados \? dados\.lotes : \[\]\)$/,
    // 12D-3: painel do mínimo por tamanho, só pelo render escapado de js/estoque-minimos.js.
    /^comTabela \? Min\.render\.linhas\(painel, \{ podeEditar: podeEditar \}\) : ''$/,
    /^podeEditar \? Min\.render\.opcoesTamanhos\(painel\) : ''$/,
  ];

  test('Gestão de estoque: toda escrita em innerHTML tem origem conhecida e escapada', () => {
    const lista = atribuicoes('pages/materials.html');
    assert.ok(lista.length >= 10);
    for (const origem of lista) assert.ok(ORIGENS_GESTAO.some((re) => re.test(origem)), origem);
  });

  test('Dashboard: só o aviso usa innerHTML, com o texto escapado; nome e empresa vão por textContent', () => {
    for (const origem of atribuicoes('pages/dashboard.html')) {
      assert.match(origem, /^(''|'<div class="notice" style="' \+ cor \+ '">' \+ D\.render\.escaparHtml\(texto\) \+ '<\/div>')$/, origem);
    }
    const sessao = semComentarios(ler('js/sessao-empresarial.js'));
    assert.match(sessao, /el\.usuario\.textContent = /);
    assert.match(sessao, /el\.empresa\.textContent = /);
    assert.equal(/innerHTML/.test(sessao), false);
  });
});
