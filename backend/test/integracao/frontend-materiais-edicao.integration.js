'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
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
const EpiMateriais = require('../../../frontend/js/materiais');

/**
 * Melhoria da C2 (25/09/2026), ponta a ponta: edição de material existente
 * pelo módulo real da página (frontend/js/materiais.js) contra o GET e o
 * PATCH /api/materiais/:id que já existem, com a cadeia /api de produção e
 * PostgreSQL real em schema temporário exclusivo com TODAS as migrations.
 *
 * Prova, no banco: a edição não altera saldo nem cria movimentação; a
 * troca de categoria/tipo não mexe nas linhas de estoque_tamanhos (a C3
 * continua listando os mesmos tamanhos); a entrada inicial só acontece com
 * "Sim" explícito; e a API recusa editar sem materials.editar (403) e fora
 * da empresa (404).
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 40 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-da-melhoria-c2-2026';
const EMAILS = {
  master: 'master.edicao@exemplo-cliente.com.br',     // MASTER em A: visualizar, criar, editar, MOVIMENTAR_ESTOQUE
  cadastra: 'cadastra.edicao@exemplo-cliente.com.br', // SUPERVISOR em A: visualizar + criar, SEM editar
  editor: 'editor.edicao@exemplo-cliente.com.br',     // SUPERVISOR em A: visualizar + editar, SEM criar
  outra: 'outra.edicao@exemplo-cliente.com.br',       // MASTER em B
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
  fn.chamadas = chamadas;
  return fn;
}

const FORMULARIO = {
  nome: 'Botina edição C2', categoria: 'EPI', tipo: 'Sapatão / Botina', tipoCustom: '', caNumero: '38271', caValidade: '2026-10-15',
  fabricante: 'Bracol', codigoInterno: 'ED-001', quantidadeComprada: '30', tamanhoEntrada: '42', unidade: 'Par', estoqueMinimo: '5',
  definePrazo: 'sim', prazoUnidade: 'meses', prazo: '6', descricao: 'Material da melhoria C2', registrarEntrada: 'sim',
};

describe('Melhoria C2 — edição de material e entrada inicial (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let servidor;
  let base;
  let origem;
  const empresa = {};
  const usuario = {};
  let idBotina;

  async function entrar(email, empresaId) {
    const nav = criarNavegador(origem);
    EpiHttp.configurar({ baseUrl: `${base}/api`, fetch: nav });
    const login = await EpiPortal.acoes.entrar({ email, senha: SENHA });
    assert.equal(login.ok, true, JSON.stringify(login));
    if (!(login.dados.contexto && login.dados.contexto.empresa.id === empresaId)) {
      const sel = await EpiPortal.acoes.selecionar(empresaId);
      assert.equal(sel.ok, true, JSON.stringify(sel));
    }
    return nav;
  }

  const saldos = async (materialId) => (await pool.query('SELECT tamanho, quantidade FROM estoque_tamanhos WHERE material_id = $1 ORDER BY tamanho', [materialId])).rows;
  const contarAuditoria = async (acao) => (await pool.query('SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2', [empresa.A, acao])).rows[0].n;

  /** Faz o que a página faz: GET /materiais/:id, formulário, montarEdicao, PATCH. */
  async function editar(materialId, alteracoes) {
    const carga = await EpiMateriais.acoes.buscar(materialId);
    assert.equal(carga.ok, true, JSON.stringify(carga));
    const original = carga.dados.material;
    const campos = { ...EpiMateriais.formulario.camposDoMaterial(original).campos, ...alteracoes };
    const montado = EpiMateriais.formulario.montarEdicao(campos, original);
    assert.equal(montado.ok, true, JSON.stringify(montado));
    return { montado, resposta: montado.alterado ? await EpiMateriais.acoes.alterar(materialId, montado.corpo) : null };
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);

    for (const [chave, nome, cnpj] of [['A', 'Empresa Alfa Edição', '11222333000181'], ['B', 'Empresa Beta Edição', '22333444000100']]) {
      empresa[chave] = (await pool.query('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[chave], dryRun: false });
    }
    const vinculo = async (chave, empresaId, email, perfil) => {
      const identidade = (await pool.query('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      usuario[chave] = (await pool.query('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id', [empresaId, chave, perfil, identidade])).rows[0].id;
    };
    await vinculo('master', empresa.A, EMAILS.master, 'MASTER');
    await vinculo('cadastra', empresa.A, EMAILS.cadastra, 'SUPERVISOR');
    await vinculo('editor', empresa.A, EMAILS.editor, 'SUPERVISOR');
    await vinculo('outra', empresa.B, EMAILS.outra, 'MASTER');
    await pool.query("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar) VALUES ($1, 'SUPERVISOR', 'materials', true, false, false)", [empresa.A]);
    await pool.query("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_criar, concedido_por) VALUES ($1, $2, 'materials', true, $3)", [empresa.A, usuario.cadastra, usuario.master]);
    await pool.query("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_editar, concedido_por) VALUES ($1, $2, 'materials', true, $3)", [empresa.A, usuario.editor, usuario.master]);

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    const app = express();
    app.disable('x-powered-by');
    app.use(
      '/api',
      corsApi, semCache, verificarOrigem, exigirJson, parserJson,
      criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }) }),
      criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool }),
      criarEstoqueRoutes({ controller: criarEstoqueController({ pool }), exigirSessao, pool }),
      criarItensDisponiveisRoutes({ controller: criarItensDisponiveisController({ pool }), exigirSessao, pool }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
    servidor = http.createServer(app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
    [origem] = httpConfig.cors.origens;

    // Material de partida: cadastro pela página com "Sim", 30 no tamanho 42.
    await entrar(EMAILS.master, empresa.A);
    const m = EpiMateriais.formulario.montarCorpo(FORMULARIO);
    assert.equal(m.ok, true, JSON.stringify(m));
    const r = await EpiMateriais.fluxo.cadastrar({ corpo: m.corpo, entrada: m.entrada, podeMovimentar: true });
    assert.equal(r.ok && r.entrada.realizada, true, JSON.stringify(r));
    idBotina = r.material.id;
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (contexto) await contexto.encerrar();
  });

  test('editar nome, CA, validade do CA e fabricante: PATCH só com os quatro, persistido e auditado; saldo e movimentações inalterados', async () => {
    const nav = await entrar(EMAILS.master, empresa.A);
    const saldoAntes = await saldos(idBotina);
    assert.deepEqual(saldoAntes, [{ tamanho: '42', quantidade: 30 }]);
    const movimentosAntes = await contarAuditoria('ESTOQUE_MOVIMENTADO');
    const alteracoesAntes = await contarAuditoria('MATERIAL_ALTERADO');

    const { montado, resposta } = await editar(idBotina, { nome: 'Botina editada C2', caNumero: '40000', caValidade: '2027-03-01', fabricante: '3M' });
    assert.deepEqual(montado.corpo, { nome: 'Botina editada C2', caNumero: '40000', caValidade: '2027-03-01', fabricante: '3M' });
    assert.equal(resposta.ok, true, JSON.stringify(resposta));

    const { rows } = await pool.query("SELECT nome, ca_numero, to_char(ca_validade, 'YYYY-MM-DD') AS ca_validade, fabricante, unidade, estoque_minimo, prazo_uso_dias, codigo_interno FROM materiais WHERE id = $1", [idBotina]);
    assert.deepEqual(rows[0], { nome: 'Botina editada C2', ca_numero: '40000', ca_validade: '2027-03-01', fabricante: '3M', unidade: 'par', estoque_minimo: 5, prazo_uso_dias: 180, codigo_interno: 'ED-001' });
    assert.deepEqual(await saldos(idBotina), saldoAntes, 'saldo inalterado');
    assert.equal(await contarAuditoria('ESTOQUE_MOVIMENTADO'), movimentosAntes, 'nenhuma movimentação');
    assert.equal(await contarAuditoria('MATERIAL_ALTERADO'), alteracoesAntes + 1);
    assert.deepEqual(nav.chamadas.filter((c) => !c.startsWith('GET') && !c.startsWith('POST /api/auth')), [`PATCH /api/materiais/${idBotina}`]);
  });

  test('abrir e salvar sem mexer em nada: nenhum PATCH; prazo de 180 dias volta como 6 meses e não é reenviado', async () => {
    await entrar(EMAILS.master, empresa.A);
    const { montado, resposta } = await editar(idBotina, {});
    assert.deepEqual([montado.alterado, resposta], [false, null]);
    const carga = await EpiMateriais.acoes.buscar(idBotina);
    const campos = EpiMateriais.formulario.camposDoMaterial(carga.dados.material).campos;
    assert.deepEqual([campos.definePrazo, campos.prazo, campos.prazoUnidade], ['sim', '6', 'meses']);
  });

  test('validade do CA 15/10/2026: carregada para edição como 15/10/2026 no fuso do processo de teste', async () => {
    await entrar(EMAILS.master, empresa.A);
    await pool.query("UPDATE materiais SET ca_validade = '2026-10-15' WHERE id = $1", [idBotina]);
    const carga = await EpiMateriais.acoes.buscar(idBotina);
    assert.equal(EpiMateriais.formulario.camposDoMaterial(carga.dados.material).campos.caValidade, '2026-10-15');
  });

  // Ajuste pós-melhoria C2 (25/09/2026): o fuso do processo Node do
  // servidor é trocado em tempo de execução; servidor e banco são os mesmos.
  const FUSOS = ['America/Sao_Paulo', 'UTC', 'Asia/Tokyo', 'Europe/Berlin'];
  async function emFuso(fuso, fn) {
    const original = process.env.TZ;
    try {
      process.env.TZ = fuso;
      return await fn();
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
  }

  test('validade do CA 15/10/2026 é 15/10/2026 em São Paulo, UTC, Tóquio e Berlim: consulta, lista, estoque, formulário de edição e C3', async () => {
    await entrar(EMAILS.master, empresa.A);
    await pool.query("UPDATE materiais SET ca_validade = '2026-10-15' WHERE id = $1", [idBotina]);
    for (const fuso of FUSOS) {
      await emFuso(fuso, async () => {
        const um = await EpiMateriais.acoes.buscar(idBotina);
        const lista = await EpiMateriais.acoes.listar({ ativo: true, limite: 100 });
        const estoque = await EpiMateriais.acoes.estoque(idBotina);
        const c3 = await EpiHttp.requisitar('GET', '/estoque/itens-disponiveis?limite=100');
        assert.deepEqual([um.ok, lista.ok, estoque.ok, c3.ok], [true, true, true, true], fuso);
        assert.deepEqual([
          um.dados.material.caValidade,
          lista.dados.materiais.find((m) => m.id === idBotina).caValidade,
          estoque.dados.material.caValidade,
          c3.dados.itens.find((i) => i.materialId === idBotina).caValidade,
        ], ['2026-10-15', '2026-10-15', '2026-10-15', '2026-10-15'], fuso);
        assert.equal(EpiMateriais.formulario.camposDoMaterial(um.dados.material).campos.caValidade, '2026-10-15', fuso);
      });
    }
  });

  test('abrir e salvar a edição em Tóquio e Berlim: a data não é reenviada nem muda; PATCH e auditoria trazem 2026-10-15; trocar a data grava exatamente a nova', async () => {
    await entrar(EMAILS.master, empresa.A);
    await pool.query("UPDATE materiais SET ca_validade = '2026-10-15' WHERE id = $1", [idBotina]);
    const dataNoBanco = async () => (await pool.query("SELECT to_char(ca_validade, 'YYYY-MM-DD') AS d FROM materiais WHERE id = $1", [idBotina])).rows[0].d;
    const ultimaAuditoria = async () => (await pool.query("SELECT dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'MATERIAL_ALTERADO' ORDER BY id DESC LIMIT 1", [empresa.A])).rows[0];
    for (const fuso of ['Asia/Tokyo', 'Europe/Berlin']) {
      await emFuso(fuso, async () => {
        const { montado, resposta } = await editar(idBotina, { descricao: `Salvo em ${fuso}` });
        assert.deepEqual(montado.corpo, { descricao: `Salvo em ${fuso}` }, 'a data não é reenviada');
        assert.equal(resposta.ok, true, JSON.stringify(resposta));
        assert.equal(resposta.dados.material.caValidade, '2026-10-15', fuso);
        assert.equal(await dataNoBanco(), '2026-10-15', fuso);
        const auditoria = await ultimaAuditoria();
        assert.deepEqual([auditoria.dados_anteriores.caValidade, auditoria.dados_novos.caValidade], ['2026-10-15', '2026-10-15'], fuso);
      });
    }
    await emFuso('Asia/Tokyo', async () => {
      const { resposta } = await editar(idBotina, { caValidade: '2026-10-20' });
      assert.equal(resposta.dados.material.caValidade, '2026-10-20');
    });
    assert.equal(await dataNoBanco(), '2026-10-20');
    await pool.query("UPDATE materiais SET ca_validade = '2026-10-15' WHERE id = $1", [idBotina]);
  });

  test('unidade de controle: PATCH direto com unidade (diferente, igual ou junto de outro campo) → 400; unidade, dados, saldo e auditoria intactos', async () => {
    await entrar(EMAILS.master, empresa.A);
    const linhaAntes = (await pool.query('SELECT * FROM materiais WHERE id = $1', [idBotina])).rows[0];
    const saldoAntes = await saldos(idBotina);
    const auditoriaAntes = (await pool.query('SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1', [empresa.A])).rows[0].n;
    for (const corpo of [{ unidade: 'caixa' }, { unidade: 'par' }, { unidade: 'caixa', nome: 'Troca junto' }]) {
      const r = await EpiMateriais.acoes.alterar(idBotina, corpo);
      assert.deepEqual([r.ok, r.status, r.codigo], [false, 400, 'VALIDACAO'], JSON.stringify(corpo));
      assert.ok(r.detalhes.some((d) => d.campo === 'body.unidade' && d.codigo === 'CAMPO_NAO_PERMITIDO'), JSON.stringify(r.detalhes));
    }
    assert.deepEqual((await pool.query('SELECT * FROM materiais WHERE id = $1', [idBotina])).rows[0], linhaAntes, 'material intacto, unidade par');
    assert.equal(linhaAntes.unidade, 'par');
    assert.deepEqual(await saldos(idBotina), saldoAntes);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1', [empresa.A])).rows[0].n, auditoriaAntes, 'nada auditado');
  });

  test('trocar categoria e tipo não mexe nas linhas de estoque: grade mantém o 42 com saldo e mostra os sugeridos do novo tipo; a C3 lista os mesmos tamanhos com o novo tipo', async () => {
    await entrar(EMAILS.master, empresa.A);
    const antes = await saldos(idBotina);
    const { resposta } = await editar(idBotina, { categoria: 'Uniforme', tipo: 'Luva' });
    assert.equal(resposta.ok, true, JSON.stringify(resposta));
    assert.deepEqual(await saldos(idBotina), antes, 'estoque_tamanhos intacto');

    const g = await EpiMateriais.fluxo.carregarGrade(idBotina);
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.deepEqual(g.chips.map((c) => [c.tamanho, c.quantidade]), [['PP', 0], ['P', 0], ['M', 0], ['G', 0], ['GG', 0], ['42', 30]]);

    const c3 = await EpiHttp.requisitar('GET', '/estoque/itens-disponiveis?limite=100');
    assert.equal(c3.ok, true, JSON.stringify(c3));
    const linhas = c3.dados.itens.filter((i) => i.materialId === idBotina);
    assert.deepEqual(linhas.map((i) => [i.tamanho, i.saldo, i.tipo, i.categoria]), [['42', 30, 'Luva', 'Uniforme']]);
  });

  test('entrada inicial "Não": material criado sem linha de estoque e sem movimentação, mesmo com quantidade no formulário', async () => {
    const nav = await entrar(EMAILS.master, empresa.A);
    const m = EpiMateriais.formulario.montarCorpo({ ...FORMULARIO, nome: 'Sem estoque C2', codigoInterno: 'ED-002', registrarEntrada: 'nao' });
    assert.equal(m.entrada, null);
    const r = await EpiMateriais.fluxo.cadastrar({ corpo: m.corpo, entrada: m.entrada, podeMovimentar: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await saldos(r.material.id), []);
    assert.equal(nav.chamadas.some((c) => /estoque\/movimentar/.test(c)), false);
    assert.match(EpiMateriais.mensagens.resultado(r), /sem quantidade em estoque/i);
  });

  test('entrada inicial "Sim" sem tamanho: nada é enviado', async () => {
    const nav = await entrar(EMAILS.master, empresa.A);
    const antes = nav.chamadas.length;
    const m = EpiMateriais.formulario.montarCorpo({ ...FORMULARIO, nome: 'Sem tamanho', codigoInterno: 'ED-003', tamanhoEntrada: '' });
    assert.deepEqual([m.ok, m.erros.map((e) => e.campo)], [false, ['tamanhoEntrada']]);
    assert.equal(nav.chamadas.length, antes);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM materiais WHERE codigo_interno = 'ED-003'")).rows[0].n, 0);
  });

  test('permissão: criar sem editar recebe 403 no PATCH e nada muda; editar sem criar consegue editar', async () => {
    await entrar(EMAILS.cadastra, empresa.A);
    const antes = (await pool.query('SELECT nome, atualizado_em FROM materiais WHERE id = $1', [idBotina])).rows[0];
    const negado = await EpiMateriais.acoes.alterar(idBotina, { nome: 'Tentativa sem editar' });
    assert.deepEqual([negado.ok, negado.status], [false, 403]);
    assert.match(EpiMateriais.mensagens.erroEdicao(negado), /não pode editar/i);
    assert.deepEqual((await pool.query('SELECT nome, atualizado_em FROM materiais WHERE id = $1', [idBotina])).rows[0], antes);

    await entrar(EMAILS.editor, empresa.A);
    const { resposta } = await editar(idBotina, { fabricante: 'Danny' });
    assert.equal(resposta.ok, true, JSON.stringify(resposta));
    assert.equal((await pool.query('SELECT fabricante FROM materiais WHERE id = $1', [idBotina])).rows[0].fabricante, 'Danny');
  });

  test('isolamento: outra empresa recebe 404 ao carregar e ao editar; o material de A não muda', async () => {
    await entrar(EMAILS.outra, empresa.B);
    const antes = (await pool.query('SELECT nome, fabricante, atualizado_em FROM materiais WHERE id = $1', [idBotina])).rows[0];
    const carga = await EpiMateriais.acoes.buscar(idBotina);
    assert.deepEqual([carga.ok, carga.status], [false, 404]);
    const edicao = await EpiMateriais.acoes.alterar(idBotina, { nome: 'Invasão' });
    assert.deepEqual([edicao.ok, edicao.status], [false, 404]);
    assert.match(EpiMateriais.mensagens.erroEdicao(edicao), /não encontrado nesta empresa/i);
    assert.deepEqual((await pool.query('SELECT nome, fabricante, atualizado_em FROM materiais WHERE id = $1', [idBotina])).rows[0], antes);
  });

  // ── Entrada de estoque em material já cadastrado (25/09/2026) ──
  // Cenário do TESTE-C3-002: botina cadastrada sem quantidade, sem Número do CA.
  describe('entrada de estoque posterior pela rota existente', () => {
    let idSemEstoque;
    const linhaMaterial = async (id) => (await pool.query('SELECT id, codigo_interno, nome, unidade, atualizado_em FROM materiais WHERE id = $1', [id])).rows[0];

    before(async () => {
      await entrar(EMAILS.master, empresa.A);
      const m = EpiMateriais.formulario.montarCorpo({ ...FORMULARIO, nome: 'Botina teste validade C3', codigoInterno: 'ED-C3-002', caNumero: '', registrarEntrada: 'nao' });
      const r = await EpiMateriais.fluxo.cadastrar({ corpo: m.corpo, entrada: m.entrada, podeMovimentar: true });
      assert.equal(r.ok, true, JSON.stringify(r));
      idSemEstoque = r.material.id;
      assert.deepEqual(await saldos(idSemEstoque), []);
    });

    test('5 pares no tamanho 35: mesmo material e código, linha 35 criada com 5, ENTRADA auditada, nenhum PATCH, grade e C3 com o novo saldo', async () => {
      const nav = await entrar(EMAILS.master, empresa.A);
      const materialAntes = await linhaMaterial(idSemEstoque);
      const auditoriaAntes = await contarAuditoria('ESTOQUE_MOVIMENTADO');
      const montado = EpiMateriais.formulario.montarEntrada({ tamanho: '35', quantidade: '5', motivo: 'Entrada posterior C2' });
      assert.equal(montado.ok, true, JSON.stringify(montado));
      const r = await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, montado.corpo);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual([r.saldo.tamanho, r.saldo.quantidade], ['35', 5]);

      assert.deepEqual(await linhaMaterial(idSemEstoque), materialAntes, 'mesmo material, mesmo código, cadastro intocado');
      assert.deepEqual(await saldos(idSemEstoque), [{ tamanho: '35', quantidade: 5 }]);
      assert.equal(await contarAuditoria('ESTOQUE_MOVIMENTADO'), auditoriaAntes + 1);
      const auditoria = (await pool.query("SELECT referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'ESTOQUE_MOVIMENTADO' ORDER BY id DESC LIMIT 1", [empresa.A])).rows[0];
      assert.deepEqual([auditoria.referencia, auditoria.contexto.tipo, auditoria.contexto.quantidadeMovimentada, auditoria.dados_anteriores.quantidade, auditoria.dados_novos.quantidade],
        [`${idSemEstoque}:35`, 'ENTRADA', 5, 0, 5]);
      assert.deepEqual(nav.chamadas.filter((c) => !c.startsWith('GET') && !c.startsWith('POST /api/auth')), [`POST /api/materiais/${idSemEstoque}/estoque/movimentar`]);

      const g = await EpiMateriais.fluxo.carregarGrade(idSemEstoque);
      assert.deepEqual(g.chips.find((c) => c.tamanho === '35'), { tamanho: '35', quantidade: 5, situacao: 'com-saldo' });
      const c3 = await EpiHttp.requisitar('GET', '/estoque/itens-disponiveis?limite=100');
      assert.deepEqual(c3.dados.itens.filter((i) => i.materialId === idSemEstoque).map((i) => [i.codigoInterno, i.tamanho, i.saldo, i.disponivel, i.unidade]),
        [['ED-C3-002', '35', 5, 5, 'par']]);
    });

    test('segunda entrada no mesmo tamanho soma ao saldo; tamanho novo cria outra linha', async () => {
      await entrar(EMAILS.master, empresa.A);
      assert.equal((await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, { tamanho: '35', tipo: 'ENTRADA', quantidade: 3 })).ok, true);
      assert.equal((await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, { tamanho: '36', tipo: 'ENTRADA', quantidade: 2 })).ok, true);
      assert.deepEqual(await saldos(idSemEstoque), [{ tamanho: '35', quantidade: 8 }, { tamanho: '36', quantidade: 2 }]);
    });

    test('sem MOVIMENTAR_ESTOQUE (criar ou editar materiais não bastam): 403, nada gravado', async () => {
      const antes = await saldos(idSemEstoque);
      for (const email of [EMAILS.cadastra, EMAILS.editor]) {
        await entrar(email, empresa.A);
        const r = await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, { tamanho: '37', tipo: 'ENTRADA', quantidade: 1 });
        assert.deepEqual([r.ok, r.confirmado, r.resposta.status], [false, true, 403], email);
        assert.match(EpiMateriais.mensagens.resultadoEntradaPosterior(r, {}, {}), /movimentar estoque/i);
      }
      assert.deepEqual(await saldos(idSemEstoque), antes);
    });

    test('outra empresa: 404, nada gravado no material de A', async () => {
      const antes = await saldos(idSemEstoque);
      await entrar(EMAILS.outra, empresa.B);
      const r = await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, { tamanho: '35', tipo: 'ENTRADA', quantidade: 1 });
      assert.deepEqual([r.ok, r.resposta.status], [false, 404]);
      assert.deepEqual(await saldos(idSemEstoque), antes);
    });

    test('quantidade zero: a página não envia; enviada diretamente, o servidor recusa com 400 e nada muda', async () => {
      const nav = await entrar(EMAILS.master, empresa.A);
      const antes = await saldos(idSemEstoque);
      const local = EpiMateriais.formulario.montarEntrada({ tamanho: '35', quantidade: '0' });
      assert.deepEqual([local.ok, local.erros.map((e) => e.campo)], [false, ['quantidade']]);
      assert.equal(nav.chamadas.some((c) => /movimentar/.test(c)), false);
      const direta = await EpiMateriais.acoes.movimentar(idSemEstoque, { tamanho: '35', tipo: 'ENTRADA', quantidade: 0 });
      assert.deepEqual([direta.ok, direta.status], [false, 400]);
      assert.deepEqual(await saldos(idSemEstoque), antes);
    });
  });
});
