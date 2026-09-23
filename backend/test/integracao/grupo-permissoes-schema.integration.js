'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');

/**
 * Estrutura PostgreSQL da migration 021 (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3B): tabelas `grupo_permissoes_recurso` e `grupo_permissoes_acao`.
 *
 * Testa exclusivamente estrutura de banco — constraints, FK composta,
 * tri-state por coluna — nunca repository, middleware ou lógica de
 * autorização (nada disso foi alterado nesta subetapa; a existência de
 * uma linha aqui ainda não produz nenhum efeito sobre autorização). As
 * asserções usam o cliente PostgreSQL diretamente, no mesmo padrão de
 * grupos-acesso-schema.integration.js e autorizacao-individual-schema.integration.js.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito.
 */

const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';

const MIGRATIONS = ['000', '001', '002', '003', '005', '013', '016', '020', '021'];

const inserirUsuario = async (cliente, empresaId, email, extra = {}) => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [empresaId, 'Usuário Teste', email, '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28', extra.perfil ?? 'MASTER'],
  );
  return rows[0].id;
};

const inserirGrupo = async (cliente, empresaId, nome, criadoPor) => {
  const { rows } = await cliente.query(
    'INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id',
    [empresaId, nome, criadoPor],
  );
  return rows[0].id;
};

/** Executa um INSERT em grupo_permissoes_recurso e devolve 'ok' ou o SQLSTATE do erro. */
const criarPermissaoRecurso = async (cliente, { empresaId, grupoId, recurso, flags = {} }) => {
  try {
    await cliente.query(
      `INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [empresaId, grupoId, recurso, flags.podeVisualizar ?? null, flags.podeCriar ?? null, flags.podeEditar ?? null, flags.podeExcluir ?? null],
    );
    return 'ok';
  } catch (erro) {
    return erro.code;
  }
};

/** Executa um INSERT em grupo_permissoes_acao e devolve 'ok' ou o SQLSTATE do erro. */
const criarPermissaoAcao = async (cliente, { empresaId, grupoId, acaoCodigo, permitido = null }) => {
  try {
    await cliente.query(
      'INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido) VALUES ($1, $2, $3, $4)',
      [empresaId, grupoId, acaoCodigo, permitido],
    );
    return 'ok';
  } catch (erro) {
    return erro.code;
  }
};

describe('migration 021 — grupo_permissoes_recurso e grupo_permissoes_acao', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let masterA;
  let grupoA;
  let grupoB;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    assert.equal(await inserirEmpresa(contexto.cliente, '12345678000195', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, '98765432000110', 'Empresa B'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '12345678000195').id;
    empresaB = rows.find((e) => e.cnpj === '98765432000110').id;

    masterA = await inserirUsuario(contexto.cliente, empresaA, 'master-a@demo.safeworkengenharia.com.br');
    const masterB = await inserirUsuario(contexto.cliente, empresaB, 'master-b@demo.safeworkengenharia.com.br');

    grupoA = await inserirGrupo(contexto.cliente, empresaA, 'Almoxarifado Operacional', masterA);
    grupoB = await inserirGrupo(contexto.cliente, empresaB, 'Almoxarifado Operacional', masterB);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('grupo_permissoes_recurso', () => {
    test('cria permissão de recurso no grupo, com TRUE/FALSE/NULL preservados por operação', async () => {
      assert.equal(
        await criarPermissaoRecurso(contexto.cliente, {
          empresaId: empresaA, grupoId: grupoA, recurso: 'materials',
          flags: { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null },
        }),
        'ok',
      );

      const { rows } = await contexto.cliente.query(
        'SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = $2',
        [grupoA, 'materials'],
      );
      assert.deepEqual(rows[0], { pode_visualizar: true, pode_criar: false, pode_editar: null, pode_excluir: null });
    });

    test('mesmo grupo pode ter permissões para recursos diferentes', async () => {
      assert.equal(
        await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, grupoId: grupoA, recurso: 'stockValidity', flags: { podeVisualizar: true } }),
        'ok',
      );
      const { rows } = await contexto.cliente.query('SELECT recurso FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 ORDER BY recurso', [grupoA]);
      assert.deepEqual(rows.map((r) => r.recurso).sort(), ['materials', 'stockValidity']);
    });

    test('configurações são independentes por operação: alterar uma coluna não presume as demais', async () => {
      await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, grupoId: grupoA, recurso: 'purchases', flags: { podeVisualizar: true, podeCriar: true } });
      await contexto.cliente.query(
        'UPDATE grupo_permissoes_recurso SET pode_editar = false WHERE grupo_acesso_id = $1 AND recurso = $2',
        [grupoA, 'purchases'],
      );

      const { rows } = await contexto.cliente.query(
        'SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = $2',
        [grupoA, 'purchases'],
      );
      assert.deepEqual(rows[0], { pode_visualizar: true, pode_criar: true, pode_editar: false, pode_excluir: null }, 'visualizar/criar não podem ter sido afetados ao só alterar editar');
    });

    test('rejeita recurso duplicado no mesmo grupo', async () => {
      await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, grupoId: grupoA, recurso: 'availableItems', flags: { podeVisualizar: true } });
      const resultado = await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, grupoId: grupoA, recurso: 'availableItems', flags: { podeVisualizar: false } });
      assert.equal(resultado, VIOLACAO_UNIQUE);
    });

    test('o mesmo recurso em grupos diferentes coexiste sem colisão', async () => {
      assert.equal(await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, grupoId: grupoA, recurso: 'deliveredItems', flags: { podeVisualizar: true } }), 'ok');
      assert.equal(await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaB, grupoId: grupoB, recurso: 'deliveredItems', flags: { podeVisualizar: false } }), 'ok');
    });

    test('rejeita quando o grupo pertence a outra empresa (empresa_id divergente)', async () => {
      const resultado = await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaB, grupoId: grupoA, recurso: 'epiFicha', flags: { podeVisualizar: true } });
      assert.equal(resultado, VIOLACAO_FK, 'grupo de empresa diferente da informada deve ser rejeitado pela FK composta');
    });

    test('preserva os registros ao inativar o grupo: a linha continua existindo (histórico)', async () => {
      const grupoDescartavel = await inserirGrupo(contexto.cliente, empresaA, 'Grupo Para Inativar', masterA);
      await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, grupoId: grupoDescartavel, recurso: 'reports', flags: { podeVisualizar: true } });

      await contexto.cliente.query('UPDATE grupos_acesso SET ativo = false WHERE id = $1', [grupoDescartavel]);

      const { rows } = await contexto.cliente.query('SELECT pode_visualizar FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1', [grupoDescartavel]);
      assert.equal(rows.length, 1, 'inativar o grupo não pode apagar sua configuração de permissão');
      assert.equal(rows[0].pode_visualizar, true);
    });
  });

  describe('grupo_permissoes_acao', () => {
    test('cria permissão de ação no grupo, com TRUE/FALSE/NULL preservados', async () => {
      assert.equal(await criarPermissaoAcao(contexto.cliente, { empresaId: empresaA, grupoId: grupoA, acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: true }), 'ok');
      assert.equal(await criarPermissaoAcao(contexto.cliente, { empresaId: empresaA, grupoId: grupoA, acaoCodigo: 'REALIZAR_ENTREGA', permitido: false }), 'ok');

      const { rows } = await contexto.cliente.query(
        'SELECT acao_codigo, permitido FROM grupo_permissoes_acao WHERE grupo_acesso_id = $1 ORDER BY acao_codigo',
        [grupoA],
      );
      assert.deepEqual(rows, [
        { acao_codigo: 'MOVIMENTAR_ESTOQUE', permitido: true },
        { acao_codigo: 'REALIZAR_ENTREGA', permitido: false },
      ]);
    });

    test('permitido NULL (sem opinião do grupo) é aceito e preservado', async () => {
      assert.equal(await criarPermissaoAcao(contexto.cliente, { empresaId: empresaA, grupoId: grupoA, acaoCodigo: 'IMPORTAR_FUNCIONARIOS', permitido: null }), 'ok');

      const { rows } = await contexto.cliente.query(
        'SELECT permitido FROM grupo_permissoes_acao WHERE grupo_acesso_id = $1 AND acao_codigo = $2',
        [grupoA, 'IMPORTAR_FUNCIONARIOS'],
      );
      assert.equal(rows[0].permitido, null);
    });

    test('rejeita ação duplicada no mesmo grupo', async () => {
      const resultado = await criarPermissaoAcao(contexto.cliente, { empresaId: empresaA, grupoId: grupoA, acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: false });
      assert.equal(resultado, VIOLACAO_UNIQUE);
    });

    test('a mesma ação em grupos diferentes coexiste sem colisão', async () => {
      assert.equal(await criarPermissaoAcao(contexto.cliente, { empresaId: empresaB, grupoId: grupoB, acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: true }), 'ok');
    });

    test('rejeita quando o grupo pertence a outra empresa (empresa_id divergente)', async () => {
      const resultado = await criarPermissaoAcao(contexto.cliente, { empresaId: empresaB, grupoId: grupoA, acaoCodigo: 'GERENCIAR_USUARIOS', permitido: true });
      assert.equal(resultado, VIOLACAO_FK, 'grupo de empresa diferente da informada deve ser rejeitado pela FK composta');
    });

    test('rejeita código de ação inexistente no catálogo', async () => {
      const resultado = await criarPermissaoAcao(contexto.cliente, { empresaId: empresaA, grupoId: grupoA, acaoCodigo: 'ACAO_QUE_NAO_EXISTE', permitido: true });
      assert.equal(resultado, VIOLACAO_FK);
    });

    test('preserva os registros ao inativar o grupo: a linha continua existindo (histórico)', async () => {
      const grupoDescartavel = await inserirGrupo(contexto.cliente, empresaA, 'Grupo Para Inativar Acao', masterA);
      await criarPermissaoAcao(contexto.cliente, { empresaId: empresaA, grupoId: grupoDescartavel, acaoCodigo: 'ALTERAR_CONFIGURACOES', permitido: false });

      await contexto.cliente.query('UPDATE grupos_acesso SET ativo = false WHERE id = $1', [grupoDescartavel]);

      const { rows } = await contexto.cliente.query('SELECT permitido FROM grupo_permissoes_acao WHERE grupo_acesso_id = $1', [grupoDescartavel]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].permitido, false);
    });
  });
});
