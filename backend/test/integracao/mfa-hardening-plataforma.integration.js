'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
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
const liberacaoRepo = require('../../src/repositories/liberacao-cadastro-mfa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const sessaoRepo = require('../../src/repositories/sessao-plataforma.repository');
const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const mfaCripto = require('../../src/security/mfa-cripto');
const codigosMfa = require('../../src/security/codigos-mfa');
const cooldown = require('../../src/security/cooldown');
const { gerarTokenSessao, hashTokenSessao } = require('../../src/security/token');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * Endurecimento do MFA do Painel Privado, contra PostgreSQL real: o que
 * resta de desafio, fator pendente e liberação depois de inativar e
 * reativar o administrador; o relógio que a sessão usa dentro de uma
 * transação; alteração direta de um desafio já concluído; e entradas
 * adulteradas que as outras suítes não exercitam de ponta a ponta.
 *
 * Cada teste observa tudo, registra o que viu e só então afirma.
 */

const MIGRATIONS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048', '049', '050', '051', '052', '053', '054', '055', '056'];
const SENHA = 'planeta-nebulosa-ozonio-42';
const DESAFIO_INVALIDO = { status: 'error', codigo: 'DESAFIO_INVALIDO', message: 'Etapa de verificação inválida ou expirada' };
const SESSAO_INVALIDA = { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'Sessão inválida ou expirada' };
const CODIGO_INVALIDO = { status: 'error', codigo: 'MFA_CODIGO_INVALIDO', message: 'Código inválido' };
const COOKIE_DESAFIO = () => authConfig.desafioMfa.cookieNome;
const COOKIE_SESSAO = () => authConfig.sessao.cookieNomeAdmin;
const INSTANTE = "'HH24:MI:SS.US'";
const pausa = (ms) => new Promise((resolver) => { setTimeout(resolver, ms); });

function setCookie(resposta, nome) {
  const bruto = (resposta.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${nome}=`));
  if (bruto === undefined) return null;
  const [par] = bruto.split(';').map((p) => p.trim());
  const valor = par.slice(nome.length + 1);
  return valor === '' ? null : { valor, par };
}

describe('endurecimento do MFA do Painel Privado (PostgreSQL real)', () => {
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
  const get = (caminho, cookie) => {
    const r = request(app).get(`/api/plataforma${caminho}`);
    return cookie ? r.set('Cookie', cookie) : r;
  };
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
    return { ...admin, fatorId: fator.id, codigo: (step) => totpReferencia.codigoDoStep(segredo, step) };
  }

  async function liberar(admin) {
    const codigo = codigosMfa.gerarCodigo();
    const codigoHash = codigosMfa.hashCodigoLiberacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(codigo) });
    await liberacaoRepo.criar(contexto.pool, { administradorId: admin.id, codigoHash, origem: 'CLI_LIBERACAO', validadeMinutos: 30 });
    return codigo;
  }

  async function entrar(email) {
    const r = await post('/auth/login', null, { email, senha: SENHA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { ...setCookie(r, COOKIE_DESAFIO()), etapa: r.body.etapa };
  }

  /** Administrador sem TOTP, já no desafio CADASTRO, com o secret pendente em mãos. */
  async function emCadastro(prefixo) {
    const admin = await novoAdministrador(prefixo);
    const liberacao = await liberar(admin);
    const login = await entrar(admin.email);
    const r = await post('/auth/mfa/liberacao', login.par, { codigoLiberacao: liberacao });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const segredo = totpReferencia.segredoDaChaveManual(r.body.cadastro.chaveManual);
    return { admin, desafio: setCookie(r, COOKIE_DESAFIO()), codigo: (step) => totpReferencia.codigoDoStep(segredo, step) };
  }

  // Step do relógio do banco com pelo menos 4 s de folga até o próximo.
  async function stepEstavel() {
    const agora = (await um('SELECT clock_timestamp() AS t')).t.getTime();
    const restante = 30_000 - (agora % 30_000);
    if (restante > 4_000) return totpReferencia.stepDe(agora);
    await pausa(restante + 100);
    return totpReferencia.stepDe((await um('SELECT clock_timestamp() AS t')).t.getTime());
  }

  const inativar = (admin) => q('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [admin.id]);
  const reativar = (admin) => q('UPDATE administradores_plataforma SET ativo = true WHERE id = $1', [admin.id]);
  const sessoesValidas = async (admin) => (await um('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1 AND revogada_em IS NULL', [admin.id])).n;
  const fatores = async (admin) => (await q('SELECT estado FROM fatores_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id])).rows.map((f) => f.estado);
  const desafioDaSessao = (sessaoId) => um('SELECT * FROM desafios_mfa_plataforma WHERE sessao_criada_id = $1', [sessaoId]);
  const desafioNoBanco = (token) => um(
    `SELECT tipo, encerrado_em IS NULL AS aberto, motivo_encerramento, expira_em > clock_timestamp() AS no_prazo
       FROM desafios_mfa_plataforma WHERE token_hash = $1`,
    [hashTokenSessao(token)],
  );
  const liberacoes = async (admin) => (await q(
    `SELECT consumida_em IS NULL AND revogada_em IS NULL AS aberta, motivo_revogacao, expira_em > clock_timestamp() AS no_prazo
       FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1 ORDER BY id`,
    [admin.id],
  )).rows;
  const fatoresNoBanco = async (admin) => (await q(
    `SELECT estado, motivo_revogacao, totp_nonce IS NULL AND totp_segredo_cifrado IS NULL AS sem_segredo
       FROM fatores_mfa_plataforma WHERE administrador_id = $1 ORDER BY id`,
    [admin.id],
  )).rows;
  const recuperacao = (admin) => um(
    `SELECT (SELECT count(*)::int FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND revogado_em IS NULL) AS lotes_ativos,
            (SELECT count(*)::int FROM codigos_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND consumido_em IS NULL) AS codigos_disponiveis`,
    [admin.id],
  );

  /** Lote de 10 códigos de recuperação, como o cadastro deixa; devolve os códigos em claro. */
  async function comCodigosDeRecuperacao(admin) {
    const codigos = Array.from({ length: 10 }, () => codigosMfa.gerarCodigo());
    const hashes = codigos.map((codigo) => codigosMfa.hashCodigoRecuperacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(codigo) }));
    const lote = await loteRepo.criar(contexto.pool, admin.id);
    assert.equal(await codigoRepo.inserirHashes(contexto.pool, { administradorId: admin.id, loteId: lote.id, hashes }), 10);
    return codigos;
  }
  const instantesDaSessao = (executor, sessaoId) => executor.query(
    `SELECT to_char(criado_em, ${INSTANTE}) AS criado_em, to_char(mfa_verificado_em, ${INSTANTE}) AS mfa_verificado_em,
            to_char(ultimo_uso_em, ${INSTANTE}) AS ultimo_uso_em, to_char(expira_em, ${INSTANTE}) AS expira_em,
            to_char(revogada_em, ${INSTANTE}) AS revogada_em, motivo_revogacao
       FROM sessoes_plataforma WHERE id = $1`,
    [sessaoId],
  ).then((r) => r.rows[0]);
  const relogios = (executor) => executor.query(
    `SELECT to_char(now(), ${INSTANTE}) AS now, to_char(clock_timestamp(), ${INSTANTE}) AS clock_timestamp,
            round(extract(epoch FROM clock_timestamp() - now()) * 1000) AS idade_da_transacao_ms`,
  ).then((r) => r.rows[0]);

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

  describe('A5 — administrador inativado e reativado: nada do que existia antes volta a valer', () => {
    const INATIVADO = 'ADMINISTRADOR_INATIVADO';
    const ENCERRADO = { aberto: false, motivo: INATIVADO };
    const situacao = (desafio) => ({ aberto: desafio.aberto, motivo: desafio.motivo_encerramento });

    test('A5.1 desafio VERIFICACAO aberto antes da inativação: encerrado na inativação; depois da reativação não mostra etapa nem aceita TOTP válido', async (t) => {
      const admin = await comTotpAtivo('a5-verificacao');
      const desafio = await entrar(admin.email);
      assert.equal(desafio.etapa, 'VERIFICACAO');

      await inativar(admin);
      const durante = { estado: (await get('/auth/mfa/estado', desafio.par)).status, banco: await desafioNoBanco(desafio.valor) };
      await reativar(admin);
      const estado = await get('/auth/mfa/estado', desafio.par);
      const tentativa = await verificar(desafio.par, admin.codigo(await stepEstavel()));
      const depois = {
        estado: estado.status,
        verificar: tentativa.status,
        cookieDeSessao: setCookie(tentativa, COOKIE_SESSAO()) !== null,
        sessoesValidas: await sessoesValidas(admin),
        banco: await desafioNoBanco(desafio.valor),
      };
      t.diagnostic(`A5.1 ${JSON.stringify({ durante, depois })}`);

      assert.equal(durante.estado, 401, 'inativo: o desafio não vale');
      assert.deepEqual(situacao(durante.banco), ENCERRADO, 'encerrado na inativação');
      assert.deepEqual([depois.estado, depois.verificar, depois.cookieDeSessao, depois.sessoesValidas], [401, 401, false, 0]);
      assert.deepEqual(situacao(depois.banco), ENCERRADO, 'reativar não reabre');
    });

    test('A5.2 desafio CADASTRO com fator pendente: desafio encerrado, PENDENTE revogado e sem segredo; depois da reativação o TOTP antigo não conclui o cadastro', async (t) => {
      const c = await emCadastro('a5-cadastro');
      await inativar(c.admin);
      const durante = { estado: (await get('/auth/mfa/estado', c.desafio.par)).status, banco: await desafioNoBanco(c.desafio.valor), fatores: await fatoresNoBanco(c.admin) };
      await reativar(c.admin);

      const r = await post('/auth/mfa/cadastro/confirmar', c.desafio.par, { codigo: c.codigo(await stepEstavel()) });
      const depois = {
        confirmar: r.status,
        cookieDeSessao: setCookie(r, COOKIE_SESSAO()) !== null,
        entregouCodigosDeRecuperacao: Array.isArray(r.body.codigosRecuperacao),
        fatores: await fatoresNoBanco(c.admin),
        recuperacao: await recuperacao(c.admin),
        sessoesValidas: await sessoesValidas(c.admin),
      };
      t.diagnostic(`A5.2 ${JSON.stringify({ durante, depois })}`);

      const REVOGADO = [{ estado: 'REVOGADO', motivo_revogacao: INATIVADO, sem_segredo: true }];
      assert.equal(durante.estado, 401);
      assert.deepEqual(situacao(durante.banco), ENCERRADO);
      assert.deepEqual(durante.fatores, REVOGADO, 'o secret cifrado é destruído na inativação');
      assert.deepEqual([depois.confirmar, depois.cookieDeSessao, depois.entregouCodigosDeRecuperacao, depois.sessoesValidas], [401, false, false, 0]);
      assert.deepEqual(depois.fatores, REVOGADO, 'nenhum fator foi ativado');
      assert.deepEqual(depois.recuperacao, { lotes_ativos: 0, codigos_disponiveis: 0 });
    });

    test('A5.3 desafio CADASTRO: depois da reativação não entrega QR novo nem cria outro PENDENTE', async (t) => {
      const c = await emCadastro('a5-reinicio');
      await inativar(c.admin);
      await reativar(c.admin);

      const r = await post('/auth/mfa/cadastro/reiniciar', c.desafio.par, {});
      const depois = { reiniciar: r.status, entregouSegredo: r.body.cadastro !== undefined, fatores: await fatores(c.admin) };
      t.diagnostic(`A5.3 ${JSON.stringify({ depois })}`);

      assert.deepEqual(depois, { reiniciar: 401, entregouSegredo: false, fatores: ['REVOGADO'] });
    });

    test('A5.4 liberação de cadastro emitida antes da inativação: revogada na inativação; depois da reativação o código não abre o cadastro', async (t) => {
      const admin = await novoAdministrador('a5-liberacao');
      const codigo = await liberar(admin);
      await inativar(admin);
      const durante = { liberacoes: await liberacoes(admin) };
      await reativar(admin);

      const desafio = await entrar(admin.email);
      const r = await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: codigo });
      const depois = { etapaDoLoginNovo: desafio.etapa, liberacao: r.status, entregouSegredo: r.body.cadastro !== undefined, fatores: await fatores(admin), liberacoes: await liberacoes(admin) };
      t.diagnostic(`A5.4 ${JSON.stringify({ durante, depois })}`);

      assert.deepEqual(durante.liberacoes.map((l) => [l.aberta, l.motivo_revogacao]), [[false, INATIVADO]]);
      assert.equal(depois.etapaDoLoginNovo, 'LIBERACAO');
      assert.deepEqual([depois.liberacao, depois.entregouSegredo, depois.fatores], [401, false, []]);
      assert.deepEqual(depois.liberacoes.map((l) => [l.aberta, l.motivo_revogacao]), [[false, INATIVADO]]);
    });

    test('A5.5 o que continua: sessão antiga revogada, fator ATIVO e códigos de recuperação intactos, login novo com senha e TOTP', async (t) => {
      const admin = await comTotpAtivo('a5-preservado');
      const codigos = await comCodigosDeRecuperacao(admin);
      const antiga = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const antes = { fatores: await fatoresNoBanco(admin), recuperacao: await recuperacao(admin) };

      await inativar(admin);
      const durante = { login: (await post('/auth/login', null, { email: admin.email, senha: SENHA })).status };
      await reativar(admin);

      const painelComAntiga = await get('/painel', antiga.cookie);
      const desafio = await entrar(admin.email);
      const r = await verificar(desafio.par, admin.codigo(await stepEstavel()));
      const nova = setCookie(r, COOKIE_SESSAO());
      const depois = {
        sessaoAntiga: painelComAntiga.status,
        motivoDaSessaoAntiga: (await um('SELECT motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [antiga.id])).motivo_revogacao,
        fatores: await fatoresNoBanco(admin),
        recuperacao: await recuperacao(admin),
        etapaDoLoginNovo: desafio.etapa,
        verificar: r.status,
        painelComSessaoNova: nova === null ? null : (await get('/painel', nova.par)).status,
      };
      const outroLogin = await entrar(admin.email);
      const comCodigoAntigo = await post('/auth/mfa/recuperacao', outroLogin.par, { codigoRecuperacao: codigos[0] });
      depois.codigoDeRecuperacaoAntigo = { status: comCodigoAntigo.status, etapa: comCodigoAntigo.body.etapa ?? null };
      t.diagnostic(`A5.5 ${JSON.stringify({ antes, durante, depois })}`);

      assert.deepEqual(antes, { fatores: [{ estado: 'ATIVO', motivo_revogacao: null, sem_segredo: false }], recuperacao: { lotes_ativos: 1, codigos_disponiveis: 10 } });
      assert.equal(durante.login, 401);
      assert.deepEqual(depois, {
        sessaoAntiga: 401,
        motivoDaSessaoAntiga: INATIVADO,
        fatores: antes.fatores,
        recuperacao: antes.recuperacao,
        etapaDoLoginNovo: 'VERIFICACAO',
        verificar: 200,
        painelComSessaoNova: 200,
        codigoDeRecuperacaoAntigo: { status: 200, etapa: 'RECUPERACAO' },
      });
    });
  });

  describe('A6 — relógio da sessão dentro de uma transação', () => {
    async function emTransacaoAberta(operacao) {
      const cliente = await contexto.pool.connect();
      try {
        await cliente.query('BEGIN');
        // Fixa o now() desta transação antes do que vem a seguir.
        await cliente.query('SELECT now()');
        return await operacao(cliente);
      } finally {
        await cliente.query('ROLLBACK').catch(() => {});
        cliente.release();
      }
    }

    test('A6.1 sessão que vence depois do início da transação não é aceita nem renovada por ela', async (t) => {
      const admin = await comTotpAtivo('a6-validade');
      const sessao = await criarSessaoAdministrativa(contexto.pool, admin.id);

      const observado = await emTransacaoAberta(async (cliente) => {
        await q("UPDATE sessoes_plataforma SET expira_em = clock_timestamp() + interval '150 milliseconds' WHERE id = $1", [sessao.id]);
        await pausa(400);
        const relogio = await relogios(cliente);
        const antes = await instantesDaSessao(cliente, sessao.id);
        const vencida = (await cliente.query('SELECT expira_em <= clock_timestamp() AS v FROM sessoes_plataforma WHERE id = $1', [sessao.id])).rows[0].v;
        const lida = await sessaoRepo.buscarValidaPorHash(cliente, hashTokenSessao(sessao.token), 30);
        const renovou = await sessaoRepo.registrarUso(cliente, sessao.id, 30);
        const depois = await instantesDaSessao(cliente, sessao.id);
        return { relogio, vencidaNoRelogioReal: vencida, encontradaNaTransacao: lida !== null, renovadaNaTransacao: renovou, antes, depois };
      });
      const foraDaTransacao = (await sessaoRepo.buscarValidaPorHash(contexto.pool, hashTokenSessao(sessao.token), 30)) !== null;
      t.diagnostic(`A6.1 ${JSON.stringify({ ...observado, encontradaForaDeTransacao: foraDaTransacao })}`);

      assert.equal(observado.vencidaNoRelogioReal, true);
      assert.equal(foraDaTransacao, false, 'fora de transação a sessão vencida já é recusada');
      assert.deepEqual([observado.encontradaNaTransacao, observado.renovadaNaTransacao], [false, false]);
    });

    test('A6.2 fluxo real: sessão que vence enquanto a reautenticação espera a trava do administrador não conclui a operação', async (t) => {
      const admin = await comTotpAtivo('a6-fluxo');
      const sessao = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const codigo = admin.codigo(await stepEstavel());

      const bloqueador = await contexto.pool.connect();
      let resposta;
      let noEnvio;
      let naLiberacao;
      try {
        await bloqueador.query('BEGIN');
        await travaRepo.travarAdministrador(bloqueador, admin.id);
        await q("UPDATE sessoes_plataforma SET expira_em = clock_timestamp() + interval '800 milliseconds' WHERE id = $1", [sessao.id]);
        noEnvio = await um('SELECT expira_em > clock_timestamp() AS valida FROM sessoes_plataforma WHERE id = $1', [sessao.id]);
        const pedido = post('/auth/mfa/substituicao/iniciar', sessao.cookie, { senha: SENHA, codigo }).then((r) => r);
        await pausa(1500);
        naLiberacao = await um('SELECT expira_em > clock_timestamp() AS valida FROM sessoes_plataforma WHERE id = $1', [sessao.id]);
        await bloqueador.query('COMMIT');
        resposta = await pedido;
      } finally {
        await bloqueador.query('ROLLBACK').catch(() => {});
        bloqueador.release();
      }
      const observado = {
        sessaoValidaNoEnvio: noEnvio.valida,
        sessaoValidaQuandoATravaFoiLiberada: naLiberacao.valida,
        resposta: resposta.status,
        codigo: resposta.body.codigo ?? null,
        entregouSegredo: resposta.body.cadastro !== undefined,
        fatores: await fatores(admin),
      };
      t.diagnostic(`A6.2 ${JSON.stringify(observado)}`);

      assert.deepEqual([observado.sessaoValidaNoEnvio, observado.sessaoValidaQuandoATravaFoiLiberada], [true, false]);
      assert.deepEqual([observado.resposta, observado.entregouSegredo, observado.fatores], [401, false, ['ATIVO']]);
    });

    test('A6.3 sessão criada depois do início da transação que a revoga: sem erro de constraint, não autentica, e a revogação não fica anterior à criação', async (t) => {
      const admin = await comTotpAtivo('a6-revogacao');

      const observado = await emTransacaoAberta(async (cliente) => {
        await pausa(50);
        const criada = await criarSessaoAdministrativa(contexto.pool, admin.id);
        const relogio = await relogios(cliente);
        const revogou = await sessaoRepo.revogar(cliente, criada.id, 'LOGOUT').then((ok) => ({ ok }), (erro) => ({ erro: erro.code }));
        const fechou = await cliente.query('COMMIT').then(() => true, (erro) => erro.code);
        return { criada, relogio, revogou, commit: fechou };
      });
      const instantes = await instantesDaSessao(contexto.pool, observado.criada.id);
      const coerente = (await um('SELECT revogada_em >= criado_em AS c, revogada_em >= mfa_verificado_em AS m FROM sessoes_plataforma WHERE id = $1', [observado.criada.id]));
      const painel = await get('/painel', observado.criada.cookie);
      t.diagnostic(`A6.3 ${JSON.stringify({ relogio: observado.relogio, revogou: observado.revogou, commit: observado.commit, instantes, revogadaDepoisDeCriada: coerente.c, revogadaDepoisDoMfa: coerente.m, painel: painel.status })}`);

      assert.deepEqual([observado.revogou, observado.commit], [{ ok: true }, true], 'sem quebra de constraint');
      assert.deepEqual(painel.body, SESSAO_INVALIDA);
      assert.equal(coerente.c, true);
    });

    test('A6.4 revogação de todas as sessões, mesma situação: nenhuma autentica e nenhuma fica revogada antes de existir', async (t) => {
      const admin = await comTotpAtivo('a6-todas');

      const observado = await emTransacaoAberta(async (cliente) => {
        await pausa(50);
        const criada = await criarSessaoAdministrativa(contexto.pool, admin.id);
        const revogadas = await sessaoRepo.revogarTodasDoAdministrador(cliente, admin.id, 'MFA_RESET_OPERACIONAL');
        await cliente.query('COMMIT');
        return { criada, revogadas };
      });
      const instantes = await instantesDaSessao(contexto.pool, observado.criada.id);
      const coerente = await um('SELECT revogada_em >= criado_em AS c FROM sessoes_plataforma WHERE id = $1', [observado.criada.id]);
      const painel = await get('/painel', observado.criada.cookie);
      t.diagnostic(`A6.4 ${JSON.stringify({ revogadas: observado.revogadas, instantes, revogadaDepoisDeCriada: coerente.c, painel: painel.status })}`);

      assert.equal(observado.revogadas, 1);
      assert.deepEqual(painel.body, SESSAO_INVALIDA);
      assert.equal(coerente.c, true);
    });
  });

  describe('A7 — alteração direta de um desafio concluído que comprova sessão', () => {
    async function sessaoComprovada(prefixo) {
      const admin = await comTotpAtivo(prefixo);
      const sessao = await criarSessaoAdministrativa(contexto.pool, admin.id);
      return { admin, sessao, desafio: await desafioDaSessao(sessao.id) };
    }

    async function alterar(desafioId, atribuicao, params = []) {
      try {
        await q(`UPDATE desafios_mfa_plataforma SET ${atribuicao} WHERE id = $1`, [desafioId, ...params]);
        return { aceito: true };
      } catch (erro) {
        return { aceito: false, code: erro.code, constraint: erro.constraint ?? null };
      }
    }

    async function sessaoRevogadaSemVinculo(admin) {
      const { id } = await um(
        `INSERT INTO sessoes_plataforma (administrador_id, token_hash, expira_em, revogada_em, motivo_revogacao)
         VALUES ($1, $2, clock_timestamp() + interval '1 hour', clock_timestamp(), 'LOGOUT') RETURNING id`,
        [admin.id, hashTokenSessao(gerarTokenSessao())],
      );
      return id;
    }

    /** O que a aplicação enxerga: a leitura do repositório e a rota protegida. */
    async function leitura(sessao) {
      const lida = await sessaoRepo.buscarValidaPorHash(contexto.pool, hashTokenSessao(sessao.token), 30);
      return { buscarValidaPorHash: lida === null ? null : 'sessão', painel: (await get('/painel', sessao.cookie)).status };
    }

    // [campo, descrição, atribuição, parâmetros a partir do cenário]
    const ADULTERACOES = [
      ['administrador_id', 'trocar para outro administrador', 'administrador_id = $2', async () => [(await novoAdministrador('a7-outro')).id]],
      ['tipo', 'trocar para CADASTRO', "tipo = 'CADASTRO'", () => []],
      ['tipo', 'trocar para RECUPERACAO', "tipo = 'RECUPERACAO'", () => []],
      ['tipo', 'trocar para SUBSTITUICAO', "tipo = 'SUBSTITUICAO'", () => []],
      ['tipo', 'trocar para LIBERACAO', "tipo = 'LIBERACAO'", () => []],
      ['motivo_encerramento', 'trocar para LOGOUT', "motivo_encerramento = 'LOGOUT'", () => []],
      ['motivo_encerramento', 'trocar para EXPIRADO', "motivo_encerramento = 'EXPIRADO'", () => []],
      ['criado_em', 'recuar uma hora', "criado_em = criado_em - interval '1 hour'", () => []],
      ['criado_em', 'adiantar para depois do MFA', 'criado_em = encerrado_em', () => []],
      ['encerrado_em', 'recuar para antes do MFA', 'encerrado_em = criado_em', () => []],
      ['encerrado_em', 'adiantar uma hora', "encerrado_em = encerrado_em + interval '1 hour'", () => []],
      ['encerrado_em', 'reabrir (nulo)', 'encerrado_em = NULL', () => []],
      ['sessao_criada_id', 'desligar (nulo)', 'sessao_criada_id = NULL', () => []],
      ['sessao_criada_id', 'religar a uma sessão revogada do mesmo administrador', 'sessao_criada_id = $2', async ({ admin }) => [await sessaoRevogadaSemVinculo(admin)]],
      ['sessao_criada_id', 'religar à sessão de outro administrador', 'sessao_criada_id = $2', async () => {
        const outro = await comTotpAtivo('a7-alheio');
        return [(await criarSessaoAdministrativa(contexto.pool, outro.id)).id];
      }],
    ];

    async function adulterar() {
      const linhas = [];
      for (const [campo, descricao, atribuicao, parametros] of ADULTERACOES) {
        const cenario = await sessaoComprovada('a7-campo');
        const antes = await leitura(cenario.sessao);
        const update = await alterar(cenario.desafio.id, atribuicao, await parametros(cenario));
        linhas.push({ campo, descricao, antes, update, depois: await leitura(cenario.sessao), sessoesNaoRevogadas: await sessoesValidas(cenario.admin) });
      }
      return linhas;
    }

    test('A7.1 comportamento normal: sessão nascida do desafio concluído é lida pelo repositório e autentica', async (t) => {
      const { sessao, desafio } = await sessaoComprovada('a7-normal');
      const observado = { leitura: await leitura(sessao), desafio: { tipo: desafio.tipo, motivo: desafio.motivo_encerramento, ligado: desafio.sessao_criada_id === sessao.id } };
      t.diagnostic(`A7.1 ${JSON.stringify(observado)}`);

      assert.deepEqual(observado, { leitura: { buscarValidaPorHash: 'sessão', painel: 200 }, desafio: { tipo: 'VERIFICACAO', motivo: 'CONCLUIDO', ligado: true } });
    });

    test('A7.2 cada campo crítico adulterado por SQL direto, um por vez: ou o banco recusa, ou a leitura recusa a sessão, ou a comprovação continua coerente', async (t) => {
      const linhas = await adulterar();
      for (const l of linhas) {
        t.diagnostic(`A7.2 ${l.campo} | ${l.descricao} | UPDATE ${l.update.aceito ? 'aceito' : `recusado ${l.update.code} ${l.update.constraint}`} | leitura ${JSON.stringify(l.depois)}`);
      }

      const coerentes = new Set(['criado_em: recuar uma hora', 'encerrado_em: adiantar uma hora']);
      for (const l of linhas) {
        const nome = `${l.campo}: ${l.descricao}`;
        assert.deepEqual(l.antes, { buscarValidaPorHash: 'sessão', painel: 200 }, nome);
        if (!l.update.aceito || coerentes.has(nome)) {
          assert.deepEqual(l.depois, { buscarValidaPorHash: 'sessão', painel: 200 }, `${nome}: a comprovação não mudou`);
        } else {
          assert.deepEqual(l.depois, { buscarValidaPorHash: null, painel: 401 }, `${nome}: a leitura falha fechada`);
        }
      }
    });

    test('A7.3 religar o desafio a uma sessão revogada não a faz valer; a original deixa de valer', async (t) => {
      const { admin, sessao, desafio } = await sessaoComprovada('a7-religar');
      const token = gerarTokenSessao();
      const { id: revogada } = await um(
        `INSERT INTO sessoes_plataforma (administrador_id, token_hash, expira_em, revogada_em, motivo_revogacao, mfa_verificado_em, mfa_metodo, criado_em)
         VALUES ($1, $2, clock_timestamp() + interval '1 hour', clock_timestamp(), 'LOGOUT', $3, 'TOTP', clock_timestamp()) RETURNING id`,
        [admin.id, hashTokenSessao(token), desafio.encerrado_em],
      );

      const update = await alterar(desafio.id, 'sessao_criada_id = $2', [revogada]);
      const observado = {
        update,
        original: await leitura(sessao),
        revogada: await leitura({ token, cookie: `${COOKIE_SESSAO()}=${token}` }),
      };
      t.diagnostic(`A7.3 ${JSON.stringify(observado)}`);

      assert.deepEqual(observado.original, { buscarValidaPorHash: null, painel: 401 });
      assert.deepEqual(observado.revogada, { buscarValidaPorHash: null, painel: 401 });
    });

    test('A7.4 limite de confiança: quem escreve no banco com o papel da aplicação insere desafio e sessão coerentes e obtém sessão aceita', async (t) => {
      const admin = await comTotpAtivo('a7-fabricada');
      const token = gerarTokenSessao();
      const cliente = await contexto.pool.connect();
      let fechou;
      try {
        await cliente.query('BEGIN');
        const { rows: [desafio] } = await cliente.query(
          `INSERT INTO desafios_mfa_plataforma (administrador_id, token_hash, tipo, criado_em, expira_em, encerrado_em, motivo_encerramento)
           VALUES ($1, $2, 'VERIFICACAO', clock_timestamp() - interval '2 seconds', clock_timestamp() + interval '5 minutes', clock_timestamp(), 'CONCLUIDO')
           RETURNING id, encerrado_em - interval '1 second' AS verificado_em`,
          [admin.id, hashTokenSessao(gerarTokenSessao())],
        );
        const { rows: [sessao] } = await cliente.query(
          `INSERT INTO sessoes_plataforma (administrador_id, token_hash, expira_em, mfa_verificado_em, mfa_metodo, criado_em, ultimo_uso_em)
           VALUES ($1, $2, clock_timestamp() + interval '1 hour', $3, 'TOTP', clock_timestamp(), clock_timestamp()) RETURNING id`,
          [admin.id, hashTokenSessao(token), desafio.verificado_em],
        );
        await cliente.query('UPDATE desafios_mfa_plataforma SET sessao_criada_id = $2 WHERE id = $1', [desafio.id, sessao.id]);
        fechou = await cliente.query('COMMIT').then(() => true, (erro) => erro.code);
      } finally {
        await cliente.query('ROLLBACK').catch(() => {});
        cliente.release();
      }
      const observado = { commit: fechou, leitura: await leitura({ token, cookie: `${COOKIE_SESSAO()}=${token}` }) };
      t.diagnostic(`A7.4 ${JSON.stringify(observado)}`);

      assert.deepEqual(observado, { commit: true, leitura: { buscarValidaPorHash: 'sessão', painel: 200 } });
    });

    // Imutabilidade do desafio concluído não foi implementada: não corrige o cenário de escrita direta no
    // banco, em que um escritor privilegiado insere artefatos coerentes novos (A7.4). Contra a aplicação,
    // a leitura continua falhando fechada.
    test('A7.5 decisão de arquitetura: o banco aceita alteração direta; a que quebra a comprovação derruba a sessão e a que continua coerente não dá privilégio novo', async (t) => {
      const linhas = await adulterar();
      const aceitas = linhas.filter((l) => l.update.aceito);
      t.diagnostic(`A7.5 aceitas pelo banco: ${JSON.stringify(aceitas.map((l) => `${l.campo}: ${l.descricao} -> painel ${l.depois.painel}`))}`);

      assert.ok(aceitas.length > 0, 'não há imutabilidade absoluta no banco');
      for (const l of aceitas) {
        const nome = `${l.campo}: ${l.descricao}`;
        const recusada = l.depois.painel === 401 && l.depois.buscarValidaPorHash === null;
        const amesma = l.depois.painel === 200 && l.depois.buscarValidaPorHash === 'sessão';
        assert.ok(recusada || amesma, nome);
        assert.equal(l.sessoesNaoRevogadas, 1, `${nome}: nenhuma sessão a mais`);
      }
      assert.ok(aceitas.some((l) => l.depois.painel === 401), 'a leitura falha fechada quando a comprovação quebra');
    });

    test('A7.6 nenhum caminho da aplicação altera o desafio depois de concluído: uso da sessão, novos logins, limite de desafios e logout', async (t) => {
      const admin = await comTotpAtivo('a7-aplicacao');
      const desafio = await entrar(admin.email);
      const r = await verificar(desafio.par, admin.codigo(await stepEstavel()));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const sessao = setCookie(r, COOKIE_SESSAO());
      const foto = () => um(
        `SELECT xmin::text AS xmin, administrador_id, tipo, motivo_encerramento, criado_em, encerrado_em, expira_em, sessao_criada_id, falhas
           FROM desafios_mfa_plataforma WHERE token_hash = $1`,
        [hashTokenSessao(desafio.valor)],
      );
      const concluido = await foto();

      const passos = {
        painel: (await get('/painel', sessao.par)).status,
        me: (await get('/auth/me', sessao.par)).status,
        verificarDeNovo: (await verificar(desafio.par, admin.codigo(await stepEstavel()))).status,
        estado: (await get('/auth/mfa/estado', desafio.par)).status,
      };
      for (let i = 0; i < 6; i += 1) await entrar(admin.email);
      passos.logoutComOsDoisCookies = (await post('/auth/logout', `${sessao.par}; ${desafio.par}`)).status;
      passos.logoutSoComODesafio = (await post('/auth/logout', desafio.par)).status;
      passos.painelDepoisDoLogout = (await get('/painel', sessao.par)).status;
      t.diagnostic(`A7.6 ${JSON.stringify(passos)}`);

      assert.deepEqual(passos, { painel: 200, me: 200, verificarDeNovo: 401, estado: 401, logoutComOsDoisCookies: 200, logoutSoComODesafio: 200, painelDepoisDoLogout: 401 });
      assert.equal(concluido.motivo_encerramento, 'CONCLUIDO');
      assert.deepEqual(await foto(), concluido, 'a linha do desafio concluído não foi reescrita');
    });
  });

  describe('entradas adulteradas', () => {
    test('desafio já concluído reapresentado com outro TOTP válido: 401 e nenhuma segunda sessão', async () => {
      const admin = await comTotpAtivo('reuso-concluido');
      const desafio = await entrar(admin.email);
      const step = await stepEstavel();
      assert.equal((await verificar(desafio.par, admin.codigo(step))).status, 200);

      const r = await verificar(desafio.par, admin.codigo(step + 1));
      assert.deepEqual([r.status, r.body, setCookie(r, COOKIE_SESSAO())], [401, DESAFIO_INVALIDO, null]);
      assert.equal(await sessoesValidas(admin), 1);
    });

    test('valor do token de sessão sob o nome do cookie do desafio: 401 no estado e na verificação', async () => {
      const admin = await comTotpAtivo('troca-de-nome');
      const sessao = await criarSessaoAdministrativa(contexto.pool, admin.id);
      const trocado = `${COOKIE_DESAFIO()}=${sessao.token}`;

      assert.deepEqual((await get('/auth/mfa/estado', trocado)).body, DESAFIO_INVALIDO);
      const r = await verificar(trocado, admin.codigo(await stepEstavel()));
      assert.deepEqual([r.status, r.body], [401, DESAFIO_INVALIDO]);
      assert.equal(await sessoesValidas(admin), 1);
    });

    test('token aleatório no formato certo: 401 como sessão e como desafio, sem distinguir de cookie ausente', async () => {
      const token = gerarTokenSessao();
      const comoSessao = await get('/painel', `${COOKIE_SESSAO()}=${token}`);
      const semCookie = await get('/painel');
      assert.deepEqual([comoSessao.status, comoSessao.body], [semCookie.status, semCookie.body]);
      assert.deepEqual(comoSessao.body, SESSAO_INVALIDA);

      const comoDesafio = await get('/auth/mfa/estado', `${COOKIE_DESAFIO()}=${token}`);
      assert.deepEqual([comoDesafio.status, comoDesafio.body], [401, DESAFIO_INVALIDO]);
    });

    test('sessão de um administrador com o desafio SUBSTITUICAO de outro: nada é trocado para nenhum dos dois', async () => {
      const dono = await comTotpAtivo('cruzado-dono');
      const intruso = await comTotpAtivo('cruzado-intruso');
      const sessaoDono = await criarSessaoAdministrativa(contexto.pool, dono.id);
      const sessaoIntruso = await criarSessaoAdministrativa(contexto.pool, intruso.id);

      const inicio = await post('/auth/mfa/substituicao/iniciar', sessaoDono.cookie, { senha: SENHA, codigo: dono.codigo(await stepEstavel()) });
      assert.equal(inicio.status, 200, JSON.stringify(inicio.body));
      const desafioDono = setCookie(inicio, COOKIE_DESAFIO());
      const segredoNovo = totpReferencia.segredoDaChaveManual(inicio.body.cadastro.chaveManual);

      const r = await post(
        '/auth/mfa/substituicao/confirmar',
        `${sessaoIntruso.cookie}; ${desafioDono.par}`,
        { codigo: totpReferencia.codigoDoStep(segredoNovo, await stepEstavel()) },
      );
      assert.deepEqual([r.status, r.body], [401, DESAFIO_INVALIDO]);
      assert.deepEqual([await fatores(dono), await fatores(intruso)], [['ATIVO', 'PENDENTE'], ['ATIVO']]);
      assert.deepEqual([await sessoesValidas(dono), await sessoesValidas(intruso)], [1, 1]);
    });

    test('dígitos de outros alfabetos no TOTP: 400 de validação, sem contar falha nem consumir o desafio', async () => {
      const admin = await comTotpAtivo('unicode-totp');
      const desafio = await entrar(admin.email);

      for (const codigo of ['１２３４５６', '١٢٣٤٥٦', '12345６', '123 456', '+12345', '1e5000', '12345\u0000']) {
        const r = await verificar(desafio.par, codigo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(codigo));
      }
      const linha = await um('SELECT falhas, encerrado_em FROM desafios_mfa_plataforma WHERE token_hash = $1', [hashTokenSessao(desafio.valor)]);
      assert.deepEqual([linha.falhas, linha.encerrado_em], [0, null]);
      assert.equal((await verificar(desafio.par, admin.codigo(await stepEstavel()))).status, 200);
    });

    test('letras parecidas de outros alfabetos no recovery code: 401 genérico, nada consumido', async () => {
      const admin = await comTotpAtivo('unicode-recovery');
      const desafio = await entrar(admin.email);

      for (const codigo of ['АААА-ВВВВ-СССС-ЕЕЕЕ', 'ＡＡＡＡ-ＢＢＢＢ-ＣＣＣＣ-ＤＤＤＤ', 'AAAA-BBBB-CCCC-DDD\u0000']) {
        const r = await post('/auth/mfa/recuperacao', desafio.par, { codigoRecuperacao: codigo });
        assert.deepEqual([r.status, r.body], [401, CODIGO_INVALIDO], JSON.stringify(codigo));
      }
      assert.deepEqual(await fatores(admin), ['ATIVO']);
    });

    test('e-mail com maiúsculas e espaços é a mesma identidade: mesmo administrador, mesma chave de cooldown', async () => {
      const admin = await novoAdministrador('caixa-email');
      const variantes = [admin.email, admin.email.toUpperCase(), `  ${admin.email}  `, `\t${admin.email.toUpperCase()}\n`];

      for (const email of variantes) {
        const errada = await post('/auth/login', null, { email, senha: 'senha-errada-de-proposito-1' });
        assert.deepEqual([errada.status, errada.body.codigo], [401, 'CREDENCIAIS_INVALIDAS'], JSON.stringify(email));
      }
      const tentativas = (await q('SELECT chave_cooldown, administrador_id FROM login_tentativas_plataforma WHERE administrador_id = $1', [admin.id])).rows;
      assert.equal(tentativas.length, variantes.length);
      assert.deepEqual([...new Set(tentativas.map((t) => t.chave_cooldown))], [cooldown.gerarChaveCooldownPlataforma(admin.email)]);
    });
  });
});
