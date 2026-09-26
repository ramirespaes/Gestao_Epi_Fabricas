'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarGrupoHomogeneoExposicaoController } = require('../../src/controllers/grupo-homogeneo-exposicao.controller');
const { criarGrupoHomogeneoExposicaoRoutes } = require('../../src/routes/grupo-homogeneo-exposicao.routes');
const { criarGheMaterialController } = require('../../src/controllers/ghe-material.controller');
const { criarGheMaterialRoutes } = require('../../src/routes/ghe-material.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');

/**
 * Matriz GHE × EPI (Bloco 9, Etapa C, Parte C5) de ponta a ponta:
 * HTTP -> autenticação real -> rotas reais -> controller -> serviço ->
 * PostgreSQL real em schema temporário (migrations até a 041).
 *
 * RBAC: recurso `employeeGroups` — visualizar consulta a matriz; editar
 * inclui/remove vínculos. Nenhum recurso novo. Isolamento: GHE e material
 * sempre da empresa da sessão; o banco repete a garantia (FKs compostas).
 */

const MIGRATIONS = [
  '000', '001', '002', '003', '004', '005', '025', '006', '007', '008', '009', '010', '011',
  '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '039', '041',
];

const SENHA = 'senha-correta-do-teste-bloco9-c5-2026';
let HASH_SENHA;
const RECURSO = 'employeeGroups';
const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';
const EMAIL = {
  masterA: 'master-a.c5@demo.safeworkengenharia.com.br',
  leitorA: 'leitor-a.c5@demo.safeworkengenharia.com.br',
  semPermissaoA: 'sem-permissao-a.c5@demo.safeworkengenharia.com.br',
  masterB: 'master-b.c5@demo.safeworkengenharia.com.br',
};

async function inserirUsuario(pool, empresaId, email, perfil) {
  await pool.query(
    'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, true)',
    [empresaId, `Usuário ${email}`, email, HASH_SENHA, perfil],
  );
}

async function conceder(pool, empresaId, perfil, { visualizar, criar, editar }) {
  await pool.query(
    `INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
     VALUES ($1, $2, $3, $4, $5, $6, false)`,
    [empresaId, perfil, RECURSO, visualizar, criar, editar],
  );
}

async function inserirMaterial(pool, empresaId, nome, ativo = true) {
  const { rows } = await pool.query(
    "INSERT INTO materiais (empresa_id, nome, tipo, categoria, ca_numero, prazo_uso_dias, ativo) VALUES ($1, $2, 'Luva', 'EPI', '12345', 90, $3) RETURNING id",
    [empresaId, nome, ativo],
  );
  return rows[0].id;
}

function extrairCookie(resposta) {
  const cookies = resposta.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 1);
  return cookies[0].split(';')[0];
}

describe('API da matriz GHE × EPI com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let empresaB;
  const cookie = {};
  let gheA;
  let gheB;
  let luva;
  let oculos;
  let inativo;
  let materialB;

  const contarVinculos = async (empresaId) => (await pool.query('SELECT count(*)::int AS n FROM ghe_materiais WHERE empresa_id = $1', [empresaId])).rows[0].n;
  const contarAuditoria = async (acao) => (await pool.query('SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2', [empresaA, acao])).rows[0].n;
  const matriz = (gheId, c = cookie.masterA) => request(app).get(`/api/grupos-homogeneos/${gheId}/materiais`).set('Cookie', c);
  const vincular = (gheId, corpo, c = cookie.masterA) => request(app).post(`/api/grupos-homogeneos/${gheId}/materiais`).set('Cookie', c).send(corpo);
  const desvincular = (gheId, materialId, c = cookie.masterA) => request(app).delete(`/api/grupos-homogeneos/${gheId}/materiais/${materialId}`).set('Cookie', c);

  before(async () => {
    HASH_SENHA = await gerarHashSenha(SENHA);
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;

    assert.equal(await inserirEmpresa(pool, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, CNPJ_B, 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
    empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;

    await inserirUsuario(pool, empresaA, EMAIL.masterA, 'MASTER');
    await inserirUsuario(pool, empresaA, EMAIL.leitorA, 'SUPERVISOR');
    await inserirUsuario(pool, empresaA, EMAIL.semPermissaoA, 'USUARIO');
    await inserirUsuario(pool, empresaB, EMAIL.masterB, 'MASTER');
    await conceder(pool, empresaA, 'MASTER', { visualizar: true, criar: true, editar: true });
    await conceder(pool, empresaB, 'MASTER', { visualizar: true, criar: true, editar: true });
    await conceder(pool, empresaA, 'SUPERVISOR', { visualizar: true, criar: false, editar: false });

    gheA = (await pool.query("INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome) VALUES ($1, 'Soldadores') RETURNING id", [empresaA])).rows[0].id;
    gheB = (await pool.query("INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome) VALUES ($1, 'Pintores') RETURNING id", [empresaB])).rows[0].id;
    luva = await inserirMaterial(pool, empresaA, 'Luva de raspa');
    oculos = await inserirMaterial(pool, empresaA, 'Óculos de proteção');
    inativo = await inserirMaterial(pool, empresaA, 'Avental antigo', false);
    materialB = await inserirMaterial(pool, empresaB, 'Máscara da empresa B');

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao });
    const gheRoutes = criarGrupoHomogeneoExposicaoRoutes({ controller: criarGrupoHomogeneoExposicaoController({ pool }), exigirSessao, pool });
    const matrizRoutes = criarGheMaterialRoutes({ controller: criarGheMaterialController({ pool }), exigirSessao, pool });
    app = criarAppTeste((a) => { a.use('/api', authRoutes, gheRoutes, matrizRoutes); });

    const login = async (cnpj, email) => {
      const r = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA });
      assert.equal(r.status, 200, 'login na preparação do cenário');
      return extrairCookie(r);
    };
    cookie.masterA = await login(CNPJ_A, EMAIL.masterA);
    cookie.leitorA = await login(CNPJ_A, EMAIL.leitorA);
    cookie.semPermissaoA = await login(CNPJ_A, EMAIL.semPermissaoA);
    cookie.masterB = await login(CNPJ_B, EMAIL.masterB);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('RBAC (employeeGroups)', () => {
    test('sem sessão: 401', async () => {
      assert.equal((await request(app).get(`/api/grupos-homogeneos/${gheA}/materiais`)).status, 401);
    });

    test('sem permissão: 403 em consultar, incluir e remover', async () => {
      assert.equal((await matriz(gheA, cookie.semPermissaoA)).status, 403);
      assert.equal((await vincular(gheA, { materialId: luva }, cookie.semPermissaoA)).status, 403);
      assert.equal((await desvincular(gheA, luva, cookie.semPermissaoA)).status, 403);
    });

    test('só visualizar: consulta (200), mas não inclui nem remove (403)', async () => {
      assert.equal((await matriz(gheA, cookie.leitorA)).status, 200);
      assert.equal((await vincular(gheA, { materialId: luva }, cookie.leitorA)).status, 403);
      assert.equal((await desvincular(gheA, luva, cookie.leitorA)).status, 403);
      assert.equal(await contarVinculos(empresaA), 0);
    });
  });

  describe('consultar, incluir, duplicidade, remover', () => {
    test('matriz inicial: GHE e EPIs ATIVOS da empresa, nenhum vinculado; inativo não vinculado e material de B não aparecem', async () => {
      const r = await matriz(gheA);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.grupo, { id: gheA, nome: 'Soldadores', ativo: true });
      assert.deepEqual(r.body.materiais.map((m) => [m.id, m.vinculado]), [[luva, false], [oculos, false]]);
      assert.deepEqual(Object.keys(r.body.materiais[0]).sort(), ['ativo', 'caNumero', 'categoria', 'codigoInterno', 'id', 'nome', 'prazoUsoDias', 'tipo', 'unidade', 'vinculado']);
      assert.equal(r.body.materiais[0].prazoUsoDias, 90);
    });

    test('incluir vínculo: 201, auditado, e a consulta passa a mostrá-lo vinculado', async () => {
      const r = await vincular(gheA, { materialId: luva });
      assert.equal(r.status, 201);
      assert.deepEqual([r.body.vinculo.grupoHomogeneoId, r.body.vinculo.materialId], [gheA, luva]);
      assert.equal(await contarAuditoria('GHE_MATERIAL_VINCULADO'), 1);
      const m = await matriz(gheA);
      assert.deepEqual(m.body.materiais.map((x) => [x.id, x.vinculado]), [[luva, true], [oculos, false]]);
    });

    test('duplicidade: 409 GHE_MATERIAL_JA_VINCULADO, sem segunda linha nem segunda auditoria', async () => {
      const r = await vincular(gheA, { materialId: luva });
      assert.equal(r.status, 409);
      assert.equal(r.body.codigo, 'GHE_MATERIAL_JA_VINCULADO');
      assert.equal(await contarVinculos(empresaA), 1);
      assert.equal(await contarAuditoria('GHE_MATERIAL_VINCULADO'), 1);
    });

    test('remover vínculo: 200, auditado, e a consulta volta a mostrá-lo desvinculado; remover de novo: 404', async () => {
      const r = await desvincular(gheA, luva);
      assert.equal(r.status, 200);
      assert.equal(r.body.removido, true);
      assert.equal(await contarAuditoria('GHE_MATERIAL_DESVINCULADO'), 1);
      assert.deepEqual((await matriz(gheA)).body.materiais.map((x) => [x.id, x.vinculado]), [[luva, false], [oculos, false]]);
      const denovo = await desvincular(gheA, luva);
      assert.equal(denovo.status, 404);
      assert.equal(denovo.body.codigo, 'GHE_MATERIAL_NAO_VINCULADO');
    });
  });

  describe('inexistentes, inválidos e inativos', () => {
    test('GHE inexistente: 404 GHE_NAO_ENCONTRADO em consultar, incluir e remover', async () => {
      for (const r of [await matriz(999999), await vincular(999999, { materialId: luva }), await desvincular(999999, luva)]) {
        assert.equal(r.status, 404);
        assert.equal(r.body.codigo, 'GHE_NAO_ENCONTRADO');
      }
    });

    test('material inexistente: 404 MATERIAL_NAO_ENCONTRADO', async () => {
      const r = await vincular(gheA, { materialId: 999999 });
      assert.equal(r.status, 404);
      assert.equal(r.body.codigo, 'MATERIAL_NAO_ENCONTRADO');
    });

    test('identificadores inválidos e campos extras: 400, nada gravado', async () => {
      assert.equal((await request(app).get('/api/grupos-homogeneos/abc/materiais').set('Cookie', cookie.masterA)).status, 400);
      assert.equal((await vincular(gheA, { materialId: '1' })).status, 400);
      assert.equal((await vincular(gheA, { materialId: 0 })).status, 400);
      assert.equal((await vincular(gheA, {})).status, 400);
      assert.equal((await vincular(gheA, { materialId: luva, empresaId: empresaB })).status, 400);
      assert.equal((await desvincular(gheA, 'x')).status, 400);
      assert.equal(await contarVinculos(empresaA), 0);
    });

    test('material inativo não pode ser vinculado: 409 MATERIAL_INATIVO', async () => {
      const r = await vincular(gheA, { materialId: inativo });
      assert.equal(r.status, 409);
      assert.equal(r.body.codigo, 'MATERIAL_INATIVO');
      assert.equal(await contarVinculos(empresaA), 0);
    });

    test('GHE inativo não aceita novo vínculo (409 GHE_INATIVO); vínculo existente continua na consulta e pode ser removido mesmo com GHE e material inativos', async () => {
      assert.equal((await vincular(gheA, { materialId: oculos })).status, 201);
      assert.equal((await request(app).post(`/api/grupos-homogeneos/${gheA}/inativar`).set('Cookie', cookie.masterA).send({})).status, 200);
      await pool.query('UPDATE materiais SET ativo = false WHERE id = $1', [oculos]);

      const novo = await vincular(gheA, { materialId: luva });
      assert.equal(novo.status, 409);
      assert.equal(novo.body.codigo, 'GHE_INATIVO');

      const m = await matriz(gheA);
      assert.equal(m.status, 200);
      assert.equal(m.body.grupo.ativo, false);
      const vinculado = m.body.materiais.find((x) => x.id === oculos);
      assert.deepEqual([vinculado.vinculado, vinculado.ativo], [true, false], 'material inativo vinculado continua visível');

      const r = await desvincular(gheA, oculos);
      assert.equal(r.status, 200);
      assert.equal(await contarVinculos(empresaA), 0);
    });
  });

  describe('multiempresa', () => {
    test('empresa B não consulta, não inclui e não remove no GHE da empresa A (404), e nada muda em A', async () => {
      await pool.query('UPDATE grupos_homogeneos_exposicao SET ativo = true WHERE id = $1', [gheA]);
      assert.equal((await vincular(gheA, { materialId: luva })).status, 201);
      for (const r of [await matriz(gheA, cookie.masterB), await vincular(gheA, { materialId: materialB }, cookie.masterB), await desvincular(gheA, luva, cookie.masterB)]) {
        assert.equal(r.status, 404);
        assert.equal(r.body.codigo, 'GHE_NAO_ENCONTRADO');
      }
      assert.equal(await contarVinculos(empresaA), 1);
    });

    test('empresa A não vincula material da empresa B: 404 MATERIAL_NAO_ENCONTRADO', async () => {
      const r = await vincular(gheA, { materialId: materialB });
      assert.equal(r.status, 404);
      assert.equal(r.body.codigo, 'MATERIAL_NAO_ENCONTRADO');
      assert.equal(await contarVinculos(empresaA), 1);
      assert.equal(await contarVinculos(empresaB), 0);
    });

    test('listagem de B mostra só os materiais de B; nenhum material de A vaza', async () => {
      const r = await matriz(gheB, cookie.masterB);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.materiais.map((m) => m.id), [materialB]);
    });
  });
});
