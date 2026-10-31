'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Repositório do histórico de situação do funcionário (RED), sem PostgreSQL: o que cada consulta pergunta e o que devolve.
 * O comportamento contra o banco real está em funcionario-situacao-datas*.integration.js (não executados nesta rodada).
 *
 * Colunas de retorno exigidas (aliases das consultas):
 *   registrar                    → id, registrado_em
 *   buscarUltimaDataEfetiva      → data_efetiva (texto AAAA-MM-DD)
 *   resumirEntregasPosteriores   → total, primeira_em, ultima_em (textos AAAA-MM-DD)
 */

const EMPRESA = 42;
const FUNC = 70;

function repo() {
  try {
    return require('../../src/repositories/funcionario-situacao.repository');
  } catch (erro) {
    return assert.fail(`repositório src/repositories/funcionario-situacao.repository.js ausente: ${erro.code ?? erro.message}`);
  }
}
const executor = (linhas = []) => {
  const chamadas = [];
  return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows: linhas, rowCount: linhas.length }; } };
};
const sql = (e) => e.chamadas.map((c) => c.texto).join('\n');

describe('registrar', () => {
  const dados = { empresaId: EMPRESA, funcionarioId: FUNC, situacaoAnterior: 'ATIVO', situacaoNova: 'AFASTADO', dataEfetiva: '2026-10-01', registradoPor: 7 };

  test('INSERT parametrizado em funcionario_situacoes, com empresa, funcionário, situações, data e ator; devolve id e instante do servidor', async () => {
    const instante = new Date('2026-10-11T01:30:00Z');
    const e = executor([{ id: '501', registrado_em: instante }]);
    const r = await repo().registrar(e, dados);
    assert.equal(e.chamadas.length, 1);
    assert.match(sql(e), /INSERT\s+INTO\s+funcionario_situacoes/i);
    assert.equal(e.chamadas[0].valores.length, 6);
    const valores = e.chamadas[0].valores.map(String).sort();
    assert.deepEqual(valores, [String(EMPRESA), String(FUNC), 'ATIVO', 'AFASTADO', '2026-10-01', '7'].sort());
    assert.deepEqual([r.id, r.registradoEm], ['501', instante]);
  });

  test('o instante do registro é do servidor: a lista de colunas do INSERT não inclui registrado_em (só o RETURNING)', async () => {
    const e = executor([{ id: '1', registrado_em: new Date() }]);
    await repo().registrar(e, dados);
    const antesDeValues = sql(e).split(/VALUES/i)[0];
    assert.doesNotMatch(antesDeValues, /registrado_em/i);
    assert.match(sql(e), /RETURNING[^;]*registrado_em/i);
  });

  test('sem motivo, descrição, observação nem previsão: nenhuma dessas colunas aparece no SQL', async () => {
    const e = executor([{ id: '1', registrado_em: new Date() }]);
    await repo().registrar(e, dados);
    assert.doesNotMatch(sql(e), /motivo|descricao|observacao|previsao|conflito/i);
  });

  test('data nula é aceita (INATIVO → ATIVO) e viaja como null', async () => {
    const e = executor([{ id: '1', registrado_em: new Date() }]);
    await repo().registrar(e, { ...dados, situacaoAnterior: 'INATIVO', situacaoNova: 'ATIVO', dataEfetiva: null });
    assert.ok(e.chamadas[0].valores.includes(null));
  });

  test('exige empresa, funcionário e ator inteiros positivos (nunca vindos de objeto qualquer)', async () => {
    for (const ruim of [{ empresaId: 0 }, { funcionarioId: -1 }, { registradoPor: 'x' }, { empresaId: undefined }]) {
      await assert.rejects(repo().registrar(executor(), { ...dados, ...ruim }), TypeError, JSON.stringify(ruim));
    }
  });
});

describe('buscarUltimaDataEfetiva', () => {
  test('filtra sempre por empresa e funcionário, considera só linhas com data e devolve a mais recente como texto', async () => {
    const e = executor([{ data_efetiva: '2026-09-10' }]);
    const r = await repo().buscarUltimaDataEfetiva(e, EMPRESA, FUNC);
    assert.equal(r, '2026-09-10');
    assert.deepEqual(e.chamadas[0].valores, [EMPRESA, FUNC]);
    assert.match(sql(e), /empresa_id\s*=\s*\$1/i);
    assert.match(sql(e), /funcionario_id\s*=\s*\$2/i);
    assert.match(sql(e), /data_efetiva\s+IS\s+NOT\s+NULL/i);
    assert.match(sql(e), /ORDER\s+BY|MAX\s*\(/i);
  });

  test('sem nenhuma linha: null (nenhuma data é inventada para o legado)', async () => {
    assert.equal(await repo().buscarUltimaDataEfetiva(executor([]), EMPRESA, FUNC), null);
    assert.equal(await repo().buscarUltimaDataEfetiva(executor([{ data_efetiva: null }]), EMPRESA, FUNC), null);
  });
});

describe('buscarPrimeiraDataEfetiva', () => {
  test('filtra sempre por empresa e funcionário, considera só linhas com data e devolve a mais antiga como texto', async () => {
    const e = executor([{ data_efetiva: '2026-03-02' }]);
    const r = await repo().buscarPrimeiraDataEfetiva(e, EMPRESA, FUNC);
    assert.equal(r, '2026-03-02');
    assert.deepEqual(e.chamadas[0].valores, [EMPRESA, FUNC]);
    assert.match(sql(e), /empresa_id\s*=\s*\$1/i);
    assert.match(sql(e), /funcionario_id\s*=\s*\$2/i);
    assert.match(sql(e), /data_efetiva\s+IS\s+NOT\s+NULL/i);
    assert.match(sql(e), /MIN\s*\(/i);
    assert.doesNotMatch(sql(e), /\b(INSERT|UPDATE|DELETE)\b/i, 'só lê');
  });

  test('sem nenhuma linha com data: null (nenhuma data é inventada para o legado)', async () => {
    assert.equal(await repo().buscarPrimeiraDataEfetiva(executor([]), EMPRESA, FUNC), null);
    assert.equal(await repo().buscarPrimeiraDataEfetiva(executor([{ data_efetiva: null }]), EMPRESA, FUNC), null);
  });

  test('recusa identificadores inválidos antes de consultar', async () => {
    const e = executor();
    for (const [empresa, funcionario] of [[0, FUNC], [EMPRESA, -1], [null, FUNC], [EMPRESA, '70'], [1.5, FUNC]]) {
      await assert.rejects(() => repo().buscarPrimeiraDataEfetiva(e, empresa, funcionario), TypeError);
    }
    assert.equal(e.chamadas.length, 0);
  });
});

describe('resumirEntregasPosteriores', () => {
  test('compara data_operacional (data civil da entrega) ESTRITAMENTE maior que a data efetiva, da ficha do funcionário, na empresa', async () => {
    const e = executor([{ total: 2, primeira_em: '2026-10-05', ultima_em: '2026-10-08' }]);
    const r = await repo().resumirEntregasPosteriores(e, EMPRESA, FUNC, '2026-10-01');
    assert.deepEqual(e.chamadas[0].valores, [EMPRESA, FUNC, '2026-10-01']);
    const texto = sql(e);
    assert.match(texto, /entregas_epi/i);
    assert.match(texto, /fichas_epi/i);
    assert.match(texto, /data_operacional\s*>\s*\$3/i, 'estritamente posterior: o mesmo dia não conflita');
    assert.doesNotMatch(texto, /data_operacional\s*>=/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /funcionario_id\s*=\s*\$2/i);
    assert.deepEqual(r, { total: 2, primeiraEm: '2026-10-05', ultimaEm: '2026-10-08' });
  });

  test('nunca usa entregue_em, criado_em nem conversão de fuso para decidir (a data civil já está gravada)', async () => {
    const e = executor([{ total: 0, primeira_em: null, ultima_em: null }]);
    await repo().resumirEntregasPosteriores(e, EMPRESA, FUNC, '2026-10-01');
    assert.doesNotMatch(sql(e), /entregue_em\s*(>|<|=|::date)|AT\s+TIME\s+ZONE|criado_em|criada_em/i);
  });

  test('não filtra por origem: entregas diretas e por solicitação contam', async () => {
    const e = executor([{ total: 0, primeira_em: null, ultima_em: null }]);
    await repo().resumirEntregasPosteriores(e, EMPRESA, FUNC, '2026-10-01');
    assert.doesNotMatch(sql(e), /origem/i);
  });

  test('sem entregas posteriores devolve total 0 e datas nulas', async () => {
    const r = await repo().resumirEntregasPosteriores(executor([{ total: 0, primeira_em: null, ultima_em: null }]), EMPRESA, FUNC, '2026-10-01');
    assert.deepEqual(r, { total: 0, primeiraEm: null, ultimaEm: null });
  });

  test('o total vem como número inteiro mesmo que o driver devolva texto (bigint)', async () => {
    const r = await repo().resumirEntregasPosteriores(executor([{ total: '3', primeira_em: '2026-10-05', ultima_em: '2026-10-08' }]), EMPRESA, FUNC, '2026-10-01');
    assert.equal(r.total, 3);
    assert.equal(typeof r.total, 'number');
  });

  test('data efetiva fora do formato é recusada antes de consultar', async () => {
    const e = executor();
    await assert.rejects(repo().resumirEntregasPosteriores(e, EMPRESA, FUNC, '01/10/2026'), TypeError);
    assert.equal(e.chamadas.length, 0);
  });
});
