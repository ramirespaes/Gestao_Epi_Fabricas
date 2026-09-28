'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const cripto = require('../../src/security/mfa-cripto');

const ADMIN = 42;
const FATOR = '3f2b8c1e-6d4a-4e7b-9c1f-0a2b3c4d5e6f';
const OUTRO_FATOR = '3f2b8c1e-6d4a-4e7b-9c1f-0a2b3c4d5e70';

function chaves(mapa) {
  const chamadas = [];
  const obterChave = (versao) => {
    chamadas.push(versao);
    if (!mapa.has(versao)) throw new cripto.ErroCriptografiaMfa('CHAVE_INDISPONIVEL');
    return Buffer.from(mapa.get(versao));
  };
  obterChave.chamadas = chamadas;
  return obterChave;
}

function motor({ versaoAtual = 1, mapa = new Map([[1, crypto.randomBytes(32)]]) } = {}) {
  const obterChave = chaves(mapa);
  return { m: cripto.criarCriptografiaMfa({ obterChave, versaoAtual }), obterChave, mapa };
}

function recusaCripto(fn, valores = []) {
  assert.throws(fn, (erro) => {
    assert.ok(erro instanceof cripto.ErroCriptografiaMfa, `esperado ErroCriptografiaMfa, veio ${erro && erro.name}`);
    assertSemSensiveis(erro.message, valores, 'erro');
    return true;
  });
}

describe('AAD canônico', () => {
  test('formato exato e determinístico', () => {
    const aad = cripto.montarAad({ formatoVersao: 1, chaveVersao: 3, administradorId: ADMIN, fatorUid: FATOR });
    assert.ok(Buffer.isBuffer(aad));
    assert.equal(aad.toString('ascii'), `safework|mfa|totp-segredo|f1|k3|a42|u${FATOR}`);
    assert.deepEqual(aad, cripto.montarAad({ formatoVersao: 1, chaveVersao: 3, administradorId: ADMIN, fatorUid: FATOR }));
  });

  test('contexto diferente produz AAD diferente', () => {
    const base = { formatoVersao: 1, chaveVersao: 1, administradorId: ADMIN, fatorUid: FATOR };
    const aad = cripto.montarAad(base).toString('ascii');
    for (const variacao of [{ administradorId: 43 }, { fatorUid: OUTRO_FATOR }, { chaveVersao: 2 }, { formatoVersao: 2 }]) {
      assert.notEqual(cripto.montarAad({ ...base, ...variacao }).toString('ascii'), aad, JSON.stringify(variacao));
    }
  });

  test('componentes fora do formato não entram: nada pode quebrar a estrutura', () => {
    const base = { formatoVersao: 1, chaveVersao: 1, administradorId: ADMIN, fatorUid: FATOR };
    const ruins = [
      { administradorId: 0 }, { administradorId: -1 }, { administradorId: 1.5 }, { administradorId: '42' }, { administradorId: 2147483648 },
      { fatorUid: FATOR.toUpperCase() }, { fatorUid: `${FATOR}|a1` }, { fatorUid: 'nao-e-uuid' }, { fatorUid: FATOR.replace(/-/g, '') },
      { chaveVersao: 0 }, { chaveVersao: 10000 }, { chaveVersao: '1' },
      { formatoVersao: 0 }, { formatoVersao: 1.5 },
    ];
    for (const ruim of ruins) {
      assert.throws(() => cripto.montarAad({ ...base, ...ruim }), TypeError, JSON.stringify(ruim));
    }
  });
});

describe('AES-256-GCM do secret TOTP (formato 1)', () => {
  test('cifra e decifra; envelope com nonce de 12 bytes e ciphertext de 20 + 16 (tag)', () => {
    const { m } = motor();
    const segredo = crypto.randomBytes(20);
    const envelope = m.cifrarSegredoTotp({ segredo, administradorId: ADMIN, fatorUid: FATOR });
    assert.deepEqual(Object.keys(envelope).sort(), ['chaveVersao', 'formatoVersao', 'nonce', 'segredoCifrado']);
    assert.equal(envelope.formatoVersao, 1);
    assert.equal(envelope.chaveVersao, 1);
    assert.equal(envelope.nonce.length, 12);
    assert.equal(envelope.segredoCifrado.length, 36);
    assert.equal(envelope.segredoCifrado.includes(segredo), false, 'o secret não aparece no ciphertext');

    const decifrado = m.decifrarSegredoTotp({ administradorId: ADMIN, fatorUid: FATOR, ...envelope });
    assert.deepEqual(decifrado, segredo);
  });

  test('o ciphertext é AES-256-GCM com o AAD canônico (verificado com node:crypto direto)', () => {
    const chave = crypto.randomBytes(32);
    const { m } = motor({ mapa: new Map([[1, chave]]) });
    const segredo = crypto.randomBytes(20);
    const env = m.cifrarSegredoTotp({ segredo, administradorId: ADMIN, fatorUid: FATOR });
    const decipher = crypto.createDecipheriv('aes-256-gcm', chave, env.nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`safework|mfa|totp-segredo|f1|k1|a42|u${FATOR}`, 'ascii'));
    decipher.setAuthTag(env.segredoCifrado.subarray(20));
    assert.deepEqual(Buffer.concat([decipher.update(env.segredoCifrado.subarray(0, 20)), decipher.final()]), segredo);
  });

  test('nonce novo a cada cifragem; escrita sempre com a versão atual', () => {
    const { m } = motor({ versaoAtual: 2, mapa: new Map([[1, crypto.randomBytes(32)], [2, crypto.randomBytes(32)]]) });
    const segredo = crypto.randomBytes(20);
    const a = m.cifrarSegredoTotp({ segredo, administradorId: ADMIN, fatorUid: FATOR });
    const b = m.cifrarSegredoTotp({ segredo, administradorId: ADMIN, fatorUid: FATOR });
    assert.equal(a.chaveVersao, 2);
    assert.notDeepEqual(a.nonce, b.nonce);
    assert.notDeepEqual(a.segredoCifrado, b.segredoCifrado);
  });

  test('ciphertext transplantado para outro administrador, outro fator, outra versão de formato ou de chave falha', () => {
    const chave = crypto.randomBytes(32);
    const { m } = motor({ versaoAtual: 1, mapa: new Map([[1, chave], [2, chave]]) });
    const env = m.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: ADMIN, fatorUid: FATOR });
    recusaCripto(() => m.decifrarSegredoTotp({ ...env, administradorId: 43, fatorUid: FATOR }));
    recusaCripto(() => m.decifrarSegredoTotp({ ...env, administradorId: ADMIN, fatorUid: OUTRO_FATOR }));
    recusaCripto(() => m.decifrarSegredoTotp({ ...env, administradorId: ADMIN, fatorUid: FATOR, chaveVersao: 2 }), 'mesma chave, versão diferente no AAD');
    recusaCripto(() => m.decifrarSegredoTotp({ ...env, administradorId: ADMIN, fatorUid: FATOR, formatoVersao: 2 }));
  });

  test('chave errada para a mesma versão falha', () => {
    const { m } = motor();
    const env = m.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: ADMIN, fatorUid: FATOR });
    const { m: outro } = motor();
    recusaCripto(() => outro.decifrarSegredoTotp({ ...env, administradorId: ADMIN, fatorUid: FATOR }));
  });

  test('tag, ciphertext ou nonce adulterados falham', () => {
    const { m } = motor();
    const env = m.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: ADMIN, fatorUid: FATOR });
    for (const posicao of [0, 19, 20, 35]) {
      const adulterado = Buffer.from(env.segredoCifrado);
      adulterado[posicao] ^= 0x01;
      recusaCripto(() => m.decifrarSegredoTotp({ ...env, segredoCifrado: adulterado, administradorId: ADMIN, fatorUid: FATOR }), String(posicao));
    }
    const nonce = Buffer.from(env.nonce);
    nonce[0] ^= 0x01;
    recusaCripto(() => m.decifrarSegredoTotp({ ...env, nonce, administradorId: ADMIN, fatorUid: FATOR }));
  });

  test('versão de chave inexistente falha fechado, consultando só a versão registrada', () => {
    const { m, obterChave } = motor({ versaoAtual: 1, mapa: new Map([[1, crypto.randomBytes(32)]]) });
    const env = m.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: ADMIN, fatorUid: FATOR });
    obterChave.chamadas.length = 0;
    recusaCripto(() => m.decifrarSegredoTotp({ ...env, chaveVersao: 7, administradorId: ADMIN, fatorUid: FATOR }));
    assert.deepEqual(obterChave.chamadas, [7], 'nenhuma tentativa com outra versão');
  });

  test('versão atual sem chave: cifragem falha fechado', () => {
    const { m } = motor({ versaoAtual: 3, mapa: new Map([[1, crypto.randomBytes(32)]]) });
    recusaCripto(() => m.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: ADMIN, fatorUid: FATOR }));
  });

  test('envelope fora do formato 1 é recusado antes de qualquer decifração', () => {
    const { m, obterChave } = motor();
    const env = m.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: ADMIN, fatorUid: FATOR });
    obterChave.chamadas.length = 0;
    for (const ruim of [
      { formatoVersao: 2 }, { nonce: env.nonce.subarray(0, 11) }, { nonce: 'aaa' },
      { segredoCifrado: env.segredoCifrado.subarray(0, 35) }, { segredoCifrado: Buffer.concat([env.segredoCifrado, Buffer.alloc(1)]) },
    ]) {
      recusaCripto(() => m.decifrarSegredoTotp({ ...env, ...ruim, administradorId: ADMIN, fatorUid: FATOR }));
    }
    assert.deepEqual(obterChave.chamadas, []);
  });

  test('entrada da cifragem fora do contrato é erro de programação', () => {
    const { m } = motor();
    for (const segredo of [crypto.randomBytes(19), crypto.randomBytes(21), 'x'.repeat(20), null]) {
      assert.throws(() => m.cifrarSegredoTotp({ segredo, administradorId: ADMIN, fatorUid: FATOR }), TypeError);
    }
    assert.throws(() => m.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: 0, fatorUid: FATOR }), TypeError);
  });

  test('nenhuma mensagem de erro leva chave, secret, nonce ou ciphertext', () => {
    const chave = crypto.randomBytes(32);
    const { m } = motor({ mapa: new Map([[1, chave]]) });
    const segredo = crypto.randomBytes(20);
    const env = m.cifrarSegredoTotp({ segredo, administradorId: ADMIN, fatorUid: FATOR });
    const sensiveis = [chave.toString('hex'), chave.toString('base64'), segredo.toString('hex'), env.nonce.toString('hex'), env.segredoCifrado.toString('hex'), env.segredoCifrado.toString('base64')];
    for (const fn of [
      () => m.decifrarSegredoTotp({ ...env, administradorId: 43, fatorUid: FATOR }),
      () => m.decifrarSegredoTotp({ ...env, chaveVersao: 9, administradorId: ADMIN, fatorUid: FATOR }),
    ]) {
      recusaCripto(fn, sensiveis);
    }
  });

  test('a instância padrão usa a configuração do processo (chave de teste gerada em memória)', () => {
    const env = cripto.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: ADMIN, fatorUid: FATOR });
    assert.equal(env.chaveVersao, 1);
    assert.equal(cripto.decifrarSegredoTotp({ ...env, administradorId: ADMIN, fatorUid: FATOR }).length, 20);
  });
});

// Antes de abrir transação, quem vai cifrar confere a chave da versão atual:
// sem ela, 503 e nada é tocado.
describe('garantirChaveAtual', () => {
  test('chave atual disponível: não lança e pede só a versão atual', () => {
    const { m, obterChave } = motor({ versaoAtual: 2, mapa: new Map([[1, crypto.randomBytes(32)], [2, crypto.randomBytes(32)]]) });
    assert.doesNotThrow(() => m.garantirChaveAtual());
    assert.deepEqual(obterChave.chamadas, [2]);
  });

  test('chave atual ausente ou fora do tamanho: ErroCriptografiaMfa CHAVE_INDISPONIVEL, sem detalhe', () => {
    const semAtual = motor({ versaoAtual: 3 });
    recusaCripto(() => semAtual.m.garantirChaveAtual());
    const curta = cripto.criarCriptografiaMfa({ obterChave: () => Buffer.alloc(16), versaoAtual: 1 });
    assert.throws(() => curta.garantirChaveAtual(), (erro) => erro instanceof cripto.ErroCriptografiaMfa && erro.motivo === 'CHAVE_INDISPONIVEL');
  });

  test('zera a cópia da chave depois de conferir', () => {
    const copia = crypto.randomBytes(32);
    const m = cripto.criarCriptografiaMfa({ obterChave: () => copia, versaoAtual: 1 });
    m.garantirChaveAtual();
    assert.equal(copia.equals(Buffer.alloc(32)), true);
  });

  test('a instância padrão confere a chave do processo', () => {
    assert.doesNotThrow(() => cripto.garantirChaveAtual());
  });
});
