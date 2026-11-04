'use strict';

const crypto = require('node:crypto');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): CICLO DE VIDA DAS IDENTIDADES DE EXECUÇÃO de restauração. Registro em memória, LIMITADO e com política explícita; não conhece processos, janelas nem arquivos (expirar ou remover uma identidade NUNCA libera, encerra ou sinaliza nada).
 *
 * Estados: ATIVA (emitida, ainda não avaliada) -> CONCLUIDA (avaliada UMA vez pelo avaliador de produção, com a avaliação imutável guardada) ou EXPIRADA (ATIVA que passou de `ttlAtivaMs` sem ser avaliada). Uma identidade que não está no registro é DESCONHECIDA e nunca autoriza coisa alguma: por isso remover
 * entradas antigas não permite reapresentar evidências antigas como novas (sem entrada, a evidência é recusada, e a identidade tem 128 bits aleatórios e não é reaproveitada).
 *
 * Política (explícita e validada): `capacidade` (máximo de entradas), `ttlAtivaMs` (vida máxima de uma execução ATIVA; depois vira EXPIRADA e deixa de poder ser avaliada), `retencaoTerminalMs` (quanto tempo CONCLUIDA/EXPIRADA continuam consultáveis e recusando reapresentação antes de serem removidas).
 * Manutenção (a cada emissão e em `manter()`): marca EXPIRADA as ATIVAS vencidas e remove SÓ as terminais além da retenção. Entrada ATIVA dentro do prazo NUNCA é removida. Registro cheio depois da manutenção: `emitir` FALHA FECHADO (REGISTRO_DE_EXECUCOES_CHEIO), sem despejar nenhuma execução em andamento.
 * O relógio é monotônico (`process.hrtime`), injetável só na fábrica (testes).
 */

const IDENTIDADE = /^[0-9a-f]{32}$/;
const POLITICA_PADRAO = Object.freeze({ capacidade: 4096, ttlAtivaMs: 6 * 60 * 60 * 1000, retencaoTerminalMs: 24 * 60 * 60 * 1000 });
const relogioMonotonico = () => Number(process.hrtime.bigint() / 1000000n);
const inteiroPositivo = (v) => Number.isSafeInteger(v) && v > 0;

function erro(codigo) {
  const falha = new Error('registro de execuções');
  falha.code = codigo;
  return falha;
}

function criarRegistroDeExecucoes(opcoes = {}) {
  if (opcoes === null || typeof opcoes !== 'object' || Array.isArray(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['capacidade', 'ttlAtivaMs', 'retencaoTerminalMs', 'relogio'].includes(k))) throw new TypeError('política do registro inválida');
  const { capacidade, ttlAtivaMs, retencaoTerminalMs } = { ...POLITICA_PADRAO, ...opcoes };
  const relogio = opcoes.relogio === undefined ? relogioMonotonico : opcoes.relogio;
  if (!inteiroPositivo(capacidade) || !inteiroPositivo(ttlAtivaMs) || !inteiroPositivo(retencaoTerminalMs) || typeof relogio !== 'function') throw new TypeError('política do registro inválida');

  const entradas = new Map(); // id -> { estado, emitidaEm, terminalEm, avaliacao }

  /** Expira as ATIVAS vencidas (só muda o estado) e remove as TERMINAIS além da retenção. Nunca remove uma ATIVA no prazo. */
  function manter() {
    const agora = relogio();
    let expiradas = 0;
    let removidas = 0;
    for (const [id, e] of entradas) {
      if (e.estado === 'ATIVA' && agora - e.emitidaEm >= ttlAtivaMs) { e.estado = 'EXPIRADA'; e.terminalEm = agora; expiradas += 1; }
    }
    for (const [id, e] of entradas) {
      if (e.estado !== 'ATIVA' && agora - e.terminalEm >= retencaoTerminalMs) { entradas.delete(id); removidas += 1; }
    }
    let ativas = 0;
    for (const e of entradas.values()) if (e.estado === 'ATIVA') ativas += 1;
    return Object.freeze({ expiradas, removidas, ativas, total: entradas.size });
  }

  function emitir() {
    manter();
    if (entradas.size >= capacidade) throw erro('REGISTRO_DE_EXECUCOES_CHEIO');
    let id = crypto.randomBytes(16).toString('hex');
    if (entradas.has(id)) id = crypto.randomBytes(16).toString('hex'); // colisão de 128 bits: praticamente impossível; uma nova tentativa e, se repetir, falha
    if (entradas.has(id)) throw erro('IDENTIDADE_DUPLICADA');
    entradas.set(id, { estado: 'ATIVA', emitidaEm: relogio(), terminalEm: null, avaliacao: null });
    return Object.freeze({ id });
  }

  /** 'ATIVA' | 'CONCLUIDA' | 'EXPIRADA' | null (desconhecida: nunca emitida, ou já removida pela retenção). A expiração é aplicada na consulta. */
  function estado(id) {
    if (typeof id !== 'string' || !IDENTIDADE.test(id)) return null;
    const e = entradas.get(id);
    if (e === undefined) return null;
    if (e.estado === 'ATIVA' && relogio() - e.emitidaEm >= ttlAtivaMs) { e.estado = 'EXPIRADA'; e.terminalEm = relogio(); }
    return e.estado;
  }

  /** ATIVA -> CONCLUIDA, uma única vez, guardando a avaliação IMUTÁVEL. Qualquer outra situação devolve false e não altera nada. */
  function concluir(id, avaliacao) {
    if (estado(id) !== 'ATIVA' || avaliacao === null || typeof avaliacao !== 'object' || !Object.isFrozen(avaliacao)) return false;
    const e = entradas.get(id);
    e.estado = 'CONCLUIDA';
    e.terminalEm = relogio();
    e.avaliacao = avaliacao;
    return true;
  }

  /** A avaliação imutável já produzida (execução CONCLUIDA), sem reexecutar nada; nulo caso contrário. */
  function resultado(id) {
    return estado(id) === 'CONCLUIDA' ? entradas.get(id).avaliacao : null;
  }

  // ESCOPO DA GARANTIA (honesto): estado só deste processo, sem coordenação entre processos e sem persistência entre reinicializações. Uma evidência exportada, reconstruída ou reapresentada a outro processo ou depois de um reinício é DESCONHECIDA e nunca autoriza; mas este registro NÃO é defesa
  // durável nem compartilhada contra replay, e quem precisar reconhecer evidências entre processos precisa de coordenação compartilhada (fora do escopo, não implementada).
  return Object.freeze({ emitir, estado, concluir, resultado, manter, tamanho: () => entradas.size, escopo: 'PROCESSO_UNICO_VOLATIL', duravel: false, compartilhado: false, politica: Object.freeze({ capacidade, ttlAtivaMs, retencaoTerminalMs }) });
}

const REGISTRO_DE_EXECUCOES = criarRegistroDeExecucoes();

module.exports = { criarRegistroDeExecucoes, REGISTRO_DE_EXECUCOES, POLITICA_PADRAO };
