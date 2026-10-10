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
const LEGADO_OCULOS = 'Óculos de proteção';
const BASE = { prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade' };

describe('12G-8 → classificação V2 — material legado, óculos legado e isolamento', () => {
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

  // As listas fixas por categoria e o "Outros" da 12G-8 foram substituídos pela classificação V2 (Grupo → Grupo de Proteção → Tipo do
  // catálogo; 08/10/2026): essas regras têm a suíte própria em material-classificacao-v2.integration.js. Aqui ficam o LEGADO e o isolamento.
  const OUTRO_DE = (grupoProtecao, descricao) => ({ categoria: 'EPI', grupoProtecao, tipo: OUTROS, tipoDescricao: descricao });

  describe('material legado (anterior à classificação V2)', () => {
    test('continua legível e editável nos outros campos, sem conversão; mudar só o grupo exige o bloco completo; o bloco completo converte para V2', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: 'Sapatão / Botina' });
      const lido = await como(gestor).get(`${MATERIAIS}/${id}`);
      assert.deepEqual([lido.status, lido.body.material.tipo, lido.body.material.tipoDescricao, lido.body.material.modeloClassificacao], [200, 'Sapatão / Botina', null, 'LEGADO']);

      const renomeado = await como(gestor).patch(`${MATERIAIS}/${id}`, { nome: 'Botina renomeada' });
      assert.deepEqual([renomeado.status, renomeado.body.material.tipo, renomeado.body.material.modeloClassificacao], [200, 'Sapatão / Botina', 'LEGADO']);

      await recusa(await como(gestor).patch(`${MATERIAIS}/${id}`, { categoria: 'Vestimenta' }), ['body.grupoProtecao', 'GRUPO_PROTECAO_OBRIGATORIO']);
      assert.deepEqual((await noBanco(id)).categoria, 'EPI');

      const convertido = await como(gestor).patch(`${MATERIAIS}/${id}`, { categoria: 'Vestimenta', grupoProtecao: 'Proteção do tronco', tipo: OUTROS, tipoDescricao: 'Camisa' });
      assert.deepEqual(
        [convertido.status, convertido.body.material.categoria, convertido.body.material.tipo, convertido.body.material.modeloClassificacao],
        [200, 'Vestimenta', OUTROS, 'V2'],
      );
    });

    test('ao ser reclassificado como "Outros" + especificação, passa ao formato novo; o nome antigo não é aceito como valor novo', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: 'Protetor auricular' });
      const convertido = await como(gestor).patch(`${MATERIAIS}/${id}`, OUTRO_DE('Proteção auditiva', 'Protetor auricular'));
      assert.deepEqual([convertido.status, convertido.body.material.tipo, convertido.body.material.tipoDescricao], [200, OUTROS, 'Protetor auricular']);
      assert.deepEqual(await noBanco(id), { tipo: OUTROS, tipo_descricao: 'Protetor auricular', categoria: 'EPI', oculos_com_grau: null });

      const novo = await criado(OUTRO_DE('Proteção das mãos', 'Luva'));
      const recusado = await como(gestor).patch(`${MATERIAIS}/${novo.id}`, { tipo: 'Protetor auricular' });
      assert.equal(recusado.status, 400, JSON.stringify(recusado.body));
    });

    test('legado sem categoria e sem tipo: editar o nome continua possível', async () => {
      const id = await legado(d.empresaA, {});
      const r = await como(gestor).patch(`${MATERIAIS}/${id}`, { nome: 'Sem classificação' });
      assert.deepEqual([r.status, r.body.material.tipo, r.body.material.categoria], [200, null, null]);
    });
  });

  describe('óculos de proteção legado', () => {
    test('o nome histórico vale só para o que já existe: legível, editável, reclassificável para EPI + Proteção ocular sem perder o grau; nunca aceito como valor novo', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: LEGADO_OCULOS, oculosComGrau: true });
      const lido = await como(gestor).get(`${MATERIAIS}/${id}`);
      assert.deepEqual([lido.body.material.tipo, lido.body.material.oculosComGrau], [LEGADO_OCULOS, true]);

      const renomeado = await como(gestor).patch(`${MATERIAIS}/${id}`, { nome: 'Óculos renomeado' });
      assert.deepEqual([renomeado.status, renomeado.body.material.tipo, renomeado.body.material.oculosComGrau], [200, LEGADO_OCULOS, true]);

      const ocular = await como(gestor).patch(`${MATERIAIS}/${id}`, OUTRO_DE('Proteção ocular', 'Óculos de proteção'));
      assert.deepEqual([ocular.status, ocular.body.material.tipo, ocular.body.material.oculosComGrau, ocular.body.material.modeloClassificacao], [200, OUTROS, true, 'V2']);
      assert.deepEqual(await noBanco(id), { tipo: OUTROS, tipo_descricao: 'Óculos de proteção', categoria: 'EPI', oculos_com_grau: true });

      await recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: LEGADO_OCULOS, oculosComGrau: true }), ['body.tipoMaterialId', 'TIPO_OBRIGATORIO']);
    });

    test('óculos legado reclassificado para outra proteção perde o grau', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: LEGADO_OCULOS, oculosComGrau: false });
      const r = await como(gestor).patch(`${MATERIAIS}/${id}`, OUTRO_DE('Proteção das mãos', 'Luva'));
      assert.deepEqual([r.status, r.body.material.tipoDescricao, r.body.material.oculosComGrau], [200, 'Luva', null]);
    });
  });

  describe('isolamento e permissão', () => {
    test('só visualizar não cadastra (403); outra empresa não vê nem edita (404)', async () => {
      assert.equal((await criar(OUTRO_DE('Proteção das mãos', 'Luva'), soVer)).status, 403);
      const material = await criado(OUTRO_DE('Proteção das mãos', 'Perneira'));
      assert.equal((await como(gestorB).get(`${MATERIAIS}/${material.id}`)).status, 404);
      assert.equal((await como(gestorB).patch(`${MATERIAIS}/${material.id}`, { tipoDescricao: 'Outra' })).status, 404);
      assert.equal((await noBanco(material.id)).tipo_descricao, 'Perneira');
    });
  });
});
