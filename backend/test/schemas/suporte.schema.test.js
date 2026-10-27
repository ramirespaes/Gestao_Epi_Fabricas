'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schemas = require('../../src/schemas/suporte.schema');

const CHAVE = '4b7f1f5e-5a58-4d0c-9d3a-0b2a7e9c1f11';
const chamado = (extra = {}) => ({ assunto: 'Erro', categoria: 'ERRO', descricao: 'Detalhe', chaveIdempotencia: CHAVE, ...extra });
const contato = (extra = {}) => ({ assunto: 'Luvas', mensagem: 'Preciso de luvas', chaveIdempotencia: CHAVE, ...extra });

describe('Suporte — schemas', () => {
  test('chamado: normaliza (aparar, NFC, CRLF → LF) e conta code points', () => {
    const r = schemas.criarChamado.body.safeParse(chamado({ assunto: '  Café  ', descricao: 'a\r\nb\rc' }));
    assert.equal(r.success, true);
    assert.equal(r.data.assunto, 'Café');
    assert.equal(r.data.descricao, 'a\nb\nc');
    assert.equal(schemas.criarChamado.body.safeParse(chamado({ descricao: '😀'.repeat(4000) })).success, true);
    assert.equal(schemas.criarChamado.body.safeParse(chamado({ descricao: '😀'.repeat(4001) })).success, false);
  });

  test('chamado: campos fora do contrato e valores inválidos são recusados', () => {
    for (const extra of [
      { empresaId: 1 }, { usuarioId: 1 }, { email: 'a@b.test' }, { situacao: 'ABERTO' }, { protocolo: 'x' },
      { categoria: 'OUTRA' }, { assunto: '' }, { assunto: 'a'.repeat(151) }, { descricao: '   ' }, { descricao: 'x\u0007y' },
      { chaveIdempotencia: 'nao-uuid' }, { chaveIdempotencia: CHAVE.toUpperCase() },
    ]) assert.equal(schemas.criarChamado.body.safeParse(chamado(extra)).success, false, JSON.stringify(extra));
    assert.equal(schemas.criarChamado.body.safeParse({ assunto: 'a', categoria: 'ERRO', descricao: 'b' }).success, false, 'a chave é obrigatória');
  });

  test('contato: só assunto, mensagem e chave; o canal vem da rota e é fechado em almoxarifado | sst', () => {
    assert.equal(schemas.enviarContato.body.safeParse(contato()).success, true);
    for (const extra of [{ para: 'a@b.test' }, { destinatario: 'a@b.test' }, { empresaId: 1 }, { canal: 'SST' }, { mensagem: '' }, { mensagem: 'x'.repeat(4001) }]) {
      assert.equal(schemas.enviarContato.body.safeParse(contato(extra)).success, false, JSON.stringify(extra));
    }
    assert.equal(schemas.enviarContato.params.safeParse({ canal: 'sst' }).success, true);
    assert.equal(schemas.enviarContato.params.safeParse({ canal: 'financeiro' }).success, false);
    assert.deepEqual(schemas.CANAIS, { almoxarifado: 'ALMOXARIFADO', sst: 'SST' });
  });

  test('Painel: filtros e situação fechados; identificador só decimal canônico', () => {
    assert.equal(schemas.listarChamadosPlataforma.query.safeParse({ situacao: 'ABERTO', pagina: '2', limite: '10', busca: 'x' }).success, true);
    assert.equal(schemas.listarChamadosPlataforma.query.safeParse({ situacao: 'X' }).success, false);
    assert.equal(schemas.listarChamadosPlataforma.query.safeParse({ empresaId: '1;DROP' }).success, false);
    assert.equal(schemas.alterarSituacao.body.safeParse({ situacao: 'EM_ATENDIMENTO' }).success, true);
    assert.equal(schemas.alterarSituacao.body.safeParse({ situacao: 'EM_ATENDIMENTO', x: 1 }).success, false);
    assert.equal(schemas.responderChamado.body.safeParse({ texto: 'ok', administradorId: 1 }).success, false);
    assert.equal(schemas.buscarChamadoPlataforma.params.safeParse({ id: '01' }).success, false);
  });
});
