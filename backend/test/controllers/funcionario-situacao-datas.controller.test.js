'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const funcionarioService = require('../../src/services/funcionario.service');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const funcionarioSchemas = require('../../src/schemas/funcionario.schema');

/**
 * Datas efetivas da situação — controller e rotas (RED). O controller repassa ao serviço a data informada (já validada pelo
 * schema), a data civil "hoje" de São Paulo vinda do relógio injetado (nunca a data UTC) e a empresa e o ator da sessão; devolve
 * a representação do funcionário sem CPF completo e, na mudança real, o bloco `ultimaMudancaSituacao`.
 */

// 2026-10-11T01:30:00Z = 22:30 de 10/10 em São Paulo: a data UTC já é o dia seguinte.
const RELOGIO = () => new Date('2026-10-11T01:30:00Z');
const HOJE_CIVIL = '2026-10-10';
const CPF = '52998224725';
const registrada = new Date('2026-10-11T01:30:00Z');

function respostaFalsa() {
  const r = { statusCode: null, corpo: null };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (c) => { r.corpo = c; return r; };
  return r;
}
const sessao = { empresa: { id: 3 }, usuario: { id: 7 }, headers: { 'user-agent': 'teste' }, ip: '203.0.113.9' };
const pessoa = (situacao) => ({ id: 70, nome: 'Tício', cpf: CPF, situacao, ativo: situacao === 'ATIVO' });

describe('controller — situação com data efetiva', () => {
  test('alterarSituacao: repassa situacao, dataEfetiva, hoje civil de São Paulo, id da URL e empresa/ator da sessão', async (t) => {
    const alterar = t.mock.method(funcionarioService, 'alterarSituacao', async () => ({
      funcionario: pessoa('INATIVO'), situacaoAnterior: 'ATIVO', alterado: true, ultimaMudanca: { situacao: 'INATIVO', dataEfetiva: '2026-10-01', registradaEm: registrada },
    }));
    const res = respostaFalsa();
    await criarFuncionarioController({ pool: {}, relogio: RELOGIO }).alterarSituacao({
      ...sessao, validado: { params: { id: 70 }, body: { situacao: 'INATIVO', dataEfetiva: '2026-10-01' } },
    }, res);
    const args = alterar.mock.calls[0].arguments[1];
    assert.equal(args.empresaId, 3);
    assert.equal(args.atorId, 7);
    assert.equal(args.funcionarioId, 70);
    assert.equal(args.situacao, 'INATIVO');
    assert.equal(args.dataEfetiva, '2026-10-01');
    assert.equal(args.hoje, HOJE_CIVIL, 'hoje é a data civil de São Paulo, não a data UTC');
    assert.equal(res.statusCode, 200);
    assert.equal(res.corpo.situacaoAnterior, 'ATIVO');
    assert.deepEqual(res.corpo.ultimaMudancaSituacao, { situacao: 'INATIVO', dataEfetiva: '2026-10-01', registradaEm: registrada });
    assert.equal(JSON.stringify(res.corpo).includes(CPF), false, 'CPF completo nunca volta');
    assert.equal(res.corpo.funcionario.cpfMascarado, '***.***.***-25');
  });

  test('alterarSituacao para ATIVO sem data: dataEfetiva chega indefinida ao serviço (quem decide é o estado travado)', async (t) => {
    const alterar = t.mock.method(funcionarioService, 'alterarSituacao', async () => ({ funcionario: pessoa('ATIVO'), situacaoAnterior: 'INATIVO', alterado: true }));
    const res = respostaFalsa();
    await criarFuncionarioController({ pool: {}, relogio: RELOGIO }).alterarSituacao({ ...sessao, validado: { params: { id: 70 }, body: { situacao: 'ATIVO' } } }, res);
    assert.equal(alterar.mock.calls[0].arguments[1].dataEfetiva, undefined);
    assert.equal(res.statusCode, 200);
  });

  test('a empresa e o ator nunca vêm do corpo validado', async (t) => {
    const alterar = t.mock.method(funcionarioService, 'alterarSituacao', async () => ({ funcionario: pessoa('AFASTADO'), situacaoAnterior: 'ATIVO', alterado: true }));
    await criarFuncionarioController({ pool: {}, relogio: RELOGIO }).alterarSituacao({
      ...sessao, validado: { params: { id: 70 }, body: { situacao: 'AFASTADO', dataEfetiva: '2026-10-01', empresaId: 999, atorId: 999 } },
    }, respostaFalsa());
    const args = alterar.mock.calls[0].arguments[1];
    assert.equal(args.empresaId, 3);
    assert.equal(args.atorId, 7);
  });

  test('inativar (rota legada): repassa dataEfetiva e hoje; mantém `alterado` na resposta', async (t) => {
    const inativar = t.mock.method(funcionarioService, 'inativar', async () => ({
      funcionario: pessoa('INATIVO'), alterado: true, ultimaMudanca: { situacao: 'INATIVO', dataEfetiva: '2026-10-01', registradaEm: registrada },
    }));
    const res = respostaFalsa();
    await criarFuncionarioController({ pool: {}, relogio: RELOGIO }).inativar({ ...sessao, validado: { params: { id: 70 }, body: { dataEfetiva: '2026-10-01' } } }, res);
    const args = inativar.mock.calls[0].arguments[1];
    assert.equal(args.dataEfetiva, '2026-10-01');
    assert.equal(args.hoje, HOJE_CIVIL);
    assert.equal(args.funcionarioId, 70);
    assert.equal(res.corpo.alterado, true);
    assert.equal(res.corpo.ultimaMudancaSituacao.dataEfetiva, '2026-10-01');
  });

  test('reativar (rota legada): corpo vazio continua válido; com data, ela chega ao serviço; hoje civil sempre', async (t) => {
    const reativar = t.mock.method(funcionarioService, 'reativar', async () => ({ funcionario: pessoa('ATIVO'), alterado: false }));
    const controller = criarFuncionarioController({ pool: {}, relogio: RELOGIO });
    await controller.reativar({ ...sessao, validado: { params: { id: 70 }, body: {} } }, respostaFalsa());
    assert.equal(reativar.mock.calls[0].arguments[1].dataEfetiva, undefined);
    assert.equal(reativar.mock.calls[0].arguments[1].hoje, HOJE_CIVIL);
    await controller.reativar({ ...sessao, validado: { params: { id: 70 }, body: { dataEfetiva: '2026-10-02' } } }, respostaFalsa());
    assert.equal(reativar.mock.calls[1].arguments[1].dataEfetiva, '2026-10-02');
  });

  test('operação idempotente (alterado false) não inventa bloco de mudança', async (t) => {
    t.mock.method(funcionarioService, 'reativar', async () => ({ funcionario: pessoa('ATIVO'), alterado: false }));
    const res = respostaFalsa();
    await criarFuncionarioController({ pool: {}, relogio: RELOGIO }).reativar({ ...sessao, validado: { params: { id: 70 }, body: {} } }, res);
    assert.equal(res.corpo.alterado, false);
    assert.equal(res.corpo.ultimaMudancaSituacao, undefined);
  });
});

describe('rotas — situação, inativar e reativar', () => {
  const exigirSessao = (req, res, next) => next();
  const controller = new Proxy({}, { get: (_, nome) => (nome === 'then' ? undefined : function handler() {}) });
  const rotas = criarFuncionarioRoutes({ controller, exigirSessao, pool: {} }).stack.filter((c) => c.route)
    .map((c) => ({ caminho: c.route.path, metodos: Object.keys(c.route.methods), pilha: c.route.stack }));

  for (const [caminho, schema] of [['/funcionarios/:id/situacao', 'situacao'], ['/funcionarios/:id/inativar', 'inativar'], ['/funcionarios/:id/reativar', 'reativar']]) {
    test(`${caminho}: POST com sessão, permissão de editar, validação e controller; schema exportado com corpo`, () => {
      const rota = rotas.find((r) => r.caminho === caminho);
      assert.ok(rota, 'rota registrada');
      assert.deepEqual(rota.metodos, ['post']);
      assert.equal(rota.pilha[0].handle, exigirSessao);
      assert.equal(rota.pilha.length, 4, 'sessão, permissão, validação e controller');
      assert.ok(funcionarioSchemas[schema].body, 'schema do corpo exportado');
    });
  }

  test('não existe rota /afastar nem /motivo: o afastamento é só POST /situacao', () => {
    assert.equal(rotas.some((r) => /afastar|motivo|desligar/.test(r.caminho)), false);
  });
});
