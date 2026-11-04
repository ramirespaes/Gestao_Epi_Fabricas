'use strict';

const path = require('node:path');
const { adquirirJanela, TIPOS } = require('../../../src/utils/janela-escrita-imagens');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('./tmp-seguro');

/**
 * CONS-02 (testes do armazenamento de imagens): a remoção física do armazenamento exige a POSSE da janela de LIMPEZA. Este helper adquire uma posse VERDADEIRA (arquivo de trava exclusivo de teste, num
 * diretório temporário FORA do armazenamento, protocolo real de `adquirirJanela`) para os testes de remoção LEGÍTIMA. Não existe posse falsa aqui: quem precisa de uma posse inválida a monta no próprio teste.
 */
async function adquirirPosseDeLimpeza(raizArmazenamento) {
  const pasta = criarRaizTemporaria();
  const posse = await adquirirJanela({ arquivo: path.join(pasta, 'janela.lock'), tipo: TIPOS.LIMPEZA, raizArmazenamento });
  return {
    posse,
    arquivo: path.join(pasta, 'janela.lock'),
    async liberar() {
      try { await posse.liberar(); } finally { removerTemporarioSeguro(pasta); }
    },
  };
}

module.exports = { adquirirPosseDeLimpeza };
