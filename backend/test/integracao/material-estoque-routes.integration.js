'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { inserirLote } = require('./helpers/estoque-lotes');
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
  '000', '001', '002', '003', '004', '005', '025', '007', '008', '009', '010', '011',
  '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023',
  '039', '041', '042', '044',
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
        caNumero: '38271', caValidade: '2026-08-15', prazoUsoDias: 365, exigeTamanho: true, unidade: 'par', estoqueMinimo: 5,
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
      const resposta = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Botina', prazoUsoDias: 0, exigeTamanho: true });
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
        .send({ nome: '100%_algodão', prazoUsoDias: 180, exigeTamanho: true });
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

  describe('Cenário 9 — Parte C2: categoria, código interno e descrição', () => {
    let idComCodigo;

    test('MASTER cadastra com categoria, código interno e descrição; os três voltam na resposta e na consulta; auditoria registra os três', async () => {
      const resposta = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({
        nome: 'Luva nitrílica C2', categoria: 'EPI', codigoInterno: 'EPI-000245', descricao: 'Proteção química leve',
        caNumero: '55771', caValidade: '2027-04-30', prazoUsoDias: 180, exigeTamanho: true, unidade: 'par', estoqueMinimo: 5,
      });
      assert.equal(resposta.status, 201, JSON.stringify(resposta.body));
      assert.deepEqual(
        [resposta.body.material.categoria, resposta.body.material.codigoInterno, resposta.body.material.descricao],
        ['EPI', 'EPI-000245', 'Proteção química leve'],
      );
      idComCodigo = resposta.body.material.id;
      const consulta = await request(app).get(`/api/materiais/${idComCodigo}`).set('Cookie', cookieMasterA);
      assert.equal(consulta.body.material.codigoInterno, 'EPI-000245');
      const { rows } = await pool.query("SELECT dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'MATERIAL_CRIADO' AND referencia = $2", [empresaA, String(idComCodigo)]);
      assert.deepEqual([rows[0].dados_novos.categoria, rows[0].dados_novos.codigoInterno, rows[0].dados_novos.descricao], ['EPI', 'EPI-000245', 'Proteção química leve']);
    });

    test('código interno duplicado na MESMA empresa (mesmo com caixa diferente): 409 MATERIAL_CODIGO_INTERNO_DUPLICADO, nada criado', async () => {
      const { rows: antes } = await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresaA]);
      const r = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Outra luva', codigoInterno: 'epi-000245', prazoUsoDias: 180, exigeTamanho: true });
      assert.deepEqual([r.status, r.body.codigo], [409, 'MATERIAL_CODIGO_INTERNO_DUPLICADO']);
      const { rows: depois } = await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresaA]);
      assert.equal(depois[0].n, antes[0].n);
      const patch = await request(app).patch(`/api/materiais/${materialId}`).set('Cookie', cookieMasterA).send({ codigoInterno: 'EPI-000245' });
      assert.deepEqual([patch.status, patch.body.codigo], [409, 'MATERIAL_CODIGO_INTERNO_DUPLICADO']);
    });

    test('empresa B pode usar o mesmo código interno da empresa A', async () => {
      const r = await request(app).post('/api/materiais').set('Cookie', cookieMasterB).send({ nome: 'Luva da B', codigoInterno: 'EPI-000245', prazoUsoDias: 180, exigeTamanho: true });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });

    test('vazio ou só espaços nos três campos: 400 VALIDACAO, como já ocorre com tipo/fabricante (o cliente converte vazio em null)', async () => {
      for (const corpo of [{ categoria: '' }, { codigoInterno: '   ' }, { descricao: '' }, { tipo: '' }]) {
        const r = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Vazio', ...corpo });
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
      }
    });

    test('null nos três campos: 201 com null, e vários materiais sem código não conflitam entre si', async () => {
      const a = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Sem código A', categoria: null, codigoInterno: null, descricao: null, prazoUsoDias: 180, exigeTamanho: true });
      const b = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Sem código B', codigoInterno: null, prazoUsoDias: 180, exigeTamanho: true });
      const c = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Sem código C', prazoUsoDias: 180, exigeTamanho: true });
      assert.deepEqual([a.status, b.status, c.status], [201, 201, 201]);
      assert.deepEqual([a.body.material.categoria, a.body.material.codigoInterno, a.body.material.descricao], [null, null, null]);
      assert.deepEqual([b.body.material.codigoInterno, c.body.material.codigoInterno], [null, null]);
    });

    test('PATCH: null explícito limpa o código; ausente não mexe', async () => {
      const limpa = await request(app).patch(`/api/materiais/${idComCodigo}`).set('Cookie', cookieMasterA).send({ codigoInterno: null });
      assert.deepEqual([limpa.status, limpa.body.material.codigoInterno, limpa.body.material.categoria], [200, null, 'EPI']);
      const denovo = await request(app).patch(`/api/materiais/${idComCodigo}`).set('Cookie', cookieMasterA).send({ codigoInterno: 'EPI-000245' });
      assert.equal(denovo.status, 200, 'liberado depois de limpo');
    });

    test('acima dos limites (categoria/código 30, descrição 500) e campo desconhecido: 400 VALIDACAO', async () => {
      for (const corpo of [{ categoria: 'a'.repeat(31) }, { codigoInterno: 'b'.repeat(31) }, { descricao: 'c'.repeat(501) }, { quantidadeComprada: 10 }]) {
        const r = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Limite', ...corpo });
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
      }
    });

    test('perfil sem materials.criar: 403 mesmo com os campos novos', async () => {
      const r = await request(app).post('/api/materiais').set('Cookie', cookieAdminSemPermissaoA).send({ nome: 'Tentativa', codigoInterno: 'X-1' });
      assert.equal(r.status, 403);
    });
  });

  describe('Cenário 8 — concorrência: duas saídas simultâneas nunca produzem estoque negativo (correção pós-auditoria de 23/09/2026)', () => {
    let materialConcorrenciaId;

    test('prepara um material ativo com saldo inicial de 10 unidades', async () => {
      const criar = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Luva de concorrência', prazoUsoDias: 180, exigeTamanho: true });
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

  describe('Cenário 9 — prazo de uso obrigatório no cadastro e na edição', () => {
    const contarMateriais = async (empresaId) => (await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresaId])).rows[0].n;
    let idPrazo;

    test('cadastro sem prazo, com null, zero ou negativo: 400 VALIDACAO no campo prazoUsoDias, nada criado', async () => {
      const antes = await contarMateriais(empresaA);
      for (const [corpo, codigo] of [
        [{ nome: 'Sem prazo', exigeTamanho: true }, 'CAMPO_OBRIGATORIO'],
        [{ nome: 'Prazo nulo', prazoUsoDias: null, exigeTamanho: true }, 'TIPO_INVALIDO'],
        [{ nome: 'Prazo zero', prazoUsoDias: 0, exigeTamanho: true }, 'TAMANHO_MINIMO'],
        [{ nome: 'Prazo negativo', prazoUsoDias: -30, exigeTamanho: true }, 'TAMANHO_MINIMO'],
      ]) {
        const r = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send(corpo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
        assert.deepEqual(r.body.detalhes.map((d) => [d.campo, d.codigo]), [['body.prazoUsoDias', codigo]]);
      }
      assert.equal(await contarMateriais(empresaA), antes);
    });

    test('cadastro com prazo positivo: 201 com o prazo gravado', async () => {
      const r = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send({ nome: 'Botina com prazo', prazoUsoDias: 180, exigeTamanho: true });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.material.prazoUsoDias, 180);
      idPrazo = r.body.material.id;
    });

    test('edição para mais ou para menos: 200, e o prazo novo passa a ser o do cadastro', async () => {
      for (const prazoUsoDias of [240, 90]) {
        const r = await request(app).patch(`/api/materiais/${idPrazo}`).set('Cookie', cookieMasterA).send({ prazoUsoDias });
        assert.deepEqual([r.status, r.body.material.prazoUsoDias], [200, prazoUsoDias]);
      }
      assert.equal((await request(app).get(`/api/materiais/${idPrazo}`).set('Cookie', cookieMasterA)).body.material.prazoUsoDias, 90);
    });

    test('edição para null ou zero: 400, e o prazo atual não muda', async () => {
      for (const [prazoUsoDias, codigo] of [[null, 'TIPO_INVALIDO'], [0, 'TAMANHO_MINIMO']]) {
        const r = await request(app).patch(`/api/materiais/${idPrazo}`).set('Cookie', cookieMasterA).send({ prazoUsoDias });
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO']);
        assert.deepEqual(r.body.detalhes.map((d) => [d.campo, d.codigo]), [['body.prazoUsoDias', codigo]]);
      }
      assert.equal((await request(app).get(`/api/materiais/${idPrazo}`).set('Cookie', cookieMasterA)).body.material.prazoUsoDias, 90);
    });

    test('material legado sem prazo continua editável sem apagar nada; ao receber um prazo, passa a tê-lo', async () => {
      const { rows } = await pool.query("INSERT INTO materiais (empresa_id, nome) VALUES ($1, 'Legado sem prazo') RETURNING id", [empresaA]);
      const legado = rows[0].id;
      const soNome = await request(app).patch(`/api/materiais/${legado}`).set('Cookie', cookieMasterA).send({ nome: 'Legado renomeado' });
      assert.deepEqual([soNome.status, soNome.body.material.prazoUsoDias], [200, null]);
      const comPrazo = await request(app).patch(`/api/materiais/${legado}`).set('Cookie', cookieMasterA).send({ prazoUsoDias: 365 });
      assert.deepEqual([comPrazo.status, comPrazo.body.material.prazoUsoDias], [200, 365]);
    });

    test('empresa B não altera o prazo de material da empresa A', async () => {
      const r = await request(app).patch(`/api/materiais/${idPrazo}`).set('Cookie', cookieMasterB).send({ prazoUsoDias: 30 });
      assert.equal(r.status, 404);
      assert.equal((await request(app).get(`/api/materiais/${idPrazo}`).set('Cookie', cookieMasterA)).body.material.prazoUsoDias, 90);
    });
  });

  describe('Cenário 10 — exigência de tamanho explícita no material', () => {
    const cadastro = (extra) => ({ nome: `Material ${Math.random()}`, prazoUsoDias: 180, ...extra });
    const criarMaterial = async (extra) => {
      const r = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send(cadastro(extra));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.material;
    };
    const patch = (id, corpo, cookie = cookieMasterA) => request(app).patch(`/api/materiais/${id}`).set('Cookie', cookie).send(corpo);
    const entrada = (id, extra = {}) => request(app).post(`/api/materiais/${id}/estoque/entradas`).set('Cookie', cookieMasterA)
      .send({ quantidade: 5, caNumero: '12345', caValidade: '2030-12-31', chaveIdempotencia: crypto.randomUUID(), ...extra });
    const baixa = (loteId, quantidade) => request(app).post(`/api/estoque/lotes/${loteId}/baixas`).set('Cookie', cookieMasterA)
      .send({ quantidade, motivo: 'AJUSTE_INVENTARIO', chaveIdempotencia: crypto.randomUUID() });
    const legado = async () => (await pool.query(
      "INSERT INTO materiais (empresa_id, nome, prazo_uso_dias) VALUES ($1, 'Legado sem classificação', 180) RETURNING id",
      [empresaA],
    )).rows[0].id;
    const lotesDoMaterial = async (id) => (await pool.query(
      'SELECT id, tamanho, origem, quantidade_entrada, saldo FROM estoque_lotes WHERE material_id = $1 ORDER BY id', [id],
    )).rows;

    test('cadastro sem exigeTamanho, com null ou com texto: 400 VALIDACAO no campo exigeTamanho, nada criado', async () => {
      const antes = (await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresaA])).rows[0].n;
      for (const [extra, codigo] of [[{}, 'CAMPO_OBRIGATORIO'], [{ exigeTamanho: null }, 'TIPO_INVALIDO'], [{ exigeTamanho: 'sim' }, 'TIPO_INVALIDO']]) {
        const r = await request(app).post('/api/materiais').set('Cookie', cookieMasterA).send(cadastro(extra));
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(extra));
        assert.deepEqual(r.body.detalhes.map((d) => [d.campo, d.codigo]), [['body.exigeTamanho', codigo]]);
      }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresaA])).rows[0].n, antes);
    });

    test('cadastro com true e com false: 201, e o valor volta na resposta e na consulta', async () => {
      for (const exigeTamanho of [true, false]) {
        const material = await criarMaterial({ exigeTamanho });
        assert.equal(material.exigeTamanho, exigeTamanho);
        const consulta = await request(app).get(`/api/materiais/${material.id}`).set('Cookie', cookieMasterA);
        assert.equal(consulta.body.material.exigeTamanho, exigeTamanho);
      }
    });

    test('legado sem classificação continua editável em outro campo; a classificação fica null e a entrada fica bloqueada', async () => {
      const id = await legado();
      const r = await patch(id, { nome: 'Legado renomeado', prazoUsoDias: 200 });
      assert.deepEqual([r.status, r.body.material.nome, r.body.material.exigeTamanho], [200, 'Legado renomeado', null]);
      const bloqueada = await entrada(id, { tamanho: '40' });
      assert.deepEqual([bloqueada.status, bloqueada.body.codigo], [409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO']);
    });

    test('primeira classificação do legado, para true ou para false, mesmo com saldo legado de qualquer tamanho; os lotes não mudam', async () => {
      for (const exigeTamanho of [true, false]) {
        const id = await legado();
        await inserirLote(pool, { empresaId: empresaA, materialId: id, tamanho: 'Único', quantidade: 4 });
        await inserirLote(pool, { empresaId: empresaA, materialId: id, tamanho: null, quantidade: 2 });
        const lotesAntes = await lotesDoMaterial(id);
        const r = await patch(id, { exigeTamanho });
        assert.deepEqual([r.status, r.body.material.exigeTamanho], [200, exigeTamanho]);
        assert.deepEqual(await lotesDoMaterial(id), lotesAntes, 'nenhum lote é reescrito');
      }
    });

    test('mudança posterior com saldo positivo incompatível: 409 MATERIAL_TAMANHO_SALDO_INCOMPATIVEL nos dois sentidos', async () => {
      const comTamanho = await criarMaterial({ exigeTamanho: true });
      assert.equal((await entrada(comTamanho.id, { tamanho: '40' })).status, 201);
      const semTamanho = await criarMaterial({ exigeTamanho: false });
      assert.equal((await entrada(semTamanho.id)).status, 201);

      for (const [id, novo] of [[comTamanho.id, false], [semTamanho.id, true]]) {
        const r = await patch(id, { exigeTamanho: novo });
        assert.deepEqual([r.status, r.body.codigo], [409, 'MATERIAL_TAMANHO_SALDO_INCOMPATIVEL']);
        assert.equal((await request(app).get(`/api/materiais/${id}`).set('Cookie', cookieMasterA)).body.material.exigeTamanho, !novo);
      }
    });

    test('mudança compatível funciona: sem saldo incompatível, de true para false e de volta; repetir o valor atual também', async () => {
      const material = await criarMaterial({ exigeTamanho: true });
      for (const exigeTamanho of [false, true, true]) {
        const r = await patch(material.id, { exigeTamanho });
        assert.deepEqual([r.status, r.body.material.exigeTamanho], [200, exigeTamanho]);
      }
    });

    test('saldo zero histórico não impede a mudança; o lote antigo continua como estava', async () => {
      const material = await criarMaterial({ exigeTamanho: true });
      const criada = await entrada(material.id, { tamanho: '41', quantidade: 3 });
      assert.equal(criada.status, 201);
      assert.equal((await baixa(criada.body.lote.loteId, 3)).status, 201);
      const r = await patch(material.id, { exigeTamanho: false });
      assert.deepEqual([r.status, r.body.material.exigeTamanho], [200, false]);
      assert.deepEqual(await lotesDoMaterial(material.id), [
        { id: criada.body.lote.loteId, tamanho: '41', origem: 'ENTRADA', quantidade_entrada: 3, saldo: 0 },
      ]);
      assert.equal((await entrada(material.id)).status, 201, 'a partir de agora, entrada sem tamanho');
    });

    test('edição para null é 400; a empresa B não altera a classificação de material da A', async () => {
      const material = await criarMaterial({ exigeTamanho: true });
      const nulo = await patch(material.id, { exigeTamanho: null });
      assert.deepEqual([nulo.status, nulo.body.detalhes.map((d) => [d.campo, d.codigo])], [400, [['body.exigeTamanho', 'TIPO_INVALIDO']]]);
      assert.equal((await patch(material.id, { exigeTamanho: false }, cookieMasterB)).status, 404);
      assert.equal((await request(app).get(`/api/materiais/${material.id}`).set('Cookie', cookieMasterA)).body.material.exigeTamanho, true);
    });
  });
});
