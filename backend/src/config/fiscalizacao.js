'use strict';

const path = require('node:path');

/**
 * Configuração do pacote de fiscalização (12K-D6). Limites aprovados: 100.000 linhas POR módulo, 100 MiB para o ZIP inteiro,
 * 366 dias inclusivos e uma geração por empresa. O diretório de armazenamento vem SÓ do ambiente (nunca fixado no código) e
 * precisa ficar fora do repositório e de qualquer pasta pública: isso é responsabilidade de quem configura o ambiente.
 * Mensagens de erro nunca levam o valor recebido.
 */

const LIMITE_LINHAS_POR_MODULO = 100000;
const LIMITE_BYTES_ZIP = 100 * 1024 * 1024;
const PERIODO_MAXIMO_DIAS = 366;
const HEARTBEAT_PADRAO_SEGUNDOS = 15;
const ABANDONO_PADRAO_SEGUNDOS = 120;
const FATOR_MINIMO_ABANDONO = 3;
const DECIMAL = /^[1-9][0-9]{0,5}$/;

function segundos(origem, nome, rotulo, padrao) {
  const bruto = origem[nome];
  if (bruto === undefined || String(bruto).trim() === '') return padrao;
  if (!DECIMAL.test(String(bruto).trim())) throw new Error(`${nome}: ${rotulo} deve ser um inteiro positivo em segundos`);
  return Number(String(bruto).trim());
}

function lerParametros(origem) {
  const heartbeat = segundos(origem, 'FISCALIZACAO_HEARTBEAT_SEGUNDOS', 'heartbeat', HEARTBEAT_PADRAO_SEGUNDOS);
  const abandono = segundos(origem, 'FISCALIZACAO_ABANDONO_SEGUNDOS', 'abandono', ABANDONO_PADRAO_SEGUNDOS);
  if (abandono < heartbeat * FATOR_MINIMO_ABANDONO) {
    throw new Error(`FISCALIZACAO_ABANDONO_SEGUNDOS: o abandono deve ser de pelo menos ${FATOR_MINIMO_ABANDONO} vezes o heartbeat`);
  }
  return {
    limiteLinhasPorModulo: LIMITE_LINHAS_POR_MODULO,
    limiteBytesZip: LIMITE_BYTES_ZIP,
    periodoMaximoDias: PERIODO_MAXIMO_DIAS,
    heartbeatMs: heartbeat * 1000,
    abandonoMs: abandono * 1000,
    geracoesSimultaneasPorEmpresa: 1,
  };
}

/** Configuração completa; o diretório é obrigatório. */
function lerConfiguracao(origem = process.env) {
  const diretorio = typeof origem.FISCALIZACAO_ARMAZENAMENTO_DIRETORIO === 'string' ? origem.FISCALIZACAO_ARMAZENAMENTO_DIRETORIO.trim() : '';
  if (!diretorio) throw new Error('FISCALIZACAO_ARMAZENAMENTO_DIRETORIO: obrigatória');
  if (!path.isAbsolute(diretorio)) throw new Error('FISCALIZACAO_ARMAZENAMENTO_DIRETORIO: deve ser um caminho absoluto');
  return Object.freeze({ ...lerParametros(origem), diretorio });
}

/** Igual à completa, mas devolve null quando o diretório não foi configurado (a API sobe; o D6 responde indisponível). */
function lerConfiguracaoOpcional(origem = process.env) {
  const definido = typeof origem.FISCALIZACAO_ARMAZENAMENTO_DIRETORIO === 'string' && origem.FISCALIZACAO_ARMAZENAMENTO_DIRETORIO.trim() !== '';
  return definido ? lerConfiguracao(origem) : null;
}

module.exports = {
  lerConfiguracao, lerConfiguracaoOpcional, LIMITE_LINHAS_POR_MODULO, LIMITE_BYTES_ZIP, PERIODO_MAXIMO_DIAS,
};
