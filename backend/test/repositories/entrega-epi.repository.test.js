'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Contrato do cabeçalho da entrega de EPI (entregas_epi) na parte que a 12C
 * acrescenta: a origem. Até aqui o repositório gravava DIRETA fixo no SQL; agora
 * a origem é um parâmetro, DIRETA por padrão, e só DIRETA ou SOLICITACAO são
 * aceitas. O banco (CHECK da 066) é a autoridade; aqui confiro o contrato do
 * repositório e que a entrega DIRETA continua gravando exatamente como antes.
 */

const repo = () => exigirModulo('src/repositories/entrega-epi.repository');

const EMPRESA = 7;
const CHAVE = '3f6a2b1c-0d4e-4f5a-8b7c-9d0e1f2a3b4c';
const HASH = 'a'.repeat(64);

const executorFalso = (...respostas) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: respostas.length > 0 ? respostas.shift() : [] };
    },
  };
};

const linha = (extra = {}) => ({
  id: 11, empresa_id: EMPRESA, ficha_id: 3, responsavel_id: 9, ghe_id: 2, origem: 'DIRETA', entregue_em: new Date('2026-10-02T15:00:00Z'),
  entregue_em_canonico: '2026-10-02T15:00:00.000000Z', data_operacional: '2026-10-02', chave_idempotencia: CHAVE, requisicao_hash: HASH,
  empresa_nome: 'Empresa Fictícia', empresa_cnpj: '11222333000181', empresa_endereco: 'Rua 1', empresa_cidade: 'Cidade', empresa_uf: 'SP',
  trabalhador_nome: 'Trabalhador Fictício', trabalhador_matricula: 'M1', trabalhador_funcao: 'Função', trabalhador_setor: 'Setor',
  ghe_nome: 'GHE', responsavel_nome: 'Responsável', ...extra,
});

const dados = (extra = {}) => ({
  empresaId: EMPRESA,
  fichaId: 3,
  responsavelId: 9,
  gheId: 2,
  chave: CHAVE,
  requisicaoHash: HASH,
  empresa: { nome: 'Empresa Fictícia', cnpj: '11222333000181', endereco: 'Rua 1', cidade: 'Cidade', uf: 'SP' },
  trabalhador: { nome: 'Trabalhador Fictício', matricula: 'M1', funcao: 'Função', setor: 'Setor' },
  gheNome: 'GHE',
  responsavelNome: 'Responsável',
  ...extra,
});

describe('origens', () => {
  test('DIRETA e SOLICITACAO, congeladas', () => {
    assert.deepEqual([...repo().ORIGENS], ['DIRETA', 'SOLICITACAO']);
    assert.ok(Object.isFrozen(repo().ORIGENS));
  });
});

describe('criar — origem', () => {
  test('sem origem a entrega continua DIRETA, agora por parâmetro e não por texto fixo do SQL', async () => {
    const executor = executorFalso([linha()]);
    const entrega = await repo().criar(executor, dados());
    assert.equal(entrega.origem, 'DIRETA');
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^INSERT INTO entregas_epi\b/);
    assert.doesNotMatch(texto, /'DIRETA'|'SOLICITACAO'/, 'a origem é parâmetro');
    assert.deepEqual(valores.slice(0, 7), [EMPRESA, 3, 9, 2, 'DIRETA', CHAVE, HASH]);
    assert.equal(valores.length, 18, 'os 17 valores de antes, mais a origem');
    assert.match(texto, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, \$13, \$14, \$15, \$16, \$17, \$18\)/);
    assert.deepEqual(valores.slice(7), [
      'Empresa Fictícia', '11222333000181', 'Rua 1', 'Cidade', 'SP', 'Trabalhador Fictício', 'M1', 'Função', 'Setor', 'GHE', 'Responsável',
    ], 'as cópias congeladas seguem nas mesmas posições relativas');
  });

  test('a origem SOLICITACAO vai para o banco como parâmetro, na mesma posição', async () => {
    const executor = executorFalso([linha({ origem: 'SOLICITACAO' })]);
    const entrega = await repo().criar(executor, dados({ origem: 'SOLICITACAO' }));
    assert.equal(entrega.origem, 'SOLICITACAO');
    assert.equal(executor.chamadas[0].valores[4], 'SOLICITACAO');
  });

  test('origem fora de DIRETA e SOLICITACAO é recusada antes de consultar', async () => {
    const executor = executorFalso();
    for (const origem of ['AUTOATENDIMENTO', 'direta', '', null, 1, {}]) {
      await assert.rejects(() => repo().criar(executor, dados({ origem })), /origem/, String(origem));
    }
    assert.equal(executor.chamadas.length, 0);
  });

  test('o restante da validação não mudou: empresa, ficha, chave e hash continuam obrigatórios', async () => {
    const executor = executorFalso();
    await assert.rejects(() => repo().criar(executor, dados({ empresaId: 0 })), /empresa/);
    await assert.rejects(() => repo().criar(executor, dados({ fichaId: '3' })), /ficha/);
    await assert.rejects(() => repo().criar(executor, dados({ chave: 'x' })), /chave/);
    await assert.rejects(() => repo().criar(executor, dados({ requisicaoHash: 'zz' })), /hash/);
    assert.equal(executor.chamadas.length, 0);
  });
});
