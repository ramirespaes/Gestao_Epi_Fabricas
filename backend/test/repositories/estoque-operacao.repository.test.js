'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../src/repositories/estoque-operacao.repository');

/**
 * Contrato do repositório de escrita do estoque por lote. Triggers, travas e
 * concorrência são provados com PostgreSQL real nos testes de integração;
 * aqui confiro isolamento, parâmetros e mapeamento.
 */

const EMPRESA = 4242;
const MATERIAL = 30;
const LOTE = 7;
const USUARIO = 11;
const CHAVE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const HASH = 'a'.repeat(64);
const CRIADO_EM = new Date('2026-09-30T15:00:00Z');

const executorFalso = (...respostas) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: respostas.length > 0 ? respostas.shift() : [] };
    },
  };
};

const linhaLote = (extra = {}) => ({
  id: LOTE, material_id: MATERIAL, tamanho: '40', ca_numero: '12345', ca_validade: '2027-06-30', origem: 'ENTRADA',
  quantidade_entrada: 10, quantidade_baixada: 0, quantidade_entregue: 0, saldo: 10, ...extra,
});
const lotePublico = (extra = {}) => ({
  loteId: LOTE, materialId: MATERIAL, tamanho: '40', caNumero: '12345', caValidade: '2027-06-30', origem: 'ENTRADA',
  quantidadeEntrada: 10, quantidadeBaixada: 0, quantidadeEntregue: 0, saldo: 10, ...extra,
});
const linhaOperacao = (extra = {}) => ({
  id: '99', tipo: 'ENTRADA', lote_id: LOTE, quantidade: 10, motivo: null, justificativa: null, usuario_id: USUARIO,
  requisicao_hash: HASH, criado_em: CRIADO_EM, ...extra,
});
const operacaoPublica = (extra = {}) => ({
  id: '99', tipo: 'ENTRADA', loteId: LOTE, quantidade: 10, motivo: null, justificativa: null, usuarioId: USUARIO, criadoEm: CRIADO_EM, ...extra,
});

function semFonteLegada(texto) {
  assert.doesNotMatch(texto, /estoque_tamanhos/, 'a escrita nova nunca toca o saldo legado');
  assert.doesNotMatch(texto, /UPDATE\s+estoque_lotes/i, 'contadores do lote só mudam pelos triggers da 042');
}

describe('travarChave', () => {
  test('advisory lock de transação com chave de 64 bits derivada da empresa e da chave de idempotência', async () => {
    const executor = executorFalso();
    await repo.travarChave(executor, EMPRESA, CHAVE);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^SELECT pg_advisory_xact_lock\(\$1::bigint\)$/);
    assert.equal(valores.length, 1);
    assert.match(valores[0], /^-?\d{1,19}$/);
    const lock = BigInt(valores[0]);
    assert.ok(lock >= -(2n ** 63n) && lock < 2n ** 63n);
  });

  test('a mesma chave dá o mesmo lock; outra empresa ou outra chave dá outro', async () => {
    const lockDe = async (empresaId, chave) => {
      const executor = executorFalso();
      await repo.travarChave(executor, empresaId, chave);
      return executor.chamadas[0].valores[0];
    };
    assert.equal(await lockDe(EMPRESA, CHAVE), await lockDe(EMPRESA, CHAVE));
    assert.notEqual(await lockDe(EMPRESA, CHAVE), await lockDe(EMPRESA + 1, CHAVE));
    assert.notEqual(await lockDe(EMPRESA, CHAVE), await lockDe(EMPRESA, '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9d'));
  });
});

describe('buscarPorChave', () => {
  test('procura só na empresa e devolve a operação com o hash para comparação', async () => {
    const executor = executorFalso([linhaOperacao()]);
    const r = await repo.buscarPorChave(executor, EMPRESA, CHAVE);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /FROM\s+estoque_operacoes/);
    assert.match(texto, /empresa_id\s*=\s*\$1\s+AND\s+chave_idempotencia\s*=\s*\$2/);
    assert.deepEqual(valores, [EMPRESA, CHAVE]);
    assert.deepEqual(r, { ...operacaoPublica(), requisicaoHash: HASH });
  });

  test('chave nunca usada devolve null', async () => {
    assert.equal(await repo.buscarPorChave(executorFalso([]), EMPRESA, CHAVE), null);
  });
});

describe('buscarLote / buscarLoteParaBaixa', () => {
  test('buscarLote lê o lote da empresa, sem trava', async () => {
    const executor = executorFalso([linhaLote()]);
    assert.deepEqual(await repo.buscarLote(executor, EMPRESA, LOTE), lotePublico());
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /FROM\s+estoque_lotes\s+WHERE\s+empresa_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/);
    assert.doesNotMatch(texto, /FOR UPDATE/);
    assert.deepEqual(valores, [EMPRESA, LOTE]);
  });

  test('buscarLoteParaBaixa trava a linha do lote na empresa; lote de outra empresa não aparece', async () => {
    const executor = executorFalso([linhaLote({ origem: 'SALDO_INICIAL', ca_numero: null, ca_validade: null })]);
    const r = await repo.buscarLoteParaBaixa(executor, EMPRESA, LOTE);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2\s+FOR UPDATE$/);
    assert.deepEqual(valores, [EMPRESA, LOTE]);
    assert.deepEqual(r, lotePublico({ origem: 'SALDO_INICIAL', caNumero: null, caValidade: null }));
    assert.equal(await repo.buscarLoteParaBaixa(executorFalso([]), EMPRESA, LOTE), null);
  });
});

describe('registrarEntrada', () => {
  const dados = (extra = {}) => ({
    empresaId: EMPRESA, materialId: MATERIAL, usuarioId: USUARIO, tamanho: '40', quantidade: 10,
    caNumero: '12345', caValidade: '2027-06-30', chave: CHAVE, requisicaoHash: HASH, ...extra,
  });

  test('cria o lote ENTRADA com CA e a operação ENTRADA com responsável, chave e hash', async () => {
    const executor = executorFalso([linhaLote()], [linhaOperacao()]);
    const r = await repo.registrarEntrada(executor, dados());
    assert.equal(executor.chamadas.length, 2);

    const [lote, operacao] = executor.chamadas;
    assert.match(lote.texto, /INSERT INTO estoque_lotes/);
    assert.match(lote.texto, /'ENTRADA'/);
    assert.deepEqual(lote.valores, [EMPRESA, MATERIAL, '40', '12345', '2027-06-30', 10]);
    assert.match(operacao.texto, /INSERT INTO estoque_operacoes/);
    assert.match(operacao.texto, /'ENTRADA'/);
    assert.deepEqual(operacao.valores, [EMPRESA, LOTE, 10, USUARIO, CHAVE, HASH]);
    for (const { texto } of executor.chamadas) semFonteLegada(texto);

    assert.deepEqual(r, { operacao: operacaoPublica(), lote: lotePublico() });
  });

  test('recusa dado incompleto antes de gravar: CA e validade nunca são opcionais aqui', async () => {
    const executor = executorFalso();
    await assert.rejects(() => repo.registrarEntrada(executor, dados({ caNumero: null })), /CA/);
    await assert.rejects(() => repo.registrarEntrada(executor, dados({ caValidade: null })), /validade/);
    await assert.rejects(() => repo.registrarEntrada(executor, dados({ usuarioId: null })), /usuário/);
    await assert.rejects(() => repo.registrarEntrada(executor, dados({ quantidade: 0 })), /quantidade/);
    await assert.rejects(() => repo.registrarEntrada(executor, dados({ chave: CHAVE.toUpperCase() })), /chave/);
    await assert.rejects(() => repo.registrarEntrada(executor, dados({ requisicaoHash: 'x' })), /hash/);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('registrarBaixa', () => {
  const dados = (extra = {}) => ({
    empresaId: EMPRESA, loteId: LOTE, usuarioId: USUARIO, quantidade: 4, motivo: 'OUTRO', justificativa: 'Doação',
    chave: CHAVE, requisicaoHash: HASH, ...extra,
  });

  test('grava só a operação BAIXA; o trigger da 042 atualiza o lote', async () => {
    const executor = executorFalso([linhaOperacao({ tipo: 'BAIXA', quantidade: 4, motivo: 'OUTRO', justificativa: 'Doação' })]);
    const r = await repo.registrarBaixa(executor, dados());
    assert.equal(executor.chamadas.length, 1);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /INSERT INTO estoque_operacoes/);
    assert.match(texto, /'BAIXA'/);
    semFonteLegada(texto);
    assert.deepEqual(valores, [EMPRESA, LOTE, 4, 'OUTRO', 'Doação', USUARIO, CHAVE, HASH]);
    assert.deepEqual(r, operacaoPublica({ tipo: 'BAIXA', quantidade: 4, motivo: 'OUTRO', justificativa: 'Doação' }));
  });

  test('justificativa ausente vai como null', async () => {
    const executor = executorFalso([linhaOperacao({ tipo: 'BAIXA' })]);
    await repo.registrarBaixa(executor, dados({ motivo: 'AVARIA', justificativa: null }));
    assert.equal(executor.chamadas[0].valores[4], null);
  });
});

describe('recusa identificadores inválidos antes de consultar', () => {
  test('empresa, lote e chave', async () => {
    const executor = executorFalso();
    await assert.rejects(() => repo.travarChave(executor, 0, CHAVE), /empresa/);
    await assert.rejects(() => repo.travarChave(executor, EMPRESA, 'abc'), /chave/);
    await assert.rejects(() => repo.buscarPorChave(executor, 'x', CHAVE), /empresa/);
    await assert.rejects(() => repo.buscarLote(executor, EMPRESA, -1), /lote/);
    await assert.rejects(() => repo.buscarLoteParaBaixa(executor, EMPRESA, 1.5), /lote/);
    await assert.rejects(() => repo.registrarBaixa(executor, {
      empresaId: EMPRESA, loteId: 0, usuarioId: USUARIO, quantidade: 1, motivo: 'AVARIA', justificativa: null, chave: CHAVE, requisicaoHash: HASH,
    }), /lote/);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('registrarEntrada — lote sem tamanho (migration 044)', () => {
  const dados = (extra = {}) => ({
    empresaId: EMPRESA, materialId: MATERIAL, usuarioId: USUARIO, tamanho: null, quantidade: 10,
    caNumero: '12345', caValidade: '2027-06-30', chave: CHAVE, requisicaoHash: HASH, ...extra,
  });

  test('tamanho null vai como null para o lote; CA e validade continuam obrigatórios', async () => {
    const executor = executorFalso([linhaLote({ tamanho: null })], [linhaOperacao()]);
    const r = await repo.registrarEntrada(executor, dados());
    assert.equal(executor.chamadas[0].valores[2], null);
    assert.equal(r.lote.tamanho, null);
    const vazio = executorFalso();
    await assert.rejects(() => repo.registrarEntrada(vazio, dados({ caNumero: null })), /CA/);
    await assert.rejects(() => repo.registrarEntrada(vazio, dados({ tamanho: '' })), /tamanho/);
    await assert.rejects(() => repo.registrarEntrada(vazio, dados({ tamanho: ' 40' })), /tamanho/);
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('histórico de operações (E8)', () => {
  const linhaHistorico = (extra = {}) => ({
    id: '99', tipo: 'BAIXA', quantidade: 2, motivo: 'OUTRO', justificativa: 'Doação', criado_em: CRIADO_EM, lote_id: LOTE,
    material_id: MATERIAL, nome: 'Botina', codigo_interno: 'EPI-1', tamanho: null, ca_numero: '12345', ca_validade: '2027-06-30', responsavel: 'Maria', ...extra,
  });

  test('lista só da empresa, com filtros parametrizados, busca sem coringas e ordem fixa do servidor', async () => {
    const executor = executorFalso([linhaHistorico()]);
    const r = await repo.listarHistorico(executor, EMPRESA, {
      tipo: 'BAIXA', de: '2026-09-01', ate: '2026-09-30', busca: '50%_x\\', pagina: 3, limite: 20,
    });
    const [{ texto, valores }] = executor.chamadas;
    assert.deepEqual(valores, [EMPRESA, 'BAIXA', '2026-09-01', '2026-09-30', '50\\%\\_x\\\\', 20, 40]);
    assert.match(texto, /WHERE o\.empresa_id = \$1/);
    assert.match(texto, /l\.empresa_id = o\.empresa_id/);
    assert.match(texto, /u\.empresa_id = o\.empresa_id AND u\.id = o\.usuario_id/);
    assert.match(texto, /ORDER BY o\.criado_em DESC, o\.id DESC\s+LIMIT \$6 OFFSET \$7/);
    assert.match(texto, /AT TIME ZONE 'America\/Sao_Paulo'/);
    assert.doesNotMatch(texto, /logs_auditoria|chave_idempotencia|requisicao_hash|UPDATE|DELETE|INSERT/i);
    assert.deepEqual(r, [{
      operacaoId: '99', tipo: 'BAIXA', quantidade: 2, motivo: 'OUTRO', justificativa: 'Doação', responsavel: 'Maria', criadoEm: CRIADO_EM,
      loteId: LOTE, materialId: MATERIAL, material: 'Botina', codigoInterno: 'EPI-1', tamanho: null, caNumero: '12345', caValidade: '2027-06-30',
    }]);
  });

  test('sem filtro, os filtros vão como null; a contagem usa os mesmos filtros', async () => {
    const executor = executorFalso([], [{ total: 7 }]);
    await repo.listarHistorico(executor, EMPRESA, { pagina: 1, limite: 50 });
    assert.equal(await repo.contarHistorico(executor, EMPRESA, { tipo: 'ENTRADA' }), 7);
    assert.deepEqual(executor.chamadas.map((c) => c.valores), [[EMPRESA, null, null, null, null, 50, 0], [EMPRESA, 'ENTRADA', null, null, null]]);
    assert.doesNotMatch(executor.chamadas[1].texto, /ORDER BY|LIMIT/);
  });

  test('recusa empresa, tipo, data, busca, página e limite inválidos antes de consultar', async () => {
    const executor = executorFalso();
    const pagina = { pagina: 1, limite: 50 };
    await assert.rejects(() => repo.listarHistorico(executor, 0, pagina), /empresa/);
    await assert.rejects(() => repo.listarHistorico(executor, EMPRESA, { ...pagina, tipo: 'ENTREGA' }), /tipo/);
    await assert.rejects(() => repo.listarHistorico(executor, EMPRESA, { ...pagina, de: '01/09/2026' }), /período/);
    await assert.rejects(() => repo.listarHistorico(executor, EMPRESA, { ...pagina, busca: '' }), /busca/);
    await assert.rejects(() => repo.listarHistorico(executor, EMPRESA, { pagina: 0, limite: 50 }), /página/);
    await assert.rejects(() => repo.listarHistorico(executor, EMPRESA, { pagina: 1, limite: 101 }), /limite/);
    await assert.rejects(() => repo.contarHistorico(executor, EMPRESA, { ate: "2026-09-30' OR 1=1" }), /período/);
    assert.equal(executor.chamadas.length, 0);
  });
});
