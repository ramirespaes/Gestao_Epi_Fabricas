'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAutorizacaoConsultaController } = require('../../src/controllers/autorizacao-consulta.controller');
const { criarAutorizacaoConsultaRoutes } = require('../../src/routes/autorizacao-consulta.routes');
const { criarAutorizacaoIndividualController } = require('../../src/controllers/autorizacao-individual.controller');
const { criarAutorizacaoIndividualRoutes } = require('../../src/routes/autorizacao-individual.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const autorizacaoServico = require('../../src/services/autorizacao-individual.service');
const { gerarHashSenha } = require('../../src/security/password');

/**
 * API HTTP de consulta de autorizações individuais (Bloco 8, Incremento
 * 8, Etapa 5A, Subetapa 3V) de ponta a ponta: HTTP -> autenticação real
 * -> rota real -> controller real -> serviço real -> PostgreSQL real.
 *
 * A rota montada aqui é EXATAMENTE a de produção, pela mesma fábrica
 * que app.js usa. As rotas da 3P entram lado a lado para provar que
 * convivem no mesmo caminho base sem conflito — e continuam intactas.
 *
 * O que precisa ficar provado, já que a autoridade de leitura ESPELHA
 * a de escrita da 3I:
 *
 *   • não é pública: sem sessão, 401;
 *   • MASTER lê qualquer pessoa da empresa (escopo TOTAL);
 *   • não-MASTER lê as próprias (PROPRIAS) e, sobre terceiros, apenas
 *     as que ele mesmo concedeu (CONCEDIDAS_POR_MIM) — nem uma a mais;
 *   • nomes vêm por junção; e-mail, senha e biometria NÃO vêm;
 *   • outra empresa não enxerga nada, nem por id;
 *   • usuarioId é obrigatório e nenhum campo de autoridade é aceito.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '025', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024'];

const SENHA = 'senha-correta-do-teste-3v-2026';
let HASH_SENHA;

const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
const EMAIL_ADMIN_A = 'admin-a@demo.safeworkengenharia.com.br';
const EMAIL_ANA = 'ana@demo.safeworkengenharia.com.br';
const EMAIL_MASTER_B = 'master-b@demo.safeworkengenharia.com.br';

const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE';

function extrairCookie(resposta) {
  const cookies = resposta.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 1, 'esperado exatamente um Set-Cookie');
  return cookies[0].split(';')[0];
}

describe('API HTTP de consulta de autorizações individuais com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let masterA;
  let adminA;
  let ana;
  let anaB;
  let cookieMasterA;
  let cookieAdminA;
  let cookieAna;
  let cookieMasterB;
  let direta;      // master -> admin, podeDelegar
  let delegada;    // admin -> ana (origem: direta)
  let outraDireta; // master -> ana

  async function login(cnpj, email) {
    const resposta = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA });
    assert.equal(resposta.status, 200, 'login deveria ter sucesso na preparação do cenário');
    return extrairCookie(resposta);
  }

  const consultar = (cookie, query) => request(app).get(`/api/autorizacoes-individuais${query}`).set('Cookie', cookie);

  before(async () => {
    HASH_SENHA = await gerarHashSenha(SENHA);
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;

    assert.equal(await inserirEmpresa(pool, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, CNPJ_B, 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
    const empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;

    const inserirUsuario = async (empresaId, email, perfil, nome) => {
      const { rows: criado } = await pool.query(
        'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, true) RETURNING id',
        [empresaId, nome, email, HASH_SENHA, perfil],
      );
      return criado[0].id;
    };
    masterA = await inserirUsuario(empresaA, EMAIL_MASTER_A, 'MASTER', 'Master da Empresa A');
    adminA = await inserirUsuario(empresaA, EMAIL_ADMIN_A, 'ADMINISTRADOR', 'Administrador da Empresa A');
    ana = await inserirUsuario(empresaA, EMAIL_ANA, 'USUARIO', 'Ana Souza');
    const masterB = await inserirUsuario(empresaB, EMAIL_MASTER_B, 'MASTER', 'Master da Empresa B');
    anaB = await inserirUsuario(empresaB, 'ana.b@demo.safeworkengenharia.com.br', 'USUARIO', 'Ana da Empresa B');

    // Cadeia real, criada pelo serviço da 3I: master -> admin (repassável)
    // -> ana; e uma direta independente master -> ana.
    direta = await autorizacaoServico.concederDireta(pool, {
      empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
    });
    delegada = await autorizacaoServico.delegar(pool, {
      empresaId: empresaA, concedidoPor: adminA, origemId: direta.id, usuarioId: ana,
    });
    outraDireta = await autorizacaoServico.concederDireta(pool, {
      empresaId: empresaA, concedidoPor: masterA, usuarioId: ana, acaoCodigo: 'APROVAR_SOLICITACAO',
    });
    // Uma autorização na empresa B, para provar isolamento.
    await autorizacaoServico.concederDireta(pool, {
      empresaId: empresaB, concedidoPor: masterB, usuarioId: anaB, acaoCodigo: ACAO_ALTERNATIVA,
    });

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao }),
        criarAutorizacaoIndividualRoutes({ controller: criarAutorizacaoIndividualController({ pool }), exigirSessao }),
        criarAutorizacaoConsultaRoutes({ controller: criarAutorizacaoConsultaController({ pool }), exigirSessao }),
      );
    });

    cookieMasterA = await login(CNPJ_A, EMAIL_MASTER_A);
    cookieAdminA = await login(CNPJ_A, EMAIL_ADMIN_A);
    cookieAna = await login(CNPJ_A, EMAIL_ANA);
    cookieMasterB = await login(CNPJ_B, EMAIL_MASTER_B);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('autenticação e validação', () => {
    test('sem cookie: 401 SESSAO_INVALIDA — nada vaza', async () => {
      const resposta = await request(app).get(`/api/autorizacoes-individuais?usuarioId=${ana}`);

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
      assert.equal(resposta.body.autorizacoes, undefined);
    });

    test('usuarioId é obrigatório: sem ele, 400', async () => {
      const resposta = await consultar(cookieMasterA, '');

      assert.equal(resposta.status, 400);
      assert.equal(resposta.body.codigo, 'VALIDACAO');
    });

    test('usuarioId inválido é 400', async () => {
      for (const query of ['?usuarioId=0', '?usuarioId=-1', '?usuarioId=abc', '?usuarioId=1.5', '?usuarioId=']) {
        assert.equal((await consultar(cookieMasterA, query)).status, 400, `${query} deveria ser recusado`);
      }
    });

    test('campo de autoridade na query é recusado, não ignorado', async () => {
      for (const extra of ['&empresaId=999', '&atorId=1', '&perfil=MASTER', '&isMaster=true', '&autorizadoPor=1']) {
        const resposta = await consultar(cookieMasterA, `?usuarioId=${ana}${extra}`);
        assert.equal(resposta.status, 400, `${extra} deveria ser recusado`);
        assert.equal(resposta.body.codigo, 'VALIDACAO');
      }
    });
  });

  describe('autoridade de leitura espelha a de escrita', () => {
    test('MASTER lê qualquer pessoa: as duas autorizações de Ana, escopo TOTAL', async () => {
      const resposta = await consultar(cookieMasterA, `?usuarioId=${ana}`);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.escopo, 'TOTAL');
      assert.deepEqual(
        resposta.body.autorizacoes.map((a) => a.id).sort((x, y) => x - y),
        [delegada.id, outraDireta.id].sort((x, y) => x - y),
      );
    });

    test('não-MASTER lê as próprias: escopo PROPRIAS, lista completa', async () => {
      const resposta = await consultar(cookieAdminA, `?usuarioId=${adminA}`);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.escopo, 'PROPRIAS');
      assert.deepEqual(resposta.body.autorizacoes.map((a) => a.id), [direta.id]);
      assert.equal(resposta.body.autorizacoes[0].podeDelegar, true, 'é daqui que sai a origem delegável');
    });

    test('não-MASTER lendo terceiro vê SÓ o que concedeu: a delegada, não a direta do Master', async () => {
      const resposta = await consultar(cookieAdminA, `?usuarioId=${ana}`);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.escopo, 'CONCEDIDAS_POR_MIM');
      assert.deepEqual(resposta.body.autorizacoes.map((a) => a.id), [delegada.id]);
      assert.equal(
        resposta.body.autorizacoes.some((a) => a.id === outraDireta.id),
        false,
        'a autorização concedida pelo Master não é visível ao Administrador',
      );
    });

    test('quem não concedeu nada a alguém vê lista vazia, não 403', async () => {
      const resposta = await consultar(cookieAna, `?usuarioId=${adminA}`);

      assert.equal(resposta.status, 200, 'sem revelar que existe algo ali');
      assert.deepEqual(resposta.body.autorizacoes, []);
      assert.equal(resposta.body.escopo, 'CONCEDIDAS_POR_MIM');
    });

    test('a leitura não grava auditoria', async () => {
      const { rows: antes } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria');

      await consultar(cookieMasterA, `?usuarioId=${ana}`);
      await consultar(cookieAdminA, `?usuarioId=${ana}`);

      const { rows: depois } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria');
      assert.equal(depois[0].total, antes[0].total);
    });

    test('ator inativado depois do login recebe 403', async () => {
      const cookie = await login(CNPJ_A, EMAIL_ANA);
      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [ana]);

      try {
        const resposta = await consultar(cookie, `?usuarioId=${ana}`);
        // exigirSessao pode recusar antes (usuário inativo invalida a
        // sessão) — nos dois casos, nada é lido.
        assert.ok([401, 403].includes(resposta.status), `status inesperado: ${resposta.status}`);
        assert.equal(resposta.body.autorizacoes, undefined);
      } finally {
        await pool.query('UPDATE usuarios SET ativo = true WHERE id = $1', [ana]);
      }
    });
  });

  describe('conteúdo e privacidade', () => {
    test('cada linha traz os nomes por junção e o estado da ação', async () => {
      const resposta = await consultar(cookieMasterA, `?usuarioId=${ana}`);
      const linha = resposta.body.autorizacoes.find((a) => a.id === delegada.id);

      assert.equal(linha.usuarioNome, 'Ana Souza');
      assert.equal(linha.autorizadoPorNome, 'Administrador da Empresa A');
      assert.equal(linha.acaoCodigo, ACAO_ALTERNATIVA);
      assert.equal(typeof linha.acaoNome, 'string');
      assert.equal(linha.acaoModo, 'ALTERNATIVA');
      assert.equal(typeof linha.acaoExigeSst, 'boolean');
      assert.equal(linha.acaoAtiva, true);
      assert.equal(linha.origemId, direta.id, 'a delegada aponta para a origem');
    });

    test('direta e delegada são distinguíveis por origemId', async () => {
      const resposta = await consultar(cookieMasterA, `?usuarioId=${ana}`);
      const porId = Object.fromEntries(resposta.body.autorizacoes.map((a) => [a.id, a]));

      assert.equal(porId[delegada.id].origemId, direta.id);
      assert.equal(porId[outraDireta.id].origemId, null);
    });

    test('nenhuma credencial, biometria nem e-mail acompanham a resposta', async () => {
      const resposta = await consultar(cookieMasterA, `?usuarioId=${ana}`);

      for (const linha of resposta.body.autorizacoes) {
        for (const proibido of ['senha', 'senha_hash', 'senhaHash', 'biometria', 'email', 'token']) {
          assert.equal(proibido in linha, false, `"${proibido}" não deveria existir`);
        }
      }
    });

    test('pessoa sem autorização devolve lista vazia, não 404', async () => {
      const resposta = await consultar(cookieMasterA, `?usuarioId=${masterA}`);

      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body.autorizacoes, []);
    });
  });

  describe('isolamento multiempresa', () => {
    test('o MASTER da empresa B não enxerga as autorizações da empresa A', async () => {
      const resposta = await consultar(cookieMasterB, `?usuarioId=${ana}`);

      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body.autorizacoes, [], 'o id existe, mas não nesta empresa');
    });

    test('o MASTER da empresa A não enxerga as da empresa B', async () => {
      const resposta = await consultar(cookieMasterA, `?usuarioId=${anaB}`);

      assert.deepEqual(resposta.body.autorizacoes, []);
    });

    test('nenhum id de autorização de outra empresa aparece', async () => {
      const { rows } = await pool.query('SELECT id FROM usuario_autorizacoes WHERE empresa_id <> $1', [empresaA]);
      const deFora = new Set(rows.map((r) => r.id));
      assert.ok(deFora.size > 0, 'o cenário tem autorização em outra empresa');

      for (const alvo of [ana, adminA, masterA]) {
        const resposta = await consultar(cookieMasterA, `?usuarioId=${alvo}`);
        for (const linha of resposta.body.autorizacoes) {
          assert.equal(deFora.has(linha.id), false);
        }
      }
    });
  });

  describe('convivência com as rotas da 3P, intactas', () => {
    test('POST e DELETE da 3P continuam respondendo no mesmo caminho base', async () => {
      const criada = await request(app).post('/api/autorizacoes-individuais').set('Cookie', cookieMasterA)
        .send({ tipo: 'DIRETA', usuarioId: ana, acaoCodigo: ACAO_ALTERNATIVA });
      assert.equal(criada.status, 201, JSON.stringify(criada.body));

      const lida = await consultar(cookieMasterA, `?usuarioId=${ana}`);
      assert.equal(lida.body.autorizacoes.some((a) => a.id === criada.body.autorizacao.id), true, 'a consulta vê o que a 3P criou');

      const revogada = await request(app).delete(`/api/autorizacoes-individuais/${criada.body.autorizacao.id}`)
        .set('Cookie', cookieMasterA).send({});
      assert.equal(revogada.status, 200);

      const relida = await consultar(cookieMasterA, `?usuarioId=${ana}`);
      assert.equal(relida.body.autorizacoes.some((a) => a.id === criada.body.autorizacao.id), false);
    });

    test('a rota de consulta é somente leitura: PUT e PATCH não existem', async () => {
      for (const resposta of [
        await request(app).put('/api/autorizacoes-individuais').set('Cookie', cookieMasterA).send({}),
        await request(app).patch('/api/autorizacoes-individuais').set('Cookie', cookieMasterA).send({}),
      ]) {
        assert.ok([404, 405].includes(resposta.status), `status inesperado: ${resposta.status}`);
      }
    });
  });
});
