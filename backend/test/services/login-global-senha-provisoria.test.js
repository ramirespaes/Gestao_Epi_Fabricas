'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { autenticar } = require('../../src/services/login-global.service');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const sessaoRepo = require('../../src/repositories/sessao-global.repository');
const loginTentativaGlobalRepo = require('../../src/repositories/login-tentativa-global.repository');
const password = require('../../src/security/password');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Login global com senha PROVISÓRIA (Gestão de Usuários), sem PostgreSQL:
 * válida, autentica e marca a troca obrigatória; expirada, recusa com código
 * próprio, sem sessão, sem renovar o prazo e sem contar como senha errada.
 * Mesma técnica de login-global.service.test.js.
 */

const EMAIL = 'pessoa@example.invalid';
const SENHA = 'planeta-nebulosa-ozonio-42';
const AGORA = new Date('2026-10-06T12:00:00.000Z');
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaHNpbnRldGljbw';

const base = { id: 9, email: EMAIL, senhaHash: HASH, ativo: true };
const provisoriaValida = Object.freeze({ ...base, senhaProvisoria: true, senhaProvisoriaExpiraEm: new Date(AGORA.getTime() + 60_000) });
const provisoriaExpirada = Object.freeze({ ...base, senhaProvisoria: true, senhaProvisoriaExpiraEm: new Date(AGORA.getTime() - 1) });
const provisoriaNoLimite = Object.freeze({ ...base, senhaProvisoria: true, senhaProvisoriaExpiraEm: AGORA });
const definitiva = Object.freeze({ ...base, senhaProvisoria: false, senhaProvisoriaExpiraEm: null });

function clienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => { chamadas.push(texto); return /clock_timestamp/i.test(texto) ? { rows: [{ agora: AGORA }] } : { rows: [], rowCount: 0 }; },
    release: () => chamadas.push('RELEASE'),
  };
}
const poolFalso = (cliente) => ({ connect: async () => cliente });

function prepararSucesso(t, credencial) {
  t.mock.method(identidadeRepo, 'buscarCredencialPorEmail', async () => credencial);
  t.mock.method(password, 'verificarSenha', async () => true);
  t.mock.method(loginTentativaGlobalRepo, 'buscarCooldownVigente', async () => null);
  const registrar = t.mock.method(loginTentativaGlobalRepo, 'registrarTentativa', async () => '1');
  const ativar = t.mock.method(loginTentativaGlobalRepo, 'registrarAtivacaoCooldown', async () => '1');
  const criarSessao = t.mock.method(sessaoRepo, 'criar', async () => '321');
  return { registrar, ativar, criarSessao };
}

describe('autenticar — senha provisória', () => {
  test('válida: autentica, cria a sessão e devolve trocaSenhaObrigatoria=true na identidade', async (t) => {
    const { registrar, criarSessao } = prepararSucesso(t, provisoriaValida);
    const resultado = await autenticar(poolFalso(clienteFalso()), { email: EMAIL, senha: SENHA });
    assert.deepEqual(resultado.identidade, { id: 9, email: EMAIL, trocaSenhaObrigatoria: true });
    assert.equal(criarSessao.mock.calls.length, 1);
    assert.equal(registrar.mock.calls[0].arguments[1].sucesso, true);
    assert.equal(JSON.stringify(resultado).includes('senhaHash'), false);
  });

  test('definitiva: trocaSenhaObrigatoria=false, sem nenhum outro campo novo', async (t) => {
    prepararSucesso(t, definitiva);
    const resultado = await autenticar(poolFalso(clienteFalso()), { email: EMAIL, senha: SENHA });
    assert.deepEqual(resultado.identidade, { id: 9, email: EMAIL, trocaSenhaObrigatoria: false });
  });

  test('expirada (inclusive no instante exato): 401 SENHA_PROVISORIA_EXPIRADA, sem sessão, sem contar como senha errada e sem renovar o prazo', async (t) => {
    for (const credencial of [provisoriaExpirada, provisoriaNoLimite]) {
      const { registrar, ativar, criarSessao } = prepararSucesso(t, credencial);
      const cliente = clienteFalso();
      await assert.rejects(() => autenticar(poolFalso(cliente), { email: EMAIL, senha: SENHA }), (erro) => {
        assert.ok(erro instanceof HttpError);
        assert.equal(erro.status, 401);
        assert.equal(erro.codigo, 'SENHA_PROVISORIA_EXPIRADA');
        assert.doesNotMatch(erro.message, /hash|argon|example\.invalid/i);
        return true;
      });
      assert.equal(criarSessao.mock.calls.length, 0, 'nenhuma sessão');
      assert.equal(registrar.mock.calls.filter((c) => c.arguments[1].sucesso === false).length, 0, 'não é senha errada: não entra no cooldown');
      assert.equal(ativar.mock.calls.length, 0);
      assert.equal(cliente.chamadas.filter((c) => /UPDATE/i.test(String(c))).length, 0, 'nada é renovado');
      assert.equal(cliente.chamadas.filter((c) => /^COMMIT$/i.test(String(c))).length, 1, 'desfecho de negócio termina em COMMIT');
    }
  });

  test('senha errada com provisória válida continua 401 genérico e conta no cooldown, como qualquer senha errada', async (t) => {
    t.mock.method(identidadeRepo, 'buscarCredencialPorEmail', async () => provisoriaValida);
    t.mock.method(password, 'verificarSenha', async () => false);
    t.mock.method(loginTentativaGlobalRepo, 'buscarCooldownVigente', async () => null);
    const registrar = t.mock.method(loginTentativaGlobalRepo, 'registrarTentativa', async () => '1');
    t.mock.method(loginTentativaGlobalRepo, 'contarFalhasRecentes', async () => 0);
    await assert.rejects(() => autenticar(poolFalso(clienteFalso()), { email: EMAIL, senha: 'errada-errada-errada' }), (erro) => erro.codigo === 'CREDENCIAIS_INVALIDAS');
    assert.equal(registrar.mock.calls[0].arguments[1].motivo, 'SENHA_INVALIDA');
  });
});
