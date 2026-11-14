'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const E = require('../../src/services/backup-custodia-embrulho.service');
const C = require('../../src/services/backup-custodia-cerimonia.service');
const K = require('../../src/services/backup-fontes-kms-pre-resolvido.service');
const P = require('../../src/services/backup-aws-portas.service');
const { criarSdkFalso } = require('../helpers/sdk-aws-falso');
const { fichaDeTeste, registro } = require('../helpers/fichas-duraveis');

/**
 * D3/H9-d F2b [EMBP]: composição do embrulho (F2a) com a porta KMS Encrypt sobre o SDK FALSO, e a volta pelo provedor KMS pré-resolvido com a porta de decifragem do host.
 * Segredos sintéticos; nada contata a AWS. O comportamento do KMS real e da política IAM não é provado aqui.
 */

// Seis blocos sintéticos distintos: os dois primeiros são os segredos (MAC e KEK), os outros quatro a aleatoriedade da divisão.
const BLOCOS = [11, 23, 37, 41, 53, 67].map((semente) => Buffer.from(Array.from({ length: 32 }, (_, i) => (semente * 3 + i * 5) & 255)));
const [SM, SK] = BLOCOS;
const [MAC, KEK] = ['mac-hml-v1', 'kek-hml-v1'];
const base = fichaDeTeste('HOMOLOGACAO');
const ficha = registro(base)[0];
const pausa = (ms) => new Promise((r) => { setTimeout(r, ms); });
const zerado = (b) => b.length > 0 && b.every((x) => x === 0);

function cenario({ papel = 'cerimonia', prazoDaPortaMs = 1000 } = {}) {
  let i = 0;
  const p = C.prepararCerimonia({ mac: { chaveId: MAC, bytes: 32 }, cifra: { chaveId: KEK }, aleatorio: () => Buffer.from(BLOCOS[i++]) });
  assert.equal(p.ok, true);
  const f = criarSdkFalso({ ficha: base });
  const categorias = [];
  const porta = P.criarPortaKmsEncrypt({ sdk: f.sdk, regiao: base.regiao, credenciais: f.credenciais(papel), prazoMs: prazoDaPortaMs, observador: (c) => { categorias.push(c); } });
  const recebidos = [];
  const cliente = { cifrar(pedido) { recebidos.push(pedido.segredo); return porta.cifrar(pedido); } };
  const entrada = (extra = {}) => ({ ficha, registro: p.registro, apresentados: { mac: [p.custodiantes[0].mac, p.custodiantes[1].mac], cifra: [p.custodiantes[1].cifra, p.custodiantes[2].cifra] }, cliente, prazoMs: 1000, ...extra });
  const host = () => P.criarPortaKms({ sdk: f.sdk, regiao: base.regiao, credenciais: f.credenciais('publicador') });
  const encrypts = () => f.estado.chamadas.filter((c) => c.operacao === 'kms:Encrypt');
  return { p, f, porta, recebidos, categorias, entrada, host, encrypts };
}
function recusado(r, motivo) {
  assert.deepEqual({ ...r }, { ok: false, motivo });
  assert.deepEqual(Reflect.ownKeys(r), ['ok', 'motivo']);
}

describe('[EMBP] embrulho + porta KMS Encrypt', () => {
  test('EMBP-01 — a cerimônia embrulha MAC e KEK pela porta e o host as recupera: provedor pré-resolvido com a porta de decifragem, valores de verificação conferidos', async () => {
    const c = cenario();
    const r = await E.embrulharChaves(c.entrada());
    assert.equal(r.ok, true);
    assert.deepEqual(c.categorias, []);
    assert.deepEqual(c.encrypts().map((x) => x.input), [
      { KeyId: base.chaveMac, EncryptionContext: K.contextoDeCriptografia({ ambiente: 'HOMOLOGACAO', finalidade: 'MAC', chaveId: MAC }), EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' },
      { KeyId: base.chaveCifra, EncryptionContext: K.contextoDeCriptografia({ ambiente: 'HOMOLOGACAO', finalidade: 'CIFRA', chaveId: KEK }), EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' },
    ]);
    assert.deepEqual(c.encrypts().map((x) => x.papel), ['cerimonia', 'cerimonia']);
    const provedor = K.criarProvedoresKmsPreResolvidos({ ficha, cliente: c.host(), chaves: r.chaves, prazoMs: 1000 });
    await provedor.resolver();
    assert.equal(provedor.estado(), 'RESOLVIDO');
    assert.ok(Buffer.from(provedor.mac.obter(MAC).segredo).equals(SM));
    assert.ok(Buffer.from(provedor.cifra.obter(KEK).segredo).equals(SK));
    provedor.zerar();
  });

  test('EMBP-02 — propriedade dos buffers na composição: o SDK nunca recebe o buffer do embrulho, a porta não o altera, e os dois lados terminam zerados', async () => {
    const c = cenario();
    const r = await E.embrulharChaves(c.entrada());
    assert.equal(r.ok, true, 'a porta não altera o buffer recebido (senão a recusa seria SEGREDO_ALTERADO)');
    assert.equal(c.recebidos.length, 2);
    assert.equal(c.f.estado.enviados.length, 2);
    assert.deepEqual(c.f.estado.enviados.map((x) => x.hex), [SM.toString('hex'), SK.toString('hex')]);
    for (const [i, enviado] of c.f.estado.enviados.entries()) {
      assert.notEqual(enviado.referencia, c.recebidos[i]);
      assert.ok(zerado(enviado.referencia), 'cópia da porta zerada');
      assert.ok(zerado(c.recebidos[i]), 'buffer do embrulho zerado');
    }
    const visivel = JSON.stringify(r) + JSON.stringify(c.f.estado.chamadas);
    for (const s of [SM, SK]) for (const forma of ['hex', 'base64']) assert.equal(visivel.includes(s.toString(forma)), false);
  });

  test('EMBP-03 — contextos independentes de ponta a ponta: com os blobs trocados entre as famílias, o host não resolve', async () => {
    const c = cenario();
    const r = await E.embrulharChaves(c.entrada());
    const [daMac, daKek] = [r.chaves.mac[0], r.chaves.cifra[0]];
    const provedor = K.criarProvedoresKmsPreResolvidos({ ficha, cliente: c.host(), prazoMs: 1000, chaves: { mac: [{ ...daMac, blob: daKek.blob }], cifra: [{ ...daKek, blob: daMac.blob }] } });
    const erro = await provedor.resolver().then(() => null, (e) => e);
    assert.deepEqual([erro.code, erro.motivo], ['KMS_PRE_RESOLUCAO_FALHOU', 'KMS_INDISPONIVEL']);
    assert.equal(provedor.estado(), 'FALHOU');
  });

  test('EMBP-04 — falha do KMS na MAC ou na KEK: uma única recusa, sem blob, sem nova tentativa; o embrulho só vê KMS_INDISPONIVEL e a categoria fica com o observador', async () => {
    const casos = [['NEGAR', 'ACESSO_NEGADO'], ['LIMITE', 'LIMITE_DE_TAXA'], ['REDE', 'FALHA_NAO_CLASSIFICADA'], ['ERRO_COM_SEGREDO', 'FALHA_NAO_CLASSIFICADA'], ['BLOB_VAZIO', 'RESPOSTA_INVALIDA'], ['SEM_KEYID', 'RESPOSTA_INVALIDA']];
    for (const [modo, categoria] of casos) {
      for (const naChamada of [0, 1]) {
        const c = cenario();
        if (naChamada === 1) c.f.programar('Encrypt', 'NORMAL');
        c.f.programar('Encrypt', modo);
        const r = await E.embrulharChaves(c.entrada());
        recusado(r, 'KMS_INDISPONIVEL');
        assert.deepEqual(c.categorias, [categoria], `${modo}, chamada ${naChamada}`);
        assert.equal(c.encrypts().length, naChamada + 1, `${modo}, chamada ${naChamada}`);
        assert.ok(c.f.estado.enviados.every((x) => zerado(x.referencia)) && c.recebidos.every(zerado), `${modo}, chamada ${naChamada}`);
        assert.equal(JSON.stringify(r).includes('eco'), false);
      }
    }
    const semPermissao = cenario({ papel: 'publicador' });
    recusado(await E.embrulharChaves(semPermissao.entrada()), 'KMS_INDISPONIVEL');
    assert.deepEqual(semPermissao.categorias, ['ACESSO_NEGADO']);
    assert.equal(semPermissao.encrypts().length, 1);
  });

  test('EMBP-05 — prazo da porta menor que o do embrulho: a porta aborta, o embrulho recusa e nada fica pendente', async () => {
    for (const naChamada of [0, 1]) {
      const c = cenario({ prazoDaPortaMs: 30 });
      if (naChamada === 1) c.f.programar('Encrypt', 'NORMAL');
      c.f.programar('Encrypt', 'PENDENTE');
      const inicio = process.hrtime.bigint();
      recusado(await E.embrulharChaves(c.entrada({ prazoMs: 1000 })), 'KMS_INDISPONIVEL');
      const duracaoMs = Number(process.hrtime.bigint() - inicio) / 1e6;
      assert.ok(duracaoMs >= 25 && duracaoMs < 900, String(duracaoMs));
      assert.deepEqual(c.categorias, ['PRAZO']);
      assert.equal(c.f.estado.sinais.at(-1).aborted, true);
      assert.equal(c.encrypts().length, naChamada + 1);
      assert.ok(c.f.estado.enviados.every((x) => zerado(x.referencia)) && c.recebidos.every(zerado));
    }
  });

  test('EMBP-06 — prazo do embrulho menor que o da porta, com o SDK surdo ao aborto: o embrulho recusa e zera o seu buffer no prazo dele; a cópia da porta só é zerada no prazo DA PORTA', async () => {
    const c = cenario({ prazoDaPortaMs: 150 });
    c.f.programar('Encrypt', 'SURDA');
    recusado(await E.embrulharChaves(c.entrada({ prazoMs: 20 })), 'KMS_INDISPONIVEL');
    assert.ok(zerado(c.recebidos[0]), 'o buffer do embrulho já está zerado');
    assert.equal(zerado(c.f.estado.enviados[0].referencia), false, 'a cópia da porta ainda vive: o prazo dela não venceu');
    assert.equal(c.f.estado.sinais[0].aborted, false);
    await pausa(200);
    assert.ok(zerado(c.f.estado.enviados[0].referencia), 'vencido o prazo da porta, a cópia é zerada');
    assert.equal(c.f.estado.sinais[0].aborted, true);
    assert.deepEqual(c.categorias, ['PRAZO']);
    c.f.estado.tardias[0]();
    await pausa(10);
    assert.equal(c.encrypts().length, 1, 'a resposta tardia não reabre nada nem dispara a segunda chave');
  });

  test('EMBP-07 — zeragem imediata: quando o cliente recebe o pedido da KEK, o segredo da MAC reconstruído dentro do embrulho já está zerado', async () => {
    const c = cenario();
    const createHash = crypto.createHash;
    // O XOR passa o segredo reconstruído ao cálculo do valor de verificação: a espia guarda a REFERÊNCIA de cada buffer que, na captura, é igual ao segredo da MAC.
    const daMac = [];
    const instantes = [];
    crypto.createHash = function espiao(...args) {
      const h = createHash.apply(this, args);
      const update = h.update;
      h.update = function atualizar(dado, ...resto) { if (dado instanceof Uint8Array && SM.equals(dado)) daMac.push(dado); return update.call(this, dado, ...resto); };
      return h;
    };
    let r;
    try {
      const cliente = { cifrar(pedido) { instantes.push({ capturados: daMac.length, vivos: daMac.filter((b) => !zerado(b)).length }); return c.porta.cifrar(pedido); } };
      r = await E.embrulharChaves(c.entrada({ cliente }));
    } finally {
      crypto.createHash = createHash;
    }
    assert.equal(crypto.createHash, createHash);
    assert.equal(crypto.createHash('sha256').update('abc').digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(r.ok, true);
    assert.equal(instantes.length, 2);
    // No pedido da MAC há duas reconstruções capturadas: a da conferência (já zerada pela cerimônia) e a do embrulho, viva porque está em uso. É o controle de que a espia enxerga o segredo vivo.
    assert.deepEqual(instantes[0], { capturados: 2, vivos: 1 });
    // No pedido da KEK nenhuma reconstrução da MAC pode continuar viva.
    assert.deepEqual(instantes[1], { capturados: 2, vivos: 0 });
    assert.ok(daMac.every(zerado));
  });
});
