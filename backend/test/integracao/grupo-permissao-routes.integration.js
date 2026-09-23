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
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const permissoes = require('../../src/repositories/permissao.repository');
const { gerarHashSenha } = require('../../src/security/password');
const { gerarTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * API HTTP de permissões de grupo (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3N) de ponta a ponta: HTTP -> autenticação real -> rotas reais
 * -> controller real -> serviço aprovado na Subetapa 3K -> PostgreSQL
 * real.
 *
 * As rotas montadas aqui são EXATAMENTE as de produção
 * (criarGrupoPermissaoRoutes/criarGrupoPermissaoController), pelas mesmas
 * fábricas usadas por app.js — só o pool e o limitador são exclusivos
 * deste arquivo. O grupo em si é criado pela API de grupos já auditada na
 * Subetapa 3M, montada lado a lado, para não duplicar SQL e para provar
 * que as duas convivem sem regressão. O login também é real
 * (criarAuthRoutes/criarAuthController): os cookies usados abaixo vêm de
 * sessões de verdade, validadas no PostgreSQL.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '023'];

const SENHA = 'senha-correta-do-teste-3n-2026';
let HASH_SENHA;

const RECURSO = 'materials';
const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE';   // 017: ALTERNATIVA
const ACAO_OBRIGATORIA = 'APROVAR_SOLICITACAO';  // 017: OBRIGATORIA + exige_sst
const ACAO_NENHUMA = 'GERENCIAR_USUARIOS';       // 017: padrão NENHUMA

async function inserirUsuario(pool, empresaId, email, perfil = 'ADMINISTRADOR', ativo = true) {
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

async function lerRecurso(pool, grupoId, recurso) {
  const { rows } = await pool.query(
    'SELECT * FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = $2',
    [grupoId, recurso],
  );
  return rows[0] ?? null;
}

async function lerAcao(pool, grupoId, acaoCodigo) {
  const { rows } = await pool.query(
    'SELECT * FROM grupo_permissoes_acao WHERE grupo_acesso_id = $1 AND acao_codigo = $2',
    [grupoId, acaoCodigo],
  );
  return rows[0] ?? null;
}

async function contarAuditoria(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

async function contarConfiguracoes(pool, empresaId) {
  const { rows } = await pool.query(`
    SELECT (SELECT count(*)::int FROM grupo_permissoes_recurso WHERE empresa_id = $1) AS recursos,
           (SELECT count(*)::int FROM grupo_permissoes_acao WHERE empresa_id = $1) AS acoes`, [empresaId]);
  return rows[0];
}

describe('API HTTP de permissões de grupo com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let empresaB;
  let cookieMasterA;
  let cookieMasterB;
  let cookieAdminA;
  let cookieSupervisorA;
  let cookieUsuarioA;
  let masterA;

  const CNPJ_A = '12345678000195';
  const CNPJ_B = '98765432000110';
  const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
  const EMAIL_MASTER_B = 'master-b@demo.safeworkengenharia.com.br';
  const EMAIL_ADMIN_A = 'admin-a@demo.safeworkengenharia.com.br';
  const EMAIL_SUPERVISOR_A = 'supervisor-a@demo.safeworkengenharia.com.br';
  const EMAIL_USUARIO_A = 'usuario-a@demo.safeworkengenharia.com.br';

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
    await inserirUsuario(pool, empresaB, EMAIL_MASTER_B, 'MASTER');
    await inserirUsuario(pool, empresaA, EMAIL_ADMIN_A, 'ADMINISTRADOR');
    await inserirUsuario(pool, empresaA, EMAIL_SUPERVISOR_A, 'SUPERVISOR');
    await inserirUsuario(pool, empresaA, EMAIL_USUARIO_A, 'USUARIO');

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao });
    const grupoRoutes = criarGrupoAcessoRoutes({ controller: criarGrupoAcessoController({ pool }), exigirSessao });
    const permissaoRoutes = criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao });

    app = criarAppTeste((a) => { a.use('/api', authRoutes, grupoRoutes, permissaoRoutes); });

    cookieMasterA = await login(CNPJ_A, EMAIL_MASTER_A);
    cookieMasterB = await login(CNPJ_B, EMAIL_MASTER_B);
    cookieAdminA = await login(CNPJ_A, EMAIL_ADMIN_A);
    cookieSupervisorA = await login(CNPJ_A, EMAIL_SUPERVISOR_A);
    cookieUsuarioA = await login(CNPJ_A, EMAIL_USUARIO_A);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  /** Cria um grupo pela API já aprovada na 3M, para não duplicar SQL. */
  async function criarGrupoPelaApi(nome, { cookie = cookieMasterA } = {}) {
    const resposta = await request(app).post('/api/grupos-acesso').set('Cookie', cookie).send({ nome });
    assert.equal(resposta.status, 201, `criação deveria ter sucesso: ${JSON.stringify(resposta.body)}`);
    return resposta.body.grupo;
  }

  describe('autenticação', () => {
    test('sem cookie: as quatro rotas respondem 401 SESSAO_INVALIDA, sem tocar o banco', async () => {
      const grupo = await criarGrupoPelaApi('Sem Sessão Alvo');
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      const requisicoes = [
        request(app).get(`/api/grupos-acesso/${grupo.id}/permissoes/recursos`),
        request(app).get(`/api/grupos-acesso/${grupo.id}/permissoes/acoes`),
        request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`).send({ podeVisualizar: true }),
        request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`).send({ permitido: true }),
      ];

      for (const requisicao of requisicoes) {
        const resposta = await requisicao;
        assert.equal(resposta.status, 401, 'nenhuma rota de permissão é pública');
        assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
      }

      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
    });

    test('cookie forjado (token nunca emitido): 401', async () => {
      const grupo = await criarGrupoPelaApi('Cookie Forjado Alvo');
      const forjado = `${authConfig.sessao.cookieNome}=${gerarTokenSessao()}`;

      const resposta = await request(app).get(`/api/grupos-acesso/${grupo.id}/permissoes/recursos`).set('Cookie', forjado);

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    });

    test('MASTER inativado DEPOIS do login perde o acesso na requisição seguinte', async () => {
      const grupo = await criarGrupoPelaApi('Alvo Master Sera Inativado');
      const email = 'master-permissoes-sera-inativado@demo.safeworkengenharia.com.br';
      const id = await inserirUsuario(pool, empresaA, email, 'MASTER');
      const cookie = await login(CNPJ_A, email);
      assert.equal((await request(app).get(`/api/grupos-acesso/${grupo.id}/permissoes/recursos`).set('Cookie', cookie)).status, 200);

      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [id]);

      const resposta = await request(app).get(`/api/grupos-acesso/${grupo.id}/permissoes/recursos`).set('Cookie', cookie);
      // exigirSessao já barra usuário inativo; a sessão deixa de valer —
      // a autoridade do serviço nem chega a ser avaliada.
      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    });
  });

  describe('autorização administrativa', () => {
    test('ADMINISTRADOR, SUPERVISOR e USUARIO recebem 403 nas quatro rotas, inclusive nas de consulta', async () => {
      const grupo = await criarGrupoPelaApi('Alvo Sem Autoridade');
      const auditoriaAntes = await contarAuditoria(pool, empresaA);
      const configsAntes = await contarConfiguracoes(pool, empresaA);

      for (const cookie of [cookieAdminA, cookieSupervisorA, cookieUsuarioA]) {
        const casos = [
          ['get', `/api/grupos-acesso/${grupo.id}/permissoes/recursos`, null],
          ['get', `/api/grupos-acesso/${grupo.id}/permissoes/acoes`, null],
          ['patch', `/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`, { podeVisualizar: true }],
          ['patch', `/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`, { permitido: true }],
        ];

        for (const [metodo, caminho, corpo] of casos) {
          const requisicao = request(app)[metodo](caminho).set('Cookie', cookie);
          const resposta = corpo === null ? await requisicao : await requisicao.send(corpo);
          assert.equal(resposta.status, 403, `${metodo.toUpperCase()} ${caminho} deveria ser 403`);
          assert.equal(resposta.body.codigo, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
        }
      }

      assert.deepEqual(await contarConfiguracoes(pool, empresaA), configsAntes, 'nada gravado');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'nenhuma recusa é auditada');
    });

    test('empresa diferente: MASTER de B não enxerga nem altera permissões de grupo de A', async () => {
      const grupo = await criarGrupoPelaApi('Exclusivo de A');

      const casos = [
        ['get', `/api/grupos-acesso/${grupo.id}/permissoes/recursos`, null],
        ['get', `/api/grupos-acesso/${grupo.id}/permissoes/acoes`, null],
        ['patch', `/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`, { podeVisualizar: true }],
        ['patch', `/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`, { permitido: true }],
      ];

      for (const [metodo, caminho, corpo] of casos) {
        const requisicao = request(app)[metodo](caminho).set('Cookie', cookieMasterB);
        const resposta = corpo === null ? await requisicao : await requisicao.send(corpo);
        // MASTER de B tem autoridade — na empresa B. A busca do grupo é
        // sempre filtrada pela empresa da SESSÃO (empresaB aqui), então um
        // grupo de A simplesmente não é encontrado: 404, nunca 403 nem um
        // vazamento de que o grupo existe em outra empresa.
        assert.equal(resposta.status, 404, `${metodo.toUpperCase()} ${caminho} deveria ser 404 para MASTER de outra empresa`);
        assert.equal(resposta.body.codigo, 'GRUPO_NAO_ENCONTRADO');
      }
    });

    test('grupo inexistente: 404 nas quatro rotas', async () => {
      const casos = [
        ['get', '/api/grupos-acesso/999999/permissoes/recursos', null],
        ['get', '/api/grupos-acesso/999999/permissoes/acoes', null],
        ['patch', `/api/grupos-acesso/999999/permissoes/recursos/${RECURSO}`, { podeVisualizar: true }],
        ['patch', `/api/grupos-acesso/999999/permissoes/acoes/${ACAO_ALTERNATIVA}`, { permitido: true }],
      ];

      for (const [metodo, caminho, corpo] of casos) {
        const requisicao = request(app)[metodo](caminho).set('Cookie', cookieMasterA);
        const resposta = corpo === null ? await requisicao : await requisicao.send(corpo);
        assert.equal(resposta.status, 404, `${metodo.toUpperCase()} ${caminho}`);
        assert.equal(resposta.body.codigo, 'GRUPO_NAO_ENCONTRADO');
      }
    });

    test('identidade nunca vem do corpo: empresaId/isMaster/perfil/atorId/ativo são rejeitados pelo schema', async () => {
      const grupo = await criarGrupoPelaApi('Forja de Identidade');

      for (const extra of [{ empresaId: empresaB }, { isMaster: true }, { perfil: 'MASTER' }, { atorId: 999 }, { ativo: true }]) {
        const r1 = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
          .set('Cookie', cookieMasterA).send({ podeVisualizar: true, ...extra });
        assert.equal(r1.status, 400, `recurso com ${JSON.stringify(extra)} deveria ser recusado`);
        assert.equal(r1.body.codigo, 'VALIDACAO');

        const r2 = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
          .set('Cookie', cookieMasterA).send({ permitido: true, ...extra });
        assert.equal(r2.status, 400, `ação com ${JSON.stringify(extra)} deveria ser recusada`);
        assert.equal(r2.body.codigo, 'VALIDACAO');
      }
    });
  });

  describe('permissões de recurso', () => {
    test('consulta inicial: lista vazia', async () => {
      const grupo = await criarGrupoPelaApi('Recursos Vazio');
      const resposta = await request(app).get(`/api/grupos-acesso/${grupo.id}/permissoes/recursos`).set('Cookie', cookieMasterA);
      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body.recursos, []);
    });

    test('configura TRUE, depois FALSE, depois NULL — tri-state persistido e legível pelo RBAC', async () => {
      const grupo = await criarGrupoPelaApi('Recursos Tri-State');

      const r1 = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
        .set('Cookie', cookieMasterA).send({ podeVisualizar: true });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.alterado, true);
      assert.equal(r1.body.configuracao.podeVisualizar, true);
      assert.equal((await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, grupo.id, RECURSO)).podeVisualizar, true);

      const r2 = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
        .set('Cookie', cookieMasterA).send({ podeVisualizar: false });
      assert.equal(r2.body.configuracao.podeVisualizar, false, 'FALSE gravado como FALSE');

      const r3 = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
        .set('Cookie', cookieMasterA).send({ podeVisualizar: null });
      assert.equal(r3.body.configuracao.podeVisualizar, null, 'NULL passa a herdar');
    });

    test('alteração parcial preserva as demais operações; FALSE nunca vira NULL', async () => {
      const grupo = await criarGrupoPelaApi('Recursos Parcial');
      await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
        .set('Cookie', cookieMasterA).send({ podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: false });

      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
        .set('Cookie', cookieMasterA).send({ podeExcluir: true });

      assert.equal(resposta.body.configuracao.podeExcluir, true, 'só o campo informado muda');
      assert.equal(resposta.body.configuracao.podeVisualizar, true, 'preservado');
      assert.equal(resposta.body.configuracao.podeCriar, false, 'FALSE preservado — nunca vira NULL');
      assert.equal(resposta.body.configuracao.podeEditar, true, 'preservado');
    });

    test('recurso com formato inválido: 400 VALIDACAO, nada gravado', async () => {
      const grupo = await criarGrupoPelaApi('Recurso Formato Invalido');
      const antes = await contarConfiguracoes(pool, empresaA);

      for (const recurso of ['1recurso', 'tem-hifen']) {
        const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${recurso}`)
          .set('Cookie', cookieMasterA).send({ podeVisualizar: true });
        assert.equal(resposta.status, 400, `recurso ${recurso}`);
        assert.equal(resposta.body.codigo, 'VALIDACAO');
      }

      assert.deepEqual(await contarConfiguracoes(pool, empresaA), antes);
    });

    test('corpo {} (nenhuma operação informada): 400 GRUPO_PERMISSAO_SEM_ALTERACAO, sem auditoria', async () => {
      const grupo = await criarGrupoPelaApi('Recursos Corpo Vazio');
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
        .set('Cookie', cookieMasterA).send({});

      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'GRUPO_PERMISSAO_SEM_ALTERACAO');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
    });

    test('valor fora do tri-state (string, número): 400 VALIDACAO', async () => {
      const grupo = await criarGrupoPelaApi('Recursos Fora Do Tristate');

      for (const valor of ['true', 1, 'sim']) {
        const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
          .set('Cookie', cookieMasterA).send({ podeVisualizar: valor });
        assert.equal(resposta.status, 400, `valor ${JSON.stringify(valor)} deveria ser recusado`);
        assert.equal(resposta.body.codigo, 'VALIDACAO');
      }
    });

    test('auditoria registra a alteração de recurso, com anterior/novo/ator/referência', async () => {
      const grupo = await criarGrupoPelaApi('Recursos Auditados');
      await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
        .set('Cookie', cookieMasterA).send({ podeVisualizar: true });

      const { rows } = await pool.query(
        "SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'GRUPO_PERMISSAO_RECURSO_CONFIGURADA' AND referencia = $2",
        [empresaA, String(grupo.id)],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].usuario_id, masterA);
      assert.equal(rows[0].dados_anteriores, null);
      assert.equal(rows[0].dados_novos.podeVisualizar, true);
      assert.equal(rows[0].contexto.recurso, RECURSO);
    });
  });

  describe('permissões de ação', () => {
    test('ação ALTERNATIVA aceita TRUE/FALSE/NULL', async () => {
      const grupo = await criarGrupoPelaApi('Acao Alternativa');

      const r1 = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: true });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.configuracao.permitido, true);

      const r2 = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: false });
      assert.equal(r2.body.configuracao.permitido, false);

      const r3 = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: null });
      assert.equal(r3.body.configuracao.permitido, null);
    });

    test('ação NENHUMA rejeita concessão/negativa por grupo: 409, nada gravado', async () => {
      const grupo = await criarGrupoPelaApi('Acao Nenhuma');

      for (const permitido of [true, false]) {
        const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_NENHUMA}`)
          .set('Cookie', cookieMasterA).send({ permitido });
        assert.equal(resposta.status, 409, `permitido=${permitido}`);
        assert.equal(resposta.body.codigo, 'GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA');
      }
      assert.equal(await lerAcao(pool, grupo.id, ACAO_NENHUMA), null);
    });

    test('ação OBRIGATORIA rejeita concessão por grupo: 409 — grupo não substitui autorização individual nem SST', async () => {
      const grupo = await criarGrupoPelaApi('Acao Obrigatoria');

      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_OBRIGATORIA}`)
        .set('Cookie', cookieMasterA).send({ permitido: true });

      assert.equal(resposta.status, 409);
      assert.equal(resposta.body.codigo, 'GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA');
      assert.equal(await lerAcao(pool, grupo.id, ACAO_OBRIGATORIA), null);
    });

    test('NULL limpa configuração obsoleta mesmo fora de ALTERNATIVA (contrato preservado da 3K)', async () => {
      const grupo = await criarGrupoPelaApi('Acao Limpeza Null');
      await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: true });

      // Muda o modo da ação para OBRIGATORIA diretamente no catálogo (sem
      // tocar em rota nem em migration), simulando "o modo mudou depois".
      await pool.query("UPDATE acoes SET modo_autorizacao_individual = 'OBRIGATORIA' WHERE codigo = $1", [ACAO_ALTERNATIVA]);

      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: null });

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.configuracao.permitido, null);

      await pool.query("UPDATE acoes SET modo_autorizacao_individual = 'ALTERNATIVA' WHERE codigo = $1", [ACAO_ALTERNATIVA]);
    });

    test('ação inexistente ou código malformado: 400', async () => {
      const grupo = await criarGrupoPelaApi('Acao Inexistente');

      for (const codigo of ['ACAO_QUE_NAO_EXISTE', 'minuscula', '123']) {
        const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${codigo}`)
          .set('Cookie', cookieMasterA).send({ permitido: true });
        assert.equal(resposta.status, 400, `código ${codigo}`);
      }
    });

    test('ação inativa no catálogo: 400 GRUPO_PERMISSAO_ACAO_INVALIDA', async () => {
      const grupo = await criarGrupoPelaApi('Acao Inativa');
      await pool.query('UPDATE acoes SET ativo = false WHERE codigo = $1', [ACAO_ALTERNATIVA]);

      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: true });

      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'GRUPO_PERMISSAO_ACAO_INVALIDA');

      await pool.query('UPDATE acoes SET ativo = true WHERE codigo = $1', [ACAO_ALTERNATIVA]);
    });

    test('permitido ausente: 400 CAMPO_OBRIGATORIO — nunca tratado como "não mexer"', async () => {
      const grupo = await criarGrupoPelaApi('Acao Sem Permitido');
      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({});
      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'VALIDACAO');
      assert.equal(resposta.body.detalhes[0].codigo, 'CAMPO_OBRIGATORIO');
    });

    test('auditoria registra a alteração de ação', async () => {
      const grupo = await criarGrupoPelaApi('Acao Auditada');
      await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: true });

      const { rows } = await pool.query(
        "SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'GRUPO_PERMISSAO_ACAO_CONFIGURADA' AND referencia = $2",
        [empresaA, String(grupo.id)],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].dados_novos.permitido, true);
    });
  });

  describe('grupo inativo e integridade', () => {
    test('grupo inativo: consulta e configuração continuam funcionando, e a inativação NÃO é desfeita', async () => {
      const grupo = await criarGrupoPelaApi('Grupo Sera Inativado');
      await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
        .set('Cookie', cookieMasterA).send({ podeVisualizar: true });
      await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA);

      const consulta = await request(app).get(`/api/grupos-acesso/${grupo.id}/permissoes/recursos`).set('Cookie', cookieMasterA);
      assert.equal(consulta.status, 200);
      assert.equal(consulta.body.recursos[0].podeVisualizar, true, 'configuração preservada mesmo com grupo inativo');

      const configura = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: true });
      assert.equal(configura.status, 200, 'configurar permissões de grupo inativo é permitido');

      const grupoLido = await request(app).get(`/api/grupos-acesso/${grupo.id}`).set('Cookie', cookieMasterA);
      assert.equal(grupoLido.body.grupo.ativo, false, 'configurar permissão não reativa o grupo');
    });

    test('requisição inválida (formato, regra de negócio ou autoridade) não produz gravação nem auditoria', async () => {
      const grupo = await criarGrupoPelaApi('Sem Efeito Colateral');
      const configsAntes = await contarConfiguracoes(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`).set('Cookie', cookieMasterA).send({ podeVisualizar: 'sim' });
      await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_NENHUMA}`).set('Cookie', cookieMasterA).send({ permitido: true });
      await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`).set('Cookie', cookieAdminA).send({ podeVisualizar: true });

      assert.deepEqual(await contarConfiguracoes(pool, empresaA), configsAntes);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
    });

    test('operação sem mudança efetiva não produz nova linha de auditoria', async () => {
      const grupo = await criarGrupoPelaApi('Sem Mudanca Efetiva');
      await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`).set('Cookie', cookieMasterA).send({ permitido: true });
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: true });

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.alterado, false);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'sem mudança efetiva, sem nova auditoria');
    });

    test('rollback: falha real da auditoria desfaz a gravação da configuração de recurso', async (t) => {
      const grupo = await criarGrupoPelaApi('Rollback Http Recurso');
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada pós-gravação'); });

      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/recursos/${RECURSO}`)
        .set('Cookie', cookieMasterA).send({ podeVisualizar: true });

      assert.equal(resposta.status, 500);
      assert.equal(await lerRecurso(pool, grupo.id, RECURSO), null, 'o UPSERT foi desfeito pelo ROLLBACK');
    });

    test('rollback: falha real da auditoria desfaz a gravação da configuração de ação', async (t) => {
      const grupo = await criarGrupoPelaApi('Rollback Http Acao');
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada pós-gravação'); });

      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: true });

      assert.equal(resposta.status, 500);
      assert.equal(await lerAcao(pool, grupo.id, ACAO_ALTERNATIVA), null, 'o UPSERT foi desfeito pelo ROLLBACK');
    });

    test('não regressão: rotas de grupos (3M) continuam funcionando lado a lado com as de permissões (3N)', async () => {
      const grupo = await criarGrupoPelaApi('Nao Regressao 3M');
      const busca = await request(app).get(`/api/grupos-acesso/${grupo.id}`).set('Cookie', cookieMasterA);
      assert.equal(busca.status, 200);
      assert.equal(busca.body.grupo.id, grupo.id);

      const lista = await request(app).get('/api/grupos-acesso').set('Cookie', cookieMasterA);
      assert.equal(lista.status, 200);
      assert.ok(lista.body.grupos.some((g) => g.id === grupo.id));
    });
  });
});
