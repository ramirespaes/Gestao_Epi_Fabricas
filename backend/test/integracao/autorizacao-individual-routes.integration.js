'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarGrupoAcessoController } = require('../../src/controllers/grupo-acesso.controller');
const { criarGrupoAcessoRoutes } = require('../../src/routes/grupo-acesso.routes');
const { criarAutorizacaoIndividualController } = require('../../src/controllers/autorizacao-individual.controller');
const { criarAutorizacaoIndividualRoutes } = require('../../src/routes/autorizacao-individual.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const permissoes = require('../../src/repositories/permissao.repository');
const { gerarHashSenha } = require('../../src/security/password');
const { gerarTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * API HTTP de autorizações individuais de ação (Bloco 8, Incremento 8,
 * Etapa 5A, Subetapa 3P) de ponta a ponta: HTTP -> autenticação real ->
 * rotas reais -> controller real -> serviço aprovado na Subetapa 3I ->
 * PostgreSQL real.
 *
 * As rotas montadas aqui são EXATAMENTE as de produção
 * (criarAutorizacaoIndividualRoutes/criarAutorizacaoIndividualController),
 * montadas lado a lado com as de grupos (3M) para provar não regressão.
 * O login também é real: os cookies vêm de sessões de verdade,
 * validadas no PostgreSQL.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '025', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '023'];

const SENHA = 'senha-correta-do-teste-3p-2026';
let HASH_SENHA;

const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE';   // 017: ALTERNATIVA, sem SST
const ACAO_OBRIGATORIA = 'APROVAR_SOLICITACAO';  // 017: OBRIGATORIA, exige_sst
const ACAO_NENHUMA = 'GERENCIAR_USUARIOS';       // 017: padrão NENHUMA
const ACAO_PARA_DESATIVAR = 'REALIZAR_ENTREGA';  // 017: ALTERNATIVA

async function inserirUsuario(pool, empresaId, email, perfil = 'SUPERVISOR', ativo = true) {
  const { rows } = await pool.query(
    'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [empresaId, `Usuário ${email}`, email, HASH_SENHA, perfil, ativo],
  );
  return rows[0].id;
}

function extrairCookie(resposta) {
  const cookies = resposta.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 1, 'esperado exatamente um Set-Cookie');
  return cookies[0].split(';')[0];
}

async function lerAutorizacao(pool, id) {
  const { rows } = await pool.query('SELECT * FROM usuario_autorizacoes WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function contarAutorizacoes(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM usuario_autorizacoes WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

async function contarAuditoria(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

describe('API HTTP de autorizações individuais com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let empresaB;
  let cookieMasterA;
  let cookieMasterB;
  let masterA;
  let masterB;

  const CNPJ_A = '12345678000195';
  const CNPJ_B = '98765432000110';
  const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
  const EMAIL_MASTER_B = 'master-b@demo.safeworkengenharia.com.br';

  async function login(cnpj, email) {
    const resposta = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA });
    assert.equal(resposta.status, 200, 'login deveria ter sucesso na preparação do cenário');
    return extrairCookie(resposta);
  }

  before(async () => {
    HASH_SENHA = await gerarHashSenha(SENHA);
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;

    assert.equal(await inserirEmpresa(pool, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, CNPJ_B, 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
    empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;

    masterA = await inserirUsuario(pool, empresaA, EMAIL_MASTER_A, 'MASTER');
    masterB = await inserirUsuario(pool, empresaB, EMAIL_MASTER_B, 'MASTER');

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao });
    const grupoRoutes = criarGrupoAcessoRoutes({ controller: criarGrupoAcessoController({ pool }), exigirSessao });
    const autorizacaoRoutes = criarAutorizacaoIndividualRoutes({ controller: criarAutorizacaoIndividualController({ pool }), exigirSessao });

    app = criarAppTeste((a) => { a.use('/api', authRoutes, grupoRoutes, autorizacaoRoutes); });

    cookieMasterA = await login(CNPJ_A, EMAIL_MASTER_A);
    cookieMasterB = await login(CNPJ_B, EMAIL_MASTER_B);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  /** Concede diretamente pela própria API (MASTER de A), para não duplicar SQL nas montagens de cenário. */
  async function concederPelaApi(usuarioId, acaoCodigo, { cookie = cookieMasterA, podeDelegar, motivo } = {}) {
    const corpo = { tipo: 'DIRETA', usuarioId, acaoCodigo, ...(podeDelegar !== undefined ? { podeDelegar } : {}), ...(motivo !== undefined ? { motivo } : {}) };
    const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookie).send(corpo);
    assert.equal(resposta.status, 201, `concessão direta deveria ter sucesso: ${JSON.stringify(resposta.body)}`);
    return resposta.body.autorizacao;
  }

  describe('autenticação', () => {
    test('sem cookie: POST e DELETE respondem 401 SESSAO_INVALIDA, sem tocar o banco', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'sem-sessao@demo.safeworkengenharia.com.br');
      const antes = await contarAutorizacoes(pool, empresaA);

      const post = await request(app).post('/api/autorizacoes-individuais').send({ tipo: 'DIRETA', usuarioId: usuario, acaoCodigo: ACAO_ALTERNATIVA });
      assert.equal(post.status, 401);
      assert.equal(post.body.codigo, 'SESSAO_INVALIDA');

      const del = await request(app).delete('/api/autorizacoes-individuais/1');
      assert.equal(del.status, 401);
      assert.equal(del.body.codigo, 'SESSAO_INVALIDA');

      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
    });

    test('cookie forjado (token nunca emitido): 401', async () => {
      const forjado = `${authConfig.sessao.cookieNome}=${gerarTokenSessao()}`;
      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', forjado)
        .send({ tipo: 'DIRETA', usuarioId: 1, acaoCodigo: ACAO_ALTERNATIVA });
      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    });
  });

  describe('validação do corpo (schema)', () => {
    test('campos de identidade/autoridade forjados são rejeitados pelo schema', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'forja-corpo@demo.safeworkengenharia.com.br');
      const antes = await contarAutorizacoes(pool, empresaA);

      for (const extra of [{ empresaId: empresaB }, { concedidoPor: 999 }, { autorizadoPor: 999 }, { isMaster: true }, { perfil: 'MASTER' }]) {
        const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
          .send({ tipo: 'DIRETA', usuarioId: usuario, acaoCodigo: ACAO_ALTERNATIVA, ...extra });
        assert.equal(resposta.status, 400, `campo ${Object.keys(extra)[0]} deveria ser recusado`);
        assert.equal(resposta.body.codigo, 'VALIDACAO');
      }

      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
    });

    test('DIRETA com origemId, ou DELEGADA com acaoCodigo: 400 — os dois ramos nunca se misturam (delegar ação diferente é estruturalmente impossível)', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'mistura-ramos@demo.safeworkengenharia.com.br');

      const diretaComOrigem = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DIRETA', usuarioId: usuario, acaoCodigo: ACAO_ALTERNATIVA, origemId: 1 });
      assert.equal(diretaComOrigem.status, 400);
      assert.equal(diretaComOrigem.body.codigo, 'VALIDACAO');

      const delegadaComAcao = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DELEGADA', usuarioId: usuario, origemId: 1, acaoCodigo: ACAO_ALTERNATIVA });
      assert.equal(delegadaComAcao.status, 400);
      assert.equal(delegadaComAcao.body.codigo, 'VALIDACAO');
    });

    test('tipo desconhecido, usuarioId/origemId inválidos e código de ação malformado: 400', async () => {
      const casos = [
        { tipo: 'OUTRO', usuarioId: 1, acaoCodigo: ACAO_ALTERNATIVA },
        { tipo: 'DIRETA', usuarioId: 0, acaoCodigo: ACAO_ALTERNATIVA },
        { tipo: 'DIRETA', usuarioId: 1, acaoCodigo: 'minuscula' },
        { tipo: 'DELEGADA', usuarioId: 1, origemId: -3 },
      ];
      for (const corpo of casos) {
        const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA).send(corpo);
        assert.equal(resposta.status, 400, JSON.stringify(corpo));
      }
    });

    test('DELETE com campo desconhecido no corpo é rejeitado; motivo é aceito', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'delete-corpo@demo.safeworkengenharia.com.br');
      const criada = await concederPelaApi(usuario, ACAO_ALTERNATIVA);

      const comForja = await request(app).delete(`/api/autorizacoes-individuais/${criada.id}`).set('Cookie', cookieMasterA).send({ empresaId: empresaB });
      assert.equal(comForja.status, 400);
      assert.equal(comForja.body.codigo, 'VALIDACAO');

      const comMotivo = await request(app).delete(`/api/autorizacoes-individuais/${criada.id}`).set('Cookie', cookieMasterA).send({ motivo: 'engano na concessão' });
      assert.equal(comMotivo.status, 200);
    });
  });

  describe('concessão direta', () => {
    test('MASTER concede diretamente: 201, persistida com origem_id null, e o RBAC passa a enxergar', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'concessao-direta-http@demo.safeworkengenharia.com.br');

      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DIRETA', usuarioId: usuario, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true, motivo: 'cobertura de férias' });

      assert.equal(resposta.status, 201);
      const { autorizacao } = resposta.body;
      assert.equal(autorizacao.usuarioId, usuario);
      assert.equal(autorizacao.acaoCodigo, ACAO_ALTERNATIVA);
      assert.equal(autorizacao.autorizadoPor, masterA);
      assert.equal(autorizacao.podeDelegar, true);
      assert.equal(autorizacao.origemId, null);
      assert.equal(autorizacao.motivo, 'cobertura de férias');
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, usuario, ACAO_ALTERNATIVA), true);

      const { rows } = await pool.query(
        "SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA' AND referencia = $2",
        [empresaA, String(autorizacao.id)],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].usuario_id, masterA);
      assert.deepEqual(rows[0].contexto, { tipo: 'DIRETA' });
    });

    test('não-MASTER não concede diretamente: 403, nada gravado', async () => {
      await inserirUsuario(pool, empresaA, 'supervisor-tenta-http@demo.safeworkengenharia.com.br');
      const cookieSupervisor = await login(CNPJ_A, 'supervisor-tenta-http@demo.safeworkengenharia.com.br');
      const alvo = await inserirUsuario(pool, empresaA, 'alvo-negado-http@demo.safeworkengenharia.com.br');
      const antes = await contarAutorizacoes(pool, empresaA);

      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieSupervisor)
        .send({ tipo: 'DIRETA', usuarioId: alvo, acaoCodigo: ACAO_ALTERNATIVA });

      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'CONCESSAO_NAO_AUTORIZADA');
      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
    });

    test('autoconcessão: 400', async () => {
      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DIRETA', usuarioId: masterA, acaoCodigo: ACAO_ALTERNATIVA });
      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'AUTOCONCESSAO_NAO_PERMITIDA');
    });

    test('beneficiário inativo: 400, nada gravado', async () => {
      const inativo = await inserirUsuario(pool, empresaA, 'inativo-http@demo.safeworkengenharia.com.br', 'USUARIO', false);
      const antes = await contarAutorizacoes(pool, empresaA);

      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DIRETA', usuarioId: inativo, acaoCodigo: ACAO_ALTERNATIVA });

      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'CONCESSAO_INVALIDA');
      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
    });

    test('beneficiário de outra empresa: 400 — MASTER de A não concede a usuário de B (mensagem não revela nada sobre B)', async () => {
      const usuarioDeB = await inserirUsuario(pool, empresaB, 'usuario-de-b-http@demo.safeworkengenharia.com.br', 'USUARIO');

      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DIRETA', usuarioId: usuarioDeB, acaoCodigo: ACAO_ALTERNATIVA });

      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'CONCESSAO_INVALIDA');
      assert.equal(await contarAutorizacoes(pool, empresaB), 0, 'nada foi criado na empresa alheia');
    });

    test('ação inexistente, código malformado no catálogo real, ou em modo NENHUMA: 400 CONCESSAO_INVALIDA', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'acao-invalida-http@demo.safeworkengenharia.com.br');

      const inexistente = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DIRETA', usuarioId: usuario, acaoCodigo: 'ACAO_QUE_NAO_EXISTE' });
      assert.equal(inexistente.status, 400);
      assert.equal(inexistente.body.codigo, 'CONCESSAO_INVALIDA');

      // NENHUMA: nunca ganha autorização individual, mesmo concedida pelo MASTER.
      const nenhuma = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DIRETA', usuarioId: usuario, acaoCodigo: ACAO_NENHUMA });
      assert.equal(nenhuma.status, 400);
      assert.equal(nenhuma.body.codigo, 'CONCESSAO_INVALIDA');
    });

    test('ação OBRIGATORIA (com exige_sst): concessão direta funciona normalmente — a exigência de SST vale no USO, não na concessão pelo MASTER', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'obrigatoria-direta-http@demo.safeworkengenharia.com.br');

      const autorizacao = await concederPelaApi(usuario, ACAO_OBRIGATORIA);

      assert.equal(autorizacao.acaoCodigo, ACAO_OBRIGATORIA);
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, usuario, ACAO_OBRIGATORIA), true);
    });

    test('duplicidade de autorização direta: 409, e a primeira permanece', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'duplicidade-http@demo.safeworkengenharia.com.br');
      const primeira = await concederPelaApi(usuario, ACAO_ALTERNATIVA);

      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DIRETA', usuarioId: usuario, acaoCodigo: ACAO_ALTERNATIVA });

      assert.equal(resposta.status, 409);
      assert.equal(resposta.body.codigo, 'AUTORIZACAO_JA_EXISTE');
      assert.ok(await lerAutorizacao(pool, primeira.id));
    });
  });

  describe('delegação', () => {
    test('delegação válida: ação herdada da origem, auditoria com tipo DELEGADA e origemId', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'carlos-delegador-http@demo.safeworkengenharia.com.br');
      const cookieCarlos = await login(CNPJ_A, 'carlos-delegador-http@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-delegada-http@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await concederPelaApi(carlos, ACAO_ALTERNATIVA, { podeDelegar: true });

      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieCarlos)
        .send({ tipo: 'DELEGADA', usuarioId: joana, origemId: origem.id });

      assert.equal(resposta.status, 201);
      const { autorizacao } = resposta.body;
      assert.equal(autorizacao.acaoCodigo, ACAO_ALTERNATIVA, 'ação herdada da origem');
      assert.equal(autorizacao.autorizadoPor, carlos);
      assert.equal(autorizacao.origemId, origem.id);
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, joana, ACAO_ALTERNATIVA), true);

      const { rows } = await pool.query(
        "SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA' AND referencia = $2",
        [empresaA, String(autorizacao.id)],
      );
      assert.deepEqual(rows[0].contexto, { tipo: 'DELEGADA', origemId: origem.id });
    });

    test('MASTER não delega: 403 mesmo com origem própria e pode_delegar=true — o caminho dele é DIRETA', async () => {
      await inserirUsuario(pool, empresaA, 'outro-master-http@demo.safeworkengenharia.com.br', 'MASTER');
      const cookieOutroMaster = await login(CNPJ_A, 'outro-master-http@demo.safeworkengenharia.com.br');
      const alvo = await inserirUsuario(pool, empresaA, 'alvo-master-delega-http@demo.safeworkengenharia.com.br');
      const origemDoMaster = await concederPelaApi(masterA, ACAO_ALTERNATIVA, { cookie: cookieOutroMaster, podeDelegar: true });

      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DELEGADA', usuarioId: alvo, origemId: origemDoMaster.id });

      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'DELEGACAO_NAO_AUTORIZADA');
    });

    test('usuário sem pode_delegar na origem: executar não é delegar — 403, nada gravado', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'sem-delegar-http@demo.safeworkengenharia.com.br');
      const cookieCarlos = await login(CNPJ_A, 'sem-delegar-http@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-sem-delegar-http@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await concederPelaApi(carlos, ACAO_ALTERNATIVA); // podeDelegar default = false
      const antes = await contarAutorizacoes(pool, empresaA);

      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieCarlos)
        .send({ tipo: 'DELEGADA', usuarioId: joana, origemId: origem.id });

      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'DELEGACAO_NAO_AUTORIZADA');
      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
    });

    test('origem inválida: inexistente, de outro usuário, ou de outra empresa — sempre 403, nunca fabrica nem substitui a cadeia', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'origem-invalida-http@demo.safeworkengenharia.com.br');
      const cookieCarlos = await login(CNPJ_A, 'origem-invalida-http@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-origem-invalida-http@demo.safeworkengenharia.com.br', 'USUARIO');

      const inexistente = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieCarlos)
        .send({ tipo: 'DELEGADA', usuarioId: joana, origemId: 999999 });
      assert.equal(inexistente.status, 403);
      assert.equal(inexistente.body.codigo, 'DELEGACAO_NAO_AUTORIZADA');

      // Origem existe, mas pertence a OUTRO usuário (carlos não é o dono).
      const outro = await inserirUsuario(pool, empresaA, 'dono-de-origem-alheia-http@demo.safeworkengenharia.com.br');
      const origemAlheia = await concederPelaApi(outro, ACAO_ALTERNATIVA, { podeDelegar: true });
      const deOutroUsuario = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieCarlos)
        .send({ tipo: 'DELEGADA', usuarioId: joana, origemId: origemAlheia.id });
      assert.equal(deOutroUsuario.status, 403);
      assert.equal(deOutroUsuario.body.codigo, 'DELEGACAO_NAO_AUTORIZADA');

      // Origem de outra empresa: nem mesmo aparece para o delegador de A.
      const delegadorB = await inserirUsuario(pool, empresaB, 'delegador-b-http@demo.safeworkengenharia.com.br');
      const origemB = await concederPelaApi(delegadorB, ACAO_ALTERNATIVA, { cookie: cookieMasterB, podeDelegar: true });
      const deOutraEmpresa = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieCarlos)
        .send({ tipo: 'DELEGADA', usuarioId: joana, origemId: origemB.id });
      assert.equal(deOutraEmpresa.status, 403);
      assert.equal(deOutraEmpresa.body.codigo, 'DELEGACAO_NAO_AUTORIZADA');
    });

    test('exige_sst: delegador fora da SST não delega ação OBRIGATORIA+SST; com vinculo_sst real, delega', async () => {
      const maria = await inserirUsuario(pool, empresaA, 'maria-sst-http@demo.safeworkengenharia.com.br');
      const cookieMaria = await login(CNPJ_A, 'maria-sst-http@demo.safeworkengenharia.com.br');
      const pedro = await inserirUsuario(pool, empresaA, 'pedro-sst-http@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await concederPelaApi(maria, ACAO_OBRIGATORIA, { podeDelegar: true });

      const semSst = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMaria)
        .send({ tipo: 'DELEGADA', usuarioId: pedro, origemId: origem.id });
      assert.equal(semSst.status, 403);
      assert.equal(semSst.body.codigo, 'DELEGACAO_NAO_AUTORIZADA');

      await pool.query('INSERT INTO vinculo_sst (usuario_id, empresa_id, concedido_por) VALUES ($1, $2, $3)', [maria, empresaA, masterA]);

      const comSst = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMaria)
        .send({ tipo: 'DELEGADA', usuarioId: pedro, origemId: origem.id });
      assert.equal(comSst.status, 201);
      assert.equal(comSst.body.autorizacao.acaoCodigo, ACAO_OBRIGATORIA);
    });
  });

  describe('revogação', () => {
    test('MASTER revoga uma concessão direta: 200, some do RBAC, auditoria com dados anteriores', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'revogar-direta-http@demo.safeworkengenharia.com.br');
      const criada = await concederPelaApi(usuario, ACAO_ALTERNATIVA);

      const resposta = await request(app).delete(`/api/autorizacoes-individuais/${criada.id}`).set('Cookie', cookieMasterA)
        .send({ motivo: 'não precisa mais' });

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.descendentesObservados, 0);
      assert.equal(await lerAutorizacao(pool, criada.id), null);
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, usuario, ACAO_ALTERNATIVA), false);

      const { rows } = await pool.query(
        "SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'AUTORIZACAO_INDIVIDUAL_REVOGADA' AND referencia = $2",
        [empresaA, String(criada.id)],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].usuario_id, masterA);
      assert.equal(rows[0].descricao, 'não precisa mais');
      assert.equal(rows[0].dados_anteriores.usuarioId, usuario);
    });

    test('revogação por origem: cascata remove os descendentes; autorização independente permanece', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'carlos-cascata-http@demo.safeworkengenharia.com.br');
      const cookieCarlos = await login(CNPJ_A, 'carlos-cascata-http@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-cascata-http@demo.safeworkengenharia.com.br', 'USUARIO');
      const independente = await inserirUsuario(pool, empresaA, 'independente-cascata-http@demo.safeworkengenharia.com.br');

      const origem = await concederPelaApi(carlos, ACAO_ALTERNATIVA, { podeDelegar: true });
      const delegadaResp = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieCarlos)
        .send({ tipo: 'DELEGADA', usuarioId: joana, origemId: origem.id });
      assert.equal(delegadaResp.status, 201);
      const delegada = delegadaResp.body.autorizacao;

      // Autorização independente (direta, sem relação nenhuma com a origem).
      const autonoma = await concederPelaApi(independente, ACAO_ALTERNATIVA);

      const resposta = await request(app).delete(`/api/autorizacoes-individuais/${origem.id}`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.descendentesObservados, 1);
      assert.equal(await lerAutorizacao(pool, origem.id), null, 'origem removida');
      assert.equal(await lerAutorizacao(pool, delegada.id), null, 'descendente removido pela cascata (FK da migration 023)');
      assert.ok(await lerAutorizacao(pool, autonoma.id), 'autorização independente preservada');
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, joana, ACAO_ALTERNATIVA), false);
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, independente, ACAO_ALTERNATIVA), true);
    });

    test('não-MASTER só revoga o que ele mesmo concedeu: outro não-MASTER recebe 403, nada muda', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'carlos-so-o-que-concedeu-http@demo.safeworkengenharia.com.br');
      const cookieCarlos = await login(CNPJ_A, 'carlos-so-o-que-concedeu-http@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-so-o-que-concedeu-http@demo.safeworkengenharia.com.br', 'USUARIO');
      const outro = await inserirUsuario(pool, empresaA, 'outro-nao-master-http@demo.safeworkengenharia.com.br');
      const cookieOutro = await login(CNPJ_A, 'outro-nao-master-http@demo.safeworkengenharia.com.br');

      const origem = await concederPelaApi(carlos, ACAO_ALTERNATIVA, { podeDelegar: true });
      const delegadaResp = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieCarlos)
        .send({ tipo: 'DELEGADA', usuarioId: joana, origemId: origem.id });
      const delegada = delegadaResp.body.autorizacao;

      const negado = await request(app).delete(`/api/autorizacoes-individuais/${delegada.id}`).set('Cookie', cookieOutro);
      assert.equal(negado.status, 403);
      assert.equal(negado.body.codigo, 'REVOGACAO_NAO_AUTORIZADA');
      assert.ok(await lerAutorizacao(pool, delegada.id), 'nada foi revogado');

      const permitido = await request(app).delete(`/api/autorizacoes-individuais/${delegada.id}`).set('Cookie', cookieCarlos);
      assert.equal(permitido.status, 200, 'carlos concedeu esta linha, então pode revogá-la');
    });

    test('isolamento multiempresa: MASTER de A não revoga (nem enxerga) autorização de B — 404', async () => {
      const usuarioB = await inserirUsuario(pool, empresaB, 'usuario-b-revogar-http@demo.safeworkengenharia.com.br', 'USUARIO');
      const criadaB = await concederPelaApi(usuarioB, ACAO_ALTERNATIVA, { cookie: cookieMasterB });

      const resposta = await request(app).delete(`/api/autorizacoes-individuais/${criadaB.id}`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 404);
      assert.equal(resposta.body.codigo, 'AUTORIZACAO_NAO_ENCONTRADA');
      assert.ok(await lerAutorizacao(pool, criadaB.id), 'autorização de B continua intacta');
    });

    test('autorização inexistente: 404', async () => {
      const resposta = await request(app).delete('/api/autorizacoes-individuais/999999').set('Cookie', cookieMasterA);
      assert.equal(resposta.status, 404);
      assert.equal(resposta.body.codigo, 'AUTORIZACAO_NAO_ENCONTRADA');
    });
  });

  describe('segurança transacional e integridade', () => {
    test('rollback: falha real da auditoria após a concessão desfaz o INSERT', async (t) => {
      const usuario = await inserirUsuario(pool, empresaA, 'rollback-concessao-http@demo.safeworkengenharia.com.br');
      const antes = await contarAutorizacoes(pool, empresaA);
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada pós-gravação'); });

      const resposta = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DIRETA', usuarioId: usuario, acaoCodigo: ACAO_ALTERNATIVA });

      assert.equal(resposta.status, 500);
      assert.equal(await contarAutorizacoes(pool, empresaA), antes, 'o INSERT foi desfeito pelo ROLLBACK');
    });

    test('rollback: falha real da auditoria após revogar uma origem com descendentes preserva a cadeia inteira', async (t) => {
      const carlos = await inserirUsuario(pool, empresaA, 'rollback-cascata-http@demo.safeworkengenharia.com.br');
      const cookieCarlos = await login(CNPJ_A, 'rollback-cascata-http@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-rollback-cascata-http@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await concederPelaApi(carlos, ACAO_ALTERNATIVA, { podeDelegar: true });
      const delegadaResp = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieCarlos)
        .send({ tipo: 'DELEGADA', usuarioId: joana, origemId: origem.id });
      const delegada = delegadaResp.body.autorizacao;

      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada pós-exclusão'); });
      const resposta = await request(app).delete(`/api/autorizacoes-individuais/${origem.id}`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 500);
      assert.ok(await lerAutorizacao(pool, origem.id), 'a origem permanece: o ROLLBACK desfez o DELETE em cascata');
      assert.ok(await lerAutorizacao(pool, delegada.id), 'o descendente também permanece');
    });

    test('não regressão: rotas de grupos (3M) continuam funcionando lado a lado com as de autorizações individuais (3P)', async () => {
      const resposta = await request(app).post('/api/grupos-acesso').set('Cookie', cookieMasterA).send({ nome: 'Nao Regressao 3P' });
      assert.equal(resposta.status, 201);

      const lista = await request(app).get('/api/grupos-acesso').set('Cookie', cookieMasterA);
      assert.equal(lista.status, 200);
    });
  });
});
