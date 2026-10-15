'use strict';

/**
 * Monitoramento de comunicação do tablet do Atendimento Token (Etapa J, J2a).
 * Constantes aprovadas, sem variável de ambiente: alterá-las muda o contrato do monitoramento.
 */

// Cadência do heartbeat do cliente e variação aleatória máxima sobre ela (10%): intervalo real entre 54 s e 66 s.
const HEARTBEAT_INTERVALO_MS = 60000;
const HEARTBEAT_JITTER = 0.1;

// Silêncio, em segundos, a partir do qual (inclusive) o estado efetivo deixa de ser ONLINE.
const LIMIAR_OFFLINE_SEGUNDOS = 180;

// Tempo adicional de observação, em segundos, antes de a transição QUEDA ser formalizada.
const CONFIRMACAO_SEGUNDOS = 90;

// Janela mínima, em segundos, entre duas escritas de contato do mesmo tablet. Só o valor: o mecanismo de escrita é de outra fase.
const JANELA_ESCRITA_MINIMA_SEGUNDOS = 45;

// Prazo máximo de validade, em segundos, de uma suspeita pendente (inclusive). Com a passagem do job a cada 60 s, são cinco
// períodos: uma suspeita mais velha que isto indica passagens perdidas e nunca confirma QUEDA; recomeça como nova primeira observação.
const PRAZO_MAXIMO_SUSPEITA_SEGUNDOS = 300;

module.exports = Object.freeze({
  HEARTBEAT_INTERVALO_MS,
  HEARTBEAT_JITTER,
  LIMIAR_OFFLINE_SEGUNDOS,
  CONFIRMACAO_SEGUNDOS,
  JANELA_ESCRITA_MINIMA_SEGUNDOS,
  PRAZO_MAXIMO_SUSPEITA_SEGUNDOS,
});
