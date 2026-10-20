'use strict';

// Pré-carga de teste (node --require), só para processos filhos de teste: o sharp real, mas a geração das variantes (toBuffer sem resolveWithObject) falha com uma
// mensagem sensível. O erro leva `codigo` só se PRE_CARGA_CODIGO existir. A leitura da entrada (toBuffer com resolveWithObject) segue normal.
const sharp = require('sharp');

const original = sharp.prototype.toBuffer;
sharp.prototype.toBuffer = function toBuffer(opcoes) {
  if (opcoes && opcoes.resolveWithObject) return original.call(this, opcoes);
  const erro = new Error('explosão de teste SEGREDO-NA-MENSAGEM em /caminho/secreto/do/servidor');
  if (process.env.PRE_CARGA_CODIGO) erro.codigo = process.env.PRE_CARGA_CODIGO;
  return Promise.reject(erro);
};
