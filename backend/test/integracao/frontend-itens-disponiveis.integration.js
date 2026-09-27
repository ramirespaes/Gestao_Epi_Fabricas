'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { inserirLote, baixarLote, somarDias } = require('./helpers/estoque-lotes');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarItensDisponiveisController } = require('../../src/controllers/itens-disponiveis.controller');
const { criarItensDisponiveisRoutes } = require('../../src/routes/itens-disponiveis.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { corsApi } = require('../../src/middleware/cors');
const { semCache } = require('../../src/middleware/cabecalhos');
const { verificarOrigem } = require('../../src/middleware/origem');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { gerarHashSenha } = require('../../src/security/password');
const { httpConfig } = require('../../src/config/http');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

const EpiHttp = require('../../../frontend/js/api-http');
const EpiPortal = require('../../../frontend/js/portal-cliente');
const EpiSessaoEmpresarial = require('../../../frontend/js/sessao-empresarial');
const EpiPermissoes = require('../../../frontend/js/permissoes-efetivas');
require('../../../frontend/js/materiais');
const EpiItens = require('../../../frontend/js/itens-disponiveis');

/**
 * Bloco 9, Etapa C, Parte C3 — Itens Disponíveis ponta a ponta: Portal do
 * Cliente (login global) → sessão empresarial (C0) → permissões efetivas
 * (C1, recurso availableItems) → módulo real da página
 * (frontend/js/itens-disponiveis.js) contra o servidor HTTP real, cadeia
 * /api de produção, PostgreSQL real em schema temporário (todas as migrations).
 * O saldo vem dos lotes, com a data operacional fixada em 30/09/2026.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 45 }, (_, i) => String(i).padStart(3, '0'));
const HOJE = '2026-09-30';
const RELOGIO = () => new Date('2026-09-30T15:00:00Z');
const SENHA = 'senha-forte-da-parte-c3-2026';
const EMAILS = {
  master: 'master.itens.c3@exemplo-cliente.com.br',       // MASTER em A (provisionado: availableItems visualizar)
  supervisor: 'supervisor.itens.c3@exemplo-cliente.com.br', // materials.visualizar, SEM availableItems
  usuario: 'usuario.itens.c3@exemplo-cliente.com.br',       // availableItems por exceção, SEM materials
  masterB: 'master.b.itens.c3@exemplo-cliente.com.br',
};

function criarNavegador(origem) {
  const jar = new Map();
  const chamadas = [];
  const fn = async (url, opcoes = {}) => {
    chamadas.push(`${opcoes.method} ${new URL(url).pathname}${new URL(url).search}`);
    const cabecalhos = { ...(opcoes.headers || {}), Origin: origem };
    if (opcoes.credentials === 'include' && jar.size > 0) cabecalhos.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const resposta = await fetch(url, { ...opcoes, headers: cabecalhos });
    for (const bruto of resposta.headers.getSetCookie()) {
      const [par, ...atributos] = bruto.split(';');
      const i = par.indexOf('=');
      const nome = par.slice(0, i).trim();
      if (atributos.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(nome); else jar.set(nome, par.slice(i + 1).trim());
    }
    return resposta;
  };
  fn.jar = jar;
  fn.chamadas = chamadas;
  return fn;
}

function janela() {
  const j = {
    redirecionamentos: [],
    location: { pathname: '/pages/available-items.html', search: '', hash: '', replace: (d) => j.redirecionamentos.push(d) },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { set cookie(_v) {} },
  };
  return j;
}

describe('C3 — Itens Disponíveis pela página integrada (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let servidor;
  let base;
  let origem;
  const empresa = {};
  const usuario = {};

  async function abrirPagina(email) {
    const nav = criarNavegador(origem);
    EpiHttp.configurar({ baseUrl: `${base}/api`, fetch: nav });
    const login = await EpiPortal.acoes.entrar({ email, senha: SENHA });
    assert.equal(login.ok, true, JSON.stringify(login));
    const sessao = await EpiSessaoEmpresarial.iniciar({ janela: janela() });
    assert.equal(sessao.autenticado, true, JSON.stringify(sessao));
    const p = await EpiPermissoes.carregar(EpiPermissoes.esperadoDoContexto(sessao.contexto));
    assert.equal(p.ok, true, JSON.stringify(p));
    return { nav, contexto: sessao.contexto, permissoes: p.permissoes, podeAbrir: EpiPermissoes.podeAbrir(p.permissoes, 'availableItems') };
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);
    const q = (sql, params) => pool.query(sql, params);
    for (const [k, nome, cnpj] of [['A', 'Empresa Demonstração SafeWork', '11222333000181'], ['B', 'Empresa Beta C3', '22333444000100']]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[k], dryRun: false });
    }
    const vinculo = async (chave, empresaId, email, perfil) => {
      const id = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      usuario[chave] = (await q('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id', [empresaId, chave, perfil, id])).rows[0].id;
    };
    await vinculo('master', empresa.A, EMAILS.master, 'MASTER');
    await vinculo('supervisor', empresa.A, EMAILS.supervisor, 'SUPERVISOR');
    await vinculo('usuario', empresa.A, EMAILS.usuario, 'USUARIO');
    await vinculo('masterB', empresa.B, EMAILS.masterB, 'MASTER');
    await q("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar) VALUES ($1, 'SUPERVISOR', 'materials', true)", [empresa.A]);
    await q("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, 'availableItems', true, $3)", [empresa.A, usuario.usuario, usuario.master]);

    // Empresa A: 60 materiais ativos × 2 tamanhos = 120 linhas (exportação com mais de uma página de 100),
    // mais um material com CA vencido e um inativo. Empresa B: um material. O tamanho G de cada luva
    // é um lote que foi baixado por inteiro.
    const valido = somarDias(HOJE, 200);
    for (let n = 1; n <= 60; n += 1) {
      const id = (await q("INSERT INTO materiais (empresa_id, nome, tipo, categoria, unidade, estoque_minimo) VALUES ($1, $2, 'Luva', 'EPI', 'par', 5) RETURNING id", [empresa.A, `Luva ${String(n).padStart(3, '0')}`])).rows[0].id;
      await inserirLote(pool, { empresaId: empresa.A, materialId: id, tamanho: 'M', quantidade: n, ca: '12345', validade: valido });
      const g = await inserirLote(pool, { empresaId: empresa.A, materialId: id, tamanho: 'G', quantidade: 1, ca: '12345', validade: valido });
      await baixarLote(pool, { empresaId: empresa.A, loteId: g, quantidade: 1, usuarioId: usuario.master });
    }
    const vencido = (await q("INSERT INTO materiais (empresa_id, nome, tipo, categoria, codigo_interno, unidade, estoque_minimo) VALUES ($1, 'Capacete vencido', 'Capacete', 'EPI', 'CAP-1', 'unidade', 1) RETURNING id", [empresa.A])).rows[0].id;
    await inserirLote(pool, { empresaId: empresa.A, materialId: vencido, tamanho: 'Único', quantidade: 7, ca: '67890', validade: somarDias(HOJE, -1) });
    const inativo = (await q("INSERT INTO materiais (empresa_id, nome, tipo, categoria, unidade, ativo) VALUES ($1, 'Inativo', 'Luva', 'EPI', 'par', false) RETURNING id", [empresa.A])).rows[0].id;
    await inserirLote(pool, { empresaId: empresa.A, materialId: inativo, tamanho: 'P', quantidade: 99, ca: '12345', validade: valido });
    const b = (await q("INSERT INTO materiais (empresa_id, nome, tipo, categoria, unidade) VALUES ($1, 'Material B', 'Luva', 'EPI', 'par') RETURNING id", [empresa.B])).rows[0].id;
    await inserirLote(pool, { empresaId: empresa.B, materialId: b, tamanho: 'M', quantidade: 55, ca: '12345', validade: valido });

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    const app = express();
    app.disable('x-powered-by');
    app.use(
      '/api',
      corsApi, semCache, verificarOrigem, exigirJson, parserJson,
      criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao }),
      criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }) }),
      criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool }),
      criarItensDisponiveisRoutes({ controller: criarItensDisponiveisController({ pool, relogio: RELOGIO }), exigirSessao, pool }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
    servidor = http.createServer(app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
    [origem] = httpConfig.cors.origens;
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (contexto) await contexto.encerrar();
  });

  test('MASTER: a página abre (availableItems provisionado); primeira página real com 50 linhas, total 121, opções reais; status pela regra da C2', async () => {
    const pagina = await abrirPagina(EMAILS.master);
    assert.equal(pagina.podeAbrir, true);
    const r = await EpiItens.acoes.listar({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.dados.itens.length, r.dados.total, r.dados.pagina, r.dados.limite], [50, 121, 1, 50]);
    assert.deepEqual(r.dados.filtros, { categorias: ['EPI'], tipos: ['Capacete', 'Luva'], tamanhos: ['G', 'M', 'Único'] });
    const html = EpiItens.render.linhas(r.dados.itens);
    assert.match(html, /Sem estoque/);
    assert.match(html, /Baixo/);
    assert.equal(/Inativo|Material B/.test(html), false);
    assert.equal(pagina.nav.chamadas.some((c) => /empresaId|usuarioId/.test(c)), false);
  });

  test('filtro de validade do CA e combinação de filtros reais; o saldo com CA vencido fica bloqueado', async () => {
    await abrirPagina(EMAILS.master);
    const vencidos = await EpiItens.acoes.listar({ validade: 'expired' });
    assert.deepEqual(vencidos.dados.itens.map((i) => [i.material, i.tamanho, i.saldo, i.bloqueado, i.disponivel, i.validade]), [['Capacete vencido', 'Único', 7, 7, 0, 'expired']]);
    const combinados = await EpiItens.acoes.listar({ tipo: 'Luva', tamanho: 'G' });
    assert.equal(combinados.dados.total, 60);
    assert.ok(combinados.dados.itens.every((i) => i.saldo === 0 && i.disponivel === 0));
  });

  test('exportação: busca as duas páginas (100 + 21) e gera o CSV com as sete colunas e 121 linhas', async () => {
    const pagina = await abrirPagina(EMAILS.master);
    const r = await EpiItens.acoes.listarTodos({});
    assert.deepEqual([r.ok, r.dados.itens.length, r.dados.completo], [true, 121, true]);
    assert.deepEqual(pagina.nav.chamadas.filter((c) => c.startsWith('GET /api/estoque')), ['GET /api/estoque/itens-disponiveis?pagina=1&limite=100', 'GET /api/estoque/itens-disponiveis?pagina=2&limite=100']);
    const linhas = EpiItens.csv.gerar(r.dados.itens).slice(1).split('\r\n');
    assert.equal(linhas.length, 122);
    assert.equal(linhas[0], '"Categoria";"Tipo";"Material";"Tamanho";"Quantidade disponível";"Unidade";"Status"');
    assert.ok(linhas.slice(1).every((l) => l.split('";"').length === 7));
    assert.ok(linhas.includes('"EPI";"Capacete";"Capacete vencido (CAP-1)";"Único";"0";"Unidade";"Sem estoque"'));
  });

  test('permissão independente: supervisor com materials SEM availableItems não abre e a API recusa (403, mensagem própria)', async () => {
    const pagina = await abrirPagina(EMAILS.supervisor);
    assert.equal(pagina.podeAbrir, false);
    assert.equal(EpiPermissoes.podeAbrir(pagina.permissoes, 'materials'), true);
    const r = await EpiItens.acoes.listar({});
    assert.deepEqual([r.ok, r.status], [false, 403]);
    assert.match(EpiItens.mensagens.erroConsulta(r), /não pode consultar os itens disponíveis/i);
  });

  test('usuário só com availableItems: abre e consulta; o cadastro de materiais continua negado', async () => {
    const pagina = await abrirPagina(EMAILS.usuario);
    assert.deepEqual([pagina.podeAbrir, EpiPermissoes.podeAbrir(pagina.permissoes, 'materials')], [true, false]);
    assert.equal((await EpiItens.acoes.listar({})).dados.total, 121);
    assert.equal((await EpiHttp.requisitar('GET', '/materiais')).status, 403);
  });

  test('isolamento: MASTER da empresa B vê só o material de B', async () => {
    await abrirPagina(EMAILS.masterB);
    const r = await EpiItens.acoes.listar({});
    assert.deepEqual(r.dados.itens.map((i) => [i.material, i.tamanho, i.saldo]), [['Material B', 'M', 55]]);
  });

  test('sessão expirada: 401 e a página pede novo login; falha de rede: status 0, sem dados', async () => {
    await abrirPagina(EMAILS.master);
    await pool.query("UPDATE sessoes SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 minute' WHERE usuario_id = $1 AND revogada_em IS NULL", [usuario.master]);
    const expirada = await EpiItens.acoes.listar({});
    assert.deepEqual([expirada.status, EpiItens.mensagens.exigeNovoLogin(expirada)], [401, true]);
    EpiHttp.configurar({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    const rede = await EpiItens.acoes.listar({});
    assert.deepEqual([rede.ok, rede.status], [false, 0]);
    assert.match(EpiItens.mensagens.erroConsulta(rede), /rede/i);
  });
});
