'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Helpers compartilhados pela entrega DIRETA (Bloco 10) e pela entrega por
 * solicitação (12C-2). Só entra aqui o que as duas realmente usam: a
 * validação da confirmação, o hash de conteúdo, o resultado repetido, as
 * cópias do documento e as regras de classificação do material e de lote
 * utilizável. O comportamento da DIRETA não muda: o serviço dela re-exporta
 * os mesmos símbolos que sempre exportou.
 */

const comum = () => exigirModulo('src/services/entrega-epi-comum');

function codigoDe(fn) {
  try {
    fn();
  } catch (erro) {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    return [erro.status, erro.codigo];
  }
  return null;
}

const material = (extra = {}) => ({
  id: 30, ativo: true, prazoUsoDias: 180, exigeTamanho: true, tipo: null, oculosComGrau: null, exigeCa: true, ...extra,
});
const lote = (extra = {}) => ({ loteId: 5, materialId: 30, tamanho: '40', caNumero: '123', caValidade: '2099-12-31', saldo: 10, ...extra });
const HOJE = '2026-10-02';

describe('os símbolos que a DIRETA sempre exportou continuam os mesmos', () => {
  test('LIMITE_ITENS, calcularHashConteudo, normalizarTracos e declaracaoValida são os do módulo comum, sem cópia', () => {
    const direta = require('../../src/services/entrega-epi.service');
    assert.equal(direta.LIMITE_ITENS, 20);
    for (const nome of ['calcularHashConteudo', 'normalizarTracos', 'declaracaoValida', 'LIMITE_ITENS']) {
      assert.equal(direta[nome], comum()[nome], nome);
    }
  });
});

describe('exigirClassificacaoDoMaterial', () => {
  test('material classificado passa', () => {
    assert.equal(comum().exigirClassificacaoDoMaterial(material()), undefined);
    assert.equal(comum().exigirClassificacaoDoMaterial(material({ exigeTamanho: false })), undefined);
    assert.equal(comum().exigirClassificacaoDoMaterial(material({ tipo: 'Óculos de proteção', oculosComGrau: false })), undefined);
  });

  test('prazo de uso, tamanho e óculos sem classificação são 409, com o código de sempre', () => {
    const { exigirClassificacaoDoMaterial: exigir } = comum();
    assert.deepEqual(codigoDe(() => exigir(material({ prazoUsoDias: null }))), [409, 'MATERIAL_PRAZO_NAO_CLASSIFICADO']);
    assert.deepEqual(codigoDe(() => exigir(material({ prazoUsoDias: 0 }))), [409, 'MATERIAL_PRAZO_NAO_CLASSIFICADO']);
    assert.deepEqual(codigoDe(() => exigir(material({ exigeTamanho: null }))), [409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO']);
    assert.deepEqual(codigoDe(() => exigir(material({ tipo: 'Óculos de proteção', oculosComGrau: null }))), [409, 'MATERIAL_OCULOS_NAO_CLASSIFICADO']);
  });

  test('12G-8: Incolor e Ampla Visão são óculos como o nome histórico; "Outros" com texto de óculos não é', () => {
    const { exigirClassificacaoDoMaterial: exigir } = comum();
    for (const tipo of ['Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão', 'Óculos de proteção']) {
      assert.deepEqual(codigoDe(() => exigir(material({ tipo, oculosComGrau: null }))), [409, 'MATERIAL_OCULOS_NAO_CLASSIFICADO'], tipo);
      assert.equal(exigir(material({ tipo, oculosComGrau: true })), undefined, tipo);
    }
    assert.equal(exigir(material({ tipo: 'Outros', tipoDescricao: 'Óculos de proteção', oculosComGrau: null })), undefined);
  });
});

describe('exigirCaValidoDoLote', () => {
  test('lote com CA válido, ou de material que não exige CA, passa; o CA vale até o fim do dia', () => {
    const { exigirCaValidoDoLote: exigir } = comum();
    assert.equal(exigir(lote(), material(), HOJE), undefined);
    assert.equal(exigir(lote({ caValidade: HOJE }), material(), HOJE), undefined);
    assert.equal(exigir(lote({ caNumero: null, caValidade: null }), material({ exigeCa: false }), HOJE), undefined);
  });

  test('CA ausente e CA vencido são 409; só quando o material exige CA', () => {
    const { exigirCaValidoDoLote: exigir } = comum();
    assert.deepEqual(codigoDe(() => exigir(lote({ caNumero: null, caValidade: null }), material(), HOJE)), [409, 'CA_AUSENTE']);
    assert.deepEqual(codigoDe(() => exigir(lote({ caValidade: '2026-10-01' }), material(), HOJE)), [409, 'CA_VENCIDO']);
    assert.equal(codigoDe(() => exigir(lote({ caValidade: '2020-01-01' }), material({ exigeCa: false }), HOJE)), null);
  });
});

describe('exigirSaldoDoLote', () => {
  test('quantidade até o saldo passa; acima do saldo é SALDO_INSUFICIENTE (409)', () => {
    const { exigirSaldoDoLote: exigir } = comum();
    assert.equal(exigir(lote({ saldo: 3 }), 3), undefined);
    assert.deepEqual(codigoDe(() => exigir(lote({ saldo: 2 }), 3)), [409, 'SALDO_INSUFICIENTE']);
  });
});
