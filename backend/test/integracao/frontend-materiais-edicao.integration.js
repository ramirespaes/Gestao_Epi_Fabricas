'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
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
 * Prova, no banco: a edição não altera o estoque nem cria movimentação; a
 * troca de categoria/tipo não mexe nos lotes (a C3 continua listando os
 * mesmos tamanhos); a entrada inicial só acontece com "Sim" explícito; e a
 * API recusa editar sem materials.editar (403) e fora da empresa (404).
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 46 }, (_, i) => String(i).padStart(3, '0'));
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
  nome: 'Botina edição C2', categoria: 'EPI', tipo: 'Sapatão / Botina', tipoCustom: '', controleTamanho: 'grade',
  fabricante: 'Bracol', codigoInterno: 'ED-001', quantidadeComprada: '30', tamanhoEntrada: '42', caEntrada: '38271', caValidadeEntrada: '2030-12-31',
  unidade: 'Par', estoqueMinimo: '5', prazoUnidade: 'meses', prazo: '6', descricao: 'Material da melhoria C2', registrarEntrada: 'sim',
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
    const login = await EpiPortal.acoes.entrar({ email, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.ok, true, JSON.stringify(login));
    if (!(login.dados.contexto && login.dados.contexto.empresa.id === empresaId)) {
      const sel = await EpiPortal.acoes.selecionar(empresaId);
      assert.equal(sel.ok, true, JSON.stringify(sel));
    }
    return nav;
  }

  const lotes = async (materialId) => (await pool.query('SELECT tamanho, saldo FROM estoque_lotes WHERE material_id = $1 ORDER BY id', [materialId])).rows;
  const legado = async (materialId) => (await pool.query('SELECT count(*)::int AS n FROM estoque_tamanhos WHERE material_id = $1', [materialId])).rows[0].n;
  const contarAuditoria = async (acao) => (await pool.query('SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2', [empresa.A, acao])).rows[0].n;
  const novaOperacao = () => EpiMateriais.idempotencia.criar();

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
      criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
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
    const r = await EpiMateriais.fluxo.cadastrar({ corpo: m.corpo, entrada: m.entrada, podeMovimentar: true, idempotencia: novaOperacao() });
    assert.equal(r.ok && r.entrada.realizada, true, JSON.stringify(r));
    idBotina = r.material.id;
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (contexto) await contexto.encerrar();
  });

  test('editar nome e fabricante: PATCH só com os dois, persistido e auditado; o CA legado do cadastro e o estoque não mudam', async () => {
    const nav = await entrar(EMAILS.master, empresa.A);
    await pool.query("UPDATE materiais SET ca_numero = '38271', ca_validade = '2026-10-15' WHERE id = $1", [idBotina]);
    const lotesAntes = await lotes(idBotina);
    assert.deepEqual(lotesAntes, [{ tamanho: '42', saldo: 30 }]);
    const entradasAntes = await contarAuditoria('ESTOQUE_ENTRADA');
    const alteracoesAntes = await contarAuditoria('MATERIAL_ALTERADO');

    const { montado, resposta } = await editar(idBotina, { nome: 'Botina editada C2', fabricante: '3M', caNumero: '40000', caValidade: '2027-03-01' });
    assert.deepEqual(montado.corpo, { nome: 'Botina editada C2', fabricante: '3M' }, 'o CA do cadastro nunca vai no PATCH');
    assert.equal(resposta.ok, true, JSON.stringify(resposta));

    const { rows } = await pool.query("SELECT nome, ca_numero, to_char(ca_validade, 'YYYY-MM-DD') AS ca_validade, fabricante, unidade, estoque_minimo, prazo_uso_dias, exige_tamanho, codigo_interno FROM materiais WHERE id = $1", [idBotina]);
    assert.deepEqual(rows[0], { nome: 'Botina editada C2', ca_numero: '38271', ca_validade: '2026-10-15', fabricante: '3M', unidade: 'par', estoque_minimo: 5, prazo_uso_dias: 180, exige_tamanho: true, codigo_interno: 'ED-001' });
    assert.deepEqual(await lotes(idBotina), lotesAntes, 'estoque inalterado');
    assert.equal(await contarAuditoria('ESTOQUE_ENTRADA'), entradasAntes, 'nenhuma movimentação');
    assert.equal(await contarAuditoria('MATERIAL_ALTERADO'), alteracoesAntes + 1);
    assert.deepEqual(nav.chamadas.filter((c) => !c.startsWith('GET') && !c.startsWith('POST /api/auth')), [`PATCH /api/materiais/${idBotina}`]);
  });

  test('abrir e salvar sem mexer em nada: nenhum PATCH; prazo de 180 dias volta como 6 meses e o controle de tamanho volta como "possui tamanhos"', async () => {
    await entrar(EMAILS.master, empresa.A);
    const { montado, resposta } = await editar(idBotina, {});
    assert.deepEqual([montado.alterado, resposta], [false, null]);
    const carga = await EpiMateriais.acoes.buscar(idBotina);
    const campos = EpiMateriais.formulario.camposDoMaterial(carga.dados.material).campos;
    assert.deepEqual([campos.prazo, campos.prazoUnidade, campos.controleTamanho], ['6', 'meses', 'grade']);
  });

  test('prazo de uso pela edição: aumentar e reduzir gravam o novo valor; apagar não é possível', async () => {
    await entrar(EMAILS.master, empresa.A);
    for (const [prazo, dias] of [['8', 240], ['6', 180]]) {
      const { resposta } = await editar(idBotina, { prazo, prazoUnidade: 'meses' });
      assert.equal(resposta.dados.material.prazoUsoDias, dias);
    }
    const carga = await EpiMateriais.acoes.buscar(idBotina);
    const semPrazo = EpiMateriais.formulario.montarEdicao({ ...EpiMateriais.formulario.camposDoMaterial(carga.dados.material).campos, prazo: '' }, carga.dados.material);
    assert.deepEqual([semPrazo.ok, semPrazo.erros.map((e) => e.campo)], [false, ['prazo']]);
  });

  // O fuso do processo Node do servidor é trocado em tempo de execução;
  // servidor e banco são os mesmos.
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

  // E10: o material não tem CA. O valor antigo fica no banco, mas não sai na API nem entra no formulário.
  test('CA legado do cadastro não sai na consulta nem na lista, em São Paulo, UTC, Tóquio e Berlim; ele não entra no formulário', async () => {
    await entrar(EMAILS.master, empresa.A);
    await pool.query("UPDATE materiais SET ca_validade = '2026-10-15' WHERE id = $1", [idBotina]);
    for (const fuso of FUSOS) {
      await emFuso(fuso, async () => {
        const um = await EpiMateriais.acoes.buscar(idBotina);
        const lista = await EpiMateriais.acoes.listar({ ativo: true, limite: 100 });
        assert.deepEqual([um.ok, lista.ok], [true, true], fuso);
        assert.deepEqual(['caValidade' in um.dados.material, 'caValidade' in lista.dados.materiais.find((m) => m.id === idBotina)], [false, false], fuso);
        assert.equal('caValidade' in EpiMateriais.formulario.camposDoMaterial(um.dados.material).campos, false, fuso);
      });
    }
  });

  test('salvar a edição em Tóquio e Berlim: o CA legado não é reenviado nem muda; nem o PATCH nem a auditoria trazem CA', async () => {
    await entrar(EMAILS.master, empresa.A);
    await pool.query("UPDATE materiais SET ca_validade = '2026-10-15' WHERE id = $1", [idBotina]);
    const dataNoBanco = async () => (await pool.query("SELECT to_char(ca_validade, 'YYYY-MM-DD') AS d FROM materiais WHERE id = $1", [idBotina])).rows[0].d;
    const ultimaAuditoria = async () => (await pool.query("SELECT dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'MATERIAL_ALTERADO' ORDER BY id DESC LIMIT 1", [empresa.A])).rows[0];
    for (const fuso of ['Asia/Tokyo', 'Europe/Berlin']) {
      await emFuso(fuso, async () => {
        const { montado, resposta } = await editar(idBotina, { descricao: `Salvo em ${fuso}`, caValidade: '2026-10-20' });
        assert.deepEqual(montado.corpo, { descricao: `Salvo em ${fuso}` }, 'a data não é reenviada');
        assert.equal(resposta.ok, true, JSON.stringify(resposta));
        assert.equal('caValidade' in resposta.dados.material, false, fuso);
        assert.equal(await dataNoBanco(), '2026-10-15', fuso);
        const auditoria = await ultimaAuditoria();
        assert.deepEqual(['caValidade' in auditoria.dados_anteriores, 'caValidade' in auditoria.dados_novos], [false, false], fuso);
      });
    }
  });

  test('unidade de controle: PATCH direto com unidade (diferente, igual ou junto de outro campo) → 400; unidade, dados, estoque e auditoria intactos', async () => {
    await entrar(EMAILS.master, empresa.A);
    const linhaAntes = (await pool.query('SELECT * FROM materiais WHERE id = $1', [idBotina])).rows[0];
    const lotesAntes = await lotes(idBotina);
    const auditoriaAntes = (await pool.query('SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1', [empresa.A])).rows[0].n;
    for (const corpo of [{ unidade: 'caixa' }, { unidade: 'par' }, { unidade: 'caixa', nome: 'Troca junto' }]) {
      const r = await EpiMateriais.acoes.alterar(idBotina, corpo);
      assert.deepEqual([r.ok, r.status, r.codigo], [false, 400, 'VALIDACAO'], JSON.stringify(corpo));
      assert.ok(r.detalhes.some((d) => d.campo === 'body.unidade' && d.codigo === 'CAMPO_NAO_PERMITIDO'), JSON.stringify(r.detalhes));
    }
    assert.deepEqual((await pool.query('SELECT * FROM materiais WHERE id = $1', [idBotina])).rows[0], linhaAntes, 'material intacto, unidade par');
    assert.equal(linhaAntes.unidade, 'par');
    assert.deepEqual(await lotes(idBotina), lotesAntes);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1', [empresa.A])).rows[0].n, auditoriaAntes, 'nada auditado');
  });

  test('trocar categoria e tipo não mexe nos lotes: o lote 42 continua com saldo, a lista de tamanhos segue o novo tipo, e Itens Disponíveis mostra o novo tipo', async () => {
    await entrar(EMAILS.master, empresa.A);
    const antes = await lotes(idBotina);
    const { resposta } = await editar(idBotina, { categoria: 'Uniforme', tipo: 'Luva' });
    assert.equal(resposta.ok, true, JSON.stringify(resposta));
    assert.deepEqual(await lotes(idBotina), antes, 'lotes intactos');

    const e = await EpiMateriais.fluxo.carregarEstoque(idBotina);
    assert.equal(e.ok, true, JSON.stringify(e));
    assert.deepEqual(e.lotes.map((l) => [l.tamanho, l.fisico]), [['42', 30]]);
    assert.deepEqual(EpiMateriais.formulario.tamanhosDaEntrada(e.lotes, e.material.tipo).slice(0, 6), ['42', 'PP', 'P', 'M', 'G', 'GG']);

    const c3 = await EpiHttp.requisitar('GET', '/estoque/itens-disponiveis?limite=100');
    assert.equal(c3.ok, true, JSON.stringify(c3));
    const linhas = c3.dados.itens.filter((i) => i.materialId === idBotina);
    assert.deepEqual(linhas.map((i) => [i.tamanho, i.saldo, i.tipo, i.categoria]), [['42', 30, 'Luva', 'Uniforme']]);
  });

  test('entrada inicial "Não": material criado sem lote e sem movimentação, mesmo com quantidade no formulário', async () => {
    const nav = await entrar(EMAILS.master, empresa.A);
    const m = EpiMateriais.formulario.montarCorpo({ ...FORMULARIO, nome: 'Sem estoque C2', codigoInterno: 'ED-002', registrarEntrada: 'nao' });
    assert.equal(m.entrada, null);
    const r = await EpiMateriais.fluxo.cadastrar({ corpo: m.corpo, entrada: m.entrada, podeMovimentar: true, idempotencia: novaOperacao() });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await lotes(r.material.id), []);
    assert.equal(nav.chamadas.some((c) => /estoque\/entradas/.test(c)), false);
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

  test('controle de tamanho pela edição: o legado recebe a primeira classificação; depois, a troca com saldo incompatível é recusada com mensagem clara', async () => {
    await entrar(EMAILS.master, empresa.A);
    const idLegado = (await pool.query("INSERT INTO materiais (empresa_id, nome, prazo_uso_dias) VALUES ($1, 'Protetor legado', 180) RETURNING id", [empresa.A])).rows[0].id;
    const carga = await EpiMateriais.acoes.buscar(idLegado);
    assert.equal(EpiMateriais.formulario.camposDoMaterial(carga.dados.material).campos.controleTamanho, '');
    const semClasse = await EpiMateriais.fluxo.registrarEntrada(idLegado, { quantidade: 5, caNumero: '1', caValidade: '2030-12-31' }, novaOperacao());
    assert.deepEqual([semClasse.resposta.status, semClasse.resposta.codigo], [409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO']);
    assert.match(EpiMateriais.mensagens.erroEntrada(semClasse.resposta), /controle de tamanho/i);

    const { montado, resposta } = await editar(idLegado, { controleTamanho: 'unico' });
    assert.deepEqual([montado.corpo, resposta.ok, resposta.dados.material.exigeTamanho], [{ exigeTamanho: false }, true, false]);
    const entrada = await EpiMateriais.fluxo.registrarEntrada(idLegado, { quantidade: 5, caNumero: '1', caValidade: '2030-12-31' }, novaOperacao());
    assert.equal(entrada.ok, true, JSON.stringify(entrada));

    const troca = await editar(idLegado, { controleTamanho: 'grade' });
    assert.deepEqual([troca.resposta.status, troca.resposta.codigo], [409, 'MATERIAL_TAMANHO_SALDO_INCOMPATIVEL']);
    assert.match(EpiMateriais.mensagens.erroEdicao(troca.resposta), /controle de tamanho/i);
    assert.match(EpiMateriais.mensagens.erroEdicao(troca.resposta), /saldo/i);
    assert.equal((await pool.query('SELECT exige_tamanho FROM materiais WHERE id = $1', [idLegado])).rows[0].exige_tamanho, false);
  });

  describe('óculos de proteção com ou sem grau', () => {
    const OCULOS = 'Óculos de proteção';
    const OCULOS_FORM = { ...FORMULARIO, tipo: OCULOS, controleTamanho: 'unico', codigoInterno: '', registrarEntrada: 'nao', unidade: 'Unidade' };
    const noBanco = async (id) => (await pool.query('SELECT tipo, oculos_com_grau FROM materiais WHERE id = $1', [id])).rows[0];
    const cadastrar = async (campos) => {
      const m = EpiMateriais.formulario.montarCorpo(campos);
      assert.equal(m.ok, true, JSON.stringify(m));
      const r = await EpiMateriais.fluxo.cadastrar({ corpo: m.corpo, entrada: m.entrada, podeMovimentar: true, idempotencia: novaOperacao() });
      assert.equal(r.ok, true, JSON.stringify(r));
      return { corpo: m.corpo, material: r.material };
    };

    test('cadastro pela página: óculos marcado grava true, desmarcado grava false; outro tipo não envia a informação e grava NULL mesmo com a caixa marcada', async () => {
      await entrar(EMAILS.master, empresa.A);
      for (const oculosComGrau of [true, false]) {
        const { corpo, material } = await cadastrar({ ...OCULOS_FORM, nome: `Óculos ${oculosComGrau}`, oculosComGrau });
        assert.equal(corpo.oculosComGrau, oculosComGrau);
        assert.equal(material.oculosComGrau, oculosComGrau);
        assert.deepEqual(await noBanco(material.id), { tipo: OCULOS, oculos_com_grau: oculosComGrau });
      }
      const { corpo, material } = await cadastrar({ ...OCULOS_FORM, nome: 'Luva com caixa escondida', tipo: 'Luva', oculosComGrau: true });
      assert.equal(Object.hasOwn(corpo, 'oculosComGrau'), false);
      assert.equal(material.oculosComGrau, null);
      assert.deepEqual(await noBanco(material.id), { tipo: 'Luva', oculos_com_grau: null });
    });

    test('legado NULL: abrir e editar outro campo não classifica; a classificação só vai quando a pessoa mexe na caixa', async () => {
      await entrar(EMAILS.master, empresa.A);
      const id = (await pool.query(
        "INSERT INTO materiais (empresa_id, nome, tipo, prazo_uso_dias, exige_tamanho) VALUES ($1, 'Óculos legado', $2, 180, false) RETURNING id",
        [empresa.A, OCULOS],
      )).rows[0].id;
      const carga = await EpiMateriais.acoes.buscar(id);
      assert.equal(carga.dados.material.oculosComGrau, null);
      assert.equal(EpiMateriais.formulario.oculosSemClassificacao(carga.dados.material), true);

      const aberto = await editar(id, {});
      assert.deepEqual([aberto.montado.alterado, aberto.resposta], [false, null], 'abrir e salvar não envia nada');
      const renomeado = await editar(id, { nome: 'Óculos legado renomeado' });
      assert.deepEqual(renomeado.montado.corpo, { nome: 'Óculos legado renomeado' });
      assert.deepEqual(await noBanco(id), { tipo: OCULOS, oculos_com_grau: null });

      const classificado = await editar(id, { oculosComGrau: false, oculosComGrauTocado: true });
      assert.deepEqual([classificado.montado.corpo, classificado.resposta.ok], [{ oculosComGrau: false }, true]);
      assert.deepEqual(await noBanco(id), { tipo: OCULOS, oculos_com_grau: false });
      const recarga = await EpiMateriais.acoes.buscar(id);
      assert.deepEqual([EpiMateriais.formulario.camposDoMaterial(recarga.dados.material).campos.oculosComGrau, EpiMateriais.formulario.oculosSemClassificacao(recarga.dados.material)], [false, false]);
    });

    test('troca de tipo pela página: óculos para Luva limpa a informação; Luva para óculos envia a classificação escolhida', async () => {
      await entrar(EMAILS.master, empresa.A);
      const { material: oculos } = await cadastrar({ ...OCULOS_FORM, nome: 'Óculos que vira luva', oculosComGrau: true });
      const paraLuva = await editar(oculos.id, { tipo: 'Luva' });
      assert.deepEqual(paraLuva.montado.corpo, { tipo: 'Luva', oculosComGrau: null });
      assert.equal(paraLuva.resposta.ok, true, JSON.stringify(paraLuva.resposta));
      assert.deepEqual(await noBanco(oculos.id), { tipo: 'Luva', oculos_com_grau: null });

      const paraOculos = await editar(oculos.id, { tipo: OCULOS, oculosComGrau: true, oculosComGrauTocado: true });
      assert.deepEqual(paraOculos.montado.corpo, { tipo: OCULOS, oculosComGrau: true });
      assert.equal(paraOculos.resposta.ok, true, JSON.stringify(paraOculos.resposta));
      assert.deepEqual(await noBanco(oculos.id), { tipo: OCULOS, oculos_com_grau: true });
    });
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

  // Entrada de estoque em material já cadastrado: botina cadastrada sem quantidade.
  describe('entrada de estoque posterior por lote', () => {
    let idSemEstoque;
    const linhaMaterial = async (id) => (await pool.query('SELECT id, codigo_interno, nome, unidade, atualizado_em FROM materiais WHERE id = $1', [id])).rows[0];
    const entrada = (extra = {}) => ({ tamanho: '35', quantidade: 5, caNumero: '38271', caValidade: '2030-12-31', ...extra });

    before(async () => {
      await entrar(EMAILS.master, empresa.A);
      const m = EpiMateriais.formulario.montarCorpo({ ...FORMULARIO, nome: 'Botina teste validade C3', codigoInterno: 'ED-C3-002', registrarEntrada: 'nao' });
      const r = await EpiMateriais.fluxo.cadastrar({ corpo: m.corpo, entrada: m.entrada, podeMovimentar: true, idempotencia: novaOperacao() });
      assert.equal(r.ok, true, JSON.stringify(r));
      idSemEstoque = r.material.id;
      assert.deepEqual(await lotes(idSemEstoque), []);
    });

    test('5 pares no tamanho 35: mesmo material e código, lote criado com 5 e o CA, ESTOQUE_ENTRADA auditada, nenhum PATCH, nada em estoque_tamanhos', async () => {
      const nav = await entrar(EMAILS.master, empresa.A);
      const materialAntes = await linhaMaterial(idSemEstoque);
      const auditoriaAntes = await contarAuditoria('ESTOQUE_ENTRADA');
      const montado = EpiMateriais.formulario.montarEntrada({ tamanho: '35', quantidade: '5', caNumero: '38271', caValidade: '2030-12-31' }, true);
      assert.equal(montado.ok, true, JSON.stringify(montado));
      const r = await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, montado.corpo, novaOperacao());
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual([r.lote.tamanho, r.lote.saldo, r.lote.caNumero], ['35', 5, '38271']);

      assert.deepEqual(await linhaMaterial(idSemEstoque), materialAntes, 'mesmo material, mesmo código, cadastro intocado');
      assert.deepEqual(await lotes(idSemEstoque), [{ tamanho: '35', saldo: 5 }]);
      assert.equal(await legado(idSemEstoque), 0);
      assert.equal(await contarAuditoria('ESTOQUE_ENTRADA'), auditoriaAntes + 1);
      assert.deepEqual(nav.chamadas.filter((c) => !c.startsWith('GET') && !c.startsWith('POST /api/auth')), [`POST /api/materiais/${idSemEstoque}/estoque/entradas`]);
      const e = await EpiMateriais.fluxo.carregarEstoque(idSemEstoque);
      assert.deepEqual(e.totais, { fisico: 5, bloqueado: 0, disponivel: 5 });
    });

    test('nova entrada no mesmo tamanho cria outro lote; tamanho novo também; os totais somam', async () => {
      await entrar(EMAILS.master, empresa.A);
      assert.equal((await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, entrada({ quantidade: 3, caNumero: '40000' }), novaOperacao())).ok, true);
      assert.equal((await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, entrada({ tamanho: '36', quantidade: 2 }), novaOperacao())).ok, true);
      assert.deepEqual(await lotes(idSemEstoque), [{ tamanho: '35', saldo: 5 }, { tamanho: '35', saldo: 3 }, { tamanho: '36', saldo: 2 }]);
      assert.deepEqual((await EpiMateriais.fluxo.carregarEstoque(idSemEstoque)).totais, { fisico: 10, bloqueado: 0, disponivel: 10 });
    });

    test('CA vencido: 400 com mensagem clara e nada gravado', async () => {
      await entrar(EMAILS.master, empresa.A);
      const antes = await lotes(idSemEstoque);
      const r = await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, entrada({ caValidade: '2020-01-31' }), novaOperacao());
      assert.deepEqual([r.ok, r.confirmado, r.resposta.status], [false, true, 400]);
      assert.match(EpiMateriais.mensagens.resultadoEntrada(r, {}, {}), /CA vencido/);
      assert.deepEqual(await lotes(idSemEstoque), antes);
    });

    test('sem MOVIMENTAR_ESTOQUE (criar ou editar materiais não bastam): 403, nada gravado', async () => {
      const antes = await lotes(idSemEstoque);
      for (const email of [EMAILS.cadastra, EMAILS.editor]) {
        await entrar(email, empresa.A);
        const r = await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, entrada({ tamanho: '37', quantidade: 1 }), novaOperacao());
        assert.deepEqual([r.ok, r.confirmado, r.resposta.status], [false, true, 403], email);
        assert.match(EpiMateriais.mensagens.resultadoEntrada(r, {}, {}), /movimentar estoque/i);
      }
      assert.deepEqual(await lotes(idSemEstoque), antes);
    });

    test('outra empresa: 404, nada gravado no material de A', async () => {
      const antes = await lotes(idSemEstoque);
      await entrar(EMAILS.outra, empresa.B);
      const r = await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, entrada({ quantidade: 1 }), novaOperacao());
      assert.deepEqual([r.ok, r.resposta.status], [false, 404]);
      assert.deepEqual(await lotes(idSemEstoque), antes);
    });

    test('quantidade zero: a página não envia; enviada diretamente, o servidor recusa com 400 e nada muda', async () => {
      const nav = await entrar(EMAILS.master, empresa.A);
      const antes = await lotes(idSemEstoque);
      const local = EpiMateriais.formulario.montarEntrada({ tamanho: '35', quantidade: '0', caNumero: '1', caValidade: '2030-12-31' }, true);
      assert.deepEqual([local.ok, local.erros.map((e) => e.campo)], [false, ['quantidade']]);
      assert.equal(nav.chamadas.some((c) => /entradas/.test(c)), false);
      const direta = await EpiMateriais.fluxo.registrarEntrada(idSemEstoque, entrada({ quantidade: 0 }), novaOperacao());
      assert.deepEqual([direta.ok, direta.resposta.status], [false, 400]);
      assert.deepEqual(await lotes(idSemEstoque), antes);
    });
  });
});
