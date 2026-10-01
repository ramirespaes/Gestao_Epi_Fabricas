'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

/**
 * Contrato do repositório da trilha de auditoria da identidade global
 * (migration 064). Mesma disciplina de auditoria-plataforma.repository.js:
 * cada função fixa o próprio ator e nenhuma aceita o tipo de ator de quem
 * chama. Só INSERT, sem empresa, ação no padrão das outras trilhas (texto não
 * vazio de até 60 caracteres) e JSON sempre objeto.
 */

const CAMINHO = '../../src/repositories/auditoria-identidade.repository';
const repo = () => require(CAMINHO); // eslint-disable-line global-require
const CRIADO = new Date('2026-10-01T12:00:00Z');

const executorFalso = (linhas = [{ id: '91', criado_em: CRIADO }]) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: linhas.length };
    },
  };
};

const base = (extra = {}) => ({ identidadeId: 7, acao: 'SENHA_REDEFINIDA', ...extra });

const FUNCOES = [
  { nome: 'registrarDaIdentidade', ator: 'IDENTIDADE' },
  { nome: 'registrarEventoSistema', ator: 'SISTEMA' },
];

describe('auditoria-identidade.repository', () => {
  test('registrarDaIdentidade: um INSERT parametrizado em logs_auditoria_identidade, sem empresa, com ator IDENTIDADE; devolve id e instante do banco', async () => {
    const executor = executorFalso();
    const r = await repo().registrarDaIdentidade(executor, base({
      acao: 'SENHA_ALTERADA', referencia: '7', descricao: 'Troca de senha pela própria pessoa',
      ip: '203.0.113.7', dispositivo: 'Agente de Teste', contexto: { origem: 'portal', sessoesRevogadas: 2 },
      dadosAnteriores: null, dadosNovos: { pedidosCancelados: 1 },
    }));
    assert.deepEqual(r, { id: '91', criadoEm: CRIADO });
    assert.equal(executor.chamadas.length, 1);
    const [{ texto, valores }] = executor.chamadas;
    assert.match(texto, /INSERT INTO logs_auditoria_identidade/);
    assert.match(texto, /\(identidade_id, ator_tipo, acao, referencia, descricao, ip, dispositivo, contexto, dados_anteriores, dados_novos\)/);
    assert.match(texto, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10\)/);
    assert.match(texto, /RETURNING id, criado_em/);
    assert.equal(/empresa_id/.test(texto), false);
    assert.deepEqual(valores, [
      7, 'IDENTIDADE', 'SENHA_ALTERADA', '7', 'Troca de senha pela própria pessoa', '203.0.113.7', 'Agente de Teste',
      { origem: 'portal', sessoesRevogadas: 2 }, null, { pedidosCancelados: 1 },
    ]);
  });

  test('registrarEventoSistema: mesmo INSERT, com ator SISTEMA e a origem da requisição sem sessão', async () => {
    const executor = executorFalso();
    const r = await repo().registrarEventoSistema(executor, base({
      ip: '203.0.113.7', dispositivo: 'Agente de Teste', contexto: { origem: 'link', sessoesRevogadas: 3 },
    }));
    assert.deepEqual(r, { id: '91', criadoEm: CRIADO });
    const [{ texto, valores }] = executor.chamadas;
    assert.match(texto, /INSERT INTO logs_auditoria_identidade/);
    assert.deepEqual(valores, [
      7, 'SISTEMA', 'SENHA_REDEFINIDA', null, null, '203.0.113.7', 'Agente de Teste', { origem: 'link', sessoesRevogadas: 3 }, null, null,
    ]);
  });

  for (const { nome, ator } of FUNCOES) {
    describe(nome, () => {
      test('campos opcionais ausentes viram NULL e o ator é o da função', async () => {
        const executor = executorFalso();
        await repo()[nome](executor, base());
        assert.deepEqual(executor.chamadas[0].valores, [7, ator, 'SENHA_REDEFINIDA', null, null, null, null, null, null, null]);
      });

      test('quem chama não escolhe o ator: atorTipo é recusado, com qualquer valor, antes de qualquer consulta', async () => {
        for (const atorTipo of ['IDENTIDADE', 'SISTEMA', 'ADMINISTRADOR', ator, '', null, undefined]) {
          const executor = executorFalso();
          await assert.rejects(() => repo()[nome](executor, base({ atorTipo })), TypeError, JSON.stringify(atorTipo));
          assert.equal(executor.chamadas.length, 0, JSON.stringify(atorTipo));
        }
      });

      test('nenhum outro campo de quem chama altera o ator gravado', async () => {
        for (const extra of [{ ator: 'SISTEMA' }, { ator: 'IDENTIDADE' }, { ator_tipo: 'SISTEMA' }, { ator_tipo: 'IDENTIDADE' }, { tipoAtor: 'SISTEMA' }]) {
          const executor = executorFalso();
          await repo()[nome](executor, base(extra));
          assert.equal(executor.chamadas[0].valores[1], ator, JSON.stringify(extra));
        }
      });

      test('identidade obrigatória e ação vazia ou maior que 60 são recusadas antes de qualquer consulta', async () => {
        const ruins = [
          { identidadeId: undefined }, { identidadeId: null }, { identidadeId: 0 }, { identidadeId: -1 }, { identidadeId: '7' }, { identidadeId: 1.5 },
          { acao: '' }, { acao: 'A'.repeat(61) }, { acao: undefined }, { acao: 42 },
        ];
        for (const ruim of ruins) {
          const executor = executorFalso();
          await assert.rejects(() => repo()[nome](executor, base(ruim)), TypeError, JSON.stringify(ruim));
          assert.equal(executor.chamadas.length, 0);
        }
        const ok = executorFalso();
        await repo()[nome](ok, base({ acao: 'A'.repeat(60) }));
        assert.equal(ok.chamadas.length, 1, 'ação segue o padrão das outras trilhas: até 60 caracteres, sem formato próprio');
      });

      test('contexto, dadosAnteriores e dadosNovos precisam ser objeto ou null', async () => {
        for (const campo of ['contexto', 'dadosAnteriores', 'dadosNovos']) {
          for (const ruim of [[1, 2], 'texto', 5, true]) {
            const executor = executorFalso();
            await assert.rejects(() => repo()[nome](executor, base({ [campo]: ruim })), TypeError, `${campo} ${JSON.stringify(ruim)}`);
            assert.equal(executor.chamadas.length, 0);
          }
        }
      });

      test('erro do banco (inclusive a recusa de chave JSON sensível) é propagado sem tradução', async () => {
        const erro = Object.assign(new Error('logs_auditoria: campo JSONB contém chave sensível'), { code: 'P0001' });
        const executor = { query: async () => { throw erro; } };
        await assert.rejects(() => repo()[nome](executor, base({ contexto: { origem: 'link' } })), (e) => e === erro);
      });
    });
  }

  test('o módulo é só de inserção: exporta apenas as duas funções de ator fixo, nada genérico, e não importa o pool', () => {
    assert.deepEqual(Object.keys(repo()).sort(), ['registrarDaIdentidade', 'registrarEventoSistema']);
    const fonte = fs.readFileSync(require.resolve(CAMINHO), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const proibido of [/config\/database/, /\bUPDATE\b/, /\bDELETE\b/, /empresa_id/]) {
      assert.doesNotMatch(fonte, proibido, String(proibido));
    }
  });
});
