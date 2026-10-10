'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { abrirPoolTemporario, migrationExiste } = require('./helpers/schema-temporario');
const { todasAsMigrations, inserir } = require('./helpers/entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./helpers/solicitacao-epi-servico');
const { criarFerramentas } = require('./helpers/reserva-estoque');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { criarAppTeste } = require('../helpers/app-teste');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarSolicitacaoEpiRoutes } = require('../../src/routes/solicitacao-epi.routes');
const { criarSolicitacaoEpiController } = require('../../src/controllers/solicitacao-epi.controller');

/**
 * 12G-8 — grade de tamanhos do material, pelas rotas reais em PostgreSQL real
 * (schema temporário com todas as migrations).
 *
 * GHE = quais produtos o trabalhador pode usar; GRADE = quais tamanhos são
 * válidos para o produto; ESTOQUE = o que pode ser entregue agora. A grade é
 * explícita no cadastro do material e nunca deduzida dos lotes. Material com
 * grade: a entrada e a solicitação só aceitam tamanho da grade, e o Pedido
 * sugere a grade (inclusive tamanho sem estoque). Material antigo sem grade:
 * tudo continua como antes.
 */

const MATERIAIS = '/api/materiais';
// Classificação V2: grupo "Outros" com especificação, que não depende do catálogo da empresa (a grade é o assunto deste arquivo).
const CORPO_BASE = { nome: 'Botina de cadastro', categoria: 'Outros', categoriaDescricao: 'Calçado', tipo: 'Outros', tipoDescricao: 'Botina de cadastro', prazoUsoDias: 180, exigeTamanho: true, unidade: 'par' };

describe('12G-8 — grade de tamanhos do material', () => {
  let ctx;
  let d;
  let f;
  let app;
  let gestor;
  let gestorB;
  let pedinte;
  let soVer;

  const como = (usuarioId) => ({
    get: (url) => request(app).get(url).set(CABECALHO, String(usuarioId)),
    post: (url, corpo = {}) => request(app).post(url).set(CABECALHO, String(usuarioId)).send(corpo),
    patch: (url, corpo = {}) => request(app).patch(url).set(CABECALHO, String(usuarioId)).send(corpo),
    put: (url, corpo = {}) => request(app).put(url).set(CABECALHO, String(usuarioId)).send(corpo),
  });
  let sequencia = 0;
  async function usuarioCom(empresaId, { recursos = {}, acoes = [] } = {}) {
    sequencia += 1;
    const id = await inserirUsuario(ctx.pool, empresaId, `grade-${sequencia}@example.invalid`, 'USUARIO');
    const mestre = empresaId === d.empresaA ? d.master : d.masterB;
    for (const [recurso, operacoes] of Object.entries(recursos)) {
      await ctx.pool.query(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [empresaId, id, recurso, operacoes.includes('visualizar'), operacoes.includes('criar'), operacoes.includes('editar'), false, mestre],
      );
    }
    for (const acao of acoes) await inserir(ctx.pool, 'usuario_autorizacoes', { usuario_id: id, empresa_id: empresaId, acao_codigo: acao, autorizado_por: mestre });
    return id;
  }

  const criarComGrade = async (tamanhos, extra = {}) => {
    const r = await como(gestor).post(MATERIAIS, { ...CORPO_BASE, nome: `Botina ${crypto.randomUUID().slice(0, 8)}`, tamanhos, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.material;
  };
  const entrada = (materialId, tamanho, quantidade = 5, usuario = gestor) => como(usuario).post(`${MATERIAIS}/${materialId}/estoque/entradas`, {
    tamanho, quantidade, caNumero: '38271', caValidade: '2030-12-31', chaveIdempotencia: crypto.randomUUID(),
  });
  const pedir = (materialId, tamanho) => como(pedinte).post('/api/solicitacoes-epi', {
    funcionarioId: d.trabalhador, itens: [{ materialId, tamanho, quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: crypto.randomUUID(),
  });
  const sugeridos = async (materialId) => {
    const r = await como(pedinte).get(`/api/solicitacoes-epi/contexto/${d.trabalhador}/materiais?pagina=1&limite=100`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body.materiais.find((m) => m.id === materialId) || {}).tamanhosSugeridos;
  };
  const gradeNoBanco = async (materialId) => (await ctx.pool.query(
    'SELECT tamanho FROM material_tamanhos WHERE material_id = $1 ORDER BY ordem', [materialId],
  )).rows.map((r) => r.tamanho);
  const lotesDe = async (materialId) => (await ctx.pool.query('SELECT tamanho, saldo FROM estoque_lotes WHERE material_id = $1 ORDER BY id', [materialId])).rows;
  const erroDoCampo = (r) => (r.body.detalhes || []).map((x) => [x.campo, x.codigo]);

  before(async () => {
    assert.equal(migrationExiste('070'), true, 'migration 070 ainda não implementada');
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarMundoDoServico(ctx.pool);
    for (const empresaId of [d.empresaA, d.empresaB]) await provisionamento.provisionar(ctx.pool, { empresaId, dryRun: false });
    f = criarFerramentas(ctx.pool, d);
    const exigirSessao = sessaoDeTeste(ctx.pool);
    const { pool } = ctx;
    const relogio = () => new Date();
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool }),
        criarEstoqueRoutes({ controller: criarEstoqueController({ pool, relogio }), exigirSessao, pool }),
        criarSolicitacaoEpiRoutes({ controller: criarSolicitacaoEpiController({ pool, relogio }), exigirSessao, pool }),
      );
    });
    gestor = await usuarioCom(d.empresaA, { recursos: { materials: ['visualizar', 'criar', 'editar'] }, acoes: ['ENTRADA_ESTOQUE', 'BAIXA_ESTOQUE'] });
    gestorB = await usuarioCom(d.empresaB, { recursos: { materials: ['visualizar', 'criar', 'editar'] }, acoes: ['ENTRADA_ESTOQUE', 'BAIXA_ESTOQUE'] });
    pedinte = await usuarioCom(d.empresaA, { recursos: { request: ['visualizar', 'criar'] } });
    soVer = await usuarioCom(d.empresaA, { recursos: { materials: ['visualizar'] } });
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  describe('grade no cadastro e na edição', () => {
    test('cadastro com grade: grava na ordem informada e devolve a grade; a consulta do material também; a auditoria registra a grade', async () => {
      const material = await criarComGrade(['39', '38', '40']);
      assert.deepEqual(material.tamanhos, ['39', '38', '40']);
      assert.deepEqual(await gradeNoBanco(material.id), ['39', '38', '40']);
      const lido = await como(gestor).get(`${MATERIAIS}/${material.id}`);
      assert.deepEqual(lido.body.material.tamanhos, ['39', '38', '40']);
      const auditoria = (await ctx.pool.query("SELECT dados_novos FROM logs_auditoria WHERE acao = 'MATERIAL_CRIADO' AND referencia = $1", [String(material.id)])).rows[0];
      assert.deepEqual(auditoria.dados_novos.tamanhos, ['39', '38', '40']);
    });

    test('cadastro sem grade continua valendo (legado) e devolve grade vazia', async () => {
      const r = await como(gestor).post(MATERIAIS, { ...CORPO_BASE, nome: 'Botina sem grade' });
      assert.equal(r.status, 201);
      assert.deepEqual(r.body.material.tamanhos, []);
      assert.deepEqual(await gradeNoBanco(r.body.material.id), []);
    });

    test('edição substitui a grade (nova ordem); grade vazia volta ao comportamento legado', async () => {
      const material = await criarComGrade(['P', 'M']);
      const editado = await como(gestor).patch(`${MATERIAIS}/${material.id}`, { tamanhos: ['PP', 'P', 'M', 'G'] });
      assert.equal(editado.status, 200, JSON.stringify(editado.body));
      assert.deepEqual(editado.body.material.tamanhos, ['PP', 'P', 'M', 'G']);
      assert.deepEqual(await gradeNoBanco(material.id), ['PP', 'P', 'M', 'G']);
      const auditoria = (await ctx.pool.query("SELECT dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = 'MATERIAL_ALTERADO' AND referencia = $1", [String(material.id)])).rows[0];
      assert.deepEqual([auditoria.dados_anteriores.tamanhos, auditoria.dados_novos.tamanhos], [['P', 'M'], ['PP', 'P', 'M', 'G']]);
      const vazia = await como(gestor).patch(`${MATERIAIS}/${material.id}`, { tamanhos: [] });
      assert.equal(vazia.status, 200);
      assert.deepEqual(await gradeNoBanco(material.id), []);
    });

    test('validação: tamanho vazio, só espaços, repetido (sem diferenciar maiúsculas), longo demais ou grade grande demais → 400 em body.tamanhos, nada gravado', async () => {
      const casos = [
        [[''], ['body.tamanhos.0', 'TAMANHO_INVALIDO']],
        [['   '], ['body.tamanhos.0', 'TAMANHO_INVALIDO']],
        [['M', 'm'], ['body.tamanhos.1', 'TAMANHO_REPETIDO']],
        [['40', ' 40 '], ['body.tamanhos.1', 'TAMANHO_REPETIDO']],
        [['x'.repeat(21)], ['body.tamanhos.0', 'TAMANHO_INVALIDO']],
        [Array.from({ length: 51 }, (_, i) => `T${i}`), ['body.tamanhos', 'TAMANHO_MAXIMO']],
      ];
      for (const [tamanhos, esperado] of casos) {
        const r = await como(gestor).post(MATERIAIS, { ...CORPO_BASE, nome: 'Botina inválida', tamanhos });
        assert.equal(r.status, 400, JSON.stringify(tamanhos));
        assert.deepEqual(erroDoCampo(r), [esperado], JSON.stringify(r.body));
      }
      assert.equal((await ctx.pool.query("SELECT count(*)::int AS n FROM materiais WHERE nome = 'Botina inválida'")).rows[0].n, 0);
    });

    test('material sem tamanho não tem grade: cadastro e edição recusados; sair de "possui tamanhos" exige tirar a grade junto', async () => {
      const unico = await como(gestor).post(MATERIAIS, { ...CORPO_BASE, nome: 'Capacete com grade', exigeTamanho: false, tamanhos: ['M'] });
      assert.equal(unico.status, 400);
      assert.deepEqual(erroDoCampo(unico), [['body.tamanhos', 'GRADE_NAO_SE_APLICA']]);
      const capacete = await como(gestor).post(MATERIAIS, { ...CORPO_BASE, nome: 'Capacete único', exigeTamanho: false });
      const patch = await como(gestor).patch(`${MATERIAIS}/${capacete.body.material.id}`, { tamanhos: ['M'] });
      assert.equal(patch.status, 400);
      assert.deepEqual(erroDoCampo(patch), [['body.tamanhos', 'GRADE_NAO_SE_APLICA']]);

      const comGrade = await criarComGrade(['P', 'M']);
      const semTirar = await como(gestor).patch(`${MATERIAIS}/${comGrade.id}`, { exigeTamanho: false });
      assert.equal(semTirar.status, 409);
      assert.equal(semTirar.body.codigo, 'MATERIAL_TAMANHO_GRADE_INCOMPATIVEL');
      assert.deepEqual(await gradeNoBanco(comGrade.id), ['P', 'M']);
      const tirando = await como(gestor).patch(`${MATERIAIS}/${comGrade.id}`, { exigeTamanho: false, tamanhos: [] });
      assert.equal(tirando.status, 200, JSON.stringify(tirando.body));
      assert.deepEqual([tirando.body.material.exigeTamanho, tirando.body.material.tamanhos], [false, []]);
    });

    test('isolamento e permissões: outra empresa não vê nem edita a grade; sem materials.editar não altera; nenhuma decisão pelo nome do perfil', async () => {
      const material = await criarComGrade(['38', '39']);
      assert.equal((await como(gestorB).get(`${MATERIAIS}/${material.id}`)).status, 404);
      assert.equal((await como(gestorB).patch(`${MATERIAIS}/${material.id}`, { tamanhos: ['99'] })).status, 404);
      assert.equal((await como(soVer).patch(`${MATERIAIS}/${material.id}`, { tamanhos: ['99'] })).status, 403);
      assert.equal((await como(soVer).post(MATERIAIS, { ...CORPO_BASE, tamanhos: ['38'] })).status, 403);
      assert.deepEqual(await gradeNoBanco(material.id), ['38', '39']);
    });

    test('tamanho com marcação é só dado: gravado e devolvido como texto', async () => {
      const material = await criarComGrade(['<b>x</b>', '"40"']);
      assert.deepEqual(material.tamanhos, ['<b>x</b>', '"40"']);
      assert.deepEqual(await gradeNoBanco(material.id), ['<b>x</b>', '"40"']);
    });
  });

  describe('entrada de estoque', () => {
    test('com grade: tamanho da grade entra; fora da grade é recusado em body.tamanho e nenhum lote é criado', async () => {
      const material = await criarComGrade(['38', '39']);
      assert.equal((await entrada(material.id, '39')).status, 201);
      const fora = await entrada(material.id, '41');
      assert.equal(fora.status, 400);
      assert.deepEqual(erroDoCampo(fora), [['body.tamanho', 'TAMANHO_FORA_DA_GRADE']]);
      assert.deepEqual((await lotesDe(material.id)).map((l) => l.tamanho), ['39']);
    });

    test('material antigo sem grade: a entrada continua aceitando o tamanho como antes', async () => {
      const legado = await f.material();
      assert.equal((await entrada(legado, '47')).status, 201);
    });

    test('tirar da grade um tamanho com saldo, com mínimo próprio ou com solicitação em aberto é recusado; saldo zero não impede', async () => {
      const material = await criarComGrade(['38', '39', '40', '41']);
      assert.equal((await entrada(material.id, '38')).status, 201);
      assert.equal((await como(gestor).put(`${MATERIAIS}/${material.id}/minimos/39`, { minimo: 2 })).status, 201);
      await ctx.pool.query('INSERT INTO ghe_materiais (empresa_id, grupo_homogeneo_id, material_id) VALUES ($1, $2, $3)', [d.empresaA, d.gheA, material.id]);
      assert.equal((await pedir(material.id, '40')).status, 201);
      const zerado = await entrada(material.id, '41', 2);
      assert.equal((await como(gestor).post(`/api/estoque/lotes/${zerado.body.lote.loteId}/baixas`, {
        quantidade: 2, motivo: 'DESCARTE', chaveIdempotencia: crypto.randomUUID(),
      })).status, 201);
      for (const removido of ['38', '39', '40']) {
        const r = await como(gestor).patch(`${MATERIAIS}/${material.id}`, { tamanhos: ['38', '39', '40', '41'].filter((t) => t !== removido) });
        assert.equal(r.status, 409, removido);
        assert.equal(r.body.codigo, 'MATERIAL_GRADE_TAMANHO_EM_USO');
      }
      assert.deepEqual(await gradeNoBanco(material.id), ['38', '39', '40', '41']);
      const semUso = await como(gestor).patch(`${MATERIAIS}/${material.id}`, { tamanhos: ['38', '39', '40'] });
      assert.equal(semUso.status, 200, JSON.stringify(semUso.body));
    });

    test('definir a grade pela primeira vez sem um tamanho que já tem saldo é recusado (a grade nunca deixa estoque fora dela)', async () => {
      const legado = await f.material();
      assert.equal((await entrada(legado, '42')).status, 201);
      const r = await como(gestor).patch(`${MATERIAIS}/${legado}`, { tamanhos: ['40', '41'] });
      assert.equal(r.status, 409);
      assert.equal(r.body.codigo, 'MATERIAL_GRADE_TAMANHO_EM_USO');
      assert.equal((await como(gestor).patch(`${MATERIAIS}/${legado}`, { tamanhos: ['40', '41', '42'] })).status, 200);
    });

    test('concorrência: trocar a grade e dar entrada ao mesmo tempo nunca deixa saldo fora da grade', async () => {
      for (let rodada = 0; rodada < 8; rodada += 1) {
        const material = await criarComGrade(['38', '39']);
        await Promise.all([
          como(gestor).patch(`${MATERIAIS}/${material.id}`, { tamanhos: ['38'] }),
          entrada(material.id, '39'),
        ]);
        const grade = await gradeNoBanco(material.id);
        for (const lote of await lotesDe(material.id)) {
          if (lote.saldo > 0) assert.ok(grade.includes(lote.tamanho), `rodada ${rodada}: saldo em ${lote.tamanho} fora da grade ${grade}`);
        }
      }
    });
  });

  describe('Pedido de EPI', () => {
    test('material com grade: o Pedido sugere a grade, na ordem, inclusive tamanho sem estoque; legado continua sugerindo os tamanhos dos lotes', async () => {
      const material = await criarComGrade(['40', '38', '39']);
      await ctx.pool.query('INSERT INTO ghe_materiais (empresa_id, grupo_homogeneo_id, material_id) VALUES ($1, $2, $3)', [d.empresaA, d.gheA, material.id]);
      assert.equal((await entrada(material.id, '38')).status, 201);
      assert.deepEqual(await sugeridos(material.id), ['40', '38', '39']);
      const legado = await f.material();
      await f.estoque(legado, 3, { tamanho: '44' });
      assert.deepEqual(await sugeridos(legado), ['44']);
    });

    test('criação: tamanho da grade sem estoque é aceito; fora da grade é recusado pelo backend; legado aceita como antes', async () => {
      const material = await criarComGrade(['38', '39']);
      await ctx.pool.query('INSERT INTO ghe_materiais (empresa_id, grupo_homogeneo_id, material_id) VALUES ($1, $2, $3)', [d.empresaA, d.gheA, material.id]);
      assert.equal((await pedir(material.id, '39')).status, 201);
      const fora = await pedir(material.id, '45');
      assert.equal(fora.status, 400);
      assert.deepEqual(erroDoCampo(fora), [['body.itens[0].tamanho', 'TAMANHO_FORA_DA_GRADE']]);
      const legado = await f.material();
      assert.equal((await pedir(legado, '45')).status, 201);
    });
  });
});
