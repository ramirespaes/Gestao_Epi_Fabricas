'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { criarFonteDeChaves, restringirFonteDeChaves, ehFonteDeChaves, criarFonteOperacionalDeChaves, PROVEDORES_OPERACIONAIS_APROVADOS } = require('../../src/services/imagem-backup-manifesto-autenticado.service');

/**
 * `restringirFonteDeChaves` só pode TORNAR MAIS RESTRITA uma fonte já reconhecida: nunca muda a origem, nunca reativa chave revogada ou indisponível, nunca entrega segredo que a base não entregaria. Chaves aleatórias em memória.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const base = () => criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'k-ativa', segredo: crypto.randomBytes(32) }, { id: 'k-rev', segredo: crypto.randomBytes(32), revogada: true }] });
const permitirTudo = () => 'PERMITIR';

describe('[FR-A] só fontes reconhecidas; origem herdada', () => {
  teste('FR-A01 — fonte literal, clone, objeto "operacional" forjado e decisão que não é função são recusados (FONTE_INVALIDA)', () => {
    const f = base();
    const forjadas = [{ origem: 'OPERACIONAL', obter: () => ({ situacao: 'ATIVA', segredo: crypto.randomBytes(32) }) }, { ...f }, Object.create(f), null, undefined, 'k', 7];
    for (const falsa of forjadas) assert.throws(() => restringirFonteDeChaves(falsa, permitirTudo), (e) => e.code === 'FONTE_INVALIDA');
    for (const ruim of [undefined, null, 'PERMITIR', {}]) assert.throws(() => restringirFonteDeChaves(f, ruim), (e) => e.code === 'FONTE_INVALIDA');
  });

  teste('FR-A02 — a origem é HERDADA: não existe parâmetro de origem, a derivada de teste nunca é OPERACIONAL (nem derivada da derivada) e é reconhecida como fonte', () => {
    const f = base();
    const d = restringirFonteDeChaves(f, permitirTudo);
    const dd = restringirFonteDeChaves(d, permitirTudo);
    assert.deepEqual([d.origem, dd.origem, ehFonteDeChaves(d), ehFonteDeChaves(dd)], ['TESTE_CONTROLADO', 'TESTE_CONTROLADO', true, true]);
    assert.equal(restringirFonteDeChaves.length, 2, 'só fonte e decisão');
    assert.ok(Object.isFrozen(d));
  });

  teste('FR-A03 — o catálogo de provedores operacionais segue vazio e fechado; restringir não o contorna', () => {
    assert.deepEqual([...PROVEDORES_OPERACIONAIS_APROVADOS], []);
    assert.throws(() => criarFonteOperacionalDeChaves({ provedor: 'qualquer', adaptador: { obter: () => ({ situacao: 'ATIVA', segredo: crypto.randomBytes(32) }) } }), (e) => e.code === 'FONTE_OPERACIONAL_INDISPONIVEL');
    const d = restringirFonteDeChaves(base(), permitirTudo);
    assert.notEqual(d.origem, 'OPERACIONAL');
  });
});

describe('[FR-B] nunca amplia: revogada, indisponível e decisões fora do contrato', () => {
  teste('FR-B01 — decidir PERMITIR não reativa chave REVOGADA nem inexistente da base; ids malformados continuam INDISPONIVEL', () => {
    const d = restringirFonteDeChaves(base(), permitirTudo);
    assert.equal(d.obter('k-ativa').situacao, 'ATIVA');
    assert.equal(d.obter('k-rev').situacao, 'REVOGADA');
    assert.equal(d.obter('k-nao-existe').situacao, 'INDISPONIVEL');
    for (const id of [undefined, null, 7, '', '../x', {}]) assert.equal(d.obter(id).situacao, 'INDISPONIVEL', String(id));
  });

  teste('FR-B02 — REVOGADA da decisão esconde o segredo mesmo com a base ATIVA; qualquer outra resposta (inclusive true, texto livre, undefined) e exceção da decisão viram INDISPONIVEL', () => {
    const f = base();
    const revoga = restringirFonteDeChaves(f, () => 'REVOGADA');
    const r = revoga.obter('k-ativa');
    assert.deepEqual({ ...r }, { situacao: 'REVOGADA' });
    for (const resposta of [true, 'ATIVA', 'permitir', undefined, null, 1, {}]) {
      const d = restringirFonteDeChaves(f, () => resposta);
      assert.deepEqual({ ...d.obter('k-ativa') }, { situacao: 'INDISPONIVEL' }, String(resposta));
    }
    const lanca = restringirFonteDeChaves(f, () => { throw new Error('x'); });
    assert.deepEqual({ ...lanca.obter('k-ativa') }, { situacao: 'INDISPONIVEL' });
  });
});

describe('[FR-C] segredo e proveniência', () => {
  teste('FR-C01 — a derivada não expõe segredo nem a fonte base (só origem, obter e toJSON); o segredo entregue é CÓPIA e alterá-la não afeta a base', () => {
    const f = base();
    const d = restringirFonteDeChaves(f, permitirTudo);
    assert.deepEqual(Reflect.ownKeys(d).sort(), ['obter', 'origem', 'toJSON']);
    assert.equal(/segredo|secret/i.test(JSON.stringify(d)), false);
    const a = d.obter('k-ativa').segredo;
    const copia = Buffer.from(a);
    a.fill(0);
    assert.deepEqual(d.obter('k-ativa').segredo, copia);
    assert.deepEqual(f.obter('k-ativa').segredo, copia);
  });

  teste('FR-C02 — a decisão recebe só o id (nunca segredo): um espião vê exatamente os ids consultados', () => {
    const vistos = [];
    const d = restringirFonteDeChaves(base(), (...args) => { vistos.push(args); return 'PERMITIR'; });
    d.obter('k-ativa');
    d.obter('k-rev');
    assert.deepEqual(vistos, [['k-ativa'], ['k-rev']]);
  });
});
