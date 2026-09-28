'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarSessaoAdministrativa } = require('./helpers/sessao-plataforma-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarAuthPlataformaController } = require('../../src/controllers/auth-plataforma.controller');
const { criarAuthPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const { criarPainelPlataformaRoutes } = require('../../src/routes/painel-plataforma.routes');
const { painelPlataformaController } = require('../../src/controllers/painel-plataforma.controller');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarExigirDesafioMfa } = require('../../src/middleware/desafio-mfa-plataforma');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarInicial } = require('../../src/services/administrador-plataforma.service');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const { cifrarSegredoTotp } = require('../../src/security/mfa-cripto');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * Integração HTTP completa do Painel Privado da plataforma: HTTP -> rota ->
 * validação Zod -> controller -> serviços -> repositórios -> PostgreSQL
 * real, em schema temporário removido em cascata ao final (contrato da
 * seção 11 do CLAUDE.md). O schema public nunca é lido nem escrito.
 *
 * Senha correta NÃO cria sessão: abre um desafio pré-MFA (LIBERACAO sem
 * TOTP ativo, VERIFICACAO com TOTP ativo) e emite só o cookie do desafio. O
 * desafio não autentica /auth/me nem rota administrativa; só
 * /auth/mfa/estado o aceita. Sessões plenas já existentes (criadas aqui
 * pelo repositório) continuam valendo como antes.
 *
 * Monta, no MESMO app de teste, as rotas do cliente (/api/auth/*) e as da
 * plataforma (/api/plataforma/*), para provar que o cookie de um contexto
 * nunca autentica o outro. CORS/Origin/Host da plataforma têm cobertura
 * própria em test/app.test.js.
 */

const CNPJ_CLIENTE = '12345678000195';
const SENHA_CORRETA = 'senha-correta-do-teste-http-2026';
// Não pode conter termos triviais nem o e-mail do administrador
// (validarPoliticaSenha real roda em criarInicial, sem atalho de teste).
const SENHA_ADMIN = 'planeta-nebulosa-ozonio-42';
const EMAIL_ADMIN = 'admin@safework.com.br';
const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

/** Set-Cookie do nome pedido, analisado: valor e atributos em minúsculas. */
function setCookie(resposta, nome) {
  const bruto = (resposta.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${nome}=`));
  if (bruto === undefined) return null;
  const [par, ...resto] = bruto.split(';').map((p) => p.trim());
  const atributos = {};
  for (const parte of resto) {
    const i = parte.indexOf('=');
    atributos[(i === -1 ? parte : parte.slice(0, i)).toLowerCase()] = i === -1 ? true : parte.slice(i + 1);
  }
  return { valor: par.slice(nome.length + 1), atributos, par };
}

describe('Painel Privado da plataforma — HTTP completo com PostgreSQL real', () => {
  let contexto;
  let app;
  let empresaCliente;
  let administradorId;

  const q = (sql, params) => contexto.pool.query(sql, params);
  const login = (email = EMAIL_ADMIN, senha = SENHA_ADMIN) => request(app).post('/api/plataforma/auth/login').send({ email, senha });
  const desafioDe = async (token) => (await q(
    `SELECT id, tipo, administrador_id, encerrado_em, motivo_encerramento,
            round(extract(epoch FROM (expira_em - criado_em)))::int AS prazo_segundos
       FROM desafios_mfa_plataforma WHERE token_hash = $1`,
    [sha256(token)],
  )).rows[0];
  const contar = async (tabela, administrador) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE administrador_id = $1`, [administrador])).rows[0].n;

  async function novoAdministrador(email, senha = SENHA_ADMIN) {
    const hash = await gerarHashSenha(senha);
    return (await q('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
  }

  async function ativarTotp(id) {
    const fatorUid = crypto.randomUUID();
    const envelope = cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: id, fatorUid });
    const fator = await fatorRepo.criarPendenteTotp(contexto.pool, { administradorId: id, fatorUid, envelope, validadeMinutos: 15 });
    assert.equal(await fatorRepo.ativarTotp(contexto.pool, { administradorId: id, fatorId: fator.id, step: 1 }), true);
  }

  before(async () => {
    // 048: auditoria com ator e alvo; 049 e 052: fatores e desafios do MFA;
    // 053: liberação emitida por criarInicial; 054: colunas de MFA da sessão.
    contexto = await abrirPoolTemporario(['000', '001', '002', '005', '025', '012', '013', '014', '015', '027', '028', '029', '030', '031', '048', '049', '052', '053', '054']);

    const authController = criarAuthController({ pool: contexto.pool });
    const exigirSessaoCliente = criarExigirSessao({ pool: contexto.pool });
    const limitadorCliente = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const authRoutes = criarAuthRoutes({ controller: authController, limitador: limitadorCliente, exigirSessao: exigirSessaoCliente });

    const exigirSessaoPlataformaTeste = criarExigirSessaoPlataforma({ pool: contexto.pool });
    const authPlataformaRoutes = criarAuthPlataformaRoutes({
      controller: criarAuthPlataformaController({ pool: contexto.pool }),
      limitador: criarLimitador({ limite: 1000, janelaSegundos: 60 }),
      limitadorMfa: criarLimitador({ limite: 1000, janelaSegundos: 60 }),
      exigirSessaoPlataforma: exigirSessaoPlataformaTeste,
      desafioMfa: (tipos) => criarExigirDesafioMfa({ pool: contexto.pool, tipos }),
    });
    const painelPlataformaRoutes = criarPainelPlataformaRoutes({
      controller: painelPlataformaController, exigirSessaoPlataforma: exigirSessaoPlataformaTeste,
    });

    app = criarAppTeste((a) => {
      a.use('/api', authRoutes);
      a.use('/api/plataforma', authPlataformaRoutes, painelPlataformaRoutes);
    });

    const hashClienteCorreto = await gerarHashSenha(SENHA_CORRETA);
    const cliente = await contexto.pool.connect();
    try {
      assert.equal(await inserirEmpresa(cliente, CNPJ_CLIENTE, 'Empresa Cliente'), 'ok');
      const { rows: empresas } = await cliente.query('SELECT id FROM empresas LIMIT 1');
      empresaCliente = empresas[0].id;
      await cliente.query(
        `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [empresaCliente, 'Usuário Cliente', 'usuario.cliente@demo.safeworkengenharia.com.br', hashClienteCorreto, 'ADMINISTRADOR'],
      );
    } finally {
      cliente.release();
    }

    // Administrador inicial pelo procedimento controlado real, não um INSERT paralelo.
    const administrador = await criarInicial(contexto.pool, { email: EMAIL_ADMIN, senha: SENHA_ADMIN });
    administradorId = administrador.id;
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('POST /auth/login — senha correta abre desafio, nunca sessão', () => {
    test('sem TOTP ativo: 200 {status, etapa LIBERACAO, expiraEm}, só o cookie do desafio, nenhuma sessão criada', async () => {
      const sessoesAntes = await contar('sessoes_plataforma', administradorId);

      const resposta = await login();

      assert.equal(resposta.status, 200);
      assert.deepEqual(Object.keys(resposta.body).sort(), ['etapa', 'expiraEm', 'status']);
      assert.deepEqual([resposta.body.status, resposta.body.etapa], ['ok', 'LIBERACAO']);
      assert.ok(!Number.isNaN(Date.parse(resposta.body.expiraEm)));

      assert.equal(resposta.headers['set-cookie'].length, 1, 'um único Set-Cookie: o do desafio');
      assert.equal(setCookie(resposta, authConfig.sessao.cookieNomeAdmin), null, 'nenhum cookie de sessão plena');
      const cookie = setCookie(resposta, authConfig.desafioMfa.cookieNome);
      assert.match(cookie.valor, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(cookie.atributos.httponly, true);
      assert.equal(cookie.atributos.samesite, 'Strict');
      assert.equal(cookie.atributos.path, '/api/plataforma/auth');
      assert.equal(cookie.atributos['max-age'], String(authConfig.desafioMfa.cadastroMinutos * 60));
      assert.equal('domain' in cookie.atributos, false);

      const corpo = JSON.stringify(resposta.body);
      for (const proibido of [cookie.valor, sha256(cookie.valor), EMAIL_ADMIN, 'administrador']) {
        assert.equal(corpo.includes(proibido), false);
      }

      assert.equal(await contar('sessoes_plataforma', administradorId), sessoesAntes, 'senha correta não cria sessão');
      const desafio = await desafioDe(cookie.valor);
      assert.deepEqual(
        [desafio.tipo, desafio.administrador_id, desafio.encerrado_em, desafio.prazo_segundos],
        ['LIBERACAO', administradorId, null, authConfig.desafioMfa.cadastroMinutos * 60],
      );
    });

    test('com TOTP ativo: VERIFICACAO, cookie com o prazo de verificação, nenhuma sessão', async () => {
      const id = await novoAdministrador('com-totp@safework.com.br');
      await ativarTotp(id);

      const resposta = await login('com-totp@safework.com.br');

      assert.deepEqual([resposta.status, resposta.body.etapa], [200, 'VERIFICACAO']);
      const cookie = setCookie(resposta, authConfig.desafioMfa.cookieNome);
      assert.equal(cookie.atributos['max-age'], String(authConfig.desafioMfa.verificacaoMinutos * 60));
      const desafio = await desafioDe(cookie.valor);
      assert.deepEqual([desafio.tipo, desafio.prazo_segundos], ['VERIFICACAO', authConfig.desafioMfa.verificacaoMinutos * 60]);
      assert.equal(await contar('sessoes_plataforma', id), 0);
    });

    test('a rota não conhece CNPJ: campo desconhecido é recusado', async () => {
      const resposta = await request(app).post('/api/plataforma/auth/login').send({ email: EMAIL_ADMIN, senha: SENHA_ADMIN, cnpj: '99999999000199' });
      assert.deepEqual([resposta.status, resposta.body.codigo], [400, 'VALIDACAO']);
    });

    test('credenciais inválidas: mesmo 401 genérico para senha errada e e-mail inexistente, sem cookie e sem desafio', async () => {
      const desafiosAntes = await contar('desafios_mfa_plataforma', administradorId);

      const senhaErrada = await login(EMAIL_ADMIN, 'senha-errada');
      const emailInexistente = await login('ninguem@safework.com.br', SENHA_ADMIN);

      for (const r of [senhaErrada, emailInexistente]) {
        assert.deepEqual([r.status, r.body], [401, { status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'E-mail ou senha inválidos' }]);
        assert.equal(r.headers['set-cookie'], undefined);
      }
      assert.equal(await contar('desafios_mfa_plataforma', administradorId), desafiosAntes);
    });

    test('administrador inativo: senha correta recusada; sessão e desafio anteriores deixam de valer; reativar não os revive', async () => {
      const senha = 'senha-do-inativo-2026';
      const id = await novoAdministrador('inativo@safework.com.br', senha);
      const sessao = await criarSessaoAdministrativa(contexto.pool, id);
      const antes = await login('inativo@safework.com.br', senha);
      const cookieDesafio = setCookie(antes, authConfig.desafioMfa.cookieNome).par;

      await q('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [id]);

      assert.deepEqual([(await request(app).get('/api/plataforma/painel').set('Cookie', sessao.cookie)).body.codigo], ['SESSAO_INVALIDA']);
      assert.equal((await request(app).get('/api/plataforma/auth/mfa/estado').set('Cookie', cookieDesafio)).status, 401);
      const depois = await login('inativo@safework.com.br', senha);
      assert.deepEqual([depois.status, depois.body.codigo], [401, 'CREDENCIAIS_INVALIDAS']);

      await q('UPDATE administradores_plataforma SET ativo = true WHERE id = $1', [id]);
      assert.equal((await request(app).get('/api/plataforma/painel').set('Cookie', sessao.cookie)).status, 401, 'a revogação da 031 é permanente');
      assert.equal((await login('inativo@safework.com.br', senha)).body.etapa, 'LIBERACAO', 'depois de reativar, a senha volta a abrir desafio');
    });

    test('cooldown persistente: vigente, até a senha correta recebe 429, sem cookie e sem desafio', async () => {
      const email = 'cooldown-http@safework.com.br';
      const senha = 'senha-do-cooldown-http-2026';
      const id = await novoAdministrador(email, senha);

      for (let i = 0; i < authConfig.cooldown.niveis[0].falhas; i += 1) {
        assert.equal((await login(email, 'senha-errada-qualquer')).status, 401);
      }

      const bloqueada = await login(email, senha);
      assert.deepEqual([bloqueada.status, bloqueada.body.codigo], [429, 'LOGIN_EM_COOLDOWN']);
      assert.ok(Number(bloqueada.headers['retry-after']) > 0);
      assert.equal(bloqueada.headers['set-cookie'], undefined);
      assert.equal(await contar('desafios_mfa_plataforma', id), 0);
    });

    test('limite: 7 logins válidos seguidos deixam exatamente 5 desafios abertos; os 2 mais antigos saem por LIMITE_DESAFIOS', async () => {
      const id = await novoAdministrador('limite-http@safework.com.br');
      for (let i = 0; i < 7; i += 1) {
        assert.equal((await login('limite-http@safework.com.br')).status, 200);
      }
      const { rows } = await q(
        'SELECT encerrado_em IS NULL AS aberto, motivo_encerramento FROM desafios_mfa_plataforma WHERE administrador_id = $1 ORDER BY criado_em, id',
        [id],
      );
      assert.deepEqual(rows.map((r) => r.aberto), [false, false, true, true, true, true, true]);
      assert.deepEqual(rows.slice(0, 2).map((r) => r.motivo_encerramento), ['LIMITE_DESAFIOS', 'LIMITE_DESAFIOS']);
    });
  });

  describe('o desafio não é sessão', () => {
    test('/auth/me e rota administrativa com só o cookie do desafio: 401 SESSAO_INVALIDA, nada do administrador', async () => {
      const cookieDesafio = setCookie(await login(), authConfig.desafioMfa.cookieNome).par;

      for (const caminho of ['/api/plataforma/auth/me', '/api/plataforma/painel']) {
        const r = await request(app).get(caminho).set('Cookie', cookieDesafio);
        assert.deepEqual([r.status, r.body], [401, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'Sessão inválida ou expirada' }], caminho);
      }
    });

    test('o valor do token do desafio sob o nome do cookie de sessão também não vale', async () => {
      const token = setCookie(await login(), authConfig.desafioMfa.cookieNome).valor;
      const r = await request(app).get('/api/plataforma/painel').set('Cookie', `${authConfig.sessao.cookieNomeAdmin}=${token}`);
      assert.equal(r.status, 401);
    });

    test('o cookie do desafio nunca autentica o ambiente empresarial', async () => {
      const cookieDesafio = setCookie(await login(), authConfig.desafioMfa.cookieNome).par;
      const r = await request(app).get('/api/auth/me').set('Cookie', cookieDesafio);
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA']);
    });
  });

  describe('GET /auth/mfa/estado', () => {
    test('desafio válido: 200 só com etapa e expiraEm, sem identidade nem token', async () => {
      const resposta = await login();
      const cookie = setCookie(resposta, authConfig.desafioMfa.cookieNome);

      const estado = await request(app).get('/api/plataforma/auth/mfa/estado').set('Cookie', cookie.par);

      assert.equal(estado.status, 200);
      // Corpo exato: sem administradorId, e-mail, fator, token ou qualquer outro campo.
      assert.deepEqual(estado.body, { status: 'ok', etapa: 'LIBERACAO', expiraEm: resposta.body.expiraEm });
      assert.equal(estado.headers['set-cookie'], undefined);
      for (const proibido of [cookie.valor, sha256(cookie.valor), EMAIL_ADMIN]) {
        assert.equal(JSON.stringify(estado.body).includes(proibido), false);
      }
    });

    test('recusa genérica: sem cookie, malformado, duplicado, vencido, encerrado ou só sessão plena', async () => {
      const estado = (cookie) => {
        const r = request(app).get('/api/plataforma/auth/mfa/estado');
        return cookie === undefined ? r : r.set('Cookie', cookie);
      };
      const nome = authConfig.desafioMfa.cookieNome;
      const removeu = (r) => (setCookie(r, nome)?.atributos['max-age'] === '0');

      const semCookie = await estado();
      assert.deepEqual([semCookie.status, semCookie.body.codigo, semCookie.headers['set-cookie']], [401, 'DESAFIO_INVALIDO', undefined]);

      const malformado = await estado(`${nome}=nao-e-um-token`);
      assert.deepEqual([malformado.status, removeu(malformado)], [401, true]);

      const a = setCookie(await login(), nome);
      const b = setCookie(await login(), nome);
      const duplicado = await estado(`${a.par}; ${b.par}`);
      assert.deepEqual([duplicado.status, removeu(duplicado)], [401, true]);

      await q(
        "UPDATE desafios_mfa_plataforma SET criado_em = now() - interval '1 hour', expira_em = now() - interval '1 minute' WHERE token_hash = $1",
        [sha256(a.valor)],
      );
      const vencido = await estado(a.par);
      assert.deepEqual([vencido.status, vencido.body.codigo, removeu(vencido)], [401, 'DESAFIO_INVALIDO', true]);

      await q("UPDATE desafios_mfa_plataforma SET encerrado_em = clock_timestamp(), motivo_encerramento = 'LOGOUT' WHERE token_hash = $1", [sha256(b.valor)]);
      const encerrado = await estado(b.par);
      assert.deepEqual([encerrado.status, encerrado.body.codigo, removeu(encerrado)], [401, 'DESAFIO_INVALIDO', true]);

      const sessao = await criarSessaoAdministrativa(contexto.pool, administradorId);
      const soSessao = await estado(sessao.cookie);
      assert.deepEqual([soSessao.status, soSessao.body.codigo], [401, 'DESAFIO_INVALIDO']);

      for (const r of [semCookie, malformado, duplicado, vencido, encerrado, soSessao]) {
        assert.deepEqual(r.body, { status: 'error', codigo: 'DESAFIO_INVALIDO', message: 'Etapa de verificação inválida ou expirada' });
      }
    });
  });

  describe('POST /auth/logout', () => {
    test('com sessão e desafio: revoga a sessão, encerra o desafio com LOGOUT e remove os dois cookies; repetir é inofensivo', async () => {
      const sessao = await criarSessaoAdministrativa(contexto.pool, administradorId);
      const desafio = setCookie(await login(), authConfig.desafioMfa.cookieNome);
      const cookies = `${sessao.cookie}; ${desafio.par}`;

      const primeiro = await request(app).post('/api/plataforma/auth/logout').set('Cookie', cookies);

      assert.deepEqual([primeiro.status, primeiro.body], [200, { status: 'ok' }]);
      const remSessao = setCookie(primeiro, authConfig.sessao.cookieNomeAdmin);
      const remDesafio = setCookie(primeiro, authConfig.desafioMfa.cookieNome);
      assert.deepEqual([remSessao.valor, remSessao.atributos['max-age'], remSessao.atributos.path], ['', '0', '/']);
      assert.deepEqual([remDesafio.valor, remDesafio.atributos['max-age'], remDesafio.atributos.path], ['', '0', '/api/plataforma/auth']);

      const { rows: [s1] } = await q('SELECT revogada_em, motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [sessao.id]);
      assert.equal(s1.motivo_revogacao, 'LOGOUT');
      const d1 = await desafioDe(desafio.valor);
      assert.equal(d1.motivo_encerramento, 'LOGOUT');

      const segundo = await request(app).post('/api/plataforma/auth/logout').set('Cookie', cookies);
      assert.deepEqual([segundo.status, segundo.headers['set-cookie'].length], [200, 2]);
      const { rows: [s2] } = await q('SELECT revogada_em FROM sessoes_plataforma WHERE id = $1', [sessao.id]);
      assert.deepEqual(s2.revogada_em, s1.revogada_em, 'a revogação não é refeita');
      assert.equal((await request(app).get('/api/plataforma/auth/mfa/estado').set('Cookie', desafio.par)).status, 401);
      assert.equal((await request(app).get('/api/plataforma/painel').set('Cookie', sessao.cookie)).status, 401);
    });

    test('só com o desafio: encerra o desafio; sem cookie algum: 200 e as duas remoções', async () => {
      const desafio = setCookie(await login(), authConfig.desafioMfa.cookieNome);
      const r = await request(app).post('/api/plataforma/auth/logout').set('Cookie', desafio.par);
      assert.equal(r.status, 200);
      assert.equal((await desafioDe(desafio.valor)).motivo_encerramento, 'LOGOUT');

      const vazio = await request(app).post('/api/plataforma/auth/logout');
      assert.equal(vazio.status, 200);
      assert.ok(setCookie(vazio, authConfig.sessao.cookieNomeAdmin));
      assert.ok(setCookie(vazio, authConfig.desafioMfa.cookieNome));
    });
  });

  describe('sessões já existentes não são afetadas', () => {
    test('sessão plena anterior continua valendo em /auth/me e no painel, sem colunas de MFA', async () => {
      const sessao = await criarSessaoAdministrativa(contexto.pool, administradorId);

      const me = await request(app).get('/api/plataforma/auth/me').set('Cookie', sessao.cookie);
      const painel = await request(app).get('/api/plataforma/painel').set('Cookie', sessao.cookie);

      assert.deepEqual([me.status, me.body.administrador.id], [200, administradorId]);
      assert.equal(painel.status, 200);
      assert.equal('empresa' in painel.body, false);
      const { rows } = await q('SELECT mfa_verificado_em, mfa_metodo FROM sessoes_plataforma WHERE id = $1', [sessao.id]);
      assert.deepEqual(rows[0], { mfa_verificado_em: null, mfa_metodo: null });
    });

    test('sessão vencida continua recusada', async () => {
      const sessao = await criarSessaoAdministrativa(contexto.pool, administradorId);
      await q("UPDATE sessoes_plataforma SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 minute' WHERE id = $1", [sessao.id]);
      assert.equal((await request(app).get('/api/plataforma/painel').set('Cookie', sessao.cookie)).status, 401);
    });
  });

  describe('isolamento entre a sessão administrativa e a sessão empresarial', () => {
    test('o cookie do cliente nunca autentica o Painel Privado', async () => {
      const loginCliente = await request(app)
        .post('/api/auth/login')
        .send({ cnpj: CNPJ_CLIENTE, email: 'usuario.cliente@demo.safeworkengenharia.com.br', senha: SENHA_CORRETA });
      assert.equal(loginCliente.status, 200);
      const cookieCliente = setCookie(loginCliente, authConfig.sessao.cookieNome).par;

      const painel = await request(app).get('/api/plataforma/painel').set('Cookie', cookieCliente);
      assert.deepEqual([painel.status, painel.body.codigo], [401, 'SESSAO_INVALIDA']);
    });

    test('o cookie administrativo nunca autentica usuários no ambiente empresarial', async () => {
      const sessao = await criarSessaoAdministrativa(contexto.pool, administradorId);
      const me = await request(app).get('/api/auth/me').set('Cookie', sessao.cookie);
      assert.deepEqual([me.status, me.body.codigo], [401, 'SESSAO_INVALIDA']);
    });

    test('login administrativo não cria nem altera nenhum registro em usuarios/empresas', async () => {
      const { rows: usuariosAntes } = await q('SELECT count(*)::int AS total FROM usuarios');
      const { rows: empresasAntes } = await q('SELECT count(*)::int AS total FROM empresas');

      await login();

      const { rows: usuariosDepois } = await q('SELECT count(*)::int AS total FROM usuarios');
      const { rows: empresasDepois } = await q('SELECT count(*)::int AS total FROM empresas');
      assert.equal(usuariosDepois[0].total, usuariosAntes[0].total);
      assert.equal(empresasDepois[0].total, empresasAntes[0].total);
    });
  });
});
