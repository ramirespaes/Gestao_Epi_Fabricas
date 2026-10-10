'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');
const { estiloComputado, token } = require('./helpers/estilo-computado');

const P = require('../js/permissoes-efetivas');
const G = require('../js/grupo-permissoes');

/**
 * 12G-1 — fundação das telas da solicitação de EPI: Pedido de EPI
 * (request.html), Aprovação da Segurança do Trabalho (supervisor-approval.html)
 * e Entregas por solicitação (stock-requests.html) saem do protótipo (login
 * simulado, banco simulado, CDN, "Cobresul", exemplos) e passam a usar a
 * sessão e as permissões reais, com os estados padrão. Os fluxos (criar,
 * decidir, entregar, encerrar) são das subetapas seguintes; aqui só a
 * estrutura, o menu, o Portal, as permissões e a tela de permissões de grupo.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const scriptEmbutido = (html) => html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

const NOVAS = {
  'request.html': { pagina: 'request', titulo: 'Pedido de EPI' },
  'supervisor-approval.html': { pagina: 'supervisorApproval', titulo: 'Aprovação da Segurança do Trabalho' },
  'stock-requests.html': { pagina: 'stockRequests', titulo: 'Entregas por solicitação' },
};
const SCRIPTS_FUNDACAO = ['../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/estado-pagina.js', '../js/solicitacoes-epi.js'];
// 12G-2, 12G-3 e 12G-4: o Pedido de EPI, a Aprovação e as Entregas ficaram funcionais e carregam também a Ficha e a própria tela.
const SCRIPTS = {
  'request.html': [...SCRIPTS_FUNDACAO, '../js/epi-ficha.js', '../js/pedido-epi.js'],
  'supervisor-approval.html': [...SCRIPTS_FUNDACAO, '../js/epi-ficha.js', '../js/aprovacao-sst.js'],
  'stock-requests.html': [...SCRIPTS_FUNDACAO, '../js/epi-ficha.js', '../js/entregas-solicitacao.js', '../js/alerta-falta-estoque.js'],
};
// Só as páginas que continuam na fundação (Pedido em pedido-epi.test.js; Aprovação em aprovacao-sst.test.js; Entregas em entregas-solicitacao.test.js).
const AINDA_EM_INTEGRACAO = [];
const EXEMPLOS = /Tício|Ticio|João Pereira|Carlos Mendes|Ana Souza|Fulano|CR-00\d|MAT-00\d|\d{2}\/04\/2026|3 pendências|Saldo atual: 60/;

// As 11 integradas antes da 12G-1 e as três desta subetapa.
// Configurações (05/10/2026) passou a página integrada depois da 12G-1.
const INTEGRADAS_ANTES = ['available-items.html', 'config.html', 'dashboard.html', 'delivered-items.html', 'employee-groups.html', 'employee-history.html', 'epi-ficha.html', 'funcionarios.html', 'import-employees.html', 'materials.html', 'operations.html', 'reports.html', 'stock-validity.html', 'gestao-usuarios.html'];
const INTEGRADAS = [...INTEGRADAS_ANTES, ...Object.keys(NOVAS)].sort();
const ADMINISTRATIVAS = ['autorizacoes-individuais.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'grupos-acesso.html', 'new-user.html', 'user-admin.html'];
const COM_MENU_COMPLETO = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html') && !ADMINISTRATIVAS.includes(f)).sort();

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

// ─────────────────────────────────────────────────────────────────────
// Fixtures de rede
// ─────────────────────────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
function permissoes({ perfil = 'USUARIO', request = NENHUMA, acoes = {} } = {}) {
  return {
    status: 'ok', empresaId: 3, usuarioId: 7, perfil, recursos: { request }, acoes,
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: false }, vinculosSst: area(perfil === 'MASTER'),
    },
  };
}
function rotas(p) {
  return {
    'GET /auth/me': { status: 200, corpo: { status: 'ok', usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@example.invalid', perfil: p.perfil }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } } },
    'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
    'GET /auth/permissoes': { status: 200, corpo: p },
  };
}
const QUEM_ABRE = {
  'request.html': permissoes({ request: { ...NENHUMA, visualizar: true, criar: true } }),
  'supervisor-approval.html': permissoes({ acoes: { APROVAR_SOLICITACAO: true, REPROVAR_SOLICITACAO: true } }),
  'stock-requests.html': permissoes({ acoes: { REALIZAR_ENTREGA: true, ENCERRAR_SOLICITACAO: true } }),
};
const estado = (pg) => {
  const lista = pg.consulta('#estadoPagina [data-estado]');
  return lista.length === 0 ? null : lista[0].getAttribute('data-estado');
};

// ─────────────────────────────────────────────────────────────────────
describe('as três páginas saem do protótipo (inspeção estática)', () => {
  for (const [arquivo, { pagina, titulo }] of Object.entries(NOVAS)) {
    const html = ler(`pages/${arquivo}`);
    const codigo = semComentarios(html);

    test(`${arquivo}: título "${titulo}" no <title> e no cabeçalho; tema antes de pintar`, () => {
      assert.match(html, new RegExp(`<title>${titulo} — Gestão de EPIs</title>`));
      assert.match(html, new RegExp(`font-weight:500">${titulo}</h2>`));
      assert.match(html.split('</head>')[0], /<link rel="stylesheet" href="\.\.\/css\/main\.css">\s*<script src="\.\.\/js\/tema\.js"><\/script>/);
    });

    test(`${arquivo}: só scripts locais, na ordem da fundação; sem protótipo, sem CDN, sem armazenamento`, () => {
      const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).filter((s) => s !== '../js/tema.js');
      assert.deepEqual(srcs, SCRIPTS[arquivo]);
      assert.equal(/main\.js|db-api\.js|cdn\.jsdelivr|xlsx/.test(codigo), false);
      assert.equal(/localStorage|sessionStorage|document\.cookie|indexedDB/.test(semComentarios(scriptEmbutido(html))), false);
      assert.equal(/\.innerHTML\s*=/.test(scriptEmbutido(html)), false, 'o script da página não escreve HTML');
    });

    test(`${arquivo}: sem login simulado, quiosque, biometria, "Cobresul" ou exemplos fictícios`, () => {
      assert.equal(/loginScreen|doLogin|biometric|kiosk|Quiosque|selfServiceLogout|recoverPanel/i.test(codigo), false);
      assert.equal(/Cobresul/i.test(html), false);
      assert.equal(EXEMPLOS.test(codigo), false);
      assert.equal(/Aprovação do Supervisor|Sem Estoque|Solicitações sem Estoque/.test(codigo), false);
    });

    test(`${arquivo}: sessão real, conteúdo protegido nascendo oculto, estados e a página "${pagina}" nas permissões`, () => {
      for (const id of ['telaSessao', 'telaSessaoMensagem', 'telaSessaoPortal', 'estadoPagina']) assert.match(html, new RegExp(`id="${id}"`), id);
      assert.match(html, /<div id="conteudoProtegido" style="display:none">/);
      const script = semComentarios(scriptEmbutido(html));
      assert.match(script, /EpiHttp\.configurar\(\{ baseUrl: window\.SAFEWORK_PORTAL_API_BASE_URL \}\)/);
      assert.match(script, new RegExp(`EpiEstadoPagina\\.montarPaginaProtegida\\(\\{\\s*pagina: '${pagina}'`));
      for (const id of ['identidade', 'botaoSair', 'botaoTrocarEmpresa']) assert.equal(html.includes(`id="${id}"`), false, `#${id}: sem cabeçalho de conta (E6)`);
      assert.match(html, /<a href="\.\.\/portal\/inicio\.html">/, 'o Início do Portal, que tem Sair');
      assert.match(html, new RegExp(`<a class="active" href="javascript:void\\(0\\)" data-pagina="${pagina}" style="display:none">`));
    });
  }

  test('request.html: sem campo de CPF e sem "Único" (o servidor não usa tamanho fictício)', () => {
    const codigo = semComentarios(ler('pages/request.html'));
    assert.equal(/\bCPF\b|requestCpf/i.test(codigo), false);
    assert.equal(/>Único</.test(codigo), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('as três páginas abertas como no navegador', () => {
  for (const [arquivo, { pagina }] of Object.entries(NOVAS)) {
    if (AINDA_EM_INTEGRACAO.includes(arquivo)) test(`${arquivo}: com a permissão, o conteúdo aparece; as áreas ainda sem fluxo dizem "em integração" e não têm controle ativo`, async () => {
      const pg = abrirPagina(`pages/${arquivo}`, { rotas: rotas(QUEM_ABRE[arquivo]) });
      await pg.esperar();
      assert.deepEqual(pg.chamadas.map((c) => c.chave), ['GET /auth/me', 'GET /auth/global/me', 'GET /auth/permissoes'], 'a fundação não consulta solicitações');
      assert.equal(pg.visivel('conteudoProtegido'), true);
      assert.equal(estado(pg), null);
      const areas = pg.consulta('#conteudoProtegido [data-area-integracao]');
      assert.ok(areas.length >= 1, `${arquivo}: área em integração marcada`);
      for (const a of areas) assert.equal(a.querySelectorAll('[data-estado="em-integracao"]').length, 1, `${arquivo}: estado em integração`);
      const controles = pg.consulta('#conteudoProtegido button').concat(pg.consulta('#conteudoProtegido input'), pg.consulta('#conteudoProtegido select'), pg.consulta('#conteudoProtegido textarea'));
      for (const c of controles) assert.equal(c.disabled, true, `${arquivo}: controle sem fluxo ainda ativo (${c.id || c.localName})`);
      assert.deepEqual(pg.storage.filter((s) => !(s.operacao === 'removeItem' || s.storage === 'cookie')), []);
      assert.deepEqual(pg.documento.usosDeInnerHTML, []);
      assert.deepEqual(pg.externas, []);
      const ativo = pg.consulta(`.nav a[data-pagina="${pagina}"]`)[0];
      assert.equal(pg.visivelNo(ativo), true, 'o próprio item aparece no menu');
    });

    test(`${arquivo}: MASTER sem concessão de solicitação e usuário sem nada recebem acesso negado; nada protegido aparece`, async () => {
      for (const p of [permissoes({ perfil: 'MASTER' }), permissoes()]) {
        const pg = abrirPagina(`pages/${arquivo}`, { rotas: rotas(p) });
        await pg.esperar();
        assert.equal(estado(pg), 'acesso-negado', p.perfil);
        assert.equal(pg.visivel('conteudoProtegido'), false, p.perfil);
        for (const novo of ['request', 'supervisorApproval', 'stockRequests']) {
          assert.equal(pg.visivelNo(pg.consulta(`.nav a[data-pagina="${novo}"]`)[0]), false, `${p.perfil}: ${novo} oculto no menu`);
        }
      }
    });
  }

  test('quem abre cada página: Pedido com ver OU criar; Aprovação com APROVAR; Entregas com REALIZAR_ENTREGA OU ENCERRAR', () => {
    const casos = [
      ['request', permissoes({ request: { ...NENHUMA, visualizar: true } }), true],
      ['request', permissoes({ request: { ...NENHUMA, criar: true } }), true],
      ['request', permissoes({ request: { ...NENHUMA, editar: true } }), false],
      ['supervisorApproval', permissoes({ acoes: { APROVAR_SOLICITACAO: true } }), true],
      ['supervisorApproval', permissoes({ acoes: { REPROVAR_SOLICITACAO: true } }), false, 'a fila exige APROVAR no servidor'],
      ['supervisorApproval', permissoes({ acoes: { ENCERRAR_SOLICITACAO: true } }), false],
      ['stockRequests', permissoes({ acoes: { REALIZAR_ENTREGA: true } }), true],
      ['stockRequests', permissoes({ acoes: { ENCERRAR_SOLICITACAO: true } }), true],
      ['stockRequests', permissoes({ acoes: { APROVAR_SOLICITACAO: true } }), false],
      ['request', permissoes({ perfil: 'MASTER' }), false], ['supervisorApproval', permissoes({ perfil: 'MASTER' }), false], ['stockRequests', permissoes({ perfil: 'MASTER' }), false],
    ];
    for (const [pagina, p, esperado, nota] of casos) assert.equal(P.podeAbrir(p, pagina), esperado, `${pagina} ${JSON.stringify(p.recursos.request)} ${JSON.stringify(p.acoes)} ${nota || ''}`);
    assert.deepEqual(P.PAGINAS.request, { abrir: [{ recurso: 'request', operacao: 'visualizar' }, { recurso: 'request', operacao: 'criar' }], abrirComQualquer: true, alterar: [] });
    assert.deepEqual(P.PAGINAS.supervisorApproval, { abrir: [{ acao: 'APROVAR_SOLICITACAO' }], alterar: [] });
    assert.deepEqual(P.PAGINAS.stockRequests, { abrir: [{ acao: 'REALIZAR_ENTREGA' }, { acao: 'ENCERRAR_SOLICITACAO' }], abrirComQualquer: true, alterar: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('ajuste visual final: nada em integração parece funcionar, e nada de desenvolvimento aparece ao usuário', () => {
  const html = (arquivo) => semComentarios(ler(`pages/${arquivo}`));

  // Estilo que VENCE de fato na cascata (main.css + <style> da página sobre o DOM real), não a presença da regra.
  // 12G-2: os controles do Pedido de EPI funcionam e saíram daqui; ficam os que ainda estão em integração.
  // 12G-6: o "Gerar alerta" das Entregas funciona e também saiu (alerta-falta-estoque.test.js).
  const ALVOS = {};
  const PROPS = ['opacity', 'filter', 'cursor', 'color', 'background', 'background-color', 'border', 'border-color', 'box-shadow'];
  for (const [arquivo, nomes] of Object.entries(ALVOS)) {
    for (const tema of ['light', 'dark']) {
      test(`${arquivo} (tema ${tema}): ${nomes.join(', ')} ficam cinza, apagados, sem o azul de ação, com cursor de bloqueio, também sob o mouse`, async () => {
        const pg = abrirPagina(`pages/${arquivo}`, { rotas: rotas(QUEM_ABRE[arquivo]) });
        await pg.esperar();
        pg.documento.documentElement.setAttribute('data-theme', tema);
        const neutro = { fundo: token(pg, `pages/${arquivo}`, '--surface-container-high'), texto: token(pg, `pages/${arquivo}`, '--on-surface-variant'), borda: token(pg, `pages/${arquivo}`, '--outline-variant') };
        const azul = token(pg, `pages/${arquivo}`, '--primary').toLowerCase();
        const controles = pg.consulta('[data-area-integracao] button, [data-area-integracao] select, .botao-em-integracao');
        for (const nome of nomes) {
          const el = controles.find((c) => c.getAttribute('id') === nome || c.textContent.replace(/send|notifications_active|Em integração/g, '').trim() === nome);
          assert.ok(el, `${arquivo}: ${nome}`);
          assert.equal(el.disabled, true, `${nome}: desabilitado de verdade`);
          for (const hover of [false, true]) {
            const e = estiloComputado(pg, `pages/${arquivo}`, el, PROPS, { hover });
            const onde = `${arquivo} ${tema} ${nome}${hover ? ' (mouse em cima)' : ''}: ${JSON.stringify(e)}`;
            assert.ok(Number(e.opacity) <= 0.6, onde);
            assert.match(String(e.filter), /grayscale\(1\)/, onde);
            assert.equal(e.cursor, 'not-allowed', onde);
            assert.equal(e.color, neutro.texto, onde);
            assert.equal(e.background, neutro.fundo, onde);
            assert.ok(String(e.border).includes(neutro.borda), onde);
            for (const p of ['color', 'background', 'background-color', 'border', 'border-color']) {
              assert.equal(String(e[p]).toLowerCase().includes(azul), false, `${onde} — ${p} ainda tem o azul de ação`);
            }
          }
        }
      });
    }
  }

  test('Aprovação da Segurança do Trabalho: sem o selo "Workflow" (termo interno)', () => {
    assert.equal(/Workflow/.test(html('supervisor-approval.html')), false);
  });

  test('Entregas por solicitação: sem o quadro de regra futura na tela; a regra fica preservada como comentário da página; "Gerar alerta" (12G-6) nasce oculto e desabilitado, sem "Em integração"', () => {
    const visivel = html('stock-requests.html');
    assert.equal(/alert-banner|Alertas de materiais pendentes|Quando um funcionário solicitar um material sem estoque/.test(visivel), false);
    assert.match(ler('pages/stock-requests.html'), /<!--[\s\S]*Quando um funcionário solicitar um material sem estoque, o item deve aparecer nesta lista e gerar alerta para compras\/almoxarifado[\s\S]*-->/);
    const gerar = visivel.match(/<button [^>]*id="botaoGerarAlerta"[^>]*>[\s\S]*?<\/button>/)[0];
    assert.match(gerar, /\sdisabled[\s>]/);
    assert.match(gerar, /style="display:none"/);
    assert.equal(/botao-em-integracao|Em integração/.test(gerar), false);
  });

  test('abertas no navegador: nenhum controle da área em integração fica ativo', async () => {
    for (const arquivo of ['stock-requests.html']) {
      const pg = abrirPagina(`pages/${arquivo}`, { rotas: rotas(QUEM_ABRE[arquivo]) });
      await pg.esperar();
      const ativos = pg.consulta('[data-area-integracao] button, [data-area-integracao] select, .botao-em-integracao').filter((c) => !c.disabled);
      assert.deepEqual(ativos.map((c) => c.textContent.trim()), [], arquivo);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('menu, Portal e Permissões do Grupo', () => {
  test('nas 17 páginas integradas com menu completo, Solicitações liga as três páginas por permissão; o Totem segue "Em integração"', () => {
    assert.equal(INTEGRADAS.length, 17);
    const destino = { 'Pedido de EPI': ['request.html', 'request'], 'Aprovação da Segurança do Trabalho': ['supervisor-approval.html', 'supervisorApproval'], 'Entregas por solicitação': ['stock-requests.html', 'stockRequests'] };
    for (const arquivo of INTEGRADAS) {
      const itens = secao(ler(`pages/${arquivo}`), 'Solicitações').itens;
      assert.deepEqual(itens.map((i) => i.rotulo), ['Autoatendimento (Totem)', ...Object.keys(destino)], arquivo);
      assert.match(itens[0].html, /class="nav-pendente"[\s\S]*Em integração/, arquivo);
      for (const item of itens.slice(1)) {
        const [href, pagina] = destino[item.rotulo];
        const esperado = NOVAS[arquivo] && NOVAS[arquivo].pagina === pagina
          ? `<a class="active" href="javascript:void(0)" data-pagina="${pagina}" style="display:none">`
          : `<a href="${href}" data-pagina="${pagina}" style="display:none">`;
        assert.ok(item.html.startsWith(esperado), `${arquivo}: ${item.html}`);
      }
    }
  });

  test('nenhuma das 24 páginas de menu completo usa os nomes antigos; os protótipos mantêm a navegação deles com os nomes novos', () => {
    assert.equal(COM_MENU_COMPLETO.length, 23);
    for (const arquivo of COM_MENU_COMPLETO) {
      const rotulos = secao(ler(`pages/${arquivo}`), 'Solicitações').itens.map((i) => i.rotulo);
      assert.deepEqual(rotulos, ['Autoatendimento (Totem)', 'Pedido de EPI', 'Aprovação da Segurança do Trabalho', 'Entregas por solicitação'], arquivo);
    }
    for (const arquivo of COM_MENU_COMPLETO.filter((f) => !INTEGRADAS.includes(f))) {
      const itens = secao(ler(`pages/${arquivo}`), 'Solicitações').itens;
      assert.match(itens.find((i) => i.rotulo === 'Aprovação da Segurança do Trabalho').html, /data-page="supervisorApproval"/, arquivo);
      assert.match(itens.find((i) => i.rotulo === 'Entregas por solicitação').html, /data-page="stockRequests"/, arquivo);
    }
  });

  test('Portal: as três páginas entram nos módulos, na ordem do menu, ocultas até a permissão; "Solicitações e aprovações" sai de "Em integração"', () => {
    const inicio = ler('portal/inicio.html');
    const paginas = [...inicio.matchAll(/<a href="\.\.\/pages\/[^"]+" data-pagina="([^"]+)" style="display:none">/g)].map((m) => m[1]);
    assert.deepEqual(paginas, ['dashboard', 'reports', 'materials', 'stockValidity', 'availableItems', 'operations', 'employeeGroups', 'deliveredItems', 'epiFicha', 'funcionarios', 'employeeHistory',
      'request', 'supervisorApproval', 'stockRequests',
      'grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais', 'importEmployees', 'newUser', 'userAdmin', 'config']);
    assert.match(inicio, /<a href="\.\.\/pages\/request\.html" data-pagina="request" style="display:none">Pedido de EPI<\/a>/);
    assert.match(inicio, /<a href="\.\.\/pages\/supervisor-approval\.html" data-pagina="supervisorApproval" style="display:none">Aprovação da Segurança do Trabalho<\/a>/);
    assert.match(inicio, /<a href="\.\.\/pages\/stock-requests\.html" data-pagina="stockRequests" style="display:none">Entregas por solicitação<\/a>/);
    assert.equal(/Solicitações e aprovações/.test(inicio), false);
  });

  test('Permissões do Grupo: "request" é funcional (Visualizar, Criar, Editar); Aprovação e Entregas explicam que valem as ações', () => {
    const porId = Object.fromEntries(G.RECURSOS.map((r) => [r.id, r]));
    assert.deepEqual(porId.request, { id: 'request', nome: 'Pedido de EPI', operacoes: ['podeVisualizar', 'podeCriar', 'podeEditar'] });
    const linha = G.render.linhaRecurso(porId.request, null);
    assert.equal((linha.match(/<select/g) || []).length, 3);
    assert.equal((linha.match(/class="nao-se-aplica"/g) || []).length, 1, 'Excluir não se aplica: nenhuma rota usa');
    assert.match(linha, /data-acao="salvar-recurso"/);
    assert.equal(porId.supervisorApproval.nome, 'Aprovação da Segurança do Trabalho');
    assert.match(porId.supervisorApproval.nota, /Aprovar solicitação/);
    assert.match(porId.supervisorApproval.nota, /Reprovar solicitação/);
    assert.equal(porId.stockRequests.nome, 'Entregas por solicitação');
    assert.match(porId.stockRequests.nota, /Realizar entrega/);
    assert.match(porId.stockRequests.nota, /Encerrar solicitação/);
    for (const id of ['supervisorApproval', 'stockRequests']) {
      assert.deepEqual(porId[id].operacoes, [], id);
      assert.equal(/Em integração/.test(porId[id].nota), false, id);
    }
  });

  test('publicação: os dois módulos novos e as três páginas estão na allowlist, com tudo o que as páginas carregam', () => {
    const publicados = JSON.parse(ler('publicacao/allowlist.json')).arquivos;
    for (const f of ['js/estado-pagina.js', 'js/solicitacoes-epi.js', 'pages/request.html', 'pages/supervisor-approval.html', 'pages/stock-requests.html']) {
      assert.ok(publicados.includes(f), f);
    }
    for (const arquivo of Object.keys(NOVAS)) {
      for (const src of [...ler(`pages/${arquivo}`).matchAll(/<script src="\.\.\/([^"]+)"><\/script>/g)].map((m) => m[1])) {
        assert.ok(publicados.includes(src), `${arquivo} carrega ${src}`);
      }
    }
  });
});
