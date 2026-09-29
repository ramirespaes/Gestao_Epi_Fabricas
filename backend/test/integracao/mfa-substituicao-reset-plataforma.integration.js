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
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const liberacaoRepo = require('../../src/repositories/liberacao-cadastro-mfa-plataforma.repository');
const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const sessaoRepo = require('../../src/repositories/sessao-plataforma.repository');
const mfaCripto = require('../../src/security/mfa-cripto');
const totp = require('../../src/security/totp');
const codigosMfa = require('../../src/security/codigos-mfa');
const { hashTokenSessao } = require('../../src/security/token');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const scriptRedefinir = require('../../scripts/mfa-redefinir');

const MIGRATIONS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048', '049', '050', '051', '052', '053', '054'];
const SENHA = 'planeta-nebulosa-ozonio-42';
const REAUTENTICACAO_INVALIDA = { status: 'error', codigo: 'REAUTENTICACAO_INVALIDA', message: 'Senha ou código inválidos' };
const COOKIE_DESAFIO = () => authConfig.desafioMfa.cookieNome;
const COOKIE_SESSAO = () => authConfig.sessao.cookieNomeAdmin;
const CODIGO_IMPRESSO = /[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}/;
const semChave = mfaCripto.criarCriptografiaMfa({ obterChave: () => { throw new Error('chave ausente'); }, versaoAtual: 1 });

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

describe('substituição do TOTP, regeneração de recovery codes e reset por CLI (PostgreSQL real)', () => {
  let contexto;
  let app;
  let hashSenha;
  let sequencia = 0;

  const q = (sql, params) => contexto.pool.query(sql, params);
  const um = async (sql, params) => (await q(sql, params)).rows[0];
  const n = async (sql, params) => (await um(sql, params)).n;
  const post = (caminho, cookie, corpo = {}) => {
    const r = request(app).post(`/api/plataforma${caminho}`).send(corpo);
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const get = (caminho, cookie) => request(app).get(`/api/plataforma${caminho}`).set('Cookie', cookie);

  async function novoAdministrador(prefixo) {
    sequencia += 1;
    const email = `${prefixo}-${sequencia}-${crypto.randomBytes(3).toString('hex')}@safework.com.br`;
    const { id } = await um('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hashSenha]);
    return { id, email };
  }

  async function comTotp(prefixo) {
    const admin = await novoAdministrador(prefixo);
    const segredo = crypto.randomBytes(20);
    const fatorUid = crypto.randomUUID();
    const envelope = mfaCripto.cifrarSegredoTotp({ segredo: Buffer.from(segredo), administradorId: admin.id, fatorUid });
    const fator = await fatorRepo.criarPendenteTotp(contexto.pool, { administradorId: admin.id, fatorUid, envelope, validadeMinutos: 15 });
    assert.equal(await fatorRepo.ativarTotp(contexto.pool, { administradorId: admin.id, fatorId: fator.id, step: 1 }), true);
    const lote = await loteRepo.criar(contexto.pool, admin.id);
    const codigos = Array.from({ length: 10 }, () => codigosMfa.gerarCodigo());
    await codigoRepo.inserirHashes(contexto.pool, {
      administradorId: admin.id, loteId: lote.id, hashes: codigos.map((c) => codigosMfa.hashCodigoRecuperacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(c) })),
    });
    const sessao = await criarSessaoAdministrativa(contexto.pool, admin.id);
    return { ...admin, segredo, fatorId: fator.id, codigos, sessao, codigoTotp: (step) => totpReferencia.codigoDoStep(segredo, step) };
  }

  async function stepEstavel() {
    const agora = (await um('SELECT clock_timestamp() AS t')).t.getTime();
    const restante = 30_000 - (agora % 30_000);
    if (restante > 4_000) return totpReferencia.stepDe(agora);
    await new Promise((r) => { setTimeout(r, restante + 100); });
    return totpReferencia.stepDe((await um('SELECT clock_timestamp() AS t')).t.getTime());
  }

  const iniciar = (cookie, codigo, senha = SENHA) => post('/auth/mfa/substituicao/iniciar', cookie, { senha, codigo });
  const regenerar = (cookie, codigo, senha = SENHA) => post('/auth/mfa/recuperacao/regenerar', cookie, { senha, codigo });
  const confirmar = (cookieSessao, cookieDesafio, codigo) => post('/auth/mfa/substituicao/confirmar', `${cookieSessao}; ${cookieDesafio}`, { codigo });

  async function substituicaoIniciada(admin, step) {
    const r = await iniciar(admin.sessao.cookie, admin.codigoTotp(step));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const segredoNovo = totpReferencia.segredoDaChaveManual(r.body.cadastro.chaveManual);
    return { resposta: r, desafio: setCookie(r, COOKIE_DESAFIO()), codigoNovo: (s) => totpReferencia.codigoDoStep(segredoNovo, s) };
  }

  async function entrar(email) {
    const r = await post('/auth/login', null, { email, senha: SENHA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { ...setCookie(r, COOKIE_DESAFIO()), etapa: r.body.etapa };
  }

  async function redefinir(email) {
    const logs = [];
    const saida = { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
    const codigoSaida = await scriptRedefinir.executarComando({ email, confirmo: true }, { pool: contexto.pool, saida });
    return { codigoSaida, logs, codigo: logs.join('\n').match(CODIGO_IMPRESSO)?.[0] ?? null };
  }

  // Outro cliente com a senha e um recovery code: abre RECUPERACAO e guarda o TOTP do PENDENTE.
  async function recuperacaoAberta(admin, indice = 0) {
    const login = await entrar(admin.email);
    const r = await post('/auth/mfa/recuperacao', login.par, { codigoRecuperacao: admin.codigos[indice] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const segredo = totpReferencia.segredoDaChaveManual(r.body.cadastro.chaveManual);
    return { desafio: setCookie(r, COOKIE_DESAFIO()), codigoPendente: (s) => totpReferencia.codigoDoStep(segredo, s) };
  }
  const concluirRecuperacao = (cookie, codigo) => post('/auth/mfa/cadastro/confirmar', cookie, { codigo });
  const motivoDoDesafio = async (token) => (await um('SELECT motivo_encerramento FROM desafios_mfa_plataforma WHERE token_hash = $1', [hashTokenSessao(token)])).motivo_encerramento;
  const sessoesValidasPorMetodo = async (admin) => (await q('SELECT mfa_metodo FROM sessoes_plataforma WHERE administrador_id = $1 AND revogada_em IS NULL ORDER BY id', [admin.id])).rows.map((s) => s.mfa_metodo);

  const fatores = async (admin) => (await q('SELECT id, estado, motivo_revogacao, totp_segredo_cifrado IS NULL AS sem_segredo, totp_ultimo_step_aceito AS step FROM fatores_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows;
  const contarEstado = (admin, estado) => n('SELECT count(*)::int AS n FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = $2', [admin.id, estado]);
  const lotesAtivos = (admin) => n("SELECT count(*)::int AS n FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [admin.id]);
  const sessoesValidas = (admin) => n('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1 AND revogada_em IS NULL', [admin.id]);
  const desafiosAbertos = (admin, tipo = null) => n('SELECT count(*)::int AS n FROM desafios_mfa_plataforma WHERE administrador_id = $1 AND encerrado_em IS NULL AND ($2::text IS NULL OR tipo = $2)', [admin.id, tipo]);
  const liberacoesAbertas = async (admin) => (await q('SELECT codigo_hash FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1 AND consumida_em IS NULL AND revogada_em IS NULL', [admin.id])).rows.map((l) => l.codigo_hash);
  const hashLiberacao = (admin, codigo) => codigosMfa.hashCodigoLiberacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(codigo) });
  const ultimoStep = async (admin) => Number((await um("SELECT totp_ultimo_step_aceito AS s FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [admin.id]))?.s ?? NaN);
  const idsDeSessao = async (admin) => (await q('SELECT id FROM sessoes_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows.map((s) => s.id);

  // Evento sensível concluído: a resposta só remove cookies, nenhuma linha de sessão nasce e nenhuma segue válida.
  async function encerrouSemSessaoNova(resposta, admin, sessoesAntes) {
    const nomes = (resposta.headers['set-cookie'] ?? []).map((c) => c.slice(0, c.indexOf('=')));
    assert.deepEqual(nomes.sort(), [COOKIE_SESSAO(), COOKIE_DESAFIO()].sort(), 'nenhum cookie de sessão nova');
    for (const nome of nomes) {
      const c = setCookie(resposta, nome);
      assert.deepEqual([c.valor, c.atributos['max-age']], ['', '0'], `${nome} removido`);
    }
    assert.deepEqual(await idsDeSessao(admin), sessoesAntes, 'nenhuma linha de sessão nova');
    assert.equal(await sessoesValidas(admin), 0);
    assert.equal((await get('/auth/me', admin.sessao.cookie)).status, 401);
  }

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

  describe('substituição: iniciar', () => {
    test('reautenticação consome o step atual; PENDENTE novo; desafio SUBSTITUICAO ligado à sessão; o fator antigo segue autenticando e o PENDENTE não', async () => {
      const admin = await comTotp('iniciar');
      const step = await stepEstavel();

      const { resposta, desafio, codigoNovo } = await substituicaoIniciada(admin, step);

      assert.equal(resposta.body.etapa, 'SUBSTITUICAO');
      assert.equal(setCookie(resposta, COOKIE_SESSAO()), null);
      const lista = await fatores(admin);
      assert.deepEqual(lista.map((f) => [f.estado, Number(f.step)]), [['ATIVO', step], ['PENDENTE', 0]]);
      const linha = await um('SELECT tipo, sessao_origem_id, fator_pendente_id FROM desafios_mfa_plataforma WHERE token_hash = $1', [hashTokenSessao(desafio.valor)]);
      assert.deepEqual([linha.tipo, linha.sessao_origem_id, linha.fator_pendente_id], ['SUBSTITUICAO', admin.sessao.id, lista[1].id]);
      assert.equal((await get('/auth/me', admin.sessao.cookie)).status, 200);
      assert.equal(await n("SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE acao = 'MFA_SUBSTITUICAO_INICIADA' AND administrador_id = $1", [admin.id]), 1);

      const login = await entrar(admin.email);
      assert.equal((await post('/auth/mfa/verificar', login.par, { codigo: codigoNovo(step) })).body.codigo, 'MFA_CODIGO_INVALIDO', 'o PENDENTE não autentica');
      assert.equal((await post('/auth/mfa/verificar', login.par, { codigo: admin.codigoTotp(step + 1) })).status, 200);
    });

    test('senha errada, TOTP errado e replay: mesma resposta; nada criado; tentativas no cooldown de MFA', async () => {
      const admin = await comTotp('reautenticacao');
      const step = await stepEstavel();
      const naJanela = new Set([-1, 0, 1].map((d) => admin.codigoTotp(step + d)));
      const errado = ['000000', '111111', '222222'].find((c) => !naJanela.has(c));

      assert.deepEqual((await iniciar(admin.sessao.cookie, admin.codigoTotp(step), 'senha-errada-qualquer')).body, REAUTENTICACAO_INVALIDA);
      assert.deepEqual((await iniciar(admin.sessao.cookie, errado)).body, REAUTENTICACAO_INVALIDA);
      assert.equal(await ultimoStep(admin), 1);
      assert.equal(await contarEstado(admin, 'PENDENTE'), 0);

      await substituicaoIniciada(admin, step);
      assert.deepEqual((await iniciar(admin.sessao.cookie, admin.codigoTotp(step))).body, REAUTENTICACAO_INVALIDA, 'replay');
      const motivos = (await q('SELECT motivo FROM login_tentativas_plataforma WHERE administrador_id = $1 AND NOT sucesso ORDER BY id', [admin.id])).rows.map((r) => r.motivo);
      assert.deepEqual(motivos, ['REAUTENTICACAO_INVALIDA', 'TOTP_INVALIDO', 'TOTP_REPETIDO']);
      assert.equal(await desafiosAbertos(admin, 'SUBSTITUICAO'), 1);
    });

    test('fator revogado, administrador inativo e sessão revogada: nenhuma substituição', async () => {
      const semFator = await comTotp('semfator');
      await fatorRepo.revogar(contexto.pool, { administradorId: semFator.id, fatorId: semFator.fatorId, motivo: 'REVOGADO_TESTE' });
      assert.deepEqual((await iniciar(semFator.sessao.cookie, semFator.codigoTotp(await stepEstavel()))).body, REAUTENTICACAO_INVALIDA);
      assert.equal(await contarEstado(semFator, 'PENDENTE'), 0);

      const inativo = await comTotp('inativo');
      await q('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [inativo.id]);
      assert.equal((await iniciar(inativo.sessao.cookie, inativo.codigoTotp(await stepEstavel()))).body.codigo, 'SESSAO_INVALIDA');

      const revogada = await comTotp('revogada');
      await q("UPDATE sessoes_plataforma SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [revogada.sessao.id]);
      assert.equal((await iniciar(revogada.sessao.cookie, revogada.codigoTotp(await stepEstavel()))).body.codigo, 'SESSAO_INVALIDA');
      for (const admin of [inativo, revogada]) assert.equal(await ultimoStep(admin), 1);
    });

    test('cinco reautenticações erradas ativam o cooldown; a seguinte, mesmo certa, recebe 429 sem consumir o step', async () => {
      const admin = await comTotp('cooldown');
      for (let i = 0; i < authConfig.cooldown.niveis[0].falhas; i += 1) await iniciar(admin.sessao.cookie, '000000', 'senha-errada-qualquer');

      const r = await iniciar(admin.sessao.cookie, admin.codigoTotp(await stepEstavel()));

      assert.deepEqual([r.status, r.body.codigo], [429, 'MFA_EM_COOLDOWN']);
      assert.ok(Number(r.headers['retry-after']) > 0);
      assert.equal(await ultimoStep(admin), 1);
    });
  });

  describe('substituição: confirmar', () => {
    test('troca atômica: antigo REVOGADO sem material, novo ATIVO, 10 códigos novos, todas as sessões revogadas (inclusive a de origem), nenhuma sessão nova; novo login completo obrigatório', async () => {
      const admin = await comTotp('confirmar');
      const outroDispositivo = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const outroDesafio = await entrar(admin.email);
      const sessoesAntes = await idsDeSessao(admin);

      const r = await confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step));

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body).sort(), ['codigosRecuperacao', 'status']);
      assert.equal(r.body.codigosRecuperacao.length, 10);
      await encerrouSemSessaoNova(r, admin, sessoesAntes);

      const [antigo, novo] = await fatores(admin);
      assert.deepEqual([antigo.estado, antigo.motivo_revogacao, antigo.sem_segredo], ['REVOGADO', 'SUBSTITUIDO', true]);
      assert.deepEqual([novo.estado, Number(novo.step)], ['ATIVO', step]);
      assert.equal(await lotesAtivos(admin), 1);
      assert.equal(await n("SELECT count(*)::int AS n FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND motivo_revogacao = 'SUBSTITUICAO'", [admin.id]), 1);
      for (const antiga of [admin.sessao, outroDispositivo]) {
        assert.equal((await um('SELECT motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [antiga.id])).motivo_revogacao, 'MFA_SUBSTITUIDO');
        assert.equal((await get('/auth/me', antiga.cookie)).status, 401);
      }
      assert.equal((await um('SELECT motivo_encerramento FROM desafios_mfa_plataforma WHERE token_hash = $1', [hashTokenSessao(outroDesafio.valor)])).motivo_encerramento, 'MFA_SUBSTITUIDO');
      const concluido = await um('SELECT motivo_encerramento, sessao_criada_id FROM desafios_mfa_plataforma WHERE token_hash = $1', [hashTokenSessao(desafio.valor)]);
      assert.deepEqual([concluido.motivo_encerramento, concluido.sessao_criada_id], ['CONCLUIDO', null]);
      const acoes = (await q("SELECT acao, ator_tipo FROM logs_auditoria_plataforma WHERE administrador_id = $1 AND acao IN ('MFA_FATOR_SUBSTITUIDO', 'SESSOES_ADMINISTRADOR_REVOGADAS') ORDER BY id", [admin.id])).rows;
      assert.deepEqual(acoes.map((a) => [a.acao, a.ator_tipo]), [['MFA_FATOR_SUBSTITUIDO', 'ADMINISTRADOR'], ['SESSOES_ADMINISTRADOR_REVOGADAS', 'ADMINISTRADOR']]);

      const login = await entrar(admin.email);
      assert.equal((await post('/auth/mfa/verificar', login.par, { codigo: admin.codigoTotp(step + 1) })).body.codigo, 'MFA_CODIGO_INVALIDO', 'o fator antigo não autentica mais');
      assert.equal((await post('/auth/mfa/recuperacao', login.par, { codigoRecuperacao: admin.codigos[0] })).body.codigo, 'MFA_CODIGO_INVALIDO', 'recovery code antigo não vale');
      const entrada = await post('/auth/mfa/verificar', login.par, { codigo: codigoNovo(step + 1) });
      assert.equal(entrada.status, 200);
      assert.deepEqual(await sessoesValidasPorMetodo(admin), ['TOTP'], 'só o login completo devolve uma sessão');
      assert.equal((await get('/auth/me', setCookie(entrada, COOKIE_SESSAO()).par)).status, 200);
    });

    test('outra sessão do mesmo administrador não conclui; TOTP novo errado não troca nada', async () => {
      const admin = await comTotp('outrasessao');
      const outra = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);

      assert.equal((await confirmar(outra.cookie, desafio.par, codigoNovo(step))).body.codigo, 'DESAFIO_INVALIDO');
      const naJanela = new Set([-1, 0, 1].map((d) => codigoNovo(step + d)));
      const errado = ['000000', '111111', '222222'].find((c) => !naJanela.has(c));
      assert.equal((await confirmar(admin.sessao.cookie, desafio.par, errado)).body.codigo, 'MFA_CODIGO_INVALIDO');
      assert.deepEqual((await fatores(admin)).map((f) => f.estado), ['ATIVO', 'PENDENTE']);
      assert.equal(await sessoesValidas(admin), 2);
      assert.equal((await confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step))).status, 200, 'a sessão de origem ainda conclui');
    });

    test('abandono: o antigo segue ATIVO, o PENDENTE nunca autentica, nada é trocado', async () => {
      const admin = await comTotp('abandono');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      await q("UPDATE desafios_mfa_plataforma SET criado_em = now() - interval '30 minutes', expira_em = now() - interval '1 minute' WHERE token_hash = $1", [hashTokenSessao(desafio.valor)]);

      assert.equal((await confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step))).body.codigo, 'DESAFIO_INVALIDO');
      assert.deepEqual((await fatores(admin)).map((f) => f.estado), ['ATIVO', 'PENDENTE']);
      assert.equal(await lotesAtivos(admin), 1);
      const login = await entrar(admin.email);
      assert.equal((await post('/auth/mfa/verificar', login.par, { codigo: codigoNovo(step + 1) })).body.codigo, 'MFA_CODIGO_INVALIDO');
      assert.equal((await post('/auth/mfa/verificar', login.par, { codigo: admin.codigoTotp(step + 1) })).status, 200);
    });

    test('falha criptográfica real: chave histórica do fator atual, chave atual e cifragem do novo: 503 sem consumir step nem criar nada; decifrar o novo na confirmação: 503 sem trocar', async (t) => {
      t.mock.method(console, 'error', () => {});
      const admin = await comTotp('cripto');
      const step = await stepEstavel();

      await q('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 2 WHERE id = $1', [admin.fatorId]);
      assert.deepEqual([(await iniciar(admin.sessao.cookie, admin.codigoTotp(step))).status], [503]);
      await q('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 1 WHERE id = $1', [admin.fatorId]);

      t.mock.method(mfaCripto, 'garantirChaveAtual', semChave.garantirChaveAtual);
      assert.equal((await iniciar(admin.sessao.cookie, admin.codigoTotp(step))).status, 503);
      t.mock.restoreAll();
      t.mock.method(console, 'error', () => {});
      t.mock.method(mfaCripto, 'cifrarSegredoTotp', semChave.cifrarSegredoTotp);
      assert.equal((await iniciar(admin.sessao.cookie, admin.codigoTotp(step))).status, 503);
      t.mock.restoreAll();
      t.mock.method(console, 'error', () => {});

      assert.equal(await ultimoStep(admin), 1);
      assert.equal(await contarEstado(admin, 'PENDENTE'), 0);
      assert.equal(await desafiosAbertos(admin), 0);
      assert.equal(await n("SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE acao = 'MFA_CHAVE_INDISPONIVEL' AND ator_tipo = 'SISTEMA' AND administrador_afetado_id = $1", [admin.id]), 3);
      assert.equal(await n("SELECT count(*)::int AS n FROM login_tentativas_plataforma WHERE administrador_id = $1 AND NOT sucesso", [admin.id]), 0);

      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const pendenteId = (await fatores(admin))[1].id;
      await q('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 2 WHERE id = $1', [pendenteId]);
      assert.equal((await confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step))).status, 503);
      assert.deepEqual((await fatores(admin)).map((f) => f.estado), ['ATIVO', 'PENDENTE']);
      assert.equal(await sessoesValidas(admin), 1);
    });
  });

  describe('regeneração dos recovery codes', () => {
    test('reautenticação; lote REGENERADO trocado por 10 códigos; os antigos deixam de valer; todas as sessões revogadas; nenhuma sessão nova; novo login completo obrigatório', async () => {
      const admin = await comTotp('regenerar');
      const outro = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const step = await stepEstavel();
      const sessoesAntes = await idsDeSessao(admin);

      const r = await regenerar(admin.sessao.cookie, admin.codigoTotp(step));

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body).sort(), ['codigosRecuperacao', 'status']);
      assert.equal(r.body.codigosRecuperacao.length, 10);
      await encerrouSemSessaoNova(r, admin, sessoesAntes);
      const lotes = (await q('SELECT id, estado, motivo_revogacao FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows;
      assert.deepEqual(lotes.map((l) => [l.estado, l.motivo_revogacao]), [['REVOGADO', 'REGENERADO'], ['ATIVO', null]]);
      const hashes = (await q('SELECT codigo_hash FROM codigos_recuperacao_mfa_plataforma WHERE lote_id = $1 ORDER BY codigo_hash', [lotes[1].id])).rows.map((c) => c.codigo_hash);
      assert.deepEqual(hashes, r.body.codigosRecuperacao.map((c) => codigosMfa.hashCodigoRecuperacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(c) })).sort());
      for (const antiga of [admin.sessao, outro]) {
        assert.equal((await um('SELECT motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [antiga.id])).motivo_revogacao, 'MFA_CODIGOS_REGENERADOS');
        assert.equal((await get('/auth/me', antiga.cookie)).status, 401);
      }
      assert.equal(await ultimoStep(admin), step);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['ATIVO', null]]);
      assert.equal(await n("SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE acao = 'MFA_CODIGOS_RECUPERACAO_REGENERADOS' AND administrador_id = $1", [admin.id]), 1);

      const avulsa = await criarSessaoAdministrativa(contexto.pool, admin.id);
      assert.deepEqual((await regenerar(avulsa.cookie, admin.codigoTotp(step))).body, REAUTENTICACAO_INVALIDA, 'o mesmo step não reautentica de novo');
      const login = await entrar(admin.email);
      assert.equal((await post('/auth/mfa/recuperacao', login.par, { codigoRecuperacao: admin.codigos[0] })).body.codigo, 'MFA_CODIGO_INVALIDO');
      const entrada = await post('/auth/mfa/verificar', login.par, { codigo: admin.codigoTotp(step + 1) });
      assert.equal(entrada.status, 200, 'o novo login completo funciona com o mesmo TOTP');
      assert.equal((await get('/auth/me', setCookie(entrada, COOKIE_SESSAO()).par)).status, 200);
    });

    test('senha ou TOTP inválidos e fator indecifrável: nada muda; lote antigo segue válido', async (t) => {
      t.mock.method(console, 'error', () => {});
      const admin = await comTotp('regenerarfalha');
      const step = await stepEstavel();

      assert.deepEqual((await regenerar(admin.sessao.cookie, admin.codigoTotp(step), 'senha-errada-qualquer')).body, REAUTENTICACAO_INVALIDA);
      await q('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 2 WHERE id = $1', [admin.fatorId]);
      assert.equal((await regenerar(admin.sessao.cookie, admin.codigoTotp(step))).status, 503);
      await q('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 1 WHERE id = $1', [admin.fatorId]);

      assert.equal(await n('SELECT count(*)::int AS n FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1', [admin.id]), 1);
      assert.equal(await lotesAtivos(admin), 1);
      assert.equal(await sessoesValidas(admin), 1);
      assert.equal(await ultimoStep(admin), 1);
    });
  });

  describe('regeneração invalida fluxos MFA abertos', () => {
    test('RECUPERACAO aberta por outro cliente: a regeneração a encerra e revoga o PENDENTE; a confirmação posterior falha fechado', async () => {
      const admin = await comTotp('regenrec');
      const step = await stepEstavel();
      const ataque = await recuperacaoAberta(admin);
      const sessoesAntes = await idsDeSessao(admin);

      const r = await regenerar(admin.sessao.cookie, admin.codigoTotp(step));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await encerrouSemSessaoNova(r, admin, sessoesAntes);

      const tentativa = await concluirRecuperacao(ataque.desafio.par, ataque.codigoPendente(step));

      assert.deepEqual([tentativa.status, tentativa.body.codigo], [401, 'DESAFIO_INVALIDO'], 'a RECUPERACAO anterior não pode prosseguir');
      assert.equal(setCookie(tentativa, COOKIE_SESSAO()), null);
      assert.equal(await motivoDoDesafio(ataque.desafio.valor), 'MFA_CODIGOS_REGENERADOS');
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao, f.sem_segredo]), [['ATIVO', null, false], ['REVOGADO', 'MFA_CODIGOS_REGENERADOS', true]]);
      assert.equal(await lotesAtivos(admin), 1);
      assert.equal(r.body.codigosRecuperacao.length, 10);
      assert.deepEqual(await idsDeSessao(admin), sessoesAntes, 'a tentativa também não cria sessão');
      assert.equal(await sessoesValidas(admin), 0);
      const login = await entrar(admin.email);
      assert.equal((await post('/auth/mfa/recuperacao', login.par, { codigoRecuperacao: admin.codigos[1] })).body.codigo, 'MFA_CODIGO_INVALIDO', 'código antigo não vale');
    });

    test('SUBSTITUICAO aberta: a regeneração a encerra e revoga o PENDENTE; a confirmação posterior falha com qualquer sessão; o fator original segue', async () => {
      const admin = await comTotp('regensub');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const sessoesAntes = await idsDeSessao(admin);

      const r = await regenerar(admin.sessao.cookie, admin.codigoTotp(step + 1));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await encerrouSemSessaoNova(r, admin, sessoesAntes);

      const depois = await criarSessaoAdministrativa(contexto.pool, admin.id);
      for (const cookieSessao of [admin.sessao.cookie, depois.cookie]) {
        const tentativa = await confirmar(cookieSessao, desafio.par, codigoNovo(step));
        assert.equal(tentativa.status, 401);
        assert.equal(setCookie(tentativa, COOKIE_SESSAO()), null);
      }
      assert.equal(await motivoDoDesafio(desafio.valor), 'MFA_CODIGOS_REGENERADOS');
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao, f.sem_segredo]), [['ATIVO', null, false], ['REVOGADO', 'MFA_CODIGOS_REGENERADOS', true]]);
      assert.equal(await desafiosAbertos(admin), 0);
      assert.equal(await lotesAtivos(admin), 1);
      assert.deepEqual(await idsDeSessao(admin), [...sessoesAntes, depois.id], 'as confirmações recusadas não criam sessão');
    });
  });

  describe('reset operacional por CLI', () => {
    test('revoga fatores, lote, desafios, sessões e liberação anterior; uma liberação CLI_RESET; auditoria OPERACAO_CLI; sem secret nem sessão; depois o cadastro seguro funciona', async () => {
      const admin = await comTotp('reset');
      const step = await stepEstavel();
      await substituicaoIniciada(admin, step);
      const outraSessao = await criarSessaoAdministrativa(contexto.pool, admin.id);
      await entrar(admin.email);
      const antiga = codigosMfa.gerarCodigo();
      await liberacaoRepo.criar(contexto.pool, { administradorId: admin.id, codigoHash: hashLiberacao(admin, antiga), origem: 'CLI_LIBERACAO', validadeMinutos: 30 });

      const r = await redefinir(admin.email);

      assert.equal(r.codigoSaida, scriptRedefinir.SAIDAS.OK);
      assert.equal(r.logs.join('\n').split(r.codigo).length - 1, 1);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao, f.sem_segredo]), [['REVOGADO', 'RESET_OPERACIONAL', true], ['REVOGADO', 'RESET_OPERACIONAL', true]]);
      assert.equal(await lotesAtivos(admin), 0);
      assert.equal(await desafiosAbertos(admin), 0);
      assert.equal(await sessoesValidas(admin), 0);
      for (const sessao of [admin.sessao, outraSessao]) assert.equal((await get('/auth/me', sessao.cookie)).status, 401);
      assert.deepEqual(await liberacoesAbertas(admin), [hashLiberacao(admin, r.codigo)]);
      assert.equal((await um("SELECT origem FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1 AND revogada_em IS NULL AND consumida_em IS NULL", [admin.id])).origem, 'CLI_RESET');
      const auditorias = (await q('SELECT acao, ator_tipo, administrador_id FROM logs_auditoria_plataforma WHERE administrador_afetado_id = $1 AND ator_tipo = $2 ORDER BY id', [admin.id, 'OPERACAO_CLI'])).rows;
      assert.deepEqual(auditorias.map((a) => [a.acao, a.administrador_id]), [['MFA_RESET_OPERACIONAL', null], ['LIBERACAO_CADASTRO_CRIADA', null], ['SESSOES_ADMINISTRADOR_REVOGADAS', null]]);
      assert.equal((await um('SELECT ativo FROM administradores_plataforma WHERE id = $1', [admin.id])).ativo, true);

      const login = await entrar(admin.email);
      assert.equal(login.etapa, 'LIBERACAO');
      const cadastro = await post('/auth/mfa/liberacao', login.par, { codigoLiberacao: r.codigo });
      assert.equal(cadastro.status, 200);
      const novoSegredo = totpReferencia.segredoDaChaveManual(cadastro.body.cadastro.chaveManual);
      const fim = await post('/auth/mfa/cadastro/confirmar', setCookie(cadastro, COOKIE_DESAFIO()).par, { codigo: totpReferencia.codigoDoStep(novoSegredo, await stepEstavel()) });
      assert.equal(fim.status, 200);
    });

    test('administrador inexistente ou inativo: saída própria, nada impresso e nada alterado', async () => {
      const inexistente = await redefinir('ninguem@safework.com.br');
      assert.deepEqual([inexistente.codigoSaida, inexistente.codigo], [scriptRedefinir.SAIDAS.ADMINISTRADOR_INEXISTENTE, null]);

      const admin = await comTotp('resetinativo');
      await substituicaoIniciada(admin, await stepEstavel());
      await q('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [admin.id]);
      const antes = {
        fatores: await fatores(admin),
        lotesAtivos: await lotesAtivos(admin),
        desafiosAbertos: await desafiosAbertos(admin),
        sessoesValidas: await sessoesValidas(admin),
        liberacoes: await n('SELECT count(*)::int AS n FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1', [admin.id]),
        auditorias: await n('SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE administrador_afetado_id = $1', [admin.id]),
      };

      const r = await redefinir(admin.email);

      assert.deepEqual([r.codigoSaida, r.codigo], [scriptRedefinir.SAIDAS.ADMINISTRADOR_INATIVO, null]);
      assert.deepEqual({
        fatores: await fatores(admin),
        lotesAtivos: await lotesAtivos(admin),
        desafiosAbertos: await desafiosAbertos(admin),
        sessoesValidas: await sessoesValidas(admin),
        liberacoes: await n('SELECT count(*)::int AS n FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1', [admin.id]),
        auditorias: await n('SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE administrador_afetado_id = $1', [admin.id]),
      }, antes);
      assert.equal((await um('SELECT ativo FROM administradores_plataforma WHERE id = $1', [admin.id])).ativo, false);
    });
  });

  describe('logout com PENDENTE', () => {
    test('SUBSTITUICAO aberta: logout encerra o desafio, revoga o PENDENTE como ABANDONADO e a sessão; o antigo segue ATIVO; idempotente', async () => {
      const admin = await comTotp('logout');
      const step = await stepEstavel();
      const { desafio } = await substituicaoIniciada(admin, step);

      const r = await post('/auth/logout', `${admin.sessao.cookie}; ${desafio.par}`);

      assert.equal(r.status, 200);
      assert.equal((await um('SELECT motivo_encerramento FROM desafios_mfa_plataforma WHERE token_hash = $1', [hashTokenSessao(desafio.valor)])).motivo_encerramento, 'LOGOUT');
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['ATIVO', null], ['REVOGADO', 'ABANDONADO']]);
      assert.equal(await sessoesValidas(admin), 0);
      assert.equal((await post('/auth/logout', `${admin.sessao.cookie}; ${desafio.par}`)).status, 200);
    });
  });

  describe('concorrência', () => {
    async function disputar(t, admin, [alvo, metodo], primeira, segunda) {
      const retida = sinal();
      const chegou = sinal();
      const portao = sinal();
      const pids = [];
      const travarOriginal = travaRepo.travarAdministrador;
      const original = alvo[metodo];
      t.mock.method(travaRepo, 'travarAdministrador', async (executor, id) => {
        if (id === admin.id) {
          pids.push(executor.processID);
          if (pids.length === 2) chegou.resolver();
        }
        return travarOriginal(executor, id);
      });
      let retidas = 0;
      t.mock.method(alvo, metodo, async (executor, dados, ...resto) => {
        const r = await original(executor, dados, ...resto);
        if (dados?.administradorId === admin.id && retidas === 0) {
          retidas += 1;
          retida.resolver();
          await portao.promessa;
        }
        return r;
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
      t.diagnostic(`disputa: ${JSON.stringify({ esperaDaSegunda: espera })}`);
      return resultados.map((r) => {
        assert.equal(r.status, 'fulfilled', String(r.reason));
        return r.value;
      });
    }

    async function placar(t, admin) {
      const final = {
        ativos: await contarEstado(admin, 'ATIVO'),
        pendentes: await contarEstado(admin, 'PENDENTE'),
        lotesAtivos: await lotesAtivos(admin),
        desafiosAbertos: await desafiosAbertos(admin),
        sessoesValidas: await sessoesValidas(admin),
        liberacoesAbertas: (await liberacoesAbertas(admin)).length,
      };
      t.diagnostic(`placar: ${JSON.stringify(final)}`);
      return final;
    }

    test('A: duas substituições iniciadas (steps diferentes): a segunda substitui a primeira; um PENDENTE, um SUBSTITUICAO aberto, um ATIVO', async (t) => {
      const admin = await comTotp('duasinicios');
      const step = await stepEstavel();

      const [a, b] = await disputar(t, admin, [fatorRepo, 'criarPendenteTotp'],
        () => iniciar(admin.sessao.cookie, admin.codigoTotp(step)), () => iniciar(admin.sessao.cookie, admin.codigoTotp(step + 1)));

      assert.deepEqual([a.status, b.status], [200, 200]);
      assert.equal((await um('SELECT motivo_encerramento FROM desafios_mfa_plataforma WHERE token_hash = $1', [hashTokenSessao(setCookie(a, COOKIE_DESAFIO()).valor)])).motivo_encerramento, 'SUBSTITUICAO_INICIADA');
      assert.deepEqual(await placar(t, admin), { ativos: 1, pendentes: 1, lotesAtivos: 1, desafiosAbertos: 1, sessoesValidas: 1, liberacoesAbertas: 0 });
    });

    test('A2: duas substituições com o mesmo TOTP: o step só reautentica uma vez', async (t) => {
      const admin = await comTotp('mesmotoken');
      const codigo = admin.codigoTotp(await stepEstavel());

      const [a, b] = await disputar(t, admin, [fatorRepo, 'criarPendenteTotp'], () => iniciar(admin.sessao.cookie, codigo), () => iniciar(admin.sessao.cookie, codigo));

      assert.deepEqual([a.status, b.status, b.body.codigo], [200, 401, 'REAUTENTICACAO_INVALIDA']);
      assert.deepEqual(await placar(t, admin), { ativos: 1, pendentes: 1, lotesAtivos: 1, desafiosAbertos: 1, sessoesValidas: 1, liberacoesAbertas: 0 });
    });

    test('B: duas confirmações do mesmo SUBSTITUICAO: uma troca, antigo revogado uma vez, um lote, nenhuma sessão nova', async (t) => {
      const admin = await comTotp('duasconfirmacoes');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const codigo = codigoNovo(step);
      const sessoesAntes = await idsDeSessao(admin);

      const [a, b] = await disputar(t, admin, [fatorRepo, 'ativarTotp'],
        () => confirmar(admin.sessao.cookie, desafio.par, codigo), () => confirmar(admin.sessao.cookie, desafio.par, codigo));

      assert.deepEqual([a.status, b.status], [200, 401]);
      await encerrouSemSessaoNova(a, admin, sessoesAntes);
      assert.equal(setCookie(b, COOKIE_SESSAO()), null);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['REVOGADO', 'SUBSTITUIDO'], ['ATIVO', null]]);
      assert.deepEqual(await placar(t, admin), { ativos: 1, pendentes: 0, lotesAtivos: 1, desafiosAbertos: 0, sessoesValidas: 0, liberacoesAbertas: 0 });
    });

    test('C: duas regenerações com a mesma sessão e o mesmo TOTP: um lote novo, nenhuma sessão nova', async (t) => {
      const admin = await comTotp('duasregeneracoes');
      const codigo = admin.codigoTotp(await stepEstavel());
      const sessoesAntes = await idsDeSessao(admin);

      const [a, b] = await disputar(t, admin, [loteRepo, 'revogarAtivo'], () => regenerar(admin.sessao.cookie, codigo), () => regenerar(admin.sessao.cookie, codigo));

      assert.deepEqual([a.status, b.status, b.body.codigo], [200, 401, 'SESSAO_INVALIDA']);
      await encerrouSemSessaoNova(a, admin, sessoesAntes);
      assert.equal(await n('SELECT count(*)::int AS n FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1', [admin.id]), 2);
      assert.deepEqual(await placar(t, admin), { ativos: 1, pendentes: 0, lotesAtivos: 1, desafiosAbertos: 0, sessoesValidas: 0, liberacoesAbertas: 0 });
    });

    test('D: dois resets concorrentes: serializados; no fim só a liberação do segundo vale', async (t) => {
      const admin = await comTotp('doisresets');

      const [a, b] = await disputar(t, admin, [liberacaoRepo, 'criar'], () => redefinir(admin.email), () => redefinir(admin.email));

      assert.deepEqual([a.codigoSaida, b.codigoSaida], [scriptRedefinir.SAIDAS.OK, scriptRedefinir.SAIDAS.OK]);
      assert.deepEqual(await liberacoesAbertas(admin), [hashLiberacao(admin, b.codigo)], 'vale o código impresso pelo segundo');
      assert.notEqual(hashLiberacao(admin, a.codigo), hashLiberacao(admin, b.codigo));
      assert.deepEqual(await placar(t, admin), { ativos: 0, pendentes: 0, lotesAtivos: 0, desafiosAbertos: 0, sessoesValidas: 0, liberacoesAbertas: 1 });
    });

    test('E1: reset enquanto um login TOTP está dentro da transação: a sessão do login não sobrevive ao reset', async (t) => {
      const admin = await comTotp('resetlogin1');
      const login = await entrar(admin.email);
      const codigo = admin.codigoTotp(await stepEstavel());

      const [a, b] = await disputar(t, admin, [fatorRepo, 'registrarStepAceito'], () => post('/auth/mfa/verificar', login.par, { codigo }), () => redefinir(admin.email));

      assert.equal(a.status, 200);
      assert.equal(b.codigoSaida, scriptRedefinir.SAIDAS.OK);
      assert.equal((await get('/auth/me', setCookie(a, COOKIE_SESSAO()).par)).status, 401);
      assert.deepEqual(await placar(t, admin), { ativos: 0, pendentes: 0, lotesAtivos: 0, desafiosAbertos: 0, sessoesValidas: 0, liberacoesAbertas: 1 });
    });

    test('E2: login TOTP que chega durante o reset: falha fechado, nenhuma sessão', async (t) => {
      const admin = await comTotp('resetlogin2');
      const login = await entrar(admin.email);
      const codigo = admin.codigoTotp(await stepEstavel());

      const [a, b] = await disputar(t, admin, [liberacaoRepo, 'criar'], () => redefinir(admin.email), () => post('/auth/mfa/verificar', login.par, { codigo }));

      assert.equal(a.codigoSaida, scriptRedefinir.SAIDAS.OK);
      assert.deepEqual([b.status, b.body.codigo], [401, 'DESAFIO_INVALIDO']);
      assert.equal(setCookie(b, COOKIE_SESSAO()), null);
      assert.deepEqual(await placar(t, admin), { ativos: 0, pendentes: 0, lotesAtivos: 0, desafiosAbertos: 0, sessoesValidas: 0, liberacoesAbertas: 1 });
    });

    test('F1: reset com SUBSTITUICAO aberta: tudo revogado; a confirmação depois falha fechado', async (t) => {
      const admin = await comTotp('resetsubst1');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);

      assert.equal((await redefinir(admin.email)).codigoSaida, scriptRedefinir.SAIDAS.OK);
      const r = await confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step));

      assert.equal(r.status, 401);
      assert.equal(setCookie(r, COOKIE_SESSAO()), null);
      assert.deepEqual(await placar(t, admin), { ativos: 0, pendentes: 0, lotesAtivos: 0, desafiosAbertos: 0, sessoesValidas: 0, liberacoesAbertas: 1 });
    });

    test('regeneração × RECUPERACAO, ordem A (regeneração com a trava): a RECUPERACAO é invalidada; nenhuma sessão para ninguém', async (t) => {
      const admin = await comTotp('regenrecA');
      const step = await stepEstavel();
      const ataque = await recuperacaoAberta(admin);
      const sessoesAntes = await idsDeSessao(admin);

      const [a, b] = await disputar(t, admin, [loteRepo, 'revogarAtivo'],
        () => regenerar(admin.sessao.cookie, admin.codigoTotp(step)), () => concluirRecuperacao(ataque.desafio.par, ataque.codigoPendente(step)));

      assert.equal(a.status, 200);
      assert.deepEqual([b.status, b.body.codigo], [401, 'DESAFIO_INVALIDO']);
      assert.equal(setCookie(b, COOKIE_SESSAO()), null);
      await encerrouSemSessaoNova(a, admin, sessoesAntes);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['ATIVO', null], ['REVOGADO', 'MFA_CODIGOS_REGENERADOS']]);
      assert.deepEqual(await placar(t, admin), { ativos: 1, pendentes: 0, lotesAtivos: 1, desafiosAbertos: 0, sessoesValidas: 0, liberacoesAbertas: 0 });
    });

    test('regeneração × RECUPERACAO, ordem B (RECUPERACAO com a trava): conclui inteira; a regeneração falha pela sessão revogada', async (t) => {
      const admin = await comTotp('regenrecB');
      const step = await stepEstavel();
      const ataque = await recuperacaoAberta(admin);

      const [a, b] = await disputar(t, admin, [fatorRepo, 'ativarTotp'],
        () => concluirRecuperacao(ataque.desafio.par, ataque.codigoPendente(step)), () => regenerar(admin.sessao.cookie, admin.codigoTotp(step)));

      assert.equal(a.status, 200);
      assert.deepEqual([b.status, b.body.codigo], [401, 'SESSAO_INVALIDA']);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['REVOGADO', 'RECUPERACAO'], ['ATIVO', null]]);
      const lote = (await q("SELECT c.codigo_hash FROM codigos_recuperacao_mfa_plataforma c JOIN lotes_recuperacao_mfa_plataforma l ON l.id = c.lote_id WHERE l.administrador_id = $1 AND l.estado = 'ATIVO' ORDER BY c.codigo_hash", [admin.id])).rows.map((c) => c.codigo_hash);
      assert.deepEqual(lote, a.body.codigosRecuperacao.map((c) => codigosMfa.hashCodigoRecuperacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(c) })).sort());
      assert.deepEqual(await sessoesValidasPorMetodo(admin), ['RECADASTRO']);
      assert.deepEqual(await placar(t, admin), { ativos: 1, pendentes: 0, lotesAtivos: 1, desafiosAbertos: 0, sessoesValidas: 1, liberacoesAbertas: 0 });
    });

    test('regeneração × confirmação da SUBSTITUICAO, ordem A (regeneração com a trava): a substituição é invalidada; fator original segue; nenhuma sessão nova', async (t) => {
      const admin = await comTotp('regensubA');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const sessoesAntes = await idsDeSessao(admin);

      const [a, b] = await disputar(t, admin, [loteRepo, 'revogarAtivo'],
        () => regenerar(admin.sessao.cookie, admin.codigoTotp(step + 1)), () => confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step)));

      assert.equal(a.status, 200);
      assert.deepEqual([b.status, b.body.codigo], [401, 'DESAFIO_INVALIDO']);
      await encerrouSemSessaoNova(a, admin, sessoesAntes);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['ATIVO', null], ['REVOGADO', 'MFA_CODIGOS_REGENERADOS']]);
      assert.deepEqual(await placar(t, admin), { ativos: 1, pendentes: 0, lotesAtivos: 1, desafiosAbertos: 0, sessoesValidas: 0, liberacoesAbertas: 0 });
    });

    test('regeneração × confirmação da SUBSTITUICAO, ordem B (substituição com a trava): troca inteira sem sessão nova; a regeneração falha pela sessão revogada', async (t) => {
      const admin = await comTotp('regensubB');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const sessoesAntes = await idsDeSessao(admin);

      const [a, b] = await disputar(t, admin, [fatorRepo, 'ativarTotp'],
        () => confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step)), () => regenerar(admin.sessao.cookie, admin.codigoTotp(step + 1)));

      assert.equal(a.status, 200);
      assert.deepEqual([b.status, b.body.codigo], [401, 'SESSAO_INVALIDA']);
      await encerrouSemSessaoNova(a, admin, sessoesAntes);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['REVOGADO', 'SUBSTITUIDO'], ['ATIVO', null]]);
      assert.deepEqual(await placar(t, admin), { ativos: 1, pendentes: 0, lotesAtivos: 1, desafiosAbertos: 0, sessoesValidas: 0, liberacoesAbertas: 0 });
    });

    test('F2: reset enquanto a confirmação da substituição está dentro da transação: nada da troca sobrevive', async (t) => {
      const admin = await comTotp('resetsubst2');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const sessoesAntes = await idsDeSessao(admin);

      const [a, b] = await disputar(t, admin, [fatorRepo, 'ativarTotp'], () => confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step)), () => redefinir(admin.email));

      assert.equal(a.status, 200);
      assert.equal(b.codigoSaida, scriptRedefinir.SAIDAS.OK);
      await encerrouSemSessaoNova(a, admin, sessoesAntes);
      assert.deepEqual(await placar(t, admin), { ativos: 0, pendentes: 0, lotesAtivos: 0, desafiosAbertos: 0, sessoesValidas: 0, liberacoesAbertas: 1 });
    });
  });

  // Ordem A: o logout conclui antes de a operação reler a sessão sob a trava. Ordem B: a operação já
  // releu a sessão e está retida antes do COMMIT quando o logout revoga. Em nenhuma das duas sobra sessão.
  describe('logout × operações sensíveis em andamento', () => {
    async function comLogoutAntes(t, admin, operacao, cookieLogout) {
      const retida = sinal();
      const portao = sinal();
      const travarOriginal = travaRepo.travarAdministrador;
      let retidas = 0;
      t.mock.method(travaRepo, 'travarAdministrador', async (executor, id) => {
        if (id === admin.id && retidas === 0) {
          retidas += 1;
          retida.resolver();
          await portao.promessa;
        }
        return travarOriginal(executor, id);
      });

      let emAndamento;
      let saida;
      try {
        emAndamento = operacao().then((r) => r);
        await retida.promessa;
        saida = await post('/auth/logout', cookieLogout);
      } finally {
        portao.resolver();
      }
      return { op: await emAndamento, saida };
    }

    test('ordem A, logout × confirmação da SUBSTITUICAO (logout com o cookie de sessão): 401 SESSAO_INVALIDA; nada trocado; nenhuma sessão', async (t) => {
      const admin = await comTotp('logoutantessub');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const sessoesAntes = await idsDeSessao(admin);

      const { op, saida } = await comLogoutAntes(t, admin, () => confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step)), admin.sessao.cookie);

      assert.equal(saida.status, 200);
      assert.deepEqual([op.status, op.body.codigo], [401, 'SESSAO_INVALIDA']);
      assert.equal(setCookie(op, COOKIE_SESSAO()), null);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['ATIVO', null], ['PENDENTE', null]]);
      assert.equal(await n('SELECT count(*)::int AS n FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1', [admin.id]), 1);
      assert.deepEqual(await idsDeSessao(admin), sessoesAntes);
      assert.equal(await sessoesValidas(admin), 0);
    });

    test('ordem A, logout × confirmação da SUBSTITUICAO (logout com os dois cookies): 401 DESAFIO_INVALIDO; PENDENTE abandonado; nenhuma sessão', async (t) => {
      const admin = await comTotp('logoutantessub2');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const sessoesAntes = await idsDeSessao(admin);

      const { op, saida } = await comLogoutAntes(t, admin, () => confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step)), `${admin.sessao.cookie}; ${desafio.par}`);

      assert.equal(saida.status, 200);
      assert.deepEqual([op.status, op.body.codigo], [401, 'DESAFIO_INVALIDO']);
      assert.equal(setCookie(op, COOKIE_SESSAO()), null);
      assert.equal(await motivoDoDesafio(desafio.valor), 'LOGOUT');
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['ATIVO', null], ['REVOGADO', 'ABANDONADO']]);
      assert.equal(await n('SELECT count(*)::int AS n FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1', [admin.id]), 1);
      assert.deepEqual(await idsDeSessao(admin), sessoesAntes);
      assert.equal(await sessoesValidas(admin), 0);
    });

    test('ordem A, logout × regeneração: 401 SESSAO_INVALIDA; step não consumido; lote antigo segue; nenhuma sessão', async (t) => {
      const admin = await comTotp('logoutantesregen');
      const step = await stepEstavel();
      const sessoesAntes = await idsDeSessao(admin);

      const { op, saida } = await comLogoutAntes(t, admin, () => regenerar(admin.sessao.cookie, admin.codigoTotp(step)), admin.sessao.cookie);

      assert.equal(saida.status, 200);
      assert.deepEqual([op.status, op.body.codigo], [401, 'SESSAO_INVALIDA']);
      assert.equal(setCookie(op, COOKIE_SESSAO()), null);
      assert.equal(await ultimoStep(admin), 1);
      assert.deepEqual((await q('SELECT estado FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1', [admin.id])).rows.map((l) => l.estado), ['ATIVO']);
      assert.deepEqual(await idsDeSessao(admin), sessoesAntes);
      assert.equal(await sessoesValidas(admin), 0);
    });

    async function comLogoutNoMeio(t, admin, [alvo, metodo], operacao, cookieLogout) {
      const retida = sinal();
      const portao = sinal();
      const original = alvo[metodo];
      let retidas = 0;
      t.mock.method(alvo, metodo, async (executor, dados, ...resto) => {
        const r = await original(executor, dados, ...resto);
        if (dados?.administradorId === admin.id && retidas === 0) {
          retidas += 1;
          retida.resolver();
          await portao.promessa;
        }
        return r;
      });

      let emAndamento;
      let logout;
      const sequencia = [];
      const chegadas = [];
      const agoraNoBanco = async () => (await um('SELECT clock_timestamp() AS t')).t.toISOString();
      try {
        emAndamento = operacao().then((r) => { chegadas.push('operação'); return r; });
        await retida.promessa;
        sequencia.push(`${await agoraNoBanco()} operação sensível leu a sessão sob a trava e está retida antes do COMMIT`);
        logout = post('/auth/logout', cookieLogout).then((r) => { chegadas.push('logout'); return r; });
        for (let i = 0; i < 400; i += 1) {
          const { revogada } = await um('SELECT revogada_em IS NOT NULL AS revogada FROM sessoes_plataforma WHERE id = $1', [admin.sessao.id]);
          if (revogada) break;
          await new Promise((r) => { setTimeout(r, 10); });
        }
        const origem = await um('SELECT motivo_revogacao, revogada_em FROM sessoes_plataforma WHERE id = $1', [admin.sessao.id]);
        sequencia.push(`${origem.revogada_em.toISOString()} logout revogou a sessão de origem (${origem.motivo_revogacao}), fora da trava do administrador`);
        await new Promise((r) => { setTimeout(r, 50); });
        const esperando = await um("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())");
        sequencia.push(`${await agoraNoBanco()} logout ${esperando.n > 0 ? 'aguarda a trava do administrador para encerrar o desafio' : 'já concluiu (sem desafio, não pede a trava)'}`);
      } finally {
        portao.resolver();
      }
      const [op, saida] = await Promise.all([emAndamento, logout]);
      const nova = await um('SELECT mfa_metodo, criado_em FROM sessoes_plataforma WHERE administrador_id = $1 AND revogada_em IS NULL', [admin.id]);
      if (nova) sequencia.push(`${nova.criado_em.toISOString()} operação criou a sessão nova ${nova.mfa_metodo} e fez COMMIT`);
      sequencia.push(`respostas: operação HTTP ${op.status} (Set-Cookie de sessão: ${setCookie(op, COOKIE_SESSAO())?.valor ? 'novo token' : 'nenhum'}); logout HTTP ${saida.status} (remove os cookies); ordem de chegada: ${chegadas.join(' antes de ')}`);
      const estado = {
        sessoes: (await q('SELECT mfa_metodo, motivo_revogacao, revogada_em IS NULL AS valida FROM sessoes_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows,
        fatores: (await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]),
        desafios: (await q('SELECT tipo, motivo_encerramento FROM desafios_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows,
        lotes: (await q('SELECT estado, motivo_revogacao FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows,
      };
      t.diagnostic(`sequência: ${sequencia.join(' | ')}`);
      t.diagnostic(`estado final: ${JSON.stringify(estado)}`);
      return { op, saida };
    }

    test('ordem B, logout × confirmação da SUBSTITUICAO: a troca conclui sem sessão nova; nenhuma sessão sobrevive', async (t) => {
      const admin = await comTotp('logoutsub');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const sessoesAntes = await idsDeSessao(admin);

      const { op, saida } = await comLogoutNoMeio(t, admin, [fatorRepo, 'ativarTotp'],
        () => confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step)), `${admin.sessao.cookie}; ${desafio.par}`);

      assert.equal(await sessoesValidas(admin), 0, `a operação respondeu ${op.status} e deixou sessão válida depois do logout`);
      assert.deepEqual([op.status, saida.status], [200, 200]);
      await encerrouSemSessaoNova(op, admin, sessoesAntes);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['REVOGADO', 'SUBSTITUIDO'], ['ATIVO', null]]);
      assert.equal(await motivoDoDesafio(desafio.valor), 'CONCLUIDO');
      assert.deepEqual((await q('SELECT estado, motivo_revogacao FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows.map((l) => [l.estado, l.motivo_revogacao]), [['REVOGADO', 'SUBSTITUICAO'], ['ATIVO', null]]);
    });

    test('ordem B, logout × regeneração: o lote é trocado sem sessão nova; nenhuma sessão sobrevive', async (t) => {
      const admin = await comTotp('logoutregen');
      const step = await stepEstavel();
      const sessoesAntes = await idsDeSessao(admin);

      const { op, saida } = await comLogoutNoMeio(t, admin, [loteRepo, 'revogarAtivo'], () => regenerar(admin.sessao.cookie, admin.codigoTotp(step)), admin.sessao.cookie);

      assert.equal(await sessoesValidas(admin), 0, `a operação respondeu ${op.status} e deixou sessão válida depois do logout`);
      assert.deepEqual([op.status, saida.status], [200, 200]);
      await encerrouSemSessaoNova(op, admin, sessoesAntes);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['ATIVO', null]]);
      assert.deepEqual((await q('SELECT estado, motivo_revogacao FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows.map((l) => [l.estado, l.motivo_revogacao]), [['REVOGADO', 'REGENERADO'], ['ATIVO', null]]);
    });
  });

  // Conclusões que criam sessão: se a confirmação pegar a trava antes, o logout revoga a sessão ligada ao desafio
  // (sessao_criada_id), e só ela; se o logout pegar antes, nenhuma sessão nasce.
  describe('logout × conclusões que criam sessão (CADASTRO, TOTP, RECADASTRO)', () => {
    async function corrida(t, admin, [alvo, metodo, reter], primeira, segunda) {
      const retida = sinal();
      const chegou = sinal();
      const portao = sinal();
      const pids = [];
      const travarOriginal = travaRepo.travarAdministrador;
      const original = alvo[metodo];
      t.mock.method(travaRepo, 'travarAdministrador', async (executor, id) => {
        if (id === admin.id) {
          pids.push(executor.processID);
          if (pids.length === 2) chegou.resolver();
        }
        return travarOriginal(executor, id);
      });
      let retidas = 0;
      t.mock.method(alvo, metodo, async (...args) => {
        const r = await original(...args);
        if (retidas === 0 && reter(...args)) {
          retidas += 1;
          retida.resolver();
          await portao.promessa;
        }
        return r;
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
      const sessoes = (await q('SELECT mfa_metodo, motivo_revogacao, revogada_em IS NULL AS valida FROM sessoes_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows;
      t.diagnostic(`corrida: ${JSON.stringify({ esperaDaSegunda: espera, sessoes })}`);
      return resultados.map((r) => {
        assert.equal(r.status, 'fulfilled', String(r.reason));
        return r.value;
      });
    }

    async function emCadastro(prefixo) {
      const admin = await novoAdministrador(prefixo);
      const liberacao = codigosMfa.gerarCodigo();
      await liberacaoRepo.criar(contexto.pool, { administradorId: admin.id, codigoHash: hashLiberacao(admin, liberacao), origem: 'CLI_LIBERACAO', validadeMinutos: 30 });
      const login = await entrar(admin.email);
      const r = await post('/auth/mfa/liberacao', login.par, { codigoLiberacao: liberacao });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const segredo = totpReferencia.segredoDaChaveManual(r.body.cadastro.chaveManual);
      return { admin, desafio: setCookie(r, COOKIE_DESAFIO()), codigo: (s) => totpReferencia.codigoDoStep(segredo, s) };
    }

    // sobrevivem: sessões de outros dispositivos continuam depois da conclusão (a recuperação revoga todas por regra própria).
    const FAMILIAS = {
      TOTP: async () => {
        const admin = await comTotp('logoutfimtotp');
        const desafio = await entrar(admin.email);
        return { admin, desafio, confirmar: (step) => post('/auth/mfa/verificar', desafio.par, { codigo: admin.codigoTotp(step) }), metodo: 'TOTP', sobrevivem: true };
      },
      CADASTRO: async () => {
        const c = await emCadastro('logoutfimcad');
        return { admin: c.admin, desafio: c.desafio, confirmar: (step) => post('/auth/mfa/cadastro/confirmar', c.desafio.par, { codigo: c.codigo(step) }), metodo: 'CADASTRO', sobrevivem: true };
      },
      RECADASTRO: async () => {
        const admin = await comTotp('logoutfimrec');
        const aberta = await recuperacaoAberta(admin);
        return { admin, desafio: aberta.desafio, confirmar: (step) => concluirRecuperacao(aberta.desafio.par, aberta.codigoPendente(step)), metodo: 'RECADASTRO', sobrevivem: false };
      },
    };

    const pendenteDoDesafio = async (token) => um(
      'SELECT f.estado, f.motivo_revogacao FROM desafios_mfa_plataforma d JOIN fatores_mfa_plataforma f ON f.id = d.fator_pendente_id WHERE d.token_hash = $1',
      [hashTokenSessao(token)],
    );
    const sessaoLigada = async (token) => um(
      `SELECT d.motivo_encerramento, s.id, s.mfa_metodo, s.motivo_revogacao, s.revogada_em
         FROM desafios_mfa_plataforma d JOIN sessoes_plataforma s ON s.id = d.sessao_criada_id WHERE d.token_hash = $1`,
      [hashTokenSessao(token)],
    );
    const idDaSessao = async (token) => (await um('SELECT id FROM sessoes_plataforma WHERE token_hash = $1', [hashTokenSessao(token)]))?.id ?? null;
    function soRemocoes(resposta) {
      for (const nome of [COOKIE_SESSAO(), COOKIE_DESAFIO()]) {
        const c = setCookie(resposta, nome);
        assert.deepEqual([c?.valor, c?.atributos['max-age']], ['', '0'], `${nome} removido`);
      }
    }

    for (const [familia, preparar] of Object.entries(FAMILIAS)) {
      test(`${familia}, ordem A (logout com a trava): desafio LOGOUT, PENDENTE abandonado quando há; a confirmação recebe 401; nenhuma sessão nasce`, async (t) => {
        const f = await preparar();
        const step = await stepEstavel();
        const antes = { ids: await idsDeSessao(f.admin), validas: await sessoesValidas(f.admin), ativos: await contarEstado(f.admin, 'ATIVO') };

        const [saida, conf] = await corrida(t, f.admin, [desafioRepo, 'encerrar', (_, dados) => dados.motivo === 'LOGOUT'],
          () => post('/auth/logout', f.desafio.par), () => f.confirmar(step));

        assert.equal(saida.status, 200);
        soRemocoes(saida);
        assert.deepEqual([conf.status, conf.body.codigo], [401, 'DESAFIO_INVALIDO']);
        assert.equal(setCookie(conf, COOKIE_SESSAO()), null);
        assert.equal(await motivoDoDesafio(f.desafio.valor), 'LOGOUT');
        const pendente = await pendenteDoDesafio(f.desafio.valor);
        assert.deepEqual(pendente && [pendente.estado, pendente.motivo_revogacao], familia === 'TOTP' ? undefined : ['REVOGADO', 'ABANDONADO']);
        assert.deepEqual(await idsDeSessao(f.admin), antes.ids, 'nenhuma sessão nasce');
        assert.equal(await sessoesValidas(f.admin), antes.validas);
        assert.equal(await contarEstado(f.admin, 'ATIVO'), antes.ativos);
      });

      test(`${familia}, ordem B (confirmação com a trava): conclui e emite a sessão; o logout revoga exatamente a sessão ligada ao desafio (LOGOUT); o outro dispositivo não é tocado pelo logout`, async (t) => {
        const f = await preparar();
        const outroDispositivo = await criarSessaoAdministrativa(contexto.pool, f.admin.id);
        const step = await stepEstavel();

        const [conf, saida] = await corrida(t, f.admin, [sessaoRepo, 'criar', (_, dados) => dados?.administradorId === f.admin.id],
          () => f.confirmar(step), () => post('/auth/logout', f.desafio.par));

        assert.deepEqual([conf.status, saida.status], [200, 200], JSON.stringify(conf.body));
        soRemocoes(saida);
        const emitida = setCookie(conf, COOKIE_SESSAO());
        assert.ok(emitida.valor, 'a confirmação emite o cookie de sessão');
        const ligada = await sessaoLigada(f.desafio.valor);
        assert.deepEqual([ligada?.motivo_encerramento, ligada?.mfa_metodo], ['CONCLUIDO', f.metodo]);
        assert.equal(await idDaSessao(emitida.valor), ligada.id, 'o cookie emitido é o da sessão ligada ao desafio');
        assert.equal(ligada.motivo_revogacao, 'LOGOUT', 'a sessão criada pelo desafio é revogada pelo logout');
        assert.equal((await get('/auth/me', emitida.par)).status, 401);

        const outro = await um('SELECT motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [outroDispositivo.id]);
        if (f.sobrevivem) {
          assert.equal(outro.motivo_revogacao, null);
          assert.equal((await get('/auth/me', outroDispositivo.cookie)).status, 200);
        } else {
          assert.equal(outro.motivo_revogacao, 'MFA_RECUPERADO', 'revogada pela recuperação, não pelo logout');
        }
        const validas = (await q('SELECT id FROM sessoes_plataforma WHERE administrador_id = $1 AND revogada_em IS NULL', [f.admin.id])).rows.map((s) => s.id);
        assert.equal(validas.includes(ligada.id), false, '0 sessões válidas daquele fluxo');
      });
    }

    test('TOTP, ordem B com a sessão antiga deste navegador e outra em outro dispositivo: caem a deste navegador e a criada pelo desafio; a do outro dispositivo continua', async (t) => {
      const admin = await comTotp('logoutfimoutro');
      const desafio = await entrar(admin.email);
      const nesteNavegador = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const cookies = `${nesteNavegador.cookie}; ${desafio.par}`;
      const step = await stepEstavel();

      const [conf, saida] = await corrida(t, admin, [fatorRepo, 'registrarStepAceito', (_, dados) => dados?.administradorId === admin.id],
        () => post('/auth/mfa/verificar', cookies, { codigo: admin.codigoTotp(step) }), () => post('/auth/logout', cookies));

      assert.deepEqual([conf.status, saida.status], [200, 200]);
      const ligada = await sessaoLigada(desafio.valor);
      assert.equal(await idDaSessao(setCookie(conf, COOKIE_SESSAO()).valor), ligada.id);
      assert.equal(ligada.motivo_revogacao, 'LOGOUT');
      assert.equal((await um('SELECT motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [nesteNavegador.id])).motivo_revogacao, 'LOGOUT');
      assert.equal((await um('SELECT motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [admin.sessao.id])).motivo_revogacao, null);
      assert.equal((await get('/auth/me', admin.sessao.cookie)).status, 200, 'o outro dispositivo continua');
      assert.equal(await sessoesValidas(admin), 1);
    });

    test('desafio já CONCLUIDO com sessão ligada ainda válida: logout só com o cookie do desafio revoga essa sessão (LOGOUT); repetido, nada muda; a outra sessão continua', async () => {
      const admin = await comTotp('logoutconcluido');
      const desafio = await entrar(admin.email);
      const entrada = await post('/auth/mfa/verificar', desafio.par, { codigo: admin.codigoTotp(await stepEstavel()) });
      assert.equal(entrada.status, 200);
      const emitida = setCookie(entrada, COOKIE_SESSAO());
      const antes = await sessaoLigada(desafio.valor);
      assert.deepEqual([antes.motivo_encerramento, antes.id, antes.revogada_em], ['CONCLUIDO', await idDaSessao(emitida.valor), null]);
      assert.equal((await get('/auth/me', emitida.par)).status, 200);

      const r = await post('/auth/logout', desafio.par);

      assert.equal(r.status, 200);
      soRemocoes(r);
      const depois = await sessaoLigada(desafio.valor);
      assert.equal(depois.motivo_revogacao, 'LOGOUT');
      assert.equal((await get('/auth/me', emitida.par)).status, 401);
      assert.equal((await post('/auth/logout', desafio.par)).status, 200);
      const repetido = await sessaoLigada(desafio.valor);
      assert.deepEqual([repetido.motivo_revogacao, repetido.revogada_em.getTime()], ['LOGOUT', depois.revogada_em.getTime()], 'idempotente');
      assert.equal((await get('/auth/me', admin.sessao.cookie)).status, 200);
      assert.equal(await sessoesValidas(admin), 1);
    });

    test('desafio CONCLUIDO sem sessão ligada (SUBSTITUICAO) ou já encerrado por LOGOUT: o logout com esse cookie não infere sessão nenhuma', async () => {
      const admin = await comTotp('logoutsemligada');
      const step = await stepEstavel();
      const { desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      assert.equal((await confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step))).status, 200);
      const concluido = await um('SELECT motivo_encerramento, sessao_criada_id FROM desafios_mfa_plataforma WHERE token_hash = $1', [hashTokenSessao(desafio.valor)]);
      assert.deepEqual([concluido.motivo_encerramento, concluido.sessao_criada_id], ['CONCLUIDO', null]);
      const login = await entrar(admin.email);
      const entrada = await post('/auth/mfa/verificar', login.par, { codigo: codigoNovo(step + 1) });
      assert.equal(entrada.status, 200);
      const encerradoPorLogout = await entrar(admin.email);
      assert.equal((await post('/auth/logout', encerradoPorLogout.par)).status, 200);
      assert.equal(await motivoDoDesafio(encerradoPorLogout.valor), 'LOGOUT');

      for (const cookie of [desafio.par, encerradoPorLogout.par]) assert.equal((await post('/auth/logout', cookie)).status, 200);

      assert.equal((await get('/auth/me', setCookie(entrada, COOKIE_SESSAO()).par)).status, 200);
      assert.deepEqual(await sessoesValidasPorMetodo(admin), ['TOTP']);
    });
  });

  describe('nenhum segredo fora do lugar', () => {
    test('senha, TOTPs, secrets, recovery codes, liberação, tokens, ciphertext, nonce, chave e URI não aparecem em log, auditoria, tentativas ou outras tabelas', async (t) => {
      const logs = [];
      for (const metodo of ['log', 'error', 'warn', 'info']) t.mock.method(console, metodo, (...args) => logs.push(args));
      const admin = await comTotp('vazamento');
      const step = await stepEstavel();
      const fatorAntigo = await um('SELECT totp_nonce, totp_segredo_cifrado FROM fatores_mfa_plataforma WHERE id = $1', [admin.fatorId]);
      await iniciar(admin.sessao.cookie, '000000', 'senha-errada-qualquer');
      const { resposta, desafio, codigoNovo } = await substituicaoIniciada(admin, step);
      const pendente = await um("SELECT totp_nonce, totp_segredo_cifrado FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'PENDENTE'", [admin.id]);
      const fim = await confirmar(admin.sessao.cookie, desafio.par, codigoNovo(step));
      const sessaoDepois = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const regen = await regenerar(sessaoDepois.cookie, codigoNovo(step + 1));
      const reset = await redefinir(admin.email);
      t.mock.restoreAll();
      assert.deepEqual([fim.status, regen.status, reset.codigoSaida], [200, 200, 0]);
      for (const r of [fim, regen]) assert.equal(setCookie(r, COOKIE_SESSAO()).valor, '');

      const normal = (c) => codigosMfa.normalizarCodigo(c);
      const segredoNovo = totpReferencia.segredoDaChaveManual(resposta.body.cadastro.chaveManual);
      const segredos = [
        SENHA, 'senha-errada-qualquer', admin.codigoTotp(step), codigoNovo(step), codigoNovo(step + 1),
        admin.segredo.toString('hex'), totp.chaveManual(Buffer.from(admin.segredo)).replace(/ /g, ''), segredoNovo.toString('hex'), resposta.body.cadastro.chaveManual.replace(/ /g, ''),
        ...admin.codigos, ...admin.codigos.map(normal), ...fim.body.codigosRecuperacao, ...regen.body.codigosRecuperacao, ...regen.body.codigosRecuperacao.map(normal),
        reset.codigo, normal(reset.codigo), admin.sessao.token, sessaoDepois.token, desafio.valor,
        resposta.body.cadastro.uri, fatorAntigo.totp_nonce.toString('hex'), fatorAntigo.totp_segredo_cifrado.toString('hex'),
        pendente.totp_nonce.toString('hex'), pendente.totp_segredo_cifrado.toString('hex'), process.env.MFA_TOTP_KEY_V1, 'otpauth://',
      ];
      for (const tabela of ['logs_auditoria_plataforma', 'login_tentativas_plataforma', 'desafios_mfa_plataforma', 'sessoes_plataforma', 'lotes_recuperacao_mfa_plataforma', 'liberacoes_cadastro_mfa_plataforma']) {
        const texto = (await q(`SELECT row_to_json(t)::text AS l FROM ${tabela} t`)).rows.map((r) => r.l).join('\n');
        for (const valor of segredos) assert.equal(texto.includes(valor), false, `${tabela} contém segredo`);
      }
      const textoLogs = JSON.stringify(logs);
      for (const valor of segredos) assert.equal(textoLogs.includes(valor), false, 'log técnico com segredo');
    });
  });
});
