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

  test('recusa campos de autoridade e desconhecidos (empresaId, usuarioId, ativo, busca)', () => {
    for (const bruto of [{ empresaId: '1' }, { usuarioId: '1' }, { ativo: 'false' }, { busca: 'x' }]) {
      assert.equal(q.safeParse(bruto).success, false, JSON.stringify(bruto));
    }
  });

  test('a constante do alerta de validade do CA é 60 dias', () => {
    assert.equal(schema.DIAS_ALERTA_VALIDADE_CA, 60);
    assert.equal(schema.LIMITE_PADRAO, 50);
  });
});
