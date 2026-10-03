'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { inserirLote, baixarLote, somarDias } = require('./helpers/estoque-lotes');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarItensDisponiveisController } = require('../../src/controllers/itens-disponiveis.controller');
const { criarItensDisponiveisRoutes } = require('../../src/routes/itens-disponiveis.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * Bloco 9, Etapa C, Parte C3 — GET /api/estoque/itens-disponiveis com
 * PostgreSQL real, em schema temporário exclusivo com TODAS as migrations.
 * Somente leitura. O saldo vem dos lotes, com a data operacional fixada em
 * 30/09/2026 (relógio injetado).
 */

const TODAS_AS_MIGRATIONS = todasAsMigrations();
const HOJE = '2026-09-30';
const RELOGIO = () => new Date('2026-09-30T15:00:00Z');
const SENHA = 'senha-forte-da-parte-c3-2026';
const EMAILS = {
  masterA: 'master.a.c3@exemplo-cliente.com.br',
  supervisorA: 'supervisor.a.c3@exemplo-cliente.com.br', // materials.visualizar SEM availableItems
  usuarioA: 'usuario.a.c3@exemplo-cliente.com.br',       // availableItems.visualizar SEM materials
  masterB: 'master.b.c3@exemplo-cliente.com.br',
};
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;
const ROTA = '/api/estoque/itens-disponiveis';

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

describe('C3 — GET /api/estoque/itens-disponiveis (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  const empresa = {};
  const u = {};
  const m = {};
  const cookie = {};

  async function sessao(email) {
    const login = await request(app).post('/api/auth/global/login').send({ email, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    return `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
  }
  const listar = (quem, query = '') => request(app).get(`${ROTA}${query}`).set('Cookie', cookie[quem]);

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);
    const q = (sql, params) => pool.query(sql, params);

    for (const [k, nome, cnpj] of [['A', 'Empresa Alfa C3', '11222333000181'], ['B', 'Empresa Beta C3', '22333444000100']]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[k], dryRun: false });
    }
    const vinculo = async (chave, empresaId, email, perfil) => {
      const id = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      u[chave] = (await q('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id', [empresaId, chave, perfil, id])).rows[0].id;
    };
    await vinculo('masterA', empresa.A, EMAILS.masterA, 'MASTER');
    await vinculo('supervisorA', empresa.A, EMAILS.supervisorA, 'SUPERVISOR');
    await vinculo('usuarioA', empresa.A, EMAILS.usuarioA, 'USUARIO');
    await vinculo('masterB', empresa.B, EMAILS.masterB, 'MASTER');
    await q("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar) VALUES ($1, 'SUPERVISOR', 'materials', true)", [empresa.A]);
    await q("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, 'availableItems', true, $3)", [empresa.A, u.usuarioA, u.masterA]);

    // Materiais: o CA e a validade (relativa a HOJE) ficam em cada lote.
    const responsavel = { [empresa.A]: u.masterA, [empresa.B]: u.masterB };
    const material = async (chave, empresaId, campos, saldos) => {
      const r = await q(
        `INSERT INTO materiais (empresa_id, nome, tipo, categoria, codigo_interno, unidade, estoque_minimo, exige_ca, ativo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [empresaId, campos.nome, campos.tipo, campos.categoria, campos.codigo || null, campos.unidade, campos.minimo, campos.exigeCa !== false, campos.ativo !== false],
      );
      m[chave] = r.rows[0].id;
      const validade = campos.caDias === null ? null : somarDias(HOJE, campos.caDias);
      for (const [tamanho, quantidade] of saldos) {
        const loteId = await inserirLote(pool, { empresaId, materialId: m[chave], tamanho, quantidade: quantidade || 1, ca: validade ? 'CA-1' : null, validade });
        // Tamanho esgotado: o lote existiu e foi baixado por inteiro.
        if (quantidade === 0) await baixarLote(pool, { empresaId, loteId, quantidade: 1, usuarioId: responsavel[empresaId] });
      }
    };
    await material('botina', empresa.A, { nome: 'Botina de segurança', tipo: 'Sapatão / Botina', categoria: 'EPI', codigo: 'EPI-001', unidade: 'par', minimo: 5, caDias: 10 }, [['40', 12], ['41', 3], ['42', 0]]);
    await material('luva', empresa.A, { nome: 'Luva nitrílica', tipo: 'Luva', categoria: 'EPI', unidade: 'par', minimo: 0, caDias: -1 }, [['M', 4]]);
    await material('oculosHoje', empresa.A, { nome: 'Óculos incolor', tipo: 'Óculos de proteção', categoria: 'EPI', unidade: 'unidade', minimo: 2, caDias: 0 }, [['Único', 22]]);
    await material('capacete60', empresa.A, { nome: 'Capacete classe B', tipo: 'Capacete', categoria: 'EPI', unidade: 'unidade', minimo: 1, caDias: 60 }, [['Único', 5]]);
    await material('respirador61', empresa.A, { nome: 'Respirador PFF2', tipo: 'Respirador', categoria: 'EPI', unidade: 'unidade', minimo: 1, caDias: 61 }, [['Único', 30]]);
    await material('camiseta', empresa.A, { nome: 'Camiseta manga longa', tipo: 'Roupa / Uniforme', categoria: 'Uniforme', unidade: 'unidade', minimo: 10, caDias: null, exigeCa: false }, [['G', 9]]);
    await material('inativo', empresa.A, { nome: 'Material inativo', tipo: 'Luva', categoria: 'Ferramenta', unidade: 'unidade', minimo: 0, caDias: null, ativo: false }, [['P', 50]]);
    await material('semSaldo', empresa.A, { nome: 'Protetor sem linha de saldo', tipo: 'Protetor auricular', categoria: 'Material de consumo', unidade: 'unidade', minimo: 0, caDias: null }, []);
    await material('botinaB', empresa.B, { nome: 'Botina da empresa B', tipo: 'Sapatão / Botina', categoria: 'EPI', unidade: 'par', minimo: 1, caDias: 100 }, [['40', 99]]);

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool }),
        criarEstoqueRoutes({ controller: criarEstoqueController({ pool }), exigirSessao, pool }),
        criarItensDisponiveisRoutes({ controller: criarItensDisponiveisController({ pool, relogio: RELOGIO }), exigirSessao, pool }),
      );
    });
    for (const k of Object.keys(EMAILS)) cookie[k] = await sessao(EMAILS[k]);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('provisionamento do MASTER concede availableItems SOMENTE visualizar, nas duas empresas', async () => {
    const { rows } = await pool.query("SELECT empresa_id, pode_visualizar, pode_criar, pode_editar, pode_excluir FROM permissoes_recurso WHERE perfil = 'MASTER' AND recurso = 'availableItems' ORDER BY empresa_id");
    assert.deepEqual(rows, [
      { empresa_id: empresa.A, pode_visualizar: true, pode_criar: false, pode_editar: false, pode_excluir: false },
      { empresa_id: empresa.B, pode_visualizar: true, pode_criar: false, pode_editar: false, pode_excluir: false },
    ]);
    const outros = await pool.query("SELECT count(*)::int n FROM permissoes_recurso WHERE recurso = 'availableItems' AND perfil <> 'MASTER'");
    assert.equal(outros.rows[0].n, 0, 'nenhum outro perfil recebe automaticamente');
  });

  test('sem cookie: 401; cookie inválido: 401', async () => {
    assert.equal((await request(app).get(ROTA)).status, 401);
    assert.equal((await request(app).get(ROTA).set('Cookie', `${C_EMPRESA}=${'0'.repeat(64)}`)).status, 401);
  });

  test('MASTER A: só materiais ATIVOS da empresa A, todos os tamanhos com lote (inclusive esgotado), saldo = disponível + bloqueado, ordem por material e tamanho', async () => {
    const r = await listar('masterA');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'ok');
    const chaves = r.body.itens.map((i) => `${i.material}|${i.tamanho}|${i.saldo}`);
    assert.deepEqual(chaves, [
      'Botina de segurança|40|12', 'Botina de segurança|41|3', 'Botina de segurança|42|0',
      'Camiseta manga longa|G|9', 'Capacete classe B|Único|5', 'Luva nitrílica|M|4',
      'Óculos incolor|Único|22', 'Respirador PFF2|Único|30',
    ]);
    assert.equal(r.body.total, 8);
    assert.deepEqual([r.body.pagina, r.body.limite], [1, 50]);
    for (const i of r.body.itens) assert.equal(i.saldo, i.disponivel + i.bloqueado, 'saldo físico = disponível + bloqueado');
    const botina40 = r.body.itens[0];
    assert.deepEqual(botina40, {
      materialId: m.botina, material: 'Botina de segurança', codigoInterno: 'EPI-001', categoria: 'EPI', tipo: 'Sapatão / Botina',
      tamanho: '40', saldo: 12, bloqueado: 0, disponivel: 12, unidade: 'par', estoqueMinimo: 5, caValidade: somarDias(HOJE, 10), validade: 'expiring',
      // 12D-2: os campos da posição, aditivos (sem solicitação aprovada o livre é o próprio disponível)
      fisicoUtilizavel: 12, comprometido: 0, saldoLivre: 12, semCobertura: 0, minimoOrigem: 'PADRAO', abaixoDoMinimo: false, deficit: 0, necessidade: 0,
    });
    assert.equal(botina40.disponivel, botina40.fisicoUtilizavel, 'disponivel continua igual ao físico utilizável');
    assert.equal(r.body.itens.some((i) => i.material === 'Material inativo'), false, 'inativo nunca aparece');
    assert.equal(r.body.itens.some((i) => i.material === 'Protetor sem linha de saldo'), false, 'nenhum tamanho fictício');
    assert.equal(r.body.itens.some((i) => i.material === 'Botina da empresa B'), false, 'isolamento');
  });

  test('opções reais dos filtros: distintas, só da empresa e de materiais ativos com saldo cadastrado', async () => {
    const r = await listar('masterA');
    assert.deepEqual(r.body.filtros, {
      categorias: ['EPI', 'Uniforme'],
      tipos: ['Capacete', 'Luva', 'Óculos de proteção', 'Respirador', 'Roupa / Uniforme', 'Sapatão / Botina'],
      tamanhos: ['40', '41', '42', 'G', 'M', 'Único'],
    });
  });

  test('filtros combináveis: categoria, tipo e tamanho', async () => {
    const nomes = async (qs) => (await listar('masterA', qs)).body.itens.map((i) => `${i.material}|${i.tamanho}`);
    assert.deepEqual(await nomes('?categoria=Uniforme'), ['Camiseta manga longa|G']);
    assert.deepEqual(await nomes('?tipo=Luva'), ['Luva nitrílica|M']);
    assert.deepEqual(await nomes('?tamanho=40'), ['Botina de segurança|40']);
    assert.deepEqual(await nomes('?categoria=EPI&tamanho=%C3%9Anico'), ['Capacete classe B|Único', 'Óculos incolor|Único', 'Respirador PFF2|Único']);
    const vazio = await listar('masterA', '?tipo=Inexistente');
    assert.deepEqual([vazio.status, vazio.body.itens, vazio.body.total], [200, [], 0]);
  });

  test('validade do CA (alerta de 60 dias): vencido < hoje; hoje até hoje+60 = próximo; > hoje+60 = dentro do prazo; sem data só em Todos', async () => {
    const porValidade = async (v) => (await listar('masterA', `?validade=${v}`)).body.itens.map((i) => i.material).filter((x, i, a) => a.indexOf(x) === i);
    assert.deepEqual(await porValidade('expired'), ['Luva nitrílica']);
    assert.deepEqual(await porValidade('expiring'), ['Botina de segurança', 'Capacete classe B', 'Óculos incolor']);
    assert.deepEqual(await porValidade('ok'), ['Respirador PFF2']);
    const camiseta = (await listar('masterA', '?categoria=Uniforme')).body.itens[0];
    assert.deepEqual([camiseta.caValidade, camiseta.validade], [null, 'sem-validade']);
  });

  test('CA vencido bloqueia: o item continua listado com o saldo físico, e nada dele fica disponível', async () => {
    const luva = (await listar('masterA', '?tipo=Luva')).body.itens[0];
    assert.deepEqual([luva.validade, luva.saldo, luva.bloqueado, luva.disponivel], ['expired', 4, 4, 0]);
  });

  test('paginação: total correto, páginas disjuntas, página além do fim vazia', async () => {
    const p1 = await listar('masterA', '?limite=3&pagina=1');
    const p3 = await listar('masterA', '?limite=3&pagina=3');
    const p9 = await listar('masterA', '?limite=3&pagina=9');
    assert.deepEqual([p1.body.itens.length, p1.body.total, p3.body.itens.length, p9.body.itens.length, p9.body.total], [3, 8, 2, 0, 8]);
    assert.deepEqual(p3.body.itens.map((i) => i.material), ['Óculos incolor', 'Respirador PFF2']);
  });

  test('query inválida ou com autoridade: 400 VALIDACAO', async () => {
    for (const qs of ['?empresaId=' + empresa.B, '?usuarioId=1', '?limite=101', '?pagina=0', '?validade=vencido', '?categoria=', '?ativo=false']) {
      const r = await listar('masterA', qs);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], qs);
    }
  });

  test('isolamento: MASTER B só vê a empresa B, com as opções de filtro de B', async () => {
    const r = await listar('masterB');
    assert.deepEqual(r.body.itens.map((i) => `${i.material}|${i.tamanho}|${i.saldo}`), ['Botina da empresa B|40|99']);
    assert.deepEqual(r.body.filtros, { categorias: ['EPI'], tipos: ['Sapatão / Botina'], tamanhos: ['40'] });
  });

  test('permissão independente: materials.visualizar sem availableItems → 403; availableItems sem materials → 200 e nada além', async () => {
    const sup = await listar('supervisorA');
    assert.deepEqual([sup.status, sup.body.codigo], [403, 'PERMISSAO_NEGADA']);
    assert.equal((await request(app).get('/api/materiais').set('Cookie', cookie.supervisorA)).status, 200, 'o supervisor continua vendo o cadastro');

    const usr = await listar('usuarioA');
    assert.equal(usr.status, 200);
    assert.equal(usr.body.total, 8);
    assert.equal((await request(app).get('/api/materiais').set('Cookie', cookie.usuarioA)).status, 403, 'itens disponíveis não concede o cadastro');
    assert.equal((await request(app).post('/api/materiais').set('Cookie', cookie.usuarioA).send({ nome: 'x' })).status, 403);
    assert.equal((await request(app).post(`/api/materiais/${m.botina}/estoque/entradas`).set('Cookie', cookie.usuarioA).send({})).status, 403, 'nem movimentar');
  });

  test('somente leitura: POST, PATCH e DELETE não existem; nada é auditado pela consulta', async () => {
    const antes = (await pool.query('SELECT count(*)::int n FROM logs_auditoria')).rows[0].n;
    for (const metodo of ['post', 'patch', 'delete']) {
      assert.equal((await request(app)[metodo](ROTA).set('Cookie', cookie.masterA).send({})).status, 404, metodo);
    }
    await listar('masterA');
    assert.equal((await pool.query('SELECT count(*)::int n FROM logs_auditoria')).rows[0].n, antes);
  });

  test('persistência: uma baixa registrada no histórico aparece na consulta seguinte; tamanho esgotado continua listado como 0', async () => {
    const { rows: [l] } = await pool.query("SELECT id FROM estoque_lotes WHERE material_id = $1 AND tamanho = '41'", [m.botina]);
    await baixarLote(pool, { empresaId: empresa.A, loteId: l.id, quantidade: 3, usuarioId: u.masterA });
    const botina41 = (await listar('masterA', '?tamanho=41')).body.itens[0];
    assert.deepEqual([botina41.saldo, botina41.disponivel], [0, 0]);
  });

  test('sessão expirada: 401', async () => {
    const c = await sessao(EMAILS.masterB);
    await pool.query("UPDATE sessoes SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 minute' WHERE usuario_id = $1 AND revogada_em IS NULL", [u.masterB]);
    assert.equal((await request(app).get(ROTA).set('Cookie', c)).status, 401);
    cookie.masterB = await sessao(EMAILS.masterB);
  });
});
