'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * E10 — o cadastro de material não tem CA. O CA é do lote (entrada), e na
 * entrega será o do lote entregue. A API de materiais não aceita nem devolve
 * CA; as colunas antigas continuam no banco, intocadas, só como histórico.
 */

// O serviço de materiais lê a grade (070): o schema precisa de todas as migrations.
const TODAS_AS_MIGRATIONS = todasAsMigrations();
const SENHA = 'senha-forte-sem-ca-mestre-2026';
const EMAIL = 'master.ca.mestre.e10@exemplo-cliente.com.br';
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;
const CA_LEGADO = 'CA-LEGADO-777';

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

describe('E10 — material sem CA mestre na API (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let empresa;
  let legado;
  let cookie;

  const q = (sql, params) => pool.query(sql, params);
  const api = (metodo, rota) => request(app)[metodo](rota).set('Cookie', cookie);
  const colunasCa = async (id) => (await q("SELECT ca_numero, to_char(ca_validade, 'YYYY-MM-DD') AS ca_validade FROM materiais WHERE id = $1", [id])).rows[0];
  // Classificação V2: grupo "Outros" com especificação, que não depende do catálogo (o assunto aqui é o CA do cadastro).
  const valido = (extra = {}) => ({ nome: 'Luva nitrílica', categoria: 'Outros', categoriaDescricao: 'Luva', tipo: 'Outros', tipoDescricao: 'Luva nitrílica', prazoUsoDias: 180, exigeTamanho: true, ...extra });

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    empresa = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Empresa CA Mestre E10', '11222333000181') RETURNING id")).rows[0].id;
    await provisionamento.provisionar(pool, { empresaId: empresa, dryRun: false });
    const identidade = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [EMAIL, await gerarHashSenha(SENHA)])).rows[0].id;
    await q("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Master', NULL, NULL, 'MASTER', $2)", [empresa, identidade]);
    // Material antigo com CA no cadastro, como a base anterior à E6.
    legado = (await q(
      "INSERT INTO materiais (empresa_id, nome, prazo_uso_dias, exige_tamanho, ca_numero, ca_validade) VALUES ($1, 'Botina antiga', 365, true, $2, '2026-10-15') RETURNING id",
      [empresa, CA_LEGADO],
    )).rows[0].id;

    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: criarLimitador({ limite: 100000, janelaSegundos: 60 }), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao: criarExigirSessao({ pool }), pool }),
      );
    });
    const login = await request(app).post('/api/auth/global/login').send({ email: EMAIL, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    cookie = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cadastro com CA no material: 400 VALIDACAO, nada criado', async () => {
    const antes = (await q('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresa])).rows[0].n;
    for (const extra of [{ caNumero: '12345' }, { caValidade: '2030-01-31' }, { caNumero: null }]) {
      const r = await api('post', '/api/materiais').send(valido(extra));
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(extra));
    }
    assert.equal((await q('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresa])).rows[0].n, antes);
  });

  test('edição com CA no material: 400 VALIDACAO, e o valor antigo do banco não muda', async () => {
    for (const extra of [{ caNumero: '99999' }, { caValidade: '2031-01-31' }, { caValidade: null }]) {
      const r = await api('patch', `/api/materiais/${legado}`).send({ descricao: 'x', ...extra });
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(extra));
    }
    assert.deepEqual(await colunasCa(legado), { ca_numero: CA_LEGADO, ca_validade: '2026-10-15' });
  });

  test('consulta e lista não trazem CA do cadastro, nem o valor antigo gravado no banco', async () => {
    const um = await api('get', `/api/materiais/${legado}`);
    const lista = await api('get', '/api/materiais');
    assert.equal(um.status, 200);
    for (const material of [um.body.material, lista.body.materiais.find((m) => m.id === legado)]) {
      assert.equal('caNumero' in material, false);
      assert.equal('caValidade' in material, false);
    }
    assert.equal(JSON.stringify(um.body).includes(CA_LEGADO) || JSON.stringify(lista.body).includes(CA_LEGADO), false);
  });

  test('cadastro e edição válidos: sem CA na resposta e na auditoria; editar outro campo preserva a coluna antiga', async () => {
    const criado = await api('post', '/api/materiais').send(valido({ nome: 'Capacete' }));
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    assert.deepEqual(['caNumero' in criado.body.material, 'caValidade' in criado.body.material], [false, false]);
    const editado = await api('patch', `/api/materiais/${legado}`).send({ descricao: 'Revisada' });
    assert.equal(editado.status, 200, JSON.stringify(editado.body));
    assert.deepEqual(await colunasCa(legado), { ca_numero: CA_LEGADO, ca_validade: '2026-10-15' });
    const { rows } = await q("SELECT dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao IN ('MATERIAL_CRIADO', 'MATERIAL_ALTERADO')", [empresa]);
    assert.ok(rows.length >= 2);
    for (const r of rows) {
      for (const dados of [r.dados_anteriores, r.dados_novos]) {
        if (dados) assert.equal('caNumero' in dados || 'caValidade' in dados, false, JSON.stringify(dados));
      }
    }
  });
});
