'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/convite-usuario.service');
const autoridade = require('../../src/services/autoridade-administrativa');
const conviteRepo = require('../../src/repositories/convite-usuario.repository');
const usuarioAdministracaoRepo = require('../../src/repositories/usuario-administracao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');

/**
 * Testes unitários do convite de usuário (Bloco 9, parte F), sem
 * PostgreSQL. Foco no que a auditoria da criação grava (SEC-023/PRIV-001):
 * o registro funcional do convite guarda e-mail, nome, perfil e expiração;
 * logs_auditoria só aponta para ele. Repositórios mockados por namespace.
 */

const EMPRESA_ID = 3;
const ATOR = Object.freeze({ id: 5, perfil: 'MASTER', ativo: true });
const EMAIL = 'Pessoa.Convidada@Exemplo-Cliente.com.br';
const EMAIL_N = 'pessoa.convidada@exemplo-cliente.com.br';
const NOME = 'Pessoa Convidada da Silva';
const agora = new Date('2026-09-27T12:00:00Z');

function clienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (t) => { chamadas.push(t); return /clock_timestamp/.test(t) ? { rows: [{ agora }] } : { rows: [], rowCount: 0 }; },
    release: () => chamadas.push('RELEASE'),
  };
}
const poolFalso = (cliente) => ({ connect: async () => cliente });

function mundoDaCriacao(t) {
  t.mock.method(autoridade, 'exigirAutoridadeAdministrativa', async () => ATOR);
  t.mock.method(usuarioAdministracaoRepo, 'buscarVinculoPorEmail', async () => null);
  t.mock.method(conviteRepo, 'buscarPendentePorEmailParaAtualizacao', async () => null);
  const criar = t.mock.method(conviteRepo, 'criar', async (_, d) => ({
    id: '41', empresaId: d.empresaId, emailConvite: d.emailConvite, nome: d.nome, perfil: d.perfil,
    situacao: 'PENDENTE', criadoEm: agora, expiraEm: d.expiraEm, canceladoEm: null,
  }));
  const audit = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1' }));
  return { criar, audit };
}

describe('criar — SEC-023/PRIV-001: auditoria sem PII do convite', () => {
  test('dadosNovos leva só conviteId: sem e-mail, nome, perfil, expiração, token ou hash', async (t) => {
    const { criar, audit } = mundoDaCriacao(t);

    const r = await servico.criar(poolFalso(clienteFalso()), {
      empresaId: EMPRESA_ID, atorId: ATOR.id, email: EMAIL, nome: NOME, perfil: 'SUPERVISOR', ip: '10.0.0.1', dispositivo: 'Navegador',
    });

    assert.equal(audit.mock.calls.length, 1);
    const registro = audit.mock.calls[0].arguments[1];
    assert.deepEqual(registro.dadosNovos, { conviteId: '41' });
    assert.equal(registro.empresaId, EMPRESA_ID);
    assert.equal(registro.usuarioId, ATOR.id);
    assert.equal(registro.acao, 'USUARIO_CONVIDADO');
    assert.equal(registro.referencia, '41');
    assert.deepEqual(registro.contexto, { origem: 'administracao_usuarios' });

    const tokenHash = criar.mock.calls[0].arguments[1].tokenHash;
    const texto = JSON.stringify(registro);
    for (const dado of [EMAIL_N, 'pessoa.convidada', NOME, 'SUPERVISOR', 'expiraEm', r.token, tokenHash]) {
      assert.equal(texto.includes(dado), false, dado);
    }
  });

  test('o registro funcional do convite e a resposta continuam com e-mail, nome, perfil e expiração', async (t) => {
    const { criar } = mundoDaCriacao(t);

    const r = await servico.criar(poolFalso(clienteFalso()), {
      empresaId: EMPRESA_ID, atorId: ATOR.id, email: EMAIL, nome: NOME, perfil: 'SUPERVISOR',
    });

    const gravado = criar.mock.calls[0].arguments[1];
    assert.equal(gravado.emailConvite, EMAIL_N);
    assert.equal(gravado.nome, NOME);
    assert.equal(gravado.perfil, 'SUPERVISOR');
    assert.ok(gravado.expiraEm instanceof Date && gravado.expiraEm > agora);
    assert.equal(r.convite.id, '41');
    assert.equal(r.convite.emailConvite, EMAIL_N);
    assert.equal(r.convite.nome, NOME);
    assert.equal(r.convite.perfil, 'SUPERVISOR');
    assert.equal(r.convite.expiraEm, gravado.expiraEm);
  });
});
