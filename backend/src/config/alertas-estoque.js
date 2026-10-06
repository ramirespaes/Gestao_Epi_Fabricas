'use strict';

const { z } = require('zod');
const { inteiroDeAmbiente, validarAmbiente, congelarProfundo } = require('./ambiente');

/**
 * Aviso de disponibilidade para entrega (12G-6): quantos minutos depois da
 * última entrada relevante o e-mail consolidado da empresa fica pronto para
 * o processador (ALERTA_ESTOQUE_JANELA_MINUTOS, padrão 10).
 */

const INTEIROS = Object.freeze({
  ALERTA_ESTOQUE_JANELA_MINUTOS: { min: 1, max: 120, padrao: 10 },
});

const VARIAVEIS_CONHECIDAS = Object.keys(INTEIROS);

function carregarConfigAlertasEstoque(origem = process.env) {
  const e = validarAmbiente({
    esquema: z.object({ ALERTA_ESTOQUE_JANELA_MINUTOS: inteiroDeAmbiente(INTEIROS.ALERTA_ESTOQUE_JANELA_MINUTOS) }),
    origem,
    titulo: 'Configuração dos alertas de estoque',
    conhecidas: VARIAVEIS_CONHECIDAS,
    inteiros: INTEIROS,
  });
  return congelarProfundo({ janelaMinutos: e.ALERTA_ESTOQUE_JANELA_MINUTOS });
}

const alertasEstoqueConfig = carregarConfigAlertasEstoque();

module.exports = { alertasEstoqueConfig, carregarConfigAlertasEstoque, INTEIROS };
