'use strict';

const { criarProcessadorDeImagens } = require('./imagem-processador.service');

/**
 * Único ponto de ativação do processador REAL de imagens no app (Biblioteca de Imagens, Unidade 5C-6). DESLIGADO por padrão: só o valor exato `ativo` de
 * IMAGENS_PROCESSADOR_REAL liga; qualquer outra coisa (ausente, vazio, outra grafia, propriedade herdada) devolve nulo, e sem processador o envio responde 503
 * IMAGENS_INDISPONIVEL antes de ler, processar ou gravar qualquer coisa. Ligado, ainda é preciso o diretório (IMAGENS_ARMAZENAMENTO_DIRETORIO). O processo decide
 * UMA vez e todos usam o mesmo processador, para que o encerramento do servidor alcance todos os filhos.
 */

const VARIAVEL_DE_ATIVACAO = 'IMAGENS_PROCESSADOR_REAL';
const VALOR_DE_ATIVACAO = 'ativo';

function criarProcessadorDoAmbiente({ origem = process.env, fabrica = criarProcessadorDeImagens } = {}) {
  const ligado = origem !== null && typeof origem === 'object'
    && Object.hasOwn(origem, VARIAVEL_DE_ATIVACAO) && origem[VARIAVEL_DE_ATIVACAO] === VALOR_DE_ATIVACAO;
  return ligado ? fabrica() : null;
}

let compartilhado;

function processadorDoProcesso() {
  if (compartilhado === undefined) compartilhado = criarProcessadorDoAmbiente();
  return compartilhado;
}

module.exports = { criarProcessadorDoAmbiente, processadorDoProcesso, VARIAVEL_DE_ATIVACAO, VALOR_DE_ATIVACAO };
