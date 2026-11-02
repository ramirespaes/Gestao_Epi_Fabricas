'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { criarCoordenadorCompartilhado, ehCoordenadorCompartilhado, verificarContratoDoCoordenador, COORDENADORES_COMPARTILHADOS_APROVADOS } = require('../../src/services/imagem-backup-coordenacao.service');
const { REGISTRO_DE_EXECUCOES } = require('../../src/services/imagem-backup-execucoes.service');

/**
 * Contrato da coordenação compartilhada, verificado contra implementações FALSAS e em MEMÓRIA do próprio teste (a "memória durável" é um objeto que sobrevive ao "reinício" simulado). Nada aqui é um coordenador operacional,
 * nada é banco, tabela, fila ou serviço real, e nada autoriza operação multiprocesso.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);

/** Implementação de referência (só teste): armazenamento durável simulado + estado de processo descartável no reinício. */
function referencia() {
  const duravel = { execucoes: new Map(), travas: new Map() };
  let agora = 1000;
  const impl = {
    async emitir() { const id = crypto.randomBytes(16).toString('hex'); duravel.execucoes.set(id, 'ATIVA'); return { id }; },
    async consumir(id) {
      const e = duravel.execucoes.get(id);
      if (e === undefined) return { consumido: false, motivo: 'DESCONHECIDA' };
      if (e === 'CONSUMIDA') return { consumido: false, motivo: 'JA_CONSUMIDA' };
      if (e === 'EXPIRADA') return { consumido: false, motivo: 'EXPIRADA' };
      duravel.execucoes.set(id, 'CONSUMIDA'); // síncrono: atômico no laço de eventos (equivale a um compare-and-set durável)
      return { consumido: true };
    },
    async estado(id) { return duravel.execucoes.get(id) ?? null; },
    async adquirirExclusao({ chave, ttlMs }) {
      const t = duravel.travas.get(chave);
      if (t !== undefined && t.ate > agora) return { ocupada: true };
      const posse = crypto.randomBytes(8).toString('hex');
      duravel.travas.set(chave, { posse, ate: agora + ttlMs });
      return { posse };
    },
    async liberarExclusao(posse) {
      for (const [chave, t] of duravel.travas) if (t.posse === posse) { duravel.travas.delete(chave); return { liberada: true }; }
      return { liberada: false };
    },
    async recuperar() { return { ok: true }; },
  };
  return { impl, duravel, avancar: (ms) => { agora += ms; } };
}
const criar = (impl, prazoMs = 100) => criarCoordenadorCompartilhado({ id: 'coord-teste', implementacao: impl, prazoMs });

describe('[CO-A] aprovação e invólucro', () => {
  teste('CO-A01 — nenhum coordenador compartilhado aprovado; o de teste nunca é operacional; fora de NODE_ENV=test é recusado; configuração estrita', () => {
    assert.deepEqual([...COORDENADORES_COMPARTILHADOS_APROVADOS], []);
    const c = criar(referencia().impl);
    assert.deepEqual([c.operacional, c.origem, ehCoordenadorCompartilhado(c)], [false, 'TESTE_CONTROLADO', true]);
    assert.equal(ehCoordenadorCompartilhado({ ...c }), false);
    assert.equal(ehCoordenadorCompartilhado({ operacional: true }), false);
    const antes = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => criar(referencia().impl), (e) => e.code === 'COORDENADOR_NAO_APROVADO');
    } finally { process.env.NODE_ENV = antes; }
    for (const ruim of [null, {}, { id: 'X', implementacao: referencia().impl, prazoMs: 10 }, { id: 'a', implementacao: {}, prazoMs: 10 }, { id: 'a', implementacao: referencia().impl, prazoMs: 0 }, { id: 'a', implementacao: referencia().impl, prazoMs: 10, extra: 1 }]) assert.throws(() => criarCoordenadorCompartilhado(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });

  teste('CO-A02 — o registro em memória NÃO é declarado compartilhado nem durável', () => {
    assert.deepEqual([REGISTRO_DE_EXECUCOES.escopo, REGISTRO_DE_EXECUCOES.duravel, REGISTRO_DE_EXECUCOES.compartilhado], ['PROCESSO_UNICO_VOLATIL', false, false]);
  });
});

describe('[CO-B] cenários do contrato', () => {
  teste('CO-B01 — implementação de referência cumpre TODO o contrato, inclusive consumo único sob concorrência, exclusão, expiração da posse e replay depois do reinício', async () => {
    const { impl, duravel } = referencia();
    const c = criar(impl);
    const r = await verificarContratoDoCoordenador(c, { reiniciar: async () => { /* o estado de processo some; o durável fica */ void duravel; } });
    assert.deepEqual([r.conforme, [...r.falhas]], [true, []]);
  });

  teste('CO-B02 — consumo DUPLO é detectado: implementação que consome duas vezes reprova (CONSUMO_NAO_E_UNICO / REAPRESENTACAO_ACEITA)', async () => {
    const { impl } = referencia();
    const furado = { ...impl, async consumir() { return { consumido: true }; } };
    const r = await verificarContratoDoCoordenador(criar(furado));
    assert.equal(r.conforme, false);
    assert.ok(r.falhas.includes('CONSUMO_NAO_E_UNICO') && r.falhas.includes('REAPRESENTACAO_ACEITA'));
  });

  teste('CO-B03 — exclusão NÃO mútua e liberação falha reprovam', async () => {
    const { impl } = referencia();
    const r1 = await verificarContratoDoCoordenador(criar({ ...impl, async adquirirExclusao() { return { posse: 'p' }; } }));
    assert.ok(r1.falhas.includes('EXCLUSAO_NAO_E_MUTUA'));
    const r2 = await verificarContratoDoCoordenador(criar({ ...impl, async liberarExclusao() { return { liberada: false }; } }));
    assert.ok(r2.falhas.includes('LIBERACAO_FALHOU'));
  });

  teste('CO-B04 — REINICIALIZAÇÃO: implementação que perde o estado (memória volátil) aceita replay e reprova; recuperação que falha reprova', async () => {
    let memoria = new Map();
    const volatil = {
      async emitir() { const id = crypto.randomBytes(16).toString('hex'); memoria.set(id, 'ATIVA'); return { id }; },
      async consumir(id) { const e = memoria.get(id); if (e === 'ATIVA') { memoria.set(id, 'CONSUMIDA'); return { consumido: true }; } return { consumido: false, motivo: e === undefined ? 'DESCONHECIDA' : 'JA_CONSUMIDA' }; },
      async estado(id) { return memoria.get(id) ?? null; },
      async adquirirExclusao() { return { posse: 'p' }; },
      async liberarExclusao() { return { liberada: true }; },
      async recuperar() { return { ok: true }; },
    };
    const r = await verificarContratoDoCoordenador(criar(volatil), { reiniciar: async () => { memoria = new Map(); } });
    assert.equal(r.conforme, false);
    assert.ok(r.falhas.includes('ESTADO_PERDIDO_NO_REINICIO'), [...r.falhas].join());
    const { impl } = referencia();
    const r2 = await verificarContratoDoCoordenador(criar({ ...impl, async recuperar() { return { ok: false }; } }), { reiniciar: async () => {} });
    assert.ok(r2.falhas.includes('RECUPERACAO_FALHOU'));
  });

  teste('CO-B05 — FALHA FECHADA em estado inconclusivo: exceção, atraso, resposta fora do formato e campos extras nunca autorizam', async () => {
    const { impl } = referencia();
    const id = (await impl.emitir()).id;
    const mudo = criar({ ...impl, consumir: async () => { throw new Error('armazenamento fora do ar'); } });
    assert.deepEqual({ ...(await mudo.consumir(id)) }, { consumido: false, motivo: 'INCONCLUSIVO' });
    const lento = criar({ ...impl, consumir: () => new Promise(() => {}) }, 30);
    assert.deepEqual({ ...(await lento.consumir(id)) }, { consumido: false, motivo: 'INCONCLUSIVO' });
    for (const resposta of [true, 'ok', { consumido: 1 }, { consumido: true, extra: 1 }, { consumido: false, motivo: 'QUALQUER' }, null, undefined]) {
      const c = criar({ ...impl, consumir: async () => resposta });
      assert.equal((await c.consumir(id)).consumido, false, JSON.stringify(resposta));
    }
    assert.equal((await criar({ ...impl, emitir: async () => ({ id: 'curto' }) }).emitir()).ok, false);
    assert.equal(await criar({ ...impl, estado: async () => 'TALVEZ' }).estado(id), null);
    assert.deepEqual({ ...(await criar({ ...impl, adquirirExclusao: async () => ({}) }).adquirirExclusao({ chave: 'k', ttlMs: 10 })) }, { adquirida: false, motivo: 'INCONCLUSIVO' });
    assert.equal(await criar({ ...impl, recuperar: async () => { throw new Error('x'); } }).recuperar(), false);
  });

  teste('CO-B06 — REAPRESENTAÇÃO: identidade já consumida, desconhecida ou mal formada nunca é nova autorização', async () => {
    const { impl } = referencia();
    const c = criar(impl);
    const { id } = await c.emitir();
    assert.equal((await c.consumir(id)).consumido, true);
    assert.deepEqual({ ...(await c.consumir(id)) }, { consumido: false, motivo: 'JA_CONSUMIDA' });
    assert.equal((await c.consumir('0'.repeat(32))).motivo, 'DESCONHECIDA');
    for (const ruim of [undefined, null, 7, 'zz', 'A'.repeat(32)]) assert.equal((await c.consumir(ruim)).consumido, false);
  });

  teste('CO-B07 — a posse de exclusão EXPIRA sozinha (nunca eterna) e o pedido malformado é recusado', async () => {
    const { impl, avancar } = referencia();
    const c = criar(impl);
    const a = await c.adquirirExclusao({ chave: 'backup:imagens', ttlMs: 1000 });
    assert.equal(a.adquirida, true);
    assert.equal((await c.adquirirExclusao({ chave: 'backup:imagens', ttlMs: 1000 })).motivo, 'OCUPADA');
    avancar(1001);
    assert.equal((await c.adquirirExclusao({ chave: 'backup:imagens', ttlMs: 1000 })).adquirida, true);
    for (const ruim of [null, {}, { chave: '../x', ttlMs: 10 }, { chave: 'k', ttlMs: 0 }, { chave: 'k', ttlMs: 10, extra: 1 }]) await assert.rejects(() => c.adquirirExclusao(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });

  teste('CO-B08 — verificar o contrato exige um coordenador produzido pela fábrica', async () => {
    await assert.rejects(() => verificarContratoDoCoordenador(referencia().impl), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });
});
