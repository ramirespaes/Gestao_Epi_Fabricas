'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * Integração HTTP completa: HTTP -> rota -> validação Zod -> controller ->
 * login.service.js -> repositories -> PostgreSQL real, em schema temporário
 * removido em cascata ao final. O schema public não é lido nem escrito.
 *
 * A rota é montada com a MESMA fábrica de produção (criarAuthRoutes,
 * criarAuthController) — não uma reimplementação paralela para teste — só
 * com pool e limitador exclusivos deste arquivo.
 *
 * DIFERENÇA IMPORTANTE EM RELAÇÃO AO APP REAL: criarAppTeste monta apenas
 * express.json/parserJson + as rotas dadas + os handlers reais de 404/erro.
 * Ele NÃO reproduz cabecalhosSeguranca, corsApi, verificarOrigem nem
 * limitadorGeral — essas camadas já são exaustivamente testadas contra o
 * app real em test/app.test.js (Etapa 3), inclusive com um teste que confirma
 * que POST /api/auth/login está de fato montada ali. Este arquivo não repete
 * nem substitui aquela verificação: seu único objetivo é provar que a cadeia
 * rota -> controller -> serviço -> repositórios funciona de ponta a ponta
 * contra PostgreSQL de verdade.
 *
 * Nenhum mock: login.service.js e os quatro repositórios rodam de verdade.
 * A bateria matemática de níveis de cooldown já tem sua cobertura completa
 * no Incremento 5 — aqui só se confirma que o mecanismo já existente é
 * corretamente acionado quando chega por uma requisição HTTP real.
 */

const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const SENHA_CORRETA = 'senha-correta-do-teste-http-2026';
const SENHA_ERRADA = 'senha-errada-qualquer';

let HASH_SENHA_CORRETA;

const inserirUsuario = async (cliente, empresaId, email, nome, hash, extra = {}) => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [empresaId, nome, email, hash, extra.perfil ?? 'ADMINISTRADOR', extra.ativo ?? true],
  );
  return rows[0].id;
};

const daquiAMinutos = (minutos) => new Date(Date.now() + minutos * 60_000);

/** Extrai "nome=valor" do único Set-Cookie de uma resposta. */
function extrairCookie(resposta) {
  const cookies = resposta.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 1, 'esperado exatamente um Set-Cookie');
  return cookies[0].split(';')[0];
}

describe('POST /api/auth/login com PostgreSQL real', () => {
  let contexto;
  let app;
  let empresaA;
  let empresaB;
  let usuarioA;

  before(async () => {
    HASH_SENHA_CORRETA = await gerarHashSenha(SENHA_CORRETA);

    contexto = await abrirPoolTemporario(['000', '001', '002', '005', '025', '013', '015']);

    const controller = criarAuthController({ pool: contexto.pool });
    // MESMO pool temporário do controller — não o pool global, e nenhuma
    // substituição feita depois de importar os módulos: tudo construído
    // explicitamente aqui, uma única vez.
    const exigirSessaoTeste = criarExigirSessao({ pool: contexto.pool });
    // Limite generoso, exclusivo deste arquivo: não pode interferir na
    // validação do cooldown persistente do serviço (Teste 4), que é o
    // mecanismo real sob teste. Mesmo padrão de isolamento por
    // criarLimitador() já usado em test/middleware/rate-limit.test.js.
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const routes = criarAuthRoutes({ controller, limitador, exigirSessao: exigirSessaoTeste });
    app = criarAppTeste((a) => a.use('/api', routes));

    const cliente = await contexto.pool.connect();
    try {
      assert.equal(await inserirEmpresa(cliente, CNPJ_A, 'Empresa A'), 'ok');
      assert.equal(await inserirEmpresa(cliente, CNPJ_B, 'Empresa B'), 'ok');

      const { rows: empresas } = await cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
      empresaA = empresas.find((e) => e.cnpj === CNPJ_A).id;
      empresaB = empresas.find((e) => e.cnpj === CNPJ_B).id;

      usuarioA = await inserirUsuario(
        cliente, empresaA, 'ana.souza@demo.safeworkengenharia.com.br', 'Ana da Empresa A', HASH_SENHA_CORRETA,
      );
    } finally {
      cliente.release();
    }
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('Teste 1 — login válido de ponta a ponta: HTTP -> serviço -> PostgreSQL', async () => {
    const resposta = await request(app)
      .post('/api/auth/login')
      .send({ cnpj: CNPJ_A, email: 'ana.souza@demo.safeworkengenharia.com.br', senha: SENHA_CORRETA });

    assert.equal(resposta.status, 200);
    assert.deepEqual(Object.keys(resposta.body).sort(), ['empresa', 'status', 'usuario']);
    assert.equal(resposta.body.status, 'ok');
    assert.equal(resposta.body.usuario.id, usuarioA);
    assert.equal(resposta.body.empresa.id, empresaA);
    assert.equal(resposta.body.empresa.cnpj, CNPJ_A);

    const cookies = resposta.headers['set-cookie'];
    assert.ok(Array.isArray(cookies) && cookies.length === 1);
    const token = cookies[0].split(';')[0].split('=')[1];
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(resposta.body).includes(token), false, 'o token não pode aparecer no corpo JSON');

    const { rows: sessoes } = await contexto.pool.query(
      'SELECT empresa_id, usuario_id, token_hash, criado_em, expira_em FROM sessoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1',
      [usuarioA],
    );
    assert.equal(sessoes.length, 1, 'a sessão precisa ter sido realmente persistida');
    const sessao = sessoes[0];
    assert.equal(sessao.empresa_id, empresaA);

    const hashEsperado = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    assert.equal(sessao.token_hash, hashEsperado, 'token_hash deve ser exatamente o SHA-256 hexadecimal do token recebido');
    assert.equal(JSON.stringify(sessao).includes(token), false, 'o token em claro não pode estar em nenhuma coluna persistida');

    const duracaoMinutos = (sessao.expira_em.getTime() - sessao.criado_em.getTime()) / 60_000;
    assert.ok(
      Math.abs(duracaoMinutos - authConfig.sessao.expiracaoMinutos) < 0.05,
      `validade da sessão deveria ser ${authConfig.sessao.expiracaoMinutos} min, obtido ${duracaoMinutos}`,
    );

    const { rows: tentativas } = await contexto.pool.query(
      'SELECT sucesso, motivo FROM login_tentativas WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1', [usuarioA],
    );
    assert.equal(tentativas[0].sucesso, true);
    assert.equal(tentativas[0].motivo, null);
  });

  test('Teste 2 — isolamento multiempresa via HTTP', async () => {
    const emailCompartilhado = 'mesmo.email@demo.safeworkengenharia.com.br';
    const cliente = await contexto.pool.connect();
    try {
      await inserirUsuario(cliente, empresaA, emailCompartilhado, 'Fulano da A', HASH_SENHA_CORRETA);
      await inserirUsuario(cliente, empresaB, emailCompartilhado, 'Fulano da B', await gerarHashSenha('outra-senha-da-empresa-b'));
    } finally {
      cliente.release();
    }

    // A credencial válida na empresa A não pode autenticar sob o CNPJ da B.
    const respostaErrada = await request(app)
      .post('/api/auth/login')
      .send({ cnpj: CNPJ_B, email: emailCompartilhado, senha: SENHA_CORRETA });
    assert.equal(respostaErrada.status, 401);
    assert.equal(respostaErrada.body.codigo, 'CREDENCIAIS_INVALIDAS');

    // A mesma credencial autentica normalmente sob o CNPJ correto.
    const respostaCerta = await request(app)
      .post('/api/auth/login')
      .send({ cnpj: CNPJ_A, email: emailCompartilhado, senha: SENHA_CORRETA });
    assert.equal(respostaCerta.status, 200);
    assert.equal(respostaCerta.body.empresa.id, empresaA);

    // "mesmo.email@..." também existe na empresa B (usuário diferente, senha
    // diferente): a busca por CNPJ_B encontra ESSE usuário, não "ausente" —
    // a senha de "Fulano da A" está simplesmente errada para ele. Prova mais
    // forte de isolamento do que EMAIL_INEXISTENTE seria aqui: o mesmo
    // endereço de e-mail resolve para identidades totalmente independentes
    // conforme a empresa, nunca "a mesma pessoa" entre contratantes.
    const { rows } = await contexto.pool.query(
      "SELECT motivo FROM login_tentativas WHERE motivo = 'SENHA_INVALIDA' AND empresa_id = $1 ORDER BY id DESC LIMIT 1", [empresaB],
    );
    assert.equal(rows.length, 1, 'a tentativa contra a empresa B deve ter sido registrada como senha inválida para o usuário DELA, não como sucesso');

    // empresaId/usuarioId no corpo: recusados antes de qualquer lógica.
    const respostaComIdExtra = await request(app)
      .post('/api/auth/login')
      .send({ cnpj: CNPJ_A, email: emailCompartilhado, senha: SENHA_CORRETA, empresaId: empresaB, usuarioId: 999 });
    assert.equal(respostaComIdExtra.status, 400);
  });

  test('Teste 3 — credenciais inválidas: 401 genérico, sem sessão, tentativa negada persistida', async () => {
    const { rows: antes } = await contexto.pool.query('SELECT count(*)::int AS total FROM sessoes WHERE usuario_id = $1', [usuarioA]);

    const resposta = await request(app)
      .post('/api/auth/login')
      .send({ cnpj: CNPJ_A, email: 'ana.souza@demo.safeworkengenharia.com.br', senha: SENHA_ERRADA });

    assert.equal(resposta.status, 401);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'CNPJ, e-mail ou senha inválidos' });
    assert.equal(resposta.headers['set-cookie'], undefined);

    const { rows: depois } = await contexto.pool.query('SELECT count(*)::int AS total FROM sessoes WHERE usuario_id = $1', [usuarioA]);
    assert.equal(depois[0].total, antes[0].total, 'nenhuma sessão nova pode ter sido criada');

    const { rows: tentativa } = await contexto.pool.query(
      'SELECT motivo FROM login_tentativas WHERE usuario_id = $1 AND NOT sucesso ORDER BY id DESC LIMIT 1', [usuarioA],
    );
    assert.equal(tentativa[0].motivo, 'SENHA_INVALIDA');
  });

  test('Teste 4 — cooldown persistente acionado por requisições HTTP reais', async () => {
    const cliente = await contexto.pool.connect();
    const cnpjTemp = '11222333000181';
    const email = 'usuario.cooldown-http@demo.safeworkengenharia.com.br';
    try {
      await inserirEmpresa(cliente, cnpjTemp, 'Empresa Cooldown HTTP');
      const { rows } = await cliente.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpjTemp]);
      await inserirUsuario(cliente, rows[0].id, email, 'Usuário Cooldown HTTP', HASH_SENHA_CORRETA);
    } finally {
      cliente.release();
    }

    const limiar = authConfig.cooldown.niveis[0].falhas;
    for (let i = 0; i < limiar - 1; i += 1) {
      const r = await request(app).post('/api/auth/login').send({ cnpj: cnpjTemp, email, senha: SENHA_ERRADA });
      assert.equal(r.status, 401);
    }

    // A tentativa que cruza o limiar ainda recebe o 401 genérico — contrato
    // já decidido e testado no Incremento 5; aqui só confirmamos que a
    // requisição HTTP não muda esse comportamento.
    const cruzando = await request(app).post('/api/auth/login').send({ cnpj: cnpjTemp, email, senha: SENHA_ERRADA });
    assert.equal(cruzando.status, 401);
    assert.equal(cruzando.body.codigo, 'CREDENCIAIS_INVALIDAS');

    const { rows: contagemAntes } = await contexto.pool.query(
      'SELECT count(*)::int AS total FROM login_tentativas WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1)', [email],
    );

    const bloqueada = await request(app).post('/api/auth/login').send({ cnpj: cnpjTemp, email, senha: SENHA_CORRETA });
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.body.codigo, 'LOGIN_EM_COOLDOWN');
    assert.ok(Number(bloqueada.headers['retry-after']) > 0);
    assert.equal(bloqueada.headers['set-cookie'], undefined);

    const { rows: contagemDepois } = await contexto.pool.query(
      'SELECT count(*)::int AS total FROM login_tentativas WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1)', [email],
    );
    assert.equal(contagemDepois[0].total, contagemAntes[0].total, 'requisição durante o cooldown não pode gerar nova linha de tentativa');

    const { rows: sessoesUsuario } = await contexto.pool.query(
      'SELECT count(*)::int AS total FROM sessoes WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1)', [email],
    );
    assert.equal(sessoesUsuario[0].total, 0, 'nenhuma sessão pode ter sido criada durante o bloqueio, mesmo com a senha correta');
  });

  describe('Ciclo completo login -> /me -> logout -> /me, com PostgreSQL real (Incremento 7)', () => {
    /** Cria empresa e usuário ativos, isolados por CNPJ próprio de cada cenário. */
    async function prepararIdentidade(cnpj, email) {
      const cliente = await contexto.pool.connect();
      try {
        assert.equal(await inserirEmpresa(cliente, cnpj, `Empresa ${cnpj}`), 'ok');
        const { rows } = await cliente.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpj]);
        const usuarioId = await inserirUsuario(cliente, rows[0].id, email, `Usuário ${email}`, HASH_SENHA_CORRETA);
        return { empresaId: rows[0].id, usuarioId };
      } finally {
        cliente.release();
      }
    }

    test('cenário 1 — login, /me com o cookie recebido: dados corretos, sem token, hash bate no PostgreSQL', async () => {
      const cnpj = '90000001000101';
      const email = 'cenario1@demo.safeworkengenharia.com.br';
      const { empresaId, usuarioId } = await prepararIdentidade(cnpj, email);

      const login = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA_CORRETA });
      assert.equal(login.status, 200);
      assert.match(login.headers['set-cookie'][0], /HttpOnly/i);
      const cookie = extrairCookie(login);
      const token = cookie.split('=')[1];

      const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
      assert.equal(me.status, 200);
      assert.deepEqual(Object.keys(me.body).sort(), ['empresa', 'status', 'usuario']);
      assert.equal(me.body.usuario.id, usuarioId);
      assert.equal(me.body.empresa.id, empresaId);
      assert.equal('token' in me.body, false);
      assert.equal(JSON.stringify(me.body).includes('token_hash'), false);
      assert.equal(JSON.stringify(me.body).includes(token), false, 'token em claro não pode aparecer no corpo de /me');

      const hashEsperado = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
      const { rows } = await contexto.pool.query(
        'SELECT token_hash FROM sessoes WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1', [usuarioId],
      );
      assert.equal(rows[0].token_hash, hashEsperado, 'a sessão localizada deve corresponder ao SHA-256 do token recebido no login');
    });

    test('cenário 2 — /me sem cookie: 401 SESSAO_INVALIDA, nenhuma identidade devolvida', async () => {
      const resposta = await request(app).get('/api/auth/me');

      assert.equal(resposta.status, 401);
      assert.deepEqual(resposta.body, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'Sessão inválida ou expirada' });
      assert.equal('usuario' in resposta.body, false);
      assert.equal('empresa' in resposta.body, false);
    });

    test('cenário 3 — /me atualiza ultimo_uso_em no PostgreSQL (preparação determinística, sem depender de milissegundos)', async () => {
      const cnpj = '90000003000103';
      const email = 'cenario3@demo.safeworkengenharia.com.br';
      await prepararIdentidade(cnpj, email);

      const login = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA_CORRETA });
      const cookie = extrairCookie(login);
      const tokenHash = crypto.createHash('sha256').update(cookie.split('=')[1], 'utf8').digest('hex');

      // Empurra ultimo_uso_em 10 minutos para o passado (ainda dentro da
      // janela de inatividade) — uma diferença grande e conhecida, para que
      // "avançou" não dependa de milissegundos de execução do teste.
      const antigo = daquiAMinutos(-10);
      await contexto.pool.query('UPDATE sessoes SET ultimo_uso_em = $1 WHERE token_hash = $2', [antigo, tokenHash]);

      const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
      assert.equal(me.status, 200);

      const { rows } = await contexto.pool.query('SELECT ultimo_uso_em FROM sessoes WHERE token_hash = $1', [tokenHash]);
      assert.ok(
        rows[0].ultimo_uso_em.getTime() > antigo.getTime() + 9 * 60_000,
        'ultimo_uso_em deveria ter avançado bem além do valor antigo preparado (folga de 9 min elimina qualquer instabilidade de relógio)',
      );
    });

    test('cenário 4 — sessão fora da janela de inatividade: 401, não revive, ultimo_uso_em não é renovado', async () => {
      const cnpj = '90000004000104';
      const email = 'cenario4@demo.safeworkengenharia.com.br';
      await prepararIdentidade(cnpj, email);

      const login = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA_CORRETA });
      const cookie = extrairCookie(login);
      const tokenHash = crypto.createHash('sha256').update(cookie.split('=')[1], 'utf8').digest('hex');

      const foraDaJanela = daquiAMinutos(-(authConfig.sessao.inatividadeMinutos + 5));
      await contexto.pool.query('UPDATE sessoes SET ultimo_uso_em = $1 WHERE token_hash = $2', [foraDaJanela, tokenHash]);

      const primeira = await request(app).get('/api/auth/me').set('Cookie', cookie);
      assert.equal(primeira.status, 401);
      assert.equal(primeira.body.codigo, 'SESSAO_INVALIDA');

      const { rows } = await contexto.pool.query('SELECT ultimo_uso_em FROM sessoes WHERE token_hash = $1', [tokenHash]);
      assert.deepEqual(rows[0].ultimo_uso_em, foraDaJanela, 'ultimo_uso_em não pode ter sido renovado numa sessão vencida por inatividade');

      const segunda = await request(app).get('/api/auth/me').set('Cookie', cookie);
      assert.equal(segunda.status, 401, 'a sessão não pode voltar a ficar válida numa segunda tentativa');
    });

    test('cenário 5 — logout real: revoga no PostgreSQL, cookie antigo deixa de servir para /me', async () => {
      const cnpj = '90000005000105';
      const email = 'cenario5@demo.safeworkengenharia.com.br';
      await prepararIdentidade(cnpj, email);

      const login = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA_CORRETA });
      const cookie = extrairCookie(login);
      const tokenHash = crypto.createHash('sha256').update(cookie.split('=')[1], 'utf8').digest('hex');

      const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
      assert.equal(logout.status, 200);
      assert.deepEqual(logout.body, { status: 'ok' });
      assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);

      const { rows } = await contexto.pool.query(
        'SELECT revogada_em, motivo_revogacao FROM sessoes WHERE token_hash = $1', [tokenHash],
      );
      assert.notEqual(rows[0].revogada_em, null, 'revogada_em deve estar preenchida após o logout');
      assert.equal(rows[0].motivo_revogacao, 'LOGOUT');

      const meDepois = await request(app).get('/api/auth/me').set('Cookie', cookie);
      assert.equal(meDepois.status, 401);
      assert.equal(meDepois.body.codigo, 'SESSAO_INVALIDA');
    });

    test('cenário 6 — logout chamado duas vezes com o mesmo cookie: ambas 200, revogação persistida uma única vez', async () => {
      const cnpj = '90000006000106';
      const email = 'cenario6@demo.safeworkengenharia.com.br';
      const { usuarioId } = await prepararIdentidade(cnpj, email);

      const login = await request(app).post('/api/auth/login').send({ cnpj, email, senha: SENHA_CORRETA });
      const cookie = extrairCookie(login);

      const primeira = await request(app).post('/api/auth/logout').set('Cookie', cookie);
      const segunda = await request(app).post('/api/auth/logout').set('Cookie', cookie);

      assert.equal(primeira.status, 200);
      assert.equal(segunda.status, 200);

      const { rows } = await contexto.pool.query(
        'SELECT count(*)::int AS total FROM sessoes WHERE usuario_id = $1 AND revogada_em IS NOT NULL', [usuarioId],
      );
      assert.equal(rows[0].total, 1, 'só existe uma sessão para este usuário, e ela deve estar revogada uma única vez — nenhuma sessão adicional foi afetada');
    });

    test('cenário 7 — isolamento multiempresa: revogar a sessão de A não afeta a de B; IDs no corpo são ignorados', async () => {
      const cnpjA = '90000007000107';
      const emailA = 'cenario7a@demo.safeworkengenharia.com.br';
      const cnpjB = '90000007000108';
      const emailB = 'cenario7b@demo.safeworkengenharia.com.br';
      const { empresaId: empresaIdB } = await prepararIdentidade(cnpjB, emailB);
      await prepararIdentidade(cnpjA, emailA);

      const loginA = await request(app).post('/api/auth/login').send({ cnpj: cnpjA, email: emailA, senha: SENHA_CORRETA });
      const loginB = await request(app).post('/api/auth/login').send({ cnpj: cnpjB, email: emailB, senha: SENHA_CORRETA });
      const cookieA = extrairCookie(loginA);
      const cookieB = extrairCookie(loginB);

      // /logout não tem corpo algum na sua definição de rota (sem
      // validar()) — ainda assim, mesmo enviando campos arbitrários, o
      // único vetor de identidade é o cookie: não há como o corpo indicar
      // "revogue a sessão de outra empresa".
      const logoutA = await request(app).post('/api/auth/logout').set('Cookie', cookieA).send({ empresaId: empresaIdB, sessaoId: 999999 });
      assert.equal(logoutA.status, 200);

      const meA = await request(app).get('/api/auth/me').set('Cookie', cookieA);
      assert.equal(meA.status, 401, 'a sessão de A foi corretamente revogada');

      const meB = await request(app).get('/api/auth/me').set('Cookie', cookieB);
      assert.equal(meB.status, 200, 'a sessão de B não pode ter sido afetada pelo logout de A, mesmo com empresaId de B enviado no corpo');
      assert.equal(meB.body.empresa.id, empresaIdB);
      assert.equal(meB.body.empresa.cnpj, cnpjB);
    });
  });
});
