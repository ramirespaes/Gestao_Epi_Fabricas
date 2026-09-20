'use strict';

const { describe, test, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const argon2 = require('argon2');
const { authConfig } = require('../../src/config/auth');
const pw = require('../../src/security/password');
const { assertSemSensiveis } = require('../helpers/sensiveis');

// Hashes Argon2 são caros: os fixos abaixo são gerados uma vez e
// reutilizados. Nada aqui mede tempo; o custo equalizado é verificado de
// forma estrutural (uma verificação com os mesmos parâmetros nos dois
// caminhos), estável em qualquer hardware ou carga de CI.
const SENHA = 'Minha Senha Com Espaços 2026';
const ARGON = { type: argon2.argon2id, parallelism: 1, hashLength: 32 };
const fixos = {};

before(async () => {
  fixos.atual = await pw.gerarHashSenha(SENHA);
  fixos.fraco = await argon2.hash(SENHA, { ...ARGON, memoryCost: 19456, timeCost: 2 });
  fixos.forte = await argon2.hash(SENHA, { ...ARGON, memoryCost: 131072, timeCost: 4 });
  fixos.p2 = await argon2.hash(SENHA, { ...ARGON, memoryCost: 65536, timeCost: 3, parallelism: 2 });
  fixos.len16 = await argon2.hash(SENHA, { ...ARGON, memoryCost: 65536, timeCost: 3, hashLength: 16 });
  fixos.argon2i = await argon2.hash(SENHA, { type: argon2.argon2i, memoryCost: 65536, timeCost: 3, parallelism: 1 });
});

const semHash = (texto, hash, rotulo) => assertSemSensiveis(texto, [hash.length > 40 ? hash.slice(10, 40) : hash], rotulo);

describe('hash fictício: inicialização única, concorrência e recuperação', () => {
  // Ordem deliberada: a falha simulada precisa ocorrer ANTES da primeira
  // preparação bem-sucedida deste processo.
  test('falha na geração rejeita e limpa o estado para nova tentativa', async () => {
    const hashOriginal = argon2.hash;
    mock.method(argon2, 'hash', async () => { throw new Error('falha simulada'); });
    try {
      await assert.rejects(() => pw.prepararHashFicticio(), /falha simulada/);
      await assert.rejects(() => pw.obterHashFicticio(), /falha simulada/);
    } finally {
      mock.restoreAll();
    }
    assert.equal(argon2.hash, hashOriginal);
  });

  test('chamadas concorrentes compartilham uma única geração', async () => {
    const contador = mock.method(argon2, 'hash');
    try {
      await Promise.all([pw.prepararHashFicticio(), pw.prepararHashFicticio(), pw.obterHashFicticio(), pw.verificarSenhaContraFicticio('qualquer senha')]);
      assert.equal(contador.mock.callCount(), 1);
    } finally {
      mock.restoreAll();
    }
    const f1 = await pw.obterHashFicticio();
    const f2 = await pw.obterHashFicticio();
    assert.equal(f1, f2);
    assert.match(f1, /^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    assert.equal(pw.precisaRehash(f1), false);
    assert.equal(await pw.prepararHashFicticio(), undefined);
  });

  test('verificação contra o fictício devolve sempre false', async () => {
    const ficticio = await pw.obterHashFicticio();
    for (const senha of [SENHA, 'qualquer coisa', 'a', ' ', ficticio]) {
      assert.equal(await pw.verificarSenhaContraFicticio(senha), false);
    }
  });

  test('custo equalizado: usuário existente e inexistente fazem uma verificação com os mesmos parâmetros', async () => {
    const verificar = mock.method(argon2, 'verify');
    try {
      await pw.verificarSenha(fixos.atual, 'senha errada 123');
      await pw.verificarSenhaContraFicticio('senha errada 123');
      assert.equal(verificar.mock.callCount(), 2);
      const parametros = verificar.mock.calls.map((c) => c.arguments[0].split('$')[3]);
      assert.equal(parametros[0], parametros[1]);
      assert.equal(parametros[0], 'm=65536,p=1,t=3');
    } finally {
      mock.restoreAll();
    }
  });
});

describe('gerarHashSenha e verificarSenha', () => {
  test('Argon2id com os parâmetros do projeto, salt aleatório, 97 caracteres', async () => {
    assert.match(fixos.atual, /^\$argon2id\$v=19\$/);
    assert.ok(fixos.atual.includes('m=65536') && fixos.atual.includes('t=3') && fixos.atual.includes('p=1'));
    assert.equal(fixos.atual.length, 97);
    assert.deepEqual(authConfig.argon2, { memoryKib: 65536, timeCost: 3, parallelism: 1, hashLength: 32 });
    const outro = await pw.gerarHashSenha(SENHA);
    assert.notEqual(outro, fixos.atual);
    assert.equal(await pw.verificarSenha(outro, SENHA), true);
    assert.equal(Buffer.from(outro.split('$')[5], 'base64').length, 32);
  });

  test('só a senha exata confere: caixa, espaços e trim importam', async () => {
    assert.equal(await pw.verificarSenha(fixos.atual, SENHA), true);
    assert.equal(await pw.verificarSenha(fixos.atual, 'Minha Senha Com Espaços 2027'), false);
    assert.equal(await pw.verificarSenha(fixos.atual, SENHA.toLowerCase()), false);
    assert.equal(await pw.verificarSenha(fixos.atual, SENHA + ' '), false);
    assert.equal(await pw.verificarSenha(fixos.atual, ' ' + SENHA), false);
  });

  test('NFC deliberado: NFD e NFC equivalem; NFKC não é aplicado', async () => {
    const nfc = 'Coração forte 123'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    assert.notEqual(nfc, nfd);
    const hash = await pw.gerarHashSenha(nfd);
    assert.equal(await pw.verificarSenha(hash, nfc), true);
    assert.equal(await pw.verificarSenha(hash, nfd), true);
    const ligadura = await pw.gerarHashSenha('ﬁm de semana 123');
    assert.equal(await pw.verificarSenha(ligadura, 'fim de semana 123'), false);
  });

  test('hashes legados válidos verificam; precisaRehash decide pelos parâmetros', async () => {
    assert.equal(await pw.verificarSenha(fixos.fraco, SENHA), true);
    assert.equal(pw.precisaRehash(fixos.fraco), true);
    assert.equal(pw.precisaRehash(fixos.atual), false);
    assert.equal(await pw.verificarSenha(fixos.forte, SENHA), true);
    assert.equal(pw.precisaRehash(fixos.forte), false);
    assert.equal(pw.precisaRehash(fixos.p2), true);
    assert.equal(await pw.verificarSenha(fixos.len16, SENHA), true);
    assert.equal(await pw.verificarSenha(fixos.len16, 'senha errada 123'), false);
    assert.equal(pw.precisaRehash(fixos.len16), true);
    assert.equal(pw.precisaRehash(fixos.argon2i), true);
    assert.equal(pw.precisaRehash('lixo'), true);
  });

  test('digest truncado ou alterado é indistinguível de senha errada: false, sem lançar', async () => {
    assert.equal(await pw.verificarSenha(fixos.atual.slice(0, -3) + 'zzz', SENHA), false);
    assert.equal(await pw.verificarSenha(fixos.atual.slice(0, 60), SENHA), false);
    assert.equal(pw.precisaRehash(fixos.atual.slice(0, 60)), true);
  });

  test('hashes malformados lançam HashSenhaCorrompidoError sem o hash na mensagem', async () => {
    const h = fixos.atual;
    const corrompidos = {
      argon2i: fixos.argon2i,
      semCifrao: 'nao-e-phc',
      base64Invalido: h.slice(0, -3) + '!!!',
      bcrypt: '$2b$10$abcdefghijklmnopqrstuv',
      versaoAntiga: h.replace('v=19', 'v=16'),
      paramRepetido: h.replace('m=65536', 'm=65536,m=1'),
      paramFaltando: h.replace(',t=3', ''),
      paramZero: h.replace('t=3', 't=0'),
      semSalt: '$argon2id$v=19$m=65536,t=3,p=1$$abc',
      seteSegmentos: h + '$x',
    };
    for (const [rotulo, ruim] of Object.entries(corrompidos)) {
      await assert.rejects(() => pw.verificarSenha(ruim, SENHA), (erro) => {
        assert.equal(erro instanceof pw.HashSenhaCorrompidoError, true, rotulo);
        assert.equal(erro.name, 'HashSenhaCorrompidoError');
        semHash(erro.message, ruim, rotulo);
        if (erro.cause) semHash(String(erro.cause.message), ruim, rotulo);
        return true;
      });
    }
    const saltCurto = h.split('$').map((parte, i) => (i === 4 ? 'abc' : parte)).join('$');
    await assert.rejects(() => pw.verificarSenha(saltCurto, SENHA), (erro) => {
      assert.ok(erro instanceof pw.HashSenhaCorrompidoError);
      assert.ok(erro.cause instanceof Error);
      semHash(String(erro.cause.message), h, 'salt curto');
      return true;
    });
  });

  test('tipos inválidos são rejeitados antes da biblioteca', async () => {
    for (const ruim of ['', null, undefined, 123, {}, []]) {
      await assert.rejects(() => pw.gerarHashSenha(ruim), TypeError);
      await assert.rejects(() => pw.verificarSenha(fixos.atual, ruim), TypeError);
      await assert.rejects(() => pw.verificarSenha(ruim, SENHA), TypeError);
      await assert.rejects(() => pw.verificarSenhaContraFicticio(ruim), TypeError);
      assert.throws(() => pw.precisaRehash(ruim), TypeError);
    }
  });
});
