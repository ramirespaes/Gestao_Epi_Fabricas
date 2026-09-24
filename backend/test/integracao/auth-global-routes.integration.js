'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarAuthPlataformaController } = require('../../src/controllers/auth-plataforma.controller');
const { criarAuthPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const { criarGrupoAcessoController } = require('../../src/controllers/grupo-acesso.controller');
const { criarGrupoAcessoRoutes } = require('../../src/routes/grupo-acesso.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const { criarInicial } = require('../../src/services/administrador-plataforma.service');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const { assertSemSensiveis } = require('../helpers/sensiveis');

/**
 * Pacote 4 — LOGIN GLOBAL DO PORTAL DO CLIENTE, ponta a ponta, contra
 * PostgreSQL real (schema temporário exclusivo com TODAS as migrations,
 * 000-038, removido em cascata ao final). Nenhum mock: rotas, controllers,
 * serviços e repositórios REAIS, montados pelas mesmas fábricas de
 * produção com pool/limitador exclusivos deste arquivo.
 *
 * Cobre a lista obrigatória da seção 13 do pacote: login válido, senha
 * inválida, e-mail inexistente, cooldown, identidade inativa, zero/uma/
 * várias empresas, seleção correta e não autorizada, empresa inativa,
 * vínculo inativo, troca de empresa, sessão anterior revogada, logout
 * empresarial, logout global, sessão expirada, identidade inativada com
 * sessões existentes, permissões MASTER e de outros perfis (RBAC
 * inalterado), isolamento entre empresas, isolamento do Painel Privado,
 * cookies distintos, e a recusa do login legado para vínculos do modelo
 * global. CSRF/CORS/Origin da montagem real estão em test/app.test.js.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 39 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-do-portal-2026';
const SENHA_ERRADA = 'senha-errada-do-portal-2026';
const SENHA_ADMIN = 'planeta-nebulosa-ozonio-42';
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL, cookieNomeAdmin: C_ADMIN } = authConfig.sessao;

const ANA = 'ana@exemplo-cliente.com.br';        // A (MASTER) + B (USUARIO)
const BRUNO = 'bruno@exemplo-cliente.com.br';    // C (ADMINISTRADOR) — uma só empresa
const CARLA = 'carla@exemplo-cliente.com.br';    // nenhuma empresa
const DORA = 'dora@exemplo-cliente.com.br';      // identidade INATIVA, vínculo em A
const EVA = 'eva@exemplo-cliente.com.br';        // vínculo legado (email+senha_hash em usuarios) ligado a identidade
const FABIO = 'fabio@exemplo-cliente.com.br';    // uma empresa (B); usado no cenário "identidade inativada com sessões"
const COOL = 'cooldown@exemplo-cliente.com.br';  // só para o cooldown
const GIL = 'gil@exemplo-cliente.com.br';        // sessões anteriores preservadas em tentativas malsucedidas (C)

/** Set-Cookie -> { nome: { valor, removido } } */
function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par, ...atributos] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = {
      valor: par.slice(i + 1),
      removido: atributos.some((a) => /^\s*max-age=0\s*$/i.test(a)),
      httpOnly: atributos.some((a) => /^\s*httponly\s*$/i.test(a)),
    };
  }
  return saida;
}
const par = (nome, valor) => `${nome}=${valor}`;

describe('Portal do Cliente — login global, seleção de empresa e sessões (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let hash;
  const empresa = {};
  const usuario = {};
  const identidade = {};

  const login = (email, senha = SENHA, cookies = '') => {
    const req = request(app).post('/api/auth/global/login');
    if (cookies) req.set('Cookie', cookies);
    return req.send({ email, senha });
  };
  const me = (cookies) => request(app).get('/api/auth/global/me').set('Cookie', cookies);
  const meEmpresarial = (cookies) => request(app).get('/api/auth/me').set('Cookie', cookies);
  const selecionar = (cookies, empresaId) => request(app).post(`/api/auth/global/empresas/${empresaId}/selecionar`).set('Cookie', cookies);
  const sessaoGlobalDe = async (email) => (await pool.query('SELECT s.id, s.revogada_em, s.motivo_revogacao FROM sessoes_globais s JOIN identidades i ON i.id = s.identidade_id WHERE lower(i.email) = $1 ORDER BY s.id DESC LIMIT 1', [email])).rows[0];
  const sessoesEmpresariaisDe = async (email) => (await pool.query('SELECT s.id, s.empresa_id, s.autenticado_via, s.sessao_global_id, s.revogada_em, s.motivo_revogacao FROM sessoes s JOIN usuarios u ON u.empresa_id = s.empresa_id AND u.id = s.usuario_id JOIN identidades i ON i.id = u.identidade_id WHERE lower(i.email) = $1 ORDER BY s.id', [email])).rows;
  const tentativasDe = async (email) => (await pool.query('SELECT sucesso, motivo, identidade_id FROM login_tentativas_globais t LEFT JOIN identidades i ON i.id = t.identidade_id WHERE t.identidade_id IS NULL OR lower(i.email) = $1 ORDER BY t.id', [email])).rows;

  /** Login que precisa dar certo; devolve os cookies emitidos. */
  async function entrar(email) {
    const r = await login(email);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { corpo: r.body, cookies: cookiesDe(r) };
  }

  before(async () => {
    hash = await gerarHashSenha(SENHA);
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    const exigirSessaoGlobal = criarExigirSessaoGlobal({ pool });
    const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao }),
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal }),
        criarGrupoAcessoRoutes({ controller: criarGrupoAcessoController({ pool }), exigirSessao }),
      );
      a.use('/api/plataforma', criarAuthPlataformaRoutes({ controller: criarAuthPlataformaController({ pool }), limitador: semLimite(), exigirSessaoPlataforma }));
    });

    for (const [chave, nome, cnpj] of [['A', 'Empresa A', '11222333000181'], ['B', 'Empresa B', '22333444000100'], ['C', 'Empresa C', '33444555000119']]) {
      const { rows } = await pool.query('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj]);
      empresa[chave] = rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[chave], dryRun: false });
    }
    for (const [chave, email, ativo] of [['ana', ANA, true], ['bruno', BRUNO, true], ['carla', CARLA, true], ['dora', DORA, false], ['eva', EVA, true], ['fabio', FABIO, true], ['cool', COOL, true], ['gil', GIL, true]]) {
      const { rows } = await pool.query('INSERT INTO identidades (email, senha_hash, ativo) VALUES ($1, $2, $3) RETURNING id', [email, hash, ativo]);
      identidade[chave] = rows[0].id;
    }
    const vinculo = async (chave, empresaId, identidadeId, perfil) => {
      const { rows } = await pool.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id", [empresaId, `Pessoa ${chave}`, perfil, identidadeId]);
      usuario[chave] = rows[0].id;
    };
    await vinculo('anaA', empresa.A, identidade.ana, 'MASTER');
    await vinculo('anaB', empresa.B, identidade.ana, 'USUARIO');
    await vinculo('brunoC', empresa.C, identidade.bruno, 'ADMINISTRADOR');
    await vinculo('doraA', empresa.A, identidade.dora, 'USUARIO');
    await vinculo('fabioB', empresa.B, identidade.fabio, 'USUARIO');
    await vinculo('coolC', empresa.C, identidade.cool, 'USUARIO');
    await vinculo('gilC', empresa.C, identidade.gil, 'USUARIO');
    // Vínculo "legado" (email + senha_hash em usuarios) que FOI ligado a uma identidade.
    const { rows: eva } = await pool.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Eva', $2, $3, 'USUARIO', $4) RETURNING id", [empresa.C, EVA, hash, identidade.eva]);
    usuario.evaC = eva[0].id;
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('login global', () => {
    test('uma empresa autorizada (cenário A): 200, seleção automática, DOIS cookies HttpOnly com nomes distintos, corpo sem token/hash/senha', async () => {
      const r = await login(BRUNO);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body).sort(), ['contexto', 'empresas', 'identidade', 'status']);
      assert.deepEqual(r.body.identidade, { id: identidade.bruno, email: BRUNO });
      assert.deepEqual(r.body.empresas, [{ id: empresa.C, nome: 'Empresa C', cnpj: '33444555000119', perfil: 'ADMINISTRADOR' }]);
      assert.equal(r.body.contexto.empresa.id, empresa.C);
      assert.deepEqual(r.body.contexto.usuario, { id: usuario.brunoC, nome: 'Pessoa brunoC', email: BRUNO, perfil: 'ADMINISTRADOR' });

      const c = cookiesDe(r);
      assert.deepEqual(Object.keys(c).sort(), [C_EMPRESA, C_GLOBAL].sort());
      assert.equal(C_ADMIN in c, false);
      assert.ok(c[C_GLOBAL].httpOnly && c[C_EMPRESA].httpOnly);
      assert.match(c[C_GLOBAL].valor, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(c[C_GLOBAL].valor, c[C_EMPRESA].valor);
      assertSemSensiveis(r.text, [c[C_GLOBAL].valor, c[C_EMPRESA].valor, SENHA, 'senha_hash', 'token_hash'], 'corpo do login');

      const [s] = await sessoesEmpresariaisDe(BRUNO);
      assert.equal(s.autenticado_via, 'SESSAO_GLOBAL');
      assert.equal(s.sessao_global_id, (await sessaoGlobalDe(BRUNO)).id);
      const t = await tentativasDe(BRUNO);
      assert.deepEqual(t.filter((x) => x.identidade_id === identidade.bruno).map((x) => [x.sucesso, x.motivo]), [[true, null]]);

      // A sessão empresarial criada funciona nas rotas de negócio de sempre.
      const meE = await meEmpresarial(par(C_EMPRESA, c[C_EMPRESA].valor));
      assert.deepEqual([meE.status, meE.body.empresa.id, meE.body.usuario.email], [200, empresa.C, BRUNO]);
    });

    test('várias empresas (cenário B): 200, lista ordenada, contexto null, cookie global emitido e cookie empresarial REMOVIDO', async () => {
      const r = await login(ANA);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.empresas.map((e) => [e.id, e.perfil]), [[empresa.A, 'MASTER'], [empresa.B, 'USUARIO']]);
      assert.equal(r.body.contexto, null);
      const c = cookiesDe(r);
      assert.equal(c[C_GLOBAL].removido, false);
      assert.equal(c[C_EMPRESA].removido, true, 'nenhum cookie empresarial antigo pode sobreviver a um login sem contexto');
      assert.equal((await sessoesEmpresariaisDe(ANA)).length, 0, 'nada foi selecionado por conta própria');
    });

    test('nenhuma empresa (cenário C): 200 com empresas [] e contexto null; a sessão global existe mas NÃO dá acesso operacional', async () => {
      const r = await login(CARLA);
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.empresas, r.body.contexto], [[], null]);
      const c = cookiesDe(r);
      const meG = await me(par(C_GLOBAL, c[C_GLOBAL].valor));
      assert.deepEqual([meG.status, meG.body.empresas, meG.body.contexto], [200, [], null]);
      const meE = await meEmpresarial(par(C_GLOBAL, c[C_GLOBAL].valor));
      assert.equal(meE.status, 401, 'o cookie global nunca autentica uma rota empresarial');
      const grupos = await request(app).get('/api/grupos-acesso').set('Cookie', par(C_GLOBAL, c[C_GLOBAL].valor));
      assert.equal(grupos.status, 401);
      const escolha = await selecionar(par(C_GLOBAL, c[C_GLOBAL].valor), empresa.A);
      assert.deepEqual([escolha.status, escolha.body.codigo], [403, 'EMPRESA_NAO_AUTORIZADA'], 'não há como escolher uma empresa arbitrária');
    });

    test('senha inválida e e-mail inexistente: 401 idêntico (anti-enumeração); motivos distintos só na tabela; nenhuma sessão criada', async () => {
      const senha = await login(ANA, SENHA_ERRADA);
      const inexistente = await login('ninguem@exemplo-cliente.com.br');
      assert.equal(senha.status, 401);
      assert.deepEqual(senha.body, inexistente.body);
      assert.deepEqual(senha.body, { status: 'error', codigo: 'CREDENCIAIS_INVALIDAS', message: 'E-mail ou senha inválidos' });
      assert.equal('set-cookie' in senha.headers, false);
      const t = await tentativasDe(ANA);
      assert.ok(t.some((x) => x.motivo === 'SENHA_INVALIDA' && x.identidade_id === identidade.ana));
      assert.ok(t.some((x) => x.motivo === 'IDENTIDADE_INEXISTENTE' && x.identidade_id === null));
    });

    test('identidade inativa: 401 genérico, motivo IDENTIDADE_INATIVA, sem sessão', async () => {
      const r = await login(DORA);
      assert.deepEqual([r.status, r.body.codigo], [401, 'CREDENCIAIS_INVALIDAS']);
      assert.ok((await tentativasDe(DORA)).some((x) => x.motivo === 'IDENTIDADE_INATIVA'));
      assert.equal(await sessaoGlobalDe(DORA), undefined);
    });

    test('cooldown: após N falhas a tentativa seguinte recebe 429 com Retry-After, sem verificar senha nem criar linha nova', async () => {
      const limiar = authConfig.cooldown.niveis[0].falhas;
      for (let i = 0; i < limiar; i += 1) {
        assert.equal((await login(COOL, SENHA_ERRADA)).status, 401);
      }
      const antes = (await tentativasDe(COOL)).length;
      const bloqueado = await login(COOL, SENHA);
      assert.deepEqual([bloqueado.status, bloqueado.body.codigo], [429, 'LOGIN_EM_COOLDOWN']);
      assert.ok(Number(bloqueado.headers['retry-after']) >= 1);
      assert.equal((await tentativasDe(COOL)).length, antes, 'durante o cooldown nenhuma linha nova é gravada');
      assert.equal(await sessaoGlobalDe(COOL), undefined, 'a senha correta não abriu sessão durante o cooldown');
    });

    test('login legado por CNPJ NUNCA autentica um vínculo do modelo global, nem com usuarios.senha_hash correto (motivo VINCULO_MODELO_GLOBAL)', async () => {
      const r = await request(app).post('/api/auth/login').send({ cnpj: '33444555000119', email: EVA, senha: SENHA });
      assert.deepEqual([r.status, r.body.codigo], [401, 'CREDENCIAIS_INVALIDAS']);
      const { rows } = await pool.query('SELECT motivo FROM login_tentativas WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1', [usuario.evaC]);
      assert.equal(rows[0].motivo, 'VINCULO_MODELO_GLOBAL');
      // ... e o login GLOBAL da mesma pessoa funciona: uma única credencial válida.
      const global = await login(EVA);
      assert.equal(global.status, 200);
      assert.equal(global.body.contexto.usuario.email, EVA, 'e-mail vem da identidade (fonte de verdade), não da coluna legada');
    });

    test('um login novo revoga a sessão global e a empresarial que o navegador já trazia (NOVO_LOGIN_GLOBAL), mesmo de outra pessoa', async () => {
      const bruno = await entrar(BRUNO);
      const cookiesAntigos = `${par(C_GLOBAL, bruno.cookies[C_GLOBAL].valor)}; ${par(C_EMPRESA, bruno.cookies[C_EMPRESA].valor)}`;
      const r = await login(ANA, SENHA, cookiesAntigos);
      assert.equal(r.status, 200);
      const g = await sessaoGlobalDe(BRUNO);
      assert.equal(g.motivo_revogacao, 'NOVO_LOGIN_GLOBAL');
      assert.equal((await sessoesEmpresariaisDe(BRUNO)).at(-1).motivo_revogacao, 'NOVO_LOGIN_GLOBAL');
      assert.equal((await me(par(C_GLOBAL, bruno.cookies[C_GLOBAL].valor))).status, 401);
      assert.equal((await meEmpresarial(par(C_EMPRESA, bruno.cookies[C_EMPRESA].valor))).status, 401);
    });
  });

  describe('tentativa de login NÃO derruba sessões válidas (correção pós-auditoria, item 1)', () => {
    /** Estado das duas sessões anteriores, pelo cookie (HTTP) e pelo banco. */
    async function estadoAnterior(cookies) {
      const g = await me(par(C_GLOBAL, cookies[C_GLOBAL].valor));
      const e = await meEmpresarial(par(C_EMPRESA, cookies[C_EMPRESA].valor));
      return [g.status, e.status];
    }
    const cabecalho = (cookies) => `${par(C_GLOBAL, cookies[C_GLOBAL].valor)}; ${par(C_EMPRESA, cookies[C_EMPRESA].valor)}`;

    test('A. senha incorreta com sessão global e empresarial válidas no navegador: 401, sem Set-Cookie, as duas continuam válidas e nada é revogado', async () => {
      const gil = await entrar(GIL);
      assert.deepEqual(await estadoAnterior(gil.cookies), [200, 200]);

      const r = await login(GIL, SENHA_ERRADA, cabecalho(gil.cookies));
      assert.deepEqual([r.status, r.body.codigo, 'set-cookie' in r.headers], [401, 'CREDENCIAIS_INVALIDAS', false]);
      assert.deepEqual(await estadoAnterior(gil.cookies), [200, 200]);
      assert.equal((await sessaoGlobalDe(GIL)).revogada_em, null);
      assert.equal((await sessoesEmpresariaisDe(GIL)).at(-1).revogada_em, null);

      // Com os cookies de OUTRA pessoa, senha errada também não derruba nada.
      const alheio = await login(BRUNO, SENHA_ERRADA, cabecalho(gil.cookies));
      assert.equal(alheio.status, 401);
      assert.deepEqual(await estadoAnterior(gil.cookies), [200, 200]);
    });

    test('B. tentativa durante cooldown (429): a sessão anterior continua válida', async () => {
      const gil = await entrar(GIL);
      const limiar = authConfig.cooldown.niveis[0].falhas;
      for (let i = 0; i < limiar; i += 1) {
        assert.equal((await login(GIL, SENHA_ERRADA, cabecalho(gil.cookies))).status, 401);
      }
      const r = await login(GIL, SENHA, cabecalho(gil.cookies));
      assert.deepEqual([r.status, r.body.codigo, 'set-cookie' in r.headers], [429, 'LOGIN_EM_COOLDOWN', false]);
      assert.deepEqual(await estadoAnterior(gil.cookies), [200, 200], 'nem as falhas nem o 429 revogaram a sessão já aberta');
      assert.equal((await sessaoGlobalDe(GIL)).revogada_em, null);
    });

    test('C. login bem-sucedido de OUTRA identidade: as sessões anteriores são revogadas (NOVO_LOGIN_GLOBAL) e deixam de valer', async () => {
      const ana = await entrar(ANA);
      const e = cookiesDe(await selecionar(par(C_GLOBAL, ana.cookies[C_GLOBAL].valor), empresa.A))[C_EMPRESA].valor;
      const anteriores = { [C_GLOBAL]: ana.cookies[C_GLOBAL], [C_EMPRESA]: { valor: e } };
      assert.deepEqual(await estadoAnterior(anteriores), [200, 200]);

      const r = await login(BRUNO, SENHA, cabecalho(anteriores));
      assert.equal(r.status, 200);
      assert.deepEqual(await estadoAnterior(anteriores), [401, 401]);
      assert.equal((await sessaoGlobalDe(ANA)).motivo_revogacao, 'NOVO_LOGIN_GLOBAL');
      assert.equal((await sessoesEmpresariaisDe(ANA)).at(-1).motivo_revogacao, 'NOVO_LOGIN_GLOBAL');
      const novos = cookiesDe(r);
      assert.deepEqual(await estadoAnterior(novos), [200, 200], 'as sessões do novo login valem');
    });

    test('D. login bem-sucedido da MESMA identidade: as anteriores são substituídas pelas novas', async () => {
      const antes = await entrar(BRUNO);
      const idGlobalAntes = (await sessaoGlobalDe(BRUNO)).id;
      const r = await login(BRUNO, SENHA, cabecalho(antes.cookies));
      assert.equal(r.status, 200);
      const depois = cookiesDe(r);
      assert.notEqual(depois[C_GLOBAL].valor, antes.cookies[C_GLOBAL].valor);
      assert.notEqual(depois[C_EMPRESA].valor, antes.cookies[C_EMPRESA].valor);
      assert.deepEqual(await estadoAnterior(antes.cookies), [401, 401]);
      assert.deepEqual(await estadoAnterior(depois), [200, 200]);
      const { rows } = await pool.query('SELECT motivo_revogacao FROM sessoes_globais WHERE id = $1', [idGlobalAntes]);
      assert.equal(rows[0].motivo_revogacao, 'NOVO_LOGIN_GLOBAL');
    });

    test('falha REAL depois de criar a sessão global (seleção automática quebra no banco): 500 sem cookie, sessão global nova revogada (LOGIN_INCOMPLETO), nenhuma empresarial viva dela, e as sessões anteriores preservadas', async (t) => {
      const gil = await entrar(ANA); // sessões anteriores de outra pessoa, válidas
      const eAna = cookiesDe(await selecionar(par(C_GLOBAL, gil.cookies[C_GLOBAL].valor), empresa.A))[C_EMPRESA].valor;
      const anteriores = { [C_GLOBAL]: gil.cookies[C_GLOBAL], [C_EMPRESA]: { valor: eAna } };
      const { rows: antes } = await pool.query('SELECT coalesce(max(id), 0) AS id FROM sessoes_globais');

      t.mock.method(console, 'error', () => {});
      t.mock.method(sessaoRepo, 'criar', async () => { const e = new Error('falha simulada ao gravar a sessão empresarial'); e.code = '08006'; throw e; });

      const r = await login(BRUNO, SENHA, cabecalho(anteriores)); // Bruno tem UMA empresa: seleção automática
      t.mock.restoreAll();

      assert.deepEqual([r.status, r.body.codigo, 'set-cookie' in r.headers], [500, 'ERRO_INTERNO', false]);
      const { rows: criadas } = await pool.query('SELECT s.id, s.revogada_em IS NOT NULL AS revogada, s.motivo_revogacao, i.email FROM sessoes_globais s JOIN identidades i ON i.id = s.identidade_id WHERE s.id > $1', [antes[0].id]);
      assert.equal(criadas.length, 1, 'a autenticação chegou a criar (e commitar) a sessão global');
      assert.deepEqual([criadas[0].email, criadas[0].revogada, criadas[0].motivo_revogacao], [BRUNO, true, 'LOGIN_INCOMPLETO']);
      const { rows: vivas } = await pool.query('SELECT count(*)::int AS total FROM sessoes WHERE sessao_global_id = $1 AND revogada_em IS NULL', [criadas[0].id]);
      assert.equal(vivas[0].total, 0);
      assert.deepEqual(await estadoAnterior(anteriores), [200, 200], 'nada foi substituído: o login não se concluiu');

      // Sem a falha, o mesmo login funciona normalmente.
      assert.equal((await login(BRUNO)).status, 200);
    });
  });

  describe('seleção e troca de empresa', () => {
    test('seleção correta: cookie empresarial emitido, sessão SESSAO_GLOBAL ligada à global; /me mostra o contexto; RBAC: MASTER em A lista grupos (200)', async () => {
      const ana = await entrar(ANA);
      const g = par(C_GLOBAL, ana.cookies[C_GLOBAL].valor);
      const r = await selecionar(g, empresa.A);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body).sort(), ['empresa', 'status', 'usuario']);
      assert.deepEqual(r.body.usuario, { id: usuario.anaA, nome: 'Pessoa anaA', email: ANA, perfil: 'MASTER' });
      const c = cookiesDe(r);
      assert.deepEqual(Object.keys(c), [C_EMPRESA]);
      assertSemSensiveis(r.text, [c[C_EMPRESA].valor], 'corpo da seleção');
      const e = par(C_EMPRESA, c[C_EMPRESA].valor);

      // Só as sessões nascidas DESTE login (outros testes podem deixar sessões
      // antigas da mesma pessoa válidas de propósito — ver "tentativa de login
      // NÃO derruba sessões válidas").
      const globalAtual = (await sessaoGlobalDe(ANA)).id;
      const nascidas = (await sessoesEmpresariaisDe(ANA)).filter((x) => x.sessao_global_id === globalAtual && x.revogada_em === null);
      assert.equal(nascidas.length, 1);
      assert.deepEqual([nascidas[0].empresa_id, nascidas[0].autenticado_via], [empresa.A, 'SESSAO_GLOBAL']);

      const meG = await me(`${g}; ${e}`);
      assert.equal(meG.body.contexto.empresa.id, empresa.A);
      const grupos = await request(app).get('/api/grupos-acesso').set('Cookie', e);
      assert.equal(grupos.status, 200, 'MASTER de A: permissões de sempre, decididas pelo RBAC existente');
    });

    test('empresa não autorizada (sem vínculo) ou inexistente: 403 genérico idêntico, nenhuma sessão criada, sessão anterior preservada', async () => {
      const ana = await entrar(ANA);
      const g = par(C_GLOBAL, ana.cookies[C_GLOBAL].valor);
      const antes = (await sessoesEmpresariaisDe(ANA)).length;
      const semVinculo = await selecionar(g, empresa.C);
      const inexistente = await selecionar(g, 999999);
      assert.deepEqual([semVinculo.status, semVinculo.body.codigo], [403, 'EMPRESA_NAO_AUTORIZADA']);
      assert.deepEqual(semVinculo.body, inexistente.body);
      assert.equal('set-cookie' in semVinculo.headers, false);
      assert.equal((await sessoesEmpresariaisDe(ANA)).length, antes);
      const invalido = await selecionar(g, 'abc');
      assert.deepEqual([invalido.status, invalido.body.codigo], [400, 'VALIDACAO']);
    });

    test('troca de empresa: a sessão anterior é revogada (TROCA_EMPRESA) e não pode ser reutilizada; a nova vale; permissões recarregadas (USUARIO em B recebe 403 nos grupos)', async () => {
      const ana = await entrar(ANA);
      const g = par(C_GLOBAL, ana.cookies[C_GLOBAL].valor);
      const emA = cookiesDe(await selecionar(g, empresa.A))[C_EMPRESA].valor;
      assert.equal((await request(app).get('/api/grupos-acesso').set('Cookie', par(C_EMPRESA, emA))).status, 200);

      const troca = await selecionar(`${g}; ${par(C_EMPRESA, emA)}`, empresa.B);
      assert.equal(troca.status, 200, JSON.stringify(troca.body));
      assert.equal(troca.body.empresa.id, empresa.B);
      const emB = cookiesDe(troca)[C_EMPRESA].valor;
      assert.notEqual(emA, emB);

      const antiga = await meEmpresarial(par(C_EMPRESA, emA));
      assert.deepEqual([antiga.status, antiga.body.codigo], [401, 'SESSAO_INVALIDA'], 'a sessão anterior não pode ser reutilizada');
      const sessoes = await sessoesEmpresariaisDe(ANA);
      assert.equal(sessoes.find((s) => s.empresa_id === empresa.A && s.motivo_revogacao === 'TROCA_EMPRESA') !== undefined, true);
      const globalAtual = (await sessaoGlobalDe(ANA)).id;
      assert.equal(sessoes.filter((s) => s.revogada_em === null && s.sessao_global_id === globalAtual).length, 1, 'uma única sessão empresarial viva por sessão global');

      const nova = await meEmpresarial(par(C_EMPRESA, emB));
      assert.deepEqual([nova.status, nova.body.empresa.id, nova.body.usuario.perfil], [200, empresa.B, 'USUARIO']);
      const grupos = await request(app).get('/api/grupos-acesso').set('Cookie', par(C_EMPRESA, emB));
      assert.equal(grupos.status, 403, 'USUARIO em B: o MASTER de A não leva autoridade para B');
    });

    test('concorrência: duas seleções SIMULTÂNEAS do mesmo login global (duas abas, A e B) terminam com exatamente UMA sessão empresarial viva', async () => {
      const ana = await entrar(ANA);
      const g = par(C_GLOBAL, ana.cookies[C_GLOBAL].valor);
      const resultados = await Promise.all([selecionar(g, empresa.A), selecionar(g, empresa.B)]);
      assert.deepEqual(resultados.map((r) => r.status), [200, 200], 'as duas são legítimas; o lock só as serializa');
      const globalAtual = (await sessaoGlobalDe(ANA)).id;
      const vivas = (await sessoesEmpresariaisDe(ANA)).filter((s) => s.sessao_global_id === globalAtual && s.revogada_em === null);
      assert.equal(vivas.length, 1, 'a seleção que chegou por último revogou a outra (TROCA_EMPRESA)');
      const validas = await Promise.all(resultados.map((r) => meEmpresarial(par(C_EMPRESA, cookiesDe(r)[C_EMPRESA].valor))));
      assert.deepEqual(validas.map((r) => r.status).sort(), [200, 401]);
    });

    test('isolamento entre empresas: dado criado por MASTER em A não aparece (nem é acessível) com a sessão de B', async () => {
      const ana = await entrar(ANA);
      const g = par(C_GLOBAL, ana.cookies[C_GLOBAL].valor);
      const emA = par(C_EMPRESA, cookiesDe(await selecionar(g, empresa.A))[C_EMPRESA].valor);
      const criado = await request(app).post('/api/grupos-acesso').set('Cookie', emA).send({ nome: 'Almoxarifado A', descricao: 'só da empresa A' });
      assert.equal(criado.status, 201, JSON.stringify(criado.body));
      const { rows } = await pool.query('SELECT empresa_id FROM grupos_acesso WHERE id = $1', [criado.body.grupo.id]);
      assert.equal(rows[0].empresa_id, empresa.A);

      const emB = par(C_EMPRESA, cookiesDe(await selecionar(`${g}; ${emA}`, empresa.B))[C_EMPRESA].valor);
      const deB = await request(app).get(`/api/grupos-acesso/${criado.body.grupo.id}`).set('Cookie', emB);
      assert.notEqual(deB.status, 200, 'a sessão de B nunca alcança um grupo de A');
    });
  });

  describe('revogação e encerramento', () => {
    test('empresa suspensa: some da lista, seleção recusada, sessão empresarial dela revogada (EMPRESA_INATIVADA); outras empresas e a sessão global intactas; reativar não restaura', async () => {
      const ana = await entrar(ANA);
      const g = par(C_GLOBAL, ana.cookies[C_GLOBAL].valor);
      const emB = par(C_EMPRESA, cookiesDe(await selecionar(g, empresa.B))[C_EMPRESA].valor);
      assert.equal((await meEmpresarial(emB)).status, 200);

      await pool.query('UPDATE empresas SET ativo = false WHERE id = $1', [empresa.B]);
      try {
        assert.deepEqual((await me(g)).body.empresas.map((e) => e.id), [empresa.A]);
        assert.deepEqual([(await selecionar(g, empresa.B)).status], [403]);
        assert.equal((await meEmpresarial(emB)).status, 401);
        assert.equal((await sessoesEmpresariaisDe(ANA)).find((s) => s.empresa_id === empresa.B && s.motivo_revogacao === 'EMPRESA_INATIVADA') !== undefined, true);
        assert.equal((await selecionar(g, empresa.A)).status, 200, 'A continua acessível');
      } finally {
        await pool.query('UPDATE empresas SET ativo = true WHERE id = $1', [empresa.B]);
      }
      assert.equal((await meEmpresarial(emB)).status, 401, 'reativar a empresa não restaura a sessão revogada');
      assert.equal((await selecionar(g, empresa.B)).status, 200, 'nova seleção volta a funcionar');
    });

    test('vínculo inativado: só aquela empresa cai (USUARIO_INATIVADO); reativar não restaura a sessão; nova seleção funciona', async () => {
      const ana = await entrar(ANA);
      const g = par(C_GLOBAL, ana.cookies[C_GLOBAL].valor);
      const emA = par(C_EMPRESA, cookiesDe(await selecionar(g, empresa.A))[C_EMPRESA].valor);

      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [usuario.anaA]);
      try {
        assert.deepEqual((await me(g)).body.empresas.map((e) => e.id), [empresa.B]);
        assert.equal((await selecionar(g, empresa.A)).status, 403);
        assert.equal((await meEmpresarial(emA)).status, 401);
        assert.equal((await selecionar(g, empresa.B)).status, 200, 'B não é afetada');
        assert.equal((await me(g)).status, 200, 'a sessão global sobrevive');
      } finally {
        await pool.query('UPDATE usuarios SET ativo = true WHERE id = $1', [usuario.anaA]);
      }
      assert.equal((await meEmpresarial(emA)).status, 401, 'reativar o vínculo não restaura a sessão revogada');
      assert.equal((await sessoesEmpresariaisDe(ANA)).some((s) => s.motivo_revogacao === 'USUARIO_INATIVADO'), true);
      assert.equal((await selecionar(g, empresa.A)).status, 200);
    });

    test('sair da empresa (POST /auth/logout): revoga só a empresarial (LOGOUT); a global segue válida e permite reselecionar sem senha', async () => {
      const bruno = await entrar(BRUNO);
      const g = par(C_GLOBAL, bruno.cookies[C_GLOBAL].valor);
      const e = par(C_EMPRESA, bruno.cookies[C_EMPRESA].valor);
      const saida = await request(app).post('/api/auth/logout').set('Cookie', `${g}; ${e}`);
      assert.equal(saida.status, 200);
      const c = cookiesDe(saida);
      assert.deepEqual([Object.keys(c), c[C_EMPRESA].removido], [[C_EMPRESA], true]);
      assert.equal((await meEmpresarial(e)).status, 401);
      const meG = await me(g);
      assert.deepEqual([meG.status, meG.body.contexto], [200, null]);
      assert.equal((await selecionar(g, empresa.C)).status, 200, 'sem digitar a senha de novo');
    });

    test('sair completamente (POST /auth/global/logout): revoga a global (LOGOUT) e as empresariais nascidas dela (LOGOUT_GLOBAL); remove os dois cookies; login novo exigido', async () => {
      const bruno = await entrar(BRUNO);
      const g = par(C_GLOBAL, bruno.cookies[C_GLOBAL].valor);
      const e = par(C_EMPRESA, bruno.cookies[C_EMPRESA].valor);
      const saida = await request(app).post('/api/auth/global/logout').set('Cookie', `${g}; ${e}`);
      assert.equal(saida.status, 200);
      const c = cookiesDe(saida);
      assert.deepEqual(Object.keys(c).sort(), [C_EMPRESA, C_GLOBAL].sort());
      assert.ok(c[C_EMPRESA].removido && c[C_GLOBAL].removido);
      assert.equal((await me(g)).status, 401);
      assert.equal((await meEmpresarial(e)).status, 401);
      assert.equal((await selecionar(g, empresa.C)).status, 401);
      assert.equal((await sessaoGlobalDe(BRUNO)).motivo_revogacao, 'LOGOUT');
      assert.equal((await sessoesEmpresariaisDe(BRUNO)).at(-1).motivo_revogacao, 'LOGOUT_GLOBAL', 'nascida da global: revogada em cascata pela saída completa');
      // idempotente
      assert.equal((await request(app).post('/api/auth/global/logout').set('Cookie', `${g}; ${e}`)).status, 200);
      assert.equal((await request(app).post('/api/auth/global/logout')).status, 200);
    });

    test('sessão global expirada (absoluta ou por inatividade): 401; a empresarial ainda válida não é derrubada por isso', async () => {
      const bruno = await entrar(BRUNO);
      const g = par(C_GLOBAL, bruno.cookies[C_GLOBAL].valor);
      const e = par(C_EMPRESA, bruno.cookies[C_EMPRESA].valor);
      const { id } = await sessaoGlobalDe(BRUNO);
      await pool.query("UPDATE sessoes_globais SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 minute' WHERE id = $1", [id]);
      assert.equal((await me(g)).status, 401);
      assert.equal((await selecionar(g, empresa.C)).status, 401);
      assert.equal((await meEmpresarial(e)).status, 200, 'contrato de sessoes inalterado: sua validade não depende da global');

      const fabio = await entrar(FABIO);
      const g2 = par(C_GLOBAL, fabio.cookies[C_GLOBAL].valor);
      await pool.query("UPDATE sessoes_globais SET ultimo_uso_em = now() - ($2 * interval '1 minute') - interval '1 minute' WHERE id = $1", [(await sessaoGlobalDe(FABIO)).id, authConfig.sessao.inatividadeMinutos]);
      assert.equal((await me(g2)).status, 401, 'inatividade');
    });

    test('identidade inativada com sessões existentes: global E empresarial caem juntas (IDENTIDADE_INATIVADA), login recusado', async () => {
      const fabio = await entrar(FABIO);
      const g = par(C_GLOBAL, fabio.cookies[C_GLOBAL].valor);
      const e = par(C_EMPRESA, fabio.cookies[C_EMPRESA].valor);
      assert.equal((await meEmpresarial(e)).status, 200);

      await pool.query('UPDATE identidades SET ativo = false WHERE id = $1', [identidade.fabio]);
      assert.equal((await me(g)).status, 401);
      assert.equal((await meEmpresarial(e)).status, 401);
      assert.equal((await sessaoGlobalDe(FABIO)).motivo_revogacao, 'IDENTIDADE_INATIVADA');
      assert.equal((await sessoesEmpresariaisDe(FABIO)).at(-1).motivo_revogacao, 'IDENTIDADE_INATIVADA');
      assert.equal((await login(FABIO)).status, 401);
    });
  });

  describe('isolamento do Painel Privado e dos cookies', () => {
    test('cookie global/empresarial nunca autenticam na plataforma; cookie administrativo nunca autentica no Portal; os três nomes são distintos', async () => {
      await criarInicial(pool, { email: 'admin@safework.com.br', senha: SENHA_ADMIN });
      const adm = await request(app).post('/api/plataforma/auth/login').send({ email: 'admin@safework.com.br', senha: SENHA_ADMIN });
      assert.equal(adm.status, 200);
      const cAdmin = cookiesDe(adm)[C_ADMIN].valor;
      const bruno = await entrar(BRUNO);
      const g = bruno.cookies[C_GLOBAL].valor;
      const e = bruno.cookies[C_EMPRESA].valor;

      assert.equal(new Set([C_GLOBAL, C_EMPRESA, C_ADMIN]).size, 3);
      assert.equal((await request(app).get('/api/plataforma/auth/me').set('Cookie', `${par(C_GLOBAL, g)}; ${par(C_EMPRESA, e)}`)).status, 401);
      assert.equal((await me(par(C_ADMIN, cAdmin))).status, 401);
      assert.equal((await meEmpresarial(par(C_ADMIN, cAdmin))).status, 401);
      // O valor do token global usado sob o NOME administrativo (ou vice-versa) também não vale nada.
      assert.equal((await request(app).get('/api/plataforma/auth/me').set('Cookie', par(C_ADMIN, g))).status, 401);
      assert.equal((await me(par(C_GLOBAL, cAdmin))).status, 401);
    });

    test('/auth/global/me ignora um cookie empresarial de OUTRA identidade (não o apresenta como contexto)', async () => {
      const bruno = await entrar(BRUNO);
      const ana = await entrar(ANA);
      const r = await me(`${par(C_GLOBAL, ana.cookies[C_GLOBAL].valor)}; ${par(C_EMPRESA, bruno.cookies[C_EMPRESA].valor)}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.identidade.email, ANA);
      assert.equal(r.body.contexto, null);
    });
  });
});
