'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

/**
 * Contrato dos dois repositórios de pedidos de redefinição de senha:
 * identidades (migration 061) e administradores da plataforma (062). Mesmo
 * comportamento nas duas tabelas. Só o SHA-256 do token chega aqui; validade
 * e situação são decididas no SQL, pelo relógio do banco; o executor vem por
 * parâmetro.
 */

const MODULOS = [
  {
    nome: 'redefinicao-senha.repository (identidades)',
    caminho: '../../src/repositories/redefinicao-senha.repository',
    tabela: 'redefinicoes_senha',
    coluna: 'identidade_id',
    conta: 'identidadeId',
  },
  {
    nome: 'redefinicao-senha-plataforma.repository (administradores)',
    caminho: '../../src/repositories/redefinicao-senha-plataforma.repository',
    tabela: 'redefinicoes_senha_plataforma',
    coluna: 'administrador_id',
    conta: 'administradorId',
  },
];

const HASH = 'a'.repeat(64);
const TOKEN_EM_CLARO = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const CONTA_ID = 7;
const PEDIDO = '15';
const CRIADO = new Date('2026-10-01T12:00:00Z');
const EXPIRA = new Date('2026-10-01T13:00:00Z');

/** Executor falso: devolve as respostas na ordem das consultas. */
function executorFalso(...respostas) {
  const chamadas = [];
  let i = 0;
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      const r = respostas[Math.min(i, respostas.length - 1)] || {};
      i += 1;
      return { rows: r.rows || [], rowCount: r.rowCount ?? (r.rows ? r.rows.length : 0) };
    },
  };
}

for (const { nome, caminho, tabela, coluna, conta } of MODULOS) {
  const repo = () => require(caminho); // eslint-disable-line global-require
  const linha = (extra = {}) => ({
    id: PEDIDO, [coluna]: CONTA_ID, criado_em: CRIADO, expira_em: EXPIRA, usado_em: null, cancelado_em: null, motivo_cancelamento: null, vigente: true, ...extra,
  });

  describe(nome, () => {
    test('criar: cancela o pendente da conta e depois insere só o hash; a validade é somada no banco e criado_em não é enviado', async () => {
      const executor = executorFalso({ rowCount: 1 }, { rows: [{ id: PEDIDO, criado_em: CRIADO, expira_em: EXPIRA }] });
      const r = await repo().criar(executor, { [conta]: CONTA_ID, tokenHash: HASH, validadeMinutos: 60, ip: '203.0.113.7', dispositivo: 'Agente de Teste' });

      assert.deepEqual(r, { id: PEDIDO, criadoEm: CRIADO, expiraEm: EXPIRA, substituidos: 1 });
      assert.equal(executor.chamadas.length, 2);
      const [cancelar, inserir] = executor.chamadas;
      assert.match(cancelar.texto, new RegExp(`UPDATE ${tabela}\\b`));
      assert.match(cancelar.texto, new RegExp(`${coluna} = \\$1`));
      assert.match(cancelar.texto, /usado_em IS NULL/);
      assert.match(cancelar.texto, /cancelado_em IS NULL/);
      assert.equal(cancelar.valores[0], CONTA_ID);
      assert.equal(`${cancelar.texto} ${cancelar.valores.join(' ')}`.includes('SUBSTITUIDA'), true, 'motivo do cancelamento');

      assert.match(inserir.texto, new RegExp(`INSERT INTO ${tabela}\\b`));
      const colunasInseridas = inserir.texto.match(new RegExp(`INSERT INTO ${tabela}\\s*\\(([^)]*)\\)`))[1];
      assert.equal(/criado_em/.test(colunasInseridas), false, 'criado_em é do banco');
      assert.match(inserir.texto, /(now\(\)|clock_timestamp\(\))\s*\+/, 'expira_em somado no banco');
      assert.equal(inserir.valores.includes(HASH), true);
      assert.equal(inserir.valores.includes(60), true);
      assert.equal(inserir.valores.some((v) => v instanceof Date), false, 'nenhuma data vem do relógio da aplicação');
      for (const { texto, valores } of executor.chamadas) {
        assert.equal(texto.includes(HASH), false, 'valores só por parâmetro');
        assert.match(texto, /\$1/);
        assert.equal(valores.every((v) => v !== TOKEN_EM_CLARO), true);
      }
    });

    test('criar: sem pendente anterior devolve substituidos 0', async () => {
      const executor = executorFalso({ rowCount: 0 }, { rows: [{ id: PEDIDO, criado_em: CRIADO, expira_em: EXPIRA }] });
      const r = await repo().criar(executor, { [conta]: CONTA_ID, tokenHash: HASH, validadeMinutos: 240 });
      assert.equal(r.substituidos, 0);
      assert.deepEqual(executor.chamadas[1].valores.slice(-2), [null, null], 'ip e dispositivo são opcionais');
    });

    test('criar: token em claro, hash fora do formato, conta inválida e validade fora de 1 a 240 minutos são recusados antes de qualquer consulta', async () => {
      const base = { [conta]: CONTA_ID, tokenHash: HASH, validadeMinutos: 60 };
      const ruins = [
        { tokenHash: TOKEN_EM_CLARO }, { tokenHash: 'A'.repeat(64) }, { tokenHash: 'a'.repeat(63) }, { tokenHash: undefined },
        { [conta]: 0 }, { [conta]: -1 }, { [conta]: '7' }, { [conta]: 1.5 },
        { validadeMinutos: 0 }, { validadeMinutos: 241 }, { validadeMinutos: 60.5 }, { validadeMinutos: '60' }, { validadeMinutos: undefined },
      ];
      for (const ruim of ruins) {
        const executor = executorFalso();
        await assert.rejects(() => repo().criar(executor, { ...base, ...ruim }), TypeError, JSON.stringify(ruim));
        assert.equal(executor.chamadas.length, 0, JSON.stringify(ruim));
      }
    });

    test('buscarPorHash: localiza pelo hash e decide a situação no SQL, pelo relógio do banco; sem linha devolve null', async () => {
      const casos = [
        [linha(), 'PENDENTE'],
        [linha({ vigente: false }), 'EXPIRADA'],
        [linha({ usado_em: EXPIRA, vigente: false }), 'USADA'],
        [linha({ cancelado_em: CRIADO, motivo_cancelamento: 'SUBSTITUIDA' }), 'CANCELADA'],
      ];
      for (const [registro, situacao] of casos) {
        const executor = executorFalso({ rows: [registro] });
        const r = await repo().buscarPorHash(executor, HASH);
        assert.deepEqual(r, {
          id: PEDIDO, [conta]: CONTA_ID, criadoEm: CRIADO, expiraEm: EXPIRA,
          usadoEm: registro.usado_em, canceladoEm: registro.cancelado_em, motivoCancelamento: registro.motivo_cancelamento, situacao,
        });
        const [{ texto, valores }] = executor.chamadas;
        assert.match(texto, new RegExp(`FROM ${tabela}\\b`));
        assert.match(texto, /token_hash = \$1/);
        assert.match(texto, /expira_em > (now\(\)|clock_timestamp\(\))/);
        assert.equal(/FOR UPDATE/.test(texto), false, 'a leitura simples não trava a linha');
        assert.deepEqual(valores, [HASH]);
      }
      assert.equal(await repo().buscarPorHash(executorFalso({ rows: [] }), HASH), null);
      assert.deepEqual(repo().SITUACAO, { PENDENTE: 'PENDENTE', USADA: 'USADA', CANCELADA: 'CANCELADA', EXPIRADA: 'EXPIRADA' });
    });

    test('buscarPorHashParaAtualizacao: mesma leitura, travando a linha do pedido (FOR UPDATE)', async () => {
      const executor = executorFalso({ rows: [linha()] });
      const r = await repo().buscarPorHashParaAtualizacao(executor, HASH);
      assert.equal(r.situacao, 'PENDENTE');
      assert.match(executor.chamadas[0].texto, /FOR UPDATE/);
      assert.deepEqual(executor.chamadas[0].valores, [HASH]);
      assert.equal(await repo().buscarPorHashParaAtualizacao(executorFalso({ rows: [] }), HASH), null);
    });

    test('buscas recusam token em claro e hash fora do formato antes de qualquer consulta', async () => {
      for (const funcao of ['buscarPorHash', 'buscarPorHashParaAtualizacao']) {
        for (const ruim of [TOKEN_EM_CLARO, 'A'.repeat(64), '', null, undefined, 123]) {
          const executor = executorFalso();
          await assert.rejects(() => repo()[funcao](executor, ruim), TypeError, `${funcao} ${ruim}`);
          assert.equal(executor.chamadas.length, 0);
        }
      }
    });

    test('marcarUsada: UPDATE condicionado a pendente e dentro da validade pelo relógio do banco; devolve se este consumo venceu', async () => {
      const venceu = executorFalso({ rowCount: 1 });
      assert.equal(await repo().marcarUsada(venceu, PEDIDO), true);
      const [{ texto, valores }] = venceu.chamadas;
      assert.match(texto, new RegExp(`UPDATE ${tabela}\\b`));
      assert.match(texto, /SET usado_em = (now\(\)|clock_timestamp\(\))/);
      assert.match(texto, /id = \$1/);
      assert.match(texto, /usado_em IS NULL/);
      assert.match(texto, /cancelado_em IS NULL/);
      assert.match(texto, /expira_em > (now\(\)|clock_timestamp\(\))/);
      assert.deepEqual(valores, [PEDIDO]);
      assert.equal(await repo().marcarUsada(executorFalso({ rowCount: 0 }), PEDIDO), false, 'usado, cancelado, expirado ou inexistente');
      for (const ruim of [15, '0', '-1', '1.5', 'abc', null, undefined]) {
        const executor = executorFalso();
        await assert.rejects(() => repo().marcarUsada(executor, ruim), TypeError, String(ruim));
        assert.equal(executor.chamadas.length, 0);
      }
    });

    test('cancelarPendentes: por conta, com motivo no formato do banco; devolve quantos pedidos cancelou', async () => {
      const executor = executorFalso({ rowCount: 2 });
      assert.equal(await repo().cancelarPendentes(executor, CONTA_ID, 'SENHA_ALTERADA'), 2);
      const [{ texto, valores }] = executor.chamadas;
      assert.match(texto, new RegExp(`UPDATE ${tabela}\\b`));
      assert.match(texto, new RegExp(`${coluna} = \\$1`));
      assert.match(texto, /usado_em IS NULL/);
      assert.match(texto, /cancelado_em IS NULL/);
      assert.deepEqual(valores, [CONTA_ID, 'SENHA_ALTERADA']);
      for (const [contaId, motivo] of [[0, 'SENHA_ALTERADA'], [CONTA_ID, 'senha alterada'], [CONTA_ID, ''], [CONTA_ID, 'A'.repeat(31)], [CONTA_ID, undefined]]) {
        const vazio = executorFalso();
        await assert.rejects(() => repo().cancelarPendentes(vazio, contaId, motivo), TypeError);
        assert.equal(vazio.chamadas.length, 0);
      }
    });

    test('o módulo só exporta o contrato, não importa o pool nem faz hash ou gera token', () => {
      assert.deepEqual(Object.keys(repo()).sort(), ['SITUACAO', 'buscarPorHash', 'buscarPorHashParaAtualizacao', 'cancelarPendentes', 'criar', 'marcarUsada']);
      const fonte = fs.readFileSync(require.resolve(caminho), 'utf8');
      for (const proibido of [/config\/database/, /require\('argon2'\)/, /security\/password/, /security\/token/, /randomBytes/, /createHash/]) {
        assert.doesNotMatch(fonte, proibido, String(proibido));
      }
    });
  });
}
