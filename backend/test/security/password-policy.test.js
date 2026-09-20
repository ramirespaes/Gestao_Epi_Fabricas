'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { validarPoliticaSenha, POLITICA_SENHA, CODIGOS_POLITICA_SENHA: C } = require('../../src/security/password-policy');
const { assertSemSensiveis } = require('../helpers/sensiveis');

const codigos = (senha, contexto) => validarPoliticaSenha(senha, contexto).erros.map((e) => e.codigo);
const aceita = (senha, contexto) => assert.deepEqual(validarPoliticaSenha(senha, contexto), { ok: true, erros: [] }, JSON.stringify(codigos(senha, contexto)));
const rejeitaCom = (senha, codigo, contexto) => assert.ok(codigos(senha, contexto).includes(codigo), `${codigo} esperado, obtido ${codigos(senha, contexto)}`);
const naoTem = (senha, codigo, contexto) => assert.equal(codigos(senha, contexto).includes(codigo), false, `${codigo} inesperado`);

describe('política de senha', () => {
  test('constantes e códigos', () => {
    assert.deepEqual(POLITICA_SENHA, { tamanhoMinimo: 12, tamanhoMaximo: 128, caracteresDistintosMinimo: 4 });
    assert.equal(Object.keys(C).length, 7);
    assert.equal('SENHA_SOMENTE_DIGITOS' in C, false);
  });

  test('aceita senhas válidas, inclusive só numéricas e com espaços nas pontas', () => {
    aceita('Frase Com Espacos e Caixa 2026');
    aceita('xK9#pL2$mQ7v');
    aceita('a1b2c3d4e5f6'.repeat(10) + 'zzzzzzzy');
    aceita('  espacos nas pontas ficam  ');
    aceita('🔒🔑🛡️🚀🌟💡🎯🧩🪄🧭⚙️🔧');
    aceita('Epidemia forte 9');
    aceita('202609152026');
    aceita('4917305862190');
  });

  test('tamanho em code points após NFC', () => {
    rejeitaCom('abcdefghij1', C.SENHA_CURTA);
    aceita('coraçãozin1'.normalize('NFD') + 'x');
    assert.equal(Array.from('coraçãozin1x'.normalize('NFD')).length, 14);
    rejeitaCom('coraçãozin'.normalize('NFD') + '1', C.SENHA_CURTA);
    rejeitaCom('Xy7'.repeat(43), C.SENHA_LONGA);
    naoTem('Xy7'.repeat(42) + 'Zq', C.SENHA_LONGA);
    rejeitaCom('20260915', C.SENHA_CURTA);
  });

  test('NFD e NFC produzem o mesmo resultado', () => {
    for (const s of ['Coração forte 123', 'Ação e reação 2026', 'Ñandú voa alto 7', 'Épico Ímpar Ótimo', 'senha', 'abcdefghijkl']) {
      assert.deepEqual(validarPoliticaSenha(s.normalize('NFD')), validarPoliticaSenha(s.normalize('NFC')));
    }
  });

  test('caracteres de controle e diversidade', () => {
    rejeitaCom('Senha boa\tcom tab', C.SENHA_CARACTERE_INVALIDO);
    rejeitaCom('Quebra de linha\nno meio 1', C.SENHA_CARACTERE_INVALIDO);
    naoTem('Espaco comum eh permitido', C.SENHA_CARACTERE_INVALIDO);
    for (const s of ['aaaaaaaaaaaa', 'abababababab', 'abcabcabcabc', '111111111111', '121212121212']) {
      rejeitaCom(s, C.SENHA_POUCOS_CARACTERES_DISTINTOS);
    }
    naoTem('abcdabcdabcd', C.SENHA_POUCOS_CARACTERES_DISTINTOS);
    naoTem('abcdabcdabcd', C.SENHA_TRIVIAL);
  });

  test('sequências, inclusive circulares de dígitos, e termos triviais', () => {
    for (const s of ['123456789012', '210987654321', '890123456789', 'abcdefghijkl', 'lkjihgfedcba', 'MinhaSenha2026!', 'Password!2026x', 'qwertyuiop12', '1q2w3e4r5t6y', 'Administrador#7', 'GestaoEPI@2026', 'Welcome2026!!']) {
      rejeitaCom(s, C.SENHA_TRIVIAL);
    }
    naoTem('123456789021', C.SENHA_TRIVIAL);
    naoTem('abcdefghijkm', C.SENHA_TRIVIAL);
    naoTem('Epidemia forte 9', C.SENHA_TRIVIAL);
  });

  test('relação com o e-mail sem falsos positivos excessivos', () => {
    const email = 'Joao.Silva@Empresa.com.br';
    rejeitaCom('joao.silva@empresa.com.br!', C.SENHA_CONTEM_EMAIL, { email });
    rejeitaCom('XxJOAO.SILVAxx2026', C.SENHA_CONTEM_EMAIL, { email });
    rejeitaCom('Silva Forte 2026!', C.SENHA_CONTEM_EMAIL, { email });
    rejeitaCom('Empresa@2026!!', C.SENHA_CONTEM_EMAIL, { email });
    naoTem('Joao Forte 2026!!', C.SENHA_CONTEM_EMAIL, { email });
    naoTem('com br compartilhado 9', C.SENHA_CONTEM_EMAIL, { email });
    naoTem('Ana Uol Forte 2026!', C.SENHA_CONTEM_EMAIL, { email: 'ana@uol.com.br' });
    rejeitaCom('meu ana@uol.com.br 12', C.SENHA_CONTEM_EMAIL, { email: 'ana@uol.com.br' });
    naoTem('Frase Com Espacos e Caixa 2026', C.SENHA_CONTEM_EMAIL);
  });

  test('relação com CNPJ numérico e alfanumérico', () => {
    rejeitaCom('x12345678x2026!', C.SENHA_CONTEM_CNPJ, { cnpj: '12.345.678/0001-95' });
    rejeitaCom('12345678000195abc', C.SENHA_CONTEM_CNPJ, { cnpj: '12345678000195' });
    rejeitaCom('12.345.678/0001-95!!', C.SENHA_CONTEM_CNPJ, { cnpj: '12345678000195' });
    rejeitaCom('Zz00000000e08g12', C.SENHA_CONTEM_CNPJ, { cnpj: '00.000.000/E08G-12' });
    rejeitaCom('00.000.000/e08g-12x', C.SENHA_CONTEM_CNPJ, { cnpj: '00000000e08g12' });
    rejeitaCom('abc00000000xyz!', C.SENHA_CONTEM_CNPJ, { cnpj: '00000000E08G12' });
    rejeitaCom('12345678000195', C.SENHA_CONTEM_CNPJ, { cnpj: '12.345.678/0001-95' });
    naoTem('Frase Com Espacos e Caixa 2026', C.SENHA_CONTEM_CNPJ, { cnpj: '12345678000195' });
    naoTem('1234567 forte 2026!', C.SENHA_CONTEM_CNPJ, { cnpj: '12345678000195' });
  });

  test('devolve todos os erros aplicáveis de uma vez', () => {
    assert.deepEqual(codigos('senha'), [C.SENHA_CURTA, C.SENHA_TRIVIAL]);
    assert.deepEqual(codigos('aaa'), [C.SENHA_CURTA, C.SENHA_POUCOS_CARACTERES_DISTINTOS]);
    assert.deepEqual(codigos('12345678', { cnpj: '12345678000195' }), [C.SENHA_CURTA, C.SENHA_TRIVIAL, C.SENHA_CONTEM_CNPJ]);
  });

  test('TypeError fixo para senha não string e contexto não normalizável', () => {
    const semValor = (fn, valor) => assert.throws(fn, (e) => e instanceof TypeError && !e.message.includes(valor));
    semValor(() => validarPoliticaSenha(12345678), '1234');
    semValor(() => validarPoliticaSenha(null), 'null');
    semValor(() => validarPoliticaSenha('Frase Com Espacos e Caixa 2026', null), 'Frase');
    semValor(() => validarPoliticaSenha('Frase Com Espacos e Caixa 2026', { email: 'nao-e-email' }), 'nao-e-email');
    semValor(() => validarPoliticaSenha('Frase Com Espacos e Caixa 2026', { email: 'josé@x.com' }), 'josé');
    semValor(() => validarPoliticaSenha('Frase Com Espacos e Caixa 2026', { cnpj: '123' }), '123');
    semValor(() => validarPoliticaSenha('Frase Com Espacos e Caixa 2026', { cnpj: '00000000E08GA2' }), 'E08GA2');
    aceita('Frase Com Espacos e Caixa 2026', { email: undefined, cnpj: null });
  });

  test('mensagens nunca contêm senha, e-mail ou CNPJ', () => {
    const resultado = validarPoliticaSenha('joao.silva@empresa.com.br12345678000195', { email: 'Joao.Silva@Empresa.com.br', cnpj: '12345678000195' });
    assert.equal(resultado.ok, false);
    for (const erro of resultado.erros) {
      assertSemSensiveis(erro.mensagem, ['joao', '12345678', 'empresa.com'], erro.codigo);
    }
  });
});
