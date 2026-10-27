'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { renderizar, TIPOS } = require('../../src/email/templates');

const dados = (extra = {}) => ({
  canal: 'ALMOXARIFADO', empresa: 'Empresa Alfa', remetenteNome: 'Maria Souza', remetenteEmail: 'maria@alfa.example.invalid', assunto: 'Falta de luva', mensagem: 'Linha 1\nLinha 2', ...extra,
});

describe('e-mail CONTATO_SUPORTE', () => {
  test('o assunto é constante por canal e nunca leva dado do usuário; o corpo leva remetente, assunto e mensagem', () => {
    const a = renderizar(TIPOS.CONTATO_SUPORTE, dados());
    const b = renderizar(TIPOS.CONTATO_SUPORTE, dados({ assunto: 'Outro\r\nBcc: x@y.test', remetenteNome: 'Beto\r\nBcc: z' }));
    assert.equal(a.assunto, 'Mensagem enviada pelo Suporte do SafeWork — Almoxarifado');
    assert.equal(b.assunto, a.assunto);
    assert.doesNotMatch(b.assunto, /[\r\n]/);
    assert.match(a.texto, /Empresa Alfa/);
    assert.match(a.texto, /Maria Souza/);
    assert.match(a.texto, /Falta de luva/);
    assert.match(a.texto, /Linha 1/);
    assert.match(a.texto, /Linha 2/);
    assert.equal(renderizar(TIPOS.CONTATO_SUPORTE, dados({ canal: 'SST' })).assunto, 'Mensagem enviada pelo Suporte do SafeWork — Segurança do Trabalho (SST)');
  });

  test('HTML do usuário é escapado, sem link nem script, e o e-mail do remetente é só texto', () => {
    const r = renderizar(TIPOS.CONTATO_SUPORTE, dados({ mensagem: '<script>alert(1)</script><a href="http://x">y</a>', assunto: '<b>x</b>' }));
    assert.doesNotMatch(r.html, /<script>alert|<b>x<\/b>|<a href="http:\/\/x">/);
    assert.match(r.html, /&lt;script&gt;/);
    assert.doesNotMatch(r.html, /mailto:/);
    assert.doesNotMatch(r.html, /href="[^"]*maria@alfa/);
  });

  test('canal desconhecido ou mensagem vazia são erro de programação', () => {
    assert.throws(() => renderizar(TIPOS.CONTATO_SUPORTE, dados({ canal: 'FINANCEIRO' })), TypeError);
    assert.throws(() => renderizar(TIPOS.CONTATO_SUPORTE, dados({ mensagem: '  \n \n' })), TypeError);
  });

  test('o e-mail leva a mensagem registrada INTEIRA dentro do limite do schema (4000 code points): nem linha longa nem muitas linhas são cortadas', () => {
    const umaLinha = renderizar(TIPOS.CONTATO_SUPORTE, dados({ mensagem: 'x'.repeat(4000) }));
    assert.match(umaLinha.texto, /x{4000}/);
    const muitas = renderizar(TIPOS.CONTATO_SUPORTE, dados({ mensagem: Array.from({ length: 1999 }, () => 'a').join('\n') }));
    assert.equal((muitas.texto.match(/^a$/gm) || []).length, 1999, 'uma linha "a" por linha da mensagem (3997 code points)');
    const alem = renderizar(TIPOS.CONTATO_SUPORTE, dados({ mensagem: Array.from({ length: 4500 }, (_, i) => `l${i}`).join('\n') }));
    assert.match(alem.texto, /\bl3999\b/, 'a 4000ª linha fica');
    assert.doesNotMatch(alem.texto, /\bl4000\b/, 'só o que excede o próprio limite do schema é cortado (defesa em profundidade)');
  });
});
