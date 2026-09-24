'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao } = require('../../src/middleware/autorizacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { gerarTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Integração de ponta a ponta: HTTP -> autenticação real (Incremento 7) ->
 * autorização por recurso e por ação (Incremento 8) -> PostgreSQL real, em
 * schema temporário removido em cascata ao final. O schema public não é
 * lido nem escrito.
 *
 * A autenticação usa as MESMAS fábricas de produção (criarAuthController,
 * criarAuthRoutes, criarExigirSessao) — login, /me e logout reais, não uma
 * reimplementação paralela. As rotas de RBAC abaixo de /teste existem
 * SOMENTE neste arquivo: nenhuma rota de negócio é criada em routes/ de
 * produção, e app.js não é tocado.
 *
 * Um único pool temporário, injetado explicitamente em todas as fábricas
 * (controller, exigirSessao, exigirPermissaoRecurso, exigirPermissaoAcao) —
 * nunca o pool global de src/config/database.js, e nenhuma substituição
 * feita depois de importar os módulos.
 *
 * Cada cenário usa sua própria empresa/usuário (CNPJ e e-mail exclusivos),
 * para não depender de ordem entre testes. Quando um cenário precisa alterar
 * a mesma linha de permissão mais de uma vez (ex.: recurso concedido depois
 * negado), o novo valor é escrito explicitamente antes de cada asserção via
 * UPSERT — nunca presumido a partir de um teste anterior.
 */

const SENHA_CORRETA = 'senha-correta-do-teste-rbac-2026';
let HASH_SENHA_CORRETA;

const RECURSO = 'materials';
const ACAO_ENTREGA = 'REALIZAR_ENTREGA';
const ACAO_ESTOQUE = 'MOVIMENTAR_ESTOQUE';
const ACAO_APROVAR = 'APROVAR_SOLICITACAO';

const inserirUsuario = async (cliente, empresaId, email, nome, hash, extra = {}) => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [empresaId, nome, email, hash, extra.perfil ?? 'ADMINISTRADOR', extra.ativo ?? true],
  );
  return rows[0].id;
};

/** Extrai "nome=valor" do único Set-Cookie de uma resposta. */
function extrairCookie(resposta) {
  const cookies = resposta.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 1, 'esperado exatamente um Set-Cookie');
  return cookies[0].split(';')[0];
}

async function definirPermissaoRecurso(pool, empresaId, perfil, recurso, flags) {
  await pool.query(
    `INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (empresa_id, perfil, recurso) DO UPDATE
       SET pode_visualizar = EXCLUDED.pode_visualizar, pode_criar = EXCLUDED.pode_criar,
           pode_editar = EXCLUDED.pode_editar, pode_excluir = EXCLUDED.pode_excluir`,
    [empresaId, perfil, recurso, flags.podeVisualizar ?? false, flags.podeCriar ?? false, flags.podeEditar ?? false, flags.podeExcluir ?? false],
  );
}

async function definirPermissaoAcao(pool, empresaId, perfil, acaoCodigo, permitido) {
  await pool.query(
    `INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (empresa_id, perfil, acao_codigo) DO UPDATE SET permitido = EXCLUDED.permitido`,
    [empresaId, perfil, acaoCodigo, permitido],
  );
}

async function definirBloqueio(pool, usuarioId, acaoCodigo, bloqueado, motivo = null) {
  if (bloqueado) {
    await pool.query(
      `INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, motivo) VALUES ($1, $2, $3)
       ON CONFLICT (usuario_id, acao_codigo) DO UPDATE SET motivo = EXCLUDED.motivo`,
      [usuarioId, acaoCodigo, motivo],
    );
  } else {
    await pool.query('DELETE FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = $2', [usuarioId, acaoCodigo]);
  }
}

async function definirSst(pool, empresaId, usuarioId, concedidoPor, integra) {
  if (integra) {
    await pool.query(
      'INSERT INTO vinculo_sst (usuario_id, empresa_id, concedido_por) VALUES ($1, $2, $3) ON CONFLICT (usuario_id) DO NOTHING',
      [usuarioId, empresaId, concedidoPor],
    );
  } else {
    await pool.query('DELETE FROM vinculo_sst WHERE usuario_id = $1', [usuarioId]);
  }
}

async function definirAutorizacaoIndividual(pool, empresaId, usuarioId, acaoCodigo, autorizadoPor, autorizado) {
  if (autorizado) {
    await pool.query(
      `INSERT INTO usuario_autorizacoes (usuario_id, empresa_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)
       ON CONFLICT (usuario_id, acao_codigo) DO NOTHING`,
      [usuarioId, empresaId, acaoCodigo, autorizadoPor],
    );
  } else {
    await pool.query('DELETE FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = $2', [usuarioId, acaoCodigo]);
  }
}

async function criarGrupoAcesso(pool, empresaId, nome, criadoPor, ativo = true) {
  const { rows } = await pool.query(
    'INSERT INTO grupos_acesso (empresa_id, nome, criado_por, ativo) VALUES ($1, $2, $3, $4) RETURNING id',
    [empresaId, nome, criadoPor, ativo],
  );
  return rows[0].id;
}

async function atribuirGrupo(pool, usuarioId, grupoAcessoId) {
  await pool.query('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupoAcessoId, usuarioId]);
}

async function definirPermissaoRecursoGrupo(pool, empresaId, grupoAcessoId, recurso, flags) {
  await pool.query(
    `INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (grupo_acesso_id, recurso) DO UPDATE
       SET pode_visualizar = EXCLUDED.pode_visualizar, pode_criar = EXCLUDED.pode_criar,
           pode_editar = EXCLUDED.pode_editar, pode_excluir = EXCLUDED.pode_excluir`,
    [empresaId, grupoAcessoId, recurso, flags.podeVisualizar ?? null, flags.podeCriar ?? null, flags.podeEditar ?? null, flags.podeExcluir ?? null],
  );
}

async function definirPermissaoAcaoGrupo(pool, empresaId, grupoAcessoId, acaoCodigo, permitido) {
  await pool.query(
    `INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (grupo_acesso_id, acao_codigo) DO UPDATE SET permitido = EXCLUDED.permitido`,
    [empresaId, grupoAcessoId, acaoCodigo, permitido],
  );
}

async function definirPermissaoRecursoIndividual(pool, empresaId, usuarioId, recurso, flags, concedidoPor) {
  await pool.query(
    `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (usuario_id, recurso) DO UPDATE
       SET pode_visualizar = EXCLUDED.pode_visualizar, pode_criar = EXCLUDED.pode_criar,
           pode_editar = EXCLUDED.pode_editar, pode_excluir = EXCLUDED.pode_excluir`,
    [empresaId, usuarioId, recurso, flags.podeVisualizar ?? null, flags.podeCriar ?? null, flags.podeEditar ?? null, flags.podeExcluir ?? null, concedidoPor],
  );
}

describe('autenticação + RBAC (recurso e ação) com PostgreSQL real', () => {
  let contexto;
  let app;

  /** Cria empresa e usuário ativos, isolados por CNPJ/e-mail próprios do cenário. */
  async function prepararIdentidade(cnpj, email, perfil = 'ADMINISTRADOR') {
    const cliente = await contexto.pool.connect();
    try {
      assert.equal(await inserirEmpresa(cliente, cnpj, `Empresa ${cnpj}`), 'ok');
      const { rows } = await cliente.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpj]);
      const usuarioId = await inserirUsuario(cliente, rows[0].id, email, `Usuário ${email}`, HASH_SENHA_CORRETA, { perfil });
      return { empresaId: rows[0].id, usuarioId };
    } finally {
      cliente.release();
    }
  }

  async function loginEObterCookie(cnpj, email) {
    const resposta = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA_CORRETA });
    assert.equal(resposta.status, 200, 'login deveria ter sucesso na preparação do cenário');
    return extrairCookie(resposta);
  }

  before(async () => {
    HASH_SENHA_CORRETA = await gerarHashSenha(SENHA_CORRETA);

    contexto = await abrirPoolTemporario(['000', '001', '002', '003', '005', '025', '009', '010', '011', '013', '015', '016', '017', '018', '019', '020', '021', '022']);

    const controller = criarAuthController({ pool: contexto.pool });
    const exigirSessaoTeste = criarExigirSessao({ pool: contexto.pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller, limitador, exigirSessao: exigirSessaoTeste });

    const exigirRecursoVisualizar = criarExigirPermissaoRecurso({ pool: contexto.pool }, RECURSO, 'visualizar');
    const exigirRecursoEditar = criarExigirPermissaoRecurso({ pool: contexto.pool }, RECURSO, 'editar');
    const exigirAcaoEntrega = criarExigirPermissaoAcao({ pool: contexto.pool }, ACAO_ENTREGA);
    const exigirAcaoEstoque = criarExigirPermissaoAcao({ pool: contexto.pool }, ACAO_ESTOQUE);
    const exigirAcaoAprovar = criarExigirPermissaoAcao({ pool: contexto.pool }, ACAO_APROVAR);

    app = criarAppTeste((a) => {
      a.use('/api', authRoutes);

      // Rotas EXCLUSIVAS deste arquivo de teste — nunca em src/routes/.
      a.get('/teste/recurso-visualizar', exigirSessaoTeste, exigirRecursoVisualizar, (req, res) => {
        res.status(200).json({ status: 'ok' });
      });
      a.get('/teste/acao-entrega', exigirSessaoTeste, exigirAcaoEntrega, (req, res) => {
        res.status(200).json({ status: 'ok' });
      });
      a.get('/teste/acao-estoque', exigirSessaoTeste, exigirAcaoEstoque, (req, res) => {
        res.status(200).json({ status: 'ok' });
      });
      a.get('/teste/acao-aprovar', exigirSessaoTeste, exigirAcaoAprovar, (req, res) => {
        res.status(200).json({ status: 'ok' });
      });
      a.get('/teste/recurso-editar-e-acao-entrega', exigirSessaoTeste, exigirRecursoEditar, exigirAcaoEntrega, (req, res) => {
        res.status(200).json({ status: 'ok' });
      });
    });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('Cenário 1 — sem cookie', () => {
    test('rota de recurso: 401 SESSAO_INVALIDA, autorização nunca chega a rodar', async () => {
      const resposta = await request(app).get('/teste/recurso-visualizar');

      assert.equal(resposta.status, 401);
      assert.deepEqual(resposta.body, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'Sessão inválida ou expirada' });
    });

    test('rota de ação: 401 SESSAO_INVALIDA, autorização nunca chega a rodar', async () => {
      const resposta = await request(app).get('/teste/acao-entrega');

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    });
  });

  describe('Cenário 2 — cookie inválido ou sessão revogada', () => {
    test('token sintaticamente válido mas nunca emitido: 401 SESSAO_INVALIDA', async () => {
      const cookieForjado = `${authConfig.sessao.cookieNome}=${gerarTokenSessao()}`;

      const resposta = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookieForjado);

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    });

    test('sessão revogada por logout: 401 SESSAO_INVALIDA, mesmo cookie antes válido', async () => {
      const cnpj = '90100001000101';
      const email = 'cenario2@demo.safeworkengenharia.com.br';
      await prepararIdentidade(cnpj, email);
      const cookie = await loginEObterCookie(cnpj, email);
      await request(app).post('/api/auth/logout').set('Cookie', cookie);

      const resposta = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);

      assert.equal(resposta.status, 401);
      assert.equal(resposta.body.codigo, 'SESSAO_INVALIDA');
    });
  });

  describe('Cenário 3 — sessão válida, sem linha de permissão de recurso', () => {
    test('403 PERMISSAO_NEGADA, mas a sessão continua válida', async () => {
      const cnpj = '90300001000101';
      const email = 'cenario3@demo.safeworkengenharia.com.br';
      await prepararIdentidade(cnpj, email);
      const cookie = await loginEObterCookie(cnpj, email);

      const resposta = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);
      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');

      const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
      assert.equal(me.status, 200, 'falta de permissão não pode ter invalidado a sessão');
    });
  });

  describe('Cenário 4 e 5 — permissão de recurso negada explicitamente e concedida', () => {
    test('pode_visualizar=false -> 403; depois pode_visualizar=true -> 200, na mesma sessão', async () => {
      const cnpj = '90450001000101';
      const email = 'cenario45@demo.safeworkengenharia.com.br';
      const { empresaId } = await prepararIdentidade(cnpj, email);
      const cookie = await loginEObterCookie(cnpj, email);

      await definirPermissaoRecurso(contexto.pool, empresaId, 'ADMINISTRADOR', RECURSO, { podeVisualizar: false });
      const negado = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);
      assert.equal(negado.status, 403);
      assert.equal(negado.body.codigo, 'PERMISSAO_NEGADA');

      await definirPermissaoRecurso(contexto.pool, empresaId, 'ADMINISTRADOR', RECURSO, { podeVisualizar: true });
      const concedido = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);
      assert.equal(concedido.status, 200);
    });
  });

  describe('Cenário 6 — permissão de ação ausente ou false', () => {
    test('registro inexistente -> 403', async () => {
      const cnpj = '90600001000101';
      const email = 'cenario6a@demo.safeworkengenharia.com.br';
      await prepararIdentidade(cnpj, email);
      const cookie = await loginEObterCookie(cnpj, email);

      const resposta = await request(app).get('/teste/acao-entrega').set('Cookie', cookie);
      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    });

    test('registro existente com permitido=false -> 403', async () => {
      const cnpj = '90600002000102';
      const email = 'cenario6b@demo.safeworkengenharia.com.br';
      const { empresaId } = await prepararIdentidade(cnpj, email);
      const cookie = await loginEObterCookie(cnpj, email);
      await definirPermissaoAcao(contexto.pool, empresaId, 'ADMINISTRADOR', ACAO_ENTREGA, false);

      const resposta = await request(app).get('/teste/acao-entrega').set('Cookie', cookie);
      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    });
  });

  describe('Cenário 7 e 8 — permissão de ação true, com e sem bloqueio individual', () => {
    test('permitido=true, sem bloqueio -> 200', async () => {
      const cnpj = '90780001000101';
      const email = 'cenario78a@demo.safeworkengenharia.com.br';
      const { empresaId } = await prepararIdentidade(cnpj, email);
      const cookie = await loginEObterCookie(cnpj, email);
      await definirPermissaoAcao(contexto.pool, empresaId, 'ADMINISTRADOR', ACAO_ENTREGA, true);

      const resposta = await request(app).get('/teste/acao-entrega').set('Cookie', cookie);
      assert.equal(resposta.status, 200);
    });

    test('permitido=true, com bloqueio individual -> 403, confirmado diretamente no PostgreSQL', async () => {
      const cnpj = '90780002000102';
      const email = 'cenario78b@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId } = await prepararIdentidade(cnpj, email);
      const cookie = await loginEObterCookie(cnpj, email);
      await definirPermissaoAcao(contexto.pool, empresaId, 'ADMINISTRADOR', ACAO_ENTREGA, true);
      await definirBloqueio(contexto.pool, usuarioId, ACAO_ENTREGA, true);

      const resposta = await request(app).get('/teste/acao-entrega').set('Cookie', cookie);
      assert.equal(resposta.status, 403);
      assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');

      const { rows } = await contexto.pool.query(
        'SELECT usuario_id, acao_codigo FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = $2',
        [usuarioId, ACAO_ENTREGA],
      );
      assert.equal(rows.length, 1, 'o bloqueio usado pela decisão precisa existir de fato no PostgreSQL');
    });
  });

  describe('Cenário 9 — bloqueio individual é específico da ação', () => {
    test('bloqueio em REALIZAR_ENTREGA não nega MOVIMENTAR_ESTOQUE, que tem permissão própria', async () => {
      const cnpj = '90900001000101';
      const email = 'cenario9@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId } = await prepararIdentidade(cnpj, email);
      const cookie = await loginEObterCookie(cnpj, email);

      await definirPermissaoAcao(contexto.pool, empresaId, 'ADMINISTRADOR', ACAO_ENTREGA, true);
      await definirPermissaoAcao(contexto.pool, empresaId, 'ADMINISTRADOR', ACAO_ESTOQUE, true);
      await definirBloqueio(contexto.pool, usuarioId, ACAO_ENTREGA, true);

      const entrega = await request(app).get('/teste/acao-entrega').set('Cookie', cookie);
      assert.equal(entrega.status, 403, 'a ação bloqueada continua negada');

      const estoque = await request(app).get('/teste/acao-estoque').set('Cookie', cookie);
      assert.equal(estoque.status, 200, 'uma ação diferente, com permissão própria, não pode ser afetada pelo bloqueio da outra');
    });
  });

  describe('Cenário 10 — recurso e ação em sequência, quatro estados', () => {
    test('as duas dimensões não se substituem: cada uma precisa estar positiva para autorizar', async () => {
      const cnpj = '91000001000101';
      const email = 'cenario10@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId } = await prepararIdentidade(cnpj, email);
      const cookie = await loginEObterCookie(cnpj, email);

      // 1) recurso negado + ação concedida = 403
      await definirPermissaoRecurso(contexto.pool, empresaId, 'ADMINISTRADOR', RECURSO, { podeEditar: false });
      await definirPermissaoAcao(contexto.pool, empresaId, 'ADMINISTRADOR', ACAO_ENTREGA, true);
      await definirBloqueio(contexto.pool, usuarioId, ACAO_ENTREGA, false);
      const recursoNegado = await request(app).get('/teste/recurso-editar-e-acao-entrega').set('Cookie', cookie);
      assert.equal(recursoNegado.status, 403, 'recurso negado deve bastar para negar, mesmo com ação concedida');

      // 2) recurso concedido + ação negada = 403
      await definirPermissaoRecurso(contexto.pool, empresaId, 'ADMINISTRADOR', RECURSO, { podeEditar: true });
      await definirPermissaoAcao(contexto.pool, empresaId, 'ADMINISTRADOR', ACAO_ENTREGA, false);
      const acaoNegada = await request(app).get('/teste/recurso-editar-e-acao-entrega').set('Cookie', cookie);
      assert.equal(acaoNegada.status, 403, 'ação negada deve bastar para negar, mesmo com recurso concedido');

      // 3) recurso concedido + ação concedida + bloqueio individual = 403
      await definirPermissaoAcao(contexto.pool, empresaId, 'ADMINISTRADOR', ACAO_ENTREGA, true);
      await definirBloqueio(contexto.pool, usuarioId, ACAO_ENTREGA, true);
      const comBloqueio = await request(app).get('/teste/recurso-editar-e-acao-entrega').set('Cookie', cookie);
      assert.equal(comBloqueio.status, 403, 'bloqueio individual nega mesmo com as duas permissões concedidas');

      // 4) recurso concedido + ação concedida + sem bloqueio = 200
      await definirBloqueio(contexto.pool, usuarioId, ACAO_ENTREGA, false);
      const autorizado = await request(app).get('/teste/recurso-editar-e-acao-entrega').set('Cookie', cookie);
      assert.equal(autorizado.status, 200, 'só com as duas permissões e sem bloqueio a requisição é autorizada');
    });
  });

  describe('Cenário 11 — isolamento multiempresa', () => {
    test('permissoes_recurso: mesmo perfil e recurso, valores opostos por empresa, cada sessão só enxerga a própria', async () => {
      const cnpjA = '91100001000101';
      const emailA = 'cenario11-recurso-a@demo.safeworkengenharia.com.br';
      const cnpjB = '91100002000102';
      const emailB = 'cenario11-recurso-b@demo.safeworkengenharia.com.br';

      const { empresaId: empresaA } = await prepararIdentidade(cnpjA, emailA);
      const { empresaId: empresaB } = await prepararIdentidade(cnpjB, emailB);

      // Mesmo perfil (ADMINISTRADOR) e mesmo recurso, valores opostos.
      await definirPermissaoRecurso(contexto.pool, empresaA, 'ADMINISTRADOR', RECURSO, { podeVisualizar: true });
      await definirPermissaoRecurso(contexto.pool, empresaB, 'ADMINISTRADOR', RECURSO, { podeVisualizar: false });

      const cookieA = await loginEObterCookie(cnpjA, emailA);
      const cookieB = await loginEObterCookie(cnpjB, emailB);

      const recursoA = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookieA);
      const recursoB = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookieB);
      assert.equal(recursoA.status, 200, 'empresa A concedeu explicitamente, e sua sessão não pode ser afetada pela matriz de B');
      assert.equal(recursoB.status, 403, 'a concessão de A não pode vazar para a sessão de B');

      // Confirmação direta no PostgreSQL, restrita às duas empresas deste teste.
      const { rows: recursos } = await contexto.pool.query(
        'SELECT empresa_id, pode_visualizar FROM permissoes_recurso WHERE recurso = $1 AND empresa_id = ANY($2::int[]) ORDER BY empresa_id',
        [RECURSO, [empresaA, empresaB]],
      );
      assert.equal(recursos.length, 2, 'devem existir exatamente as duas linhas cadastradas por este teste');
      assert.equal(recursos.find((r) => r.empresa_id === empresaA).pode_visualizar, true);
      assert.equal(recursos.find((r) => r.empresa_id === empresaB).pode_visualizar, false);
    });

    test('permissoes_acao: mesmo perfil e ação, permitido oposto por empresa, cada sessão só enxerga a própria', async () => {
      const cnpjA = '91101001000101';
      const emailA = 'cenario11-acao-a@demo.safeworkengenharia.com.br';
      const cnpjB = '91101002000102';
      const emailB = 'cenario11-acao-b@demo.safeworkengenharia.com.br';

      const { empresaId: empresaA } = await prepararIdentidade(cnpjA, emailA);
      const { empresaId: empresaB } = await prepararIdentidade(cnpjB, emailB);

      // 1-2: mesma ação, mesmo perfil, permitido oposto entre as empresas.
      await definirPermissaoAcao(contexto.pool, empresaA, 'ADMINISTRADOR', ACAO_ENTREGA, false);
      await definirPermissaoAcao(contexto.pool, empresaB, 'ADMINISTRADOR', ACAO_ENTREGA, true);

      const cookieA = await loginEObterCookie(cnpjA, emailA);
      const cookieB = await loginEObterCookie(cnpjB, emailB);

      // 3-4: cada sessão recebe o resultado da própria empresa.
      const acaoA = await request(app).get('/teste/acao-entrega').set('Cookie', cookieA);
      const acaoB = await request(app).get('/teste/acao-entrega').set('Cookie', cookieB);
      assert.equal(acaoA.status, 403, 'empresa A negou explicitamente, e sua sessão não pode herdar a permissão de B');
      assert.equal(acaoB.status, 200, 'a negação de A não pode vazar para a sessão de B');

      // Confirmação direta no PostgreSQL: duas linhas, empresas distintas, valores opostos.
      const { rows: acoes } = await contexto.pool.query(
        'SELECT empresa_id, permitido FROM permissoes_acao WHERE acao_codigo = $1 AND empresa_id = ANY($2::int[]) ORDER BY empresa_id',
        [ACAO_ENTREGA, [empresaA, empresaB]],
      );
      assert.equal(acoes.length, 2, 'devem existir exatamente as duas linhas cadastradas por este teste');
      assert.equal(acoes.find((r) => r.empresa_id === empresaA).permitido, false);
      assert.equal(acoes.find((r) => r.empresa_id === empresaB).permitido, true);
    });

    test('usuario_bloqueios: bloqueio individual do usuário de A não afeta o usuário de B, mesmo com a mesma ação concedida às duas empresas', async () => {
      const cnpjA = '91102001000101';
      const emailA = 'cenario11-bloqueio-a@demo.safeworkengenharia.com.br';
      const cnpjB = '91102002000102';
      const emailB = 'cenario11-bloqueio-b@demo.safeworkengenharia.com.br';

      const { empresaId: empresaA, usuarioId: usuarioA } = await prepararIdentidade(cnpjA, emailA);
      const { empresaId: empresaB, usuarioId: usuarioB } = await prepararIdentidade(cnpjB, emailB);

      // 5: concede a mesma ação para as duas empresas.
      await definirPermissaoAcao(contexto.pool, empresaA, 'ADMINISTRADOR', ACAO_ENTREGA, true);
      await definirPermissaoAcao(contexto.pool, empresaB, 'ADMINISTRADOR', ACAO_ENTREGA, true);
      // 6: bloqueia individualmente somente o usuário de A.
      await definirBloqueio(contexto.pool, usuarioA, ACAO_ENTREGA, true);

      const cookieA = await loginEObterCookie(cnpjA, emailA);
      const cookieB = await loginEObterCookie(cnpjB, emailB);

      // 7-8: mesmo com a permissão de perfil concedida nas duas empresas, só A é negado.
      const acaoA = await request(app).get('/teste/acao-entrega').set('Cookie', cookieA);
      const acaoB = await request(app).get('/teste/acao-entrega').set('Cookie', cookieB);
      assert.equal(acaoA.status, 403, 'usuário de A está bloqueado individualmente para esta ação');
      assert.equal(acaoB.status, 200, 'o bloqueio individual do usuário de A não pode afetar o usuário de B, mesmo com a mesma ação concedida à empresa B');

      // Confirmação direta no PostgreSQL, restrita aos dois usuários deste teste.
      const { rows: bloqueios } = await contexto.pool.query(
        'SELECT usuario_id FROM usuario_bloqueios WHERE acao_codigo = $1 AND usuario_id = ANY($2::int[])',
        [ACAO_ENTREGA, [usuarioA, usuarioB]],
      );
      assert.deepEqual(bloqueios.map((r) => r.usuario_id), [usuarioA], 'só o usuário de A pode ter bloqueio nesta ação, entre os dois deste teste');
      assert.equal(bloqueios.some((r) => r.usuario_id === usuarioB), false);
    });
  });

  describe('Cenário 12 — identidade não vem do navegador', () => {
    test('empresaId, usuarioId e perfil falsificados em query e headers não substituem a sessão', async () => {
      const cnpjReal = '91200001000101';
      const emailReal = 'cenario12-real@demo.safeworkengenharia.com.br';
      const cnpjAlvo = '91200002000102';
      const emailAlvo = 'cenario12-alvo@demo.safeworkengenharia.com.br';

      const { empresaId: empresaReal } = await prepararIdentidade(cnpjReal, emailReal);
      const { empresaId: empresaAlvo } = await prepararIdentidade(cnpjAlvo, emailAlvo, 'MASTER');

      // O usuário real NÃO tem permissão; a empresa/perfil "alvo" TEM.
      await definirPermissaoRecurso(contexto.pool, empresaAlvo, 'MASTER', RECURSO, { podeVisualizar: true });

      const cookieReal = await loginEObterCookie(cnpjReal, emailReal);

      const resposta = await request(app)
        .get('/teste/recurso-visualizar')
        .query({ empresaId: empresaAlvo, perfil: 'MASTER' })
        .set('Cookie', cookieReal)
        .set('X-Empresa-Id', String(empresaAlvo))
        .set('X-Perfil', 'MASTER')
        .set('X-Usuario-Id', '999999');

      assert.equal(resposta.status, 403, 'a decisão deve usar a empresa/perfil da sessão real, não os valores forjados');
      assert.notEqual(resposta.status, 200);
      assert.equal(JSON.stringify(resposta.body).includes(String(empresaAlvo)), false);
    });
  });

  describe('Cenário 13 — MASTER sem bypass', () => {
    test('sem permissão explícita -> 403; com permissão e sem bloqueio -> 200; com bloqueio -> 403', async () => {
      const cnpj = '91300001000101';
      const email = 'cenario13@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId } = await prepararIdentidade(cnpj, email, 'MASTER');
      const cookie = await loginEObterCookie(cnpj, email);

      const semPermissao = await request(app).get('/teste/acao-entrega').set('Cookie', cookie);
      assert.equal(semPermissao.status, 403, 'MASTER sem linha explícita em permissoes_acao não tem acesso automático');

      await definirPermissaoAcao(contexto.pool, empresaId, 'MASTER', ACAO_ENTREGA, true);
      const comPermissao = await request(app).get('/teste/acao-entrega').set('Cookie', cookie);
      assert.equal(comPermissao.status, 200, 'com permissão explícita e sem bloqueio, MASTER é autorizado como qualquer outro perfil');

      await definirBloqueio(contexto.pool, usuarioId, ACAO_ENTREGA, true);
      const comBloqueio = await request(app).get('/teste/acao-entrega').set('Cookie', cookie);
      assert.equal(comBloqueio.status, 403, 'bloqueio individual nega mesmo MASTER com permissão de perfil concedida');
    });
  });

  describe('Cenário 14 — respostas não expõem dados internos', () => {
    test('403 de recurso e de ação não vazam token, hash, matriz interna, motivo de bloqueio ou IDs de outra empresa', async () => {
      const cnpjOutraEmpresa = '91400009000109';
      const emailOutraEmpresa = 'cenario14-outra@demo.safeworkengenharia.com.br';
      const { empresaId: empresaOutra } = await prepararIdentidade(cnpjOutraEmpresa, emailOutraEmpresa);

      const cnpj = '91400001000101';
      const email = 'cenario14@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId } = await prepararIdentidade(cnpj, email);
      const cookie = await loginEObterCookie(cnpj, email);
      await definirPermissaoAcao(contexto.pool, empresaId, 'ADMINISTRADOR', ACAO_ENTREGA, true);
      await definirBloqueio(contexto.pool, usuarioId, ACAO_ENTREGA, true, 'Motivo confidencial de auditoria interna');

      const respostaRecurso = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);
      const respostaAcao = await request(app).get('/teste/acao-entrega').set('Cookie', cookie);

      assert.equal(respostaRecurso.status, 403);
      assert.equal(respostaAcao.status, 403);
      assert.deepEqual(respostaRecurso.body, { status: 'error', codigo: 'PERMISSAO_NEGADA', message: 'Sem permissão para esta operação' });
      assert.deepEqual(respostaAcao.body, { status: 'error', codigo: 'PERMISSAO_NEGADA', message: 'Sem permissão para esta operação' });

      const cookieToken = cookie.split('=')[1];
      for (const resposta of [respostaRecurso, respostaAcao]) {
        const corpo = JSON.stringify(resposta.body);
        assert.equal(corpo.includes(cookieToken), false, 'token não pode aparecer no corpo');
        assert.equal(/token_hash|senha_hash/i.test(corpo), false, 'hashes internos não podem aparecer no corpo');
        assert.equal(/motivo confidencial/i.test(corpo), false, 'motivo do bloqueio não pode ser exposto');
        assert.equal(corpo.includes(String(empresaOutra)), false, 'ID de outra empresa não pode aparecer na resposta');
        assert.equal(/pode_visualizar|pode_criar|pode_editar|pode_excluir|permitido/i.test(corpo), false, 'a matriz interna não pode ser exposta');
      }
    });
  });

  describe('Cenário 15 — regressão do ciclo de autenticação', () => {
    test('login, /me e logout continuam funcionando normalmente com as rotas de RBAC montadas no mesmo app', async () => {
      const cnpj = '91500001000101';
      const email = 'cenario15@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId } = await prepararIdentidade(cnpj, email);

      const login = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA_CORRETA });
      assert.equal(login.status, 200);
      assert.equal(login.body.usuario.id, usuarioId);
      assert.equal(login.body.empresa.id, empresaId);
      const cookie = extrairCookie(login);

      const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
      assert.equal(me.status, 200);
      assert.equal(me.body.usuario.id, usuarioId);

      const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
      assert.equal(logout.status, 200);
      assert.deepEqual(logout.body, { status: 'ok' });

      const meDepois = await request(app).get('/api/auth/me').set('Cookie', cookie);
      assert.equal(meDepois.status, 401);
      assert.equal(meDepois.body.codigo, 'SESSAO_INVALIDA');
    });
  });

  describe('Cenário 16 — autorização individual e SST (Subetapa 2), com PostgreSQL real', () => {
    test('modo ALTERNATIVA (MOVIMENTAR_ESTOQUE): autorização individual concede acesso mesmo SEM nenhuma linha em permissoes_acao — exemplo Carlos/almoxarifado', async () => {
      const cnpj = '91600001000101';
      const emailCarlos = 'carlos-almoxarifado@demo.safeworkengenharia.com.br';
      const emailPedro = 'pedro-producao@demo.safeworkengenharia.com.br';
      const emailConcessor = 'concessor-cenario16a@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      // Mesma empresa: inserirUsuario diretamente, não prepararIdentidade
      // (que recriaria a empresa com o mesmo CNPJ e falharia na UNIQUE).
      const carlosId = await inserirUsuario(contexto.pool, empresaId, emailCarlos, 'Carlos', HASH_SENHA_CORRETA, { perfil: 'USUARIO' });
      await inserirUsuario(contexto.pool, empresaId, emailPedro, 'Pedro', HASH_SENHA_CORRETA, { perfil: 'USUARIO' });

      // Nenhuma linha em permissoes_acao para USUARIO nesta empresa: a
      // ausência não pode negar antecipadamente quem tem autorização
      // individual.
      await definirAutorizacaoIndividual(contexto.pool, empresaId, carlosId, ACAO_ESTOQUE, concessorId, true);

      const cookieCarlos = await loginEObterCookie(cnpj, emailCarlos);
      const cookiePedro = await loginEObterCookie(cnpj, emailPedro);

      const respostaCarlos = await request(app).get('/teste/acao-estoque').set('Cookie', cookieCarlos);
      const respostaPedro = await request(app).get('/teste/acao-estoque').set('Cookie', cookiePedro);

      assert.equal(respostaCarlos.status, 200, 'autorização individual deve autorizar mesmo sem permissoes_acao para o perfil');
      assert.equal(respostaPedro.status, 403, 'Pedro não tem permissão de perfil nem autorização individual');
      assert.equal(respostaPedro.body.codigo, 'PERMISSAO_NEGADA');

      const { rows } = await contexto.pool.query('SELECT count(*)::int AS total FROM permissoes_acao WHERE empresa_id = $1 AND acao_codigo = $2', [empresaId, ACAO_ESTOQUE]);
      assert.equal(rows[0].total, 0, 'a autorização de Carlos não depende de nenhuma linha em permissoes_acao');
    });

    test('modo OBRIGATORIA (APROVAR_SOLICITACAO): exige SST E autorização individual simultaneamente, mesmo sem permissoes_acao — exemplo Maria/SST', async () => {
      const cnpj = '91600002000102';
      const emailMaria = 'maria-sst@demo.safeworkengenharia.com.br';
      const emailConcessor = 'concessor-cenario16b@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      const mariaId = await inserirUsuario(contexto.pool, empresaId, emailMaria, 'Maria', HASH_SENHA_CORRETA, { perfil: 'SUPERVISOR' });
      const cookieMaria = await loginEObterCookie(cnpj, emailMaria);

      // Nem SST, nem autorização individual: negado.
      const semNenhuma = await request(app).get('/teste/acao-aprovar').set('Cookie', cookieMaria);
      assert.equal(semNenhuma.status, 403);

      // Só SST, sem autorização individual: ainda negado — SST não basta
      // sozinha em modo OBRIGATORIA.
      await definirSst(contexto.pool, empresaId, mariaId, concessorId, true);
      const soComSst = await request(app).get('/teste/acao-aprovar').set('Cookie', cookieMaria);
      assert.equal(soComSst.status, 403, 'participar da SST não concede automaticamente a autorização de aprovar/reprovar');

      // SST + autorização individual, sem nenhuma linha em permissoes_acao
      // para SUPERVISOR: autorizado — a ausência de permissão de perfil não
      // nega antecipadamente em modo OBRIGATORIA.
      await definirAutorizacaoIndividual(contexto.pool, empresaId, mariaId, ACAO_APROVAR, concessorId, true);
      const comAsDuas = await request(app).get('/teste/acao-aprovar').set('Cookie', cookieMaria);
      assert.equal(comAsDuas.status, 200);

      const { rows } = await contexto.pool.query('SELECT count(*)::int AS total FROM permissoes_acao WHERE empresa_id = $1 AND acao_codigo = $2', [empresaId, ACAO_APROVAR]);
      assert.equal(rows[0].total, 0, 'Maria foi autorizada sem nenhuma linha em permissoes_acao');

      // Removendo a SST (ex.: revogação), mesmo com autorização individual
      // ainda concedida: volta a negar.
      await definirSst(contexto.pool, empresaId, mariaId, concessorId, false);
      const semSstDeNovo = await request(app).get('/teste/acao-aprovar').set('Cookie', cookieMaria);
      assert.equal(semSstDeNovo.status, 403, 'autorização individual sozinha não basta sem SST em modo OBRIGATORIA');
    });

    test('MASTER dispensa SST e autorização individual: só a permissão de perfil é exigida, mesmo em modo OBRIGATORIA', async () => {
      const cnpj = '91600003000103';
      const emailJoao = 'joao-master@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: joaoId } = await prepararIdentidade(cnpj, emailJoao, 'MASTER');
      const cookieJoao = await loginEObterCookie(cnpj, emailJoao);

      const semPermissao = await request(app).get('/teste/acao-aprovar').set('Cookie', cookieJoao);
      assert.equal(semPermissao.status, 403, 'MASTER ainda precisa da permissão explícita na matriz, mesmo dispensando SST/individual');

      await definirPermissaoAcao(contexto.pool, empresaId, 'MASTER', ACAO_APROVAR, true);
      const comPermissao = await request(app).get('/teste/acao-aprovar').set('Cookie', cookieJoao);
      assert.equal(comPermissao.status, 200);

      const { rows: sst } = await contexto.pool.query('SELECT count(*)::int AS total FROM vinculo_sst WHERE usuario_id = $1', [joaoId]);
      const { rows: individual } = await contexto.pool.query('SELECT count(*)::int AS total FROM usuario_autorizacoes WHERE usuario_id = $1', [joaoId]);
      assert.equal(sst[0].total, 0, 'João nunca precisou de vinculo_sst');
      assert.equal(individual[0].total, 0, 'João nunca precisou de usuario_autorizacoes');
    });
  });

  describe('Cenário 17 — grupos de acesso (Subetapa 3D), com PostgreSQL real', () => {
    test('grupo ativo concede um recurso que o perfil nega', async () => {
      const cnpj = '91700001000101';
      const emailConcessor = 'concessor-cenario17a@demo.safeworkengenharia.com.br';
      const emailUsuario = 'usuario-cenario17a@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      const usuarioId = await inserirUsuario(contexto.pool, empresaId, emailUsuario, 'Usuário 17a', HASH_SENHA_CORRETA, { perfil: 'ADMINISTRADOR' });

      await definirPermissaoRecurso(contexto.pool, empresaId, 'ADMINISTRADOR', RECURSO, { podeVisualizar: false });
      const grupoId = await criarGrupoAcesso(contexto.pool, empresaId, 'Grupo Concede 17a', concessorId, true);
      await definirPermissaoRecursoGrupo(contexto.pool, empresaId, grupoId, RECURSO, { podeVisualizar: true });
      await atribuirGrupo(contexto.pool, usuarioId, grupoId);

      const cookie = await loginEObterCookie(cnpj, emailUsuario);
      const resposta = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);

      assert.equal(resposta.status, 200, 'o grupo ativo concedeu o recurso que o perfil negava');
    });

    test('grupo ativo nega uma ação que o perfil concede (modo ALTERNATIVA)', async () => {
      const cnpj = '91700002000102';
      const emailConcessor = 'concessor-cenario17b@demo.safeworkengenharia.com.br';
      const emailUsuario = 'usuario-cenario17b@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      const usuarioId = await inserirUsuario(contexto.pool, empresaId, emailUsuario, 'Usuário 17b', HASH_SENHA_CORRETA, { perfil: 'USUARIO' });

      await definirPermissaoAcao(contexto.pool, empresaId, 'USUARIO', ACAO_ESTOQUE, true);
      const grupoId = await criarGrupoAcesso(contexto.pool, empresaId, 'Grupo Nega 17b', concessorId, true);
      await definirPermissaoAcaoGrupo(contexto.pool, empresaId, grupoId, ACAO_ESTOQUE, false);
      await atribuirGrupo(contexto.pool, usuarioId, grupoId);

      const cookie = await loginEObterCookie(cnpj, emailUsuario);
      const resposta = await request(app).get('/teste/acao-estoque').set('Cookie', cookie);

      assert.equal(resposta.status, 403, 'o grupo ativo negou a ação que o perfil concedia');
      assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    });

    test('grupo nega a ação, mas autorização individual explícita resgata a concessão (exceção final)', async () => {
      const cnpj = '91700003000103';
      const emailConcessor = 'concessor-cenario17c@demo.safeworkengenharia.com.br';
      const emailUsuario = 'usuario-cenario17c@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      const usuarioId = await inserirUsuario(contexto.pool, empresaId, emailUsuario, 'Usuário 17c', HASH_SENHA_CORRETA, { perfil: 'USUARIO' });

      await definirPermissaoAcao(contexto.pool, empresaId, 'USUARIO', ACAO_ESTOQUE, true);
      const grupoId = await criarGrupoAcesso(contexto.pool, empresaId, 'Grupo Nega 17c', concessorId, true);
      await definirPermissaoAcaoGrupo(contexto.pool, empresaId, grupoId, ACAO_ESTOQUE, false);
      await atribuirGrupo(contexto.pool, usuarioId, grupoId);

      const cookie = await loginEObterCookie(cnpj, emailUsuario);

      const semIndividual = await request(app).get('/teste/acao-estoque').set('Cookie', cookie);
      assert.equal(semIndividual.status, 403, 'sem autorização individual, a negativa do grupo prevalece');

      await definirAutorizacaoIndividual(contexto.pool, empresaId, usuarioId, ACAO_ESTOQUE, concessorId, true);
      const comIndividual = await request(app).get('/teste/acao-estoque').set('Cookie', cookie);
      assert.equal(comIndividual.status, 200, 'autorização individual funciona como exceção final, mesmo após negativa de grupo');
    });

    test('grupo inativo com TRUE não concede o que o perfil já negava', async () => {
      const cnpj = '91700004000104';
      const emailConcessor = 'concessor-cenario17d@demo.safeworkengenharia.com.br';
      const emailUsuario = 'usuario-cenario17d@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      const usuarioId = await inserirUsuario(contexto.pool, empresaId, emailUsuario, 'Usuário 17d', HASH_SENHA_CORRETA, { perfil: 'ADMINISTRADOR' });

      await definirPermissaoRecurso(contexto.pool, empresaId, 'ADMINISTRADOR', RECURSO, { podeVisualizar: false });
      const grupoId = await criarGrupoAcesso(contexto.pool, empresaId, 'Grupo Inativo 17d', concessorId, false);
      await definirPermissaoRecursoGrupo(contexto.pool, empresaId, grupoId, RECURSO, { podeVisualizar: true });
      await atribuirGrupo(contexto.pool, usuarioId, grupoId);

      const cookie = await loginEObterCookie(cnpj, emailUsuario);
      const resposta = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);

      assert.equal(resposta.status, 403, 'grupo inativo nunca concede o que o perfil não concedia');
    });

    test('MASTER não é restringido por grupo, mesmo com um grupo ativo que negaria a ação', async () => {
      const cnpj = '91700005000105';
      const emailMaster = 'master-cenario17e@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: masterId } = await prepararIdentidade(cnpj, emailMaster, 'MASTER');

      await definirPermissaoAcao(contexto.pool, empresaId, 'MASTER', ACAO_ESTOQUE, true);
      const grupoId = await criarGrupoAcesso(contexto.pool, empresaId, 'Grupo Restringe 17e', masterId, true);
      await definirPermissaoAcaoGrupo(contexto.pool, empresaId, grupoId, ACAO_ESTOQUE, false);
      await atribuirGrupo(contexto.pool, masterId, grupoId);

      const cookie = await loginEObterCookie(cnpj, emailMaster);
      const resposta = await request(app).get('/teste/acao-estoque').set('Cookie', cookie);

      assert.equal(resposta.status, 200, 'MASTER usa só a permissão empresarial de perfil, sem restrição de grupo');
    });

    test('isolamento entre empresas: grupo da empresa A não afeta a sessão da empresa B, mesmo com o mesmo perfil e recurso', async () => {
      const cnpjA = '91700006000106';
      const cnpjB = '91700007000107';
      const emailConcessorA = 'concessor-cenario17f-a@demo.safeworkengenharia.com.br';
      const emailConcessorB = 'concessor-cenario17f-b@demo.safeworkengenharia.com.br';
      const emailUsuarioA = 'usuario-cenario17f-a@demo.safeworkengenharia.com.br';
      const emailUsuarioB = 'usuario-cenario17f-b@demo.safeworkengenharia.com.br';

      const { empresaId: empresaA, usuarioId: concessorA } = await prepararIdentidade(cnpjA, emailConcessorA, 'MASTER');
      const { empresaId: empresaB } = await prepararIdentidade(cnpjB, emailConcessorB, 'MASTER');
      const usuarioA = await inserirUsuario(contexto.pool, empresaA, emailUsuarioA, 'Usuário 17f A', HASH_SENHA_CORRETA, { perfil: 'ADMINISTRADOR' });
      const usuarioB = await inserirUsuario(contexto.pool, empresaB, emailUsuarioB, 'Usuário 17f B', HASH_SENHA_CORRETA, { perfil: 'ADMINISTRADOR' });

      await definirPermissaoRecurso(contexto.pool, empresaA, 'ADMINISTRADOR', RECURSO, { podeVisualizar: false });
      await definirPermissaoRecurso(contexto.pool, empresaB, 'ADMINISTRADOR', RECURSO, { podeVisualizar: false });
      const grupoA = await criarGrupoAcesso(contexto.pool, empresaA, 'Grupo Concede 17f', concessorA, true);
      await definirPermissaoRecursoGrupo(contexto.pool, empresaA, grupoA, RECURSO, { podeVisualizar: true });
      await atribuirGrupo(contexto.pool, usuarioA, grupoA);
      // usuarioB permanece sem grupo.

      const cookieA = await loginEObterCookie(cnpjA, emailUsuarioA);
      const cookieB = await loginEObterCookie(cnpjB, emailUsuarioB);

      const respostaA = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookieA);
      const respostaB = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookieB);

      assert.equal(respostaA.status, 200, 'o grupo da empresa A concedeu o recurso');
      assert.equal(respostaB.status, 403, 'a empresa B não tem grupo e o perfil nega — o grupo de A não pode ter vazado');
    });

    test('um grupo chamado "SST" não concede vinculo_sst: APROVAR_SOLICITACAO (modo OBRIGATORIA) continua exigindo SST real', async () => {
      const cnpj = '91700008000108';
      const emailConcessor = 'concessor-cenario17g@demo.safeworkengenharia.com.br';
      const emailUsuario = 'usuario-cenario17g@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      const usuarioId = await inserirUsuario(contexto.pool, empresaId, emailUsuario, 'Usuário 17g', HASH_SENHA_CORRETA, { perfil: 'SUPERVISOR' });

      // Grupo literalmente chamado "SST", com permissão de ação concedida —
      // mas modo OBRIGATORIA nunca consulta grupo, então isso não deveria
      // ter nenhum efeito.
      const grupoSstId = await criarGrupoAcesso(contexto.pool, empresaId, 'SST', concessorId, true);
      await definirPermissaoAcaoGrupo(contexto.pool, empresaId, grupoSstId, ACAO_APROVAR, true);
      await atribuirGrupo(contexto.pool, usuarioId, grupoSstId);
      await definirAutorizacaoIndividual(contexto.pool, empresaId, usuarioId, ACAO_APROVAR, concessorId, true);

      const cookie = await loginEObterCookie(cnpj, emailUsuario);

      const semSst = await request(app).get('/teste/acao-aprovar').set('Cookie', cookie);
      assert.equal(semSst.status, 403, 'pertencer a um grupo chamado SST não é o mesmo que ter vinculo_sst — continua negado sem SST real');

      await definirSst(contexto.pool, empresaId, usuarioId, concessorId, true);
      const comSst = await request(app).get('/teste/acao-aprovar').set('Cookie', cookie);
      assert.equal(comSst.status, 200, 'com vinculo_sst real e autorização individual, agora autoriza — o grupo nunca participou dessa decisão');

      const { rows } = await contexto.pool.query(
        'SELECT g.nome FROM grupos_acesso g JOIN usuarios u ON u.grupo_acesso_id = g.id WHERE u.id = $1',
        [usuarioId],
      );
      assert.equal(rows[0].nome, 'SST', 'confirma que o grupo realmente se chama SST, para que o teste tenha valor');
    });
  });

  describe('Cenário 18 — exceção individual de recurso (Subetapa 3G), com PostgreSQL real', () => {
    test('exceção individual concede um recurso que o perfil E o grupo negam', async () => {
      const cnpj = '91800001000101';
      const emailConcessor = 'concessor-cenario18a@demo.safeworkengenharia.com.br';
      const emailUsuario = 'usuario-cenario18a@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      const usuarioId = await inserirUsuario(contexto.pool, empresaId, emailUsuario, 'Usuário 18a', HASH_SENHA_CORRETA, { perfil: 'ADMINISTRADOR' });

      await definirPermissaoRecurso(contexto.pool, empresaId, 'ADMINISTRADOR', RECURSO, { podeVisualizar: false });
      const grupoId = await criarGrupoAcesso(contexto.pool, empresaId, 'Grupo Nega 18a', concessorId, true);
      await definirPermissaoRecursoGrupo(contexto.pool, empresaId, grupoId, RECURSO, { podeVisualizar: false });
      await atribuirGrupo(contexto.pool, usuarioId, grupoId);
      await definirPermissaoRecursoIndividual(contexto.pool, empresaId, usuarioId, RECURSO, { podeVisualizar: true }, concessorId);

      const cookie = await loginEObterCookie(cnpj, emailUsuario);
      const resposta = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);

      assert.equal(resposta.status, 200, 'a exceção individual concedeu, mesmo com perfil e grupo negando');
    });

    test('exceção individual nega um recurso que o perfil E o grupo concedem', async () => {
      const cnpj = '91800002000102';
      const emailConcessor = 'concessor-cenario18b@demo.safeworkengenharia.com.br';
      const emailUsuario = 'usuario-cenario18b@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      const usuarioId = await inserirUsuario(contexto.pool, empresaId, emailUsuario, 'Usuário 18b', HASH_SENHA_CORRETA, { perfil: 'ADMINISTRADOR' });

      await definirPermissaoRecurso(contexto.pool, empresaId, 'ADMINISTRADOR', RECURSO, { podeVisualizar: true });
      const grupoId = await criarGrupoAcesso(contexto.pool, empresaId, 'Grupo Concede 18b', concessorId, true);
      await definirPermissaoRecursoGrupo(contexto.pool, empresaId, grupoId, RECURSO, { podeVisualizar: true });
      await atribuirGrupo(contexto.pool, usuarioId, grupoId);
      await definirPermissaoRecursoIndividual(contexto.pool, empresaId, usuarioId, RECURSO, { podeVisualizar: false }, concessorId);

      const cookie = await loginEObterCookie(cnpj, emailUsuario);
      const resposta = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);

      assert.equal(resposta.status, 403, 'a exceção individual negou, mesmo com perfil e grupo concedendo');
      assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    });

    test('exceção individual NULL herda o resultado do grupo, sem nenhuma opinião própria', async () => {
      const cnpj = '91800003000103';
      const emailConcessor = 'concessor-cenario18c@demo.safeworkengenharia.com.br';
      const emailUsuario = 'usuario-cenario18c@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      const usuarioId = await inserirUsuario(contexto.pool, empresaId, emailUsuario, 'Usuário 18c', HASH_SENHA_CORRETA, { perfil: 'ADMINISTRADOR' });

      await definirPermissaoRecurso(contexto.pool, empresaId, 'ADMINISTRADOR', RECURSO, { podeVisualizar: false });
      const grupoId = await criarGrupoAcesso(contexto.pool, empresaId, 'Grupo Concede 18c', concessorId, true);
      await definirPermissaoRecursoGrupo(contexto.pool, empresaId, grupoId, RECURSO, { podeVisualizar: true });
      await atribuirGrupo(contexto.pool, usuarioId, grupoId);
      // Linha individual existe, mas com todas as operações NULL — sem
      // opinião nenhuma; o resultado do grupo (concedeu) deve prevalecer.
      await definirPermissaoRecursoIndividual(contexto.pool, empresaId, usuarioId, RECURSO, {}, concessorId);

      const cookie = await loginEObterCookie(cnpj, emailUsuario);
      const resposta = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);

      assert.equal(resposta.status, 200, 'exceção individual sem opinião preserva o resultado do grupo');
    });

    test('MASTER não é restringido por exceção individual, mesmo com uma que negaria o recurso', async () => {
      const cnpj = '91800004000104';
      const emailMaster = 'master-cenario18d@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: masterId } = await prepararIdentidade(cnpj, emailMaster, 'MASTER');

      await definirPermissaoRecurso(contexto.pool, empresaId, 'MASTER', RECURSO, { podeVisualizar: true });
      await definirPermissaoRecursoIndividual(contexto.pool, empresaId, masterId, RECURSO, { podeVisualizar: false }, masterId);

      const cookie = await loginEObterCookie(cnpj, emailMaster);
      const resposta = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookie);

      assert.equal(resposta.status, 200, 'MASTER usa só a permissão empresarial de perfil, sem restrição individual');
    });

    test('isolamento entre empresas: exceção individual de um usuário de A não afeta a sessão de um usuário de B', async () => {
      const cnpjA = '91800005000105';
      const cnpjB = '91800006000106';
      const emailConcessorA = 'concessor-cenario18e-a@demo.safeworkengenharia.com.br';
      const emailConcessorB = 'concessor-cenario18e-b@demo.safeworkengenharia.com.br';
      const emailUsuarioA = 'usuario-cenario18e-a@demo.safeworkengenharia.com.br';
      const emailUsuarioB = 'usuario-cenario18e-b@demo.safeworkengenharia.com.br';

      const { empresaId: empresaA, usuarioId: concessorA } = await prepararIdentidade(cnpjA, emailConcessorA, 'MASTER');
      const { empresaId: empresaB } = await prepararIdentidade(cnpjB, emailConcessorB, 'MASTER');
      const usuarioA = await inserirUsuario(contexto.pool, empresaA, emailUsuarioA, 'Usuário 18e A', HASH_SENHA_CORRETA, { perfil: 'ADMINISTRADOR' });
      const usuarioB = await inserirUsuario(contexto.pool, empresaB, emailUsuarioB, 'Usuário 18e B', HASH_SENHA_CORRETA, { perfil: 'ADMINISTRADOR' });

      await definirPermissaoRecurso(contexto.pool, empresaA, 'ADMINISTRADOR', RECURSO, { podeVisualizar: false });
      await definirPermissaoRecurso(contexto.pool, empresaB, 'ADMINISTRADOR', RECURSO, { podeVisualizar: false });
      await definirPermissaoRecursoIndividual(contexto.pool, empresaA, usuarioA, RECURSO, { podeVisualizar: true }, concessorA);
      // usuarioB não recebe nenhuma exceção individual.

      const cookieA = await loginEObterCookie(cnpjA, emailUsuarioA);
      const cookieB = await loginEObterCookie(cnpjB, emailUsuarioB);

      const respostaA = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookieA);
      const respostaB = await request(app).get('/teste/recurso-visualizar').set('Cookie', cookieB);

      assert.equal(respostaA.status, 200, 'a exceção individual de A concedeu o recurso');
      assert.equal(respostaB.status, 403, 'usuário de B não tem exceção e o perfil nega — a exceção de A não pode ter vazado');
    });

    test('sem regressão: exceção de RECURSO não interfere na autorização por AÇÃO (SST e bloqueio individual continuam intactos)', async () => {
      const cnpj = '91800007000107';
      const emailConcessor = 'concessor-cenario18f@demo.safeworkengenharia.com.br';
      const emailUsuario = 'usuario-cenario18f@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId: concessorId } = await prepararIdentidade(cnpj, emailConcessor, 'MASTER');
      const usuarioId = await inserirUsuario(contexto.pool, empresaId, emailUsuario, 'Usuário 18f', HASH_SENHA_CORRETA, { perfil: 'SUPERVISOR' });

      // Exceção de RECURSO concedendo amplamente — não pode, de jeito
      // nenhum, ter efeito sobre APROVAR_SOLICITACAO (ação de negócio).
      await definirPermissaoRecursoIndividual(contexto.pool, empresaId, usuarioId, RECURSO, {
        podeVisualizar: true, podeCriar: true, podeEditar: true, podeExcluir: true,
      }, concessorId);

      const cookie = await loginEObterCookie(cnpj, emailUsuario);

      const semSstNemIndividual = await request(app).get('/teste/acao-aprovar').set('Cookie', cookie);
      assert.equal(semSstNemIndividual.status, 403, 'exceção de recurso não pode substituir SST nem autorização individual de ação');

      await definirSst(contexto.pool, empresaId, usuarioId, concessorId, true);
      await definirAutorizacaoIndividual(contexto.pool, empresaId, usuarioId, ACAO_APROVAR, concessorId, true);
      const comAsDuas = await request(app).get('/teste/acao-aprovar').set('Cookie', cookie);
      assert.equal(comAsDuas.status, 200, 'com SST e autorização individual de AÇÃO reais, agora autoriza — a exceção de recurso nunca participou');

      await definirBloqueio(contexto.pool, usuarioId, ACAO_APROVAR, true);
      const comBloqueio = await request(app).get('/teste/acao-aprovar').set('Cookie', cookie);
      assert.equal(comBloqueio.status, 403, 'bloqueio individual de ação continua prevalecendo, mesmo com a exceção de recurso concedendo tudo');
    });
  });

  /**
   * Verificação complementar, não um cenário de RBAC: confirma que a
   * conexão usada por TODO este arquivo está estruturalmente impedida de
   * alcançar o schema public, e não apenas que "nenhum teste apontou pra
   * lá por engano". current_schemas(false) devolve só os schemas
   * explicitamente listados no search_path da sessão (ao contrário de
   * current_schemas(true), que incluiria schemas implícitos como
   * pg_catalog) — se essa lista for exatamente [schema temporário], sem
   * 'public', então qualquer nome de tabela não qualificado usado pelos
   * testes (empresas, usuarios, permissoes_recurso, ...) SÓ pode resolver
   * dentro do schema temporário: se a tabela não existisse lá, a consulta
   * falharia com "relation does not exist", nunca cairia silenciosamente
   * em public. Isso, somado à ausência de qualquer "public." no texto das
   * consultas deste arquivo (nenhuma existe) e ao uso exclusivo de
   * contexto.pool/contexto.pool.connect() (nunca outro Client/Pool), é a
   * prova de que este arquivo não lê nem escreve em public — não a
   * contagem de tabelas de um banco compartilhado, que não prova isolamento
   * nenhum.
   */
  describe('Verificação complementar — isolamento do schema temporário', () => {
    test('o pool de teste tem search_path restrito ao schema temporário, sem incluir public', async () => {
      // ::text[] explícito: o tipo de retorno nativo de current_schemas é
      // name[], que o driver pg não converte para array JS (fica como a
      // string literal do array do PostgreSQL); text[] já tem parser
      // registrado no driver.
      const { rows } = await contexto.pool.query('SELECT current_schemas(false)::text[] AS schemas');

      assert.deepEqual(rows[0].schemas, [contexto.schema], 'o search_path desta conexão deve conter exclusivamente o schema temporário');
      assert.equal(rows[0].schemas.includes('public'), false, 'public não pode fazer parte do caminho de resolução de nomes desta conexão');
    });
  });
});
