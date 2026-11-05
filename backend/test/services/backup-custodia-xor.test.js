'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const X = require('../../src/services/backup-custodia-xor.service');

/** R-D45 [OFF-M]: custódia XOR 2 de 3 — divisão, reconstrução por qualquer dupla, limite de conhecimento de um custodiante, valor de verificação e formato em texto. Só vetores e dados SINTÉTICOS. */

const S = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const A = Buffer.alloc(32, 0xaa);
const B = Buffer.alloc(32, 0x55);
const fixo = (...blocos) => { let i = 0; return (n) => { const b = blocos[i++]; assert.equal(b.length, n); return Buffer.from(b); }; };
const dividir = (extra = {}) => X.dividirSegredo({ chaveId: 'mac-hml-v1', segredo: S, aleatorio: fixo(A, B), ...extra });
const reconstruir = (...pacotes) => X.reconstruirSegredo({ pacotes });
const comValor = (pacote, indice, valor) => ({ ...pacote, partes: pacote.partes.map((p) => (p.indice === indice ? { indice, valor, verificacao: X.verificacaoDaParte(pacote.chaveId, indice, valor) } : p)) });

describe('[OFF-M] divisão e reconstrução', () => {
  test('OFF-01 — vetor conhecido: partes a=aa.., b=55.., c=S^a^b; o custodiante k guarda as partes [k, k%3+1]', () => {
    const d = dividir();
    const c = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i));
    const valores = d.pacotes.map((p) => p.partes.map((x) => [x.indice, x.valor]));
    assert.deepEqual(valores, [
      [[1, A.toString('hex')], [2, B.toString('hex')]],
      [[2, B.toString('hex')], [3, c.toString('hex')]],
      [[3, c.toString('hex')], [1, A.toString('hex')]],
    ]);
    assert.deepEqual(d.pacotes.map((p) => p.custodiante), [1, 2, 3]);
    const vcEsperado = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('SAFEWORK-BACKUP-KCV-V1\n'), Buffer.from('mac-hml-v1\n'), S])).digest('hex');
    assert.equal(d.valorDeVerificacao, vcEsperado);
    assert.equal(X.valorDeVerificacao('mac-hml-v1', S), vcEsperado);
    assert.ok(d.pacotes.every((p) => p.valorDeVerificacao === vcEsperado && p.chaveId === 'mac-hml-v1' && p.formato === X.FORMATO));
  });

  test('OFF-02 — QUALQUER dupla de custodiantes reconstrói o segredo, em qualquer ordem; o valor de verificação confere', () => {
    const d = dividir();
    for (const [i, j] of [[0, 1], [1, 0], [1, 2], [2, 1], [0, 2], [2, 0]]) {
      const r = reconstruir(d.pacotes[i], d.pacotes[j]);
      assert.equal(r.ok, true, `${i}${j}`);
      assert.ok(r.segredo.equals(S));
      assert.equal(r.valorDeVerificacao, d.valorDeVerificacao);
    }
    assert.equal(reconstruir(d.pacotes[0], d.pacotes[1], d.pacotes[2]).ok, true, 'os três também reconstroem');
  });

  test('OFF-03 — com aleatoriedade real: segredos de 32 e de 64 bytes reconstroem por qualquer dupla; duas divisões do mesmo segredo diferem', () => {
    for (const n of [32, 64]) {
      const segredo = crypto.randomBytes(n);
      const d1 = X.dividirSegredo({ chaveId: 'kek-hml-v1', segredo });
      const d2 = X.dividirSegredo({ chaveId: 'kek-hml-v1', segredo });
      assert.notEqual(d1.pacotes[0].partes[0].valor, d2.pacotes[0].partes[0].valor);
      for (const [i, j] of [[0, 1], [1, 2], [0, 2]]) assert.ok(reconstruir(d1.pacotes[i], d1.pacotes[j]).segredo.equals(segredo));
    }
  });
});

describe('[OFF-M] limite de conhecimento: demonstração por enumeração exaustiva', () => {
  test('OFF-04 — a divisão real é uma bijeção: para cada par visível (u,v) e cada segredo s de 1 byte, existe UMA terceira parte; todos os 256 segredos são compatíveis com o que um custodiante vê', () => {
    for (let u = 0; u < 16; u += 1) {
      for (let v = 0; v < 16; v += 1) {
        const completamentos = new Set();
        for (let s = 0; s < 256; s += 1) {
          const [a, b, c] = X.dividirEmTresPartes(Buffer.from([s]), Buffer.from([u]), Buffer.from([v]));
          assert.equal(a[0], u);
          assert.equal(b[0], v);
          assert.equal(X.combinarPartes(a, b, c)[0], s);
          completamentos.add(c[0]);
        }
        assert.equal(completamentos.size, 256, `visão (${u},${v}): cada segredo exige uma terceira parte diferente`);
      }
    }
  });

  test('OFF-05 — o mesmo vale para TODO o domínio (256 x 256 visões), nas três visões (a,b), (b,c) e (c,a): nenhuma visão exclui qualquer segredo', () => {
    const cobertos = new Uint8Array(256);
    let visoes = 0;
    let naoCobertos = 0;
    for (let u = 0; u < 256; u += 1) {
      for (let v = 0; v < 256; v += 1) {
        cobertos.fill(0);
        for (let w = 0; w < 256; w += 1) cobertos[u ^ v ^ w] = 1;
        for (let s = 0; s < 256; s += 1) if (cobertos[s] !== 1) naoCobertos += 1;
        visoes += 1;
      }
    }
    assert.equal(visoes, 65536);
    assert.equal(naoCobertos, 0, 'nenhum par (u,v) exclui algum segredo');
  });

  test('OFF-06 — a distribuição do que um custodiante vê não depende do segredo: para cada segredo, (a,b), (a,c) e (b,c) percorrem os 65536 pares exatamente uma vez', () => {
    for (const s of [0, 1, 0x5a, 0xff]) {
      const visoes = { ab: new Set(), ac: new Set(), bc: new Set() };
      for (let a = 0; a < 256; a += 1) {
        for (let b = 0; b < 256; b += 1) {
          const c = s ^ a ^ b;
          visoes.ab.add(a * 256 + b);
          visoes.ac.add(a * 256 + c);
          visoes.bc.add(b * 256 + c);
        }
      }
      for (const [nome, conjunto] of Object.entries(visoes)) assert.equal(conjunto.size, 65536, `segredo ${s} visão ${nome}`);
    }
  });

  test('OFF-07 — um custodiante sozinho não reconstrói; o mesmo custodiante duas vezes também não; excesso de pacotes é entrada inválida', () => {
    const d = dividir();
    assert.deepEqual({ ...reconstruir(d.pacotes[0]) }, { ok: false, motivo: 'PACOTES_INSUFICIENTES' });
    assert.deepEqual({ ...reconstruir(d.pacotes[0], d.pacotes[0]) }, { ok: false, motivo: 'CUSTODIANTES_REPETIDOS' });
    assert.deepEqual({ ...reconstruir(d.pacotes[0], d.pacotes[1], d.pacotes[2], d.pacotes[0]) }, { ok: false, motivo: 'ENTRADA_INVALIDA' });
    assert.deepEqual({ ...X.reconstruirSegredo({ pacotes: 'x' }) }, { ok: false, motivo: 'ENTRADA_INVALIDA' });
    assert.deepEqual({ ...X.reconstruirSegredo({}) }, { ok: false, motivo: 'ENTRADA_INVALIDA' });
  });
});

describe('[OFF-M] falha fechada', () => {
  test('OFF-08 — erro de transcrição, parte divergente, chaves diferentes, valor de verificação errado e formato inválido têm motivos fixos', () => {
    const d = dividir();
    const outro = X.dividirSegredo({ chaveId: 'mac-hml-v1', segredo: S, aleatorio: fixo(Buffer.alloc(32, 0x01), Buffer.alloc(32, 0x02)) });
    const p1 = d.pacotes[0];
    const p2 = d.pacotes[1];
    const errado = { ...p2, partes: p2.partes.map((p, i) => (i === 0 ? { ...p, valor: `${p.valor.slice(0, -1)}${p.valor.endsWith('0') ? '1' : '0'}` } : p)) };
    assert.equal(reconstruir(p1, errado).motivo, 'PARTE_COM_ERRO_DE_TRANSCRICAO');
    assert.equal(reconstruir(p1, outro.pacotes[1]).motivo, 'PARTE_DIVERGENTE');
    assert.equal(reconstruir(p1, comValor(p2, 2, 'ab'.repeat(32))).motivo, 'PARTE_DIVERGENTE');
    const deOutraChave = X.dividirSegredo({ chaveId: 'kek-hml-v1', segredo: S, aleatorio: fixo(A, B) });
    assert.equal(reconstruir(p1, deOutraChave.pacotes[1]).motivo, 'PACOTES_DE_CHAVES_DIFERENTES');
    const vcErrado = (p) => ({ ...p, valorDeVerificacao: 'f'.repeat(64) });
    assert.equal(reconstruir(vcErrado(p1), vcErrado(p2)).motivo, 'VALOR_DE_VERIFICACAO_DIVERGENTE');
    assert.equal(reconstruir(vcErrado(p1), p2).motivo, 'PACOTES_DE_CHAVES_DIFERENTES');
    assert.equal(reconstruir({ ...p1, formato: 'OUTRO' }, p2).motivo, 'PACOTE_FORMATO');
    assert.equal(reconstruir({ ...p1, custodiante: 4 }, p2).motivo, 'PACOTE_FORMATO');
    assert.equal(reconstruir({ ...p1, partes: [p1.partes[1], p1.partes[0]] }, p2).motivo, 'PACOTE_FORMATO');
    assert.equal(reconstruir({ ...p1, extra: 1 }, p2).motivo, 'PACOTE_FORMATO');
    assert.equal(reconstruir(null, p2).motivo, 'PACOTE_FORMATO');
  });

  test('OFF-09 — nenhum resultado de falha contém material de parte ou de segredo', () => {
    const d = dividir();
    const partes = d.pacotes.flatMap((p) => p.partes.map((x) => x.valor));
    const falhas = [reconstruir(d.pacotes[0]), reconstruir(d.pacotes[0], d.pacotes[0]), reconstruir(d.pacotes[0], comValor(d.pacotes[1], 2, 'ab'.repeat(32)))];
    for (const f of falhas) {
      const texto = JSON.stringify(f);
      for (const v of [...partes, S.toString('hex')]) assert.equal(texto.includes(v), false);
    }
  });

  test('OFF-10 — a divisão recusa segredo curto ou longo, identificador inválido, chave extra e aleatoriedade com tamanho errado', () => {
    const recusa = (e) => e.code === 'CONFIGURACAO_INVALIDA';
    assert.throws(() => X.dividirSegredo({ chaveId: 'a', segredo: Buffer.alloc(31) }), recusa);
    assert.throws(() => X.dividirSegredo({ chaveId: 'a', segredo: Buffer.alloc(129) }), recusa);
    assert.throws(() => X.dividirSegredo({ chaveId: 'a b', segredo: S }), recusa);
    assert.throws(() => X.dividirSegredo({ chaveId: 'a', segredo: 'texto' }), recusa);
    assert.throws(() => X.dividirSegredo({ chaveId: 'a', segredo: S, extra: 1 }), recusa);
    assert.throws(() => X.dividirSegredo({ chaveId: 'a', segredo: S, aleatorio: () => Buffer.alloc(3) }), recusa);
    assert.throws(() => X.dividirSegredo({ chaveId: 'a', segredo: S, aleatorio: () => 'x' }), recusa);
    assert.throws(() => X.dividirSegredo(null), recusa);
  });
});

describe('[OFF-M] formato em texto (transcrição em papel)', () => {
  test('OFF-11 — codificar e decodificar é um ciclo exato; reconstrução a partir do texto', () => {
    const d = dividir();
    const textos = d.pacotes.map(X.codificarPacote);
    assert.match(textos[1], /^SAFEWORK-CUSTODIA-XOR-2DE3-V1\nchave: mac-hml-v1\ncustodiante: 2\nvc: [0-9a-f]{64}\nparte 2: [0-9a-f]{64} [0-9a-f]{8}\nparte 3: [0-9a-f]{64} [0-9a-f]{8}\n$/);
    for (let i = 0; i < 3; i += 1) assert.deepEqual(X.decodificarPacote(textos[i]).pacote, d.pacotes[i]);
    assert.ok(X.reconstruirSegredo({ pacotes: [textos[2], textos[0]] }).segredo.equals(S));
    assert.ok(X.reconstruirSegredo({ pacotes: [textos[1], d.pacotes[2]] }).segredo.equals(S), 'texto e objeto se misturam');
  });

  test('OFF-12 — a leitura é estrita: linha extra, espaço, maiúscula, CRLF, campo ausente, ordem trocada e valor curto são recusados', () => {
    const texto = X.codificarPacote(dividir().pacotes[0]);
    const linhas = texto.split('\n');
    const ruins = [
      `${texto}\n`,
      texto.replace('chave: ', 'chave:  '),
      texto.toUpperCase(),
      texto.replace(/\n/g, '\r\n'),
      linhas.filter((l) => !l.startsWith('vc: ')).join('\n'),
      [linhas[0], linhas[2], linhas[1], ...linhas.slice(3)].join('\n'),
      texto.replace(/parte 1: [0-9a-f]{64}/, 'parte 1: abcd'),
      texto.trimEnd(),
      '',
    ];
    for (const r of ruins) assert.deepEqual({ ...X.decodificarPacote(r) }, { ok: false, motivo: 'PACOTE_FORMATO' }, JSON.stringify(r).slice(0, 60));
    assert.deepEqual({ ...X.decodificarPacote(7) }, { ok: false, motivo: 'PACOTE_FORMATO' });
    assert.equal(X.reconstruirSegredo({ pacotes: [texto.toUpperCase(), texto] }).ok, false);
  });
});
