'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/funcionario.service');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { TIPO_POR_ACAO } = require('../../src/services/relatorio-auditoria.service');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Revelação do CPF na edição (RED), sem PostgreSQL: o serviço lê o funcionário DA EMPRESA DA SESSÃO dentro de uma transação,
 * grava a auditoria `FUNCIONARIO_CPF_CONSULTADO` na MESMA transação (só metadados) e só então devolve o CPF. Falha da auditoria
 * ou funcionário de outra empresa não devolvem CPF algum.
 */

const EMPRESA = 42;
const OUTRA_EMPRESA = 99;
const ATOR = 7;
const FUNC = 70;
const CPF = '52998224725';
const IP = '203.0.113.9';
const DISPOSITIVO = 'Navegador de teste';

const existente = { id: FUNC, empresaId: EMPRESA, nome: 'Tício de Tal', cpf: CPF, matricula: 'MAT-000171', telefone: '47999990000', dataNascimento: '1990-03-15' };

function clienteFalso() {
  const chamadas = [];
  return { chamadas, query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; }, release: () => { chamadas.push('RELEASE'); } };
}
const poolFalso = (cliente) => ({ connect: async () => cliente, query: (...a) => cliente.query(...a) });

function mundo(t, cliente, { registrar } = {}) {
  const buscarPorId = t.mock.method(funcionarioRepo, 'buscarPorId', async (executor, empresaId, id) => (empresaId === EMPRESA && id === FUNC ? { ...existente } : null));
  const registrarMock = t.mock.method(auditoriaRepo, 'registrar', registrar ?? (async () => { cliente.chamadas.push('AUDITORIA'); return { id: '1', criadoEm: new Date() }; }));
  return { buscarPorId, registrar: registrarMock };
}
const revelar = (...args) => {
  assert.equal(typeof servico.revelarCpf, 'function', 'funcionario.service.revelarCpf ainda não existe');
  return servico.revelarCpf(...args);
};
const dados = (extra = {}) => ({ empresaId: EMPRESA, atorId: ATOR, funcionarioId: FUNC, ip: IP, dispositivo: DISPOSITIVO, ...extra });

describe('revelarCpf', () => {
  test('o nome do evento é FUNCIONARIO_CPF_CONSULTADO e ele entra no catálogo da Auditoria como funcionário (FUN)', () => {
    assert.equal(servico.ACAO_AUDITORIA_CPF_CONSULTADO, 'FUNCIONARIO_CPF_CONSULTADO');
    assert.equal(TIPO_POR_ACAO.FUNCIONARIO_CPF_CONSULTADO, 'FUN');
  });

  test('devolve só o CPF completo do funcionário da empresa informada, lido na transação (não no pool)', async (t) => {
    const cliente = clienteFalso();
    const m = mundo(t, cliente);
    const r = await revelar(poolFalso(cliente), dados());
    assert.deepEqual(r, { cpf: CPF });
    assert.equal(m.buscarPorId.mock.calls.length, 1);
    const [executor, empresaId, id] = m.buscarPorId.mock.calls[0].arguments;
    assert.equal(executor, cliente);
    assert.equal(empresaId, EMPRESA);
    assert.equal(id, FUNC);
  });

  test('audita uma vez, na mesma transação e ANTES do COMMIT, só com metadados seguros', async (t) => {
    const cliente = clienteFalso();
    const m = mundo(t, cliente);
    await revelar(poolFalso(cliente), dados());
    assert.equal(m.registrar.mock.calls.length, 1);
    const [executor, auditoria] = m.registrar.mock.calls[0].arguments;
    assert.equal(executor, cliente, 'a auditoria usa o client da transação');
    assert.equal(auditoria.acao, 'FUNCIONARIO_CPF_CONSULTADO');
    assert.equal(auditoria.empresaId, EMPRESA);
    assert.equal(auditoria.usuarioId, ATOR);
    assert.equal(auditoria.referencia, String(FUNC));
    assert.equal(auditoria.ip, IP);
    assert.equal(auditoria.dispositivo, DISPOSITIVO);
    assert.deepEqual(auditoria.contexto, { finalidade: 'EDICAO' });
    assert.ok(auditoria.dadosAnteriores == null && auditoria.dadosNovos == null, 'sem dados antes/depois');
    const ordem = cliente.chamadas.filter((c) => ['BEGIN', 'AUDITORIA', 'COMMIT', 'ROLLBACK'].includes(c));
    assert.deepEqual(ordem, ['BEGIN', 'AUDITORIA', 'COMMIT']);
  });

  test('a auditoria não carrega o CPF (completo, formatado ou mascarado), nem telefone, nascimento ou resposta', async (t) => {
    const cliente = clienteFalso();
    const m = mundo(t, cliente);
    await revelar(poolFalso(cliente), dados());
    const texto = JSON.stringify(m.registrar.mock.calls[0].arguments[1]);
    for (const proibido of [CPF, '529.982.247-25', '529.982', '***', '-25', '47999990000', '1990-03-15']) {
      assert.equal(texto.includes(proibido), false, `auditoria contém ${proibido}`);
    }
    const auditoria = m.registrar.mock.calls[0].arguments[1];
    assert.deepEqual(Object.keys(auditoria.contexto), ['finalidade'], 'o contexto só tem a finalidade (nenhuma chave cpf)');
  });

  test('funcionário de outra empresa ou inexistente: o mesmo 404, sem auditoria, com ROLLBACK', async (t) => {
    for (const alvo of [dados({ empresaId: OUTRA_EMPRESA }), dados({ funcionarioId: 123456 })]) {
      const cliente = clienteFalso();
      const m = mundo(t, cliente);
      let erro;
      await assert.rejects(revelar(poolFalso(cliente), alvo), (e) => { erro = e; return true; });
      assert.ok(HttpError.ehHttpError(erro));
      assert.equal(erro.status, 404);
      assert.equal(erro.codigo, 'FUNCIONARIO_NAO_ENCONTRADO');
      assert.equal(m.registrar.mock.calls.length, 0);
      assert.ok(cliente.chamadas.includes('ROLLBACK') && !cliente.chamadas.includes('COMMIT'));
      assert.equal(JSON.stringify(erro.message).includes(CPF), false);
      t.mock.restoreAll();
    }
  });

  test('falha da auditoria: nada é devolvido, ROLLBACK, e o erro não carrega o CPF', async (t) => {
    const cliente = clienteFalso();
    mundo(t, cliente, { registrar: async () => { throw new Error('falha simulada da auditoria'); } });
    let erro;
    await assert.rejects(revelar(poolFalso(cliente), dados()), (e) => { erro = e; return true; });
    assert.equal(String(erro.message).includes(CPF), false);
    assert.ok(cliente.chamadas.includes('ROLLBACK') && !cliente.chamadas.includes('COMMIT'));
    assert.ok(cliente.chamadas.includes('RELEASE'));
  });

  test('exige empresa, ator e funcionário válidos (inteiros positivos); nada é consultado antes', async (t) => {
    const cliente = clienteFalso();
    const m = mundo(t, cliente);
    for (const ruim of [{ empresaId: 0 }, { empresaId: '42' }, { atorId: null }, { atorId: -1 }, { funcionarioId: 0 }, { funcionarioId: '70' }]) {
      await assert.rejects(revelar(poolFalso(cliente), dados(ruim)), TypeError, JSON.stringify(ruim));
    }
    assert.equal(m.buscarPorId.mock.calls.length, 0);
    assert.equal(m.registrar.mock.calls.length, 0);
  });

  test('não aceita CPF, empresa ou escopo vindos do chamador além do contrato (campos extras são ignorados, nunca usados)', async (t) => {
    const cliente = clienteFalso();
    const m = mundo(t, cliente);
    const r = await revelar(poolFalso(cliente), dados({ cpf: '11111111111', empresaIdDoCorpo: OUTRA_EMPRESA }));
    assert.deepEqual(r, { cpf: CPF });
    assert.equal(m.buscarPorId.mock.calls[0].arguments[1], EMPRESA);
  });
});
