'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { todasAsMigrations, criarGhe, criarMaterial, criarLote, inserir } = require('./helpers/entrega-epi');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const { criarEntregaEpiController } = require('../../src/controllers/entrega-epi.controller');
const { criarEntregaEpiRoutes } = require('../../src/routes/entrega-epi.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const entregaServico = require('../../src/services/entrega-epi.service');
const estoqueServico = require('../../src/services/estoque.service');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Rotas HTTP da entrega de EPI (10E) e da ficha (10F) contra PostgreSQL real:
 * sessão, autorização por AÇÃO (REALIZAR_ENTREGA) e por RECURSO
 * (epiFicha.visualizar), validação, contexto da entrega, gravação pelo
 * serviço transacional, leituras históricas, privacidade (CPF mascarado,
 * sem IP/User-Agent/hash da requisição) e isolamento entre empresas.
 */

const TODAS = todasAsMigrations();
const HOJE = dataOperacional();
const ONTEM = somarDias(HOJE, -1);
const SENHA = 'senha-forte-da-entrega-de-epi-2026';
const EMAILS = {
  masterA: 'master.a.entrega@exemplo-cliente.com.br',
  entregadorA: 'entregador.a@exemplo-cliente.com.br', // REALIZAR_ENTREGA individual; sem materials nem epiFicha
  leitorA: 'leitor.a@exemplo-cliente.com.br', // epiFicha.visualizar individual; sem REALIZAR_ENTREGA
  semNadaA: 'sem.nada.a@exemplo-cliente.com.br',
  masterB: 'master.b.entrega@exemplo-cliente.com.br',
};
const CPF = { a1: '52998224725', a2: '11144477735', inativo: '12345678909', b1: '98765432100' };
const CPFS_COMPLETOS = Object.values(CPF);
const DECLARACAO = 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).';
const TRACOS = [[[10, 10], [20, 12], [30, 15]], [[40, 40], [42, 41]]];
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };
const DESENHO = { modo: 'DESENHO', tracos: TRACOS, declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;

function somarDias(dataIso, dias) {
  const d = new Date(`${dataIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

// Nenhuma resposta pública pode carregar CPF completo, IP, User-Agent ou hash da requisição.
function semDadosSensiveis(corpo, rotulo = '') {
  const texto = JSON.stringify(corpo);
  for (const cpf of CPFS_COMPLETOS) assert.doesNotMatch(texto, new RegExp(cpf), `${rotulo} CPF completo`);
  for (const proibido of ['requisicaoHash', '"ip"', 'dispositivo', 'Agente de Teste', 'chaveIdempotencia', 'entregueEmCanonico', 'senha']) {
    assert.doesNotMatch(texto, new RegExp(proibido), `${rotulo} ${proibido}`);
  }
}

describe('rotas da entrega de EPI — 10E e 10F (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  const empresa = {};
  const u = {};
  const cookie = {};
  const d = {};

  const q = (sql, params) => pool.query(sql, params);
  const get = (quem, rota) => request(app).get(rota).set('Cookie', cookie[quem] || '');
  const post = (quem, rota, corpo) => request(app).post(rota).set('Cookie', cookie[quem] || '').set('User-Agent', 'Agente de Teste').send(corpo);
  const item = (extra = {}) => ({ materialId: d.botina, loteId: d.loteBotina40, quantidade: 1, motivo: 'ADMISSAO', ...extra });
  const corpo = (extra = {}) => ({ funcionarioId: d.funcA1, itens: [item()], confirmacao: ACEITE, chaveIdempotencia: crypto.randomUUID(), ...extra });
  const registrarDireto = (extra) => entregaServico.registrarEntrega(pool, {
    empresaId: empresa.A, atorId: u.masterA, funcionarioId: d.funcA1, itens: [item()], confirmacao: ACEITE, chaveIdempotencia: crypto.randomUUID(), ...extra,
  });

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);

    for (const [k, nome, cnpj] of [['A', 'Empresa Alfa Entregas Ltda', '11222333000181'], ['B', 'Empresa Beta Entregas Ltda', '22333444000100']]) {
      empresa[k] = (await q(
        "INSERT INTO empresas (nome, cnpj, endereco, numero, bairro, cidade, uf) VALUES ($1, $2, 'Rua Fictícia', '100', 'Industrial', 'Cidade Fictícia', 'SP') RETURNING id",
        [nome, cnpj],
      )).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[k], dryRun: false });
    }
    const vinculo = async (chave, empresaId, email, perfil) => {
      const id = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      u[chave] = (await q(
        'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id',
        [empresaId, `Usuário ${chave}`, perfil, id],
      )).rows[0].id;
    };
    await vinculo('masterA', empresa.A, EMAILS.masterA, 'MASTER');
    await vinculo('entregadorA', empresa.A, EMAILS.entregadorA, 'USUARIO');
    await vinculo('leitorA', empresa.A, EMAILS.leitorA, 'USUARIO');
    await vinculo('semNadaA', empresa.A, EMAILS.semNadaA, 'USUARIO');
    await vinculo('masterB', empresa.B, EMAILS.masterB, 'MASTER');

    // 10I: o MASTER depende SÓ do provisionamento oficial (nenhuma linha
    // inserida à mão); as concessões abaixo são dos usuários comuns.
    await q("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'REALIZAR_ENTREGA', $3)", [empresa.A, u.entregadorA, u.masterA]);
    await q("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por) VALUES ($1, $2, 'epiFicha', true, $3)", [empresa.A, u.leitorA, u.masterA]);

    d.gheA = await criarGhe(pool, empresa.A, 'GHE Produção');
    const funcionario = async (empresaId, valores) => (await inserir(pool, 'funcionarios', { empresa_id: empresaId, ...valores })).id;
    d.funcA1 = await funcionario(empresa.A, { matricula: 'A-001', nome: 'Ana Fictícia', cpf: CPF.a1, grupo_homogeneo_id: d.gheA, setor: 'Produção', funcao: 'Operadora' });
    d.funcA2 = await funcionario(empresa.A, { matricula: 'A-002', nome: 'Bruno Fictício', cpf: CPF.a2 });
    d.funcInativo = await funcionario(empresa.A, { matricula: 'A-003', nome: 'Carla Inativa', cpf: CPF.inativo, ativo: false });
    d.funcB1 = await funcionario(empresa.B, { matricula: 'B-001', nome: 'Beatriz da Beta', cpf: CPF.b1 });

    d.botina = await criarMaterial(pool, empresa.A, 'Botina de segurança', { tipo: 'Calçado', codigoInterno: 'BOT-01', unidade: 'par' });
    d.luva = await criarMaterial(pool, empresa.A, 'Luva nitrílica', { exigeTamanho: false, prazo: 90, codigoInterno: 'LUV-07' });
    d.uniforme = await criarMaterial(pool, empresa.A, 'Uniforme operacional', { exigeCa: false, exigeTamanho: true });
    d.semClassificacao = await criarMaterial(pool, empresa.A, 'Capacete sem classificação', { exigeTamanho: null });
    d.inativo = await criarMaterial(pool, empresa.A, 'Material inativo', { ativo: false, exigeTamanho: false });
    d.botinaB = await criarMaterial(pool, empresa.B, 'Botina da Beta');
    await inserir(pool, 'ghe_materiais', { empresa_id: empresa.A, grupo_homogeneo_id: d.gheA, material_id: d.botina });
    await inserir(pool, 'ghe_materiais', { empresa_id: empresa.A, grupo_homogeneo_id: d.gheA, material_id: d.luva });

    const loteA = (materialId, quantidade, extra = {}) => criarLote(pool, { empresaId: empresa.A, materialId, quantidade, ...extra });
    d.loteBotina40 = await loteA(d.botina, 10);
    d.loteBotina41 = await loteA(d.botina, 5, { tamanho: '41', caValidade: '2030-06-30' });
    d.loteBotinaZerado = await loteA(d.botina, 3, { tamanho: '42' });
    await estoqueServico.registrarBaixa(pool, { empresaId: empresa.A, atorId: u.masterA, loteId: d.loteBotinaZerado, quantidade: 3, motivo: 'AVARIA', chaveIdempotencia: crypto.randomUUID() });
    d.loteLuvaValido = await loteA(d.luva, 20, { tamanho: null, caNumero: '501', caValidade: '2099-12-31' });
    d.loteLuvaVenceHoje = await loteA(d.luva, 5, { tamanho: null, caNumero: '502', caValidade: HOJE });
    d.loteLuvaVencido = await loteA(d.luva, 5, { tamanho: null, caNumero: '503', caValidade: ONTEM });
    d.loteLuvaSemCa = await loteA(d.luva, 5, { tamanho: null, caNumero: null, caValidade: null });
    d.loteUniforme = await loteA(d.uniforme, 8, { tamanho: 'G', caNumero: null, caValidade: null });
    d.loteB = await criarLote(pool, { empresaId: empresa.B, materialId: d.botinaB, quantidade: 6 });

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarEstoqueRoutes({ controller: criarEstoqueController({ pool }), exigirSessao, pool }),
        criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao, pool }),
        criarEntregaEpiRoutes({ controller: criarEntregaEpiController({ pool }), exigirSessao, pool }),
      );
    });
    for (const k of Object.keys(EMAILS)) {
      const login = await request(app).post('/api/auth/global/login').send({ email: EMAILS[k], senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const c = cookiesDe(login);
      cookie[k] = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
    }

    // Histórico: duas entregas da Ana (ficha 1), uma do Bruno (ficha 2), uma na Beta.
    d.entregaA1 = await registrarDireto({ itens: [item({ quantidade: 2 })], confirmacao: DESENHO, ip: '203.0.113.5', dispositivo: 'Navegador Antigo' });
    d.entregaA1b = await registrarDireto({ itens: [item({ materialId: d.luva, loteId: d.loteLuvaValido, motivo: 'SUBSTITUICAO_PRAZO' }), item({ materialId: d.uniforme, loteId: d.loteUniforme, justificativaForaGhe: 'Visita à área externa' })] });
    d.entregaA2 = await registrarDireto({ funcionarioId: d.funcA2, itens: [item({ justificativaForaGhe: 'Sem GHE definido' })] });
    d.entregaB = await entregaServico.registrarEntrega(pool, {
      empresaId: empresa.B, atorId: u.masterB, funcionarioId: d.funcB1, chaveIdempotencia: crypto.randomUUID(), confirmacao: ACEITE,
      itens: [{ materialId: d.botinaB, loteId: d.loteB, quantidade: 1, motivo: 'ADMISSAO', justificativaForaGhe: 'Sem GHE' }],
    });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('10I — provisionamento oficial do MASTER cobre ficha e entrega', () => {
    test('empresa provisionada só pelo serviço: linhas de perfil MASTER para epiFicha (visualizar) e REALIZAR_ENTREGA; MASTER acessa ficha e contexto', async () => {
      const { rows: recursosMaster } = await q(
        "SELECT recurso, pode_visualizar v, pode_criar c, pode_editar e, pode_excluir x FROM permissoes_recurso WHERE empresa_id = $1 AND perfil = 'MASTER' AND recurso = 'epiFicha'",
        [empresa.A],
      );
      assert.deepEqual(recursosMaster, [{ recurso: 'epiFicha', v: true, c: false, e: false, x: false }]);
      const { rows: acoesMaster } = await q(
        "SELECT acao_codigo, permitido FROM permissoes_acao WHERE empresa_id = $1 AND perfil = 'MASTER' ORDER BY acao_codigo",
        [empresa.A],
      );
      assert.deepEqual(acoesMaster, [{ acao_codigo: 'MOVIMENTAR_ESTOQUE', permitido: true }, { acao_codigo: 'REALIZAR_ENTREGA', permitido: true }]);
      assert.equal((await get('masterA', '/api/fichas-epi')).status, 200);
      assert.equal((await get('masterA', '/api/entregas-epi/contexto/funcionarios')).status, 200);
      assert.equal((await get('masterB', '/api/fichas-epi')).status, 200);
      assert.equal((await get('masterB', '/api/entregas-epi/contexto/funcionarios')).status, 200);
    });

    test('empresa antiga sem as linhas: provisionar a empresa existente insere epiFicha e REALIZAR_ENTREGA; repetir não duplica; nenhum outro perfil ganha', async () => {
      const empresaC = (await q(
        "INSERT INTO empresas (nome, cnpj, endereco, numero, bairro, cidade, uf) VALUES ('Empresa Gama Antiga Ltda', '33444555000160', 'Rua Fictícia', '300', 'Industrial', 'Cidade Fictícia', 'SP') RETURNING id",
      )).rows[0].id;
      const primeira = await provisionamento.provisionar(pool, { empresaId: empresaC, dryRun: false });
      assert.ok(primeira.inseridos.recursos.includes('epiFicha'));
      assert.ok(primeira.inseridos.acoes.includes('REALIZAR_ENTREGA'));
      const segunda = await provisionamento.provisionar(pool, { empresaId: empresaC, dryRun: false });
      assert.deepEqual(segunda.inseridos, { recursos: [], acoes: [] });
      const situacao = Object.fromEntries(segunda.plano.recursos.map((r) => [r.recurso, r.situacao]));
      assert.equal(situacao.epiFicha, 'ADEQUADA');
      const n = (await q("SELECT count(*)::int AS n FROM permissoes_recurso WHERE empresa_id = $1 AND recurso = 'epiFicha'", [empresaC])).rows[0].n;
      assert.equal(n, 1);
      // Fora do provisionamento nada muda: nenhum outro perfil ganha a ficha.
      const outros = (await q("SELECT count(*)::int AS n FROM permissoes_recurso WHERE perfil <> 'MASTER' AND recurso = 'epiFicha'")).rows[0].n;
      assert.equal(outros, 0);
    });
  });

  describe('montagem e cadeia de segurança', () => {
    test('sem sessão: 401 em todos os endpoints novos, mesmo com corpo inválido; rota inexistente sob /api: 404 ROTA_NAO_ENCONTRADA', async () => {
      const rotas = [
        ['post', '/api/entregas-epi', { corpo: 'inválido' }],
        ['get', `/api/entregas-epi/contexto/${d.funcA1}`],
        ['get', `/api/entregas-epi/contexto/${d.funcA1}/materiais`],
        ['get', `/api/entregas-epi/contexto/${d.funcA1}/materiais/${d.botina}/lotes`],
        ['get', '/api/fichas-epi'],
        ['post', '/api/fichas-epi/consulta-cpf', { cpf: CPF.a1 }],
        ['get', `/api/fichas-epi/${d.entregaA1.ficha.id}`],
        ['get', `/api/fichas-epi/${d.entregaA1.ficha.id}/entregas`],
        ['get', `/api/entregas-epi/${d.entregaA1.entrega.id}`],
      ];
      for (const [metodo, rota, c] of rotas) {
        const r = metodo === 'get' ? await request(app).get(rota) : await request(app).post(rota).send(c);
        assert.equal(r.status, 401, `${metodo} ${rota} ${JSON.stringify(r.body)}`);
      }
      const nada = await get('masterA', `/api/fichas-epi/${d.entregaA1.ficha.id}/inexistente`);
      assert.deepEqual([nada.status, nada.body.codigo], [404, 'ROTA_NAO_ENCONTRADA']);
      const contextoSemId = await get('masterA', '/api/entregas-epi/contexto');
      assert.deepEqual([contextoSemId.status, contextoSemId.body.codigo], [400, 'VALIDACAO'], 'cai em /entregas-epi/:id com id inválido');
    });

    test('validação vem depois da autorização: sem permissão, corpo inválido recebe 403, não 400; com permissão, 400 passa pelo errorHandler no formato do projeto', async () => {
      const semPermissao = await post('semNadaA', '/api/entregas-epi', { corpo: 'inválido' });
      assert.deepEqual([semPermissao.status, semPermissao.body.codigo], [403, 'PERMISSAO_NEGADA']);
      const invalido = await post('entregadorA', '/api/entregas-epi', { corpo: 'inválido' });
      assert.deepEqual([invalido.status, invalido.body.status, invalido.body.codigo], [400, 'error', 'VALIDACAO']);
      assert.ok(Array.isArray(invalido.body.detalhes));
      const idInvalido = await get('masterA', '/api/fichas-epi/abc');
      assert.deepEqual([idInvalido.status, idInvalido.body.codigo], [400, 'VALIDACAO']);
    });
  });

  describe('autorização', () => {
    const contextoRotas = () => [
      '/api/entregas-epi/contexto/funcionarios',
      `/api/entregas-epi/contexto/${d.funcA1}`,
      `/api/entregas-epi/contexto/${d.funcA1}/materiais`,
      `/api/entregas-epi/contexto/${d.funcA1}/materiais/${d.botina}/lotes`,
    ];
    const leituraRotas = () => [
      '/api/fichas-epi',
      `/api/fichas-epi/${d.entregaA1.ficha.id}`,
      `/api/fichas-epi/${d.entregaA1.ficha.id}/entregas`,
      `/api/entregas-epi/${d.entregaA1.entrega.id}`,
    ];

    test('A) REALIZAR_ENTREGA individual sem materials.visualizar: contexto, materiais, lotes e POST liberados; a rota de lotes por material continua 403', async () => {
      for (const rota of contextoRotas()) {
        const r = await get('entregadorA', rota);
        assert.equal(r.status, 200, `${rota} ${JSON.stringify(r.body)}`);
      }
      const materiais = await get('entregadorA', `/api/materiais/${d.botina}/estoque/lotes`);
      assert.deepEqual([materiais.status, materiais.body.codigo], [403, 'PERMISSAO_NEGADA']);
      const r = await post('entregadorA', '/api/entregas-epi', corpo({ funcionarioId: d.funcA2, itens: [item({ justificativaForaGhe: 'Sem GHE definido' })] }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });

    test('B) sem REALIZAR_ENTREGA (inclusive quem só lê fichas): 403 nos endpoints de contexto, na consulta de CPF do contexto e no POST', async () => {
      for (const quem of ['semNadaA', 'leitorA']) {
        for (const rota of contextoRotas()) {
          const r = await get(quem, rota);
          assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], `${quem} ${rota}`);
        }
        const cpf = await post(quem, '/api/entregas-epi/contexto/consulta-cpf', { cpf: CPF.a1 });
        assert.deepEqual([cpf.status, cpf.body.codigo], [403, 'PERMISSAO_NEGADA'], quem);
        const r = await post(quem, '/api/entregas-epi', corpo());
        assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], quem);
      }
    });

    test('C) epiFicha.visualizar individual sem REALIZAR_ENTREGA: leituras históricas 200; contexto e gravação 403', async () => {
      for (const rota of leituraRotas()) {
        const r = await get('leitorA', rota);
        assert.equal(r.status, 200, `${rota} ${JSON.stringify(r.body)}`);
      }
      const cpf = await post('leitorA', '/api/fichas-epi/consulta-cpf', { cpf: CPF.a1 });
      assert.equal(cpf.status, 200, JSON.stringify(cpf.body));
    });

    test('D) REALIZAR_ENTREGA sem epiFicha.visualizar: leituras históricas 403', async () => {
      for (const rota of leituraRotas()) {
        const r = await get('entregadorA', rota);
        assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], rota);
      }
      const cpf = await post('entregadorA', '/api/fichas-epi/consulta-cpf', { cpf: CPF.a1 });
      assert.deepEqual([cpf.status, cpf.body.codigo], [403, 'PERMISSAO_NEGADA']);
    });

    test('bloqueio individual da ação nega mesmo com autorização individual; removido, volta a permitir', async () => {
      await q("INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por) VALUES ($1, 'REALIZAR_ENTREGA', $2)", [u.entregadorA, u.masterA]);
      const bloqueado = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}`);
      assert.deepEqual([bloqueado.status, bloqueado.body.codigo], [403, 'PERMISSAO_NEGADA']);
      await q("DELETE FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = 'REALIZAR_ENTREGA'", [u.entregadorA]);
      assert.equal((await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}`)).status, 200);
    });
  });

  describe('POST /api/entregas-epi', () => {
    test('201 com a entrega pública: ficha, snapshots, itens com lote histórico sem saldo, confirmação sem IP/dispositivo, hashConteudo; empresa e responsável vêm da sessão; IP e User-Agent vão para a auditoria e a confirmação', async () => {
      const chave = crypto.randomUUID();
      const r = await post('entregadorA', '/api/entregas-epi', corpo({ chaveIdempotencia: chave, itens: [item({ loteId: d.loteBotina41, quantidade: 2 })], confirmacao: DESENHO }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const { entrega } = r.body;
      assert.deepEqual([r.body.status, r.body.repetida], ['ok', false]);
      assert.deepEqual([entrega.ficha.id, entrega.ficha.numero], [d.entregaA1.ficha.id, 1]);
      assert.deepEqual(entrega.empresa, { nome: 'Empresa Alfa Entregas Ltda', cnpj: '11222333000181', endereco: 'Rua Fictícia, 100 - Industrial', cidade: 'Cidade Fictícia', uf: 'SP' });
      assert.deepEqual(entrega.trabalhador, { nome: 'Ana Fictícia', matricula: 'A-001', funcao: 'Operadora', setor: 'Produção' });
      assert.deepEqual([entrega.ghe, entrega.responsavel], [{ id: d.gheA, nome: 'GHE Produção' }, { id: u.entregadorA, nome: 'Usuário entregadorA' }]);
      assert.deepEqual([entrega.origem, entrega.dataOperacional], ['DIRETA', HOJE]);
      assert.deepEqual(entrega.itens.map((i) => [i.loteId, i.quantidade, i.previstoNoGhe, Object.keys(i.lote).sort()]), [[d.loteBotina41, 2, true, ['caNumero', 'caValidade', 'tamanho']]]);
      assert.deepEqual(Object.keys(entrega.confirmacao).sort(), ['confirmadaEm', 'declaracaoTexto', 'declaracaoVersao', 'hashConteudo', 'modo', 'tracos']);
      assert.match(entrega.confirmacao.hashConteudo, /^[0-9a-f]{64}$/);
      assert.equal(Object.hasOwn(entrega, 'chaveIdempotencia'), false);
      semDadosSensiveis(r.body, 'POST');

      const { rows: [gravada] } = await q('SELECT empresa_id, responsavel_id FROM entregas_epi WHERE id = $1', [entrega.id]);
      assert.deepEqual(gravada, { empresa_id: empresa.A, responsavel_id: u.entregadorA });
      const { rows: [confirmacao] } = await q('SELECT ip, dispositivo FROM entregas_epi_confirmacoes WHERE entrega_id = $1', [entrega.id]);
      assert.deepEqual([confirmacao.dispositivo, typeof confirmacao.ip === 'string' && confirmacao.ip.length > 0], ['Agente de Teste', true]);
      const { rows: [auditoria] } = await q("SELECT usuario_id, dispositivo, contexto FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'ENTREGA_REGISTRADA' AND referencia = $2", [empresa.A, String(entrega.id)]);
      assert.deepEqual([auditoria.usuario_id, auditoria.dispositivo, auditoria.contexto.idempotencia.chave], [u.entregadorA, 'Agente de Teste', chave]);
      d.entregaHttp = entrega;
      d.chaveHttp = chave;
    });

    test('200 na repetição legítima (mesma chave, mesmo conteúdo), com o mesmo conteúdo histórico; 409 IDEMPOTENCIA_CONFLITO quando o conteúdo muda', async () => {
      const repetida = await post('entregadorA', '/api/entregas-epi', corpo({ chaveIdempotencia: d.chaveHttp, itens: [item({ loteId: d.loteBotina41, quantidade: 2 })], confirmacao: DESENHO }));
      assert.equal(repetida.status, 200, JSON.stringify(repetida.body));
      assert.deepEqual([repetida.body.repetida, repetida.body.entrega], [true, d.entregaHttp]);
      const conflito = await post('entregadorA', '/api/entregas-epi', corpo({ chaveIdempotencia: d.chaveHttp, itens: [item({ loteId: d.loteBotina41, quantidade: 1 })], confirmacao: DESENHO }));
      assert.deepEqual([conflito.status, conflito.body.codigo], [409, 'IDEMPOTENCIA_CONFLITO']);
    });

    test('erros de negócio do serviço chegam com o status e o código: 404 trabalhador de outra empresa, 409 saldo, 409 fora do GHE, 409 inativo', async () => {
      const casos = [
        [corpo({ funcionarioId: d.funcB1 }), 404, 'FUNCIONARIO_NAO_ENCONTRADO'],
        [corpo({ funcionarioId: d.funcInativo }), 409, 'FUNCIONARIO_INATIVO'],
        [corpo({ itens: [item({ quantidade: 999 })] }), 409, 'SALDO_INSUFICIENTE'],
        [corpo({ itens: [item({ materialId: d.uniforme, loteId: d.loteUniforme })] }), 409, 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA'],
        [corpo({ itens: [item({ materialId: d.luva, loteId: d.loteLuvaVencido })] }), 409, 'CA_VENCIDO'],
        [corpo({ itens: [item({ materialId: d.luva, loteId: d.loteBotina40 })] }), 409, 'LOTE_MATERIAL_DIVERGENTE'],
        [corpo({ itens: [item({ materialId: d.semClassificacao, loteId: d.loteBotina40, justificativaForaGhe: 'x' })] }), 409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO'],
      ];
      for (const [c, status, codigo] of casos) {
        const r = await post('masterA', '/api/entregas-epi', c);
        assert.deepEqual([r.status, r.body.codigo], [status, codigo], JSON.stringify(r.body));
        assert.equal(Object.hasOwn(r.body, 'stack'), false);
      }
    });

    test('campos do servidor enviados pelo cliente: 400 CAMPO_NAO_PERMITIDO (empresaId, atorId, entregueEm, dataOperacional, snapshots, previstoNoGhe, hashConteudo)', async () => {
      const proibidos = [
        { empresaId: empresa.B }, { atorId: u.masterB }, { responsavelId: u.masterB }, { entregueEm: '2020-01-01T00:00:00Z' }, { dataOperacional: '2020-01-01' },
        { origem: 'SOLICITACAO' }, { fichaId: 1 }, { empresa: { nome: 'Outra' } }, { trabalhador: { nome: 'Outro' } }, { hashConteudo: 'a'.repeat(64) }, { requisicaoHash: 'a'.repeat(64) },
      ];
      for (const extra of proibidos) {
        const r = await post('masterA', '/api/entregas-epi', corpo(extra));
        assert.equal(r.status, 400, JSON.stringify(extra));
        assert.ok(r.body.detalhes.some((det) => det.codigo === 'CAMPO_NAO_PERMITIDO'), JSON.stringify(r.body.detalhes));
      }
      const item2 = await post('masterA', '/api/entregas-epi', corpo({ itens: [item({ previstoNoGhe: true })] }));
      assert.ok(item2.body.detalhes.some((det) => det.campo === 'body.itens.0.previstoNoGhe' && det.codigo === 'CAMPO_NAO_PERMITIDO'));
      const snapshot = await post('masterA', '/api/entregas-epi', corpo({ itens: [item({ material: { nome: 'x' } })] }));
      assert.equal(snapshot.status, 400);
    });

    test('schema pela rota: 21 itens, quantidade zero, motivo inválido, OUTRO sem justificativa, UUID inválido, DESENHO sem traços, ACEITE com traços, declaração vazia e declaração de 4001 caracteres', async () => {
      const itens = (n) => Array.from({ length: n }, (_, i) => item({ loteId: i + 1 }));
      const casos = [
        [corpo({ itens: itens(21) }), 'body.itens', 'TAMANHO_MAXIMO'],
        [corpo({ itens: [] }), 'body.itens', 'TAMANHO_MINIMO'],
        [corpo({ itens: [item({ quantidade: 0 })] }), 'body.itens.0.quantidade', 'TAMANHO_MINIMO'],
        [corpo({ itens: [item({ quantidade: 2147483648 })] }), 'body.itens.0.quantidade', 'TAMANHO_MAXIMO'],
        [corpo({ itens: [item({ motivo: 'TROCA' })] }), 'body.itens.0.motivo', 'VALOR_NAO_PERMITIDO'],
        [corpo({ itens: [item({ motivo: 'OUTRO' })] }), 'body.itens.0.justificativa', 'JUSTIFICATIVA_OBRIGATORIA'],
        [corpo({ chaveIdempotencia: 'abc' }), 'body.chaveIdempotencia', 'FORMATO_INVALIDO'],
        [corpo({ confirmacao: { ...DESENHO, tracos: undefined } }), 'body.confirmacao.tracos', 'TRACOS_OBRIGATORIOS'],
        [corpo({ confirmacao: { ...DESENHO, tracos: [[[1, 2, 3]]] } }), 'body.confirmacao.tracos', 'TRACOS_INVALIDOS'],
        [corpo({ confirmacao: { ...ACEITE, tracos: TRACOS } }), 'body.confirmacao.tracos', 'TRACOS_NAO_SE_APLICAM'],
        [corpo({ confirmacao: { ...ACEITE, declaracaoVersao: 'nr6' } }), 'body.confirmacao.declaracaoVersao', 'FORMATO_INVALIDO'],
        [corpo({ confirmacao: { ...ACEITE, declaracaoTexto: '' } }), 'body.confirmacao.declaracaoTexto', 'DECLARACAO_INVALIDA'],
        [corpo({ confirmacao: { ...ACEITE, declaracaoTexto: 'x'.repeat(4001) } }), 'body.confirmacao.declaracaoTexto', 'DECLARACAO_INVALIDA'],
        [corpo({ funcionarioId: 0 }), 'body.funcionarioId', 'ID_INVALIDO'],
      ];
      for (const [c, campo, codigo] of casos) {
        const r = await post('masterA', '/api/entregas-epi', c);
        assert.equal(r.status, 400, JSON.stringify([campo, codigo, r.body]));
        assert.ok(r.body.detalhes.some((det) => det.campo === campo && det.codigo === codigo), JSON.stringify([campo, codigo, r.body.detalhes]));
      }
      const semCorpo = await request(app).post('/api/entregas-epi').set('Cookie', cookie.masterA).set('Content-Type', 'application/json');
      assert.equal(semCorpo.status, 400);
    });

    test('20 itens e 4000 caracteres fora do BMP na declaração: aceitos de ponta a ponta', async () => {
      const lotes = [];
      for (let i = 0; i < 20; i += 1) {
        lotes.push(await criarLote(pool, { empresaId: empresa.A, materialId: d.luva, quantidade: 1, tamanho: null, caNumero: '600', caValidade: '2099-12-31' }));
      }
      const astral = '\u{1D400}'.repeat(4000);
      const r = await post('masterA', '/api/entregas-epi', corpo({
        itens: lotes.map((loteId) => item({ materialId: d.luva, loteId })),
        confirmacao: { ...ACEITE, declaracaoTexto: astral },
      }));
      assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
      assert.deepEqual([r.body.entrega.itens.length, r.body.entrega.confirmacao.declaracaoTexto === astral], [20, true]);
    });
  });

  describe('localizar trabalhador para a entrega (10H)', () => {
    test('GET /entregas-epi/contexto/funcionarios: só ativos da empresa, com GHE e CPF mascarado; busca por nome ou matrícula; paginação; sem depender de employeeHistory', async () => {
      const r = await get('entregadorA', '/api/entregas-epi/contexto/funcionarios?limite=100');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const ids = r.body.funcionarios.map((f) => f.id);
      assert.deepEqual([ids.includes(d.funcA1), ids.includes(d.funcA2), ids.includes(d.funcInativo), ids.includes(d.funcB1)], [true, true, false, false]);
      const ana = r.body.funcionarios.find((f) => f.id === d.funcA1);
      assert.deepEqual(ana, { id: d.funcA1, nome: 'Ana Fictícia', matricula: 'A-001', cpfMascarado: '***.***.***-25', setor: 'Produção', funcao: 'Operadora', ghe: { id: d.gheA, nome: 'GHE Produção' } });
      assert.equal(r.body.funcionarios.find((f) => f.id === d.funcA2).ghe, null);
      assert.deepEqual([r.body.pagina, r.body.limite, r.body.total], [1, 100, r.body.funcionarios.length]);
      semDadosSensiveis(r.body, 'contexto/funcionarios');
      const semPermissaoDeHistorico = await get('entregadorA', '/api/funcionarios?busca=Ana');
      assert.deepEqual([semPermissaoDeHistorico.status, semPermissaoDeHistorico.body.codigo], [403, 'PERMISSAO_NEGADA'], 'employeeHistory continua negado a quem só entrega');

      const porNome = await get('entregadorA', `/api/entregas-epi/contexto/funcionarios?busca=${encodeURIComponent('ana f')}`);
      assert.deepEqual(porNome.body.funcionarios.map((f) => f.id), [d.funcA1]);
      const porMatricula = await get('entregadorA', '/api/entregas-epi/contexto/funcionarios?busca=A-002');
      assert.deepEqual(porMatricula.body.funcionarios.map((f) => f.id), [d.funcA2]);
      for (const coringa of ['%', '_', '\\']) {
        const c = await get('entregadorA', `/api/entregas-epi/contexto/funcionarios?busca=${encodeURIComponent(coringa)}`);
        assert.deepEqual([c.status, c.body.total], [200, 0], coringa);
      }
      const porCpf = await get('entregadorA', `/api/entregas-epi/contexto/funcionarios?busca=${CPF.a1}`);
      assert.deepEqual([porCpf.status, porCpf.body.total], [200, 0], 'CPF não é critério de busca');
      const naQuery = await get('entregadorA', `/api/entregas-epi/contexto/funcionarios?cpf=${CPF.a1}`);
      assert.equal(naQuery.status, 400);
      const pagina = await get('entregadorA', '/api/entregas-epi/contexto/funcionarios?limite=1&pagina=2');
      assert.deepEqual([pagina.body.funcionarios.length, pagina.body.pagina, pagina.body.total], [1, 2, r.body.total]);
      const daBeta = await get('masterB', '/api/entregas-epi/contexto/funcionarios?limite=100');
      assert.deepEqual(daBeta.body.funcionarios.map((f) => f.nome), ['Beatriz da Beta']);
    });

    test('POST /entregas-epi/contexto/consulta-cpf: CPF só no corpo, com DV; resposta mascarada; outra empresa 404; inativo 409; CPF na URL não existe', async () => {
      const r = await post('entregadorA', '/api/entregas-epi/contexto/consulta-cpf', { cpf: '529.982.247-25' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.funcionario, { id: d.funcA1, nome: 'Ana Fictícia', matricula: 'A-001', cpfMascarado: '***.***.***-25', setor: 'Produção', funcao: 'Operadora', ghe: { id: d.gheA, nome: 'GHE Produção' } });
      semDadosSensiveis(r.body, 'contexto/consulta-cpf');
      const outraEmpresa = await post('entregadorA', '/api/entregas-epi/contexto/consulta-cpf', { cpf: CPF.b1 });
      assert.deepEqual([outraEmpresa.status, outraEmpresa.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      const daBeta = await post('masterB', '/api/entregas-epi/contexto/consulta-cpf', { cpf: CPF.a1 });
      assert.equal(daBeta.status, 404);
      const inativo = await post('entregadorA', '/api/entregas-epi/contexto/consulta-cpf', { cpf: CPF.inativo });
      assert.deepEqual([inativo.status, inativo.body.codigo], [409, 'FUNCIONARIO_INATIVO']);
      const dvInvalido = await post('entregadorA', '/api/entregas-epi/contexto/consulta-cpf', { cpf: '52998224726' });
      assert.equal(dvInvalido.status, 400);
      const extra = await post('entregadorA', '/api/entregas-epi/contexto/consulta-cpf', { cpf: CPF.a1, empresaId: empresa.B });
      assert.equal(extra.status, 400);
      const naUrl = await get('entregadorA', `/api/entregas-epi/contexto/consulta-cpf/${CPF.a1}`);
      assert.notEqual(naUrl.status, 200);
      const semSessao = await request(app).post('/api/entregas-epi/contexto/consulta-cpf').send({ cpf: CPF.a1 });
      assert.equal(semSessao.status, 401);
    });
  });

  describe('contexto da entrega', () => {
    test('trabalhador com GHE e ficha: funcionário com CPF mascarado, GHE atual e ficha existente', async () => {
      const r = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.funcionario, { id: d.funcA1, nome: 'Ana Fictícia', matricula: 'A-001', cpfMascarado: '***.***.***-25', setor: 'Produção', funcao: 'Operadora', ativo: true });
      assert.deepEqual(r.body.ghe, { id: d.gheA, nome: 'GHE Produção' });
      assert.deepEqual([r.body.ficha.id, r.body.ficha.numero, typeof r.body.ficha.criadaEm], [d.entregaA1.ficha.id, 1, 'string']);
      semDadosSensiveis(r.body, 'contexto');
    });

    test('trabalhador sem GHE e sem ficha: ghe e ficha nulos; inativo: 409 FUNCIONARIO_INATIVO; outra empresa e inexistente: 404', async () => {
      const novo = (await inserir(pool, 'funcionarios', { empresa_id: empresa.A, matricula: 'A-010', nome: 'Novo Sem Ficha', cpf: '39053344705' })).id;
      const r = await get('masterA', `/api/entregas-epi/contexto/${novo}`);
      assert.deepEqual([r.status, r.body.ghe, r.body.ficha, r.body.funcionario.cpfMascarado], [200, null, null, '***.***.***-05']);
      const inativo = await get('masterA', `/api/entregas-epi/contexto/${d.funcInativo}`);
      assert.deepEqual([inativo.status, inativo.body.codigo], [409, 'FUNCIONARIO_INATIVO']);
      const outra = await get('masterA', `/api/entregas-epi/contexto/${d.funcB1}`);
      assert.deepEqual([outra.status, outra.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      const inexistente = await get('masterA', '/api/entregas-epi/contexto/999999');
      assert.deepEqual([inexistente.status, inexistente.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
    });

    test('materiais do contexto: só ativos da empresa, com previstoNoGhe pelo GHE do trabalhador, campos de seleção, busca por nome/código e paginação', async () => {
      const r = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais?limite=100`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const porId = new Map(r.body.materiais.map((m) => [m.id, m]));
      assert.equal(porId.has(d.inativo), false, 'inativo não aparece');
      assert.equal(porId.has(d.botinaB), false, 'outra empresa não aparece');
      assert.deepEqual(porId.get(d.botina), { id: d.botina, nome: 'Botina de segurança', codigoInterno: 'BOT-01', tipo: 'Calçado', unidade: 'par', prazoUsoDias: 180, exigeTamanho: true, oculosComGrau: null, exigeCa: true, previstoNoGhe: true });
      assert.deepEqual([porId.get(d.luva).previstoNoGhe, porId.get(d.uniforme).previstoNoGhe, porId.get(d.semClassificacao).exigeTamanho], [true, false, null]);
      assert.deepEqual(r.body.materiais.map((m) => m.nome), [...r.body.materiais.map((m) => m.nome)].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })));
      assert.deepEqual([r.body.total, r.body.pagina, r.body.limite], [r.body.materiais.length, 1, 100]);

      const previstos = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais?previstoNoGhe=true`);
      assert.deepEqual(previstos.body.materiais.map((m) => m.id).sort((a, b) => a - b), [d.botina, d.luva].sort((a, b) => a - b));
      const fora = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais?previstoNoGhe=false`);
      assert.equal(fora.body.materiais.every((m) => m.previstoNoGhe === false && ![d.botina, d.luva].includes(m.id)), true);
      const busca = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais?busca=lUv-0`);
      assert.deepEqual(busca.body.materiais.map((m) => m.id), [d.luva]);
      const nome = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais?busca=${encodeURIComponent('botina')}`);
      assert.deepEqual(nome.body.materiais.map((m) => m.id), [d.botina]);
      const coringa = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais?busca=${encodeURIComponent('%')}`);
      assert.deepEqual([coringa.status, coringa.body.total], [200, 0]);
      const pagina = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais?limite=2&pagina=2`);
      assert.deepEqual([pagina.body.materiais.length, pagina.body.pagina, pagina.body.total], [2, 2, r.body.total]);
      const semGhe = await get('masterA', `/api/entregas-epi/contexto/${d.funcA2}/materiais?limite=100`);
      assert.equal(semGhe.body.materiais.every((m) => m.previstoNoGhe === false), true);
      const empresaNaQuery = await get('masterA', `/api/entregas-epi/contexto/${d.funcA1}/materiais?empresaId=${empresa.B}`);
      assert.equal(empresaNaQuery.status, 400);
    });

    test('lotes do contexto: só lotes com saldo do material da empresa, com tamanho, CA, validade, saldo e situação do CA; ordem por validade mais próxima; zerado, outra empresa e outro material fora', async () => {
      const r = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais/${d.luva}/lotes`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.lotes.map((l) => [l.loteId, l.situacaoCa]).filter(([id]) => [d.loteLuvaVencido, d.loteLuvaVenceHoje, d.loteLuvaValido, d.loteLuvaSemCa].includes(id)), [
        [d.loteLuvaVencido, 'VENCIDO'], [d.loteLuvaVenceHoje, 'VENCE_HOJE'], [d.loteLuvaValido, 'VALIDO'], [d.loteLuvaSemCa, 'SEM_CA'],
      ]);
      const valido = r.body.lotes.find((l) => l.loteId === d.loteLuvaValido);
      assert.deepEqual(valido, { loteId: d.loteLuvaValido, tamanho: null, caNumero: '501', caValidade: '2099-12-31', saldo: valido.saldo, situacaoCa: 'VALIDO' });
      assert.ok(valido.saldo >= 1);

      const botina = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais/${d.botina}/lotes`);
      const ids = botina.body.lotes.map((l) => l.loteId);
      assert.deepEqual([ids.includes(d.loteBotinaZerado), ids.includes(d.loteLuvaValido), ids.includes(d.loteB)], [false, false, false]);
      assert.deepEqual(ids, [d.loteBotina41, d.loteBotina40], 'validade 2030 antes de 2099');
      const uniforme = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais/${d.uniforme}/lotes`);
      assert.deepEqual(uniforme.body.lotes.map((l) => [l.loteId, l.situacaoCa, l.caNumero]), [[d.loteUniforme, 'NAO_EXIGE_CA', null]]);
      const outraEmpresa = await get('entregadorA', `/api/entregas-epi/contexto/${d.funcA1}/materiais/${d.botinaB}/lotes`);
      assert.deepEqual([outraEmpresa.status, outraEmpresa.body.codigo], [404, 'MATERIAL_NAO_ENCONTRADO']);
      const trabalhadorDeOutra = await get('masterB', `/api/entregas-epi/contexto/${d.funcA1}/materiais/${d.botina}/lotes`);
      assert.equal(trabalhadorDeOutra.status, 404);
    });
  });

  describe('10F — fichas e histórico', () => {
    test('GET /fichas-epi: paginado, ordenado pela última entrega, com funcionário atual mascarado e resumo', async () => {
      const r = await get('leitorA', '/api/fichas-epi');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.pagina, r.body.limite, r.body.total, r.body.fichas.length], [1, 20, 2, 2]);
      const ana = r.body.fichas.find((f) => f.id === d.entregaA1.ficha.id);
      assert.deepEqual([ana.numero, ana.funcionarioAtual.nome, ana.funcionarioAtual.cpfMascarado, ana.funcionarioAtual.ativo], [1, 'Ana Fictícia', '***.***.***-25', true]);
      assert.ok(ana.resumo.totalEntregas >= 3 && ana.resumo.totalItens >= 4 && typeof ana.resumo.ultimaEntregaEm === 'string');
      const ordem = r.body.fichas.map((f) => f.resumo.ultimaEntregaEm);
      assert.deepEqual(ordem, [...ordem].sort().reverse());
      const pagina = await get('leitorA', '/api/fichas-epi?limite=1&pagina=2');
      assert.deepEqual([pagina.body.fichas.length, pagina.body.total, pagina.body.pagina], [1, 2, 2]);
      semDadosSensiveis(r.body, 'fichas');
    });

    test('filtros: busca por nome, matrícula, material histórico e código histórico; numero; funcionarioId; materialId; ativo atual; período; período invertido 400', async () => {
      const ids = async (query) => {
        const r = await get('leitorA', `/api/fichas-epi?${query}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        return r.body.fichas.map((f) => f.id);
      };
      const fichaAna = d.entregaA1.ficha.id;
      const fichaBruno = d.entregaA2.ficha.id;
      assert.deepEqual(await ids('busca=Ana'), [fichaAna]);
      assert.deepEqual(await ids('busca=A-002'), [fichaBruno]);
      assert.deepEqual(await ids('busca=Uniforme'), [fichaAna]);
      assert.deepEqual(await ids('busca=LUV-07'), [fichaAna]);
      assert.deepEqual(await ids(`busca=${encodeURIComponent('%')}`), []);
      assert.deepEqual(await ids('numero=2'), [fichaBruno]);
      assert.deepEqual(await ids(`funcionarioId=${d.funcA2}`), [fichaBruno]);
      assert.deepEqual(await ids(`materialId=${d.uniforme}`), [fichaAna]);
      assert.deepEqual((await ids(`materialId=${d.botina}`)).sort((a, b) => a - b), [fichaAna, fichaBruno].sort((a, b) => a - b));
      assert.deepEqual(await ids('ativo=false'), []);
      await q('UPDATE funcionarios SET ativo = false WHERE id = $1', [d.funcA2]);
      assert.deepEqual(await ids('ativo=false'), [fichaBruno]);
      await q('UPDATE funcionarios SET ativo = true WHERE id = $1', [d.funcA2]);
      assert.deepEqual((await ids(`de=${HOJE}&ate=${HOJE}`)).length, 2);
      assert.deepEqual(await ids(`de=${somarDias(HOJE, 1)}`), []);
      assert.deepEqual(await ids(`ate=${ONTEM}`), []);
      const invertido = await get('leitorA', `/api/fichas-epi?de=${HOJE}&ate=${ONTEM}`);
      assert.deepEqual([invertido.status, invertido.body.detalhes[0].codigo], [400, 'PERIODO_INVERTIDO']);
      const cpfNaQuery = await get('leitorA', `/api/fichas-epi?cpf=${CPF.a1}`);
      assert.equal(cpfNaQuery.status, 400);
    });

    test('POST /fichas-epi/consulta-cpf: CPF no corpo, resposta mascarada, ficha existente ou nula; inexistente na empresa 404; a Beta não enxerga a Alfa', async () => {
      const ana = await post('leitorA', '/api/fichas-epi/consulta-cpf', { cpf: '529.982.247-25' });
      assert.equal(ana.status, 200, JSON.stringify(ana.body));
      assert.deepEqual([ana.body.funcionario.id, ana.body.funcionario.cpfMascarado, ana.body.ficha.id, ana.body.ficha.numero], [d.funcA1, '***.***.***-25', d.entregaA1.ficha.id, 1]);
      semDadosSensiveis(ana.body, 'consulta-cpf');
      const semFicha = await post('leitorA', '/api/fichas-epi/consulta-cpf', { cpf: '39053344705' });
      assert.deepEqual([semFicha.status, semFicha.body.ficha, semFicha.body.funcionario.matricula], [200, null, 'A-010']);
      assert.equal((await q('SELECT count(*)::int AS n FROM fichas_epi WHERE empresa_id = $1', [empresa.A])).rows[0].n, 2, 'a leitura não cria ficha');
      const inexistente = await post('leitorA', '/api/fichas-epi/consulta-cpf', { cpf: CPF.b1 });
      assert.deepEqual([inexistente.status, inexistente.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      const daBeta = await post('masterB', '/api/fichas-epi/consulta-cpf', { cpf: CPF.a1 });
      assert.equal(daBeta.status, 404);
      const invalido = await post('leitorA', '/api/fichas-epi/consulta-cpf', { cpf: '52998224726' });
      assert.equal(invalido.status, 400);
      const naUrl = await get('leitorA', `/api/fichas-epi/consulta-cpf/${CPF.a1}`);
      assert.equal(naUrl.status, 404);
    });

    test('GET /fichas-epi/:id: ficha, funcionário ATUAL (com GHE e CPF mascarado) e resumo; inexistente e de outra empresa 404', async () => {
      const r = await get('leitorA', `/api/fichas-epi/${d.entregaA1.ficha.id}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.ficha.id, r.body.ficha.numero, typeof r.body.ficha.criadaEm], [d.entregaA1.ficha.id, 1, 'string']);
      assert.deepEqual(r.body.funcionarioAtual, { id: d.funcA1, nome: 'Ana Fictícia', matricula: 'A-001', cpfMascarado: '***.***.***-25', setor: 'Produção', funcao: 'Operadora', ativo: true, ghe: { id: d.gheA, nome: 'GHE Produção' } });
      const { rows: [totais] } = await q(
        `SELECT count(DISTINCT e.id)::int AS entregas, count(i.id)::int AS itens, max(e.entregue_em) AS ultima
           FROM entregas_epi e JOIN entregas_epi_itens i ON i.entrega_id = e.id WHERE e.ficha_id = $1`,
        [d.entregaA1.ficha.id],
      );
      assert.deepEqual(r.body.resumo, { totalEntregas: totais.entregas, totalItens: totais.itens, ultimaEntregaEm: totais.ultima.toISOString() });
      semDadosSensiveis(r.body, 'ficha');
      assert.equal((await get('leitorA', '/api/fichas-epi/999999')).status, 404);
      const daBeta = await get('masterB', `/api/fichas-epi/${d.entregaA1.ficha.id}`);
      assert.deepEqual([daBeta.status, daBeta.body.codigo], [404, 'FICHA_NAO_ENCONTRADA']);
    });

    test('a ficha mostra o cadastro atual, não snapshot: alterar setor e função do trabalhador muda funcionarioAtual e não muda a entrega histórica', async () => {
      await q("UPDATE funcionarios SET setor = 'Logística', funcao = 'Conferente' WHERE id = $1", [d.funcA1]);
      const ficha = await get('leitorA', `/api/fichas-epi/${d.entregaA1.ficha.id}`);
      assert.deepEqual([ficha.body.funcionarioAtual.setor, ficha.body.funcionarioAtual.funcao], ['Logística', 'Conferente']);
      const entrega = await get('leitorA', `/api/entregas-epi/${d.entregaA1.entrega.id}`);
      assert.deepEqual([entrega.body.entrega.trabalhador.setor, entrega.body.entrega.trabalhador.funcao], ['Produção', 'Operadora']);
      await q("UPDATE funcionarios SET setor = 'Produção', funcao = 'Operadora' WHERE id = $1", [d.funcA1]);
    });

    test('GET /fichas-epi/:id/entregas: paginado, entregue_em DESC, snapshots históricos, itens com lote histórico sem saldo e confirmação pública; período; 404 fora da empresa', async () => {
      const r = await get('leitorA', `/api/fichas-epi/${d.entregaA1.ficha.id}/entregas?limite=2`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.ficha.id, r.body.ficha.numero, r.body.pagina, r.body.limite, r.body.entregas.length], [d.entregaA1.ficha.id, 1, 1, 2, 2]);
      assert.ok(r.body.total >= 3);
      const instantes = r.body.entregas.map((e) => e.entregueEm);
      assert.deepEqual(instantes, [...instantes].sort().reverse());
      for (const e of r.body.entregas) {
        assert.deepEqual(Object.keys(e.trabalhador).sort(), ['funcao', 'matricula', 'nome', 'setor']);
        assert.equal(e.itens.every((i) => Object.keys(i.lote).sort().join(',') === 'caNumero,caValidade,tamanho'), true);
        assert.deepEqual(Object.keys(e.confirmacao).sort(), ['confirmadaEm', 'declaracaoTexto', 'declaracaoVersao', 'hashConteudo', 'modo', 'tracos']);
        assert.equal(Object.hasOwn(e, 'chaveIdempotencia'), false);
      }
      semDadosSensiveis(r.body, 'entregas da ficha');
      const segunda = await get('leitorA', `/api/fichas-epi/${d.entregaA1.ficha.id}/entregas?limite=2&pagina=2`);
      assert.deepEqual([segunda.body.entregas.length >= 1, segunda.body.pagina], [true, 2]);
      const fora = await get('leitorA', `/api/fichas-epi/${d.entregaA1.ficha.id}/entregas?ate=${ONTEM}`);
      assert.deepEqual([fora.body.total, fora.body.entregas], [0, []]);
      const invertido = await get('leitorA', `/api/fichas-epi/${d.entregaA1.ficha.id}/entregas?de=${HOJE}&ate=${ONTEM}`);
      assert.equal(invertido.status, 400);
      assert.equal((await get('masterB', `/api/fichas-epi/${d.entregaA1.ficha.id}/entregas`)).status, 404);
    });

    test('GET /entregas-epi/:id: entrega histórica completa com snapshots, lote histórico, confirmação pública e hashConteudo; outra empresa 404', async () => {
      const r = await get('leitorA', `/api/entregas-epi/${d.entregaA1.entrega.id}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const { entrega } = r.body;
      assert.deepEqual(entrega.empresa, { nome: 'Empresa Alfa Entregas Ltda', cnpj: '11222333000181', endereco: 'Rua Fictícia, 100 - Industrial', cidade: 'Cidade Fictícia', uf: 'SP' });
      assert.deepEqual([entrega.trabalhador.nome, entrega.ghe, entrega.responsavel], ['Ana Fictícia', { id: d.gheA, nome: 'GHE Produção' }, { id: u.masterA, nome: 'Usuário masterA' }]);
      assert.deepEqual(entrega.itens.map((i) => [i.materialId, i.quantidade, i.material.nome, i.lote]), [[d.botina, 2, 'Botina de segurança', { tamanho: '40', caNumero: '12345', caValidade: '2099-12-31' }]]);
      assert.deepEqual([entrega.confirmacao.modo, entrega.confirmacao.tracos, entrega.confirmacao.hashConteudo], ['DESENHO', TRACOS, d.entregaA1.confirmacao.hashConteudo]);
      assert.deepEqual([entrega.ficha.id, entrega.ficha.numero, entrega.dataOperacional, entrega.origem], [d.entregaA1.ficha.id, 1, HOJE, 'DIRETA']);
      semDadosSensiveis(r.body, 'entrega');
      const daBeta = await get('masterB', `/api/entregas-epi/${d.entregaA1.entrega.id}`);
      assert.deepEqual([daBeta.status, daBeta.body.codigo], [404, 'ENTREGA_NAO_ENCONTRADA']);
      assert.equal((await get('leitorA', '/api/entregas-epi/999999')).status, 404);
    });

    test('a Beta vê só o que é dela: lista, filtros por funcionário/material da Alfa vazios, e a própria entrega', async () => {
      const lista = await get('masterB', '/api/fichas-epi');
      assert.deepEqual([lista.body.total, lista.body.fichas[0].funcionarioAtual.nome], [1, 'Beatriz da Beta']);
      assert.deepEqual((await get('masterB', `/api/fichas-epi?funcionarioId=${d.funcA1}`)).body.total, 0);
      assert.deepEqual((await get('masterB', `/api/fichas-epi?materialId=${d.botina}`)).body.total, 0);
      assert.deepEqual((await get('masterB', '/api/fichas-epi?busca=Ana')).body.total, 0);
      const propria = await get('masterB', `/api/entregas-epi/${d.entregaB.entrega.id}`);
      assert.deepEqual([propria.status, propria.body.entrega.trabalhador.nome], [200, 'Beatriz da Beta']);
      assert.equal((await get('leitorA', `/api/entregas-epi/${d.entregaB.entrega.id}`)).status, 404);
    });
  });
});
