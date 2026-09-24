'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarCatalogoController } = require('../../src/controllers/catalogo.controller');
const { criarCatalogoRoutes } = require('../../src/routes/catalogo.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const autorizacaoServico = require('../../src/services/autorizacao-individual.service');
const autoridade = require('../../src/services/autoridade-administrativa');
const { gerarHashSenha } = require('../../src/security/password');

/**
 * API HTTP do catálogo de ações (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3T) de ponta a ponta: HTTP -> autenticação real -> rota real
 * -> controller real -> serviço real -> PostgreSQL real.
 *
 * A rota montada aqui é EXATAMENTE a de produção
 * (criarCatalogoRoutes/criarCatalogoController), pela mesma fábrica que
 * app.js usa — só o pool e o limitador são exclusivos deste arquivo.
 *
 * O que precisa ficar provado, já que esta é a primeira rota do bloco a
 * expor um catálogo global:
 *
 *   • ela NÃO é pública: sem sessão, 401;
 *   • ela exige a mesma autoridade administrativa da configuração de
 *     permissões de grupo — um ADMINISTRADOR comum recebe 403, e o
 *     mesmo usuário passa a ler depois da concessão real da 3I;
 *   • o que ela devolve é o catálogo REAL das migrations (003/017/024),
 *     não uma lista mantida à mão;
 *   • sendo catálogo global, ela responde igual para empresas
 *     diferentes — e é só isso que atravessa a fronteira, nunca
 *     permissão de ninguém;
 *   • é somente leitura: não existe caminho para criar, alterar ou
 *     desativar uma ação por HTTP.
 *
 * A migration 024 é aplicada NESTE SCHEMA TEMPORÁRIO apenas — o banco
 * principal não é tocado.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '025', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024'];

const SENHA = 'senha-correta-do-teste-3t-2026';
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

describe('API HTTP do catálogo de ações com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let masterA;
  let adminA;
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

    const inserirUsuario = async (empresaId, email, perfil) => {
      const { rows: criado } = await pool.query(
        'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, true) RETURNING id',
        [empresaId, `Usuário ${email}`, email, HASH_SENHA, perfil],
      );
      return criado[0].id;
    };
    masterA = await inserirUsuario(empresaA, EMAIL_MASTER_A, 'MASTER');
    adminA = await inserirUsuario(empresaA, EMAIL_ADMIN_A, 'ADMINISTRADOR');
    await inserirUsuario(empresaA, EMAIL_USUARIO_A, 'USUARIO');
    await inserirUsuario(empresaB, EMAIL_MASTER_B, 'MASTER');

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao });
    const catalogoRoutes = criarCatalogoRoutes({ controller: criarCatalogoController({ pool }), exigirSessao });

    app = criarAppTeste((a) => { a.use('/api', authRoutes, catalogoRoutes); });

    cookieMasterA = await login(CNPJ_A, EMAIL_MASTER_A);
    cookieAdminA = await login(CNPJ_A, EMAIL_ADMIN_A);
    cookieUsuarioA = await login(CNPJ_A, EMAIL_USUARIO_A);
    cookieMasterB = await login(CNPJ_B, EMAIL_MASTER_B);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('autenticação', () => {
    test('sem cookie: 401 SESSAO_INVALIDA — o catálogo não é público', async () => {
      const resposta = await request(app).get('/api/catalogo/acoes');

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
      assert.equal(resposta.body.acoes, undefined, 'nenhum código de ação vaza na recusa');
    });

    test('cookie inválido também recebe 401, sem pista sobre o catálogo', async () => {
      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', 'sessao=token-que-nao-existe');

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.acoes, undefined);
    });

    test('sessão revogada perde o acesso imediatamente', async () => {
      const cookie = await login(CNPJ_A, EMAIL_MASTER_A);
      assert.equal((await request(app).get('/api/catalogo/acoes').set('Cookie', cookie)).status, 200);

      await pool.query(
        `UPDATE sessoes SET revogada_em = now(), motivo_revogacao = 'TESTE'
          WHERE usuario_id = $1 AND revogada_em IS NULL`,
        [masterA],
      );

      assert.equal((await request(app).get('/api/catalogo/acoes').set('Cookie', cookie)).status, 401);

      // As sessões usadas pelos demais testes foram revogadas junto:
      // renovar aqui mantém o restante do arquivo independente.
      cookieMasterA = await login(CNPJ_A, EMAIL_MASTER_A);
    });
  });

  describe('autoridade administrativa (3Q)', () => {
    test('MASTER lê o catálogo', async () => {
      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterA);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.status, 'ok');
      assert.ok(Array.isArray(resposta.body.acoes));
      assert.ok(resposta.body.acoes.length > 0);
    });

    test('ADMINISTRADOR sem autorização individual recebe 403 CATALOGO_NAO_AUTORIZADO', async () => {
      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieAdminA);

      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'CATALOGO_NAO_AUTORIZADO');
      assert.equal(resposta.body.acoes, undefined);
    });

    test('USUARIO comum também recebe 403', async () => {
      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieUsuarioA);

      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'CATALOGO_NAO_AUTORIZADO');
    });

    test('a consulta recusada não grava auditoria: ler catálogo não é evento auditável', async () => {
      const { rows: antes } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria');

      await request(app).get('/api/catalogo/acoes').set('Cookie', cookieAdminA);
      await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterA);

      const { rows: depois } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria');
      assert.equal(depois[0].total, antes[0].total);
    });

    test('concedida ADMINISTRAR_PERMISSOES_GRUPO pela 3I, o mesmo ADMINISTRADOR passa a ler', async () => {
      const criada = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA,
        concedidoPor: masterA,
        usuarioId: adminA,
        acaoCodigo: autoridade.ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO,
      });
      autorizacaoConcedida = criada.id;

      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieAdminA);

      assert.equal(resposta.status, 200);
      assert.ok(resposta.body.acoes.length > 0);
    });

    test('revogada a autorização, volta o 403 — sem precisar de novo login', async () => {
      assert.ok(autorizacaoConcedida, 'a concessão do teste anterior é o insumo deste');

      await autorizacaoServico.revogar(pool, {
        empresaId: empresaA,
        revogadoPor: masterA,
        autorizacaoId: autorizacaoConcedida,
      });

      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieAdminA);

      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'CATALOGO_NAO_AUTORIZADO');
    });
  });

  describe('conteúdo do catálogo', () => {
    test('é exatamente o que está em `acoes`, ordenado pelo código', async () => {
      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterA);
      const { rows } = await pool.query('SELECT codigo FROM acoes ORDER BY codigo');

      assert.deepEqual(resposta.body.acoes.map((a) => a.codigo), rows.map((r) => r.codigo));
    });

    test('cada ação traz nome, situação, exigência de SST e modo de autorização', async () => {
      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterA);

      for (const acao of resposta.body.acoes) {
        assert.deepEqual(
          Object.keys(acao).sort(),
          ['ativo', 'codigo', 'descricao', 'exigeSst', 'modoAutorizacaoIndividual', 'nome'],
        );
        assert.equal(typeof acao.ativo, 'boolean');
        assert.equal(typeof acao.exigeSst, 'boolean');
        assert.ok(['NENHUMA', 'ALTERNATIVA', 'OBRIGATORIA'].includes(acao.modoAutorizacaoIndividual));
      }
    });

    test('traz as três ações administrativas da migration 024, todas OBRIGATORIA', async () => {
      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterA);
      const porCodigo = Object.fromEntries(resposta.body.acoes.map((a) => [a.codigo, a]));

      for (const codigo of Object.values(autoridade.ACOES_ADMINISTRATIVAS)) {
        assert.ok(porCodigo[codigo], `faltou ${codigo}`);
        assert.equal(porCodigo[codigo].modoAutorizacaoIndividual, 'OBRIGATORIA');
        assert.equal(porCodigo[codigo].exigeSst, false);
        assert.equal(porCodigo[codigo].ativo, true);
      }
    });

    test('uma ação desativada no banco continua aparecendo, marcada como inativa', async () => {
      const codigo = Object.values(autoridade.ACOES_ADMINISTRATIVAS)[0];
      await pool.query('UPDATE acoes SET ativo = false WHERE codigo = $1', [codigo]);

      try {
        const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterA);
        const acao = resposta.body.acoes.find((a) => a.codigo === codigo);

        assert.ok(acao, 'a tela precisa saber que a ação existe, para não oferecer configurá-la');
        assert.equal(acao.ativo, false);
      } finally {
        await pool.query('UPDATE acoes SET ativo = true WHERE codigo = $1', [codigo]);
      }
    });

    test('nenhum dado de permissão, usuário ou empresa acompanha o catálogo', async () => {
      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterA);

      assert.deepEqual(Object.keys(resposta.body).sort(), ['acoes', 'status']);

      // A verificação é sobre a ESTRUTURA, não sobre o texto: as
      // descrições da migration 024 dizem "da própria empresa", e isso é
      // conteúdo legítimo do catálogo. O que não pode existir é campo
      // que carregue estado de alguém.
      const proibidos = ['empresaId', 'empresa_id', 'usuarioId', 'usuario_id', 'permitido', 'senha', 'token', 'grupoAcessoId'];
      for (const acao of resposta.body.acoes) {
        for (const campo of proibidos) {
          assert.equal(campo in acao, false, `"${campo}" não deveria existir em ${acao.codigo}`);
        }
      }
    });
  });

  describe('catálogo é global, permissão não é', () => {
    test('empresas diferentes recebem o mesmo catálogo', async () => {
      const respostaA = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterA);
      const respostaB = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterB);

      assert.equal(respostaA.status, 200);
      assert.equal(respostaB.status, 200);
      assert.deepEqual(respostaB.body.acoes, respostaA.body.acoes);
    });
  });

  describe('somente leitura', () => {
    test('POST, PATCH, PUT e DELETE não existem nesta rota', async () => {
      for (const resposta of [
        await request(app).post('/api/catalogo/acoes').set('Cookie', cookieMasterA).send({ codigo: 'X' }),
        await request(app).patch('/api/catalogo/acoes').set('Cookie', cookieMasterA).send({ ativo: false }),
        await request(app).put('/api/catalogo/acoes').set('Cookie', cookieMasterA).send({ ativo: false }),
        await request(app).delete('/api/catalogo/acoes').set('Cookie', cookieMasterA),
      ]) {
        assert.ok([404, 405].includes(resposta.status), `status inesperado: ${resposta.status}`);
      }
    });

    test('o catálogo do banco fica intacto depois das tentativas de escrita', async () => {
      const { rows } = await pool.query('SELECT count(*)::int AS total FROM acoes');
      const resposta = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterA);

      assert.equal(resposta.body.acoes.length, rows[0].total);
    });

    test('query string desconhecida é ignorada: a rota não tem filtros', async () => {
      const semFiltro = await request(app).get('/api/catalogo/acoes').set('Cookie', cookieMasterA);
      const comFiltro = await request(app).get('/api/catalogo/acoes?ativo=false&empresaId=999').set('Cookie', cookieMasterA);

      assert.equal(comFiltro.status, 200);
      assert.deepEqual(comFiltro.body.acoes, semFiltro.body.acoes);
    });
  });
});
