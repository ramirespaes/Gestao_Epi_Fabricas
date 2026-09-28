'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
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

  test('desafio aberto: encerra com LOGOUT pelo id achado com o hash', async (t) => {
    const buscar = t.mock.method(desafioRepo, 'buscarPorHash', async () => ({ id: '300', encerradoEm: null }));
    const encerrar = t.mock.method(desafioRepo, 'encerrar', async () => true);

    assert.equal(await servico.encerrarDesafioPorToken(CLIENTE, TOKEN), true);

    assert.equal(buscar.mock.calls[0].arguments[1], hashTokenSessao(TOKEN));
    assert.deepEqual(encerrar.mock.calls[0].arguments[1], { desafioId: '300', motivo: 'LOGOUT' });
  });

  test('desafio já encerrado, inexistente ou token fora do formato: nada a fazer', async (t) => {
    t.mock.method(desafioRepo, 'buscarPorHash', async (_, hash) => (hash === hashTokenSessao(TOKEN) ? { id: '300', encerradoEm: new Date() } : null));
    const encerrar = t.mock.method(desafioRepo, 'encerrar', async () => true);

    assert.equal(await servico.encerrarDesafioPorToken(CLIENTE, TOKEN), false);
    assert.equal(await servico.encerrarDesafioPorToken(CLIENTE, gerarTokenSessao()), false);
    assert.equal(await servico.encerrarDesafioPorToken(CLIENTE, 'x'), false);
    assert.equal(await servico.encerrarDesafioPorToken(CLIENTE, null), false);
    assert.equal(encerrar.mock.calls.length, 0);
  });

  test('não usa aleatoriedade nem o token além do hash', async (t) => {
    const aleatorio = t.mock.method(crypto, 'randomBytes');
    t.mock.method(desafioRepo, 'buscarPorHash', async () => null);
    await servico.encerrarDesafioPorToken(CLIENTE, TOKEN);
    assert.equal(aleatorio.mock.calls.length, 0);
  });
});
