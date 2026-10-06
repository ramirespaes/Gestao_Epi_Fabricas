'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const s = require('../../src/schemas/conta.schema');

/**
 * Configurações — schemas da conta da identidade autenticada: só estrutura
 * e normalização; a identidade nunca vem do corpo (strictObject recusa
 * qualquer campo de autoridade).
 */

describe('conta.schema — atualizar (telefone, tema, modo visual)', () => {
  test('aceita um ou mais campos; telefone aparado; null limpa o telefone; valores do domínio', () => {
    const r = s.atualizar.body.safeParse({ telefone: '  (47) 99999-0001 ', tema: 'escuro', modoVisual: 'baixa_visao' });
    assert.equal(r.success, true, JSON.stringify(r.error));
    assert.deepEqual(r.data, { telefone: '(47) 99999-0001', tema: 'escuro', modoVisual: 'baixa_visao' });
    assert.deepEqual(s.atualizar.body.safeParse({ telefone: null }).data, { telefone: null });
    assert.deepEqual(s.atualizar.body.safeParse({ tema: 'sistema' }).data, { tema: 'sistema' });
    for (const tema of s.TEMAS) assert.equal(s.atualizar.body.safeParse({ tema }).success, true, tema);
    for (const modoVisual of s.MODOS_VISUAIS) assert.equal(s.atualizar.body.safeParse({ modoVisual }).success, true, modoVisual);
    assert.deepEqual(s.TEMAS, ['sistema', 'claro', 'escuro']);
    assert.deepEqual(s.MODOS_VISUAIS, ['padrao', 'alto_contraste', 'deuteranopia', 'protanopia', 'tritanopia', 'baixa_visao', 'monocromatico']);
  });

  test('recusa corpo vazio, campos desconhecidos ou de autoridade, valores fora do domínio e telefone inválido', () => {
    for (const corpo of [
      {}, { identidadeId: 1, tema: 'claro' }, { usuarioId: 1 }, { email: 'x@y.z' }, { senhaAtual: 'x' },
      { tema: 'dark' }, { tema: 'Claro' }, { tema: null }, { modoVisual: 'contrast' }, { modoVisual: 'lowvision' }, { modoVisual: null },
      { telefone: '' }, { telefone: '   ' }, { telefone: '1'.repeat(21) }, { telefone: 'abc\u0007' }, { telefone: 123 },
    ]) {
      assert.equal(s.atualizar.body.safeParse(corpo).success, false, JSON.stringify(corpo));
    }
    assert.equal(s.atualizar.query.safeParse({}).success, true);
    assert.equal(s.atualizar.query.safeParse({ identidadeId: 1 }).success, false);
  });
});

describe('conta.schema — trocarEmail', () => {
  test('senha atual como veio e novo e-mail normalizado; campos de autoridade recusados; e-mail inválido recusado', () => {
    const r = s.trocarEmail.body.safeParse({ senhaAtual: ' Senha Atual 1234 ', novoEmail: '  Nova.Pessoa@Example.INVALID ' });
    assert.equal(r.success, true, JSON.stringify(r.error));
    assert.deepEqual(r.data, { senhaAtual: ' Senha Atual 1234 ', novoEmail: 'nova.pessoa@example.invalid' });
    for (const corpo of [
      { novoEmail: 'a@b.co' }, { senhaAtual: 'x' }, { senhaAtual: 'x', novoEmail: 'sem-arroba' }, { senhaAtual: 'x', novoEmail: 'acento@exémplo.com' },
      { senhaAtual: 'x', novoEmail: 'a@b.co', identidadeId: 2 }, { senhaAtual: 'x', novoEmail: 'a@b.co', email: 'a@b.co' }, { senhaAtual: '', novoEmail: 'a@b.co' },
    ]) {
      assert.equal(s.trocarEmail.body.safeParse(corpo).success, false, JSON.stringify(corpo));
    }
    assert.equal(s.trocarEmail.query.safeParse({}).success, true);
  });
});
