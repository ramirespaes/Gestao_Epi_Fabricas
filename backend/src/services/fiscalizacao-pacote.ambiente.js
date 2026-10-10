'use strict';

const { lerConfiguracaoOpcional } = require('../config/fiscalizacao');
const { criarArmazenamentoLocal } = require('../storage/armazenamento-local');
const { criarFiscalizacaoPacoteService } = require('./fiscalizacao-pacote.service');

/**
 * Monta o serviço da Fiscalização com a configuração do ambiente (12K-D6). Sem FISCALIZACAO_ARMAZENAMENTO_DIRETORIO devolve null: a
 * API sobe normalmente e as rotas da Fiscalização respondem 503, em vez de gravar em um caminho que ninguém escolheu.
 */
function criarServicoDoAmbiente(pool, origem = process.env) {
  const config = lerConfiguracaoOpcional(origem);
  if (!config) return null;
  return criarFiscalizacaoPacoteService({ pool, armazenamento: criarArmazenamentoLocal({ diretorio: config.diretorio }), config });
}

module.exports = { criarServicoDoAmbiente };
