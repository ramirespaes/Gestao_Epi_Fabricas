'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schema = require('../../src/schemas/itens-disponiveis.schema');

/**
 * Consulta de itens disponíveis (Bloco 9, Etapa C, Parte C3): somente
 * leitura, query estrita. Nenhum identificador de empresa ou usuário é
 * aceito do cliente.
 */

describe('itens-disponiveis.schema — listar.query', () => {
  const q = schema.listar.query;

  test('sem filtros: página 1 e limite padrão 50', () => {
    const r = q.safeParse({});
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { pagina: 1, limite: 50 });
  });

  test('filtros de texto aparados; validade só ok, expiring ou expired; paginação numérica', () => {
    const r = q.safeParse({ categoria: ' EPI ', tipo: 'Luva', tamanho: 'G', validade: 'expiring', pagina: '2', limite: '100' });
    assert.equal(r.success, true, JSON.stringify(r.error && r.error.issues));
    assert.deepEqual(r.data, { categoria: 'EPI', tipo: 'Luva', tamanho: 'G', validade: 'expiring', pagina: 2, limite: 100 });
    for (const v of ['ok', 'expiring', 'expired']) assert.equal(q.safeParse({ validade: v }).success, true, v);
  });

  test('recusa: validade desconhecida, limite acima de 100, página 0, textos vazios ou longos demais', () => {
    for (const bruto of [{ validade: 'vencido' }, { validade: '' }, { limite: '101' }, { pagina: '0' }, { categoria: '' }, { categoria: 'x'.repeat(31) }, { tipo: 'x'.repeat(101) }, { tamanho: 'x'.repeat(21) }]) {
      assert.equal(q.safeParse(bruto).success, false, JSON.stringify(bruto));
    }
  });

  test('recusa campos de autoridade e desconhecidos (empresaId, usuarioId, ativo, ordem)', () => {
    for (const bruto of [{ empresaId: '1' }, { usuarioId: '1' }, { ativo: 'false' }, { ordem: 'nome' }]) {
      assert.equal(q.safeParse(bruto).success, false, JSON.stringify(bruto));
    }
  });

  test('busca aparada até 100 caracteres; vazia, só espaços ou longa demais é recusada (12D-2)', () => {
    assert.equal(q.safeParse({ busca: '  Botina  ' }).data.busca, 'Botina');
    assert.equal(q.safeParse({ busca: 'x'.repeat(100) }).success, true);
    for (const busca of ['', '   ', 'x'.repeat(101)]) assert.equal(q.safeParse({ busca }).success, false, JSON.stringify(busca));
  });

  test('situacao: só as quatro situações funcionais; nenhum valor arbitrário (12D-2)', () => {
    assert.deepEqual([...schema.SITUACOES_ESTOQUE], ['SEM_ESTOQUE', 'ABAIXO_MINIMO', 'COM_COMPROMETIDO', 'SEM_COBERTURA']);
    for (const situacao of schema.SITUACOES_ESTOQUE) assert.equal(q.safeParse({ situacao }).data.situacao, situacao);
    for (const situacao of ['COM_NECESSIDADE', 'sem_estoque', '', 'QUALQUER', ['SEM_ESTOQUE', 'ABAIXO_MINIMO']]) {
      assert.equal(q.safeParse({ situacao }).success, false, JSON.stringify(situacao));
    }
  });

  test('somenteComNecessidade: true ou false em texto, convertido para boolean; qualquer outro valor é recusado (12D-2)', () => {
    assert.equal(q.safeParse({ somenteComNecessidade: 'true' }).data.somenteComNecessidade, true);
    assert.equal(q.safeParse({ somenteComNecessidade: 'false' }).data.somenteComNecessidade, false);
    for (const valor of ['1', 'sim', '', 'TRUE', true]) assert.equal(q.safeParse({ somenteComNecessidade: valor }).success, false, JSON.stringify(valor));
  });

  test('os filtros novos convivem com os antigos e com a paginação', () => {
    const r = q.safeParse({
      categoria: 'EPI', tipo: 'Luva', tamanho: 'G', validade: 'ok', busca: 'nitr', situacao: 'ABAIXO_MINIMO', somenteComNecessidade: 'true', pagina: '3', limite: '10',
    });
    assert.equal(r.success, true, JSON.stringify(r.error && r.error.issues));
    assert.deepEqual(r.data, {
      categoria: 'EPI', tipo: 'Luva', tamanho: 'G', validade: 'ok', busca: 'nitr', situacao: 'ABAIXO_MINIMO', somenteComNecessidade: true, pagina: 3, limite: 10,
    });
  });

  test('a constante do alerta de validade do CA é 60 dias', () => {
    assert.equal(schema.DIAS_ALERTA_VALIDADE_CA, 60);
    assert.equal(schema.LIMITE_PADRAO, 50);
  });
});
