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
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const permissoes = require('../../src/repositories/permissao.repository');
const { gerarHashSenha } = require('../../src/security/password');
const { gerarTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * API HTTP de grupos de acesso (Bloco 8, Incremento 8, Etapa 5A, Subetapa
 * 3M) de ponta a ponta: HTTP -> autenticação real -> rotas reais ->
 * controller real -> serviço aprovado na 3J -> PostgreSQL real.
 *
 * As rotas montadas aqui são EXATAMENTE as de produção, pelas mesmas
 * fábricas (criarGrupoAcessoRoutes/criarGrupoAcessoController) — só o pool
 * e o limitador são exclusivos deste arquivo. Nenhuma rota é redefinida no
 * teste, para que o que se prova aqui seja o que roda em produção.
 *
 * O login também é real (criarAuthRoutes/criarAuthController): os cookies
 * usados abaixo vêm de sessões de verdade, validadas no PostgreSQL.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '025', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '023'];

const SENHA = 'senha-correta-do-teste-3m-2026';
let HASH_SENHA;

const RECURSO = 'materials';

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

async function lerGrupo(pool, id) {
  const { rows } = await pool.query('SELECT * FROM grupos_acesso WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function contarGrupos(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM grupos_acesso WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

async function contarAuditoria(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

describe('API HTTP de grupos de acesso com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let empresaB;
  let cookieMasterA;
  let cookieMasterB;
  let cookieAdminA;
  let masterA;

  const CNPJ_A = '12345678000195';
  const CNPJ_B = '98765432000110';
  const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
  const EMAIL_MASTER_B = 'master-b@demo.safeworkengenharia.com.br';
  const EMAIL_ADMIN_A = 'admin-a@demo.safeworkengenharia.com.br';

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

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao });
    const grupoRoutes = criarGrupoAcessoRoutes({ controller: criarGrupoAcessoController({ pool }), exigirSessao });

    app = criarAppTeste((a) => { a.use('/api', authRoutes, grupoRoutes); });

    cookieMasterA = await login(CNPJ_A, EMAIL_MASTER_A);
    cookieMasterB = await login(CNPJ_B, EMAIL_MASTER_B);
    cookieAdminA = await login(CNPJ_A, EMAIL_ADMIN_A);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  /** Cria um grupo pela própria API e devolve o corpo. */
  async function criarPelaApi(nome, { cookie = cookieMasterA, descricao } = {}) {
    const corpo = descricao === undefined ? { nome } : { nome, descricao };
    const resposta = await request(app).post('/api/grupos-acesso').set('Cookie', cookie).send(corpo);
    assert.equal(resposta.status, 201, `criação deveria ter sucesso: ${JSON.stringify(resposta.body)}`);
    return resposta.body.grupo;
  }

  describe('autenticação', () => {
    test('sem cookie: todas as seis rotas respondem 401 SESSAO_INVALIDA, sem tocar o banco', async () => {
      const antes = await contarGrupos(pool, empresaA);
      const requisicoes = [
        request(app).post('/api/grupos-acesso').send({ nome: 'Sem Sessão' }),
        request(app).get('/api/grupos-acesso'),
        request(app).get('/api/grupos-acesso/1'),
        request(app).patch('/api/grupos-acesso/1').send({ nome: 'X' }),
        request(app).post('/api/grupos-acesso/1/inativar').send({}),
        request(app).post('/api/grupos-acesso/1/reativar').send({}),
      ];

      for (const requisicao of requisicoes) {
        const resposta = await requisicao;
        assert.equal(resposta.status, 401, 'nenhuma rota de grupo é pública');
        assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
      }

      assert.equal(await contarGrupos(pool, empresaA), antes);
    });

    test('cookie forjado (token nunca emitido): 401', async () => {
      const forjado = `${authConfig.sessao.cookieNome}=${gerarTokenSessao()}`;

      const resposta = await request(app).get('/api/grupos-acesso').set('Cookie', forjado);

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    });
  });

  describe('autorização administrativa', () => {
    test('ADMINISTRADOR autenticado recebe 403 em TODAS as rotas, inclusive nas de consulta', async () => {
      const grupo = await criarPelaApi('Alvo do Admin');
      const antes = await contarGrupos(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      const casos = [
        ['post', '/api/grupos-acesso', { nome: 'Do Admin' }],
        ['get', '/api/grupos-acesso', null],
        ['get', `/api/grupos-acesso/${grupo.id}`, null],
        ['patch', `/api/grupos-acesso/${grupo.id}`, { nome: 'Renomeado pelo Admin' }],
        ['post', `/api/grupos-acesso/${grupo.id}/inativar`, {}],
        ['post', `/api/grupos-acesso/${grupo.id}/reativar`, {}],
      ];

      for (const [metodo, caminho, corpo] of casos) {
        const requisicao = request(app)[metodo](caminho).set('Cookie', cookieAdminA);
        const resposta = corpo === null ? await requisicao : await requisicao.send(corpo);
        assert.equal(resposta.status, 403, `${metodo.toUpperCase()} ${caminho} deveria ser 403`);
        assert.equal(resposta.body.codigo, 'GRUPO_NAO_AUTORIZADO');
      }

      assert.equal(await contarGrupos(pool, empresaA), antes, 'nada criado');
      assert.equal((await lerGrupo(pool, grupo.id)).nome, 'Alvo do Admin', 'nada alterado');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'recusa não é auditada');
    });

    test('MASTER inativado DEPOIS do login perde o acesso na requisição seguinte', async () => {
      const email = 'master-sera-inativado@demo.safeworkengenharia.com.br';
      const id = await inserirUsuario(pool, empresaA, email, 'MASTER');
      const cookie = await login(CNPJ_A, email);
      assert.equal((await request(app).get('/api/grupos-acesso').set('Cookie', cookie)).status, 200);

      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [id]);

      const resposta = await request(app).get('/api/grupos-acesso').set('Cookie', cookie);
      // exigirSessao já barra usuário inativo; a sessão deixa de valer.
      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    });

    test('identidade nunca vem do corpo: empresaId/isMaster/perfil/atorId enviados são rejeitados pelo schema', async () => {
      const antes = await contarGrupos(pool, empresaA);

      for (const extra of [{ empresaId: empresaB }, { isMaster: true }, { perfil: 'MASTER' }, { atorId: masterA }, { criadoPor: 999 }]) {
        const resposta = await request(app).post('/api/grupos-acesso').set('Cookie', cookieAdminA)
          .send({ nome: 'Tentativa de Forja', ...extra });

        assert.equal(resposta.status, 400, `campo ${Object.keys(extra)[0]} deveria ser recusado pelo schema`);
        assert.equal(resposta.body.codigo, 'VALIDACAO');
      }

      assert.equal(await contarGrupos(pool, empresaA), antes);
      assert.equal(await contarGrupos(pool, empresaB), 0, 'nada foi criado na empresa alheia');
    });

    test('empresa diferente: MASTER de A não enxerga nem altera grupo de B', async () => {
      const deB = await criarPelaApi('Exclusivo de B', { cookie: cookieMasterB });

      const consulta = await request(app).get(`/api/grupos-acesso/${deB.id}`).set('Cookie', cookieMasterA);
      assert.equal(consulta.status, 404);
      assert.equal(consulta.body.codigo, 'GRUPO_NAO_ENCONTRADO');

      const alteracao = await request(app).patch(`/api/grupos-acesso/${deB.id}`).set('Cookie', cookieMasterA).send({ nome: 'Invadido' });
      assert.equal(alteracao.status, 404);

      const inativacao = await request(app).post(`/api/grupos-acesso/${deB.id}/inativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(inativacao.status, 404);

      const linha = await lerGrupo(pool, deB.id);
      assert.equal(linha.nome, 'Exclusivo de B', 'intacto');
      assert.equal(linha.ativo, true);

      const lista = await request(app).get('/api/grupos-acesso').set('Cookie', cookieMasterA);
      assert.equal(lista.body.grupos.some((g) => g.id === deB.id), false, 'grupo de B não aparece na lista de A');
    });
  });

  describe('criação, consulta e listagem', () => {
    test('POST cria com 201, criado_por = MASTER da sessão, ativo=true e auditoria', async () => {
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      const resposta = await request(app).post('/api/grupos-acesso').set('Cookie', cookieMasterA)
        .send({ nome: 'Almoxarifado', descricao: 'Equipe do depósito' });

      assert.equal(resposta.status, 201);
      assert.equal(resposta.body.status, 'ok');
      const { grupo } = resposta.body;
      assert.equal(grupo.nome, 'Almoxarifado');
      assert.equal(grupo.descricao, 'Equipe do depósito');
      assert.equal(grupo.ativo, true);
      assert.equal(grupo.criadoPor, masterA, 'criado_por vem da sessão, não do corpo');
      assert.equal(grupo.empresaId, empresaA);

      const linha = await lerGrupo(pool, grupo.id);
      assert.equal(linha.criado_por, masterA);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes + 1, 'a criação foi auditada');
    });

    test('GET por id devolve o grupo da própria empresa; id inexistente é 404', async () => {
      const grupo = await criarPelaApi('Consultável');

      const resposta = await request(app).get(`/api/grupos-acesso/${grupo.id}`).set('Cookie', cookieMasterA);
      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.grupo.id, grupo.id);
      assert.equal(resposta.body.grupo.nome, 'Consultável');

      const ausente = await request(app).get('/api/grupos-acesso/99999999').set('Cookie', cookieMasterA);
      assert.equal(ausente.status, 404);
      assert.equal(ausente.body.codigo, 'GRUPO_NAO_ENCONTRADO');
    });

    test('GET lista traz ativos e inativos por padrão e respeita ?ativo=', async () => {
      const grupo = await criarPelaApi('Some da Lista Ativa');
      await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA).send({});

      const todos = await request(app).get('/api/grupos-acesso').set('Cookie', cookieMasterA);
      const ativos = await request(app).get('/api/grupos-acesso?ativo=true').set('Cookie', cookieMasterA);
      const inativos = await request(app).get('/api/grupos-acesso?ativo=false').set('Cookie', cookieMasterA);

      assert.equal(todos.status, 200);
      assert.equal(todos.body.grupos.some((g) => g.id === grupo.id), true);
      assert.equal(ativos.body.grupos.some((g) => g.id === grupo.id), false);
      assert.equal(inativos.body.grupos.some((g) => g.id === grupo.id), true);
      assert.equal(ativos.body.grupos.every((g) => g.ativo === true), true);
      assert.equal(todos.body.grupos.every((g) => g.empresaId === empresaA), true, 'só a própria empresa');
    });
  });

  describe('edição, inativação e reativação', () => {
    test('PATCH altera nome e descrição preservando id, empresa_id, criado_por e criado_em', async () => {
      const grupo = await criarPelaApi('Nome Antigo', { descricao: 'antiga' });
      const original = await lerGrupo(pool, grupo.id);

      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}`).set('Cookie', cookieMasterA)
        .send({ nome: 'Nome Novo', descricao: 'nova' });

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.grupo.nome, 'Nome Novo');
      const depois = await lerGrupo(pool, grupo.id);
      assert.equal(depois.descricao, 'nova');
      assert.equal(depois.criado_por, original.criado_por, 'criado_por preservado');
      assert.deepEqual(depois.criado_em, original.criado_em, 'criado_em preservado');
      assert.equal(depois.empresa_id, original.empresa_id);
      assert.equal(depois.ativo, true, 'PATCH não mexe em ativo');
    });

    test('PATCH com descricao: null limpa a descrição; sem a chave, preserva', async () => {
      const grupo = await criarPelaApi('Descrição Volátil', { descricao: 'tinha' });

      await request(app).patch(`/api/grupos-acesso/${grupo.id}`).set('Cookie', cookieMasterA).send({ nome: 'Só o Nome' });
      assert.equal((await lerGrupo(pool, grupo.id)).descricao, 'tinha', 'chave ausente preserva');

      await request(app).patch(`/api/grupos-acesso/${grupo.id}`).set('Cookie', cookieMasterA).send({ descricao: null });
      assert.equal((await lerGrupo(pool, grupo.id)).descricao, null, 'null explícito limpa');
    });

    test('PATCH não aceita campos de identidade nem ativo: 400 VALIDACAO', async () => {
      const grupo = await criarPelaApi('Blindado');

      for (const corpo of [{ id: 7 }, { empresaId: empresaB }, { criadoPor: 1 }, { criadoEm: '2020-01-01' }, { ativo: false }]) {
        const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}`).set('Cookie', cookieMasterA).send(corpo);
        assert.equal(resposta.status, 400, `corpo ${JSON.stringify(corpo)} deveria ser recusado`);
        assert.equal(resposta.body.codigo, 'VALIDACAO');
      }

      const linha = await lerGrupo(pool, grupo.id);
      assert.equal(linha.nome, 'Blindado');
      assert.equal(linha.ativo, true, 'ativo não é alterável por PATCH');
    });

    test('PATCH sem nenhum campo: 400 GRUPO_SEM_ALTERACAO (regra do serviço)', async () => {
      const grupo = await criarPelaApi('Sem Alteração');

      const resposta = await request(app).patch(`/api/grupos-acesso/${grupo.id}`).set('Cookie', cookieMasterA).send({});

      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'GRUPO_SEM_ALTERACAO');
    });

    test('inativar e reativar por rotas próprias, com idempotência e auditoria', async () => {
      const grupo = await criarPelaApi('Vai e Volta HTTP');

      const inativa = await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(inativa.status, 200);
      assert.equal(inativa.body.alterado, true);
      assert.equal(inativa.body.grupo.ativo, false);
      assert.equal((await lerGrupo(pool, grupo.id)).ativo, false);

      const auditoriaAntes = await contarAuditoria(pool, empresaA);
      const repetida = await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(repetida.status, 200, 'idempotente: o estado pedido é o atual');
      assert.equal(repetida.body.alterado, false);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'sem mudança efetiva, sem auditoria');

      const reativa = await request(app).post(`/api/grupos-acesso/${grupo.id}/reativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(reativa.status, 200);
      assert.equal(reativa.body.alterado, true);
      assert.equal((await lerGrupo(pool, grupo.id)).ativo, true);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes + 1);
    });

    // Correção pós-auditoria da Subetapa 3M: inativar/reativar não recebem
    // dado de negócio nenhum pelo corpo — só params.id era validado antes.
    // Corpo ausente e {} continuam funcionando; qualquer campo informado
    // agora é 400 VALIDACAO, sem chegar ao controller nem ao serviço.
    describe('validação do corpo de inativar/reativar (correção pós-auditoria)', () => {
      test('A. inativação sem corpo (sem Content-Type, sem payload) funciona', async () => {
        const grupo = await criarPelaApi('Sem Corpo Inativar');

        const resposta = await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA);

        assert.equal(resposta.status, 200);
        assert.equal(resposta.body.alterado, true);
        assert.equal((await lerGrupo(pool, grupo.id)).ativo, false);
      });

      test('B. reativação sem corpo funciona', async () => {
        const grupo = await criarPelaApi('Sem Corpo Reativar');
        await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA).send({});

        const resposta = await request(app).post(`/api/grupos-acesso/${grupo.id}/reativar`).set('Cookie', cookieMasterA);

        assert.equal(resposta.status, 200);
        assert.equal(resposta.body.alterado, true);
        assert.equal((await lerGrupo(pool, grupo.id)).ativo, true);
      });

      test('C. inativação com corpo {} (application/json explícito) funciona', async () => {
        const grupo = await criarPelaApi('Corpo Vazio Inativar');

        const resposta = await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA)
          .set('Content-Type', 'application/json').send({});

        assert.equal(resposta.status, 200);
        assert.equal(resposta.body.alterado, true);
        assert.equal((await lerGrupo(pool, grupo.id)).ativo, false);
      });

      test('D. reativação com corpo {} funciona', async () => {
        const grupo = await criarPelaApi('Corpo Vazio Reativar');
        await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA).send({});

        const resposta = await request(app).post(`/api/grupos-acesso/${grupo.id}/reativar`).set('Cookie', cookieMasterA).send({});

        assert.equal(resposta.status, 200);
        assert.equal(resposta.body.alterado, true);
        assert.equal((await lerGrupo(pool, grupo.id)).ativo, true);
      });

      test('E. inativação com ativo ou empresaId no corpo: 400 VALIDACAO, nada gravado', async () => {
        const grupo = await criarPelaApi('Campo Extra Inativar');
        const antes = await lerGrupo(pool, grupo.id);
        const auditoriaAntes = await contarAuditoria(pool, empresaA);

        for (const corpo of [{ ativo: false }, { empresaId: empresaB }]) {
          const resposta = await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA).send(corpo);

          assert.equal(resposta.status, 400, `corpo ${JSON.stringify(corpo)} deveria ser recusado`);
          assert.equal(resposta.body.codigo, 'VALIDACAO');
          assert.equal(resposta.body.detalhes[0].campo.startsWith('body.'), true);
        }

        const depois = await lerGrupo(pool, grupo.id);
        assert.equal(depois.ativo, true, 'ainda ativo: a rejeição não inativou o grupo');
        assert.deepEqual(depois.atualizado_em, antes.atualizado_em, 'nada foi gravado');
        assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'requisição rejeitada não é auditada');
      });

      test('F. reativação com ativo ou isMaster no corpo: 400 VALIDACAO, nada gravado', async () => {
        const grupo = await criarPelaApi('Campo Extra Reativar');
        await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA).send({});
        const antes = await lerGrupo(pool, grupo.id);
        const auditoriaAntes = await contarAuditoria(pool, empresaA);

        for (const corpo of [{ ativo: true }, { isMaster: true }]) {
          const resposta = await request(app).post(`/api/grupos-acesso/${grupo.id}/reativar`).set('Cookie', cookieMasterA).send(corpo);

          assert.equal(resposta.status, 400, `corpo ${JSON.stringify(corpo)} deveria ser recusado`);
          assert.equal(resposta.body.codigo, 'VALIDACAO');
        }

        const depois = await lerGrupo(pool, grupo.id);
        assert.equal(depois.ativo, false, 'ainda inativo: a rejeição não reativou o grupo');
        assert.deepEqual(depois.atualizado_em, antes.atualizado_em, 'nada foi gravado');
        assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'requisição rejeitada não é auditada');
      });

      test('G. demais campos de forja (perfil, atorId, criadoPor) também são recusados nas duas rotas', async () => {
        const grupo = await criarPelaApi('Mais Campos de Forja');

        for (const rota of ['inativar', 'reativar']) {
          for (const corpo of [{ perfil: 'MASTER' }, { atorId: 999 }, { criadoPor: 999 }]) {
            const resposta = await request(app).post(`/api/grupos-acesso/${grupo.id}/${rota}`).set('Cookie', cookieMasterA).send(corpo);
            assert.equal(resposta.status, 400, `${rota} com ${JSON.stringify(corpo)} deveria ser recusado`);
            assert.equal(resposta.body.codigo, 'VALIDACAO');
          }
        }

        assert.equal((await lerGrupo(pool, grupo.id)).ativo, true, 'nenhuma das tentativas rejeitadas alterou o grupo');
      });
    });

    test('não existe rota de exclusão: DELETE responde 404 de rota e o grupo permanece', async () => {
      const grupo = await criarPelaApi('Indestrutível');

      const resposta = await request(app).delete(`/api/grupos-acesso/${grupo.id}`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 404);
      assert.ok(await lerGrupo(pool, grupo.id), 'o grupo continua existindo');
    });

    test('inativar pela API preserva permissões do grupo e vínculos dos usuários', async () => {
      const grupo = await criarPelaApi('Com Permissões HTTP');
      const membro = await inserirUsuario(pool, empresaA, 'membro-http@demo.safeworkengenharia.com.br');
      await pool.query(
        `INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar, pode_excluir)
         VALUES ($1, $2, $3, true, false)`,
        [empresaA, grupo.id, RECURSO],
      );
      await pool.query('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupo.id, membro]);

      const resposta = await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(resposta.status, 200);

      assert.deepEqual(
        await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, grupo.id, RECURSO),
        { podeVisualizar: true, podeCriar: null, podeEditar: null, podeExcluir: false },
        'permissões intactas',
      );
      const { rows: [usuario] } = await pool.query('SELECT grupo_acesso_id FROM usuarios WHERE id = $1', [membro]);
      assert.equal(usuario.grupo_acesso_id, grupo.id, 'usuário continua vinculado');
      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, membro), { id: grupo.id, ativo: false });
    });
  });

  describe('entradas inválidas e conflitos', () => {
    test('nome duplicado na mesma empresa: 409 GRUPO_NOME_EM_USO', async () => {
      await criarPelaApi('Nome Único HTTP');
      const antes = await contarGrupos(pool, empresaA);

      const resposta = await request(app).post('/api/grupos-acesso').set('Cookie', cookieMasterA).send({ nome: 'NOME ÚNICO HTTP' });

      assert.equal(resposta.status, 409);
      assert.equal(resposta.body.codigo, 'GRUPO_NOME_EM_USO');
      assert.equal(await contarGrupos(pool, empresaA), antes);
    });

    test('o mesmo nome em empresas diferentes é aceito', async () => {
      await criarPelaApi('Compartilhado');

      const resposta = await request(app).post('/api/grupos-acesso').set('Cookie', cookieMasterB).send({ nome: 'Compartilhado' });

      assert.equal(resposta.status, 201);
      assert.equal(resposta.body.grupo.empresaId, empresaB);
    });

    test('nome vazio, só espaços, longo demais ou de tipo errado: 400 VALIDACAO', async () => {
      const antes = await contarGrupos(pool, empresaA);

      for (const nome of ['', '   ', 'x'.repeat(101), 42, null]) {
        const resposta = await request(app).post('/api/grupos-acesso').set('Cookie', cookieMasterA).send({ nome });
        assert.equal(resposta.status, 400, `nome ${JSON.stringify(nome)} deveria ser recusado`);
        assert.equal(resposta.body.codigo, 'VALIDACAO');
        assert.equal(Array.isArray(resposta.body.detalhes), true);
        assert.equal(resposta.body.detalhes[0].campo.startsWith('body.'), true);
      }

      const semNome = await request(app).post('/api/grupos-acesso').set('Cookie', cookieMasterA).send({});
      assert.equal(semNome.status, 400);

      assert.equal(await contarGrupos(pool, empresaA), antes);
    });

    test('id de rota não numérico ou não canônico: 400 VALIDACAO', async () => {
      for (const id of ['abc', '0', '007', '1.5', '-1']) {
        const resposta = await request(app).get(`/api/grupos-acesso/${id}`).set('Cookie', cookieMasterA);
        assert.equal(resposta.status, 400, `id ${id} deveria ser recusado`);
        assert.equal(resposta.body.codigo, 'VALIDACAO');
      }
    });

    test('query ?ativo= com valor inválido: 400 VALIDACAO', async () => {
      const resposta = await request(app).get('/api/grupos-acesso?ativo=talvez').set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'VALIDACAO');
    });

    test('respostas de erro não vazam SQL, stack, nome de tabela nem dado de outra empresa', async () => {
      const deB = await criarPelaApi('Segredo de B', { cookie: cookieMasterB });

      const respostas = [
        await request(app).get(`/api/grupos-acesso/${deB.id}`).set('Cookie', cookieMasterA),
        await request(app).post('/api/grupos-acesso').set('Cookie', cookieAdminA).send({ nome: 'X' }),
        await request(app).post('/api/grupos-acesso').set('Cookie', cookieMasterA).send({ nome: '' }),
      ];

      for (const resposta of respostas) {
        const corpo = JSON.stringify(resposta.body);
        assert.doesNotMatch(corpo, /select|insert|update |grupos_acesso|pg_|stack|at Object/i);
        assert.doesNotMatch(corpo, /Segredo de B/);
        assert.equal(corpo.includes(String(empresaB)), false, 'nenhum id de outra empresa');
      }
    });
  });

  describe('rollback', () => {
    test('falha real da auditoria durante POST: 500 genérico e nenhum grupo criado', async (t) => {
      const gruposAntes = await contarGrupos(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada de auditoria'); });

      const resposta = await request(app).post('/api/grupos-acesso').set('Cookie', cookieMasterA).send({ nome: 'Fantasma HTTP' });

      assert.equal(resposta.status, 500);
      assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
      assert.doesNotMatch(JSON.stringify(resposta.body), /falha simulada/, 'a causa interna nunca vaza');
      assert.equal(await contarGrupos(pool, empresaA), gruposAntes, 'o INSERT foi desfeito');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);

      const { rows } = await pool.query('SELECT id FROM grupos_acesso WHERE empresa_id = $1 AND nome = $2', [empresaA, 'Fantasma HTTP']);
      assert.equal(rows.length, 0, 'o nome continua livre');
    });

    test('falha real da auditoria durante inativação: 500 e o grupo continua ativo', async (t) => {
      const grupo = await criarPelaApi('Rollback HTTP Estado');
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada'); });

      const resposta = await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA).send({});

      assert.equal(resposta.status, 500);
      assert.equal((await lerGrupo(pool, grupo.id)).ativo, true, 'a inativação foi desfeita');
    });
  });
});
