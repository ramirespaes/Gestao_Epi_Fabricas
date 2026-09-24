'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarUsuarioConsultaController } = require('../../src/controllers/usuario-consulta.controller');
const { criarUsuarioConsultaRoutes } = require('../../src/routes/usuario-consulta.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const autorizacaoServico = require('../../src/services/autorizacao-individual.service');
const autoridade = require('../../src/services/autoridade-administrativa');
const { gerarHashSenha } = require('../../src/security/password');

/**
 * API HTTP de consulta de usuários (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3U) de ponta a ponta: HTTP -> autenticação real -> rota real
 * -> controller real -> serviço real -> PostgreSQL real.
 *
 * A rota montada aqui é EXATAMENTE a de produção, pela mesma fábrica que
 * app.js usa — só o pool e o limitador são exclusivos deste arquivo.
 *
 * O que precisa ficar provado, já que esta rota expõe uma relação de
 * PESSOAS:
 *
 *   • não é pública: sem sessão, 401;
 *   • exige ADMINISTRAR_VINCULOS_GRUPO — um ADMINISTRADOR comum recebe
 *     403, e o mesmo usuário passa a ler depois da concessão real da 3I;
 *   • nunca atravessa empresas: a empresa vem da sessão, e não existe
 *     parâmetro que a substitua;
 *   • não devolve credencial nem biometria;
 *   • a busca casa nome e e-mail sem interpretar curingas digitados;
 *   • é somente leitura.
 *
 * A migration 024 é aplicada NESTE SCHEMA TEMPORÁRIO apenas — o banco
 * principal não é tocado.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '025', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024'];

const SENHA = 'senha-correta-do-teste-3u-2026';
let HASH_SENHA;

const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
const EMAIL_ADMIN_A = 'admin-a@demo.safeworkengenharia.com.br';
const EMAIL_USUARIO_A = 'usuario-a@demo.safeworkengenharia.com.br';
const EMAIL_MASTER_B = 'master-b@demo.safeworkengenharia.com.br';

function extrairCookie(resposta) {
  const cookies = resposta.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 1, 'esperado exatamente um Set-Cookie');
  return cookies[0].split(';')[0];
}

describe('API HTTP de consulta de usuários com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let masterA;
  let adminA;
  let grupoA;
  let cookieMasterA;
  let cookieAdminA;
  let cookieUsuarioA;
  let cookieMasterB;
  let autorizacaoConcedida;

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
    const empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;

    const inserirUsuario = async (empresaId, email, perfil, nome, ativo = true) => {
      const { rows: criado } = await pool.query(
        'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [empresaId, nome, email, HASH_SENHA, perfil, ativo],
      );
      return criado[0].id;
    };

    masterA = await inserirUsuario(empresaA, EMAIL_MASTER_A, 'MASTER', 'Master da Empresa A');
    adminA = await inserirUsuario(empresaA, EMAIL_ADMIN_A, 'ADMINISTRADOR', 'Administrador da Empresa A');
    await inserirUsuario(empresaA, EMAIL_USUARIO_A, 'USUARIO', 'Ana Souza');
    await inserirUsuario(empresaA, 'bruno@demo.safeworkengenharia.com.br', 'SUPERVISOR', 'Bruno Lima');
    await inserirUsuario(empresaA, 'carla@demo.safeworkengenharia.com.br', 'USUARIO', 'Carla 100% Dias');
    await inserirUsuario(empresaA, 'inativo@demo.safeworkengenharia.com.br', 'USUARIO', 'Zilda Inativa', false);
    await inserirUsuario(empresaB, EMAIL_MASTER_B, 'MASTER', 'Master da Empresa B');
    await inserirUsuario(empresaB, 'ana.b@demo.safeworkengenharia.com.br', 'USUARIO', 'Ana da Empresa B');

    const { rows: grupo } = await pool.query(
      'INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id',
      [empresaA, 'Almoxarifado 3U', masterA],
    );
    grupoA = grupo[0].id;
    await pool.query('UPDATE usuarios SET grupo_acesso_id = $1 WHERE empresa_id = $2 AND nome = $3', [grupoA, empresaA, 'Ana Souza']);

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao });
    const consultaRoutes = criarUsuarioConsultaRoutes({
      controller: criarUsuarioConsultaController({ pool }), exigirSessao,
    });

    app = criarAppTeste((a) => { a.use('/api', authRoutes, consultaRoutes); });

    cookieMasterA = await login(CNPJ_A, EMAIL_MASTER_A);
    cookieAdminA = await login(CNPJ_A, EMAIL_ADMIN_A);
    cookieUsuarioA = await login(CNPJ_A, EMAIL_USUARIO_A);
    cookieMasterB = await login(CNPJ_B, EMAIL_MASTER_B);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  const listar = (cookie, query = '') => request(app).get(`/api/usuarios${query}`).set('Cookie', cookie);

  describe('autenticação', () => {
    test('sem cookie: 401 SESSAO_INVALIDA — a relação de pessoas não é pública', async () => {
      const resposta = await request(app).get('/api/usuarios');

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
      assert.equal(resposta.body.usuarios, undefined, 'nenhum nome vaza na recusa');
    });

    test('cookie inválido também recebe 401', async () => {
      const resposta = await request(app).get('/api/usuarios').set('Cookie', 'sessao=token-que-nao-existe');

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.usuarios, undefined);
    });
  });

  describe('autoridade administrativa (3Q)', () => {
    test('MASTER lista os usuários da própria empresa', async () => {
      const resposta = await listar(cookieMasterA);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.status, 'ok');
      assert.ok(Array.isArray(resposta.body.usuarios));
      assert.ok(resposta.body.usuarios.length > 0);
    });

    test('ADMINISTRADOR sem autorização recebe 403 USUARIO_CONSULTA_NAO_AUTORIZADA', async () => {
      const resposta = await listar(cookieAdminA);

      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'USUARIO_CONSULTA_NAO_AUTORIZADA');
      assert.equal(resposta.body.usuarios, undefined);
    });

    test('USUARIO comum também recebe 403', async () => {
      assert.equal((await listar(cookieUsuarioA)).status, 403);
    });

    test('consultar não grava auditoria: ler uma lista não é evento auditável', async () => {
      const { rows: antes } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria');

      await listar(cookieMasterA);
      await listar(cookieAdminA);

      const { rows: depois } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria');
      assert.equal(depois[0].total, antes[0].total);
    });

    test('concedida ADMINISTRAR_VINCULOS_GRUPO pela 3I, o ADMINISTRADOR passa a listar', async () => {
      const criada = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA,
        concedidoPor: masterA,
        usuarioId: adminA,
        acaoCodigo: autoridade.ACOES_ADMINISTRATIVAS.VINCULOS_GRUPO,
      });
      autorizacaoConcedida = criada.id;

      const resposta = await listar(cookieAdminA);

      assert.equal(resposta.status, 200);
      assert.ok(resposta.body.usuarios.length > 0);
    });

    test('a autoridade de PERMISSÕES não serve: as ações são distintas', async () => {
      // Revoga a de vínculos e concede a de permissões no lugar.
      await autorizacaoServico.revogar(pool, {
        empresaId: empresaA, revogadoPor: masterA, autorizacaoId: autorizacaoConcedida,
      });
      const outra = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA,
        concedidoPor: masterA,
        usuarioId: adminA,
        acaoCodigo: autoridade.ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO,
      });

      const resposta = await listar(cookieAdminA);
      assert.equal(resposta.status, 403, 'autoridade de permissões não abre a lista de pessoas');

      await autorizacaoServico.revogar(pool, {
        empresaId: empresaA, revogadoPor: masterA, autorizacaoId: outra.id,
      });
    });
  });

  describe('conteúdo e privacidade', () => {
    test('cada usuário traz só id, nome, email, perfil, ativo e grupoAcessoId', async () => {
      const resposta = await listar(cookieMasterA);

      for (const usuario of resposta.body.usuarios) {
        assert.deepEqual(
          Object.keys(usuario).sort(),
          ['ativo', 'email', 'grupoAcessoId', 'id', 'nome', 'perfil'],
        );
      }
    });

    test('nenhuma credencial e nenhuma biometria atravessam a resposta', async () => {
      const resposta = await listar(cookieMasterA);
      const serializado = JSON.stringify(resposta.body);

      for (const proibido of ['senha', 'senha_hash', 'argon2', 'token', 'biometria']) {
        assert.equal(serializado.toLowerCase().includes(proibido), false, `"${proibido}" não deveria aparecer`);
      }
    });

    test('inclui usuários inativos, marcados como tal', async () => {
      const resposta = await listar(cookieMasterA);
      const inativa = resposta.body.usuarios.find((u) => u.nome === 'Zilda Inativa');

      assert.ok(inativa, 'quem está inativo continua visível para a administração');
      assert.equal(inativa.ativo, false);
    });

    test('grupoAcessoId reflete o vínculo real: null para quem não tem', async () => {
      const resposta = await listar(cookieMasterA);
      const vinculada = resposta.body.usuarios.find((u) => u.nome === 'Ana Souza');
      const solta = resposta.body.usuarios.find((u) => u.nome === 'Bruno Lima');

      assert.equal(vinculada.grupoAcessoId, grupoA);
      assert.equal(solta.grupoAcessoId, null);
    });

    test('a ordenação é por nome, para que a tela não pareça aleatória', async () => {
      const nomes = (await listar(cookieMasterA)).body.usuarios.map((u) => u.nome);
      const ordenados = [...nomes].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'pt-BR'));

      assert.deepEqual(nomes, ordenados);
    });
  });

  describe('busca e filtros', () => {
    test('a busca casa por nome, sem diferenciar maiúsculas', async () => {
      const resposta = await listar(cookieMasterA, '?busca=ANA');

      assert.equal(resposta.status, 200);
      assert.ok(resposta.body.usuarios.some((u) => u.nome === 'Ana Souza'));
      assert.equal(resposta.body.usuarios.every((u) => /ana/i.test(u.nome) || /ana/i.test(u.email)), true);
    });

    test('a busca casa por e-mail', async () => {
      const resposta = await listar(cookieMasterA, '?busca=bruno@demo');

      assert.equal(resposta.body.usuarios.length, 1);
      assert.equal(resposta.body.usuarios[0].nome, 'Bruno Lima');
    });

    test('curingas digitados são texto, não curinga: "100%" encontra quem tem "100%"', async () => {
      const resposta = await listar(cookieMasterA, `?busca=${encodeURIComponent('100%')}`);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.usuarios.length, 1);
      assert.equal(resposta.body.usuarios[0].nome, 'Carla 100% Dias');
    });

    test('um "%" sozinho não devolve todo mundo', async () => {
      const todos = await listar(cookieMasterA);
      const comPorcento = await listar(cookieMasterA, `?busca=${encodeURIComponent('%')}`);

      assert.ok(todos.body.total > 1);
      assert.equal(comPorcento.body.usuarios.length, 1, 'só quem realmente tem % no nome');
    });

    test('vinculo=sem_grupo traz só quem não está em grupo nenhum', async () => {
      const resposta = await listar(cookieMasterA, '?vinculo=sem_grupo');

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.usuarios.every((u) => u.grupoAcessoId === null), true);
      assert.equal(resposta.body.usuarios.some((u) => u.nome === 'Ana Souza'), false);
    });

    test('vinculo=com_grupo traz só quem já está em algum grupo', async () => {
      const resposta = await listar(cookieMasterA, '?vinculo=com_grupo');

      assert.equal(resposta.body.usuarios.every((u) => u.grupoAcessoId !== null), true);
      assert.equal(resposta.body.usuarios.some((u) => u.nome === 'Ana Souza'), true);
    });

    test('busca sem resultado devolve lista vazia e total zero, não 404', async () => {
      const resposta = await listar(cookieMasterA, '?busca=ninguemcomessenome');

      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body.usuarios, []);
      assert.equal(resposta.body.total, 0);
    });

    test('a paginação limita a página e preserva o total do filtro', async () => {
      const completa = await listar(cookieMasterA);
      const primeira = await listar(cookieMasterA, '?pagina=1&limite=2');
      const segunda = await listar(cookieMasterA, '?pagina=2&limite=2');

      assert.equal(primeira.body.usuarios.length, 2);
      assert.equal(primeira.body.total, completa.body.total, 'o total não é o da página');
      assert.equal(primeira.body.pagina, 1);
      assert.equal(primeira.body.limite, 2);
      assert.notDeepEqual(
        segunda.body.usuarios.map((u) => u.id),
        primeira.body.usuarios.map((u) => u.id),
      );
    });

    test('parâmetro desconhecido é recusado com 400, não ignorado', async () => {
      for (const query of ['?empresaId=999', '?atorId=1', '?perfil=MASTER', '?isMaster=true', '?ordem=desc']) {
        const resposta = await listar(cookieMasterA, query);
        assert.equal(resposta.status, 400, `${query} deveria ser recusado`);
        assert.equal(resposta.body.codigo, 'VALIDACAO');
      }
    });

    test('valores inválidos de filtro e paginação são recusados com 400', async () => {
      for (const query of ['?vinculo=inventado', '?vinculo=', '?pagina=0', '?limite=0', '?limite=101', '?busca=']) {
        const resposta = await listar(cookieMasterA, query);
        assert.equal(resposta.status, 400, `${query} deveria ser recusado`);
      }
    });
  });

  describe('isolamento multiempresa', () => {
    test('a empresa vem da sessão: cada MASTER vê apenas a sua gente', async () => {
      const respostaA = await listar(cookieMasterA);
      const respostaB = await listar(cookieMasterB);

      assert.equal(respostaA.body.usuarios.some((u) => u.nome === 'Ana Souza'), true);
      assert.equal(respostaA.body.usuarios.some((u) => u.nome === 'Ana da Empresa B'), false);

      assert.equal(respostaB.body.usuarios.some((u) => u.nome === 'Ana da Empresa B'), true);
      assert.equal(respostaB.body.usuarios.some((u) => u.nome === 'Ana Souza'), false);
    });

    test('nenhum identificador de outra empresa aparece nos resultados', async () => {
      const { rows } = await pool.query('SELECT id FROM usuarios WHERE empresa_id <> $1', [empresaA]);
      const idsDeFora = new Set(rows.map((r) => r.id));

      const resposta = await listar(cookieMasterA);

      for (const usuario of resposta.body.usuarios) {
        assert.equal(idsDeFora.has(usuario.id), false, `id ${usuario.id} é de outra empresa`);
      }
    });

    test('buscar por alguém de outra empresa não a encontra', async () => {
      const resposta = await listar(cookieMasterA, '?busca=ana.b@demo');

      assert.deepEqual(resposta.body.usuarios, []);
    });
  });

  describe('somente leitura', () => {
    test('POST, PUT, PATCH e DELETE não existem nesta rota', async () => {
      for (const resposta of [
        await request(app).post('/api/usuarios').set('Cookie', cookieMasterA).send({ nome: 'X' }),
        await request(app).put('/api/usuarios').set('Cookie', cookieMasterA).send({ nome: 'X' }),
        await request(app).patch('/api/usuarios').set('Cookie', cookieMasterA).send({ nome: 'X' }),
        await request(app).delete('/api/usuarios').set('Cookie', cookieMasterA),
      ]) {
        assert.ok([404, 405].includes(resposta.status), `status inesperado: ${resposta.status}`);
      }
    });

    test('a tabela de usuários fica intacta depois das tentativas de escrita', async () => {
      const { rows } = await pool.query('SELECT count(*)::int AS total FROM usuarios');
      const resposta = await listar(cookieMasterA, '?limite=100');

      assert.equal(resposta.body.total + 2, rows[0].total, 'os 2 da empresa B ficam de fora');
    });
  });
});
