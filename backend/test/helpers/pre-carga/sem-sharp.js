'use strict';

// Pré-carga de teste (node --require), só para processos filhos de teste: faz o require('sharp') falhar como num servidor sem o binário nativo.
const Module = require('node:module');

const carregarOriginal = Module._load;
Module._load = function carregar(pedido, ...resto) {
  if (pedido === 'sharp') throw Object.assign(new Error('falha simulada ao carregar o sharp SEGREDO-NA-MENSAGEM em /caminho/secreto/do/servidor'), { code: 'ERR_DLOPEN_FAILED' });
  return carregarOriginal.call(this, pedido, ...resto);
};
