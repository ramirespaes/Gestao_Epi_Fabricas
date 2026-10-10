'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations, criarMaterial } = require('./helpers/entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./helpers/solicitacao-epi-servico');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarGrupoHomogeneoExposicaoController } = require('../../src/controllers/grupo-homogeneo-exposicao.controller');
const { criarGrupoHomogeneoExposicaoRoutes } = require('../../src/routes/grupo-homogeneo-exposicao.routes');
const { criarGheMaterialController } = require('../../src/controllers/ghe-material.controller');
const { criarGheMaterialRoutes } = require('../../src/routes/ghe-material.routes');

/**
 * Incremento 3 (RED): vínculo GHE × TIPO de material (`ghe_tipos_material`, migration 083), sob
 * /api/grupos-homogeneos/:id/tipos-material, no desenho de GHE × material (ghe-material.*):
 *
 *   GET    /api/grupos-homogeneos/:id/tipos-material              200 { grupo:{id,nome,ativo}, tipos:[...] }
 *   PUT    /api/grupos-homogeneos/:id/tipos-material/:tipoId      body { classificacao }
 *                                                                201 criou | 200 trocou a classificação ou já estava igual
 *   DELETE /api/grupos-homogeneos/:id/tipos-material/:tipoId      200 { removido: true }
 *
 * Cada item de `tipos`: { id, nome, grupo, grupoProtecao, ativo, vinculado, classificacao (OBRIGATORIO | NAO_OBRIGATORIO | null) }.
 * Aparecem os tipos ATIVOS da empresa e os INATIVOS que já estão vinculados ao GHE.
 * Resposta do PUT: { vinculo:{grupoHomogeneoId,tipoMaterialId,classificacao}, criado, alterado }.
 *
 * RBAC: recurso `employeeGroups` (GET = visualizar; PUT e DELETE = editar), como o vínculo GHE × material.
 * Erros reutilizados: 404 GHE_NAO_ENCONTRADO, 409 GHE_INATIVO, 404 TIPO_MATERIAL_NAO_ENCONTRADO. Novos: 409 TIPO_MATERIAL_INATIVO
 * e 404 GHE_TIPO_MATERIAL_NAO_VINCULADO (DELETE). Classificação inválida: 400 VALIDACAO em body.classificacao (schema).
 * GHE ou tipo de outra empresa = o mesmo 404 do inexistente.
 * Auditoria (referencia = id do GHE, na transação da escrita): GHE_TIPO_MATERIAL_VINCULADO (dados_novos),
 * GHE_TIPO_MATERIAL_ALTERADO (dados_anteriores/dados_novos com a classificação, só quando muda de fato) e
 * GHE_TIPO_MATERIAL_DESVINCULADO (dados_anteriores). Mesma classificação = nenhuma escrita e nenhuma auditoria.
 * ghe_materiais segue como está; previsto_no_ghe (Incremento 4) não é tocado aqui.
 *
 * Os módulos novos (rotas e controller) ainda não existem no RED: o teste os carrega se existirem e, sem eles, a rota
 * simplesmente não é montada (404). Isso é falha por funcionalidade ausente, não erro de harness.
 */

const RAIZ = '/api/grupos-homogeneos';
const OBRIGATORIO = 'OBRIGATORIO';
const NAO_OBRIGATORIO = 'NAO_OBRIGATORIO';
const ACAO = Object.freeze({
  VINCULADO: 'GHE_TIPO_MATERIAL_VINCULADO',
  ALTERADO: 'GHE_TIPO_MATERIAL_ALTERADO',
  DESVINCULADO: 'GHE_TIPO_MATERIAL_DESVINCULADO',
});
const CHAVES_DO_TIPO = ['ativo', 'classificacao', 'grupo', 'grupoProtecao', 'id', 'nome', 'vinculado'];

function carregarModulosDeTipos() {
  try {
    return {
      rotas: require('../../src/routes/ghe-tipo-material.routes'),
      controller: require('../../src/controllers/ghe-tipo-material.controller'),
    };
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && /ghe-tipo-material/.test(erro.message)) return null;
    throw erro;
  }
}

const unico = (prefixo) => `${prefixo} ${crypto.randomUUID().slice(0, 8)}`;

describe('GHE × tipo de material — API e regras (RED)', () => {
  let ctx;
  let d;
  let app;
  let gestor;
  let gestorB;
  let soVer;
  let semEditar;
  let semNada;
  let seq = 0;

  const como = (id) => ({
    get: (url) => request(app).get(url).set(CABECALHO, String(id)),
    post: (url, corpo = {}) => request(app).post(url).set(CABECALHO, String(id)).send(corpo),
    put: (url, corpo) => request(app).put(url).set(CABECALHO, String(id)).send(corpo),
    del: (url) => request(app).delete(url).set(CABECALHO, String(id)),
  });
  async function usuarioCom(empresaId, operacoes) {
    seq += 1;
    const id = await inserirUsuario(ctx.pool, empresaId, `ghe-tipos-${seq}@example.invalid`, 'USUARIO');
    const mestre = empresaId === d.empresaA ? d.master : d.masterB;
    await ctx.pool.query(
      `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
       VALUES ($1, $2, 'employeeGroups', $3, $4, $5, false, $6)`,
      [empresaId, id, operacoes.includes('visualizar'), operacoes.includes('criar'), operacoes.includes('editar'), mestre],
    );
    return id;
  }

  const q = (sql, params) => ctx.pool.query(sql, params);
  const url = (gheId, tipoId) => (tipoId === undefined ? `${RAIZ}/${gheId}/tipos-material` : `${RAIZ}/${gheId}/tipos-material/${tipoId}`);
  async function semearGhe(empresaId, { ativo = true } = {}) {
    return (await q('INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome, ativo) VALUES ($1, $2, $3) RETURNING *', [empresaId, unico('GHE tipos'), ativo])).rows[0];
  }
  async function semearTipo(empresaId, { ativo = true, grupo = 'EPI', grupoProtecao = 'Proteção da cabeça' } = {}) {
    return (await q(
      'INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome, ativo, origem) VALUES ($1, $2, $3, $4, $5, \'MANUAL\') RETURNING *',
      [empresaId, grupo, grupoProtecao, unico('Tipo'), ativo],
    )).rows[0];
  }
  async function ligar(empresaId, gheId, tipoId, classificacao) {
    return (await q(
      'INSERT INTO ghe_tipos_material (empresa_id, grupo_homogeneo_id, tipo_material_id, classificacao) VALUES ($1, $2, $3, $4) RETURNING *',
      [empresaId, gheId, tipoId, classificacao],
    )).rows[0];
  }
  const vinculos = async (gheId, tipoId) => (await q(
    'SELECT * FROM ghe_tipos_material WHERE grupo_homogeneo_id = $1 AND ($2::int IS NULL OR tipo_material_id = $2) ORDER BY id', [gheId, tipoId ?? null],
  )).rows;
  const auditorias = async (empresaId, gheId, acao = null) => (await q(
    `SELECT acao, dados_anteriores, dados_novos FROM logs_auditoria
      WHERE empresa_id = $1 AND referencia = $2 AND acao LIKE 'GHE_TIPO_MATERIAL_%' AND ($3::text IS NULL OR acao = $3) ORDER BY id`,
    [empresaId, String(gheId), acao],
  )).rows;
  const contar = async (tabela) => (await q(`SELECT count(*)::int AS n FROM ${tabela}`)).rows[0].n;

  /** Cadeia da auditoria: um VINCULADO, depois ALTERADOs encadeados (anterior = novo do passo anterior), terminando no valor final. */
  async function conferirCadeia(gheId, tipoId, finalEsperado) {
    const eventos = await auditorias(d.empresaA, gheId);
    assert.equal(eventos[0].acao, ACAO.VINCULADO, 'o primeiro evento é a criação do vínculo');
    assert.equal(eventos.filter((e) => e.acao === ACAO.VINCULADO).length, 1);
    let atual = eventos[0].dados_novos.classificacao;
    for (const e of eventos.slice(1)) {
      assert.equal(e.acao, ACAO.ALTERADO);
      assert.equal(e.dados_anteriores.classificacao, atual, 'encadeamento da auditoria');
      assert.notEqual(e.dados_novos.classificacao, atual, 'alteração auditada só quando muda de fato');
      atual = e.dados_novos.classificacao;
    }
    assert.equal(atual, finalEsperado, 'a auditoria termina no valor persistido');
    assert.equal((await vinculos(gheId, tipoId)).length, 1);
  }

  before(async () => {
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarMundoDoServico(ctx.pool);
    const exigirSessao = sessaoDeTeste(ctx.pool);
    const { pool } = ctx;
    const tipos = carregarModulosDeTipos();
    app = criarAppTeste((a) => {
      a.use('/api', criarGrupoHomogeneoExposicaoRoutes({ controller: criarGrupoHomogeneoExposicaoController({ pool }), exigirSessao, pool }));
      a.use('/api', criarGheMaterialRoutes({ controller: criarGheMaterialController({ pool }), exigirSessao, pool }));
      if (tipos) {
        a.use('/api', tipos.rotas.criarGheTipoMaterialRoutes({ controller: tipos.controller.criarGheTipoMaterialController({ pool }), exigirSessao, pool }));
      }
    });
    gestor = await usuarioCom(d.empresaA, ['visualizar', 'criar', 'editar']);
    gestorB = await usuarioCom(d.empresaB, ['visualizar', 'criar', 'editar']);
    soVer = await usuarioCom(d.empresaA, ['visualizar']);
    semEditar = await usuarioCom(d.empresaA, ['visualizar', 'criar']);
    semNada = await usuarioCom(d.empresaA, []);
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  describe('módulos e montagem', () => {
    test('as rotas e o controller existem e a aplicação monta as rotas de GHE × tipo', () => {
      assert.ok(carregarModulosDeTipos(), 'src/routes/ghe-tipo-material.routes.js e src/controllers/ghe-tipo-material.controller.js');
      const app_ = fs.readFileSync(path.join(__dirname, '../../src/app.js'), 'utf8');
      assert.match(app_, /ghe-tipo-material\.routes/);
      assert.match(app_, /gheTipoMaterialRoutes/);
    });
  });

  describe('leitura: a matriz de tipos do GHE', () => {
    test('traz tipos ativos (vinculados ou não) e inativos já vinculados; nunca inativo solto nem tipo de outra empresa', async () => {
      const ghe = await semearGhe(d.empresaA);
      const ativoLivre = await semearTipo(d.empresaA);
      const ativoObrigatorio = await semearTipo(d.empresaA, { grupo: 'Vestimenta', grupoProtecao: 'Proteção do tronco' });
      const ativoOpcional = await semearTipo(d.empresaA);
      const inativoVinculado = await semearTipo(d.empresaA, { ativo: false });
      const inativoSolto = await semearTipo(d.empresaA, { ativo: false });
      const deOutraEmpresa = await semearTipo(d.empresaB);
      await ligar(d.empresaA, ghe.id, ativoObrigatorio.id, OBRIGATORIO);
      await ligar(d.empresaA, ghe.id, ativoOpcional.id, NAO_OBRIGATORIO);
      await ligar(d.empresaA, ghe.id, inativoVinculado.id, OBRIGATORIO);

      const r = await como(gestor).get(url(ghe.id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.grupo, { id: ghe.id, nome: ghe.nome, ativo: true });
      const por = new Map(r.body.tipos.map((t) => [t.id, t]));
      for (const t of r.body.tipos) assert.deepEqual(Object.keys(t).sort(), CHAVES_DO_TIPO);
      assert.deepEqual(por.get(ativoLivre.id), {
        id: ativoLivre.id, nome: ativoLivre.nome, grupo: 'EPI', grupoProtecao: 'Proteção da cabeça', ativo: true, vinculado: false, classificacao: null,
      });
      assert.deepEqual(por.get(ativoObrigatorio.id), {
        id: ativoObrigatorio.id, nome: ativoObrigatorio.nome, grupo: 'Vestimenta', grupoProtecao: 'Proteção do tronco', ativo: true, vinculado: true, classificacao: OBRIGATORIO,
      });
      assert.equal(por.get(ativoOpcional.id).classificacao, NAO_OBRIGATORIO);
      assert.deepEqual([por.get(inativoVinculado.id).ativo, por.get(inativoVinculado.id).vinculado, por.get(inativoVinculado.id).classificacao], [false, true, OBRIGATORIO]);
      assert.equal(por.has(inativoSolto.id), false, 'inativo não vinculado não é opção nova');
      assert.equal(por.has(deOutraEmpresa.id), false, 'tipo de outra empresa nunca aparece');
    });

    test('GHE inativo continua consultável, com a situação dele', async () => {
      const ghe = await semearGhe(d.empresaA, { ativo: false });
      const tipo = await semearTipo(d.empresaA);
      await ligar(d.empresaA, ghe.id, tipo.id, OBRIGATORIO);
      const r = await como(gestor).get(url(ghe.id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.grupo.ativo, false);
      assert.equal(r.body.tipos.find((t) => t.id === tipo.id).classificacao, OBRIGATORIO);
    });

    test('GHE inexistente ou de outra empresa: o mesmo 404 GHE_NAO_ENCONTRADO', async () => {
      const deB = await semearGhe(d.empresaB);
      const inexistente = await como(gestor).get(url(999999999));
      const alheio = await como(gestor).get(url(deB.id));
      assert.equal(inexistente.status, 404, JSON.stringify(inexistente.body));
      assert.equal(inexistente.body.codigo, 'GHE_NAO_ENCONTRADO');
      assert.equal(alheio.status, 404);
      assert.deepEqual(alheio.body, inexistente.body);
    });

    test('permissão de visualizar: quem só vê lê; sem permissão é 403; sem sessão é 401', async () => {
      const ghe = await semearGhe(d.empresaA);
      assert.equal((await como(soVer).get(url(ghe.id))).status, 200);
      assert.equal((await como(semNada).get(url(ghe.id))).status, 403);
      assert.equal((await request(app).get(url(ghe.id))).status, 401);
    });
  });

  describe('criar o vínculo (PUT)', () => {
    test('cria nas duas classificações: 201, persiste com a empresa, audita GHE_TIPO_MATERIAL_VINCULADO', async () => {
      const ghe = await semearGhe(d.empresaA);
      for (const classificacao of [OBRIGATORIO, NAO_OBRIGATORIO]) {
        const tipo = await semearTipo(d.empresaA);
        const r = await como(gestor).put(url(ghe.id, tipo.id), { classificacao });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.deepEqual(r.body.vinculo, { grupoHomogeneoId: ghe.id, tipoMaterialId: tipo.id, classificacao });
        assert.equal(r.body.criado, true);
        assert.equal(r.body.alterado, true);
        const linhas = await vinculos(ghe.id, tipo.id);
        assert.equal(linhas.length, 1);
        assert.deepEqual([linhas[0].empresa_id, linhas[0].classificacao], [d.empresaA, classificacao]);
        const eventos = (await auditorias(d.empresaA, ghe.id, ACAO.VINCULADO)).filter((e) => e.dados_novos.tipoMaterialId === tipo.id);
        assert.equal(eventos.length, 1);
        assert.deepEqual(eventos[0].dados_novos, { grupoHomogeneoId: ghe.id, tipoMaterialId: tipo.id, classificacao });
        assert.equal(eventos[0].dados_anteriores, null);
      }
    });

    test('classificação inválida ou ausente, e campo extra: 400 VALIDACAO; nada é gravado nem auditado', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      for (const corpo of [
        { classificacao: 'obrigatorio' }, { classificacao: 'OPCIONAL' }, { classificacao: '' }, { classificacao: null },
        { classificacao: 1 }, { classificacao: [OBRIGATORIO] }, {},
      ]) {
        const r = await como(gestor).put(url(ghe.id, tipo.id), corpo);
        assert.equal(r.status, 400, `${JSON.stringify(corpo)} → ${JSON.stringify(r.body)}`);
        assert.equal(r.body.codigo, 'VALIDACAO');
        assert.ok(r.body.detalhes.some((x) => x.campo === 'body.classificacao'), JSON.stringify(corpo));
      }
      for (const extra of ['empresaId', 'grupoHomogeneoId', 'tipoMaterialId', 'ativo']) {
        const r = await como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO, [extra]: 1 });
        assert.equal(r.status, 400, extra);
        assert.ok(r.body.detalhes.some((x) => x.campo === `body.${extra}` && x.codigo === 'CAMPO_NAO_PERMITIDO'), extra);
      }
      assert.equal((await vinculos(ghe.id)).length, 0);
      assert.equal((await auditorias(d.empresaA, ghe.id)).length, 0);
    });

    test('identificadores inválidos no caminho: 400 VALIDACAO', async () => {
      const ghe = await semearGhe(d.empresaA);
      for (const caminho of [url('abc', 1), url(ghe.id, 'abc'), url(ghe.id, 0), url(0, 1)]) {
        const r = await como(gestor).put(caminho, { classificacao: OBRIGATORIO });
        assert.equal(r.status, 400, caminho);
        assert.equal(r.body.codigo, 'VALIDACAO');
      }
    });

    test('GHE inexistente ou de outra empresa: o mesmo 404 GHE_NAO_ENCONTRADO', async () => {
      const deB = await semearGhe(d.empresaB);
      const tipo = await semearTipo(d.empresaA);
      const inexistente = await como(gestor).put(url(999999999, tipo.id), { classificacao: OBRIGATORIO });
      const alheio = await como(gestor).put(url(deB.id, tipo.id), { classificacao: OBRIGATORIO });
      assert.equal(inexistente.status, 404, JSON.stringify(inexistente.body));
      assert.equal(inexistente.body.codigo, 'GHE_NAO_ENCONTRADO');
      assert.equal(alheio.status, 404);
      assert.deepEqual(alheio.body, inexistente.body);
      assert.equal((await vinculos(deB.id)).length, 0);
    });

    test('tipo inexistente ou de outra empresa: o mesmo 404 TIPO_MATERIAL_NAO_ENCONTRADO', async () => {
      const ghe = await semearGhe(d.empresaA);
      const deB = await semearTipo(d.empresaB);
      const inexistente = await como(gestor).put(url(ghe.id, 999999999), { classificacao: OBRIGATORIO });
      const alheio = await como(gestor).put(url(ghe.id, deB.id), { classificacao: OBRIGATORIO });
      assert.equal(inexistente.status, 404, JSON.stringify(inexistente.body));
      assert.equal(inexistente.body.codigo, 'TIPO_MATERIAL_NAO_ENCONTRADO');
      assert.equal(alheio.status, 404);
      assert.deepEqual(alheio.body, inexistente.body);
      assert.equal((await vinculos(ghe.id)).length, 0, 'nenhum vínculo entre empresas');
      assert.equal((await auditorias(d.empresaA, ghe.id)).length, 0);
    });

    test('GHE inativo não aceita novo vínculo: 409 GHE_INATIVO', async () => {
      const ghe = await semearGhe(d.empresaA, { ativo: false });
      const tipo = await semearTipo(d.empresaA);
      const r = await como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.codigo, 'GHE_INATIVO');
      assert.equal((await vinculos(ghe.id)).length, 0);
      assert.equal((await auditorias(d.empresaA, ghe.id)).length, 0);
    });

    test('tipo inativo não aceita novo vínculo: 409 TIPO_MATERIAL_INATIVO', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA, { ativo: false });
      const r = await como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.codigo, 'TIPO_MATERIAL_INATIVO');
      assert.equal((await vinculos(ghe.id)).length, 0);
      assert.equal((await auditorias(d.empresaA, ghe.id)).length, 0);
    });
  });

  describe('vínculo que já existe', () => {
    test('trocar a classificação mantém o MESMO registro e audita GHE_TIPO_MATERIAL_ALTERADO com anterior e novo', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      const original = await ligar(d.empresaA, ghe.id, tipo.id, OBRIGATORIO);
      const r = await como(gestor).put(url(ghe.id, tipo.id), { classificacao: NAO_OBRIGATORIO });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.criado, r.body.alterado, r.body.vinculo.classificacao], [false, true, NAO_OBRIGATORIO]);
      const linhas = await vinculos(ghe.id, tipo.id);
      assert.equal(linhas.length, 1, 'nenhuma segunda linha');
      assert.deepEqual([linhas[0].id, linhas[0].classificacao], [original.id, NAO_OBRIGATORIO]);
      assert.equal(linhas[0].criado_em.getTime(), original.criado_em.getTime());
      const eventos = await auditorias(d.empresaA, ghe.id);
      assert.deepEqual(eventos.map((e) => e.acao), [ACAO.ALTERADO]);
      assert.equal(eventos[0].dados_anteriores.classificacao, OBRIGATORIO);
      assert.equal(eventos[0].dados_novos.classificacao, NAO_OBRIGATORIO);
    });

    test('mesma classificação: 200 idempotente, sem escrita (atualizado_em igual) e sem auditoria', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      const original = await ligar(d.empresaA, ghe.id, tipo.id, OBRIGATORIO);
      for (let i = 0; i < 2; i += 1) {
        const r = await como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual([r.body.criado, r.body.alterado, r.body.vinculo.classificacao], [false, false, OBRIGATORIO]);
      }
      const linhas = await vinculos(ghe.id, tipo.id);
      assert.equal(linhas.length, 1);
      assert.equal(linhas[0].atualizado_em.getTime(), original.atualizado_em.getTime());
      assert.equal((await auditorias(d.empresaA, ghe.id)).length, 0);
    });

    test('ida e volta entre as classificações continua uma linha só, com a trilha completa', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      assert.equal((await como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO })).status, 201);
      assert.equal((await como(gestor).put(url(ghe.id, tipo.id), { classificacao: NAO_OBRIGATORIO })).status, 200);
      assert.equal((await como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO })).status, 200);
      await conferirCadeia(ghe.id, tipo.id, OBRIGATORIO);
      assert.deepEqual((await auditorias(d.empresaA, ghe.id)).map((e) => e.acao), [ACAO.VINCULADO, ACAO.ALTERADO, ACAO.ALTERADO]);
    });
  });

  describe('tipo inativo que já estava vinculado', () => {
    test('continua vinculado e visível (sem apagar nem mudar a classificação), pode ser removido e não volta como vínculo novo', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      await ligar(d.empresaA, ghe.id, tipo.id, NAO_OBRIGATORIO);
      await q('UPDATE tipos_material SET ativo = false WHERE id = $1', [tipo.id]);

      assert.deepEqual((await vinculos(ghe.id, tipo.id)).map((v) => v.classificacao), [NAO_OBRIGATORIO]);
      const matriz = await como(gestor).get(url(ghe.id));
      assert.equal(matriz.status, 200, JSON.stringify(matriz.body));
      const item = matriz.body.tipos.find((t) => t.id === tipo.id);
      assert.deepEqual([item.ativo, item.vinculado, item.classificacao], [false, true, NAO_OBRIGATORIO]);

      const remocao = await como(gestor).del(url(ghe.id, tipo.id));
      assert.equal(remocao.status, 200, JSON.stringify(remocao.body));
      assert.equal((await vinculos(ghe.id, tipo.id)).length, 0);

      const novo = await como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO });
      assert.equal(novo.status, 409, JSON.stringify(novo.body));
      assert.equal(novo.body.codigo, 'TIPO_MATERIAL_INATIVO');
      assert.equal((await vinculos(ghe.id, tipo.id)).length, 0);
    });
  });

  describe('GHE inativo', () => {
    test('inativar o GHE preserva os vínculos; novo vínculo é 409 GHE_INATIVO; remover o existente continua permitido', async () => {
      const ghe = await semearGhe(d.empresaA);
      const existente = await semearTipo(d.empresaA);
      const novo = await semearTipo(d.empresaA);
      await ligar(d.empresaA, ghe.id, existente.id, OBRIGATORIO);

      const inativar = await como(gestor).post(`${RAIZ}/${ghe.id}/inativar`);
      assert.equal(inativar.status, 200, JSON.stringify(inativar.body));
      assert.deepEqual((await vinculos(ghe.id)).map((v) => v.tipo_material_id), [existente.id], 'os vínculos permanecem armazenados');

      const bloqueado = await como(gestor).put(url(ghe.id, novo.id), { classificacao: OBRIGATORIO });
      assert.equal(bloqueado.status, 409, JSON.stringify(bloqueado.body));
      assert.equal(bloqueado.body.codigo, 'GHE_INATIVO');

      const remocao = await como(gestor).del(url(ghe.id, existente.id));
      assert.equal(remocao.status, 200, JSON.stringify(remocao.body));
      assert.equal((await vinculos(ghe.id)).length, 0);
    });
  });

  describe('vínculo existente com GHE ou tipo inativos (decisão do GREEN)', () => {
    test('a classificação pode ser corrigida (200 ALTERADO); a mesma classificação é no-op; vale com GHE inativo, tipo inativo ou ambos', async () => {
      for (const [gheAtivo, tipoAtivo] of [[false, true], [true, false], [false, false]]) {
        const ghe = await semearGhe(d.empresaA, { ativo: gheAtivo });
        const tipo = await semearTipo(d.empresaA, { ativo: tipoAtivo });
        const original = await ligar(d.empresaA, ghe.id, tipo.id, OBRIGATORIO);
        const rotulo = `ghe ativo=${gheAtivo}, tipo ativo=${tipoAtivo}`;

        const igual = await como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO });
        assert.equal(igual.status, 200, `${rotulo}: ${JSON.stringify(igual.body)}`);
        assert.deepEqual([igual.body.criado, igual.body.alterado], [false, false], rotulo);
        assert.equal((await vinculos(ghe.id, tipo.id))[0].atualizado_em.getTime(), original.atualizado_em.getTime(), rotulo);
        assert.equal((await auditorias(d.empresaA, ghe.id)).length, 0, rotulo);

        const troca = await como(gestor).put(url(ghe.id, tipo.id), { classificacao: NAO_OBRIGATORIO });
        assert.equal(troca.status, 200, `${rotulo}: ${JSON.stringify(troca.body)}`);
        assert.deepEqual([troca.body.criado, troca.body.alterado, troca.body.vinculo.classificacao], [false, true, NAO_OBRIGATORIO], rotulo);
        const linhas = await vinculos(ghe.id, tipo.id);
        assert.deepEqual([linhas.length, linhas[0].id, linhas[0].classificacao], [1, original.id, NAO_OBRIGATORIO], rotulo);
        const eventos = await auditorias(d.empresaA, ghe.id);
        assert.deepEqual(eventos.map((e) => e.acao), [ACAO.ALTERADO], rotulo);
        assert.equal(eventos[0].dados_anteriores.classificacao, OBRIGATORIO);
        assert.equal(eventos[0].dados_novos.classificacao, NAO_OBRIGATORIO);

        const remocao = await como(gestor).del(url(ghe.id, tipo.id));
        assert.equal(remocao.status, 200, `${rotulo}: ${JSON.stringify(remocao.body)}`);
        assert.equal((await vinculos(ghe.id, tipo.id)).length, 0, rotulo);
      }
    });
  });

  describe('remover o vínculo (DELETE)', () => {
    test('remove SÓ essa relação: GHE, tipo, outros vínculos, ghe_materiais e materiais ficam; audita GHE_TIPO_MATERIAL_DESVINCULADO', async () => {
      const ghe = await semearGhe(d.empresaA);
      const outroGhe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      const tipoVizinho = await semearTipo(d.empresaA);
      const materialId = await criarMaterial(ctx.pool, d.empresaA, unico('Material'));
      await ligar(d.empresaA, ghe.id, tipo.id, OBRIGATORIO);
      await ligar(d.empresaA, ghe.id, tipoVizinho.id, NAO_OBRIGATORIO);
      await ligar(d.empresaA, outroGhe.id, tipo.id, OBRIGATORIO);
      await q('INSERT INTO ghe_materiais (empresa_id, grupo_homogeneo_id, material_id) VALUES ($1, $2, $3)', [d.empresaA, ghe.id, materialId]);
      const antes = { ghes: await contar('grupos_homogeneos_exposicao'), tipos: await contar('tipos_material'), materiais: await contar('materiais'), gm: await contar('ghe_materiais') };

      const r = await como(gestor).del(url(ghe.id, tipo.id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.removido, true);
      assert.equal((await vinculos(ghe.id, tipo.id)).length, 0);
      assert.equal((await vinculos(ghe.id, tipoVizinho.id)).length, 1, 'o outro tipo do mesmo GHE fica');
      assert.equal((await vinculos(outroGhe.id, tipo.id)).length, 1, 'o mesmo tipo em outro GHE fica');
      assert.deepEqual(
        { ghes: await contar('grupos_homogeneos_exposicao'), tipos: await contar('tipos_material'), materiais: await contar('materiais'), gm: await contar('ghe_materiais') },
        antes,
      );
      const eventos = await auditorias(d.empresaA, ghe.id, ACAO.DESVINCULADO);
      assert.equal(eventos.length, 1);
      assert.deepEqual(eventos[0].dados_anteriores, { grupoHomogeneoId: ghe.id, tipoMaterialId: tipo.id, classificacao: OBRIGATORIO });
      assert.equal(eventos[0].dados_novos, null);
    });

    test('vínculo inexistente (inclusive tipo inexistente ou de outra empresa): o mesmo 404 GHE_TIPO_MATERIAL_NAO_VINCULADO, sem auditoria', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipoLivre = await semearTipo(d.empresaA);
      const tipoDeB = await semearTipo(d.empresaB);
      const solto = await como(gestor).del(url(ghe.id, tipoLivre.id));
      const inexistente = await como(gestor).del(url(ghe.id, 999999999));
      const alheio = await como(gestor).del(url(ghe.id, tipoDeB.id));
      assert.equal(solto.status, 404, JSON.stringify(solto.body));
      assert.equal(solto.body.codigo, 'GHE_TIPO_MATERIAL_NAO_VINCULADO');
      assert.deepEqual(inexistente.body, solto.body);
      assert.deepEqual(alheio.body, solto.body);
      assert.equal((await auditorias(d.empresaA, ghe.id)).length, 0);
    });

    test('GHE inexistente ou de outra empresa: o mesmo 404 GHE_NAO_ENCONTRADO', async () => {
      const deB = await semearGhe(d.empresaB);
      const tipo = await semearTipo(d.empresaA);
      const inexistente = await como(gestor).del(url(999999999, tipo.id));
      const alheio = await como(gestor).del(url(deB.id, tipo.id));
      assert.equal(inexistente.status, 404, JSON.stringify(inexistente.body));
      assert.equal(inexistente.body.codigo, 'GHE_NAO_ENCONTRADO');
      assert.deepEqual(alheio.body, inexistente.body);
    });
  });

  describe('permissão de editar', () => {
    test('quem só visualiza, ou só visualiza e cria, não vincula nem remove (403); sem sessão é 401; nada muda', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      const ligado = await semearTipo(d.empresaA);
      await ligar(d.empresaA, ghe.id, ligado.id, OBRIGATORIO);
      for (const quem of [soVer, semEditar, semNada]) {
        assert.equal((await como(quem).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO })).status, 403, `PUT ${quem}`);
        assert.equal((await como(quem).put(url(ghe.id, ligado.id), { classificacao: NAO_OBRIGATORIO })).status, 403, `PUT troca ${quem}`);
        assert.equal((await como(quem).del(url(ghe.id, ligado.id))).status, 403, `DELETE ${quem}`);
      }
      assert.equal((await request(app).put(url(ghe.id, tipo.id)).send({ classificacao: OBRIGATORIO })).status, 401);
      assert.equal((await request(app).delete(url(ghe.id, ligado.id))).status, 401);
      assert.deepEqual((await vinculos(ghe.id)).map((v) => [v.tipo_material_id, v.classificacao]), [[ligado.id, OBRIGATORIO]]);
      assert.equal((await auditorias(d.empresaA, ghe.id)).length, 0);
    });
  });

  describe('isolamento entre empresas', () => {
    test('a empresa B não lê, vincula nem remove no GHE da A (404 do inexistente), e a matriz da B não traz tipos da A', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipoA = await semearTipo(d.empresaA);
      const tipoB = await semearTipo(d.empresaB);
      await ligar(d.empresaA, ghe.id, tipoA.id, OBRIGATORIO);
      const gheB = await semearGhe(d.empresaB);

      const inexistente = await como(gestorB).get(url(999999999));
      for (const resposta of [
        await como(gestorB).get(url(ghe.id)),
        await como(gestorB).put(url(ghe.id, tipoB.id), { classificacao: OBRIGATORIO }),
        await como(gestorB).del(url(ghe.id, tipoA.id)),
      ]) {
        assert.equal(resposta.status, 404);
        assert.equal(resposta.body.codigo, inexistente.body.codigo);
      }
      assert.deepEqual((await vinculos(ghe.id)).map((v) => v.tipo_material_id), [tipoA.id]);
      assert.equal((await vinculos(ghe.id))[0].classificacao, OBRIGATORIO);

      const matrizB = await como(gestorB).get(url(gheB.id));
      assert.equal(matrizB.status, 200);
      assert.equal(matrizB.body.tipos.some((t) => t.id === tipoA.id), false);
      assert.equal(matrizB.body.tipos.some((t) => t.id === tipoB.id), true);
    });
  });

  describe('convivência com ghe_materiais', () => {
    test('o vínculo direto por material segue funcionando e é independente do vínculo por tipo', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      const materialId = await criarMaterial(ctx.pool, d.empresaA, unico('Material'));

      const doTipo = await como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO });
      assert.equal(doTipo.status, 201, JSON.stringify(doTipo.body));
      assert.equal((await q('SELECT count(*)::int AS n FROM ghe_materiais WHERE grupo_homogeneo_id = $1', [ghe.id])).rows[0].n, 0, 'vincular tipo não cria vínculo de material');

      const doMaterial = await como(gestor).post(`${RAIZ}/${ghe.id}/materiais`, { materialId });
      assert.equal(doMaterial.status, 201, JSON.stringify(doMaterial.body));
      const matriz = await como(gestor).get(`${RAIZ}/${ghe.id}/materiais`);
      assert.equal(matriz.body.materiais.find((m) => m.id === materialId).vinculado, true);

      await como(gestor).del(url(ghe.id, tipo.id));
      assert.equal((await q('SELECT count(*)::int AS n FROM ghe_materiais WHERE grupo_homogeneo_id = $1', [ghe.id])).rows[0].n, 1, 'remover tipo não toca ghe_materiais');
      const desvinculo = await como(gestor).del(`${RAIZ}/${ghe.id}/materiais/${materialId}`);
      assert.equal(desvinculo.status, 200, JSON.stringify(desvinculo.body));
    });
  });

  describe('concorrência', () => {
    test('criação simultânea do mesmo vínculo: uma linha, um 201 e os demais 200, nunca 500; uma auditoria de criação', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      const respostas = await Promise.all(Array.from({ length: 6 }, () => como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO })));
      const status = respostas.map((r) => r.status).sort();
      assert.deepEqual(status, [200, 200, 200, 200, 200, 201], JSON.stringify(respostas.map((r) => r.body.codigo ?? null)));
      assert.equal((await vinculos(ghe.id, tipo.id)).length, 1);
      await conferirCadeia(ghe.id, tipo.id, OBRIGATORIO);
      assert.deepEqual((await auditorias(d.empresaA, ghe.id)).map((e) => e.acao), [ACAO.VINCULADO]);
    });

    test('criação simultânea com classificações diferentes: uma linha, todas 2xx, auditoria encadeada até o valor final', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      const pedidos = [OBRIGATORIO, NAO_OBRIGATORIO, OBRIGATORIO, NAO_OBRIGATORIO];
      const respostas = await Promise.all(pedidos.map((classificacao) => como(gestor).put(url(ghe.id, tipo.id), { classificacao })));
      for (const r of respostas) assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
      assert.equal(respostas.filter((r) => r.status === 201).length, 1);
      const linhas = await vinculos(ghe.id, tipo.id);
      assert.equal(linhas.length, 1);
      assert.ok(pedidos.includes(linhas[0].classificacao));
      await conferirCadeia(ghe.id, tipo.id, linhas[0].classificacao);
    });

    test('troca simultânea de classificação num vínculo existente: uma linha, todas 200, auditoria encadeada sem salto', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      assert.equal((await como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO })).status, 201);
      const pedidos = [NAO_OBRIGATORIO, OBRIGATORIO, NAO_OBRIGATORIO, OBRIGATORIO, NAO_OBRIGATORIO];
      const respostas = await Promise.all(pedidos.map((classificacao) => como(gestor).put(url(ghe.id, tipo.id), { classificacao })));
      for (const r of respostas) assert.equal(r.status, 200, JSON.stringify(r.body));
      const linhas = await vinculos(ghe.id, tipo.id);
      assert.equal(linhas.length, 1);
      await conferirCadeia(ghe.id, tipo.id, linhas[0].classificacao);
    });

    test('vincular enquanto o GHE é inativado: ou cria (201) ou é recusado (409 GHE_INATIVO), e a resposta bate com o banco', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      const [vinculo, inativacao] = await Promise.all([
        como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO }),
        como(gestor).post(`${RAIZ}/${ghe.id}/inativar`),
      ]);
      assert.equal(inativacao.status, 200, JSON.stringify(inativacao.body));
      assert.ok([201, 409].includes(vinculo.status), JSON.stringify(vinculo.body));
      const linhas = await vinculos(ghe.id, tipo.id);
      assert.equal(linhas.length, vinculo.status === 201 ? 1 : 0);
      if (vinculo.status === 409) assert.equal(vinculo.body.codigo, 'GHE_INATIVO');
    });

    test('vincular enquanto o tipo é inativado: ou cria (201) ou é recusado (409 TIPO_MATERIAL_INATIVO), e a resposta bate com o banco', async () => {
      const ghe = await semearGhe(d.empresaA);
      const tipo = await semearTipo(d.empresaA);
      const [vinculo] = await Promise.all([
        como(gestor).put(url(ghe.id, tipo.id), { classificacao: OBRIGATORIO }),
        q('UPDATE tipos_material SET ativo = false WHERE id = $1', [tipo.id]),
      ]);
      assert.ok([201, 409].includes(vinculo.status), JSON.stringify(vinculo.body));
      assert.equal((await vinculos(ghe.id, tipo.id)).length, vinculo.status === 201 ? 1 : 0);
      if (vinculo.status === 409) assert.equal(vinculo.body.codigo, 'TIPO_MATERIAL_INATIVO');
    });
  });
});
