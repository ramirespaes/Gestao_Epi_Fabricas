'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { lerPlanoAprovado, MAX_BYTES, MAX_PACOTES } = require('../../src/utils/plano-pacotes-padrao');

/** Plano dos pacotes aprovados da biblioteca padrão: o hash do PRÓPRIO plano vem de fora dele e a leitura é estrita. */

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const pacote = (extra = {}) => ({ arquivo: 'Pacote_A.zip', sha256: HASH_A, quantidade: 30, ...extra });
const plano = (extra = {}) => ({ versao: 1, pacotes: [pacote()], ...extra });
const bytesDe = (objeto) => Buffer.from(typeof objeto === 'string' ? objeto : JSON.stringify(objeto), 'utf8');
const ler = (objeto) => { const bytes = bytesDe(objeto); return lerPlanoAprovado(bytes, sha(bytes)); };

function recusa(funcao, codigo, motivo = null) {
  assert.throws(funcao, (erro) => {
    assert.equal(erro.codigo, codigo);
    if (motivo !== null) assert.ok(erro.detalhes.some((d) => d.motivo === motivo), JSON.stringify(erro.detalhes));
    assert.doesNotMatch(erro.message, /[0-9a-f]{64}/, 'a mensagem vaza um hash');
    return true;
  });
}

describe('plano de pacotes aprovados', () => {
  test('lê um plano válido com um ou mais pacotes e devolve o hash do plano', () => {
    const um = ler(plano());
    assert.deepEqual(um.pacotes, [pacote()]);
    assert.match(um.sha256, /^[0-9a-f]{64}$/);
    const dois = ler(plano({ pacotes: [pacote(), pacote({ arquivo: 'Pacote_B.zip', sha256: HASH_B, quantidade: 1 })] }));
    assert.deepEqual(dois.pacotes.map((p) => p.quantidade), [30, 1]);
  });

  test('o hash do plano é conferido contra o valor aprovado de fora: um plano adulterado ou outro hash é recusado', () => {
    const bytes = bytesDe(plano());
    assert.doesNotThrow(() => lerPlanoAprovado(bytes, sha(bytes)));
    recusa(() => lerPlanoAprovado(bytes, 'f'.repeat(64)), 'PLANO_SHA256_DIVERGENTE', 'SHA256');
    const adulterado = bytesDe(plano({ pacotes: [pacote({ sha256: HASH_B })] }));
    recusa(() => lerPlanoAprovado(adulterado, sha(bytes)), 'PLANO_SHA256_DIVERGENTE');
  });

  test('o hash aprovado é conferido ANTES de interpretar o conteúdo: JSON inválido com hash errado é divergência de hash', () => {
    recusa(() => lerPlanoAprovado(bytesDe('{'), 'f'.repeat(64)), 'PLANO_SHA256_DIVERGENTE');
  });

  test('argumentos que não são bytes e hash minúsculo de 64 hexadecimais são recusados', () => {
    const bytes = bytesDe(plano());
    for (const hash of [undefined, null, '', 'abc', sha(bytes).toUpperCase(), 'g'.repeat(64), 42]) recusa(() => lerPlanoAprovado(bytes, hash), 'PACOTE_ARGUMENTOS_INVALIDOS');
    for (const invalido of [undefined, null, 'texto', {}, []]) recusa(() => lerPlanoAprovado(invalido, sha(bytes)), 'PACOTE_ARGUMENTOS_INVALIDOS');
  });

  test('vazio, grande demais, não-JSON e UTF-8 inválido são recusados', () => {
    recusa(() => lerPlanoAprovado(Buffer.alloc(0), sha(Buffer.alloc(0))), 'PLANO_INVALIDO', 'TAMANHO_INVALIDO');
    const enorme = Buffer.alloc(MAX_BYTES + 1, 0x20);
    recusa(() => lerPlanoAprovado(enorme, sha(enorme)), 'PLANO_INVALIDO', 'TAMANHO_INVALIDO');
    recusa(() => ler('{ não é json'), 'PLANO_INVALIDO', 'JSON_INVALIDO');
    const utf8Ruim = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    recusa(() => lerPlanoAprovado(utf8Ruim, sha(utf8Ruim)), 'PLANO_INVALIDO', 'JSON_INVALIDO');
  });

  test('chaves do plano e do pacote são exatas: faltando, a mais e tipos errados são recusados', () => {
    recusa(() => ler([]), 'PLANO_INVALIDO', 'CHAVES_DIFERENTES');
    recusa(() => ler('null'), 'PLANO_INVALIDO', 'CHAVES_DIFERENTES');
    recusa(() => ler({ versao: 1 }), 'PLANO_INVALIDO', 'CHAVES_DIFERENTES');
    recusa(() => ler({ versao: 1, pacotes: [pacote()], extra: true }), 'PLANO_INVALIDO', 'CHAVES_DIFERENTES');
    recusa(() => ler(plano({ pacotes: [{ arquivo: 'Pacote_A.zip', sha256: HASH_A }] })), 'PLANO_INVALIDO', 'CHAVES_DIFERENTES');
    recusa(() => ler(plano({ pacotes: [{ ...pacote(), caminho: '/etc' }] })), 'PLANO_INVALIDO', 'CHAVES_DIFERENTES');
    recusa(() => ler(plano({ pacotes: ['Pacote_A.zip'] })), 'PLANO_INVALIDO', 'CHAVES_DIFERENTES');
  });

  test('versão desconhecida e lista de pacotes vazia, ausente ou grande demais são recusadas', () => {
    recusa(() => ler(plano({ versao: 2 })), 'PLANO_INVALIDO', 'VERSAO_NAO_SUPORTADA');
    recusa(() => ler(plano({ versao: '1' })), 'PLANO_INVALIDO', 'VERSAO_NAO_SUPORTADA');
    recusa(() => ler(plano({ pacotes: [] })), 'PLANO_INVALIDO', 'QUANTIDADE_INVALIDA');
    recusa(() => ler(plano({ pacotes: 'x' })), 'PLANO_INVALIDO', 'QUANTIDADE_INVALIDA');
    const muitos = Array.from({ length: MAX_PACOTES + 1 }, (_, k) => pacote({ arquivo: `P${k}.zip`, sha256: crypto.createHash('sha256').update(String(k)).digest('hex') }));
    recusa(() => ler(plano({ pacotes: muitos })), 'PLANO_INVALIDO', 'QUANTIDADE_INVALIDA');
  });

  test('nome do ZIP: só o nome de um arquivo .zip simples; caminho, "..", espaço e outra extensão são recusados', () => {
    for (const arquivo of ['/etc/pacote.zip', 'pasta/pacote.zip', '../pacote.zip', '..zip', 'a..b.zip', 'pacote.tar', 'pacote', ' pacote.zip', 'pa cote.zip', '.pacote.zip', '', 'pacote.zip\n', 7]) {
      recusa(() => ler(plano({ pacotes: [pacote({ arquivo })] })), 'PLANO_INVALIDO', 'NOME_INVALIDO');
    }
    assert.doesNotThrow(() => ler(plano({ pacotes: [pacote({ arquivo: 'SafeWork_Biblioteca_30_EPIs-v2.zip' })] })));
  });

  test('hash do pacote: 64 hexadecimais minúsculos; maiúsculas, curto e tipo errado são recusados', () => {
    for (const hash of [HASH_A.toUpperCase(), 'abc', '', null, 5, `${HASH_A}0`]) recusa(() => ler(plano({ pacotes: [pacote({ sha256: hash })] })), 'PLANO_INVALIDO', 'HASH_INVALIDO');
  });

  test('quantidade: inteiro de 1 a 30; zero, 31, fracionário, texto e nulo são recusados', () => {
    for (const quantidade of [0, 31, -1, 1.5, '30', null, Number.NaN]) recusa(() => ler(plano({ pacotes: [pacote({ quantidade })] })), 'PLANO_INVALIDO', 'QUANTIDADE_INVALIDA');
    for (const quantidade of [1, 30]) assert.doesNotThrow(() => ler(plano({ pacotes: [pacote({ quantidade })] })));
  });

  test('nome ou hash repetido em dois pacotes é recusado, com a posição e sem o valor', () => {
    recusa(() => ler(plano({ pacotes: [pacote(), pacote({ sha256: HASH_B })] })), 'PLANO_INVALIDO', 'NOME_REPETIDO');
    recusa(() => ler(plano({ pacotes: [pacote(), pacote({ arquivo: 'Outro.zip' })] })), 'PLANO_INVALIDO', 'HASH_REPETIDO');
    assert.throws(() => ler(plano({ pacotes: [pacote(), pacote({ arquivo: 'Outro.zip' })] })), (erro) => erro.detalhes[0].linha === 2 && erro.detalhes[0].campo === 'sha256');
  });

  test('o resultado devolve só os campos conhecidos de cada pacote', () => {
    const lido = ler(plano());
    assert.deepEqual(Object.keys(lido.pacotes[0]).sort(), ['arquivo', 'quantidade', 'sha256']);
  });
});
