'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * 12G-6 — janela do aviso de disponibilidade (ALERTA_ESTOQUE_JANELA_MINUTOS):
 * padrão 10 minutos depois da última entrada relevante, de 1 a 120, decimal
 * canônico, e o erro de configuração nunca repete o valor recebido.
 */

const modulo = () => exigirModulo('src/config/alertas-estoque');
const carregar = (origem) => modulo().carregarConfigAlertasEstoque(origem);

describe('configuração dos alertas de estoque', () => {
  test('padrão de 10 minutos; aceita de 1 a 120', () => {
    assert.equal(carregar({}).janelaMinutos, 10);
    assert.equal(carregar({ ALERTA_ESTOQUE_JANELA_MINUTOS: '1' }).janelaMinutos, 1);
    assert.equal(carregar({ ALERTA_ESTOQUE_JANELA_MINUTOS: '120' }).janelaMinutos, 120);
    assert.equal(carregar({ ALERTA_ESTOQUE_JANELA_MINUTOS: '   ' }).janelaMinutos, 10, 'vazio conta como ausente');
    assert.ok(Object.isFrozen(carregar({})));
  });

  test('recusa fora do intervalo ou fora do formato, sem repetir o valor', () => {
    for (const ruim of ['0', '121', '1.5', '01', '-5', 'dez', '1e1']) {
      assert.throws(() => carregar({ ALERTA_ESTOQUE_JANELA_MINUTOS: ruim }), (erro) => {
        assert.match(erro.message, /ALERTA_ESTOQUE_JANELA_MINUTOS/);
        assert.equal(erro.message.includes(`: ${ruim}`) || erro.message.includes(`"${ruim}"`), false, ruim);
        return true;
      }, ruim);
    }
  });

  test('.env.example documenta a janela com o padrão e o exemplo é aceito', () => {
    const exemplo = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8'));
    assert.equal(exemplo.ALERTA_ESTOQUE_JANELA_MINUTOS, '10');
    assert.equal(carregar(exemplo).janelaMinutos, 10);
  });
});
