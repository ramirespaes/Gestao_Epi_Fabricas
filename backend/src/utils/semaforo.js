'use strict';

/**
 * Semáforo assíncrono de processo (Biblioteca de Imagens, Unidade 5C-2): no máximo `limite` tarefas ao mesmo tempo; as demais esperam a vez em fila
 * FIFO. Serve para limitar a decodificação de imagem, que é a operação cara do envio: o limite vale por PROCESSO, independentemente de empresa,
 * usuário ou requisição, e nunca depende de trava do banco.
 *
 * - A vaga é devolvida sempre, inclusive quando a tarefa lança (finally); o erro da tarefa chega intacto a quem chamou.
 * - Quando alguém espera, a vaga passa DIRETO ao primeiro da fila (o contador de uso não cai e sobe de novo), então nenhuma tarefa nova
 *   "fura a fila" entre a liberação e o despertar do próximo.
 * - Unidade 5C-4: FILA MÁXIMA e ESPERA MÁXIMA, opcionais (`criarSemaforo(limite, { filaMaxima, esperaMaximaMs })`). Sem elas nada muda (fila ilimitada, espera sem prazo).
 *   Com elas: a tarefa que não cabe na fila é recusada NA HORA (ErroDeSemaforo SEMAFORO_FILA_CHEIA); a que espera além do prazo sai da fila e é recusada
 *   (SEMAFORO_ESPERA_EXCEDIDA). Uma recusada nunca roda e nunca ocupa vaga. O temporizador de espera é cancelado quando a vez chega, quando vence e quando a fila recusa:
 *   nenhum caminho deixa Timeout para trás. O tempo máximo da EXECUÇÃO continua sendo do processador (o semáforo só decide quem entra).
 */

const MENSAGENS = Object.freeze({
  SEMAFORO_FILA_CHEIA: 'Capacidade de processamento esgotada',
  SEMAFORO_ESPERA_EXCEDIDA: 'Tempo de espera por processamento excedido',
});

/** Recusa do semáforo: código estável e mensagem fixa (nada de quem chamou). */
class ErroDeSemaforo extends Error {
  constructor(codigo) {
    if (typeof codigo !== 'string' || !Object.hasOwn(MENSAGENS, codigo)) throw new TypeError('código de recusa do semáforo desconhecido');
    super(MENSAGENS[codigo]);
    this.name = 'ErroDeSemaforo';
    this.codigo = codigo;
  }
}

function criarSemaforo(limite, opcoes = {}) {
  if (!Number.isInteger(limite) || limite < 1) throw new TypeError('limite do semáforo inválido');
  if (opcoes === null || typeof opcoes !== 'object' || Array.isArray(opcoes)) throw new TypeError('opções do semáforo inválidas');
  const { filaMaxima = Infinity, esperaMaximaMs = Infinity } = opcoes;
  if (filaMaxima !== Infinity && (!Number.isInteger(filaMaxima) || filaMaxima < 0)) throw new TypeError('fila máxima do semáforo inválida');
  if (esperaMaximaMs !== Infinity && (!Number.isInteger(esperaMaximaMs) || esperaMaximaMs < 1)) throw new TypeError('espera máxima do semáforo inválida');
  let emUso = 0;
  const fila = [];

  function liberar() {
    const proximo = fila.shift();
    if (proximo !== undefined) {
      clearTimeout(proximo.temporizador);
      proximo.acordar();
      return;
    }
    emUso -= 1;
  }

  function esperarAVez() {
    return new Promise((acordar, recusar) => {
      const entrada = { acordar, temporizador: undefined };
      if (esperaMaximaMs !== Infinity) {
        entrada.temporizador = setTimeout(() => {
          const posicao = fila.indexOf(entrada);
          if (posicao >= 0) fila.splice(posicao, 1);
          recusar(new ErroDeSemaforo('SEMAFORO_ESPERA_EXCEDIDA'));
        }, esperaMaximaMs);
      }
      fila.push(entrada);
    });
  }

  async function executar(tarefa) {
    if (typeof tarefa !== 'function') throw new TypeError('a tarefa do semáforo deve ser uma função');
    if (emUso < limite) {
      emUso += 1;
    } else {
      if (fila.length >= filaMaxima) throw new ErroDeSemaforo('SEMAFORO_FILA_CHEIA');
      await esperarAVez();
    }
    try {
      return await tarefa();
    } finally {
      liberar();
    }
  }

  return Object.freeze({
    executar,
    get emUso() { return emUso; },
    get esperando() { return fila.length; },
  });
}

module.exports = { criarSemaforo, ErroDeSemaforo };
