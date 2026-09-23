'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarGrupoHomogeneoExposicaoController } = require('../../src/controllers/grupo-homogeneo-exposicao.controller');
const { criarGrupoHomogeneoExposicaoRoutes } = require('../../src/routes/grupo-homogeneo-exposicao.routes');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');

/**
 * API HTTP de GHE e funcionários (Bloco 9, Etapa B) de ponta a ponta:
 * HTTP -> autenticação real -> rotas reais (fábricas de produção) ->
 * controllers -> serviços -> PostgreSQL real, em schema temporário.
 *
 * Como na Etapa A, as permissões do MASTER são provisionadas MANUALMENTE
 * aqui (não existe provisionamento em produção — pendência já registrada
 * no planejamento, seção 10.1). Nada é executado no banco principal.
 */

const MIGRATIONS = [
  '000', '001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011',
  '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023',
];

const SENHA = 'senha-correta-do-teste-bloco9-etapa-b-2026';
let HASH_SENHA;

const RECURSO_GHE = 'employeeGroups';
const RECURSO_FUNC = 'employeeHistory';
const CPF_A = '529.982.247-25';
const CPF_A_NORMALIZADO = '52998224725';
const CPF_B = '111.444.777-35';
const CPF_B_NORMALIZADO = '11144477735';
const TELEFONE_NOVO = '47988887777';

async function inserirUsuario(pool, empresaId, email, perfil = 'ADMINISTRADOR') {
  const { rows } = await pool.query(
    'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, true) RETURNING id',
    [empresaId, `Usuário ${email}`, email, HASH_SENHA, perfil],
  );
  return rows[0].id;
}

function extrairCookie(resposta) {
  const cookies = resposta.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 1);
  return cookies[0].split(';')[0];
}

async function concederRecurso(pool, empresaId, perfil, recurso) {
  await pool.query(
    `INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
     VALUES ($1, $2, $3, true, true, true, false)
     ON CONFLICT (empresa_id, perfil, recurso) DO UPDATE SET pode_visualizar = true, pode_criar = true, pode_editar = true`,
    [empresaId, perfil, recurso],
  );
}

async function contarAuditoria(pool, empresaId, acao) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2', [empresaId, acao]);
  return rows[0].total;
}

async function contar(pool, tabela, empresaId) {
  const { rows } = await pool.query(`SELECT count(*)::int AS total FROM ${tabela} WHERE empresa_id = $1`, [empresaId]);
  return rows[0].total;
}

describe('API HTTP de GHE e funcionários com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let empresaB;
  let cookieMasterA;
  let cookieMasterB;
  let cookieSemPermissaoA;
  let cookieSoFuncionariosA;
  let cookieAdminFuncionariosA;
  let usuariosAntes;

  const CNPJ_A = '11222333000181';
  const CNPJ_B = '44555666000162';

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

    await inserirUsuario(pool, empresaA, 'master-a@demo.safeworkengenharia.com.br', 'MASTER');
    // USUARIO (não ADMINISTRADOR): o perfil ADMINISTRADOR recebe employeeHistory
    // abaixo, para o Cenário 5; este usuário precisa continuar sem permissão.
    await inserirUsuario(pool, empresaA, 'sem-permissao-a@demo.safeworkengenharia.com.br', 'USUARIO');
    await inserirUsuario(pool, empresaA, 'so-funcionarios-a@demo.safeworkengenharia.com.br', 'SUPERVISOR');
    await inserirUsuario(pool, empresaA, 'admin-funcionarios-a@demo.safeworkengenharia.com.br', 'ADMINISTRADOR');
    await inserirUsuario(pool, empresaB, 'master-b@demo.safeworkengenharia.com.br', 'MASTER');

    for (const empresa of [empresaA, empresaB]) {
      await concederRecurso(pool, empresa, 'MASTER', RECURSO_GHE);
      await concederRecurso(pool, empresa, 'MASTER', RECURSO_FUNC);
    }
    // SUPERVISOR da empresa A: só funcionários, NÃO GHE — prova que as duas
    // autoridades são independentes (planejamento, seção 10.2).
    await concederRecurso(pool, empresaA, 'SUPERVISOR', RECURSO_FUNC);
    // ADMINISTRADOR com permissão de editar funcionários: prova que a
    // imutabilidade do CPF vale para MASTER e ADMINISTRADOR igualmente.
    await concederRecurso(pool, empresaA, 'ADMINISTRADOR', RECURSO_FUNC);

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao });
    const gheRoutes = criarGrupoHomogeneoExposicaoRoutes({ controller: criarGrupoHomogeneoExposicaoController({ pool }), exigirSessao, pool });
    const funcRoutes = criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao, pool });
    app = criarAppTeste((a) => { a.use('/api', authRoutes, gheRoutes, funcRoutes); });

    cookieMasterA = await login(CNPJ_A, 'master-a@demo.safeworkengenharia.com.br');
    cookieSemPermissaoA = await login(CNPJ_A, 'sem-permissao-a@demo.safeworkengenharia.com.br');
    cookieSoFuncionariosA = await login(CNPJ_A, 'so-funcionarios-a@demo.safeworkengenharia.com.br');
    cookieAdminFuncionariosA = await login(CNPJ_A, 'admin-funcionarios-a@demo.safeworkengenharia.com.br');
    cookieMasterB = await login(CNPJ_B, 'master-b@demo.safeworkengenharia.com.br');
    usuariosAntes = await contar(pool, 'usuarios', empresaA);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  let gheId;
  let funcionarioId;

  describe('Cenário 1 — sessão e permissão', () => {
    test('sem cookie: 401 nas duas famílias de rota', async () => {
      for (const chamar of [
        () => request(app).post('/api/grupos-homogeneos').send({ nome: 'X' }),
        () => request(app).get('/api/funcionarios'),
      ]) {
        const r = await chamar();
        assert.equal(r.status, 401);
        assert.equal(r.body.codigo, 'SESSAO_INVALIDA');
      }
    });

    test('perfil sem permissão: 403 em GHE e em funcionários', async () => {
      assert.equal((await request(app).post('/api/grupos-homogeneos').set('Cookie', cookieSemPermissaoA).send({ nome: 'X' })).status, 403);
      assert.equal((await request(app).get('/api/funcionarios').set('Cookie', cookieSemPermissaoA)).status, 403);
    });

    test('autoridades independentes: quem só tem employeeHistory lista funcionários (200) mas não cria GHE (403)', async () => {
      assert.equal((await request(app).get('/api/funcionarios').set('Cookie', cookieSoFuncionariosA)).status, 200);
      assert.equal((await request(app).post('/api/grupos-homogeneos').set('Cookie', cookieSoFuncionariosA).send({ nome: 'X' })).status, 403);
    });
  });

  describe('Cenário 2 — GHE: cadastro completo', () => {
    test('cria, audita GHE_CRIADO', async () => {
      const r = await request(app).post('/api/grupos-homogeneos').set('Cookie', cookieMasterA)
        .send({ nome: 'Manutenção — Mecânicos', setor: 'Manutenção', funcao: 'Mecânico', riscos: 'Esmagamento; cortes' });
      assert.equal(r.status, 201);
      gheId = r.body.grupo.id;
      assert.equal(r.body.grupo.ativo, true);
      assert.equal(await contarAuditoria(pool, empresaA, 'GHE_CRIADO'), 1);
    });

    test('nome duplicado na mesma empresa: 409 GHE_NOME_EM_USO; mesmo nome em outra empresa: 201', async () => {
      const dup = await request(app).post('/api/grupos-homogeneos').set('Cookie', cookieMasterA).send({ nome: 'Manutenção — Mecânicos' });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.codigo, 'GHE_NOME_EM_USO');
      const outra = await request(app).post('/api/grupos-homogeneos').set('Cookie', cookieMasterB).send({ nome: 'Manutenção — Mecânicos' });
      assert.equal(outra.status, 201);
    });

    test('GET/:id, listar com busca literal, PATCH (audita), PATCH vazio 400', async () => {
      assert.equal((await request(app).get(`/api/grupos-homogeneos/${gheId}`).set('Cookie', cookieMasterA)).body.grupo.id, gheId);
      const lista = await request(app).get('/api/grupos-homogeneos?busca=mec%C3%A2nicos').set('Cookie', cookieMasterA);
      assert.deepEqual(lista.body.grupos.map((g) => g.id), [gheId]);
      const patch = await request(app).patch(`/api/grupos-homogeneos/${gheId}`).set('Cookie', cookieMasterA).send({ riscos: null });
      assert.equal(patch.status, 200);
      assert.equal(patch.body.grupo.riscos, null);
      assert.equal(await contarAuditoria(pool, empresaA, 'GHE_ALTERADO'), 1);
      assert.equal((await request(app).patch(`/api/grupos-homogeneos/${gheId}`).set('Cookie', cookieMasterA).send({})).body.codigo, 'GHE_SEM_ALTERACAO');
    });
  });

  describe('Cenário 3 — funcionários: cadastro completo e separação de usuários', () => {
    test('cria com GHE ativo: CPF normalizado, audita FUNCIONARIO_CRIADO SEM cpf/telefone no registro', async () => {
      const r = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterA).send({
        matricula: 'MAT-000171', nome: 'Marcos Silva', cpf: CPF_A, grupoHomogeneoId: gheId,
        dataNascimento: '1990-03-15', setor: 'Manutenção', funcao: 'Mecânico', cracha: 'CR-001284', telefone: '47999990000',
      });
      assert.equal(r.status, 201);
      funcionarioId = r.body.funcionario.id;
      assert.equal(r.body.funcionario.cpf, CPF_A_NORMALIZADO);
      assert.equal(r.body.funcionario.grupoHomogeneoId, gheId);

      const { rows } = await pool.query(
        "SELECT dados_novos::text AS novos, contexto::text AS ctx FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'FUNCIONARIO_CRIADO'", [empresaA],
      );
      assert.equal(rows.length, 1);
      assert.ok(!rows[0].novos.includes(CPF_A_NORMALIZADO), 'CPF nunca vai para a auditoria');
      assert.ok(!rows[0].novos.includes('47999990000'), 'telefone nunca vai para a auditoria');
      assert.ok(!rows[0].novos.includes('1990-03-15'), 'nascimento nunca vai para a auditoria');
      assert.ok(rows[0].ctx.includes('camposSensiveisOmitidos'));
    });

    test('CPF com DV inválido: 400 VALIDACAO CPF_DV_INVALIDO; ano 0000 no nascimento: 400 — nada gravado', async () => {
      const antes = await contar(pool, 'funcionarios', empresaA);
      const dv = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterA).send({ matricula: 'M2', nome: 'X', cpf: '529.982.247-26' });
      assert.equal(dv.status, 400);
      assert.ok(dv.body.detalhes.some((d) => d.campo === 'body.cpf' && d.codigo === 'CPF_DV_INVALIDO'));
      const data = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterA).send({ matricula: 'M2', nome: 'X', cpf: CPF_B, dataNascimento: '0000-01-01' });
      assert.equal(data.status, 400);
      assert.equal(await contar(pool, 'funcionarios', empresaA), antes);
    });

    test('matrícula duplicada: 409 FUNCIONARIO_MATRICULA_EM_USO; CPF duplicado: 409 FUNCIONARIO_CPF_EM_USO', async () => {
      const mat = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterA).send({ matricula: 'MAT-000171', nome: 'Outro', cpf: CPF_B });
      assert.equal(mat.status, 409);
      assert.equal(mat.body.codigo, 'FUNCIONARIO_MATRICULA_EM_USO');
      const cpf = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterA).send({ matricula: 'MAT-000999', nome: 'Outro', cpf: CPF_A });
      assert.equal(cpf.status, 409);
      assert.equal(cpf.body.codigo, 'FUNCIONARIO_CPF_EM_USO');
    });

    test('GHE inexistente: 400 FUNCIONARIO_GHE_INVALIDO; GHE inativo: 409 FUNCIONARIO_GHE_INATIVO; vínculo existente preservado', async () => {
      const inexistente = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterA).send({ matricula: 'M3', nome: 'X', cpf: CPF_B, grupoHomogeneoId: 999999 });
      assert.equal(inexistente.status, 400);
      assert.equal(inexistente.body.codigo, 'FUNCIONARIO_GHE_INVALIDO');

      assert.equal((await request(app).post(`/api/grupos-homogeneos/${gheId}/inativar`).set('Cookie', cookieMasterA).send({})).status, 200);
      const inativo = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterA).send({ matricula: 'M3', nome: 'X', cpf: CPF_B, grupoHomogeneoId: gheId });
      assert.equal(inativo.status, 409);
      assert.equal(inativo.body.codigo, 'FUNCIONARIO_GHE_INATIVO');

      const existente = await request(app).get(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieMasterA);
      assert.equal(existente.body.funcionario.grupoHomogeneoId, gheId, 'inativar o GHE não desvincula quem já estava vinculado');

      assert.equal((await request(app).post(`/api/grupos-homogeneos/${gheId}/reativar`).set('Cookie', cookieMasterA).send({})).status, 200);
      assert.equal(await contarAuditoria(pool, empresaA, 'GHE_INATIVADO'), 1);
      assert.equal(await contarAuditoria(pool, empresaA, 'GHE_REATIVADO'), 1);
    });

    test('listar filtra por GHE e por busca de matrícula; PATCH desvincula (null) e audita só "campo sensível alterado" para telefone', async () => {
      const porGhe = await request(app).get(`/api/funcionarios?grupoHomogeneoId=${gheId}`).set('Cookie', cookieMasterA);
      assert.deepEqual(porGhe.body.funcionarios.map((x) => x.id), [funcionarioId]);
      const porMatricula = await request(app).get('/api/funcionarios?busca=MAT-0001').set('Cookie', cookieMasterA);
      assert.deepEqual(porMatricula.body.funcionarios.map((x) => x.id), [funcionarioId]);

      const patch = await request(app).patch(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieMasterA).send({ grupoHomogeneoId: null, telefone: TELEFONE_NOVO });
      assert.equal(patch.status, 200);
      assert.equal(patch.body.funcionario.grupoHomogeneoId, null);
      assert.equal(patch.body.funcionario.telefone, TELEFONE_NOVO);
      assert.equal(patch.body.funcionario.cpf, CPF_A_NORMALIZADO, 'CPF intocado');
      // contexto/dados_novos como objetos (o driver já converte JSONB) — não
      // como ::text, cuja serialização tem espaços e tornaria a asserção frágil.
      const { rows } = await pool.query("SELECT contexto, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'FUNCIONARIO_ALTERADO'", [empresaA]);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].contexto.camposSensiveisAlterados, ['telefone']);
      assert.ok(!('cpf' in rows[0].dados_novos) && !('telefone' in rows[0].dados_novos), 'cpf e telefone não estão no instantâneo');
      assert.ok(!JSON.stringify(rows[0].dados_novos).includes(TELEFONE_NOVO));
    });

    test('inativar (audita) é idempotente; reativar audita; a tabela usuarios ficou intocada por todo o fluxo', async () => {
      const primeiro = await request(app).post(`/api/funcionarios/${funcionarioId}/inativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(primeiro.body.alterado, true);
      const segundo = await request(app).post(`/api/funcionarios/${funcionarioId}/inativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(segundo.body.alterado, false);
      assert.equal(await contarAuditoria(pool, empresaA, 'FUNCIONARIO_INATIVADO'), 1);
      assert.equal((await request(app).post(`/api/funcionarios/${funcionarioId}/reativar`).set('Cookie', cookieMasterA).send({})).body.funcionario.ativo, true);
      assert.equal(await contarAuditoria(pool, empresaA, 'FUNCIONARIO_REATIVADO'), 1);
      assert.equal(await contar(pool, 'usuarios', empresaA), usuariosAntes, 'nenhum usuário do sistema criado, alterado ou removido');
    });
  });

  describe('Cenário 4 — isolamento entre empresas', () => {
    test('MASTER da empresa B não enxerga GHE nem funcionário da A (404), e não consegue vincular ao GHE da A (400)', async () => {
      assert.equal((await request(app).get(`/api/grupos-homogeneos/${gheId}`).set('Cookie', cookieMasterB)).status, 404);
      assert.equal((await request(app).get(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieMasterB)).status, 404);
      assert.equal((await request(app).patch(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieMasterB).send({ nome: 'Sequestro' })).status, 404);
      const cruzado = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterB).send({ matricula: 'B1', nome: 'B', cpf: CPF_A, grupoHomogeneoId: gheId });
      assert.equal(cruzado.status, 400);
      assert.equal(cruzado.body.codigo, 'FUNCIONARIO_GHE_INVALIDO');
      assert.equal(await contar(pool, 'funcionarios', empresaB), 0);
    });

    test('mesmo CPF e mesma matrícula são permitidos em empresas diferentes (unicidade é por empresa)', async () => {
      const r = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterB).send({ matricula: 'MAT-000171', nome: 'Homônimo', cpf: CPF_B });
      assert.equal(r.status, 201);
    });
  });

  describe('Cenário 5 — CPF imutável após o cadastro (decisão definitiva de 2026-09-23)', () => {
    // O que o cadastro tem ANTES de cada tentativa: linha inteira e
    // contagem de auditoria da empresa. Nenhuma tentativa pode mudar nada.
    async function fotografar() {
      const { rows } = await pool.query('SELECT * FROM funcionarios WHERE empresa_id = $1 AND id = $2', [empresaA, funcionarioId]);
      const { rows: auditoria } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaA]);
      return { linha: rows[0], auditorias: auditoria[0].total };
    }

    function assertRecusaCpf(resposta) {
      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'VALIDACAO');
      assert.deepEqual(resposta.body.detalhes, [{ campo: 'body.cpf', codigo: 'CAMPO_NAO_PERMITIDO', mensagem: 'Campo não permitido' }]);
      assert.ok(!JSON.stringify(resposta.body).includes(CPF_A_NORMALIZADO) && !JSON.stringify(resposta.body).includes(CPF_B_NORMALIZADO), 'a resposta nunca ecoa o CPF recebido');
    }

    test('MASTER: PATCH com o CPF ORIGINAL (com máscara e sem) → 400 CAMPO_NAO_PERMITIDO; nada muda, nada é auditado', async () => {
      const antes = await fotografar();
      assertRecusaCpf(await request(app).patch(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieMasterA).send({ cpf: CPF_A }));
      assertRecusaCpf(await request(app).patch(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieMasterA).send({ cpf: CPF_A_NORMALIZADO }));
      assert.deepEqual(await fotografar(), antes);
    });

    test('MASTER: PATCH com CPF DIFERENTE → a MESMA resposta do CPF igual (sem oráculo de confirmação)', async () => {
      const antes = await fotografar();
      assertRecusaCpf(await request(app).patch(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieMasterA).send({ cpf: CPF_B }));
      const depois = await fotografar();
      assert.deepEqual(depois, antes);
      assert.equal(depois.linha.cpf, CPF_A_NORMALIZADO);
    });

    test('cpf acompanhado de campo válido: tudo-ou-nada — 400 e o outro campo NÃO é alterado', async () => {
      const antes = await fotografar();
      assertRecusaCpf(await request(app).patch(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieMasterA).send({ nome: 'Nome Que Não Pode Entrar', cpf: CPF_A }));
      assert.deepEqual(await fotografar(), antes);
    });

    test('ADMINISTRADOR com permissão de editar: mesma recusa (a regra não depende do perfil); edição sem cpf continua 200', async () => {
      const antes = await fotografar();
      assertRecusaCpf(await request(app).patch(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieAdminFuncionariosA).send({ cpf: CPF_B }));
      assert.deepEqual(await fotografar(), antes);

      const ok = await request(app).patch(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieAdminFuncionariosA).send({ setor: 'Logística' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.funcionario.setor, 'Logística');
      assert.equal(ok.body.funcionario.cpf, CPF_A_NORMALIZADO);
    });

    test('procedimento aprovado: inativar preserva o cadastro e o histórico; recadastrar com CPF correto (201); o CPF do inativo continua reservado (409)', async () => {
      const antes = await fotografar();
      const inativar = await request(app).post(`/api/funcionarios/${funcionarioId}/inativar`).set('Cookie', cookieMasterA).send({});
      assert.equal(inativar.status, 200);
      assert.equal(inativar.body.alterado, true);

      const depois = await fotografar();
      const { ativo: ativoAntes, atualizado_em: _a, ...restoAntes } = antes.linha;
      const { ativo: ativoDepois, atualizado_em: _d, ...restoDepois } = depois.linha;
      assert.equal(ativoAntes, true);
      assert.equal(ativoDepois, false);
      assert.deepEqual(restoDepois, restoAntes, 'inativar só muda ativo (e atualizado_em): CPF, matrícula, nome, GHE e demais campos preservados');
      assert.equal(depois.auditorias, antes.auditorias + 1, 'a inativação ACRESCENTA uma linha de auditoria e não altera nenhuma anterior');
      assert.equal((await request(app).get(`/api/funcionarios/${funcionarioId}`).set('Cookie', cookieMasterA)).status, 200, 'o cadastro inativo continua consultável');

      // Novo cadastro com o CPF correto: independente, sem transferência de nada.
      const novo = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterA).send({ matricula: 'MAT-000172', nome: 'Marcos Silva', cpf: CPF_B });
      assert.equal(novo.status, 201);
      assert.notEqual(novo.body.funcionario.id, funcionarioId);
      assert.equal(novo.body.funcionario.cpf, CPF_B_NORMALIZADO);

      // Unicidade por empresa preservada, inclusive para o inativo.
      const repetido = await request(app).post('/api/funcionarios').set('Cookie', cookieMasterA).send({ matricula: 'MAT-000173', nome: 'Outro', cpf: CPF_A });
      assert.equal(repetido.status, 409);
      assert.equal(repetido.body.codigo, 'FUNCIONARIO_CPF_EM_USO');

      // O cadastro original permanece exatamente como ficou após a inativação.
      assert.deepEqual((await fotografar()).linha, depois.linha);
    });
  });
});
