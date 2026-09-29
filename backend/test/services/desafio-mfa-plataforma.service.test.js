'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const sessaoRepo = require('../../src/repositories/sessao-plataforma.repository');
const { authConfig } = require('../../src/config/auth');
const { gerarTokenSessao, hashTokenSessao } = require('../../src/security/token');

const servico = require('../../src/services/desafio-mfa-plataforma.service');

/**
 * Serviço do desafio pré-MFA sem PostgreSQL: repositórios mockados por
 * namespace, registrando a ORDEM das chamadas. O que se prova aqui é a
 * sequência exigida: trava do administrador primeiro; depois fator, vencidos,
 * abertos (com trava de linha), corte para 4 quando já há 5 ou mais, e só
 * então o novo desafio, que recebe apenas o hash do token.
 */

const ADMIN = 9;
const CLIENTE = Object.freeze({ marcador: 'client-da-transacao' });
const EXPIRA = new Date('2026-09-28T10:05:00Z');
const aberto = (id) => ({ id: String(id), tipo: 'VERIFICACAO', encerradoEm: null });

function prepararMocks(t, { ativo = null, abertos = [] } = {}) {
  const ordem = [];
  const registrar = (nome, retorno) => t.mock.method(nome[0], nome[1], async (...args) => {
    ordem.push(nome[1]);
    return typeof retorno === 'function' ? retorno(...args) : retorno;
  });
  return {
    ordem,
    travar: registrar([travaRepo, 'travarAdministrador'], undefined),
    buscarAtivo: registrar([fatorRepo, 'buscarTotpAtivo'], ativo),
    expirados: registrar([desafioRepo, 'encerrarExpirados'], 0),
    listar: registrar([desafioRepo, 'listarAbertos'], abertos),
    cortar: registrar([desafioRepo, 'encerrarMaisAntigos'], Math.max(0, abertos.length - 4)),
    criar: registrar([desafioRepo, 'criar'], { id: '500', criadoEm: new Date('2026-09-28T10:00:00Z'), expiraEm: EXPIRA }),
  };
}

describe('abrirDesafioAposSenha', () => {
  test('sem TOTP ativo: LIBERACAO, com o prazo de cadastro da configuração', async (t) => {
    const m = prepararMocks(t);

    const resultado = await servico.abrirDesafioAposSenha(CLIENTE, { administradorId: ADMIN });

    assert.equal(resultado.desafio.etapa, 'LIBERACAO');
    assert.equal(resultado.desafio.validadeMinutos, authConfig.desafioMfa.cadastroMinutos);
    assert.equal(resultado.desafio.expiraEm, EXPIRA);
    const dados = m.criar.mock.calls[0].arguments[1];
    assert.deepEqual(
      { tipo: dados.tipo, validadeMinutos: dados.validadeMinutos, administradorId: dados.administradorId },
      { tipo: 'LIBERACAO', validadeMinutos: authConfig.desafioMfa.cadastroMinutos, administradorId: ADMIN },
    );
  });

  test('com TOTP ativo: VERIFICACAO, com o prazo de verificação da configuração', async (t) => {
    const m = prepararMocks(t, { ativo: { id: '41', estado: 'ATIVO' } });

    const resultado = await servico.abrirDesafioAposSenha(CLIENTE, { administradorId: ADMIN });

    assert.equal(resultado.desafio.etapa, 'VERIFICACAO');
    assert.equal(resultado.desafio.validadeMinutos, authConfig.desafioMfa.verificacaoMinutos);
    assert.equal(m.criar.mock.calls[0].arguments[1].tipo, 'VERIFICACAO');
    assert.equal(m.criar.mock.calls[0].arguments[1].validadeMinutos, authConfig.desafioMfa.verificacaoMinutos);
  });

  test('ordem: trava do administrador antes de tudo, abertos com trava de linha, criação por último; tudo no mesmo client', async (t) => {
    const m = prepararMocks(t, { abertos: [aberto(1), aberto(2)] });

    await servico.abrirDesafioAposSenha(CLIENTE, { administradorId: ADMIN });

    assert.deepEqual(m.ordem, ['travarAdministrador', 'buscarTotpAtivo', 'encerrarExpirados', 'listarAbertos', 'criar']);
    assert.deepEqual(m.travar.mock.calls[0].arguments, [CLIENTE, ADMIN]);
    assert.deepEqual(m.listar.mock.calls[0].arguments[2], { travar: true });
    for (const mockado of [m.travar, m.buscarAtivo, m.expirados, m.listar, m.criar]) {
      assert.equal(mockado.mock.calls[0].arguments[0], CLIENTE, 'uma transação só, a do chamador');
    }
    assert.equal(m.cortar.mock.calls.length, 0, 'com menos de 5 abertos nada é encerrado');
  });

  test('com 5 ou mais abertos, encerra os mais antigos até restarem 4, antes de criar', async (t) => {
    for (const quantidade of [5, 6, 9]) {
      const m = prepararMocks(t, { abertos: Array.from({ length: quantidade }, (_, i) => aberto(i + 1)) });

      await servico.abrirDesafioAposSenha(CLIENTE, { administradorId: ADMIN });

      assert.deepEqual(m.ordem.slice(-2), ['encerrarMaisAntigos', 'criar'], String(quantidade));
      assert.deepEqual(m.cortar.mock.calls[0].arguments[1], { administradorId: ADMIN, manterAbertos: 4, motivo: 'LIMITE_DESAFIOS' });
      t.mock.restoreAll();
    }
  });

  test('o token é aleatório, canônico, só existe no retorno; o repositório recebe apenas o SHA-256', async (t) => {
    const m = prepararMocks(t);

    const r1 = await servico.abrirDesafioAposSenha(CLIENTE, { administradorId: ADMIN });
    const r2 = await servico.abrirDesafioAposSenha(CLIENTE, { administradorId: ADMIN });

    assert.match(r1.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(r1.token, r2.token);
    const dados = m.criar.mock.calls[0].arguments[1];
    assert.equal(dados.tokenHash, hashTokenSessao(r1.token));
    assert.equal(JSON.stringify(dados).includes(r1.token), false);
    assert.deepEqual(Object.keys(r1).sort(), ['desafio', 'token']);
    assert.deepEqual(Object.keys(r1.desafio).sort(), ['etapa', 'expiraEm', 'validadeMinutos']);
  });

  test('erro de um repositório propaga sem criar o desafio', async (t) => {
    const m = prepararMocks(t);
    const erro = new Error('conexão perdida');
    t.mock.method(desafioRepo, 'listarAbertos', async () => { throw erro; });

    await assert.rejects(() => servico.abrirDesafioAposSenha(CLIENTE, { administradorId: ADMIN }), (e) => e === erro);
    assert.equal(m.criar.mock.calls.length, 0);
  });
});

// Transições do cadastro: quem chama já tem a trava do administrador.
describe('criarDesafioSobTrava', () => {
  test('mesmo limite de abertos; leva fator pendente e desafio anterior; não toma a trava de novo', async (t) => {
    const m = prepararMocks(t, { abertos: Array.from({ length: 5 }, (_, i) => aberto(i + 1)) });

    const r = await servico.criarDesafioSobTrava(CLIENTE, {
      administradorId: ADMIN, tipo: 'CADASTRO', validadeMinutos: 15, fatorPendenteId: '42', desafioAnteriorId: '300',
    });

    assert.deepEqual(m.ordem, ['encerrarExpirados', 'listarAbertos', 'encerrarMaisAntigos', 'criar']);
    assert.equal(m.travar.mock.calls.length, 0);
    const dados = m.criar.mock.calls[0].arguments[1];
    assert.deepEqual(
      { tipo: dados.tipo, validadeMinutos: dados.validadeMinutos, fatorPendenteId: dados.fatorPendenteId, desafioAnteriorId: dados.desafioAnteriorId },
      { tipo: 'CADASTRO', validadeMinutos: 15, fatorPendenteId: '42', desafioAnteriorId: '300' },
    );
    assert.equal(dados.tokenHash, hashTokenSessao(r.token));
    assert.deepEqual(r.desafio, { etapa: 'CADASTRO', expiraEm: EXPIRA, validadeMinutos: 15 });
  });
});

describe('encerrarDesafioPorToken (logout)', () => {
  const TOKEN = gerarTokenSessao();
  const SESSAO_CRIADA = '777';
  const DESAFIO_ABERTO = Object.freeze({
    id: '300', administradorId: ADMIN, tipo: 'SUBSTITUICAO', fatorPendenteId: '42', encerradoEm: null, motivoEncerramento: null, sessaoCriadaId: null,
  });
  const encerrado = (motivo, extra = {}) => ({ ...DESAFIO_ABERTO, encerradoEm: new Date('2026-09-28T10:01:00Z'), motivoEncerramento: motivo, ...extra });
  const concluidoComSessao = (tipo) => encerrado('CONCLUIDO', { tipo, fatorPendenteId: tipo === 'VERIFICACAO' ? null : '42', sessaoCriadaId: SESSAO_CRIADA });

  function bancoFalso() {
    const transacao = [];
    const cliente = { query: async (texto) => { transacao.push(texto); return { rows: [], rowCount: 0 }; }, release: () => {} };
    return { transacao, pool: { connect: async () => cliente, query: async () => { throw new Error('consulta fora da transação'); } } };
  }

  function preparar(t, {
    desafio = DESAFIO_ABERTO, relido = desafio, encerrou = true, fator = { id: '42', estado: 'PENDENTE' }, sessaoRevogada = true,
  } = {}) {
    const ordem = [];
    const m = (alvo, nome, retorno, rotulo = nome) => t.mock.method(alvo, nome, async (...args) => {
      ordem.push(rotulo);
      return typeof retorno === 'function' ? retorno(...args) : retorno;
    });
    const leituras = [desafio, relido];
    return {
      ordem,
      buscar: m(desafioRepo, 'buscarPorHash', () => leituras.shift()),
      travar: m(travaRepo, 'travarAdministrador', undefined),
      encerrar: m(desafioRepo, 'encerrar', encerrou),
      fator: m(fatorRepo, 'buscarPorId', fator),
      revogar: m(fatorRepo, 'revogar', true),
      revogarSessao: m(sessaoRepo, 'revogar', sessaoRevogada, 'revogarSessao'),
      revogarTodas: m(sessaoRepo, 'revogarTodasDoAdministrador', 0),
    };
  }
  const nada = (x, nomes) => {
    for (const nome of nomes) assert.equal(x[nome].mock.calls.length, 0, nome);
  };
  const commitRollback = (transacao) => [transacao.filter((q) => q === 'COMMIT').length, transacao.filter((q) => q === 'ROLLBACK').length];

  test('desafio aberto com PENDENTE: sob a trava do administrador, encerra (LOGOUT) e revoga o PENDENTE como ABANDONADO', async (t) => {
    const x = preparar(t);
    const { pool, transacao } = bancoFalso();

    assert.equal(await servico.encerrarDesafioPorToken(pool, TOKEN), true);

    assert.equal(x.buscar.mock.calls[0].arguments[1], hashTokenSessao(TOKEN));
    assert.deepEqual(x.ordem, ['buscarPorHash', 'travarAdministrador', 'buscarPorHash', 'encerrar', 'buscarPorId', 'revogar']);
    assert.deepEqual(x.encerrar.mock.calls[0].arguments[1], { desafioId: '300', motivo: 'LOGOUT' });
    assert.deepEqual(x.fator.mock.calls[0].arguments.slice(1), [{ administradorId: ADMIN, fatorId: '42' }, { travar: true }]);
    assert.deepEqual(x.revogar.mock.calls[0].arguments[1], { administradorId: ADMIN, fatorId: '42', motivo: 'ABANDONADO' });
    assert.deepEqual([transacao.filter((q) => q === 'COMMIT').length, transacao.filter((q) => q === 'ROLLBACK').length], [1, 0]);
  });

  test('outra requisição encerrou o desafio antes (ex.: confirmação que ativou o fator): nada é revogado', async (t) => {
    const x = preparar(t, { encerrou: false });
    assert.equal(await servico.encerrarDesafioPorToken(bancoFalso().pool, TOKEN), false);
    assert.equal(x.fator.mock.calls.length + x.revogar.mock.calls.length, 0);
  });

  test('o fator já não está PENDENTE, ou o desafio não tem fator: só o desafio é encerrado', async (t) => {
    let x = preparar(t, { fator: { id: '42', estado: 'ATIVO' } });
    assert.equal(await servico.encerrarDesafioPorToken(bancoFalso().pool, TOKEN), true);
    assert.equal(x.revogar.mock.calls.length, 0);
    t.mock.restoreAll();

    x = preparar(t, { desafio: { ...DESAFIO_ABERTO, tipo: 'VERIFICACAO', fatorPendenteId: null } });
    assert.equal(await servico.encerrarDesafioPorToken(bancoFalso().pool, TOKEN), true);
    assert.equal(x.fator.mock.calls.length + x.revogar.mock.calls.length, 0);
  });

  for (const tipo of ['VERIFICACAO', 'CADASTRO', 'RECUPERACAO']) {
    test(`${tipo}: a confirmação concluiu e criou a sessão enquanto o logout esperava a trava: revoga exatamente essa sessão (LOGOUT), sem tocar em desafio, fator nem outras sessões`, async (t) => {
      const x = preparar(t, { desafio: { ...DESAFIO_ABERTO, tipo }, relido: concluidoComSessao(tipo), encerrou: false });
      const { pool, transacao } = bancoFalso();

      assert.equal(await servico.encerrarDesafioPorToken(pool, TOKEN), true);

      assert.deepEqual(x.ordem, ['buscarPorHash', 'travarAdministrador', 'buscarPorHash', 'revogarSessao']);
      assert.deepEqual(x.revogarSessao.mock.calls[0].arguments.slice(1), [SESSAO_CRIADA, 'LOGOUT']);
      assert.equal(x.revogarSessao.mock.calls[0].arguments[0], x.travar.mock.calls[0].arguments[0], 'no mesmo client da trava');
      nada(x, ['encerrar', 'fator', 'revogar', 'revogarTodas']);
      assert.deepEqual(commitRollback(transacao), [1, 0]);
    });
  }

  test('logout que já chega com o desafio CONCLUIDO e sessão criada (cookie do desafio ainda no navegador): passa pela trava e revoga essa sessão; repetido, nada muda', async (t) => {
    const x = preparar(t, { desafio: concluidoComSessao('VERIFICACAO'), encerrou: false });
    const { pool, transacao } = bancoFalso();

    assert.equal(await servico.encerrarDesafioPorToken(pool, TOKEN), true);

    assert.deepEqual(x.ordem, ['buscarPorHash', 'travarAdministrador', 'buscarPorHash', 'revogarSessao']);
    assert.deepEqual(x.revogarSessao.mock.calls[0].arguments.slice(1), [SESSAO_CRIADA, 'LOGOUT']);
    assert.deepEqual(commitRollback(transacao), [1, 0]);
    t.mock.restoreAll();

    const y = preparar(t, { desafio: concluidoComSessao('VERIFICACAO'), encerrou: false, sessaoRevogada: false });
    assert.equal(await servico.encerrarDesafioPorToken(bancoFalso().pool, TOKEN), false);
    assert.equal(y.revogarSessao.mock.calls.length, 1);
    nada(y, ['encerrar', 'fator', 'revogar', 'revogarTodas']);
  });

  test('encerrado por outro motivo, ou CONCLUIDO sem sessão criada (SUBSTITUICAO): nenhuma sessão é inferida', async (t) => {
    for (const desafio of [encerrado('LOGOUT'), encerrado('MFA_CODIGOS_REGENERADOS'), encerrado('CONCLUIDO')]) {
      const x = preparar(t, { desafio });
      const { pool, transacao } = bancoFalso();
      assert.equal(await servico.encerrarDesafioPorToken(pool, TOKEN), false, desafio.motivoEncerramento);
      assert.deepEqual([x.ordem, transacao.length], [['buscarPorHash'], 0]);
      t.mock.restoreAll();
    }

    for (const relido of [encerrado('EXPIRADO'), encerrado('CONCLUIDO')]) {
      const x = preparar(t, { relido, encerrou: false });
      assert.equal(await servico.encerrarDesafioPorToken(bancoFalso().pool, TOKEN), false, relido.motivoEncerramento);
      nada(x, ['revogarSessao', 'revogarTodas', 'fator', 'revogar']);
      t.mock.restoreAll();
    }
  });

  test('desafio encerrado sem sessão criada, inexistente ou token fora do formato: nada a fazer, sem transação', async (t) => {
    t.mock.method(desafioRepo, 'buscarPorHash', async (_, hash) => (hash === hashTokenSessao(TOKEN) ? { ...DESAFIO_ABERTO, encerradoEm: new Date() } : null));
    const encerrar = t.mock.method(desafioRepo, 'encerrar', async () => true);
    const { pool, transacao } = bancoFalso();

    assert.equal(await servico.encerrarDesafioPorToken(pool, TOKEN), false);
    assert.equal(await servico.encerrarDesafioPorToken(pool, gerarTokenSessao()), false);
    assert.equal(await servico.encerrarDesafioPorToken(pool, 'x'), false);
    assert.equal(await servico.encerrarDesafioPorToken(pool, null), false);
    assert.equal(encerrar.mock.calls.length, 0);
    assert.equal(transacao.length, 0);
  });

  test('não usa aleatoriedade nem o token além do hash', async (t) => {
    const aleatorio = t.mock.method(crypto, 'randomBytes');
    t.mock.method(desafioRepo, 'buscarPorHash', async () => null);
    await servico.encerrarDesafioPorToken(bancoFalso().pool, TOKEN);
    assert.equal(aleatorio.mock.calls.length, 0);
  });
});
