'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Rb = require('../../src/services/backup-recibo-duravel.service');

/** R-D45 [REC]: recibo de gravação durável e o documento consolidado de um conjunto (chave, VERSÃO, SHA-256, bytes) — a base da restauração por versão explícita. */

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const recibo = (arquivo, extra = {}) => ({
  versao: 1, destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO', bucket: 'safework-hml-backup-111111111111', chave: `hml/c1/${arquivo}`,
  versaoId: `v-${arquivo.replace(/[^a-z0-9]/g, '')}`, sha256: sha(arquivo), bytes: arquivo.length, gravadoEm: '2026-11-05T12:00:00.000Z', ...extra,
});
const base = () => ({ destinoId: 'hml-s3-principal', ambiente: 'HOMOLOGACAO', conjuntoId: 'c1', recibos: [recibo('envelope.json'), recibo('dados/a.enc'), recibo('dados/b.enc')] });
const motivo = (entrada) => { const r = Rb.consolidarRecibos(entrada); assert.equal(r.ok, false); return r.motivo; };

describe('[REC] recibo individual', () => {
  test('REC-01 — recibo válido; cada campo inválido tem motivo fixo', () => {
    assert.equal(Rb.validarRecibo(recibo('a.enc')), null);
    const ruins = [
      [{ versao: 2 }, 'RECIBO_FORMATO'], [{ destinoId: 'X!' }, 'RECIBO_FORMATO'], [{ ambiente: 'CI' }, 'RECIBO_FORMATO'], [{ bucket: 'MAIUSCULO' }, 'RECIBO_FORMATO'],
      [{ chave: 'outro/c1/a.enc' }, 'RECIBO_FORMATO'], [{ chave: 'hml/../c1/a' }, 'RECIBO_FORMATO'], [{ versaoId: 'null' }, 'RECIBO_FORMATO'], [{ versaoId: '' }, 'RECIBO_FORMATO'],
      [{ sha256: 'xyz' }, 'RECIBO_FORMATO'], [{ bytes: -1 }, 'RECIBO_FORMATO'], [{ bytes: 1.5 }, 'RECIBO_FORMATO'], [{ bytes: 5 * 1024 ** 3 + 1 }, 'RECIBO_FORMATO'],
      [{ gravadoEm: '05/11/2026' }, 'RECIBO_FORMATO'], [{ extra: 1 }, 'RECIBO_FORMATO'],
    ];
    for (const [extra, esperado] of ruins) assert.equal(Rb.validarRecibo(recibo('a.enc', extra)), esperado, JSON.stringify(extra));
    assert.equal(Rb.validarRecibo(null), 'RECIBO_FORMATO');
  });
});

describe('[REC] documento consolidado', () => {
  test('REC-02 — consolida em bytes canônicos, ordenados por chave, independentes da ordem de entrada; o SHA-256 confere', () => {
    const a = Rb.consolidarRecibos(base());
    const embaralhado = base();
    embaralhado.recibos.reverse();
    const b = Rb.consolidarRecibos(embaralhado);
    assert.equal(a.ok, true);
    assert.ok(a.bytes.equals(b.bytes));
    assert.equal(a.sha256, sha(a.bytes));
    const doc = JSON.parse(a.bytes.toString('utf8'));
    assert.deepEqual(doc.recibos.map((r) => r.chave), ['hml/c1/dados/a.enc', 'hml/c1/dados/b.enc', 'hml/c1/envelope.json']);
    assert.equal(a.bytes.toString('utf8').includes(' '), false, 'JSON canônico sem espaços');
  });

  test('REC-03 — ciclo exato: lerConsolidado devolve o mesmo conteúdo; bytes alterados, não canônicos ou com campo extra são recusados', () => {
    const a = Rb.consolidarRecibos(base());
    const lido = Rb.lerConsolidado(a.bytes);
    assert.equal(lido.ok, true);
    assert.equal(lido.consolidado.conjuntoId, 'c1');
    assert.equal(lido.consolidado.recibos.length, 3);
    assert.deepEqual({ ...Rb.lerConsolidado(Buffer.from(JSON.stringify(JSON.parse(a.bytes.toString()), null, 2))) }, { ok: false, motivo: 'CONSOLIDADO_NAO_CANONICO' });
    assert.deepEqual({ ...Rb.lerConsolidado(Buffer.from('{')) }, { ok: false, motivo: 'CONSOLIDADO_FORMATO' });
    assert.deepEqual({ ...Rb.lerConsolidado('texto') }, { ok: false, motivo: 'CONSOLIDADO_FORMATO' });
    const extra = JSON.parse(a.bytes.toString());
    extra.extra = 1;
    assert.equal(Rb.lerConsolidado(Buffer.from(JSON.stringify(extra))).ok, false);
    const adulterado = JSON.parse(a.bytes.toString());
    adulterado.recibos[0].sha256 = 'f'.repeat(64);
    assert.equal(Rb.lerConsolidado(Buffer.from(Rb.bytesCanonicos(adulterado))).ok, true, 'o consolidado não é autenticado por si: o SHA-256 dele é registrado à parte');
  });

  test('REC-04 — recusa conjunto incompleto ou incoerente: sem envelope, chave repetida, fora do prefixo do conjunto, outro destino, outro ambiente, outro bucket, vazio', () => {
    const sem = base(); sem.recibos = sem.recibos.filter((r) => !r.chave.endsWith('envelope.json'));
    assert.equal(motivo(sem), 'ENVELOPE_AUSENTE');
    const dup = base(); dup.recibos.push(recibo('dados/a.enc', { versaoId: 'outra' }));
    assert.equal(motivo(dup), 'CHAVE_REPETIDA');
    const fora = base(); fora.recibos.push(recibo('dados/c.enc', { chave: 'hml/c2/dados/c.enc' }));
    assert.equal(motivo(fora), 'CHAVE_FORA_DO_CONJUNTO');
    const outroDestino = base(); outroDestino.recibos[1] = recibo('dados/a.enc', { destinoId: 'prod-s3-principal' });
    assert.equal(motivo(outroDestino), 'RECIBO_DE_OUTRO_DESTINO');
    const outroAmbiente = base(); outroAmbiente.recibos[1] = recibo('dados/a.enc', { ambiente: 'PRODUCAO' });
    assert.equal(motivo(outroAmbiente), 'RECIBO_DE_OUTRO_DESTINO');
    const outroBucket = base(); outroBucket.recibos[1] = recibo('dados/a.enc', { bucket: 'safework-hml-backup-999999999999' });
    assert.equal(motivo(outroBucket), 'RECIBO_DE_OUTRO_DESTINO');
    const vazio = base(); vazio.recibos = [];
    assert.equal(motivo(vazio), 'ENVELOPE_AUSENTE');
    const ruim = base(); ruim.recibos[0] = recibo('envelope.json', { sha256: 'x' });
    assert.equal(motivo(ruim), 'RECIBO_FORMATO');
    assert.equal(motivo({ ...base(), conjuntoId: 'a b' }), 'ENTRADA_INVALIDA');
    assert.equal(motivo({ ...base(), extra: 1 }), 'ENTRADA_INVALIDA');
    assert.equal(motivo(null), 'ENTRADA_INVALIDA');
  });
});
