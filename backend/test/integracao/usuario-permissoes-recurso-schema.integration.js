'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Estrutura PostgreSQL da migration 022 (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3E): tabela `usuario_permissoes_recurso`.
 *
 * Testa exclusivamente estrutura de banco — constraints, FK composta,
 * tri-state por coluna — nunca repository, middleware ou lógica de
 * autorização (nada disso foi alterado nesta subetapa; a existência de uma
 * linha aqui ainda não produz nenhum efeito sobre autorização). Mesmo
 * padrão de grupo-permissoes-schema.integration.js (021) e
 * grupos-acesso-schema.integration.js (020), agora no nível individual —
 * o último elo da cadeia perfil -> grupo -> usuário para permissões de
 * recurso.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito.
 */

const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';

const MIGRATIONS = ['000', '001', '002', '005', '013', '016', '022'];

const inserirUsuario = async (cliente, empresaId, email, extra = {}) => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [empresaId, 'Usuário Teste', email, '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28', extra.perfil ?? 'MASTER'],
  );
  return rows[0].id;
};

/** Executa um INSERT em usuario_permissoes_recurso e devolve 'ok' ou o SQLSTATE do erro. */
const criarPermissaoRecurso = async (cliente, { empresaId, usuarioId, recurso, concedidoPor, flags = {} }) => {
  try {
    await cliente.query(
      `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [empresaId, usuarioId, recurso, flags.podeVisualizar ?? null, flags.podeCriar ?? null, flags.podeEditar ?? null, flags.podeExcluir ?? null, concedidoPor],
    );
    return 'ok';
  } catch (erro) {
    return erro.code;
  }
};

describe('migration 022 — usuario_permissoes_recurso', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let masterA;
  let masterB;
  let usuarioA;
  let usuarioB;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    assert.equal(await inserirEmpresa(contexto.cliente, '12345678000195', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, '98765432000110', 'Empresa B'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '12345678000195').id;
    empresaB = rows.find((e) => e.cnpj === '98765432000110').id;

    masterA = await inserirUsuario(contexto.cliente, empresaA, 'master-a@demo.safeworkengenharia.com.br');
    masterB = await inserirUsuario(contexto.cliente, empresaB, 'master-b@demo.safeworkengenharia.com.br');
    usuarioA = await inserirUsuario(contexto.cliente, empresaA, 'usuario-a@demo.safeworkengenharia.com.br', { perfil: 'ADMINISTRADOR' });
    usuarioB = await inserirUsuario(contexto.cliente, empresaB, 'usuario-b@demo.safeworkengenharia.com.br', { perfil: 'ADMINISTRADOR' });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cria exceção individual de recurso, com TRUE/FALSE/NULL preservados por operação', async () => {
    assert.equal(
      await criarPermissaoRecurso(contexto.cliente, {
        empresaId: empresaA, usuarioId: usuarioA, recurso: 'materials', concedidoPor: masterA,
        flags: { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null },
      }),
      'ok',
    );

    const { rows } = await contexto.cliente.query(
      'SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = $2',
      [usuarioA, 'materials'],
    );
    assert.deepEqual(rows[0], { pode_visualizar: true, pode_criar: false, pode_editar: null, pode_excluir: null });
  });

  test('mesmo usuário pode ter exceções para recursos diferentes', async () => {
    assert.equal(
      await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, recurso: 'stockValidity', concedidoPor: masterA, flags: { podeVisualizar: true } }),
      'ok',
    );
    const { rows } = await contexto.cliente.query('SELECT recurso FROM usuario_permissoes_recurso WHERE usuario_id = $1 ORDER BY recurso', [usuarioA]);
    assert.deepEqual(rows.map((r) => r.recurso).sort(), ['materials', 'stockValidity']);
  });

  test('configurações são independentes por operação: alterar uma coluna não presume as demais', async () => {
    await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, recurso: 'purchases', concedidoPor: masterA, flags: { podeVisualizar: true, podeCriar: true } });
    await contexto.cliente.query(
      'UPDATE usuario_permissoes_recurso SET pode_editar = false WHERE usuario_id = $1 AND recurso = $2',
      [usuarioA, 'purchases'],
    );

    const { rows } = await contexto.cliente.query(
      'SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM usuario_permissoes_recurso WHERE usuario_id = $1 AND recurso = $2',
      [usuarioA, 'purchases'],
    );
    assert.deepEqual(rows[0], { pode_visualizar: true, pode_criar: true, pode_editar: false, pode_excluir: null }, 'visualizar/criar não podem ter sido afetados ao só alterar editar');
  });

  test('rejeita recurso duplicado para o mesmo usuário', async () => {
    await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, recurso: 'availableItems', concedidoPor: masterA, flags: { podeVisualizar: true } });
    const resultado = await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, recurso: 'availableItems', concedidoPor: masterA, flags: { podeVisualizar: false } });
    assert.equal(resultado, VIOLACAO_UNIQUE);
  });

  test('o mesmo recurso em usuários diferentes coexiste sem colisão', async () => {
    assert.equal(await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, recurso: 'deliveredItems', concedidoPor: masterA, flags: { podeVisualizar: true } }), 'ok');
    assert.equal(await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaB, usuarioId: usuarioB, recurso: 'deliveredItems', concedidoPor: masterB, flags: { podeVisualizar: false } }), 'ok');
  });

  test('rejeita quando o usuário beneficiário pertence a outra empresa (empresa_id divergente)', async () => {
    const resultado = await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaB, usuarioId: usuarioA, recurso: 'epiFicha', concedidoPor: masterB, flags: { podeVisualizar: true } });
    assert.equal(resultado, VIOLACAO_FK, 'usuário de empresa diferente da informada deve ser rejeitado pela FK composta');
  });

  test('rejeita quando o concessor pertence a outra empresa (empresa_id divergente)', async () => {
    const resultado = await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, recurso: 'reports', concedidoPor: masterB, flags: { podeVisualizar: true } });
    assert.equal(resultado, VIOLACAO_FK, 'concessor de empresa diferente da do beneficiário deve ser rejeitado pela FK composta');
  });

  test('concessor não pode ser removido enquanto conceder uma exceção (RESTRICT)', async () => {
    const concessorDescartavel = await inserirUsuario(contexto.cliente, empresaA, 'concessor-descartavel@demo.safeworkengenharia.com.br');
    await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, recurso: 'auditLogs', concedidoPor: concessorDescartavel, flags: { podeVisualizar: true } });

    await assert.rejects(
      contexto.cliente.query('DELETE FROM usuarios WHERE id = $1', [concessorDescartavel]),
      (erro) => erro.code === VIOLACAO_FK,
      'remover o concessor enquanto ele concedeu uma exceção deve ser bloqueado pela FK RESTRICT',
    );
  });

  test('remover o usuário beneficiário remove em cascata sua própria exceção (CASCADE)', async () => {
    const usuarioDescartavel = await inserirUsuario(contexto.cliente, empresaA, 'beneficiario-descartavel@demo.safeworkengenharia.com.br');
    await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioDescartavel, recurso: 'settings', concedidoPor: masterA, flags: { podeVisualizar: true } });

    await contexto.cliente.query('DELETE FROM usuarios WHERE id = $1', [usuarioDescartavel]);

    const { rows } = await contexto.cliente.query('SELECT id FROM usuario_permissoes_recurso WHERE usuario_id = $1', [usuarioDescartavel]);
    assert.equal(rows.length, 0, 'a exceção do usuário removido não pode sobreviver órfã');
  });

  test('preserva a exceção ao inativar o usuário (ativo=false): a linha continua existindo', async () => {
    const usuarioParaInativar = await inserirUsuario(contexto.cliente, empresaA, 'inativavel@demo.safeworkengenharia.com.br');
    await criarPermissaoRecurso(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioParaInativar, recurso: 'dashboard', concedidoPor: masterA, flags: { podeVisualizar: false } });

    await contexto.cliente.query('UPDATE usuarios SET ativo = false WHERE id = $1', [usuarioParaInativar]);

    const { rows } = await contexto.cliente.query('SELECT pode_visualizar FROM usuario_permissoes_recurso WHERE usuario_id = $1', [usuarioParaInativar]);
    assert.equal(rows.length, 1, 'inativar o usuário não pode apagar sua exceção');
    assert.equal(rows[0].pode_visualizar, false);
  });

  test('trigger de atualizado_em: UPDATE avança atualizado_em', async () => {
    const { rows: criado } = await contexto.cliente.query(
      `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por)
       VALUES ($1, $2, $3, true, $4) RETURNING id, atualizado_em`,
      [empresaA, usuarioA, 'trigger-teste', masterA],
    );

    await contexto.cliente.query('UPDATE usuario_permissoes_recurso SET pode_visualizar = false WHERE id = $1', [criado[0].id]);

    const { rows: atualizado } = await contexto.cliente.query('SELECT atualizado_em FROM usuario_permissoes_recurso WHERE id = $1', [criado[0].id]);
    assert.ok(atualizado[0].atualizado_em.getTime() >= criado[0].atualizado_em.getTime());
  });
});

/**
 * Prova de compatibilidade explícita: um banco que já tinha empresa e
 * usuário cadastrados ANTES de 022 existir sobrevive intacto à aplicação
 * da migration — 022 é puramente aditiva (cria uma tabela nova; não altera
 * nenhuma coluna de `usuarios` nem de nenhuma tabela existente), mesmo
 * padrão de robustez já provado para 020 em
 * grupos-acesso-schema.integration.js.
 */
describe('transição de um banco já populado antes da migration 022', () => {
  test('usuário e empresa inseridos com as migrations anteriores sobrevivem intactos à aplicação da 022, e a nova tabela nasce vazia', async () => {
    // 1) Schema temporário só com as migrations anteriores a 022.
    const contexto = await abrirSchemaTemporario(['000', '001', '002', '005', '013', '016']);
    try {
      // 2) Insere empresa e usuário no formato que já existia antes de
      // usuario_permissoes_recurso ser sequer cogitada.
      assert.equal(await inserirEmpresa(contexto.cliente, '11222333000181', 'Empresa Preexistente'), 'ok');
      const { rows: empresas } = await contexto.cliente.query('SELECT id FROM empresas WHERE cnpj = $1', ['11222333000181']);
      const empresaId = empresas[0].id;

      const { rows: usuarioInserido } = await contexto.cliente.query(
        `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo, biometria_cadastrada)
         VALUES ($1, 'João Preexistente', 'joao-preexistente@demo.safeworkengenharia.com.br', $2, 'SUPERVISOR', true, true)
         RETURNING id, nome, email, perfil, ativo, biometria_cadastrada, criado_em`,
        [empresaId, '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28'],
      );
      const usuarioId = usuarioInserido[0].id;

      // 3) Aplica o SQL real da migration 022 sobre esse schema já
      // populado. Falha aqui aborta o teste com o erro real do PostgreSQL.
      await contexto.cliente.query(conteudoDaMigration('022'));

      // 4) Consulta o mesmo usuário depois da migration.
      const { rows: usuarioDepois } = await contexto.cliente.query(
        'SELECT id, nome, email, perfil, ativo, biometria_cadastrada, criado_em FROM usuarios WHERE id = $1',
        [usuarioId],
      );

      // 5) Todos os dados anteriores preservados — 022 não toca em usuarios.
      assert.equal(usuarioDepois.length, 1, 'o usuário preexistente deve continuar existindo após a migration');
      assert.equal(usuarioDepois[0].nome, 'João Preexistente');
      assert.equal(usuarioDepois[0].email, 'joao-preexistente@demo.safeworkengenharia.com.br');
      assert.equal(usuarioDepois[0].perfil, 'SUPERVISOR');
      assert.equal(usuarioDepois[0].ativo, true);
      assert.equal(usuarioDepois[0].biometria_cadastrada, true);
      assert.deepEqual(usuarioDepois[0].criado_em, usuarioInserido[0].criado_em, 'criado_em não pode ter sido alterado pela migration');

      // 6) A tabela nova existe e nasce vazia — nenhuma exceção é criada
      // automaticamente para usuários preexistentes.
      const { rows: excecoes } = await contexto.cliente.query('SELECT count(*)::int AS total FROM usuario_permissoes_recurso');
      assert.equal(excecoes[0].total, 0, 'usuario_permissoes_recurso deve nascer vazia, sem nenhuma exceção presumida');
    } finally {
      await contexto.encerrar();
    }
  });
});
