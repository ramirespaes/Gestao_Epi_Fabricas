'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { lerConfiguracao } = require('../../src/config/imagens');

/**
 * Biblioteca de Imagens, Unidade 5A-1 (RED) — configuração da ENTREGA de arquivos, em src/config/imagens.js (função pura da origem recebida).
 * Dois campos novos, ambos lidos SÓ do ambiente:
 *   entregasPorMinutoIp  <- IMAGENS_ENTREGAS_POR_MINUTO_IP  (inteiro de 1 a 100000; o VALOR OPERACIONAL padrão não é fixado nestes testes —
 *                           a capacidade será avaliada no GREEN; aqui só o mecanismo, inclusive um limite reduzido para os testes);
 *   entregaCorp          <- IMAGENS_ENTREGA_CORP            ('same-origin' padrão; 'same-site' só FORA de produção, para o frontend e a API
 *                           em portas distintas do mesmo site no desenvolvimento local; produção nunca flexibiliza a política).
 * Mensagens de erro nomeiam a variável e nunca levam o valor recebido (CFG-04).
 */

const campo = (configuracao, nome) => {
  assert.equal(Object.hasOwn(configuracao, nome), true, `${nome} ainda não existe na configuração das imagens (não implementado)`);
  return configuracao[nome];
};
const recusada = (origem) => {
  try { lerConfiguracao(origem); } catch (falha) { return falha; }
  return assert.fail(`a configuração inválida foi aceita (recusa ainda não implementada): ${JSON.stringify(origem)}`);
};

describe('[CFG-ENT] limite próprio das entregas por IP', () => {
  test('CFG-ENT-01 — entregasPorMinutoIp existe e o padrão é um inteiro positivo (o valor operacional não é fixado aqui)', () => {
    const padrao = campo(lerConfiguracao({}), 'entregasPorMinutoIp');
    assert.equal(Number.isInteger(padrao) && padrao >= 1, true, String(padrao));
  });

  test('CFG-ENT-02 — IMAGENS_ENTREGAS_POR_MINUTO_IP aceita de 1 (limite reduzido para testes) a 100000, com espaços ao redor; em branco usa o padrão', () => {
    const padrao = campo(lerConfiguracao({}), 'entregasPorMinutoIp');
    assert.equal(campo(lerConfiguracao({ IMAGENS_ENTREGAS_POR_MINUTO_IP: '1' }), 'entregasPorMinutoIp'), 1);
    assert.equal(campo(lerConfiguracao({ IMAGENS_ENTREGAS_POR_MINUTO_IP: ' 7 ' }), 'entregasPorMinutoIp'), 7);
    assert.equal(campo(lerConfiguracao({ IMAGENS_ENTREGAS_POR_MINUTO_IP: '100000' }), 'entregasPorMinutoIp'), 100000);
    assert.equal(campo(lerConfiguracao({ IMAGENS_ENTREGAS_POR_MINUTO_IP: '   ' }), 'entregasPorMinutoIp'), padrao);
  });

  test('CFG-ENT-03 — valor fora do intervalo ou mal formado é recusado com IMAGENS_CONFIGURACAO_INVALIDA, nomeando a variável; a mensagem nunca ecoa o valor recebido', () => {
    for (const ruim of ['0', '100001', '-1', '1.5', 'abc', '1e3', '0x10', '9999999']) {
      const falha = recusada({ IMAGENS_ENTREGAS_POR_MINUTO_IP: ruim });
      assert.equal(falha.codigo, 'IMAGENS_CONFIGURACAO_INVALIDA', ruim);
      assert.match(falha.message, /IMAGENS_ENTREGAS_POR_MINUTO_IP/, ruim);
    }
    // Valores distintivos (os curtos podem coincidir com números do próprio texto da mensagem): nada do que veio de fora volta na mensagem.
    for (const distintivo of ['segredo-xyz-417', '73190482']) {
      const falha = recusada({ IMAGENS_ENTREGAS_POR_MINUTO_IP: distintivo });
      assert.equal(falha.message.includes(distintivo), false, `a mensagem ecoou ${distintivo}`);
    }
  });
});

describe('[CFG-ENT] política CORP da imagem entregue', () => {
  test('CFG-ENT-04 — o padrão é same-origin, com ou sem NODE_ENV, e same-origin explícito é aceito inclusive em produção', () => {
    assert.equal(campo(lerConfiguracao({}), 'entregaCorp'), 'same-origin');
    assert.equal(campo(lerConfiguracao({ NODE_ENV: 'production' }), 'entregaCorp'), 'same-origin');
    assert.equal(campo(lerConfiguracao({ NODE_ENV: 'production', IMAGENS_ENTREGA_CORP: 'same-origin' }), 'entregaCorp'), 'same-origin');
  });

  test('CFG-ENT-05 — same-site é aceito FORA de produção (desenvolvimento local com portas distintas do mesmo site)', () => {
    for (const ambiente of [undefined, 'development', 'test']) {
      const origem = { IMAGENS_ENTREGA_CORP: 'same-site', ...(ambiente === undefined ? {} : { NODE_ENV: ambiente }) };
      assert.equal(campo(lerConfiguracao(origem), 'entregaCorp'), 'same-site', String(ambiente));
    }
  });

  test('CFG-ENT-06 — em produção same-site é RECUSADO (a política não se flexibiliza em produção), sem ecoar o valor', () => {
    const falha = recusada({ NODE_ENV: 'production', IMAGENS_ENTREGA_CORP: 'same-site' });
    assert.equal(falha.codigo, 'IMAGENS_CONFIGURACAO_INVALIDA');
    assert.match(falha.message, /IMAGENS_ENTREGA_CORP/);
  });

  test('CFG-ENT-07 — qualquer outro valor é recusado (cross-origin, *, maiúsculas, texto livre), nomeando a variável e sem ecoar texto livre', () => {
    for (const ruim of ['cross-origin', '*', 'SAME-SITE', 'Same-Origin', 'none', 'segredo-xyz-417']) {
      const falha = recusada({ IMAGENS_ENTREGA_CORP: ruim });
      assert.equal(falha.codigo, 'IMAGENS_CONFIGURACAO_INVALIDA', ruim);
      assert.match(falha.message, /IMAGENS_ENTREGA_CORP/, ruim);
    }
    assert.equal(recusada({ IMAGENS_ENTREGA_CORP: 'segredo-xyz-417' }).message.includes('segredo-xyz-417'), false);
  });

  test('CFG-ENT-08 — os dois campos novos fazem parte do objeto congelado e não alteram a origem recebida', () => {
    const origem = { IMAGENS_ENTREGAS_POR_MINUTO_IP: '5', IMAGENS_ENTREGA_CORP: 'same-site' };
    const copia = { ...origem };
    const c = lerConfiguracao(origem);
    campo(c, 'entregasPorMinutoIp');
    campo(c, 'entregaCorp');
    assert.equal(Object.isFrozen(c), true);
    assert.deepEqual(origem, copia);
  });
});
