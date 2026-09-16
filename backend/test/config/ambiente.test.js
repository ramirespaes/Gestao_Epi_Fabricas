'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const ambiente = require('../../src/config/ambiente');
const { assertSemSensiveis } = require('../helpers/sensiveis');

describe('somenteDefinidas', () => {
  test('mantém só strings não vazias, com trim; descarta vazias, espaços e não strings', () => {
    assert.deepEqual(ambiente.somenteDefinidas({ A: ' x ', B: '', C: '   ', D: undefined, E: 5, F: null, G: 'ok' }), { A: 'x', G: 'ok' });
    assert.deepEqual(ambiente.somenteDefinidas({}), {});
  });
});

describe('congelarProfundo', () => {
  test('congela objeto raiz, objetos aninhados e arrays, e devolve a mesma referência', () => {
    const objeto = { a: { b: [{ c: 1 }, 2] }, d: 'x' };
    const resultado = ambiente.congelarProfundo(objeto);
    assert.equal(resultado, objeto);
    for (const alvo of [objeto, objeto.a, objeto.a.b, objeto.a.b[0]]) {
      assert.equal(Object.isFrozen(alvo), true);
    }
    assert.throws(() => { objeto.a.b[0].c = 9; }, TypeError);
  });

  test('não tenta congelar Buffers nem valores primitivos', () => {
    const buffer = Buffer.from('ab');
    const objeto = ambiente.congelarProfundo({ buffer, n: 1 });
    assert.equal(Object.isFrozen(objeto), true);
    assert.equal(Object.isFrozen(buffer), false);
    assert.equal(ambiente.congelarProfundo(7), 7);
    assert.equal(ambiente.congelarProfundo(null), null);
  });
});

describe('inteiroDeAmbiente e booleanoDeAmbiente', () => {
  const inteiro = ambiente.inteiroDeAmbiente({ min: 2, max: 10, padrao: 4 });

  // schema avulso: a issue não tem path, então o nome cai em "configuracao"
  const contextoInteiro = { conhecidas: [], inteiros: { configuracao: { min: 2, max: 10 } }, opcoes: {}, obrigatorias: [] };
  const problemaInteiro = (valor) => ambiente.descreverProblema(inteiro.safeParse(valor).error.issues[0], contextoInteiro).replace('configuracao', 'N');

  test('inteiro: padrão quando ausente, converte decimal canônico e respeita limites', () => {
    assert.equal(inteiro.parse(undefined), 4);
    assert.equal(inteiro.parse('5'), 5);
    assert.equal(inteiro.parse('2'), 2);
    assert.equal(inteiro.parse('10'), 10);
    assert.equal(problemaInteiro('1'), 'N: abaixo do mínimo permitido (2)');
    assert.equal(problemaInteiro('11'), 'N: acima do máximo permitido (10)');
    assert.equal(problemaInteiro('3.5'), 'N: deve ser um número inteiro');
    assert.equal(problemaInteiro('abc'), 'N: deve ser um número inteiro');
  });

  test('inteiro: aceita somente decimal canônico não negativo', () => {
    const amplo = ambiente.inteiroDeAmbiente({ min: 0, max: 100000, padrao: 7 });
    for (const [texto, numero] of [['0', 0], ['1', 1], ['2', 2], ['10', 10], ['120', 120], ['86400', 86400]]) {
      assert.strictEqual(amplo.parse(texto), numero);
    }
    for (const ruim of ['01', '+1', '-0', '-1', '1.0', '1e1', '0x2', '0b11', '0o7', '1_0', 'Infinity', 'NaN', '10abc', '1 0', '٣']) {
      const r = amplo.safeParse(ruim);
      assert.equal(r.success, false, `deveria rejeitar ${JSON.stringify(ruim)}`);
      assert.equal(ambiente.descreverProblema(r.error.issues[0], { conhecidas: [], inteiros: { configuracao: { min: 0, max: 100000 } }, opcoes: {}, obrigatorias: [] }), 'configuracao: deve ser um número inteiro', ruim);
    }
  });

  test('booleano: somente as strings true e false', () => {
    assert.equal(ambiente.booleanoDeAmbiente.parse('true'), true);
    assert.equal(ambiente.booleanoDeAmbiente.parse('false'), false);
    assert.equal(ambiente.booleanoDeAmbiente.safeParse('yes').error.issues[0].code, 'invalid_value');
    assert.equal(ambiente.booleanoDeAmbiente.safeParse('TRUE').error.issues[0].code, 'invalid_value');
  });
});

describe('descreverProblema', () => {
  const contexto = {
    conhecidas: ['NUM', 'OPC', 'OBRIG', 'TXT'],
    inteiros: { NUM: { min: 1, max: 5 } },
    opcoes: { OPC: ['a', 'b'] },
    obrigatorias: ['OBRIG'],
  };
  const esquema = z.object({
    NUM: ambiente.inteiroDeAmbiente({ min: 1, max: 5, padrao: 1 }),
    OPC: z.enum(['a', 'b']).optional(),
    OBRIG: z.string(),
    TXT: z.string().regex(/^[a-z]+$/).optional(),
  }).refine((e) => e.TXT !== 'zz', { message: 'regra cruzada fixa', path: ['TXT'] });
  const problemaDe = (entrada) => esquema.safeParse(entrada).error.issues.map((issue) => ambiente.descreverProblema(issue, contexto));

  test('nome conhecido mais regra fixa, sem o valor recebido', () => {
    assert.deepEqual(problemaDe({ OBRIG: 'x', NUM: '0' }), ['NUM: abaixo do mínimo permitido (1)']);
    assert.deepEqual(problemaDe({ OBRIG: 'x', NUM: '6' }), ['NUM: acima do máximo permitido (5)']);
    assert.deepEqual(problemaDe({ OBRIG: 'x', NUM: 'segredoValor' }), ['NUM: deve ser um número inteiro']);
    assert.deepEqual(problemaDe({ OBRIG: 'x', OPC: 'segredoValor' }), ['OPC: deve ser um de: a, b']);
    assert.deepEqual(problemaDe({ OBRIG: 'x', TXT: 'SEGREDOVALOR' }), ['TXT: formato inválido']);
    assert.deepEqual(problemaDe({ OBRIG: 'x', TXT: 'zz' }), ['TXT: valor inválido']);
    assert.deepEqual(esquema.safeParse({ OBRIG: 'x', TXT: 'zz' }).error.issues.map((issue) => ambiente.descreverProblema(issue, { ...contexto, mensagensPermitidas: ['regra cruzada fixa'] })), ['TXT: regra cruzada fixa']);
    assert.deepEqual(problemaDe({}), ['OBRIG: obrigatória']);
    for (const mensagem of [...problemaDe({ OBRIG: 'x', NUM: 'segredoValor' }), ...problemaDe({ OBRIG: 'x', OPC: 'segredoValor' })]) {
      assertSemSensiveis(mensagem, ['segredoValor'], 'problema');
    }
  });

  test('tipo inválido sem obrigatoriedade nem inteiro; nome desconhecido vira configuracao', () => {
    const issueTipo = z.object({ OUTRA: z.string() }).safeParse({ OUTRA: 5 }).error.issues[0];
    assert.equal(ambiente.descreverProblema(issueTipo, contexto), 'configuracao: ausente ou tipo inválido');
    const issueRaiz = z.object({}).safeParse('texto').error.issues[0];
    assert.equal(ambiente.descreverProblema(issueRaiz, contexto), 'configuracao: ausente ou tipo inválido');
    assert.equal(ambiente.descreverProblema({ code: 'inexistente', path: ['NUM'] }, contexto), 'NUM: valor inválido');
  });

  test('issue custom só usa a mensagem quando explicitamente permitida pelo consumidor', () => {
    const sensivel = { code: 'custom', path: ['NUM'], message: 'segredo-super-secreto' };
    const semLista = ambiente.descreverProblema(sensivel, contexto);
    assert.equal(semLista, 'NUM: valor inválido');
    assertSemSensiveis(semLista, ['segredo-super-secreto'], 'custom sem allowlist');
    const comLista = ambiente.descreverProblema(sensivel, { ...contexto, mensagensPermitidas: ['regra fixa autorizada'] });
    assert.equal(comLista, 'NUM: valor inválido');
    assertSemSensiveis(comLista, ['segredo-super-secreto'], 'custom fora da allowlist');
    assert.equal(ambiente.descreverProblema({ code: 'custom', path: ['NUM'], message: 'regra fixa autorizada' }, { ...contexto, mensagensPermitidas: ['regra fixa autorizada'] }), 'NUM: regra fixa autorizada');
    assert.equal(ambiente.descreverProblema({ code: 'custom', path: ['NUM'] }, contexto), 'NUM: valor inválido');
  });
});

describe('validarAmbiente', () => {
  const contexto = { conhecidas: ['X', 'Y'], inteiros: { Y: { min: 1, max: 3 } }, opcoes: {}, obrigatorias: ['X'] };
  const esquema = z.object({ X: z.string(), Y: ambiente.inteiroDeAmbiente({ min: 1, max: 3, padrao: 2 }) });

  test('devolve os dados validados a partir de variáveis não vazias', () => {
    assert.deepEqual(ambiente.validarAmbiente({ esquema, origem: { X: ' ok ', Y: '', Z: 'ignorada' }, titulo: 'Config X', ...contexto }), { X: 'ok', Y: 2 });
  });

  test('lança Error com título e uma linha por problema, sem valores', () => {
    assert.throws(() => ambiente.validarAmbiente({ esquema, origem: { Y: 'valorSecreto' }, titulo: 'Config X', ...contexto }), (erro) => {
      assert.ok(erro instanceof Error);
      assert.equal(erro.message, 'Config X inválida:\n  - X: obrigatória\n  - Y: deve ser um número inteiro');
      assertSemSensiveis(erro.message, ['valorSecreto'], 'erro');
      return true;
    });
  });
});
