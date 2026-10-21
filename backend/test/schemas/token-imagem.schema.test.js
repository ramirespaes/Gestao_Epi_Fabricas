'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Atendimento Token — imagens do material no tablet (RED-1, schema). Contrato proposto, módulo AINDA NÃO implementado:
 *   src/schemas/token-imagem.schema.js exporta `obter = { params, query }` (os dois em strictObject) e `origemDaRota(origemDoCatalogo)`.
 *   GET|HEAD /api/atendimento-token/tablet/atendimento/imagens/:origem/:id/:variante?v=<versao>
 *
 * Só FORMATO, sem banco. Os tipos do SafeWork não mudam: `imagem.id` é BIGINT em TEXTO decimal canônico (nunca Number), `imagem.versao` é inteiro
 * positivo, `material.id` é inteiro JavaScript e NÃO existe na rota (o material do cartão nunca é parâmetro: o servidor o deduz do atendimento).
 * O tablet só recebe `miniatura` e `exibicao`; o `mestre` nunca sai por aqui. Origem e variante são estritas (diferente da rota administrativa, que
 * devolve 404 uniforme): aqui o formato inválido é VALIDACAO antes de qualquer autenticação. Nenhum identificador recebido é autorização.
 */

const modulo = () => exigirModulo('src/schemas/token-imagem.schema');
const obter = () => modulo().obter;
const PARAMS = { origem: 'empresa', id: '5', variante: 'miniatura' };
const caminhosComErro = (r) => r.error.issues.map((i) => i.path.join('.'));

describe('[TIS] schema da entrega de imagens ao tablet', () => {
  test('TIS-01 — params válidos: origem empresa|padrao, variante miniatura|exibicao; o id BIGINT sai como TEXTO canônico, inclusive acima de 2^53 e no limite do PostgreSQL', () => {
    const { params } = obter();
    for (const origem of ['empresa', 'padrao']) {
      for (const variante of ['miniatura', 'exibicao']) assert.deepEqual(params.safeParse({ origem, id: '5', variante }), { success: true, data: { origem, id: '5', variante } });
    }
    for (const id of ['9007199254740993', '9223372036854775807', '1']) {
      const r = params.safeParse({ ...PARAMS, id });
      assert.equal(r.success, true, id);
      assert.equal(typeof r.data.id, 'string', 'o id nunca vira Number');
      assert.equal(r.data.id, id, 'sem perda de precisão');
    }
  });

  test('TIS-02 — id: tudo o que não é decimal canônico de 1 a 9223372036854775807 é recusado no campo id (zeros à esquerda, sinal, fração, notação, hexa, espaço, vazio, acima do BIGINT, caminho, URL codificada, dígitos de outro alfabeto)', () => {
    const { params } = obter();
    const ruins = ['0', '007', '+1', '-1', '1.0', '1e3', '0x1', ' 5', '5 ', '', 'abc', '9223372036854775808', '99999999999999999999', '１２', '1;DROP', '../1', '1/2', '%2e%2e', '%31', 'null', 'NaN'];
    for (const ruim of ruins) {
      const r = params.safeParse({ ...PARAMS, id: ruim });
      assert.equal(r.success, false, JSON.stringify(ruim));
      assert.ok(caminhosComErro(r).includes('id'), `${JSON.stringify(ruim)} deve ser recusado em id`);
    }
    for (const naoTexto of [5, 5n, null, undefined, {}, ['5']]) assert.equal(params.safeParse({ ...PARAMS, id: naoTexto }).success, false, String(typeof naoTexto));
  });

  test('TIS-03 — origem da ROTA é só empresa|padrao em minúsculas; a forma do catálogo (EMPRESA|PADRAO), outras grafias e tentativas de caminho são recusadas', () => {
    const { params } = obter();
    for (const ruim of ['EMPRESA', 'PADRAO', 'Empresa', 'global', 'ambas', '', ' empresa', 'empresa ', 'empresa/..', '../padrao', 'padrao%2f', null, undefined, 1]) {
      const r = params.safeParse({ ...PARAMS, origem: ruim });
      assert.equal(r.success, false, JSON.stringify(ruim));
      assert.ok(caminhosComErro(r).includes('origem'), JSON.stringify(ruim));
    }
  });

  test('TIS-04 — variante: só miniatura|exibicao; o MESTRE nunca é servido ao tablet', () => {
    const { params } = obter();
    for (const ruim of ['mestre', 'original', 'MINIATURA', 'Exibicao', '', 'miniatura/', '../mestre', 'miniatura.webp', null, undefined]) {
      const r = params.safeParse({ ...PARAMS, variante: ruim });
      assert.equal(r.success, false, JSON.stringify(ruim));
      assert.ok(caminhosComErro(r).includes('variante'), JSON.stringify(ruim));
    }
  });

  test('TIS-05 — params estritos: nenhum campo extra (empresa, material, atendimento, dispositivo, funcionário) é aceito como parâmetro', () => {
    const { params } = obter();
    for (const extra of ['empresaId', 'materialId', 'atendimentoId', 'dispositivoId', 'funcionarioId', 'ghe', 'caminho']) {
      assert.equal(params.safeParse({ ...PARAMS, [extra]: '1' }).success, false, extra);
    }
  });

  test('TIS-06 — query: uma única chave opcional `v` (versão da imagem, inteiro de 1 a 2147483647, sem zeros à esquerda), devolvida como NÚMERO; ausente é válido', () => {
    const { query } = obter();
    assert.deepEqual(query.safeParse({}), { success: true, data: {} });
    assert.deepEqual(query.safeParse({ v: '1' }), { success: true, data: { v: 1 } });
    assert.deepEqual(query.safeParse({ v: '2147483647' }), { success: true, data: { v: 2147483647 } });
    for (const ruim of ['0', '-1', '+1', '01', '1.5', '1e2', '0x1', '2147483648', '9223372036854775807', 'abc', '', ' 1', '1 ', '１']) {
      const r = query.safeParse({ v: ruim });
      assert.equal(r.success, false, JSON.stringify(ruim));
      assert.ok(caminhosComErro(r).includes('v'), JSON.stringify(ruim));
    }
    assert.equal(query.safeParse({ v: ['1', '2'] }).success, false, 'v repetido');
  });

  test('TIS-07 — query estrita: empresa, material, atendimento, dispositivo, funcionário ou qualquer chave extra é recusada (nada vindo do navegador escolhe o escopo)', () => {
    const { query } = obter();
    for (const extra of ['empresaId', 'materialId', 'atendimentoId', 'dispositivoId', 'funcionarioId', 'ghe', 'caminho', 'origem', 'id', 'variante']) {
      assert.equal(query.safeParse({ [extra]: '1' }).success, false, extra);
      assert.equal(query.safeParse({ v: '1', [extra]: '1' }).success, false, `v + ${extra}`);
    }
  });

  test('TIS-08 — conversão controlada do catálogo para a rota: EMPRESA→empresa e PADRAO→padrao; qualquer outro valor (inclusive a forma da rota, outras grafias e tipos) é null', () => {
    const { origemDaRota } = modulo();
    assert.equal(typeof origemDaRota, 'function');
    assert.equal(origemDaRota('EMPRESA'), 'empresa');
    assert.equal(origemDaRota('PADRAO'), 'padrao');
    for (const ruim of ['empresa', 'padrao', 'Empresa', 'OUTRA', '', ' EMPRESA', 'EMPRESA ', null, undefined, 1, true, {}, ['EMPRESA'], Symbol.iterator]) {
      assert.equal(origemDaRota(ruim), null, String(typeof ruim === 'symbol' ? 'symbol' : JSON.stringify(ruim)));
    }
  });
});
