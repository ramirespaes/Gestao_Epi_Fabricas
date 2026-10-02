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
const entregaConviteUsuario = require('../../src/services/entrega-convite-usuario.service');
const conviteRepo = require('../../src/repositories/convite-usuario.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { criarServicoEmail } = require('../../src/email/servico-email');
const { criarSmtp } = require('../../src/email/transporte/smtp');
const { carregarConfigEmail } = require('../../src/config/email');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const { httpConfig } = require('../../src/config/http');

/**
 * Reenvio do convite de usuário e teto de envios (Bloco 11H) contra
 * PostgreSQL real, schema temporário: o anterior é cancelado e nasce outro,
 * com token novo, na mesma transação; o link antigo morre e o novo vale;
 * o teto de 60 segundos entre envios e de 5 em 24 horas por (empresa, e-mail)
 * vale para criar e reenviar; as corridas entre reenviar, aceitar, cancelar e
 * criar nunca deixam dois convites em aberto nem um aceite sobre convite
 * cancelado.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 48 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-dos-reenvios-2026';
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

describe('Bloco 11H — reenvio de convite de usuário (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let hash;
  let contadorDeEmail = 0;
  const empresa = {};
  const u = {};
  const email = {};
  const cookie = {};

  const q = (sql, params) => pool.query(sql, params);
  const emailNovo = (prefixo) => { contadorDeEmail += 1; return `${prefixo}.${contadorDeEmail}@exemplo-cliente.com.br`; };
  const convidar = (quem, corpo, alvo = () => app) => request(alvo()).post(ADMIN).set('Cookie', cookie[quem]).send(corpo);
  const reenviar = (quem, id, alvo = () => app) => request(alvo()).post(`${ADMIN}/${id}/reenviar`).set('Cookie', cookie[quem]).send({});
  const cancelar = (quem, id) => request(app).post(`${ADMIN}/${id}/cancelar`).set('Cookie', cookie[quem]).send({});
  const listar = (quem) => request(app).get(`${ADMIN}?limite=100`).set('Cookie', cookie[quem]);
  const consultar = (token) => request(app).post('/api/convite-usuario/consultar').send({ token });
  const aceitar = (token, senha = SENHA_NOVA) => request(app).post('/api/convite-usuario/aceitar').send({ token, senha });
  const tokenDe = (resposta) => {
    const achado = LINK.exec(resposta.body.entrega.linkAceite);
    assert.ok(achado, resposta.body.entrega.linkAceite);
    return achado[1];
  };
  const linha = async (id) => (await q('SELECT * FROM convites_usuario WHERE id = $1', [id])).rows[0];
  const abertosDe = async (empresaId, emailConvite) => (await q(
    'SELECT id FROM convites_usuario WHERE empresa_id = $1 AND email_convite = $2 AND aceito_em IS NULL AND cancelado_em IS NULL AND expira_em > now()',
    [empresaId, emailConvite],
  )).rows;
  const auditorias = async (acao) => (await q('SELECT empresa_id, usuario_id, referencia, contexto, dados_novos FROM logs_auditoria WHERE acao = $1 ORDER BY id', [acao])).rows;

  /** Anda o relógio dos convites do par para trás, sem mexer na ordem criado_em < expira_em. */
  const envelhecer = (empresaId, emailConvite, intervalo = '3 minutes') => q(
    'UPDATE convites_usuario SET criado_em = criado_em - $3::interval, expira_em = expira_em - $3::interval WHERE empresa_id = $1 AND email_convite = $2',
    [empresaId, emailConvite, intervalo],
  );
  const expirar = (id) => q("UPDATE convites_usuario SET criado_em = now() - interval '10 days', expira_em = now() - interval '1 day' WHERE id = $1", [id]);

  async function criarConvite(quem, { perfil = 'USUARIO', nome = 'Pessoa Reenvio', prefixo = 'reenvio' } = {}) {
    const endereco = emailNovo(prefixo);
    const r = await convidar(quem, { email: endereco, nome, tipoConta: perfil });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.convite.id, email: endereco, token: tokenDe(r), resposta: r };
  }

  async function vinculo(chave, empresaId, perfil, { ativo = true } = {}) {
    email[chave] = `${chave.toLowerCase()}.reenvio@exemplo-cliente.com.br`;
    const identidade = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email[chave], hash])).rows[0].id;
    u[chave] = (await q(
      'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id, ativo) VALUES ($1, $2, NULL, NULL, $3, $4, $5) RETURNING id',
      [empresaId, chave, perfil, identidade, ativo],
    )).rows[0].id;
  }

  async function entrar(chave) {
    const login = await request(app).post('/api/auth/global/login').send({ email: email[chave], senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    cookie[chave] = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
  }

  const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
  function montarApp(entregar) {
    const exigirSessao = criarExigirSessao({ pool });
    const controller = entregar ? criarConviteUsuarioController({ pool, entregar }) : criarConviteUsuarioController({ pool });
    return criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao }),
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarConviteUsuarioRoutes({
          controller, exigirSessao, limitador: semLimite(), limitadorEnvio: semLimite(),
        }),
      );
    });
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    hash = await gerarHashSenha(SENHA);
    for (const [k, nome, cnpj] of [['A', 'Empresa Alfa Reenvio', '11222333000181'], ['B', 'Empresa Beta Reenvio', '22333444000100']]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
    }
    await vinculo('masterA', empresa.A, 'MASTER');
    await vinculo('admA', empresa.A, 'ADMINISTRADOR');
    await vinculo('adm2A', empresa.A, 'ADMINISTRADOR');
    await vinculo('usuA', empresa.A, 'USUARIO');
    await vinculo('masterB', empresa.B, 'MASTER');
    await q("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'GERENCIAR_USUARIOS', $3)", [empresa.A, u.admA, u.masterA]);

    app = montarApp();
    for (const chave of ['masterA', 'admA', 'adm2A', 'usuA', 'masterB']) await entrar(chave);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('o reenvio em si', () => {
    test('cancela o anterior e cria um novo com o mesmo e-mail, nome e perfil; o link antigo morre e o novo vale; só o hash fica no banco', async (t) => {
      const antigo = await criarConvite('masterA', { perfil: 'SUPERVISOR', nome: 'Pessoa Um' });
      await envelhecer(empresa.A, antigo.email);
      const saidas = [];
      for (const metodo of ['log', 'info', 'warn', 'error']) t.mock.method(console, metodo, (...a) => { saidas.push(JSON.stringify(a)); });

      const r = await reenviar('masterA', antigo.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.conviteAnteriorId, String(antigo.id));
      assert.notEqual(r.body.convite.id, antigo.id);
      assert.deepEqual(
        [r.body.convite.emailConvite, r.body.convite.nome, r.body.convite.perfil, r.body.convite.situacao],
        [antigo.email, 'Pessoa Um', 'SUPERVISOR', 'PENDENTE'],
      );
      const novoToken = tokenDe(r);
      assert.notEqual(novoToken, antigo.token);

      const anterior = await linha(antigo.id);
      assert.notEqual(anterior.cancelado_em, null, 'o anterior foi cancelado');
      const novo = await linha(r.body.convite.id);
      assert.deepEqual([novo.cancelado_em, novo.aceito_em, novo.criado_por], [null, null, u.masterA]);
      assert.equal(novo.token_hash, sha256(novoToken));
      assert.notEqual(novo.token_hash, anterior.token_hash);
      assert.ok(novo.expira_em > new Date(), 'validade nova');
      assert.equal(JSON.stringify(novo).includes(novoToken), false);

      const velho = await consultar(antigo.token);
      assert.deepEqual([velho.status, velho.body.codigo], [409, 'CONVITE_CANCELADO']);
      assert.deepEqual([(await aceitar(antigo.token)).status, (await aceitar(antigo.token)).body.codigo], [409, 'CONVITE_CANCELADO']);
      const vivo = await consultar(novoToken);
      assert.deepEqual([vivo.status, vivo.body.situacao, vivo.body.emailConvite], [200, 'PENDENTE', antigo.email]);

      assert.equal((await abertosDe(empresa.A, antigo.email)).length, 1);
      const lista = await listar('masterA');
      assert.equal(lista.body.convites.some((c) => c.id === String(antigo.id)), false, 'o cancelado sai da lista de abertos');
      assert.equal(lista.body.convites.some((c) => c.id === r.body.convite.id), true);

      const texto = saidas.join('\n');
      for (const segredo of [antigo.token, novoToken, antigo.email]) assert.equal(texto.includes(segredo), false, 'segredo no console');
    });

    test('auditoria do reenvio: ação própria, ator da sessão, aponta para o novo e o anterior, sem e-mail, nome, token ou hash', async () => {
      const antigo = await criarConvite('masterA');
      await envelhecer(empresa.A, antigo.email);
      const r = await reenviar('masterA', antigo.id);
      assert.equal(r.status, 201);
      const registros = (await auditorias('USUARIO_CONVITE_REENVIADO')).filter((a) => a.referencia === r.body.convite.id);
      assert.equal(registros.length, 1);
      const [a] = registros;
      assert.deepEqual([a.empresa_id, a.usuario_id], [empresa.A, u.masterA]);
      assert.deepEqual(a.dados_novos, { conviteId: r.body.convite.id, conviteAnteriorId: String(antigo.id) });
      const texto = JSON.stringify(a);
      for (const segredo of [antigo.email, 'Pessoa Reenvio', antigo.token, tokenDe(r), sha256(antigo.token), sha256(tokenDe(r))]) {
        assert.equal(texto.includes(segredo), false);
      }
    });

    test('convite expirado também pode ser reenviado', async () => {
      const antigo = await criarConvite('masterA');
      await expirar(antigo.id);
      assert.equal((await consultar(antigo.token)).body.codigo, 'CONVITE_EXPIRADO');
      const r = await reenviar('masterA', antigo.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.notEqual((await linha(antigo.id)).cancelado_em, null);
      assert.equal((await consultar(tokenDe(r))).status, 200);
      assert.equal((await abertosDe(empresa.A, antigo.email)).length, 1);
    });

    test('convite já aceito ou já cancelado: 409 CONVITE_NAO_REENVIAVEL e nada é criado', async () => {
      const cancelado = await criarConvite('masterA');
      assert.equal((await cancelar('masterA', cancelado.id)).status, 200);
      const aceito = await criarConvite('masterA');
      assert.equal((await aceitar(aceito.token)).status, 201);

      for (const alvo of [cancelado, aceito]) {
        const antes = (await q('SELECT count(*)::int AS n FROM convites_usuario WHERE empresa_id = $1 AND email_convite = $2', [empresa.A, alvo.email])).rows[0].n;
        const r = await reenviar('masterA', alvo.id);
        assert.deepEqual([r.status, r.body.codigo], [409, 'CONVITE_NAO_REENVIAVEL']);
        assert.equal((await q('SELECT count(*)::int AS n FROM convites_usuario WHERE empresa_id = $1 AND email_convite = $2', [empresa.A, alvo.email])).rows[0].n, antes);
      }
    });

    test('e-mail que já virou usuário da empresa depois do convite: 409 e o convite que valia não é cancelado', async () => {
      const antigo = await criarConvite('masterA');
      const identidade = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [antigo.email, hash])).rows[0].id;
      await q("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Criado por fora', NULL, NULL, 'USUARIO', $2)", [empresa.A, identidade]);
      await envelhecer(empresa.A, antigo.email);
      const r = await reenviar('masterA', antigo.id);
      assert.deepEqual([r.status, r.body.codigo], [409, 'USUARIO_VINCULO_EXISTENTE']);
      assert.equal((await linha(antigo.id)).cancelado_em, null);
    });

    test('convite expirado substituído por outro em aberto para o mesmo e-mail: 409 CONVITE_JA_PENDENTE, sem um segundo em aberto', async () => {
      const primeiro = await criarConvite('masterA');
      await expirar(primeiro.id);
      const segundo = await convidar('masterA', { email: primeiro.email, nome: 'Segundo', tipoConta: 'USUARIO' });
      assert.equal(segundo.status, 201, JSON.stringify(segundo.body));
      await envelhecer(empresa.A, primeiro.email);
      const r = await reenviar('masterA', primeiro.id);
      assert.deepEqual([r.status, r.body.codigo], [409, 'CONVITE_JA_PENDENTE']);
      assert.equal((await abertosDe(empresa.A, primeiro.email)).length, 1);
    });
  });

  describe('quem pode e em qual empresa', () => {
    test('convite de outra empresa e convite inexistente respondem igual (404); a outra empresa não é tocada', async () => {
      const deA = await criarConvite('masterA');
      await envelhecer(empresa.A, deA.email);
      const deOutra = await reenviar('masterB', deA.id);
      const inexistente = await reenviar('masterB', '999999999');
      assert.deepEqual([deOutra.status, inexistente.status], [404, 404]);
      assert.deepEqual(deOutra.body, inexistente.body);
      assert.equal((await linha(deA.id)).cancelado_em, null);
    });

    test('ADMINISTRADOR autorizado reenvia SUPERVISOR e USUARIO; não reenvia convite de ADMINISTRADOR nem de MASTER (403)', async () => {
      const sup = await criarConvite('masterA', { perfil: 'SUPERVISOR' });
      const adm = await criarConvite('masterA', { perfil: 'ADMINISTRADOR' });
      await envelhecer(empresa.A, sup.email);
      await envelhecer(empresa.A, adm.email);
      assert.equal((await reenviar('admA', sup.id)).status, 201);
      const negado = await reenviar('admA', adm.id);
      assert.deepEqual([negado.status, negado.body.codigo], [403, 'USUARIO_PERFIL_NAO_PERMITIDO']);
      assert.equal((await linha(adm.id)).cancelado_em, null);
    });

    test('sem autorização de gerenciar usuários, sem ser administrador ou sem sessão: 403, 403 e 401; corpo e identificador inválidos: 400', async () => {
      const alvo = await criarConvite('masterA');
      await envelhecer(empresa.A, alvo.email);
      for (const quem of ['adm2A', 'usuA']) {
        const r = await reenviar(quem, alvo.id);
        assert.deepEqual([r.status, r.body.codigo], [403, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA'], quem);
      }
      assert.equal((await request(app).post(`${ADMIN}/${alvo.id}/reenviar`).send({})).status, 401);
      assert.equal((await request(app).post(`${ADMIN}/abc/reenviar`).set('Cookie', cookie.masterA).send({})).status, 400);
      assert.equal((await request(app).post(`${ADMIN}/${alvo.id}/reenviar`).set('Cookie', cookie.masterA).send({ empresaId: empresa.B })).status, 400);
      assert.equal((await linha(alvo.id)).cancelado_em, null);
    });
  });

  describe('teto de envios por (empresa, e-mail)', () => {
    test('reenviar de novo em menos de 60 segundos: 429 com Retry-After, e o convite que vale continua pendente', async () => {
      const alvo = await criarConvite('masterA');
      const r = await reenviar('masterA', alvo.id);
      assert.deepEqual([r.status, r.body.codigo], [429, 'CONVITE_ENVIO_MUITO_RECENTE']);
      const espera = Number(r.headers['retry-after']);
      assert.ok(Number.isInteger(espera) && espera >= 1 && espera <= 60, r.headers['retry-after']);
      assert.equal((await linha(alvo.id)).cancelado_em, null);
      assert.equal((await abertosDe(empresa.A, alvo.email)).length, 1);
    });

    test('cancelar e convidar de novo logo em seguida não contorna o teto; passados os 60 segundos, passa', async () => {
      const alvo = await criarConvite('masterA');
      assert.equal((await cancelar('masterA', alvo.id)).status, 200);
      const logo = await convidar('masterA', { email: alvo.email, nome: 'Outra vez', tipoConta: 'USUARIO' });
      assert.deepEqual([logo.status, logo.body.codigo], [429, 'CONVITE_ENVIO_MUITO_RECENTE']);
      await envelhecer(empresa.A, alvo.email);
      const depois = await convidar('masterA', { email: alvo.email, nome: 'Outra vez', tipoConta: 'USUARIO' });
      assert.equal(depois.status, 201, JSON.stringify(depois.body));
    });

    test('cinco convites em 24 horas: o sexto, por reenvio ou por criação, é recusado (429 diário); quando o mais antigo sai da janela, volta a passar', async () => {
      const primeiro = await criarConvite('masterA');
      let atual = primeiro;
      for (let i = 0; i < 4; i += 1) {
        await envelhecer(empresa.A, primeiro.email);
        const r = await reenviar('masterA', atual.id);
        assert.equal(r.status, 201, `reenvio ${i + 1}: ${JSON.stringify(r.body)}`);
        atual = { ...atual, id: r.body.convite.id };
      }
      assert.equal((await q('SELECT count(*)::int AS n FROM convites_usuario WHERE empresa_id = $1 AND email_convite = $2', [empresa.A, primeiro.email])).rows[0].n, 5);

      await envelhecer(empresa.A, primeiro.email);
      const sexto = await reenviar('masterA', atual.id);
      assert.deepEqual([sexto.status, sexto.body.codigo], [429, 'CONVITE_ENVIO_LIMITE_DIARIO']);
      assert.ok(Number(sexto.headers['retry-after']) > 60, 'a espera é a do mais antigo sair da janela');
      assert.equal((await abertosDe(empresa.A, primeiro.email)).length, 1, 'o convite em aberto continua um só');

      await cancelar('masterA', atual.id);
      const criar = await convidar('masterA', { email: primeiro.email, nome: 'Sexto', tipoConta: 'USUARIO' });
      assert.deepEqual([criar.status, criar.body.codigo], [429, 'CONVITE_ENVIO_LIMITE_DIARIO']);

      await envelhecer(empresa.A, primeiro.email, '25 hours');
      const liberado = await convidar('masterA', { email: primeiro.email, nome: 'Depois da janela', tipoConta: 'USUARIO' });
      assert.equal(liberado.status, 201, JSON.stringify(liberado.body));
    });

    test('o teto é por e-mail: outro e-mail da mesma empresa e o mesmo e-mail em outra empresa não são afetados', async () => {
      const alvo = await criarConvite('masterA');
      assert.equal((await reenviar('masterA', alvo.id)).status, 429);
      const outroEmail = await convidar('masterA', { email: emailNovo('independente'), nome: 'Outro', tipoConta: 'USUARIO' });
      assert.equal(outroEmail.status, 201);
      const outraEmpresa = await convidar('masterB', { email: alvo.email, nome: 'Mesmo e-mail, outra empresa', tipoConta: 'USUARIO' });
      assert.equal(outraEmpresa.status, 201, JSON.stringify(outraEmpresa.body));
    });
  });

  describe('concorrência', () => {
    test('dois reenvios simultâneos do mesmo convite: um 201 e um 409, um único convite em aberto', async () => {
      const alvo = await criarConvite('masterA');
      await envelhecer(empresa.A, alvo.email);
      const respostas = await Promise.all([reenviar('masterA', alvo.id), reenviar('masterA', alvo.id), reenviar('admA', alvo.id)]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [201, 409, 409], JSON.stringify(respostas.map((r) => r.body)));
      assert.ok(respostas.filter((r) => r.status === 409).every((r) => r.body.codigo === 'CONVITE_NAO_REENVIAVEL'));
      assert.equal((await abertosDe(empresa.A, alvo.email)).length, 1);
    });

    test('reenviar e aceitar ao mesmo tempo: só um vence; nunca há vínculo criado por um link cancelado nem dois convites em aberto', async () => {
      const alvo = await criarConvite('masterA');
      await envelhecer(empresa.A, alvo.email);
      const [reenvio, aceite] = await Promise.all([reenviar('masterA', alvo.id), aceitar(alvo.token)]);
      const vinculos = (await q('SELECT count(*)::int AS n FROM usuarios u JOIN identidades i ON i.id = u.identidade_id WHERE u.empresa_id = $1 AND i.email = $2', [empresa.A, alvo.email])).rows[0].n;
      const anterior = await linha(alvo.id);
      if (aceite.status === 201) {
        assert.deepEqual([reenvio.status, reenvio.body.codigo], [409, 'CONVITE_NAO_REENVIAVEL']);
        assert.deepEqual([vinculos, anterior.cancelado_em === null], [1, true]);
        assert.equal((await abertosDe(empresa.A, alvo.email)).length, 0);
      } else {
        assert.equal(reenvio.status, 201, JSON.stringify([reenvio.body, aceite.body]));
        assert.deepEqual([aceite.status, aceite.body.codigo], [409, 'CONVITE_CANCELADO']);
        assert.deepEqual([vinculos, anterior.cancelado_em !== null], [0, true]);
        assert.equal((await abertosDe(empresa.A, alvo.email)).length, 1);
      }
    });

    test('reenviar e cancelar ao mesmo tempo: exatamente um 2xx e o estado final é coerente', async () => {
      const alvo = await criarConvite('masterA');
      await envelhecer(empresa.A, alvo.email);
      const [reenvio, cancelamento] = await Promise.all([reenviar('masterA', alvo.id), cancelar('masterA', alvo.id)]);
      assert.equal([reenvio, cancelamento].filter((r) => r.status >= 200 && r.status < 300).length, 1, JSON.stringify([reenvio.body, cancelamento.body]));
      assert.notEqual((await linha(alvo.id)).cancelado_em, null);
      assert.equal((await abertosDe(empresa.A, alvo.email)).length, reenvio.status === 201 ? 1 : 0);
    });

    test('criar e reenviar ao mesmo tempo para o mesmo e-mail: o reenvio vence e a criação encontra convite em aberto (409)', async () => {
      const alvo = await criarConvite('masterA');
      await envelhecer(empresa.A, alvo.email);
      const [reenvio, criacao] = await Promise.all([
        reenviar('masterA', alvo.id),
        convidar('admA', { email: alvo.email, nome: 'Concorrente', tipoConta: 'USUARIO' }),
      ]);
      assert.equal(reenvio.status, 201, JSON.stringify(reenvio.body));
      assert.deepEqual([criacao.status, criacao.body.codigo], [409, 'CONVITE_JA_PENDENTE']);
      assert.equal((await abertosDe(empresa.A, alvo.email)).length, 1);
    });
  });

  describe('entrega', () => {
    const preparar = (entrega) => {
      const chamadas = [];
      const appInjetado = montarApp(async (dados) => { chamadas.push(dados); return entrega(dados); });
      return { chamadas, alvo: () => appInjetado };
    };

    test('com e-mail enviado de verdade: a resposta não traz link nem token, e a entrega recebe o convite novo como reenvio', async () => {
      const antigo = await criarConvite('masterA');
      await envelhecer(empresa.A, antigo.email);
      const { chamadas, alvo } = preparar(async (d) => ({ modo: 'EMAIL', estado: 'ENVIADO', expiraEm: d.expiraEm }));
      const r = await reenviar('masterA', antigo.id, alvo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal('linkAceite' in r.body.entrega, false);
      assert.equal(JSON.stringify(r.body).includes('token'), false);
      assert.equal(chamadas.length, 1);
      assert.equal(chamadas[0].reenvio, true);
      assert.equal(chamadas[0].conviteId, r.body.convite.id);
      assert.match(chamadas[0].token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal((await linha(r.body.convite.id)).token_hash, sha256(chamadas[0].token));
    });

    test('falha no envio: 201, o convite novo fica pendente e pode ser reenviado depois', async () => {
      const antigo = await criarConvite('masterA');
      await envelhecer(empresa.A, antigo.email);
      const { alvo } = preparar(async (d) => ({ modo: 'EMAIL', estado: 'FALHA', expiraEm: d.expiraEm }));
      const r = await reenviar('masterA', antigo.id, alvo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.entrega.estado, 'FALHA');
      assert.equal((await abertosDe(empresa.A, antigo.email)).length, 1);
      await envelhecer(empresa.A, antigo.email);
      assert.equal((await reenviar('masterA', r.body.convite.id)).status, 201);
    });

    test('production sem provedor de e-mail real: 503 antes de gravar, nada cancelado, nada criado', async (t) => {
      const antigo = await criarConvite('masterA');
      await envelhecer(empresa.A, antigo.email);
      const original = entregaConviteUsuario.exigirDisponivel;
      t.mock.method(entregaConviteUsuario, 'exigirDisponivel', () => original('production', 'desativado'));
      t.mock.method(console, 'error', () => {});
      const r = await reenviar('masterA', antigo.id);
      assert.deepEqual([r.status, r.body.codigo], [503, 'CONVITE_ENTREGA_INDISPONIVEL']);
      assert.equal('entrega' in r.body, false);
      assert.equal((await linha(antigo.id)).cancelado_em, null);
      assert.equal((await q('SELECT count(*)::int AS n FROM convites_usuario WHERE empresa_id = $1 AND email_convite = $2', [empresa.A, antigo.email])).rows[0].n, 1);
    });
  });

  describe('atomicidade com falha real no meio do reenvio', () => {
    const contagem = async (emailConvite) => (await q('SELECT count(*)::int AS n FROM convites_usuario WHERE empresa_id = $1 AND email_convite = $2', [empresa.A, emailConvite])).rows[0].n;
    const reenvios = async () => (await auditorias('USUARIO_CONVITE_REENVIADO')).length;

    test('se a criação do convite novo falhar depois do cancelamento, o cancelamento é desfeito: o anterior continua pendente e nada fica gravado', async (t) => {
      const antigo = await criarConvite('masterA');
      await envelhecer(empresa.A, antigo.email);
      const auditoriasAntes = await reenvios();
      t.mock.method(console, 'error', () => {});
      const original = conviteRepo.criar;
      t.mock.method(conviteRepo, 'criar', async (...args) => {
        const cancelado = await linha(antigo.id);
        assert.equal(cancelado.cancelado_em, null, 'a leitura fora da transação ainda enxerga o anterior pendente');
        await original(...args);
        throw new Error('falha simulada depois do INSERT');
      });

      const r = await reenviar('masterA', antigo.id);
      assert.equal(r.status, 500);
      assert.equal(JSON.stringify(r.body).includes('simulada'), false, 'a mensagem interna não vai ao cliente');
      assert.equal((await linha(antigo.id)).cancelado_em, null, 'o cancelamento foi desfeito');
      assert.equal(await contagem(antigo.email), 1, 'o INSERT do novo também foi desfeito');
      assert.equal(await reenvios(), auditoriasAntes);
      assert.equal((await consultar(antigo.token)).status, 200, 'o link antigo continua valendo');
    });

    test('se a auditoria falhar, nada do reenvio fica: nem o cancelamento nem o convite novo', async (t) => {
      const antigo = await criarConvite('masterA');
      await envelhecer(empresa.A, antigo.email);
      t.mock.method(console, 'error', () => {});
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada na auditoria'); });
      const r = await reenviar('masterA', antigo.id);
      assert.equal(r.status, 500);
      assert.equal((await linha(antigo.id)).cancelado_em, null);
      assert.equal(await contagem(antigo.email), 1);
      assert.equal((await abertosDe(empresa.A, antigo.email)).length, 1);
    });
  });

  describe('trava consultiva do par (empresa, e-mail)', () => {
    test('reenviar convite expirado e criar ao mesmo tempo para o mesmo e-mail: em 8 rodadas, nunca há dois convites em aberto', async () => {
      for (let rodada = 0; rodada < 8; rodada += 1) {
        const expirado = await criarConvite('masterA', { prefixo: 'corrida' });
        await expirar(expirado.id);
        const respostas = await Promise.all([
          reenviar('masterA', expirado.id),
          convidar('admA', { email: expirado.email, nome: 'Concorrente', tipoConta: 'USUARIO' }),
          reenviar('admA', expirado.id),
        ]);
        const aprovadas = respostas.filter((r) => r.status === 201).length;
        assert.equal(aprovadas, 1, `rodada ${rodada}: ${JSON.stringify(respostas.map((r) => [r.status, r.body.codigo]))}`);
        assert.ok(respostas.filter((r) => r.status !== 201).every((r) => r.status === 409), `rodada ${rodada}`);
        assert.equal((await abertosDe(empresa.A, expirado.email)).length, 1, `rodada ${rodada}`);
      }
    });
  });

  describe('entrega SMTP de production (transporte e serviço reais, nodemailer substituído)', () => {
    const SENHA_SMTP = 'senhaSmtpFicticiaParaTeste42';
    const USUARIO_SMTP = 'usuarioSmtpFicticio';

    function entregaDeProducao(enviar) {
      const enviadas = [];
      const config = carregarConfigEmail({
        EMAIL_MODO: 'smtp', SMTP_HOST: 'smtp.exemplo-provedor.test', SMTP_USUARIO: USUARIO_SMTP, SMTP_SENHA: SENHA_SMTP,
      });
      const transporte = criarSmtp(config, { criarTransporteNodemailer: () => ({ sendMail: async (mensagem) => { enviadas.push(mensagem); return enviar(mensagem); }, close() {} }) });
      const servico = criarServicoEmail({ transporte });
      const entregar = (dados) => entregaConviteUsuario.entregar(dados, { servico, ambiente: 'production', config });
      return { enviadas, alvo: () => montarApp(entregar) };
    }
    const aceita = async (mensagem) => ({ accepted: [mensagem.envelope.to[0]], rejected: [] });
    const tokenDoEmail = (mensagem) => /#token=([A-Za-z0-9_-]{43})/.exec(mensagem.text)[1];

    test('o e-mail leva o link e o token novos; a resposta HTTP não traz link nem token; o banco guarda só o hash', async (t) => {
      const antigo = await criarConvite('masterA');
      await envelhecer(empresa.A, antigo.email);
      const { enviadas, alvo } = entregaDeProducao(aceita);
      const saidas = [];
      for (const metodo of ['log', 'info', 'warn', 'error']) t.mock.method(console, metodo, (...a) => { saidas.push(JSON.stringify(a)); });

      const r = await reenviar('masterA', antigo.id, alvo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.entrega.modo, r.body.entrega.estado], ['EMAIL', 'ENVIADO']);
      assert.equal('linkAceite' in r.body.entrega, false);
      assert.equal(enviadas.length, 1);
      assert.equal(enviadas[0].to, antigo.email);
      const novoToken = tokenDoEmail(enviadas[0]);
      assert.notEqual(novoToken, antigo.token);
      assert.equal(JSON.stringify(r.body).includes(novoToken), false, 'token na resposta HTTP');
      assert.equal((await linha(r.body.convite.id)).token_hash, sha256(novoToken));
      assert.equal((await consultar(novoToken)).status, 200);
      assert.equal((await consultar(antigo.token)).body.codigo, 'CONVITE_CANCELADO');
      assert.equal(saidas.join('\n').includes(novoToken), false, 'token no console');
    });

    test('provedor recusa: 201 com estado FALHA, o convite novo fica pendente, e o log não leva e-mail, token, link nem texto do provedor', async (t) => {
      const antigo = await criarConvite('masterA');
      await envelhecer(empresa.A, antigo.email);
      const erroDoProvedor = Object.assign(new Error(`550 5.1.1 <${antigo.email}> rejeitado por smtp-interno.exemplo.net com ${SENHA_SMTP}`), { code: 'EENVELOPE' });
      const { enviadas, alvo } = entregaDeProducao(async () => { throw erroDoProvedor; });
      const saidas = [];
      for (const metodo of ['log', 'info', 'warn', 'error']) t.mock.method(console, metodo, (...a) => { saidas.push(JSON.stringify(a)); });

      const r = await reenviar('masterA', antigo.id, alvo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.entrega.estado, 'FALHA');
      assert.equal('linkAceite' in r.body.entrega, false);
      assert.equal((await abertosDe(empresa.A, antigo.email)).length, 1, 'o convite novo segue pendente');
      const token = tokenDoEmail(enviadas[0]);
      assert.equal((await consultar(token)).status, 200, 'e pode ser reenviado depois');
      const texto = saidas.join('\n');
      assert.match(texto, /entrega_falhou/);
      for (const sensivel of [antigo.email, token, antigo.token, '#token=', 'smtp-interno', SENHA_SMTP, USUARIO_SMTP, 'aceitar-convite']) {
        assert.equal(texto.includes(sensivel), false, `o log contém ${sensivel}`);
      }
    });

    test('criar convite também não devolve link em production com SMTP real', async () => {
      const { enviadas, alvo } = entregaDeProducao(aceita);
      const endereco = emailNovo('smtp.criar');
      const r = await convidar('masterA', { email: endereco, nome: 'Por E-mail', tipoConta: 'USUARIO' }, alvo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal('linkAceite' in r.body.entrega, false);
      assert.equal(enviadas.length, 1);
      assert.equal(JSON.stringify(r.body).includes(tokenDoEmail(enviadas[0])), false);
    });
  });

  test('nenhuma auditoria guarda token, hash, senha ou cookie dos reenvios', async () => {
    const { rows } = await q("SELECT contexto, dados_anteriores, dados_novos, referencia FROM logs_auditoria WHERE acao IN ('USUARIO_CONVIDADO', 'USUARIO_CONVITE_CANCELADO', 'USUARIO_CONVITE_REENVIADO')");
    const texto = JSON.stringify(rows);
    const { rows: hashes } = await q('SELECT token_hash FROM convites_usuario');
    for (const { token_hash: h } of hashes) assert.equal(texto.includes(h), false, 'hash do token na auditoria');
    assert.doesNotMatch(texto, /senha|argon|token|cookie|authorization/i);
  });
});
