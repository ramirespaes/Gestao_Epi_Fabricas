'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { inserirLote, baixarLote, somarDias } = require('./helpers/estoque-lotes');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarItensDisponiveisController } = require('../../src/controllers/itens-disponiveis.controller');
const { criarItensDisponiveisRoutes } = require('../../src/routes/itens-disponiveis.routes');
const { criarDashboardController } = require('../../src/controllers/dashboard.controller');
const { criarDashboardRoutes } = require('../../src/routes/dashboard.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const loteRepo = require('../../src/repositories/estoque-lote.repository');

/**
 * Leitura do estoque por lote com PostgreSQL real e relógio controlado.
 * 23h30 de 30/09 em São Paulo (02h30 de 01/10 em UTC): a data operacional é
 * 30/09. Se alguém calculasse "hoje" em UTC ou pelo relógio do banco, os
 * números mudariam.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 46 }, (_, i) => String(i).padStart(3, '0'));
const HOJE = '2026-09-30';
const NOITE_DE_30_09 = () => new Date('2026-10-01T02:30:00Z');
const MADRUGADA_DE_01_10 = () => new Date('2026-10-01T03:30:00Z');
const SENHA = 'senha-forte-da-leitura-por-lote-2026';
const EMAILS = {
  masterA: 'master.a.lotes@exemplo-cliente.com.br',
  usuarioA: 'usuario.a.lotes@exemplo-cliente.com.br', // availableItems por exceção, SEM materials
  masterB: 'master.b.lotes@exemplo-cliente.com.br',
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

describe('leitura do estoque por lote (PostgreSQL real, data operacional controlada)', () => {
  let contexto;
  let pool;
  let app;
  let appMadrugada;
  const empresa = {};
  const u = {};
  const m = {};
  const lote = {};
  const cookie = {};

  const get = (quem, rota, alvo = app) => request(alvo).get(rota).set('Cookie', cookie[quem]);

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const q = (sql, params) => pool.query(sql, params);
    const hash = await gerarHashSenha(SENHA);

    for (const [k, nome, cnpj] of [['A', 'Empresa Alfa Lotes', '11222333000181'], ['B', 'Empresa Beta Lotes', '22333444000100']]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[k], dryRun: false });
    }
    const vinculo = async (chave, empresaId, email, perfil) => {
      const id = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      u[chave] = (await q('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id', [empresaId, chave, perfil, id])).rows[0].id;
    };
    await vinculo('masterA', empresa.A, EMAILS.masterA, 'MASTER');
    await vinculo('usuarioA', empresa.A, EMAILS.usuarioA, 'USUARIO');
    await vinculo('masterB', empresa.B, EMAILS.masterB, 'MASTER');
    await q("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, 'availableItems', true, $3)", [empresa.A, u.usuarioA, u.masterA]);

    const material = async (chave, empresaId, nome, { tipo, categoria = 'EPI', minimo = 0, exigeCa = true, ativo = true, caLegado = null } = {}) => {
      m[chave] = (await q(
        `INSERT INTO materiais (empresa_id, nome, tipo, categoria, estoque_minimo, exige_ca, ativo, ca_numero, ca_validade)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [empresaId, nome, tipo, categoria, minimo, exigeCa, ativo, caLegado ? '00000' : null, caLegado],
      )).rows[0].id;
    };
    const novoLote = (chave, empresaId, materialChave, tamanho, quantidade, validade, ca = validade ? `CA-${chave}` : null) =>
      inserirLote(pool, { empresaId, materialId: m[materialChave], tamanho, quantidade, ca, validade }).then((id) => { lote[chave] = id; });

    // CA vencido no cadastro legado do material: não pode influenciar nada.
    await material('botina', empresa.A, 'Botina', { tipo: 'Sapatão / Botina', minimo: 10, caLegado: '2020-01-01' });
    await material('luva', empresa.A, 'Luva', { tipo: 'Luva' });
    await material('uniforme', empresa.A, 'Uniforme', { tipo: 'Roupa / Uniforme', categoria: 'Uniforme', exigeCa: false });
    await material('capacete', empresa.A, 'Capacete', { tipo: 'Capacete', minimo: 20 });
    await material('oculos', empresa.A, 'Óculos', { tipo: 'Óculos de proteção', minimo: 10 });
    await material('inativo', empresa.A, 'Inativo', { tipo: 'Luva', ativo: false });
    await material('semEstoque', empresa.A, 'Sem estoque', { tipo: 'Luva', caLegado: '2020-01-01' });
    await material('botinaB', empresa.B, 'Botina B', { tipo: 'Sapatão / Botina' });

    await novoLote('botinaValida', empresa.A, 'botina', '40', 10, '2026-12-31');
    await novoLote('botinaVencida', empresa.A, 'botina', '40', 5, somarDias(HOJE, -1));
    await novoLote('botinaZerada', empresa.A, 'botina', '40', 3, '2026-09-01');
    await baixarLote(pool, { empresaId: empresa.A, loteId: lote.botinaZerada, quantidade: 3, usuarioId: u.masterA });
    await novoLote('botinaHoje', empresa.A, 'botina', '41', 4, HOJE);
    await novoLote('botinaEsgotada', empresa.A, 'botina', '42', 2, '2027-01-31');
    await baixarLote(pool, { empresaId: empresa.A, loteId: lote.botinaEsgotada, quantidade: 2, usuarioId: u.masterA });
    await novoLote('luvaSemCa', empresa.A, 'luva', 'M', 8, null);
    await novoLote('luvaAVencer', empresa.A, 'luva', 'M', 2, somarDias(HOJE, 30));
    await novoLote('uniforme', empresa.A, 'uniforme', 'G', 6, null);
    await novoLote('capacete', empresa.A, 'capacete', 'U', 20, '2027-06-30');
    await novoLote('oculosValido', empresa.A, 'oculos', 'U', 5, '2027-01-31');
    await novoLote('oculosVencido', empresa.A, 'oculos', 'U', 15, '2026-09-01');
    await novoLote('inativo', empresa.A, 'inativo', 'P', 9, '2026-08-01');
    await novoLote('botinaBVencida', empresa.B, 'botinaB', '40', 50, '2026-09-01');
    await novoLote('botinaBValida', empresa.B, 'botinaB', '40', 7, '2027-03-31');
    // Saldo legado divergente: a leitura operacional não pode enxergá-lo.
    await q("INSERT INTO estoque_tamanhos (material_id, tamanho, quantidade) VALUES ($1, '40', 999), ($2, 'U', 50)", [m.botina, m.semEstoque]);

    const montar = (relogio) => {
      const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
      const exigirSessao = criarExigirSessao({ pool });
      return criarAppTeste((a) => {
        a.use(
          '/api',
          criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }) }),
          criarEstoqueRoutes({ controller: criarEstoqueController({ pool, relogio }), exigirSessao, pool }),
          criarItensDisponiveisRoutes({ controller: criarItensDisponiveisController({ pool, relogio }), exigirSessao, pool }),
          criarDashboardRoutes({ controller: criarDashboardController({ pool, relogio }), exigirSessao, pool }),
        );
      });
    };
    app = montar(NOITE_DE_30_09);
    appMadrugada = montar(MADRUGADA_DE_01_10);
    for (const k of Object.keys(EMAILS)) {
      const login = await request(app).post('/api/auth/global/login').send({ email: EMAILS[k], senha: SENHA });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const c = cookiesDe(login);
      cookie[k] = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
    }
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  const resumoDe = (l) => [l.tamanho, l.caValidade, l.situacaoCa, l.fisico, l.bloqueado, l.disponivel];

  test('lotes do material: físico, bloqueado e disponível por lote; CA futuro e CA que vence hoje disponíveis, vencido bloqueado; lote zerado fora', async () => {
    const r = await get('masterA', `/api/materiais/${m.botina}/estoque/lotes`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.hoje, r.body.diasAlerta, r.body.material.id], [HOJE, 60, m.botina]);
    assert.deepEqual(r.body.lotes.map(resumoDe), [
      ['40', '2026-09-29', 'VENCIDO', 5, 5, 0],
      ['40', '2026-12-31', 'VALIDO', 10, 0, 10],
      ['41', HOJE, 'VENCE_HOJE', 4, 0, 4],
    ]);
    const vencido = r.body.lotes[0];
    assert.deepEqual(vencido, {
      loteId: lote.botinaVencida, materialId: m.botina, tamanho: '40', caNumero: 'CA-botinaVencida', caValidade: '2026-09-29',
      origem: 'SALDO_INICIAL', quantidadeEntrada: 5, quantidadeBaixada: 0, quantidadeEntregue: 0,
      fisico: 5, bloqueado: 5, disponivel: 0, situacaoCa: 'VENCIDO',
    });
    assert.deepEqual(r.body.porTamanho, [
      { tamanho: '40', fisico: 15, bloqueado: 5, disponivel: 10 },
      { tamanho: '41', fisico: 4, bloqueado: 0, disponivel: 4 },
    ]);
    assert.deepEqual(r.body.totais, { fisico: 19, bloqueado: 5, disponivel: 14 });
    for (const l of r.body.lotes) assert.equal(l.fisico, l.disponivel + l.bloqueado);
    assert.equal(r.body.lotes.some((l) => [lote.botinaZerada, lote.botinaEsgotada].includes(l.loteId)), false, 'lote zerado não é saldo atual');
  });

  test('exige_ca: sem CA bloqueia quando o material exige; não bloqueia quando dispensa; a vencer é só informativo', async () => {
    const luva = (await get('masterA', `/api/materiais/${m.luva}/estoque/lotes`)).body;
    assert.deepEqual(luva.lotes.map(resumoDe), [
      ['M', somarDias(HOJE, 30), 'A_VENCER', 2, 0, 2],
      ['M', null, 'SEM_CA', 8, 8, 0],
    ]);
    const uniforme = (await get('masterA', `/api/materiais/${m.uniforme}/estoque/lotes`)).body;
    assert.deepEqual(uniforme.lotes.map(resumoDe), [['G', null, 'NAO_EXIGE_CA', 6, 0, 6]]);
  });

  test('material inativo: a consulta do material mostra os lotes com a mesma regra de CA', async () => {
    const inativo = (await get('masterA', `/api/materiais/${m.inativo}/estoque/lotes`)).body;
    assert.deepEqual(inativo.lotes.map(resumoDe), [['P', '2026-08-01', 'VENCIDO', 9, 9, 0]]);
  });

  test('isolamento: material de outra empresa responde 404 sem revelar nada; a empresa B vê só os próprios lotes', async () => {
    const cruzado = await get('masterA', `/api/materiais/${m.botinaB}/estoque/lotes`);
    assert.deepEqual([cruzado.status, cruzado.body.codigo, cruzado.body.lotes], [404, 'MATERIAL_NAO_ENCONTRADO', undefined]);
    const b = (await get('masterB', `/api/materiais/${m.botinaB}/estoque/lotes`)).body;
    assert.deepEqual(b.totais, { fisico: 57, bloqueado: 50, disponivel: 7 });
    assert.equal((await get('masterB', `/api/materiais/${m.botina}/estoque/lotes`)).status, 404);
  });

  test('consulta de lotes exige materials.visualizar', async () => {
    const r = await get('usuarioA', `/api/materiais/${m.botina}/estoque/lotes`);
    assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA']);
  });

  test('Itens Disponíveis: disponível exclui o bloqueado, saldo é o físico, e estoque_tamanhos não é fonte', async () => {
    const r = await get('masterA', '/api/estoque/itens-disponiveis');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const porChave = Object.fromEntries(r.body.itens.map((i) => [`${i.material}|${i.tamanho}`, [i.saldo, i.bloqueado, i.disponivel, i.validade, i.caValidade]]));
    assert.deepEqual(porChave, {
      'Botina|40': [15, 5, 10, 'expired', '2026-09-29'],
      'Botina|41': [4, 0, 4, 'expiring', HOJE],
      'Botina|42': [0, 0, 0, 'sem-validade', null],
      'Capacete|U': [20, 0, 20, 'ok', '2027-06-30'],
      'Luva|M': [10, 8, 2, 'expiring', somarDias(HOJE, 30)],
      'Óculos|U': [20, 15, 5, 'expired', '2026-09-01'],
      'Uniforme|G': [6, 0, 6, 'sem-validade', null],
    });
    assert.equal(r.body.total, 7, 'material inativo e material só com saldo legado ficam fora');
    const expirados = (await get('masterA', '/api/estoque/itens-disponiveis?validade=expired')).body.itens.map((i) => `${i.material}|${i.tamanho}`);
    assert.deepEqual(expirados.sort(), ['Botina|40', 'Óculos|U']);
  });

  test('dashboard: disponível sem bloqueado; mínimo pelo disponível; CA vencido conta lotes com saldo; vence hoje é a vencer', async () => {
    const a = (await get('masterA', '/api/dashboard/indicadores')).body.indicadores;
    assert.deepEqual(a.itensDisponiveis, { permitido: true, valor: 47 });
    // Botina 41 (4 < 10), Botina 42 esgotada (0) e Óculos (físico 20, bloqueado 15, disponível 5 < 10).
    assert.deepEqual(a.estoqueAbaixoMinimo, { permitido: true, valor: 3 });
    // Botina 40 vencida, Óculos vencido e o lote com saldo do material inativo (E9: estoque físico não some ao
    // inativar); não contam o lote zerado, o sem CA, o que dispensa CA, o que vence hoje e o material sem estoque
    // com CA legado vencido. O disponível continua só de material ativo.
    assert.deepEqual(a.caVencido, { permitido: true, valor: 3, aVencer: 2, diasAlerta: 60 });

    const b = (await get('masterB', '/api/dashboard/indicadores')).body.indicadores;
    assert.deepEqual([b.itensDisponiveis.valor, b.estoqueAbaixoMinimo.valor, b.caVencido.valor, b.caVencido.aVencer], [7, 0, 1, 0]);
  });

  test('abaixo do mínimo só quando há mínimo configurado e o disponível fica abaixo dele', async () => {
    const empresaC = (await pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Empresa Mínimo', '33444555000181') RETURNING id")).rows[0].id;
    const casos = [
      // [mínimo, lote com CA válido, lote sem CA (bloqueado)] -> disponível = lote com CA
      ['min 10, disponível 0', 10, 0, 3],
      ['min 10, disponível 5', 10, 5, 0],
      ['min 10, disponível 10', 10, 10, 0],
      ['min 0, disponível 0', 0, 0, 2],
      ['min 0, disponível 5', 0, 5, 0],
    ];
    for (const [nome, minimo, valido, semCa] of casos) {
      const id = (await pool.query('INSERT INTO materiais (empresa_id, nome, estoque_minimo) VALUES ($1, $2, $3) RETURNING id', [empresaC, nome, minimo])).rows[0].id;
      if (valido > 0) await inserirLote(pool, { empresaId: empresaC, materialId: id, tamanho: 'U', quantidade: valido, ca: '12345', validade: '2027-12-31' });
      if (semCa > 0) await inserirLote(pool, { empresaId: empresaC, materialId: id, tamanho: 'U', quantidade: semCa });
    }
    const r = await loteRepo.resumirIndicadores(pool, empresaC, { hoje: HOJE, diasAlerta: 60 });
    assert.deepEqual([r.disponivel, r.abaixoMinimo], [20, 2], 'só "min 10, disponível 0" e "min 10, disponível 5"');
  });

  test('fuso America/Sao_Paulo: à 00h30 de 01/10 o CA que venceu em 30/09 passa a bloquear', async () => {
    const lotes = (await get('masterA', `/api/materiais/${m.botina}/estoque/lotes`, appMadrugada)).body;
    assert.equal(lotes.hoje, '2026-10-01');
    assert.deepEqual(lotes.lotes.find((l) => l.tamanho === '41').situacaoCa, 'VENCIDO');
    const a = (await get('masterA', '/api/dashboard/indicadores', appMadrugada)).body.indicadores;
    assert.deepEqual([a.itensDisponiveis.valor, a.caVencido.valor, a.caVencido.aVencer], [43, 4, 1]);
  });
});
