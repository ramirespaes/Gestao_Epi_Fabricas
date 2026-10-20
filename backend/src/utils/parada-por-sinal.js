'use strict';

const os = require('node:os');

/**
 * Pedido de parada por sinal (Biblioteca de Imagens, P-ORF-01, G7). SIGINT e SIGTERM deixam de matar o processo no meio de um trabalho que segura uma trava e viram um PEDIDO que o
 * trabalho consulta entre uma unidade e outra (`deveParar()`): a unidade em andamento termina, nenhuma outra começa e quem segura a trava a solta pelo caminho normal, com a prova
 * de posse pelo token. O manipulador só registra o primeiro sinal e avisa (`aoReceber(sinal, ordem)`); nunca encerra o processo, nunca envia sinal, nunca toca em arquivo ou banco,
 * e um erro do aviso nunca escapa dele (um erro ali derrubaria o processo e deixaria a trava). Sinais seguintes não mudam o primeiro. SIGKILL, falta de energia e memória esgotada
 * não têm tratamento possível: a trava fica e só a recuperação controlada a resolve.
 *
 * O manipulador só deve existir enquanto há o que proteger: com `armado: false` nada é instalado até `armar()` (idempotente) e, até lá, o Node mantém o comportamento padrão (um
 * Ctrl-C durante uma conexão que não responde ainda mata o processo, porque nenhuma trava existe). `encerrar()` retira os ouvintes, devolve o comportamento padrão e é definitivo.
 */

const SINAIS_PADRAO = Object.freeze(['SIGINT', 'SIGTERM']);

function validarSinais(sinais) {
  if (!Array.isArray(sinais) || sinais.length === 0 || new Set(sinais).size !== sinais.length) throw new TypeError('sinais inválidos');
  for (const sinal of sinais) if (typeof sinal !== 'string' || !Number.isInteger(os.constants.signals[sinal])) throw new TypeError('sinal desconhecido');
  return [...sinais];
}

/** @returns {{deveParar: () => boolean, sinal: () => (string|null), armar: () => void, encerrar: () => void}} */
function criarParadaPorSinal({ processo = process, sinais = SINAIS_PADRAO, aoReceber, armado = true } = {}) {
  if (processo === null || typeof processo !== 'object' || typeof processo.on !== 'function' || typeof processo.removeListener !== 'function') throw new TypeError('processo inválido');
  if (aoReceber !== undefined && typeof aoReceber !== 'function') throw new TypeError('aviso inválido');
  if (typeof armado !== 'boolean') throw new TypeError('armado inválido');
  const lista = validarSinais(sinais);
  let recebido = null;
  let ordem = 0;
  let instalada = false;
  let encerrada = false;
  const ouvintes = new Map();
  for (const sinal of lista) {
    ouvintes.set(sinal, () => {
      ordem += 1;
      if (recebido === null) recebido = sinal;
      if (aoReceber === undefined) return;
      try {
        aoReceber(sinal, ordem);
      } catch {
        // o aviso é só cortesia: nunca pode derrubar quem está parando de forma segura
      }
    });
  }
  const retirar = () => { for (const [sinal, ouvinte] of ouvintes) processo.removeListener(sinal, ouvinte); };
  const instalar = () => {
    if (instalada || encerrada) return;
    try {
      for (const [sinal, ouvinte] of ouvintes) processo.on(sinal, ouvinte);
    } catch (falha) {
      retirar();
      throw falha;
    }
    instalada = true;
  };
  const desinstalar = () => {
    encerrada = true;
    if (!instalada) return;
    retirar();
    instalada = false;
  };
  if (armado) instalar();
  return Object.freeze({ deveParar: () => recebido !== null, sinal: () => recebido, armar: instalar, encerrar: desinstalar });
}

/** Código de saída de shell de um processo parado por sinal: 128 + o número do sinal (SIGINT 130, SIGTERM 143). */
function saidaDoSinal(sinal) {
  const numero = typeof sinal === 'string' ? os.constants.signals[sinal] : undefined;
  if (!Number.isInteger(numero)) throw new TypeError('sinal desconhecido');
  return 128 + numero;
}

module.exports = { criarParadaPorSinal, saidaDoSinal, SINAIS_PADRAO };
