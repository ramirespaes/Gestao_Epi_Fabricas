'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarDelegacaoDestinatariosController } = require('../../src/controllers/delegacao-destinatarios.controller');
const { criarDelegacaoDestinatariosRoutes } = require('../../src/routes/delegacao-destinatarios.routes');
const { criarGrupoUsuarioController } = require('../../src/controllers/grupo-usuario.controller');
const { criarGrupoUsuarioRoutes } = require('../../src/routes/grupo-usuario.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const autorizacaoServico = require('../../src/services/autorizacao-individual.service');
const { gerarHashSenha } = require('../../src/security/password');

/**
 * API HTTP de destinatários para delegação (Bloco 8, Incremento 8,
 * Etapa 5A, Subetapa 3V — complemento) de ponta a ponta.
 *
 * O que precisa ficar provado:
 *   • a rota exige que o ator tenha AUTORIDADE EFETIVA para delegar ao
 *     menos uma autorização — não "ter uma linha", mas a mesma
 *     verificação que a 3I faz na hora de delegar (origem própria,
 *     pode_delegar, ação concedível, SST quando exigida, sem bloqueio);
 *   • quem não pode delegar recebe 403, inclusive MASTER (que não
 *     delega) e quem tem linha sem pode_delegar;
 *   • a projeção é mínima: id, nome, e-mail — nada mais;
 *   • só usuários ATIVOS da MESMA empresa, nunca o próprio ator;
 *   • a consulta não concede nada: nem executar, nem delegar, nem
 *     administrar grupos.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024'];

const SENHA = 'senha-correta-do-teste-3v-dest-2026';
let HASH_SENHA;

const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
const EMAIL_ADMIN_A = 'admin-a@demo.safeworkengenharia.com.br';
const EMAIL_SUPERVISOR_A = 'supervisor-a@demo.safeworkengenharia.com.br';
const EMAIL_ANA = 'ana@demo.safeworkengenharia.com.br';
const EMAIL_MASTER_B = 'master-b@demo.safeworkengenharia.com.br';

const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE';
const ACAO_COM_SST = 'APROVAR_SOLICITACAO';

function extrairCookie(resposta) {
  const cookies = resposta.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 1, 'esperado exatamente um Set-Cookie');
  return cookies[0].split(';')[0];
}

describe('API HTTP de destinatários para delegação com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let empresaA;
  let empresaB;
  let masterA;
  let adminA;
  let supervisorA;
  let ana;
  let zilda;
  let anaB;
  let cookieMasterA;
  let cookieAdminA;
  let cookieSupervisorA;
  let cookieAna;
  let cookieMasterB;

  async function login(cnpj, email) {
    const resposta = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA });
    assert.equal(resposta.status, 200, `login de ${email} deveria ter sucesso`);
    return extrairCookie(resposta);
  }

  const consultar = (cookie, query = '') => request(app).get(`/api/delegacao/destinatarios${query}`).set('Cookie', cookie);

  async function limpar() {
    await pool.query('DELETE FROM usuario_autorizacoes WHERE empresa_id = $1', [empresaA]);
    await pool.query('DELETE FROM vinculo_sst WHERE empresa_id = $1', [empresaA]);
    // usuario_bloqueios não tem empresa_id (migration 011): o isolamento
    // é por usuario_id -> usuarios.empresa_id.
    await pool.query('DELETE FROM usuario_bloqueios WHERE usuario_id IN (SELECT id FROM usuarios WHERE empresa_id = $1)', [empresaA]);
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

    const inserirUsuario = async (empresaId, email, perfil, nome, ativo = true) => {
      const { rows: criado } = await pool.query(
        'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [empresaId, nome, email, HASH_SENHA, perfil, ativo],
      );
      return criado[0].id;
    };
    masterA = await inserirUsuario(empresaA, EMAIL_MASTER_A, 'MASTER', 'Master da Empresa A');
    adminA = await inserirUsuario(empresaA, EMAIL_ADMIN_A, 'ADMINISTRADOR', 'Administrador da Empresa A');
    supervisorA = await inserirUsuario(empresaA, EMAIL_SUPERVISOR_A, 'SUPERVISOR', 'Supervisor da Empresa A');
    ana = await inserirUsuario(empresaA, EMAIL_ANA, 'USUARIO', 'Ana Souza');
    zilda = await inserirUsuario(empresaA, 'zilda@demo.safeworkengenharia.com.br', 'USUARIO', 'Zilda Inativa', false);
    const masterB = await inserirUsuario(empresaB, EMAIL_MASTER_B, 'MASTER', 'Master da Empresa B');
    anaB = await inserirUsuario(empresaB, 'ana.b@demo.safeworkengenharia.com.br', 'USUARIO', 'Ana da Empresa B');
    void masterB;

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao }),
        criarDelegacaoDestinatariosRoutes({ controller: criarDelegacaoDestinatariosController({ pool }), exigirSessao }),
        criarGrupoUsuarioRoutes({ controller: criarGrupoUsuarioController({ pool }), exigirSessao }),
      );
    });

    cookieMasterA = await login(CNPJ_A, EMAIL_MASTER_A);
    cookieAdminA = await login(CNPJ_A, EMAIL_ADMIN_A);
    cookieSupervisorA = await login(CNPJ_A, EMAIL_SUPERVISOR_A);
    cookieAna = await login(CNPJ_A, EMAIL_ANA);
    cookieMasterB = await login(CNPJ_B, EMAIL_MASTER_B);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('autenticação e validação', () => {
    test('sem cookie: 401, nada vaza', async () => {
      const resposta = await request(app).get('/api/delegacao/destinatarios');

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.destinatarios, undefined);
    });

    test('E. campo de autoridade ou de identificador na query é recusado com 400', async () => {
      await limpar();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });

      for (const query of ['?empresaId=999', '?atorId=1', '?usuarioId=1', '?perfil=MASTER', '?isMaster=true', '?ativo=false', '?limite=1000']) {
        const resposta = await consultar(cookieAdminA, query);
        assert.equal(resposta.status, 400, `${query} deveria ser recusado`);
        assert.equal(resposta.body.codigo, 'VALIDACAO');
      }
    });
  });

  describe('B. autoridade: só quem pode efetivamente delegar', () => {
    test('sem nenhuma autorização: 403', async () => {
      await limpar();

      const resposta = await consultar(cookieSupervisorA);

      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'CONSULTA_DESTINATARIOS_NAO_AUTORIZADA');
      assert.equal(resposta.body.destinatarios, undefined);
    });

    test('com autorização mas SEM pode_delegar: 403 — poder executar não é poder delegar', async () => {
      await limpar();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: supervisorA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: false,
      });

      assert.equal((await consultar(cookieSupervisorA)).status, 403);
    });

    test('MASTER não delega, logo não tem destinatários de delegação: 403', async () => {
      assert.equal((await consultar(cookieMasterA)).status, 403);
    });

    test('A. com origem própria repassável e efetiva: 200, e a lista chega', async () => {
      await limpar();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });

      const resposta = await consultar(cookieAdminA);

      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.status, 'ok');
      assert.ok(resposta.body.destinatarios.length > 0);
      assert.equal(typeof resposta.body.total, 'number');
    });

    test('H. origem repassável que EXIGE SST, ator fora da SST: 403; dentro da SST: 200', async () => {
      await limpar();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: supervisorA, acaoCodigo: ACAO_COM_SST, podeDelegar: true,
      });

      assert.equal((await consultar(cookieSupervisorA)).status, 403, 'a exigência de SST vale para a consulta como vale para delegar');

      await pool.query('INSERT INTO vinculo_sst (usuario_id, empresa_id, concedido_por) VALUES ($1, $2, $3)', [supervisorA, empresaA, masterA]);

      assert.equal((await consultar(cookieSupervisorA)).status, 200);
    });

    test('H. bloqueio individual na ação da origem: 403', async () => {
      await limpar();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: supervisorA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
      assert.equal((await consultar(cookieSupervisorA)).status, 200, 'antes do bloqueio, pode');

      await pool.query(
        'INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por) VALUES ($1, $2, $3)',
        [supervisorA, ACAO_ALTERNATIVA, masterA],
      );

      assert.equal((await consultar(cookieSupervisorA)).status, 403, 'bloqueado não delega, logo não consulta');
    });

    test('origem de ação DESATIVADA no catálogo não conta', async () => {
      await limpar();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: supervisorA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
      await pool.query('UPDATE acoes SET ativo = false WHERE codigo = $1', [ACAO_ALTERNATIVA]);
      try {
        assert.equal((await consultar(cookieSupervisorA)).status, 403);
      } finally {
        await pool.query('UPDATE acoes SET ativo = true WHERE codigo = $1', [ACAO_ALTERNATIVA]);
      }
    });

    test('a consulta não grava auditoria', async () => {
      await limpar();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
      const { rows: antes } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria');

      await consultar(cookieAdminA);
      await consultar(cookieSupervisorA);

      const { rows: depois } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria');
      assert.equal(depois[0].total, antes[0].total);
    });
  });

  describe('conteúdo mínimo e elegibilidade', () => {
    before(async () => {
      await limpar();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
    });

    test('cada destinatário traz SÓ id, nome e e-mail', async () => {
      const resposta = await consultar(cookieAdminA);

      for (const pessoa of resposta.body.destinatarios) {
        assert.deepEqual(Object.keys(pessoa).sort(), ['email', 'id', 'nome']);
      }
    });

    test('nenhuma credencial, biometria, perfil ou grupo acompanham a resposta', async () => {
      const resposta = await consultar(cookieAdminA);
      const serializado = JSON.stringify(resposta.body).toLowerCase();

      for (const proibido of ['senha', 'argon2', 'token', 'biometria', 'perfil', 'grupoacessoid', 'cpf']) {
        assert.equal(serializado.includes(proibido), false, `"${proibido}" não deveria aparecer`);
      }
    });

    test('D. usuário inativo não é oferecido', async () => {
      const resposta = await consultar(cookieAdminA);

      assert.equal(resposta.body.destinatarios.some((p) => p.id === zilda), false);
    });

    test('o próprio ator não é oferecido: autoconcessão nem chega a ser proposta', async () => {
      const resposta = await consultar(cookieAdminA);

      assert.equal(resposta.body.destinatarios.some((p) => p.id === adminA), false);
    });

    test('a busca casa nome e e-mail, sem diferenciar maiúsculas', async () => {
      const porNome = await consultar(cookieAdminA, '?busca=ANA');
      const porEmail = await consultar(cookieAdminA, '?busca=supervisor-a@');

      assert.ok(porNome.body.destinatarios.some((p) => p.nome === 'Ana Souza'));
      assert.equal(porEmail.body.destinatarios.length, 1);
      assert.equal(porEmail.body.destinatarios[0].id, supervisorA);
    });

    test('curinga digitado é texto, não curinga', async () => {
      const resposta = await consultar(cookieAdminA, `?busca=${encodeURIComponent('%')}`);

      assert.equal(resposta.status, 200);
      assert.deepEqual(resposta.body.destinatarios, [], 'ninguém tem % no nome');
    });

    test('a lista é limitada e o total informa o que ficou de fora', async () => {
      const resposta = await consultar(cookieAdminA);

      assert.ok(resposta.body.destinatarios.length <= 50);
      assert.ok(resposta.body.total >= resposta.body.destinatarios.length);
    });
  });

  describe('C. isolamento multiempresa', () => {
    test('a empresa B não aparece para o delegador da empresa A', async () => {
      await limpar();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });

      const resposta = await consultar(cookieAdminA, '?busca=ana');

      assert.equal(resposta.body.destinatarios.some((p) => p.id === anaB), false);
      assert.equal(resposta.body.destinatarios.some((p) => p.nome === 'Ana da Empresa B'), false);
    });

    test('nenhum id de outra empresa aparece, com ou sem busca', async () => {
      const { rows } = await pool.query('SELECT id FROM usuarios WHERE empresa_id <> $1', [empresaA]);
      const deFora = new Set(rows.map((r) => r.id));

      for (const query of ['', '?busca=a', '?busca=master']) {
        const resposta = await consultar(cookieAdminA, query);
        for (const pessoa of resposta.body.destinatarios) {
          assert.equal(deFora.has(pessoa.id), false, `id ${pessoa.id} é de outra empresa`);
        }
      }
    });
  });

  describe('F/G. a consulta não concede nada', () => {
    test('F. quem pode consultar destinatários NÃO passa a administrar vínculos de grupo', async () => {
      await limpar();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
      assert.equal((await consultar(cookieAdminA)).status, 200);

      const { rows } = await pool.query('SELECT id FROM grupos_acesso WHERE empresa_id = $1 LIMIT 1', [empresaA]);
      const grupoId = rows[0] ? rows[0].id : 1;
      const vinculo = await request(app).put(`/api/grupos-acesso/${grupoId}/usuarios/${ana}`).set('Cookie', cookieAdminA).send({});

      assert.equal(vinculo.status, 403, 'a autoridade de vínculos não veio de carona');
      assert.equal(vinculo.body.codigo, 'GRUPO_VINCULO_NAO_AUTORIZADO');
    });

    test('G. o POST de delegação continua sujeito à 3I: origem forjada é 403 mesmo para quem consulta', async () => {
      const outra = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: supervisorA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });

      const resposta = await autorizacaoServico.delegar(pool, {
        empresaId: empresaA, concedidoPor: adminA, origemId: outra.id, usuarioId: ana,
      }).then(() => null, (erro) => erro);

      assert.ok(resposta, 'deveria ter recusado');
      assert.equal(resposta.status, 403);
    });
  });

  describe('somente leitura', () => {
    test('POST, PUT, PATCH e DELETE não existem nesta rota', async () => {
      for (const resposta of [
        await request(app).post('/api/delegacao/destinatarios').set('Cookie', cookieAdminA).send({}),
        await request(app).put('/api/delegacao/destinatarios').set('Cookie', cookieAdminA).send({}),
        await request(app).patch('/api/delegacao/destinatarios').set('Cookie', cookieAdminA).send({}),
        await request(app).delete('/api/delegacao/destinatarios').set('Cookie', cookieAdminA),
      ]) {
        assert.ok([404, 405].includes(resposta.status), `status inesperado: ${resposta.status}`);
      }
    });
  });
});
