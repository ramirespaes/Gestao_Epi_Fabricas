'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/usuario-administracao.service');
const autoridade = require('../../src/services/autoridade-administrativa');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const usuarioAdmRepo = require('../../src/repositories/usuario-administracao.repository');
const usuarioIpRepo = require('../../src/repositories/usuario-ip.repository');
const grupoAcessoRepo = require('../../src/repositories/grupo-acesso.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const password = require('../../src/security/password');

/**
 * Atomicidade da criação do usuário administrativo: identidade (com CPF),
 * vínculo (matrícula, setor, horário, grupo) e IPs permitidos nascem na MESMA
 * transação. Se qualquer passo falhar depois dos primeiros INSERTs, a
 * transação é desfeita (ROLLBACK, nunca COMMIT) e nada é auditado — nenhum
 * cadastro pela metade. Repositórios e hash são dublês; a ordem e os
 * comandos da transação são reais.
 */

const EMPRESA = 3;
const ATOR = 7;
const ENTRADA = {
  empresaId: EMPRESA, atorId: ATOR, nome: 'Pessoa Nova', email: 'pessoa.nova@example.invalid', perfil: 'USUARIO',
  senhaProvisoria: 'cometa-lanterna-ardosia-77', cpf: '52998224725', matricula: 'ADM-001', setor: 'Recursos Humanos',
  horarioTrabalho: { inicio: '08:00', fim: '18:00' }, ipsPermitidos: ['203.0.113.10', '2001:db8::10'], grupoAcessoId: 4,
};

function clienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => {
      chamadas.push(String(texto));
      if (/clock_timestamp/.test(texto)) return { rows: [{ agora: new Date('2026-10-05T15:00:00-03:00') }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => { chamadas.push('RELEASE'); },
  };
}
const poolFalso = (cliente) => ({ connect: async () => cliente, query: (...args) => cliente.query(...args) });

function mundo(t, { falharEm } = {}) {
  t.mock.method(autoridade, 'exigirAutoridadeAdministrativa', async () => ({ id: ATOR, perfil: 'MASTER', ativo: true }));
  t.mock.method(password, 'gerarHashSenha', async () => '$argon2id$falso');
  t.mock.method(identidadeRepo, 'buscarPorEmail', async () => null);
  t.mock.method(identidadeRepo, 'buscarPorCpf', async () => null);
  t.mock.method(usuarioAdmRepo, 'buscarVinculoPorEmail', async () => null);
  t.mock.method(usuarioAdmRepo, 'buscarPorId', async () => ({ id: 5, nome: 'Pessoa Nova', email: 'pessoa.nova@example.invalid', perfil: 'USUARIO', ativo: true, criadoEm: new Date(), grupo: { nome: 'RH', ativo: true } }));
  t.mock.method(usuarioRepo, 'existeMatricula', async () => false);
  t.mock.method(grupoAcessoRepo, 'buscarPorId', async () => ({ id: 4, nome: 'RH', ativo: true }));
  const passos = {
    identidade: t.mock.method(identidadeRepo, 'criar', async () => { if (falharEm === 'identidade') throw new Error('falha simulada'); return { id: 9, email: ENTRADA.email, cpf: ENTRADA.cpf }; }),
    usuario: t.mock.method(usuarioRepo, 'criar', async () => { if (falharEm === 'usuario') throw new Error('falha simulada'); return { id: 5, identidadeId: 9 }; }),
    ips: t.mock.method(usuarioIpRepo, 'inserir', async () => { if (falharEm === 'ips') throw new Error('falha simulada'); return ENTRADA.ipsPermitidos; }),
    auditoria: t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '77', criadoEm: new Date() })),
  };
  return passos;
}
const contar = (chamadas, padrao) => chamadas.filter((c) => padrao.test(c)).length;

describe('criação do usuário administrativo — uma transação só', () => {
  test('caminho feliz: identidade com CPF, vínculo com matrícula/setor/horário/grupo e os IPs nascem entre BEGIN e COMMIT, com auditoria sem CPF, senha ou IP', async (t) => {
    const passos = mundo(t);
    const cliente = clienteFalso();
    const r = await servico.criar(poolFalso(cliente), ENTRADA);
    assert.deepEqual([contar(cliente.chamadas, /^BEGIN$/), contar(cliente.chamadas, /^COMMIT$/), contar(cliente.chamadas, /^ROLLBACK$/)], [1, 1, 0]);
    assert.ok(cliente.chamadas.some((c) => /pg_advisory_xact_lock/.test(c)), 'trava da empresa');
    assert.equal(passos.identidade.mock.calls[0].arguments[1].cpf, ENTRADA.cpf);
    const vinculo = passos.usuario.mock.calls[0].arguments[1];
    assert.deepEqual([vinculo.matricula, vinculo.setor, vinculo.horarioTrabalho, vinculo.grupoAcessoId], ['ADM-001', 'Recursos Humanos', { inicio: '08:00', fim: '18:00' }, 4]);
    assert.deepEqual(passos.ips.mock.calls[0].arguments[1], { empresaId: EMPRESA, usuarioId: 5, ips: ['203.0.113.10', '2001:db8::10'] });
    const auditoria = passos.auditoria.mock.calls[0].arguments[1];
    const texto = JSON.stringify(auditoria);
    assert.equal(/52998224725|203\.0\.113|2001:db8|cometa|argon2/.test(texto), false, 'auditoria sem CPF, IP ou senha');
    assert.equal(auditoria.dadosNovos.ipsPermitidos, 2);
    assert.equal(auditoria.dadosNovos.temCpf, true);
    assert.deepEqual(r.administrativo, { cpfMascarado: '***.***.***-25', matricula: 'ADM-001', setor: 'Recursos Humanos', horarioTrabalho: { inicio: '08:00', fim: '18:00' }, ipsPermitidos: ['203.0.113.10', '2001:db8::10'], grupoAcessoId: 4 });
    assert.equal(JSON.stringify(r).includes(ENTRADA.cpf), false, 'o CPF nunca volta em claro');
  });

  test('falha ao gravar os IPs: ROLLBACK, nenhum COMMIT, nenhuma auditoria — identidade e vínculo já inseridos são desfeitos com a transação', async (t) => {
    const passos = mundo(t, { falharEm: 'ips' });
    const cliente = clienteFalso();
    await assert.rejects(() => servico.criar(poolFalso(cliente), ENTRADA), /falha simulada/);
    assert.deepEqual([contar(cliente.chamadas, /^BEGIN$/), contar(cliente.chamadas, /^COMMIT$/), contar(cliente.chamadas, /^ROLLBACK$/)], [1, 0, 1]);
    assert.equal(passos.identidade.mock.calls.length, 1, 'a identidade chegou a ser inserida na transação…');
    assert.equal(passos.usuario.mock.calls.length, 1, '…e o vínculo também: os dois caem com o ROLLBACK');
    assert.equal(passos.auditoria.mock.calls.length, 0);
  });

  test('falha ao gravar o vínculo: ROLLBACK depois da identidade, sem IPs e sem auditoria', async (t) => {
    const passos = mundo(t, { falharEm: 'usuario' });
    const cliente = clienteFalso();
    await assert.rejects(() => servico.criar(poolFalso(cliente), ENTRADA), /falha simulada/);
    assert.deepEqual([contar(cliente.chamadas, /^COMMIT$/), contar(cliente.chamadas, /^ROLLBACK$/)], [0, 1]);
    assert.deepEqual([passos.ips.mock.calls.length, passos.auditoria.mock.calls.length], [0, 0]);
  });

  test('sem IPs, sem horário e sem grupo: nada é inserido na tabela de IPs e o vínculo nasce com os opcionais nulos', async (t) => {
    const passos = mundo(t);
    const cliente = clienteFalso();
    const r = await servico.criar(poolFalso(cliente), { ...ENTRADA, horarioTrabalho: null, ipsPermitidos: [], grupoAcessoId: null });
    assert.equal(passos.ips.mock.calls.length, 0);
    const vinculo = passos.usuario.mock.calls[0].arguments[1];
    assert.deepEqual([vinculo.horarioTrabalho, vinculo.grupoAcessoId], [null, null]);
    assert.deepEqual(r.administrativo.ipsPermitidos, []);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });
});
