'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const material = require('../../src/schemas/material.schema');

// Ajuste do contrato RED (decisão registrada no doc. 32): os validadores BIGINT ficam em módulo PRÓPRIO e não em `campos.schema.js`, porque o
// teste histórico `campos.schema.test.js` fixa a lista EXATA de exports daquele módulo e a V7 só autorizou ajustar [BE-40] e o teste de CORS.
const campos = { get idGrandeParametro() { return exigirModulo('src/schemas/identificador-grande.schema').idGrandeParametro; }, get idGrandeCorpo() { return exigirModulo('src/schemas/identificador-grande.schema').idGrandeCorpo; } };

/**
 * Biblioteca de Imagens, Unidade 4 (RED) — schemas Zod das rotas da biblioteca (`src/schemas/imagem-material.schema.js`), o identificador
 * BIGINT em params e corpo (`identificador-grande.schema`: `idGrandeParametro`, `idGrandeCorpo`) e o campo `imagem` dos corpos de criar/alterar material
 * (`material.schema`). Só formato, sem banco; empresa, ator e estado nunca vêm do cliente (strictObject em todo corpo e query).
 */

const issueDe = (resultado, caminho) => resultado.error.issues.find((i) => i.path.join('.') === caminho);
const codigoDe = (resultado, caminho) => issueDe(resultado, caminho)?.params?.codigo ?? issueDe(resultado, caminho)?.code;
const corpoBase = { nome: 'Botina', prazoUsoDias: 180, exigeTamanho: true, categoria: 'Outros', categoriaDescricao: 'x', tipo: 'Outros', tipoDescricao: 'x' };

describe('identificador-grande.schema — identificador BIGINT (texto decimal canônico, sem perda de precisão)', () => {
  test('idGrandeParametro: aceita "5" e "9007199254740993" (acima de 2^53) como TEXTO; recusa "05", "abc", "0", "-1", "1.5", "1e3", "" e acima de 2^63−1 com ID_INVALIDO', () => {
    assert.equal(typeof campos.idGrandeParametro?.safeParse, 'function', 'idGrandeParametro ainda não existe em identificador-grande.schema');
    assert.deepEqual(campos.idGrandeParametro.safeParse('5'), { success: true, data: '5' });
    assert.deepEqual(campos.idGrandeParametro.safeParse('9007199254740993'), { success: true, data: '9007199254740993' });
    assert.deepEqual(campos.idGrandeParametro.safeParse('9223372036854775807').data, '9223372036854775807');
    for (const ruim of ['05', 'abc', '0', '-1', '1.5', '1e3', '', '9223372036854775808', ' 5']) {
      const r = campos.idGrandeParametro.safeParse(ruim);
      assert.equal(r.success, false, JSON.stringify(ruim));
      assert.equal(r.error.issues[0].params?.codigo, 'ID_INVALIDO', JSON.stringify(ruim));
    }
  });

  test('idGrandeCorpo: aceita inteiro seguro (5 → "5") OU texto decimal canônico; recusa número acima de 2^53, 0, negativo, fracionário, "05", booleano e null com ID_INVALIDO/invalid_type', () => {
    assert.equal(typeof campos.idGrandeCorpo?.safeParse, 'function', 'idGrandeCorpo ainda não existe em identificador-grande.schema');
    assert.deepEqual(campos.idGrandeCorpo.safeParse(5), { success: true, data: '5' });
    assert.deepEqual(campos.idGrandeCorpo.safeParse('5'), { success: true, data: '5' });
    assert.deepEqual(campos.idGrandeCorpo.safeParse('9007199254740993').data, '9007199254740993');
    for (const ruim of [9007199254740993, 0, -1, 1.5, '05', '', 'abc', '9223372036854775808', true, null]) {
      assert.equal(campos.idGrandeCorpo.safeParse(ruim).success, false, JSON.stringify(ruim));
    }
  });
});

describe('material.schema — campo `imagem` em criar e alterar', () => {
  test('aceita { origem: PADRAO|EMPRESA, id } (id inteiro seguro ou texto) e normaliza o id para texto; aceita null; ausente continua válido', () => {
    for (const corpo of [material.criar.body, material.alterar.body]) {
      const com = corpo.safeParse({ ...corpoBase, imagem: { origem: 'EMPRESA', id: 5 } });
      assert.equal(com.success, true, JSON.stringify(com.error?.issues));
      assert.deepEqual(com.data.imagem, { origem: 'EMPRESA', id: '5' });
      assert.deepEqual(corpo.safeParse({ ...corpoBase, imagem: { origem: 'PADRAO', id: '9007199254740993' } }).data.imagem, { origem: 'PADRAO', id: '9007199254740993' });
      assert.equal(corpo.safeParse({ ...corpoBase, imagem: null }).data.imagem, null);
      assert.equal('imagem' in corpo.safeParse({ ...corpoBase }).data, false, 'ausente = não mexer');
    }
  });

  test('recusa imagem malformada apontando o campo: origem fora do enum (minúsculas, outra), id inválido, chave extra, tipo errado', () => {
    for (const corpo of [material.criar.body, material.alterar.body]) {
      assert.equal(codigoDe(corpo.safeParse({ ...corpoBase, imagem: { origem: 'empresa', id: 1 } }), 'imagem.origem'), 'invalid_value');
      assert.equal(codigoDe(corpo.safeParse({ ...corpoBase, imagem: { origem: 'OUTRA', id: 1 } }), 'imagem.origem'), 'invalid_value');
      assert.equal(codigoDe(corpo.safeParse({ ...corpoBase, imagem: { origem: 'EMPRESA', id: '05' } }), 'imagem.id'), 'ID_INVALIDO');
      assert.equal(codigoDe(corpo.safeParse({ ...corpoBase, imagem: { origem: 'EMPRESA', id: 9007199254740993 } }), 'imagem.id'), 'ID_INVALIDO');
      assert.equal(corpo.safeParse({ ...corpoBase, imagem: { origem: 'EMPRESA', id: 1, caminho: '/x' } }).error.issues.some((i) => i.code === 'unrecognized_keys' && i.path.join('.') === 'imagem'), true);
      for (const errada of ['x', [], 7, true, { origem: 'EMPRESA' }, { id: 1 }]) assert.equal(corpo.safeParse({ ...corpoBase, imagem: errada }).success, false, JSON.stringify(errada));
    }
  });
});

describe('imagem-material.schema — rotas da biblioteca', () => {
  const schemas = () => exigirModulo('src/schemas/imagem-material.schema');

  test('listar.query: padrões origem=TODAS, estado=ATIVA, pagina=1, limite=20; aceita busca e tipoNome até 100; recusa origem/estado fora do enum, limite fora de 1–100, empresaId e chaves extras', () => {
    const s = schemas().listar.query;
    assert.deepEqual(s.safeParse({}).data, { origem: 'TODAS', estado: 'ATIVA', pagina: 1, limite: 20 });
    assert.deepEqual(s.safeParse({ origem: 'PADRAO', busca: '  luva  ', tipoNome: 'Luva', estado: 'TODAS', pagina: '2', limite: '100' }).data, { origem: 'PADRAO', busca: 'luva', tipoNome: 'Luva', estado: 'TODAS', pagina: 2, limite: 100 });
    for (const ruim of [{ origem: 'padrao' }, { origem: 'OUTRA' }, { estado: 'X' }, { limite: '101' }, { limite: '0' }, { pagina: '0' }, { busca: 'x'.repeat(101) }, { tipoNome: '' }, { empresaId: '1' }, { selecionada: 'true' }]) {
      assert.equal(s.safeParse(ruim).success, false, JSON.stringify(ruim));
    }
  });

  test('renomear: params.id BIGINT; body { nome } estrito (1–100, aparado, sem controle); estado, empresaId e versao recusados', () => {
    const { renomear } = schemas();
    assert.deepEqual(renomear.params.safeParse({ id: '9007199254740993' }).data, { id: '9007199254740993' });
    assert.equal(renomear.params.safeParse({ id: '05' }).success, false);
    assert.deepEqual(renomear.body.safeParse({ nome: '  Luva  ' }).data, { nome: 'Luva' });
    for (const ruim of [{}, { nome: '' }, { nome: 'x'.repeat(101) }, { nome: 'a\u0000b' }, { nome: 'x', estado: 'ATIVA' }, { nome: 'x', empresaId: 1 }, { nome: 'x', versao: 2 }]) {
      assert.equal(renomear.body.safeParse(ruim).success, false, JSON.stringify(ruim));
    }
  });

  test('inativar/reativar: params.id BIGINT e corpo {} estrito; excluir: corpo { confirmacao: true } literal (false, "true", 1, ausente e chave extra recusados)', () => {
    const { inativar, reativar, excluir } = schemas();
    for (const s of [inativar, reativar]) {
      assert.equal(s.params.safeParse({ id: '7' }).success, true);
      assert.deepEqual(s.body.safeParse({}).data, {});
      assert.equal(s.body.safeParse({ ativo: false }).success, false);
    }
    assert.deepEqual(excluir.params.safeParse({ id: '7' }).data, { id: '7' });
    assert.deepEqual(excluir.body.safeParse({ confirmacao: true }).data, { confirmacao: true });
    for (const ruim of [{}, { confirmacao: false }, { confirmacao: 'true' }, { confirmacao: 1 }, { confirmacao: true, empresaId: 1 }, { confirmacao: true, motivo: 'x' }]) {
      assert.equal(excluir.body.safeParse(ruim).success, false, JSON.stringify(ruim));
    }
  });
});
