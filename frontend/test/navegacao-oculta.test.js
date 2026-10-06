'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina, ler } = require('./helpers/dom-pagina');

/**
 * Ocultação temporária da navegação (05/10/2026): os módulos fora do foco
 * atual somem do menu lateral e do Início do Portal — sem item cinza, sem
 * placeholder, sem etiqueta —, em todas as páginas que usam a navegação do
 * SafeWork, com ou sem permissão. Só a navegação muda: páginas, módulos,
 * rotas, permissões, testes e o acesso direto legado continuam.
 *
 * Pendência obrigatória registrada: quando a Gestão de Usuários estiver
 * completa, testada e validada, as seis telas de acessos que ela substitui
 * serão desativadas de vez, antes do Git consolidado. Validade, Compras /
 * Entradas e Regras Função / Setor ficam só adiadas.
 */

const RAIZ = path.join(__dirname, '..');
const P = require('../js/permissoes-efetivas');

const OCULTOS = ['stockValidity', 'grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais', 'newUser', 'userAdmin'];
const OCULTOS_PENDENTES = ['Compras / Entradas', 'Regras Função / Setor'];
const VISIVEIS = { gestaoUsuarios: 'Gestão de Usuários', employeeGroups: 'Gestão de GHE', request: 'Pedido de EPI' };
const PRESERVADOS = [
  'pages/stock-validity.html', 'pages/purchases.html', 'pages/eligibility-rules.html', 'pages/grupos-acesso.html', 'pages/grupo-permissoes.html',
  'pages/grupo-usuarios.html', 'pages/autorizacoes-individuais.html', 'pages/new-user.html', 'pages/user-admin.html',
  'js/validade-estoque.js', 'js/grupos-acesso.js', 'js/grupo-permissoes.js', 'js/grupo-usuarios.js', 'js/autorizacoes-individuais.js', 'js/usuarios.js',
  'test/validade-estoque.test.js', 'test/grupos-acesso.test.js', 'test/grupo-permissoes.test.js', 'test/grupo-usuarios.test.js', 'test/autorizacoes-individuais.test.js', 'test/usuarios-paginas.test.js',
];
// Páginas com o menu completo que o harness abre sem canvas nem dependências extras.
const PAGINAS = ['dashboard.html', 'materials.html', 'employee-groups.html', 'request.html', 'gestao-usuarios.html', 'config.html'];

const TUDO = { visualizar: true, criar: true, editar: true, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
function permissoesPlenas() {
  const recursos = {};
  for (const r of ['dashboard', 'materials', 'stockValidity', 'operations', 'availableItems', 'employeeGroups', 'employeeHistory', 'epiFicha', 'request', 'importEmployees']) recursos[r] = { ...TUDO };
  return {
    status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'MASTER', recursos,
    acoes: { ENTRADA_ESTOQUE: true, BAIXA_ESTOQUE: true, IMPORTAR_FUNCIONARIOS: true, REALIZAR_ENTREGA: true, APROVAR_SOLICITACAO: true, REPROVAR_SOLICITACAO: true, ENCERRAR_SOLICITACAO: true },
    administracao: {
      gruposAcesso: area(true), permissoesGrupo: area(true), vinculosGrupo: area(true), usuarios: area(true),
      autorizacoesIndividuais: { consultar: true, concederDireta: true, delegar: false }, vinculosSst: area(true),
    },
  };
}
const contexto = () => ({
  status: 'ok',
  usuario: { id: 7, nome: 'Pessoa Master', email: 'master@validacao-epi.invalid', perfil: 'MASTER' },
  empresa: { id: 3, nome: 'Empresa Foco', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const lista = () => ({ status: 200, corpo: { status: 'ok', solicitacoes: [], total: 0, pagina: 1, limite: 20, paginas: 1 } });
function abrir(arquivo) {
  return abrirPagina(`pages/${arquivo}`, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoesPlenas() },
      'GET /solicitacoes-epi/minhas': lista,
      'GET /administracao/usuarios': { status: 200, corpo: { status: 'ok', usuarios: [], total: 0, pagina: 1, limite: 100, paginas: 1, mastersAtivos: 1, perfisGerenciaveis: [] } },
    },
  });
}
const pendenteDe = (pg, rotulo) => pg.consulta('.nav a.nav-pendente').find((a) => a.textContent.includes(rotulo));

function conferirMenu(pg, arquivo) {
  for (const id of OCULTOS) {
    const a = pg.consulta(`.nav a[data-pagina="${id}"]`)[0];
    assert.ok(a, `${arquivo}: o item ${id} continua no HTML (nada foi apagado)`);
    assert.equal(pg.visivelNo(a), false, `${arquivo}: ${id} some do menu mesmo com permissão`);
    assert.equal(pg.visivelNo(a.querySelector('.nav-icon')), false, `${arquivo}: o ícone de ${id} some junto`);
  }
  for (const rotulo of OCULTOS_PENDENTES) {
    const a = pendenteDe(pg, rotulo);
    assert.ok(a, `${arquivo}: "${rotulo}" continua no HTML`);
    assert.equal(pg.visivelNo(a), false, `${arquivo}: "${rotulo}" some do menu`);
    assert.equal(a.getAttribute('href'), null, `${arquivo}: "${rotulo}" sem link`);
  }
  for (const [id, rotulo] of Object.entries(VISIVEIS)) {
    const a = pg.consulta(`.nav a[data-pagina="${id}"]`)[0];
    assert.ok(a, `${arquivo}: ${rotulo} presente`);
    assert.equal(pg.visivelNo(a), true, `${arquivo}: ${rotulo} continua visível`);
    assert.match(a.textContent, new RegExp(rotulo), arquivo);
  }
}

describe('navegação oculta — regra central (permissoes-efetivas.js)', () => {
  test('a lista é exatamente a dos módulos fora do foco; aplicarMenu nunca os mostra, mesmo com toda permissão; os demais seguem a permissão', () => {
    assert.deepEqual(P.NAVEGACAO_OCULTA, OCULTOS);
    assert.deepEqual(P.NAVEGACAO_OCULTA_PENDENTES, OCULTOS_PENDENTES);
    const p = permissoesPlenas();
    const links = [...OCULTOS, 'gestaoUsuarios', 'employeeGroups', 'request', 'materials', 'dashboard', 'operations'].map((pagina) => ({ style: { display: 'none' }, getAttribute: (n) => (n === 'data-pagina' ? pagina : null) }));
    P.aplicarMenu(p, links);
    assert.deepEqual(links.map((l) => l.style.display), [...OCULTOS.map(() => 'none'), '', '', '', '', '', '']);
    for (const id of OCULTOS) assert.equal(P.podeAbrir(p, id), true, `${id}: a permissão e o acesso direto continuam; só a navegação esconde`);
    P.aplicarMenu(null, links);
    assert.ok(links.every((l) => l.style.display === 'none'));
  });

  test('liberarInspecao esconde "Compras / Entradas" e "Regras Função / Setor" (sem link, sem etiqueta visível) e não toca os outros pendentes', () => {
    const pendente = (rotulo) => {
      const atributos = { class: 'nav-pendente', 'aria-disabled': 'true', title: 'Em integração' };
      return { atributos, style: {}, childNodes: [{ nodeType: 1, textContent: 'x' }, { nodeType: 3, textContent: rotulo }], getAttribute: (n) => (Object.hasOwn(atributos, n) ? atributos[n] : null), setAttribute: (n, v) => { atributos[n] = String(v); }, removeAttribute: (n) => { delete atributos[n]; } };
    };
    const itens = [pendente('Compras / Entradas'), pendente('Regras Função / Setor'), pendente('Relatórios'), pendente('Suporte')];
    for (const perfil of ['MASTER', 'USUARIO']) {
      P.liberarInspecao({ perfil }, { querySelectorAll: (sel) => (sel === 'a.nav-pendente' ? itens : []) });
      assert.deepEqual(itens.slice(0, 2).map((i) => [i.style.display, i.atributos.href]), [['none', undefined], ['none', undefined]], perfil);
      assert.deepEqual(itens.slice(2).map((i) => i.style.display), [undefined, undefined], `${perfil}: os demais pendentes não são escondidos por esta regra`);
    }
  });
});

describe('navegação oculta — páginas reais no harness, com permissões plenas', () => {
  for (const arquivo of PAGINAS) {
    test(`${arquivo}: os nove itens somem (ícones inclusive) e Gestão de Usuários, Gestão de GHE e Pedido de EPI continuam; nada reaparece na volta pelo histórico`, async () => {
      const pg = abrir(arquivo);
      await pg.esperar();
      await pg.esperar();
      assert.equal(pg.chamadas.some((c) => c.chave === 'GET /auth/permissoes'), true, 'o menu vem das permissões reais');
      conferirMenu(pg, arquivo);
      await pg.eventoDaJanela('pageshow', { persisted: true });
      await pg.esperar();
      conferirMenu(pg, `${arquivo} (volta pelo histórico)`);
    });
  }
});

describe('navegação oculta — preservação', () => {
  test('páginas, módulos e testes dos módulos ocultos continuam no repositório, e os itens continuam na marcação das páginas', () => {
    for (const rel of PRESERVADOS) assert.ok(fs.existsSync(path.join(RAIZ, rel)), rel);
    const paginas = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html') && /data-pagina="userAdmin"/.test(ler(`pages/${f}`)));
    assert.ok(paginas.length >= 12, `${paginas.length} páginas com o menu`);
    for (const f of paginas) {
      const html = ler(`pages/${f}`);
      // As quatro páginas de acessos têm menu próprio, sem a seção Estoque (e, portanto, sem Validade).
      const menuCompleto = html.includes('data-pagina="importEmployees"');
      for (const id of OCULTOS.filter((x) => menuCompleto || x !== 'stockValidity')) assert.ok(html.includes(`data-pagina="${id}"`), `${f}: ${id} permanece na marcação`);
      const nav = (html.match(/<nav class="nav">([\s\S]*?)<\/nav>/) || [])[1] || '';
      assert.ok(nav, `${f}: menu lateral presente`);
      assert.equal(/em breve|Módulo desativado|Adiado/i.test(nav), false, `${f}: nenhum placeholder ou etiqueta de módulo desativado no menu`);
    }
    assert.match(ler('portal/inicio.js'), /EpiPermissoes\.aplicarMenu\(/, 'o Início do Portal usa a mesma regra central');
  });
});
