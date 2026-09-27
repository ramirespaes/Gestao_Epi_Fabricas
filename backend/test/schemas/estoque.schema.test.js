'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const estoque = require('../../src/schemas/estoque.schema');

/** Testes do schema de estoque por lote (Bloco 9). */

const CHAVE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

describe('quantidade — teto do INTEGER do PostgreSQL, na entrada e na baixa', () => {
  const corpos = (quantidade) => [
    ['entrada', estoque.entrada.body, { tamanho: '40', quantidade, caNumero: '12345', caValidade: '2030-01-31', chaveIdempotencia: CHAVE }],
    ['baixa', estoque.baixa.body, { quantidade, motivo: 'AVARIA', chaveIdempotencia: CHAVE }],
  ];

  test('aceita exatamente o teto do INTEGER (2147483647)', () => {
    for (const [nome, schema, corpo] of corpos(2147483647)) assert.equal(schema.safeParse(corpo).success, true, nome);
  });

  test('rejeita quantidade acima do teto do INTEGER', () => {
    for (const [nome, schema, corpo] of corpos(2147483648)) assert.equal(schema.safeParse(corpo).success, false, nome);
  });

  test('rejeita quantidade zero ou negativa', () => {
    for (const quantidade of [0, -1]) {
      for (const [nome, schema, corpo] of corpos(quantidade)) assert.equal(schema.safeParse(corpo).success, false, `${nome} ${quantidade}`);
    }
  });
});

describe('caminho antigo por tamanho: sem schema', () => {
  test('não há mais schema de movimentação nem de consulta por tamanho', () => {
    assert.equal('movimentar' in estoque, false);
    assert.equal('consultar' in estoque, false);
    assert.equal(estoque.lotes.params.safeParse({ id: '7' }).data.id, 7);
  });
});

const issuesDe = (r) => r.error.issues.map((i) => [i.path.join('.'), i.code, i.params ? i.params.codigo : undefined]);

describe('entrada — CA e validade sempre obrigatórios', () => {
  const valida = (extra = {}) => ({
    tamanho: ' 40 ', quantidade: 5, caNumero: ' 12345 ', caValidade: '2026-09-30', chaveIdempotencia: CHAVE, ...extra,
  });

  test('aceita a entrada completa e devolve tamanho e CA aparados', () => {
    const r = estoque.entrada.body.safeParse(valida());
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { tamanho: '40', quantidade: 5, caNumero: '12345', caValidade: '2026-09-30', chaveIdempotencia: CHAVE });
  });

  test('chave de idempotência sai em minúsculas, para a mesma chave ter uma única forma', () => {
    const r = estoque.entrada.body.safeParse(valida({ chaveIdempotencia: CHAVE.toUpperCase() }));
    assert.equal(r.data.chaveIdempotencia, CHAVE);
  });

  test('quantidade, CA, validade e chave são obrigatórios; null também é recusado', () => {
    for (const campo of ['quantidade', 'caNumero', 'caValidade', 'chaveIdempotencia']) {
      const semCampo = valida();
      delete semCampo[campo];
      assert.equal(estoque.entrada.body.safeParse(semCampo).success, false, `${campo} ausente`);
      assert.equal(estoque.entrada.body.safeParse(valida({ [campo]: null })).success, false, `${campo} null`);
    }
  });

  test('não existe campo para dispensar o CA', () => {
    const r = estoque.entrada.body.safeParse(valida({ exigeCa: false }));
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues.map((i) => i.code), ['unrecognized_keys']);
  });

  test('CA vazio, só espaços ou acima de 20 caracteres', () => {
    for (const caNumero of ['', '   ', 'x'.repeat(21)]) {
      assert.deepEqual(issuesDe(estoque.entrada.body.safeParse(valida({ caNumero }))), [['caNumero', 'custom', 'CA_NUMERO_INVALIDO']]);
    }
  });

  test('validade fora do calendário ou fora do formato AAAA-MM-DD', () => {
    for (const caValidade of ['2026-02-30', '30/09/2026', '2026-9-30', '']) {
      assert.deepEqual(issuesDe(estoque.entrada.body.safeParse(valida({ caValidade }))), [['caValidade', 'custom', 'CA_VALIDADE_INVALIDA']]);
    }
  });

  test('tamanho é opcional aqui (quem decide é o material); ausente ou null sai null', () => {
    const semTamanho = { ...valida() };
    delete semTamanho.tamanho;
    for (const corpo of [semTamanho, valida({ tamanho: null })]) {
      const r = estoque.entrada.body.safeParse(corpo);
      assert.equal(r.success, true, JSON.stringify(r.error && r.error.issues));
      assert.equal(r.data.tamanho ?? null, null);
    }
  });

  test('tamanho vazio ou acima de 20 caracteres', () => {
    for (const tamanho of ['', '   ', 'x'.repeat(21)]) {
      assert.deepEqual(issuesDe(estoque.entrada.body.safeParse(valida({ tamanho }))), [['tamanho', 'custom', 'TAMANHO_INVALIDO']]);
    }
  });

  test('quantidade inteira entre 1 e o teto do INTEGER', () => {
    for (const quantidade of [0, -1, 1.5, 2147483648, '5']) {
      assert.equal(estoque.entrada.body.safeParse(valida({ quantidade })).success, false, String(quantidade));
    }
    assert.equal(estoque.entrada.body.safeParse(valida({ quantidade: 2147483647 })).success, true);
  });

  test('chave de idempotência precisa ser UUID', () => {
    for (const chaveIdempotencia of ['', 'abc', '3f2b8c1e9a4d4e7b8c2a1d5e6f7a8b9c', 42]) {
      assert.equal(estoque.entrada.body.safeParse(valida({ chaveIdempotencia })).success, false, String(chaveIdempotencia));
    }
  });
});

describe('baixa — motivos da 042 e justificativa do OUTRO', () => {
  const valida = (extra = {}) => ({ quantidade: 4, motivo: 'AVARIA', chaveIdempotencia: CHAVE, ...extra });

  test('os sete motivos da 042 são os únicos aceitos', () => {
    assert.deepEqual([...estoque.MOTIVOS_BAIXA], ['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO', 'DEVOLUCAO_FORNECEDOR', 'OUTRO']);
    for (const motivo of estoque.MOTIVOS_BAIXA) {
      const r = estoque.baixa.body.safeParse(valida({ motivo, justificativa: 'Conferência do almoxarifado' }));
      assert.equal(r.success, true, motivo);
    }
    for (const motivo of ['ROUBO', 'avaria', '', null]) {
      assert.equal(estoque.baixa.body.safeParse(valida({ motivo })).success, false, String(motivo));
    }
  });

  test('justificativa é opcional fora do OUTRO e sai aparada', () => {
    assert.equal(estoque.baixa.body.safeParse(valida()).data.justificativa, undefined);
    assert.equal(estoque.baixa.body.safeParse(valida({ justificativa: null })).data.justificativa, null);
    assert.equal(estoque.baixa.body.safeParse(valida({ justificativa: '  rasgada  ' })).data.justificativa, 'rasgada');
  });

  test('OUTRO sem justificativa é recusado', () => {
    for (const extra of [{}, { justificativa: null }]) {
      assert.deepEqual(
        issuesDe(estoque.baixa.body.safeParse(valida({ motivo: 'OUTRO', ...extra }))),
        [['justificativa', 'custom', 'JUSTIFICATIVA_OBRIGATORIA']],
      );
    }
    assert.deepEqual(
      issuesDe(estoque.baixa.body.safeParse(valida({ motivo: 'OUTRO', justificativa: '   ' }))),
      [['justificativa', 'custom', 'JUSTIFICATIVA_INVALIDA']],
    );
  });

  test('OUTRO com justificativa é aceito; justificativa acima de 500 caracteres não', () => {
    assert.equal(estoque.baixa.body.safeParse(valida({ motivo: 'OUTRO', justificativa: 'Doação para treinamento' })).success, true);
    assert.equal(estoque.baixa.body.safeParse(valida({ motivo: 'OUTRO', justificativa: 'x'.repeat(500) })).success, true);
    assert.equal(estoque.baixa.body.safeParse(valida({ motivo: 'OUTRO', justificativa: 'x'.repeat(501) })).success, false);
  });

  test('quantidade, chave e campos extras', () => {
    for (const quantidade of [0, -3, 2.5]) {
      assert.equal(estoque.baixa.body.safeParse(valida({ quantidade })).success, false, String(quantidade));
    }
    assert.equal(estoque.baixa.body.safeParse(valida({ chaveIdempotencia: 'nao-e-uuid' })).success, false);
    assert.equal(estoque.baixa.body.safeParse(valida({ loteId: 1 })).success, false, 'o lote vem da rota');
    assert.equal(estoque.baixa.params.safeParse({ loteId: '7' }).data.loteId, 7);
    assert.equal(estoque.baixa.params.safeParse({ loteId: '07' }).success, false);
  });
});

describe('operacoes — filtros do histórico (E8)', () => {
  const q = (query) => estoque.operacoes.query.safeParse(query);

  test('sem filtro: página 1 e limite 50; tipos só os três da 042', () => {
    assert.deepEqual(q({}).data, { pagina: 1, limite: 50 });
    assert.deepEqual([...estoque.TIPOS_OPERACAO], ['SALDO_INICIAL', 'ENTRADA', 'BAIXA']);
    for (const tipo of estoque.TIPOS_OPERACAO) assert.equal(q({ tipo }).data.tipo, tipo);
    for (const tipo of ['ENTREGA', 'baixa', '', ['BAIXA', 'ENTRADA']]) assert.equal(q({ tipo }).success, false, String(tipo));
  });

  test('período: datas de calendário, o mesmo dia vale, e a data final antes da inicial é recusada', () => {
    assert.deepEqual(q({ de: '2026-09-09', ate: '2026-09-09' }).data, { de: '2026-09-09', ate: '2026-09-09', pagina: 1, limite: 50 });
    for (const data of ['2026-13-01', '2026-02-30', '09/09/2026', 'ontem']) assert.equal(q({ de: data }).success, false, data);
    assert.deepEqual(issuesDe(q({ de: '2026-09-10', ate: '2026-09-09' })), [['ate', 'custom', 'PERIODO_INVERTIDO']]);
  });

  test('busca aparada até 100 caracteres; limite até 100; nenhum parâmetro fora da lista', () => {
    assert.equal(q({ busca: '  CA-777  ' }).data.busca, 'CA-777');
    assert.equal(q({ busca: 'x'.repeat(101) }).success, false);
    assert.equal(q({ limite: '100' }).data.limite, 100);
    for (const limite of ['0', '101', '-1', '1e2']) assert.equal(q({ limite }).success, false, limite);
    for (const extra of [{ ordem: 'criado_em' }, { empresaId: '2' }, { usuarioId: '1' }]) assert.equal(q(extra).success, false, JSON.stringify(extra));
  });
});
