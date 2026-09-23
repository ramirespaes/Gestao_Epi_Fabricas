'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const servico = require('../../src/services/grupo-acesso.service');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const permissoes = require('../../src/repositories/permissao.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Serviço de gestão de grupos de acesso contra PostgreSQL real (Bloco 8,
 * Incremento 8, Etapa 5A, Subetapa 3J): transações, FOR UPDATE, o índice
 * único funcional de nome por empresa (migration 020), a trilha em
 * logs_auditoria com as triggers das migrations 012/014 ativas, e — o
 * ponto mais importante — a prova de que inativar um grupo não apaga suas
 * permissões nem desvincula seus usuários, e de que o RBAC já aprovado
 * continua lendo exatamente o que lia.
 *
 * Schema temporário exclusivo, removido em cascata ao final. O schema
 * public não é lido nem escrito.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '009', '010', '011', '012', '013', '014', '016', '017', '018', '019', '020', '021', '023'];

const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28';
const RECURSO = 'materials';
const ACAO = 'MOVIMENTAR_ESTOQUE';

async function inserirUsuario(pool, empresaId, email, perfil = 'ADMINISTRADOR', ativo = true) {
  const { rows } = await pool.query(
    'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [empresaId, `Usuário ${email}`, email, HASH, perfil, ativo],
  );
  return rows[0].id;
}

async function lerGrupo(pool, id) {
  const { rows } = await pool.query('SELECT * FROM grupos_acesso WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function lerAuditoria(pool, empresaId, acao, referencia) {
  const { rows } = await pool.query(
    'SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2 AND referencia = $3 ORDER BY id',
    [empresaId, acao, referencia],
  );
  return rows;
}

async function contarGrupos(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM grupos_acesso WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

async function contarAuditoria(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

async function esperarHttpError(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError ${status} ${codigo}, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.equal(erro.status, status);
    assert.equal(erro.codigo, codigo);
    return true;
  });
}

describe('serviço de grupos de acesso em PostgreSQL real', () => {
  let contexto;
  let pool;
  let empresaA;
  let empresaB;
  let masterA;
  let masterB;
  let adminA;

  before(async () => {
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;
    assert.equal(await inserirEmpresa(pool, '12345678000195', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, '98765432000110', 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '12345678000195').id;
    empresaB = rows.find((e) => e.cnpj === '98765432000110').id;
    masterA = await inserirUsuario(pool, empresaA, 'master-a@demo.safeworkengenharia.com.br', 'MASTER');
    masterB = await inserirUsuario(pool, empresaB, 'master-b@demo.safeworkengenharia.com.br', 'MASTER');
    adminA = await inserirUsuario(pool, empresaA, 'admin-a@demo.safeworkengenharia.com.br', 'ADMINISTRADOR');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('criação', () => {
    test('MASTER cria na própria empresa: ativo=true, criado_por = MASTER, e auditoria na mesma transação', async () => {
      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Almoxarifado', descricao: 'Equipe do depósito' });

      const linha = await lerGrupo(pool, grupo.id);
      assert.equal(linha.empresa_id, empresaA);
      assert.equal(linha.nome, 'Almoxarifado');
      assert.equal(linha.descricao, 'Equipe do depósito');
      assert.equal(linha.ativo, true);
      assert.equal(linha.criado_por, masterA);
      assert.ok(linha.criado_em instanceof Date);

      const [auditoria] = await lerAuditoria(pool, empresaA, 'GRUPO_ACESSO_CRIADO', String(grupo.id));
      assert.ok(auditoria, 'a criação precisa ter registro em logs_auditoria');
      assert.equal(auditoria.usuario_id, masterA);
      assert.deepEqual(auditoria.dados_novos, { nome: 'Almoxarifado', descricao: 'Equipe do depósito', ativo: true });
      assert.equal(auditoria.dados_anteriores, null);
    });

    test('nomes personalizados de exemplo convivem na mesma empresa', async () => {
      for (const nome of ['Administração', 'Gerência', 'Manutenção']) {
        const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome });
        assert.equal((await lerGrupo(pool, grupo.id)).nome, nome);
      }
    });

    test('nome duplicado na mesma empresa, sem diferenciar maiúsculas: 409, e o primeiro permanece', async () => {
      const primeiro = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Compras' });
      const antes = await contarGrupos(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await esperarHttpError(servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Compras' }), 409, 'GRUPO_NOME_EM_USO');
      await esperarHttpError(servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'COMPRAS' }), 409, 'GRUPO_NOME_EM_USO');
      await esperarHttpError(servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: '  compras  ' }), 409, 'GRUPO_NOME_EM_USO');

      assert.ok(await lerGrupo(pool, primeiro.id));
      assert.equal(await contarGrupos(pool, empresaA), antes, 'nenhuma linha a mais');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'recusa não é auditada');
    });

    test('o mesmo nome em empresas diferentes é permitido', async () => {
      const deA = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Expedição' });
      const deB = await servico.criar(pool, { empresaId: empresaB, atorId: masterB, nome: 'Expedição' });

      assert.notEqual(deA.id, deB.id);
      assert.equal((await lerGrupo(pool, deA.id)).empresa_id, empresaA);
      assert.equal((await lerGrupo(pool, deB.id)).empresa_id, empresaB);
    });

    test('não-MASTER (inclusive ADMINISTRADOR) não cria: 403, nada gravado', async () => {
      const antes = await contarGrupos(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await esperarHttpError(servico.criar(pool, { empresaId: empresaA, atorId: adminA, nome: 'Tentativa' }), 403, 'GRUPO_NAO_AUTORIZADO');

      assert.equal(await contarGrupos(pool, empresaA), antes);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
    });

    test('MASTER inativo não administra: 403', async () => {
      const masterInativo = await inserirUsuario(pool, empresaA, 'master-inativo@demo.safeworkengenharia.com.br', 'MASTER', false);

      await esperarHttpError(servico.criar(pool, { empresaId: empresaA, atorId: masterInativo, nome: 'De Inativo' }), 403, 'GRUPO_NAO_AUTORIZADO');
    });

    test('MASTER de outra empresa não cria nesta: 403, nada gravado', async () => {
      const antes = await contarGrupos(pool, empresaA);

      await esperarHttpError(servico.criar(pool, { empresaId: empresaA, atorId: masterB, nome: 'Invasora' }), 403, 'GRUPO_NAO_AUTORIZADO');

      assert.equal(await contarGrupos(pool, empresaA), antes);
    });

    test('nome vazio ou só espaços: 400, nada gravado', async () => {
      const antes = await contarGrupos(pool, empresaA);

      await esperarHttpError(servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: '' }), 400, 'GRUPO_NOME_INVALIDO');
      await esperarHttpError(servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: '    ' }), 400, 'GRUPO_NOME_INVALIDO');
      await esperarHttpError(servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'x'.repeat(101) }), 400, 'GRUPO_NOME_INVALIDO');

      assert.equal(await contarGrupos(pool, empresaA), antes);
    });

    test('grupo chamado "SST" não cria vinculo_sst, e "Funcionários" não cria usuário nem funcionário', async () => {
      const { rows: [antes] } = await pool.query(
        'SELECT (SELECT count(*)::int FROM vinculo_sst) AS sst, (SELECT count(*)::int FROM usuarios WHERE empresa_id = $1) AS usuarios',
        [empresaA],
      );

      const sst = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'SST' });
      const funcionarios = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Funcionários' });

      const { rows: [depois] } = await pool.query(
        'SELECT (SELECT count(*)::int FROM vinculo_sst) AS sst, (SELECT count(*)::int FROM usuarios WHERE empresa_id = $1) AS usuarios',
        [empresaA],
      );
      assert.equal(depois.sst, antes.sst, 'nenhum vinculo_sst foi criado');
      assert.equal(depois.usuarios, antes.usuarios, 'nenhum usuário foi criado');
      assert.equal((await lerGrupo(pool, sst.id)).nome, 'SST');
      assert.equal((await lerGrupo(pool, funcionarios.id)).nome, 'Funcionários');
      // E o RBAC continua sem enxergar SST onde não há vinculo_sst.
      assert.equal(await permissoes.usuarioIntegraSst(pool, empresaA, masterA), false);
    });
  });

  describe('consulta e listagem', () => {
    test('buscar e listar são isolados por empresa; id de outra empresa é 404', async () => {
      const deB = await servico.criar(pool, { empresaId: empresaB, atorId: masterB, nome: 'Exclusivo de B' });

      const encontrado = await servico.buscar(pool, { empresaId: empresaB, atorId: masterB, grupoId: deB.id });
      assert.equal(encontrado.nome, 'Exclusivo de B');

      await esperarHttpError(servico.buscar(pool, { empresaId: empresaA, atorId: masterA, grupoId: deB.id }), 404, 'GRUPO_NAO_ENCONTRADO');

      const daEmpresaA = await servico.listar(pool, { empresaId: empresaA, atorId: masterA });
      assert.equal(daEmpresaA.every((g) => g.empresaId === empresaA), true, 'listagem de A só traz grupos de A');
      assert.equal(daEmpresaA.some((g) => g.id === deB.id), false);
    });

    test('listagem traz ativos e inativos por padrão, e respeita o filtro explícito', async () => {
      const paraInativar = await servico.criar(pool, { empresaId: empresaB, atorId: masterB, nome: 'Será Inativado' });
      await servico.inativar(pool, { empresaId: empresaB, atorId: masterB, grupoId: paraInativar.id });

      const todos = await servico.listar(pool, { empresaId: empresaB, atorId: masterB });
      const ativos = await servico.listar(pool, { empresaId: empresaB, atorId: masterB, ativo: true });
      const inativos = await servico.listar(pool, { empresaId: empresaB, atorId: masterB, ativo: false });

      assert.equal(todos.some((g) => g.id === paraInativar.id), true, 'sem filtro, o inativo aparece');
      assert.equal(ativos.some((g) => g.id === paraInativar.id), false);
      assert.equal(inativos.some((g) => g.id === paraInativar.id), true);
      assert.equal(ativos.every((g) => g.ativo === true), true);
      assert.equal(inativos.every((g) => g.ativo === false), true);
    });
  });

  describe('alteração', () => {
    test('altera nome e descrição preservando id, empresa_id, criado_por e criado_em', async () => {
      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Antigo Nome', descricao: 'antiga' });
      const original = await lerGrupo(pool, grupo.id);

      const atualizado = await servico.alterar(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, nome: 'Nome Novo', descricao: 'nova',
      });

      const depois = await lerGrupo(pool, grupo.id);
      assert.equal(atualizado.nome, 'Nome Novo');
      assert.equal(depois.nome, 'Nome Novo');
      assert.equal(depois.descricao, 'nova');
      assert.equal(depois.id, original.id);
      assert.equal(depois.empresa_id, original.empresa_id);
      assert.equal(depois.criado_por, original.criado_por, 'criado_por preservado');
      assert.deepEqual(depois.criado_em, original.criado_em, 'criado_em preservado');
      assert.ok(depois.atualizado_em >= original.atualizado_em, 'atualizado_em avança pela trigger da 020');
      assert.equal(depois.ativo, true, 'alterar nome/descrição não mexe em ativo');

      const [auditoria] = await lerAuditoria(pool, empresaA, 'GRUPO_ACESSO_ALTERADO', String(grupo.id));
      assert.deepEqual(auditoria.dados_anteriores, { nome: 'Antigo Nome', descricao: 'antiga', ativo: true });
      assert.deepEqual(auditoria.dados_novos, { nome: 'Nome Novo', descricao: 'nova', ativo: true });
      assert.deepEqual(auditoria.contexto, { camposAlterados: ['nome', 'descricao'] });
    });

    test('renomear para nome já usado na empresa: 409, e o nome antigo permanece', async () => {
      const ocupado = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Nome Ocupado' });
      const outro = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Outro Grupo' });

      await esperarHttpError(servico.alterar(pool, { empresaId: empresaA, atorId: masterA, grupoId: outro.id, nome: 'nome ocupado' }), 409, 'GRUPO_NOME_EM_USO');

      assert.equal((await lerGrupo(pool, outro.id)).nome, 'Outro Grupo');
      assert.equal((await lerGrupo(pool, ocupado.id)).nome, 'Nome Ocupado');
    });

    test('não-MASTER não altera; grupo de outra empresa é 404 para o MASTER de lá', async () => {
      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Protegido' });

      await esperarHttpError(servico.alterar(pool, { empresaId: empresaA, atorId: adminA, grupoId: grupo.id, nome: 'Hackeado' }), 403, 'GRUPO_NAO_AUTORIZADO');
      await esperarHttpError(servico.alterar(pool, { empresaId: empresaB, atorId: masterB, grupoId: grupo.id, nome: 'Hackeado' }), 404, 'GRUPO_NAO_ENCONTRADO');

      assert.equal((await lerGrupo(pool, grupo.id)).nome, 'Protegido');
    });
  });

  describe('inativação e reativação preservam tudo o mais', () => {
    test('inativar não apaga permissões do grupo, não desvincula usuários e não muda o que o RBAC lê', async () => {
      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Com Permissões' });
      const membro = await inserirUsuario(pool, empresaA, 'membro-permissoes@demo.safeworkengenharia.com.br');
      await pool.query(
        `INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar, pode_excluir)
         VALUES ($1, $2, $3, true, false)`,
        [empresaA, grupo.id, RECURSO],
      );
      await pool.query(
        'INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido) VALUES ($1, $2, $3, false)',
        [empresaA, grupo.id, ACAO],
      );
      await pool.query('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupo.id, membro]);

      const resultado = await servico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      assert.equal(resultado.alterado, true);
      assert.equal((await lerGrupo(pool, grupo.id)).ativo, false);

      // Permissões intactas, exatamente como estavam.
      assert.deepEqual(
        await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, grupo.id, RECURSO),
        { podeVisualizar: true, podeCriar: null, podeEditar: null, podeExcluir: false },
      );
      assert.deepEqual(await permissoes.buscarPermissaoAcaoGrupo(pool, empresaA, grupo.id, ACAO), { permitido: false });

      // Usuário continua vinculado; o RBAC apenas passa a ver ativo=false.
      const { rows: [usuarioDepois] } = await pool.query('SELECT grupo_acesso_id FROM usuarios WHERE id = $1', [membro]);
      assert.equal(usuarioDepois.grupo_acesso_id, grupo.id, 'inativar não desvincula usuários');
      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, membro), { id: grupo.id, ativo: false });

      const [auditoria] = await lerAuditoria(pool, empresaA, 'GRUPO_ACESSO_INATIVADO', String(grupo.id));
      assert.equal(auditoria.usuario_id, masterA);
      assert.deepEqual(auditoria.contexto, { efeito: 'CONCESSOES_DO_GRUPO_SUSPENSAS' });
      assert.equal(auditoria.dados_anteriores.ativo, true);
      assert.equal(auditoria.dados_novos.ativo, false);
    });

    test('reativar devolve ativo=true com as mesmas permissões e vínculos, e é auditada com ação própria', async () => {
      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Vai e Volta' });
      const membro = await inserirUsuario(pool, empresaA, 'membro-vaievolta@demo.safeworkengenharia.com.br');
      await pool.query(
        'INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar) VALUES ($1, $2, $3, true)',
        [empresaA, grupo.id, RECURSO],
      );
      await pool.query('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupo.id, membro]);
      await servico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      const resultado = await servico.reativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      assert.equal(resultado.alterado, true);
      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, membro), { id: grupo.id, ativo: true });
      assert.deepEqual(
        await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, grupo.id, RECURSO),
        { podeVisualizar: true, podeCriar: null, podeEditar: null, podeExcluir: null },
        'a concessão TRUE estava lá o tempo todo e volta a valer',
      );

      const [auditoria] = await lerAuditoria(pool, empresaA, 'GRUPO_ACESSO_REATIVADO', String(grupo.id));
      assert.deepEqual(auditoria.contexto, { efeito: 'CONCESSOES_DO_GRUPO_VOLTAM_A_VALER' });
      assert.equal(auditoria.dados_novos.ativo, true);
    });

    test('reativação exige a mesma autoridade da criação: não-MASTER recebe 403 e o grupo continua inativo', async () => {
      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Reativação Protegida' });
      await servico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await esperarHttpError(servico.reativar(pool, { empresaId: empresaA, atorId: adminA, grupoId: grupo.id }), 403, 'GRUPO_NAO_AUTORIZADO');

      assert.equal((await lerGrupo(pool, grupo.id)).ativo, false);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
    });

    test('idempotência: inativar duas vezes não grava nem audita a segunda', async () => {
      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Idempotente' });
      await servico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });
      const auditoriaAntes = await contarAuditoria(pool, empresaA);
      const { atualizado_em: antes } = await lerGrupo(pool, grupo.id);

      const repetido = await servico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      assert.equal(repetido.alterado, false);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'nada a auditar');
      assert.deepEqual((await lerGrupo(pool, grupo.id)).atualizado_em, antes, 'nem a trigger foi disparada');
    });

    test('nenhum grupo é excluído fisicamente em nenhuma das operações', async () => {
      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Nunca Apagado' });
      const antes = await contarGrupos(pool, empresaA);

      await servico.alterar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, nome: 'Nunca Apagado 2' });
      await servico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });
      await servico.reativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      assert.equal(await contarGrupos(pool, empresaA), antes, 'a contagem nunca diminui');
      assert.ok(await lerGrupo(pool, grupo.id));
    });
  });

  describe('segurança transacional', () => {
    test('falha real da auditoria após o INSERT: ROLLBACK — nenhum grupo e nenhum log gravados', async (t) => {
      const gruposAntes = await contarGrupos(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada depois do INSERT'); });

      await assert.rejects(servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Fantasma' }), /falha simulada/);

      assert.equal(await contarGrupos(pool, empresaA), gruposAntes, 'o INSERT foi desfeito');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
      const { rows } = await pool.query('SELECT id FROM grupos_acesso WHERE empresa_id = $1 AND nome = $2', [empresaA, 'Fantasma']);
      assert.equal(rows.length, 0, 'o nome continua livre para uso futuro');
    });

    test('falha real da auditoria após a inativação: ROLLBACK — o grupo continua ativo', async (t) => {
      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Rollback de Estado' });
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada depois do UPDATE'); });

      await assert.rejects(servico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id }), /falha simulada/);

      assert.equal((await lerGrupo(pool, grupo.id)).ativo, true, 'a inativação foi desfeita');
    });

    test('falha real da auditoria após alteração de nome: ROLLBACK — o nome antigo permanece', async (t) => {
      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Nome Preservado' });
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada depois do UPDATE'); });

      await assert.rejects(servico.alterar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, nome: 'Nome Que Não Vinga' }), /falha simulada/);

      assert.equal((await lerGrupo(pool, grupo.id)).nome, 'Nome Preservado');
    });
  });

  describe('não-interferência com o RBAC existente', () => {
    test('nada aqui altera perfis, permissões de perfil, vinculo_sst, bloqueios, autorizações individuais ou o catálogo', async () => {
      const { rows: [antes] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM permissoes_recurso) AS pr,
               (SELECT count(*)::int FROM permissoes_acao) AS pa,
               (SELECT count(*)::int FROM vinculo_sst) AS sst,
               (SELECT count(*)::int FROM usuario_bloqueios) AS bloq,
               (SELECT count(*)::int FROM usuario_autorizacoes) AS aut,
               (SELECT count(*)::int FROM acoes WHERE ativo) AS acoes_ativas`);

      const grupo = await servico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Sem Efeito Colateral' });
      await servico.alterar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, descricao: 'x' });
      await servico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });
      await servico.reativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });
      await servico.listar(pool, { empresaId: empresaA, atorId: masterA });

      const { rows: [depois] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM permissoes_recurso) AS pr,
               (SELECT count(*)::int FROM permissoes_acao) AS pa,
               (SELECT count(*)::int FROM vinculo_sst) AS sst,
               (SELECT count(*)::int FROM usuario_bloqueios) AS bloq,
               (SELECT count(*)::int FROM usuario_autorizacoes) AS aut,
               (SELECT count(*)::int FROM acoes WHERE ativo) AS acoes_ativas`);

      assert.deepEqual(depois, antes, 'nenhuma tabela do RBAC anterior foi tocada');
    });

    test('logs_auditoria continua append-only: nem este teste consegue apagar o que o serviço gravou', async () => {
      await assert.rejects(pool.query('DELETE FROM logs_auditoria WHERE empresa_id = $1', [empresaA]), /append-only/);
    });
  });
});
