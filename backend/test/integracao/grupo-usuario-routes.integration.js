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
const { criarGrupoUsuarioController } = require('../../src/controllers/grupo-usuario.controller');
const { criarGrupoUsuarioRoutes } = require('../../src/routes/grupo-usuario.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const permissoes = require('../../src/repositories/permissao.repository');
const { gerarHashSenha } = require('../../src/security/password');
const { gerarTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * API HTTP de vinculação de usuários aos grupos (Bloco 8, Incremento 8,
 * Etapa 5A, Subetapa 3O) de ponta a ponta: HTTP -> autenticação real ->
 * rotas reais -> controller real -> serviço aprovado na Subetapa 3L ->
 * PostgreSQL real.
 *
 * As rotas montadas aqui são EXATAMENTE as de produção
 * (criarGrupoUsuarioRoutes/criarGrupoUsuarioController), montadas lado a
 * lado com as de grupos (3M) e de permissões (3N) — nada é redefinido,
 * para provar que as três convivem sem regressão. O login também é
 * real: os cookies vêm de sessões de verdade, validadas no PostgreSQL.
 *
 * CONTRATO HTTP (correção pós-auditoria da Subetapa 3O): vincular
 * precisa de um grupo de destino, então continua em
 * PUT /api/grupos-acesso/:id/usuarios/:usuarioId. desvincular NÃO usa
 * grupo nenhum — o serviço da 3L sempre remove o vínculo ATUAL, seja
 * ele qual for — então vive em
 * DELETE /api/usuarios/:usuarioId/grupo-acesso, sem nenhum id de
 * grupo na URL.
 */

// 004/006 (funcionarios) e 018 (vinculo_sst): esta subetapa precisa
// PROVAR que vincular/desvincular não toca nenhum dos dois — só é
// demonstrável com as tabelas realmente presentes. 022: exceções
// individuais de recurso, pela mesma razão.
const MIGRATIONS = ['000', '001', '002', '003', '004', '005', '006', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023'];

const SENHA = 'senha-correta-do-teste-3o-2026';
let HASH_SENHA;

const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE'; // 017: ALTERNATIVA
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

async function lerVinculo(pool, usuarioId) {
  const { rows } = await pool.query('SELECT grupo_acesso_id, ativo, perfil FROM usuarios WHERE id = $1', [usuarioId]);
  return rows[0] ?? null;
}

async function contarAuditoria(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

describe('API HTTP de vinculação de usuários a grupos com PostgreSQL real', () => {
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
    const permissaoRoutes = criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao });
    const usuarioVinculoRoutes = criarGrupoUsuarioRoutes({ controller: criarGrupoUsuarioController({ pool }), exigirSessao });

    app = criarAppTeste((a) => { a.use('/api', authRoutes, grupoRoutes, permissaoRoutes, usuarioVinculoRoutes); });

    cookieMasterA = await login(CNPJ_A, EMAIL_MASTER_A);
    cookieMasterB = await login(CNPJ_B, EMAIL_MASTER_B);
    cookieAdminA = await login(CNPJ_A, EMAIL_ADMIN_A);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  /** Cria um grupo pela API já aprovada na 3M, para não duplicar SQL. */
  async function criarGrupoPelaApi(nome, { cookie = cookieMasterA } = {}) {
    const resposta = await request(app).post('/api/grupos-acesso').set('Cookie', cookie).send({ nome });
    assert.equal(resposta.status, 201, `criação deveria ter sucesso: ${JSON.stringify(resposta.body)}`);
    return resposta.body.grupo;
  }

  describe('autenticação', () => {
    test('sem cookie: as três rotas respondem 401 SESSAO_INVALIDA, sem tocar o banco', async () => {
      const grupo = await criarGrupoPelaApi('Sem Sessão Alvo');
      const usuario = await inserirUsuario(pool, empresaA, 'sem-sessao-alvo@demo.safeworkengenharia.com.br');
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      const requisicoes = [
        request(app).get(`/api/grupos-acesso/${grupo.id}/usuarios`),
        request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`),
        request(app).delete(`/api/usuarios/${usuario}/grupo-acesso`),
      ];

      for (const requisicao of requisicoes) {
        const resposta = await requisicao;
        assert.equal(resposta.status, 401, 'nenhuma rota de vínculo é pública');
        assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
      }

      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
      assert.equal((await lerVinculo(pool, usuario)).grupo_acesso_id, null, 'nada gravado');
    });

    test('cookie forjado (token nunca emitido): 401', async () => {
      const grupo = await criarGrupoPelaApi('Cookie Forjado Alvo');
      const forjado = `${authConfig.sessao.cookieNome}=${gerarTokenSessao()}`;

      const resposta = await request(app).get(`/api/grupos-acesso/${grupo.id}/usuarios`).set('Cookie', forjado);

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    });

    test('MASTER inativado DEPOIS do login perde o acesso na requisição seguinte', async () => {
      const grupo = await criarGrupoPelaApi('Alvo Master Sera Inativado');
      const email = 'master-vinculo-sera-inativado@demo.safeworkengenharia.com.br';
      const id = await inserirUsuario(pool, empresaA, email, 'MASTER');
      const cookie = await login(CNPJ_A, email);
      assert.equal((await request(app).get(`/api/grupos-acesso/${grupo.id}/usuarios`).set('Cookie', cookie)).status, 200);

      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [id]);

      const resposta = await request(app).get(`/api/grupos-acesso/${grupo.id}/usuarios`).set('Cookie', cookie);
      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    });
  });

  describe('autorização administrativa', () => {
    test('ADMINISTRADOR sem autoridade recebe 403 nas três rotas, inclusive na consulta', async () => {
      const grupo = await criarGrupoPelaApi('Alvo Sem Autoridade');
      const usuario = await inserirUsuario(pool, empresaA, 'alvo-sem-autoridade@demo.safeworkengenharia.com.br');
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      const casos = [
        ['get', `/api/grupos-acesso/${grupo.id}/usuarios`],
        ['put', `/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`],
        ['delete', `/api/usuarios/${usuario}/grupo-acesso`],
      ];

      for (const [metodo, caminho] of casos) {
        const resposta = await request(app)[metodo](caminho).set('Cookie', cookieAdminA);
        assert.equal(resposta.status, 403, `${metodo.toUpperCase()} ${caminho} deveria ser 403`);
        assert.equal(resposta.body.codigo, 'GRUPO_VINCULO_NAO_AUTORIZADO');
      }

      assert.equal((await lerVinculo(pool, usuario)).grupo_acesso_id, null, 'nada gravado');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'nenhuma recusa é auditada');
    });

    test('empresa diferente: MASTER de B não enxerga grupo nem usuário de A', async () => {
      const grupo = await criarGrupoPelaApi('Exclusivo de A');
      const usuario = await inserirUsuario(pool, empresaA, 'exclusivo-de-a@demo.safeworkengenharia.com.br');

      const consulta = await request(app).get(`/api/grupos-acesso/${grupo.id}/usuarios`).set('Cookie', cookieMasterB);
      assert.equal(consulta.status, 404);
      assert.equal(consulta.body.codigo, 'GRUPO_NAO_ENCONTRADO');

      const vinculo = await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterB);
      // O usuário é carregado ANTES do grupo no serviço: usuário de A não
      // existe na empresa B, então 404 de usuário, não de grupo.
      assert.equal(vinculo.status, 404);
      assert.equal(vinculo.body.codigo, 'USUARIO_NAO_ENCONTRADO');

      assert.equal((await lerVinculo(pool, usuario)).grupo_acesso_id, null);
    });

    test('grupo inexistente: 404 em GET e PUT (as únicas rotas que dependem de um grupo)', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'grupo-inexistente-alvo@demo.safeworkengenharia.com.br');

      assert.equal((await request(app).get('/api/grupos-acesso/999999/usuarios').set('Cookie', cookieMasterA)).status, 404);
      const vinculo = await request(app).put(`/api/grupos-acesso/999999/usuarios/${usuario}`).set('Cookie', cookieMasterA);
      assert.equal(vinculo.status, 404);
      assert.equal(vinculo.body.codigo, 'GRUPO_NAO_ENCONTRADO');
      // DELETE não tem "grupo inexistente" possível: a rota
      // (/api/usuarios/:usuarioId/grupo-acesso) não recebe id de grupo
      // nenhum — desvincular sempre atua sobre o vínculo ATUAL do
      // usuário, e é coberto pelo caso de "usuário inexistente" abaixo.
    });

    test('usuário inexistente: 404 USUARIO_NAO_ENCONTRADO ao vincular/desvincular', async () => {
      const grupo = await criarGrupoPelaApi('Usuario Inexistente Alvo');

      const vinculo = await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/999999`).set('Cookie', cookieMasterA);
      assert.equal(vinculo.status, 404);
      assert.equal(vinculo.body.codigo, 'USUARIO_NAO_ENCONTRADO');

      const desvinculo = await request(app).delete('/api/usuarios/999999/grupo-acesso').set('Cookie', cookieMasterA);
      assert.equal(desvinculo.status, 404);
      assert.equal(desvinculo.body.codigo, 'USUARIO_NAO_ENCONTRADO');
    });

    test('campos não permitidos no corpo são rejeitados pelo schema, nas duas rotas de escrita', async () => {
      const grupo = await criarGrupoPelaApi('Forja De Corpo');
      const usuario = await inserirUsuario(pool, empresaA, 'forja-de-corpo@demo.safeworkengenharia.com.br');

      for (const extra of [{ empresaId: empresaB }, { isMaster: true }, { perfil: 'MASTER' }, { atorId: 999 }, { grupoAcessoId: 1 }]) {
        const r1 = await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA).send(extra);
        assert.equal(r1.status, 400, `PUT com ${JSON.stringify(extra)} deveria ser recusado`);
        assert.equal(r1.body.codigo, 'VALIDACAO');

        const r2 = await request(app).delete(`/api/usuarios/${usuario}/grupo-acesso`).set('Cookie', cookieMasterA).send(extra);
        assert.equal(r2.status, 400, `DELETE com ${JSON.stringify(extra)} deveria ser recusado`);
        assert.equal(r2.body.codigo, 'VALIDACAO');
      }

      assert.equal((await lerVinculo(pool, usuario)).grupo_acesso_id, null, 'nenhuma tentativa rejeitada alterou o vínculo');
    });

    test('corpo ausente e corpo {} são aceitos nas duas rotas de escrita', async () => {
      const grupo = await criarGrupoPelaApi('Corpo Vazio Aceito');
      const usuario = await inserirUsuario(pool, empresaA, 'corpo-vazio-aceito@demo.safeworkengenharia.com.br');

      const semCorpo = await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);
      assert.equal(semCorpo.status, 200);

      const corpoVazio = await request(app).delete(`/api/usuarios/${usuario}/grupo-acesso`)
        .set('Cookie', cookieMasterA).set('Content-Type', 'application/json').send({});
      assert.equal(corpoVazio.status, 200);
    });
  });

  describe('vincular, transferir e desvincular', () => {
    test('MASTER vincula usuário: o RBAC passa a enxergar o grupo, e a auditoria registra anterior/novo', async () => {
      const grupo = await criarGrupoPelaApi('Vinculação HTTP');
      const usuario = await inserirUsuario(pool, empresaA, 'vinculacao-http@demo.safeworkengenharia.com.br');

      const resposta = await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.alterado, true);
      assert.deepEqual(resposta.body.vinculo, { usuarioId: usuario, grupoAnteriorId: null, grupoAtualId: grupo.id });
      assert.equal((await lerVinculo(pool, usuario)).grupo_acesso_id, grupo.id);
      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, usuario), { id: grupo.id, ativo: true });

      const { rows } = await pool.query(
        "SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'USUARIO_VINCULADO_A_GRUPO' AND referencia = $2",
        [empresaA, String(usuario)],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].usuario_id, masterA);
      assert.equal(rows[0].dados_anteriores.grupoAcessoId, null);
      assert.equal(rows[0].dados_novos.grupoAcessoId, grupo.id);
    });

    test('MASTER transfere usuário para outro grupo pela mesma rota (PUT), sem endpoint separado', async () => {
      const grupoOrigem = await criarGrupoPelaApi('Origem Transferencia');
      const grupoDestino = await criarGrupoPelaApi('Destino Transferencia');
      const usuario = await inserirUsuario(pool, empresaA, 'transferencia-http@demo.safeworkengenharia.com.br');
      await request(app).put(`/api/grupos-acesso/${grupoOrigem.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);

      const resposta = await request(app).put(`/api/grupos-acesso/${grupoDestino.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.alterado, true);
      assert.deepEqual(resposta.body.vinculo, { usuarioId: usuario, grupoAnteriorId: grupoOrigem.id, grupoAtualId: grupoDestino.id });
      assert.equal((await lerVinculo(pool, usuario)).grupo_acesso_id, grupoDestino.id);

      const { rows } = await pool.query(
        "SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'USUARIO_TRANSFERIDO_DE_GRUPO' AND referencia = $2",
        [empresaA, String(usuario)],
      );
      assert.equal(rows.length, 1, 'transferência audita com ação própria, distinta de vínculo novo');
    });

    test('vincular ao mesmo grupo não grava nem audita: alterado=false', async () => {
      const grupo = await criarGrupoPelaApi('Sem Mudanca Vinculo');
      const usuario = await inserirUsuario(pool, empresaA, 'sem-mudanca-vinculo@demo.safeworkengenharia.com.br');
      await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      const resposta = await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.alterado, false);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
    });

    test('MASTER desvincula usuário: volta a null e a auditoria registra o retorno ao piso do perfil', async () => {
      const grupo = await criarGrupoPelaApi('Desvinculacao HTTP');
      const usuario = await inserirUsuario(pool, empresaA, 'desvinculacao-http@demo.safeworkengenharia.com.br');
      await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);

      const resposta = await request(app).delete(`/api/usuarios/${usuario}/grupo-acesso`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.alterado, true);
      assert.deepEqual(resposta.body.vinculo, { usuarioId: usuario, grupoAnteriorId: grupo.id, grupoAtualId: null });
      assert.equal((await lerVinculo(pool, usuario)).grupo_acesso_id, null);
      assert.equal(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, usuario), null);

      const { rows } = await pool.query(
        "SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'USUARIO_DESVINCULADO_DE_GRUPO' AND referencia = $2",
        [empresaA, String(usuario)],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].contexto.efeito, 'VOLTA_AO_PISO_DO_PERFIL');
    });

    test('desvincular quem já não tem grupo não grava nem audita: alterado=false', async () => {
      const usuario = await inserirUsuario(pool, empresaA, 'ja-sem-grupo@demo.safeworkengenharia.com.br');
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      const resposta = await request(app).delete(`/api/usuarios/${usuario}/grupo-acesso`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.alterado, false);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
    });

    test('MASTER consulta usuários do grupo, incluindo inativos, sem expor credencial', async () => {
      const grupo = await criarGrupoPelaApi('Consulta De Membros');
      const ativo = await inserirUsuario(pool, empresaA, 'membro-ativo-http@demo.safeworkengenharia.com.br');
      const inativo = await inserirUsuario(pool, empresaA, 'membro-inativo-http@demo.safeworkengenharia.com.br');
      await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${ativo}`).set('Cookie', cookieMasterA);
      await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${inativo}`).set('Cookie', cookieMasterA);
      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [inativo]);

      const resposta = await request(app).get(`/api/grupos-acesso/${grupo.id}/usuarios`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.usuarios.length, 2);
      assert.equal(resposta.body.usuarios.some((u) => u.id === inativo && u.ativo === false), true, 'inativos continuam visíveis');
      assert.equal(resposta.body.usuarios.every((u) => 'senha_hash' in u === false), true, 'nunca credencial');
    });
  });

  describe('recusas específicas da 3L preservadas', () => {
    test('autovinculação é rejeitada: MASTER não altera o próprio grupo', async () => {
      const grupo = await criarGrupoPelaApi('Autovinculo Alvo');

      const vinculo = await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${masterA}`).set('Cookie', cookieMasterA);
      assert.equal(vinculo.status, 409);
      assert.equal(vinculo.body.codigo, 'AUTOVINCULO_NAO_PERMITIDO');

      const desvinculo = await request(app).delete(`/api/usuarios/${masterA}/grupo-acesso`).set('Cookie', cookieMasterA);
      assert.equal(desvinculo.status, 409);
      assert.equal(desvinculo.body.codigo, 'AUTOVINCULO_NAO_PERMITIDO');
    });

    test('usuário MASTER não recebe grupo: 409', async () => {
      const grupo = await criarGrupoPelaApi('Master Sem Grupo Alvo');
      const outroMaster = await inserirUsuario(pool, empresaA, 'outro-master-http@demo.safeworkengenharia.com.br', 'MASTER');

      const resposta = await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${outroMaster}`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 409);
      assert.equal(resposta.body.codigo, 'USUARIO_MASTER_SEM_GRUPO');
      assert.equal((await lerVinculo(pool, outroMaster)).grupo_acesso_id, null);
    });

    test('grupo inativo não recebe novo vínculo: 409', async () => {
      const grupo = await criarGrupoPelaApi('Sera Inativado Vinculo');
      await request(app).post(`/api/grupos-acesso/${grupo.id}/inativar`).set('Cookie', cookieMasterA);
      const usuario = await inserirUsuario(pool, empresaA, 'grupo-inativo-alvo@demo.safeworkengenharia.com.br');

      const resposta = await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 409);
      assert.equal(resposta.body.codigo, 'GRUPO_INATIVO');
    });

    test('usuário inativo não recebe vínculo novo, nem é desvinculado; vínculo histórico é preservado', async () => {
      const grupo = await criarGrupoPelaApi('Historico Preservado');
      const usuario = await inserirUsuario(pool, empresaA, 'historico-preservado@demo.safeworkengenharia.com.br');
      await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);
      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [usuario]);

      const outroGrupo = await criarGrupoPelaApi('Outro Grupo Para Inativo');
      const tentaVincular = await request(app).put(`/api/grupos-acesso/${outroGrupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);
      assert.equal(tentaVincular.status, 409);
      assert.equal(tentaVincular.body.codigo, 'USUARIO_INATIVO');

      const tentaDesvincular = await request(app).delete(`/api/usuarios/${usuario}/grupo-acesso`).set('Cookie', cookieMasterA);
      assert.equal(tentaDesvincular.status, 409);
      assert.equal(tentaDesvincular.body.codigo, 'USUARIO_INATIVO');

      assert.equal((await lerVinculo(pool, usuario)).grupo_acesso_id, grupo.id, 'o vínculo histórico não foi tocado por nenhuma das duas tentativas');
    });
  });

  describe('segurança das permissões e integridade', () => {
    test('retirar de grupo restritivo restaura o piso do perfil (a negação do grupo deixa de valer)', async () => {
      const grupo = await criarGrupoPelaApi('Grupo Restritivo Http');
      await request(app).patch(`/api/grupos-acesso/${grupo.id}/permissoes/acoes/${ACAO_ALTERNATIVA}`)
        .set('Cookie', cookieMasterA).send({ permitido: false });
      const usuario = await inserirUsuario(pool, empresaA, 'grupo-restritivo-http@demo.safeworkengenharia.com.br');
      await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);

      assert.equal((await permissoes.buscarPermissaoAcaoGrupo(pool, empresaA, grupo.id, ACAO_ALTERNATIVA)).permitido, false);
      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, usuario), { id: grupo.id, ativo: true });

      await request(app).delete(`/api/usuarios/${usuario}/grupo-acesso`).set('Cookie', cookieMasterA);

      assert.equal(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, usuario), null, 'sem grupo: a negação do grupo deixou de valer');
    });

    test('exceções individuais de recurso e vinculo_sst atravessam vincular/desvincular intactos', async () => {
      const grupo = await criarGrupoPelaApi('Preserva Excecoes Http');
      const usuario = await inserirUsuario(pool, empresaA, 'preserva-excecoes-http@demo.safeworkengenharia.com.br');
      await pool.query(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por)
         VALUES ($1, $2, $3, true, $4)`,
        [empresaA, usuario, RECURSO, masterA],
      );
      await pool.query(
        'INSERT INTO vinculo_sst (usuario_id, empresa_id, concedido_por) VALUES ($1, $2, $3)',
        [usuario, empresaA, masterA],
      );

      await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);
      await request(app).delete(`/api/usuarios/${usuario}/grupo-acesso`).set('Cookie', cookieMasterA);

      const excecao = await permissoes.buscarPermissaoRecursoIndividual(pool, empresaA, usuario, RECURSO);
      assert.equal(excecao.podeVisualizar, true, 'exceção individual de recurso preservada');
      assert.equal(await permissoes.usuarioIntegraSst(pool, empresaA, usuario), true, 'vinculo_sst preservado');
    });

    test('nomes de grupo "SST" e "Funcionários" não criam vinculo_sst nem cadastro em funcionarios', async () => {
      const grupoSst = await criarGrupoPelaApi('SST');
      const grupoFuncionarios = await criarGrupoPelaApi('Funcionários');
      const usuario1 = await inserirUsuario(pool, empresaA, 'grupo-sst-http@demo.safeworkengenharia.com.br');
      const usuario2 = await inserirUsuario(pool, empresaA, 'grupo-funcionarios-http@demo.safeworkengenharia.com.br');

      await request(app).put(`/api/grupos-acesso/${grupoSst.id}/usuarios/${usuario1}`).set('Cookie', cookieMasterA);
      await request(app).put(`/api/grupos-acesso/${grupoFuncionarios.id}/usuarios/${usuario2}`).set('Cookie', cookieMasterA);

      assert.equal(await permissoes.usuarioIntegraSst(pool, empresaA, usuario1), false);
      // `funcionarios` não tem nenhuma coluna que referencie `usuarios` —
      // são cadastros independentes (identificados por CPF/matrícula), o
      // que já É a prova estrutural de que vincular a um grupo chamado
      // "Funcionários" não poderia criar um. Confirma-se aqui que a
      // tabela permanece vazia na empresa, como estava antes das duas
      // vinculações.
      const { rows } = await pool.query('SELECT count(*)::int AS total FROM funcionarios WHERE empresa_id = $1', [empresaA]);
      assert.equal(rows[0].total, 0, 'nenhum cadastro de funcionário foi criado pelo nome do grupo');
    });

    test('rollback: falha real da auditoria desfaz o vínculo gravado', async (t) => {
      const grupo = await criarGrupoPelaApi('Rollback Http Vinculo');
      const usuario = await inserirUsuario(pool, empresaA, 'rollback-http-vinculo@demo.safeworkengenharia.com.br');
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada pós-gravação'); });

      const resposta = await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 500);
      assert.equal((await lerVinculo(pool, usuario)).grupo_acesso_id, null, 'o UPDATE foi desfeito pelo ROLLBACK');
    });

    test('rollback: falha real da auditoria desfaz o desvínculo', async (t) => {
      const grupo = await criarGrupoPelaApi('Rollback Http Desvinculo');
      const usuario = await inserirUsuario(pool, empresaA, 'rollback-http-desvinculo@demo.safeworkengenharia.com.br');
      await request(app).put(`/api/grupos-acesso/${grupo.id}/usuarios/${usuario}`).set('Cookie', cookieMasterA);
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada pós-gravação'); });

      const resposta = await request(app).delete(`/api/usuarios/${usuario}/grupo-acesso`).set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 500);
      assert.equal((await lerVinculo(pool, usuario)).grupo_acesso_id, grupo.id, 'o vínculo anterior foi restaurado pelo ROLLBACK');
    });

    test('não regressão: rotas de grupos (3M) e de permissões (3N) continuam funcionando lado a lado', async () => {
      const grupo = await criarGrupoPelaApi('Nao Regressao 3M 3N');

      const busca = await request(app).get(`/api/grupos-acesso/${grupo.id}`).set('Cookie', cookieMasterA);
      assert.equal(busca.status, 200);

      const permissao = await request(app).get(`/api/grupos-acesso/${grupo.id}/permissoes/recursos`).set('Cookie', cookieMasterA);
      assert.equal(permissao.status, 200);
      assert.deepEqual(permissao.body.recursos, []);
    });
  });
});
