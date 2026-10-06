'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const identidadeRepo = require('../../src/repositories/identidade.repository');
const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');
const sessaoGlobalRepo = require('../../src/repositories/sessao-global.repository');
const sessaoRepo = require('../../src/repositories/sessao.repository');

/**
 * Primitivas que o ciclo de senha (Bloco 11) acrescenta a repositórios já
 * existentes: gravar o hash novo da senha e revogar as sessões da identidade.
 * O hash chega pronto do serviço; nada aqui faz hash, decide regra de negócio
 * ou toca em MFA.
 */

const HASH_NOVO = '$argon2id$v=19$m=65536,t=3,p=1$c2FsLW5vdm8tZmljdGljaW8$aGFzaC1ub3ZvLWZpY3RpY2lvLWRlLXRlc3Rl';
const ATUALIZADO = new Date('2026-10-01T12:00:00Z');

const executorFalso = (linhas = [], rowCount) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: rowCount ?? linhas.length };
    },
  };
};

for (const { nome, repo, tabela, mensagemId } of [
  { nome: 'identidade.repository — atualizarSenhaHash', repo: identidadeRepo, tabela: 'identidades', mensagemId: /identidade/ },
  { nome: 'administrador-plataforma.repository — atualizarSenhaHash', repo: administradorRepo, tabela: 'administradores_plataforma', mensagemId: /administrador/ },
]) {
  describe(nome, () => {
    test('grava o hash recebido, sem transformá-lo, só na conta do id informado; devolve id e instante da atualização', async () => {
      const executor = executorFalso([{ id: 7, atualizado_em: ATUALIZADO }]);
      const r = await repo.atualizarSenhaHash(executor, 7, HASH_NOVO);
      assert.deepEqual(r, { id: 7, atualizadoEm: ATUALIZADO });
      assert.equal(executor.chamadas.length, 1);
      const [{ texto, valores }] = executor.chamadas;
      // identidades (074): a nova senha definitiva também encerra o estado provisório, no mesmo UPDATE.
      const limpezaProvisoria = tabela === 'identidades'
        ? ',\\s+senha_provisoria = false,\\s+senha_provisoria_definida_em = NULL,\\s+senha_provisoria_expira_em = NULL'
        : '';
      assert.match(texto, new RegExp(`UPDATE ${tabela}\\s+SET senha_hash = \\$2${limpezaProvisoria}\\s+WHERE id = \\$1\\s+RETURNING id, atualizado_em`));
      assert.deepEqual(valores, [7, HASH_NOVO]);
      assert.equal(texto.includes(HASH_NOVO), false, 'hash só por parâmetro');
    });

    test('conta inexistente devolve null', async () => {
      assert.equal(await repo.atualizarSenhaHash(executorFalso([]), 999, HASH_NOVO), null);
    });

    test('id inválido e hash vazio ou não textual são recusados antes de qualquer consulta', async () => {
      for (const [id, hash] of [[0, HASH_NOVO], [-1, HASH_NOVO], ['7', HASH_NOVO], [1.5, HASH_NOVO], [undefined, HASH_NOVO], [7, ''], [7, null], [7, undefined], [7, 123]]) {
        const executor = executorFalso([{ id: 7, atualizado_em: ATUALIZADO }]);
        await assert.rejects(() => repo.atualizarSenhaHash(executor, id, hash), TypeError, `${id} ${hash}`);
        assert.equal(executor.chamadas.length, 0);
      }
      await assert.rejects(() => repo.atualizarSenhaHash(executorFalso(), 0, HASH_NOVO), mensagemId);
    });

    test('só a senha muda: nenhuma outra coluna, tabela de MFA, sessão ou vínculo aparece no SQL', async () => {
      const executor = executorFalso([{ id: 7, atualizado_em: ATUALIZADO }]);
      await repo.atualizarSenhaHash(executor, 7, HASH_NOVO);
      const { texto } = executor.chamadas[0];
      for (const proibido of [/\bemail\b/, /\bativo\b/, /mfa/i, /fatores_/, /codigos_/, /desafios_/, /sessoes/, /usuarios/]) {
        assert.doesNotMatch(texto, proibido, String(proibido));
      }
    });
  });
}

describe('sessao-global.repository — revogarTodasDaIdentidade', () => {
  test('revoga todas as sessões globais ainda não revogadas da identidade e devolve quantas', async () => {
    const executor = executorFalso([], 3);
    assert.equal(await sessaoGlobalRepo.revogarTodasDaIdentidade(executor, 7, 'SENHA_REDEFINIDA'), 3);
    const [{ texto, valores }] = executor.chamadas;
    assert.match(texto, /UPDATE sessoes_globais/);
    assert.match(texto, /identidade_id = \$1/);
    assert.match(texto, /revogada_em IS NULL/);
    assert.match(texto, /motivo_revogacao = \$2/);
    assert.deepEqual(valores, [7, 'SENHA_REDEFINIDA', null], 'sem exceção: nenhuma sessão é preservada');
  });

  test('exceto preserva explicitamente a sessão atual da troca autenticada', async () => {
    const executor = executorFalso([], 2);
    assert.equal(await sessaoGlobalRepo.revogarTodasDaIdentidade(executor, 7, 'SENHA_ALTERADA', { exceto: '777' }), 2);
    const [{ texto, valores }] = executor.chamadas;
    assert.match(texto, /\$3::bigint IS NULL OR id <> \$3::bigint/);
    assert.deepEqual(valores, [7, 'SENHA_ALTERADA', '777']);
  });

  test('identidade, motivo e exceção inválidos são recusados antes de qualquer consulta', async () => {
    for (const [id, motivo, opcoes] of [[0, 'SENHA_ALTERADA', {}], ['7', 'SENHA_ALTERADA', {}], [7, 'senha alterada', {}], [7, '', {}], [7, 'SENHA_ALTERADA', { exceto: 777 }], [7, 'SENHA_ALTERADA', { exceto: '0' }]]) {
      const executor = executorFalso([], 0);
      await assert.rejects(() => sessaoGlobalRepo.revogarTodasDaIdentidade(executor, id, motivo, opcoes), TypeError, JSON.stringify([id, motivo, opcoes]));
      assert.equal(executor.chamadas.length, 0);
    }
  });
});

describe('sessao.repository — revogarTodasDaIdentidade', () => {
  test('revoga as sessões empresariais de todos os vínculos da identidade, em qualquer empresa, e devolve quantas', async () => {
    const executor = executorFalso([], 4);
    assert.equal(await sessaoRepo.revogarTodasDaIdentidade(executor, 7, 'SENHA_REDEFINIDA'), 4);
    const [{ texto, valores }] = executor.chamadas;
    assert.match(texto, /UPDATE sessoes\b/);
    assert.match(texto, /usuarios/);
    assert.match(texto, /identidade_id = \$1/);
    assert.match(texto, /revogada_em IS NULL/);
    assert.match(texto, /motivo_revogacao = \$2/);
    assert.equal(/empresa_id = \$/.test(texto), false, 'sem filtro de empresa vindo de parâmetro: alcança todas as empresas da identidade');
    assert.deepEqual(valores, [7, 'SENHA_REDEFINIDA', null]);
  });

  test('exceto preserva só a sessão empresarial atual da requisição; as demais caem, mesmo as nascidas da mesma sessão global', async () => {
    const executor = executorFalso([], 1);
    assert.equal(await sessaoRepo.revogarTodasDaIdentidade(executor, 7, 'SENHA_ALTERADA', { exceto: '555' }), 1);
    const [{ texto, valores }] = executor.chamadas;
    assert.match(texto, /\$3::bigint IS NULL OR (s\.)?id <> \$3::bigint/);
    assert.equal(/sessao_global_id/.test(texto), false, 'a exceção é a sessão empresarial, não a sessão global de origem');
    assert.deepEqual(valores, [7, 'SENHA_ALTERADA', '555']);
  });

  test('identidade, motivo e exceção inválidos são recusados antes de qualquer consulta', async () => {
    for (const [id, motivo, opcoes] of [[0, 'SENHA_ALTERADA', {}], ['7', 'SENHA_ALTERADA', {}], [7, 'senha alterada', {}], [7, 'SENHA_ALTERADA', { exceto: 555 }], [7, 'SENHA_ALTERADA', { exceto: 'abc' }], [7, 'SENHA_ALTERADA', { exceto: '0' }]]) {
      const executor = executorFalso([], 0);
      await assert.rejects(() => sessaoRepo.revogarTodasDaIdentidade(executor, id, motivo, opcoes), TypeError, JSON.stringify([id, motivo, opcoes]));
      assert.equal(executor.chamadas.length, 0);
    }
  });
});
