'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * E10 — o caminho antigo de estoque (estoque_tamanhos) não existe mais na
 * API. Nenhuma tela o usava, e mantê-lo deixava alterar saldo fora de
 * estoque_lotes/estoque_operacoes, sem lote, sem CA e sem histórico. A
 * tabela antiga continua no banco (histórico da migration 043), intocada.
 */

// Todas: desde a 12G-6 a entrada lê a fila da solicitação (065) e grava o aviso de disponibilidade (069).
const TODAS_AS_MIGRATIONS = todasAsMigrations();
const SENHA = 'senha-forte-do-legado-e10-2026';
const EMAIL = 'master.legado.e10@exemplo-cliente.com.br';
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;
const SRC = path.join(__dirname, '..', '..', 'src');

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

function arquivosJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const caminho = path.join(dir, e.name);
    if (e.isDirectory()) return arquivosJs(caminho);
    return e.name.endsWith('.js') ? [caminho] : [];
  });
}

describe('E10 — caminho legado de estoque removido (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let empresa;
  let material;
  let cookie;

  const q = (sql, params) => pool.query(sql, params);
  const legado = async () => (await q('SELECT tamanho, quantidade FROM estoque_tamanhos WHERE material_id = $1 ORDER BY tamanho', [material])).rows;
  const contagens = async () => (await q(
    `SELECT (SELECT count(*) FROM estoque_operacoes WHERE empresa_id = $1)::int AS operacoes,
            (SELECT count(*) FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'ESTOQUE_MOVIMENTADO')::int AS auditoria_legada`,
    [empresa],
  )).rows[0];

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    empresa = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Empresa Legado E10', '11222333000181') RETURNING id")).rows[0].id;
    await provisionamento.provisionar(pool, { empresaId: empresa, dryRun: false });
    const identidade = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [EMAIL, await gerarHashSenha(SENHA)])).rows[0].id;
    await q("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Master', NULL, NULL, 'MASTER', $2)", [empresa, identidade]);
    material = (await q("INSERT INTO materiais (empresa_id, nome, exige_tamanho, prazo_uso_dias) VALUES ($1, 'Botina', true, 180) RETURNING id", [empresa])).rows[0].id;
    // Saldo antigo, como a migration 043 encontrou: fica só como histórico.
    await q("INSERT INTO estoque_tamanhos (material_id, tamanho, quantidade) VALUES ($1, '40', 7)", [material]);

    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: criarLimitador({ limite: 100000, janelaSegundos: 60 }), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarEstoqueRoutes({ controller: criarEstoqueController({ pool }), exigirSessao: criarExigirSessao({ pool }), pool }),
      );
    });
    const login = await request(app).post('/api/auth/global/login').send({ email: EMAIL, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    cookie = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('POST /materiais/:id/estoque/movimentar não existe: 404, e nada muda no estoque antigo, nos lotes ou na auditoria', async () => {
    const antes = { legado: await legado(), ...(await contagens()) };
    for (const tipo of ['ENTRADA', 'SAIDA']) {
      const r = await request(app).post(`/api/materiais/${material}/estoque/movimentar`).set('Cookie', cookie).send({ tamanho: '40', tipo, quantidade: 2 });
      assert.equal(r.status, 404, `${tipo}: ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual({ legado: await legado(), ...(await contagens()) }, antes);
    assert.deepEqual(antes.legado, [{ tamanho: '40', quantidade: 7 }]);
  });

  test('GET /materiais/:id/estoque (saldo antigo por tamanho) não existe: 404, sem saldo nenhum na resposta', async () => {
    const r = await request(app).get(`/api/materiais/${material}/estoque`).set('Cookie', cookie);
    assert.equal(r.status, 404);
    assert.equal('saldos' in r.body, false);
  });

  test('o caminho novo continua: entrada por lote grava lote e operação, e não toca o estoque antigo', async () => {
    const r = await request(app).post(`/api/materiais/${material}/estoque/entradas`).set('Cookie', cookie)
      .send({ tamanho: '40', quantidade: 3, caNumero: 'CA-1', caValidade: '2030-12-31', chaveIdempotencia: crypto.randomUUID() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await contagens()).operacoes, 1);
    assert.deepEqual(await legado(), [{ tamanho: '40', quantidade: 7 }]);
    assert.equal((await request(app).get(`/api/materiais/${material}/estoque/lotes`).set('Cookie', cookie)).status, 200);
  });

  test('nenhum código da API lê ou grava estoque_tamanhos', () => {
    assert.equal(fs.existsSync(path.join(SRC, 'repositories', 'estoque-tamanho.repository.js')), false);
    for (const arquivo of arquivosJs(SRC)) {
      const codigo = fs.readFileSync(arquivo, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.equal(/estoque-tamanho\.repository|estoque_tamanhos/.test(codigo), false, path.relative(SRC, arquivo));
    }
  });
});
