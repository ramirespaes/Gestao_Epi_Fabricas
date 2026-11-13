'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const X = require('../../src/services/backup-custodia-xor.service');
const C = require('../../src/services/backup-custodia-cerimonia.service');

/** D3/H9-d [CER]: lógica pura da cerimônia de custódia (preparação e conferência). Só aleatoriedade INJETADA e valores SINTÉTICOS; nenhum segredo real. */

const bloco = (n, semente) => Buffer.from(Array.from({ length: n }, (_, i) => (semente + i * 7) & 255));
const SM = bloco(32, 1);
const SK = bloco(32, 2);
const A1 = bloco(32, 3);
const B1 = bloco(32, 4);
const A2 = bloco(32, 5);
const B2 = bloco(32, 6);
const BLOCOS = [SM, SK, A1, B1, A2, B2];
const ZERO = Buffer.alloc(32);
const MAC = 'mac-hml-v1';
const KEK = 'kek-hml-v1';

/** Entrega CÓPIAS dos blocos, na ordem, e guarda o que entregou (para conferir a zeragem). */
function fila(...blocos) {
  const entregues = [];
  let i = 0;
  const f = (n) => { const b = Buffer.from(blocos[i++]); assert.equal(b.length, n); entregues.push(b); return b; };
  f.entregues = entregues;
  return f;
}
const pedido = (extra = {}) => ({ mac: { chaveId: MAC, bytes: 32 }, cifra: { chaveId: KEK }, aleatorio: fila(...BLOCOS), ...extra });
const preparar = (extra) => C.prepararCerimonia(pedido(extra));
const textos = (p, familia, ...indices) => indices.map((i) => p.custodiantes[i][familia]);
const conferir = (p, mac, cifra, registro = p.registro) => C.conferirCerimonia({ registro, apresentados: { mac, cifra } });
const dupla = (p, i, j) => conferir(p, textos(p, 'mac', i, j), textos(p, 'cifra', i, j));
const outraDivisao = (chaveId, segredo, semente) => X.dividirSegredo({ chaveId, segredo, aleatorio: fila(bloco(segredo.length, semente), bloco(segredo.length, semente + 1)) });
const codificados = (d, ...indices) => indices.map((i) => X.codificarPacote(d.pacotes[i]));
const registroDe = (dMac, dCifra, bytesMac = 32) => ({ mac: { chaveId: dMac.chaveId, bytes: bytesMac, valorDeVerificacao: dMac.valorDeVerificacao }, cifra: { chaveId: dCifra.chaveId, bytes: 32, valorDeVerificacao: dCifra.valorDeVerificacao } });

function recusado(r, motivo, sensiveis = []) {
  assert.deepEqual(r, { ok: false, motivo });
  assert.deepEqual(Reflect.ownKeys(r), ['ok', 'motivo']);
  assert.ok(Object.isFrozen(r));
  assert.ok(C.MOTIVOS.includes(motivo), motivo);
  const visivel = JSON.stringify(r) + util.inspect(r, { showHidden: true, depth: 9 });
  for (const s of sensiveis) assert.equal(visivel.includes(s), false);
}
const hexDe = (...buffers) => buffers.map((b) => b.toString('hex'));
const partesDe = (p) => p.custodiantes.flatMap((c) => [c.mac, c.cifra]).flatMap((t) => [...t.matchAll(/^parte [1-3]: ([0-9a-f]+) /gm)].map((m) => m[1]));
/** Função que se passa por objeto: sem `length` nem `name`, só com as chaves pedidas. */
const funcaoComo = (campos) => { const f = () => {}; delete f.length; delete f.name; return Object.assign(f, campos); };
/** Espia `Buffer.prototype.fill(0)` só durante `fn`, que é síncrona, e devolve em hex o conteúdo de cada buffer zerado. Restaura no `finally`. */
function zeradosDurante(fn) {
  const original = Buffer.prototype.fill;
  const vistos = [];
  Buffer.prototype.fill = function espiao(...args) { if (args.length === 1 && args[0] === 0) vistos.push(Buffer.from(this).toString('hex')); return original.apply(this, args); };
  try { return { saida: fn(), vistos }; } finally { Buffer.prototype.fill = original; }
}
const vezes = (vistos, b) => vistos.filter((v) => v === Buffer.from(b).toString('hex')).length;

describe('[CER] preparação da cerimônia', () => {
  test('CER-01 — vetor conhecido: registro sem segredo e três cartões iguais aos da divisão XOR 2 de 3 existente', () => {
    const p = preparar();
    const dMac = X.dividirSegredo({ chaveId: MAC, segredo: SM, aleatorio: fila(A1, B1) });
    const dKek = X.dividirSegredo({ chaveId: KEK, segredo: SK, aleatorio: fila(A2, B2) });
    assert.deepEqual(p, {
      ok: true,
      registro: { mac: { chaveId: MAC, bytes: 32, valorDeVerificacao: X.valorDeVerificacao(MAC, SM) }, cifra: { chaveId: KEK, bytes: 32, valorDeVerificacao: X.valorDeVerificacao(KEK, SK) } },
      custodiantes: [0, 1, 2].map((i) => ({ custodiante: i + 1, mac: X.codificarPacote(dMac.pacotes[i]), cifra: X.codificarPacote(dKek.pacotes[i]) })),
    });
    for (const o of [p, p.registro, p.registro.mac, p.registro.cifra, p.custodiantes, ...p.custodiantes]) assert.ok(Object.isFrozen(o));
    const visivel = JSON.stringify(p) + util.inspect(p, { showHidden: true, depth: 9 });
    for (const s of hexDe(SM, SK)) assert.equal(visivel.includes(s), false, 'o segredo não sai da preparação');
    assert.equal(JSON.stringify(p.registro).includes(A1.toString('hex')), false, 'o registro não traz partes');
  });

  test('CER-02 — tamanhos: MAC de 32 a 128 bytes inteiros, KEK sempre 32; fora disso nada é sorteado', () => {
    for (const bytes of [32, 33, 64, 128]) {
      const p = preparar({ mac: { chaveId: MAC, bytes }, aleatorio: fila(bloco(bytes, 1), SK, bloco(bytes, 3), bloco(bytes, 4), A2, B2) });
      assert.equal(p.ok, true, String(bytes));
      assert.equal(p.registro.mac.bytes, bytes);
      assert.equal(p.registro.cifra.bytes, 32);
      assert.match(p.custodiantes[0].mac, new RegExp(`\\nparte 1: [0-9a-f]{${bytes * 2}} `));
      assert.match(p.custodiantes[0].cifra, /\nparte 1: [0-9a-f]{64} /);
    }
    for (const bytes of [31, 129, 0, -32, 32.5, '32', null, undefined, NaN, Infinity, [32], Object(32)]) {
      const aleatorio = fila(...BLOCOS);
      recusado(preparar({ mac: { chaveId: MAC, bytes }, aleatorio }), 'ENTRADA_INVALIDA');
      assert.equal(aleatorio.entregues.length, 0, String(bytes));
    }
  });

  test('CER-03 — separação: mesmo id recusa antes do sorteio; MAC igual à KEK é CHAVES_NAO_SEPARADAS', () => {
    const aleatorio = fila(...BLOCOS);
    recusado(preparar({ cifra: { chaveId: MAC }, aleatorio }), 'ID_REPETIDO');
    assert.equal(aleatorio.entregues.length, 0);
    recusado(preparar({ aleatorio: fila(SM, SM, A1, B1, A2, B2) }), 'CHAVES_NAO_SEPARADAS', hexDe(SM, A1, B1, A2, B2));
  });

  test('CER-04 — aleatoriedade inválida: não é função, lança, devolve tipo ou tamanho errado (em qualquer um dos seis sorteios)', () => {
    for (const aleatorio of [undefined, null, 'x', 7, {}, []]) recusado(preparar({ aleatorio }), 'ALEATORIEDADE_INVALIDA');
    const ruins = [() => { throw new Error(`falhou ${SM.toString('hex')}`); }, () => 'a'.repeat(32), () => Array.from(SM), () => null, () => Buffer.alloc(31, 9), () => Buffer.alloc(33, 9), () => new Uint16Array(16)];
    for (const ruim of ruins) {
      for (let k = 0; k < 6; k += 1) {
        const boa = fila(...BLOCOS);
        let i = 0;
        const aleatorio = (n) => { const b = boa(n); return i++ === k ? ruim() : b; };
        recusado(preparar({ aleatorio }), 'ALEATORIEDADE_INVALIDA', hexDe(...BLOCOS));
      }
    }
    for (const [k, bytes, desvio] of [[0, 32, 1], [1, 32, 1], [0, 64, -1], [0, 64, 1]]) {
      let i = 0;
      const aleatorio = (n) => { const b = bloco(i === k ? n + desvio : n, 10 + i); i += 1; return b; };
      recusado(preparar({ mac: { chaveId: MAC, bytes }, aleatorio }), 'ALEATORIEDADE_INVALIDA');
    }
    const u8 = fila(...BLOCOS);
    assert.equal(preparar({ aleatorio: (n) => new Uint8Array(u8(n)) }).ok, true, 'Uint8Array que não é Buffer é aceito');
    let chamadas = 0;
    recusado(preparar({ aleatorio: () => { chamadas += 1; return null; } }), 'ALEATORIEDADE_INVALIDA');
    assert.equal(chamadas, 1, 'o primeiro sorteio inválido interrompe os sorteios');
  });

  test('CER-05 — aleatoriedade degenerada: bloco zerado, blocos repetidos e parte derivada igual a outro valor expõem o segredo e são recusados', () => {
    const xor = (...bs) => X.combinarPartes(...bs);
    const casos = {
      'segredo zerado': [ZERO, SK, A1, B1, A2, B2],
      'parte a zerada': [SM, SK, ZERO, B1, A2, B2],
      'parte b zerada (KEK)': [SM, SK, A1, B1, A2, ZERO],
      'a igual a b': [SM, SK, A1, A1, A2, B2],
      'a igual ao segredo': [SM, SK, SM, B1, A2, B2],
      'b igual ao segredo (c = a)': [SM, SK, A1, B1, A2, SK],
      'c zerada (S = a xor b)': [SM, SK, A1, xor(SM, A1), A2, B2],
      'c da KEK zerada': [SM, SK, A1, B1, A2, xor(SK, A2)],
      'parte do MAC igual ao segredo da KEK': [SM, SK, SK, B1, A2, B2],
      'bloco do MAC repetido na KEK': [SM, SK, A1, B1, A1, B2],
      'segredo do MAC usado como parte da KEK': [SM, SK, A1, B1, A2, SM],
      'c do MAC igual a parte da KEK': [SM, SK, A1, B1, xor(SM, A1, B1), B2],
      'c da KEK igual a c do MAC': [SM, SK, A1, B1, A2, xor(SK, A2, xor(SM, A1, B1))],
    };
    for (const [nome, blocos] of Object.entries(casos)) {
      const r = preparar({ aleatorio: fila(...blocos) });
      assert.equal(r.ok, false, nome);
      recusado(r, 'ALEATORIEDADE_DEGENERADA', hexDe(...blocos.filter((b) => !b.equals(ZERO))));
    }
  });

  test('CER-06 — os buffers entregues pela aleatoriedade são zerados pelo módulo, no sucesso e em toda falha depois do sorteio', () => {
    const zerados = (aleatorio, n) => { assert.equal(aleatorio.entregues.length, n); assert.ok(aleatorio.entregues.every((b) => b.equals(Buffer.alloc(b.length)))); };
    const ok = fila(...BLOCOS);
    assert.equal(preparar({ aleatorio: ok }).ok, true);
    zerados(ok, 6);
    const iguais = fila(SM, SM, A1, B1, A2, B2);
    assert.equal(preparar({ aleatorio: iguais }).ok, false);
    zerados(iguais, 2);
    const curta = fila(SM, SK, A1);
    let k = 0;
    recusado(preparar({ aleatorio: (n) => (k++ < 3 ? curta(n) : null) }), 'ALEATORIEDADE_INVALIDA');
    zerados(curta, 3);
    const errado = Buffer.alloc(31, 9);
    recusado(preparar({ aleatorio: () => errado }), 'ALEATORIEDADE_INVALIDA');
    assert.ok(errado.equals(Buffer.alloc(31)), 'o buffer de tamanho errado também é zerado');
  });

  test('CER-07 — entrada fora do contrato: forma exata, ids válidos, objetos hostis; sempre recusa, nunca lança', () => {
    const invalidos = [
      undefined, null, 'x', 7, [], () => {},
      {}, { mac: { chaveId: MAC, bytes: 32 }, cifra: { chaveId: KEK } },
      pedido({ extra: 1 }), pedido({ [Symbol('x')]: 1 }), { mac: { chaveId: MAC, bytes: 32 }, cifra: { chaveId: KEK }, outro: fila(...BLOCOS) },
      pedido({ mac: null }), pedido({ mac: [] }), pedido({ mac: { chaveId: MAC } }), pedido({ mac: { chaveId: MAC, bytes: 32, extra: 1 } }),
      pedido({ cifra: null }), pedido({ cifra: {} }), pedido({ cifra: { chaveId: KEK, bytes: 32 } }),
      pedido({ mac: { chaveId: '', bytes: 32 } }), pedido({ mac: { chaveId: '-x', bytes: 32 } }), pedido({ mac: { chaveId: 'a'.repeat(65), bytes: 32 } }), pedido({ mac: { chaveId: 7, bytes: 32 } }), pedido({ mac: { chaveId: 'a b', bytes: 32 } }),
      pedido({ cifra: { chaveId: 'kek\n' } }), pedido({ cifra: { chaveId: ['kek'] } }), pedido({ cifra: { chaveId: null } }),
    ];
    for (const [i, v] of invalidos.entries()) assert.deepEqual(C.prepararCerimonia(v), { ok: false, motivo: 'ENTRADA_INVALIDA' }, `caso ${i}`);
    const bomba = () => { throw new Error(`SEGREDO ${SM.toString('hex')}`); };
    const hostis = [
      new Proxy({}, { ownKeys: bomba }),
      Object.defineProperty(pedido(), 'mac', { enumerable: true, get: bomba }),
      pedido({ mac: Object.defineProperty({ bytes: 32 }, 'chaveId', { enumerable: true, get: bomba }) }),
      pedido({ cifra: new Proxy({ chaveId: KEK }, { get: bomba }) }),
    ];
    for (const [i, v] of hostis.entries()) recusado(C.prepararCerimonia(v), 'ENTRADA_INVALIDA', hexDe(SM));
    let leituras = 0;
    const instavel = pedido({ mac: { get chaveId() { leituras += 1; return leituras === 1 ? MAC : KEK; }, bytes: 32 } });
    const p = C.prepararCerimonia(instavel);
    assert.equal(p.ok, true);
    assert.equal(p.registro.mac.chaveId, MAC, 'cada campo é lido uma vez: o valor validado é o usado');
    assert.equal(leituras, 1);
  });

  test('CER-08 — função no lugar de objeto é recusada nas oito posições, mesmo com as chaves exatas', () => {
    assert.deepEqual(Reflect.ownKeys(funcaoComo({ a: 1 })), ['a'], 'o disfarce tem só as chaves pedidas');
    const p = preparar();
    const apresentados = { mac: textos(p, 'mac', 0, 1), cifra: textos(p, 'cifra', 0, 1) };
    const copia = { mac: { ...p.registro.mac }, cifra: { ...p.registro.cifra } };
    assert.equal(C.conferirCerimonia({ registro: copia, apresentados }).ok, true, 'controle: os mesmos valores em objetos são aceitos');
    const posicoes = {
      'opcoes (preparação)': () => C.prepararCerimonia(funcaoComo(pedido())),
      'mac (preparação)': () => preparar({ mac: funcaoComo({ chaveId: MAC, bytes: 32 }) }),
      'cifra (preparação)': () => preparar({ cifra: funcaoComo({ chaveId: KEK }) }),
      'opcoes (conferência)': () => C.conferirCerimonia(funcaoComo({ registro: copia, apresentados })),
      'registro': () => C.conferirCerimonia({ registro: funcaoComo(copia), apresentados }),
      'registro.mac': () => C.conferirCerimonia({ registro: { mac: funcaoComo(copia.mac), cifra: copia.cifra }, apresentados }),
      'registro.cifra': () => C.conferirCerimonia({ registro: { mac: copia.mac, cifra: funcaoComo(copia.cifra) }, apresentados }),
      'apresentados': () => C.conferirCerimonia({ registro: copia, apresentados: funcaoComo(apresentados) }),
    };
    assert.equal(Object.keys(posicoes).length, 8);
    for (const [nome, chamar] of Object.entries(posicoes)) {
      const r = chamar();
      assert.equal(r.ok, false, nome);
      recusado(r, 'ENTRADA_INVALIDA', hexDe(SM, SK));
    }
  });

  test('CER-09 — as cópias internas dos segredos e dos sorteios são zeradas, no sucesso e na falha (espião síncrono de Buffer.prototype.fill, restaurado)', () => {
    const fillOriginal = Buffer.prototype.fill;
    const descritor = Object.getOwnPropertyDescriptor(Buffer.prototype, 'fill');
    // Entrega Uint8Array que não é Buffer: a zeragem do buffer entregue não passa pelo espião; só as cópias internas passam.
    const semBuffer = (...blocos) => { const f = fila(...blocos); return (n) => new Uint8Array(f(n)); };

    const ok = zeradosDurante(() => preparar({ aleatorio: semBuffer(...BLOCOS) }));
    assert.equal(ok.saida.ok, true);
    assert.deepEqual([vezes(ok.vistos, SM), vezes(ok.vistos, SK)], [1, 1], 'segredos zerados ao fim da preparação');

    const iguais = zeradosDurante(() => preparar({ aleatorio: semBuffer(SM, SM) }));
    recusado(iguais.saida, 'CHAVES_NAO_SEPARADAS');
    assert.equal(vezes(iguais.vistos, SM), 2, 'zerados também na recusa');

    const curto = bloco(31, 77);
    const errado = zeradosDurante(() => preparar({ aleatorio: () => new Uint8Array(curto) }));
    recusado(errado.saida, 'ALEATORIEDADE_INVALIDA');
    assert.equal(vezes(errado.vistos, curto), 1, 'a cópia do sorteio de tamanho errado é zerada');

    const p = preparar();
    const apresentados = { mac: textos(p, 'mac', 0, 1), cifra: textos(p, 'cifra', 1, 2) };
    const conf = zeradosDurante(() => C.conferirCerimonia({ registro: p.registro, apresentados }));
    assert.equal(conf.saida.ok, true);
    assert.deepEqual([vezes(conf.vistos, SM), vezes(conf.vistos, SK)], [1, 1], 'segredos reconstruídos zerados ao fim da conferência');
    const recusada = zeradosDurante(() => C.conferirCerimonia({ registro: { mac: { ...p.registro.mac, bytes: 64 }, cifra: p.registro.cifra }, apresentados }));
    recusado(recusada.saida, 'SEGREDO_INVALIDO');
    assert.equal(vezes(recusada.vistos, SM), 1, 'zerado também quando a conferência recusa depois de reconstruir');

    assert.throws(() => zeradosDurante(() => { throw new Error('sintético'); }), /sintético/);
    assert.equal(Buffer.prototype.fill, fillOriginal, 'o espião é retirado, inclusive quando a função lança');
    assert.deepEqual(Object.getOwnPropertyDescriptor(Buffer.prototype, 'fill'), descritor);
    const fora = Buffer.from(SM);
    fora.fill(0);
    assert.ok(fora.equals(ZERO), 'fill volta ao normal fora do espião');
  });
});

describe('[CER] conferência da transcrição (reconstrução por dupla)', () => {
  test('CER-10 — QUALQUER dupla válida, em qualquer ordem, o trio e duplas diferentes por família conferem; o resultado não traz segredo nem partes', () => {
    const p = preparar();
    const esperado = { ok: true, mac: { chaveId: MAC, valorDeVerificacao: p.registro.mac.valorDeVerificacao }, cifra: { chaveId: KEK, valorDeVerificacao: p.registro.cifra.valorDeVerificacao } };
    for (const [i, j] of [[0, 1], [1, 0], [1, 2], [2, 1], [0, 2], [2, 0]]) {
      const r = dupla(p, i, j);
      assert.deepEqual(r, esperado, `${i}${j}`);
      for (const o of [r, r.mac, r.cifra]) assert.ok(Object.isFrozen(o));
    }
    assert.deepEqual(conferir(p, textos(p, 'mac', 0, 1, 2), textos(p, 'cifra', 2, 1, 0)), esperado);
    assert.deepEqual(conferir(p, textos(p, 'mac', 0, 1), textos(p, 'cifra', 1, 2)), esperado);
    const objetos = (familia, ...is) => textos(p, familia, ...is).map((t) => X.decodificarPacote(t).pacote);
    assert.deepEqual(conferir(p, objetos('mac', 0, 2), objetos('cifra', 0, 2)), esperado, 'pacotes como objeto também');
    const visivel = JSON.stringify(esperado) + util.inspect(dupla(p, 0, 1), { showHidden: true, depth: 9 });
    for (const s of [...hexDe(SM, SK), ...partesDe(p)]) assert.equal(visivel.includes(s), false);
    assert.equal(partesDe(p).length, 12);
  });

  test('CER-11 — com aleatoriedade real e MAC de 64 bytes, toda dupla reconstrói e confere', () => {
    const crypto = require('node:crypto');
    const p = C.prepararCerimonia({ mac: { chaveId: MAC, bytes: 64 }, cifra: { chaveId: KEK }, aleatorio: (n) => crypto.randomBytes(n) });
    assert.equal(p.ok, true);
    for (const [i, j] of [[0, 1], [1, 2], [0, 2]]) assert.equal(dupla(p, i, j).ok, true);
    const q = C.prepararCerimonia({ mac: { chaveId: MAC, bytes: 64 }, cifra: { chaveId: KEK }, aleatorio: (n) => crypto.randomBytes(n) });
    assert.notEqual(q.registro.mac.valorDeVerificacao, p.registro.mac.valorDeVerificacao);
    recusado(conferir(q, textos(p, 'mac', 0, 1), textos(p, 'cifra', 0, 1)), 'VALOR_DE_VERIFICACAO_DIVERGENTE', partesDe(p));
  });

  test('CER-12 — partes insuficientes, repetidas e em excesso são recusadas, em qualquer das famílias', () => {
    const p = preparar();
    const boas = { mac: textos(p, 'mac', 0, 1), cifra: textos(p, 'cifra', 0, 1) };
    const sens = [...hexDe(SM, SK), ...partesDe(p)];
    const casos = [
      [[], 'ENTRADA_INVALIDA'],
      [(f) => textos(p, f, 0), 'PACOTES_INSUFICIENTES'],
      [(f) => textos(p, f, 2), 'PACOTES_INSUFICIENTES'],
      [(f) => textos(p, f, 1, 1), 'CUSTODIANTES_REPETIDOS'],
      [(f) => textos(p, f, 0, 1, 0), 'CUSTODIANTES_REPETIDOS'],
      [(f) => textos(p, f, 0, 1, 2, 0), 'ENTRADA_INVALIDA'],
      [null, 'ENTRADA_INVALIDA'], [undefined, 'ENTRADA_INVALIDA'], ['x', 'ENTRADA_INVALIDA'], [{ 0: 'a', 1: 'b', length: 2 }, 'ENTRADA_INVALIDA'],
    ];
    for (const [caso, motivo] of casos) {
      for (const familia of ['mac', 'cifra']) {
        const ruim = typeof caso === 'function' ? caso(familia) : caso;
        recusado(C.conferirCerimonia({ registro: p.registro, apresentados: { ...boas, [familia]: ruim } }), motivo, sens);
      }
    }
  });

  test('CER-13 — partes inválidas: erro de transcrição, formato, parte divergente, outra divisão, famílias trocadas e pacotes de chaves misturadas', () => {
    const p = preparar();
    const sens = [...hexDe(SM, SK), ...partesDe(p)];
    const [m0, m1] = textos(p, 'mac', 0, 1);
    const boasCifra = textos(p, 'cifra', 0, 1);
    const trocarDigito = (t) => t.replace(/(parte 1: )([0-9a-f])/, (_, a, d) => a + (d === '0' ? '1' : '0'));
    recusado(conferir(p, [trocarDigito(m0), m1], boasCifra), 'PARTE_COM_ERRO_DE_TRANSCRICAO', sens);
    for (const ruim of [`${m0}\n`, m0.toUpperCase(), m0.replace('\n', '\r\n'), m0.slice(0, -1), '', 7, null, {}, { ...X.decodificarPacote(m0).pacote, extra: 1 }]) recusado(conferir(p, [ruim, m1], boasCifra), 'PACOTE_FORMATO', sens);
    const outra = outraDivisao(MAC, SM, 40);
    recusado(conferir(p, [m0, X.codificarPacote(outra.pacotes[1])], boasCifra), 'PARTE_DIVERGENTE', sens);
    const outroSegredo = outraDivisao(MAC, bloco(32, 90), 50);
    recusado(conferir(p, [m0, X.codificarPacote(outroSegredo.pacotes[1])], boasCifra), 'PACOTES_DE_CHAVES_DIFERENTES', sens);
    recusado(conferir(p, codificados(outroSegredo, 0, 1), boasCifra), 'VALOR_DE_VERIFICACAO_DIVERGENTE', sens);
    recusado(conferir(p, boasCifra, [m0, m1]), 'CHAVE_DIFERENTE_DA_ESPERADA', sens);
    recusado(conferir(p, [m0, m1], [m0, m1]), 'CHAVE_DIFERENTE_DA_ESPERADA', sens);
    recusado(conferir(p, [m0, boasCifra[1]], boasCifra), 'PACOTES_DE_CHAVES_DIFERENTES', sens);
  });

  test('CER-14 — tamanho e separação conferidos na reconstrução: bytes do registro, KEK de 32 bytes e MAC diferente da KEK', () => {
    const dMac = outraDivisao(MAC, SM, 60);
    const dKek = outraDivisao(KEK, SK, 70);
    const apresentados = { mac: codificados(dMac, 0, 1), cifra: codificados(dKek, 1, 2) };
    assert.equal(C.conferirCerimonia({ registro: registroDe(dMac, dKek), apresentados }).ok, true);
    recusado(C.conferirCerimonia({ registro: registroDe(dMac, dKek, 64), apresentados }), 'SEGREDO_INVALIDO', hexDe(SM, SK));
    const mac64 = outraDivisao(MAC, bloco(64, 9), 80);
    assert.equal(C.conferirCerimonia({ registro: registroDe(mac64, dKek, 64), apresentados: { ...apresentados, mac: codificados(mac64, 0, 2) } }).ok, true);
    recusado(C.conferirCerimonia({ registro: registroDe(mac64, dKek, 32), apresentados: { ...apresentados, mac: codificados(mac64, 0, 2) } }), 'SEGREDO_INVALIDO');
    const kek64 = outraDivisao(KEK, bloco(64, 11), 82);
    const registroKek64 = { ...registroDe(dMac, kek64), cifra: { chaveId: KEK, bytes: 64, valorDeVerificacao: kek64.valorDeVerificacao } };
    recusado(C.conferirCerimonia({ registro: registroKek64, apresentados: { ...apresentados, cifra: codificados(kek64, 0, 1) } }), 'ENTRADA_INVALIDA');
    recusado(C.conferirCerimonia({ registro: registroDe(dMac, kek64), apresentados: { ...apresentados, cifra: codificados(kek64, 0, 1) } }), 'SEGREDO_INVALIDO');
    const kekIgual = outraDivisao(KEK, SM, 84);
    recusado(C.conferirCerimonia({ registro: registroDe(dMac, kekIgual), apresentados: { mac: codificados(dMac, 0, 1), cifra: codificados(kekIgual, 0, 1) } }), 'CHAVES_NAO_SEPARADAS', hexDe(SM));
  });

  test('CER-15 — tudo ou nada: a falha de uma família não devolve nada da outra, seja qual for a ordem', () => {
    const p = preparar();
    const bons = { mac: textos(p, 'mac', 0, 1), cifra: textos(p, 'cifra', 0, 1) };
    for (const familia of ['mac', 'cifra']) {
      const r = C.conferirCerimonia({ registro: p.registro, apresentados: { ...bons, [familia]: textos(p, familia, 0) } });
      recusado(r, 'PACOTES_INSUFICIENTES', [p.registro.mac.valorDeVerificacao, p.registro.cifra.valorDeVerificacao, MAC, KEK]);
    }
  });

  test('CER-16 — registro e entrada fora do contrato: forma exata, ids, bytes, valor de verificação; objetos hostis; nunca lança', () => {
    const p = preparar();
    const apresentados = { mac: textos(p, 'mac', 0, 1), cifra: textos(p, 'cifra', 0, 1) };
    const reg = (mac = {}, cifra = {}) => ({ mac: { ...p.registro.mac, ...mac }, cifra: { ...p.registro.cifra, ...cifra } });
    const vc = p.registro.mac.valorDeVerificacao;
    const registros = [
      undefined, null, 'x', [], {}, { mac: p.registro.mac }, { ...reg(), extra: 1 }, { mac: null, cifra: p.registro.cifra }, { mac: p.registro.mac, cifra: [] },
      reg({ extra: 1 }), reg({}, { extra: 1 }), { mac: { chaveId: MAC, bytes: 32 }, cifra: p.registro.cifra },
      reg({ chaveId: '' }), reg({ chaveId: 7 }), reg({ chaveId: '.x' }), reg({}, { chaveId: 'a'.repeat(65) }), reg({}, { chaveId: MAC }), reg({ chaveId: KEK }),
      reg({ bytes: 31 }), reg({ bytes: 129 }), reg({ bytes: '32' }), reg({ bytes: 32.5 }), reg({}, { bytes: 33 }), reg({}, { bytes: 64 }), reg({}, { bytes: '32' }), reg({}, { bytes: 31 }), reg({}, { bytes: 0 }),
      reg({ valorDeVerificacao: vc.slice(1) }), reg({ valorDeVerificacao: `${vc}0` }), reg({ valorDeVerificacao: vc.toUpperCase() }), reg({ valorDeVerificacao: `${vc.slice(0, 63)}g` }), reg({}, { valorDeVerificacao: null }), reg({}, { valorDeVerificacao: [vc] }),
    ];
    for (const [i, registro] of registros.entries()) assert.deepEqual(C.conferirCerimonia({ registro, apresentados }), { ok: false, motivo: 'ENTRADA_INVALIDA' }, `registro ${i}`);
    recusado(C.conferirCerimonia({ registro: reg({ bytes: 31 }), apresentados: { ...apresentados, mac: textos(p, 'mac', 0) } }), 'ENTRADA_INVALIDA');
    const entradas = [undefined, null, 'x', [], {}, { registro: p.registro }, { apresentados }, { registro: p.registro, apresentados, extra: 1 }, { registro: p.registro, apresentados: null }, { registro: p.registro, apresentados: [] }, { registro: p.registro, apresentados: { mac: apresentados.mac } }, { registro: p.registro, apresentados: { ...apresentados, extra: [] } }];
    for (const [i, v] of entradas.entries()) assert.deepEqual(C.conferirCerimonia(v), { ok: false, motivo: 'ENTRADA_INVALIDA' }, `entrada ${i}`);
    const bomba = () => { throw new Error(`SEGREDO ${SM.toString('hex')}`); };
    const hostis = [
      new Proxy({}, { ownKeys: bomba }),
      { registro: new Proxy(p.registro, { get: bomba }), apresentados },
      { registro: p.registro, apresentados: new Proxy(apresentados, { get: bomba }) },
      { registro: p.registro, apresentados: { mac: new Proxy([], { get: bomba }), cifra: apresentados.cifra } },
      { registro: p.registro, apresentados: { mac: apresentados.mac, cifra: [apresentados.cifra[0], new Proxy({}, { ownKeys: bomba })] } },
    ];
    for (const v of hostis) recusado(C.conferirCerimonia(v), 'ENTRADA_INVALIDA', hexDe(SM));
    let leituras = 0;
    const instavel = { mac: { ...p.registro.mac, get chaveId() { leituras += 1; return leituras === 1 ? MAC : KEK; } }, cifra: p.registro.cifra };
    assert.equal(C.conferirCerimonia({ registro: instavel, apresentados }).ok, true, 'cada campo do registro é lido uma vez');
    assert.equal(leituras, 1);
  });

  test('CER-17 — o buffer do segredo reconstruído pelo XOR é o próprio que é zerado, não uma cópia (espião síncrono de crypto.createHash, restaurado)', () => {
    const crypto = require('node:crypto');
    const createHashOriginal = crypto.createHash;
    const descritor = Object.getOwnPropertyDescriptor(crypto, 'createHash');
    // O XOR passa o buffer do segredo reconstruído a createHash().update(); a referência é classificada na captura, antes de qualquer zeragem.
    const segredosVistosEm = (fn) => {
      const vistos = [];
      crypto.createHash = function espiao(...args) {
        const h = createHashOriginal.apply(this, args);
        const update = h.update;
        h.update = function atualizar(dado, ...resto) {
          if (dado instanceof Uint8Array) for (const [nome, s] of [['mac', SM], ['cifra', SK]]) if (Buffer.compare(dado, s) === 0) vistos.push({ nome, referencia: dado });
          return update.call(this, dado, ...resto);
        };
        return h;
      };
      try { return { saida: fn(), vistos }; } finally { crypto.createHash = createHashOriginal; }
    };
    const p = preparar();
    const apresentados = { mac: textos(p, 'mac', 0, 1), cifra: textos(p, 'cifra', 1, 2) };

    const ok = segredosVistosEm(() => C.conferirCerimonia({ registro: p.registro, apresentados }));
    assert.equal(ok.saida.ok, true);
    assert.deepEqual(ok.vistos.map((v) => v.nome), ['mac', 'cifra'], 'os dois segredos reconstruídos foram identificados');
    for (const v of ok.vistos) assert.ok(v.referencia.equals(ZERO), `o buffer reconstruído (${v.nome}) é zerado ao fim da conferência`);

    const recusada = segredosVistosEm(() => C.conferirCerimonia({ registro: { mac: { ...p.registro.mac, bytes: 64 }, cifra: p.registro.cifra }, apresentados }));
    recusado(recusada.saida, 'SEGREDO_INVALIDO');
    assert.deepEqual(recusada.vistos.map((v) => v.nome), ['mac']);
    assert.ok(recusada.vistos[0].referencia.equals(ZERO), 'zerado também quando a conferência recusa depois de reconstruir');

    assert.throws(() => segredosVistosEm(() => { throw new Error('sintético'); }), /sintético/);
    assert.equal(crypto.createHash, createHashOriginal, 'o espião é retirado, inclusive quando a função lança');
    assert.deepEqual(Object.getOwnPropertyDescriptor(crypto, 'createHash'), descritor);
    assert.equal(crypto.createHash('sha256').update('abc').digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('[CER] contrato do módulo', () => {
  test('CER-20 — motivos fixos e exportações exatas', () => {
    assert.deepEqual(Object.keys(C).sort(), ['BYTES_KEK', 'BYTES_MAC_MAX', 'BYTES_MAC_MIN', 'MOTIVOS', 'conferirCerimonia', 'prepararCerimonia']);
    assert.deepEqual([C.BYTES_KEK, C.BYTES_MAC_MIN, C.BYTES_MAC_MAX], [32, 32, 128]);
    assert.ok(Object.isFrozen(C.MOTIVOS));
    assert.deepEqual([...C.MOTIVOS].sort(), [
      'ALEATORIEDADE_DEGENERADA', 'ALEATORIEDADE_INVALIDA', 'CHAVES_NAO_SEPARADAS', 'CHAVE_DIFERENTE_DA_ESPERADA', 'CUSTODIANTES_REPETIDOS', 'ENTRADA_INVALIDA', 'ID_REPETIDO',
      'PACOTES_DE_CHAVES_DIFERENTES', 'PACOTES_INSUFICIENTES', 'PACOTE_FORMATO', 'PARTE_COM_ERRO_DE_TRANSCRICAO', 'PARTE_DIVERGENTE', 'SEGREDO_INVALIDO', 'VALOR_DE_VERIFICACAO_DIVERGENTE',
    ]);
  });

  test('CER-21 — módulo puro: só importa a custódia XOR; sem arquivo, rede, ambiente, entrada padrão, processo, relógio, SDK nem gerador próprio de aleatoriedade', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'backup-custodia-cerimonia.service.js'), 'utf8');
    const importados = [...fonte.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]);
    assert.deepEqual(importados, ["'./backup-custodia-xor.service'"]);
    for (const proibido of [/\bprocess\b/, /\bimport\s*\(/, /\bfs\b/, /\bcrypto\b/, /randomBytes|getRandomValues|Math\.random/, /\bDate\b/, /console\./, /@aws-sdk/, /\bstdin\b|\bstdout\b/, /setTimeout|setInterval/]) assert.equal(proibido.test(fonte), false, String(proibido));
  });
});
