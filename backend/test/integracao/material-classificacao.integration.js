'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { abrirPoolTemporario, migrationExiste } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./helpers/solicitacao-epi-servico');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { criarAppTeste } = require('../helpers/app-teste');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');

/**
 * 12G-8 — Categoria → Tipo pelas rotas reais (PostgreSQL real, schema
 * temporário com todas as migrations). Cada categoria aceita só a sua lista;
 * "Outros" leva a descrição em coluna própria (071); o legado fora das listas
 * continua legível e editável sem conversão automática; os dois tipos de
 * óculos são distintos e o nome histórico só vale para o que já existe.
 */

const MATERIAIS = '/api/materiais';
const OUTROS = 'Outros';
const EPI = [
  'Botina de Segurança', 'Capacete', 'Creme de Proteção', 'Luva', 'Mangote', 'Óculos de Proteção Ampla Visão',
  'Óculos de Proteção Incolor', OUTROS, 'Palmilha', 'Proteção Auricular Concha', 'Proteção Auricular Descartável',
  'Respirador PFF2', 'Sapato de Segurança', 'Viseira Película Ouro',
];
const UNIFORME = ['Calça', 'Calça de Forneiro', 'Calça Eletricista', 'Camisa', 'Camisa de Forneiro', 'Camisa Eletricista', 'Camiseta', OUTROS];
const INCOLOR = 'Óculos de Proteção Incolor';
const AMPLA = 'Óculos de Proteção Incolor'.replace('Incolor', 'Ampla Visão');
const LEGADO_OCULOS = 'Óculos de proteção';
const BASE = { prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade' };
const FORA = ['body.tipo', 'TIPO_FORA_DA_CATEGORIA'];
const OBRIGATORIA = ['body.tipoDescricao', 'TIPO_DESCRICAO_OBRIGATORIA'];
const NAO_SE_APLICA = ['body.tipoDescricao', 'TIPO_DESCRICAO_NAO_SE_APLICA'];

describe('12G-8 — Categoria → Tipo, "Outros" com descrição e tipos de óculos', () => {
  let ctx;
  let d;
  let app;
  let gestor;
  let gestorB;
  let soVer;

  const como = (usuarioId) => ({
    get: (url) => request(app).get(url).set(CABECALHO, String(usuarioId)),
    post: (url, corpo = {}) => request(app).post(url).set(CABECALHO, String(usuarioId)).send(corpo),
    patch: (url, corpo = {}) => request(app).patch(url).set(CABECALHO, String(usuarioId)).send(corpo),
  });
  let sequencia = 0;
  async function usuarioCom(empresaId, { recursos = {} } = {}) {
    sequencia += 1;
    const id = await inserirUsuario(ctx.pool, empresaId, `classificacao-${sequencia}@example.invalid`, 'USUARIO');
    const mestre = empresaId === d.empresaA ? d.master : d.masterB;
    for (const [recurso, operacoes] of Object.entries(recursos)) {
      await ctx.pool.query(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [empresaId, id, recurso, operacoes.includes('visualizar'), operacoes.includes('criar'), operacoes.includes('editar'), false, mestre],
      );
    }
    return id;
  }

  const nome = (prefixo) => `${prefixo} ${crypto.randomUUID().slice(0, 8)}`;
  const criar = (corpo, usuario = gestor) => como(usuario).post(MATERIAIS, { nome: nome('Material'), ...BASE, ...corpo });
  const criado = async (corpo) => {
    const r = await criar(corpo);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.material;
  };
  const detalhes = (r) => (r.body.detalhes || []).map((x) => [x.campo, x.codigo]);
  const recusa = async (r, detalhe) => {
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.deepEqual(detalhes(r), [detalhe]);
  };
  const noBanco = async (id) => (await ctx.pool.query(
    'SELECT tipo, tipo_descricao, categoria, oculos_com_grau FROM materiais WHERE id = $1', [id],
  )).rows[0];
  const legado = async (empresaId, { categoria = null, tipo = null, oculosComGrau = null } = {}) => (await ctx.pool.query(
    `INSERT INTO materiais (empresa_id, nome, categoria, tipo, prazo_uso_dias, exige_tamanho, oculos_com_grau)
     VALUES ($1, $2, $3, $4, 180, false, $5) RETURNING id`,
    [empresaId, nome('Legado'), categoria, tipo, oculosComGrau],
  )).rows[0].id;
  const corpoDe = (categoria, tipo, extra = {}) => ({
    ...(categoria === null ? {} : { categoria }),
    tipo,
    ...(tipo === OUTROS ? { tipoDescricao: 'Descrição do item' } : {}),
    ...([INCOLOR, AMPLA].includes(tipo) ? { oculosComGrau: false } : {}),
    ...extra,
  });

  before(async () => {
    assert.equal(migrationExiste('071'), true, 'migration 071 ainda não implementada');
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarMundoDoServico(ctx.pool);
    for (const empresaId of [d.empresaA, d.empresaB]) await provisionamento.provisionar(ctx.pool, { empresaId, dryRun: false });
    const exigirSessao = sessaoDeTeste(ctx.pool);
    const { pool } = ctx;
    app = criarAppTeste((a) => {
      a.use('/api', criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool }));
    });
    gestor = await usuarioCom(d.empresaA, { recursos: { materials: ['visualizar', 'criar', 'editar'] } });
    gestorB = await usuarioCom(d.empresaB, { recursos: { materials: ['visualizar', 'criar', 'editar'] } });
    soVer = await usuarioCom(d.empresaA, { recursos: { materials: ['visualizar'] } });
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  describe('listas por categoria', () => {
    test('EPI: cada um dos 14 tipos oficiais é aceito e devolvido igual; tipo de uniforme, nome antigo ou "Outro" é 400 TIPO_FORA_DA_CATEGORIA', async () => {
      for (const tipo of EPI) {
        const material = await criado(corpoDe('EPI', tipo));
        assert.deepEqual([material.categoria, material.tipo, material.tipoDescricao], ['EPI', tipo, tipo === OUTROS ? 'Descrição do item' : null], tipo);
      }
      for (const tipo of ['Camisa', 'Calça Eletricista', 'Sapatão / Botina', 'Protetor auricular', 'Respirador', LEGADO_OCULOS, 'Outro', 'luva']) {
        await recusa(await criar(corpoDe('EPI', tipo)), FORA);
      }
    });

    test('Uniforme: os 8 tipos oficiais são aceitos; tipo de EPI é 400 TIPO_FORA_DA_CATEGORIA', async () => {
      for (const tipo of UNIFORME) {
        const material = await criado(corpoDe('Uniforme', tipo));
        assert.deepEqual([material.categoria, material.tipo], ['Uniforme', tipo], tipo);
      }
      for (const tipo of ['Luva', 'Capacete', 'Botina de Segurança', INCOLOR, 'Roupa / Uniforme']) {
        await recusa(await criar(corpoDe('Uniforme', tipo)), FORA);
      }
    });

    test('Material de consumo, Ferramenta e sem categoria: só "Outros" (com descrição); qualquer outro tipo é 400', async () => {
      for (const categoria of ['Material de consumo', 'Ferramenta', null]) {
        const material = await criado(corpoDe(categoria, OUTROS));
        assert.deepEqual([material.categoria, material.tipo, material.tipoDescricao], [categoria, OUTROS, 'Descrição do item'], String(categoria));
        for (const tipo of ['Luva', 'Camisa', 'Sapatão / Botina']) await recusa(await criar(corpoDe(categoria, tipo)), FORA);
      }
    });

    test('sem tipo o material continua aceito (como antes); o tipo nunca é adivinhado', async () => {
      const material = await criado({ categoria: 'EPI' });
      assert.deepEqual([material.tipo, material.tipoDescricao], [null, null]);
    });
  });

  describe('"Outros" com descrição própria', () => {
    test('sem descrição, descrição nula, só espaços, longa demais ou com caractere de controle: 400 no campo da descrição', async () => {
      await recusa(await criar({ categoria: 'EPI', tipo: OUTROS }), OBRIGATORIA);
      await recusa(await criar({ categoria: 'EPI', tipo: OUTROS, tipoDescricao: null }), OBRIGATORIA);
      for (const tipoDescricao of ['   ', 'x'.repeat(101), 'Fita\u0007isolante']) {
        await recusa(await criar({ categoria: 'Material de consumo', tipo: OUTROS, tipoDescricao }), ['body.tipoDescricao', 'TIPO_DESCRICAO_INVALIDA']);
      }
    });

    test('a descrição é aparada e gravada em coluna própria, com tipo = "Outros"; a consulta devolve as duas', async () => {
      const material = await criado({ categoria: 'Material de consumo', tipo: OUTROS, tipoDescricao: '  Fita isolante  ' });
      assert.deepEqual([material.tipo, material.tipoDescricao], [OUTROS, 'Fita isolante']);
      assert.deepEqual(await noBanco(material.id), { tipo: OUTROS, tipo_descricao: 'Fita isolante', categoria: 'Material de consumo', oculos_com_grau: null });
      const lido = await como(gestor).get(`${MATERIAIS}/${material.id}`);
      assert.deepEqual([lido.status, lido.body.material.tipo, lido.body.material.tipoDescricao], [200, OUTROS, 'Fita isolante']);
      const listado = await como(gestor).get(`${MATERIAIS}?pagina=1&limite=100`);
      assert.equal(listado.body.materiais.find((m) => m.id === material.id).tipoDescricao, 'Fita isolante');
    });

    test('a descrição é texto puro: marcação entra e sai byte a byte, sem interpretação', async () => {
      const texto = '<img src=x onerror=alert(1)> "aspas" & <svg/onload=1>';
      const material = await criado({ categoria: 'Ferramenta', tipo: OUTROS, tipoDescricao: texto });
      assert.equal(material.tipoDescricao, texto);
      assert.equal((await noBanco(material.id)).tipo_descricao, texto);
    });

    test('tipo que não é "Outros" não carrega descrição: 400 TIPO_DESCRICAO_NAO_SE_APLICA', async () => {
      await recusa(await criar({ categoria: 'EPI', tipo: 'Luva', tipoDescricao: 'Luva de raspa' }), NAO_SE_APLICA);
      await recusa(await criar({ categoria: 'Uniforme', tipo: 'Camisa', tipoDescricao: 'x' }), NAO_SE_APLICA);
    });

    test('edição: sair de "Outros" limpa a descrição; entrar em "Outros" exige a descrição; só a descrição também muda', async () => {
      const outros = await criado({ categoria: 'EPI', tipo: OUTROS, tipoDescricao: 'Perneira' });
      const luva = await como(gestor).patch(`${MATERIAIS}/${outros.id}`, { tipo: 'Luva' });
      assert.deepEqual([luva.status, luva.body.material.tipo, luva.body.material.tipoDescricao], [200, 'Luva', null]);
      assert.deepEqual((await noBanco(outros.id)).tipo_descricao, null);

      await recusa(await como(gestor).patch(`${MATERIAIS}/${outros.id}`, { tipo: OUTROS }), OBRIGATORIA);
      await recusa(await como(gestor).patch(`${MATERIAIS}/${outros.id}`, { tipoDescricao: 'Avental' }), NAO_SE_APLICA);
      const volta = await como(gestor).patch(`${MATERIAIS}/${outros.id}`, { tipo: OUTROS, tipoDescricao: 'Avental' });
      assert.deepEqual([volta.status, volta.body.material.tipo, volta.body.material.tipoDescricao], [200, OUTROS, 'Avental']);

      const so = await como(gestor).patch(`${MATERIAIS}/${outros.id}`, { tipoDescricao: '  Avental de raspa ' });
      assert.deepEqual([so.status, so.body.material.tipo, so.body.material.tipoDescricao], [200, OUTROS, 'Avental de raspa']);
      await recusa(await como(gestor).patch(`${MATERIAIS}/${outros.id}`, { tipoDescricao: null }), OBRIGATORIA);
      assert.deepEqual(await noBanco(outros.id), { tipo: OUTROS, tipo_descricao: 'Avental de raspa', categoria: 'EPI', oculos_com_grau: null });
    });

    test('a auditoria do cadastro e da edição registra tipo e descrição como estão', async () => {
      const material = await criado({ categoria: 'Uniforme', tipo: OUTROS, tipoDescricao: 'Jaleco' });
      await como(gestor).patch(`${MATERIAIS}/${material.id}`, { tipo: 'Camiseta' });
      const { rows } = await ctx.pool.query(
        `SELECT acao, dados_anteriores, dados_novos FROM logs_auditoria
          WHERE empresa_id = $1 AND referencia = $2 AND acao IN ('MATERIAL_CRIADO', 'MATERIAL_ALTERADO') ORDER BY id`,
        [d.empresaA, String(material.id)],
      );
      assert.deepEqual(rows.map((r) => [r.acao, r.dados_novos.tipo, r.dados_novos.tipoDescricao]), [
        ['MATERIAL_CRIADO', OUTROS, 'Jaleco'],
        ['MATERIAL_ALTERADO', 'Camiseta', null],
      ]);
      assert.deepEqual([rows[1].dados_anteriores.tipo, rows[1].dados_anteriores.tipoDescricao], [OUTROS, 'Jaleco']);
    });
  });

  describe('material legado fora das listas', () => {
    test('continua legível e editável nos outros campos, sem conversão; a categoria não muda para uma incompatível com o tipo antigo', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: 'Sapatão / Botina' });
      const lido = await como(gestor).get(`${MATERIAIS}/${id}`);
      assert.deepEqual([lido.status, lido.body.material.tipo, lido.body.material.tipoDescricao], [200, 'Sapatão / Botina', null]);

      const renomeado = await como(gestor).patch(`${MATERIAIS}/${id}`, { nome: 'Botina renomeada' });
      assert.deepEqual([renomeado.status, renomeado.body.material.tipo], [200, 'Sapatão / Botina']);

      await recusa(await como(gestor).patch(`${MATERIAIS}/${id}`, { categoria: 'Uniforme' }), FORA);
      assert.deepEqual((await noBanco(id)).categoria, 'EPI');

      const trocado = await como(gestor).patch(`${MATERIAIS}/${id}`, { categoria: 'Uniforme', tipo: 'Camisa' });
      assert.deepEqual([trocado.status, trocado.body.material.categoria, trocado.body.material.tipo], [200, 'Uniforme', 'Camisa']);
    });

    test('ao ser salvo como "Outros" + descrição, passa ao formato novo; o nome antigo não é aceito como valor novo', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: 'Protetor auricular' });
      const convertido = await como(gestor).patch(`${MATERIAIS}/${id}`, { tipo: OUTROS, tipoDescricao: 'Protetor auricular' });
      assert.deepEqual([convertido.status, convertido.body.material.tipo, convertido.body.material.tipoDescricao], [200, OUTROS, 'Protetor auricular']);
      assert.deepEqual(await noBanco(id), { tipo: OUTROS, tipo_descricao: 'Protetor auricular', categoria: 'EPI', oculos_com_grau: null });

      const novo = await criado({ categoria: 'EPI', tipo: 'Luva' });
      await recusa(await como(gestor).patch(`${MATERIAIS}/${novo.id}`, { tipo: 'Protetor auricular' }), FORA);
    });

    test('legado sem categoria e sem tipo: editar o nome continua possível', async () => {
      const id = await legado(d.empresaA, {});
      const r = await como(gestor).patch(`${MATERIAIS}/${id}`, { nome: 'Sem classificação' });
      assert.deepEqual([r.status, r.body.material.tipo, r.body.material.categoria], [200, null, null]);
    });
  });

  describe('óculos de proteção', () => {
    test('Incolor e Ampla Visão são distintos no dado gravado e seguem a regra de óculos com grau', async () => {
      await recusa(await criar({ categoria: 'EPI', tipo: INCOLOR }), ['body.oculosComGrau', 'OCULOS_COM_GRAU_OBRIGATORIO']);
      await recusa(await criar({ categoria: 'EPI', tipo: AMPLA, oculosComGrau: null }), ['body.oculosComGrau', 'OCULOS_COM_GRAU_OBRIGATORIO']);
      const incolor = await criado({ categoria: 'EPI', tipo: INCOLOR, oculosComGrau: true });
      const ampla = await criado({ categoria: 'EPI', tipo: AMPLA, oculosComGrau: false });
      assert.deepEqual(await noBanco(incolor.id), { tipo: INCOLOR, tipo_descricao: null, categoria: 'EPI', oculos_com_grau: true });
      assert.deepEqual(await noBanco(ampla.id), { tipo: AMPLA, tipo_descricao: null, categoria: 'EPI', oculos_com_grau: false });
      assert.notEqual(INCOLOR, AMPLA);
      await recusa(await criar({ categoria: 'EPI', tipo: 'Luva', oculosComGrau: true }), ['body.oculosComGrau', 'OCULOS_COM_GRAU_NAO_SE_APLICA']);
    });

    test('o nome histórico vale só para o que já existe: legível, editável, convertível a Incolor ou Ampla Visão sem perder o grau; nunca aceito como valor novo', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: LEGADO_OCULOS, oculosComGrau: true });
      const lido = await como(gestor).get(`${MATERIAIS}/${id}`);
      assert.deepEqual([lido.body.material.tipo, lido.body.material.oculosComGrau], [LEGADO_OCULOS, true]);

      const renomeado = await como(gestor).patch(`${MATERIAIS}/${id}`, { nome: 'Óculos renomeado' });
      assert.deepEqual([renomeado.status, renomeado.body.material.tipo, renomeado.body.material.oculosComGrau], [200, LEGADO_OCULOS, true]);

      const incolor = await como(gestor).patch(`${MATERIAIS}/${id}`, { tipo: INCOLOR });
      assert.deepEqual([incolor.status, incolor.body.material.tipo, incolor.body.material.oculosComGrau], [200, INCOLOR, true]);
      assert.deepEqual(await noBanco(id), { tipo: INCOLOR, tipo_descricao: null, categoria: 'EPI', oculos_com_grau: true });

      const ampla = await como(gestor).patch(`${MATERIAIS}/${id}`, { tipo: AMPLA, oculosComGrau: false });
      assert.deepEqual([ampla.status, ampla.body.material.tipo, ampla.body.material.oculosComGrau], [200, AMPLA, false]);

      const luva = await criado({ categoria: 'EPI', tipo: 'Luva' });
      await recusa(await como(gestor).patch(`${MATERIAIS}/${luva.id}`, { tipo: LEGADO_OCULOS, oculosComGrau: true }), FORA);
      await recusa(await criar({ categoria: 'EPI', tipo: LEGADO_OCULOS, oculosComGrau: true }), FORA);
    });

    test('óculos legado que passa a outro tipo perde o grau, como antes', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: LEGADO_OCULOS, oculosComGrau: false });
      const r = await como(gestor).patch(`${MATERIAIS}/${id}`, { tipo: 'Luva' });
      assert.deepEqual([r.status, r.body.material.tipo, r.body.material.oculosComGrau], [200, 'Luva', null]);
    });
  });

  describe('isolamento e permissão', () => {
    test('só visualizar não cadastra (403); outra empresa não vê nem edita (404)', async () => {
      assert.equal((await criar({ categoria: 'EPI', tipo: 'Luva' }, soVer)).status, 403);
      const material = await criado({ categoria: 'EPI', tipo: OUTROS, tipoDescricao: 'Perneira' });
      assert.equal((await como(gestorB).get(`${MATERIAIS}/${material.id}`)).status, 404);
      assert.equal((await como(gestorB).patch(`${MATERIAIS}/${material.id}`, { tipoDescricao: 'Outra' })).status, 404);
      assert.equal((await noBanco(material.id)).tipo_descricao, 'Perneira');
    });
  });
});
