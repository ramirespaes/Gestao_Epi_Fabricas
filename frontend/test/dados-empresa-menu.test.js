'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');
const P = require('../js/permissoes-efetivas');

/**
 * Dados da Empresa (F2) — permissão e menu pelo mecanismo CENTRAL (permissoes-efetivas.js): o recurso companyData, nenhum
 * mecanismo paralelo, e nenhuma das páginas homologadas editada para ganhar o item. O item "Dados da Empresa" aparece na
 * seção Administração, logo depois de "Configurações", só para quem pode abrir a página.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const PAGINAS = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html')).sort();
const PROPRIA = 'company-data.html';
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ v = false, e = false, perfil = 'ADMINISTRADOR' } = {}) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil,
  recursos: { companyData: { ...NENHUMA, visualizar: v, editar: e } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false },
  },
});

describe('PAGINAS.companyData (mecanismo central)', () => {
  test('abre com companyData.visualizar; alterar exige editar; nada de ação nem de nome de perfil', () => {
    assert.deepEqual(P.PAGINAS.companyData, {
      abrir: [{ recurso: 'companyData', operacao: 'visualizar' }],
      alterar: [{ recurso: 'companyData', operacao: 'editar' }],
    });
  });

  test('podeAbrir/podeAlterar: Visualizar OFF + Editar ON não abre nem altera; os dois ON alteram; o perfil não decide', () => {
    assert.equal(P.podeAbrir(permissoes({ v: false, e: true }), 'companyData'), false);
    assert.equal(P.podeAlterar(permissoes({ v: false, e: true }), 'companyData'), false);
    assert.equal(P.podeAbrir(permissoes({ v: true, e: false }), 'companyData'), true);
    assert.equal(P.podeAlterar(permissoes({ v: true, e: false }), 'companyData'), false);
    assert.equal(P.podeAlterar(permissoes({ v: true, e: true }), 'companyData'), true);
    for (const perfil of ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
      assert.equal(P.podeAbrir(permissoes({ v: false, e: false, perfil }), 'companyData'), false, perfil);
    }
    assert.equal(P.podeAbrir(null, 'companyData'), false);
  });
});

describe('ajustarMenuDadosEmpresa — o item é criado centralmente', () => {
  function raizDeTeste() {
    const pg = abrirPagina('pages/config.html', { rotas: {}, html: undefined });
    return pg;
  }

  test('a função existe e é exportada', () => {
    assert.equal(typeof P.ajustarMenuDadosEmpresa, 'function');
  });

  test('NENHUMA página homologada foi editada: só company-data.html e o Início do Portal mencionam a nova página', () => {
    // lgpd.html foi integrada depois (LGPD de Consulta, V2) e nasceu com o menu completo, inclusive o item estático de Dados da Empresa.
    for (const f of PAGINAS) {
      if (f === PROPRIA || f === 'lgpd.html') continue;
      assert.equal(ler(`pages/${f}`).includes('company-data.html'), false, `${f} não deve ser editada`);
    }
    assert.match(ler('portal/inicio.html'), /<a href="\.\.\/pages\/company-data\.html" data-pagina="companyData" style="display:none">Dados da Empresa<\/a>/);
  });

  async function abrir(arquivo, perm) {
    const rotas = {
      'GET /auth/me': { status: 200, corpo: { status: 'ok', usuario: { id: 7, nome: 'Eva', email: 'eva@example.invalid', perfil: perm.perfil }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' } } },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: perm },
      'GET /empresa/dados': { status: 200, corpo: { status: 'ok', dados: { razaoSocial: 'X', cnpj: '11222333000181', versao: 1, representante: {}, financeiro: {}, camposBloqueados: [] } } },
    };
    const pg = abrirPagina(`pages/${arquivo}`, { rotas });
    await pg.esperar();
    await pg.esperar();
    return pg;
  }
  const itens = (pg) => pg.consulta('.nav a').filter((a) => /Dados da Empresa/.test(a.textContent));
  const rotulos = (pg) => pg.consulta('.nav a').map((a) => a.textContent.replace(/\s+/g, ' ').trim());

  test('com permissão de abrir: o item aparece UMA vez, logo depois de "Configurações", visível e apontando para company-data.html', async () => {
    for (const arquivo of ['config.html', 'dashboard.html', 'funcionarios.html', 'gestao-usuarios.html', 'materials.html']) {
      const pg = await abrir(arquivo, permissoes({ v: true }));
      const achados = itens(pg);
      assert.equal(achados.length, 1, arquivo);
      const a = achados[0];
      assert.equal(a.getAttribute('href'), 'company-data.html', arquivo);
      assert.equal(a.getAttribute('data-pagina'), 'companyData', arquivo);
      assert.equal(pg.visivelNo(a), true, arquivo);
      const r = rotulos(pg);
      const posicao = r.findIndex((t) => t.endsWith('Configurações'));
      assert.ok(posicao >= 0, `${arquivo}: o item Configurações existe`);
      assert.ok(r[posicao + 1].endsWith('Dados da Empresa'), `${arquivo}: logo depois de Configurações (veio "${r[posicao + 1]}")`);
    }
  });

  test('sem permissão (Visualizar OFF, mesmo com Editar ON): nenhum item aparece', async () => {
    for (const perm of [permissoes({ v: false, e: false }), permissoes({ v: false, e: true })]) {
      const pg = await abrir('config.html', perm);
      assert.equal(itens(pg).filter((a) => pg.visivelNo(a)).length, 0);
    }
  });

  test('na própria página o item estático existe uma vez só, ativo, e não é duplicado pela injeção', async () => {
    const pg = await abrir(PROPRIA, permissoes({ v: true, e: true }));
    const achados = itens(pg);
    assert.equal(achados.length, 1);
    assert.equal(achados[0].classList.contains('active'), true);
    assert.equal(pg.visivelNo(achados[0]), true);
  });

  test('o perfil (MASTER ou ADMINISTRADOR) não decide: com a mesma permissão efetiva o resultado é igual', async () => {
    for (const perfil of ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR']) {
      const pg = await abrir('config.html', permissoes({ v: true, perfil }));
      assert.equal(itens(pg).filter((a) => pg.visivelNo(a)).length, 1, perfil);
    }
    const semNada = await abrir('config.html', permissoes({ v: false, perfil: 'MASTER' }));
    assert.equal(itens(semNada).filter((a) => semNada.visivelNo(a)).length, 0, 'MASTER sem a permissão efetiva não vê o item');
  });
});
