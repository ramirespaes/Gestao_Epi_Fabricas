'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Autorização da decisão da solicitação (12F-2). A decisão é um ato só sobre
 * todos os itens: aprovar algum item exige APROVAR_SOLICITACAO, reprovar algum
 * exige REPROVAR_SOLICITACAO, e a decisão mista exige as duas. Cada exigência é
 * o middleware da fábrica central (criarExigirPermissaoAcao); a composição só
 * escolhe quais rodam, em ordem, e para na primeira recusa.
 */

const rotas = () => exigirModulo('src/routes/solicitacao-epi.routes');

describe('solicitacao-epi.routes — ações exigidas pela decisão', () => {
  test('só aprovações: APROVAR_SOLICITACAO; só reprovações: REPROVAR_SOLICITACAO; a mistura: as duas, nessa ordem', () => {
    const { acoesDaDecisao } = rotas();
    assert.deepEqual(acoesDaDecisao([{ decisao: 'APROVADO' }, { decisao: 'APROVADO' }]), ['APROVAR_SOLICITACAO']);
    assert.deepEqual(acoesDaDecisao([{ decisao: 'REPROVADO' }]), ['REPROVAR_SOLICITACAO']);
    assert.deepEqual(acoesDaDecisao([{ decisao: 'REPROVADO' }, { decisao: 'APROVADO' }]), ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO']);
  });

  test('aprovar com quantidade menor que a pedida continua sendo aprovar (não exige REPROVAR_SOLICITACAO)', () => {
    assert.deepEqual(rotas().acoesDaDecisao([{ decisao: 'APROVADO', quantidadeAprovada: 1 }]), ['APROVAR_SOLICITACAO']);
  });
});

describe('solicitacao-epi.routes — composição dos middlewares da decisão', () => {
  const registro = () => {
    const chamadas = [];
    const permitir = (acao) => async (req, res, next) => { chamadas.push(acao); next(); };
    const negar = (acao, erro) => async (req, res, next) => { chamadas.push(acao); next(erro); };
    return { chamadas, permitir, negar };
  };
  const req = (decisoes) => ({ validado: Object.freeze({ body: Object.freeze({ decisoes }) }) });
  const rodar = (middleware, requisicao) => new Promise((resolve, reject) => {
    Promise.resolve(middleware(requisicao, {}, resolve)).catch(reject);
  });

  test('a decisão mista roda as duas exigências e só segue se as duas permitem', async () => {
    const { chamadas, permitir } = registro();
    const m = rotas().criarExigirAutoridadeDaDecisao({ APROVAR_SOLICITACAO: permitir('APROVAR_SOLICITACAO'), REPROVAR_SOLICITACAO: permitir('REPROVAR_SOLICITACAO') });
    assert.equal(await rodar(m, req([{ decisao: 'APROVADO' }, { decisao: 'REPROVADO' }])), undefined);
    assert.deepEqual(chamadas, ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO']);
  });

  test('a primeira recusa encerra: o erro dela sobe e a outra exigência nem roda', async () => {
    const { chamadas, permitir, negar } = registro();
    const erro = new Error('negado');
    const m = rotas().criarExigirAutoridadeDaDecisao({ APROVAR_SOLICITACAO: negar('APROVAR_SOLICITACAO', erro), REPROVAR_SOLICITACAO: permitir('REPROVAR_SOLICITACAO') });
    assert.equal(await rodar(m, req([{ decisao: 'APROVADO' }, { decisao: 'REPROVADO' }])), erro);
    assert.deepEqual(chamadas, ['APROVAR_SOLICITACAO']);
  });

  test('a recusa da segunda exigência também sobe; só reprovar não consulta APROVAR_SOLICITACAO', async () => {
    const { chamadas, permitir, negar } = registro();
    const erro = new Error('negado');
    const m = rotas().criarExigirAutoridadeDaDecisao({ APROVAR_SOLICITACAO: permitir('APROVAR_SOLICITACAO'), REPROVAR_SOLICITACAO: negar('REPROVAR_SOLICITACAO', erro) });
    assert.equal(await rodar(m, req([{ decisao: 'APROVADO' }, { decisao: 'REPROVADO' }])), erro);
    assert.equal(await rodar(m, req([{ decisao: 'REPROVADO' }])), erro);
    assert.deepEqual(chamadas, ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO']);
  });

  test('falha inesperada de uma exigência (banco) sobe como erro, nunca como permissão', async () => {
    const falha = new Error('banco fora');
    const m = rotas().criarExigirAutoridadeDaDecisao({
      APROVAR_SOLICITACAO: async () => { throw falha; }, REPROVAR_SOLICITACAO: async (r, s, next) => next(),
    });
    await assert.rejects(rodar(m, req([{ decisao: 'APROVADO' }])), falha);
  });

  test('sem decisão nenhuma (o schema já recusa) nada é consultado e a resposta é o 403 genérico: nunca segue sem exigência', async () => {
    const { chamadas, permitir } = registro();
    const m = rotas().criarExigirAutoridadeDaDecisao({ APROVAR_SOLICITACAO: permitir('APROVAR_SOLICITACAO'), REPROVAR_SOLICITACAO: permitir('REPROVAR_SOLICITACAO') });
    const erro = await rodar(m, req([]));
    assert.deepEqual([erro?.status, erro?.codigo, erro?.message], [403, 'PERMISSAO_NEGADA', 'Sem permissão para esta operação']);
    assert.deepEqual(chamadas, []);
  });

  test('montar sem as duas exigências é erro de programação', () => {
    const { criarExigirAutoridadeDaDecisao } = rotas();
    assert.equal(typeof criarExigirAutoridadeDaDecisao, 'function', 'fábrica ainda não implementada: criarExigirAutoridadeDaDecisao');
    assert.throws(() => criarExigirAutoridadeDaDecisao({ APROVAR_SOLICITACAO: async () => {} }), { name: 'TypeError', message: /REPROVAR_SOLICITACAO/ });
    assert.throws(() => criarExigirAutoridadeDaDecisao({ REPROVAR_SOLICITACAO: async () => {} }), { name: 'TypeError', message: /APROVAR_SOLICITACAO/ });
  });
});
