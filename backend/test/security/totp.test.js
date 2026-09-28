'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const totp = require('../../src/security/totp');

// Referência independente (RFC 4226 §5.3 / RFC 6238), só para os testes.
function hotpReferencia(segredo, contador, digitos = 6) {
  const mensagem = Buffer.alloc(8);
  mensagem.writeBigUInt64BE(BigInt(contador));
  const hmac = crypto.createHmac('sha1', segredo).update(mensagem).digest();
  const deslocamento = hmac[hmac.length - 1] & 0x0f;
  const binario = hmac.readUInt32BE(deslocamento) & 0x7fffffff;
  return String(binario % 10 ** digitos).padStart(digitos, '0');
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decodificar(texto) {
  let bits = '';
  for (const c of texto.replace(/=+$/, '')) {
    const v = BASE32.indexOf(c);
    assert.ok(v >= 0, 'caractere fora do Base32 RFC 4648');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

const SEGREDO_RFC = Buffer.from('12345678901234567890', 'ascii');
const PERIODO_MS = 30_000;

describe('referência dos testes', () => {
  test('a referência reproduz os vetores SHA1 de 8 dígitos do RFC 6238 (Apêndice B)', () => {
    for (const [segundos, esperado] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
      assert.equal(hotpReferencia(SEGREDO_RFC, Math.floor(segundos / 30), 8), esperado);
    }
  });
});

describe('parâmetros fixos', () => {
  test('SHA1, 6 dígitos, 30 s, janela 1, issuer SafeWork, secret de 20 bytes', () => {
    assert.deepEqual({ ...totp.PARAMETROS }, {
      algoritmo: 'SHA1', digitos: 6, periodoSegundos: 30, janela: 1, emissor: 'SafeWork', segredoBytes: 20,
    });
    assert.ok(Object.isFrozen(totp.PARAMETROS));
  });
});

describe('validarCodigo', () => {
  test('vetores do RFC 6238 com 6 dígitos (os 6 últimos dos vetores de 8) devolvem o step do instante', () => {
    for (const [segundos, esperado] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
      const instanteMs = segundos * 1000;
      assert.deepEqual(totp.validarCodigo({ segredo: SEGREDO_RFC, codigo: esperado, instanteMs }), { step: Math.floor(instanteMs / PERIODO_MS) }, String(segundos));
    }
  });

  test('janela de ±1 step: -1, atual e +1 aceitos, cada um com o seu step; ±2 recusados', () => {
    const segredo = crypto.randomBytes(20);
    const instanteMs = 1_900_000_015_000;
    const atual = Math.floor(instanteMs / PERIODO_MS);
    for (const delta of [-1, 0, 1]) {
      const codigo = hotpReferencia(segredo, atual + delta);
      assert.deepEqual(totp.validarCodigo({ segredo, codigo, instanteMs }), { step: atual + delta }, String(delta));
    }
    for (const delta of [-2, 2, -3, 3]) {
      const codigo = hotpReferencia(segredo, atual + delta);
      if ([-1, 0, 1].some((d) => hotpReferencia(segredo, atual + d) === codigo)) continue; // colisão improvável
      assert.equal(totp.validarCodigo({ segredo, codigo, instanteMs }), null, String(delta));
    }
  });

  test('fronteiras de 30 s: o último ms de um step e o primeiro do seguinte', () => {
    const segredo = crypto.randomBytes(20);
    const k = 63_333_333;
    const ultimoMsAnterior = k * PERIODO_MS - 1;
    const primeiroMs = k * PERIODO_MS;
    assert.deepEqual(totp.validarCodigo({ segredo, codigo: hotpReferencia(segredo, k - 1), instanteMs: ultimoMsAnterior }), { step: k - 1 });
    assert.deepEqual(totp.validarCodigo({ segredo, codigo: hotpReferencia(segredo, k), instanteMs: primeiroMs }), { step: k });
    // Do último ms do step k-1, o código de k-2 ainda está na janela; do primeiro ms de k, já não.
    const codigoKMenos2 = hotpReferencia(segredo, k - 2);
    assert.deepEqual(totp.validarCodigo({ segredo, codigo: codigoKMenos2, instanteMs: ultimoMsAnterior }), { step: k - 2 });
    assert.equal(totp.validarCodigo({ segredo, codigo: codigoKMenos2, instanteMs: primeiroMs }), null);
  });

  test('código fora do formato exato de 6 dígitos é inválido (null), sem exceção', () => {
    const segredo = crypto.randomBytes(20);
    const instanteMs = 1_900_000_015_000;
    const valido = hotpReferencia(segredo, Math.floor(instanteMs / PERIODO_MS));
    for (const codigo of [valido.slice(0, 5), `${valido}0`, ` ${valido}`, `${valido} `, valido.replace(/\d/, 'a'), '', '１２３４５６', 123456, null, undefined]) {
      assert.equal(totp.validarCodigo({ segredo, codigo, instanteMs }), null, JSON.stringify(codigo));
    }
  });

  test('código errado é null', () => {
    const segredo = crypto.randomBytes(20);
    const instanteMs = 1_900_000_015_000;
    const atual = Math.floor(instanteMs / PERIODO_MS);
    const validos = new Set([-1, 0, 1].map((d) => hotpReferencia(segredo, atual + d)));
    const errado = ['000000', '123456', '999999'].find((c) => !validos.has(c));
    assert.equal(totp.validarCodigo({ segredo, codigo: errado, instanteMs }), null);
  });

  test('o instante é obrigatório e explícito: sem ele é erro de programação, e Date.now nunca é consultado', (t) => {
    const segredo = crypto.randomBytes(20);
    t.mock.method(Date, 'now', () => { throw new Error('Date.now não pode decidir a autenticação'); });
    for (const instanteMs of [undefined, null, NaN, -1, 1.5, '1900000015000', Infinity]) {
      assert.throws(() => totp.validarCodigo({ segredo, codigo: '123456', instanteMs }), TypeError, String(instanteMs));
    }
    const instanteMs = 1_900_000_015_000;
    const codigo = hotpReferencia(segredo, Math.floor(instanteMs / PERIODO_MS));
    assert.deepEqual(totp.validarCodigo({ segredo, codigo, instanteMs }), { step: Math.floor(instanteMs / PERIODO_MS) });
  });

  test('secret fora do contrato é erro de programação', () => {
    for (const segredo of [crypto.randomBytes(19), crypto.randomBytes(21), 'x'.repeat(20), null]) {
      assert.throws(() => totp.validarCodigo({ segredo, codigo: '123456', instanteMs: 0 }), TypeError);
    }
  });

  test('o resultado é um objeto simples, só com step: nada da biblioteca escapa', () => {
    const segredo = crypto.randomBytes(20);
    const instanteMs = 1_900_000_015_000;
    const r = totp.validarCodigo({ segredo, codigo: hotpReferencia(segredo, Math.floor(instanteMs / PERIODO_MS)), instanteMs });
    assert.equal(Object.getPrototypeOf(r), Object.prototype);
    assert.deepEqual(Object.keys(r), ['step']);
  });

  test('sem estado: o mesmo código continua válido em chamadas seguidas (o anti-replay é da persistência)', () => {
    const segredo = crypto.randomBytes(20);
    const instanteMs = 1_900_000_015_000;
    const codigo = hotpReferencia(segredo, Math.floor(instanteMs / PERIODO_MS));
    const a = totp.validarCodigo({ segredo, codigo, instanteMs });
    const b = totp.validarCodigo({ segredo, codigo, instanteMs });
    assert.deepEqual(a, b);
  });
});

describe('gerarSegredo, URI de cadastro e chave manual', () => {
  test('gerarSegredo: 20 bytes aleatórios, diferentes a cada chamada', () => {
    const a = totp.gerarSegredo();
    const b = totp.gerarSegredo();
    assert.ok(Buffer.isBuffer(a));
    assert.equal(a.length, 20);
    assert.notDeepEqual(a, b);
  });

  test('URI otpauth://totp com issuer SafeWork, rótulo = e-mail, SHA1, 6 dígitos, 30 s e o secret em Base32', () => {
    const segredo = crypto.randomBytes(20);
    const email = 'admin.plataforma@safeworkengenharia.com.br';
    const uri = totp.montarUriCadastro({ segredo, email });
    const url = new URL(uri);
    assert.equal(url.protocol, 'otpauth:');
    assert.equal(url.host, 'totp');
    assert.equal(decodeURIComponent(url.pathname.slice(1)), `SafeWork:${email}`);
    assert.equal(url.searchParams.get('issuer'), 'SafeWork');
    assert.equal(url.searchParams.get('algorithm'), 'SHA1');
    assert.equal(url.searchParams.get('digits'), '6');
    assert.equal(url.searchParams.get('period'), '30');
    assert.deepEqual(base32Decodificar(url.searchParams.get('secret')), segredo);
  });

  test('URI recusa e-mail ausente ou com caracteres de controle', () => {
    const segredo = crypto.randomBytes(20);
    for (const email of ['', '   ', null, 'a@b.com\nX', 'a@b.com\u0000']) {
      assert.throws(() => totp.montarUriCadastro({ segredo, email }), TypeError, JSON.stringify(email));
    }
  });

  test('chave manual: Base32 RFC 4648 sem padding, em grupos de 4, que decodifica para o secret', () => {
    const segredo = crypto.randomBytes(20);
    const chave = totp.chaveManual(segredo);
    assert.match(chave, /^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/);
    assert.deepEqual(base32Decodificar(chave.replace(/ /g, '')), segredo);
  });
});

describe('encapsulamento da biblioteca', () => {
  test('nenhum módulo de src/ além de security/totp.js importa otpauth', () => {
    const raiz = path.join(__dirname, '..', '..', 'src');
    const usos = [];
    const percorrer = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) percorrer(abs);
        else if (e.name.endsWith('.js') && /(require\(|from\s+|import\()\s*['"]otpauth(\/[^'"]*)?['"]/.test(fs.readFileSync(abs, 'utf8'))) {
          usos.push(path.relative(raiz, abs).split(path.sep).join('/'));
        }
      }
    };
    percorrer(raiz);
    assert.deepEqual(usos, ['security/totp.js']);
  });
});
