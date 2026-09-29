'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');
const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const sessaoRepo = require('../../src/repositories/sessao-plataforma.repository');
const liberacaoRepo = require('../../src/repositories/liberacao-cadastro-mfa-plataforma.repository');
const auditoriaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const mfaCripto = require('../../src/security/mfa-cripto');
const codigosMfa = require('../../src/security/codigos-mfa');
const { authConfig } = require('../../src/config/auth');

const CAMINHO = path.join(__dirname, '../../src/services/reset-mfa-plataforma.service.js');
const carregar = () => {
  assert.ok(fs.existsSync(CAMINHO), 'serviço de reset operacional ausente');
  return require(CAMINHO);
};

const ADMIN = 9;
const EXPIRA = new Date('2026-09-28T12:30:00.000Z');

function bancoFalso() {
  const transacao = [];
  const cliente = { query: async (texto) => { transacao.push(texto); return { rows: [], rowCount: 0 }; }, release: () => {} };
  return { transacao, pool: { connect: async () => cliente, query: async () => { throw new Error('consulta fora da transação'); } } };
}

function preparar(t, c = {}) {
  const ordem = [];
  const m = (alvo, nome, retorno) => t.mock.method(alvo, nome, async (...args) => {
    ordem.push(nome);
    return typeof retorno === 'function' ? retorno(...args) : retorno;
  });
  return {
    ordem,
    administrador: m(administradorRepo, 'buscarPorEmail', c.administrador === undefined ? { id: ADMIN, email: 'admin@safework.com.br', ativo: true } : c.administrador),
    travar: m(travaRepo, 'travarAdministrador', undefined),
    ativo: m(fatorRepo, 'buscarTotpAtivo', c.ativo === undefined ? { id: '41' } : c.ativo),
    revogarFator: m(fatorRepo, 'revogar', true),
    revogarPendente: m(fatorRepo, 'revogarPendenteTotp', 1),
    revogarLote: m(loteRepo, 'revogarAtivo', true),
    encerrarAbertos: m(desafioRepo, 'encerrarAbertos', 2),
    revogarSessoes: m(sessaoRepo, 'revogarTodasDoAdministrador', c.revogarSessoes ?? 3),
    revogarLiberacao: m(liberacaoRepo, 'revogarAberta', true),
    criarLiberacao: m(liberacaoRepo, 'criar', { id: '77', criadoEm: new Date(), expiraEm: EXPIRA }),
    auditarCli: m(auditoriaRepo, 'registrarOperacaoCli', { id: '1' }),
    auditarAdministrador: m(auditoriaRepo, 'registrar', { id: '2' }),
    criarSessao: m(sessaoRepo, 'criar', '999'),
    criarPendente: m(fatorRepo, 'criarPendenteTotp', null),
    cifrar: t.mock.method(mfaCripto, 'cifrarSegredoTotp', () => { throw new Error('reset não cria secret'); }),
  };
}

describe('redefinirMfa: reset operacional por CLI', () => {
  test('sob a trava: fatores ATIVO e PENDENTE, lote, desafios, sessões e liberação anterior revogados; uma liberação CLI_RESET nova; nada de secret nem sessão', async (t) => {
    const servico = carregar();
    const x = preparar(t);
    const { pool, transacao } = bancoFalso();

    const r = await servico.redefinirMfa(pool, { email: 'Admin@SafeWork.com.br' });

    assert.deepEqual(x.ordem, ['buscarPorEmail', 'travarAdministrador', 'buscarTotpAtivo', 'revogar', 'revogarPendenteTotp', 'revogarAtivo', 'encerrarAbertos',
      'revogarTodasDoAdministrador', 'revogarAberta', 'criar', 'registrarOperacaoCli', 'registrarOperacaoCli', 'registrarOperacaoCli']);
    assert.equal(x.administrador.mock.calls[0].arguments[1], 'admin@safework.com.br');
    assert.deepEqual(x.ativo.mock.calls[0].arguments.slice(1), [ADMIN, { travar: true }]);
    assert.deepEqual(x.revogarFator.mock.calls[0].arguments[1], { administradorId: ADMIN, fatorId: '41', motivo: 'RESET_OPERACIONAL' });
    assert.deepEqual(x.revogarPendente.mock.calls[0].arguments[1], { administradorId: ADMIN, motivo: 'RESET_OPERACIONAL' });
    assert.deepEqual(x.revogarLote.mock.calls[0].arguments[1], { administradorId: ADMIN, motivo: 'RESET_OPERACIONAL' });
    assert.deepEqual(x.encerrarAbertos.mock.calls[0].arguments[1], { administradorId: ADMIN, motivo: 'RESET_OPERACIONAL' });
    assert.deepEqual(x.revogarSessoes.mock.calls[0].arguments.slice(1, 3), [ADMIN, 'MFA_RESET_OPERACIONAL']);
    const liberacao = x.criarLiberacao.mock.calls[0].arguments[1];
    assert.deepEqual([liberacao.origem, liberacao.validadeMinutos], ['CLI_RESET', authConfig.liberacaoMfa.expiracaoMinutos]);
    assert.equal(liberacao.codigoHash, codigosMfa.hashCodigoLiberacao({ administradorId: ADMIN, codigo: codigosMfa.normalizarCodigo(r.codigo) }));

    const auditorias = x.auditarCli.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(auditorias.map((a) => [a.acao, a.administradorAfetadoId]), [
      ['MFA_RESET_OPERACIONAL', ADMIN], ['LIBERACAO_CADASTRO_CRIADA', ADMIN], ['SESSOES_ADMINISTRADOR_REVOGADAS', ADMIN],
    ]);
    assert.deepEqual(auditorias[0].contexto, { origem: 'CLI_RESET', fatores: 2, desafios: 2, loteRevogado: true });
    assert.deepEqual(auditorias[2].contexto, { motivo: 'MFA_RESET_OPERACIONAL', quantidade: 3 });
    assert.equal(JSON.stringify(auditorias).includes(codigosMfa.normalizarCodigo(r.codigo)), false);
    for (const nome of ['auditarAdministrador', 'criarSessao', 'criarPendente', 'cifrar']) assert.equal(x[nome].mock.calls.length, 0, nome);

    assert.deepEqual(Object.keys(r).sort(), ['administradorId', 'codigo', 'expiraEm']);
    assert.match(r.codigo, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    assert.deepEqual([transacao.filter((q) => q === 'COMMIT').length, transacao.filter((q) => q === 'ROLLBACK').length], [1, 0]);
  });

  test('sem fator ATIVO: revoga só o que houver e segue', async (t) => {
    const servico = carregar();
    const x = preparar(t, { ativo: null });
    await servico.redefinirMfa(bancoFalso().pool, { email: 'admin@safework.com.br' });
    assert.equal(x.revogarFator.mock.calls.length, 0);
    assert.equal(x.revogarPendente.mock.calls.length, 1);
  });

  test('e-mail inválido ou administrador inexistente: erro controlado, nada alterado', async (t) => {
    const servico = carregar();
    let x = preparar(t);
    let banco = bancoFalso();
    await assert.rejects(() => servico.redefinirMfa(banco.pool, { email: 'nao-e-email' }), (e) => e instanceof servico.ErroResetMfa && e.motivo === 'EMAIL_INVALIDO');
    assert.equal(banco.transacao.length, 0);
    t.mock.restoreAll();

    x = preparar(t, { administrador: null });
    banco = bancoFalso();
    await assert.rejects(() => servico.redefinirMfa(banco.pool, { email: 'ninguem@safework.com.br' }), (e) => e.motivo === 'ADMINISTRADOR_INEXISTENTE');
    assert.equal(x.travar.mock.calls.length + x.criarLiberacao.mock.calls.length, 0);
  });

  test('administrador inativo: recusado antes de qualquer alteração', async (t) => {
    const servico = carregar();
    const x = preparar(t, { administrador: { id: ADMIN, email: 'admin@safework.com.br', ativo: false } });

    await assert.rejects(
      () => servico.redefinirMfa(bancoFalso().pool, { email: 'admin@safework.com.br' }),
      (e) => e instanceof servico.ErroResetMfa && e.motivo === 'ADMINISTRADOR_INATIVO',
    );

    assert.deepEqual(x.ordem, ['buscarPorEmail']);
  });

  test('erro antes do COMMIT: ROLLBACK, nenhuma liberação devolvida', async (t) => {
    const servico = carregar();
    preparar(t, { revogarSessoes: () => { throw new Error('falha no banco'); } });
    const { pool, transacao } = bancoFalso();
    await assert.rejects(() => servico.redefinirMfa(pool, { email: 'admin@safework.com.br' }), /falha no banco/);
    assert.deepEqual([transacao.filter((q) => q === 'COMMIT').length, transacao.filter((q) => q === 'ROLLBACK').length], [0, 1]);
  });
});
