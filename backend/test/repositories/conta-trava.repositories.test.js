'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const identidadeRepo = require('../../src/repositories/identidade.repository');
const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');

/**
 * Trava da conta por id (Bloco 11C): SELECT ... FOR UPDATE na linha da
 * identidade ou do administrador, para o ciclo de senha tomar sempre a conta
 * antes do pedido de redefinição. Não devolve o hash da senha: quem precisa
 * dele continua usando buscarCredencialPorEmail.
 */

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: linhas.length };
    },
  };
};

for (const { nome, repo, tabela, mensagemId } of [
  { nome: 'identidade.repository — buscarPorIdParaAtualizacao', repo: identidadeRepo, tabela: 'identidades', mensagemId: /identidade/ },
  { nome: 'administrador-plataforma.repository — buscarPorIdParaAtualizacao', repo: administradorRepo, tabela: 'administradores_plataforma', mensagemId: /administrador/ },
]) {
  describe(nome, () => {
    test('uma consulta parametrizada com FOR UPDATE na linha do id informado; devolve id, e-mail e situação', async () => {
      const executor = executorFalso([{ id: 7, email: 'pessoa@example.invalid', ativo: true }]);
      const conta = await repo.buscarPorIdParaAtualizacao(executor, 7);
      assert.deepEqual(conta, { id: 7, email: 'pessoa@example.invalid', ativo: true });
      assert.equal(executor.chamadas.length, 1);
      const [{ texto, valores }] = executor.chamadas;
      assert.match(texto, new RegExp(`SELECT id, email, ativo\\s+FROM ${tabela}\\s+WHERE id = \\$1\\s+FOR UPDATE\\s*$`));
      assert.deepEqual(valores, [7]);
    });

    test('não devolve nem consulta o hash da senha', async () => {
      const executor = executorFalso([{ id: 7, email: 'pessoa@example.invalid', ativo: false, senha_hash: 'nao-deveria-sair' }]);
      const conta = await repo.buscarPorIdParaAtualizacao(executor, 7);
      assert.deepEqual(Object.keys(conta).sort(), ['ativo', 'email', 'id']);
      assert.doesNotMatch(executor.chamadas[0].texto, /senha_hash/);
    });

    test('conta inexistente devolve null', async () => {
      assert.equal(await repo.buscarPorIdParaAtualizacao(executorFalso([]), 999), null);
    });

    test('id inválido é recusado antes de qualquer consulta', async () => {
      for (const id of [0, -1, '7', 1.5, null, undefined]) {
        const executor = executorFalso([{ id: 7, email: 'pessoa@example.invalid', ativo: true }]);
        await assert.rejects(() => repo.buscarPorIdParaAtualizacao(executor, id), TypeError, String(id));
        assert.equal(executor.chamadas.length, 0);
      }
      await assert.rejects(() => repo.buscarPorIdParaAtualizacao(executorFalso(), 0), mensagemId);
    });
  });
}
