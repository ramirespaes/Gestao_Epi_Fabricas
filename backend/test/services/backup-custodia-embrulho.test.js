'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const E = require('../../src/services/backup-custodia-embrulho.service');
const C = require('../../src/services/backup-custodia-cerimonia.service');
const K = require('../../src/services/backup-fontes-kms-pre-resolvido.service');
const X = require('../../src/services/backup-custodia-xor.service');
const { criarProvedoresDeRecuperacaoOffline } = require('../../src/services/backup-fontes-recuperacao-offline.service');
const { criarKmsFalso } = require('../helpers/kms-falso');
const { fichaDeTeste, registro } = require('../helpers/fichas-duraveis');

/** D3/H9-d F2 [EMB]: lógica pura do embrulho das chaves MAC e KEK para o KMS. Só cliente KMS FALSO e valores SINTÉTICOS; nenhum segredo real, sem rede. */

const bloco = (n, semente) => Buffer.from(Array.from({ length: n }, (_, i) => (semente + i * 7) & 255));
const SM = bloco(32, 1);
const SK = bloco(32, 2);
const BLOCOS = [SM, SK, bloco(32, 3), bloco(32, 4), bloco(32, 5), bloco(32, 6)];
const ZERO = Buffer.alloc(32);
const MAC = 'mac-hml-v1';
const KEK = 'kek-hml-v1';
const ARN_ESTRANHO = 'arn:aws:kms:us-east-1:111111111111:key/99999999-9999-4999-8999-999999999999';
const ficha = registro(fichaDeTeste('HOMOLOGACAO'))[0];
const ctx = (finalidade, chaveId) => K.contextoDeCriptografia({ ambiente: 'HOMOLOGACAO', finalidade, chaveId });
const pausa = (ms) => new Promise((r) => { setTimeout(r, ms); });
const temporizadores = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;

function fila(...blocos) {
  let i = 0;
  return () => Buffer.from(blocos[i++]);
}

/** Cerimônia sintética, KMS falso e um cliente de cifragem que registra cada pedido; `desvio(pedido, indice)` pode trocar a resposta de uma chamada. */
function cenario(desvio = () => undefined) {
  const p = C.prepararCerimonia({ mac: { chaveId: MAC, bytes: 32 }, cifra: { chaveId: KEK }, aleatorio: fila(...BLOCOS) });
  assert.equal(p.ok, true);
  const kms = criarKmsFalso();
  const pedidos = [];
  const cliente = {
    async cifrar(pedido) {
      const indice = pedidos.length;
      pedidos.push({ pedido, chaves: Reflect.ownKeys(pedido), hex: Buffer.from(pedido.segredo).toString('hex'), referencia: pedido.segredo, memoriaPropria: pedido.segredo.byteOffset === 0 && pedido.segredo.buffer.byteLength === pedido.segredo.length, anterioresZerados: pedidos.every((x) => x.referencia.equals(ZERO)) });
      const trocada = await desvio(pedido, indice);
      return trocada === undefined ? { chaveArn: pedido.chaveArn, blob: kms.cifrar(pedido) } : trocada;
    },
  };
  const cartoes = (familia, ...indices) => indices.map((i) => p.custodiantes[i][familia]);
  const entrada = (extra = {}) => ({ ficha, registro: p.registro, apresentados: { mac: cartoes('mac', 0, 1), cifra: cartoes('cifra', 0, 1) }, cliente, prazoMs: 1000, ...extra });
  const sensiveis = [SM, SK].flatMap((b) => [b.toString('hex'), b.toString('base64')]).concat(p.custodiantes.flatMap((c) => [c.mac, c.cifra]).flatMap((t) => [...t.matchAll(/^parte [1-3]: ([0-9a-f]+) /gm)].map((m) => m[1])));
  return { p, kms, pedidos, cliente, cartoes, entrada, sensiveis };
}

function recusado(r, motivo, sensiveis = []) {
  assert.deepEqual({ ...r }, { ok: false, motivo });
  assert.deepEqual(Reflect.ownKeys(r), ['ok', 'motivo']);
  assert.ok(Object.isFrozen(r));
  assert.ok(E.MOTIVOS.includes(motivo), motivo);
  const visivel = JSON.stringify(r) + util.inspect(r, { showHidden: true, depth: 9 });
  for (const s of sensiveis) assert.equal(visivel.includes(s), false);
}
const todosZerados = (c) => c.pedidos.every((x) => x.referencia.equals(ZERO));
/**
 * Espia `crypto.createHash(...).update` durante `fn` e guarda a referência de cada buffer igual a um dos segredos sintéticos: são os segredos reconstruídos pelo XOR,
 * que nunca saem dos módulos (o XOR os passa ao cálculo do valor de verificação). Restaura no `finally`.
 */
async function internosDurante(fn) {
  const original = crypto.createHash;
  const internos = [];
  crypto.createHash = function espiao(...args) {
    const h = original.apply(this, args);
    const update = h.update;
    h.update = function atualizar(dado, ...resto) { if (dado instanceof Uint8Array && (SM.equals(dado) || SK.equals(dado))) internos.push(dado); return update.call(this, dado, ...resto); };
    return h;
  };
  try { return { saida: await fn(), internos }; } finally { crypto.createHash = original; }
}
const funcaoComo = (campos) => { const f = () => {}; delete f.length; delete f.name; return Object.assign(f, campos); };

describe('[EMB] embrulho das duas chaves', () => {
  test('EMB-01 — sucesso: duas chamadas (MAC, depois KEK), cada uma com o ARN da ficha e o contexto próprio; retorno no formato do provedor KMS', async () => {
    const c = cenario();
    const r = await E.embrulharChaves(c.entrada());
    assert.equal(r.ok, true);
    assert.deepEqual(Reflect.ownKeys(r), ['ok', 'chaves']);
    assert.deepEqual(Reflect.ownKeys(r.chaves), ['mac', 'cifra']);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.chaves) && Object.isFrozen(r.chaves.mac) && Object.isFrozen(r.chaves.cifra) && Object.isFrozen(r.chaves.mac[0]) && Object.isFrozen(r.chaves.cifra[0]));
    assert.equal(c.pedidos.length, 2);
    for (const x of c.pedidos) { assert.deepEqual(x.chaves, ['chaveArn', 'contexto', 'segredo']); assert.ok(Object.isFrozen(x.pedido)); }
    assert.equal(c.pedidos[0].pedido.chaveArn, ficha.chaveMac);
    assert.equal(c.pedidos[1].pedido.chaveArn, ficha.chaveCifra);
    assert.deepEqual(c.pedidos[0].pedido.contexto, ctx('MAC', MAC));
    assert.deepEqual(c.pedidos[1].pedido.contexto, ctx('CIFRA', KEK));
    assert.notDeepEqual(c.pedidos[0].pedido.contexto, c.pedidos[1].pedido.contexto);
    assert.equal(c.pedidos[0].hex, SM.toString('hex'));
    assert.equal(c.pedidos[1].hex, SK.toString('hex'));
    for (const [familia, id] of [['mac', MAC], ['cifra', KEK]]) {
      assert.equal(r.chaves[familia].length, 1);
      const item = r.chaves[familia][0];
      assert.deepEqual(Reflect.ownKeys(item), ['chaveId', 'estado', 'blob', 'vc']);
      assert.equal(item.chaveId, id);
      assert.equal(item.estado, 'ATIVA');
      assert.equal(item.vc, c.p.registro[familia].valorDeVerificacao);
      assert.ok(Buffer.isBuffer(item.blob) && item.blob.length === 48);
    }
    assert.equal(r.chaves.mac[0].blob.equals(r.chaves.cifra[0].blob), false);
  });

  test('EMB-02 — qualquer dupla de custodiantes e os três cartões dão o mesmo embrulho lógico; o prazo é opcional e o temporizador não fica pendente', async () => {
    for (const indices of [[0, 1], [0, 2], [1, 2], [2, 0], [0, 1, 2]]) {
      const c = cenario();
      const r = await E.embrulharChaves(c.entrada({ apresentados: { mac: c.cartoes('mac', ...indices), cifra: c.cartoes('cifra', ...indices) } }));
      assert.equal(r.ok, true, indices.join());
      assert.deepEqual(c.pedidos.map((x) => x.hex), [SM.toString('hex'), SK.toString('hex')]);
    }
    const c = cenario();
    const semPrazo = c.entrada();
    delete semPrazo.prazoMs;
    const antes = temporizadores();
    assert.equal((await E.embrulharChaves(semPrazo)).ok, true);
    assert.equal(temporizadores(), antes);
    for (const prazoMs of [1000, 60000]) assert.equal((await E.embrulharChaves(cenario().entrada({ prazoMs }))).ok, true);
    assert.equal(temporizadores(), antes);
  });

  test('EMB-03 — compatibilidade: a saída resolve no provedor KMS pré-resolvido, e os mesmos cartões dão as mesmas chaves na recuperação offline', async () => {
    const c = cenario();
    const r = await E.embrulharChaves(c.entrada());
    const kms = K.criarProvedoresKmsPreResolvidos({ ficha, cliente: c.kms.cliente, chaves: r.chaves, prazoMs: 1000 });
    await kms.resolver();
    assert.equal(kms.estado(), 'RESOLVIDO');
    const offline = criarProvedoresDeRecuperacaoOffline({ chaves: { mac: [{ chaveId: MAC, estado: 'ATIVA', pacotes: c.cartoes('mac', 1, 2) }], cifra: [{ chaveId: KEK, estado: 'ATIVA', pacotes: c.cartoes('cifra', 1, 2) }] } });
    for (const [familia, id, segredo] of [['mac', MAC, SM], ['cifra', KEK, SK]]) {
      const a = kms[familia].obter(id);
      const b = offline[familia].obter(id);
      assert.equal(a.situacao, 'ATIVA');
      assert.equal(b.situacao, 'ATIVA');
      assert.ok(a.segredo.equals(segredo) && b.segredo.equals(segredo));
      assert.equal(X.valorDeVerificacao(id, a.segredo), r.chaves[familia][0].vc);
    }
    kms.zerar();
    offline.zerar();
  });

  test('EMB-04 — contextos independentes: o blob da MAC não resolve como KEK nem o contrário', async () => {
    const c = cenario();
    const r = await E.embrulharChaves(c.entrada());
    const trocadas = { mac: [{ ...r.chaves.mac[0], blob: r.chaves.cifra[0].blob }], cifra: [{ ...r.chaves.cifra[0], blob: r.chaves.mac[0].blob }] };
    const kms = K.criarProvedoresKmsPreResolvidos({ ficha, cliente: c.kms.cliente, chaves: trocadas, prazoMs: 1000 });
    await assert.rejects(kms.resolver(), (e) => e.code === 'KMS_PRE_RESOLUCAO_FALHOU' && e.motivo === 'KMS_INDISPONIVEL');
  });
});

describe('[EMB] recusas antes de chamar o KMS', () => {
  test('EMB-05 — entrada fora do formato, ficha, cliente e prazo inválidos: motivo fixo e nenhuma chamada', async () => {
    const getter = Object.freeze(Object.defineProperty({ ...ficha }, 'chaveMac', { get: () => ficha.chaveMac, enumerable: true }));
    const casos = [
      ['ENTRADA_INVALIDA', () => ({ extra: 1 })],
      ['ENTRADA_INVALIDA', () => ({ [Symbol('x')]: 1 })],
      ['ENTRADA_INVALIDA', () => ({ apresentados: null })],
      ['ENTRADA_INVALIDA', () => ({ apresentados: [] })],
      ['ENTRADA_INVALIDA', (c) => ({ apresentados: { mac: c.cartoes('mac', 0, 1) } })],
      ['ENTRADA_INVALIDA', (c) => ({ apresentados: { mac: c.cartoes('mac', 0, 1), cifra: c.cartoes('cifra', 0, 1), extra: [] } })],
      ['ENTRADA_INVALIDA', (c) => ({ apresentados: { mac: 'x', cifra: c.cartoes('cifra', 0, 1) } })],
      ['ENTRADA_INVALIDA', (c) => ({ apresentados: { mac: [], cifra: c.cartoes('cifra', 0, 1) } })],
      ['ENTRADA_INVALIDA', (c) => ({ apresentados: { mac: [...c.cartoes('mac', 0, 1, 2), c.cartoes('mac', 0)[0]], cifra: c.cartoes('cifra', 0, 1) } })],
      ['ENTRADA_INVALIDA', (c) => ({ apresentados: { mac: c.cartoes('mac', 0, 1), cifra: [c.cartoes('cifra', 0)[0], X.decodificarPacote(c.cartoes('cifra', 1)[0]).pacote] } })],
      ['ENTRADA_INVALIDA', (c) => ({ apresentados: funcaoComo({ mac: c.cartoes('mac', 0, 1), cifra: c.cartoes('cifra', 0, 1) }) })],
      ['ENTRADA_INVALIDA', () => ({ registro: null })],
      ['FICHA_INVALIDA', () => ({ ficha: null })],
      ['FICHA_INVALIDA', () => ({ ficha: { ...ficha } })],
      ['FICHA_INVALIDA', () => ({ ficha: Object.freeze({ ...ficha, chaveCifra: ficha.chaveMac }) })],
      ['FICHA_INVALIDA', () => ({ ficha: Object.freeze({ ...ficha, ambiente: 'OUTRO' }) })],
      ['FICHA_INVALIDA', () => ({ ficha: getter })],
      ['FICHA_INVALIDA', () => ({ ficha: Object.freeze(funcaoComo({ ...ficha })) })],
      ['CLIENTE_INVALIDO', () => ({ cliente: null })],
      ['CLIENTE_INVALIDO', () => ({ cliente: {} })],
      ['CLIENTE_INVALIDO', () => ({ cliente: { cifrar: 'x' } })],
      ['CLIENTE_INVALIDO', (c) => ({ cliente: funcaoComo({ cifrar: c.cliente.cifrar }) })],
      ['PRAZO_INVALIDO', () => ({ prazoMs: 0 })],
      ['PRAZO_INVALIDO', () => ({ prazoMs: 60001 })],
      ['PRAZO_INVALIDO', () => ({ prazoMs: 1.5 })],
      ['PRAZO_INVALIDO', () => ({ prazoMs: '1000' })],
      ['PRAZO_INVALIDO', () => ({ prazoMs: undefined })],
    ];
    for (const [i, [motivo, extra]] of casos.entries()) {
      const c = cenario();
      recusado(await E.embrulharChaves(c.entrada(extra(c))), motivo, c.sensiveis);
      assert.equal(c.pedidos.length, 0, `caso ${i}`);
    }
    for (const falta of ['ficha', 'registro', 'apresentados', 'cliente']) {
      const c = cenario();
      const e = c.entrada();
      delete e[falta];
      recusado(await E.embrulharChaves(e), 'ENTRADA_INVALIDA');
      assert.equal(c.pedidos.length, 0);
    }
  });

  test('EMB-06 — a conferência da cerimônia decide primeiro: a recusa dela é repassada e o KMS não é chamado', async () => {
    const outra = X.dividirSegredo({ chaveId: MAC, segredo: bloco(32, 9), aleatorio: fila(bloco(32, 10), bloco(32, 11)) });
    const casos = [
      ['PACOTES_INSUFICIENTES', (c) => ({ apresentados: { mac: c.cartoes('mac', 0), cifra: c.cartoes('cifra', 0, 1) } })],
      ['CUSTODIANTES_REPETIDOS', (c) => ({ apresentados: { mac: c.cartoes('mac', 0, 0), cifra: c.cartoes('cifra', 0, 1) } })],
      ['PACOTE_FORMATO', (c) => ({ apresentados: { mac: ['x', 'y'], cifra: c.cartoes('cifra', 0, 1) } })],
      ['CHAVE_DIFERENTE_DA_ESPERADA', (c) => ({ apresentados: { mac: c.cartoes('cifra', 0, 1), cifra: c.cartoes('mac', 0, 1) } })],
      ['VALOR_DE_VERIFICACAO_DIVERGENTE', (c) => ({ apresentados: { mac: [0, 1].map((i) => X.codificarPacote(outra.pacotes[i])), cifra: c.cartoes('cifra', 0, 1) } })],
      ['ENTRADA_INVALIDA', (c) => ({ registro: { mac: c.p.registro.mac } })],
      ['SEGREDO_INVALIDO', (c) => ({ registro: { mac: { ...c.p.registro.mac, bytes: 64 }, cifra: c.p.registro.cifra } })],
    ];
    for (const [motivo, extra] of casos) {
      const c = cenario();
      recusado(await E.embrulharChaves(c.entrada(extra(c))), motivo, c.sensiveis);
      assert.equal(c.pedidos.length, 0, motivo);
    }
  });

  test('EMB-07 — nunca lança nem rejeita, lê cada campo da entrada uma única vez e não altera o que recebeu', async () => {
    const explode = new Proxy({}, { ownKeys() { throw new Error(SM.toString('hex')); } });
    const comGetter = Object.defineProperty({}, 'ficha', { get() { throw new Error(SK.toString('hex')); }, enumerable: true });
    for (const hostil of [undefined, null, 1, 'x', [], () => {}, funcaoComo({}), Object.create(null), explode, comGetter]) {
      recusado(await E.embrulharChaves(hostil), 'ENTRADA_INVALIDA', [SM.toString('hex'), SK.toString('hex')]);
    }
    const c = cenario();
    const base = c.entrada();
    const leituras = {};
    const contada = {};
    for (const k of Object.keys(base)) Object.defineProperty(contada, k, { enumerable: true, get() { leituras[k] = (leituras[k] || 0) + 1; return base[k]; } });
    const apresentados = {};
    const originais = base.apresentados;
    for (const k of ['mac', 'cifra']) Object.defineProperty(apresentados, k, { enumerable: true, get() { leituras[`a.${k}`] = (leituras[`a.${k}`] || 0) + 1; return originais[k]; } });
    base.apresentados = apresentados;
    const copiaDosCartoes = JSON.stringify([c.cartoes('mac', 0, 1), c.cartoes('cifra', 0, 1)]);
    assert.equal((await E.embrulharChaves(contada)).ok, true);
    assert.deepEqual(leituras, { ficha: 1, registro: 1, apresentados: 1, cliente: 1, prazoMs: 1, 'a.mac': 1, 'a.cifra': 1 });
    assert.equal(JSON.stringify([c.cartoes('mac', 0, 1), c.cartoes('cifra', 0, 1)]), copiaDosCartoes);
    assert.deepEqual(c.p.registro, C.prepararCerimonia({ mac: { chaveId: MAC, bytes: 32 }, cifra: { chaveId: KEK }, aleatorio: fila(...BLOCOS) }).registro);
  });

  test('EMB-08 — lista de cartões que muda entre leituras não engana: o que foi conferido é o que é embrulhado', async () => {
    const c = cenario();
    const outra = X.dividirSegredo({ chaveId: MAC, segredo: bloco(32, 9), aleatorio: fila(bloco(32, 10), bloco(32, 11)) });
    const falsos = [0, 1].map((i) => X.codificarPacote(outra.pacotes[i]));
    let leituras = 0;
    const mutante = new Proxy(c.cartoes('mac', 0, 1), { get(alvo, k, r) { if (k === '0' || k === '1') { leituras += 1; return leituras > 2 ? falsos[Number(k)] : alvo[k]; } return Reflect.get(alvo, k, r); } });
    const r = await E.embrulharChaves(c.entrada({ apresentados: { mac: mutante, cifra: c.cartoes('cifra', 0, 1) } }));
    assert.equal(r.ok, true);
    assert.equal(leituras, 2);
    assert.equal(c.pedidos[0].hex, SM.toString('hex'));
  });
});

describe('[EMB] falhas do KMS: tudo ou nada', () => {
  test('EMB-09 — exceção, rejeição e resposta fora do contrato, na primeira ou na segunda chamada: recusa sem blob, sem causa e com os buffers zerados', async () => {
    const respostas = [
      ['KMS_INDISPONIVEL', (p) => { throw new Error(`falha ${Buffer.from(p.segredo).toString('hex')}`); }],
      ['KMS_INDISPONIVEL', (p) => Promise.reject(Object.assign(new Error('AccessDenied'), { segredo: Buffer.from(p.segredo) }))],
      ['KMS_INDISPONIVEL', () => ({ get then() { throw new Error('then'); } })],
      ['RESPOSTA_INVALIDA', () => null],
      ['RESPOSTA_INVALIDA', () => 'blob'],
      ['RESPOSTA_INVALIDA', () => []],
      ['RESPOSTA_INVALIDA', (p) => ({ chaveArn: p.chaveArn })],
      ['RESPOSTA_INVALIDA', (p) => ({ chaveArn: p.chaveArn, blob: Buffer.alloc(8, 1), extra: 1 })],
      ['RESPOSTA_INVALIDA', (p) => funcaoComo({ chaveArn: p.chaveArn, blob: Buffer.alloc(8, 1) })],
      ['RESPOSTA_INVALIDA', () => ({ chaveArn: 7, blob: Buffer.alloc(8, 1) })],
      ['RESPOSTA_INVALIDA', (p) => ({ chaveArn: p.chaveArn, blob: 'YmxvYg==' })],
      ['RESPOSTA_INVALIDA', (p) => ({ chaveArn: p.chaveArn, blob: Buffer.alloc(0) })],
      ['RESPOSTA_INVALIDA', (p) => ({ chaveArn: p.chaveArn, blob: Buffer.alloc(4097, 1) })],
      ['RESPOSTA_INVALIDA', (p) => ({ chaveArn: p.chaveArn, blob: p.segredo })],
      ['RESPOSTA_INVALIDA', (p) => ({ chaveArn: p.chaveArn, blob: Buffer.concat([Buffer.alloc(4, 1), Buffer.from(p.segredo), Buffer.alloc(4, 2)]) })],
      ['RESPOSTA_INVALIDA', (p) => ({ chaveArn: p.chaveArn, get blob() { throw new Error('blob'); } })],
      ['CHAVE_KMS_DIVERGENTE', () => ({ chaveArn: ARN_ESTRANHO, blob: Buffer.alloc(8, 1) })],
      ['CHAVE_KMS_DIVERGENTE', (p) => ({ chaveArn: p.chaveArn === ficha.chaveMac ? ficha.chaveCifra : ficha.chaveMac, blob: Buffer.alloc(8, 1) })],
    ];
    for (const [i, [motivo, resposta]] of respostas.entries()) {
      for (const naChamada of [0, 1]) {
        const c = cenario((p, indice) => (indice === naChamada ? resposta(p) : undefined));
        recusado(await E.embrulharChaves(c.entrada()), motivo, c.sensiveis);
        assert.equal(c.pedidos.length, naChamada + 1, `caso ${i}, chamada ${naChamada}`);
        assert.ok(todosZerados(c), `caso ${i}, chamada ${naChamada}`);
      }
    }
    const limite = cenario((p, indice) => (indice === 0 ? { chaveArn: p.chaveArn, blob: Buffer.alloc(4096, 1) } : { chaveArn: p.chaveArn, blob: Uint8Array.of(9) }));
    const r = await E.embrulharChaves(limite.entrada());
    assert.equal(r.ok, true);
    assert.deepEqual([r.chaves.mac[0].blob.length, r.chaves.cifra[0].blob.length], [4096, 1]);
    assert.ok(Buffer.isBuffer(r.chaves.cifra[0].blob));
  });

  test('EMB-10 — o mesmo blob para as duas chaves é recusado; o blob devolvido é cópia', async () => {
    const igual = Buffer.alloc(16, 7);
    const c = cenario((p) => ({ chaveArn: p.chaveArn, blob: Buffer.from(igual) }));
    recusado(await E.embrulharChaves(c.entrada()), 'RESPOSTA_INVALIDA', c.sensiveis);
    assert.equal(c.pedidos.length, 2);
    const devolvidos = [];
    const d = cenario((p, i) => { devolvidos.push(Buffer.alloc(16, i + 1)); return { chaveArn: p.chaveArn, blob: devolvidos[i] }; });
    const r = await E.embrulharChaves(d.entrada());
    assert.equal(r.ok, true);
    devolvidos[0].fill(0);
    assert.ok(r.chaves.mac[0].blob.equals(Buffer.alloc(16, 1)));
    assert.notEqual(r.chaves.mac[0].blob, devolvidos[0]);
  });

  test('EMB-11 — atraso além do prazo: recusa no prazo, a segunda chave não é pedida e a resposta tardia (sucesso ou erro) não muda nada', async () => {
    const naoTratadas = [];
    const ouvinte = (e) => naoTratadas.push(e);
    process.on('unhandledRejection', ouvinte);
    try {
      for (const [naChamada, tardia] of [[0, 'sucesso'], [1, 'sucesso'], [0, 'erro'], [1, 'erro']]) {
        let concluir;
        const c = cenario((p, indice) => (indice === naChamada ? new Promise((resolver, rejeitar) => { concluir = () => (tardia === 'erro' ? rejeitar(new Error('tarde')) : resolver({ chaveArn: p.chaveArn, blob: Buffer.alloc(8, 3) })); }) : undefined));
        const antes = temporizadores();
        const inicio = process.hrtime.bigint();
        const r = await E.embrulharChaves(c.entrada({ prazoMs: 30 }));
        const duracaoMs = Number(process.hrtime.bigint() - inicio) / 1e6;
        recusado(r, 'KMS_INDISPONIVEL', c.sensiveis);
        assert.ok(duracaoMs >= 25 && duracaoMs < 900, String(duracaoMs));
        assert.equal(c.pedidos.length, naChamada + 1);
        assert.ok(todosZerados(c));
        assert.equal(temporizadores(), antes);
        concluir();
        await pausa(15);
        assert.equal(c.pedidos.length, naChamada + 1);
        assert.deepEqual({ ...r }, { ok: false, motivo: 'KMS_INDISPONIVEL' });
      }
      assert.deepEqual(naoTratadas, []);
    } finally {
      process.off('unhandledRejection', ouvinte);
    }
  });
});

describe('[EMB] sigilo', () => {
  test('EMB-12 — o buffer entregue é exclusivo, é zerado ao fim de cada chamada e a MAC já está zerada quando a KEK é pedida', async () => {
    const c = cenario();
    const r = await E.embrulharChaves(c.entrada());
    assert.equal(r.ok, true);
    assert.notEqual(c.pedidos[0].referencia, c.pedidos[1].referencia);
    assert.equal(c.pedidos.length, 2);
    assert.equal(c.pedidos[1].anterioresZerados, true);
    assert.ok(todosZerados(c));
    for (const x of c.pedidos) assert.equal(x.memoriaPropria, true);
  });

  test('EMB-15 — segredo alterado pelo cliente durante a chamada é recusado, na MAC ou na KEK, sem devolver blob', async () => {
    const alteracoes = [
      ['preenchido', (b) => { b.fill(0xff); }],
      ['um bit', (b) => { b[b.length - 1] ^= 1; }],
      ['primeiro byte', (b) => { b[0] = (b[0] + 1) & 255; }],
      ['zerado pelo cliente', (b) => { b.fill(0); }],
      ['memória transferida', (b) => { b.buffer.transfer(); }],
    ];
    for (const [nome, alterar] of alteracoes) {
      for (const naChamada of [0, 1]) {
        const onde = `${nome}, chamada ${naChamada}`;
        const c = cenario((p, indice) => { if (indice === naChamada) alterar(p.segredo); return undefined; });
        const { saida, internos } = await internosDurante(() => E.embrulharChaves(c.entrada()));
        recusado(saida, 'SEGREDO_ALTERADO', c.sensiveis);
        assert.equal(c.pedidos.length, naChamada + 1, onde);
        assert.equal(c.pedidos[naChamada].hex, [SM, SK][naChamada].toString('hex'), onde);
        for (const x of c.pedidos) assert.ok(x.referencia.length === 0 || ZERO.equals(x.referencia), onde);
        assert.ok(internos.length >= naChamada + 3 && internos.every((b) => ZERO.equals(b)), onde);
      }
    }
  });

  test('EMB-16 — LIMITE CONHECIDO: alteração desfeita antes do retorno não é detectável aqui; quem a detecta é o valor de verificação, na resolução pelo host', async () => {
    const c = cenario((p, indice) => {
      if (indice !== 0) return undefined;
      const original = Buffer.from(p.segredo);
      p.segredo[0] ^= 1;
      const blob = c.kms.cifrar(p);
      p.segredo.set(original);
      return { chaveArn: p.chaveArn, blob };
    });
    const r = await E.embrulharChaves(c.entrada());
    assert.equal(r.ok, true);
    const kms = K.criarProvedoresKmsPreResolvidos({ ficha, cliente: c.kms.cliente, chaves: r.chaves, prazoMs: 1000 });
    await assert.rejects(kms.resolver(), (e) => e.code === 'KMS_PRE_RESOLUCAO_FALHOU' && e.motivo === 'VALOR_DE_VERIFICACAO_DIVERGENTE');
  });

  test('EMB-17 — `fill` trocado na instância entregue (função vazia ou que lança) não impede a zeragem nem faz a promessa rejeitar: sucesso, falha e prazo', async () => {
    const trocas = [['vazia', () => {}], ['lança', () => { throw new Error(SM.toString('hex')); }]];
    const desfechos = [
      ['sucesso', () => undefined, (r) => assert.equal(r.ok, true), 1000],
      ['falha', () => Promise.reject(new Error('AccessDenied')), (r, c) => recusado(r, 'KMS_INDISPONIVEL', c.sensiveis), 1000],
      ['resposta inválida', () => null, (r, c) => recusado(r, 'RESPOSTA_INVALIDA', c.sensiveis), 1000],
      ['prazo', () => new Promise(() => {}), (r, c) => recusado(r, 'KMS_INDISPONIVEL', c.sensiveis), 30],
    ];
    for (const [troca, fill] of trocas) {
      for (const [desfecho, responder, conferir, prazoMs] of desfechos) {
        for (const naChamada of [0, 1]) {
          const c = cenario((p, indice) => {
            Object.defineProperty(p.segredo, 'fill', { value: fill, configurable: true, writable: true });
            return indice === naChamada ? responder() : undefined;
          });
          const r = await E.embrulharChaves(c.entrada({ prazoMs }));
          const onde = `${troca}, ${desfecho}, chamada ${naChamada}`;
          conferir(r, c);
          assert.equal(c.pedidos.length, desfecho === 'sucesso' ? 2 : naChamada + 1, onde);
          for (const x of c.pedidos) { assert.equal(Object.hasOwn(x.referencia, 'fill'), true, onde); assert.ok(ZERO.equals(x.referencia), onde); }
        }
      }
    }
  });

  test('EMB-18 — `Buffer.prototype.fill` trocado pelo cliente depois da carga do módulo não impede a zeragem dos buffers deste módulo nem faz a promessa rejeitar', async () => {
    const original = Buffer.prototype.fill;
    const descritor = JSON.stringify(Object.getOwnPropertyDescriptor(Buffer.prototype, 'fill'));
    // Com o protótipo que lança, é a reconstrução XOR da KEK (outro módulo, que usa o protótipo) que falha: a recusa é fechada e a KEK não chega a ser pedida.
    const casos = [
      ['vazia', function vazia() { return this; }, false, null, 2],
      ['vazia', function vazia() { return this; }, true, 'RESPOSTA_INVALIDA', 2],
      ['lança', () => { throw new Error('fill'); }, false, 'ENTRADA_INVALIDA', 1],
    ];
    for (const [nome, fill, falhar, motivo, chamadas] of casos) {
      const c = cenario((p, indice) => { if (indice === 0) Buffer.prototype.fill = fill; return falhar && indice === 1 ? null : undefined; });
      let r;
      try { r = await E.embrulharChaves(c.entrada()); } finally { Buffer.prototype.fill = original; }
      if (motivo === null) assert.equal(r.ok, true, nome); else recusado(r, motivo, c.sensiveis);
      assert.equal(c.pedidos.length, chamadas, nome);
      assert.ok(todosZerados(c), `${nome}, falhar=${falhar}`);
    }
    assert.equal(Buffer.prototype.fill, original);
    assert.equal(JSON.stringify(Object.getOwnPropertyDescriptor(Buffer.prototype, 'fill')), descritor);
  });

  test('EMB-19 — o segredo reconstruído internamente também termina zerado: sucesso, falha, resposta inválida e prazo', async () => {
    const createHash = crypto.createHash;
    const desfechos = [
      ['sucesso', () => undefined, null, 1000],
      ['falha', () => Promise.reject(new Error('AccessDenied')), 'KMS_INDISPONIVEL', 1000],
      ['resposta inválida', () => null, 'RESPOSTA_INVALIDA', 1000],
      ['prazo', () => new Promise(() => {}), 'KMS_INDISPONIVEL', 30],
    ];
    for (const [desfecho, responder, motivo, prazoMs] of desfechos) {
      for (const naChamada of [0, 1]) {
        const onde = `${desfecho}, chamada ${naChamada}`;
        const c = cenario((p, indice) => (indice === naChamada ? responder() : undefined));
        const { saida, internos } = await internosDurante(() => E.embrulharChaves(c.entrada({ prazoMs })));
        if (motivo === null) assert.equal(saida.ok, true, onde); else recusado(saida, motivo, c.sensiveis);
        // A conferência reconstrói MAC e KEK (2) e o embrulho reconstrói de novo cada chave que chega a pedir.
        const esperados = 2 + c.pedidos.length;
        assert.ok(internos.length >= esperados, `${onde}: ${internos.length}`);
        assert.equal(new Set(internos).size >= esperados, true, onde);
        assert.ok(internos.every((b) => ZERO.equals(b)), onde);
      }
    }
    assert.equal(crypto.createHash, createHash);
  });

  test('EMB-20 — blob hostil: o tamanho vale pelo que o blob realmente tem, e o que é devolvido é uma cópia de 1 a 4096 bytes em memória própria', async () => {
    const real = (n, v) => new Uint8Array(n).fill(v);
    const aceitos = [
      ['valueOf próprio', (i) => { const b = real(10, i + 1); b.valueOf = () => Buffer.alloc(9000, 7); return b; }, 10],
      ['length maior que o real', (i) => { const b = real(4096, i + 1); Object.defineProperty(b, 'length', { get: () => 99999 }); return b; }, 4096],
      ['length zero sobre conteúdo real', (i) => { const b = real(8, i + 1); Object.defineProperty(b, 'length', { get: () => 0 }); return b; }, 8],
    ];
    for (const [nome, criar, tamanho] of aceitos) {
      const c = cenario((p, i) => ({ chaveArn: p.chaveArn, blob: criar(i) }));
      const r = await E.embrulharChaves(c.entrada());
      assert.equal(r.ok, true, nome);
      for (const [i, familia] of ['mac', 'cifra'].entries()) {
        const { blob } = r.chaves[familia][0];
        assert.ok(Buffer.isBuffer(blob), nome);
        assert.equal(blob.length, tamanho, nome);
        assert.ok(blob.equals(Buffer.alloc(tamanho, i + 1)), nome);
        assert.ok(blob.byteOffset === 0 && blob.buffer.byteLength === tamanho, nome);
        assert.deepEqual(Reflect.ownKeys(blob).filter((k) => !/^\d+$/.test(String(k))), [], nome);
      }
    }
    const recusados = [
      ['length menor que o real, depois maior', () => { const b = real(20000, 1); let k = 0; Object.defineProperty(b, 'length', { get() { k += 1; return k <= 2 ? 10 : 20000; } }); return b; }],
      ['length fixo sobre 4097 bytes', () => { const b = real(4097, 1); Object.defineProperty(b, 'length', { get: () => 10 }); return b; }],
      ['valueOf sobre 4097 bytes', () => { const b = real(4097, 1); b.valueOf = () => Buffer.alloc(8, 1); return b; }],
      ['protótipo de Uint8Array sem memória', () => Object.create(Uint8Array.prototype)],
      ['Proxy de Uint8Array', () => new Proxy(real(10, 1), {})],
      ['Uint16Array', () => new Uint16Array(8).fill(1)],
      ['DataView', () => new DataView(new ArrayBuffer(8))],
      ['ArrayBuffer', () => new ArrayBuffer(8)],
      ['memória transferida', () => { const b = real(10, 1); b.buffer.transfer(); return b; }],
    ];
    for (const [nome, criar] of recusados) {
      for (const naChamada of [0, 1]) {
        const c = cenario((p, i) => (i === naChamada ? { chaveArn: p.chaveArn, blob: criar() } : undefined));
        recusado(await E.embrulharChaves(c.entrada()), 'RESPOSTA_INVALIDA', c.sensiveis);
        assert.equal(c.pedidos.length, naChamada + 1, `${nome}, chamada ${naChamada}`);
        assert.ok(todosZerados(c), `${nome}, chamada ${naChamada}`);
      }
    }
  });

  test('EMB-21 — `Object.prototype.then` posto pelo cliente não faz a promessa rejeitar nem leva texto dele ao retorno', async () => {
    const instalacoes = [
      ['uma vez', () => { Object.prototype.then = function umaVez(_resolver, rejeitar) { delete Object.prototype.then; rejeitar(new Error(SM.toString('hex'))); }; }],
      ['permanente', () => { Object.prototype.then = function sempre(_resolver, rejeitar) { rejeitar(new Error(SK.toString('hex'))); }; }],
    ];
    for (const [nome, instalar] of instalacoes) {
      for (const naChamada of [0, 1]) {
        for (const [resposta, motivo] of [['válida', 'KMS_INDISPONIVEL'], ['nula', 'RESPOSTA_INVALIDA']]) {
          const onde = `${nome}, chamada ${naChamada}, resposta ${resposta}`;
          const c = cenario((p, i) => { if (i !== naChamada) return undefined; instalar(); return resposta === 'nula' ? null : undefined; });
          let r;
          let erro = null;
          try { r = await E.embrulharChaves(c.entrada()); } catch (e) { erro = e; } finally { delete Object.prototype.then; }
          assert.equal(erro, null, onde);
          recusado(r, motivo, c.sensiveis);
          assert.equal(Object.getPrototypeOf(r), null, onde);
          assert.ok(todosZerados(c), onde);
        }
      }
    }
    assert.equal('then' in {}, false);
    const ok = await E.embrulharChaves(cenario().entrada());
    assert.equal(ok.ok, true);
    assert.equal(Object.getPrototypeOf(ok), null);
  });

  test('EMB-22 — `Buffer.compare`, `indexOf`, `includes` e `equals` trocados pelo cliente não desligam as verificações', async () => {
    const originais = { compare: Buffer.compare, indexOf: Buffer.prototype.indexOf, includes: Buffer.prototype.includes, equals: Buffer.prototype.equals };
    const restaurar = () => { Buffer.compare = originais.compare; Buffer.prototype.indexOf = originais.indexOf; Buffer.prototype.includes = originais.includes; Buffer.prototype.equals = originais.equals; };
    const casos = [
      ['compare, um bit alterado', 'SEGREDO_ALTERADO', [0, 1], (p) => { Buffer.compare = () => 0; p.segredo[0] ^= 1; return undefined; }],
      ['indexOf e includes, blob com o segredo', 'RESPOSTA_INVALIDA', [0, 1], (p) => { Buffer.prototype.indexOf = () => -1; Buffer.prototype.includes = () => false; return { chaveArn: p.chaveArn, blob: Buffer.concat([Buffer.alloc(4, 1), Buffer.from(p.segredo)]) }; }],
      ['equals e compare, blob repetido', 'RESPOSTA_INVALIDA', [1], (p) => { Buffer.prototype.equals = () => false; Buffer.compare = () => 1; return { chaveArn: p.chaveArn, blob: Buffer.alloc(16, 7) }; }, (p) => ({ chaveArn: p.chaveArn, blob: Buffer.alloc(16, 7) })],
    ];
    try {
      for (const [nome, motivo, chamadas, hostil, antes = () => undefined] of casos) {
        for (const naChamada of chamadas) {
          const c = cenario((p, i) => (i === naChamada ? hostil(p) : antes(p)));
          let r;
          try { r = await E.embrulharChaves(c.entrada()); } finally { restaurar(); }
          recusado(r, motivo, c.sensiveis);
          assert.equal(c.pedidos.length, naChamada + 1, `${nome}, chamada ${naChamada}`);
          assert.ok(todosZerados(c), `${nome}, chamada ${naChamada}`);
        }
      }
    } finally {
      restaurar();
    }
    assert.deepEqual([Buffer.compare, Buffer.prototype.indexOf, Buffer.prototype.includes, Buffer.prototype.equals], [originais.compare, originais.indexOf, originais.includes, originais.equals]);
  });

  test('EMB-13 — nenhum segredo, parte ou cartão aparece no retorno; o módulo não tem arquivo, rede, ambiente, SDK nem saída de console', async () => {
    const c = cenario();
    const r = await E.embrulharChaves(c.entrada());
    const visivel = JSON.stringify(r) + util.inspect(r, { showHidden: true, depth: 9 });
    for (const s of c.sensiveis) assert.equal(visivel.includes(s), false);
    for (const item of [r.chaves.mac[0], r.chaves.cifra[0]]) for (const s of [SM, SK]) assert.equal(item.blob.includes(s), false);
    const fonte = fs.readFileSync(path.join(__dirname, '../../src/services/backup-custodia-embrulho.service.js'), 'utf8');
    assert.equal(/require\(['"]node:(?:fs|net|http|https|child_process|dns|tls|os)|process\.(?:env|stdin|stdout|stderr|argv)|console\.|@aws-sdk|EncryptCommand|GenerateDataKey|randomBytes/.test(fonte), false);
    assert.deepEqual([...fonte.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort(), ['./backup-armazenamento-duravel-fichas.service', './backup-custodia-cerimonia.service', './backup-custodia-xor.service', './backup-fontes-kms-pre-resolvido.service']);
  });

  test('EMB-14 — contrato público: só `embrulharChaves` e constantes; os motivos incluem os da cerimônia', () => {
    assert.deepEqual(Object.keys(E).sort(), ['BLOB_MAXIMO', 'MOTIVOS', 'PRAZO_MAXIMO_MS', 'PRAZO_PADRAO_MS', 'embrulharChaves']);
    assert.ok(Object.isFrozen(E.MOTIVOS));
    assert.equal(new Set(E.MOTIVOS).size, E.MOTIVOS.length);
    for (const m of C.MOTIVOS) assert.ok(E.MOTIVOS.includes(m), m);
    assert.deepEqual(E.MOTIVOS.filter((m) => !C.MOTIVOS.includes(m)), ['FICHA_INVALIDA', 'CLIENTE_INVALIDO', 'PRAZO_INVALIDO', 'KMS_INDISPONIVEL', 'SEGREDO_ALTERADO', 'CHAVE_KMS_DIVERGENTE', 'RESPOSTA_INVALIDA']);
    assert.deepEqual([E.BLOB_MAXIMO, E.PRAZO_PADRAO_MS, E.PRAZO_MAXIMO_MS], [4096, 10000, 60000]);
  });
});
