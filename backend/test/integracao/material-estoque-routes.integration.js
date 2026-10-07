'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
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

const MIGRATIONS = todasAsMigrations();

const SENHA = 'senha-correta-do-teste-bloco9-etapa-a-2026';
let HASH_SENHA;

const RECURSO = 'materials';
// 078: entrada e baixa são ações independentes; os cenários antigos concedem as duas juntas (a independência tem teste próprio).
const ACOES_ESTOQUE = ['ENTRADA_ESTOQUE', 'BAIXA_ESTOQUE'];

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
  for (const acao of ACOES_ESTOQUE) {
    await pool.query(
      `INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (empresa_id, perfil, acao_codigo) DO UPDATE SET permitido = EXCLUDED.permitido`,
      [empresaId, perfil, acao, permitido],
    );
  }
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
        () => request(app).get('/api/materiais/1/estoque/lotes'),
        () => request(app).post('/api/materiais/1/estoque/entradas').send({ tamanho: '40', quantidade: 1 }),
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
        nome: 'Botina de segurança', categoria: 'EPI', tipo: 'Botina de Segurança', fabricante: 'Bracol',
        prazoUsoDias: 365, exigeTamanho: true, unidade: 'par', estoqueMinimo: 5,
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

    // E10: o material não tem CA; a validade do CA é do lote, com a mesma checagem estrita de calendário.
    test('CA no cadastro ou na edição do material, com qualquer valor: 400 VALIDACAO (campo não permitido), nada gravado, nenhuma auditoria', async () => {
      const contarMateriais = async () => {
        const { rows } = await pool.query('SELECT count(*)::int AS total FROM materiais WHERE empresa_id = $1', [empresaA]);
        return rows[0].total;
      };
      const materiaisAntes = await contarMateriais();
      const criadosAntes = await contarAuditoria(pool, empresaA, 'MATERIAL_CRIADO');
      const alteradosAntes = await contarAuditoria(pool, empresaA, 'MATERIAL_ALTERADO');

      for (const [campo, valor] of [['caValidade', '0000-01-01'], ['caValidade', '2030-02-28'], ['caNumero', '38271']]) {
        const criar = await request(app).post('/api/materiais').set('Cookie', cookieMasterA)
          .send({ nome: 'Material com CA', prazoUsoDias: 180, exigeTamanho: true, [campo]: valor });
        assert.equal(criar.status, 400, `${campo} no cadastro`);
        assert.equal(criar.body.codigo, 'VALIDACAO');
        assert.ok(criar.body.detalhes.some((d) => d.campo === `body.${campo}` && d.codigo === 'CAMPO_NAO_PERMITIDO'));

        const alterar = await request(app).patch(`/api/materiais/${materialId}`).set('Cookie', cookieMasterA)
          .send({ [campo]: valor });
        assert.equal(alterar.status, 400, `${campo} na edição`);
        assert.equal(alterar.body.codigo, 'VALIDACAO');
        assert.ok(alterar.body.detalhes.some((d) => d.campo === `body.${campo}` && d.codigo === 'CAMPO_NAO_PERMITIDO'));
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

  // E10: entrada e baixa por lote têm cenários próprios em estoque-lotes-operacoes.integration.js;
  // o caminho antigo por tamanho saiu (estoque-legado-removido.integration.js).
  const entrada = (quantidade) => ({
    tamanho: '40', quantidade, caNumero: '38271', caValidade: '2030-12-31', chaveIdempotencia: crypto.randomUUID(),
  });

  describe('Cenário 6 — inativação bloqueia entrada, mesmo para o MASTER (restrição estrutural)', () => {
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

    test('entrada em material inativo: 409 MATERIAL_INATIVO, mesmo para o MASTER', async () => {
      const resposta = await request(app).post(`/api/materiais/${materialId}/estoque/entradas`)
        .set('Cookie', cookieMasterA).send(entrada(1));
      assert.equal(resposta.status, 409);
      assert.equal(resposta.body.codigo, 'MATERIAL_INATIVO');
    });

    test('reativa o material, audita MATERIAL_REATIVADO, a entrada volta a funcionar', async () => {
      const reativar = await request(app).post(`/api/materiais/${materialId}/reativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(reativar.status, 200);
      assert.equal(reativar.body.material.ativo, true);
      assert.equal(await contarAuditoria(pool, empresaA, 'MATERIAL_REATIVADO'), 1);

      const resposta = await request(app).post(`/api/materiais/${materialId}/estoque/entradas`)
        .set('Cookie', cookieMasterA).send(entrada(1));
      assert.equal(resposta.status, 201, JSON.stringify(resposta.body));
      assert.equal(resposta.body.lote.saldo, 1);
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
        prazoUsoDias: 180, exigeTamanho: true, unidade: 'par', estoqueMinimo: 5,
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

  describe('Cenário 11 — óculos de proteção com ou sem grau (migration 045)', () => {
    // OCULOS é o nome histórico (só legado gravado por SQL); INCOLOR é um dos dois tipos oficiais (12G-8).
    const OCULOS = 'Óculos de proteção';
    const INCOLOR = 'Óculos de Proteção Incolor';
    const cadastro = (extra) => ({ nome: `Material ${Math.random()}`, categoria: 'EPI', prazoUsoDias: 180, exigeTamanho: false, ...extra });
    const criar = (extra) => request(app).post('/api/materiais').set('Cookie', cookieMasterA).send(cadastro(extra));
    const patch = (id, corpo, cookie = cookieMasterA) => request(app).patch(`/api/materiais/${id}`).set('Cookie', cookie).send(corpo);
    const consultar = async (id) => (await request(app).get(`/api/materiais/${id}`).set('Cookie', cookieMasterA)).body.material;
    const noBanco = async (id) => (await pool.query('SELECT tipo, oculos_com_grau FROM materiais WHERE id = $1', [id])).rows[0];
    const recusa = (r, codigo) => {
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(r.body));
      assert.deepEqual(r.body.detalhes.map((d) => [d.campo, d.codigo]), [['body.oculosComGrau', codigo]]);
    };
    const legado = async (tipo = OCULOS) => (await pool.query(
      "INSERT INTO materiais (empresa_id, nome, tipo, prazo_uso_dias, exige_tamanho) VALUES ($1, 'Óculos legado', $2, 180, false) RETURNING id",
      [empresaA, tipo],
    )).rows[0].id;

    test('cadastro de óculos com true e com false: 201; o valor volta no cadastro, na consulta, na lista e fica no banco', async () => {
      for (const oculosComGrau of [true, false]) {
        const r = await criar({ tipo: INCOLOR, oculosComGrau });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.material.oculosComGrau, oculosComGrau);
        assert.equal((await consultar(r.body.material.id)).oculosComGrau, oculosComGrau);
        const lista = await request(app).get('/api/materiais?limite=100').set('Cookie', cookieMasterA);
        assert.equal(lista.body.materiais.find((m) => m.id === r.body.material.id).oculosComGrau, oculosComGrau);
        assert.deepEqual(await noBanco(r.body.material.id), { tipo: INCOLOR, oculos_com_grau: oculosComGrau });
      }
    });

    test('cadastro de óculos sem a informação ou com null: 400 OCULOS_COM_GRAU_OBRIGATORIO, nada criado', async () => {
      const antes = (await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresaA])).rows[0].n;
      recusa(await criar({ tipo: INCOLOR }), 'OCULOS_COM_GRAU_OBRIGATORIO');
      recusa(await criar({ tipo: INCOLOR, oculosComGrau: null }), 'OCULOS_COM_GRAU_OBRIGATORIO');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1', [empresaA])).rows[0].n, antes);
    });

    test('outro tipo: sem a informação grava NULL e a resposta traz oculosComGrau null; true ou false escondido é 400', async () => {
      const r = await criar({ tipo: 'Luva' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.material.oculosComGrau, null);
      assert.equal(Object.hasOwn(r.body.material, 'oculosComGrau'), true);
      assert.deepEqual(await noBanco(r.body.material.id), { tipo: 'Luva', oculos_com_grau: null });
      for (const oculosComGrau of [true, false]) recusa(await criar({ tipo: 'Luva', oculosComGrau }), 'OCULOS_COM_GRAU_NAO_SE_APLICA');
      recusa(await criar({ nome: 'Óculos de proteção incolor', tipo: 'Luva', oculosComGrau: true }), 'OCULOS_COM_GRAU_NAO_SE_APLICA');
    });

    test('texto no lugar do booleano: 400 VALIDACAO de tipo, antes do serviço', async () => {
      const r = await criar({ tipo: INCOLOR, oculosComGrau: 'true' });
      assert.deepEqual([r.status, r.body.codigo, r.body.detalhes.map((d) => [d.campo, d.codigo])], [400, 'VALIDACAO', [['body.oculosComGrau', 'TIPO_INVALIDO']]]);
    });

    test('legado de óculos com NULL: editar outro campo preserva o NULL; depois pode ser classificado como true ou false', async () => {
      for (const oculosComGrau of [true, false]) {
        const id = await legado();
        const outro = await patch(id, { nome: 'Óculos legado renomeado' });
        assert.deepEqual([outro.status, outro.body.material.oculosComGrau], [200, null]);
        assert.deepEqual(await noBanco(id), { tipo: OCULOS, oculos_com_grau: null });
        const classificado = await patch(id, { oculosComGrau });
        assert.deepEqual([classificado.status, classificado.body.material.oculosComGrau], [200, oculosComGrau]);
        assert.deepEqual(await noBanco(id), { tipo: OCULOS, oculos_com_grau: oculosComGrau });
      }
    });

    test('óculos classificados: null explícito é 400 e o valor fica', async () => {
      const r = await criar({ tipo: INCOLOR, oculosComGrau: true });
      recusa(await patch(r.body.material.id, { oculosComGrau: null }), 'OCULOS_COM_GRAU_OBRIGATORIO');
      assert.equal((await noBanco(r.body.material.id)).oculos_com_grau, true);
    });

    test('óculos que passam a outro tipo: a informação vira NULL; mandar true junto é 400 e nada muda', async () => {
      const r = await criar({ tipo: INCOLOR, oculosComGrau: true });
      recusa(await patch(r.body.material.id, { tipo: 'Luva', oculosComGrau: true }), 'OCULOS_COM_GRAU_NAO_SE_APLICA');
      assert.deepEqual(await noBanco(r.body.material.id), { tipo: INCOLOR, oculos_com_grau: true });
      const troca = await patch(r.body.material.id, { tipo: 'Luva' });
      assert.deepEqual([troca.status, troca.body.material.tipo, troca.body.material.oculosComGrau], [200, 'Luva', null]);
      assert.deepEqual(await noBanco(r.body.material.id), { tipo: 'Luva', oculos_com_grau: null });
    });

    test('outro tipo que passa a óculos: sem classificar é 400 e nada muda; classificando, grava', async () => {
      const r = await criar({ tipo: 'Luva' });
      recusa(await patch(r.body.material.id, { tipo: INCOLOR }), 'OCULOS_COM_GRAU_OBRIGATORIO');
      assert.deepEqual(await noBanco(r.body.material.id), { tipo: 'Luva', oculos_com_grau: null });
      const troca = await patch(r.body.material.id, { tipo: INCOLOR, oculosComGrau: false });
      assert.deepEqual([troca.status, troca.body.material.oculosComGrau], [200, false]);
      assert.deepEqual(await noBanco(r.body.material.id), { tipo: INCOLOR, oculos_com_grau: false });
    });

    test('a auditoria registra o valor anterior e o novo, sem nenhum dado do corpo além dos campos do material', async () => {
      const id = await legado();
      await patch(id, { oculosComGrau: true });
      const { rows } = await pool.query(
        `SELECT dados_anteriores ? 'oculosComGrau' AS tem_antes, dados_anteriores->'oculosComGrau' AS antes,
                dados_novos ? 'oculosComGrau' AS tem_depois, dados_novos->'oculosComGrau' AS depois
           FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'MATERIAL_ALTERADO' AND referencia = $2`,
        [empresaA, String(id)],
      );
      assert.deepEqual(rows, [{ tem_antes: true, antes: null, tem_depois: true, depois: true }]);
    });

    test('isolamento e permissão: outra empresa recebe 404; perfil sem editar recebe 403; nada muda', async () => {
      const r = await criar({ tipo: INCOLOR, oculosComGrau: false });
      assert.equal((await patch(r.body.material.id, { oculosComGrau: true }, cookieMasterB)).status, 404);
      assert.equal((await patch(r.body.material.id, { oculosComGrau: true }, cookieAdminSemPermissaoA)).status, 403);
      assert.equal((await noBanco(r.body.material.id)).oculos_com_grau, false);
    });
  });
});
