'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const totpReferencia = require('../helpers/totp-referencia');
const { criarAuthPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const { criarAuthPlataformaController } = require('../../src/controllers/auth-plataforma.controller');
const { criarExigirDesafioMfa } = require('../../src/middleware/desafio-mfa-plataforma');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const sessaoRepo = require('../../src/repositories/sessao-plataforma.repository');
const auditoriaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const tentativaRepo = require('../../src/repositories/login-tentativa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');
const desafioService = require('../../src/services/desafio-mfa-plataforma.service');
const mfaCripto = require('../../src/security/mfa-cripto');
const password = require('../../src/security/password');
const codigosMfa = require('../../src/security/codigos-mfa');
const cooldown = require('../../src/security/cooldown');
const tokenSeguranca = require('../../src/security/token');
const { gerarTokenSessao, hashTokenSessao } = tokenSeguranca;
const { authConfig } = require('../../src/config/auth');
const { HttpError } = require('../../src/errors/HttpError');

// Rota, middlewares, controller e serviço reais; só os repositórios e a decifragem são substituídos.

const ADMIN = 9;
const EMAIL = 'admin@safework.com.br';
const DESAFIO = '300';
const FATOR = '41';
const FATOR_UID = '3f2c8a4e-9b1d-4c7a-8e2f-5a6b7c8d9e0f';
const AGORA = new Date('2026-09-28T12:00:10.000Z');
const STEP = totpReferencia.stepDe(AGORA.getTime());
const SEGREDO = crypto.randomBytes(20);
const codigoDo = (step) => totpReferencia.codigoDoStep(SEGREDO, step);
const TOKEN_DESAFIO = gerarTokenSessao();
const COOKIE_DESAFIO = `${authConfig.desafioMfa.cookieNome}=${TOKEN_DESAFIO}`;
const COOKIE_SESSAO = authConfig.sessao.cookieNomeAdmin;

const codigoForaDaJanela = () => {
  const naJanela = new Set([-1, 0, 1].map((d) => codigoDo(STEP + d)));
  for (let n = 0; ; n += 1) {
    const codigo = String(n).padStart(6, '0');
    if (!naJanela.has(codigo)) return codigo;
  }
};

const desafio = (extra = {}) => ({
  id: DESAFIO, administradorId: ADMIN, tipo: 'VERIFICACAO', fatorPendenteId: null, falhas: 0, reinicios: 0,
  encerradoEm: null, expiraEm: new Date('2026-09-28T12:05:00.000Z'), ...extra,
});
const ativo = (extra = {}) => ({
  id: FATOR, fatorUid: FATOR_UID, administradorId: ADMIN, tipo: 'TOTP', estado: 'ATIVO', formatoVersao: 1, chaveVersao: 1,
  nonce: Buffer.alloc(12, 1), segredoCifrado: Buffer.alloc(36, 2), ultimoStepAceito: STEP - 5, ...extra,
});
const PENDENTE = '42';
const PENDENTE_UID = '7b1e2d3c-4a5b-4c6d-9e8f-0a1b2c3d4e5f';
const pendente = (extra = {}) => ({
  ...ativo(), id: PENDENTE, fatorUid: PENDENTE_UID, estado: 'PENDENTE', ultimoStepAceito: null, pendenteVigente: true, ...extra,
});
const ENVELOPE = Object.freeze({ formatoVersao: 1, chaveVersao: 1, nonce: Buffer.alloc(12, 3), segredoCifrado: Buffer.alloc(36, 4) });

function preparar(t, c = {}) {
  const ordem = [];
  const m = (alvo, nome, retorno) => t.mock.method(alvo, nome, async (...args) => {
    ordem.push(nome);
    return typeof retorno === 'function' ? retorno(...args) : retorno;
  });
  return {
    ordem,
    desafioDoCookie: m(desafioRepo, 'buscarValidoPorHash', c.desafioDoCookie === undefined ? desafio() : c.desafioDoCookie),
    travar: m(travaRepo, 'travarAdministrador', undefined),
    desafio: m(desafioRepo, 'buscarValidoPorId', c.desafio === undefined ? desafio() : c.desafio),
    cooldown: m(tentativaRepo, 'buscarCooldownVigente', c.cooldown ?? null),
    fator: m(fatorRepo, 'buscarTotpAtivo', c.fator === undefined ? ativo() : c.fator),
    garantir: t.mock.method(mfaCripto, 'garantirChaveAtual', () => {
      ordem.push('garantirChaveAtual');
      if (c.garantir) c.garantir();
    }),
    cifrar: t.mock.method(mfaCripto, 'cifrarSegredoTotp', (...args) => {
      ordem.push('cifrarSegredoTotp');
      return c.cifrar ? c.cifrar(...args) : ENVELOPE;
    }),
    lote: m(loteRepo, 'buscarAtivo', c.lote === undefined ? { id: '7', criadoEm: AGORA } : c.lote),
    utilizavel: m(codigoRepo, 'buscarUtilizavelPorHash', c.utilizavel === undefined ? { id: '90', loteId: '7' } : c.utilizavel),
    consumir: m(codigoRepo, 'consumir', c.consumido === undefined ? { id: '90', loteId: '7' } : c.consumido),
    revogarPendente: m(fatorRepo, 'revogarPendenteTotp', 0),
    criarPendente: m(fatorRepo, 'criarPendenteTotp', { id: PENDENTE, fatorUid: PENDENTE_UID, criadoEm: AGORA, pendenteExpiraEm: new Date('2026-09-28T12:15:00Z') }),
    buscarPendente: m(fatorRepo, 'buscarPorId', c.pendente === undefined ? pendente() : c.pendente),
    revogarFator: m(fatorRepo, 'revogar', true),
    ativar: m(fatorRepo, 'ativarTotp', c.ativou ?? true),
    trocar: m(desafioRepo, 'trocarFatorPendente', true),
    encerrarAbertos: m(desafioRepo, 'encerrarAbertos', 1),
    criarDesafio: m(desafioService, 'criarDesafioSobTrava', async (_, dados) => ({
      token: gerarTokenSessao(), desafio: { etapa: dados.tipo, expiraEm: new Date('2026-09-28T12:15:00Z'), validadeMinutos: dados.validadeMinutos },
    })),
    administrador: m(administradorRepo, 'buscarPorId', { id: ADMIN, email: 'admin@safework.com.br', ativo: true }),
    revogarLote: m(loteRepo, 'revogarAtivo', true),
    criarLote: m(loteRepo, 'criar', { id: '8', criadoEm: AGORA }),
    inserirHashes: m(codigoRepo, 'inserirHashes', (_, dados) => dados.hashes.length),
    credencial: m(administradorRepo, 'buscarCredencialPorEmail', c.credencial === undefined
      ? { id: ADMIN, email: EMAIL, senhaHash: '$argon2id$ficticio', ativo: true }
      : c.credencial),
    senha: m(password, 'verificarSenha', c.senhaOk ?? true),
    decifrar: t.mock.method(mfaCripto, 'decifrarSegredoTotp', (...args) => {
      ordem.push('decifrarSegredoTotp');
      return c.decifrar ? c.decifrar(...args) : Buffer.from(SEGREDO);
    }),
    step: m(fatorRepo, 'registrarStepAceito', c.stepAceito ?? true),
    tentativa: m(tentativaRepo, 'registrarTentativa', '1'),
    contarFalhas: m(tentativaRepo, 'contarFalhasRecentes', c.falhasRecentes ?? 0),
    ativarCooldown: m(tentativaRepo, 'registrarAtivacaoCooldown', '2'),
    incrementar: m(desafioRepo, 'incrementarFalhas', c.falhasDoDesafio ?? 1),
    encerrar: m(desafioRepo, 'encerrar', true),
    sessaoAnterior: m(sessaoRepo, 'buscarValidaPorHash', c.sessaoAnterior ?? null),
    revogar: m(sessaoRepo, 'revogar', true),
    revogarTodas: m(sessaoRepo, 'revogarTodasDoAdministrador', c.sessoesRevogadas ?? 0),
    criarSessao: m(sessaoRepo, 'criar', '777'),
    ligar: m(desafioRepo, 'ligarSessaoCriada', c.ligou ?? true),
    auditar: m(auditoriaRepo, 'registrar', { id: '1', criadoEm: AGORA }),
    auditarSistema: m(auditoriaRepo, 'registrarEventoSistema', { id: '2', criadoEm: AGORA }),
  };
}

function montar({ ordem = [], agora = AGORA, limiteMfa = 1000, sessao = null } = {}) {
  const transacao = [];
  const cliente = {
    query: async (texto) => {
      transacao.push(texto);
      if (/clock_timestamp/i.test(texto)) {
        ordem.push('clock_timestamp');
        return { rows: [{ agora }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => cliente,
    query: async () => { throw new Error('consulta fora da transação'); },
  };
  const router = criarAuthPlataformaRoutes({
    controller: criarAuthPlataformaController({ pool }),
    limitador: criarLimitador({ limite: 1000, janelaSegundos: 60 }),
    limitadorMfa: criarLimitador({ limite: limiteMfa, janelaSegundos: 60 }),
    exigirSessaoPlataforma: (req, res, next) => {
      if (sessao === null) {
        next(HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada'));
        return;
      }
      req.sessaoPlataforma = { id: sessao.id };
      req.administradorPlataforma = { id: ADMIN, email: EMAIL };
      next();
    },
    desafioMfa: (tipos) => criarExigirDesafioMfa({ pool, tipos }),
  });
  return { app: criarAppTeste((app) => app.use(router)), transacao };
}

const verificar = (app, corpo = { codigo: codigoDo(STEP) }, cookie = COOKIE_DESAFIO) => {
  const r = request(app).post('/auth/mfa/verificar').send(corpo);
  return cookie ? r.set('Cookie', cookie) : r;
};
const contar = (lista, texto) => lista.filter((c) => c === texto).length;

function setCookie(resposta, nome) {
  const bruto = (resposta.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${nome}=`));
  if (bruto === undefined) return null;
  const [par, ...resto] = bruto.split(';').map((p) => p.trim());
  const atributos = Object.fromEntries(resto.map((p) => {
    const i = p.indexOf('=');
    return i === -1 ? [p.toLowerCase(), true] : [p.slice(0, i).toLowerCase(), p.slice(i + 1)];
  }));
  return { valor: par.slice(nome.length + 1), atributos };
}

const semSessaoNemPasso = (x) => {
  for (const [nome, mock] of Object.entries({ step: x.step, criarSessao: x.criarSessao, ligar: x.ligar })) {
    assert.equal(mock.mock.calls.length, 0, nome);
  }
};

describe('POST /auth/mfa/verificar: cadeia HTTP', () => {
  test('sem desafio: 401 DESAFIO_INVALIDO antes de ler o corpo; o serviço não roda', async (t) => {
    const x = preparar(t);
    const { app } = montar({ ordem: x.ordem });

    const r = await verificar(app, {}, null);

    assert.deepEqual([r.status, r.body.codigo], [401, 'DESAFIO_INVALIDO']);
    assert.equal(x.travar.mock.calls.length, 0);
  });

  test('só desafio VERIFICACAO: LIBERACAO, CADASTRO, RECUPERACAO e SUBSTITUICAO são 401 DESAFIO_INVALIDO', async (t) => {
    for (const tipo of ['LIBERACAO', 'CADASTRO', 'RECUPERACAO', 'SUBSTITUICAO']) {
      const x = preparar(t, { desafioDoCookie: desafio({ tipo }) });
      const { app } = montar({ ordem: x.ordem });

      const r = await verificar(app);

      assert.deepEqual([r.status, r.body.codigo], [401, 'DESAFIO_INVALIDO'], tipo);
      assert.equal(x.travar.mock.calls.length, 0, tipo);
      t.mock.restoreAll();
    }
  });

  test('corpo estrito: exatamente 6 dígitos em texto, sem espaço, sem coerção e sem campo extra; 400 sem chamar o serviço', async (t) => {
    const x = preparar(t);
    const { app } = montar({ ordem: x.ordem });

    for (const corpo of [{}, { codigo: '12345' }, { codigo: '1234567' }, { codigo: ' 123456' }, { codigo: '12345 ' }, { codigo: 123456 }, { codigo: '12a456' }, { codigo: '123456', extra: 1 }]) {
      const r = await verificar(app, corpo);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
    }
    assert.equal(x.travar.mock.calls.length, 0);
  });

  test('o limitador de MFA vem antes do desafio', async (t) => {
    preparar(t);
    const { app } = montar({ limiteMfa: 1 });

    assert.equal((await verificar(app, {}, null)).status, 401);
    assert.equal((await verificar(app, {}, null)).status, 429);
  });
});

describe('POST /auth/mfa/verificar: TOTP, anti-replay e sessão plena', () => {
  test('sucesso: sequência transacional, um único instante do banco, step gravado pelo UPDATE condicional, sessão nova com MFA TOTP', async (t) => {
    const x = preparar(t);
    const { app, transacao } = montar({ ordem: x.ordem });

    const r = await verificar(app);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { status: 'ok' });
    const essenciais = ['travarAdministrador', 'buscarValidoPorId', 'buscarCooldownVigente', 'buscarTotpAtivo', 'clock_timestamp',
      'decifrarSegredoTotp', 'registrarStepAceito', 'encerrar', 'registrarTentativa', 'criar', 'ligarSessaoCriada', 'registrar'];
    assert.deepEqual(x.ordem.filter((n) => essenciais.includes(n)), essenciais);
    assert.deepEqual(x.desafio.mock.calls[0].arguments.slice(1), [{ desafioId: DESAFIO, administradorId: ADMIN }, { travar: true }]);
    assert.deepEqual(x.fator.mock.calls[0].arguments.slice(1), [ADMIN, { travar: true }]);
    assert.deepEqual(x.step.mock.calls[0].arguments[1], { administradorId: ADMIN, fatorId: FATOR, step: STEP });
    assert.equal(contar(transacao, 'SELECT clock_timestamp() AS agora'), 1);
    assert.equal(x.garantir.mock.calls.length, 0, 'decifrar usa a versão de chave do fator, não exige a chave atual');

    assert.equal(x.tentativa.mock.calls[0].arguments[1].sucesso, true);
    assert.equal(x.tentativa.mock.calls[0].arguments[1].chaveCooldown, cooldown.gerarChaveCooldownMfaPlataforma(ADMIN));
    assert.deepEqual(x.encerrar.mock.calls[0].arguments[1], { desafioId: DESAFIO, motivo: 'CONCLUIDO' });

    const sessao = setCookie(r, COOKIE_SESSAO);
    assert.notEqual(sessao.valor, TOKEN_DESAFIO);
    const criada = x.criarSessao.mock.calls[0].arguments[1];
    assert.equal(criada.tokenHash, hashTokenSessao(sessao.valor));
    assert.deepEqual(criada.mfa, { verificadoEm: AGORA, metodo: 'TOTP' });
    assert.deepEqual(criada.expiraEm, new Date(AGORA.getTime() + authConfig.sessao.expiracaoMinutosAdmin * 60_000));
    assert.deepEqual(x.ligar.mock.calls[0].arguments[1], { desafioId: DESAFIO, sessaoId: '777' });
    assert.deepEqual([setCookie(r, authConfig.desafioMfa.cookieNome).valor, setCookie(r, authConfig.desafioMfa.cookieNome).atributos['max-age']], ['', '0']);

    const auditoria = x.auditar.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(auditoria.map((a) => [a.acao, a.administradorId]), [['MFA_LOGIN_CONCLUIDO', ADMIN]]);
    const texto = JSON.stringify(auditoria);
    for (const proibido of [codigoDo(STEP), sessao.valor, TOKEN_DESAFIO, SEGREDO.toString('hex')]) assert.equal(texto.includes(proibido), false);
    assert.equal(x.revogarTodas.mock.calls.length, 0);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [1, 0]);
  });

  test('sessão que não fica ligada ao desafio concluído não é entregue: erro, ROLLBACK, nenhum cookie de sessão', async (t) => {
    t.mock.method(console, 'error', () => {});
    const x = preparar(t, { ligou: false });
    const { app, transacao } = montar({ ordem: x.ordem });

    const r = await verificar(app);

    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(setCookie(r, COOKIE_SESSAO), null);
    assert.equal(JSON.stringify(r.body).includes('ligar'), false, 'a resposta não descreve o motivo interno');
    assert.equal(x.ligar.mock.calls.length, 1);
    assert.equal(x.auditar.mock.calls.length, 0, 'nenhum login é auditado como concluído');
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [0, 1]);
  });

  test('código errado: 401 MFA_CODIGO_INVALIDO, falha contada (TOTP_INVALIDO) e COMMITada; sem step e sem sessão', async (t) => {
    const x = preparar(t);
    const { app, transacao } = montar({ ordem: x.ordem });

    const r = await verificar(app, { codigo: codigoForaDaJanela() });

    assert.deepEqual([r.status, r.body], [401, { status: 'error', codigo: 'MFA_CODIGO_INVALIDO', message: 'Código inválido' }]);
    assert.equal(x.tentativa.mock.calls[0].arguments[1].motivo, 'TOTP_INVALIDO');
    assert.equal(x.incrementar.mock.calls.length, 1);
    semSessaoNemPasso(x);
    assert.equal(r.headers['set-cookie'], undefined);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [1, 0]);
  });

  test('replay: o UPDATE condicional não afeta linha; mesma resposta pública do código errado, motivo interno TOTP_REPETIDO, sem sessão', async (t) => {
    const x = preparar(t, { stepAceito: false });
    const { app } = montar({ ordem: x.ordem });

    const r = await verificar(app);

    assert.deepEqual([r.status, r.body], [401, { status: 'error', codigo: 'MFA_CODIGO_INVALIDO', message: 'Código inválido' }]);
    assert.equal(x.step.mock.calls.length, 1);
    assert.equal(x.tentativa.mock.calls[0].arguments[1].motivo, 'TOTP_REPETIDO');
    assert.equal(x.incrementar.mock.calls.length, 1);
    assert.equal(x.encerrar.mock.calls.length, 0);
    assert.equal(x.criarSessao.mock.calls.length, 0);
  });

  test('janela ±1 pelo relógio do banco: steps anterior, atual e seguinte chegam ao UPDATE; ±2 não', async (t) => {
    for (const delta of [-1, 0, 1]) {
      const x = preparar(t);
      const { app } = montar({ ordem: x.ordem });
      assert.equal((await verificar(app, { codigo: codigoDo(STEP + delta) })).status, 200, String(delta));
      assert.equal(x.step.mock.calls[0].arguments[1].step, STEP + delta);
      t.mock.restoreAll();
    }
    for (const delta of [-2, 2]) {
      const codigo = codigoDo(STEP + delta);
      if ([-1, 0, 1].some((d) => codigoDo(STEP + d) === codigo)) continue;
      const x = preparar(t);
      const { app } = montar({ ordem: x.ordem });
      assert.equal((await verificar(app, { codigo })).status, 401, String(delta));
      assert.equal(x.step.mock.calls.length, 0);
      t.mock.restoreAll();
    }
  });

  test('o relógio avança: o step levado ao UPDATE acompanha o instante do banco', async (t) => {
    let x = preparar(t);
    assert.equal((await verificar(montar({ ordem: x.ordem }).app, { codigo: codigoDo(STEP) })).status, 200);
    assert.equal(x.step.mock.calls[0].arguments[1].step, STEP);
    t.mock.restoreAll();

    x = preparar(t);
    const depois = new Date(AGORA.getTime() + 30_000);
    assert.equal((await verificar(montar({ ordem: x.ordem, agora: depois }).app, { codigo: codigoDo(STEP + 1) })).status, 200);
    assert.equal(x.step.mock.calls[0].arguments[1].step, STEP + 1);
  });

  test('quinta falha: desafio encerrado como FALHAS_EXCEDIDAS e MFA_DESAFIO_ESGOTADO auditado', async (t) => {
    const x = preparar(t, { falhasDoDesafio: authConfig.desafioMfa.maxFalhas });
    const { app } = montar({ ordem: x.ordem });

    assert.equal((await verificar(app, { codigo: codigoForaDaJanela() })).status, 401);

    assert.deepEqual(x.encerrar.mock.calls[0].arguments[1], { desafioId: DESAFIO, motivo: 'FALHAS_EXCEDIDAS' });
    assert.ok(x.auditar.mock.calls.some((c) => c.arguments[1].acao === 'MFA_DESAFIO_ESGOTADO'));
  });

  test('desafio que já chegou ao limite de falhas não é mais aceito', async (t) => {
    const x = preparar(t, { desafio: desafio({ falhas: authConfig.desafioMfa.maxFalhas }) });
    const { app } = montar({ ordem: x.ordem });

    const r = await verificar(app);

    assert.deepEqual([r.status, r.body.codigo], [401, 'DESAFIO_INVALIDO']);
    assert.equal(x.decifrar.mock.calls.length, 0);
    semSessaoNemPasso(x);
  });

  test('falhas recentes no limiar ativam o cooldown persistente de MFA do administrador', async (t) => {
    const x = preparar(t, { falhasRecentes: authConfig.cooldown.niveis[0].falhas });
    const { app } = montar({ ordem: x.ordem });

    assert.equal((await verificar(app, { codigo: codigoForaDaJanela() })).status, 401);

    assert.equal(x.ativarCooldown.mock.calls[0].arguments[1].chaveCooldown, cooldown.gerarChaveCooldownMfaPlataforma(ADMIN));
    assert.ok(x.auditar.mock.calls.some((c) => c.arguments[1].acao === 'MFA_COOLDOWN_ATIVADO'));
  });

  test('cooldown vigente: 429 com Retry-After mesmo com código válido; nada conferido, step intacto, desafio aberto', async (t) => {
    const x = preparar(t, { cooldown: { ativoAte: new Date(Date.now() + 60_000) } });
    const { app } = montar({ ordem: x.ordem });

    const r = await verificar(app);

    assert.deepEqual([r.status, r.body.codigo], [429, 'MFA_EM_COOLDOWN']);
    assert.ok(Number(r.headers['retry-after']) > 0);
    for (const [nome, mock] of Object.entries({ fator: x.fator, decifrar: x.decifrar, tentativa: x.tentativa, incrementar: x.incrementar, encerrar: x.encerrar })) {
      assert.equal(mock.mock.calls.length, 0, nome);
    }
    semSessaoNemPasso(x);
  });

  test('falha criptográfica: 503 MFA_INDISPONIVEL, ROLLBACK, nada contado, step intacto, sem sessão; evento SISTEMA sem segredo', async (t) => {
    for (const motivo of ['CHAVE_INDISPONIVEL', 'ENVELOPE_INVALIDO', 'AUTENTICACAO_FALHOU']) {
      const logs = [];
      t.mock.method(console, 'error', (...args) => logs.push(args));
      const x = preparar(t, { decifrar: () => { throw new mfaCripto.ErroCriptografiaMfa(motivo); } });
      const { app, transacao } = montar({ ordem: x.ordem });

      const r = await verificar(app);

      assert.deepEqual([r.status, r.body.codigo], [503, 'MFA_INDISPONIVEL'], motivo);
      assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [0, 1]);
      for (const [nome, mock] of Object.entries({ tentativa: x.tentativa, incrementar: x.incrementar, encerrar: x.encerrar, auditar: x.auditar })) {
        assert.equal(mock.mock.calls.length, 0, `${motivo}: ${nome}`);
      }
      semSessaoNemPasso(x);
      assert.deepEqual(x.auditarSistema.mock.calls[0].arguments[1], {
        administradorAfetadoId: ADMIN, acao: 'MFA_CHAVE_INDISPONIVEL', contexto: { operacao: 'verificacao', motivo },
      });
      assert.equal(JSON.stringify(logs).includes(codigoDo(STEP)), false);
      t.mock.restoreAll();
    }
  });

  test('session fixation: só a sessão que este navegador apresentou é revogada; outras do administrador seguem; token novo', async (t) => {
    const tokenAntigo = gerarTokenSessao();
    const x = preparar(t, { sessaoAnterior: { sessao: { id: '500' }, administrador: { id: ADMIN } } });
    const { app } = montar({ ordem: x.ordem });

    const r = await verificar(app, undefined, `${COOKIE_SESSAO}=${tokenAntigo}; ${COOKIE_DESAFIO}`);

    assert.equal(r.status, 200);
    assert.equal(x.sessaoAnterior.mock.calls[0].arguments[1], hashTokenSessao(tokenAntigo));
    assert.deepEqual(x.revogar.mock.calls.map((c) => c.arguments.slice(1)), [['500', 'SUBSTITUIDA_NO_NAVEGADOR']]);
    assert.equal(x.revogarTodas.mock.calls.length, 0);
    const nova = setCookie(r, COOKIE_SESSAO).valor;
    assert.notEqual(nova, tokenAntigo);
    assert.notEqual(nova, TOKEN_DESAFIO);
  });

  test('sem fator ATIVO: fail closed com 401 DESAFIO_INVALIDO e desafio encerrado; nada decifrado, nenhuma falha, nenhum cadastro', async (t) => {
    const x = preparar(t, { fator: null });
    const { app } = montar({ ordem: x.ordem });

    const r = await verificar(app);

    assert.deepEqual([r.status, r.body.codigo], [401, 'DESAFIO_INVALIDO']);
    assert.deepEqual(x.encerrar.mock.calls[0].arguments[1], { desafioId: DESAFIO, motivo: 'SEM_FATOR_ATIVO' });
    for (const [nome, mock] of Object.entries({ decifrar: x.decifrar, tentativa: x.tentativa, incrementar: x.incrementar })) {
      assert.equal(mock.mock.calls.length, 0, nome);
    }
    semSessaoNemPasso(x);
  });

  test('desafio que deixou de valer dentro da transação (encerrado, vencido, administrador inativo ou de outro tipo): 401 DESAFIO_INVALIDO', async (t) => {
    for (const noServico of [null, desafio({ tipo: 'CADASTRO' })]) {
      const x = preparar(t, { desafio: noServico });
      const { app } = montar({ ordem: x.ordem });

      const r = await verificar(app);

      assert.deepEqual([r.status, r.body.codigo], [401, 'DESAFIO_INVALIDO']);
      assert.equal(x.fator.mock.calls.length, 0);
      semSessaoNemPasso(x);
      t.mock.restoreAll();
    }
  });
});

const CORPO_INVALIDO = { status: 'error', codigo: 'MFA_CODIGO_INVALIDO', message: 'Código inválido' };
const HASH_RECUPERACAO = codigosMfa.hashCodigoRecuperacao({ administradorId: ADMIN, codigo: 'ABCDEFGHJKMNPQRS' });
const emRecuperacao = (extra = {}) => desafio({ tipo: 'RECUPERACAO', fatorPendenteId: PENDENTE, ...extra });
const recuperar = (app, corpo = { codigoRecuperacao: 'abcd efgh jkmn pqrs' }, cookie = COOKIE_DESAFIO) => {
  const r = request(app).post('/auth/mfa/recuperacao').send(corpo);
  return cookie ? r.set('Cookie', cookie) : r;
};
const postar = (app, caminho, corpo) => request(app).post(caminho).send(corpo).set('Cookie', COOKIE_DESAFIO);
const nada = (x, nomes) => {
  for (const nome of nomes) assert.equal(x[nome].mock.calls.length, 0, nome);
};

describe('POST /auth/mfa/recuperacao: VERIFICACAO -> RECUPERACAO', () => {
  test('montada: sem desafio 401; só VERIFICACAO; corpo estrito', async (t) => {
    let x = preparar(t);
    let { app } = montar({ ordem: x.ordem });
    assert.equal((await recuperar(app, {}, null)).body.codigo, 'DESAFIO_INVALIDO');
    assert.equal((await recuperar(app, {})).status, 400);
    assert.equal((await recuperar(app, { codigoRecuperacao: 'ABCD-EFGH-JKMN-PQRS', extra: 1 })).status, 400);
    nada(x, ['travar']);
    t.mock.restoreAll();

    for (const tipo of ['LIBERACAO', 'CADASTRO', 'RECUPERACAO', 'SUBSTITUICAO']) {
      x = preparar(t, { desafioDoCookie: desafio({ tipo }) });
      ({ app } = montar({ ordem: x.ordem }));
      assert.equal((await recuperar(app)).body.codigo, 'DESAFIO_INVALIDO', tipo);
      nada(x, ['travar']);
      t.mock.restoreAll();
    }
  });

  test('código válido: localizado sob as travas e só consumido depois do PENDENTE novo; desafio RECUPERACAO; nenhuma sessão; fator antigo não é decifrado', async (t) => {
    const x = preparar(t);
    const { app, transacao } = montar({ ordem: x.ordem });

    const r = await recuperar(app);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['cadastro', 'etapa', 'expiraEm', 'status']);
    assert.equal(r.body.etapa, 'RECUPERACAO');
    assert.deepEqual(Object.keys(r.body.cadastro).sort(), ['chaveManual', 'uri']);
    assert.match(r.body.cadastro.uri, /^otpauth:\/\/totp\//);
    const novoDesafio = setCookie(r, authConfig.desafioMfa.cookieNome);
    assert.notEqual(novoDesafio.valor, TOKEN_DESAFIO);
    assert.equal(setCookie(r, COOKIE_SESSAO), null);

    const sequencia = ['garantirChaveAtual', 'travarAdministrador', 'buscarValidoPorId', 'buscarCooldownVigente', 'buscarTotpAtivo', 'buscarAtivo',
      'buscarUtilizavelPorHash', 'cifrarSegredoTotp', 'revogarPendenteTotp', 'criarPendenteTotp', 'consumir', 'encerrar', 'encerrarAbertos',
      'criarDesafioSobTrava', 'registrarTentativa', 'registrar'];
    assert.deepEqual(x.ordem.filter((n) => sequencia.includes(n)), sequencia);
    assert.deepEqual(x.lote.mock.calls[0].arguments.slice(1), [ADMIN, { travar: true }]);
    assert.deepEqual(x.utilizavel.mock.calls[0].arguments.slice(1), [{ administradorId: ADMIN, codigoHash: HASH_RECUPERACAO }, { travar: true }]);
    assert.deepEqual(x.consumir.mock.calls[0].arguments[1], { administradorId: ADMIN, codigoHash: HASH_RECUPERACAO });
    assert.deepEqual(x.encerrar.mock.calls[0].arguments[1], { desafioId: DESAFIO, motivo: 'TRANSICAO' });
    assert.equal(x.encerrarAbertos.mock.calls[0].arguments[1].motivo, 'RECUPERACAO_INICIADA');
    assert.deepEqual(x.criarDesafio.mock.calls[0].arguments[1], {
      administradorId: ADMIN, tipo: 'RECUPERACAO', validadeMinutos: authConfig.desafioMfa.cadastroMinutos, fatorPendenteId: PENDENTE, desafioAnteriorId: DESAFIO,
    });
    assert.equal(x.tentativa.mock.calls[0].arguments[1].sucesso, true);
    nada(x, ['decifrar', 'ativar', 'revogarFator', 'criarSessao', 'ligar', 'revogarTodas']);

    const auditorias = x.auditar.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(auditorias.map((a) => [a.acao, a.administradorId]), [['MFA_RECUPERACAO_INICIADA', ADMIN]]);
    const texto = JSON.stringify(auditorias);
    for (const proibido of ['ABCDEFGHJKMNPQRS', 'abcd efgh', HASH_RECUPERACAO, novoDesafio.valor, 'otpauth']) assert.equal(texto.includes(proibido), false);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [1, 0]);
  });

  test('código inexistente, já usado ou fora do formato: 401 genérico, falha contada (RECUPERACAO_INVALIDA), nada criado nem consumido', async (t) => {
    for (const [cenario, corpo] of [[{ utilizavel: null }, undefined], [{}, { codigoRecuperacao: 'nao-e-um-codigo' }], [{ lote: null }, undefined]]) {
      const x = preparar(t, cenario);
      const { app, transacao } = montar({ ordem: x.ordem });

      const r = await recuperar(app, corpo);

      assert.deepEqual([r.status, r.body], [401, CORPO_INVALIDO], JSON.stringify(cenario));
      assert.equal(x.tentativa.mock.calls[0].arguments[1].motivo, 'RECUPERACAO_INVALIDA');
      assert.equal(x.incrementar.mock.calls.length, 1);
      nada(x, ['cifrar', 'criarPendente', 'consumir', 'criarDesafio', 'criarSessao']);
      assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [1, 0]);
      t.mock.restoreAll();
    }
  });

  test('sem fator ATIVO: fail closed com o desafio encerrado; o código nem é conferido', async (t) => {
    const x = preparar(t, { fator: null });
    const { app } = montar({ ordem: x.ordem });

    assert.equal((await recuperar(app)).body.codigo, 'DESAFIO_INVALIDO');
    assert.deepEqual(x.encerrar.mock.calls[0].arguments[1], { desafioId: DESAFIO, motivo: 'SEM_FATOR_ATIVO' });
    nada(x, ['utilizavel', 'incrementar', 'consumir', 'criarPendente']);
  });

  test('quinta falha encerra o desafio; cooldown vigente barra sem conferir nem consumir', async (t) => {
    let x = preparar(t, { utilizavel: null, falhasDoDesafio: authConfig.desafioMfa.maxFalhas });
    assert.equal((await recuperar(montar({ ordem: x.ordem }).app)).status, 401);
    assert.deepEqual(x.encerrar.mock.calls[0].arguments[1], { desafioId: DESAFIO, motivo: 'FALHAS_EXCEDIDAS' });
    t.mock.restoreAll();

    x = preparar(t, { cooldown: { ativoAte: new Date(Date.now() + 60_000) } });
    const r = await recuperar(montar({ ordem: x.ordem }).app);
    assert.deepEqual([r.status, r.body.codigo], [429, 'MFA_EM_COOLDOWN']);
    nada(x, ['utilizavel', 'consumir', 'tentativa', 'incrementar']);
  });

  test('chave atual indisponível: 503 antes da transação; nada lido, consumido ou contado; evento SISTEMA', async (t) => {
    t.mock.method(console, 'error', () => {});
    const x = preparar(t, { garantir: () => { throw new mfaCripto.ErroCriptografiaMfa('CHAVE_INDISPONIVEL'); } });
    const { app, transacao } = montar({ ordem: x.ordem });

    const r = await recuperar(app);

    assert.deepEqual([r.status, r.body.codigo], [503, 'MFA_INDISPONIVEL']);
    assert.equal(transacao.length, 0);
    nada(x, ['travar', 'utilizavel', 'consumir', 'tentativa', 'incrementar']);
    assert.deepEqual(x.auditarSistema.mock.calls[0].arguments[1].contexto, { operacao: 'recuperacao', motivo: 'CHAVE_INDISPONIVEL' });
  });

  test('cifragem falha dentro da transação: 503, ROLLBACK; código não consumido, nenhum PENDENTE, nenhuma falha', async (t) => {
    t.mock.method(console, 'error', () => {});
    const x = preparar(t, { cifrar: () => { throw new mfaCripto.ErroCriptografiaMfa('CHAVE_INDISPONIVEL'); } });
    const { app, transacao } = montar({ ordem: x.ordem });

    assert.equal((await recuperar(app)).status, 503);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [0, 1]);
    nada(x, ['consumir', 'criarPendente', 'tentativa', 'incrementar', 'criarDesafio']);
    assert.equal(x.auditarSistema.mock.calls.length, 1);
  });

  test('consumo condicional sem linha: ROLLBACK e resposta genérica; nada fica', async (t) => {
    const x = preparar(t, { consumido: null });
    const { app, transacao } = montar({ ordem: x.ordem });

    assert.deepEqual((await recuperar(app)).body, CORPO_INVALIDO);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [0, 1]);
    nada(x, ['criarDesafio', 'incrementar']);
  });
});

describe('RECUPERACAO: reiniciar e confirmar o novo TOTP', () => {
  const noDesafio = (extra = {}) => ({ desafioDoCookie: emRecuperacao(), desafio: emRecuperacao(), ...extra });

  test('reiniciar aceita RECUPERACAO: troca só o PENDENTE; fator ATIVO antigo intacto; nenhum código consumido; nenhuma sessão', async (t) => {
    const x = preparar(t, noDesafio());
    const { app } = montar({ ordem: x.ordem });

    const r = await postar(app, '/auth/mfa/cadastro/reiniciar', {});

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.etapa, 'RECUPERACAO');
    assert.deepEqual(x.revogarFator.mock.calls.map((c) => c.arguments[1]), [{ administradorId: ADMIN, fatorId: PENDENTE, motivo: 'REINICIADO' }]);
    nada(x, ['consumir', 'utilizavel', 'criarSessao', 'ativar', 'revogarTodas']);
  });

  test('confirmar em RECUPERACAO: antigo revogado antes de ativar o novo, lote trocado, todas as sessões revogadas antes da nova, RECADASTRO', async (t) => {
    const x = preparar(t, noDesafio({ sessoesRevogadas: 2 }));
    const { app, transacao } = montar({ ordem: x.ordem });

    const r = await postar(app, '/auth/mfa/cadastro/confirmar', { codigo: codigoDo(STEP) });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['codigosRecuperacao', 'status']);
    assert.equal(r.body.codigosRecuperacao.length, 10);
    const sessao = setCookie(r, COOKIE_SESSAO);
    assert.notEqual(sessao.valor, TOKEN_DESAFIO);
    assert.deepEqual([setCookie(r, authConfig.desafioMfa.cookieNome).valor, setCookie(r, authConfig.desafioMfa.cookieNome).atributos['max-age']], ['', '0']);

    const marcos = ['decifrarSegredoTotp', 'revogar', 'ativarTotp', 'revogarAtivo', 'inserirHashes', 'revogarTodasDoAdministrador', 'encerrarAbertos', 'encerrar', 'ligarSessaoCriada'];
    assert.deepEqual(x.ordem.filter((n) => marcos.includes(n)), marcos);
    assert.ok(x.ordem.lastIndexOf('criar') > x.ordem.indexOf('revogarTodasDoAdministrador'), 'a sessão nova nasce depois das revogações');
    assert.equal(x.decifrar.mock.calls.length, 1);
    assert.equal(x.decifrar.mock.calls[0].arguments[0].fatorUid, PENDENTE_UID, 'só o PENDENTE é decifrado');
    assert.deepEqual(x.revogarFator.mock.calls[0].arguments[1], { administradorId: ADMIN, fatorId: FATOR, motivo: 'RECUPERACAO' });
    assert.deepEqual(x.ativar.mock.calls[0].arguments[1], { administradorId: ADMIN, fatorId: PENDENTE, step: STEP });
    assert.deepEqual(x.revogarLote.mock.calls[0].arguments[1], { administradorId: ADMIN, motivo: 'RECUPERACAO' });
    assert.deepEqual(x.inserirHashes.mock.calls[0].arguments[1].hashes,
      r.body.codigosRecuperacao.map((c) => codigosMfa.hashCodigoRecuperacao({ administradorId: ADMIN, codigo: codigosMfa.normalizarCodigo(c) })));
    assert.deepEqual(x.revogarTodas.mock.calls[0].arguments.slice(1, 3), [ADMIN, 'MFA_RECUPERADO']);
    assert.deepEqual(x.encerrarAbertos.mock.calls[0].arguments[1], { administradorId: ADMIN, motivo: 'MFA_RECUPERADO', exceto: DESAFIO });
    assert.deepEqual(x.encerrar.mock.calls.map((c) => c.arguments[1]), [{ desafioId: DESAFIO, motivo: 'CONCLUIDO' }]);
    const criada = x.criarSessao.mock.calls[0].arguments[1];
    assert.equal(criada.tokenHash, hashTokenSessao(sessao.valor));
    assert.deepEqual(criada.mfa, { verificadoEm: AGORA, metodo: 'RECADASTRO' });

    const auditorias = x.auditar.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(auditorias.map((a) => [a.acao, a.administradorId]), [['MFA_RECUPERACAO_CONCLUIDA', ADMIN], ['SESSOES_ADMINISTRADOR_REVOGADAS', ADMIN]]);
    assert.deepEqual(auditorias[1].contexto, { motivo: 'MFA_RECUPERADO', quantidade: 2 });
    const texto = JSON.stringify(auditorias);
    for (const proibido of [...r.body.codigosRecuperacao, sessao.valor, codigoDo(STEP)]) assert.equal(texto.includes(proibido), false);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [1, 0]);
  });

  test('recadastro cuja sessão não fica ligada ao desafio: erro, ROLLBACK de tudo, nenhum cookie de sessão nem código de recuperação', async (t) => {
    t.mock.method(console, 'error', () => {});
    const x = preparar(t, noDesafio({ ligou: false }));
    const { app, transacao } = montar({ ordem: x.ordem });

    const r = await postar(app, '/auth/mfa/cadastro/confirmar', { codigo: codigoDo(STEP) });

    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(setCookie(r, COOKIE_SESSAO), null);
    assert.equal(r.body.codigosRecuperacao, undefined);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [0, 1]);
  });

  test('TOTP novo errado: 401; fator antigo, lote e sessões intactos', async (t) => {
    const x = preparar(t, noDesafio());
    const { app } = montar({ ordem: x.ordem });

    assert.deepEqual((await postar(app, '/auth/mfa/cadastro/confirmar', { codigo: codigoForaDaJanela() })).body, CORPO_INVALIDO);
    assert.equal(x.tentativa.mock.calls[0].arguments[1].motivo, 'TOTP_INVALIDO');
    nada(x, ['revogarFator', 'ativar', 'revogarLote', 'criarLote', 'revogarTodas', 'criarSessao']);
  });

  test('ativação que falha depois de revogar o antigo: ROLLBACK, o antigo continua ATIVO', async (t) => {
    const x = preparar(t, noDesafio({ ativou: false }));
    const { app, transacao } = montar({ ordem: x.ordem });

    const r = await postar(app, '/auth/mfa/cadastro/confirmar', { codigo: codigoDo(STEP) });

    assert.deepEqual([r.status, r.body.codigo], [409, 'MFA_CADASTRO_EXPIRADO']);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [0, 1]);
    nada(x, ['criarSessao', 'revogarTodas']);
  });

  test('decifrar o PENDENTE falha: 503, ROLLBACK, nada revogado', async (t) => {
    t.mock.method(console, 'error', () => {});
    const x = preparar(t, noDesafio({ decifrar: () => { throw new mfaCripto.ErroCriptografiaMfa('AUTENTICACAO_FALHOU'); } }));
    const { app, transacao } = montar({ ordem: x.ordem });

    assert.equal((await postar(app, '/auth/mfa/cadastro/confirmar', { codigo: codigoDo(STEP) })).status, 503);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [0, 1]);
    nada(x, ['revogarFator', 'ativar', 'revogarTodas', 'criarSessao', 'incrementar']);
  });

  test('PENDENTE vencido: 409, nada revogado nem decifrado', async (t) => {
    const x = preparar(t, noDesafio({ pendente: pendente({ pendenteVigente: false }) }));
    const { app } = montar({ ordem: x.ordem });

    assert.deepEqual((await postar(app, '/auth/mfa/cadastro/confirmar', { codigo: codigoDo(STEP) })).body.codigo, 'MFA_CADASTRO_EXPIRADO');
    nada(x, ['decifrar', 'revogarFator', 'ativar', 'revogarTodas']);
  });

  test('sem fator ATIVO antigo no momento da confirmação: conclui sem revogar fator', async (t) => {
    const x = preparar(t, noDesafio({ fator: null }));
    const { app } = montar({ ordem: x.ordem });

    assert.equal((await postar(app, '/auth/mfa/cadastro/confirmar', { codigo: codigoDo(STEP) })).status, 200);
    nada(x, ['revogarFator']);
    assert.equal(x.ativar.mock.calls.length, 1);
  });
});

const SESSAO_ID = '500';
const TOKEN_SESSAO = gerarTokenSessao();
const COOKIE_COM_SESSAO = `${COOKIE_SESSAO}=${TOKEN_SESSAO}`;
const SESSAO_ATUAL = { sessao: { id: SESSAO_ID }, administrador: { id: ADMIN, email: EMAIL } };
const SENHA = 'senha-atual-do-administrador';
const REAUTENTICACAO_INVALIDA = { status: 'error', codigo: 'REAUTENTICACAO_INVALIDA', message: 'Senha ou código inválidos' };
const reautenticacao = (extra = {}) => ({ senha: SENHA, codigo: codigoDo(STEP), ...extra });
const comSessao = (app, caminho, corpo, cookie = COOKIE_COM_SESSAO) => request(app).post(caminho).send(corpo).set('Cookie', cookie);
const emSubstituicao = (extra = {}) => desafio({ tipo: 'SUBSTITUICAO', fatorPendenteId: PENDENTE, sessaoOrigemId: SESSAO_ID, ...extra });
const fatorPorId = (_, dados) => (dados.fatorId === PENDENTE ? pendente() : ativo());
const logado = (extra = {}) => ({ sessaoAnterior: SESSAO_ATUAL, ...extra });
const encerraSemSessaoNova = (x, r, gerados) => {
  nada(x, ['criarSessao', 'ligar']);
  assert.equal(gerados.mock.calls.length, 0, 'nenhum token de sessão gerado');
  const nomes = (r.headers['set-cookie'] ?? []).map((c) => c.slice(0, c.indexOf('=')));
  assert.deepEqual(nomes.sort(), [COOKIE_SESSAO, authConfig.desafioMfa.cookieNome].sort(), 'só remoções, nenhum cookie de sessão nova');
  for (const nome of nomes) {
    const c = setCookie(r, nome);
    assert.deepEqual([c.valor, c.atributos['max-age']], ['', '0'], `${nome} removido`);
  }
};

describe('POST /auth/mfa/substituicao/iniciar', () => {
  test('exige sessão plena e corpo estrito', async (t) => {
    let x = preparar(t);
    assert.equal((await comSessao(montar({ ordem: x.ordem }).app, '/auth/mfa/substituicao/iniciar', reautenticacao())).body.codigo, 'SESSAO_INVALIDA');
    nada(x, ['travar']);
    t.mock.restoreAll();

    x = preparar(t, logado());
    const { app } = montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } });
    for (const corpo of [{}, { senha: SENHA }, reautenticacao({ extra: 1 }), reautenticacao({ codigo: '12345' })]) {
      assert.equal((await comSessao(app, '/auth/mfa/substituicao/iniciar', corpo)).status, 400, JSON.stringify(corpo));
    }
    nada(x, ['travar']);
  });

  test('sucesso: reautenticação sob a trava, step atual consumido, PENDENTE novo, desafio SUBSTITUICAO ligado à sessão; nada trocado ainda', async (t) => {
    const x = preparar(t, logado());
    const { app, transacao } = montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } });

    const r = await comSessao(app, '/auth/mfa/substituicao/iniciar', reautenticacao());

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['cadastro', 'etapa', 'expiraEm', 'status']);
    assert.equal(r.body.etapa, 'SUBSTITUICAO');
    assert.match(r.body.cadastro.uri, /^otpauth:\/\/totp\//);
    assert.ok(setCookie(r, authConfig.desafioMfa.cookieNome).valor.length > 0);
    assert.equal(setCookie(r, COOKIE_SESSAO), null);

    const sequencia = ['garantirChaveAtual', 'travarAdministrador', 'buscarValidaPorHash', 'buscarCooldownVigente', 'buscarCredencialPorEmail',
      'verificarSenha', 'buscarTotpAtivo', 'clock_timestamp', 'decifrarSegredoTotp', 'registrarStepAceito', 'cifrarSegredoTotp',
      'revogarPendenteTotp', 'criarPendenteTotp', 'encerrarAbertos', 'criarDesafioSobTrava', 'registrarTentativa', 'registrar'];
    assert.deepEqual(x.ordem.filter((n) => sequencia.includes(n)), sequencia);
    assert.equal(x.sessaoAnterior.mock.calls[0].arguments[1], hashTokenSessao(TOKEN_SESSAO));
    assert.deepEqual(x.senha.mock.calls[0].arguments, ['$argon2id$ficticio', SENHA]);
    assert.deepEqual(x.fator.mock.calls[0].arguments.slice(1), [ADMIN, { travar: true }]);
    assert.deepEqual(x.step.mock.calls[0].arguments[1], { administradorId: ADMIN, fatorId: FATOR, step: STEP });
    assert.equal(x.encerrarAbertos.mock.calls[0].arguments[1].motivo, 'SUBSTITUICAO_INICIADA');
    assert.deepEqual(x.criarDesafio.mock.calls[0].arguments[1], {
      administradorId: ADMIN, tipo: 'SUBSTITUICAO', validadeMinutos: authConfig.desafioMfa.cadastroMinutos, fatorPendenteId: PENDENTE, sessaoOrigemId: SESSAO_ID,
    });
    nada(x, ['revogarFator', 'ativar', 'revogarLote', 'revogarTodas', 'criarSessao']);
    const auditorias = x.auditar.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(auditorias.map((a) => [a.acao, a.administradorId]), [['MFA_SUBSTITUICAO_INICIADA', ADMIN]]);
    for (const proibido of [SENHA, codigoDo(STEP), TOKEN_SESSAO, 'otpauth']) assert.equal(JSON.stringify(auditorias).includes(proibido), false);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [1, 0]);
  });

  test('senha errada, TOTP errado, replay ou sem fator ATIVO: a mesma resposta genérica; nada criado', async (t) => {
    const casos = [
      [{ senhaOk: false }, 'REAUTENTICACAO_INVALIDA', ['decifrar', 'step']],
      [{}, 'TOTP_INVALIDO', ['step'], { codigo: codigoForaDaJanela() }],
      [{ stepAceito: false }, 'TOTP_REPETIDO', []],
      [{ fator: null }, null, ['decifrar', 'step', 'tentativa']],
    ];
    for (const [cenario, motivo, naoChamados, corpo = {}] of casos) {
      const x = preparar(t, logado(cenario));
      const { app, transacao } = montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } });

      const r = await comSessao(app, '/auth/mfa/substituicao/iniciar', reautenticacao(corpo));

      assert.deepEqual([r.status, r.body], [401, REAUTENTICACAO_INVALIDA], JSON.stringify(cenario));
      if (motivo) assert.equal(x.tentativa.mock.calls[0].arguments[1].motivo, motivo);
      nada(x, [...naoChamados, 'cifrar', 'criarPendente', 'criarDesafio', 'incrementar']);
      assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [1, 0]);
      t.mock.restoreAll();
    }
  });

  test('cooldown vigente: 429 sem conferir senha nem TOTP; sessão relida inválida: 401 SESSAO_INVALIDA', async (t) => {
    let x = preparar(t, logado({ cooldown: { ativoAte: new Date(Date.now() + 60_000) } }));
    let r = await comSessao(montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } }).app, '/auth/mfa/substituicao/iniciar', reautenticacao());
    assert.deepEqual([r.status, r.body.codigo], [429, 'MFA_EM_COOLDOWN']);
    nada(x, ['senha', 'decifrar', 'step']);
    t.mock.restoreAll();

    x = preparar(t, { sessaoAnterior: null });
    r = await comSessao(montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } }).app, '/auth/mfa/substituicao/iniciar', reautenticacao());
    assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA']);
    nada(x, ['senha', 'decifrar', 'step', 'tentativa']);
  });

  test('falha criptográfica (chave atual antes, fator atual ou cifragem do novo): 503, ROLLBACK, step não fica consumido, nada criado', async (t) => {
    t.mock.method(console, 'error', () => {});
    const erro = () => { throw new mfaCripto.ErroCriptografiaMfa('CHAVE_INDISPONIVEL'); };
    for (const [cenario, transacaoAberta] of [[{ garantir: erro }, false], [{ decifrar: erro }, true], [{ cifrar: erro }, true]]) {
      const x = preparar(t, logado(cenario));
      const { app, transacao } = montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } });

      const r = await comSessao(app, '/auth/mfa/substituicao/iniciar', reautenticacao());

      assert.deepEqual([r.status, r.body.codigo], [503, 'MFA_INDISPONIVEL'], Object.keys(cenario)[0]);
      assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [0, transacaoAberta ? 1 : 0]);
      nada(x, ['criarPendente', 'criarDesafio', 'tentativa', 'revogarTodas', 'revogarLote']);
      assert.equal(x.auditarSistema.mock.calls[0].arguments[1].contexto.operacao, 'substituicao');
      t.mock.restoreAll();
      t.mock.method(console, 'error', () => {});
    }
  });
});

describe('POST /auth/mfa/substituicao/confirmar', () => {
  const noDesafio = (extra = {}) => logado({ desafioDoCookie: emSubstituicao(), desafio: emSubstituicao(), pendente: fatorPorId, ...extra });
  const confirmar = (app, codigo = codigoDo(STEP)) => comSessao(app, '/auth/mfa/substituicao/confirmar', { codigo }, `${COOKIE_COM_SESSAO}; ${COOKIE_DESAFIO}`);

  test('exige a sessão plena e o desafio SUBSTITUICAO', async (t) => {
    let x = preparar(t, noDesafio());
    assert.equal((await confirmar(montar({ ordem: x.ordem }).app)).body.codigo, 'SESSAO_INVALIDA');
    t.mock.restoreAll();

    x = preparar(t, noDesafio({ desafioDoCookie: emRecuperacao() }));
    assert.equal((await confirmar(montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } }).app)).body.codigo, 'DESAFIO_INVALIDO');
    nada(x, ['travar']);
  });

  test('outra sessão do mesmo administrador não conclui: 401 DESAFIO_INVALIDO, nada muda', async (t) => {
    const outra = { sessao: { id: '777' }, administrador: { id: ADMIN, email: EMAIL } };
    const x = preparar(t, noDesafio({ sessaoAnterior: outra }));
    const { app } = montar({ ordem: x.ordem, sessao: { id: '777' } });

    assert.equal((await confirmar(app)).body.codigo, 'DESAFIO_INVALIDO');
    nada(x, ['decifrar', 'revogarFator', 'ativar', 'revogarTodas', 'criarSessao', 'incrementar']);
  });

  test('sucesso: antigo revogado antes de ativar o novo, lote trocado, todas as sessões revogadas e nenhuma sessão nova; os dois cookies removidos', async (t) => {
    const x = preparar(t, noDesafio({ sessoesRevogadas: 3 }));
    const gerados = t.mock.method(tokenSeguranca, 'gerarTokenSessao');
    const { app, transacao } = montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } });

    const r = await confirmar(app);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['codigosRecuperacao', 'status']);
    assert.equal(r.body.codigosRecuperacao.length, 10);
    encerraSemSessaoNova(x, r, gerados);

    const sequencia = ['travarAdministrador', 'buscarValidoPorId', 'buscarCooldownVigente', 'buscarValidaPorHash', 'buscarTotpAtivo', 'buscarPorId', 'buscarPorId',
      'clock_timestamp', 'decifrarSegredoTotp', 'revogar', 'ativarTotp', 'revogarAtivo', 'criar', 'inserirHashes', 'encerrarAbertos', 'registrarTentativa',
      'encerrar', 'registrar', 'revogarTodasDoAdministrador', 'registrar'];
    assert.deepEqual(x.ordem.filter((n) => sequencia.includes(n)), sequencia);
    assert.equal(x.ordem.at(-1), 'registrar', 'nada depois da auditoria da revogação');
    assert.deepEqual(x.buscarPendente.mock.calls.map((c) => [c.arguments[1].fatorId, c.arguments[2]]), [[FATOR, { travar: true }], [PENDENTE, { travar: true }]]);
    assert.deepEqual(x.decifrar.mock.calls.map((c) => c.arguments[0].fatorUid), [PENDENTE_UID]);
    assert.deepEqual(x.revogarFator.mock.calls[0].arguments[1], { administradorId: ADMIN, fatorId: FATOR, motivo: 'SUBSTITUIDO' });
    assert.deepEqual(x.ativar.mock.calls[0].arguments[1], { administradorId: ADMIN, fatorId: PENDENTE, step: STEP });
    assert.deepEqual(x.revogarLote.mock.calls[0].arguments[1], { administradorId: ADMIN, motivo: 'SUBSTITUICAO' });
    assert.deepEqual(x.encerrarAbertos.mock.calls[0].arguments[1], { administradorId: ADMIN, motivo: 'MFA_SUBSTITUIDO', exceto: DESAFIO });
    assert.deepEqual(x.revogarTodas.mock.calls[0].arguments.slice(1, 3), [ADMIN, 'MFA_SUBSTITUIDO']);
    assert.equal(x.revogarTodas.mock.calls[0].arguments[3], undefined, 'nenhuma sessão é poupada, nem a de origem');
    const auditorias = x.auditar.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(auditorias.map((a) => a.acao), ['MFA_FATOR_SUBSTITUIDO', 'SESSOES_ADMINISTRADOR_REVOGADAS']);
    assert.deepEqual(auditorias[1].contexto, { motivo: 'MFA_SUBSTITUIDO', quantidade: 3 });
    for (const proibido of [...r.body.codigosRecuperacao, TOKEN_SESSAO, codigoDo(STEP)]) assert.equal(JSON.stringify(auditorias).includes(proibido), false);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [1, 0]);
  });

  test('TOTP novo errado: 401 MFA_CODIGO_INVALIDO; nada revogado nem ativado', async (t) => {
    const x = preparar(t, noDesafio());
    const r = await confirmar(montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } }).app, codigoForaDaJanela());
    assert.deepEqual(r.body, CORPO_INVALIDO);
    assert.equal(x.incrementar.mock.calls.length, 1);
    nada(x, ['revogarFator', 'ativar', 'revogarLote', 'revogarTodas', 'criarSessao']);
  });

  test('ativação que falha depois de revogar o antigo, ou decifrar o novo que falha: ROLLBACK de tudo', async (t) => {
    let x = preparar(t, noDesafio({ ativou: false }));
    let montado = montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } });
    assert.equal((await confirmar(montado.app)).body.codigo, 'MFA_CADASTRO_EXPIRADO');
    assert.deepEqual([contar(montado.transacao, 'COMMIT'), contar(montado.transacao, 'ROLLBACK')], [0, 1]);
    t.mock.restoreAll();

    t.mock.method(console, 'error', () => {});
    x = preparar(t, noDesafio({ decifrar: () => { throw new mfaCripto.ErroCriptografiaMfa('AUTENTICACAO_FALHOU'); } }));
    montado = montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } });
    assert.equal((await confirmar(montado.app)).status, 503);
    assert.deepEqual([contar(montado.transacao, 'COMMIT'), contar(montado.transacao, 'ROLLBACK')], [0, 1]);
    nada(x, ['revogarFator', 'ativar', 'revogarTodas']);
  });

  test('PENDENTE vencido: 409 sem decifrar nem revogar', async (t) => {
    const x = preparar(t, noDesafio({ pendente: (_, d) => (d.fatorId === PENDENTE ? pendente({ pendenteVigente: false }) : ativo()) }));
    assert.equal((await confirmar(montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } }).app)).body.codigo, 'MFA_CADASTRO_EXPIRADO');
    nada(x, ['decifrar', 'revogarFator', 'ativar']);
  });
});

describe('POST /auth/mfa/recuperacao/regenerar', () => {
  const regenerar = (app, corpo = reautenticacao()) => comSessao(app, '/auth/mfa/recuperacao/regenerar', corpo);

  test('exige sessão plena e corpo estrito', async (t) => {
    let x = preparar(t);
    assert.equal((await regenerar(montar({ ordem: x.ordem }).app)).body.codigo, 'SESSAO_INVALIDA');
    t.mock.restoreAll();

    x = preparar(t, logado());
    assert.equal((await regenerar(montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } }).app, { codigo: codigoDo(STEP) })).status, 400);
    nada(x, ['travar']);
  });

  test('sucesso: reautenticação, step consumido, desafios e PENDENTE anteriores invalidados, lote REGENERADO trocado por 10 códigos, todas as sessões revogadas e nenhuma sessão nova; os dois cookies removidos', async (t) => {
    const x = preparar(t, logado({ sessoesRevogadas: 2 }));
    const gerados = t.mock.method(tokenSeguranca, 'gerarTokenSessao');
    const { app, transacao } = montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } });

    const r = await regenerar(app);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['codigosRecuperacao', 'status']);
    assert.equal(r.body.codigosRecuperacao.length, 10);
    encerraSemSessaoNova(x, r, gerados);

    const sequencia = ['travarAdministrador', 'buscarValidaPorHash', 'buscarCooldownVigente', 'buscarCredencialPorEmail', 'verificarSenha', 'buscarTotpAtivo',
      'clock_timestamp', 'decifrarSegredoTotp', 'registrarStepAceito', 'encerrarAbertos', 'revogarPendenteTotp', 'revogarAtivo', 'criar', 'inserirHashes',
      'registrarTentativa', 'registrar', 'revogarTodasDoAdministrador', 'registrar'];
    assert.deepEqual(x.ordem.filter((n) => sequencia.includes(n)), sequencia);
    assert.equal(x.ordem.at(-1), 'registrar', 'nada depois da auditoria da revogação');
    assert.deepEqual(x.encerrarAbertos.mock.calls[0].arguments[1], { administradorId: ADMIN, motivo: 'MFA_CODIGOS_REGENERADOS' });
    assert.deepEqual(x.revogarPendente.mock.calls[0].arguments[1], { administradorId: ADMIN, motivo: 'MFA_CODIGOS_REGENERADOS' });
    assert.deepEqual(x.revogarLote.mock.calls[0].arguments[1], { administradorId: ADMIN, motivo: 'REGENERADO' });
    assert.deepEqual(x.revogarTodas.mock.calls[0].arguments.slice(1, 3), [ADMIN, 'MFA_CODIGOS_REGENERADOS']);
    assert.equal(x.revogarTodas.mock.calls[0].arguments[3], undefined, 'nenhuma sessão é poupada, nem a de origem');
    nada(x, ['revogarFator', 'ativar', 'criarPendente', 'garantir', 'cifrar']);
    const auditorias = x.auditar.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(auditorias.map((a) => a.acao), ['MFA_CODIGOS_RECUPERACAO_REGENERADOS', 'SESSOES_ADMINISTRADOR_REVOGADAS']);
    assert.deepEqual(auditorias[1].contexto, { motivo: 'MFA_CODIGOS_REGENERADOS', quantidade: 2 });
    for (const proibido of [...r.body.codigosRecuperacao, TOKEN_SESSAO, SENHA, codigoDo(STEP)]) assert.equal(JSON.stringify(auditorias).includes(proibido), false);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [1, 0]);
  });

  test('senha, TOTP ou replay inválidos: 401 genérico; lote e sessões intactos', async (t) => {
    for (const [cenario, corpo] of [[{ senhaOk: false }, {}], [{}, { codigo: codigoForaDaJanela() }], [{ stepAceito: false }, {}]]) {
      const x = preparar(t, logado(cenario));
      assert.deepEqual((await regenerar(montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } }).app, reautenticacao(corpo))).body, REAUTENTICACAO_INVALIDA);
      nada(x, ['encerrarAbertos', 'revogarPendente', 'revogarLote', 'criarLote', 'revogarTodas', 'criarSessao']);
      t.mock.restoreAll();
    }
  });

  test('falha ao decifrar o fator atual: 503, ROLLBACK, lote antigo intacto, nenhuma sessão', async (t) => {
    t.mock.method(console, 'error', () => {});
    const x = preparar(t, logado({ decifrar: () => { throw new mfaCripto.ErroCriptografiaMfa('CHAVE_INDISPONIVEL'); } }));
    const { app, transacao } = montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } });

    assert.equal((await regenerar(app)).status, 503);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [0, 1]);
    nada(x, ['encerrarAbertos', 'revogarPendente', 'revogarLote', 'criarLote', 'revogarTodas', 'criarSessao', 'tentativa']);
  });

  test('falha depois de invalidar desafios e PENDENTE (lote incompleto): ROLLBACK de tudo, nenhuma sessão', async (t) => {
    const x = preparar(t, logado());
    t.mock.method(codigoRepo, 'inserirHashes', async (_, dados) => dados.hashes.length - 1);
    const { app, transacao } = montar({ ordem: x.ordem, sessao: { id: SESSAO_ID } });

    assert.equal((await regenerar(app)).status, 500);
    assert.equal(x.encerrarAbertos.mock.calls.length, 1);
    assert.equal(x.revogarPendente.mock.calls.length, 1);
    assert.deepEqual([contar(transacao, 'COMMIT'), contar(transacao, 'ROLLBACK')], [0, 1]);
    nada(x, ['revogarTodas', 'criarSessao']);
  });
});
