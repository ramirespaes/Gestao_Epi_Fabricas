'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Compatibilidade entre a release e o estado persistente observado (migrations e
 * contratos de dados), e interface de coordenação com operações do D-ORF-6.
 * Funções puras: o instalador as chama e decide; aqui se prova cada regra.
 */

const DIR = path.resolve(__dirname, '..', '..', '..', '..', 'deploy', 'hml', 'instalador');
function carregar(nome) {
  try {
    return require(path.join(DIR, nome));
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes(nome)) assert.fail(`deploy/hml/instalador/${nome}.js ainda não existe (RED esperado)`);
    throw erro;
  }
}

const AGORA = Date.parse('2026-11-04T12:00:00.000Z');
const M = (...nomes) => nomes.map((nome) => ({ nome, sha256: 'a'.repeat(64) }));
const release = (migrations, contratos = {}) => ({ migrations: M(...migrations), contratos });
const observado = (migrations, contratos = {}, extra = {}) => ({ banco: 'safework_hml', origem: 'sonda-leitura', coletadoEm: '2026-11-04T11:55:00.000Z', migrations, contratos, ...extra });
const codigos = (r) => r.bloqueios.map((b) => b.codigo).sort();

describe('compatibilidade — migrations', () => {
  test('banco igual ao código: instalar e reverter liberados', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    for (const acao of ['instalar', 'reverter']) {
      const r = avaliarCompatibilidade({ acao, release: release(['000_a', '001_b']), observado: observado(['000_a', '001_b']), agora: AGORA });
      assert.equal(r.ok, true, acao);
      assert.deepEqual(r.bloqueios, []);
    }
  });

  test('banco à frente do código (rollback para versão sem migration já aplicada) é bloqueado nas duas ações', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    for (const acao of ['instalar', 'reverter']) {
      const r = avaliarCompatibilidade({ acao, release: release(['000_a']), observado: observado(['000_a', '001_b']), agora: AGORA });
      assert.equal(r.ok, false);
      assert.deepEqual(codigos(r), ['BANCO_A_FRENTE_DO_CODIGO']);
      assert.match(r.bloqueios[0].mensagem, /001_b/);
    }
  });

  test('migration pendente (código à frente do banco) é bloqueada: aplicar migrations é um gate separado', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    const r = avaliarCompatibilidade({ acao: 'instalar', release: release(['000_a', '001_b']), observado: observado(['000_a']), agora: AGORA });
    assert.deepEqual(codigos(r), ['MIGRATIONS_PENDENTES']);
    assert.match(r.bloqueios[0].mensagem, /001_b/);
    assert.match(r.bloqueios[0].mensagem, /gate/i);
  });

  test('conjuntos divergentes nos dois sentidos geram os dois bloqueios; a lista na mensagem é truncada', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    const r = avaliarCompatibilidade({ acao: 'instalar', release: release(['000_a', '002_c']), observado: observado(['000_a', '001_b']), agora: AGORA });
    assert.deepEqual(codigos(r), ['BANCO_A_FRENTE_DO_CODIGO', 'MIGRATIONS_PENDENTES']);
    const muitas = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(3, '0')}_x`);
    const longa = avaliarCompatibilidade({ acao: 'instalar', release: release(['999_z']), observado: observado(muitas), agora: AGORA });
    assert.ok(longa.bloqueios[0].mensagem.length < 400);
    assert.match(longa.bloqueios[0].mensagem, /\+\d+/);
  });
});

describe('compatibilidade — estado observado', () => {
  test('observado ausente, nulo ou de outro tipo bloqueia (fail-closed)', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    for (const valor of [undefined, null, 'x', 42, []]) {
      const r = avaliarCompatibilidade({ acao: 'instalar', release: release(['000_a']), observado: valor, agora: AGORA });
      assert.deepEqual(codigos(r), ['OBSERVADO_AUSENTE'], String(valor));
    }
  });

  test('observado malformado bloqueia', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    const casos = [
      observado('000_a'),
      observado([1, 2]),
      observado(['000_a', '000_a']),
      observado(['000_a'], []),
      observado(['000_a'], { c: 0 }),
      observado(['000_a'], { c: 1.5 }),
      observado(['000_a'], {}, { banco: '' }),
      observado(['000_a'], {}, { origem: undefined }),
      observado(['000_a'], {}, { coletadoEm: 'ontem' }),
      observado(['000_a'], {}, { coletadoEm: undefined }),
    ];
    for (const o of casos) {
      const r = avaliarCompatibilidade({ acao: 'instalar', release: release(['000_a']), observado: o, agora: AGORA });
      assert.deepEqual(codigos(r), ['OBSERVADO_INVALIDO'], JSON.stringify(o));
    }
  });

  test('observado antigo ou do futuro bloqueia; dentro da janela passa', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    const r = (coletadoEm, idadeMaximaMs) => avaliarCompatibilidade({ acao: 'instalar', release: release(['000_a']), observado: observado(['000_a'], {}, { coletadoEm }), agora: AGORA, idadeMaximaMs });
    assert.equal(r('2026-11-04T11:44:59.000Z').ok, false);
    assert.deepEqual(codigos(r('2026-11-04T11:44:59.000Z')), ['OBSERVADO_ANTIGO']);
    assert.equal(r('2026-11-04T11:45:01.000Z').ok, true);
    assert.deepEqual(codigos(r('2026-11-04T12:30:00.000Z')), ['OBSERVADO_INVALIDO']);
    assert.equal(r('2026-11-04T11:30:00.000Z', 60 * 60 * 1000).ok, true);
  });

  test('release sem lista de migrations bloqueia', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    for (const rel of [undefined, {}, { migrations: 'x', contratos: {} }, { migrations: [], contratos: {} }, { migrations: [{ nome: 1 }], contratos: {} }]) {
      const r = avaliarCompatibilidade({ acao: 'instalar', release: rel, observado: observado(['000_a']), agora: AGORA });
      assert.deepEqual(codigos(r), ['RELEASE_INVALIDA'], JSON.stringify(rel));
    }
  });

  test('ação desconhecida é recusada', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    assert.throws(() => avaliarCompatibilidade({ acao: 'apagar', release: release(['000_a']), observado: observado(['000_a']), agora: AGORA }), (e) => e.codigo === 'ACAO_INVALIDA');
  });
});

describe('compatibilidade — contratos persistentes', () => {
  test('contrato gravado em versão maior que a da release (rollback) bloqueia', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    const r = avaliarCompatibilidade({ acao: 'reverter', release: release(['000_a'], { 'manifesto-backup': 1 }), observado: observado(['000_a'], { 'manifesto-backup': 2 }), agora: AGORA });
    assert.deepEqual(codigos(r), ['CONTRATO_A_FRENTE']);
    assert.match(r.bloqueios[0].mensagem, /manifesto-backup/);
  });

  test('contrato que existe nos dados e a release não declara bloqueia (versão que não o conhece)', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    const r = avaliarCompatibilidade({ acao: 'reverter', release: release(['000_a'], {}), observado: observado(['000_a'], { 'manifesto-backup': 1 }), agora: AGORA });
    assert.deepEqual(codigos(r), ['CONTRATO_DESCONHECIDO']);
  });

  test('versões iguais passam; release com versão maior passa com aviso; contrato novo só na release passa com aviso', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    const igual = avaliarCompatibilidade({ acao: 'instalar', release: release(['000_a'], { c: 2 }), observado: observado(['000_a'], { c: 2 }), agora: AGORA });
    assert.equal(igual.ok, true);
    assert.deepEqual(igual.avisos, []);
    const maior = avaliarCompatibilidade({ acao: 'instalar', release: release(['000_a'], { c: 3 }), observado: observado(['000_a'], { c: 2 }), agora: AGORA });
    assert.equal(maior.ok, true);
    assert.deepEqual(maior.avisos.map((a) => a.codigo), ['CONTRATO_EVOLUI']);
    const novo = avaliarCompatibilidade({ acao: 'instalar', release: release(['000_a'], { c: 1 }), observado: observado(['000_a'], {}), agora: AGORA });
    assert.equal(novo.ok, true);
    assert.deepEqual(novo.avisos.map((a) => a.codigo), ['CONTRATO_NOVO']);
  });

  test('migration e contrato incompatíveis juntos listam todos os bloqueios', () => {
    const { avaliarCompatibilidade } = carregar('compatibilidade');
    const r = avaliarCompatibilidade({ acao: 'reverter', release: release(['000_a'], { c: 1 }), observado: observado(['000_a', '001_b'], { c: 2 }), agora: AGORA });
    assert.deepEqual(codigos(r), ['BANCO_A_FRENTE_DO_CODIGO', 'CONTRATO_A_FRENTE']);
  });
});

describe('coordenação com D-ORF-6 — interface, sem trava implementada', () => {
  test('a consulta padrão reconhece que não existe trava homologada: situação DESCONHECIDO', async () => {
    const { consultaPadrao } = carregar('coordenacao');
    const e = await consultaPadrao();
    assert.equal(e.situacao, 'DESCONHECIDO');
    assert.match(e.origem, /nenhuma trava/i);
  });

  test('frontend não depende da coordenação', () => {
    const { avaliarCoordenacao } = carregar('coordenacao');
    for (const estado of [undefined, { situacao: 'OCUPADO', origem: 'x' }, { situacao: 'DESCONHECIDO', origem: 'x' }]) {
      const r = avaliarCoordenacao({ tipo: 'estatico', estado, atestado: false });
      assert.equal(r.ok, true);
      assert.equal(r.situacao, 'NAO_APLICAVEL');
    }
  });

  test('backend: LIVRE libera; OCUPADO e DESCONHECIDO bloqueiam, e o atestado não libera nenhum dos dois (Codex B05)', () => {
    const { avaliarCoordenacao } = carregar('coordenacao');
    assert.equal(avaliarCoordenacao({ tipo: 'backend', estado: { situacao: 'LIVRE', origem: 'trava-x', consultadoEm: '2026-11-04T11:59:00.000Z' }, atestado: false, agora: AGORA }).ok, true);
    const ocupado = avaliarCoordenacao({ tipo: 'backend', estado: { situacao: 'OCUPADO', origem: 'trava-x', detalhe: 'backup em curso' }, atestado: true });
    assert.equal(ocupado.ok, false);
    assert.equal(ocupado.bloqueio.codigo, 'OPERACAO_EM_CURSO');
    const sem = avaliarCoordenacao({ tipo: 'backend', estado: { situacao: 'DESCONHECIDO', origem: 'x' }, atestado: false });
    assert.equal(sem.ok, false);
    assert.equal(sem.bloqueio.codigo, 'COORDENACAO_NAO_CONFIRMADA');
    // Um atestado humano não é exclusão mútua: nenhum backup concorrente é impedido por ele.
    const com = avaliarCoordenacao({ tipo: 'backend', estado: { situacao: 'DESCONHECIDO', origem: 'x' }, atestado: true });
    assert.equal(com.ok, false);
    assert.equal(com.atestadoManual, false);
    assert.equal(com.bloqueio.codigo, 'COORDENACAO_NAO_CONFIRMADA');
  });

  test('estado ausente, malformado ou com situação desconhecida vale como DESCONHECIDO (fail-closed)', () => {
    const { avaliarCoordenacao } = carregar('coordenacao');
    for (const estado of [undefined, null, 'LIVRE', 7, {}, { situacao: 'livre' }, { situacao: 'TALVEZ', origem: 'x' }, { situacao: 'LIVRE' }, { situacao: 'LIVRE', origem: '' }, { situacao: 'LIVRE', origem: 'trava-x' }]) {
      const r = avaliarCoordenacao({ tipo: 'backend', estado, atestado: false });
      assert.equal(r.ok, false, JSON.stringify(estado));
      assert.equal(r.bloqueio.codigo, 'COORDENACAO_NAO_CONFIRMADA');
    }
  });

  test('atestado só vale como booleano verdadeiro (nada de strings), e LIVRE não registra atestado manual', () => {
    const { avaliarCoordenacao } = carregar('coordenacao');
    const base = { tipo: 'backend', estado: { situacao: 'DESCONHECIDO', origem: 'x' } };
    for (const atestado of ['true', 1, 'sim', {}, null, undefined]) assert.equal(avaliarCoordenacao({ ...base, atestado }).ok, false, String(atestado));
    const livre = avaliarCoordenacao({ tipo: 'backend', estado: { situacao: 'LIVRE', origem: 'x', consultadoEm: '2026-11-04T11:59:00.000Z' }, atestado: true, agora: AGORA });
    assert.equal(livre.ok, true);
    assert.equal(livre.atestadoManual, false);
  });

  test('estado LIVRE antigo deixa de valer: a consulta precisa ser recente', () => {
    const { avaliarCoordenacao } = carregar('coordenacao');
    const agora = Date.parse('2026-11-04T12:00:00.000Z');
    const livre = (consultadoEm) => avaliarCoordenacao({ tipo: 'backend', estado: { situacao: 'LIVRE', origem: 'trava-x', consultadoEm }, atestado: false, agora, idadeMaximaMs: 5 * 60 * 1000 });
    assert.equal(livre('2026-11-04T11:58:00.000Z').ok, true);
    assert.equal(livre('2026-11-04T11:50:00.000Z').ok, false);
    assert.equal(livre('2026-11-04T11:50:00.000Z').bloqueio.codigo, 'COORDENACAO_NAO_CONFIRMADA');
    assert.equal(livre('amanhã').ok, false);
  });
});
