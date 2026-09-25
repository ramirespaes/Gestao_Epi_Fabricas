'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
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
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

const EpiHttp = require('../../../frontend/js/api-http');
const EpiPortal = require('../../../frontend/js/portal-cliente');
const EpiSessaoEmpresarial = require('../../../frontend/js/sessao-empresarial');
const EpiPermissoes = require('../../../frontend/js/permissoes-efetivas');
const EpiMateriais = require('../../../frontend/js/materiais');

/**
 * Bloco 9, Etapa C, Parte C2 — cadastro real de materiais e EPIs, ponta a
 * ponta: Portal do Cliente (login global + empresa) -> sessão empresarial
 * (C0) -> permissões efetivas (C1) -> módulo real da página
 * (frontend/js/materiais.js) contra o servidor HTTP de verdade, com a
 * cadeia /api de produção e PostgreSQL real em schema temporário exclusivo
 * com TODAS as migrations (000-039). O `fetch` injetado é o navegador
 * (Origin + jar de cookies HttpOnly).
 *
 * Os testes negativos confirmam que a API RECUSA (403/401/404/409/400),
 * não apenas que a interface esconde botões.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 40 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-da-etapa-c2-2026';
const EMAILS = {
  master: 'master.c2@exemplo-cliente.com.br',       // MASTER em A
  cadastra: 'cadastra.c2@exemplo-cliente.com.br',   // SUPERVISOR em A: materials.visualizar+criar, SEM MOVIMENTAR_ESTOQUE
  leitor: 'leitor.c2@exemplo-cliente.com.br',       // SUPERVISOR em A: só materials.visualizar
  nada: 'nada.c2@exemplo-cliente.com.br',           // USUARIO em A: nenhuma permissão
  multi: 'multi.c2@exemplo-cliente.com.br',         // USUARIO em A, MASTER em B
};

function criarNavegador(origem) {
  const jar = new Map();
  const chamadas = [];
  const fn = async (url, opcoes = {}) => {
    chamadas.push(`${opcoes.method} ${new URL(url).pathname}${new URL(url).search}`);
    const cabecalhos = { ...(opcoes.headers || {}), Origin: origem };
    if (opcoes.credentials === 'include' && jar.size > 0) {
      cabecalhos.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
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
    urlsSubstituidas: [],
    location: { pathname: '/pages/materials.html', search: '', hash: '', replace: (d) => j.redirecionamentos.push(d) },
    history: { replaceState: (_e, _t, u) => j.urlsSubstituidas.push(u) },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { set cookie(_v) {} },
  };
  return j;
}

const FORMULARIO_COMPLETO = {
  nome: 'Botina de segurança C2', categoria: 'EPI', tipo: 'Sapatão / Botina', tipoCustom: '', caNumero: '38271', caValidade: '2027-01-31',
  fabricante: 'Bracol', codigoInterno: 'EPI-000245', quantidadeComprada: '120', tamanhoEntrada: '42', unidade: 'Par', estoqueMinimo: '5',
  definePrazo: 'sim', prazoUnidade: 'meses', prazo: '6', descricao: 'Biqueira de composite, solado antiderrapante',
};

describe('C2 — cadastro real de materiais pela página integrada (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let servidor;
  let base;
  let origem;
  const empresa = {};
  const usuario = {};

  function navegadorNovo() {
    const nav = criarNavegador(origem);
    EpiHttp.configurar({ baseUrl: `${base}/api`, fetch: nav });
    return nav;
  }

  /** Faz o que a página faz ao abrir: sessão (C0) + permissões (C1). */
  async function abrirPagina(email, empresaId) {
    const nav = navegadorNovo();
    const login = await EpiPortal.acoes.entrar({ email, senha: SENHA });
    assert.equal(login.ok, true, JSON.stringify(login));
    if (empresaId && !(login.dados.contexto && login.dados.contexto.empresa.id === empresaId)) {
      const sel = await EpiPortal.acoes.selecionar(empresaId);
      assert.equal(sel.ok, true, JSON.stringify(sel));
    }
    const j = janela();
    const sessao = await EpiSessaoEmpresarial.iniciar({ janela: j });
    assert.equal(sessao.autenticado, true, JSON.stringify(sessao));
    const permissoes = await EpiPermissoes.carregar(EpiPermissoes.esperadoDoContexto(sessao.contexto));
    assert.equal(permissoes.ok, true, JSON.stringify(permissoes));
    const p = permissoes.permissoes;
    return {
      nav, janela: j, contexto: sessao.contexto, permissoes: p,
      podeAbrir: EpiPermissoes.podeAbrir(p, 'materials'),
      podeAlterar: EpiPermissoes.podeAlterar(p, 'materials'),
      podeMovimentar: EpiPermissoes.acao(p, 'MOVIMENTAR_ESTOQUE'),
    };
  }

  const cadastrar = (formulario, podeMovimentar) => {
    const m = EpiMateriais.formulario.montarCorpo(formulario);
    assert.equal(m.ok, true, JSON.stringify(m));
    return EpiMateriais.fluxo.cadastrar({ corpo: m.corpo, entrada: m.entrada, podeMovimentar });
  };

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);

    for (const [chave, nome, cnpj] of [['A', 'Empresa Demonstração SafeWork', '11222333000181'], ['B', 'Empresa Beta C2', '22333444000100']]) {
      empresa[chave] = (await pool.query('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[chave], dryRun: false });
    }
    const identidade = async (email) => (await pool.query('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
    const vinculo = async (chave, empresaId, identidadeId, perfil, nome) => {
      usuario[chave] = (await pool.query('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id', [empresaId, nome, perfil, identidadeId])).rows[0].id;
    };
    await vinculo('master', empresa.A, await identidade(EMAILS.master), 'MASTER', 'Master C2');
    await vinculo('cadastra', empresa.A, await identidade(EMAILS.cadastra), 'SUPERVISOR', 'Cadastra C2');
    await vinculo('leitor', empresa.A, await identidade(EMAILS.leitor), 'SUPERVISOR', 'Leitor C2');
    await vinculo('nada', empresa.A, await identidade(EMAILS.nada), 'USUARIO', 'Nada C2');
    const multi = await identidade(EMAILS.multi);
    await vinculo('multiA', empresa.A, multi, 'USUARIO', 'Multi A');
    await vinculo('multiB', empresa.B, multi, 'MASTER', 'Multi B');

    // SUPERVISOR vê materiais pelo perfil; "cadastra" ganha criar por exceção individual (sem MOVIMENTAR_ESTOQUE).
    await pool.query("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar) VALUES ($1, 'SUPERVISOR', 'materials', true, false)", [empresa.A]);
    await pool.query("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_criar, concedido_por) VALUES ($1, $2, 'materials', true, $3)", [empresa.A, usuario.cadastra, usuario.master]);

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
      criarEstoqueRoutes({ controller: criarEstoqueController({ pool }), exigirSessao, pool }),
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

  describe('positivos', () => {
    let idBotina;

    test('MASTER: abre, pode cadastrar e movimentar; cadastro completo persiste todos os campos (039, validade do CA, prazo convertido) e a entrada inicial cria o saldo; auditoria dos dois eventos', async () => {
      const pagina = await abrirPagina(EMAILS.master, empresa.A);
      assert.deepEqual([pagina.podeAbrir, pagina.podeAlterar, pagina.podeMovimentar], [true, true, true]);
      assert.equal(pagina.nav.jar.has(authConfig.sessao.cookieNome), true, 'sessão empresarial = cookie HttpOnly');

      const r = await cadastrar(FORMULARIO_COMPLETO, pagina.podeMovimentar);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual([r.entrada.solicitada, r.entrada.realizada, r.entrada.motivo], [true, true, null]);
      idBotina = r.material.id;
      assert.equal(EpiMateriais.mensagens.resultado(r), 'Material cadastrado com sucesso. Entrada de estoque registrada: 120 no tamanho 42.');

      const { rows } = await pool.query('SELECT * FROM materiais WHERE id = $1', [idBotina]);
      const m = rows[0];
      assert.equal(m.empresa_id, empresa.A, 'empresa da sessão, nunca do cliente');
      assert.deepEqual(
        [m.nome, m.categoria, m.tipo, m.ca_numero, m.fabricante, m.codigo_interno, m.unidade, m.estoque_minimo, m.prazo_uso_dias, m.descricao, m.ativo],
        ['Botina de segurança C2', 'EPI', 'Sapatão / Botina', '38271', 'Bracol', 'EPI-000245', 'par', 5, 180, 'Biqueira de composite, solado antiderrapante', true],
      );
      assert.equal(m.ca_validade instanceof Date ? m.ca_validade.toISOString().slice(0, 10) : String(m.ca_validade), '2027-01-31', 'validade do CA gravada');
      const saldo = await pool.query('SELECT tamanho, quantidade FROM estoque_tamanhos WHERE material_id = $1', [idBotina]);
      assert.deepEqual(saldo.rows, [{ tamanho: '42', quantidade: 120 }]);
      const auditoria = await pool.query("SELECT acao, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND usuario_id = $2 AND acao IN ('MATERIAL_CRIADO', 'ESTOQUE_MOVIMENTADO') ORDER BY id", [empresa.A, usuario.master]);
      assert.deepEqual(auditoria.rows.map((l) => l.acao), ['MATERIAL_CRIADO', 'ESTOQUE_MOVIMENTADO']);
      assert.deepEqual([auditoria.rows[0].dados_novos.categoria, auditoria.rows[0].dados_novos.codigoInterno, auditoria.rows[0].dados_novos.prazoUsoDias], ['EPI', 'EPI-000245', 180]);
      assert.deepEqual(pagina.nav.chamadas.filter((c) => c.startsWith('POST /api/materiais')), ['POST /api/materiais', `POST /api/materiais/${idBotina}/estoque/movimentar`]);
    });

    test('grade: o material recém-criado mostra o saldo real por tamanho, com o mínimo do material; tamanhos sem saldo aparecem como sem estoque', async () => {
      await abrirPagina(EMAILS.master, empresa.A);
      const g = await EpiMateriais.fluxo.carregarGrade(idBotina);
      assert.equal(g.ok, true, JSON.stringify(g));
      assert.deepEqual(g.chips.find((c) => c.tamanho === '42'), { tamanho: '42', quantidade: 120, situacao: 'com-saldo' });
      assert.deepEqual(g.chips.find((c) => c.tamanho === '41'), { tamanho: '41', quantidade: 0, situacao: 'sem-estoque' });
      assert.equal(g.resumo, '1 disponível · 0 atenção · 10 em falta');
      // saída direta deixa o tamanho abaixo do mínimo → atenção
      const saida = await EpiMateriais.acoes.movimentar(idBotina, { tamanho: '42', tipo: 'SAIDA', quantidade: 117, motivo: 'ajuste do teste' });
      assert.equal(saida.ok, true, JSON.stringify(saida));
      const g2 = await EpiMateriais.fluxo.carregarGrade(idBotina);
      assert.deepEqual(g2.chips.find((c) => c.tamanho === '42'), { tamanho: '42', quantidade: 3, situacao: 'abaixo-minimo' });
    });

    test('seletor da grade lista só materiais ativos da empresa da sessão; perfil com visualizar (sem criar) abre a página e consulta a grade', async () => {
      const pagina = await abrirPagina(EMAILS.leitor, empresa.A);
      assert.deepEqual([pagina.podeAbrir, pagina.podeAlterar, pagina.podeMovimentar], [true, false, false]);
      const lista = await EpiMateriais.acoes.listar({ ativo: true, limite: 100 });
      assert.equal(lista.ok, true, JSON.stringify(lista));
      assert.ok(lista.dados.materiais.some((m) => m.id === idBotina));
      assert.ok(lista.dados.materiais.every((m) => m.empresaId === empresa.A));
      assert.equal((await EpiMateriais.fluxo.carregarGrade(idBotina)).ok, true);
    });

    test('mesmo código interno em OUTRA empresa: aceito (unicidade é por empresa)', async () => {
      await abrirPagina(EMAILS.multi, empresa.B);
      const r = await cadastrar({ ...FORMULARIO_COMPLETO, nome: 'Botina da Beta', quantidadeComprada: '', tamanhoEntrada: '' }, true);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.material.codigoInterno, 'EPI-000245');
      assert.equal(r.material.empresaId, empresa.B);
    });

    test('sem prazo, sem CA, sem quantidade: cadastro mínimo grava NULL nos opcionais e não cria saldo', async () => {
      await abrirPagina(EMAILS.master, empresa.A);
      const r = await cadastrar({
        nome: 'Protetor auricular', categoria: '', tipo: 'Protetor auricular', tipoCustom: '', caNumero: '', caValidade: '', fabricante: '', codigoInterno: '',
        quantidadeComprada: '', tamanhoEntrada: '', unidade: 'Unidade', estoqueMinimo: '', definePrazo: 'nao', prazoUnidade: 'meses', prazo: '', descricao: '',
      }, true);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.entrada.solicitada, false);
      const { rows } = await pool.query('SELECT categoria, codigo_interno, descricao, ca_numero, ca_validade, prazo_uso_dias, estoque_minimo, unidade FROM materiais WHERE id = $1', [r.material.id]);
      assert.deepEqual(rows[0], { categoria: null, codigo_interno: null, descricao: null, ca_numero: null, ca_validade: null, prazo_uso_dias: null, estoque_minimo: 0, unidade: 'unidade' });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM estoque_tamanhos WHERE material_id = $1', [r.material.id])).rows[0].n, 0);
    });
  });

  describe('negativos e segurança: a API recusa, não apenas a tela esconde', () => {
    test('perfil com criar mas SEM MOVIMENTAR_ESTOQUE: material salvo, entrada não tentada pela página; a chamada direta de movimentação é recusada com 403 e não altera saldo', async () => {
      const pagina = await abrirPagina(EMAILS.cadastra, empresa.A);
      assert.deepEqual([pagina.podeAbrir, pagina.podeAlterar, pagina.podeMovimentar], [true, true, false]);
      const r = await cadastrar({ ...FORMULARIO_COMPLETO, nome: 'Luva nitrílica', codigoInterno: 'EPI-000300', tipo: 'Luva', tamanhoEntrada: 'M', quantidadeComprada: '40' }, pagina.podeMovimentar);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual([r.entrada.solicitada, r.entrada.realizada, r.entrada.motivo], [true, false, 'SEM_PERMISSAO']);
      assert.match(EpiMateriais.mensagens.resultado(r), /^Material cadastrado com sucesso\. Entrada de estoque não realizada: /);
      assert.equal(pagina.nav.chamadas.some((c) => /estoque\/movimentar/.test(c)), false, 'nenhuma movimentação foi tentada');

      const direta = await EpiMateriais.acoes.movimentar(r.material.id, { tamanho: 'M', tipo: 'ENTRADA', quantidade: 40, motivo: 'tentativa direta' });
      assert.deepEqual([direta.ok, direta.status], [false, 403]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM estoque_tamanhos WHERE material_id = $1', [r.material.id])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT ativo FROM materiais WHERE id = $1', [r.material.id])).rows[0].ativo, true, 'o material continua cadastrado');
    });

    test('perfil só com visualizar: a página não libera salvar E o POST direto recebe 403; nada é criado', async () => {
      const pagina = await abrirPagina(EMAILS.leitor, empresa.A);
      assert.equal(pagina.podeAlterar, false);
      const antes = (await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresa.A])).rows[0].n;
      const r = await EpiMateriais.fluxo.cadastrar({ corpo: { nome: 'Tentativa do leitor' }, entrada: null, podeMovimentar: false });
      assert.deepEqual([r.ok, r.etapa, r.resposta.status], [false, 'cadastro', 403]);
      assert.match(EpiMateriais.mensagens.erroCadastro(r.resposta), /não pode cadastrar materiais nesta empresa/i);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresa.A])).rows[0].n, antes);
    });

    test('perfil sem materials.visualizar: a página não abre, e listar, consultar estoque e cadastrar recebem 403', async () => {
      const pagina = await abrirPagina(EMAILS.nada, empresa.A);
      assert.deepEqual([pagina.podeAbrir, pagina.podeAlterar, pagina.podeMovimentar], [false, false, false]);
      assert.equal((await EpiMateriais.acoes.listar({ ativo: true })).status, 403);
      assert.equal((await EpiMateriais.fluxo.carregarGrade(1)).resposta.status, 403);
      assert.equal((await EpiMateriais.acoes.criar({ nome: 'x' })).status, 403);
    });

    test('isolamento: a empresa B não vê nem consulta o estoque do material da empresa A; a lista de B não contém materiais de A', async () => {
      await abrirPagina(EMAILS.multi, empresa.B);
      const idA = (await pool.query('SELECT id FROM materiais WHERE empresa_id = $1 ORDER BY id LIMIT 1', [empresa.A])).rows[0].id;
      const g = await EpiMateriais.fluxo.carregarGrade(idA);
      assert.deepEqual([g.ok, g.resposta.status, g.resposta.codigo], [false, 404, 'MATERIAL_NAO_ENCONTRADO']);
      const lista = await EpiMateriais.acoes.listar({ ativo: true, limite: 100 });
      assert.ok(lista.dados.materiais.every((m) => m.empresaId === empresa.B));
      const mov = await EpiMateriais.acoes.movimentar(idA, { tamanho: '42', tipo: 'ENTRADA', quantidade: 1 });
      assert.equal(mov.status, 404, 'movimentar material de outra empresa: inexistente para B');
    });

    test('código interno duplicado na mesma empresa (caixa diferente): 409, mensagem clara, nada criado, nenhuma entrada tentada', async () => {
      const pagina = await abrirPagina(EMAILS.master, empresa.A);
      const antes = (await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresa.A])).rows[0].n;
      const r = await cadastrar({ ...FORMULARIO_COMPLETO, nome: 'Outra botina', codigoInterno: 'epi-000245' }, true);
      assert.deepEqual([r.ok, r.etapa, r.resposta.status, r.resposta.codigo], [false, 'cadastro', 409, 'MATERIAL_CODIGO_INTERNO_DUPLICADO']);
      assert.match(EpiMateriais.mensagens.erroCadastro(r.resposta), /código interno/i);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresa.A])).rows[0].n, antes);
      assert.equal(pagina.nav.chamadas.some((c) => /estoque\/movimentar/.test(c)), false);
    });

    test('cadastro ok e entrada recusada pelo servidor (quantidade acima do limite inteiro): material permanece, sem exclusão nem nova tentativa; mensagem explícita', async () => {
      const pagina = await abrirPagina(EMAILS.master, empresa.A);
      const m = EpiMateriais.formulario.montarCorpo({ ...FORMULARIO_COMPLETO, nome: 'Capacete classe B', codigoInterno: 'EPI-000400', tipo: 'Capacete', quantidadeComprada: '1', tamanhoEntrada: 'Único' });
      const r = await EpiMateriais.fluxo.cadastrar({ corpo: m.corpo, entrada: { tamanho: 'Único', quantidade: 2147483648 }, podeMovimentar: true });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual([r.entrada.solicitada, r.entrada.realizada, r.entrada.motivo, r.entrada.resposta.status, r.entrada.resposta.codigo], [true, false, 'RECUSADA', 400, 'VALIDACAO']);
      assert.match(EpiMateriais.mensagens.resultado(r), /^Material cadastrado com sucesso\. Entrada de estoque não realizada: /);
      const chamadasMov = pagina.nav.chamadas.filter((c) => /estoque\/movimentar/.test(c));
      assert.equal(chamadasMov.length, 1, 'uma única tentativa');
      assert.equal(pagina.nav.chamadas.some((c) => /DELETE|inativar/.test(c)), false);
      assert.equal((await pool.query('SELECT ativo FROM materiais WHERE id = $1', [r.material.id])).rows[0].ativo, true);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM estoque_tamanhos WHERE material_id = $1', [r.material.id])).rows[0].n, 0);
    });

    test('dados malformados: a página não envia (erros por campo); enviados diretamente, o servidor recusa com 400 VALIDACAO (quantidadeComprada, empresaId, limites)', async () => {
      await abrirPagina(EMAILS.master, empresa.A);
      const local = EpiMateriais.formulario.montarCorpo({ ...FORMULARIO_COMPLETO, nome: '', prazo: 'x', quantidadeComprada: '2', tamanhoEntrada: '' });
      assert.deepEqual([local.ok, local.erros.map((e) => e.campo).sort()], [false, ['nome', 'prazo', 'tamanhoEntrada']]);
      for (const corpo of [{ nome: 'X', quantidadeComprada: 10 }, { nome: 'X', categoria: 'a'.repeat(31) }, { nome: 'X', descricao: 'a'.repeat(501) }, { nome: 'X', codigoInterno: '' }, { nome: 'X', caValidade: '31/01/2027' }, { nome: 'X', prazoUsoDias: 0 }]) {
        const r = await EpiMateriais.acoes.criar(corpo);
        assert.deepEqual([r.status, r.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
      }
      await assert.rejects(() => EpiMateriais.acoes.criar({ nome: 'X', empresaId: empresa.B }), /empresaId/, 'o cliente HTTP recusa campo de autoridade antes de sair do navegador');
    });

    test('sessão expirada: a página volta ao Portal e a API responde 401 ao cadastro', async () => {
      const pagina = await abrirPagina(EMAILS.master, empresa.A);
      await pool.query("UPDATE sessoes SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 minute' WHERE usuario_id = $1 AND revogada_em IS NULL", [usuario.master]);
      const r = await EpiMateriais.fluxo.cadastrar({ corpo: { nome: 'Depois de expirar' }, entrada: null, podeMovimentar: true });
      assert.deepEqual([r.ok, r.resposta.status, EpiMateriais.mensagens.exigeNovoLogin(r.resposta)], [false, 401, true]);
      const j = janela();
      assert.equal((await EpiSessaoEmpresarial.iniciar({ janela: j })).motivo, 'SEM_SESSAO');
      assert.deepEqual(j.redirecionamentos, ['../portal/index.html']);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM materiais WHERE nome = 'Depois de expirar'")).rows[0].n, 0);
      void pagina;
    });

    test('troca de empresa em outra aba: as permissões carregadas para a empresa anterior são rejeitadas (CONTEXTO_DIVERGENTE); a nova empresa vale', async () => {
      const pagina = await abrirPagina(EMAILS.multi, empresa.A);
      assert.deepEqual([pagina.contexto.empresa.id, pagina.podeAbrir], [empresa.A, false], 'USUARIO em A: nada');
      const sel = await EpiPortal.acoes.selecionar(empresa.B); // outra aba trocou para B
      assert.equal(sel.ok, true);
      const antiga = await EpiPermissoes.carregar(EpiPermissoes.esperadoDoContexto(pagina.contexto));
      assert.deepEqual([antiga.ok, antiga.motivo], [false, 'CONTEXTO_DIVERGENTE']);
      const nova = await EpiSessaoEmpresarial.iniciar({ janela: janela() });
      const p = await EpiPermissoes.carregar(EpiPermissoes.esperadoDoContexto(nova.contexto));
      assert.deepEqual([nova.contexto.empresa.id, EpiPermissoes.podeAbrir(p.permissoes, 'materials')], [empresa.B, true], 'MASTER em B');
    });

    test('perfil alterado durante a sessão: a permissão de criar some na consulta seguinte e o servidor recusa na hora', async () => {
      const pagina = await abrirPagina(EMAILS.cadastra, empresa.A);
      assert.equal(pagina.podeAlterar, true);
      await pool.query('DELETE FROM usuario_permissoes_recurso WHERE empresa_id = $1 AND usuario_id = $2', [empresa.A, usuario.cadastra]);
      const r = await EpiMateriais.acoes.criar({ nome: 'Depois de revogar' });
      assert.equal(r.status, 403);
      const p = await EpiPermissoes.carregar(EpiPermissoes.esperadoDoContexto(pagina.contexto));
      assert.equal(EpiPermissoes.podeAlterar(p.permissoes, 'materials'), false);
      await pool.query("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_criar, concedido_por) VALUES ($1, $2, 'materials', true, $3)", [empresa.A, usuario.cadastra, usuario.master]);
    });

    test('falha de rede no cadastro: resultado de falha com status 0, nada gravado, nenhuma entrada tentada', async () => {
      await abrirPagina(EMAILS.master, empresa.A);
      const antes = (await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresa.A])).rows[0].n;
      EpiHttp.configurar({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
      const r = await EpiMateriais.fluxo.cadastrar({ corpo: { nome: 'Sem rede' }, entrada: { tamanho: 'M', quantidade: 1 }, podeMovimentar: true });
      assert.deepEqual([r.ok, r.etapa, r.resposta.status], [false, 'cadastro', 0]);
      assert.match(EpiMateriais.mensagens.erroCadastro(r.resposta), /rede/i);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresa.A])).rows[0].n, antes);
    });

    test('nenhuma requisição da página carrega empresaId, usuarioId ou perfil; nenhuma usa ?_s=', async () => {
      const pagina = await abrirPagina(EMAILS.master, empresa.A);
      await cadastrar({ ...FORMULARIO_COMPLETO, nome: 'Respirador PFF2', codigoInterno: 'EPI-000500', tipo: 'Respirador', tamanhoEntrada: 'Único', quantidadeComprada: '10' }, true);
      await EpiMateriais.acoes.listar({ ativo: true, limite: 100 });
      assert.equal(pagina.nav.chamadas.some((c) => /empresaId|usuarioId|perfil=|_s=/.test(c)), false, pagina.nav.chamadas.join('\n'));
    });
  });
});

// ───────────────────────────────────────────────────────────────────
// Correções da auditoria C2 (24/09/2026)
// ───────────────────────────────────────────────────────────────────
describe('C2 — correções da auditoria (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let servidor;
  let base;
  let origem;
  const empresa = {};
  const usuario = {};

  async function abrirComoMaster() {
    const nav = criarNavegador(origem);
    EpiHttp.configurar({ baseUrl: `${base}/api`, fetch: nav });
    const login = await EpiPortal.acoes.entrar({ email: EMAILS.master, senha: SENHA });
    assert.equal(login.ok, true, JSON.stringify(login));
    const sessao = await EpiSessaoEmpresarial.iniciar({ janela: janela() });
    assert.equal(sessao.autenticado, true);
    return nav;
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);
    empresa.A = (await pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Empresa Demonstração SafeWork', '11222333000181') RETURNING id")).rows[0].id;
    await provisionamento.provisionar(pool, { empresaId: empresa.A, dryRun: false });
    const id = (await pool.query('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [EMAILS.master, hash])).rows[0].id;
    usuario.master = (await pool.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Master C2', NULL, NULL, 'MASTER', $2) RETURNING id", [empresa.A, id])).rows[0].id;
    // 120 materiais ativos: mais que uma página de 100
    for (let i = 1; i <= 120; i += 1) {
      await pool.query("INSERT INTO materiais (empresa_id, nome, codigo_interno) VALUES ($1, $2, $3)", [empresa.A, `Material ${String(i).padStart(3, '0')}`, `PG-${String(i).padStart(3, '0')}`]);
    }
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
      criarEstoqueRoutes({ controller: criarEstoqueController({ pool }), exigirSessao, pool }),
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

  test('correção 2 — listarTodos consulta além dos primeiros 100: duas páginas, 120 materiais, e o recém-cadastrado (121º) aparece na consulta seguinte', async () => {
    const nav = await abrirComoMaster();
    const r = await EpiMateriais.acoes.listarTodos({ ativo: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.dados.materiais.length, r.dados.total, r.dados.completo], [120, 120, true]);
    assert.deepEqual(nav.chamadas.filter((c) => c.startsWith('GET /api/materiais?')), ['GET /api/materiais?ativo=true&pagina=1&limite=100', 'GET /api/materiais?ativo=true&pagina=2&limite=100']);
    const primeiraPagina = await EpiMateriais.acoes.listar({ ativo: true, limite: 100 });
    assert.equal(primeiraPagina.dados.materiais.length, 100, 'uma página só não basta');

    const novo = await EpiMateriais.fluxo.cadastrar({ corpo: { nome: 'Material 121 novo', codigoInterno: 'PG-121' }, entrada: null, podeMovimentar: true });
    assert.equal(novo.ok, true, JSON.stringify(novo));
    const depois = await EpiMateriais.acoes.listarTodos({ ativo: true });
    assert.equal(depois.dados.materiais.length, 121);
    assert.ok(depois.dados.materiais.some((m) => m.id === novo.material.id), 'o recém-cadastrado está na lista completa');
  });

  test('correção 3 — quantidade acima do INTEGER é recusada pelo cliente antes de qualquer requisição; enviada diretamente, o servidor recusa com 400 e o material não recebe saldo', async () => {
    const nav = await abrirComoMaster();
    const antes = nav.chamadas.length;
    const m = EpiMateriais.formulario.montarCorpo({ ...FORMULARIO_COMPLETO, nome: 'Acima do limite', codigoInterno: 'LIM-1', quantidadeComprada: '2147483648' });
    assert.deepEqual([m.ok, m.erros.map((e) => e.campo)], [false, ['quantidadeComprada']]);
    assert.equal(nav.chamadas.length, antes, 'nenhuma requisição, nenhum cadastro parcial');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM materiais WHERE nome = 'Acima do limite'")).rows[0].n, 0);
  });

  test('correção 4 — entrada com resultado não confirmado (rede cai após o cadastro): motivo NAO_CONFIRMADO, uma única tentativa, material preservado, mensagem com a identificação e a orientação do saldo real', async () => {
    const nav = await abrirComoMaster();
    let tentativas = 0;
    EpiHttp.configurar({
      fetch: async (url, opcoes) => {
        if (/estoque\/movimentar$/.test(new URL(url).pathname)) { tentativas += 1; throw new TypeError('Failed to fetch'); }
        return nav(url, opcoes);
      },
    });
    const m = EpiMateriais.formulario.montarCorpo({ ...FORMULARIO_COMPLETO, nome: 'Rede caiu', codigoInterno: 'REDE-1', quantidadeComprada: '7', tamanhoEntrada: '40' });
    const r = await EpiMateriais.fluxo.cadastrar({ corpo: m.corpo, entrada: m.entrada, podeMovimentar: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.entrada.solicitada, r.entrada.realizada, r.entrada.motivo, r.entrada.resposta.status, tentativas], [true, false, 'NAO_CONFIRMADO', 0, 1]);
    const texto = EpiMateriais.mensagens.resultado(r);
    assert.match(texto, new RegExp(`nº ${r.material.id}`));
    assert.match(texto, /REDE-1/);
    assert.match(texto, /Entrada de estoque não confirmada/);
    assert.match(texto, /saldo real/i);
    assert.equal((await pool.query('SELECT ativo FROM materiais WHERE id = $1', [r.material.id])).rows[0].ativo, true, 'material preservado');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM estoque_tamanhos WHERE material_id = $1', [r.material.id])).rows[0].n, 0, 'nada foi gravado sem confirmação (a rede caiu antes do servidor)');
    // a orientação é verificável: a grade real do material mostra o saldo
    EpiHttp.configurar({ fetch: nav });
    const g = await EpiMateriais.fluxo.carregarGrade(r.material.id);
    assert.equal(g.ok, true);
    assert.equal(g.chips.every((c) => c.quantidade === 0), true);
  });

  test('correção 4 — cadastro com resposta de erro do servidor não é tratado como recusa: confirmado=false; recusa 409 é confirmado=true', async () => {
    const nav = await abrirComoMaster();
    EpiHttp.configurar({
      fetch: async (url, opcoes) => {
        if (opcoes.method === 'POST' && new URL(url).pathname === '/api/materiais') {
          return new Response(JSON.stringify({ status: 'erro', codigo: 'INDISPONIVEL', mensagem: 'x' }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
        return nav(url, opcoes);
      },
    });
    const incerto = await EpiMateriais.fluxo.cadastrar({ corpo: { nome: 'Servidor 503' }, entrada: null, podeMovimentar: true });
    assert.deepEqual([incerto.ok, incerto.confirmado, incerto.resposta.status], [false, false, 503]);
    assert.match(EpiMateriais.mensagens.erroCadastro(incerto.resposta), /não foi possível confirmar/i);
    EpiHttp.configurar({ fetch: nav });
    const recusa = await EpiMateriais.fluxo.cadastrar({ corpo: { nome: 'Duplicado', codigoInterno: 'pg-001' }, entrada: null, podeMovimentar: true });
    assert.deepEqual([recusa.ok, recusa.confirmado, recusa.resposta.status], [false, true, 409]);
  });
});
