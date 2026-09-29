'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');
const { criarSessaoAdministrativa } = require('./helpers/sessao-plataforma-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const totpReferencia = require('../helpers/totp-referencia');
const { criarAuthPlataformaController } = require('../../src/controllers/auth-plataforma.controller');
const { criarAuthPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const { criarPainelPlataformaRoutes } = require('../../src/routes/painel-plataforma.routes');
const { painelPlataformaController } = require('../../src/controllers/painel-plataforma.controller');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarExigirDesafioMfa } = require('../../src/middleware/desafio-mfa-plataforma');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const liberacaoService = require('../../src/services/liberacao-cadastro-mfa-plataforma.service');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const mfaCripto = require('../../src/security/mfa-cripto');
const totp = require('../../src/security/totp');
const cooldown = require('../../src/security/cooldown');
const { gerarTokenSessao, hashTokenSessao } = require('../../src/security/token');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

const MIGRATIONS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048', '049', '050', '051', '052', '053', '054', '055', '056'];
const SENHA = 'planeta-nebulosa-ozonio-42';
const CORPO_INVALIDO = { status: 'error', codigo: 'MFA_CODIGO_INVALIDO', message: 'Código inválido' };
const COOKIE_DESAFIO = () => authConfig.desafioMfa.cookieNome;
const COOKIE_SESSAO = () => authConfig.sessao.cookieNomeAdmin;

function setCookie(resposta, nome) {
  const bruto = (resposta.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${nome}=`));
  if (bruto === undefined) return null;
  const [par, ...resto] = bruto.split(';').map((p) => p.trim());
  const atributos = Object.fromEntries(resto.map((p) => {
    const i = p.indexOf('=');
    return i === -1 ? [p.toLowerCase(), true] : [p.slice(0, i).toLowerCase(), p.slice(i + 1)];
  }));
  return { valor: par.slice(nome.length + 1), atributos, par };
}

function sinal() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver };
}

describe('login normal com TOTP no Painel Privado (PostgreSQL real)', () => {
  let contexto;
  let app;
  let hashSenha;
  let sequencia = 0;

  const q = (sql, params) => contexto.pool.query(sql, params);
  const um = async (sql, params) => (await q(sql, params)).rows[0];
  const post = (caminho, cookie, corpo = {}) => {
    const r = request(app).post(`/api/plataforma${caminho}`).send(corpo);
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const get = (caminho, cookie) => request(app).get(`/api/plataforma${caminho}`).set('Cookie', cookie);
  const verificar = (cookie, codigo) => post('/auth/mfa/verificar', cookie, { codigo });

  async function novoAdministrador(prefixo) {
    sequencia += 1;
    const email = `${prefixo}-${sequencia}-${crypto.randomBytes(3).toString('hex')}@safework.com.br`;
    const { id } = await um('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hashSenha]);
    return { id, email };
  }

  async function comTotpAtivo(prefixo) {
    const admin = await novoAdministrador(prefixo);
    const segredo = crypto.randomBytes(20);
    const fatorUid = crypto.randomUUID();
    const envelope = mfaCripto.cifrarSegredoTotp({ segredo: Buffer.from(segredo), administradorId: admin.id, fatorUid });
    const fator = await fatorRepo.criarPendenteTotp(contexto.pool, { administradorId: admin.id, fatorUid, envelope, validadeMinutos: 15 });
    assert.equal(await fatorRepo.ativarTotp(contexto.pool, { administradorId: admin.id, fatorId: fator.id, step: 1 }), true);
    return { ...admin, segredo, fatorId: fator.id, codigo: (step) => totpReferencia.codigoDoStep(segredo, step) };
  }

  async function entrar(email) {
    const r = await post('/auth/login', null, { email, senha: SENHA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { ...setCookie(r, COOKIE_DESAFIO()), etapa: r.body.etapa };
  }

  async function desafioDireto(administradorId, tipo = 'VERIFICACAO') {
    const token = gerarTokenSessao();
    await desafioRepo.criar(contexto.pool, { administradorId, tokenHash: hashTokenSessao(token), tipo, validadeMinutos: 5 });
    return { valor: token, par: `${COOKIE_DESAFIO()}=${token}` };
  }

  // Step do relógio do banco com pelo menos 4 s de folga até o próximo, para os casos que dependem do step exato.
  async function stepEstavel() {
    const agora = (await um('SELECT clock_timestamp() AS t')).t.getTime();
    const restante = 30_000 - (agora % 30_000);
    if (restante > 4_000) return totpReferencia.stepDe(agora);
    await new Promise((r) => { setTimeout(r, restante + 100); });
    return totpReferencia.stepDe((await um('SELECT clock_timestamp() AS t')).t.getTime());
  }

  const codigoForaDaJanela = (admin, step) => {
    const naJanela = new Set([-1, 0, 1].map((d) => admin.codigo(step + d)));
    for (let n = 0; ; n += 1) {
      const codigo = String(n).padStart(6, '0');
      if (!naJanela.has(codigo)) return codigo;
    }
  };
  const desafioDe = (token) => um('SELECT * FROM desafios_mfa_plataforma WHERE token_hash = $1', [hashTokenSessao(token)]);
  const ultimoStep = async (admin) => Number((await um('SELECT totp_ultimo_step_aceito AS s FROM fatores_mfa_plataforma WHERE id = $1', [admin.fatorId])).s);
  const sessoesMfa = async (admin) => (await um("SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1 AND mfa_metodo = 'TOTP'", [admin.id])).n;
  const tentativasMfa = async (admin, motivo) => (await um(
    'SELECT count(*)::int AS n FROM login_tentativas_plataforma WHERE chave_cooldown = $1 AND motivo IS NOT DISTINCT FROM $2',
    [cooldown.gerarChaveCooldownMfaPlataforma(admin.id), motivo],
  )).n;

  before(async () => {
    hashSenha = await gerarHashSenha(SENHA);
    contexto = await abrirPoolTemporario(MIGRATIONS);
    const { pool } = contexto;
    const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });
    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    app = criarAppTeste((a) => {
      a.use(
        '/api/plataforma',
        criarAuthPlataformaRoutes({
          controller: criarAuthPlataformaController({ pool }),
          limitador: semLimite(),
          limitadorMfa: semLimite(),
          exigirSessaoPlataforma,
          desafioMfa: (tipos) => criarExigirDesafioMfa({ pool, tipos }),
        }),
        criarPainelPlataformaRoutes({ controller: painelPlataformaController, exigirSessaoPlataforma }),
      );
    });
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('fluxo e sessão plena', () => {
    test('senha abre VERIFICACAO; o desafio sozinho não autentica; TOTP válido cria a sessão plena com MFA TOTP', async () => {
      const admin = await comTotpAtivo('ok');
      const desafio = await entrar(admin.email);
      assert.equal(desafio.etapa, 'VERIFICACAO');
      const soDesafio = await get('/auth/me', desafio.par);
      assert.deepEqual([soDesafio.status, soDesafio.body.codigo], [401, 'SESSAO_INVALIDA']);
      assert.equal((await get('/painel', desafio.par)).status, 401);

      const step = await stepEstavel();
      const r = await verificar(desafio.par, admin.codigo(step));

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: 'ok' });
      const sessao = setCookie(r, COOKIE_SESSAO());
      assert.equal(sessao.atributos.httponly, true);
      assert.equal(sessao.atributos.path, '/');
      assert.equal(sessao.atributos['max-age'], String(authConfig.sessao.expiracaoMinutosAdmin * 60));
      assert.notEqual(sessao.valor, desafio.valor);
      const removido = setCookie(r, COOKIE_DESAFIO());
      assert.deepEqual([removido.valor, removido.atributos['max-age']], ['', '0']);

      const me = await get('/auth/me', sessao.par);
      assert.deepEqual([me.status, me.body.administrador.id], [200, admin.id]);
      assert.equal((await get('/painel', sessao.par)).status, 200);
      assert.equal((await get('/auth/mfa/estado', desafio.par)).status, 401);

      const linhaSessao = await um(
        `SELECT id, mfa_metodo, mfa_verificado_em <= criado_em AS mfa_antes,
                round(extract(epoch FROM (expira_em - criado_em)) / 60)::int AS minutos
           FROM sessoes_plataforma WHERE token_hash = $1`,
        [hashTokenSessao(sessao.valor)],
      );
      assert.deepEqual([linhaSessao.mfa_metodo, linhaSessao.mfa_antes, linhaSessao.minutos], ['TOTP', true, authConfig.sessao.expiracaoMinutosAdmin]);
      const concluido = await desafioDe(desafio.valor);
      assert.deepEqual([concluido.motivo_encerramento, concluido.sessao_criada_id], ['CONCLUIDO', linhaSessao.id]);
      assert.equal(await ultimoStep(admin), step);
      assert.equal(await tentativasMfa(admin, null), 1);
      const auditoria = await um(
        "SELECT ator_tipo, administrador_id, contexto FROM logs_auditoria_plataforma WHERE acao = 'MFA_LOGIN_CONCLUIDO' AND administrador_id = $1",
        [admin.id],
      );
      assert.deepEqual([auditoria.ator_tipo, auditoria.administrador_id, auditoria.contexto.metodo], ['ADMINISTRADOR', admin.id, 'TOTP']);
    });

    test('sessão plena sozinha não substitui o desafio; desafios LIBERACAO e CADASTRO são recusados', async () => {
      const admin = await comTotpAtivo('sosessao');
      const sessao = await criarSessaoAdministrativa(contexto.pool, admin.id);
      assert.deepEqual((await verificar(sessao.cookie, admin.codigo(await stepEstavel()))).body.codigo, 'DESAFIO_INVALIDO');

      const semFator = await novoAdministrador('liberacao');
      const liberacao = await entrar(semFator.email);
      assert.equal(liberacao.etapa, 'LIBERACAO');
      assert.equal((await verificar(liberacao.par, '123456')).body.codigo, 'DESAFIO_INVALIDO');

      const { codigo } = await liberacaoService.liberarCadastro(contexto.pool, { email: semFator.email });
      const cadastro = setCookie(await post('/auth/mfa/liberacao', liberacao.par, { codigoLiberacao: codigo }), COOKIE_DESAFIO());
      assert.equal((await verificar(cadastro.par, '123456')).body.codigo, 'DESAFIO_INVALIDO');
      assert.equal((await um("SELECT count(*)::int AS n FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [semFator.id])).n, 0);
    });

    test('corpo fora do formato: 400 VALIDACAO sem contar falha', async () => {
      const admin = await comTotpAtivo('corpo');
      const desafio = await entrar(admin.email);
      for (const corpo of [{ codigo: '12345' }, { codigo: ' 123456' }, { codigo: 123456 }, { codigo: '123456', x: 1 }]) {
        assert.equal((await post('/auth/mfa/verificar', desafio.par, corpo)).status, 400, JSON.stringify(corpo));
      }
      assert.equal((await desafioDe(desafio.valor)).falhas, 0);
    });
  });

  describe('código errado e anti-replay', () => {
    test('código errado: 401 genérico, falha contada, step e sessões intactos', async () => {
      const admin = await comTotpAtivo('errado');
      const desafio = await entrar(admin.email);

      const r = await verificar(desafio.par, codigoForaDaJanela(admin, await stepEstavel()));

      assert.deepEqual([r.status, r.body], [401, CORPO_INVALIDO]);
      assert.equal((await desafioDe(desafio.valor)).falhas, 1);
      assert.equal(await tentativasMfa(admin, 'TOTP_INVALIDO'), 1);
      assert.equal(await ultimoStep(admin), 1);
      assert.equal(await sessoesMfa(admin), 0);
    });

    test('o mesmo step em outro desafio: 401 idêntico ao do código errado; o desafio perdedor segue aberto, o controle é do fator', async () => {
      const admin = await comTotpAtivo('replay');
      const primeiro = await entrar(admin.email);
      const segundo = await entrar(admin.email);
      const step = await stepEstavel();

      assert.equal((await verificar(primeiro.par, admin.codigo(step))).status, 200);
      const repetido = await verificar(segundo.par, admin.codigo(step));

      assert.deepEqual([repetido.status, repetido.body], [401, CORPO_INVALIDO]);
      const aberto = await desafioDe(segundo.valor);
      assert.deepEqual([aberto.encerrado_em, aberto.falhas], [null, 1]);
      assert.equal(await tentativasMfa(admin, 'TOTP_REPETIDO'), 1);
      assert.equal(await sessoesMfa(admin), 1);
      assert.equal(await ultimoStep(admin), step);
    });

    test('steps já consumidos (anterior e o mesmo) são recusados; o seguinte é aceito', async () => {
      const admin = await comTotpAtivo('passos');
      const desafio = await entrar(admin.email);
      const step = await stepEstavel();
      await q('UPDATE fatores_mfa_plataforma SET totp_ultimo_step_aceito = $2 WHERE id = $1', [admin.fatorId, step]);

      assert.deepEqual((await verificar(desafio.par, admin.codigo(step - 1))).body, CORPO_INVALIDO);
      assert.deepEqual((await verificar(desafio.par, admin.codigo(step))).body, CORPO_INVALIDO);
      assert.equal(await tentativasMfa(admin, 'TOTP_REPETIDO'), 2);

      await q('UPDATE fatores_mfa_plataforma SET totp_ultimo_step_aceito = $2 WHERE id = $1', [admin.fatorId, step - 1]);
      assert.equal((await verificar(desafio.par, admin.codigo(step))).status, 200);
      assert.equal(await ultimoStep(admin), step);
    });

    test('step seguinte dentro da janela é aceito e passa a barrar o step atual', async () => {
      const admin = await comTotpAtivo('futuro');
      const step = await stepEstavel();

      assert.equal((await verificar((await entrar(admin.email)).par, admin.codigo(step + 1))).status, 200);
      assert.equal(await ultimoStep(admin), step + 1);
      assert.deepEqual((await verificar((await entrar(admin.email)).par, admin.codigo(step))).body, CORPO_INVALIDO);
      assert.equal(await sessoesMfa(admin), 1);
    });
  });

  describe('limite de falhas e cooldown', () => {
    test('quinta falha encerra o desafio; o cooldown vale no próximo desafio e barra até código válido, sem consumir nada', async () => {
      const admin = await comTotpAtivo('cooldown');
      const desafio = await entrar(admin.email);
      const step = await stepEstavel();
      const errado = codigoForaDaJanela(admin, step);

      for (let i = 1; i <= authConfig.desafioMfa.maxFalhas; i += 1) {
        assert.deepEqual((await verificar(desafio.par, errado)).body, CORPO_INVALIDO, `falha ${i}`);
      }
      assert.equal((await desafioDe(desafio.valor)).motivo_encerramento, 'FALHAS_EXCEDIDAS');
      assert.equal((await um("SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE acao = 'MFA_DESAFIO_ESGOTADO' AND administrador_id = $1", [admin.id])).n, 1);
      assert.equal((await verificar(desafio.par, admin.codigo(step))).body.codigo, 'DESAFIO_INVALIDO');
      assert.equal(await tentativasMfa(admin, 'COOLDOWN_ATIVADO'), 1);

      const novo = await entrar(admin.email);
      const tentativasAntes = (await um('SELECT count(*)::int AS n FROM login_tentativas_plataforma WHERE chave_cooldown = $1', [cooldown.gerarChaveCooldownMfaPlataforma(admin.id)])).n;
      const bloqueado = await verificar(novo.par, admin.codigo(await stepEstavel()));

      assert.deepEqual([bloqueado.status, bloqueado.body.codigo], [429, 'MFA_EM_COOLDOWN']);
      assert.ok(Number(bloqueado.headers['retry-after']) > 0);
      const intacto = await desafioDe(novo.valor);
      assert.deepEqual([intacto.encerrado_em, intacto.falhas], [null, 0]);
      assert.equal((await um('SELECT count(*)::int AS n FROM login_tentativas_plataforma WHERE chave_cooldown = $1', [cooldown.gerarChaveCooldownMfaPlataforma(admin.id)])).n, tentativasAntes);
      assert.equal(await ultimoStep(admin), 1);
      assert.equal(await sessoesMfa(admin), 0);
    });
  });

  describe('falha criptográfica', () => {
    test('versão de chave ausente e ciphertext adulterado: 503, nada muda; restaurado, o mesmo código entra', async (t) => {
      const logs = [];
      t.mock.method(console, 'error', (...args) => logs.push(args));
      const admin = await comTotpAtivo('cripto');
      const desafio = await entrar(admin.email);
      const original = await um('SELECT totp_segredo_cifrado AS c FROM fatores_mfa_plataforma WHERE id = $1', [admin.fatorId]);
      const step = await stepEstavel();

      const alteracoes = [
        ['CHAVE_INDISPONIVEL', 'UPDATE fatores_mfa_plataforma SET totp_chave_versao = 2 WHERE id = $1', 'UPDATE fatores_mfa_plataforma SET totp_chave_versao = 1 WHERE id = $1'],
        ['AUTENTICACAO_FALHOU', 'UPDATE fatores_mfa_plataforma SET totp_segredo_cifrado = set_byte(totp_segredo_cifrado, 0, get_byte(totp_segredo_cifrado, 0) # 255) WHERE id = $1', null],
      ];
      for (const [motivo, estragar, consertar] of alteracoes) {
        await q(estragar, [admin.fatorId]);
        const r = await verificar(desafio.par, admin.codigo(step));

        assert.deepEqual([r.status, r.body.codigo], [503, 'MFA_INDISPONIVEL'], motivo);
        const intacto = await desafioDe(desafio.valor);
        assert.deepEqual([intacto.encerrado_em, intacto.falhas], [null, 0], motivo);
        assert.equal(await tentativasMfa(admin, 'TOTP_INVALIDO'), 0);
        assert.equal(await ultimoStep(admin), 1);
        assert.equal(await sessoesMfa(admin), 0);
        const evento = await um(
          "SELECT ator_tipo, administrador_id, contexto FROM logs_auditoria_plataforma WHERE acao = 'MFA_CHAVE_INDISPONIVEL' AND administrador_afetado_id = $1 ORDER BY id DESC LIMIT 1",
          [admin.id],
        );
        assert.deepEqual(evento, { ator_tipo: 'SISTEMA', administrador_id: null, contexto: { operacao: 'verificacao', motivo } });
        if (consertar) await q(consertar, [admin.fatorId]);
        else await q('UPDATE fatores_mfa_plataforma SET totp_segredo_cifrado = $2 WHERE id = $1', [admin.fatorId, original.c]);
      }

      assert.equal((await verificar(desafio.par, admin.codigo(step))).status, 200);
      const texto = JSON.stringify(logs);
      for (const proibido of [admin.codigo(step), admin.segredo.toString('hex'), original.c.toString('hex')]) assert.equal(texto.includes(proibido), false);
    });
  });

  describe('session fixation', () => {
    test('a sessão antiga deste navegador é revogada; a de outro dispositivo continua; token novo', async () => {
      const admin = await comTotpAtivo('fixacao');
      const antiga = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const outroDispositivo = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const desafio = await entrar(admin.email);

      const r = await verificar(`${antiga.cookie}; ${desafio.par}`, admin.codigo(await stepEstavel()));

      assert.equal(r.status, 200);
      const nova = setCookie(r, COOKIE_SESSAO());
      assert.notEqual(nova.valor, antiga.token);
      assert.notEqual(nova.valor, desafio.valor);
      assert.equal((await um('SELECT motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [antiga.id])).motivo_revogacao, 'SUBSTITUIDA_NO_NAVEGADOR');
      assert.equal((await get('/auth/me', antiga.cookie)).status, 401);
      assert.equal((await get('/auth/me', outroDispositivo.cookie)).status, 200);
      assert.equal((await get('/auth/me', nova.par)).status, 200);
      assert.equal((await um('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1 AND revogada_em IS NULL', [admin.id])).n, 2);
    });
  });

  describe('administrador, fator e desafio inválidos', () => {
    test('administrador inativado depois do desafio: nenhuma sessão', async () => {
      const admin = await comTotpAtivo('inativo');
      const desafio = await entrar(admin.email);
      await q('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [admin.id]);

      assert.equal((await verificar(desafio.par, admin.codigo(await stepEstavel()))).body.codigo, 'DESAFIO_INVALIDO');
      assert.equal(await sessoesMfa(admin), 0);
      assert.equal(await ultimoStep(admin), 1);
    });

    test('fator revogado depois do desafio: fail closed, desafio encerrado, sem cadastro automático', async () => {
      const admin = await comTotpAtivo('revogado');
      const desafio = await entrar(admin.email);
      await fatorRepo.revogar(contexto.pool, { administradorId: admin.id, fatorId: admin.fatorId, motivo: 'REVOGADO_TESTE' });

      assert.equal((await verificar(desafio.par, admin.codigo(await stepEstavel()))).body.codigo, 'DESAFIO_INVALIDO');
      assert.equal((await desafioDe(desafio.valor)).motivo_encerramento, 'SEM_FATOR_ATIVO');
      assert.equal(await sessoesMfa(admin), 0);
      assert.equal((await um("SELECT count(*)::int AS n FROM desafios_mfa_plataforma WHERE administrador_id = $1 AND tipo <> 'VERIFICACAO'", [admin.id])).n, 0);
      assert.equal((await um("SELECT count(*)::int AS n FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'PENDENTE'", [admin.id])).n, 0);
    });

    test('só PENDENTE, nenhum fator, ou código do fator de outro administrador: nenhuma sessão', async () => {
      const comPendente = await novoAdministrador('pendente');
      const fatorUid = crypto.randomUUID();
      const segredo = crypto.randomBytes(20);
      const envelope = mfaCripto.cifrarSegredoTotp({ segredo: Buffer.from(segredo), administradorId: comPendente.id, fatorUid });
      await fatorRepo.criarPendenteTotp(contexto.pool, { administradorId: comPendente.id, fatorUid, envelope, validadeMinutos: 15 });
      const step = await stepEstavel();
      assert.equal((await verificar((await desafioDireto(comPendente.id)).par, totpReferencia.codigoDoStep(segredo, step))).body.codigo, 'DESAFIO_INVALIDO');
      assert.equal((await um("SELECT estado FROM fatores_mfa_plataforma WHERE administrador_id = $1", [comPendente.id])).estado, 'PENDENTE');

      const semFator = await novoAdministrador('semfator');
      const outro = await comTotpAtivo('dono');
      assert.equal((await verificar((await desafioDireto(semFator.id)).par, outro.codigo(step))).body.codigo, 'DESAFIO_INVALIDO');
      assert.equal(await ultimoStep(outro), 1);

      for (const id of [comPendente.id, semFator.id]) {
        assert.equal((await um('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1', [id])).n, 0);
      }
    });

    test('desafio vencido ou encerrado: 401 DESAFIO_INVALIDO', async () => {
      const admin = await comTotpAtivo('vencido');
      const vencido = await entrar(admin.email);
      await q("UPDATE desafios_mfa_plataforma SET criado_em = now() - interval '10 minutes', expira_em = now() - interval '1 minute' WHERE token_hash = $1", [hashTokenSessao(vencido.valor)]);
      const encerrado = await entrar(admin.email);
      await post('/auth/logout', encerrado.par);
      const step = await stepEstavel();

      for (const desafio of [vencido, encerrado]) {
        assert.equal((await verificar(desafio.par, admin.codigo(step))).body.codigo, 'DESAFIO_INVALIDO');
      }
      assert.equal(await sessoesMfa(admin), 0);
    });
  });

  describe('concorrência', () => {
    // A 1ª requisição para logo depois do UPDATE do step, com a transação aberta; a 2ª só é
    // liberada depois de o banco mostrá-la bloqueada.
    async function disputar(t, admin, primeira, segunda) {
      const retida = sinal();
      const chegou = sinal();
      const portao = sinal();
      const pids = [];
      const travarOriginal = travaRepo.travarAdministrador;
      const stepOriginal = fatorRepo.registrarStepAceito;
      t.mock.method(travaRepo, 'travarAdministrador', async (executor, id) => {
        if (id === admin.id) {
          pids.push(executor.processID);
          if (pids.length === 2) chegou.resolver();
        }
        return travarOriginal(executor, id);
      });
      let retidas = 0;
      t.mock.method(fatorRepo, 'registrarStepAceito', async (executor, dados) => {
        const aceito = await stepOriginal(executor, dados);
        if (dados.administradorId === admin.id && retidas === 0) {
          retidas += 1;
          retida.resolver();
          await portao.promessa;
        }
        return aceito;
      });

      let r1;
      let r2;
      let espera;
      let resultados;
      try {
        r1 = primeira().then((r) => r);
        await retida.promessa;
        r2 = segunda().then((r) => r);
        await chegou.promessa;
        espera = await aguardarEsperaPeloLock(contexto.pool, pids[1]);
      } finally {
        portao.resolver();
        resultados = await Promise.allSettled([r1, r2]);
      }
      t.diagnostic(`disputa: ${JSON.stringify({ primeira: pids[0], segunda: pids[1], esperaDaSegunda: espera })}`);
      return resultados.map((r) => {
        assert.equal(r.status, 'fulfilled', String(r.reason));
        return r.value;
      });
    }

    test('mesmo desafio e mesmo TOTP sobrepostos: uma sessão; o desafio é consumido uma vez', async (t) => {
      const admin = await comTotpAtivo('mesmo');
      const desafio = await entrar(admin.email);
      const codigo = admin.codigo(await stepEstavel());

      const [a, b] = await disputar(t, admin, () => verificar(desafio.par, codigo), () => verificar(desafio.par, codigo));

      assert.deepEqual([a.status, b.status], [200, 401]);
      assert.equal(b.body.codigo, 'DESAFIO_INVALIDO');
      assert.equal(await sessoesMfa(admin), 1);
      const consumido = await desafioDe(desafio.valor);
      assert.equal(consumido.motivo_encerramento, 'CONCLUIDO');
      assert.equal((await um('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE id = $1', [consumido.sessao_criada_id])).n, 1);
    });

    test('dois desafios do mesmo administrador e mesmo TOTP sobrepostos: o step do fator vale uma vez', async (t) => {
      const admin = await comTotpAtivo('dois');
      const primeiro = await entrar(admin.email);
      const segundo = await entrar(admin.email);
      const step = await stepEstavel();

      const [a, b] = await disputar(t, admin, () => verificar(primeiro.par, admin.codigo(step)), () => verificar(segundo.par, admin.codigo(step)));

      assert.deepEqual([a.status, b.status], [200, 401], 'duas sessões para o mesmo step');
      assert.deepEqual(b.body, CORPO_INVALIDO);
      assert.equal(await sessoesMfa(admin), 1);
      assert.equal(await ultimoStep(admin), step);
      const perdedor = await desafioDe(segundo.valor);
      assert.deepEqual([perdedor.encerrado_em, perdedor.falhas], [null, 1], 'o perdedor foi barrado pelo fator, não pelo desafio');
      assert.equal(await tentativasMfa(admin, 'TOTP_REPETIDO'), 1);
    });
  });

  describe('nenhum segredo fora do lugar', () => {
    test('código, secret, tokens, ciphertext, nonce, chave e URI não aparecem em log, auditoria, erro ou outras tabelas', async (t) => {
      const logs = [];
      for (const metodo of ['log', 'error', 'warn', 'info']) t.mock.method(console, metodo, (...args) => logs.push(args));
      const admin = await comTotpAtivo('vazamento');
      const step = await stepEstavel();
      const errado = await verificar((await entrar(admin.email)).par, codigoForaDaJanela(admin, step));
      const desafio = await entrar(admin.email);
      const ok = await verificar(desafio.par, admin.codigo(step));
      const repetido = await verificar((await entrar(admin.email)).par, admin.codigo(step));
      t.mock.restoreAll();
      assert.deepEqual([errado.status, ok.status, repetido.status], [401, 200, 401]);

      const fator = await um('SELECT totp_nonce, totp_segredo_cifrado FROM fatores_mfa_plataforma WHERE id = $1', [admin.fatorId]);
      const sessao = setCookie(ok, COOKIE_SESSAO()).valor;
      const segredos = [
        admin.codigo(step), admin.segredo.toString('hex'), admin.segredo.toString('base64'),
        totp.chaveManual(Buffer.from(admin.segredo)).replace(/ /g, ''), desafio.valor, sessao,
        fator.totp_nonce.toString('hex'), fator.totp_segredo_cifrado.toString('hex'), fator.totp_segredo_cifrado.subarray(20).toString('hex'),
        process.env.MFA_TOTP_KEY_V1, 'otpauth://',
      ];

      for (const tabela of ['logs_auditoria_plataforma', 'login_tentativas_plataforma', 'desafios_mfa_plataforma', 'sessoes_plataforma']) {
        const texto = (await q(`SELECT row_to_json(t)::text AS l FROM ${tabela} t`)).rows.map((r) => r.l).join('\n');
        for (const valor of segredos) assert.equal(texto.includes(valor), false, `${tabela} contém segredo`);
      }
      const textoLogs = JSON.stringify(logs);
      const respostas = JSON.stringify([errado.body, ok.body, repetido.body]);
      for (const valor of segredos) {
        assert.equal(textoLogs.includes(valor), false, 'log técnico com segredo');
        assert.equal(respostas.includes(valor), false, 'resposta com segredo');
      }
    });
  });
});
