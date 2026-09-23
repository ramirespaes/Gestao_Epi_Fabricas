'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const c = require('../../src/schemas/campos.schema');
const { assertSemSensiveis } = require('../helpers/sensiveis');

// Contrato público: sucesso com valor transformado, ou primeira issue com
// code/params.codigo. Nada aqui inspeciona a issue além disso.
const aceita = (schema, entrada, saida) => {
  const r = schema.safeParse(entrada);
  assert.equal(r.success, true, `esperado sucesso para ${JSON.stringify(entrada)}`);
  assert.deepEqual(r.data, saida);
};
const rejeita = (schema, entrada, codigo) => {
  const r = schema.safeParse(entrada);
  assert.equal(r.success, false, `esperado rejeição para ${JSON.stringify(entrada)}`);
  const issue = r.error.issues[0];
  if (codigo === 'invalid_type' || codigo === 'invalid_value') {
    assert.equal(issue.code, codigo);
  } else {
    assert.equal(issue.code, 'custom');
    assert.equal(issue.params.codigo, codigo);
  }
  if (typeof entrada === 'string' && entrada.length >= 3) {
    assertSemSensiveis(issue.message, [entrada], 'mensagem');
  }
  assert.equal('input' in issue, false);
};

describe('exports e limites', () => {
  test('API pública e limites técnicos', () => {
    // cpf, cpfComDigitosVerificadores e dataCalendario: Bloco 9, Etapa B.
    assert.deepEqual(Object.keys(c).sort(), ['LIMITES', 'booleanoQuery', 'cnpj', 'cnpjComDigitosVerificadores', 'codigoCatalogo', 'cpf', 'cpfComDigitosVerificadores', 'dataCalendario', 'email', 'idCorpo', 'idParametro', 'inteiroQuery', 'paginacaoQuery', 'senhaEntrada', 'textoCurto'].sort());
    assert.deepEqual(c.LIMITES, {
      CNPJ_ENTRADA_MAXIMO: 32, CPF_ENTRADA_MAXIMO: 32, EMAIL_ENTRADA_MAXIMO: 200, SENHA_ENTRADA_MAXIMO: 1024, ID_MAXIMO: 2147483647,
      // INTEGER_MAXIMO acrescentado no Bloco 9, Etapa A (correção pós-auditoria de 23/09/2026):
      // mesmo teto de ID_MAXIMO, usado por prazoUsoDias/estoqueMinimo/quantidade (colunas INTEGER).
      INTEGER_MAXIMO: 2147483647,
      PAGINA_MAXIMA: 10000, LIMITE_MAXIMO: 100, LIMITE_PADRAO: 20,
    });
  });
});

describe('cnpj estrutural', () => {
  test('numérico e alfanumérico, com e sem máscara, minúsculas para maiúsculas', () => {
    aceita(c.cnpj, '12.345.678/0001-95', '12345678000195');
    aceita(c.cnpj, '12345678000195', '12345678000195');
    aceita(c.cnpj, '00.000.000/E08G-12', '00000000E08G12');
    aceita(c.cnpj, '00000000e08g12', '00000000E08G12');
    aceita(c.cnpj, '  12345678000195 ', '12345678000195');
  });

  test('DV inválido passa no estrutural', () => {
    aceita(c.cnpj, '12345678000196', '12345678000196');
  });

  test('rejeições estruturais e de tipo', () => {
    for (const ruim of ['12 345 678 0001 95', '00000000E08GA2', '1234567800019', '123456780001951', '1'.repeat(33), '', '12.345.678/0001-95!']) {
      rejeita(c.cnpj, ruim, 'CNPJ_INVALIDO');
    }
    rejeita(c.cnpj, 12345678000195, 'invalid_type');
    rejeita(c.cnpj, null, 'invalid_type');
  });
});

describe('cnpjComDigitosVerificadores', () => {
  test('validação separada dos dígitos verificadores', () => {
    aceita(c.cnpjComDigitosVerificadores, '12.345.678/0001-95', '12345678000195');
    aceita(c.cnpjComDigitosVerificadores, '00.000.000/e08g-12', '00000000E08G12');
    rejeita(c.cnpjComDigitosVerificadores, '12345678000196', 'CNPJ_DV_INVALIDO');
    rejeita(c.cnpjComDigitosVerificadores, '00000000E08G13', 'CNPJ_DV_INVALIDO');
    rejeita(c.cnpjComDigitosVerificadores, '123', 'CNPJ_INVALIDO');
  });
});

describe('email', () => {
  test('trim e minúsculas; limite do banco', () => {
    aceita(c.email, '  Luis@Empresa.COM ', 'luis@empresa.com');
    aceita(c.email, 'a.b-c_d+tag@Sub.Dominio.com.br', 'a.b-c_d+tag@sub.dominio.com.br');
    aceita(c.email, 'a'.repeat(138) + '@empresa.com', 'a'.repeat(138) + '@empresa.com');
  });

  test('rejeita não ASCII, formato inválido, tamanho e tipo', () => {
    for (const ruim of ['semarroba.com', 'josé@x.com', 'lu is@x.com', 'a'.repeat(139) + '@empresa.com', 'a'.repeat(190) + '@empresa.com', '', 'a@b']) {
      rejeita(c.email, ruim, 'EMAIL_INVALIDO');
    }
    rejeita(c.email, 42, 'invalid_type');
  });
});

describe('senhaEntrada', () => {
  test('preserva espaços, caixa e NFD; só proteção técnica', () => {
    aceita(c.senhaEntrada, '  Senha Com Espacos  ', '  Senha Com Espacos  ');
    const nfd = 'Coração'.normalize('NFD');
    aceita(c.senhaEntrada, nfd, nfd);
    assert.notEqual(c.senhaEntrada.parse(nfd), nfd.normalize('NFC'));
    aceita(c.senhaEntrada, 'MAIÚSCULAS', 'MAIÚSCULAS');
    aceita(c.senhaEntrada, 'a', 'a');
  });

  test('limite técnico de 1024 unidades UTF-16 e vazio', () => {
    aceita(c.senhaEntrada, 'x'.repeat(1024), 'x'.repeat(1024));
    aceita(c.senhaEntrada, '🔒'.repeat(512), '🔒'.repeat(512));
    rejeita(c.senhaEntrada, 'x'.repeat(1025), 'SENHA_MUITO_LONGA');
    rejeita(c.senhaEntrada, '', 'SENHA_VAZIA');
    rejeita(c.senhaEntrada, 12345, 'invalid_type');
  });
});

describe('idParametro', () => {
  test('aceita somente string decimal canônica positiva e devolve Number', () => {
    const r = c.idParametro.safeParse('1');
    assert.equal(r.success, true);
    assert.strictEqual(r.data, 1);
    aceita(c.idParametro, '42', 42);
    aceita(c.idParametro, '2147483647', 2147483647);
  });

  test('rejeita número, zero à esquerda, expoente e demais formatos ambíguos', () => {
    assert.equal(c.idParametro.safeParse(1).success, false);
    assert.equal(c.idParametro.safeParse('007').success, false);
    assert.equal(c.idParametro.safeParse('1e3').success, false);
    for (const ruim of ['0', '007', '-1', '+1', '1.5', '1e3', '0x10', '', '2147483648', ' 1', '1 ', 'NaN', 'abc', '١٢', '12345678901']) {
      rejeita(c.idParametro, ruim, 'ID_INVALIDO');
    }
    rejeita(c.idParametro, 1, 'invalid_type');
    rejeita(c.idParametro, null, 'invalid_type');
  });
});

describe('idCorpo', () => {
  test('aceita somente número inteiro positivo dentro do teto de int4, sem transformar o valor', () => {
    aceita(c.idCorpo, 1, 1);
    aceita(c.idCorpo, 42, 42);
    aceita(c.idCorpo, 2147483647, 2147483647);
  });

  test('rejeita zero, negativo, não inteiro e acima do teto com ID_INVALIDO; tipo errado (inclusive NaN/Infinity) com invalid_type', () => {
    for (const ruim of [0, -1, 1.5, 2147483648]) {
      rejeita(c.idCorpo, ruim, 'ID_INVALIDO');
    }
    // NaN e Infinity já são recusados pelo z.number() de base, antes do
    // transform: nunca chegam à regra ID_INVALIDO.
    for (const ruim of ['1', null, true, NaN, Infinity]) {
      rejeita(c.idCorpo, ruim, 'invalid_type');
    }
  });
});

describe('inteiroQuery e paginacaoQuery', () => {
  const iq = c.inteiroQuery(1, 100);

  test('decimal canônico dentro do intervalo', () => {
    aceita(iq, '1', 1);
    aceita(iq, '100', 100);
    aceita(iq, '50', 50);
    aceita(c.inteiroQuery(0, 10), '0', 0);
  });

  test('rejeições por formato e intervalo', () => {
    for (const ruim of ['', '007', '3.5', '1e2', '0x10', '-1', '+1', ' 1', 'abc', '99999999999']) {
      rejeita(iq, ruim, 'INTEIRO_INVALIDO');
    }
    for (const fora of ['0', '101']) {
      rejeita(iq, fora, 'FORA_DO_INTERVALO');
    }
    rejeita(iq, 5, 'invalid_type');
  });

  test('paginação com padrões e limites dentro de objeto estrito', () => {
    const pag = z.strictObject(c.paginacaoQuery);
    aceita(pag, {}, { pagina: 1, limite: 20 });
    aceita(pag, { pagina: '3', limite: '100' }, { pagina: 3, limite: 100 });
    assert.equal(pag.safeParse({ pagina: '10001' }).error.issues[0].params.codigo, 'FORA_DO_INTERVALO');
    assert.equal(pag.safeParse({ limite: '0' }).error.issues[0].params.codigo, 'FORA_DO_INTERVALO');
    assert.equal(pag.safeParse({ pagina: '' }).error.issues[0].params.codigo, 'INTEIRO_INVALIDO');
    assert.equal(pag.safeParse({ limte: '20' }).error.issues[0].code, 'unrecognized_keys');
    assert.equal(Object.isFrozen(c.paginacaoQuery), true);
  });
});

describe('booleanoQuery', () => {
  test('somente "true" e "false"', () => {
    aceita(c.booleanoQuery, 'true', true);
    aceita(c.booleanoQuery, 'false', false);
    for (const ruim of ['True', '1', 'sim', '', 'yes']) {
      rejeita(c.booleanoQuery, ruim, 'invalid_value');
    }
    rejeita(c.booleanoQuery, true, 'invalid_value');
  });
});

describe('textoCurto', () => {
  const nome = c.textoCurto(150, 'NOME_INVALIDO', 'Nome inválido');

  test('trim, NFC e contagem em code points', () => {
    aceita(nome, '  João da Silva  ', 'João da Silva');
    aceita(nome, 'João'.normalize('NFD'), 'João'.normalize('NFC'));
    aceita(nome, 'ç'.normalize('NFD').repeat(150), 'ç'.normalize('NFC').repeat(150));
    aceita(nome, 'Ana Maria', 'Ana Maria');
  });

  test('rejeita tamanho, controle, vazio e tipo', () => {
    for (const ruim of ['a'.repeat(151), 'a\tb', 'a\nb', '   ', '']) {
      rejeita(nome, ruim, 'NOME_INVALIDO');
    }
    rejeita(nome, 7, 'invalid_type');
  });
});

describe('codigoCatalogo', () => {
  const perfil = c.codigoCatalogo(20, 'PERFIL_INVALIDO', 'Perfil inválido');

  test('formato estrito em maiúsculas até o tamanho do catálogo', () => {
    for (const valido of ['MASTER', 'ADMINISTRADOR', 'A_1', 'A', 'A'.repeat(20)]) {
      aceita(perfil, valido, valido);
    }
    for (const ruim of ['master', '_X', 'A'.repeat(21), '', 'A-B', 'A B', '1A']) {
      rejeita(perfil, ruim, 'PERFIL_INVALIDO');
    }
    rejeita(perfil, 5, 'invalid_type');
  });
});

describe('mensagens', () => {
  test('nunca contêm o valor recebido', () => {
    const valor = 'VALOR_SENSIVEL_XYZ_123';
    const mensagens = [c.cnpj, c.email, c.idParametro, c.inteiroQuery(1, 100), c.codigoCatalogo(20, 'PERFIL_INVALIDO', 'Perfil inválido')]
      .map((schema) => schema.safeParse(valor).error.issues[0].message);
    assert.equal(mensagens.length, 5);
    for (const mensagem of mensagens) {
      assertSemSensiveis(mensagem, ['VALOR_SENSIVEL'], 'mensagem');
    }
  });
});
