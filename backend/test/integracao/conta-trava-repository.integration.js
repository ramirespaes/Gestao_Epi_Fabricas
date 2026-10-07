'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');
const { todasAsMigrations, criarIdentidade, criarAdministrador } = require('./helpers/recuperacao-senha');
const { sondarLinha } = require('./helpers/recuperacao-senha-servico');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');

/**
 * Trava da conta por id (SELECT ... FOR UPDATE) contra PostgreSQL real, com
 * duas conexões: a segunda só consegue a linha depois que a primeira encerra
 * a transação.
 */

for (const { nome, repo, tabela, criar, extras } of [
  { nome: 'identidade.repository', repo: identidadeRepo, tabela: 'identidades', criar: criarIdentidade, extras: { telefone: null, tema: 'sistema', modoVisual: 'padrao' } },
  { nome: 'administrador-plataforma.repository', repo: administradorRepo, tabela: 'administradores_plataforma', criar: criarAdministrador, extras: {} },
]) {
  describe(`${nome} — buscarPorIdParaAtualizacao (PostgreSQL real)`, () => {
    let contexto;
    let pool;
    let sequencia = 0;

    const novaConta = async () => {
      sequencia += 1;
      const email = `trava-${sequencia}@example.invalid`;
      return { id: await criar(pool, email), email };
    };

    before(async () => {
      contexto = await abrirPoolTemporario(todasAsMigrations());
      pool = contexto.pool;
    });
    after(async () => { if (contexto) await contexto.encerrar(); });

    test('devolve id, e-mail e situação, sem o hash da senha, e trava só a linha pedida até o fim da transação', async () => {
      const conta = await novaConta();
      const outra = await novaConta();
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        assert.deepEqual(await repo.buscarPorIdParaAtualizacao(cliente, conta.id), { id: conta.id, email: conta.email, ativo: true, ...extras });
        assert.equal(await sondarLinha(pool, tabela, conta.id), 'TRAVADA');
        assert.equal(await sondarLinha(pool, tabela, outra.id), 'LIVRE');
        await cliente.query('COMMIT');
      } finally {
        cliente.release();
      }
      assert.equal(await sondarLinha(pool, tabela, conta.id), 'LIVRE');
    });

    test('conta inexistente devolve null e não trava nada', async () => {
      const conta = await novaConta();
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        assert.equal(await repo.buscarPorIdParaAtualizacao(cliente, 999999), null);
        assert.equal(await sondarLinha(pool, tabela, conta.id), 'LIVRE');
        await cliente.query('ROLLBACK');
      } finally {
        cliente.release();
      }
    });

    test('concorrência real: a segunda conexão espera a primeira e lê a situação já confirmada por ela', async () => {
      const conta = await novaConta();
      const primeira = await pool.connect();
      const segunda = await pool.connect();
      try {
        await primeira.query('BEGIN');
        await repo.buscarPorIdParaAtualizacao(primeira, conta.id);
        await primeira.query(`UPDATE ${tabela} SET ativo = false WHERE id = $1`, [conta.id]);

        await segunda.query('BEGIN');
        const leitura = repo.buscarPorIdParaAtualizacao(segunda, conta.id);
        const espera = await aguardarEsperaPeloLock(pool, segunda.processID);
        assert.match(espera, /^(transactionid|tuple)$/, 'parada numa trava de linha');

        await primeira.query('COMMIT');
        assert.deepEqual(await leitura, { id: conta.id, email: conta.email, ativo: false, ...extras });
        await segunda.query('COMMIT');
      } finally {
        await primeira.query('ROLLBACK').catch(() => {});
        await segunda.query('ROLLBACK').catch(() => {});
        primeira.release();
        segunda.release();
      }
    });
  });
}
