'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarMaterialController } = require('../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../src/routes/material.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');

/**
 * API HTTP de materiais e estoque por tamanho (Bloco 9, Etapa A) de ponta
 * a ponta: HTTP -> autenticação real -> rotas reais -> controller real ->
 * serviço real -> PostgreSQL real, em schema temporário removido em
 * cascata ao final.
 *
 * As rotas montadas aqui são EXATAMENTE as de produção
 * (criarMaterialRoutes/criarEstoqueRoutes + os controllers e o middleware
 * de autorização já existentes do Bloco 8), só com pool e limitador
 * exclusivos deste arquivo — o que se prova aqui é o que roda em
 * produção.
 *
 * PROVISIONAMENTO DE PERMISSÕES DO MASTER: como diagnosticado no
 * planejamento do Bloco 9 (seção 10.1), não existe hoje nenhum mecanismo
 * de produção que grave linhas em permissoes_recurso/permissoes_acao para
 * o MASTER — só testes fazem isso, manualmente, como este arquivo faz
 * abaixo (`concederRecursoMaterials`/`concederAcaoMovimentarEstoque`).
 * Essa é uma dependência pendente, registrada no relatório desta etapa,
 * não resolvida por este arquivo de teste.
 */

const MIGRATIONS = [
  '000', '001', '002', '003', '005', '007', '008', '009', '010', '011',
  '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023',
];

const SENHA = 'senha-correta-do-teste-bloco9-etapa-a-2026';
let HASH_SENHA;

const RECURSO = 'materials';
const ACAO_MOVIMENTAR_ESTOQUE = 'MOVIMENTAR_ESTOQUE';

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

async function concederRecursoMaterials(pool, empresaId, perfil, flags) {
  await pool.query(
    `INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (empresa_id, perfil, recurso) DO UPDATE
       SET pode_visualizar = EXCLUDED.pode_visualizar, pode_criar = EXCLUDED.pode_criar,
           pode_editar = EXCLUDED.pode_editar, pode_excluir = EXCLUDED.pode_excluir`,
    [empresaId, perfil, RECURSO, flags.podeVisualizar ?? false, flags.podeCriar ?? false, flags.podeEditar ?? false, flags.podeExcluir ?? false],
  );
}

async function concederAcaoMovimentarEstoque(pool, empresaId, perfil, permitido) {
  await pool.query(
    `INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (empresa_id, perfil, acao_codigo) DO UPDATE SET permitido = EXCLUDED.permitido`,
    [empresaId, perfil, ACAO_MOVIMENTAR_ESTOQUE, permitido],
  );
}

async function contarAuditoria(pool, empresaId, acao) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2', [empresaId, acao]);
  return rows[0].total;
}

describe('API HTTP de materiais e estoque com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let empresaB;
  let cookieMasterA;
  let cookieAdminSemPermissaoA;
  let cookieMasterB;

  const CNPJ_A = '11222333000181';
  const CNPJ_B = '44555666000162';
  const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
  const EMAIL_ADMIN_SEM_PERMISSAO_A = 'admin-sem-permissao-a@demo.safeworkengenharia.com.br';
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

    await inserirUsuario(pool, empresaA, EMAIL_MASTER_A, 'MASTER');
    await inserirUsuario(pool, empresaA, EMAIL_ADMIN_SEM_PERMISSAO_A, 'ADMINISTRADOR');
    await inserirUsuario(pool, empresaB, EMAIL_MASTER_B, 'MASTER');

    // MASTER só é autorizado porque uma linha existe — nenhum bypass de
    // perfil no middleware (ver seção 10.1 do planejamento do Bloco 9).
    await concederRecursoMaterials(pool, empresaA, 'MASTER', {
      podeVisualizar: true, podeCriar: true, podeEditar: true, podeExcluir: false,
    });
    await concederAcaoMovimentarEstoque(pool, empresaA, 'MASTER', true);
    await concederRecursoMaterials(pool, empresaB, 'MASTER', {
      podeVisualizar: true, podeCriar: true, podeEditar: true, podeExcluir: false,
    });
    await concederAcaoMovimentarEstoque(pool, empresaB, 'MASTER', true);
    // EMAIL_ADMIN_SEM_PERMISSAO_A deliberadamente SEM nenhuma linha em
    // permissoes_recurso/permissoes_acao — cenário de perfil sem permissão.

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao });
    const materialRoutes = criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool });
    const estoqueRoutes = criarEstoqueRoutes({ controller: criarEstoqueController({ pool }), exigirSessao, pool });

    app = criarAppTeste((a) => { a.use('/api', authRoutes, materialRoutes, estoqueRoutes); });

    cookieMasterA = await login(CNPJ_A, EMAIL_MASTER_A);
    cookieAdminSemPermissaoA = await login(CNPJ_A, EMAIL_ADMIN_SEM_PERMISSAO_A);
    cookieMasterB = await login(CNPJ_B, EMAIL_MASTER_B);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('Cenário 1 — sem cookie', () => {
    test('todas as rotas exigem sessão: 401 antes de qualquer autorização', async () => {
      const rotas = [
        () => request(app).post('/api/materiais').send({ nome: 'Botina' }),
        () => request(app).get('/api/materiais'),
        () => request(app).get('/api/materiais/1'),
        () => request(app).patch('/api/materiais/1').send({ nome: 'Botina' }),
        () => request(app).post('/api/materiais/1/inativar').send({}),
        () => request(app).get('/api/materiais/1/estoque'),
        () => request(app).post('/api/materiais/1/estoque/movimentar').send({ tamanho: '40', tipo: 'ENTRADA', quantidade: 1 }),
      ];
      for (const chamar of rotas) {
        const resposta = await chamar();
        assert.equal(resposta.status, 401);
        assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
      }
    });
  });

  describe('Cenário 2 — perfil sem permissão de recurso nem de ação', () => {
    test('POST /materiais: 403 PERMISSAO_NEGADA, nada é criado', async () => {
      const resposta = await request(app).post('/api/materiais').set('Cookie', cookieAdminSemPermissaoA).send({ nome: 'Botina' });
      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    });

    test('GET /materiais: 403, mesma mensagem — não revela se algum material existe', async () => {
      const resposta = await request(app).get('/api/materiais').set('Cookie', cookieAdminSemPermissaoA);
      assert.equal(resposta.status, 403);
    });
  });

  let materialId;

  describe('Cenário 3 — MASTER autorizado: cadastro completo de material', () => {
    test('cria material com todos os campos, audita MATERIAL_CRIADO', async () => {
      const antes = await contarAuditoria(pool, empresaA, 'MATERIAL_CRIADO');

      const resposta = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({
        nome: 'Botina de segurança', tipo: 'Sapatão / Botina', fabricante: 'Bracol',
        caNumero: '38271', caValidade: '2026-08-15', prazoUsoDias: 365, unidade: 'par', estoqueMinimo: 5,
      });

      assert.equal(resposta.status, 201);
      assert.equal(resposta.body.material.nome, 'Botina de segurança');
      assert.equal(resposta.body.material.ativo, true);
      materialId = resposta.body.material.id;

      assert.equal(await contarAuditoria(pool, empresaA, 'MATERIAL_CRIADO'), antes + 1);
    });

    test('nome vazio: 400 MATERIAL_NOME_INVALIDO (nesta etapa, validado antes pelo schema com VALIDACAO)', async () => {
      const resposta = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: '   ' });
      assert.equal(resposta.status, 400);
    });

    test('prazoUsoDias zero: 400 (schema Zod recusa antes do serviço)', async () => {
      const resposta = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Botina', prazoUsoDias: 0 });
      assert.equal(resposta.status, 400);
    });

    test('ano 0000 na validade do CA (0000-01-01 e 0000-02-29): 400 VALIDACAO com CA_VALIDADE_INVALIDA, nada gravado, nenhuma auditoria — no cadastro e na edição (auditoria v2)', async () => {
      const contarMateriais = async () => {
        const { rows } = await pool.query('SELECT count(*)::int AS total FROM materiais WHERE empresa_id = $1', [empresaA]);
        return rows[0].total;
      };
      const materiaisAntes = await contarMateriais();
      const criadosAntes = await contarAuditoria(pool, empresaA, 'MATERIAL_CRIADO');
      const alteradosAntes = await contarAuditoria(pool, empresaA, 'MATERIAL_ALTERADO');

      for (const caValidade of ['0000-01-01', '0000-02-29']) {
        const criar = await request(app).post('/api/materiais').set('Cookie', cookieMasterA)
          .send({ nome: 'Material com CA no ano zero', caValidade });
        assert.equal(criar.status, 400, `${caValidade} no cadastro`);
        assert.equal(criar.body.codigo, 'VALIDACAO');
        assert.ok(criar.body.detalhes.some((d) => d.campo === 'body.caValidade' && d.codigo === 'CA_VALIDADE_INVALIDA'));

        const alterar = await request(app).patch(`/api/materiais/${materialId}`).set('Cookie', cookieMasterA)
          .send({ caValidade });
        assert.equal(alterar.status, 400, `${caValidade} na edição`);
        assert.equal(alterar.body.codigo, 'VALIDACAO');
        assert.ok(alterar.body.detalhes.some((d) => d.campo === 'body.caValidade' && d.codigo === 'CA_VALIDADE_INVALIDA'));
      }

      assert.equal(await contarMateriais(), materiaisAntes, 'nenhum material gravado');
      assert.equal(await contarAuditoria(pool, empresaA, 'MATERIAL_CRIADO'), criadosAntes, 'nenhuma auditoria de criação');
      assert.equal(await contarAuditoria(pool, empresaA, 'MATERIAL_ALTERADO'), alteradosAntes, 'nenhuma auditoria de alteração');
    });

    test('campo desconhecido no corpo: 400 VALIDACAO', async () => {
      const resposta = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Botina', ativo: false });
      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'VALIDACAO');
    });

    test('GET /materiais/:id devolve o material criado', async () => {
      const resposta = await request(app).get(`/api/materiais/${materialId}`).set('Cookie', cookieMasterA);
      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.material.id, materialId);
    });

    test('GET /materiais lista com paginação', async () => {
      const resposta = await request(app).get('/api/materiais?pagina=1&limite=20').set('Cookie', cookieMasterA);
      assert.equal(resposta.status, 200);
      assert.ok(resposta.body.materiais.some((m) => m.id === materialId));
      assert.equal(resposta.body.total >= 1, true);
    });

    test('PATCH altera nome e limpa fabricante (null explícito), audita MATERIAL_ALTERADO', async () => {
      const resposta = await request(app).patch(`/api/materiais/${materialId}`).set('Cookie', cookieMasterA)
        .send({ nome: 'Botina de segurança reforçada', fabricante: null });

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.material.nome, 'Botina de segurança reforçada');
      assert.equal(resposta.body.material.fabricante, null);
      assert.equal(await contarAuditoria(pool, empresaA, 'MATERIAL_ALTERADO'), 1);
    });

    test('PATCH sem nenhum campo: 400 MATERIAL_SEM_ALTERACAO', async () => {
      const resposta = await request(app).patch(`/api/materiais/${materialId}`).set('Cookie', cookieMasterA).send({});
      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'MATERIAL_SEM_ALTERACAO');
    });
  });

  describe('Cenário 4 — isolamento entre empresas', () => {
    test('MASTER da empresa B não encontra material da empresa A: 404, nunca 403 (não revela existência)', async () => {
      const resposta = await request(app).get(`/api/materiais/${materialId}`).set('Cookie', cookieMasterB);
      assert.equal(resposta.status, 404);
      assert.equal(resposta.body.codigo, 'MATERIAL_NAO_ENCONTRADO');
    });

    test('MASTER da empresa B não altera material da empresa A', async () => {
      const resposta = await request(app).patch(`/api/materiais/${materialId}`).set('Cookie', cookieMasterB).send({ nome: 'Sequestro' });
      assert.equal(resposta.status, 404);
    });

    test('GET /materiais da empresa B nunca lista o material da empresa A', async () => {
      const resposta = await request(app).get('/api/materiais').set('Cookie', cookieMasterB);
      assert.equal(resposta.status, 200);
      assert.ok(!resposta.body.materiais.some((m) => m.id === materialId));
    });
  });

  describe('Cenário 5 — estoque: consulta protegida por recurso, movimentação por ação', () => {
    test('GET estoque com apenas permissão de recurso: 200, lista vazia (nenhuma entrada ainda)', async () => {
      const resposta = await request(app).get(`/api/materiais/${materialId}/estoque`).set('Cookie', cookieMasterA);
      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body.saldos, []);
    });

    test('POST movimentar sem MOVIMENTAR_ESTOQUE concedido: 403 PERMISSAO_NEGADA', async () => {
      // Admin sem permissão nenhuma nem de recurso nem de ação.
      const resposta = await request(app).post(`/api/materiais/${materialId}/estoque/movimentar`)
        .set('Cookie', cookieAdminSemPermissaoA).send({ tamanho: '40', tipo: 'ENTRADA', quantidade: 10 });
      assert.equal(resposta.status, 403);
    });

    test('ENTRADA cria o saldo do zero, audita ESTOQUE_MOVIMENTADO', async () => {
      const antes = await contarAuditoria(pool, empresaA, 'ESTOQUE_MOVIMENTADO');

      const resposta = await request(app).post(`/api/materiais/${materialId}/estoque/movimentar`)
        .set('Cookie', cookieMasterA).send({ tamanho: '40', tipo: 'ENTRADA', quantidade: 12, motivo: 'Compra inicial' });

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.saldo.tamanho, '40');
      assert.equal(resposta.body.saldo.quantidade, 12);
      assert.equal(await contarAuditoria(pool, empresaA, 'ESTOQUE_MOVIMENTADO'), antes + 1);
    });

    test('GET estoque agora reflete o saldo criado', async () => {
      const resposta = await request(app).get(`/api/materiais/${materialId}/estoque`).set('Cookie', cookieMasterA);
      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body.saldos.map((s) => ({ tamanho: s.tamanho, quantidade: s.quantidade })), [{ tamanho: '40', quantidade: 12 }]);
    });

    test('SAIDA menor que o saldo: subtrai corretamente', async () => {
      const resposta = await request(app).post(`/api/materiais/${materialId}/estoque/movimentar`)
        .set('Cookie', cookieMasterA).send({ tamanho: '40', tipo: 'SAIDA', quantidade: 5 });

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.saldo.quantidade, 7);
    });

    test('SAIDA maior que o saldo: 409 ESTOQUE_INSUFICIENTE, saldo não muda', async () => {
      const resposta = await request(app).post(`/api/materiais/${materialId}/estoque/movimentar`)
        .set('Cookie', cookieMasterA).send({ tamanho: '40', tipo: 'SAIDA', quantidade: 100 });

      assert.equal(resposta.status, 409);
      assert.equal(resposta.body.codigo, 'ESTOQUE_INSUFICIENTE');

      const conferencia = await request(app).get(`/api/materiais/${materialId}/estoque`).set('Cookie', cookieMasterA);
      assert.equal(conferencia.body.saldos.find((s) => s.tamanho === '40').quantidade, 7, 'saldo permanece intacto após recusa');
    });

    test('quantidade zero ou negativa: 400 (schema Zod recusa antes do serviço)', async () => {
      for (const quantidade of [0, -1]) {
        const resposta = await request(app).post(`/api/materiais/${materialId}/estoque/movimentar`)
          .set('Cookie', cookieMasterA).send({ tamanho: '40', tipo: 'ENTRADA', quantidade });
        assert.equal(resposta.status, 400);
      }
    });

    test('tipo inválido: 400', async () => {
      const resposta = await request(app).post(`/api/materiais/${materialId}/estoque/movimentar`)
        .set('Cookie', cookieMasterA).send({ tamanho: '40', tipo: 'AJUSTE', quantidade: 1 });
      assert.equal(resposta.status, 400);
    });
  });

  describe('Cenário 6 — inativação bloqueia movimentação, mesmo para o MASTER (restrição estrutural)', () => {
    test('inativa o material, audita MATERIAL_INATIVADO', async () => {
      const resposta = await request(app).post(`/api/materiais/${materialId}/inativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.material.ativo, false);
      assert.equal(resposta.body.alterado, true);
      assert.equal(await contarAuditoria(pool, empresaA, 'MATERIAL_INATIVADO'), 1);
    });

    test('inativar de novo é idempotente: alterado=false, sem nova auditoria', async () => {
      const resposta = await request(app).post(`/api/materiais/${materialId}/inativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.alterado, false);
      assert.equal(await contarAuditoria(pool, empresaA, 'MATERIAL_INATIVADO'), 1, 'nenhuma auditoria extra');
    });

    test('movimentar estoque de material inativo: 409 MATERIAL_INATIVO, mesmo para o MASTER', async () => {
      const resposta = await request(app).post(`/api/materiais/${materialId}/estoque/movimentar`)
        .set('Cookie', cookieMasterA).send({ tamanho: '40', tipo: 'ENTRADA', quantidade: 1 });
      assert.equal(resposta.status, 409);
      assert.equal(resposta.body.codigo, 'MATERIAL_INATIVO');
    });

    test('reativa o material, audita MATERIAL_REATIVADO, movimentação volta a funcionar', async () => {
      const reativar = await request(app).post(`/api/materiais/${materialId}/reativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(reativar.status, 200);
      assert.equal(reativar.body.material.ativo, true);
      assert.equal(await contarAuditoria(pool, empresaA, 'MATERIAL_REATIVADO'), 1);

      const movimentar = await request(app).post(`/api/materiais/${materialId}/estoque/movimentar`)
        .set('Cookie', cookieMasterA).send({ tamanho: '40', tipo: 'ENTRADA', quantidade: 1 });
      assert.equal(movimentar.status, 200);
      assert.equal(movimentar.body.saldo.quantidade, 8);
    });
  });

  describe('Cenário 7 — busca por nome trata % e _ como texto literal (correção pós-auditoria de 23/09/2026)', () => {
    let materialPercentualId;

    test('cria um material cujo nome contém "%" e "_" literais', async () => {
      const resposta = await request(app).post('/api/materiais').set('Cookie', cookieMasterA)
        .send({ nome: '100%_algodão' });
      assert.equal(resposta.status, 201);
      materialPercentualId = resposta.body.material.id;
    });

    test('buscar por "100%_algodão" encontra exatamente esse material, não qualquer material (o que aconteceria se % e _ fossem coringas)', async () => {
      const resposta = await request(app).get('/api/materiais?busca=100%25_algod%C3%A3o').set('Cookie', cookieMasterA);
      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body.materiais.map((m) => m.id), [materialPercentualId]);
    });

    test('buscar só por "%" não devolve todos os materiais da empresa — o caractere é tratado como texto, não como coringa', async () => {
      const resposta = await request(app).get('/api/materiais?busca=%25').set('Cookie', cookieMasterA);
      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body.materiais.map((m) => m.id), [materialPercentualId], 'só o material que realmente tem "%" no nome');
    });

    test('buscar por "botina" continua encontrando por substring normal, sem quebrar com a correção', async () => {
      const resposta = await request(app).get('/api/materiais?busca=botina').set('Cookie', cookieMasterA);
      assert.equal(resposta.status, 200);
      assert.ok(resposta.body.materiais.some((m) => m.id === materialId));
      assert.ok(!resposta.body.materiais.some((m) => m.id === materialPercentualId));
    });
  });

  describe('Cenário 8 — concorrência: duas saídas simultâneas nunca produzem estoque negativo (correção pós-auditoria de 23/09/2026)', () => {
    let materialConcorrenciaId;

    test('prepara um material ativo com saldo inicial de 10 unidades', async () => {
      const criar = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Luva de concorrência' });
      assert.equal(criar.status, 201);
      materialConcorrenciaId = criar.body.material.id;

      const entrada = await request(app).post(`/api/materiais/${materialConcorrenciaId}/estoque/movimentar`)
        .set('Cookie', cookieMasterA).send({ tamanho: 'M', tipo: 'ENTRADA', quantidade: 10 });
      assert.equal(entrada.status, 200);
      assert.equal(entrada.body.saldo.quantidade, 10);
    });

    test('duas SAÍDAs simultâneas de 6 (total 12, saldo 10): exatamente uma sucede, a outra recusa por saldo insuficiente, saldo final nunca fica negativo', async () => {
      const disparar = () => request(app).post(`/api/materiais/${materialConcorrenciaId}/estoque/movimentar`)
        .set('Cookie', cookieMasterA).send({ tamanho: 'M', tipo: 'SAIDA', quantidade: 6 });

      // As duas requisições HTTP partem juntas — o que serializa a decisão
      // é o FOR UPDATE OF et em estoque-tamanho.repository.js: a segunda
      // transação só lê o saldo depois que a primeira libera o lock no
      // COMMIT/ROLLBACK, nunca as duas decidindo sobre o mesmo saldo
      // "congelado" ao mesmo tempo.
      const [respostaA, respostaB] = await Promise.all([disparar(), disparar()]);

      const respostas = [respostaA, respostaB];
      const sucessos = respostas.filter((r) => r.status === 200);
      const recusas = respostas.filter((r) => r.status === 409);

      assert.equal(sucessos.length, 1, 'exatamente uma das duas saídas concorrentes deve suceder');
      assert.equal(recusas.length, 1, 'a outra deve ser recusada por saldo insuficiente');
      assert.equal(recusas[0].body.codigo, 'ESTOQUE_INSUFICIENTE');

      const conferencia = await request(app).get(`/api/materiais/${materialConcorrenciaId}/estoque`).set('Cookie', cookieMasterA);
      const saldoFinal = conferencia.body.saldos.find((s) => s.tamanho === 'M').quantidade;
      assert.equal(saldoFinal, 4, '10 - 6 da saída que sucedeu; nunca negativo');
      assert.ok(saldoFinal >= 0, 'nunca negativo, sob nenhuma circunstância');
    });

    test('duas ENTRADAs simultâneas: as duas sucedem e o saldo final soma as duas (sem perda por corrida)', async () => {
      const disparar = () => request(app).post(`/api/materiais/${materialConcorrenciaId}/estoque/movimentar`)
        .set('Cookie', cookieMasterA).send({ tamanho: 'G', tipo: 'ENTRADA', quantidade: 3 });

      const [respostaA, respostaB] = await Promise.all([disparar(), disparar()]);

      assert.equal(respostaA.status, 200);
      assert.equal(respostaB.status, 200);

      const conferencia = await request(app).get(`/api/materiais/${materialConcorrenciaId}/estoque`).set('Cookie', cookieMasterA);
      const saldoFinal = conferencia.body.saldos.find((s) => s.tamanho === 'G').quantidade;
      assert.equal(saldoFinal, 6, 'as duas entradas de 3 somam 6 — nenhuma foi perdida por condição de corrida (a segunda cria a linha, ver estoque-tamanho.repository.js:criar, ou a trava serializa a segunda leitura)');
    });
  });
});
