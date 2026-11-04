'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../src/services/backup-fontes-fiscalizacao-plano.service');

/** D-ORF-6, P3 — PLANEJADOR da fonte `fiscalizacao-pacotes`: função pura, só CONCLUIDO, validação total antes de qualquer resultado, ordem por chave. */

const HEX = 'c'.repeat(64);
const linha = (id, empresaId, status, extra = {}) => ({ id: String(id), empresaId: String(empresaId), status, tamanhoBytes: null, sha256: null, chaveArmazenamento: null, ...extra });
const concluido = (id, empresaId, extra = {}) => linha(id, empresaId, 'CONCLUIDO', { tamanhoBytes: 1234, sha256: HEX, chaveArmazenamento: `${empresaId}/pacote-${id}.zip`, ...extra });
const invalido = (e) => e instanceof Error && e.code === 'PLANO_INVALIDO' && !/[0-9a-f]{64}|pacote-/.test(e.message);

describe('[PL] planejarPacotes', () => {
  test('PL-01 — só CONCLUIDO entra; GERANDO e FALHA ficam fora; saída congelada, em ordem crescente de chave (texto), com os cinco campos e nada mais', () => {
    const plano = P.planejarPacotes({ pacotes: [concluido(10, 2), linha(3, 1, 'GERANDO'), concluido(9, 1), linha(4, 2, 'FALHA'), concluido(2, 10)] });
    assert.deepEqual(plano, [
      { chave: '1/pacote-9.zip', sha256: HEX, bytes: 1234, empresaId: '1', pacoteId: '9' },
      { chave: '10/pacote-2.zip', sha256: HEX, bytes: 1234, empresaId: '10', pacoteId: '2' },
      { chave: '2/pacote-10.zip', sha256: HEX, bytes: 1234, empresaId: '2', pacoteId: '10' },
    ]);
    assert.ok(Object.isFrozen(plano) && plano.every(Object.isFrozen));
    assert.deepEqual(P.planejarPacotes({ pacotes: [] }), []);
  });

  test('PL-02 — a entrada é { pacotes: [] } e nada mais; forma errada é PLANO_INVALIDO', () => {
    for (const ruim of [null, [], {}, { pacotes: null }, { pacotes: [], extra: 1 }, { pacote: [] }, { pacotes: [null] }, { pacotes: ['x'] }]) assert.throws(() => P.planejarPacotes(ruim), invalido, JSON.stringify(ruim));
  });

  test('PL-03 — linha inconsistente invalida o plano INTEIRO, sem resultado parcial e sem vazar valores na mensagem', () => {
    const casos = {
      'status desconhecido': [concluido(1, 1), linha(2, 1, 'ESTRANHO')],
      'chave fora do formato': [concluido(1, 1, { chaveArmazenamento: '1/pacote-1.zip/' })],
      'chave de outra empresa': [concluido(1, 1, { chaveArmazenamento: '2/pacote-1.zip' })],
      'chave de outro pacote': [concluido(1, 1, { chaveArmazenamento: '1/pacote-2.zip' })],
      'chave nula em CONCLUIDO': [concluido(1, 1, { chaveArmazenamento: null })],
      'sha inválido': [concluido(1, 1, { sha256: 'Z'.repeat(64) })],
      'tamanho zero': [concluido(1, 1, { tamanhoBytes: 0 })],
      'tamanho fracionário': [concluido(1, 1, { tamanhoBytes: 1.5 })],
      'tamanho acima do teto': [concluido(1, 1, { tamanhoBytes: P.TAMANHO_MAXIMO + 1 })],
      'id não inteiro': [concluido('x', 1)],
      'empresa não inteira': [concluido(1, '01')],
      'chave repetida': [concluido(1, 1), concluido(1, 1)],
    };
    for (const [nome, pacotes] of Object.entries(casos)) assert.throws(() => P.planejarPacotes({ pacotes }), invalido, nome);
  });

  test('PL-04 — pura: não altera a entrada e aceita listas congeladas', () => {
    const entrada = Object.freeze({ pacotes: Object.freeze([Object.freeze(concluido(5, 3)), Object.freeze(linha(6, 3, 'GERANDO'))]) });
    const antes = JSON.stringify(entrada);
    assert.equal(P.planejarPacotes(entrada).length, 1);
    assert.equal(JSON.stringify(entrada), antes);
  });

  test('PL-05 — lerReferencias usa o executor recebido (a transação é do chamador), pagina por id e devolve tudo congelado', async () => {
    const sql = [];
    const linhas = [1, 2, 3, 4, 5].map((id) => ({ id, empresa_id: 1, status: 'CONCLUIDO', tamanho_bytes: 10, sha256: HEX, chave_armazenamento: `1/pacote-${id}.zip`, heartbeat_em: null }));
    const executor = { async query(texto, params) { sql.push(texto.trim()); const depois = BigInt(params[0]); return { rows: linhas.filter((l) => BigInt(l.id) > depois).slice(0, params[1]) }; } };
    const r = await P.lerReferencias(executor, { tamanhoDaPagina: 2 });
    assert.equal(r.length, 5);
    assert.ok(Object.isFrozen(r));
    assert.equal(sql.length, 3);
    for (const s of sql) assert.match(s, /^SELECT\b/);
    await assert.rejects(P.lerReferencias(null), TypeError);
    assert.deepEqual(P.planejarPacotes({ pacotes: r }).map((i) => i.chave), ['1/pacote-1.zip', '1/pacote-2.zip', '1/pacote-3.zip', '1/pacote-4.zip', '1/pacote-5.zip']);
  });
});
