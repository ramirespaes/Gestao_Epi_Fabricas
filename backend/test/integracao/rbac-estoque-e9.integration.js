'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { inserirLote, baixarLote } = require('./helpers/estoque-lotes');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarDashboardController } = require('../../src/controllers/dashboard.controller');
const { criarDashboardRoutes } = require('../../src/routes/dashboard.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const recursos = require('../../src/rbac/recursos');
const estoqueRoutes = require('../../src/routes/estoque.routes');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * E9 — RBAC das áreas de estoque: Validade de estoque (stockValidity) e
 * Operações de estoque (operations) com permissão própria, MASTER pelo
 * provisionamento normal, grupos que concedem e retiram de verdade, e o
 * lote de material inativo com saldo na Validade e no Dashboard.
 * PostgreSQL real, schema temporário, data operacional de São Paulo fixa.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 46 }, (_, i) => String(i).padStart(3, '0'));
const NOITE_DE_30_09 = () => new Date('2026-10-01T02:30:00Z');
const SENHA = 'senha-forte-do-rbac-e9-2026';
const EMAILS = {
  masterA: 'master.a.e9@exemplo-cliente.com.br',
  almox: 'almox.a.e9@exemplo-cliente.com.br', // grupo com materials e dashboard, sem as áreas novas
  leitor: 'leitor.a.e9@exemplo-cliente.com.br', // grupo que recebe as áreas novas pela tela
  semGrupo: 'sem.grupo.a.e9@exemplo-cliente.com.br',
  masterB: 'master.b.e9@exemplo-cliente.com.br',
  masterC: 'master.c.e9@exemplo-cliente.com.br', // empresa ainda não provisionada
};
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

describe('E9 — RBAC de Validade e Operações de estoque (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  const empresa = {};
  const u = {};
  const grupo = {};
  const m = {};
  const lote = {};
  const cookie = {};

  const q = (sql, params) => pool.query(sql, params);
  const get = (quem, rota) => request(app).get(rota).set('Cookie', cookie[quem]);
  const validade = (quem, query = '?limite=100') => get(quem, `/api/estoque/validade${query}`);
  const operacoes = (quem, query = '?limite=100') => get(quem, `/api/estoque/operacoes${query}`);
  const dashboard = (quem) => get(quem, '/api/dashboard/indicadores');
  const permissoes = async (quem) => (await get(quem, '/api/auth/permissoes')).body;
  const configurarGrupo = (quem, grupoId, recurso, corpo) => request(app)
    .patch(`/api/grupos-acesso/${grupoId}/permissoes/recursos/${recurso}`).set('Cookie', cookie[quem]).send(corpo);
  const baixa = (quem, loteId, quantidade) => request(app).post(`/api/estoque/lotes/${loteId}/baixas`).set('Cookie', cookie[quem])
    .send({ quantidade, motivo: 'CA_VENCIDO', chaveIdempotencia: crypto.randomUUID() });
  const saldoDe = async (loteId) => (await q('SELECT saldo FROM estoque_lotes WHERE id = $1', [loteId])).rows[0].saldo;
  const linhasDoGrupo = async (grupoId) => (await q(
    "SELECT recurso, pode_visualizar FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso IN ('stockValidity', 'operations') ORDER BY recurso",
    [grupoId],
  )).rows;

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);

    for (const [k, nome, cnpj] of [['A', 'Empresa Alfa E9', '11222333000181'], ['B', 'Empresa Beta E9', '22333444000100'], ['C', 'Empresa Gama E9', '33444555000102']]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
    }
    // A e B pelo provisionamento normal; C fica sem, para provar que o MASTER não tem atalho.
    for (const k of ['A', 'B']) await provisionamento.provisionar(pool, { empresaId: empresa[k], dryRun: false });

    const vinculo = async (chave, empresaId, email, perfil) => {
      const id = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      u[chave] = (await q('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id',
        [empresaId, chave, perfil, id])).rows[0].id;
    };
    await vinculo('masterA', empresa.A, EMAILS.masterA, 'MASTER');
    await vinculo('almox', empresa.A, EMAILS.almox, 'USUARIO');
    await vinculo('leitor', empresa.A, EMAILS.leitor, 'USUARIO');
    await vinculo('semGrupo', empresa.A, EMAILS.semGrupo, 'USUARIO');
    await vinculo('masterB', empresa.B, EMAILS.masterB, 'MASTER');
    await vinculo('masterC', empresa.C, EMAILS.masterC, 'MASTER');

    const novoGrupo = async (chave, empresaId, criador, nome) => {
      grupo[chave] = (await q('INSERT INTO grupos_acesso (empresa_id, nome, ativo, criado_por) VALUES ($1, $2, true, $3) RETURNING id', [empresaId, nome, criador])).rows[0].id;
    };
    await novoGrupo('almox', empresa.A, u.masterA, 'Almoxarifado E9');
    await novoGrupo('leitor', empresa.A, u.masterA, 'Leitura de estoque E9');
    await novoGrupo('B', empresa.B, u.masterB, 'Grupo da B');
    await q("INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar) VALUES ($1, $2, 'materials', true), ($1, $2, 'dashboard', true)", [empresa.A, grupo.almox]);
    await q("INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar) VALUES ($1, $2, 'dashboard', true)", [empresa.A, grupo.leitor]);
    await q('UPDATE usuarios SET grupo_acesso_id = $2 WHERE id = $1', [u.almox, grupo.almox]);
    await q('UPDATE usuarios SET grupo_acesso_id = $2 WHERE id = $1', [u.leitor, grupo.leitor]);

    const material = async (chave, empresaId, nome, ativo = true) => {
      m[chave] = (await q('INSERT INTO materiais (empresa_id, nome, tipo, exige_ca, ativo, exige_tamanho, codigo_interno) VALUES ($1, $2, $3, true, $4, true, $5) RETURNING id',
        [empresaId, nome, 'Luva', ativo, `COD-${chave}`])).rows[0].id;
    };
    await material('ativo', empresa.A, 'Botina ativa');
    await material('inativo', empresa.A, 'Luva antiga inativa');
    await material('inativoZerado', empresa.A, 'Luva zerada inativa');
    await material('B', empresa.B, 'Botina B');
    const novoLote = async (chave, empresaId, materialChave, quantidade, validadeCa) => {
      lote[chave] = await inserirLote(pool, { empresaId, materialId: m[materialChave], tamanho: 'M', quantidade, ca: `CA-${chave}`, validade: validadeCa });
    };
    await novoLote('ativoVencido', empresa.A, 'ativo', 5, '2026-09-01');
    await novoLote('ativoValido', empresa.A, 'ativo', 10, '2027-06-30');
    await novoLote('inativoVencido', empresa.A, 'inativo', 4, '2026-09-01');
    await novoLote('inativoValido', empresa.A, 'inativo', 6, '2027-06-30');
    await novoLote('inativoZerado', empresa.A, 'inativoZerado', 3, '2026-09-01');
    await baixarLote(pool, { empresaId: empresa.A, loteId: lote.inativoZerado, quantidade: 3, usuarioId: u.masterA });
    await novoLote('B', empresa.B, 'B', 50, '2026-09-01');
    // Os materiais são inativados depois de ter estoque, como acontece de verdade.
    await q('UPDATE materiais SET ativo = false WHERE id = ANY($1::int[])', [[m.inativo, m.inativoZerado]]);

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao }),
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao }),
        criarEstoqueRoutes({ controller: criarEstoqueController({ pool, relogio: NOITE_DE_30_09 }), exigirSessao, pool }),
        criarDashboardRoutes({ controller: criarDashboardController({ pool, relogio: NOITE_DE_30_09 }), exigirSessao, pool }),
      );
    });
    for (const k of Object.keys(EMAILS)) {
      const login = await request(app).post('/api/auth/global/login').send({ email: EMAILS[k], senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const c = cookiesDe(login);
      cookie[k] = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
    }
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('catálogo e provisionamento do MASTER', () => {
    test('1 e 2. stockValidity e operations estão no catálogo e são os recursos das rotas de Validade e Operações', () => {
      assert.ok(recursos.recursoConhecido('stockValidity'));
      assert.ok(recursos.recursoConhecido('operations'));
      assert.equal(estoqueRoutes.RECURSO_VALIDADE, 'stockValidity');
      assert.equal(estoqueRoutes.RECURSO_OPERACOES, 'operations');
    });

    test('3 e 4. o escopo do MASTER traz as duas áreas só com visualizar; a empresa provisionada tem as linhas de perfil', async () => {
      const escopo = Object.fromEntries(recursos.ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((r) => [r.recurso, [...r.operacoes]]));
      assert.deepEqual([escopo.stockValidity, escopo.operations], [['visualizar'], ['visualizar']]);
      const { rows } = await q(
        "SELECT recurso, pode_visualizar v, pode_criar c, pode_editar e, pode_excluir x FROM permissoes_recurso WHERE empresa_id = $1 AND perfil = 'MASTER' AND recurso IN ('stockValidity', 'operations') ORDER BY recurso",
        [empresa.A],
      );
      assert.deepEqual(rows, [{ recurso: 'operations', v: true, c: false, e: false, x: false }, { recurso: 'stockValidity', v: true, c: false, e: false, x: false }]);
      const p = await permissoes('masterA');
      assert.deepEqual([p.recursos.stockValidity, p.recursos.operations], [
        { visualizar: true, criar: false, editar: false, excluir: false }, { visualizar: true, criar: false, editar: false, excluir: false },
      ]);
    });

    test('16. MASTER sem as linhas recebe 403; o provisionamento da empresa existente libera; repetir não duplica', async () => {
      assert.deepEqual([(await validade('masterC')).status, (await operacoes('masterC')).status], [403, 403]);
      const primeira = await provisionamento.provisionar(pool, { empresaId: empresa.C, dryRun: false });
      assert.ok(primeira.inseridos.recursos.includes('stockValidity') && primeira.inseridos.recursos.includes('operations'));
      assert.deepEqual([(await validade('masterC')).status, (await operacoes('masterC')).status], [200, 200]);
      const segunda = await provisionamento.provisionar(pool, { empresaId: empresa.C, dryRun: false });
      assert.deepEqual(segunda.inseridos, { recursos: [], acoes: [] });
      const situacao = Object.fromEntries(segunda.plano.recursos.map((r) => [r.recurso, r.situacao]));
      assert.deepEqual([situacao.stockValidity, situacao.operations], ['ADEQUADA', 'ADEQUADA']);
      const n = (await q("SELECT count(*)::int AS n FROM permissoes_recurso WHERE empresa_id = $1 AND recurso IN ('stockValidity', 'operations')", [empresa.C])).rows[0].n;
      assert.equal(n, 2);
    });

    test('customização existente é preservada: MASTER com operations negado continua negado e é relatado', async () => {
      const d = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Empresa Delta E9', '44555666000103') RETURNING id")).rows[0].id;
      await q("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir) VALUES ($1, 'MASTER', 'operations', false, false, false, false)", [d]);
      const r = await provisionamento.provisionar(pool, { empresaId: d, dryRun: false });
      const item = r.plano.recursos.find((x) => x.recurso === 'operations');
      assert.deepEqual([item.situacao, item.faltantes], ['INSUFICIENTE', ['visualizar']]);
      assert.ok(r.inseridos.recursos.includes('stockValidity'));
      assert.equal((await q("SELECT pode_visualizar FROM permissoes_recurso WHERE empresa_id = $1 AND recurso = 'operations'", [d])).rows[0].pode_visualizar, false);
    });

    test('17. grupo comum e outros perfis não recebem nada automaticamente', async () => {
      const outrosPerfis = (await q("SELECT count(*)::int AS n FROM permissoes_recurso WHERE perfil <> 'MASTER' AND recurso IN ('stockValidity', 'operations')")).rows[0].n;
      assert.equal(outrosPerfis, 0);
      assert.deepEqual(await linhasDoGrupo(grupo.almox), []);
      assert.deepEqual([(await validade('semGrupo')).status, (await operacoes('semGrupo')).status], [403, 403]);
    });
  });

  describe('permissão própria: materials.visualizar não abre as áreas novas', () => {
    test('6, 8 e 12. com materials.visualizar e sem as permissões próprias: 403 direto na API, nada listado', async () => {
      assert.equal((await get('almox', `/api/materiais/${m.ativo}/estoque/lotes`)).status, 200, 'materials continua protegendo o que é dele');
      for (const r of [await validade('almox'), await operacoes('almox')]) {
        assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA']);
        assert.equal('lotes' in r.body || 'operacoes' in r.body, false);
      }
      const p = await permissoes('almox');
      assert.deepEqual([p.recursos.materials.visualizar, p.recursos.stockValidity.visualizar, p.recursos.operations.visualizar], [true, false, false]);
    });

    test('5, 7, 9 e 10. o grupo concede pela tela e a API abre; herdar ou negar pela tela fecha de novo', async () => {
      assert.deepEqual([(await validade('leitor')).status, (await operacoes('leitor')).status], [403, 403]);
      for (const recurso of ['stockValidity', 'operations']) {
        const r = await configurarGrupo('masterA', grupo.leitor, recurso, { podeVisualizar: true });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      assert.deepEqual([(await validade('leitor')).status, (await operacoes('leitor')).status], [200, 200]);
      assert.equal((await configurarGrupo('masterA', grupo.leitor, 'stockValidity', { podeVisualizar: null })).status, 200);
      assert.equal((await configurarGrupo('masterA', grupo.leitor, 'operations', { podeVisualizar: false })).status, 200);
      assert.deepEqual([(await validade('leitor')).status, (await operacoes('leitor')).status], [403, 403]);
      for (const recurso of ['stockValidity', 'operations']) assert.equal((await configurarGrupo('masterA', grupo.leitor, recurso, { podeVisualizar: true })).status, 200);
      assert.deepEqual([(await validade('leitor')).status, (await operacoes('leitor')).status], [200, 200]);
    });

    test('11. a empresa A não configura grupo da B: 404 e nada gravado na B', async () => {
      const r = await configurarGrupo('masterA', grupo.B, 'stockValidity', { podeVisualizar: true });
      assert.equal(r.status, 404);
      assert.deepEqual(await linhasDoGrupo(grupo.B), []);
    });

    test('13 e 21. ver a Validade não dá baixa: sem MOVIMENTAR_ESTOQUE, 403 e o lote não muda; o MASTER dá baixa em lote de material inativo', async () => {
      const antes = await saldoDe(lote.inativoVencido);
      const negada = await baixa('leitor', lote.inativoVencido, 1);
      assert.deepEqual([negada.status, negada.body.codigo], [403, 'PERMISSAO_NEGADA']);
      assert.equal(await saldoDe(lote.inativoVencido), antes);
      const feita = await baixa('masterA', lote.inativoVencido, 1);
      assert.equal(feita.status, 201, JSON.stringify(feita.body));
      assert.equal(await saldoDe(lote.inativoVencido), antes - 1);
    });

    test('IDOR: a B não dá baixa em lote da A; a A não vê lote nem operação da B', async () => {
      const antes = await saldoDe(lote.ativoVencido);
      assert.equal((await baixa('masterB', lote.ativoVencido, 1)).status, 404);
      assert.equal(await saldoDe(lote.ativoVencido), antes);
      assert.equal((await validade('masterA')).body.lotes.some((l) => l.loteId === lote.B), false);
      assert.equal((await operacoes('masterA')).body.operacoes.some((o) => o.loteId === lote.B), false);
    });
  });

  describe('material inativo com saldo', () => {
    test('18. lote de material inativo com saldo aparece na Validade, marcado como inativo, com a regra de CA de sempre', async () => {
      const lotes = Object.fromEntries((await validade('masterA')).body.lotes.map((l) => [l.loteId, l]));
      assert.deepEqual([lotes[lote.inativoVencido].materialAtivo, lotes[lote.inativoVencido].situacaoCa, lotes[lote.inativoVencido].bloqueado > 0], [false, 'VENCIDO', true]);
      assert.deepEqual([lotes[lote.inativoValido].materialAtivo, lotes[lote.inativoValido].situacaoCa], [false, 'VALIDO']);
      assert.equal(lotes[lote.ativoVencido].materialAtivo, true);
    });

    test('19. lote zerado de material inativo não vira pendência: fora da lista e dos indicadores', async () => {
      const r = await validade('masterA');
      assert.equal(r.body.lotes.some((l) => l.loteId === lote.inativoZerado), false);
      assert.equal(r.body.indicadores.lotes, 4);
    });

    test('material inativo não recebe entrada nova só porque tem saldo', async () => {
      const r = await request(app).post(`/api/materiais/${m.inativo}/estoque/entradas`).set('Cookie', cookie.masterA)
        .send({ tamanho: 'M', quantidade: 1, caNumero: 'CA-NOVO', caValidade: '2030-01-31', chaveIdempotencia: crypto.randomUUID() });
      assert.deepEqual([r.status, r.body.codigo], [409, 'MATERIAL_INATIVO']);
      assert.equal((await q('SELECT ativo FROM materiais WHERE id = $1', [m.inativo])).rows[0].ativo, false, 'não reativa');
    });

    test('20. o histórico de material inativo continua nas Operações de estoque', async () => {
      const ops = (await operacoes('masterA')).body.operacoes;
      const doInativo = ops.filter((o) => o.materialId === m.inativo || o.materialId === m.inativoZerado).map((o) => o.tipo).sort();
      assert.deepEqual(doInativo, ['BAIXA', 'BAIXA', 'SALDO_INICIAL', 'SALDO_INICIAL', 'SALDO_INICIAL']);
    });
  });

  describe('Dashboard coerente com a Validade', () => {
    test('22. CA vencido e a vencer contam os mesmos lotes da Validade, inclusive de material inativo; disponível segue só material ativo', async () => {
      const v = (await validade('masterA')).body.indicadores;
      const d = await dashboard('masterA');
      assert.equal(d.status, 200, JSON.stringify(d.body));
      assert.equal(d.body.indicadores.caVencido.valor, v.vencido);
      assert.equal(d.body.indicadores.caVencido.aVencer, v.venceHoje + v.aVencer);
      assert.equal(v.vencido, 2, 'o vencido do material ativo e o do inativo');
      assert.deepEqual(d.body.indicadores.itensDisponiveis, { permitido: true, valor: 10 }, 'disponível para entrega é só de material ativo');
    });

    test('22. o número de CA vencido segue a permissão da Validade, não a de materiais', async () => {
      const almox = await dashboard('almox');
      assert.equal(almox.status, 200, JSON.stringify(almox.body));
      assert.deepEqual(almox.body.indicadores.caVencido, { permitido: false });
      const leitor = await dashboard('leitor');
      assert.equal(leitor.body.indicadores.caVencido.permitido, true);
    });
  });
});
