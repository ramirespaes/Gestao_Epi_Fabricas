'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarEmpresa } = require('./helpers/entrega-epi');
const { todasAsMigrations } = require('./helpers/recuperacao-senha');
const { capturarEntrega, espiarConsole } = require('./helpers/recuperacao-senha-servico');
const { SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, MOTIVO, fabricaPortal, fabricaPainel } = require('./helpers/troca-senha');
const { criarAppTeste } = require('../helpers/app-teste');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const loginGlobalService = require('../../src/services/login-global.service');
const loginPlataformaService = require('../../src/services/login-plataforma.service');
const codigosMfa = require('../../src/security/codigos-mfa');
const password = require('../../src/security/password');
const token = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Troca de senha autenticada pela camada HTTP (Bloco 11E) contra PostgreSQL
 * real: rotas, sessão, validação, controller e service reais, num schema
 * temporário com todas as migrations. As sessões são as que os logins e a
 * seleção de empresa existentes criam, com token real, enviadas como cookie.
 */

const rotas = () => exigirModulo('src/routes/troca-senha.routes');
const controllers = () => exigirModulo('src/controllers/troca-senha.controller');

const PORTAL = '/api/auth/global/senha';
const PAINEL = '/api/plataforma/auth/senha';
const { cookieNomeGlobal: NOME_GLOBAL, cookieNome: NOME_EMPRESA, cookieNomeAdmin: NOME_ADMIN } = authConfig.sessao;
const OK = { status: 'SENHA_ALTERADA' };
const SESSAO_INVALIDA = { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'Sessão inválida ou expirada' };
const SENHA_ATUAL_INVALIDA = { status: 'error', codigo: 'SENHA_ATUAL_INVALIDA', message: 'Senha atual incorreta' };
const SENHA_IGUAL = { status: 'error', codigo: 'SENHA_IGUAL_A_ATUAL', message: 'A nova senha deve ser diferente da senha atual' };
const REAUTENTICACAO_INVALIDA = { status: 'error', codigo: 'REAUTENTICACAO_INVALIDA', message: 'Senha ou código inválidos' };
const FALHAS_DO_NIVEL_1 = authConfig.cooldown.niveis[0].falhas;

describe('troca de senha — rotas HTTP com PostgreSQL real', () => {
  let contexto;
  let pool;
  let app;
  let hashAtual;
  let portal;
  let painel;
  const empresas = [];

  const setCookies = (r) => r.headers['set-cookie'] ?? [];
  const cookieDoPortal = (c) => [`${NOME_GLOBAL}=${c.global.token}`, ...(c.empresarial ? [`${NOME_EMPRESA}=${c.empresarial.token}`] : [])].join('; ');
  const trocarNoPortal = (corpo, cookie) => {
    const r = request(app).post(PORTAL).set('User-Agent', 'Agente de Teste');
    return (cookie ? r.set('Cookie', cookie) : r).send(corpo);
  };
  const trocarNoPainel = (corpo, cookie) => {
    const r = request(app).post(PAINEL).set('User-Agent', 'Agente de Teste');
    return (cookie ? r.set('Cookie', cookie) : r).send(corpo);
  };
  const corpoDoPortal = (extra = {}) => ({ senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA, ...extra });
  const corpoDoPainel = (c, step, extra = {}) => ({ senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA, codigo: c.admin.codigoTotp(step), ...extra });

  async function cenarioDoPortal() {
    const identidade = await portal.novaIdentidade();
    await portal.vincular(identidade, empresas[0]);
    await portal.vincular(identidade, empresas[1]);
    const global = await portal.entrar(identidade);
    const empresarial = await portal.selecionar(identidade, global, empresas[0]);
    return { identidade, global, empresarial };
  }

  async function cenarioDoPainel() {
    const admin = await painel.novoAdministrador();
    const sessao = await painel.sessao(admin);
    return { admin, sessao };
  }

  function semSensiveis(resposta, extras = []) {
    const texto = JSON.stringify(resposta.body) + JSON.stringify(resposta.headers);
    for (const sensivel of [SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, hashAtual, ...extras]) {
      assert.equal(texto.includes(sensivel), false, `a resposta contém ${String(sensivel).slice(0, 8)}…`);
    }
  }

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    hashAtual = await password.gerarHashSenha(SENHA_ATUAL);
    portal = fabricaPortal({ pool, hashSenha: hashAtual });
    painel = fabricaPainel({ pool, hashSenha: hashAtual });
    empresas.push(await criarEmpresa(pool, '11222333000181', 'Empresa Alfa'));
    empresas.push(await criarEmpresa(pool, '44555666000162', 'Empresa Beta'));
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  /** Monta o app com as rotas reais; chamado por teste porque as rotas ainda não existem antes da 11E. */
  function montar() {
    const rotasDoPortal = rotas().criarTrocaSenhaGlobalRoutes({
      controller: controllers().criarTrocaSenhaGlobalController({ pool }),
      limitador: criarLimitador({ limite: 1000, janelaSegundos: 60 }),
      exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }),
    });
    const rotasDoPainel = rotas().criarTrocaSenhaPlataformaRoutes({
      controller: controllers().criarTrocaSenhaPlataformaController({ pool }),
      limitador: criarLimitador({ limite: 1000, janelaSegundos: 60 }),
      exigirSessaoPlataforma: criarExigirSessaoPlataforma({ pool }),
    });
    app = criarAppTeste((a) => {
      a.use('/api', rotasDoPortal);
      a.use('/api/plataforma', rotasDoPainel);
    });
  }

  describe('controle das fixtures', () => {
    test('os cookies de teste autenticam nos logins existentes e as sessões de teste valem', async () => {
      const c = await cenarioDoPortal();
      const a = await cenarioDoPainel();
      assert.equal(await portal.globalVale(c.global), true);
      assert.equal(await portal.empresarialVale(c.empresarial), true);
      assert.equal(await painel.sessaoVale(a.sessao), true);
      assert.match(cookieDoPortal(c), new RegExp(`^${NOME_GLOBAL}=[A-Za-z0-9_-]{43}; ${NOME_EMPRESA}=[A-Za-z0-9_-]{43}$`));
      assert.equal((await loginGlobalService.autenticar(pool, { email: c.identidade.email, senha: SENHA_ATUAL })).identidade.id, c.identidade.id);
      assert.equal((await loginPlataformaService.autenticar(pool, { email: a.admin.email, senha: SENHA_ATUAL })).desafio.etapa, 'VERIFICACAO');
    });

    test('o app de teste, o supertest e os middlewares de sessão reais aceitam os cookies das fixtures e recusam o resto, sem a rota nova', async () => {
      const c = await cenarioDoPortal();
      const a = await cenarioDoPainel();
      const sonda = criarAppTeste((app) => {
        app.post('/api/sonda-portal', criarExigirSessaoGlobal({ pool }), (req, res) => res.json({ identidadeId: req.identidade.id, sessaoId: req.sessaoGlobal.id }));
        app.post('/api/plataforma/sonda-painel', criarExigirSessaoPlataforma({ pool }), (req, res) => res.json({ administradorId: req.administradorPlataforma.id, sessaoId: req.sessaoPlataforma.id }));
      });

      const noPortal = await request(sonda).post('/api/sonda-portal').set('Cookie', cookieDoPortal(c)).send({});
      assert.deepEqual([noPortal.status, noPortal.body], [200, { identidadeId: c.identidade.id, sessaoId: c.global.id }]);
      const noPainel = await request(sonda).post('/api/plataforma/sonda-painel').set('Cookie', a.sessao.cookie).send({});
      assert.deepEqual([noPainel.status, noPainel.body], [200, { administradorId: a.admin.id, sessaoId: a.sessao.id }]);

      for (const [rota, cookie] of [
        ['/api/sonda-portal', undefined], ['/api/sonda-portal', `${NOME_EMPRESA}=${c.empresarial.token}`], ['/api/sonda-portal', a.sessao.cookie],
        ['/api/plataforma/sonda-painel', undefined], ['/api/plataforma/sonda-painel', cookieDoPortal(c)],
      ]) {
        const r = request(sonda).post(rota);
        const resposta = await (cookie ? r.set('Cookie', cookie) : r).send({});
        assert.deepEqual([resposta.status, resposta.body], [401, SESSAO_INVALIDA], `${rota} com ${cookie ?? 'nenhum cookie'}`);
      }
      assert.equal((await request(sonda).post('/api/sonda-portal').send('texto')).status, 415, 'o app de teste exige JSON como o real');
    });

    test('as operações de banco que os testes de rota usam como preparo funcionam: revogar sessões, abrir desafio, mexer na versão da chave e ler o estado do MFA', async () => {
      const c = await cenarioDoPortal();
      const a = await cenarioDoPainel();

      await pool.query("UPDATE sessoes_globais SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [c.global.id]);
      assert.equal(await portal.globalVale(c.global), false);
      await pool.query("UPDATE sessoes_plataforma SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [a.sessao.id]);
      assert.equal(await painel.sessaoVale(a.sessao), false);

      const tokenDoDesafio = token.gerarTokenSessao();
      const desafio = await desafioRepo.criar(pool, { administradorId: a.admin.id, tokenHash: token.hashTokenSessao(tokenDoDesafio), tipo: 'VERIFICACAO', validadeMinutos: 5 });
      assert.ok(desafio.id > 0);
      assert.match(tokenDoDesafio, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(typeof authConfig.desafioMfa.cookieNome, 'string');

      const mfaAntes = await painel.estadoDoMfa(a.admin.id);
      await pool.query('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 2 WHERE id = $1', [a.admin.fatorId]);
      await pool.query('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 1 WHERE id = $1', [a.admin.fatorId]);
      assert.deepEqual(await painel.estadoDoMfa(a.admin.id), mfaAntes, 'a versão da chave voltou ao que era');
      assert.equal(await painel.ultimoStep(a.admin.id), 1);
      assert.notEqual(painel.codigoErrado(a.admin, 1), a.admin.codigoTotp(1));
      assert.equal(a.admin.codigosRecuperacao.length, 10);
      assert.equal(codigosMfa.normalizarCodigo(a.admin.codigosRecuperacao[0]).length > 0, true);
    });
  });

  describe('Portal', () => {
    test('com a sessão global e a empresarial: 200, nenhum cookie, sessões como o contrato manda, e a mesma sessão segue servindo para outra troca', async (t) => {
      montar();
      const caixa = capturarEntrega(t);
      const c = await cenarioDoPortal();
      const outra = await portal.entrar(c.identidade);
      const outraEmpresarial = await portal.selecionar(c.identidade, outra, empresas[1]);
      const totalAntes = await portal.totalDeSessoes();

      const r = await trocarNoPortal(corpoDoPortal(), cookieDoPortal(c));

      assert.equal(r.status, 200);
      assert.deepEqual(r.body, OK);
      assert.deepEqual(setCookies(r), [], 'a troca não emite, troca nem remove cookie');
      semSensiveis(r, [c.global.token, c.empresarial.token]);
      assert.equal(await portal.globalVale(c.global), true);
      assert.equal(await portal.empresarialVale(c.empresarial), true);
      assert.deepEqual(await portal.motivosGlobais([outra.id]), [MOTIVO]);
      assert.deepEqual(await portal.motivosEmpresariais([outraEmpresarial.id]), [MOTIVO]);
      assert.equal(await portal.totalDeSessoes(), totalAntes, 'nenhuma sessão nova');
      assert.deepEqual(caixa.avisos, [{ escopo: 'PORTAL', email: c.identidade.email, origem: 'TROCA' }]);

      const outraTroca = await trocarNoPortal({ senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA }, cookieDoPortal(c));
      assert.deepEqual([outraTroca.status, outraTroca.body], [200, OK], 'os mesmos cookies continuam valendo');
    });

    test('sem cookie, só com a empresarial, com a global revogada ou com cookie de outro portal: 401 genérico antes de ler o corpo, e nada muda', async (t) => {
      montar();
      capturarEntrega(t);
      const c = await cenarioDoPortal();
      const a = await cenarioDoPainel();
      const revogada = await cenarioDoPortal();
      await pool.query("UPDATE sessoes_globais SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [revogada.global.id]);
      const antes = await portal.hashDaSenha(c.identidade.id);

      const casos = [
        ['sem cookie', undefined],
        ['só a empresarial', `${NOME_EMPRESA}=${c.empresarial.token}`],
        ['global revogada', cookieDoPortal(revogada)],
        ['cookie do Painel', `${NOME_ADMIN}=${a.sessao.token}`],
        ['cookie global malformado', `${NOME_GLOBAL}=abc`],
        ['cookie global duplicado', `${NOME_GLOBAL}=${c.global.token}; ${NOME_GLOBAL}=${c.global.token}`],
      ];
      for (const [nome, cookie] of casos) {
        for (const corpo of [corpoDoPortal(), {}]) {
          const r = await trocarNoPortal(corpo, cookie);
          assert.deepEqual([r.status, r.body], [401, SESSAO_INVALIDA], nome);
          assert.deepEqual(setCookies(r), [], nome);
        }
      }
      assert.equal(await portal.hashDaSenha(c.identidade.id), antes);
      assert.equal(await portal.hashDaSenha(revogada.identidade.id), hashAtual);
    });

    test('senha atual errada: 401 próprio; no limite do login, 429 com Retry-After mesmo com a senha certa; e o login também fica em cooldown', async (t) => {
      montar();
      capturarEntrega(t);
      const c = await cenarioDoPortal();
      for (let i = 0; i < FALHAS_DO_NIVEL_1; i += 1) {
        const r = await trocarNoPortal(corpoDoPortal({ senhaAtual: `errada-${i}-qualquer` }), cookieDoPortal(c));
        assert.deepEqual([r.status, r.body], [401, SENHA_ATUAL_INVALIDA], `tentativa ${i + 1}`);
        assert.deepEqual(setCookies(r), []);
        semSensiveis(r, [`errada-${i}-qualquer`]);
      }
      const bloqueada = await trocarNoPortal(corpoDoPortal(), cookieDoPortal(c));
      assert.deepEqual([bloqueada.status, bloqueada.body.codigo], [429, 'LOGIN_EM_COOLDOWN']);
      assert.ok(Number(bloqueada.headers['retry-after']) > 0);
      assert.equal(await portal.hashDaSenha(c.identidade.id), hashAtual);
      await assert.rejects(() => loginGlobalService.autenticar(pool, { email: c.identidade.email, senha: SENHA_ATUAL }), (erro) => erro.status === 429 && erro.codigo === 'LOGIN_EM_COOLDOWN');
    });

    test('política e igualdade: 400 com o código próprio, sem ecoar a senha, sem cookie, e a sessão e a senha seguem como estavam', async (t) => {
      montar();
      capturarEntrega(t);
      const c = await cenarioDoPortal();
      const fraca = await trocarNoPortal(corpoDoPortal({ novaSenha: 'Zx9!kq' }), cookieDoPortal(c));
      assert.equal(fraca.status, 400);
      assert.equal(fraca.body.codigo, 'VALIDACAO');
      assert.equal(fraca.body.detalhes.some((d) => d.campo === 'body.novaSenha' && d.codigo === 'SENHA_CURTA'), true);
      assert.equal(JSON.stringify(fraca.body).includes('Zx9!kq'), false);
      const igual = await trocarNoPortal(corpoDoPortal({ novaSenha: SENHA_ATUAL }), cookieDoPortal(c));
      assert.deepEqual([igual.status, igual.body], [400, SENHA_IGUAL]);
      for (const r of [fraca, igual]) assert.deepEqual(setCookies(r), []);
      assert.equal(await portal.hashDaSenha(c.identidade.id), hashAtual);
      assert.equal(await portal.globalVale(c.global), true);
    });

    test('a identidade vem só da sessão: corpo com identidade, usuário, empresa, sessão ou e-mail é 400 e a conta citada não é tocada', async (t) => {
      montar();
      capturarEntrega(t);
      const c = await cenarioDoPortal();
      const vizinha = await cenarioDoPortal();
      for (const extra of [
        { identidadeId: vizinha.identidade.id }, { usuarioId: 1 }, { empresaId: empresas[0] }, { sessionId: vizinha.global.id }, { sessaoId: vizinha.global.id },
        { email: vizinha.identidade.email },
      ]) {
        const r = await trocarNoPortal(corpoDoPortal(extra), cookieDoPortal(c));
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(Object.keys(extra)));
        semSensiveis(r, [vizinha.identidade.email]);
      }
      assert.equal(await portal.hashDaSenha(vizinha.identidade.id), hashAtual);
      assert.equal(await portal.hashDaSenha(c.identidade.id), hashAtual);
    });

    test('com a sessão de uma pessoa e o cookie empresarial de outra, só a global vale e a empresarial alheia nem é tocada', async (t) => {
      montar();
      capturarEntrega(t);
      const c = await cenarioDoPortal();
      const alheia = await cenarioDoPortal();
      const cookie = `${NOME_GLOBAL}=${c.global.token}; ${NOME_EMPRESA}=${alheia.empresarial.token}`;

      const r = await trocarNoPortal(corpoDoPortal(), cookie);

      assert.deepEqual([r.status, r.body], [200, OK]);
      assert.equal(await portal.globalVale(c.global), true);
      assert.equal(await portal.empresarialVale(c.empresarial), false, 'nada foi preservado: o cookie empresarial não era desta pessoa');
      assert.equal(await portal.empresarialVale(alheia.empresarial), true, 'a sessão da outra pessoa segue válida');
      assert.equal(await portal.hashDaSenha(alheia.identidade.id), hashAtual);
    });

    test('nenhuma resposta nem linha de log do fluxo traz senha, token de sessão ou e-mail', async (t) => {
      montar();
      capturarEntrega(t);
      const linhas = espiarConsole(t);
      const c = await cenarioDoPortal();
      const respostas = [
        await trocarNoPortal(corpoDoPortal({ senhaAtual: 'errada-qualquer-12345' }), cookieDoPortal(c)),
        await trocarNoPortal(corpoDoPortal({ novaSenha: 'Zx9!kq' }), cookieDoPortal(c)),
        await trocarNoPortal(corpoDoPortal({ novaSenha: SENHA_ATUAL }), cookieDoPortal(c)),
        await trocarNoPortal(corpoDoPortal(), cookieDoPortal(c)),
        await trocarNoPortal(corpoDoPortal()),
      ];
      const texto = respostas.map((r) => JSON.stringify(r.body) + JSON.stringify(r.headers)).join('\n') + linhas.map((l) => l.texto).join('\n');
      for (const sensivel of [SENHA_ATUAL, SENHA_NOVA, 'errada-qualquer-12345', c.global.token, c.empresarial.token, c.identidade.email, 'example.invalid']) {
        assert.equal(texto.includes(sensivel), false, `vazou ${sensivel.slice(0, 8)}…`);
      }
    });
  });

  describe('Painel Privado', () => {
    test('senha atual e TOTP: 200, nenhum cookie, só a sessão atual segue válida, o MFA fica intacto e o mesmo código não vale de novo', async (t) => {
      montar();
      const caixa = capturarEntrega(t);
      const c = await cenarioDoPainel();
      const outra = await painel.sessao(c.admin);
      const abertos = await painel.desafioAberto(c.admin);
      const mfaAntes = await painel.estadoDoMfa(c.admin.id);
      const step = await painel.stepEstavel();
      const sessoesAntes = await painel.totalDeSessoes();

      const r = await trocarNoPainel(corpoDoPainel(c, step), c.sessao.cookie);

      assert.equal(r.status, 200);
      assert.deepEqual(r.body, OK);
      assert.deepEqual(setCookies(r), [], 'a sessão atual fica como está: nenhum cookie emitido, trocado ou removido');
      semSensiveis(r, [c.sessao.token, c.admin.codigoTotp(step)]);
      assert.equal(await painel.sessaoVale(c.sessao), true);
      assert.equal(await painel.sessaoVale(outra), false);
      assert.equal(await painel.totalDeSessoes(), sessoesAntes, 'nenhuma sessão nova');
      assert.equal((await painel.desafiosDe(c.admin.id)).find((d) => d.id === abertos).motivo_encerramento, MOTIVO);
      assert.deepEqual(await painel.estadoDoMfa(c.admin.id), mfaAntes);
      assert.deepEqual(caixa.avisos, [{ escopo: 'PLATAFORMA', email: c.admin.email, origem: 'TROCA' }]);

      const repetido = await trocarNoPainel(corpoDoPainel(c, step, { senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA }), c.sessao.cookie);
      assert.deepEqual([repetido.status, repetido.body], [401, REAUTENTICACAO_INVALIDA]);
      const seguinte = await trocarNoPainel(corpoDoPainel(c, step + 1, { senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA }), c.sessao.cookie);
      assert.deepEqual([seguinte.status, seguinte.body], [200, OK], 'a mesma sessão segue servindo, com um código novo');
    });

    test('sem sessão plena: sem cookie, só com o desafio de MFA aberto, com sessão revogada ou com o cookie do Portal dão 401, antes de ler o corpo, e nada muda', async (t) => {
      montar();
      capturarEntrega(t);
      const c = await cenarioDoPainel();
      const revogada = await cenarioDoPainel();
      await pool.query("UPDATE sessoes_plataforma SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [revogada.sessao.id]);
      const tokenDoDesafio = token.gerarTokenSessao();
      await desafioRepo.criar(pool, { administradorId: c.admin.id, tokenHash: token.hashTokenSessao(tokenDoDesafio), tipo: 'VERIFICACAO', validadeMinutos: 5 });
      const portalAlheio = await cenarioDoPortal();
      const step = await painel.stepEstavel();

      const casos = [
        ['sem cookie', undefined],
        ['só o desafio de MFA', `${authConfig.desafioMfa.cookieNome}=${tokenDoDesafio}`],
        ['sessão revogada', revogada.sessao.cookie],
        ['cookie do Portal', `${NOME_GLOBAL}=${portalAlheio.global.token}`],
        ['cookie administrativo malformado', `${NOME_ADMIN}=abc`],
      ];
      for (const [nome, cookie] of casos) {
        for (const corpo of [corpoDoPainel(c, step), {}]) {
          const r = await trocarNoPainel(corpo, cookie);
          assert.deepEqual([r.status, r.body], [401, SESSAO_INVALIDA], nome);
          assert.deepEqual(setCookies(r), [], nome);
        }
      }
      assert.equal(await painel.hashDaSenha(c.admin.id), hashAtual);
      assert.equal(await painel.ultimoStep(c.admin.id), 1);
    });

    test('recovery code não substitui o TOTP: 400 de validação, sem consumir nada, e o campo de recuperação também é recusado', async (t) => {
      montar();
      capturarEntrega(t);
      const c = await cenarioDoPainel();
      const mfaAntes = await painel.estadoDoMfa(c.admin.id);
      const [recovery] = c.admin.codigosRecuperacao;
      const semCodigo = { senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA };

      for (const corpo of [
        { ...semCodigo, codigo: recovery }, { ...semCodigo, codigo: codigosMfa.normalizarCodigo(recovery) }, { ...semCodigo, codigoRecuperacao: recovery },
        { ...semCodigo, codigo: '12345' }, { ...semCodigo, codigo: '12345a' }, semCodigo,
      ]) {
        const r = await trocarNoPainel(corpo, c.sessao.cookie);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO']);
        semSensiveis(r, [recovery, codigosMfa.normalizarCodigo(recovery)]);
      }
      assert.deepEqual(await painel.estadoDoMfa(c.admin.id), mfaAntes, 'nenhum recovery code consumido, nenhum lote tocado');
      assert.equal(await painel.hashDaSenha(c.admin.id), hashAtual);
      assert.equal(await painel.ultimoStep(c.admin.id), 1);
      assert.deepEqual((await painel.tentativasDe(c.admin.id)).filter((x) => !x.sucesso), [], 'a validação nem chegou à reautenticação');
    });

    test('senha errada e TOTP errado têm exatamente a mesma resposta; no limite o cooldown de MFA dá 429 com Retry-After, mesmo com tudo certo', async (t) => {
      montar();
      capturarEntrega(t);
      const c = await cenarioDoPainel();
      const step = await painel.stepEstavel();

      const senhaErrada = await trocarNoPainel(corpoDoPainel(c, step, { senhaAtual: 'senha-errada-qualquer-99' }), c.sessao.cookie);
      const totpErrado = await trocarNoPainel(corpoDoPainel(c, step, { codigo: painel.codigoErrado(c.admin, step) }), c.sessao.cookie);
      assert.deepEqual([senhaErrada.status, senhaErrada.body], [401, REAUTENTICACAO_INVALIDA]);
      assert.deepEqual([totpErrado.status, totpErrado.body], [401, REAUTENTICACAO_INVALIDA]);
      assert.equal(JSON.stringify(senhaErrada.body), JSON.stringify(totpErrado.body));

      for (let i = 2; i < FALHAS_DO_NIVEL_1; i += 1) await trocarNoPainel(corpoDoPainel(c, step, { senhaAtual: `errada-${i}-qualquer` }), c.sessao.cookie);
      const bloqueada = await trocarNoPainel(corpoDoPainel(c, step), c.sessao.cookie);
      assert.deepEqual([bloqueada.status, bloqueada.body.codigo], [429, 'MFA_EM_COOLDOWN']);
      assert.ok(Number(bloqueada.headers['retry-after']) > 0);
      assert.equal(await painel.hashDaSenha(c.admin.id), hashAtual);
      assert.equal(await painel.ultimoStep(c.admin.id), 1, 'nenhum passo consumido pelas falhas nem pelo cooldown');
    });

    test('política e igualdade só depois da reautenticação: 400 com o código próprio, nunca "código inválido", e o passo fica consumido', async (t) => {
      montar();
      capturarEntrega(t);
      const c = await cenarioDoPainel();
      const step = await painel.stepEstavel();

      const fraca = await trocarNoPainel(corpoDoPainel(c, step, { novaSenha: 'Zx9!kq' }), c.sessao.cookie);
      assert.equal(fraca.status, 400);
      assert.equal(fraca.body.codigo, 'VALIDACAO');
      assert.equal(fraca.body.detalhes.some((d) => d.campo === 'body.novaSenha' && d.codigo === 'SENHA_CURTA'), true);
      assert.equal(JSON.stringify(fraca.body).includes('Zx9!kq'), false);
      assert.equal(await painel.ultimoStep(c.admin.id), step);

      const igual = await trocarNoPainel(corpoDoPainel(c, step + 1, { novaSenha: SENHA_ATUAL }), c.sessao.cookie);
      assert.deepEqual([igual.status, igual.body], [400, SENHA_IGUAL]);
      assert.equal(await painel.ultimoStep(c.admin.id), step + 1);
      for (const r of [fraca, igual]) assert.deepEqual(setCookies(r), []);
      assert.equal(await painel.hashDaSenha(c.admin.id), hashAtual);
      assert.equal(await painel.sessaoVale(c.sessao), true);
    });

    test('fator indecifrável: 503 com o código de MFA indisponível e a mensagem genérica, sem trocar nada', async (t) => {
      montar();
      capturarEntrega(t);
      espiarConsole(t);
      const c = await cenarioDoPainel();
      const step = await painel.stepEstavel();
      await pool.query('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 2 WHERE id = $1', [c.admin.fatorId]);

      const r = await trocarNoPainel(corpoDoPainel(c, step), c.sessao.cookie);

      assert.deepEqual([r.status, r.body], [503, { status: 'error', codigo: 'MFA_INDISPONIVEL', message: 'Erro interno do servidor' }]);
      assert.deepEqual(setCookies(r), []);
      await pool.query('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 1 WHERE id = $1', [c.admin.fatorId]);
      assert.equal(await painel.hashDaSenha(c.admin.id), hashAtual);
      assert.equal(await painel.ultimoStep(c.admin.id), 1);
    });

    test('o administrador vem só da sessão: corpo com administrador, e-mail ou sessão é 400 e a conta citada não é tocada', async (t) => {
      montar();
      capturarEntrega(t);
      const c = await cenarioDoPainel();
      const vizinho = await cenarioDoPainel();
      const step = await painel.stepEstavel();
      for (const extra of [{ administradorId: vizinho.admin.id }, { email: vizinho.admin.email }, { sessaoId: vizinho.sessao.id }, { identidadeId: 1 }]) {
        const r = await trocarNoPainel(corpoDoPainel(c, step, extra), c.sessao.cookie);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(Object.keys(extra)));
        semSensiveis(r, [vizinho.admin.email]);
      }
      assert.equal(await painel.hashDaSenha(vizinho.admin.id), hashAtual);
      assert.equal(await painel.ultimoStep(vizinho.admin.id), 1);
    });

    test('nenhuma resposta nem linha de log do fluxo traz senha, TOTP, recovery code, token de sessão ou e-mail', async (t) => {
      montar();
      capturarEntrega(t);
      const linhas = espiarConsole(t);
      const c = await cenarioDoPainel();
      const step = await painel.stepEstavel();
      const errado = painel.codigoErrado(c.admin, step);
      const respostas = [
        await trocarNoPainel(corpoDoPainel(c, step, { senhaAtual: 'errada-qualquer-12345' }), c.sessao.cookie),
        await trocarNoPainel(corpoDoPainel(c, step, { codigo: errado }), c.sessao.cookie),
        await trocarNoPainel(corpoDoPainel(c, step, { novaSenha: 'Zx9!kq' }), c.sessao.cookie),
        await trocarNoPainel(corpoDoPainel(c, step + 1), c.sessao.cookie),
      ];
      const texto = respostas.map((r) => JSON.stringify(r.body) + JSON.stringify(r.headers)).join('\n') + linhas.map((l) => l.texto).join('\n');
      const codigos = [step, step + 1].map((s) => JSON.stringify(c.admin.codigoTotp(s))).concat(JSON.stringify(errado));
      const recovery = c.admin.codigosRecuperacao.flatMap((codigo) => [codigo, codigosMfa.normalizarCodigo(codigo)]);
      for (const sensivel of [SENHA_ATUAL, SENHA_NOVA, 'errada-qualquer-12345', c.sessao.token, c.admin.email, 'example.invalid', ...codigos, ...recovery]) {
        assert.equal(texto.includes(sensivel), false, `vazou ${sensivel.slice(0, 8)}…`);
      }
    });
  });
});
