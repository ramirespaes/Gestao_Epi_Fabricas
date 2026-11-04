'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { SAIDAS, ESTADOS_DA_JANELA, ESTADOS_DA_FINALIZACAO } = require('../../src/services/imagem-backup.service');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { clienteFalso } = require('../helpers/ambiente-backup-operacao');

/**
 * P1 — exceção INESPERADA do executor: o snapshot só é finalizado quando há PROVA de que isso não invalida nada ativo. O executor é substituído, no cache de módulos DESTE processo, por um que chama as dependências reais montadas pela entrada
 * (snapshot, processo do dump, cópia, finalização) na ordem de cada cenário e depois lança. O cliente PostgreSQL é um double: nenhum banco, nenhum processo. O que se mede é físico: `ROLLBACK` enviado, `end()` chamado, quantas vezes.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const executorPath = require.resolve('../../src/services/imagem-backup-executor.service');
const operacionalPath = require.resolve('../../src/services/imagem-backup-operacional.service');
const nunca = () => ({ promessa: new Promise(() => {}), cancelar() {} });

/** Recarrega a entrada operacional com o executor SUBSTITUÍDO (só neste processo) e restaura tudo ao fim. */
async function comExecutor(executor, fn) {
  require(executorPath);
  const original = require.cache[executorPath].exports;
  const anterior = require.cache[operacionalPath];
  require.cache[executorPath].exports = { ...original, executarBackupSupervisionado: executor };
  delete require.cache[operacionalPath];
  try { return await fn(require(operacionalPath).executarBackupOperacional); } finally {
    require.cache[executorPath].exports = original;
    if (anterior === undefined) delete require.cache[operacionalPath]; else require.cache[operacionalPath] = anterior;
  }
}

/** Mundo controlado: cliente com contadores de `end()`, contadores de efeitos e as dependências mínimas da entrada. */
function mundo({ connectPendente = false, endFalha = false } = {}) {
  const cliente = clienteFalso('gepi_p1_origem');
  const efeitos = { conexoes: 0, janela: 0, processo: 0, copia: 0, fim: 0 };
  const endOriginal = cliente.end;
  cliente.end = async () => { efeitos.fim += 1; if (endFalha) throw Object.assign(new Error(SEGREDO), { code: 'EIO' }); return endOriginal.call(cliente); };
  if (connectPendente) cliente.connect = () => new Promise(() => {});
  const dependencias = {
    janela: { adquirir: async () => { efeitos.janela += 1; throw new Error('a entrada nunca deve adquirir a trava por conta própria'); } },
    conexao: { criarConexao: () => { efeitos.conexoes += 1; return cliente; }, temporizador: { prazo: nunca }, prazos: { finalizacaoMs: 1000 }, planejar: planejarArquivos },
    processoDoDump: () => { efeitos.processo += 1; return {}; },
    copia: async () => { efeitos.copia += 1; return { ok: true }; },
    avaliar: () => ({ valido: true, motivos: [] }),
  };
  return { cliente, efeitos, dependencias, rollbacks: () => cliente.sqls.filter((s) => s === 'ROLLBACK').length };
}
const lanca = () => { throw new Error(SEGREDO); };

function esperarInesperada(r) {
  assert.equal(r.saida, SAIDAS.ERRO);
  assert.equal(r.valido, false);
  assert.equal(r.recuperavel, false);
  assert.equal(r.janela, ESTADOS_DA_JANELA.NAO_LIBERADA, 'a trava nunca é presumida liberada');
  assert.deepEqual([...r.motivos], ['ERRO_INTERNO']);
  assert.equal(JSON.stringify(r).includes(SEGREDO), false);
}

describe('[P1] finalização do snapshot após exceção inesperada: só com prova', () => {
  teste('P1-01 — nada foi criado (snapshot nunca aberto, dump nunca iniciado): finalizar é seguro e CONCLUÍDA pela própria instância; nenhuma conexão criada, nenhuma trava tocada', async () => {
    const m = mundo();
    const r = await comExecutor(lanca, (operacional) => operacional(m.dependencias));
    esperarInesperada(r);
    assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.CONCLUIDA);
    assert.deepEqual(m.efeitos, { conexoes: 0, janela: 0, processo: 0, copia: 0, fim: 0 });
  });

  teste('P1-02 — snapshot ABERTO, dump NUNCA iniciado, sem pendências: ROLLBACK + end() exatamente uma vez e finalização CONCLUÍDA; a trava continua não liberada', async () => {
    const m = mundo();
    const r = await comExecutor(async (deps) => { assert.deepEqual(await deps.snapshot(), { ok: true }); throw new Error(SEGREDO); }, (operacional) => operacional(m.dependencias));
    esperarInesperada(r);
    assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.CONCLUIDA);
    assert.deepEqual([m.rollbacks(), m.efeitos.fim, m.efeitos.conexoes, m.efeitos.janela], [1, 1, 1, 0]);
  });

  teste('P1-03 — dump POSSIVELMENTE ATIVO (a entrada já pediu o processo do dump): o snapshot NÃO é finalizado — nem ROLLBACK nem end() — porque a transação sustenta o `--snapshot` do pg_dump; finalização NAO_CONCLUIDA e trava retida', async () => {
    const m = mundo();
    const r = await comExecutor(async (deps) => { await deps.snapshot(); deps.processoDoDump(); throw new Error(SEGREDO); }, (operacional) => operacional(m.dependencias));
    esperarInesperada(r);
    assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.NAO_CONCLUIDA);
    assert.deepEqual([m.rollbacks(), m.efeitos.fim, m.efeitos.processo], [0, 0, 1]);
  });

  teste('P1-04 — abertura do snapshot AINDA PENDENTE (a promessa de abrir() não assentou): não finaliza; uma rejeição do executor não é prova de que a operação terminou', async () => {
    const m = mundo({ connectPendente: true });
    const r = await comExecutor(async (deps) => { deps.snapshot(); await Promise.resolve(); throw new Error(SEGREDO); }, (operacional) => operacional(m.dependencias));
    esperarInesperada(r);
    assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.NAO_CONCLUIDA);
    assert.deepEqual([m.rollbacks(), m.efeitos.fim, m.efeitos.conexoes], [0, 0, 1], 'a conexão pendente não foi tocada');
  });

  teste('P1-05 — cópia já iniciada: não finaliza', async () => {
    const m = mundo();
    const r = await comExecutor(async (deps) => { await deps.snapshot(); await deps.copia(); throw new Error(SEGREDO); }, (operacional) => operacional(m.dependencias));
    esperarInesperada(r);
    assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.NAO_CONCLUIDA);
    assert.deepEqual([m.rollbacks(), m.efeitos.fim, m.efeitos.copia], [0, 0, 1]);
  });

  teste('P1-06 — a finalização já foi PEDIDA pelo executor antes da exceção: não há segunda tentativa (a instância finaliza uma vez); end() foi chamado só pela primeira; resultado NAO_CONCLUIDA (conservador)', async () => {
    const m = mundo();
    const r = await comExecutor(async (deps) => { await deps.snapshot(); await deps.finalizar(); throw new Error(SEGREDO); }, (operacional) => operacional(m.dependencias));
    esperarInesperada(r);
    assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.NAO_CONCLUIDA);
    assert.deepEqual([m.rollbacks(), m.efeitos.fim], [1, 1]);
  });

  teste('P1-07 — a finalização FALHA (end() lança): NAO_CONCLUIDA, uma única tentativa, sem repetir e sem vazar a causa; a trava continua não liberada', async () => {
    const m = mundo({ endFalha: true });
    const r = await comExecutor(async (deps) => { await deps.snapshot(); throw new Error(SEGREDO); }, (operacional) => operacional(m.dependencias));
    esperarInesperada(r);
    assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.NAO_CONCLUIDA);
    assert.deepEqual([m.rollbacks(), m.efeitos.fim, m.efeitos.janela], [1, 1, 0]);
  });

  teste('P1-08 — caminho normal intacto: sem exceção o resultado é o do executor (recuperável false) e a entrada não finaliza por conta própria', async () => {
    const m = mundo();
    const resultado = { saida: 0, valido: true, janela: 'LIBERADA', finalizacao: 'CONCLUIDA', motivos: [], etapasExecutadas: [] };
    const r = await comExecutor(async () => resultado, (operacional) => operacional(m.dependencias));
    assert.deepEqual({ ...r }, { ...resultado, recuperavel: false });
    assert.deepEqual([m.rollbacks(), m.efeitos.fim, m.efeitos.conexoes], [0, 0, 0]);
  });
});
