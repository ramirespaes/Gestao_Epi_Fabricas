'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../js/permissoes-efetivas');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Gestão de Funcionários — entrada no menu lateral (RED/GREEN da integração de navegação).
 *
 * Uma única entrada "Funcionários", na seção Entregas, logo antes de "Histórico de Funcionários", em todas as páginas integradas
 * com menu (as que têm `data-pagina="userAdmin"`, a mesma referência da Gestão de Usuários). Visibilidade = PAGINAS.funcionarios
 * (employeeHistory.visualizar); criar e editar são capacidades dentro da página, nunca itens de menu.
 */
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const COM_MENU = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html') && /data-pagina="userAdmin"/.test(ler(`pages/${f}`))).sort();

const LINK = '<a href="funcionarios.html" data-pagina="funcionarios" style="display:none"><div class="nav-icon teal">people</div>Cadastro de Colaboradores</a>';
const HISTORICO ='<a href="employee-history.html" data-pagina="employeeHistory" style="display:none"><div class="nav-icon blue">history</div>Histórico de Funcionários</a>';
const HISTORICO_ATIVO = '<a class="active" href="javascript:void(0)" data-pagina="employeeHistory" style="display:none"><div class="nav-icon blue">history</div>Histórico de Funcionários</a>';

const nav = (h) => h.match(/<nav class="nav">([\s\S]*?)<\/nav>/)?.[1];
const secao = (html, nome) => {
  const nav = html.match(/<nav class="nav">([\s\S]*?)<\/nav>/)[1];
  const partes = nav.split(/(?=<div class="nav-section">)/);
  const parte = partes.find((p) => p.startsWith(`<div class="nav-section">${nome}</div>`));
  return parte ? [...parte.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]) : [];
};

describe('menu lateral: entrada Funcionários', () => {
  test('a referência de páginas com menu integrado é a mesma da Gestão de Usuários: as 16 de antes e a própria funcionarios.html (17)', () => {
    assert.equal(COM_MENU.length, 17, COM_MENU.join(', '));
    assert.ok(COM_MENU.includes('funcionarios.html'));
  });

  test('em cada página integrada: exatamente uma entrada, na seção Entregas, imediatamente antes do Histórico de Funcionários (em funcionarios.html, como página atual)', () => {
    for (const arquivo of COM_MENU) {
      const html = ler(`pages/${arquivo}`);
      const entrada = arquivo === 'funcionarios.html' ? LINK_ATIVO : LINK;
      assert.equal(html.split(entrada).length - 1, 1, `${arquivo}: uma única entrada exata`);
      assert.equal(html.split('data-pagina="funcionarios"').length - 1, 1, `${arquivo}: nenhum outro link para a página`);
      const entregas = secao(html, 'Entregas');
      const i = entregas.indexOf(entrada);
      assert.ok(i !== -1, `${arquivo}: fora da seção Entregas`);
      const proximo = entregas[i + 1];
      assert.ok(proximo === (arquivo === 'employee-history.html' ? HISTORICO_ATIVO : HISTORICO), `${arquivo}: antes do Histórico (${proximo})`);
    }
  });

  test('não há itens de menu para Cadastrar nem Editar Funcionário, e o Histórico, a Importação e a Gestão de GHE continuam com o mesmo link', () => {
    for (const arquivo of COM_MENU) {
      const html = ler(`pages/${arquivo}`);
      assert.doesNotMatch(nav(html), />\s*(Cadastrar|Editar|Novo) Funcionário\s*</i, arquivo);
      assert.ok(html.includes(arquivo === 'employee-history.html' ? HISTORICO_ATIVO : HISTORICO), `${arquivo}: Histórico`);
      assert.match(html, /data-pagina="importEmployees"[^>]*><div class="nav-icon green">upload_file<\/div>Importar Funcionários<\/a>/, arquivo);
      assert.match(html, /data-pagina="employeeGroups"/, arquivo);
    }
  });

  test('a visibilidade segue PAGINAS.funcionarios: só employeeHistory.visualizar mostra a entrada; criar ou editar sozinhos não', () => {
    assert.deepEqual(P.PAGINAS.funcionarios.abrir, [{ recurso: 'employeeHistory', operacao: 'visualizar' }]);
    const perm = (v, c, e) => ({ recursos: { employeeHistory: { visualizar: v, criar: c, editar: e, excluir: false } }, acoes: {}, administracao: {} });
    const link = () => {
      const html = ler('pages/materials.html');
      const pagina = html.match(/<a href="funcionarios\.html" data-pagina="([^"]+)" style="display:none">/);
      assert.ok(pagina, 'a entrada existe na página real');
      return { getAttribute: (n) => (n === 'data-pagina' ? pagina[1] : null), style: { display: 'none' } };
    };
    for (const [permissoes, visivel] of [[perm(true, false, false), true], [perm(true, true, true), true], [perm(false, true, true), false], [perm(false, false, false), false], [null, false]]) {
      const a = link();
      P.aplicarMenu(permissoes, [a]);
      assert.equal(a.style.display === '', visivel, JSON.stringify(permissoes));
    }
    assert.equal(P.NAVEGACAO_OCULTA === undefined || !P.NAVEGACAO_OCULTA.includes('funcionarios'), true);
  });

  test('os protótipos com barra própria não foram tocados', () => {
    for (const arquivo of ['lgpd.html', 'purchases.html', 'eligibility-rules.html', 'self-service.html', 'support.html', 'emails-gestao.html']) {
      assert.doesNotMatch(ler(`pages/${arquivo}`), /funcionarios\.html|data-pagina="funcionarios"/, arquivo);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Início do Portal: a lista "Módulos já integrados" (links com data-pagina, mostrados por EpiPermissoes.aplicarMenu).
// ═══════════════════════════════════════════════════════════════════
describe('Início do Portal: entrada Funcionários', () => {
  const inicio = ler('portal/inicio.html');
  const ENTRADA = '<a href="../pages/funcionarios.html" data-pagina="funcionarios" style="display:none">Cadastro de Colaboradores</a>';
  const HISTORICO_PORTAL = '<a href="../pages/employee-history.html" data-pagina="employeeHistory" style="display:none">Histórico de funcionários</a>';

  test('uma única entrada "Funcionários", oculta até a permissão, logo antes de "Histórico de funcionários"; nada de Cadastrar ou Editar', () => {
    assert.equal(inicio.split(ENTRADA).length - 1, 1);
    assert.equal(inicio.split('data-pagina="funcionarios"').length - 1, 1);
    assert.ok(inicio.includes(`${ENTRADA}\n          ${HISTORICO_PORTAL}`), 'antes do Histórico, no mesmo padrão da lista');
    assert.doesNotMatch(inicio, />\s*(Cadastrar|Editar|Novo) Funcionário\s*</i);
    assert.ok(inicio.includes('<a href="../pages/import-employees.html" data-pagina="importEmployees" style="display:none">Importar funcionários</a>'));
    assert.ok(inicio.includes('<a href="../pages/employee-groups.html" data-pagina="employeeGroups" style="display:none">Gestão de GHE</a>'));
  });

  test('o Portal usa a mesma regra central do menu: employeeHistory.visualizar mostra a entrada; criar ou editar sozinhos não', () => {
    assert.match(ler('portal/inicio.js'), /EpiPermissoes\.aplicarMenu\(/);
    const perm = (v, c, e) => ({ recursos: { employeeHistory: { visualizar: v, criar: c, editar: e, excluir: false } }, acoes: {}, administracao: {} });
    for (const [permissoes, visivel] of [[perm(true, false, false), true], [perm(true, true, true), true], [perm(false, true, true), false], [perm(false, false, false), false], [null, false]]) {
      const a = { getAttribute: (n) => (n === 'data-pagina' ? inicio.match(/<a href="\.\.\/pages\/funcionarios\.html" data-pagina="([^"]+)"/)?.[1] ?? null : null), style: { display: 'none' } };
      P.aplicarMenu(permissoes, [a]);
      assert.equal(a.style.display === '', visivel, JSON.stringify(permissoes));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// funcionarios.html participa da moldura padrão (sidebar, topbar do celular, tema), sem tocar no conteúdo aprovado.
// ═══════════════════════════════════════════════════════════════════
const LINK_ATIVO = '<a class="active" href="javascript:void(0)" data-pagina="funcionarios" style="display:none"><div class="nav-icon teal">people</div>Cadastro de Colaboradores</a>';
// SHA-256 do miolo aprovado de #conteudoProtegido (cabeçalho, busca, tabela, modal de cadastro/edição e confirmação), byte a byte.
// Atualizado na nomenclatura visual "Cadastro de Colaboradores" (h1, subtítulo, botão e título do modal): só texto, mesma estrutura.
const MIOLO_SHA = '741a8482865cfb1299bbe1c89b6e5bf078f5b19e73224f92042cb82356732118';
const sha = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');

describe('funcionarios.html — moldura padrão de navegação', () => {
  const html = ler('pages/funcionarios.html');

  test('carrega a folha comum e tem os componentes da moldura: layout, sidebar, conteúdo, topbar e botão do menu no celular, sem manipulador inline', () => {
    assert.match(html, /<link rel="stylesheet" href="\.\.\/css\/main\.css">/);
    for (const trecho of ['<div class="layout">', '<aside class="sidebar">', '<nav class="nav">', '<main class="content">', '<div class="mobile-overlay"', '<div class="mobile-topbar">', 'class="mobile-global-menu"']) {
      assert.ok(html.includes(trecho), trecho);
    }
    assert.equal(/onclick=|oninput=/.test(html), false, 'o menu do celular é ligado por addEventListener');
    assert.match(html, /<script src="\.\.\/js\/tema\.js"><\/script>/);
  });

  test('o menu é o mesmo das demais páginas integradas (referência: Pedido de EPI); só "Funcionários" é a página atual', () => {
    const ref = nav(ler('pages/request.html'))
      .replace('<a class="active" href="javascript:void(0)" data-pagina="request"', '<a href="request.html" data-pagina="request"')
      .replace(LINK, LINK_ATIVO);
    assert.ok(ref.includes(LINK_ATIVO), 'referência montada');
    assert.equal(nav(html), ref);
    assert.equal((nav(html).match(/class="active"/g) || []).length, 1);
    assert.equal(nav(html).includes(HISTORICO), true, 'Histórico de Funcionários segue como link normal');
    assert.doesNotMatch(nav(html), />\s*(Cadastrar|Editar|Novo) Funcionário\s*</i);
  });

  test('o miolo aprovado de #conteudoProtegido não mudou nem um byte; os ids e o estado da página continuam dentro de main.content', () => {
    const miolo = html.match(/<div id="conteudoProtegido" style="display:none">\n([\s\S]*?)\n  <\/div>\n(?=  <div id="toasts">)/);
    assert.ok(miolo, 'estrutura: conteúdo protegido seguido de #toasts');
    // Único acréscimo autorizado depois da aprovação: o filtro de Situação, ao lado da busca. Sem ele, o miolo é o aprovado, byte a byte.
    const FILTRO = '        <select id="fSituacaoFiltro" aria-label="Filtrar por situação">\n          <option value="">Todos</option>\n          <option value="ATIVO">Ativo</option>\n          <option value="AFASTADO">Afastado</option>\n          <option value="INATIVO">Inativo</option>\n        </select>\n';
    // E o olho do CPF na edição (revelação segura): o campo ganha um invólucro e um botão, sem mudar o <input> aprovado.
    const OLHO_ABRE = '              <div class="cpf-campo">\n                ';
    const OLHO_FECHA = '\n                <button id="btnCpfOlho" class="cpf-olho" type="button" aria-label="Mostrar CPF" aria-pressed="false" style="display:none"><span class="material-symbols-outlined">visibility</span></button>\n              </div>';
    assert.equal(miolo[1].split(FILTRO).length - 1, 1, 'o filtro de Situação aparece uma vez');
    assert.equal(miolo[1].split(OLHO_ABRE).length - 1, 1, 'o invólucro do CPF aparece uma vez');
    assert.equal(miolo[1].split(OLHO_FECHA).length - 1, 1, 'o olho aparece uma vez');
    const semAcrescimos = miolo[1].replace(FILTRO, '').replace(OLHO_ABRE, '              ').replace(OLHO_FECHA, '');
    assert.equal(sha(semAcrescimos), MIOLO_SHA);
    const principal = html.slice(html.indexOf('<main class="content">'), html.indexOf('</main>'));
    for (const id of ['estadoPagina', 'conteudoProtegido', 'toasts']) assert.ok(principal.includes(`id="${id}"`), `#${id} dentro de main.content`);
    assert.ok(html.indexOf('id="telaSessao"') < html.indexOf('<div class="layout">'), 'a tela de verificação da sessão continua fora da moldura');
  });

  test('o visual interno não vaza para a moldura: tokens e regras da página ficam sob .fn; nada em :root, body, * ou seletores soltos', () => {
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/:root\s*\{/.test(css), false, 'sem tokens em :root');
    assert.equal(/(^|\})\s*(body|html|\*)\s*[,{]/.test(css), false, 'sem regra solta em body, html ou *');
    assert.match(css, /\.fn\s*\{[^}]*--primary:/, 'tokens da página sob .fn');
    assert.match(css, /html\[data-theme="dark"\]\s+\.fn\s*\{[^}]*--surface:/, 'tema escuro sob .fn');
    const soltos = [];
    for (const m of css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)) {
      for (const seletor of m[2].split(',').map((s) => s.trim())) {
        if (!/^(\.fn\b|html\[data-theme="dark"\]\s+\.fn\b|\.nav a\.nav-pendente)/.test(seletor)) soltos.push(seletor);
      }
    }
    assert.deepEqual(soltos.filter((s) => !/^(from|to)$/.test(s)), [], 'todo seletor fica sob .fn');
    assert.ok(html.includes('<div class="fn">'), 'contêiner .fn');
  });
});

describe('Início do Portal: a entrada Funcionários na página real (DOM simulado, sessão e permissões reais)', () => {
  const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
  const area = (v) => ({ consultar: v, alterar: v });
  const permissoes = ({ v = false, c = false, e = false } = {}) => ({
    status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
    recursos: { employeeHistory: { ...NENHUMA, visualizar: v, criar: c, editar: e } }, acoes: {},
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
    },
  });
  const sessao = {
    status: 'ok',
    identidade: { id: 1, email: 'pessoa@validacao-epi.invalid', trocaSenhaObrigatoria: false },
    empresas: [{ id: 3 }],
    contexto: { usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@validacao-epi.invalid', perfil: 'USUARIO' }, empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' } },
  };
  async function inicio(ops) {
    const pg = abrirPagina('portal/inicio.html', { rotas: { 'GET /auth/global/me': { status: 200, corpo: sessao }, 'GET /auth/permissoes': { status: 200, corpo: permissoes(ops) } } });
    for (let i = 0; i < 4; i += 1) await pg.esperar();
    return pg;
  }
  const entrada = (pg) => pg.consulta('a[data-pagina="funcionarios"]')[0];

  test('com employeeHistory.visualizar a entrada aparece e leva à página; sozinhos, criar e editar não a mostram', async () => {
    const com = await inicio({ v: true });
    assert.ok(entrada(com), 'link existe');
    assert.equal(com.visivelNo(entrada(com)), true);
    assert.equal(entrada(com).getAttribute('href'), '../pages/funcionarios.html');
    assert.equal(entrada(com).textContent.trim(), 'Cadastro de Colaboradores');
    for (const ops of [{}, { c: true }, { e: true }, { c: true, e: true }]) {
      const sem = await inicio(ops);
      assert.ok(entrada(sem), 'link existe');
      assert.equal(sem.visivelNo(entrada(sem)), false, JSON.stringify(ops));
    }
  });
});
