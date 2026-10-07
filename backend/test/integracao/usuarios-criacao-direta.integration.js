'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarEmpresa } = require('./helpers/entrega-epi');
const { todasAsMigrations } = require('./helpers/recuperacao-senha');
const { capturarEntrega } = require('./helpers/recuperacao-senha-servico');
const { fabricaPortal } = require('./helpers/troca-senha');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { cpfFicticio } = require('../helpers/cpf-ficticio');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarUsuarioAdministracaoRoutes } = require('../../src/routes/usuario-administracao.routes');
const { criarUsuarioAdministracaoController } = require('../../src/controllers/usuario-administracao.controller');
const { criarTrocaSenhaGlobalRoutes } = require('../../src/routes/troca-senha.routes');
const { criarTrocaSenhaGlobalController } = require('../../src/controllers/troca-senha.controller');
const { criarContaRoutes } = require('../../src/routes/conta.routes');
const { criarContaController } = require('../../src/controllers/conta.controller');
const { criarRecuperacaoSenhaPortalRoutes } = require('../../src/routes/recuperacao-senha.routes');
const { criarRecuperacaoSenhaController } = require('../../src/controllers/recuperacao-senha.controller');
const { criarTurnstileController } = require('../../src/controllers/turnstile.controller');
const { criarExigirTurnstile } = require('../../src/middleware/turnstile');
const { criarValidadorTurnstile } = require('../../src/security/turnstile');
const entrega = require('../../src/services/entrega-recuperacao-senha.service');
const password = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const senhaProvisoriaUtil = require('../../src/utils/senha-provisoria');

/**
 * Gestão de Usuários — criação DIRETA de usuário com senha PROVISÓRIA e
 * troca obrigatória no primeiro acesso, pela camada HTTP, contra PostgreSQL
 * real em schema temporário com todas as migrations (inclusive a 074).
 *
 * O primeiro MASTER continua nascendo no Painel Privado (convite por
 * e-mail); os demais usuários nascem aqui, na empresa da sessão, sem nenhum
 * e-mail automático. Enquanto a senha provisória valer, o servidor recusa
 * tudo exceto a própria sessão, a troca de senha e o logout.
 */

const ROTA = '/api/administracao/usuarios';
const LOGIN = '/api/auth/global/login';
const ME_GLOBAL = '/api/auth/global/me';
const ME = '/api/auth/me';
const TROCAR = '/api/auth/global/senha';
const CONTA = '/api/auth/global/conta';
const SOLICITAR = '/api/auth/global/recuperacao-senha/solicitar';
const REDEFINIR = '/api/auth/global/recuperacao-senha/redefinir';
const { cookieNomeGlobal: NOME_GLOBAL, cookieNome: NOME_EMPRESA } = authConfig.sessao;

const SENHA_PROVISORIA = 'cometa-lanterna-ardosia-77';
const SENHA_NOVA = 'girassol-quartzo-bussola-58';
const ACAO_RECUPERACAO = 'portal_recuperacao_senha';
const TOKEN_RECUPERACAO = 'YYYY.DUMMY.RECUPERACAO.YYYY';
const HORA = 3_600_000;

async function siteverifyRecuperacao(url, opcoes) {
  const aprovado = new URLSearchParams(opcoes.body).get('response') === TOKEN_RECUPERACAO;
  const corpo = aprovado ? { success: true, 'error-codes': [], hostname: 'localhost', action: ACAO_RECUPERACAO } : { success: false, 'error-codes': ['invalid-input-response'] };
  return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Gestão de Usuários — criação direta com senha provisória e troca obrigatória (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let hashAtual;
  let portal;
  const empresas = {};
  let sequencia = 0;

  const um = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const todos = async (sql, p) => (await pool.query(sql, p)).rows;
  const cookie = (c) => [`${NOME_GLOBAL}=${c.global.token}`, ...(c.empresarial ? [`${NOME_EMPRESA}=${c.empresarial.token}`] : [])].join('; ');
  const cookiesDe = (r) => Object.fromEntries((r.headers['set-cookie'] ?? []).map((c) => c.split(';')[0].split('=')));
  const deCookies = (jar) => Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  const criar = (c, corpo) => request(app).post(ROTA).set('Cookie', cookie(c)).set('User-Agent', 'Agente de Teste').send(corpo);
  const login = (email, senha) => request(app).post(LOGIN).set('User-Agent', 'Agente de Teste').send({ email, senha, turnstileToken: TOKEN_TURNSTILE_TESTE });
  const identidadeDe = (email) => um('SELECT id, senha_hash, ativo, senha_provisoria, senha_provisoria_definida_em, senha_provisoria_expira_em FROM identidades WHERE lower(email) = lower($1)', [email]);
  const novoEmail = () => { sequencia += 1; return `Pessoa.Direta.${sequencia}@Example.invalid`; };
  // Usuário administrativo (05/10/2026): CPF, matrícula e setor passaram a ser obrigatórios na criação.
  const adm = () => { sequencia += 1; return { cpf: cpfFicticio(500 + sequencia), matricula: `D-${sequencia}`, setor: 'Administrativo' }; };
  const semSegredos = (texto, extras = []) => {
    for (const s of [SENHA_PROVISORIA, SENHA_NOVA, hashAtual, 'senha_hash', 'senhaHash', '$argon2', ...extras]) assert.equal(String(texto).includes(s), false, `contém ${String(s).slice(0, 10)}…`);
  };

  async function contaDaEmpresa(empresaId, perfil = 'MASTER') {
    const identidade = await portal.novaIdentidade();
    const usuarioId = await portal.vincular(identidade, empresaId, perfil);
    const global = await portal.entrar(identidade);
    const empresarial = await portal.selecionar(identidade, global, empresaId);
    return { identidade, usuarioId, empresaId, global, empresarial };
  }
  async function administradorAutorizado(empresaId, master) {
    const c = await contaDaEmpresa(empresaId, 'ADMINISTRADOR');
    await pool.query("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'GERENCIAR_USUARIOS', $3)", [empresaId, c.usuarioId, master.usuarioId]);
    return c;
  }

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    hashAtual = await password.gerarHashSenha('planeta-nebulosa-ozonio-42');
    portal = fabricaPortal({ pool, hashSenha: hashAtual });
    empresas.A = await criarEmpresa(pool, '11222333000181', 'Empresa Alfa');
    empresas.B = await criarEmpresa(pool, '11444777000161', 'Empresa Beta');
    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirGlobal = criarExigirSessaoGlobal({ pool });
    const exigirGlobalComProvisoria = criarExigirSessaoGlobal({ pool, permitirSenhaProvisoria: true });
    const exigirEmpresarial = criarExigirSessao({ pool });
    const validadorRecuperacao = criarValidadorTurnstile({
      secretKey: 'segredo-ficticio-das-suites', acao: ACAO_RECUPERACAO, hostnamesPermitidos: ['localhost'], modoTeste: false, timeoutMs: 1000, fetch: siteverifyRecuperacao,
    });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthGlobalRoutes({
          controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: exigirGlobal, exigirSessaoGlobalMe: exigirGlobalComProvisoria, ...turnstileDeTeste(),
        }),
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao: exigirEmpresarial }),
        criarUsuarioAdministracaoRoutes({ controller: criarUsuarioAdministracaoController({ pool }), exigirSessao: exigirEmpresarial }),
        criarTrocaSenhaGlobalRoutes({ controller: criarTrocaSenhaGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: exigirGlobalComProvisoria }),
        criarContaRoutes({ controller: criarContaController({ pool }), limitadorEmail: semLimite(), exigirSessaoGlobal: exigirGlobal }),
        criarRecuperacaoSenhaPortalRoutes({
          controller: criarRecuperacaoSenhaController({ pool, escopo: 'PORTAL' }),
          limitadorSolicitar: semLimite(),
          limitadorRedefinir: semLimite(),
          exigirTurnstile: criarExigirTurnstile({ validador: validadorRecuperacao }),
          turnstileController: criarTurnstileController({ siteKey: '1x00000000000000000000AA', acao: ACAO_RECUPERACAO }),
        }),
      );
    });
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('MASTER cria USUARIO: 201 sem senha nem hash; identidade com senha provisória, definida agora e válida por 48h ou 72h (sexta); usuário na empresa da sessão; auditoria sem segredo; nenhum e-mail', async (t) => {
    const caixa = capturarEntrega(t);
    const avisoEmail = t.mock.method(entrega, 'enfileirarAvisoEmailAlterado', () => {});
    const master = await contaDaEmpresa(empresas.A);
    const email = novoEmail();
    const antes = Date.now();

    const r = await criar(master, { nome: 'Pessoa Direta', email, tipoConta: 'USUARIO', senhaProvisoria: SENHA_PROVISORIA, ...adm() });

    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.usuario.nome, 'Pessoa Direta');
    assert.equal(r.body.usuario.email, email.toLowerCase());
    assert.deepEqual([r.body.usuario.perfil, r.body.usuario.ativo], ['USUARIO', true]);
    assert.match(r.body.senhaProvisoriaExpiraEm, /^\d{4}-\d{2}-\d{2}T/);
    semSegredos(JSON.stringify(r.body) + JSON.stringify(r.headers));

    const identidade = await identidadeDe(email);
    assert.equal(identidade.senha_provisoria, true);
    assert.equal(await password.verificarSenha(identidade.senha_hash, SENHA_PROVISORIA), true, 'hash Argon2id da provisória');
    const definida = identidade.senha_provisoria_definida_em.getTime();
    assert.ok(definida >= antes - 5000 && definida <= Date.now() + 5000, 'definida agora');
    const horas = senhaProvisoriaUtil.horasDeValidade(identidade.senha_provisoria_definida_em);
    assert.ok([48, 72].includes(horas));
    assert.equal(identidade.senha_provisoria_expira_em.getTime() - definida, horas * HORA, `validade de ${horas}h pelo dia da semana em São Paulo`);
    assert.equal(new Date(r.body.senhaProvisoriaExpiraEm).getTime(), identidade.senha_provisoria_expira_em.getTime());

    const usuario = await um('SELECT empresa_id, perfil, ativo, identidade_id, email, senha_hash, funcionario_id FROM usuarios WHERE id = $1', [r.body.usuario.id]);
    assert.deepEqual(usuario, { empresa_id: empresas.A, perfil: 'USUARIO', ativo: true, identidade_id: identidade.id, email: null, senha_hash: null, funcionario_id: null });

    const auditoria = await todos("SELECT acao, usuario_id, referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'USUARIO_CRIADO' AND referencia = $2", [empresas.A, String(r.body.usuario.id)]);
    assert.equal(auditoria.length, 1);
    assert.equal(auditoria[0].usuario_id, master.usuarioId, 'o ator é quem cadastrou');
    semSegredos(JSON.stringify(auditoria), [email.toLowerCase()]);
    assert.equal(auditoria[0].dados_novos.perfil, 'USUARIO');
    assert.equal(auditoria[0].dados_novos.origem, 'CRIACAO_DIRETA');
    assert.equal(auditoria[0].dados_novos.acessoProvisorioExpiraEm, identidade.senha_provisoria_expira_em.toISOString(), 'a validade entra na auditoria sob chave sem o segmento "senha" (gatilho da 014)');
    assert.equal(JSON.stringify(auditoria).toLowerCase().includes('senha'), false, 'nenhuma chave ou valor da auditoria menciona senha');

    assert.deepEqual([caixa.redefinicoes.length, caixa.avisos.length, avisoEmail.mock.calls.length], [0, 0, 0], 'ZERO e-mail na criação');
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'usuario-administracao.service.js'), 'utf8');
    assert.doesNotMatch(fonte, /require\(['"][^'"]*(email|entrega-recuperacao|convite)/, 'o serviço de criação não conhece a infraestrutura de e-mail');

    const lista = await request(app).get(ROTA).set('Cookie', cookie(master));
    assert.equal(lista.status, 200);
    const perfis = Object.fromEntries(lista.body.usuarios.map((u) => [u.id, u.perfil]));
    assert.equal(perfis[master.usuarioId], 'MASTER', 'o MASTER já aparece na listagem real');
    assert.equal(perfis[r.body.usuario.id], 'USUARIO');
  });

  test('autoridade e perfis: ADMINISTRADOR autorizado cria SUPERVISOR e USUARIO; não cria ADMINISTRADOR nem MASTER; sem autorização, SUPERVISOR e sem sessão são recusados; empresaId no corpo é recusado; a empresa é sempre a da sessão', async () => {
    const masterA = await contaDaEmpresa(empresas.A);
    const masterB = await contaDaEmpresa(empresas.B);
    const admin = await administradorAutorizado(empresas.A, masterA);
    const corpo = (tipoConta) => ({ nome: `Pessoa ${tipoConta}`, email: novoEmail(), tipoConta, senhaProvisoria: SENHA_PROVISORIA, ...adm() });

    for (const tipoConta of ['SUPERVISOR', 'USUARIO']) {
      const r = await criar(admin, corpo(tipoConta));
      assert.equal(r.status, 201, `${tipoConta}: ${JSON.stringify(r.body)}`);
      assert.equal((await um('SELECT empresa_id FROM usuarios WHERE id = $1', [r.body.usuario.id])).empresa_id, empresas.A);
    }
    for (const tipoConta of ['ADMINISTRADOR', 'MASTER']) {
      const r = await criar(admin, corpo(tipoConta));
      assert.deepEqual([r.status, r.body.codigo], [403, 'USUARIO_PERFIL_NAO_PERMITIDO'], tipoConta);
    }
    const masterCriaAdmin = await criar(masterA, corpo('ADMINISTRADOR'));
    assert.equal(masterCriaAdmin.status, 201, 'só o MASTER cria ADMINISTRADOR');

    const semAutorizacao = await contaDaEmpresa(empresas.A, 'ADMINISTRADOR');
    assert.deepEqual([(await criar(semAutorizacao, corpo('USUARIO'))).status, (await criar(semAutorizacao, corpo('USUARIO'))).body.codigo], [403, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA']);
    const supervisor = await contaDaEmpresa(empresas.A, 'SUPERVISOR');
    assert.equal((await criar(supervisor, corpo('USUARIO'))).status, 403, 'o nome do perfil não concede nada');
    assert.equal((await request(app).post(ROTA).send(corpo('USUARIO'))).status, 401);

    const comEmpresa = await criar(masterA, { ...corpo('USUARIO'), empresaId: empresas.B });
    assert.equal(comEmpresa.status, 400, 'empresa nunca vem do cliente');
    const totalAntesA = (await um('SELECT count(*)::int AS n FROM usuarios WHERE empresa_id = $1', [empresas.A])).n;
    const emB = await criar(masterB, corpo('USUARIO'));
    assert.equal(emB.status, 201);
    assert.equal((await um('SELECT empresa_id FROM usuarios WHERE id = $1', [emB.body.usuario.id])).empresa_id, empresas.B);
    assert.equal((await um('SELECT count(*)::int AS n FROM usuarios WHERE empresa_id = $1', [empresas.A])).n, totalAntesA, 'B nunca cria em A');
  });

  test('política de senha real e e-mail já existente: 400 com detalhes sem criar nada; 409 IDENTIDADE_EMAIL_JA_EXISTENTE sem sobrescrever a senha, sem identidade nova, sem vínculo e sem convite', async () => {
    const master = await contaDaEmpresa(empresas.A);
    const identidades = async () => (await um('SELECT count(*)::int AS n FROM identidades')).n;
    const usuarios = async () => (await um('SELECT count(*)::int AS n FROM usuarios')).n;
    const antes = [await identidades(), await usuarios()];

    const curta = await criar(master, { nome: 'Pessoa', email: novoEmail(), tipoConta: 'USUARIO', senhaProvisoria: 'curta', ...adm() });
    assert.equal(curta.status, 400, JSON.stringify(curta.body));
    assert.equal(curta.body.codigo, 'VALIDACAO');
    assert.ok(curta.body.detalhes.some((d) => d.codigo === 'SENHA_CURTA' && d.campo === 'body.senhaProvisoria'), JSON.stringify(curta.body.detalhes));
    const comEmail = await criar(master, { nome: 'Pessoa', email: 'joaquim.silva@example.invalid', tipoConta: 'USUARIO', senhaProvisoria: 'joaquim.silva-2026-forte', ...adm() });
    assert.equal(comEmail.status, 400, 'a política usa o e-mail como contexto');
    assert.deepEqual([await identidades(), await usuarios()], antes);

    const existente = master.identidade;
    const hashAntes = (await identidadeDe(existente.email)).senha_hash;
    const duplicado = await criar(master, { nome: 'Outra Pessoa', email: existente.email.toUpperCase(), tipoConta: 'USUARIO', senhaProvisoria: SENHA_PROVISORIA, ...adm() });
    assert.deepEqual([duplicado.status, duplicado.body.codigo], [409, 'IDENTIDADE_EMAIL_JA_EXISTENTE']);
    const depois = await identidadeDe(existente.email);
    assert.equal(depois.senha_hash, hashAntes, 'a senha de quem já existe não é tocada');
    assert.equal(depois.senha_provisoria, false);
    assert.deepEqual([await identidades(), await usuarios()], antes);
    assert.equal((await um('SELECT count(*)::int AS n FROM convites_usuario')).n, 0, 'nenhum convite é criado automaticamente');
    semSegredos(JSON.stringify(duplicado.body));
  });

  test('primeiro login com a provisória válida: autentica com trocaSenhaObrigatoria=true; tudo é recusado com 403 TROCA_SENHA_OBRIGATORIA exceto a sessão própria e a troca; depois da troca o estado é limpo, a provisória morre e a nova senha entra normalmente', async () => {
    const master = await contaDaEmpresa(empresas.A);
    const email = novoEmail();
    const criado = await criar(master, { nome: 'Pessoa Nova', email, tipoConta: 'USUARIO', senhaProvisoria: SENHA_PROVISORIA, ...adm() });
    assert.equal(criado.status, 201);

    const entrada = await login(email, SENHA_PROVISORIA);
    assert.equal(entrada.status, 200, JSON.stringify(entrada.body));
    assert.equal(entrada.body.identidade.trocaSenhaObrigatoria, true);
    const jar = cookiesDe(entrada);
    assert.ok(jar[NOME_GLOBAL] && jar[NOME_EMPRESA], 'uma empresa só: seleção automática continua');
    const c = deCookies(jar);

    const me = await request(app).get(ME_GLOBAL).set('Cookie', c);
    assert.deepEqual([me.status, me.body.identidade.trocaSenhaObrigatoria], [200, true]);
    const bloqueio = { status: 'error', codigo: 'TROCA_SENHA_OBRIGATORIA', message: 'Defina uma nova senha para continuar' };
    for (const [nome, pedido] of [
      ['GET /auth/me', request(app).get(ME).set('Cookie', c)],
      ['PATCH /auth/global/conta', request(app).patch(CONTA).set('Cookie', c).send({ tema: 'claro' })],
      ['GET /administracao/usuarios', request(app).get(ROTA).set('Cookie', c)],
      ['POST selecionar', request(app).post(`/api/auth/global/empresas/${empresas.A}/selecionar`).set('Cookie', c).send({})],
    ]) {
      const r = await pedido;
      assert.equal(r.status, 403, `${nome}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, bloqueio, nome);
    }

    // O logout não passa pelo middleware de sessão: quem ainda vai trocar consegue sair.
    const segunda = deCookies(cookiesDe(await login(email, SENHA_PROVISORIA)));
    const saida = await request(app).post('/api/auth/global/logout').set('Cookie', segunda);
    assert.equal(saida.status, 200, JSON.stringify(saida.body));
    assert.equal((await request(app).get(ME_GLOBAL).set('Cookie', segunda)).status, 401, 'a sessão encerrada não serve mais');
    assert.equal((await request(app).get(ME_GLOBAL).set('Cookie', c)).status, 200, 'a primeira sessão segue viva');

    const igual = await request(app).post(TROCAR).set('Cookie', c).send({ senhaAtual: SENHA_PROVISORIA, novaSenha: SENHA_PROVISORIA });
    assert.deepEqual([igual.status, igual.body.codigo], [400, 'SENHA_IGUAL_A_ATUAL']);
    assert.equal((await identidadeDe(email)).senha_provisoria, true, 'segue provisória até uma troca válida');

    const troca = await request(app).post(TROCAR).set('Cookie', c).send({ senhaAtual: SENHA_PROVISORIA, novaSenha: SENHA_NOVA });
    assert.equal(troca.status, 200, JSON.stringify(troca.body));
    const limpa = await identidadeDe(email);
    assert.deepEqual([limpa.senha_provisoria, limpa.senha_provisoria_definida_em, limpa.senha_provisoria_expira_em], [false, null, null]);
    assert.equal(await password.verificarSenha(limpa.senha_hash, SENHA_NOVA), true);
    assert.equal((await request(app).get(ME_GLOBAL).set('Cookie', c)).body.identidade.trocaSenhaObrigatoria, false);
    assert.equal((await request(app).get(ME).set('Cookie', c)).status, 200, 'a sessão atual continua e o Portal abre');

    assert.deepEqual([(await login(email, SENHA_PROVISORIA)).status, (await login(email, SENHA_PROVISORIA)).body.codigo], [401, 'CREDENCIAIS_INVALIDAS'], 'a provisória deixou de valer');
    const comNova = await login(email, SENHA_NOVA);
    assert.deepEqual([comNova.status, comNova.body.identidade.trocaSenhaObrigatoria], [200, false]);
  });

  test('provisória expirada: 401 SENHA_PROVISORIA_EXPIRADA sem sessão, sem renovar e sem contar como senha errada; a recuperação por e-mail redefine, limpa o estado e o login volta a funcionar', async (t) => {
    const caixa = capturarEntrega(t);
    const master = await contaDaEmpresa(empresas.A);
    const email = novoEmail();
    assert.equal((await criar(master, { nome: 'Pessoa Atrasada', email, tipoConta: 'USUARIO', senhaProvisoria: SENHA_PROVISORIA, ...adm() })).status, 201);
    const { id } = await identidadeDe(email);
    await pool.query("UPDATE identidades SET senha_provisoria_definida_em = now() - interval '49 hours', senha_provisoria_expira_em = now() - interval '1 hour' WHERE id = $1", [id]);
    const antes = await identidadeDe(email);

    const expirado = await login(email, SENHA_PROVISORIA);
    assert.deepEqual([expirado.status, expirado.body.codigo], [401, 'SENHA_PROVISORIA_EXPIRADA'], JSON.stringify(expirado.body));
    assert.equal('set-cookie' in expirado.headers, false);
    semSegredos(JSON.stringify(expirado.body), [email.toLowerCase()]);
    assert.equal((await um('SELECT count(*)::int AS n FROM sessoes_globais WHERE identidade_id = $1', [id])).n, 0, 'nenhuma sessão');
    assert.equal((await um("SELECT count(*)::int AS n FROM login_tentativas_globais WHERE identidade_id = $1 AND sucesso = false", [id])).n, 0, 'não conta como senha errada');
    const depois = await identidadeDe(email);
    assert.deepEqual([depois.senha_provisoria, depois.senha_provisoria_definida_em.toISOString(), depois.senha_provisoria_expira_em.toISOString()], [true, antes.senha_provisoria_definida_em.toISOString(), antes.senha_provisoria_expira_em.toISOString()], 'nada é renovado');

    const solicitar = await request(app).post(SOLICITAR).set('User-Agent', 'Agente de Teste').send({ email, turnstileToken: TOKEN_RECUPERACAO });
    assert.equal(solicitar.status, 202, JSON.stringify(solicitar.body));
    assert.equal(caixa.redefinicoes.length, 1, 'o e-mail da recuperação é o fluxo legítimo');
    const { token } = caixa.redefinicoes[0];
    const redefinir = await request(app).post(REDEFINIR).send({ token, novaSenha: SENHA_NOVA });
    assert.equal(redefinir.status, 200, JSON.stringify(redefinir.body));
    const limpa = await identidadeDe(email);
    assert.deepEqual([limpa.senha_provisoria, limpa.senha_provisoria_definida_em, limpa.senha_provisoria_expira_em], [false, null, null]);
    const entrada = await login(email, SENHA_NOVA);
    assert.deepEqual([entrada.status, entrada.body.identidade.trocaSenhaObrigatoria], [200, false]);
    assert.equal((await request(app).get(ME).set('Cookie', deCookies(cookiesDe(entrada)))).status, 200);
  });

  test('o MASTER do Painel Privado e qualquer identidade que definiu a própria senha ficam intocados: sem senha provisória, login sem troca obrigatória', async () => {
    const master = await contaDaEmpresa(empresas.A);
    const linha = await identidadeDe(master.identidade.email);
    assert.deepEqual([linha.senha_provisoria, linha.senha_provisoria_definida_em, linha.senha_provisoria_expira_em], [false, null, null]);
    const entrada = await login(master.identidade.email, 'planeta-nebulosa-ozonio-42');
    assert.deepEqual([entrada.status, entrada.body.identidade.trocaSenhaObrigatoria], [200, false]);
    const me = await request(app).get(ME).set('Cookie', deCookies(cookiesDe(entrada)));
    assert.equal(me.status, 200);
  });
});
