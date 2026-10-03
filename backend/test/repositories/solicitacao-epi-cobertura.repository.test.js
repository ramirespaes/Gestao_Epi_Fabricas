'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Contrato do repositório da posição de estoque e da cobertura FIFO (Modelo
 * A: reserva lógica e derivada, por empresa, material e tamanho). A correção
 * dos números é provada com PostgreSQL real na integração; aqui confiro que a
 * leitura é só leitura, filtra pela empresa em todas as tabelas, segue as
 * regras de utilizável e de demanda atendível, ordena a fila de forma
 * determinística e mapeia os números.
 *
 *   U = físico utilizável   D = demanda aprovada pendente
 *   C = min(U, D)           L = max(0, U − D)           G = max(0, D − U)
 */

const repo = () => exigirModulo('src/repositories/solicitacao-epi-cobertura.repository');

const EMPRESA = 4242;
const HOJE = '2026-10-02';
const DECIDIDA_EM = new Date('2026-10-02T15:00:00Z');

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

// bigint do PostgreSQL chega como texto no pg.
const linhaPosicao = (extra = {}) => ({
  material_id: 30, tamanho_chave: '40', fisico_utilizavel: '5', demanda_pendente: '2', comprometido: '2', saldo_livre: '3', sem_cobertura: '0', ...extra,
});
const linhaCobertura = (extra = {}) => ({
  item_id: 5, solicitacao_id: 17, material_id: 30, tamanho: '40', decidida_em: DECIDIDA_EM,
  pendente: '4', acumulado_anterior: '2', fisico_utilizavel: '5', coberta: '3', ...extra,
});

const pares = (...lista) => lista.map(([materialId, tamanho]) => ({ materialId, tamanho }));

describe('lerPosicoes — mapeamento e parâmetros', () => {
  test('mapeia U, D, C, L e G em Number; tamanho ausente volta como null', async () => {
    const executor = executorFalso([
      linhaPosicao(),
      linhaPosicao({ material_id: 31, tamanho_chave: '', fisico_utilizavel: '1', demanda_pendente: '4', comprometido: '1', saldo_livre: '0', sem_cobertura: '3' }),
    ]);
    const posicoes = await repo().lerPosicoes(executor, EMPRESA, pares([30, '40'], [31, null]), { hoje: HOJE });
    assert.deepEqual(posicoes, [
      { materialId: 30, tamanho: '40', fisicoUtilizavel: 5, demandaPendente: 2, comprometido: 2, saldoLivre: 3, semCobertura: 0 },
      { materialId: 31, tamanho: null, fisicoUtilizavel: 1, demandaPendente: 4, comprometido: 1, saldoLivre: 0, semCobertura: 3 },
    ]);
  });

  test('os pares seguem para o SQL ordenados, sem repetição, com tamanho ausente como texto vazio (o mesmo COALESCE dos índices)', async () => {
    const executor = executorFalso([]);
    await repo().lerPosicoes(executor, EMPRESA, pares([31, '41'], [30, '40'], [31, null], [30, '40']), { hoje: HOJE });
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, HOJE, [30, 31, 31], ['40', '', '41']]);
  });

  test('sem pares não consulta o banco', async () => {
    const executor = executorFalso();
    assert.deepEqual(await repo().lerPosicoes(executor, EMPRESA, [], { hoje: HOJE }), []);
    assert.equal(executor.chamadas.length, 0);
  });

  test('a posição só mostra os pares pedidos: par sem lote e sem demanda volta com zeros', async () => {
    const executor = executorFalso([linhaPosicao({ fisico_utilizavel: '0', demanda_pendente: '0', comprometido: '0', saldo_livre: '0' })]);
    const [posicao] = await repo().lerPosicoes(executor, EMPRESA, pares([30, '40']), { hoje: HOJE });
    assert.deepEqual([posicao.fisicoUtilizavel, posicao.demandaPendente, posicao.comprometido, posicao.saldoLivre, posicao.semCobertura], [0, 0, 0, 0, 0]);
  });
});

describe('lerPosicoes — SQL', () => {
  const textoDaConsulta = async () => {
    const executor = executorFalso([]);
    await repo().lerPosicoes(executor, EMPRESA, pares([30, '40']), { hoje: HOJE });
    return executor.chamadas[0].texto;
  };

  test('é leitura pura: nenhuma escrita, nenhuma trava e nenhum toque no histórico de operações', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /^WITH\b/);
    assert.doesNotMatch(texto, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    assert.doesNotMatch(texto, /\bFOR\s+(NO KEY\s+)?(UPDATE|SHARE)\b/i);
    assert.doesNotMatch(texto, /pg_advisory|estoque_operacoes|estoque_tamanhos/);
  });

  test('U: saldo dos lotes de material ativo, menos o que o CA ausente ou vencido bloqueia, na data operacional recebida', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /m\.exige_ca AND \(l\.ca_validade IS NULL OR l\.ca_validade < \$2::date\)/);
    assert.match(texto, /m\.ativo/);
    assert.match(texto, /l\.saldo > 0/);
    assert.match(texto, /COALESCE\(l\.tamanho, ''\) = p\.tamanho_chave/);
    assert.doesNotMatch(texto, /CURRENT_DATE|now\(\)/i, 'o fuso do banco não é o de São Paulo');
  });

  test('D: só itens aprovados de solicitação APROVADA ou APROVADA_PARCIAL, de trabalhador e material ativos', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /s\.status IN \('APROVADA', 'APROVADA_PARCIAL'\)/);
    assert.match(texto, /i\.decisao = 'APROVADO'/);
    assert.match(texto, /f\.ativo/);
    assert.match(texto, /COALESCE\(i\.tamanho, ''\) = p\.tamanho_chave/);
  });

  test('D é o pendente: aprovada menos a soma das entregas ligadas ao item, só dos itens com pendente; nada é lido de contador', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /LEFT JOIN LATERAL \(\s*SELECT sum\(ei\.quantidade\)::bigint AS entregue\s+FROM entregas_epi_itens ei\s+WHERE ei\.empresa_id = i\.empresa_id AND ei\.solicitacao_item_id = i\.id\s*\) e ON true/);
    assert.match(texto, /sum\(i\.quantidade_aprovada - COALESCE\(e\.entregue, 0\)\)/);
    assert.match(texto, /i\.quantidade_aprovada > COALESCE\(e\.entregue, 0\)/, 'item inteiramente entregue não conta, e pendente negativa nunca soma');
    assert.doesNotMatch(texto, /sum\(i\.quantidade_aprovada\)/, 'a demanda não é mais a aprovada inteira');
    assert.doesNotMatch(texto, /quantidade_entregue/, 'a entregue do item é derivada, não lida de coluna');
    assert.doesNotMatch(texto, /entregas_epi\b(?!_itens)/, 'só os itens da entrega entram na soma');
  });

  test('C, L e G nunca violam as invariantes: C = LEAST(U, D), L e G com GREATEST(0, ...)', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /LEAST\(/);
    assert.match(texto, /GREATEST\(0, /);
    assert.equal((texto.match(/GREATEST\(0, /g) ?? []).length, 2, 'uma para L e outra para G');
  });

  test('toda tabela é filtrada pela empresa recebida e ligada por chave composta', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /i\.empresa_id = \$1/);
    assert.match(texto, /s\.empresa_id = i\.empresa_id AND s\.id = i\.solicitacao_id/);
    assert.match(texto, /f\.empresa_id = s\.empresa_id AND f\.id = s\.funcionario_id/);
    assert.match(texto, /m\.empresa_id = \$1/);
    assert.match(texto, /l\.empresa_id = \$1/);
  });
});

describe('lerPosicoes — validação', () => {
  test('recusa empresa, data operacional e pares inválidos sem consultar', async () => {
    const vazio = executorFalso();
    await assert.rejects(() => repo().lerPosicoes(vazio, 0, pares([30, '40']), { hoje: HOJE }), /empresa/);
    await assert.rejects(() => repo().lerPosicoes(vazio, EMPRESA, pares([30, '40']), { hoje: '2026-02-30' }), /data operacional/);
    await assert.rejects(() => repo().lerPosicoes(vazio, EMPRESA, pares([30, '40']), {}), /data operacional/);
    await assert.rejects(() => repo().lerPosicoes(vazio, EMPRESA, 'x', { hoje: HOJE }), /pares/);
    await assert.rejects(() => repo().lerPosicoes(vazio, EMPRESA, pares([0, '40']), { hoje: HOJE }), /material/);
    await assert.rejects(() => repo().lerPosicoes(vazio, EMPRESA, pares([30, '']), { hoje: HOJE }), /tamanho/);
    await assert.rejects(() => repo().lerPosicoes(vazio, EMPRESA, pares([30, 'x'.repeat(21)]), { hoje: HOJE }), /tamanho/);
    assert.equal(vazio.chamadas.length, 0);
  });
});

describe('listarCobertura — mapeamento e parâmetros', () => {
  test('mapeia a fila em Number; a falta do item é pendente − coberta', async () => {
    const executor = executorFalso([
      linhaCobertura(),
      linhaCobertura({ item_id: 6, tamanho: null, pendente: '1', acumulado_anterior: '0', fisico_utilizavel: '0', coberta: '0' }),
    ]);
    const cobertura = await repo().listarCobertura(executor, EMPRESA, { hoje: HOJE });
    assert.deepEqual(cobertura, [
      {
        itemId: 5, solicitacaoId: 17, materialId: 30, tamanho: '40', decididaEm: DECIDIDA_EM,
        quantidadePendente: 4, acumuladoAnterior: 2, fisicoUtilizavel: 5, coberta: 3, semCobertura: 1,
      },
      {
        itemId: 6, solicitacaoId: 17, materialId: 30, tamanho: null, decididaEm: DECIDIDA_EM,
        quantidadePendente: 1, acumuladoAnterior: 0, fisicoUtilizavel: 0, coberta: 0, semCobertura: 1,
      },
    ]);
  });

  test('o filtro por solicitação é opcional: sem ele a fila é a da empresa; com ele os parâmetros levam o id', async () => {
    const executor = executorFalso([], []);
    await repo().listarCobertura(executor, EMPRESA, { hoje: HOJE });
    await repo().listarCobertura(executor, EMPRESA, { hoje: HOJE, solicitacaoId: 17 });
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA, HOJE, null]);
    assert.deepEqual(executor.chamadas[1].valores, [EMPRESA, HOJE, 17]);
  });
});

describe('listarCobertura — SQL', () => {
  const textoDaConsulta = async () => {
    const executor = executorFalso([]);
    await repo().listarCobertura(executor, EMPRESA, { hoje: HOJE });
    return executor.chamadas[0].texto;
  };

  test('é leitura pura: nenhuma escrita, nenhuma trava, nenhum toque no histórico de operações', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /^WITH\b/);
    assert.doesNotMatch(texto, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    assert.doesNotMatch(texto, /\bFOR\s+(NO KEY\s+)?(UPDATE|SHARE)\b/i);
    assert.doesNotMatch(texto, /pg_advisory|estoque_operacoes|estoque_tamanhos/);
  });

  test('a fila é FIFO e determinística por empresa, material e tamanho: decidida_em, solicitação e item', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /PARTITION BY i\.material_id, COALESCE\(i\.tamanho, ''\)/);
    assert.match(texto, /ORDER BY s\.decidida_em, s\.id, i\.id\s+ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING/);
    assert.match(texto, /ORDER BY fl\.decidida_em, fl\.solicitacao_id, fl\.item_id\s*$/);
    assert.match(texto, /COALESCE\(l\.tamanho, ''\) = COALESCE\(fl\.tamanho, ''\)/, 'tamanho ausente casa com tamanho ausente');
  });

  test('só entram demanda atendível (aprovada, de trabalhador e material ativos) e a regra de utilizável do estoque', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /s\.status IN \('APROVADA', 'APROVADA_PARCIAL'\)/);
    assert.match(texto, /i\.decisao = 'APROVADO'/);
    assert.match(texto, /f\.ativo/);
    assert.match(texto, /m\.ativo/);
    assert.match(texto, /m\.exige_ca AND \(l\.ca_validade IS NULL OR l\.ca_validade < \$2::date\)/);
    assert.match(texto, /LEAST\(fl\.pendente, GREATEST\(0, /);
    assert.doesNotMatch(texto, /CURRENT_DATE|now\(\)/i);
  });

  test('o pendente da fila é a aprovada menos o entregue derivado: a fila e a demanda anterior contam só o que falta entregar', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /LEFT JOIN LATERAL \(\s*SELECT sum\(ei\.quantidade\)::bigint AS entregue\s+FROM entregas_epi_itens ei\s+WHERE ei\.empresa_id = i\.empresa_id AND ei\.solicitacao_item_id = i\.id\s*\) e ON true/);
    assert.match(texto, /i\.quantidade_aprovada - COALESCE\(e\.entregue, 0\) AS pendente/);
    assert.match(texto, /i\.quantidade_aprovada > COALESCE\(e\.entregue, 0\)/, 'o item inteiramente entregue sai da fila');
    assert.match(texto, /sum\(i\.quantidade_aprovada - COALESCE\(e\.entregue, 0\)\) OVER \(/, 'a demanda anterior também é do pendente');
    assert.doesNotMatch(texto, /sum\(i\.quantidade_aprovada\)/);
    assert.doesNotMatch(texto, /quantidade_entregue/);
  });

  test('toda tabela é filtrada pela empresa recebida e ligada por chave composta', async () => {
    const texto = await textoDaConsulta();
    assert.match(texto, /s\.empresa_id = \$1/);
    assert.match(texto, /i\.empresa_id = s\.empresa_id AND i\.solicitacao_id = s\.id/);
    assert.match(texto, /f\.empresa_id = s\.empresa_id AND f\.id = s\.funcionario_id/);
    assert.match(texto, /m\.empresa_id = i\.empresa_id AND m\.id = i\.material_id/);
    assert.match(texto, /l\.empresa_id = \$1/);
  });
});

describe('listarCobertura — validação', () => {
  test('recusa empresa, data operacional ou solicitação inválidas sem consultar', async () => {
    const vazio = executorFalso();
    await assert.rejects(() => repo().listarCobertura(vazio, 0, { hoje: HOJE }), /empresa/);
    await assert.rejects(() => repo().listarCobertura(vazio, EMPRESA, { hoje: '2026-02-30' }), /data operacional/);
    await assert.rejects(() => repo().listarCobertura(vazio, EMPRESA, { hoje: undefined }), /data operacional/);
    await assert.rejects(() => repo().listarCobertura(vazio, EMPRESA, {}), /data operacional/);
    await assert.rejects(() => repo().listarCobertura(vazio, EMPRESA, { hoje: HOJE, solicitacaoId: 0 }), /solicitação/);
    await assert.rejects(() => repo().listarCobertura(vazio, EMPRESA, { hoje: HOJE, solicitacaoId: '17' }), /solicitação/);
    assert.equal(vazio.chamadas.length, 0);
  });
});
