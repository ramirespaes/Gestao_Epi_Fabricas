'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');
const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const liberacaoRepo = require('../../src/repositories/liberacao-cadastro-mfa-plataforma.repository');
const auditoriaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const codigosMfa = require('../../src/security/codigos-mfa');
const { authConfig } = require('../../src/config/auth');

const servico = require('../../src/services/liberacao-cadastro-mfa-plataforma.service');

/**
 * Liberação de cadastro do MFA, emitida só por CLI, sem PostgreSQL:
 * repositórios mockados por namespace. Prova a sequência (trava do
 * administrador, recusa com TOTP ativo, revogação da aberta, só o hash no
 * banco), a auditoria com ator OPERACAO_CLI e alvo, e que o código em claro
 * só existe no retorno.
 */

const ADMIN = { id: 9, email: 'admin@safework.com.br', ativo: true };
const EXPIRA = new Date('2026-09-28T10:30:00Z');

function criarClienteFalso() {
  const chamadas = [];
  return { chamadas, query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; }, release: () => chamadas.push('RELEASE') };
}
const criarPoolFalso = (cliente) => ({ connect: async () => cliente });

function mocks(t, { administrador = ADMIN, ativo = null } = {}) {
  const ordem = [];
  const m = (alvo, nome, retorno) => t.mock.method(alvo, nome, async (...args) => {
    ordem.push(nome);
    return typeof retorno === 'function' ? retorno(...args) : retorno;
  });
  return {
    ordem,
    buscar: m(administradorRepo, 'buscarPorEmail', administrador),
    travar: m(travaRepo, 'travarAdministrador', undefined),
    buscarAtivo: m(fatorRepo, 'buscarTotpAtivo', ativo),
    revogar: m(liberacaoRepo, 'revogarAberta', true),
    criar: m(liberacaoRepo, 'criar', { id: '5', criadoEm: new Date(), expiraEm: EXPIRA }),
    auditar: m(auditoriaRepo, 'registrarOperacaoCli', { id: '1', criadoEm: new Date() }),
  };
}

describe('emitirLiberacaoSobTrava', () => {
  test('revoga a aberta, gera 80 bits aleatórios e grava só o hash contextualizado, com o prazo da configuração', async (t) => {
    const x = mocks(t);
    const cliente = criarClienteFalso();

    const emitida = await servico.emitirLiberacaoSobTrava(cliente, { administradorId: 9, origem: 'CLI_CRIACAO' });

    assert.match(emitida.codigo, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    assert.deepEqual(x.ordem, ['revogarAberta', 'criar']);
    assert.deepEqual(x.revogar.mock.calls[0].arguments[1], { administradorId: 9, motivo: 'SUBSTITUIDA' });
    const dados = x.criar.mock.calls[0].arguments[1];
    assert.deepEqual(dados, {
      administradorId: 9,
      codigoHash: codigosMfa.hashCodigoLiberacao({ administradorId: 9, codigo: codigosMfa.normalizarCodigo(emitida.codigo) }),
      origem: 'CLI_CRIACAO',
      validadeMinutos: authConfig.liberacaoMfa.expiracaoMinutos,
    });
    assert.equal(JSON.stringify(dados).includes(emitida.codigo), false);
    assert.equal(emitida.expiraEm, EXPIRA);
  });
});

describe('liberarCadastro (CLI)', () => {
  test('sucesso: localiza pelo e-mail normalizado, trava, confere que não há TOTP ativo, emite CLI_LIBERACAO e audita como OPERACAO_CLI com o alvo', async (t) => {
    const x = mocks(t);
    const cliente = criarClienteFalso();

    const resultado = await servico.liberarCadastro(criarPoolFalso(cliente), { email: '  Admin@SafeWork.com.br ' });

    assert.equal(x.buscar.mock.calls[0].arguments[1], 'admin@safework.com.br');
    assert.deepEqual(x.ordem, ['buscarPorEmail', 'travarAdministrador', 'buscarTotpAtivo', 'revogarAberta', 'criar', 'registrarOperacaoCli']);
    assert.deepEqual(x.travar.mock.calls[0].arguments, [cliente, 9]);
    assert.equal(x.criar.mock.calls[0].arguments[1].origem, 'CLI_LIBERACAO');

    const auditoria = x.auditar.mock.calls[0].arguments[1];
    assert.equal(auditoria.administradorAfetadoId, 9);
    assert.equal(auditoria.acao, 'LIBERACAO_CADASTRO_CRIADA');
    assert.equal('administradorId' in auditoria, false, 'operação de CLI nunca é atribuída ao alvo');
    assert.equal(JSON.stringify(auditoria).includes(resultado.codigo), false, 'o código nunca vai para a auditoria');

    assert.deepEqual(Object.keys(resultado).sort(), ['administradorId', 'codigo', 'expiraEm']);
    assert.equal(cliente.chamadas.filter((c) => c === 'COMMIT').length, 1);
  });

  test('recusas explícitas para o operador, sem emitir nada: e-mail inválido, inexistente, inativo, TOTP já ativo', async (t) => {
    const casos = [
      [{ email: 'sem-arroba' }, {}, 'EMAIL_INVALIDO'],
      [{ email: 'ninguem@safework.com.br' }, { administrador: null }, 'ADMINISTRADOR_INEXISTENTE'],
      [{ email: 'admin@safework.com.br' }, { administrador: { ...ADMIN, ativo: false } }, 'ADMINISTRADOR_INATIVO'],
      [{ email: 'admin@safework.com.br' }, { ativo: { id: '41', estado: 'ATIVO' } }, 'TOTP_ATIVO'],
    ];
    for (const [entrada, cenario, motivo] of casos) {
      const x = mocks(t, cenario);
      await assert.rejects(
        () => servico.liberarCadastro(criarPoolFalso(criarClienteFalso()), entrada),
        (erro) => erro instanceof servico.ErroLiberacaoCadastro && erro.motivo === motivo,
        motivo,
      );
      assert.equal(x.criar.mock.calls.length, 0, motivo);
      assert.equal(x.auditar.mock.calls.length, 0, motivo);
      t.mock.restoreAll();
    }
  });

  test('erro inesperado depois de revogar a aberta: ROLLBACK, nada fica', async (t) => {
    mocks(t);
    const erro = new Error('conexão perdida');
    t.mock.method(liberacaoRepo, 'criar', async () => { throw erro; });
    const cliente = criarClienteFalso();

    await assert.rejects(() => servico.liberarCadastro(criarPoolFalso(cliente), { email: 'admin@safework.com.br' }), (e) => e === erro);

    assert.equal(cliente.chamadas.filter((c) => c === 'ROLLBACK').length, 1);
    assert.equal(cliente.chamadas.filter((c) => c === 'COMMIT').length, 0);
  });
});
