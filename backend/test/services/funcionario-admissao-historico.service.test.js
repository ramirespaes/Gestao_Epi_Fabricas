'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/funcionario.service');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');
const gheRepo = require('../../src/repositories/grupo-homogeneo-exposicao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const situacaoRepo = require('../../src/repositories/funcionario-situacao.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Edição da data de admissão × histórico imutável de situações (achado A1 do parecer independente de 30/10/2026).
 *
 * Regra: a admissão nunca pode passar a ser POSTERIOR à primeira data efetiva já registrada do funcionário (a mesma relação que a
 * mudança de situação confere no sentido inverso: data efetiva < admissão é recusada; igual vale). A conferência é feita sob a
 * trava FOR UPDATE do funcionário, na mesma transação da alteração; a recusa é 409 FUNCIONARIO_DATA_ADMISSAO_POSTERIOR_A_SITUACAO,
 * com o limite (a primeira data efetiva) em `detalhes`, e nada é gravado nem auditado. Sem histórico (legado) ou sem mudança da
 * admissão, nenhuma consulta é feita. Mexer em outros campos nunca é afetado.
 */

const EMPRESA = 42;
const ATOR = 7;
const FUNC = 70;
const HOJE = '2026-10-30';

const funcionario = (extra = {}) => ({
  id: FUNC, empresaId: EMPRESA, grupoHomogeneoId: null, matricula: 'MAT-1', nome: 'Tício de Tal', cpf: '52998224725',
  dataNascimento: '1990-03-15', dataAdmissao: '2020-06-01', setor: 'Manutenção', funcao: 'Mecânico', cracha: null, telefone: null,
  situacao: 'INATIVO', ativo: false, criadoEm: new Date('2026-09-23T12:00:00Z'), atualizadoEm: new Date('2026-09-23T12:00:00Z'), ...extra,
});

function mundo(t, { existente = funcionario(), primeira = null } = {}) {
  const ordem = [];
  const cliente = {
    query: async (texto) => { if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(texto)) ordem.push(texto); return { rows: [], rowCount: 0 }; },
    release: () => {},
  };
  const m = { ordem, pool: { connect: async () => cliente, query: (...a) => cliente.query(...a) } };
  m.travar = t.mock.method(funcionarioRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => {
    ordem.push('travar');
    return existente !== null && empresaId === existente.empresaId && id === existente.id ? existente : null;
  });
  m.primeira = t.mock.method(situacaoRepo, 'buscarPrimeiraDataEfetiva', async () => { ordem.push('primeira'); return primeira; });
  m.atualizar = t.mock.method(funcionarioRepo, 'atualizar', async (_c, _e, _id, campos) => {
    ordem.push('atualizar');
    return funcionario({ ...existente, dataAdmissao: campos.dataAdmissaoInformado ? campos.dataAdmissao : existente.dataAdmissao, setor: campos.setorInformado ? campos.setor : existente.setor });
  });
  m.auditoria = t.mock.method(auditoriaRepo, 'registrar', async () => { ordem.push('auditoria'); return { id: '1', criadoEm: new Date() }; });
  t.mock.method(gheRepo, 'resumirPorIds', async () => new Map());
  return m;
}

const base = { empresaId: EMPRESA, atorId: ATOR, funcionarioId: FUNC, hoje: HOJE };
const alterar = (m, extra) => servico.alterar(m.pool, { ...base, ...extra });
async function recusa(promessa) {
  let erro = null;
  try { await promessa; } catch (e) { erro = e; }
  assert.ok(erro !== null, 'a alteração deveria ter sido recusada');
  assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro.name}: ${erro.message}`);
  return erro;
}

describe('admissão × primeira data efetiva do histórico', () => {
  test('admissão POSTERIOR à primeira data efetiva: 409 com o limite, ROLLBACK, nada gravado nem auditado', async (t) => {
    const m = mundo(t, { primeira: '2026-10-15' });
    const erro = await recusa(alterar(m, { dataAdmissao: '2026-10-20', dataAdmissaoInformado: true }));
    assert.equal(erro.status, 409);
    assert.equal(erro.codigo, 'FUNCIONARIO_DATA_ADMISSAO_POSTERIOR_A_SITUACAO');
    assert.deepEqual(erro.detalhes, { limite: '2026-10-15' });
    assert.equal(m.atualizar.mock.calls.length, 0);
    assert.equal(m.auditoria.mock.calls.length, 0);
    assert.equal(m.ordem.filter((x) => x === 'ROLLBACK').length, 1);
    assert.equal(m.ordem.filter((x) => x === 'COMMIT').length, 0);
    assert.doesNotMatch(erro.message, /\d{4}-\d{2}-\d{2}/, 'a mensagem não ecoa datas');
  });

  test('admissão IGUAL à primeira data efetiva vale (o mesmo critério da mudança de situação)', async (t) => {
    const m = mundo(t, { primeira: '2026-10-15' });
    const r = await alterar(m, { dataAdmissao: '2026-10-15', dataAdmissaoInformado: true });
    assert.equal(r.dataAdmissao, '2026-10-15');
    assert.equal(m.atualizar.mock.calls.length, 1);
  });

  test('admissão ANTERIOR à primeira data efetiva vale', async (t) => {
    const m = mundo(t, { primeira: '2026-10-15' });
    await alterar(m, { dataAdmissao: '2026-10-14', dataAdmissaoInformado: true });
    assert.equal(m.atualizar.mock.calls.length, 1);
  });

  test('a consulta vem DEPOIS da trava do funcionário e ANTES do UPDATE, na mesma transação', async (t) => {
    const m = mundo(t, { primeira: '2026-10-15' });
    await alterar(m, { dataAdmissao: '2026-10-01', dataAdmissaoInformado: true });
    const ordem = m.ordem.filter((x) => ['BEGIN', 'travar', 'primeira', 'atualizar', 'COMMIT'].includes(x));
    assert.deepEqual(ordem, ['BEGIN', 'travar', 'primeira', 'atualizar', 'COMMIT']);
    assert.deepEqual(m.primeira.mock.calls[0].arguments.slice(1), [EMPRESA, FUNC]);
  });

  test('funcionário sem histórico com data (legado ou nunca mudou de situação): nenhum limite é inventado', async (t) => {
    const m = mundo(t, { primeira: null });
    await alterar(m, { dataAdmissao: '2026-10-29', dataAdmissaoInformado: true });
    assert.equal(m.atualizar.mock.calls.length, 1);
  });

  test('só consulta o histórico quando a admissão realmente muda: outros campos, admissão igual e admissão nula não consultam', async (t) => {
    const outros = mundo(t, { primeira: '2026-10-15' });
    await alterar(outros, { setor: 'Caldeiraria', setorInformado: true });
    const igual = mundo(t, { primeira: '2026-10-15' });
    await alterar(igual, { dataAdmissao: '2020-06-01', dataAdmissaoInformado: true });
    const nula = mundo(t, { primeira: '2026-10-15' });
    await alterar(nula, { dataAdmissao: null, dataAdmissaoInformado: true });
    for (const m of [outros, igual, nula]) {
      assert.equal(m.primeira.mock.calls.length, 0);
      assert.equal(m.atualizar.mock.calls.length, 1);
    }
  });

  test('a recusa vale mesmo junto de outros campos no mesmo PATCH: nada é parcialmente gravado', async (t) => {
    const m = mundo(t, { primeira: '2026-10-15' });
    const erro = await recusa(alterar(m, { dataAdmissao: '2026-10-20', dataAdmissaoInformado: true, setor: 'Outro', setorInformado: true }));
    assert.equal(erro.codigo, 'FUNCIONARIO_DATA_ADMISSAO_POSTERIOR_A_SITUACAO');
    assert.equal(m.atualizar.mock.calls.length, 0);
  });

  test('funcionário inexistente nesta empresa continua 404, sem consultar o histórico', async (t) => {
    const m = mundo(t, { existente: funcionario({ empresaId: 99 }), primeira: '2026-10-15' });
    const erro = await recusa(alterar(m, { dataAdmissao: '2026-10-20', dataAdmissaoInformado: true }));
    assert.equal(erro.status, 404);
    assert.equal(m.primeira.mock.calls.length, 0);
  });

  test('as validações anteriores seguem na frente: admissão futura continua 400 e nem abre transação', async (t) => {
    const m = mundo(t, { primeira: '2026-10-15' });
    const erro = await recusa(alterar(m, { dataAdmissao: '2026-12-01', dataAdmissaoInformado: true }));
    assert.equal(erro.status, 400);
    assert.equal(m.primeira.mock.calls.length, 0);
  });
});
