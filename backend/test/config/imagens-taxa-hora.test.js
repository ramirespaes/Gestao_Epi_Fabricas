'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { lerConfiguracao } = require('../../src/config/imagens');

/**
 * Biblioteca de Imagens, Unidade 1 (complemento ao CFG-02): o PISO da taxa de envios por hora da empresa é 10 por si só, e não
 * apenas por coerência com a taxa por minuto. Com o limite por minuto no mínimo (1), valores abaixo de 10 por hora continuam recusados.
 */
describe('[CFG-02b] piso da taxa por hora da empresa com o limite por minuto em 1', () => {
  const MINUTO = { IMAGENS_ENVIOS_POR_MINUTO_USUARIO: '1' };

  test('5 e 9 por hora são recusados, nomeando a variável e sem ecoar o valor; 10 é aceito', () => {
    for (const hora of ['5', '9']) {
      assert.throws(() => lerConfiguracao({ ...MINUTO, IMAGENS_ENVIOS_POR_HORA_EMPRESA: hora }), (falha) => {
        assert.ok(falha.message.includes('IMAGENS_ENVIOS_POR_HORA_EMPRESA'), `hora=${hora}: a mensagem nomeia a variável`);
        assert.ok(falha.message.includes('10'), `hora=${hora}: a mensagem informa o piso`);
        return true;
      }, `hora=${hora}`);
    }
    const aceita = lerConfiguracao({ ...MINUTO, IMAGENS_ENVIOS_POR_HORA_EMPRESA: '10' });
    assert.equal(aceita.envioPorMinutoUsuario, 1);
    assert.equal(aceita.envioPorHoraEmpresa, 10);
  });

  test('os extremos 0, 1 e 1001 são recusados; o teto 1000 é aceito', () => {
    for (const hora of ['0', '1', '1001']) {
      assert.throws(() => lerConfiguracao({ ...MINUTO, IMAGENS_ENVIOS_POR_HORA_EMPRESA: hora }), /IMAGENS_ENVIOS_POR_HORA_EMPRESA/, `hora=${hora}`);
    }
    assert.equal(lerConfiguracao({ ...MINUTO, IMAGENS_ENVIOS_POR_HORA_EMPRESA: '1000' }).envioPorHoraEmpresa, 1000);
  });

  test('o piso vale também sem tocar no limite por minuto (padrão 10)', () => {
    assert.throws(() => lerConfiguracao({ IMAGENS_ENVIOS_POR_HORA_EMPRESA: '9' }), /IMAGENS_ENVIOS_POR_HORA_EMPRESA/);
    assert.equal(lerConfiguracao({ IMAGENS_ENVIOS_POR_HORA_EMPRESA: '10' }).envioPorHoraEmpresa, 10);
  });
});
