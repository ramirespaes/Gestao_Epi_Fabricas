'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const { limitadorRevelacaoCpf } = require('../../src/middleware/rate-limit');

/** Fiação da rota de revelação do CPF: POST, na ordem sessão → permissão → limite → validação → controller. */

const rotasDe = (opcoes) => {
  const exigirSessao = (req, res, next) => next();
  const revelarCpf = function revelarCpf() {};
  const controller = new Proxy({}, { get: (_, nome) => (nome === 'revelarCpf' ? revelarCpf : () => {}) });
  const router = criarFuncionarioRoutes({ controller, exigirSessao, pool: {}, ...opcoes });
  return { exigirSessao, controller, rotas: router.stack.filter((c) => c.route).map((c) => ({ caminho: c.route.path, metodos: Object.keys(c.route.methods), pilha: c.route.stack })) };
};

describe('rota POST /funcionarios/:id/cpf/revelar', () => {
  test('existe só como POST, e nenhuma rota GET devolve o CPF', () => {
    const { rotas } = rotasDe();
    const revelar = rotas.filter((r) => r.caminho.includes('cpf/revelar'));
    assert.equal(revelar.length, 1);
    assert.deepEqual(revelar[0].metodos, ['post']);
    assert.equal(rotas.some((r) => r.metodos.includes('get') && /cpf/.test(r.caminho)), false);
  });

  test('ordem: sessão, permissão (employeeHistory.editar), limitador, validação, controller', () => {
    const limite = (req, res, next) => next();
    const { rotas, exigirSessao, controller } = rotasDe({ limitadorRevelacaoCpf: limite });
    const { pilha } = rotas.find((r) => r.caminho === '/funcionarios/:id/cpf/revelar');
    assert.equal(pilha.length, 5);
    assert.equal(pilha[0].handle, exigirSessao);
    assert.equal(pilha[2].handle, limite, 'o limitador vem depois da autorização e antes da validação');
    assert.equal(pilha.at(-1).handle, controller.revelarCpf);
  });

  test('sem limitador injetado, a rota usa o limitador compartilhado de 10/min por usuário + empresa', () => {
    const { rotas } = rotasDe();
    const { pilha } = rotas.find((r) => r.caminho === '/funcionarios/:id/cpf/revelar');
    assert.equal(pilha[2].handle, limitadorRevelacaoCpf);
  });
});
