'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarConviteUsuarioController } = require('../../src/controllers/convite-usuario.controller');
const { criarConviteUsuarioRoutes } = require('../../src/routes/convite-usuario.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const { httpConfig } = require('../../src/config/http');

/**
 * Parte F — convite de usuário (D1): quem administra usuários convida por
 * e-mail, nome e perfil; a pessoa aceita por um link com token opaco. Nova
 * identidade define a própria senha; identidade existente prova a senha
 * atual e ganha só o vínculo. Mesmo desenho seguro do convite do MASTER.
 * PostgreSQL real, schema temporário.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 48 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-dos-convites-2026';
// Precisa passar na política real: "senha" no texto já a torna trivial.
const SENHA_NOVA = 'Correnteza-Azul-Pedra-7319';
const ADMIN = '/api/administracao/convites-usuario';
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;
const LINK = new RegExp(`^${httpConfig.cors.origens[0].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/portal/aceitar-convite\\.html#token=([A-Za-z0-9_-]{43})$`);
const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

describe('Parte F — convite de usuário (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let hash;
  const empresa = {};
  const u = {};
  const email = {};
  const cookie = {};
  const tokens = [];

  const q = (sql, params) => pool.query(sql, params);
  const convidar = (quem, corpo) => request(app).post(ADMIN).set('Cookie', cookie[quem]).send(corpo);
  const listar = (quem, query = '') => request(app).get(`${ADMIN}${query}`).set('Cookie', cookie[quem]);
  const cancelar = (quem, id) => request(app).post(`${ADMIN}/${id}/cancelar`).set('Cookie', cookie[quem]).send({});
  const consultar = (token) => request(app).post('/api/convite-usuario/consultar').send({ token });
  const aceitar = (token, senha, ua) => {
    const r = request(app).post('/api/convite-usuario/aceitar');
    if (ua) r.set('User-Agent', ua);
    return r.send({ token, senha });
  };
  const tokenDe = (resposta) => {
    const achado = LINK.exec(resposta.body.entrega.linkAceite);
    assert.ok(achado, resposta.body.entrega.linkAceite);
    tokens.push(achado[1]);
    return achado[1];
  };
  const auditorias = async (acao) => (await q(
    'SELECT empresa_id, usuario_id, referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = $1 ORDER BY id', [acao],
  )).rows;

  async function vinculo(chave, empresaId, perfil, { identidadeId = null, ativo = true } = {}) {
    let identidade = identidadeId;
    if (identidade === null) {
      email[chave] = `${chave.toLowerCase()}.convite@exemplo-cliente.com.br`;
      identidade = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email[chave], hash])).rows[0].id;
    }
    u[chave] = (await q(
      'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id, ativo) VALUES ($1, $2, NULL, NULL, $3, $4, $5) RETURNING id',
      [empresaId, chave, perfil, identidade, ativo],
    )).rows[0].id;
    return identidade;
  }

  async function entrar(chave) {
    const login = await request(app).post('/api/auth/global/login').send({ email: email[chave], senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    cookie[chave] = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    hash = await gerarHashSenha(SENHA);
    for (const [k, nome, cnpj] of [['A', 'Empresa Alfa Convites', '11222333000181'], ['B', 'Empresa Beta Convites', '22333444000100'], ['E', 'Empresa Encerrada', '33444555000102']]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
    }
    await vinculo('masterA', empresa.A, 'MASTER');
    await vinculo('admA', empresa.A, 'ADMINISTRADOR');
    await vinculo('adm2A', empresa.A, 'ADMINISTRADOR');
    await vinculo('usuA', empresa.A, 'USUARIO');
    await vinculo('inativoA', empresa.A, 'USUARIO', { ativo: false });
    await vinculo('masterB', empresa.B, 'MASTER');
    await vinculo('externa', empresa.B, 'USUARIO'); // conta global que só trabalha na B
    await vinculo('masterE', empresa.E, 'MASTER');
    await q("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'GERENCIAR_USUARIOS', $3)", [empresa.A, u.admA, u.masterA]);

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao }),
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarConviteUsuarioRoutes({
          controller: criarConviteUsuarioController({ pool }), exigirSessao, limitador: semLimite(), limitadorEnvio: semLimite(),
        }),
      );
    });
    for (const chave of ['masterA', 'admA', 'adm2A', 'usuA', 'masterB', 'masterE']) await entrar(chave);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('criar, listar e cancelar (quem administra)', () => {
    test('MASTER convida: 201, link do Portal com o token só no fragmento; banco guarda só o hash; log sem token nem e-mail', async (t) => {
      const logs = t.mock.method(console, 'log', () => {});
      const r = await convidar('masterA', { email: '  Nova.Pessoa@Exemplo-Cliente.com.br ', nome: '  Nova   Pessoa ', tipoConta: 'USUARIO' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const token = tokenDe(r);
      assert.deepEqual(
        [r.body.convite.emailConvite, r.body.convite.nome, r.body.convite.perfil, r.body.convite.situacao, r.body.entrega.modo],
        ['nova.pessoa@exemplo-cliente.com.br', 'Nova   Pessoa', 'USUARIO', 'PENDENTE', 'DESENVOLVIMENTO_SEM_EMAIL'],
      );
      assert.doesNotMatch(JSON.stringify(r.body.convite), /token|hash/i);
      const { rows: [linha] } = await q('SELECT * FROM convites_usuario WHERE id = $1', [r.body.convite.id]);
      assert.equal(linha.token_hash, sha256(token));
      assert.equal(linha.criado_por, u.masterA);
      assert.equal(JSON.stringify(linha).includes(token), false);
      const [a] = await auditorias('USUARIO_CONVIDADO');
      assert.deepEqual([a.empresa_id, a.usuario_id, a.referencia], [empresa.A, u.masterA, String(r.body.convite.id)]);
      // SEC-023/PRIV-001: e-mail, nome e perfil ficam no convite; a auditoria só aponta para ele.
      assert.deepEqual(a.dados_novos, { conviteId: String(r.body.convite.id) });
      assert.equal(JSON.stringify(a).includes('nova.pessoa@'), false, 'e-mail na auditoria');
      const escrito = JSON.stringify(logs.mock.calls.map((c) => c.arguments));
      assert.equal(escrito.includes(token), false, 'token no log');
      assert.equal(escrito.includes('nova.pessoa@'), false, 'e-mail no log');
    });

    test('corpo estrito e validado: empresa, identidade, senha e situação nunca entram; e-mail, nome e perfil precisam ser válidos', async () => {
      const valido = { email: 'valido@exemplo-cliente.com.br', nome: 'Pessoa', tipoConta: 'USUARIO' };
      for (const extra of [{ empresaId: empresa.B }, { empresa_id: empresa.B }, { identidadeId: 1 }, { senha: SENHA_NOVA }, { ativo: true }, { criadoPor: u.usuA }, { token: 'x' }, { perfil: 'MASTER' }, { usuarioId: u.usuA }, { master: true }]) {
        const r = await convidar('masterA', { ...valido, ...extra });
        assert.equal(r.status, 400, JSON.stringify(extra));
        assert.equal(JSON.stringify(r.body).includes(SENHA_NOVA), false);
      }
      for (const ruim of [{ email: 'sem-arroba' }, { email: '' }, { nome: '   ' }, { nome: 'x'.repeat(151) }, { tipoConta: 'ROOT' }, { tipoConta: undefined }]) {
        assert.equal((await convidar('masterA', { ...valido, ...ruim })).status, 400, JSON.stringify(ruim));
      }
      assert.equal((await q("SELECT count(*)::int AS n FROM convites_usuario WHERE email_convite = 'valido@exemplo-cliente.com.br'")).rows[0].n, 0);
    });

    test('D3: ADMINISTRADOR autorizado convida só SUPERVISOR e USUARIO; sem autorização ou sem ser administrador: 403', async () => {
      assert.equal((await convidar('admA', { email: 'sup.nova@exemplo-cliente.com.br', nome: 'Supervisora', tipoConta: 'SUPERVISOR' })).status, 201);
      for (const perfil of ['ADMINISTRADOR', 'MASTER']) {
        const r = await convidar('admA', { email: `${perfil.toLowerCase()}.nova@exemplo-cliente.com.br`, nome: 'X', tipoConta: perfil });
        assert.deepEqual([r.status, r.body.codigo], [403, 'USUARIO_PERFIL_NAO_PERMITIDO']);
      }
      for (const quem of ['adm2A', 'usuA']) {
        const r = await convidar(quem, { email: 'qualquer@exemplo-cliente.com.br', nome: 'X', tipoConta: 'USUARIO' });
        assert.deepEqual([r.status, r.body.codigo], [403, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA'], quem);
      }
      assert.equal((await request(app).post(ADMIN).send({ email: 'x@y.com', nome: 'X', tipoConta: 'USUARIO' })).status, 401);
    });

    test('e-mail com vínculo NESTA empresa (ativo ou inativo): 409; com vínculo só em outra empresa: convite normal, sem revelar nada', async () => {
      for (const chave of ['usuA', 'inativoA', 'masterA']) {
        const r = await convidar('masterA', { email: email[chave].toUpperCase(), nome: 'X', tipoConta: 'USUARIO' });
        assert.deepEqual([r.status, r.body.codigo], [409, 'USUARIO_VINCULO_EXISTENTE'], chave);
      }
      const externa = await convidar('masterA', { email: email.externa, nome: 'Pessoa de Fora', tipoConta: 'SUPERVISOR' });
      const inedita = await convidar('masterA', { email: 'inedita@exemplo-cliente.com.br', nome: 'Pessoa Inédita', tipoConta: 'SUPERVISOR' });
      assert.deepEqual([externa.status, inedita.status], [201, 201]);
      assert.deepEqual(Object.keys(externa.body.convite).sort(), Object.keys(inedita.body.convite).sort());
      assert.deepEqual(Object.keys(externa.body).sort(), Object.keys(inedita.body).sort());
      assert.doesNotMatch(JSON.stringify(externa.body), /Beta|identidade|existente/i);
      tokenDe(externa);
      tokenDe(inedita);
    });

    test('convite em aberto duplicado: 409; dois convites simultâneos para o mesmo e-mail criam um só', async () => {
      const dup = await convidar('masterA', { email: 'nova.pessoa@exemplo-cliente.com.br', nome: 'Outra', tipoConta: 'USUARIO' });
      assert.deepEqual([dup.status, dup.body.codigo], [409, 'CONVITE_JA_PENDENTE']);
      const corpo = { email: 'simultaneo@exemplo-cliente.com.br', nome: 'Simultânea', tipoConta: 'USUARIO' };
      const respostas = await Promise.all([convidar('masterA', corpo), convidar('admA', corpo), convidar('masterA', corpo)]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [201, 409, 409]);
      assert.equal((await q("SELECT count(*)::int AS n FROM convites_usuario WHERE email_convite = 'simultaneo@exemplo-cliente.com.br'")).rows[0].n, 1);
      tokenDe(respostas.find((r) => r.status === 201));
    });

    test('listagem dos convites em aberto: só da empresa da sessão, paginada, com quem convidou, sem token nem hash', async () => {
      await convidar('masterB', { email: 'so.da.b@exemplo-cliente.com.br', nome: 'Só da B', tipoConta: 'USUARIO' }).then(tokenDe);
      const r = await listar('masterA', '?limite=100');
      assert.equal(r.status, 200);
      assert.equal(r.body.convites.some((c) => c.emailConvite === 'so.da.b@exemplo-cliente.com.br'), false);
      const nova = r.body.convites.find((c) => c.emailConvite === 'nova.pessoa@exemplo-cliente.com.br');
      assert.deepEqual([nova.situacao, nova.criadoPor.nome, nova.podeCancelar], ['PENDENTE', 'masterA', true]);
      assert.doesNotMatch(JSON.stringify(r.body), /token|hash|senha/i);
      const pagina = await listar('masterA', '?limite=2&pagina=1');
      assert.deepEqual([pagina.body.convites.length, pagina.body.total], [2, r.body.total]);
      assert.equal((await listar('masterA', '?limite=101')).status, 400);
      assert.equal((await listar('masterA', '?empresaId=2')).status, 400);
      assert.equal((await listar('adm2A')).status, 403);
      const doAdmin = await listar('admA', '?limite=100');
      const deAdministrador = await convidar('masterA', { email: 'adm.convidado@exemplo-cliente.com.br', nome: 'Adm Convidado', tipoConta: 'ADMINISTRADOR' });
      tokenDe(deAdministrador);
      const depois = await listar('admA', '?limite=100');
      assert.equal(depois.body.convites.find((c) => c.id === deAdministrador.body.convite.id).podeCancelar, false);
      assert.equal(doAdmin.status, 200);
    });

    test('cancelar: MASTER cancela; ADMINISTRADOR não cancela convite de ADMINISTRADOR; outra empresa 404; repetido 409; auditado', async () => {
      const alvo = (await listar('masterA', '?limite=100')).body.convites.find((c) => c.emailConvite === 'adm.convidado@exemplo-cliente.com.br');
      const negado = await cancelar('admA', alvo.id);
      assert.deepEqual([negado.status, negado.body.codigo], [403, 'USUARIO_PERFIL_NAO_PERMITIDO']);
      const deOutra = await cancelar('masterB', alvo.id);
      const inexistente = await cancelar('masterB', '999999999');
      assert.deepEqual([deOutra.status, inexistente.status], [404, 404]);
      assert.deepEqual(deOutra.body, inexistente.body);
      const ok = await cancelar('masterA', alvo.id);
      assert.deepEqual([ok.status, ok.body.convite.situacao], [200, 'CANCELADO']);
      const repetido = await cancelar('masterA', alvo.id);
      assert.deepEqual([repetido.status, repetido.body.codigo], [409, 'CONVITE_NAO_CANCELAVEL']);
      const [a] = await auditorias('USUARIO_CONVITE_CANCELADO');
      assert.deepEqual([a.empresa_id, a.usuario_id, a.referencia], [empresa.A, u.masterA, String(alvo.id)]);
      assert.equal((await cancelar('masterA', 'abc')).status, 400);
    });
  });

  describe('aceite pela pessoa convidada (público, sem sessão)', () => {
    let tokenNova;
    let tokenExterna;

    before(async () => {
      const r = await convidar('masterA', { email: 'aceite.nova@exemplo-cliente.com.br', nome: 'Aceite Nova', tipoConta: 'SUPERVISOR' });
      tokenNova = tokenDe(r);
      tokenExterna = tokens[1];
    });

    test('consulta mostra o que a pessoa precisa saber, sem dado interno', async () => {
      const r = await consultar(tokenNova);
      assert.equal(r.status, 200);
      assert.deepEqual(
        [r.body.situacao, r.body.empresa.razaoSocial, r.body.emailConvite, r.body.nome, r.body.perfil, r.body.identidadeExistente],
        ['PENDENTE', 'Empresa Alfa Convites', 'aceite.nova@exemplo-cliente.com.br', 'Aceite Nova', 'SUPERVISOR', false],
      );
      assert.doesNotMatch(JSON.stringify(r.body), /token|hash|criado_?por|masterA/i);
      assert.equal((await consultar(tokenExterna)).body.identidadeExistente, true);
    });

    test('identidade nova: senha fora da política é recusada sem criar nada; senha válida cria identidade Argon2id e vínculo com nome e perfil do convite', async () => {
      const fraca = await aceitar(tokenNova, 'curta');
      assert.equal(fraca.status, 400);
      assert.equal((await q("SELECT count(*)::int AS n FROM identidades WHERE email = 'aceite.nova@exemplo-cliente.com.br'")).rows[0].n, 0);

      const r = await aceitar(tokenNova, SENHA_NOVA);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.usuario.nome, r.body.usuario.perfil, r.body.identidadeCriada, r.body.empresa.razaoSocial], ['Aceite Nova', 'SUPERVISOR', true, 'Empresa Alfa Convites']);
      assert.doesNotMatch(JSON.stringify(r.body), /hash|token|senha/i);
      const { rows: [identidade] } = await q("SELECT id, senha_hash FROM identidades WHERE email = 'aceite.nova@exemplo-cliente.com.br'");
      assert.match(identidade.senha_hash, /^\$argon2id\$/);
      const { rows: vinculos } = await q('SELECT id, empresa_id, nome, perfil, ativo, email, senha_hash FROM usuarios WHERE identidade_id = $1', [identidade.id]);
      assert.deepEqual(vinculos.map((v) => [v.empresa_id, v.nome, v.perfil, v.ativo, v.email, v.senha_hash]), [[empresa.A, 'Aceite Nova', 'SUPERVISOR', true, null, null]]);
      const [a] = (await auditorias('USUARIO_CRIADO')).filter((x) => x.referencia === String(vinculos[0].id));
      assert.deepEqual([a.empresa_id, a.usuario_id, a.contexto.conviteCriadoPor, a.contexto.identidadeCriada], [empresa.A, vinculos[0].id, u.masterA, true]);
      const login = await request(app).post('/api/auth/global/login').send({ email: 'aceite.nova@exemplo-cliente.com.br', senha: SENHA_NOVA, turnstileToken: TOKEN_TURNSTILE_TESTE });
      assert.equal(login.status, 200);
      assert.deepEqual(login.body.empresas.map((e) => e.id), [empresa.A]);
    });

    test('uso único: o mesmo link não serve de novo', async () => {
      const r = await aceitar(tokenNova, SENHA_NOVA);
      assert.deepEqual([r.status, r.body.codigo], [409, 'CONVITE_JA_UTILIZADO']);
      assert.equal((await consultar(tokenNova)).status, 409);
    });

    test('identidade existente: senha errada é recusada; a senha atual dá só o vínculo novo, sem duplicar a identidade nem mexer na outra empresa', async () => {
      const antesB = (await q('SELECT * FROM usuarios WHERE id = $1', [u.externa])).rows[0];
      const errada = await aceitar(tokenExterna, 'outra-senha-qualquer-2026');
      assert.deepEqual([errada.status, errada.body.codigo], [401, 'CREDENCIAIS_INVALIDAS']);
      const r = await aceitar(tokenExterna, SENHA);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.identidadeCriada, false);
      assert.equal((await q('SELECT count(*)::int AS n FROM identidades WHERE email = $1', [email.externa])).rows[0].n, 1);
      const { rows } = await q('SELECT empresa_id, perfil, nome FROM usuarios WHERE identidade_id = (SELECT id FROM identidades WHERE email = $1) ORDER BY empresa_id', [email.externa]);
      assert.deepEqual(rows.map((v) => [v.empresa_id, v.perfil, v.nome]), [[empresa.A, 'SUPERVISOR', 'Pessoa de Fora'], [empresa.B, 'USUARIO', 'externa']].sort((x, y) => x[0] - y[0]));
      assert.deepEqual((await q('SELECT * FROM usuarios WHERE id = $1', [u.externa])).rows[0], antesB);
    });

    test('cooldown: erros repetidos bloqueiam o link (429), sem verificar senha e sem uma linha nova por tentativa', async () => {
      const r0 = await convidar('masterA', { email: email.masterB, nome: 'Master B em A', tipoConta: 'USUARIO' });
      const token = tokenDe(r0);
      const limiar = authConfig.cooldown.niveis[0].falhas;
      const respostas = [];
      for (let i = 0; i < limiar; i += 1) respostas.push((await aceitar(token, `errada-numero-${i}-muito-longa`)).status);
      assert.deepEqual(respostas, Array(limiar).fill(401));
      const linhas = async () => (await q('SELECT count(*)::int AS n FROM convite_usuario_tentativas')).rows[0].n;
      const antes = await linhas();
      for (let i = 0; i < 5; i += 1) {
        const r = await aceitar(token, SENHA);
        assert.deepEqual([r.status, r.body.codigo], [429, 'CONVITE_EM_COOLDOWN']);
      }
      assert.equal(await linhas(), antes, 'durante o cooldown nada é gravado');
      assert.equal((await q('SELECT count(*)::int AS n FROM usuarios WHERE empresa_id = $1 AND identidade_id = (SELECT id FROM identidades WHERE email = $2)', [empresa.A, email.masterB])).rows[0].n, 0);
    });

    test('token malformado 400, desconhecido 404; cancelado, expirado e empresa inativa 409', async () => {
      assert.equal((await consultar('curto')).status, 400);
      assert.equal((await aceitar('curto', SENHA)).status, 400);
      const desconhecido = crypto.randomBytes(32).toString('base64url');
      assert.deepEqual([(await consultar(desconhecido)).status, (await consultar(desconhecido)).body.codigo], [404, 'CONVITE_INVALIDO']);
      assert.equal((await aceitar(desconhecido, SENHA)).status, 404);

      const cancelado = await convidar('masterA', { email: 'cancelado@exemplo-cliente.com.br', nome: 'C', tipoConta: 'USUARIO' });
      const tokenCancelado = tokenDe(cancelado);
      await cancelar('masterA', cancelado.body.convite.id);
      assert.deepEqual([(await aceitar(tokenCancelado, SENHA_NOVA)).body.codigo], ['CONVITE_CANCELADO']);

      const expirado = await convidar('masterA', { email: 'expirado@exemplo-cliente.com.br', nome: 'E', tipoConta: 'USUARIO' });
      const tokenExpirado = tokenDe(expirado);
      await q("UPDATE convites_usuario SET criado_em = now() - interval '10 days', expira_em = now() - interval '1 day' WHERE id = $1", [expirado.body.convite.id]);
      assert.deepEqual([(await consultar(tokenExpirado)).status, (await aceitar(tokenExpirado, SENHA_NOVA)).body.codigo], [409, 'CONVITE_EXPIRADO']);

      const daE = await convidar('masterE', { email: 'encerrada@exemplo-cliente.com.br', nome: 'Z', tipoConta: 'USUARIO' });
      const tokenE = tokenDe(daE);
      await q('UPDATE empresas SET ativo = false WHERE id = $1', [empresa.E]);
      assert.deepEqual([(await aceitar(tokenE, SENHA_NOVA)).body.codigo], ['CONVITE_EMPRESA_INATIVA']);
      assert.equal((await q("SELECT count(*)::int AS n FROM identidades WHERE email IN ('cancelado@exemplo-cliente.com.br', 'expirado@exemplo-cliente.com.br', 'encerrada@exemplo-cliente.com.br')")).rows[0].n, 0);
    });

    test('vínculo que surgiu na empresa entre o convite e o aceite: aceite recusado (409), nada novo e o convite continua pendente', async () => {
      const r = await convidar('masterA', { email: email.masterE, nome: 'Master E em A', tipoConta: 'USUARIO' });
      const token = tokenDe(r);
      const identidade = (await q('SELECT id FROM identidades WHERE email = $1', [email.masterE])).rows[0].id;
      await q("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Criado por fora', NULL, NULL, 'USUARIO', $2)", [empresa.A, identidade]);
      const antes = (await q('SELECT count(*)::int AS n FROM usuarios WHERE identidade_id = $1', [identidade])).rows[0].n;
      const aceite = await aceitar(token, SENHA);
      assert.deepEqual([aceite.status, aceite.body.codigo], [409, 'CONVITE_VINCULO_EXISTENTE']);
      assert.equal((await q('SELECT count(*)::int AS n FROM usuarios WHERE identidade_id = $1', [identidade])).rows[0].n, antes);
      assert.equal((await q('SELECT aceito_em FROM convites_usuario WHERE id = $1', [r.body.convite.id])).rows[0].aceito_em, null);
    });

    test('concorrência: dois aceites simultâneos do mesmo link criam um só vínculo e uma só identidade', async () => {
      const r = await convidar('masterA', { email: 'corrida@exemplo-cliente.com.br', nome: 'Corrida', tipoConta: 'USUARIO' });
      const token = tokenDe(r);
      const respostas = await Promise.all([aceitar(token, SENHA_NOVA), aceitar(token, SENHA_NOVA), aceitar(token, SENHA_NOVA)]);
      assert.equal(respostas.filter((x) => x.status === 201).length, 1, respostas.map((x) => x.status).join(','));
      assert.equal((await q("SELECT count(*)::int AS n FROM identidades WHERE email = 'corrida@exemplo-cliente.com.br'")).rows[0].n, 1);
      assert.equal((await q("SELECT count(*)::int AS n FROM usuarios WHERE identidade_id = (SELECT id FROM identidades WHERE email = 'corrida@exemplo-cliente.com.br')")).rows[0].n, 1);
    });

    test('User-Agent longo no aceite não derruba nada: dispositivo cortado em 150', async () => {
      const r = await convidar('masterA', { email: 'navegador@exemplo-cliente.com.br', nome: 'Navegador', tipoConta: 'USUARIO' });
      const ok = await aceitar(tokenDe(r), SENHA_NOVA, 'Agente/9.9 '.repeat(50));
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const { rows: [t] } = await q('SELECT dispositivo FROM convite_usuario_tentativas WHERE sucesso ORDER BY id DESC LIMIT 1');
      assert.equal(t.dispositivo.length, 150);
    });
  });

  test('convite não cria funcionário, e nenhuma auditoria ou tentativa guarda token, senha, hash ou cookie', async () => {
    assert.equal((await q('SELECT count(*)::int AS n FROM funcionarios')).rows[0].n, 0);
    const { rows } = await q("SELECT contexto, dados_anteriores, dados_novos, referencia FROM logs_auditoria WHERE acao IN ('USUARIO_CONVIDADO', 'USUARIO_CONVITE_CANCELADO', 'USUARIO_CRIADO')");
    const { rows: tentativas } = await q('SELECT * FROM convite_usuario_tentativas');
    const texto = JSON.stringify([rows, tentativas]);
    for (const token of tokens) {
      assert.equal(texto.includes(token), false, 'token em claro gravado');
      assert.equal(texto.includes(sha256(token)), false, 'hash do token gravado fora de convites_usuario');
    }
    for (const senha of [SENHA, SENHA_NOVA]) assert.equal(texto.includes(senha), false);
    assert.doesNotMatch(JSON.stringify(rows), /senha|argon|token|cookie|authorization/i);
  });
});
