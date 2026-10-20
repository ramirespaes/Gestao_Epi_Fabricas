'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { criarSemaforo } = require('../../src/utils/semaforo');

/**
 * Biblioteca de Imagens, Unidade 5C-4 (VAL-10) — o semáforo ganha FILA MÁXIMA e ESPERA MÁXIMA. Por padrão continua como na 5C-2 (sem limite de fila nem de espera);
 * com as opções: a tarefa que não cabe na fila é recusada NA HORA (ErroDeSemaforo SEMAFORO_FILA_CHEIA), a que espera além do prazo sai da fila e é recusada
 * (SEMAFORO_ESPERA_EXCEDIDA), uma recusada nunca roda nem ocupa vaga, os temporizadores são sempre liberados e a ordem FIFO e a devolução da vaga não mudam.
 */

const proximosTicks = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };
const dormir = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const temporizadoresAtivos = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

function tarefaControlada(rotulo, registro) {
  let liberar;
  let falhar;
  const portao = new Promise((resolve, rejeitar) => { liberar = resolve; falhar = rejeitar; });
  return {
    executar: async () => { registro.push(`inicio:${rotulo}`); await portao; registro.push(`fim:${rotulo}`); return rotulo; },
    liberar: () => liberar(),
    falhar: (erro) => falhar(erro),
  };
}
const ErroDeSemaforo = () => require('../../src/utils/semaforo').ErroDeSemaforo;
const recusaCom = (codigo) => (erro) => {
  assert.ok(erro instanceof (ErroDeSemaforo()), `esperava ErroDeSemaforo e veio ${erro?.name}: ${erro?.message}`);
  assert.equal(erro.codigo, codigo);
  return true;
};

// Cada teste tem prazo próprio: um defeito que deixe uma tarefa esperando para sempre reprova ESSE teste em vez de travar a suíte inteira.
const teste = (nome, fn) => test(nome, { timeout: 5000 }, fn);

describe('criarSemaforo — opções de fila e espera', () => {
  teste('SFI-01 — filaMaxima e esperaMaximaMs só aceitam inteiros válidos (ou Infinity); o resto é erro de programação', () => {
    for (const invalido of [-1, 1.5, '3', null, Number.NaN, -Infinity]) assert.throws(() => criarSemaforo(2, { filaMaxima: invalido }), TypeError, `filaMaxima ${String(invalido)}`);
    for (const invalido of [0, -5, 2.5, '10', null, Number.NaN, -Infinity]) assert.throws(() => criarSemaforo(2, { esperaMaximaMs: invalido }), TypeError, `esperaMaximaMs ${String(invalido)}`);
    assert.doesNotThrow(() => criarSemaforo(2, { filaMaxima: 0 }));
    assert.doesNotThrow(() => criarSemaforo(2, { filaMaxima: Infinity, esperaMaximaMs: Infinity }));
    assert.doesNotThrow(() => criarSemaforo(2, { filaMaxima: 8, esperaMaximaMs: 10000 }));
    assert.throws(() => criarSemaforo(2, 'opções'), TypeError);
  });

  teste('SFI-02 — sem as opções nada muda: a fila é ilimitada (comportamento da 5C-2)', async () => {
    const registro = [];
    const s = criarSemaforo(1);
    const tarefas = Array.from({ length: 30 }, (_, i) => tarefaControlada(String(i), registro));
    const execucoes = tarefas.map((t) => s.executar(t.executar));
    await proximosTicks();
    assert.deepEqual([s.emUso, s.esperando], [1, 29]);
    for (const t of tarefas) { t.liberar(); await proximosTicks(2); }
    assert.equal((await Promise.all(execucoes)).length, 30);
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
  });

  teste('SFI-03 — fila cheia: com 2 em uso e 3 esperando, a sexta é recusada NA HORA, nunca roda, e as outras seguem na ordem', async () => {
    const registro = [];
    const s = criarSemaforo(2, { filaMaxima: 3 });
    const tarefas = ['A', 'B', 'C', 'D', 'E', 'F'].map((r) => tarefaControlada(r, registro));
    const execucoes = tarefas.slice(0, 5).map((t) => s.executar(t.executar));
    await proximosTicks();
    assert.deepEqual([s.emUso, s.esperando], [2, 3]);
    await assert.rejects(s.executar(tarefas[5].executar), recusaCom('SEMAFORO_FILA_CHEIA'));
    assert.deepEqual([s.emUso, s.esperando], [2, 3], 'a recusada não ocupa vaga nem lugar na fila');
    assert.ok(!registro.includes('inicio:F'), 'a recusada nunca começou');
    for (const t of tarefas.slice(0, 5)) { t.liberar(); await proximosTicks(2); }
    assert.deepEqual(await Promise.all(execucoes), ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(registro.filter((e) => e.startsWith('inicio:')), ['inicio:A', 'inicio:B', 'inicio:C', 'inicio:D', 'inicio:E']);
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
  });

  teste('SFI-04 — filaMaxima 0: ninguém espera; a primeira que não cabe no limite é recusada', async () => {
    const registro = [];
    const s = criarSemaforo(1, { filaMaxima: 0 });
    const a = tarefaControlada('A', registro);
    const execA = s.executar(a.executar);
    await proximosTicks();
    await assert.rejects(s.executar(async () => 'B'), recusaCom('SEMAFORO_FILA_CHEIA'));
    a.liberar();
    assert.equal(await execA, 'A');
    assert.equal(await s.executar(async () => 'C'), 'C');
  });

  teste('SFI-05 — espera máxima: quem espera além do prazo sai da fila e é recusado; a tarefa dele nunca roda; a vaga de quem está rodando não se perde', async () => {
    const registro = [];
    const s = criarSemaforo(1, { esperaMaximaMs: 60 });
    const a = tarefaControlada('A', registro);
    const execA = s.executar(a.executar);
    await proximosTicks();
    let rodouB = false;
    const t0 = Date.now();
    await assert.rejects(s.executar(async () => { rodouB = true; }), recusaCom('SEMAFORO_ESPERA_EXCEDIDA'));
    const esperou = Date.now() - t0;
    assert.ok(esperou >= 50 && esperou < 1000, `esperou ${esperou} ms`);
    assert.equal(rodouB, false);
    assert.deepEqual([s.emUso, s.esperando], [1, 0], 'B saiu da fila; A continua com a vaga');
    a.liberar();
    assert.equal(await execA, 'A');
    assert.equal(await s.executar(async () => 'C'), 'C', 'a vaga voltou e a fila segue funcionando');
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
  });

  teste('SFI-06 — espera máxima por tarefa: a segunda da fila só conta o tempo dela; quem é servido antes do prazo roda normalmente', async () => {
    const registro = [];
    const s = criarSemaforo(1, { esperaMaximaMs: 120 });
    const a = tarefaControlada('A', registro);
    const b = tarefaControlada('B', registro);
    const execA = s.executar(a.executar);
    await proximosTicks();
    const execB = s.executar(b.executar);
    await dormir(50);
    const execC = s.executar(async () => 'C').then((v) => ({ v }), (e) => ({ e }));
    a.liberar();
    await proximosTicks();
    assert.ok(registro.includes('inicio:B'), 'B foi servido antes do prazo');
    await dormir(200);
    const rc = await execC;
    assert.equal(rc.e?.codigo, 'SEMAFORO_ESPERA_EXCEDIDA', 'C passou do prazo esperando por B');
    b.liberar();
    assert.deepEqual([await execA, await execB], ['A', 'B']);
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
  });

  teste('SFI-07 — os temporizadores de espera são sempre liberados: servido, expirado, fila cheia ou tarefa que falha não deixam Timeout para trás', async () => {
    const base = temporizadoresAtivos();
    const s = criarSemaforo(1, { filaMaxima: 3, esperaMaximaMs: 30000 });
    const registro = [];
    const a = tarefaControlada('A', registro);
    const b = tarefaControlada('B', registro);
    const execA = s.executar(a.executar);
    await proximosTicks();
    const execB = s.executar(b.executar);
    const execC = s.executar(async () => 'C');
    const execD = s.executar(async () => 'D');
    await assert.rejects(s.executar(async () => 'E'), recusaCom('SEMAFORO_FILA_CHEIA'));
    assert.ok(temporizadoresAtivos() > base, 'enquanto esperam há temporizadores');
    a.liberar();
    await execA;
    b.falhar(new Error('falha da tarefa B'));
    await assert.rejects(execB, /falha da tarefa B/);
    assert.deepEqual([await execC, await execD], ['C', 'D']);
    assert.equal(temporizadoresAtivos(), base, 'nenhum temporizador de espera sobrou');

    const s2 = criarSemaforo(1, { esperaMaximaMs: 20 });
    const a2 = tarefaControlada('A2', registro);
    const exec2 = s2.executar(a2.executar);
    await proximosTicks();
    await assert.rejects(s2.executar(async () => 'x'), recusaCom('SEMAFORO_ESPERA_EXCEDIDA'));
    a2.liberar();
    await exec2;
    assert.equal(temporizadoresAtivos(), base, 'também depois de expirar');
  });

  teste('SFI-08 — o erro da tarefa chega intacto, a vaga volta e a fila anda, com as opções ligadas', async () => {
    const s = criarSemaforo(1, { filaMaxima: 4, esperaMaximaMs: 1000 });
    const erro = new Error('falha original');
    await assert.rejects(s.executar(async () => { throw erro; }), (e) => e === erro);
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
    assert.equal(await s.executar(async () => 'ok'), 'ok');
  });

  teste('SFI-09 — corrida entre o fim do prazo e a liberação da vaga: 200 rodadas, cada tarefa roda UMA vez ou é recusada UMA vez, e o final volta a zero', async () => {
    const s = criarSemaforo(1, { filaMaxima: 5, esperaMaximaMs: 4 });
    let rodadas = 0;
    let recusadas = 0;
    const tarefas = [];
    for (let i = 0; i < 200; i += 1) {
      tarefas.push(s.executar(async () => { rodadas += 1; await dormir(i % 3); }).then(() => 'rodou', (e) => { assert.match(e.codigo, /^SEMAFORO_(FILA_CHEIA|ESPERA_EXCEDIDA)$/); recusadas += 1; return 'recusada'; }));
      if (i % 7 === 0) await dormir(1);
    }
    const resultados = await Promise.all(tarefas);
    assert.equal(resultados.filter((r) => r === 'rodou').length, rodadas);
    assert.equal(rodadas + recusadas, 200);
    assert.ok(rodadas > 0 && recusadas > 0, `rodadas ${rodadas}, recusadas ${recusadas}`);
    assert.deepEqual([s.emUso, s.esperando], [0, 0]);
  });

  teste('SFI-10 — ErroDeSemaforo: é Error, tem nome e código estáveis e mensagem fixa (sem dado de quem chamou)', () => {
    const E = ErroDeSemaforo();
    for (const codigo of ['SEMAFORO_FILA_CHEIA', 'SEMAFORO_ESPERA_EXCEDIDA']) {
      const e = new E(codigo);
      assert.ok(e instanceof Error);
      assert.deepEqual([e.name, e.codigo], ['ErroDeSemaforo', codigo]);
      assert.ok(typeof e.message === 'string' && e.message.length > 0 && !/[0-9]{3,}/.test(e.message));
    }
    assert.throws(() => new E('OUTRO'), TypeError);
  });
});
