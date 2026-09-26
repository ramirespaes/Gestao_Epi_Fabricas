'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarDashboardController } = require('../../src/controllers/dashboard.controller');
const { criarDashboardRoutes } = require('../../src/routes/dashboard.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');

/**
 * Indicadores do dashboard (Bloco 9, Etapa C, Parte C6) de ponta a ponta,
 * PostgreSQL real em schema temporário. GET /api/dashboard/indicadores:
 *   - a rota exige dashboard.visualizar;
 *   - cada indicador só traz número se o usuário vê a FONTE:
 *       itensDisponiveis e estoqueAbaixoMinimo -> availableItems (mesmos dados de Itens Disponíveis, C3)
 *       caVencido (com aVencer em 60 dias)     -> materials (validade do CA é atributo do material)
 *       funcionariosAtivos                     -> employeeHistory
 *     sem a permissão da fonte: { permitido: false }, sem valor;
 *   - regras reutilizadas: materiais ativos, tamanhos cadastrados, disponível = saldo (C3);
 *     abaixo do mínimo = saldo zerado ou menor que o mínimo (C2); CA vencido/a vencer (C3, 60 dias);
 *   - isolamento: só a empresa da sessão.
 */

const MIGRATIONS = [
  '000', '001', '002', '003', '004', '005', '025', '006', '007', '008', '009', '010', '011',
  '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '039', '040',
];

const SENHA = 'senha-correta-do-teste-bloco9-c6-2026';
let HASH_SENHA;
const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';

async function inserirUsuario(pool, empresaId, email, perfil) {
  await pool.query(
    'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, true)',
    [empresaId, `Usuário ${email}`, email, HASH_SENHA, perfil],
  );
}

async function conceder(pool, empresaId, perfil, recursos) {
  for (const recurso of recursos) {
    await pool.query(
      `INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
       VALUES ($1, $2, $3, true, false, false, false)`,
      [empresaId, perfil, recurso],
    );
  }
}

async function material(pool, empresaId, { nome, minimo = 0, ca = null, ativo = true, tamanhos = {} }) {
  const { rows } = await pool.query(
    `INSERT INTO materiais (empresa_id, nome, estoque_minimo, ca_validade, ativo)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE CURRENT_DATE + $4::int END, $5) RETURNING id`,
    [empresaId, nome, minimo, ca, ativo],
  );
  for (const [tamanho, quantidade] of Object.entries(tamanhos)) {
    await pool.query('INSERT INTO estoque_tamanhos (material_id, tamanho, quantidade) VALUES ($1, $2, $3)', [rows[0].id, tamanho, quantidade]);
  }
}

async function funcionario(pool, empresaId, matricula, cpf, ativo) {
  await pool.query(
    'INSERT INTO funcionarios (empresa_id, matricula, nome, cpf, ativo) VALUES ($1, $2, $3, $4, $5)',
    [empresaId, matricula, `Funcionário ${matricula}`, cpf, ativo],
  );
}

function extrairCookie(resposta) {
  const cookies = resposta.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 1);
  return cookies[0].split(';')[0];
}

describe('GET /api/dashboard/indicadores com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  const cookie = {};
  const indicadores = (c) => request(app).get('/api/dashboard/indicadores').set('Cookie', c);

  before(async () => {
    HASH_SENHA = await gerarHashSenha(SENHA);
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;
    assert.equal(await inserirEmpresa(pool, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, CNPJ_B, 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id, cnpj FROM empresas ORDER BY id');
    const empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
    const empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;

    // Empresa A — valores esperados: disponível 10+3+0+7 = 20; abaixo do mínimo 2
    // (41: 3 < 5; 42: zerado); CA vencido 1; a vencer em 60 dias 2 (+30 e +60; +61 não; nulo não;
    // inativo não entra em nada); funcionários ativos 2.
    await material(pool, empresaA, { nome: 'Botina', minimo: 5, ca: -1, tamanhos: { 40: 10, 41: 3, 42: 0 } });
    await material(pool, empresaA, { nome: 'Luva', minimo: 0, ca: 30, tamanhos: { U: 7 } });
    await material(pool, empresaA, { nome: 'Capacete', minimo: 2, ca: 60 });
    await material(pool, empresaA, { nome: 'Óculos', ca: 61 });
    await material(pool, empresaA, { nome: 'Protetor sem CA' });
    await material(pool, empresaA, { nome: 'Inativo', minimo: 50, ca: -10, ativo: false, tamanhos: { U: 100 } });
    await funcionario(pool, empresaA, 'A1', '52998224725', true);
    await funcionario(pool, empresaA, 'A2', '11144477735', true);
    await funcionario(pool, empresaA, 'A3', '39053344705', false);
    // Empresa B — nada disso pode aparecer em A.
    await material(pool, empresaB, { nome: 'Máscara B', minimo: 1000, ca: -5, tamanhos: { U: 500 } });
    await funcionario(pool, empresaB, 'B1', '52998224725', true);

    await inserirUsuario(pool, empresaA, 'master-a.c6@demo.safeworkengenharia.com.br', 'MASTER');
    await inserirUsuario(pool, empresaA, 'so-dashboard-a.c6@demo.safeworkengenharia.com.br', 'SUPERVISOR');
    await inserirUsuario(pool, empresaA, 'parcial-a.c6@demo.safeworkengenharia.com.br', 'ADMINISTRADOR');
    await inserirUsuario(pool, empresaA, 'sem-dashboard-a.c6@demo.safeworkengenharia.com.br', 'USUARIO');
    await inserirUsuario(pool, empresaB, 'master-b.c6@demo.safeworkengenharia.com.br', 'MASTER');
    await conceder(pool, empresaA, 'MASTER', ['dashboard', 'availableItems', 'materials', 'employeeHistory']);
    await conceder(pool, empresaB, 'MASTER', ['dashboard', 'availableItems', 'materials', 'employeeHistory']);
    await conceder(pool, empresaA, 'SUPERVISOR', ['dashboard']);
    await conceder(pool, empresaA, 'ADMINISTRADOR', ['dashboard', 'availableItems']);
    await conceder(pool, empresaA, 'USUARIO', ['availableItems', 'materials', 'employeeHistory']);

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao });
    const dashboardRoutes = criarDashboardRoutes({ controller: criarDashboardController({ pool }), exigirSessao, pool });
    app = criarAppTeste((a) => { a.use('/api', authRoutes, dashboardRoutes); });

    const login = async (cnpj, email) => {
      const r = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA });
      assert.equal(r.status, 200, 'login na preparação do cenário');
      return extrairCookie(r);
    };
    cookie.masterA = await login(CNPJ_A, 'master-a.c6@demo.safeworkengenharia.com.br');
    cookie.soDashboardA = await login(CNPJ_A, 'so-dashboard-a.c6@demo.safeworkengenharia.com.br');
    cookie.parcialA = await login(CNPJ_A, 'parcial-a.c6@demo.safeworkengenharia.com.br');
    cookie.semDashboardA = await login(CNPJ_A, 'sem-dashboard-a.c6@demo.safeworkengenharia.com.br');
    cookie.masterB = await login(CNPJ_B, 'master-b.c6@demo.safeworkengenharia.com.br');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('sem sessão: 401', async () => {
    assert.equal((await request(app).get('/api/dashboard/indicadores')).status, 401);
  });

  test('sem dashboard.visualizar: 403, mesmo vendo todas as fontes', async () => {
    const r = await indicadores(cookie.semDashboardA);
    assert.equal(r.status, 403);
    assert.equal(r.body.indicadores, undefined);
  });

  test('com todas as fontes: os quatro indicadores reais da empresa da sessão', async () => {
    const r = await indicadores(cookie.masterA);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.indicadores, {
      itensDisponiveis: { permitido: true, valor: 20 },
      estoqueAbaixoMinimo: { permitido: true, valor: 2 },
      caVencido: { permitido: true, valor: 1, aVencer: 2, diasAlerta: 60 },
      funcionariosAtivos: { permitido: true, valor: 2 },
    });
  });

  test('só dashboard: nenhum número volta ao frontend (sem permissão em cada fonte)', async () => {
    const r = await indicadores(cookie.soDashboardA);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.indicadores, {
      itensDisponiveis: { permitido: false },
      estoqueAbaixoMinimo: { permitido: false },
      caVencido: { permitido: false },
      funcionariosAtivos: { permitido: false },
    });
  });

  test('permissão parcial: com availableItems vê só os indicadores de estoque; CA (materials) e funcionários sem número', async () => {
    const r = await indicadores(cookie.parcialA);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.indicadores, {
      itensDisponiveis: { permitido: true, valor: 20 },
      estoqueAbaixoMinimo: { permitido: true, valor: 2 },
      caVencido: { permitido: false },
      funcionariosAtivos: { permitido: false },
    });
  });

  test('multiempresa: a empresa B vê só os próprios números', async () => {
    const r = await indicadores(cookie.masterB);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.indicadores, {
      itensDisponiveis: { permitido: true, valor: 500 },
      estoqueAbaixoMinimo: { permitido: true, valor: 1 },
      caVencido: { permitido: true, valor: 1, aVencer: 0, diasAlerta: 60 },
      funcionariosAtivos: { permitido: true, valor: 1 },
    });
  });

  test('somente leitura: parâmetros de consulta não são aceitos (400)', async () => {
    const r = await request(app).get('/api/dashboard/indicadores?empresaId=2').set('Cookie', cookie.masterA);
    assert.equal(r.status, 400);
  });
});
