'use strict';

// Detector de segredos fora do lugar usado pelos testes de integração do MFA (CI #204). A busca por substring no texto
// inteiro da tabela acusava, por acaso, um código TOTP de 6 dígitos dentro de um token_hash hexadecimal ou dos
// microssegundos de um timestamp gerado pelo banco. A exceção para segredos curtos vale só para colunas de tipo
// conhecido (timestamptz e digest de 64 hex conferido pelo schema) e só quando o valor tem exatamente esse formato;
// todo o resto, inclusive JSONB, texto livre e números, continua inspecionado por substring. Todos os valores aqui são
// sintéticos.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const detector = require('./helpers/segredos-em-linhas');

const { segredosEmLinhas } = detector;

const CODIGO = '482913';
const LONGO = 'f'.repeat(8) + '0123456789abcdef'.repeat(2);
const HASH_COM_CODIGO = `ab${CODIGO}${'c'.repeat(56)}`;
const TIMESTAMP_COM_CODIGO = `2026-11-24T00:51:49.${CODIGO}+00:00`;
const COLUNAS = { token_hash: 'digest_hex64', criado_em: 'timestamptz', expira_em: 'timestamptz', encerrado_em: 'timestamptz' };
const linhaDeDesafio = (extra = {}) => ({
  id: 7, administrador_id: 3, token_hash: 'a'.repeat(64), tipo: 'SUBSTITUICAO', fator_pendente_id: 2, sessao_origem_id: 5, sessao_criada_id: null,
  desafio_anterior_id: null, criado_em: '2026-11-24T00:51:49.5+00:00', expira_em: '2026-11-24T01:01:49.5+00:00', falhas: 0, reinicios: 0,
  encerrado_em: null, motivo_encerramento: null, ...extra,
});
const achar = (linhas, segredos = [CODIGO, LONGO], colunasGeradas = COLUNAS) => segredosEmLinhas({ linhas, segredos, colunasGeradas });

describe('o defeito do CI #204: a regra antiga por substring acusa coincidências', () => {
  test('caracterização: o texto inteiro da linha contém o código quando ele cai no hash ou nos microssegundos', () => {
    for (const linha of [linhaDeDesafio({ token_hash: HASH_COM_CODIGO }), linhaDeDesafio({ criado_em: TIMESTAMP_COM_CODIGO })]) {
      assert.equal(JSON.stringify(linha).includes(CODIGO), true);
    }
  });
});

describe('RED: coincidências em colunas de tipo conhecido não são vazamento', () => {
  test('código curto dentro de um token_hash (digest de 64 hex)', () => {
    assert.deepEqual(achar([linhaDeDesafio({ token_hash: HASH_COM_CODIGO })]), []);
  });
  test('código curto nos microssegundos de criado_em, expira_em ou encerrado_em', () => {
    for (const coluna of ['criado_em', 'expira_em', 'encerrado_em']) {
      assert.deepEqual(achar([linhaDeDesafio({ [coluna]: TIMESTAMP_COM_CODIGO })]), [], coluna);
    }
  });
  test('muitas linhas, todas com coincidências, nenhuma acusação', () => {
    const linhas = Array.from({ length: 50 }, (_, i) => linhaDeDesafio({ id: i + 1, token_hash: HASH_COM_CODIGO, encerrado_em: TIMESTAMP_COM_CODIGO }));
    assert.deepEqual(achar(linhas), []);
  });
});

describe('GREEN: vazamentos continuam detectados', () => {
  test('código curto como valor de uma coluna de texto', () => {
    assert.deepEqual(achar([linhaDeDesafio({ motivo_encerramento: CODIGO })]), [{ linha: 0, coluna: 'motivo_encerramento', indice: 0 }]);
  });
  test('código curto dentro de uma mensagem livre', () => {
    assert.deepEqual(achar([{ id: 1, mensagem: `codigo ${CODIGO} recusado` }]), [{ linha: 0, coluna: 'mensagem', indice: 0 }]);
  });
  test('código curto dentro de JSONB aninhado, em valor ou em chave', () => {
    assert.deepEqual(achar([{ id: 1, detalhes: { tentativa: { valor: `x${CODIGO}y` } } }]), [{ linha: 0, coluna: 'detalhes', indice: 0 }]);
    assert.deepEqual(achar([{ id: 1, detalhes: { [CODIGO]: true } }]), [{ linha: 0, coluna: 'detalhes', indice: 0 }]);
    assert.deepEqual(achar([{ id: 1, detalhes: [1, [CODIGO]] }]), [{ linha: 0, coluna: 'detalhes', indice: 0 }]);
  });
  test('código curto como valor numérico, solto ou dentro de JSONB', () => {
    assert.deepEqual(achar([{ id: 1, codigo: Number(CODIGO) }]), [{ linha: 0, coluna: 'codigo', indice: 0 }]);
    assert.deepEqual(achar([{ id: 1, detalhes: { n: Number(CODIGO) } }]), [{ linha: 0, coluna: 'detalhes', indice: 0 }]);
  });
  test('código curto num campo JSONB com o mesmo nome de uma coluna isenta não é isento', () => {
    assert.deepEqual(achar([{ id: 1, detalhes: { token_hash: HASH_COM_CODIGO, criado_em: TIMESTAMP_COM_CODIGO } }]), [{ linha: 0, coluna: 'detalhes', indice: 0 }]);
  });
  test('código curto numa coluna isenta cujo valor foge do formato do tipo é inspecionado', () => {
    for (const [coluna, valor] of [['token_hash', `${CODIGO}`], ['token_hash', `A${CODIGO}${'B'.repeat(57)}`], ['criado_em', `${CODIGO}`], ['criado_em', `amanhã ${CODIGO}`], ['criado_em', Number(CODIGO)]]) {
      assert.deepEqual(achar([linhaDeDesafio({ [coluna]: valor })]), [{ linha: 0, coluna, indice: 0 }], `${coluna}: ${typeof valor}`);
    }
  });
  test('coluna desconhecida é inspecionada por inteiro', () => {
    assert.deepEqual(achar([linhaDeDesafio({ coluna_nova: TIMESTAMP_COM_CODIGO })]), [{ linha: 0, coluna: 'coluna_nova', indice: 0 }]);
    assert.deepEqual(achar([linhaDeDesafio({ outro_hash: HASH_COM_CODIGO })]), [{ linha: 0, coluna: 'outro_hash', indice: 0 }]);
  });
  test('sem colunas declaradas, tudo é inspecionado por inteiro', () => {
    assert.deepEqual(achar([linhaDeDesafio({ token_hash: HASH_COM_CODIGO })], [CODIGO], {}), [{ linha: 0, coluna: 'token_hash', indice: 0 }]);
  });
  test('segredo longo é detectado em qualquer coluna, inclusive em hashes e timestamps', () => {
    const hashComLongo = `${LONGO}${'0'.repeat(64 - LONGO.length)}`;
    assert.equal(hashComLongo.length, 64);
    assert.deepEqual(achar([linhaDeDesafio({ token_hash: hashComLongo })]), [{ linha: 0, coluna: 'token_hash', indice: 1 }]);
    assert.deepEqual(achar([linhaDeDesafio({ criado_em: `2026-11-24T00:51:49+00:00${LONGO}` })]), [{ linha: 0, coluna: 'criado_em', indice: 1 }]);
    assert.deepEqual(achar([{ id: 1, uri: `otpauth://totp/x?secret=${LONGO}` }], ['otpauth://', LONGO], {}), [{ linha: 0, coluna: 'uri', indice: 0 }, { linha: 0, coluna: 'uri', indice: 1 }]);
  });
  test('um achado por linha, coluna e segredo, sem repetir; o resultado nunca traz o valor do segredo', () => {
    const r = achar([linhaDeDesafio({ motivo_encerramento: `${CODIGO}${CODIGO}` }), { id: 2, a: CODIGO, b: LONGO }]);
    assert.deepEqual(r, [{ linha: 0, coluna: 'motivo_encerramento', indice: 0 }, { linha: 1, coluna: 'a', indice: 0 }, { linha: 1, coluna: 'b', indice: 1 }]);
    assert.equal(JSON.stringify(r).includes(CODIGO) || JSON.stringify(r).includes(LONGO), false);
  });
});

// A1 (auditoria): o row_to_json chega como texto, e um JSON.parse comum arredonda números acima de 2^53 e escreve
// decimais pequenos em notação científica, apagando os dígitos de um código. O detector recebe o texto da linha e
// preserva o texto original de cada número.
describe('A1: números JSON com os dígitos originais', () => {
  const GRANDE = `12345678901234${CODIGO}`;
  const PEQUENO = `0.000000${CODIGO}`;
  test('caracterização: um JSON.parse comum perde os dígitos do código', () => {
    assert.equal(String(JSON.parse(GRANDE)).includes(CODIGO), false);
    assert.equal(String(JSON.parse(PEQUENO)).includes(CODIGO), false);
  });
  test('código dentro de um bigint acima de 2^53 numa coluna', () => {
    assert.deepEqual(achar([`{"id":${GRANDE},"tipo":"x"}`]), [{ linha: 0, coluna: 'id', indice: 0 }]);
  });
  test('código dentro de um decimal pequeno numa coluna', () => {
    assert.deepEqual(achar([`{"id":1,"valor":${PEQUENO}}`]), [{ linha: 0, coluna: 'valor', indice: 0 }]);
  });
  test('código dentro de números grandes e pequenos em JSONB aninhado, em objeto e em array', () => {
    assert.deepEqual(achar([`{"id":1,"detalhes":{"a":{"b":[1,${GRANDE}]}}}`]), [{ linha: 0, coluna: 'detalhes', indice: 0 }]);
    assert.deepEqual(achar([`{"id":1,"detalhes":[{"c":${PEQUENO}}]}`]), [{ linha: 0, coluna: 'detalhes', indice: 0 }]);
    assert.deepEqual(achar([`{"id":1,"detalhes":{"e":4.82913e21,"f":${CODIGO}e3}}`]), [{ linha: 0, coluna: 'detalhes', indice: 0 }]);
  });
  test('o texto da linha segue as mesmas regras: coincidências em colunas isentas não contam, números nunca são isentos', () => {
    assert.deepEqual(achar([JSON.stringify(linhaDeDesafio({ token_hash: HASH_COM_CODIGO, criado_em: TIMESTAMP_COM_CODIGO }))]), []);
    assert.deepEqual(achar([`{"criado_em":${CODIGO}}`]), [{ linha: 0, coluna: 'criado_em', indice: 0 }]);
    assert.deepEqual(achar([`{"motivo":"codigo ${CODIGO}"}`]), [{ linha: 0, coluna: 'motivo', indice: 0 }]);
  });
  test('texto que não é um objeto JSON é recusado', () => {
    for (const texto of ['[1]', '7', 'null', '{"a":', '']) assert.throws(() => achar([texto]), /linha/, texto);
  });
});

// A3 (auditoria): bordas das regras, para que mudar o limite, uma âncora ou a precisão faça algum teste falhar.
describe('A3: limite de 16 caracteres, âncoras e precisão', () => {
  const DE_15 = 'abcdef012345678';
  const DE_16 = 'abcdef0123456789';
  const hashCom = (trecho) => `${trecho}${'0'.repeat(64 - trecho.length)}`;
  test('o limite é 16: com 16 caracteres o segredo é longo e é procurado num hash; com 15, curto, fica isento', () => {
    assert.equal(detector.TAMANHO_DE_SEGREDO_LONGO, 16);
    assert.deepEqual(achar([linhaDeDesafio({ token_hash: hashCom(DE_16) })], [DE_16]), [{ linha: 0, coluna: 'token_hash', indice: 0 }]);
    assert.deepEqual(achar([linhaDeDesafio({ token_hash: hashCom(DE_15) })], [DE_15]), []);
  });
  test('o limite é 16 também nos timestamps', () => {
    assert.deepEqual(achar([linhaDeDesafio({ criado_em: TIMESTAMP_COM_CODIGO })], [TIMESTAMP_COM_CODIGO.slice(0, 16)]), [{ linha: 0, coluna: 'criado_em', indice: 0 }]);
    assert.deepEqual(achar([linhaDeDesafio({ criado_em: TIMESTAMP_COM_CODIGO })], [TIMESTAMP_COM_CODIGO.slice(0, 15)]), []);
  });
  test('âncoras do hash: 64 hex com qualquer caractere antes ou depois não é digest e é inspecionado', () => {
    for (const valor of [`x${HASH_COM_CODIGO}`, `${HASH_COM_CODIGO}x`, `${HASH_COM_CODIGO}0`, `0${HASH_COM_CODIGO}`, `${HASH_COM_CODIGO}\n`, ` ${HASH_COM_CODIGO}`]) {
      assert.deepEqual(achar([linhaDeDesafio({ token_hash: valor })]), [{ linha: 0, coluna: 'token_hash', indice: 0 }], JSON.stringify(valor.slice(0, 3)));
    }
  });
  test('âncoras do timestamp: com qualquer caractere antes ou depois não é timestamp e é inspecionado', () => {
    for (const valor of [`x${TIMESTAMP_COM_CODIGO}`, `${TIMESTAMP_COM_CODIGO}x`, `${TIMESTAMP_COM_CODIGO}\n`, ` ${TIMESTAMP_COM_CODIGO}`, `${CODIGO} ${TIMESTAMP_COM_CODIGO}`]) {
      assert.deepEqual(achar([linhaDeDesafio({ criado_em: valor })]), [{ linha: 0, coluna: 'criado_em', indice: 0 }], JSON.stringify(valor));
    }
  });
  test('precisão do timestamp: fração de 1 a 6 dígitos é timestamptz; de 7 em diante, ou vazia, não é', () => {
    const TRECHO = '00:51';
    for (const fracao of ['4', '48', '482', '4829', '48291', CODIGO]) {
      assert.deepEqual(achar([linhaDeDesafio({ criado_em: `2026-11-24T00:51:49.${fracao}+00:00` })], [TRECHO]), [], fracao);
    }
    for (const fracao of [`${CODIGO}1`, `${CODIGO}12`, `${CODIGO}123`, '']) {
      assert.deepEqual(achar([linhaDeDesafio({ criado_em: `2026-11-24T00:51:49.${fracao}+00:00` })], [TRECHO]), [{ linha: 0, coluna: 'criado_em', indice: 0 }], fracao || 'vazia');
    }
  });
});

describe('A3: reconhecimento do CHECK de digest de 64 hex do PostgreSQL', () => {
  const coluna = detector.colunaDoDigestHex64;
  test('as duas formas do pg_get_constraintdef devolvem a coluna', () => {
    assert.equal(coluna("CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))"), 'token_hash');
    assert.equal(coluna("CHECK (((codigo_hash)::text ~ '^[0-9a-f]{64}$'::text))"), 'codigo_hash');
    assert.equal(coluna("CHECK (((chave_cooldown)::bpchar ~ '^[0-9a-f]{64}$'::text))"), 'chave_cooldown');
  });
  test('qualquer outra forma não é reconhecida', () => {
    for (const d of [
      "CHECK ((token_hash ~ '^[0-9a-f]{32}$'::text))", "CHECK ((token_hash ~ '^[0-9a-f]{63}$'::text))", "CHECK ((token_hash ~ '[0-9a-f]{64}'::text))",
      "CHECK ((token_hash ~* '^[0-9a-f]{64}$'::text))", "CHECK ((token_hash ~ '^[0-9a-fA-F]{64}$'::text))", "CHECK ((falhas >= 0))",
      "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)) NOT VALID", "CHECK (((token_hash ~ '^[0-9a-f]{64}$'::text) OR (token_hash IS NULL)))",
      "CHECK ((NOT (token_hash ~ '^[0-9a-f]{64}$'::text)))", "CHECK ((lower(token_hash) ~ '^[0-9a-f]{64}$'::text))",
      "CHECK ((\"Token\" ~ '^[0-9a-f]{64}$'::text))", "CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))\n", ` CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))`,
      '', null, undefined, 7,
    ]) assert.equal(coluna(d), null, JSON.stringify(d));
  });
  test('parênteses desbalanceados não são reconhecidos, mesmo com o final válido', () => {
    for (const d of [
      "CHECK (token_hash ~ '^[0-9a-f]{64}$'::text))",
      "CHECK (((token_hash ~ '^[0-9a-f]{64}$'::text))",
      "CHECK ((((token_hash)::text ~ '^[0-9a-f]{64}$'::text))",
    ]) assert.equal(coluna(d), null, JSON.stringify(d));
  });
});

describe('entradas inválidas são recusadas', () => {
  test('segredo vazio, ausente ou não textual', () => {
    for (const segredos of [[''], [undefined], [null], [123456], 'x', undefined]) {
      assert.throws(() => segredosEmLinhas({ linhas: [], segredos, colunasGeradas: {} }), /segredo/, String(segredos));
    }
  });
  test('tipo de coluna desconhecido e linhas que não são objetos', () => {
    assert.throws(() => segredosEmLinhas({ linhas: [], segredos: [CODIGO], colunasGeradas: { x: 'texto' } }), /tipo/);
    assert.throws(() => segredosEmLinhas({ linhas: [7], segredos: [CODIGO], colunasGeradas: {} }), /linha/);
    assert.throws(() => segredosEmLinhas({ linhas: [[1]], segredos: [CODIGO], colunasGeradas: {} }), /linha/);
    assert.throws(() => segredosEmLinhas({ linhas: null, segredos: [CODIGO], colunasGeradas: {} }), /linha/);
  });
});
