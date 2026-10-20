'use strict';

const { lerConfiguracao } = require('../config/imagens');
const { criarArmazenamentoImagens } = require('../storage/armazenamento-imagens');
const { criarEntregaDeImagens } = require('./imagem-material-entrega.service');

/**
 * Monta a entrega de imagens com a configuração do ambiente (Biblioteca de Imagens, Unidade 5A-1). Sem IMAGENS_ARMAZENAMENTO_DIRETORIO
 * devolve null: a API sobe normalmente e a entrega responde 503, em vez de ler de um caminho que ninguém escolheu. Diretório inválido
 * falha cedo, sem ecoar o valor. Função pura da origem recebida (não lê process.env quando recebe um objeto).
 */
function criarEntregaDoAmbiente(origem = process.env) {
  const { diretorio } = lerConfiguracao(origem);
  if (diretorio === null) return null;
  return criarEntregaDeImagens({ armazenamento: criarArmazenamentoImagens({ diretorio }) });
}

module.exports = { criarEntregaDoAmbiente };
