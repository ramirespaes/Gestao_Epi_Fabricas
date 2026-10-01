'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');
const {
  todasAsMigrations, erroDe, hashDeToken, criarIdentidade, criarAdministrador, inserirPedido, colunasDe,
} = require('./helpers/recuperacao-senha');

/**
 * Repositórios dos pedidos de redefinição de senha contra PostgreSQL real:
 * identidades (061) e administradores da plataforma (062), com o mesmo
 * contrato. Schema temporário com todas as migrations; duas conexões reais
 * no teste de concorrência.
 */

const ALVOS = [
  {
    titulo: 'redefinicao-senha.repository (identidades) — PostgreSQL real',
    caminho: '../../src/repositories/redefinicao-senha.repository',
    tabela: 'redefinicoes_senha',
    coluna: 'identidade_id',
    conta: 'identidadeId',
    criarConta: criarIdentidade,
  },
  {
    titulo: 'redefinicao-senha-plataforma.repository (administradores) — PostgreSQL real',
    caminho: '../../src/repositories/redefinicao-senha-plataforma.repository',
    tabela: 'redefinicoes_senha_plataforma',
    coluna: 'administrador_id',
    conta: 'administradorId',
    criarConta: criarAdministrador,
  },
];
const TOKEN_EM_CLARO = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

for (const { titulo, caminho, tabela, coluna, conta, criarConta } of ALVOS) {
  const repo = () => require(caminho); // eslint-disable-line global-require

  describe(titulo, () => {
    let contexto;
    let pool;
    let sequencia = 0;
    const alvo = { tabela, coluna };
    const novaConta = () => criarConta(pool, `pessoa${sequencia += 1}@example.invalid`);
    const linha = async (id) => (await pool.query(`SELECT * FROM ${tabela} WHERE id = $1`, [id])).rows[0];
    const emTransacao = async (operacao) => {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        const resultado = await operacao(cliente);
        await cliente.query('COMMIT');
        return resultado;
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }
    };

    before(async () => {
      contexto = await abrirPoolTemporario(todasAsMigrations());
      pool = contexto.pool;
    });
    after(async () => { if (contexto) await contexto.encerrar(); });

    test('criar: grava só o hash; criado_em e expira_em são do relógio do banco; nenhuma coluna guarda token em claro', async () => {
      const contaId = await novaConta();
      const tokenHash = hashDeToken();
      const { criado, agora } = await emTransacao(async (c) => {
        const r = await repo().criar(c, { [conta]: contaId, tokenHash, validadeMinutos: 60, ip: '203.0.113.7', dispositivo: 'Agente de Teste' });
        const { rows: [{ agora: instante }] } = await c.query('SELECT now() AS agora');
        return { criado: r, agora: instante };
      });

      assert.match(criado.id, /^[1-9][0-9]*$/);
      assert.equal(criado.substituidos, 0);
      assert.equal(criado.criadoEm.getTime(), agora.getTime(), 'criado_em é o now() da transação no banco');
      assert.equal(criado.expiraEm.getTime() - criado.criadoEm.getTime(), 60 * 60 * 1000);

      const gravado = await linha(criado.id);
      assert.deepEqual(
        [gravado[coluna], gravado.token_hash, gravado.usado_em, gravado.cancelado_em, gravado.ip, gravado.dispositivo],
        [contaId, tokenHash, null, null, '203.0.113.7', 'Agente de Teste'],
      );
      assert.deepEqual(await colunasDe(pool, contexto.schema, tabela), [
        'id', coluna, 'token_hash', 'criado_em', 'expira_em', 'usado_em', 'cancelado_em', 'motivo_cancelamento', 'ip', 'dispositivo',
      ]);
      assert.equal(JSON.stringify(gravado).includes(TOKEN_EM_CLARO), false);
    });

    test('criar: token em claro é recusado pelo repositório e nada é gravado', async () => {
      const contaId = await novaConta();
      await assert.rejects(() => repo().criar(pool, { [conta]: contaId, tokenHash: TOKEN_EM_CLARO, validadeMinutos: 60 }), TypeError);
      const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${coluna} = $1`, [contaId]);
      assert.equal(n, 0);
    });

    test('criar de novo para a mesma conta cancela o pedido pendente anterior (SUBSTITUIDA) e o novo passa a ser o único pendente', async () => {
      const contaId = await novaConta();
      const primeiroHash = hashDeToken();
      const primeiro = await emTransacao((c) => repo().criar(c, { [conta]: contaId, tokenHash: primeiroHash, validadeMinutos: 60 }));
      const segundo = await emTransacao((c) => repo().criar(c, { [conta]: contaId, tokenHash: hashDeToken(), validadeMinutos: 60 }));
      assert.equal(segundo.substituidos, 1);

      const antigo = await linha(primeiro.id);
      assert.equal(antigo.motivo_cancelamento, 'SUBSTITUIDA');
      assert.ok(antigo.cancelado_em instanceof Date);
      assert.equal((await repo().buscarPorHash(pool, primeiroHash)).situacao, 'CANCELADA');
      const { rows } = await pool.query(`SELECT id FROM ${tabela} WHERE ${coluna} = $1 AND usado_em IS NULL AND cancelado_em IS NULL`, [contaId]);
      assert.deepEqual(rows.map((r) => r.id), [segundo.id]);

      const outraConta = await novaConta();
      const daOutra = await emTransacao((c) => repo().criar(c, { [conta]: outraConta, tokenHash: hashDeToken(), validadeMinutos: 60 }));
      assert.equal(daOutra.substituidos, 0, 'o pedido de uma conta não toca no de outra');
      assert.equal((await linha(segundo.id)).cancelado_em, null);
    });

    test('criar também substitui um pendente já expirado, que ainda ocupava a vaga da conta', async () => {
      const contaId = await novaConta();
      const expirado = await inserirPedido(pool, alvo, contaId, { criadoHaMinutos: 120, validadeMinutos: 60 });
      const novo = await emTransacao((c) => repo().criar(c, { [conta]: contaId, tokenHash: hashDeToken(), validadeMinutos: 60 }));
      assert.equal(novo.substituidos, 1);
      assert.equal((await linha(expirado.id)).motivo_cancelamento, 'SUBSTITUIDA');
    });

    test('criar acima do teto de 4 horas é recusado antes do banco; o banco também recusa se alguém contornar o repositório', async () => {
      const contaId = await novaConta();
      await assert.rejects(() => repo().criar(pool, { [conta]: contaId, tokenHash: hashDeToken(), validadeMinutos: 241 }), TypeError);
      const direto = await erroDe(inserirPedido(pool, alvo, contaId, { validadeMinutos: 241 }));
      assert.equal(direto?.constraint, `chk_${tabela}_validade`);
    });

    test('buscarPorHash: PENDENTE, USADA, CANCELADA e EXPIRADA conforme o banco; hash desconhecido devolve null', async () => {
      const pendente = await inserirPedido(pool, alvo, await novaConta());
      const expirado = await inserirPedido(pool, alvo, await novaConta(), { criadoHaMinutos: 120, validadeMinutos: 60 });
      const usado = await inserirPedido(pool, alvo, await novaConta());
      await pool.query(`UPDATE ${tabela} SET usado_em = now() WHERE id = $1`, [usado.id]);
      const cancelado = await inserirPedido(pool, alvo, await novaConta());
      await pool.query(`UPDATE ${tabela} SET cancelado_em = now(), motivo_cancelamento = 'SENHA_ALTERADA' WHERE id = $1`, [cancelado.id]);

      const situacoes = [];
      for (const p of [pendente, expirado, usado, cancelado]) situacoes.push((await repo().buscarPorHash(pool, p.token_hash)).situacao);
      assert.deepEqual(situacoes, ['PENDENTE', 'EXPIRADA', 'USADA', 'CANCELADA']);

      const lido = await repo().buscarPorHash(pool, pendente.token_hash);
      assert.deepEqual(
        [lido.id, lido[conta], lido.criadoEm.getTime(), lido.expiraEm.getTime(), lido.usadoEm, lido.canceladoEm, lido.motivoCancelamento],
        [pendente.id, pendente[coluna], pendente.criado_em.getTime(), pendente.expira_em.getTime(), null, null, null],
      );
      assert.equal(await repo().buscarPorHash(pool, hashDeToken()), null);
    });

    test('consumo único: marcarUsada vence uma vez; a segunda chamada, o pedido cancelado e o expirado devolvem false e não mudam a linha', async () => {
      const pendente = await inserirPedido(pool, alvo, await novaConta());
      assert.equal(await repo().marcarUsada(pool, pendente.id), true);
      const usado = await linha(pendente.id);
      assert.ok(usado.usado_em instanceof Date);
      assert.ok(usado.usado_em <= usado.expira_em && usado.usado_em >= usado.criado_em);
      assert.equal(await repo().marcarUsada(pool, pendente.id), false, 'token usado não é reutilizado');
      assert.deepEqual(await linha(pendente.id), usado);

      const cancelado = await inserirPedido(pool, alvo, await novaConta());
      await pool.query(`UPDATE ${tabela} SET cancelado_em = now(), motivo_cancelamento = 'SUBSTITUIDA' WHERE id = $1`, [cancelado.id]);
      const antesCancelado = await linha(cancelado.id);
      assert.equal(await repo().marcarUsada(pool, cancelado.id), false, 'token cancelado não é consumido');
      assert.deepEqual(await linha(cancelado.id), antesCancelado);

      const expirado = await inserirPedido(pool, alvo, await novaConta(), { criadoHaMinutos: 120, validadeMinutos: 60 });
      assert.equal(await repo().marcarUsada(pool, expirado.id), false, 'token expirado não é consumido');
      assert.equal((await linha(expirado.id)).usado_em, null);

      assert.equal(await repo().marcarUsada(pool, '999999999'), false, 'pedido inexistente');
    });

    test('cancelarPendentes: cancela só os pendentes da conta, com o motivo informado; usados e de outras contas ficam como estão', async () => {
      const contaId = await novaConta();
      const usado = await inserirPedido(pool, alvo, contaId);
      await pool.query(`UPDATE ${tabela} SET usado_em = now() WHERE id = $1`, [usado.id]);
      const pendente = await inserirPedido(pool, alvo, contaId);
      const deOutra = await inserirPedido(pool, alvo, await novaConta());

      assert.equal(await repo().cancelarPendentes(pool, contaId, 'SENHA_ALTERADA'), 1);
      assert.equal((await linha(pendente.id)).motivo_cancelamento, 'SENHA_ALTERADA');
      assert.equal((await linha(usado.id)).cancelado_em, null);
      assert.equal((await linha(deOutra.id)).cancelado_em, null);
      assert.equal(await repo().cancelarPendentes(pool, contaId, 'SENHA_ALTERADA'), 0, 'repetir não cancela de novo');
    });

    test('o executor é o da transação recebida: ROLLBACK desfaz a criação e o consumo', async () => {
      const contaId = await novaConta();
      const pendente = await inserirPedido(pool, alvo, await novaConta());
      const cliente = await pool.connect();
      let criado;
      try {
        await cliente.query('BEGIN');
        criado = await repo().criar(cliente, { [conta]: contaId, tokenHash: hashDeToken(), validadeMinutos: 60 });
        assert.equal(await repo().marcarUsada(cliente, pendente.id), true);
        await cliente.query('ROLLBACK');
      } finally {
        cliente.release();
      }
      assert.equal(await linha(criado.id), undefined, 'pedido criado na transação desfeita não existe');
      assert.equal((await linha(pendente.id)).usado_em, null, 'consumo desfeito');
    });

    test('concorrência real: duas conexões travam o mesmo pedido; a segunda espera a primeira e só um consumo vence', async () => {
      const pendente = await inserirPedido(pool, alvo, await novaConta());
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        const vistoPorA = await repo().buscarPorHashParaAtualizacao(a, pendente.token_hash);
        assert.equal(vistoPorA.situacao, 'PENDENTE');

        await b.query('BEGIN');
        const { rows: [{ pid }] } = await b.query('SELECT pg_backend_pid() AS pid');
        const leituraDeB = repo().buscarPorHashParaAtualizacao(b, pendente.token_hash);
        const evento = await aguardarEsperaPeloLock(pool, pid);
        assert.match(evento, /transactionid|tuple/, 'a segunda conexão ficou esperando o lock da linha');

        assert.equal(await repo().marcarUsada(a, vistoPorA.id), true);
        await a.query('COMMIT');

        const vistoPorB = await leituraDeB;
        assert.equal(vistoPorB.situacao, 'USADA', 'depois da espera, a segunda conexão enxerga o pedido já usado');
        assert.equal(await repo().marcarUsada(b, vistoPorB.id), false);
        await b.query('COMMIT');
      } finally {
        await a.query('ROLLBACK').catch(() => {});
        await b.query('ROLLBACK').catch(() => {});
        a.release();
        b.release();
      }
      const final = await linha(pendente.id);
      assert.ok(final.usado_em instanceof Date);
    });

    test('concorrência real sem trava prévia: dez consumos simultâneos do mesmo pedido, exatamente um vence', async () => {
      const pendente = await inserirPedido(pool, alvo, await novaConta());
      const resultados = await Promise.all(Array.from({ length: 10 }, () => repo().marcarUsada(pool, pendente.id)));
      assert.equal(resultados.filter((venceu) => venceu === true).length, 1);
      assert.equal(resultados.filter((venceu) => venceu === false).length, 9);
    });
  });
}
