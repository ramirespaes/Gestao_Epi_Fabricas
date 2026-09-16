'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { HttpError } = require('../../src/errors/HttpError');
const { assertSemSensiveis } = require('../helpers/sensiveis');

describe('HttpError', () => {
  test('é um Error com status, codigo, expose e corpo público controlado', () => {
    const erro = new HttpError(409, 'CONFLITO_X', 'mensagem pública', { detalhes: [{ campo: 'a' }] });
    assert.ok(erro instanceof Error);
    assert.equal(erro.name, 'HttpError');
    assert.deepEqual([erro.status, erro.codigo, erro.message, erro.expose], [409, 'CONFLITO_X', 'mensagem pública', true]);
    assert.deepEqual(erro.corpoResposta(), { status: 'error', codigo: 'CONFLITO_X', message: 'mensagem pública', detalhes: [{ campo: 'a' }] });
    assert.equal(HttpError.ehHttpError(erro), true);
    assert.equal(HttpError.ehHttpError(new Error('x')), false);
  });

  test('corpo não inclui detalhes quando não definidos', () => {
    assert.deepEqual(HttpError.unauthorized().corpoResposta(), { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'Autenticação necessária' });
  });

  test('fábricas 4xx: códigos, mensagens e expose', () => {
    const casos = [
      [HttpError.badRequest(), 400, 'REQUISICAO_INVALIDA', 'Requisição inválida'],
      [HttpError.badRequest('X', 'msg', [1]), 400, 'X', 'msg'],
      [HttpError.validacao([{ campo: 'email' }]), 400, 'VALIDACAO', 'Dados inválidos'],
      [HttpError.unauthorized('SESSAO_EXPIRADA', 'Sessão expirada'), 401, 'SESSAO_EXPIRADA', 'Sessão expirada'],
      [HttpError.forbidden(), 403, 'SEM_PERMISSAO', 'Sem permissão para esta ação'],
      [HttpError.notFound(), 404, 'NAO_ENCONTRADO', 'Recurso não encontrado'],
      [HttpError.conflict(), 409, 'CONFLITO', 'Conflito com o estado atual do recurso'],
      [HttpError.tooManyRequests(), 429, 'LIMITE_EXCEDIDO', 'Muitas tentativas. Tente novamente mais tarde'],
    ];
    for (const [erro, status, codigo, message] of casos) {
      assert.deepEqual([erro.status, erro.codigo, erro.message, erro.expose], [status, codigo, message, true], codigo);
    }
    assert.deepEqual(HttpError.validacao([{ campo: 'email' }]).detalhes, [{ campo: 'email' }]);
  });

  test('tooManyRequests define Retry-After somente com inteiro positivo', () => {
    assert.deepEqual(HttpError.tooManyRequests(undefined, undefined, { retryAfterSegundos: 900 }).headers, { 'Retry-After': '900' });
    assert.equal(HttpError.tooManyRequests(undefined, undefined, { retryAfterSegundos: 0 }).headers, undefined);
    assert.equal(HttpError.tooManyRequests(undefined, undefined, { retryAfterSegundos: 1.5 }).headers, undefined);
    assert.equal(HttpError.tooManyRequests().headers, undefined);
  });

  test('erros internos: 5xx, expose false, causa preservada mas fora do corpo', () => {
    const causa = new Error('sql interno com senha_hash e luis@empresa.com');
    const interno = HttpError.internal(causa);
    assert.deepEqual([interno.status, interno.codigo, interno.expose], [500, 'ERRO_INTERNO', false]);
    assert.equal(interno.cause, causa);
    assert.deepEqual(interno.corpoResposta(), { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
    assertSemSensiveis(JSON.stringify(interno.corpoResposta()), ['senha_hash', 'luis@empresa.com'], 'corpo do 500');

    const indisponivel = HttpError.serviceUnavailable();
    assert.deepEqual([indisponivel.status, indisponivel.codigo, indisponivel.expose, indisponivel.cause], [503, 'INDISPONIVEL', false, undefined]);
    assert.equal(HttpError.internal().cause, undefined);
  });
});
