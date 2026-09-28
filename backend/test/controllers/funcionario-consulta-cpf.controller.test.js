'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const funcionarioService = require('../../src/services/funcionario.service');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const funcionarioSchemas = require('../../src/schemas/funcionario.schema');

/**
 * SEC-008: a consulta de funcionário por CPF completo sai da URL. O CPF
 * viaja no corpo de POST /funcionarios/consulta-cpf; empresa vem da sessão;
 * a resposta é a mesma da listagem, com o CPF só mascarado. Sem banco:
 * serviço substituído por mock.
 */

const CPF = '52998224725';

function respostaFalsa() {
  const r = { statusCode: null, corpo: null };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (c) => { r.corpo = c; return r; };
  return r;
}

describe('SEC-008 — consulta de funcionário por CPF no corpo', () => {
  test('controller: CPF do corpo, empresa da sessão, uma página só; resposta sem o CPF completo', async (t) => {
    const listar = t.mock.method(funcionarioService, 'listar', async () => ({
      funcionarios: [{ id: 9, nome: 'Tício de Tal', matricula: 'M-9', cpf: CPF, ativo: true }], total: 1, pagina: 1, limite: 20,
    }));
    const controller = criarFuncionarioController({ pool: {} });
    const res = respostaFalsa();

    await controller.consultarCpf({ validado: { body: { cpf: CPF } }, empresa: { id: 3 }, usuario: { id: 7 }, headers: {} }, res);

    assert.equal(listar.mock.calls.length, 1);
    assert.deepEqual(listar.mock.calls[0].arguments[1], {
      empresaId: 3, ativo: null, busca: null, grupoHomogeneoId: null, cpf: CPF, pagina: 1, limite: 20,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.stringify(res.corpo).includes(CPF), false, 'CPF completo nunca volta');
    assert.equal(res.corpo.funcionarios[0].cpfMascarado, '***.***.***-25');
    assert.deepEqual([res.corpo.total, res.corpo.pagina, res.corpo.limite], [1, 1, 20]);
  });

  test('rota: POST /funcionarios/consulta-cpf com sessão, permissão de visualizar e o schema do corpo; GET continua para a busca livre', () => {
    const exigirSessao = (req, res, next) => next();
    const controller = { criar() {}, importar() {}, listar() {}, buscar() {}, alterar() {}, inativar() {}, reativar() {}, consultarCpf() {} };
    const router = criarFuncionarioRoutes({ controller, exigirSessao, pool: {} });
    const rotas = router.stack.filter((c) => c.route).map((c) => ({ caminho: c.route.path, metodos: Object.keys(c.route.methods), pilha: c.route.stack }));

    const consulta = rotas.find((r) => r.caminho === '/funcionarios/consulta-cpf');
    assert.ok(consulta, 'rota de consulta por CPF registrada');
    assert.deepEqual(consulta.metodos, ['post']);
    assert.equal(consulta.pilha[0].handle, exigirSessao);
    assert.equal(consulta.pilha.at(-1).handle, controller.consultarCpf);
    assert.equal(consulta.pilha.length, 4, 'sessão, permissão, validação e controller');
    assert.ok(rotas.some((r) => r.caminho === '/funcionarios' && r.metodos.includes('get')));
    assert.ok(funcionarioSchemas.consultaCpf && funcionarioSchemas.consultaCpf.body, 'schema do corpo exportado');
  });
});
