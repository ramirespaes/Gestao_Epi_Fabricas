'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Estrutura PostgreSQL da migration 020 (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3A): tabela `grupos_acesso` e a coluna `usuarios.grupo_acesso_id`.
 *
 * Este arquivo testa exclusivamente estrutura de banco — constraints, FK
 * composta, índice único funcional — nunca repository, middleware ou
 * lógica de autorização (nada disso foi alterado nesta subetapa; grupos
 * ainda não têm nenhum efeito sobre autorização). As asserções usam o
 * cliente PostgreSQL diretamente, no mesmo padrão de
 * migration-016-cnpj.integration.js e autorizacao-individual-schema.integration.js.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito.
 */

const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';

const MIGRATIONS = ['000', '001', '002', '005', '013', '016', '020'];

const inserirUsuario = async (cliente, empresaId, email, extra = {}) => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [empresaId, 'Usuário Teste', email, '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28', extra.perfil ?? 'ADMINISTRADOR'],
  );
  return rows[0].id;
};

/** Executa um INSERT em grupos_acesso e devolve 'ok' ou o SQLSTATE do erro. */
const criarGrupo = async (cliente, { empresaId, nome, criadoPor }) => {
  try {
    await cliente.query(
      'INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3)',
      [empresaId, nome, criadoPor],
    );
    return 'ok';
  } catch (erro) {
    return erro.code;
  }
};

/** Executa um UPDATE associando usuário a grupo e devolve 'ok' ou o SQLSTATE do erro. */
const associarGrupo = async (cliente, { empresaId, usuarioId, grupoId }) => {
  try {
    await cliente.query(
      'UPDATE usuarios SET grupo_acesso_id = $1 WHERE empresa_id = $2 AND id = $3',
      [grupoId, empresaId, usuarioId],
    );
    return 'ok';
  } catch (erro) {
    return erro.code;
  }
};

describe('migration 020 — grupos_acesso e usuarios.grupo_acesso_id', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let masterA;
  let masterB;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    assert.equal(await inserirEmpresa(contexto.cliente, '12345678000195', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, '98765432000110', 'Empresa B'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '12345678000195').id;
    empresaB = rows.find((e) => e.cnpj === '98765432000110').id;

    masterA = await inserirUsuario(contexto.cliente, empresaA, 'master-a@demo.safeworkengenharia.com.br', { perfil: 'MASTER' });
    masterB = await inserirUsuario(contexto.cliente, empresaB, 'master-b@demo.safeworkengenharia.com.br', { perfil: 'MASTER' });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cria grupo na própria empresa', async () => {
    assert.equal(await criarGrupo(contexto.cliente, { empresaId: empresaA, nome: 'Administração Geral', criadoPor: masterA }), 'ok');
  });

  test('grupos com o mesmo nome em empresas distintas coexistem sem colisão', async () => {
    assert.equal(await criarGrupo(contexto.cliente, { empresaId: empresaA, nome: 'Almoxarifado Operacional', criadoPor: masterA }), 'ok');
    assert.equal(await criarGrupo(contexto.cliente, { empresaId: empresaB, nome: 'Almoxarifado Operacional', criadoPor: masterB }), 'ok');
  });

  test('rejeita nome duplicado na mesma empresa, inclusive com diferença de maiúsculas/minúsculas', async () => {
    assert.equal(await criarGrupo(contexto.cliente, { empresaId: empresaA, nome: 'Supervisão Produção', criadoPor: masterA }), 'ok');

    const resultadoIgual = await criarGrupo(contexto.cliente, { empresaId: empresaA, nome: 'Supervisão Produção', criadoPor: masterA });
    const resultadoMaiusculas = await criarGrupo(contexto.cliente, { empresaId: empresaA, nome: 'SUPERVISÃO PRODUÇÃO', criadoPor: masterA });
    const resultadoMinusculas = await criarGrupo(contexto.cliente, { empresaId: empresaA, nome: 'supervisão produção', criadoPor: masterA });

    assert.equal(resultadoIgual, VIOLACAO_UNIQUE);
    assert.equal(resultadoMaiusculas, VIOLACAO_UNIQUE, 'a unicidade deve ignorar diferença de caixa');
    assert.equal(resultadoMinusculas, VIOLACAO_UNIQUE, 'a unicidade deve ignorar diferença de caixa');
  });

  test('rejeita quando criado_por pertence a outra empresa', async () => {
    const resultado = await criarGrupo(contexto.cliente, { empresaId: empresaA, nome: 'Grupo Concessor Errado', criadoPor: masterB });
    assert.equal(resultado, VIOLACAO_FK, 'criado_por de empresa diferente do grupo deve ser rejeitado pela FK composta');
  });

  describe('associação de usuário a grupo', () => {
    let grupoA;
    let usuarioA;
    let usuarioB;

    before(async () => {
      const { rows } = await contexto.cliente.query(
        "INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, 'Grupo Associação', $2) RETURNING id",
        [empresaA, masterA],
      );
      grupoA = rows[0].id;
      usuarioA = await inserirUsuario(contexto.cliente, empresaA, 'usuario-associacao-a@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
      usuarioB = await inserirUsuario(contexto.cliente, empresaB, 'usuario-associacao-b@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });
    });

    test('associa usuário a grupo da própria empresa', async () => {
      assert.equal(await associarGrupo(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, grupoId: grupoA }), 'ok');

      const { rows } = await contexto.cliente.query('SELECT grupo_acesso_id FROM usuarios WHERE id = $1', [usuarioA]);
      assert.equal(rows[0].grupo_acesso_id, grupoA);
    });

    test('rejeita associação a grupo de outra empresa', async () => {
      const resultado = await associarGrupo(contexto.cliente, { empresaId: empresaB, usuarioId: usuarioB, grupoId: grupoA });
      assert.equal(resultado, VIOLACAO_FK, 'grupo de empresa diferente do usuário deve ser rejeitado pela FK composta');

      const { rows } = await contexto.cliente.query('SELECT grupo_acesso_id FROM usuarios WHERE id = $1', [usuarioB]);
      assert.equal(rows[0].grupo_acesso_id, null, 'a associação rejeitada não pode ter gravado nada');
    });

    test('usuário sem grupo: grupo_acesso_id permanece NULL, sem erro', async () => {
      const usuarioSemGrupo = await inserirUsuario(contexto.cliente, empresaA, 'sem-grupo@demo.safeworkengenharia.com.br', { perfil: 'USUARIO' });

      const { rows } = await contexto.cliente.query('SELECT grupo_acesso_id FROM usuarios WHERE id = $1', [usuarioSemGrupo]);
      assert.equal(rows[0].grupo_acesso_id, null);
    });

    test('preserva usuários já existentes: inserção no formato anterior à migration continua funcionando, com grupo_acesso_id NULL automático', async () => {
      // Mesma forma de INSERT já usada antes desta migration existir —
      // sem mencionar grupo_acesso_id nenhuma vez.
      const { rows } = await contexto.cliente.query(
        `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
         VALUES ($1, 'Usuário Pré-existente', 'pre-existente@demo.safeworkengenharia.com.br', $2, 'SUPERVISOR', true)
         RETURNING id, grupo_acesso_id`,
        [empresaA, '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28'],
      );
      assert.equal(rows[0].grupo_acesso_id, null, 'usuário inserido sem mencionar grupo deve continuar igual ao comportamento anterior à migration');
    });

    test('ON DELETE RESTRICT: não é possível excluir um grupo referenciado por algum usuário', async () => {
      await assert.rejects(
        () => contexto.cliente.query('DELETE FROM grupos_acesso WHERE id = $1', [grupoA]),
        (erro) => erro.code === VIOLACAO_FK,
        'excluir um grupo ainda referenciado por usuarios.grupo_acesso_id deve ser impedido pelo banco',
      );

      const { rows } = await contexto.cliente.query('SELECT 1 FROM grupos_acesso WHERE id = $1', [grupoA]);
      assert.equal(rows.length, 1, 'o grupo deve continuar existindo após a tentativa rejeitada');
    });
  });

  test('ativo nasce true por padrão, sem precisar ser informado', async () => {
    const { rows } = await contexto.cliente.query(
      "INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, 'Grupo Padrao Ativo', $2) RETURNING ativo",
      [empresaA, masterA],
    );
    assert.equal(rows[0].ativo, true);
  });

  test('atualizado_em avança em UPDATE, via a mesma trigger já usada nas demais tabelas', async () => {
    const { rows: criado } = await contexto.cliente.query(
      "INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, 'Grupo Trigger', $2) RETURNING id, atualizado_em",
      [empresaA, masterA],
    );

    await contexto.cliente.query('UPDATE grupos_acesso SET descricao = $1 WHERE id = $2', ['nova descrição', criado[0].id]);

    const { rows: atualizado } = await contexto.cliente.query('SELECT atualizado_em FROM grupos_acesso WHERE id = $1', [criado[0].id]);
    assert.ok(atualizado[0].atualizado_em.getTime() >= criado[0].atualizado_em.getTime());
  });
});

/**
 * Fortalecimento pedido na Subetapa 3B: a suíte acima só prova que inserir
 * um usuário no formato antigo funciona DEPOIS que o schema já nasceu com
 * a migration 020 aplicada. Este describe prova o caso literal de
 * transição — um banco que já tinha dados ANTES de 020 existir, exatamente
 * como aconteceria em um ambiente real recebendo a migration.
 */
describe('transição de um banco já populado antes da migration 020', () => {
  test('usuário e empresa inseridos com as migrations anteriores sobrevivem intactos à aplicação da 020, com grupo_acesso_id = NULL', async () => {
    // 1) Schema temporário só com as migrations anteriores a 020.
    const contexto = await abrirSchemaTemporario(['000', '001', '002', '005', '013', '016']);
    try {
      // 2) Insere empresa e usuário no formato que já existia antes de
      // grupos_acesso ser sequer cogitada.
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

      // 3) Aplica o SQL real da migration 020 sobre esse schema já populado.
      // Falha aqui aborta o teste com o erro real do PostgreSQL: executar
      // sem lançar já é a confirmação de que a migration roda sobre dados
      // vivos, não só sobre um schema vazio.
      await contexto.cliente.query(conteudoDaMigration('020'));

      // 4) Consulta o mesmo usuário depois da migration.
      const { rows: usuarioDepois } = await contexto.cliente.query(
        'SELECT id, nome, email, perfil, ativo, biometria_cadastrada, criado_em, grupo_acesso_id FROM usuarios WHERE id = $1',
        [usuarioId],
      );

      // 5) Todos os dados anteriores preservados, e grupo_acesso_id = NULL.
      assert.equal(usuarioDepois.length, 1, 'o usuário preexistente deve continuar existindo após a migration');
      assert.equal(usuarioDepois[0].nome, 'João Preexistente');
      assert.equal(usuarioDepois[0].email, 'joao-preexistente@demo.safeworkengenharia.com.br');
      assert.equal(usuarioDepois[0].perfil, 'SUPERVISOR');
      assert.equal(usuarioDepois[0].ativo, true);
      assert.equal(usuarioDepois[0].biometria_cadastrada, true);
      assert.deepEqual(usuarioDepois[0].criado_em, usuarioInserido[0].criado_em, 'criado_em não pode ter sido alterado pela migration');
      assert.equal(usuarioDepois[0].grupo_acesso_id, null, 'usuário preexistente deve nascer sem grupo, nunca associado a algo por padrão');
    } finally {
      await contexto.encerrar();
    }
  });
});
