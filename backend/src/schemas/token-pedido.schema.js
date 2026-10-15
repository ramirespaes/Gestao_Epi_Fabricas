'use strict';

const { z } = require('zod');
const { LIMITES, idCorpo, textoCurto } = require('./campos.schema');
const { chaveIdempotencia } = require('./entrega-epi.schema');
const { MOTIVOS } = require('../repositories/solicitacao-epi-item.repository');
const { LIMITE_ITENS } = require('../services/solicitacao-epi.service');

/**
 * Pedido do tablet (Atendimento Token, Etapa F). Só formato e limites; a elegibilidade (GHE, material, tamanho) é do serviço, com o estado de
 * agora. strictObject: empresa, funcionário, GHE, tablet, atendimento, origem, solicitante, status, número, decisão e observação NUNCA vêm
 * do cliente, e não há texto livre (nem observação, nem justificativa).
 *
 * MOTIVOS DO TOTEM (decisão D-F2): só os três abaixo, todos já pertencentes ao fluxo da 12G-6; ADMISSAO e OUTRO (que exige texto livre)
 * seguem existindo para o atendimento interno e NÃO são oferecidos nem aceitos aqui. Quantidade, tamanho e limite de itens são os da 12G.
 */

const MOTIVOS_DO_TOTEM = Object.freeze(['SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO']);
for (const motivo of MOTIVOS_DO_TOTEM) {
  if (!MOTIVOS.includes(motivo)) throw new Error(`motivo do Totem inexistente na 12G-6: ${motivo}`);
}

const TAMANHO_MAXIMO = 20;

const item = z.strictObject({
  materialId: idCorpo,
  tamanho: textoCurto(TAMANHO_MAXIMO, 'TAMANHO_INVALIDO', 'Tamanho inválido').nullable().optional(),
  quantidade: z.number().int().positive().max(LIMITES.INTEGER_MAXIMO),
  motivo: z.enum(MOTIVOS_DO_TOTEM),
});

const finalizar = {
  query: z.strictObject({}),
  body: z.strictObject({
    chaveIdempotencia,
    itens: z.array(item).min(1).max(LIMITE_ITENS),
  }),
};

const resultado = {
  params: z.strictObject({ chave: chaveIdempotencia }),
  query: z.strictObject({}),
};

module.exports = { MOTIVOS_DO_TOTEM, TAMANHO_MAXIMO, finalizar, resultado };
