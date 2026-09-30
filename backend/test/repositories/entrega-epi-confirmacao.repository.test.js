'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../src/repositories/entrega-epi-confirmacao.repository');

/**
 * Contrato do repositório de confirmação: o limite do texto da declaração é
 * contado em caracteres, como char_length no PostgreSQL, e não em unidades
 * UTF-16. O restante é provado com banco real na integração do serviço.
 */

const HASH = 'a'.repeat(64);
const ASTRAL = '\u{1D400}';

const executorFalso = () => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: [{ entrega_id: 10, empresa_id: 42, modo: 'ACEITE_PRESENCIAL', tracos: null, declaracao_versao: 'NR6-2026-09', declaracao_texto: valores[5], confirmada_em: new Date(), ip: null, dispositivo: null, hash_conteudo: HASH }] };
    },
  };
};

const dados = (declaracaoTexto) => ({
  empresaId: 42, entregaId: 10, modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto, hashConteudo: HASH,
});

describe('criar — limite de declaracao_texto em caracteres', () => {
  test('4000 caracteres fora do BMP (8000 unidades UTF-16) passam e vão ao banco exatamente como recebidos', async () => {
    const texto = ASTRAL.repeat(4000);
    assert.equal(texto.length, 8000);
    const executor = executorFalso();
    const r = await repo.criar(executor, dados(texto));
    assert.equal(executor.chamadas[0].valores[5], texto);
    assert.equal(r.declaracaoTexto, texto);
  });

  test('4001 caracteres são recusados, ainda que caibam em unidades UTF-16 menores que outro texto aceito', async () => {
    const executor = executorFalso();
    await assert.rejects(() => repo.criar(executor, dados(ASTRAL.repeat(4001))), /texto da declaração/);
    await assert.rejects(() => repo.criar(executor, dados('x'.repeat(4001))), /texto da declaração/);
    await assert.rejects(() => repo.criar(executor, dados('')), /texto da declaração/);
    assert.equal(executor.chamadas.length, 0);
  });
});
