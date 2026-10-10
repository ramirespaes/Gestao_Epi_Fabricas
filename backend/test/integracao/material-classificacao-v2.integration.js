'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./helpers/solicitacao-epi-servico');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { dependeDaMigration } = require('./helpers/classificacao-v2');
const { criarAppTeste } = require('../helpers/app-teste');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');

/**
 * RED — classificação V2 do material pelas rotas reais (PostgreSQL real, schema temporário com as migrations existentes;
 * a 082 ainda não existe). Contrato aprovado:
 *   Grupo (categoria): EPI | Vestimenta | Outros (novos cadastros).
 *   EPI/Vestimenta → Grupo de Proteção (12 do catálogo | Outros) → Tipo (tipoMaterialId do catálogo | Outros).
 *   Outros em qualquer nível → "Especifique…" obrigatório (categoriaDescricao, grupoProtecaoDescricao, tipoDescricao).
 *   Campo que não se aplica NUNCA é aceito (nada escondido chega ao banco).
 *   LEGADO (modeloClassificacao) edita campos não relacionados sem conversão; alterar a classificação exige o bloco completo.
 *   V2 + EPI + Proteção ocular ⇒ oculosComGrau obrigatório (Sim/Não), pelo grupo de proteção e não pelo nome.
 * Os testes falham hoje pela ausência da funcionalidade/migration, nunca por erro de preparo.
 */

const MATERIAIS = '/api/materiais';
const BASE = { prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade' };

describe('classificação V2 do material — cadastro e edição (RED)', () => {
  let ctx;
  let d;
  let app;
  let gestor;
  let gestorB;
  let seq = 0;

  const como = (usuarioId) => ({
    get: (url) => request(app).get(url).set(CABECALHO, String(usuarioId)),
    post: (url, corpo = {}) => request(app).post(url).set(CABECALHO, String(usuarioId)).send(corpo),
    patch: (url, corpo = {}) => request(app).patch(url).set(CABECALHO, String(usuarioId)).send(corpo),
  });
  async function usuarioCom(empresaId) {
    seq += 1;
    const id = await inserirUsuario(ctx.pool, empresaId, `v2-${seq}@example.invalid`, 'USUARIO');
    const mestre = empresaId === d.empresaA ? d.master : d.masterB;
    await ctx.pool.query(
      `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
       VALUES ($1, $2, 'materials', true, true, true, false, $3)`,
      [empresaId, id, mestre],
    );
    return id;
  }
  const nome = (p) => `${p} ${crypto.randomUUID().slice(0, 8)}`;
  const criar = (corpo, usuario = gestor) => como(usuario).post(MATERIAIS, { nome: nome('Material V2'), ...BASE, ...corpo });
  const criado = async (corpo) => {
    const r = await criar(corpo);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.material;
  };
  const detalhes = (r) => (r.body.detalhes || []).map((x) => [x.campo, x.codigo]);
  const recusa = (r, campo, codigo) => {
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(detalhes(r).some(([c, k]) => c === campo && k === codigo), `esperado ${campo}/${codigo}; veio ${JSON.stringify(detalhes(r))}`);
  };
  // Linha do catálogo da empresa (SQL direto: a tabela é da migration 082).
  const tipo = async (empresaId, grupo, protecao, nomeDoTipo, { ativo = true } = {}) => dependeDaMigration((async () => (await ctx.pool.query(
    'INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome, ativo) VALUES ($1, $2, $3, $4, $5) RETURNING id', [empresaId, grupo, protecao, `${nomeDoTipo} ${crypto.randomUUID().slice(0, 6)}`, ativo],
  )).rows[0].id)(), 'tabela tipos_material');
  const tipoNome = async (id) => (await ctx.pool.query('SELECT nome FROM tipos_material WHERE id = $1', [id])).rows[0].nome;
  const noBanco = async (id) => dependeDaMigration((async () => (await ctx.pool.query(
    `SELECT categoria, categoria_descricao, grupo_protecao, grupo_protecao_descricao, tipo_material_id, tipo, tipo_descricao, oculos_com_grau, modelo_classificacao
       FROM materiais WHERE id = $1`, [id],
  )).rows[0])(), 'colunas da classificação V2');
  const legado = async (empresaId, { categoria = 'EPI', tipo: t = 'Capacete', oculosComGrau = null } = {}) => (await ctx.pool.query(
    `INSERT INTO materiais (empresa_id, nome, categoria, tipo, prazo_uso_dias, exige_tamanho, oculos_com_grau) VALUES ($1, $2, $3, $4, 180, false, $5) RETURNING id`,
    [empresaId, nome('Legado'), categoria, t, oculosComGrau],
  )).rows[0].id;
  // 'Outros' sem descrição só existe em dado anterior à 071: simula-o reproduzindo a restrição NOT VALID da 071 depois da linha.
  async function legadoOutrosSemDescricao(empresaId) {
    const inserir = async () => (await ctx.pool.query(
      `INSERT INTO materiais (empresa_id, nome, categoria, tipo, tipo_descricao, prazo_uso_dias, exige_tamanho) VALUES ($1, $2, 'EPI', 'Outros', NULL, 180, false) RETURNING id`, [empresaId, nome('Legado Outros')],
    )).rows[0].id;
    try { return await inserir(); } catch (erro) {
      if (erro.code !== '23514') throw erro;
      await ctx.pool.query('ALTER TABLE materiais DROP CONSTRAINT chk_materiais_tipo_descricao_so_outros');
      const id = await inserir();
      await ctx.pool.query("ALTER TABLE materiais ADD CONSTRAINT chk_materiais_tipo_descricao_so_outros CHECK ((tipo IS NOT DISTINCT FROM 'Outros') = (tipo_descricao IS NOT NULL)) NOT VALID");
      return id;
    }
  }

  before(async () => {
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarMundoDoServico(ctx.pool);
    for (const empresaId of [d.empresaA, d.empresaB]) await provisionamento.provisionar(ctx.pool, { empresaId, dryRun: false });
    const exigirSessao = sessaoDeTeste(ctx.pool);
    const { pool } = ctx;
    app = criarAppTeste((a) => { a.use('/api', criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool })); });
    gestor = await usuarioCom(d.empresaA);
    gestorB = await usuarioCom(d.empresaB);
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  describe('cadastro novo (V2)', () => {
    test('EPI normal: Grupo → Proteção → Tipo do catálogo; o servidor copia o nome do tipo e marca V2', async () => {
      const t = await tipo(d.empresaA, 'EPI', 'Proteção auditiva', 'Protetor Teste');
      const m = await criado({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: t });
      assert.equal(m.modeloClassificacao, 'V2');
      assert.deepEqual([m.categoria, m.grupoProtecao, m.tipoMaterialId, m.tipo], ['EPI', 'Proteção auditiva', t, await tipoNome(t)]);
      assert.deepEqual([m.categoriaDescricao, m.grupoProtecaoDescricao, m.tipoDescricao], [null, null, null]);
      const b = await noBanco(m.id);
      assert.deepEqual([b.modelo_classificacao, b.tipo_material_id, b.grupo_protecao], ['V2', t, 'Proteção auditiva']);
    });

    test('Vestimenta normal', async () => {
      const t = await tipo(d.empresaA, 'Vestimenta', 'Proteção do tronco', 'Avental Teste');
      const m = await criado({ categoria: 'Vestimenta', grupoProtecao: 'Proteção do tronco', tipoMaterialId: t });
      assert.deepEqual([m.modeloClassificacao, m.categoria, m.grupoProtecao, m.tipoMaterialId], ['V2', 'Vestimenta', 'Proteção do tronco', t]);
    });

    test('Grupo = Outros: especifique o grupo e o tipo; sem proteção, sem catálogo; nada vira catálogo global', async () => {
      const antes = await dependeDaMigration(ctx.pool.query('SELECT count(*)::int n FROM tipos_material'), 'tabela tipos_material');
      const m = await criado({ categoria: 'Outros', categoriaDescricao: 'Ferramenta', tipo: 'Outros', tipoDescricao: 'Chave isolada 1000 V' });
      assert.deepEqual([m.modeloClassificacao, m.categoria, m.categoriaDescricao, m.grupoProtecao, m.tipoMaterialId, m.tipo, m.tipoDescricao],
        ['V2', 'Outros', 'Ferramenta', null, null, 'Outros', 'Chave isolada 1000 V']);
      const depois = await ctx.pool.query('SELECT count(*)::int n FROM tipos_material');
      assert.equal(depois.rows[0].n, antes.rows[0].n, 'o texto digitado não cria catálogo');
    });

    test('EPI + Proteção Outros + Tipo Outros: as duas especificações obrigatórias', async () => {
      const m = await criado({ categoria: 'EPI', grupoProtecao: 'Outros', grupoProtecaoDescricao: 'Proteção contra arco elétrico', tipo: 'Outros', tipoDescricao: 'Balaclava para arco elétrico' });
      assert.deepEqual([m.grupoProtecao, m.grupoProtecaoDescricao, m.tipoMaterialId, m.tipo, m.tipoDescricao], ['Outros', 'Proteção contra arco elétrico', null, 'Outros', 'Balaclava para arco elétrico']);
    });

    test('Vestimenta + Proteção Outros + Tipo Outros', async () => {
      const m = await criado({ categoria: 'Vestimenta', grupoProtecao: 'Outros', grupoProtecaoDescricao: 'Proteção contra respingos químicos', tipo: 'Outros', tipoDescricao: 'Avental impermeável PVC' });
      assert.deepEqual([m.categoria, m.grupoProtecao, m.tipoDescricao], ['Vestimenta', 'Outros', 'Avental impermeável PVC']);
    });

    test('EPI + Proteção conhecida + Tipo Outros: só a especificação do tipo, sem descrição de proteção', async () => {
      const m = await criado({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: 'Outros', tipoDescricao: 'Protetor auricular eletrônico' });
      assert.deepEqual([m.grupoProtecao, m.grupoProtecaoDescricao, m.tipoMaterialId, m.tipo, m.tipoDescricao], ['Proteção auditiva', null, null, 'Outros', 'Protetor auricular eletrônico']);
    });
  });

  describe('classificação obrigatória e completa', () => {
    test('Grupo é obrigatório; grupos antigos não valem para cadastro novo', async () => {
      recusa(await criar({ tipo: 'Outros', tipoDescricao: 'x' }), 'body.categoria', 'GRUPO_OBRIGATORIO');
      for (const g of ['Ferramenta', 'Material de consumo', 'Uniforme', 'Calçado']) {
        // eslint-disable-next-line no-await-in-loop
        recusa(await criar({ categoria: g, tipo: 'Outros', tipoDescricao: 'x' }), 'body.categoria', 'GRUPO_INVALIDO');
      }
    });

    test('EPI/Vestimenta sem proteção, com proteção inexistente, ou sem tipo são recusados', async () => {
      recusa(await criar({ categoria: 'EPI', tipo: 'Outros', tipoDescricao: 'x' }), 'body.grupoProtecao', 'GRUPO_PROTECAO_OBRIGATORIO');
      recusa(await criar({ categoria: 'Vestimenta', grupoProtecao: 'Proteção inexistente', tipo: 'Outros', tipoDescricao: 'x' }), 'body.grupoProtecao', 'GRUPO_PROTECAO_INVALIDO');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva' }), 'body.tipoMaterialId', 'TIPO_OBRIGATORIO');
    });

    test('cada "Outros" exige a sua especificação: vazio e só espaços recusados', async () => {
      for (const v of [undefined, '', '   ', '\t\n']) {
        // eslint-disable-next-line no-await-in-loop
        recusa(await criar({ categoria: 'Outros', ...(v === undefined ? {} : { categoriaDescricao: v }), tipo: 'Outros', tipoDescricao: 'x' }), 'body.categoriaDescricao', 'CATEGORIA_DESCRICAO_OBRIGATORIA');
        // eslint-disable-next-line no-await-in-loop
        recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Outros', ...(v === undefined ? {} : { grupoProtecaoDescricao: v }), tipo: 'Outros', tipoDescricao: 'x' }), 'body.grupoProtecaoDescricao', 'GRUPO_PROTECAO_DESCRICAO_OBRIGATORIA');
        // eslint-disable-next-line no-await-in-loop
        recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: 'Outros', ...(v === undefined ? {} : { tipoDescricao: v }) }), 'body.tipoDescricao', 'TIPO_DESCRICAO_OBRIGATORIA');
      }
    });

    test('especificação com caractere de controle ou acima do limite é recusada nos três níveis', async () => {
      recusa(await criar({ categoria: 'Outros', categoriaDescricao: 'x'.repeat(101), tipo: 'Outros', tipoDescricao: 'x' }), 'body.categoriaDescricao', 'CATEGORIA_DESCRICAO_INVALIDA');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Outros', grupoProtecaoDescricao: 'a\u0007b', tipo: 'Outros', tipoDescricao: 'x' }), 'body.grupoProtecaoDescricao', 'GRUPO_PROTECAO_DESCRICAO_INVALIDA');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: 'Outros', tipoDescricao: 'x'.repeat(101) }), 'body.tipoDescricao', 'TIPO_DESCRICAO_INVALIDA');
    });
  });

  describe('nada escondido é aceito (campo que não se aplica)', () => {
    test('Grupo Outros: proteção, descrição de proteção e tipo do catálogo são recusados', async () => {
      const base = { categoria: 'Outros', categoriaDescricao: 'Ferramenta', tipo: 'Outros', tipoDescricao: 'x' };
      recusa(await criar({ ...base, grupoProtecao: 'Proteção ocular' }), 'body.grupoProtecao', 'GRUPO_PROTECAO_NAO_SE_APLICA');
      recusa(await criar({ ...base, grupoProtecaoDescricao: 'x' }), 'body.grupoProtecaoDescricao', 'GRUPO_PROTECAO_DESCRICAO_NAO_SE_APLICA');
      const t = await tipo(d.empresaA, 'EPI', 'Proteção facial', 'Facial Teste');
      recusa(await criar({ ...base, tipoMaterialId: t }), 'body.tipoMaterialId', 'TIPO_MATERIAL_NAO_SE_APLICA');
    });

    test('descrição sem o respectivo "Outros" é recusada: categoria, proteção e tipo', async () => {
      recusa(await criar({ categoria: 'EPI', categoriaDescricao: 'x', grupoProtecao: 'Proteção auditiva', tipo: 'Outros', tipoDescricao: 'x' }), 'body.categoriaDescricao', 'CATEGORIA_DESCRICAO_NAO_SE_APLICA');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', grupoProtecaoDescricao: 'x', tipo: 'Outros', tipoDescricao: 'x' }), 'body.grupoProtecaoDescricao', 'GRUPO_PROTECAO_DESCRICAO_NAO_SE_APLICA');
      const t = await tipo(d.empresaA, 'EPI', 'Proteção auditiva', 'Plug Teste');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: t, tipoDescricao: 'x' }), 'body.tipoDescricao', 'TIPO_DESCRICAO_NAO_SE_APLICA');
    });

    test('Proteção Outros não aceita tipo do catálogo; tipo do catálogo não aceita tipo textual divergente; o modelo não vem do cliente', async () => {
      const t = await tipo(d.empresaA, 'EPI', 'Proteção auditiva', 'Concha Teste');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Outros', grupoProtecaoDescricao: 'x', tipoMaterialId: t }), 'body.tipoMaterialId', 'TIPO_MATERIAL_NAO_SE_APLICA');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: t, tipo: 'Outro Nome' }), 'body.tipo', 'TIPO_NAO_SE_APLICA');
      const r = await criar({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: t, modeloClassificacao: 'LEGADO' });
      assert.equal(r.status, 400, 'modeloClassificacao é derivado pelo servidor');
    });
  });

  describe('catálogo: compatibilidade, estado e empresa', () => {
    test('tipo de outra proteção ou de outro grupo é incompatível', async () => {
      const ocular = await tipo(d.empresaA, 'EPI', 'Proteção ocular', 'Visor Teste');
      const tronco = await tipo(d.empresaA, 'Vestimenta', 'Proteção do tronco', 'Colete Teste');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: ocular }), 'body.tipoMaterialId', 'TIPO_MATERIAL_INCOMPATIVEL');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção do tronco', tipoMaterialId: tronco }), 'body.tipoMaterialId', 'TIPO_MATERIAL_INCOMPATIVEL');
    });

    test('tipo inativo não vale para novo cadastro', async () => {
      const inativo = await tipo(d.empresaA, 'EPI', 'Proteção facial', 'Inativo Teste', { ativo: false });
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção facial', tipoMaterialId: inativo }), 'body.tipoMaterialId', 'TIPO_MATERIAL_INATIVO');
    });

    test('tipo de outra empresa e id inexistente têm a mesma resposta (sem enumerar)', async () => {
      const deB = await tipo(d.empresaB, 'EPI', 'Proteção facial', 'Facial B');
      const a = await criar({ categoria: 'EPI', grupoProtecao: 'Proteção facial', tipoMaterialId: deB });
      const b = await criar({ categoria: 'EPI', grupoProtecao: 'Proteção facial', tipoMaterialId: 2147483000 });
      recusa(a, 'body.tipoMaterialId', 'TIPO_MATERIAL_NAO_ENCONTRADO');
      recusa(b, 'body.tipoMaterialId', 'TIPO_MATERIAL_NAO_ENCONTRADO');
      assert.deepEqual(detalhes(a), detalhes(b));
      const proprio = await criar({ categoria: 'EPI', grupoProtecao: 'Proteção facial', tipoMaterialId: deB }, gestorB);
      assert.equal(proprio.status, 201, JSON.stringify(proprio.body));
    });
  });

  describe('Proteção ocular e óculos com grau (pelo grupo de proteção, não pelo nome)', () => {
    test('V2 + EPI + Proteção ocular exige oculosComGrau para QUALQUER tipo: do catálogo (nome livre) e "Outros"', async () => {
      const novo = await tipo(d.empresaA, 'EPI', 'Proteção ocular', 'Visor Sem Cara de Oculos');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipoMaterialId: novo }), 'body.oculosComGrau', 'OCULOS_COM_GRAU_OBRIGATORIO');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: 'Outros', tipoDescricao: 'Lupa de proteção' }), 'body.oculosComGrau', 'OCULOS_COM_GRAU_OBRIGATORIO');
      for (const grau of [true, false]) {
        // eslint-disable-next-line no-await-in-loop
        const m = await criado({ categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipoMaterialId: novo, oculosComGrau: grau });
        assert.equal(m.oculosComGrau, grau);
      }
    });

    test('fora de Proteção ocular, oculosComGrau não se aplica — mesmo que o nome pareça óculos', async () => {
      const t = await tipo(d.empresaA, 'EPI', 'Proteção facial', 'Óculos de Proteção Falso');
      recusa(await criar({ categoria: 'EPI', grupoProtecao: 'Proteção facial', tipoMaterialId: t, oculosComGrau: false }), 'body.oculosComGrau', 'OCULOS_COM_GRAU_NAO_SE_APLICA');
      recusa(await criar({ categoria: 'Vestimenta', grupoProtecao: 'Proteção do tronco', tipo: 'Outros', tipoDescricao: 'x', oculosComGrau: true }), 'body.oculosComGrau', 'OCULOS_COM_GRAU_NAO_SE_APLICA');
    });

    test('LEGADO: os nomes históricos continuam pedindo/aceitando óculos com grau; edição de óculos legado preserva o valor', async () => {
      const id = await legado(d.empresaA, { tipo: 'Óculos de proteção', oculosComGrau: true });
      const r = await como(gestor).patch(`${MATERIAIS}/${id}`, { nome: nome('Oculos legado') });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.material.oculosComGrau, true);
      assert.equal(r.body.material.modeloClassificacao, 'LEGADO');
    });
  });

  describe('legado versus novo: edição e conversão', () => {
    test('editar campo não relacionado de um LEGADO não converte nem bloqueia (EPI com tipo histórico)', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: 'Capacete' });
      const r = await como(gestor).patch(`${MATERIAIS}/${id}`, { nome: nome('Renomeado'), fabricante: 'Fab', prazoUsoDias: 365 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.material.modeloClassificacao, r.body.material.categoria, r.body.material.tipo, r.body.material.grupoProtecao], ['LEGADO', 'EPI', 'Capacete', null]);
      assert.deepEqual((await noBanco(id)).modelo_classificacao, 'LEGADO');
    });

    test('LEGADO com tipo "Outros" sem descrição (anterior à 071) aceita edição não relacionada (correção da constraint NOT VALID)', async () => {
      const id = await legadoOutrosSemDescricao(d.empresaA);
      const r = await como(gestor).patch(`${MATERIAIS}/${id}`, { nome: nome('Renomeado outros'), fabricante: 'Fab' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.material.modeloClassificacao, 'LEGADO');
      assert.equal(r.body.material.tipoDescricao, null);
    });

    test('reenviar a MESMA classificação legada não é alteração de classificação', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: 'Luva' });
      const r = await como(gestor).patch(`${MATERIAIS}/${id}`, { nome: nome('Mesmo'), categoria: 'EPI', tipo: 'Luva' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.material.modeloClassificacao, 'LEGADO');
    });

    test('alterar a classificação de um LEGADO exige o bloco completo; bloco parcial (só o grupo) é recusado', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: 'Capacete' });
      const parcial = await como(gestor).patch(`${MATERIAIS}/${id}`, { categoria: 'Vestimenta' });
      recusa(parcial, 'body.grupoProtecao', 'GRUPO_PROTECAO_OBRIGATORIO');
      assert.equal((await noBanco(id)).modelo_classificacao, 'LEGADO');
    });

    test('bloco completo converte LEGADO → V2 preservando id, nome e demais dados', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: 'Capacete' });
      const t = await tipo(d.empresaA, 'EPI', 'Proteção da cabeça', 'Capacete Conversao');
      const r = await como(gestor).patch(`${MATERIAIS}/${id}`, { categoria: 'EPI', grupoProtecao: 'Proteção da cabeça', tipoMaterialId: t });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.material.id, r.body.material.modeloClassificacao, r.body.material.tipoMaterialId, r.body.material.tipo], [id, 'V2', t, await tipoNome(t)]);
      assert.equal((await noBanco(id)).modelo_classificacao, 'V2');
    });

    test('V2: trocar "Outros" por opção normal descarta as especificações escondidas do banco', async () => {
      const m = await criado({ categoria: 'EPI', grupoProtecao: 'Outros', grupoProtecaoDescricao: 'Arco elétrico', tipo: 'Outros', tipoDescricao: 'Balaclava' });
      const t = await tipo(d.empresaA, 'EPI', 'Proteção respiratória', 'Respirador Troca');
      const r = await como(gestor).patch(`${MATERIAIS}/${m.id}`, { categoria: 'EPI', grupoProtecao: 'Proteção respiratória', tipoMaterialId: t });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const b = await noBanco(m.id);
      assert.deepEqual([b.grupo_protecao, b.grupo_protecao_descricao, b.tipo_material_id, b.tipo_descricao, b.categoria_descricao], ['Proteção respiratória', null, t, null, null]);
    });

    test('V2: trocar para Grupo Outros limpa proteção e tipo do catálogo; trocar o grupo de volta exige o bloco novamente', async () => {
      const t = await tipo(d.empresaA, 'EPI', 'Proteção facial', 'Facial Troca');
      const m = await criado({ categoria: 'EPI', grupoProtecao: 'Proteção facial', tipoMaterialId: t });
      const r = await como(gestor).patch(`${MATERIAIS}/${m.id}`, { categoria: 'Outros', categoriaDescricao: 'Ferramenta', tipo: 'Outros', tipoDescricao: 'Chave' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const b = await noBanco(m.id);
      assert.deepEqual([b.categoria, b.categoria_descricao, b.grupo_protecao, b.tipo_material_id], ['Outros', 'Ferramenta', null, null]);
      recusa(await como(gestor).patch(`${MATERIAIS}/${m.id}`, { categoria: 'EPI' }), 'body.grupoProtecao', 'GRUPO_PROTECAO_OBRIGATORIO');
    });

    test('V2 nunca volta a LEGADO; editar campo não relacionado de V2 mantém a classificação', async () => {
      const t = await tipo(d.empresaA, 'EPI', 'Proteção das mãos', 'Luva V2');
      const m = await criado({ categoria: 'EPI', grupoProtecao: 'Proteção das mãos', tipoMaterialId: t });
      const r = await como(gestor).patch(`${MATERIAIS}/${m.id}`, { nome: nome('V2 renomeado') });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.material.modeloClassificacao, r.body.material.tipoMaterialId], ['V2', t]);
      assert.equal((await como(gestor).patch(`${MATERIAIS}/${m.id}`, { modeloClassificacao: 'LEGADO' })).status, 400);
    });

    test('tipo que ficou inativo depois do cadastro não bloqueia a edição de campos não relacionados', async () => {
      const t = await tipo(d.empresaA, 'EPI', 'Proteção facial', 'Facial Inativar');
      const m = await criado({ categoria: 'EPI', grupoProtecao: 'Proteção facial', tipoMaterialId: t });
      await ctx.pool.query('UPDATE tipos_material SET ativo = false WHERE id = $1', [t]);
      const r = await como(gestor).patch(`${MATERIAIS}/${m.id}`, { fabricante: 'Fab nova' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.material.tipoMaterialId, t);
    });
  });

  describe('resposta e listagem', () => {
    test('GET devolve os campos novos e o modelo; LEGADO devolve grupoProtecao nulo', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: 'Luva' });
      const r = await como(gestor).get(`${MATERIAIS}/${id}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      for (const campo of ['modeloClassificacao', 'categoriaDescricao', 'grupoProtecao', 'grupoProtecaoDescricao', 'tipoMaterialId']) {
        assert.ok(Object.hasOwn(r.body.material, campo), `campo ${campo} ausente na resposta`);
      }
      assert.equal(r.body.material.modeloClassificacao, 'LEGADO');
    });

    test('isolamento: edição de classificação de material de outra empresa continua 404', async () => {
      const id = await legado(d.empresaA, { categoria: 'EPI', tipo: 'Luva' });
      const t = await tipo(d.empresaB, 'EPI', 'Proteção das mãos', 'Luva B');
      const r = await como(gestorB).patch(`${MATERIAIS}/${id}`, { categoria: 'EPI', grupoProtecao: 'Proteção das mãos', tipoMaterialId: t });
      assert.equal(r.status, 404, JSON.stringify(r.body));
    });
  });
});
