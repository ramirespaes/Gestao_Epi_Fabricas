'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { criarSemaforo } = require('../../src/utils/semaforo');

/**
 * Biblioteca de Imagens, Unidade 5C-2 — o semáforo de processo que limita a decodificação de imagem: no máximo N tarefas ao mesmo tempo, as demais
 * esperam em fila FIFO, a vaga volta sempre (inclusive quando a tarefa lança) e o erro da tarefa chega intacto. Sem relógio: só ordem de eventos.
 */

const proximosTicks = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };

/** Uma tarefa que só termina quando o teste manda; registra início e fim na linha do tempo comum. */
function tarefaControlada(rotulo, registro) {
  let liberar;
  const portao = new Promise((resolve) => { liberar = resolve; });
  return {
    executar: async () => {
      registro.push(`inicio:${rotulo}`);
      await portao;
      registro.push(`fim:${rotulo}`);
      return rotulo;
    },
    liberar: () => liberar(),
  };
}

describe('criarSemaforo — argumentos', () => {
  test('SEM-01 — o limite precisa ser um inteiro a partir de 1; qualquer outra coisa é erro de programação', () => {
    for (const invalido of [0, -1, 1.5, '2', null, undefined, Number.NaN, Infinity]) {
      assert.throws(() => criarSemaforo(invalido), TypeError, String(invalido));
    }
  });

  test('SEM-02 — a tarefa precisa ser uma função (TypeError) e uma chamada recusada não ocupa vaga', async () => {
    const s = criarSemaforo(1);
    await assert.rejects(s.executar('não é função'), TypeError);
    await assert.rejects(s.executar(undefined), TypeError);
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
  });
});

describe('criarSemaforo — limite e fila', () => {
  test('SEM-03 — nunca passa do limite e as demais entram na ordem de chegada (FIFO); contadores corretos do começo ao fim', async () => {
    const registro = [];
    const s = criarSemaforo(2);
    const tarefas = ['A', 'B', 'C', 'D', 'E'].map((r) => tarefaControlada(r, registro));
    const execucoes = tarefas.map((t) => s.executar(t.executar));
    await proximosTicks();
    assert.deepEqual(registro, ['inicio:A', 'inicio:B']);
    assert.deepEqual([s.emUso, s.esperando], [2, 3]);

    tarefas[0].liberar();
    await proximosTicks();
    assert.deepEqual(registro, ['inicio:A', 'inicio:B', 'fim:A', 'inicio:C']);
    assert.deepEqual([s.emUso, s.esperando], [2, 2]);

    tarefas[1].liberar();
    tarefas[2].liberar();
    await proximosTicks();
    assert.deepEqual(registro.filter((e) => e.startsWith('inicio:')), ['inicio:A', 'inicio:B', 'inicio:C', 'inicio:D', 'inicio:E']);
    assert.deepEqual([s.emUso, s.esperando], [2, 0]);

    tarefas[3].liberar();
    tarefas[4].liberar();
    assert.deepEqual(await Promise.all(execucoes), ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
  });

  test('SEM-04 — com muitas tarefas curtas o máximo simultâneo observado é exatamente o limite, e todas terminam com o seu resultado', async () => {
    const s = criarSemaforo(3);
    let atual = 0;
    let maximo = 0;
    const tarefa = (i) => async () => {
      atual += 1;
      maximo = Math.max(maximo, atual);
      await proximosTicks(2);
      atual -= 1;
      return i;
    };
    const resultados = await Promise.all(Array.from({ length: 20 }, (_, i) => s.executar(tarefa(i))));
    assert.deepEqual(resultados, Array.from({ length: 20 }, (_, i) => i));
    assert.equal(maximo, 3);
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
  });

  test('SEM-05 — a vaga volta quando a tarefa lança: o erro chega intacto a quem chamou e a próxima da fila segue', async () => {
    const registro = [];
    const s = criarSemaforo(1);
    const defeito = new Error('falha da tarefa');
    const primeira = s.executar(async () => { registro.push('inicio:1'); await proximosTicks(2); throw defeito; });
    const segunda = s.executar(async () => { registro.push('inicio:2'); return 'ok'; });
    await assert.rejects(primeira, (erro) => erro === defeito);
    assert.equal(await segunda, 'ok');
    assert.deepEqual(registro, ['inicio:1', 'inicio:2']);
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
  });

  test('SEM-06 — tarefa síncrona e valor de retorno: o resultado é o da tarefa e a vaga é devolvida', async () => {
    const s = criarSemaforo(1);
    assert.equal(await s.executar(() => 7), 7);
    assert.equal(await s.executar(async () => 'depois'), 'depois');
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
  });

  test('SEM-07 — com limite 1 a execução é estritamente serial, mesmo com as tarefas chegando todas de uma vez', async () => {
    const registro = [];
    const s = criarSemaforo(1);
    const tarefa = (r) => async () => { registro.push(`inicio:${r}`); await proximosTicks(2); registro.push(`fim:${r}`); };
    await Promise.all(['a', 'b', 'c'].map((r) => s.executar(tarefa(r))));
    assert.deepEqual(registro, ['inicio:a', 'fim:a', 'inicio:b', 'fim:b', 'inicio:c', 'fim:c']);
  });
});
