'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Biblioteca de Imagens, Unidade 5A-1 (RED) — schema Zod da ENTREGA de arquivos:
 *   GET /api/imagens-material/:origem/:id/:variante?v=<versao>
 * Módulo previsto: src/schemas/imagem-material-entrega.schema.js, exportando `entregar = { params, query }` (os dois em strictObject).
 *
 * Só FORMATO, sem banco. O `id` é BIGINT em texto decimal canônico (ID_INVALIDO fora disso, como nas demais rotas da biblioteca). A query tem
 * uma única chave opcional, `v` (a versão da imagem, inteiro positivo de 1 a 2147483647, sem zeros à esquerda), devolvida como NÚMERO. Chave
 * não prevista é recusada. Origem e variante desconhecidas NÃO são tratadas aqui: o contrato manda 404 uniforme (serviço), não 400.
 */

const entregar = () => exigirModulo('src/schemas/imagem-material-entrega.schema').entregar;
const issueDe = (resultado, caminho) => resultado.error.issues.find((i) => i.path.join('.') === caminho);
const codigoDe = (resultado, caminho) => issueDe(resultado, caminho)?.params?.codigo ?? issueDe(resultado, caminho)?.code;
const PARAMS = { origem: 'empresa', id: '5', variante: 'miniatura' };

describe('[SCH-ENT] schema da entrega de imagens', () => {
  test('SCH-ENT-01 — params: origem, id e variante; o id BIGINT sai como TEXTO canônico, inclusive acima de 2^53', () => {
    const { params } = entregar();
    assert.deepEqual(params.safeParse(PARAMS), { success: true, data: PARAMS });
    const grande = params.safeParse({ ...PARAMS, origem: 'padrao', id: '9007199254740993', variante: 'exibicao' });
    assert.equal(grande.success, true);
    assert.equal(grande.data.id, '9007199254740993');
    assert.equal(params.safeParse({ ...PARAMS, id: '9223372036854775807' }).data.id, '9223372036854775807');
  });

  test('SCH-ENT-02 — params: id fora do texto decimal canônico é ID_INVALIDO (zeros à esquerda, sinal, fração, notação científica, espaço, vazio, acima de 2^63−1)', () => {
    const { params } = entregar();
    for (const ruim of ['05', 'abc', '0', '-1', '+1', '1.5', '1e3', ' 5', '5 ', '', '9223372036854775808', '１２']) {
      const r = params.safeParse({ ...PARAMS, id: ruim });
      assert.equal(r.success, false, JSON.stringify(ruim));
      assert.equal(codigoDe(r, 'id'), 'ID_INVALIDO', JSON.stringify(ruim));
    }
  });

  test('SCH-ENT-03 — params é estrito: empresa, usuário e qualquer chave extra são recusadas (a autoridade nunca vem do cliente)', () => {
    const { params } = entregar();
    for (const extra of ['empresaId', 'usuarioId', 'criadoPor', 'caminho', 'chave', 'x']) {
      const r = params.safeParse({ ...PARAMS, [extra]: '1' });
      assert.equal(r.success, false, extra);
      assert.equal(r.error.issues.some((i) => i.code === 'unrecognized_keys'), true, extra);
    }
  });

  test('SCH-ENT-04 — query: vazia é válida (sem `v`); `v` é a versão positiva e sai como NÚMERO', () => {
    const { query } = entregar();
    const vazia = query.safeParse({});
    assert.equal(vazia.success, true);
    assert.equal('v' in vazia.data && vazia.data.v !== undefined, false, 'sem v na entrada, nada de v na saída');
    for (const [texto, numero] of [['1', 1], ['7', 7], ['2147483647', 2147483647], ['100', 100]]) {
      const r = query.safeParse({ v: texto });
      assert.equal(r.success, true, texto);
      assert.equal(r.data.v, numero, texto);
      assert.equal(typeof r.data.v, 'number', texto);
    }
  });

  test('SCH-ENT-05 — query: `v` inválido é recusado (zero, negativo, fração, zeros à esquerda, sinal, espaço, vazio, notação científica, acima de int4, repetido)', () => {
    const { query } = entregar();
    for (const ruim of ['0', '-1', '+1', '1.5', '01', ' 1', '1 ', '', 'abc', '1e3', '2147483648', '99999999999', ['1', '2']]) {
      const r = query.safeParse({ v: ruim });
      assert.equal(r.success, false, JSON.stringify(ruim));
      assert.equal(issueDe(r, 'v') !== undefined, true, JSON.stringify(ruim));
    }
  });

  test('SCH-ENT-06 — query é estrita: nenhuma chave além de `v` (empresaId, usuarioId, origem, qualquer outra) é aceita', () => {
    const { query } = entregar();
    for (const extra of ['empresaId', 'usuarioId', 'origem', 'variante', 'x']) {
      const r = query.safeParse({ v: '1', [extra]: '1' });
      assert.equal(r.success, false, extra);
      assert.equal(r.error.issues.some((i) => i.code === 'unrecognized_keys'), true, extra);
    }
    assert.equal(query.safeParse({ x: '1' }).success, false);
  });
});
