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
const { criarEmpresaCadastroRoutes } = require('../../src/routes/empresa-cadastro.routes');
const { criarEmpresaCadastroController } = require('../../src/controllers/empresa-cadastro.controller');
const { criarConviteMasterRoutes } = require('../../src/routes/convite-master.routes');
const { criarConviteMasterController } = require('../../src/controllers/convite-master.controller');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarExigirDesafioMfa } = require('../../src/middleware/desafio-mfa-plataforma');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const mfaCripto = require('../../src/security/mfa-cripto');
const totp = require('../../src/security/totp');
const codigosMfa = require('../../src/security/codigos-mfa');
const cooldown = require('../../src/security/cooldown');
const { hashTokenSessao } = require('../../src/security/token');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

const MIGRATIONS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048', '049', '050', '051', '052', '053', '054', '055', '056'];
const SENHA = 'planeta-nebulosa-ozonio-42';
const CORPO_INVALIDO = { status: 'error', codigo: 'MFA_CODIGO_INVALIDO', message: 'Código inválido' };
const COOKIE_DESAFIO = () => authConfig.desafioMfa.cookieNome;
const COOKIE_SESSAO = () => authConfig.sessao.cookieNomeAdmin;
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

describe('recovery code e recadastro obrigatório do TOTP (PostgreSQL real)', () => {
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
  const recuperar = (cookie, codigoRecuperacao) => post('/auth/mfa/recuperacao', cookie, { codigoRecuperacao });
  const confirmar = (cookie, codigo) => post('/auth/mfa/cadastro/confirmar', cookie, { codigo });

  async function novoAdministrador(prefixo) {
    sequencia += 1;
    const email = `${prefixo}-${sequencia}-${crypto.randomBytes(3).toString('hex')}@safework.com.br`;
    const { id } = await um('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hashSenha]);
    return { id, email };
  }

  // TOTP ATIVO com secret conhecido e um lote de 10 recovery codes conhecidos.
  async function comFatorERecuperacao(prefixo) {
    const admin = await novoAdministrador(prefixo);
    const segredo = crypto.randomBytes(20);
    const fatorUid = crypto.randomUUID();
    const envelope = mfaCripto.cifrarSegredoTotp({ segredo: Buffer.from(segredo), administradorId: admin.id, fatorUid });
    const fator = await fatorRepo.criarPendenteTotp(contexto.pool, { administradorId: admin.id, fatorUid, envelope, validadeMinutos: 15 });
    assert.equal(await fatorRepo.ativarTotp(contexto.pool, { administradorId: admin.id, fatorId: fator.id, step: 1 }), true);
    const lote = await loteRepo.criar(contexto.pool, admin.id);
    const codigos = Array.from({ length: 10 }, () => codigosMfa.gerarCodigo());
    const hashes = codigos.map((c) => codigosMfa.hashCodigoRecuperacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(c) }));
    assert.equal(await codigoRepo.inserirHashes(contexto.pool, { administradorId: admin.id, loteId: lote.id, hashes }), 10);
    return { ...admin, segredo, fatorId: fator.id, loteId: lote.id, codigos, codigoTotp: (step) => totpReferencia.codigoDoStep(segredo, step) };
  }

  async function entrar(email) {
    const r = await post('/auth/login', null, { email, senha: SENHA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { ...setCookie(r, COOKIE_DESAFIO()), etapa: r.body.etapa };
  }

  async function iniciar(admin, indice = 0) {
    const desafio = await entrar(admin.email);
    const r = await recuperar(desafio.par, admin.codigos[indice]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const segredoNovo = totpReferencia.segredoDaChaveManual(r.body.cadastro.chaveManual);
    return { verificacao: desafio, resposta: r, cookie: setCookie(r, COOKIE_DESAFIO()), codigoNovo: (step) => totpReferencia.codigoDoStep(segredoNovo, step) };
  }

  async function stepEstavel() {
    const agora = (await um('SELECT clock_timestamp() AS t')).t.getTime();
    const restante = 30_000 - (agora % 30_000);
    if (restante > 4_000) return totpReferencia.stepDe(agora);
    await new Promise((r) => { setTimeout(r, restante + 100); });
    return totpReferencia.stepDe((await um('SELECT clock_timestamp() AS t')).t.getTime());
  }

  const consumido = async (admin, codigo) => (await um(
    'SELECT consumido_em IS NOT NULL AS c FROM codigos_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND codigo_hash = $2',
    [admin.id, codigosMfa.hashCodigoRecuperacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(codigo) })],
  )).c;
  const consumidos = (admin) => n('SELECT count(*)::int AS n FROM codigos_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND consumido_em IS NOT NULL', [admin.id]);
  const desafioDe = (token) => um('SELECT * FROM desafios_mfa_plataforma WHERE token_hash = $1', [hashTokenSessao(token)]);
  const fatores = async (admin) => (await q('SELECT id, estado, motivo_revogacao, totp_segredo_cifrado IS NULL AS sem_segredo FROM fatores_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows;
  const pendentes = (admin) => n("SELECT count(*)::int AS n FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'PENDENTE'", [admin.id]);
  const sessoes = (admin) => n('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1', [admin.id]);
  const abertosDoTipo = (admin, tipo) => n('SELECT count(*)::int AS n FROM desafios_mfa_plataforma WHERE administrador_id = $1 AND tipo = $2 AND encerrado_em IS NULL', [admin.id, tipo]);

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
        criarEmpresaCadastroRoutes({ controller: criarEmpresaCadastroController({ pool }), exigirSessaoPlataforma }),
        criarConviteMasterRoutes({ controller: criarConviteMasterController({ pool }), exigirSessaoPlataforma, limitador: semLimite() }),
      );
    });
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('início da recuperação', () => {
    test('recovery válido: VERIFICACAO vira RECUPERACAO; só esse código é consumido; PENDENTE novo; fator antigo ATIVO; nenhuma sessão', async () => {
      const admin = await comFatorERecuperacao('inicio');
      const desafio = await entrar(admin.email);
      assert.equal(desafio.etapa, 'VERIFICACAO');

      const r = await recuperar(desafio.par, admin.codigos[0].toLowerCase().replace(/-/g, ' '));

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.etapa, 'RECUPERACAO');
      assert.match(r.body.cadastro.uri, /^otpauth:\/\/totp\//);
      assert.equal(setCookie(r, COOKIE_SESSAO()), null);
      const novo = setCookie(r, COOKIE_DESAFIO());
      assert.notEqual(novo.valor, desafio.valor);
      assert.equal(JSON.stringify(r.body).includes(codigosMfa.normalizarCodigo(admin.codigos[0])), false);

      assert.equal(await consumido(admin, admin.codigos[0]), true);
      assert.equal(await consumidos(admin), 1);
      assert.equal((await desafioDe(desafio.valor)).motivo_encerramento, 'TRANSICAO');
      const recuperacao = await desafioDe(novo.valor);
      assert.deepEqual([recuperacao.tipo, recuperacao.encerrado_em], ['RECUPERACAO', null]);
      assert.deepEqual((await fatores(admin)).map((f) => f.estado), ['ATIVO', 'PENDENTE']);
      assert.equal((await fatores(admin))[1].id, recuperacao.fator_pendente_id);
      assert.equal(await sessoes(admin), 0);
      assert.equal(await n("SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE acao = 'MFA_RECUPERACAO_INICIADA' AND ator_tipo = 'ADMINISTRADOR' AND administrador_id = $1", [admin.id]), 1);
    });

    test('só com o desafio RECUPERACAO nada administrativo responde; só estado, reinício, confirmação e logout', async () => {
      const admin = await comFatorERecuperacao('acesso');
      const { cookie } = await iniciar(admin);

      for (const [metodo, caminho] of [['get', '/auth/me'], ['get', '/painel'], ['get', '/empresas'], ['post', '/empresas/1/convites-master']]) {
        const r = metodo === 'get' ? await get(caminho, cookie.par) : await post(caminho, cookie.par, {});
        assert.equal(r.status, 401, caminho);
      }
      assert.equal((await post('/auth/mfa/verificar', cookie.par, { codigo: '123456' })).body.codigo, 'DESAFIO_INVALIDO');
      assert.equal((await recuperar(cookie.par, admin.codigos[1])).body.codigo, 'DESAFIO_INVALIDO');
      const estado = await get('/auth/mfa/estado', cookie.par);
      assert.deepEqual([estado.status, estado.body.etapa], [200, 'RECUPERACAO']);
      assert.equal(await consumidos(admin), 1);
    });

    test('código inexistente, fora do formato ou já usado: 401 idêntico, falha contada, nada consumido além do legítimo', async () => {
      const admin = await comFatorERecuperacao('invalido');
      const desafio = await entrar(admin.email);

      for (const codigo of [codigosMfa.gerarCodigo(), 'nao-e-codigo']) {
        assert.deepEqual((await recuperar(desafio.par, codigo)).body, CORPO_INVALIDO);
      }
      assert.equal((await desafioDe(desafio.valor)).falhas, 2);
      assert.equal(await n("SELECT count(*)::int AS n FROM login_tentativas_plataforma WHERE chave_cooldown = $1 AND motivo = 'RECUPERACAO_INVALIDA'", [cooldown.gerarChaveCooldownMfaPlataforma(admin.id)]), 2);
      assert.equal(await consumidos(admin), 0);

      await iniciar(admin, 0);
      const outro = await entrar(admin.email);
      assert.deepEqual((await recuperar(outro.par, admin.codigos[0])).body, CORPO_INVALIDO, 'código já usado');
      assert.equal(await consumidos(admin), 1);
    });

    test('cinco falhas encerram o desafio; o cooldown barra o próximo mesmo com código válido, sem consumir', async () => {
      const admin = await comFatorERecuperacao('cooldown');
      const desafio = await entrar(admin.email);
      for (let i = 0; i < authConfig.desafioMfa.maxFalhas; i += 1) await recuperar(desafio.par, codigosMfa.gerarCodigo());
      assert.equal((await desafioDe(desafio.valor)).motivo_encerramento, 'FALHAS_EXCEDIDAS');

      const novo = await entrar(admin.email);
      const r = await recuperar(novo.par, admin.codigos[0]);

      assert.deepEqual([r.status, r.body.codigo], [429, 'MFA_EM_COOLDOWN']);
      assert.ok(Number(r.headers['retry-after']) > 0);
      assert.equal(await consumido(admin, admin.codigos[0]), false);
      assert.equal(await pendentes(admin), 0);
      const intacto = await desafioDe(novo.valor);
      assert.deepEqual([intacto.encerrado_em, intacto.falhas], [null, 0]);
    });

    test('fator revogado depois do login: fail closed, sem fallback e sem consumir', async () => {
      const admin = await comFatorERecuperacao('semfator');
      const desafio = await entrar(admin.email);
      await fatorRepo.revogar(contexto.pool, { administradorId: admin.id, fatorId: admin.fatorId, motivo: 'REVOGADO_TESTE' });

      assert.equal((await recuperar(desafio.par, admin.codigos[0])).body.codigo, 'DESAFIO_INVALIDO');
      assert.equal((await desafioDe(desafio.valor)).motivo_encerramento, 'SEM_FATOR_ATIVO');
      assert.equal(await consumidos(admin), 0);
      assert.equal(await pendentes(admin), 0);
    });
  });

  describe('chaves criptográficas', () => {
    test('chave atual indisponível: 503 antes da transação, nada muda; com a chave de volta, o mesmo código funciona', async (t) => {
      t.mock.method(console, 'error', () => {});
      const admin = await comFatorERecuperacao('semchave');
      const desafio = await entrar(admin.email);
      t.mock.method(mfaCripto, 'garantirChaveAtual', semChave.garantirChaveAtual);

      const r = await recuperar(desafio.par, admin.codigos[0]);

      assert.deepEqual([r.status, r.body.codigo], [503, 'MFA_INDISPONIVEL']);
      assert.equal(await consumido(admin, admin.codigos[0]), false);
      const intacto = await desafioDe(desafio.valor);
      assert.deepEqual([intacto.encerrado_em, intacto.falhas], [null, 0]);
      assert.equal(await pendentes(admin), 0);
      assert.equal(await n('SELECT count(*)::int AS n FROM login_tentativas_plataforma WHERE chave_cooldown = $1', [cooldown.gerarChaveCooldownMfaPlataforma(admin.id)]), 0);
      const evento = await um("SELECT ator_tipo, contexto FROM logs_auditoria_plataforma WHERE acao = 'MFA_CHAVE_INDISPONIVEL' AND administrador_afetado_id = $1", [admin.id]);
      assert.deepEqual(evento, { ator_tipo: 'SISTEMA', contexto: { operacao: 'recuperacao', motivo: 'CHAVE_INDISPONIVEL' } });

      t.mock.restoreAll();
      assert.equal((await recuperar(desafio.par, admin.codigos[0])).status, 200);
    });

    test('cifragem falha dentro da transação: ROLLBACK; código não consumido, desafio intacto, fator antigo intacto', async (t) => {
      t.mock.method(console, 'error', () => {});
      const admin = await comFatorERecuperacao('cifrar');
      const desafio = await entrar(admin.email);
      t.mock.method(mfaCripto, 'cifrarSegredoTotp', semChave.cifrarSegredoTotp);

      assert.equal((await recuperar(desafio.par, admin.codigos[0])).status, 503);

      t.mock.restoreAll();
      assert.equal(await consumido(admin, admin.codigos[0]), false);
      const intacto = await desafioDe(desafio.valor);
      assert.deepEqual([intacto.encerrado_em, intacto.falhas], [null, 0]);
      assert.deepEqual((await fatores(admin)).map((f) => f.estado), ['ATIVO']);
      assert.equal(await sessoes(admin), 0);
      assert.equal(await n("SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE acao = 'MFA_CHAVE_INDISPONIVEL' AND ator_tipo = 'SISTEMA' AND administrador_afetado_id = $1", [admin.id]), 1);
    });

    test('chave histórica do fator antigo perdida e chave atual saudável: recuperação completa sem decifrar o antigo', async () => {
      const admin = await comFatorERecuperacao('historica');
      await q('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 2 WHERE id = $1', [admin.fatorId]);
      const { cookie, codigoNovo } = await iniciar(admin);
      const step = await stepEstavel();

      const r = await confirmar(cookie.par, codigoNovo(step));

      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [antigo, novo] = await fatores(admin);
      assert.deepEqual([antigo.estado, antigo.motivo_revogacao, antigo.sem_segredo], ['REVOGADO', 'RECUPERACAO', true]);
      assert.equal(novo.estado, 'ATIVO');
      const login = await entrar(admin.email);
      assert.equal((await post('/auth/mfa/verificar', login.par, { codigo: codigoNovo(step + 1) })).status, 200);
    });
  });

  describe('reinício e confirmação', () => {
    test('reiniciar em RECUPERACAO: PENDENTE trocado, fator antigo ATIVO, nenhum código a mais consumido, nenhuma sessão', async () => {
      const admin = await comFatorERecuperacao('reinicio');
      const { cookie } = await iniciar(admin);

      const r = await post('/auth/mfa/cadastro/reiniciar', cookie.par);

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.etapa, 'RECUPERACAO');
      const lista = await fatores(admin);
      assert.deepEqual(lista.map((f) => [f.estado, f.motivo_revogacao, f.sem_segredo]), [['ATIVO', null, false], ['REVOGADO', 'REINICIADO', true], ['PENDENTE', null, false]]);
      assert.equal((await desafioDe(cookie.valor)).fator_pendente_id, lista[2].id);
      assert.equal(await consumidos(admin), 1);
      assert.equal(await sessoes(admin), 0);
    });

    test('confirmação: antigo revogado, novo ATIVO, lote novo de 10, todas as sessões antigas revogadas, demais desafios encerrados, sessão RECADASTRO', async () => {
      const admin = await comFatorERecuperacao('conclusao');
      const aqui = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const outroDispositivo = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const { cookie, codigoNovo } = await iniciar(admin);
      const outroDesafio = await entrar(admin.email);
      const step = await stepEstavel();

      const r = await confirmar(`${aqui.cookie}; ${cookie.par}`, codigoNovo(step));

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.codigosRecuperacao.length, 10);
      const sessao = setCookie(r, COOKIE_SESSAO());
      assert.deepEqual([setCookie(r, COOKIE_DESAFIO()).valor, setCookie(r, COOKIE_DESAFIO()).atributos['max-age']], ['', '0']);

      const [antigo, novo] = await fatores(admin);
      assert.deepEqual([antigo.estado, antigo.motivo_revogacao, antigo.sem_segredo, novo.estado], ['REVOGADO', 'RECUPERACAO', true, 'ATIVO']);
      assert.equal(Number((await um('SELECT totp_ultimo_step_aceito AS s FROM fatores_mfa_plataforma WHERE id = $1', [novo.id])).s), step);

      const lotes = (await q('SELECT id, estado, motivo_revogacao FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows;
      assert.deepEqual(lotes.map((l) => [l.estado, l.motivo_revogacao]), [['REVOGADO', 'RECUPERACAO'], ['ATIVO', null]]);
      const hashesAtivos = (await q('SELECT codigo_hash FROM codigos_recuperacao_mfa_plataforma WHERE lote_id = $1 AND consumido_em IS NULL ORDER BY codigo_hash', [lotes[1].id])).rows.map((c) => c.codigo_hash);
      assert.deepEqual(hashesAtivos, r.body.codigosRecuperacao.map((c) => codigosMfa.hashCodigoRecuperacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(c) })).sort());

      for (const antiga of [aqui, outroDispositivo]) {
        assert.equal((await um('SELECT motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [antiga.id])).motivo_revogacao, 'MFA_RECUPERADO');
        assert.equal((await get('/auth/me', antiga.cookie)).status, 401);
      }
      const linha = await um('SELECT mfa_metodo, mfa_verificado_em IS NOT NULL AS verificado FROM sessoes_plataforma WHERE token_hash = $1', [hashTokenSessao(sessao.valor)]);
      assert.deepEqual([linha.mfa_metodo, linha.verificado], ['RECADASTRO', true]);
      assert.equal((await get('/auth/me', sessao.par)).status, 200);
      assert.equal((await get('/painel', sessao.par)).status, 200);
      assert.equal(await n('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1 AND revogada_em IS NULL', [admin.id]), 1);

      assert.equal((await desafioDe(outroDesafio.valor)).motivo_encerramento, 'MFA_RECUPERADO');
      assert.equal((await desafioDe(cookie.valor)).motivo_encerramento, 'CONCLUIDO');
      const acoes = (await q("SELECT acao, ator_tipo, contexto FROM logs_auditoria_plataforma WHERE administrador_id = $1 AND acao IN ('MFA_RECUPERACAO_CONCLUIDA', 'SESSOES_ADMINISTRADOR_REVOGADAS') ORDER BY id", [admin.id])).rows;
      assert.deepEqual(acoes.map((a) => [a.acao, a.ator_tipo]), [['MFA_RECUPERACAO_CONCLUIDA', 'ADMINISTRADOR'], ['SESSOES_ADMINISTRADOR_REVOGADAS', 'ADMINISTRADOR']]);
      assert.deepEqual(acoes[1].contexto, { motivo: 'MFA_RECUPERADO', quantidade: 2 });

      const depois = await entrar(admin.email);
      assert.deepEqual((await post('/auth/mfa/verificar', depois.par, { codigo: admin.codigoTotp(step) })).body, CORPO_INVALIDO, 'TOTP antigo não vale');
      assert.deepEqual((await recuperar(depois.par, admin.codigos[1])).body, CORPO_INVALIDO, 'recovery code antigo não vale');
      assert.equal((await post('/auth/mfa/verificar', depois.par, { codigo: codigoNovo(step + 1) })).status, 200);
    });

    test('TOTP novo errado na confirmação: nada muda', async () => {
      const admin = await comFatorERecuperacao('errado');
      const sessao = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const { cookie, codigoNovo } = await iniciar(admin);
      const step = await stepEstavel();
      const naJanela = new Set([-1, 0, 1].map((d) => codigoNovo(step + d)));
      const errado = ['000000', '111111', '222222'].find((c) => !naJanela.has(c));

      assert.deepEqual((await confirmar(cookie.par, errado)).body, CORPO_INVALIDO);
      assert.deepEqual((await fatores(admin)).map((f) => f.estado), ['ATIVO', 'PENDENTE']);
      assert.equal(await n("SELECT count(*)::int AS n FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO' AND id = $2", [admin.id, admin.loteId]), 1);
      assert.equal((await get('/auth/me', sessao.cookie)).status, 200);
    });
  });

  describe('abandono', () => {
    test('código consumido, fator antigo ATIVO, PENDENTE sem valor, nenhuma sessão; o login normal com o fator antigo continua', async () => {
      const admin = await comFatorERecuperacao('abandono');
      const { cookie, codigoNovo } = await iniciar(admin);
      await q("UPDATE desafios_mfa_plataforma SET criado_em = now() - interval '30 minutes', expira_em = now() - interval '1 minute' WHERE token_hash = $1", [hashTokenSessao(cookie.valor)]);
      const step = await stepEstavel();

      assert.equal((await confirmar(cookie.par, codigoNovo(step))).body.codigo, 'DESAFIO_INVALIDO');
      assert.equal(await consumido(admin, admin.codigos[0]), true);
      assert.deepEqual((await fatores(admin)).map((f) => f.estado), ['ATIVO', 'PENDENTE']);
      assert.equal(await sessoes(admin), 0);

      const login = await entrar(admin.email);
      assert.equal(login.etapa, 'VERIFICACAO');
      assert.equal((await post('/auth/mfa/verificar', login.par, { codigo: codigoNovo(step) })).body.codigo, 'MFA_CODIGO_INVALIDO', 'o PENDENTE não autentica');
      assert.equal((await post('/auth/mfa/verificar', login.par, { codigo: admin.codigoTotp(step) })).status, 200);
    });
  });

  describe('concorrência', () => {
    // A 1ª requisição para dentro da transação no ponto indicado; a 2ª só é liberada depois de o banco mostrá-la bloqueada.
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
      t.mock.method(alvo, metodo, async (executor, dados) => {
        const r = await original(executor, dados);
        if (dados.administradorId === admin.id && retidas === 0) {
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
      t.diagnostic(`disputa: ${JSON.stringify({ primeira: pids[0], segunda: pids[1], esperaDaSegunda: espera })}`);
      return resultados.map((r) => {
        assert.equal(r.status, 'fulfilled', String(r.reason));
        return r.value;
      });
    }

    const ativos = (admin) => n("SELECT count(*)::int AS n FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [admin.id]);
    const lotesAtivos = (admin) => n("SELECT count(*)::int AS n FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [admin.id]);
    async function placar(t, admin) {
      const final = {
        codigosConsumidos: await consumidos(admin),
        pendentes: await pendentes(admin),
        fatoresAtivos: await ativos(admin),
        lotesAtivos: await lotesAtivos(admin),
        recuperacoesAbertas: await abertosDoTipo(admin, 'RECUPERACAO'),
        sessoes: await sessoes(admin),
      };
      t.diagnostic(`placar: ${JSON.stringify(final)}`);
      return final;
    }

    test('A: mesmo recovery code no mesmo desafio: um consumo, um RECUPERACAO, um PENDENTE', async (t) => {
      const admin = await comFatorERecuperacao('mesmo');
      const d = await entrar(admin.email);

      const [a, b] = await disputar(t, admin, [codigoRepo, 'consumir'], () => recuperar(d.par, admin.codigos[0]), () => recuperar(d.par, admin.codigos[0]));

      assert.deepEqual([a.status, b.status, b.body.codigo], [200, 401, 'DESAFIO_INVALIDO']);
      assert.deepEqual(await placar(t, admin), { codigosConsumidos: 1, pendentes: 1, fatoresAtivos: 1, lotesAtivos: 1, recuperacoesAbertas: 1, sessoes: 0 });
    });

    test('A2: mesmo recovery code em dois desafios: um consumo, um RECUPERACAO, um PENDENTE', async (t) => {
      const admin = await comFatorERecuperacao('mesmoemdois');
      const d1 = await entrar(admin.email);
      const d2 = await entrar(admin.email);

      const [a, b] = await disputar(t, admin, [codigoRepo, 'consumir'], () => recuperar(d1.par, admin.codigos[0]), () => recuperar(d2.par, admin.codigos[0]));

      assert.deepEqual([a.status, b.status], [200, 401]);
      assert.deepEqual(await placar(t, admin), { codigosConsumidos: 1, pendentes: 1, fatoresAtivos: 1, lotesAtivos: 1, recuperacoesAbertas: 1, sessoes: 0 });
    });

    test('B: dois códigos diferentes no mesmo desafio: vence o primeiro; o desafio encerra uma vez; o segundo código segue não consumido', async (t) => {
      const admin = await comFatorERecuperacao('doiscodigos');
      const d = await entrar(admin.email);

      const [a, b] = await disputar(t, admin, [codigoRepo, 'consumir'], () => recuperar(d.par, admin.codigos[0]), () => recuperar(d.par, admin.codigos[1]));

      assert.deepEqual([a.status, b.status, b.body.codigo], [200, 401, 'DESAFIO_INVALIDO']);
      const encerrado = await desafioDe(d.valor);
      assert.deepEqual([encerrado.motivo_encerramento, encerrado.falhas], ['TRANSICAO', 0]);
      assert.equal(await consumido(admin, admin.codigos[0]), true);
      assert.equal(await consumido(admin, admin.codigos[1]), false);
      assert.deepEqual(await placar(t, admin), { codigosConsumidos: 1, pendentes: 1, fatoresAtivos: 1, lotesAtivos: 1, recuperacoesAbertas: 1, sessoes: 0 });
    });

    test('C: dois desafios com códigos diferentes: um só RECUPERACAO; o outro desafio encerrado por RECUPERACAO_INICIADA; o código do perdedor segue disponível', async (t) => {
      const admin = await comFatorERecuperacao('doisdesafios');
      const d1 = await entrar(admin.email);
      const d2 = await entrar(admin.email);

      const [a, b] = await disputar(t, admin, [codigoRepo, 'consumir'], () => recuperar(d1.par, admin.codigos[0]), () => recuperar(d2.par, admin.codigos[1]));

      assert.deepEqual([a.status, b.status, b.body.codigo], [200, 401, 'DESAFIO_INVALIDO']);
      assert.equal((await desafioDe(d2.valor)).motivo_encerramento, 'RECUPERACAO_INICIADA');
      assert.equal(await consumido(admin, admin.codigos[1]), false);
      assert.deepEqual(await placar(t, admin), { codigosConsumidos: 1, pendentes: 1, fatoresAtivos: 1, lotesAtivos: 1, recuperacoesAbertas: 1, sessoes: 0 });
    });

    test('D: duas confirmações simultâneas do mesmo RECUPERACAO: uma conclusão, antigo revogado uma vez, um ATIVO, um lote, uma sessão', async (t) => {
      const admin = await comFatorERecuperacao('duasconclusoes');
      const { cookie, codigoNovo } = await iniciar(admin);
      const codigo = codigoNovo(await stepEstavel());

      const [a, b] = await disputar(t, admin, [fatorRepo, 'ativarTotp'], () => confirmar(cookie.par, codigo), () => confirmar(cookie.par, codigo));

      assert.deepEqual([a.status, b.status, b.body.codigo], [200, 401, 'DESAFIO_INVALIDO']);
      assert.deepEqual((await fatores(admin)).map((f) => [f.estado, f.motivo_revogacao]), [['REVOGADO', 'RECUPERACAO'], ['ATIVO', null]]);
      assert.equal(await n("SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1 AND mfa_metodo = 'RECADASTRO'", [admin.id]), 1);
      assert.deepEqual(await placar(t, admin), { codigosConsumidos: 1, pendentes: 0, fatoresAtivos: 1, lotesAtivos: 1, recuperacoesAbertas: 0, sessoes: 1 });
    });
  });

  describe('nenhum segredo fora do lugar', () => {
    test('recovery codes, secrets, tokens, ciphertext, nonce, chave e URI não aparecem em log, auditoria ou outras tabelas', async (t) => {
      const logs = [];
      for (const metodo of ['log', 'error', 'warn', 'info']) t.mock.method(console, metodo, (...args) => logs.push(args));
      const admin = await comFatorERecuperacao('vazamento');
      const errado = codigosMfa.gerarCodigo();
      const primeiro = await entrar(admin.email);
      await recuperar(primeiro.par, errado);
      const { verificacao, resposta, cookie, codigoNovo } = await iniciar(admin);
      const step = await stepEstavel();
      const fim = await confirmar(cookie.par, codigoNovo(step));
      t.mock.restoreAll();
      assert.equal(fim.status, 200);

      const pendente = await um("SELECT totp_nonce, totp_segredo_cifrado FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [admin.id]);
      const normal = (c) => codigosMfa.normalizarCodigo(c);
      const segredoNovo = totpReferencia.segredoDaChaveManual(resposta.body.cadastro.chaveManual);
      const segredos = [
        ...admin.codigos, ...admin.codigos.map(normal), errado, normal(errado), ...fim.body.codigosRecuperacao, ...fim.body.codigosRecuperacao.map(normal),
        admin.segredo.toString('hex'), totp.chaveManual(Buffer.from(admin.segredo)).replace(/ /g, ''), segredoNovo.toString('hex'),
        resposta.body.cadastro.chaveManual.replace(/ /g, ''), resposta.body.cadastro.uri, primeiro.valor, verificacao.valor, cookie.valor,
        setCookie(fim, COOKIE_SESSAO()).valor, pendente.totp_nonce.toString('hex'), pendente.totp_segredo_cifrado.toString('hex'),
        process.env.MFA_TOTP_KEY_V1, 'otpauth://',
      ];
      for (const tabela of ['logs_auditoria_plataforma', 'login_tentativas_plataforma', 'desafios_mfa_plataforma', 'sessoes_plataforma', 'lotes_recuperacao_mfa_plataforma']) {
        const texto = (await q(`SELECT row_to_json(t)::text AS l FROM ${tabela} t`)).rows.map((r) => r.l).join('\n');
        for (const valor of segredos) assert.equal(texto.includes(valor), false, `${tabela} contém segredo`);
      }
      const textoLogs = JSON.stringify(logs);
      for (const valor of segredos) assert.equal(textoLogs.includes(valor), false, 'log técnico com segredo');
      assert.equal(JSON.stringify(resposta.body).includes(normal(admin.codigos[0])), false);
      assert.equal(JSON.stringify(fim.body).includes(normal(admin.codigos[0])), false);
    });
  });
});
