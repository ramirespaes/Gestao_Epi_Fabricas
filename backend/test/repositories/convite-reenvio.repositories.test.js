'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const conviteMasterRepo = require('../../src/repositories/convite-master.repository');
const conviteUsuarioRepo = require('../../src/repositories/convite-usuario.repository');

/**
 * Contratos, sem PostgreSQL, das leituras que o reenvio e o teto de envios
 * (Bloco 11H) acrescentam aos repositórios de convite: SQL parametrizado,
 * filtro por empresa, validação antes de consultar e nada de token_hash na
 * saída. O comportamento real está em convite-reenvio.integration.js.
 */

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows: linhas, rowCount: linhas.length }; } };
};

const AGORA = new Date('2026-10-02T12:00:00.000Z');
const PRIMEIRO = new Date('2026-10-01T15:00:00.000Z');
const ULTIMO = new Date('2026-10-02T11:00:00.000Z');
const EMAIL = 'pessoa.convidada@exemplo-cliente.com.br';

const REPOSITORIOS = [
  ['convite-master', conviteMasterRepo, 'convites_master'],
  ['convite-usuario', conviteUsuarioRepo, 'convites_usuario'],
];

for (const [nome, repo, tabela] of REPOSITORIOS) {
  describe(`${nome}.repository — resumirEnvios`, () => {
    test('conta os convites do par (empresa, e-mail) na janela, parametrizado, com o relógio do banco', async () => {
      const ex = executorFalso([{ total: 3, primeiro_em: PRIMEIRO, ultimo_em: ULTIMO, agora: AGORA }]);
      const resumo = await repo.resumirEnvios(ex, 7, EMAIL, 24);

      assert.deepEqual(resumo, {
        total: 3, primeiroEm: PRIMEIRO, ultimoEm: ULTIMO, agora: AGORA,
      });
      assert.equal(ex.chamadas.length, 1);
      const { texto, valores } = ex.chamadas[0];
      assert.match(texto, new RegExp(`FROM ${tabela}\\b`));
      assert.match(texto, /empresa_id = \$1/);
      assert.match(texto, /email_convite\)? = \$2/);
      assert.match(texto, /criado_em > clock_timestamp\(\) - make_interval\(hours => \$3\)/);
      assert.match(texto, /clock_timestamp\(\) AS agora/);
      assert.deepEqual(valores, [7, EMAIL, 24]);
      assert.equal(texto.includes(EMAIL), false, 'o e-mail nunca é concatenado ao SQL');
    });

    test('sem convites na janela devolve total 0 e instantes nulos', async () => {
      const ex = executorFalso([{ total: 0, primeiro_em: null, ultimo_em: null, agora: AGORA }]);
      assert.deepEqual(await repo.resumirEnvios(ex, 7, EMAIL, 24), {
        total: 0, primeiroEm: null, ultimoEm: null, agora: AGORA,
      });
    });

    test('não projeta token_hash', async () => {
      const ex = executorFalso([{ total: 0, primeiro_em: null, ultimo_em: null, agora: AGORA }]);
      await repo.resumirEnvios(ex, 7, EMAIL, 24);
      assert.equal(/token_hash/i.test(ex.chamadas[0].texto), false);
    });

    test('recusa empresa, e-mail não normalizado e janela inválidos antes de consultar', async () => {
      const ex = executorFalso();
      await assert.rejects(() => repo.resumirEnvios(ex, 0, EMAIL, 24), TypeError);
      await assert.rejects(() => repo.resumirEnvios(ex, '7', EMAIL, 24), TypeError);
      await assert.rejects(() => repo.resumirEnvios(ex, 7, 'Pessoa@Exemplo.com', 24), /normalizado/);
      for (const janela of [0, -1, 1.5, '24', 24 * 30]) {
        await assert.rejects(() => repo.resumirEnvios(ex, 7, EMAIL, janela), TypeError, String(janela));
      }
      assert.deepEqual(ex.chamadas, []);
    });
  });
}

describe('convite-master.repository — buscarPorIdParaAtualizacao', () => {
  const linha = {
    id: '7', empresa_id: 3, email_convite: EMAIL, criado_por: 1, criado_em: PRIMEIRO, expira_em: AGORA, cancelado_em: null, aceito_em: null, identidade_id: null, usuario_id: null, vigente: false,
  };

  test('trava a linha com FOR UPDATE, filtrada pela empresa, e deriva a situação', async () => {
    const ex = executorFalso([linha]);
    const convite = await conviteMasterRepo.buscarPorIdParaAtualizacao(ex, 3, '7');
    assert.equal(convite.id, '7');
    assert.equal(convite.situacao, 'EXPIRADO');
    assert.equal('tokenHash' in convite || 'token_hash' in convite, false);
    assert.match(ex.chamadas[0].texto, /empresa_id = \$1 AND id = \$2[\s\S]*FOR UPDATE/);
    assert.deepEqual(ex.chamadas[0].valores, [3, '7']);
  });

  test('sem linha devolve null; identificador de convite precisa ser string decimal', async () => {
    assert.equal(await conviteMasterRepo.buscarPorIdParaAtualizacao(executorFalso([]), 3, '7'), null);
    const ex = executorFalso();
    await assert.rejects(() => conviteMasterRepo.buscarPorIdParaAtualizacao(ex, 3, 7), /convite/);
    await assert.rejects(() => conviteMasterRepo.buscarPorIdParaAtualizacao(ex, 0, '7'), TypeError);
    assert.deepEqual(ex.chamadas, []);
  });
});

describe('convite-usuario.repository — buscarPorId', () => {
  const linha = {
    id: '9', empresa_id: 3, email_convite: EMAIL, nome: 'Ana Souza', perfil: 'USUARIO', criado_por: 1, criado_em: PRIMEIRO, expira_em: AGORA, cancelado_em: null, aceito_em: null, identidade_id: null, usuario_id: null, vigente: true,
  };

  test('lê sem travar, filtrada pela empresa, sem token_hash', async () => {
    const ex = executorFalso([linha]);
    const convite = await conviteUsuarioRepo.buscarPorId(ex, 3, '9');
    assert.equal(convite.id, '9');
    assert.equal(convite.situacao, 'PENDENTE');
    assert.equal('tokenHash' in convite || 'token_hash' in convite, false);
    assert.match(ex.chamadas[0].texto, /c\.empresa_id = \$1 AND c\.id = \$2/);
    assert.equal(/FOR UPDATE/i.test(ex.chamadas[0].texto), false, 'a leitura que descobre o e-mail não pode travar a linha antes da trava consultiva');
    assert.deepEqual(ex.chamadas[0].valores, [3, '9']);
  });

  test('sem linha devolve null; identificadores inválidos são recusados antes de consultar', async () => {
    assert.equal(await conviteUsuarioRepo.buscarPorId(executorFalso([]), 3, '9'), null);
    const ex = executorFalso();
    await assert.rejects(() => conviteUsuarioRepo.buscarPorId(ex, 3, 9), /convite/);
    await assert.rejects(() => conviteUsuarioRepo.buscarPorId(ex, -1, '9'), TypeError);
    assert.deepEqual(ex.chamadas, []);
  });
});
