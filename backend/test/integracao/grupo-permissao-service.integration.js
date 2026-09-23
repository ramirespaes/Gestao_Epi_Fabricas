'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const servico = require('../../src/services/grupo-permissao.service');
const grupoServico = require('../../src/services/grupo-acesso.service');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const permissoes = require('../../src/repositories/permissao.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Serviço de configuração das permissões de grupo contra PostgreSQL real
 * (Bloco 8, Incremento 8, Etapa 5A, Subetapa 3K): transações, FOR UPDATE
 * no grupo, UPSERT sobre as UNIQUEs da migration 021, tri-state
 * atravessando o banco de verdade, trilha em logs_auditoria com as
 * triggers das migrations 012/014 ativas — e a confirmação de que o que o
 * MIDDLEWARE lê (via permissao.repository, intocado) passa a refletir
 * exatamente o que foi configurado.
 *
 * Schema temporário exclusivo, removido em cascata ao final.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '009', '010', '011', '012', '013', '014', '016', '017', '018', '019', '020', '021', '023'];

const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28';
const RECURSO = 'materials';
const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE';   // 017: ALTERNATIVA
const ACAO_OBRIGATORIA = 'APROVAR_SOLICITACAO';  // 017: OBRIGATORIA + exige_sst
const ACAO_NENHUMA = 'GERENCIAR_USUARIOS';       // 017: padrão NENHUMA

async function inserirUsuario(pool, empresaId, email, perfil = 'ADMINISTRADOR', ativo = true) {
  const { rows } = await pool.query(
    'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [empresaId, `Usuário ${email}`, email, HASH, perfil, ativo],
  );
  return rows[0].id;
}

async function lerRecurso(pool, grupoId, recurso) {
  const { rows } = await pool.query(
    'SELECT * FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = $2',
    [grupoId, recurso],
  );
  return rows[0] ?? null;
}

async function lerAcao(pool, grupoId, acaoCodigo) {
  const { rows } = await pool.query(
    'SELECT * FROM grupo_permissoes_acao WHERE grupo_acesso_id = $1 AND acao_codigo = $2',
    [grupoId, acaoCodigo],
  );
  return rows[0] ?? null;
}

async function lerAuditoria(pool, empresaId, acao, referencia) {
  const { rows } = await pool.query(
    'SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2 AND referencia = $3 ORDER BY id',
    [empresaId, acao, referencia],
  );
  return rows;
}

async function contarAuditoria(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

async function contarConfiguracoes(pool, empresaId) {
  const { rows } = await pool.query(`
    SELECT (SELECT count(*)::int FROM grupo_permissoes_recurso WHERE empresa_id = $1) AS recursos,
           (SELECT count(*)::int FROM grupo_permissoes_acao WHERE empresa_id = $1) AS acoes`, [empresaId]);
  return rows[0];
}

async function esperarHttpError(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError ${status} ${codigo}, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.equal(erro.status, status);
    assert.equal(erro.codigo, codigo);
    return true;
  });
}

describe('serviço de permissões de grupo em PostgreSQL real', () => {
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

  /** Cria um grupo pelo serviço aprovado na 3J, para não duplicar SQL. */
  async function criarGrupo(nome, { empresaId = empresaA, atorId = masterA } = {}) {
    return grupoServico.criar(pool, { empresaId, atorId, nome });
  }

  describe('configuração de recursos', () => {
    test('MASTER cria configuração: tri-state misto persistido literalmente e legível pelo RBAC', async () => {
      const grupo = await criarGrupo('Recursos Mistos');

      const { configuracao, alterado } = await servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO,
        podeVisualizar: true, podeCriar: false,
      });

      assert.equal(alterado, true);
      const linha = await lerRecurso(pool, grupo.id, RECURSO);
      assert.equal(linha.pode_visualizar, true);
      assert.equal(linha.pode_criar, false, 'FALSE persistido como FALSE');
      assert.equal(linha.pode_editar, null, 'não informado nasce NULL (herda)');
      assert.equal(linha.pode_excluir, null);
      assert.equal(linha.empresa_id, empresaA);
      assert.equal(configuracao.podeVisualizar, true);

      // O que o middleware lê, pelo repositório intocado da 3C.
      assert.deepEqual(
        await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, grupo.id, RECURSO),
        { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null },
      );

      const [auditoria] = await lerAuditoria(pool, empresaA, 'GRUPO_PERMISSAO_RECURSO_CONFIGURADA', String(grupo.id));
      assert.equal(auditoria.usuario_id, masterA);
      assert.equal(auditoria.dados_anteriores, null);
      assert.deepEqual(auditoria.dados_novos, { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null });
      assert.equal(auditoria.contexto.recurso, RECURSO);
      assert.equal(auditoria.contexto.criouConfiguracao, true);
    });

    test('configuração existente é atualizada parcialmente: só a operação informada muda, FALSE não vira NULL', async () => {
      const grupo = await criarGrupo('Alteração Parcial');
      await servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO,
        podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: false,
      });

      await servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeExcluir: true,
      });

      const linha = await lerRecurso(pool, grupo.id, RECURSO);
      assert.equal(linha.pode_excluir, true, 'a operação informada mudou');
      assert.equal(linha.pode_visualizar, true, 'preservada');
      assert.equal(linha.pode_criar, false, 'FALSE preservado como FALSE');
      assert.equal(linha.pode_editar, true, 'preservada');

      const auditorias = await lerAuditoria(pool, empresaA, 'GRUPO_PERMISSAO_RECURSO_CONFIGURADA', String(grupo.id));
      const ultima = auditorias[auditorias.length - 1];
      assert.deepEqual(ultima.dados_anteriores, { podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: false });
      assert.deepEqual(ultima.dados_novos, { podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true });
      assert.deepEqual(ultima.contexto.operacoesInformadas, ['podeExcluir']);
      assert.equal(ultima.contexto.criouConfiguracao, false);
    });

    test('informar NULL retira a opinião daquela operação, sem tocar as outras', async () => {
      const grupo = await criarGrupo('Volta a Herdar');
      await servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true, podeCriar: false,
      });

      await servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: null,
      });

      const linha = await lerRecurso(pool, grupo.id, RECURSO);
      assert.equal(linha.pode_visualizar, null, 'voltou a herdar do perfil');
      assert.equal(linha.pode_criar, false, 'a negação de criar continua lá');
      assert.notEqual(await lerRecurso(pool, grupo.id, RECURSO), null, 'a linha continua existindo');
    });

    test('recursos diferentes do mesmo grupo são independentes', async () => {
      const grupo = await criarGrupo('Dois Recursos');

      await servico.configurarRecurso(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true });
      await servico.configurarRecurso(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: 'stockValidity', podeVisualizar: false });

      assert.equal((await lerRecurso(pool, grupo.id, RECURSO)).pode_visualizar, true);
      assert.equal((await lerRecurso(pool, grupo.id, 'stockValidity')).pode_visualizar, false);
    });

    test('sem mudança efetiva: nada é gravado e nada é auditado', async () => {
      const grupo = await criarGrupo('Sem Mudança');
      await servico.configurarRecurso(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true });
      const auditoriaAntes = await contarAuditoria(pool, empresaA);
      const { atualizado_em: antes } = await lerRecurso(pool, grupo.id, RECURSO);

      const { alterado } = await servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true,
      });

      assert.equal(alterado, false);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
      assert.deepEqual((await lerRecurso(pool, grupo.id, RECURSO)).atualizado_em, antes, 'nem a trigger foi disparada');
    });

    test('não-MASTER e MASTER inativo recebem 403, sem gravar nada', async () => {
      const grupo = await criarGrupo('Protegido Recurso');
      const masterInativo = await inserirUsuario(pool, empresaA, 'master-inativo-perm@demo.safeworkengenharia.com.br', 'MASTER', false);
      const antes = await contarConfiguracoes(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await esperarHttpError(servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: adminA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true,
      }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');

      await esperarHttpError(servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterInativo, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true,
      }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');

      assert.deepEqual(await contarConfiguracoes(pool, empresaA), antes);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'recusa não é auditada');
    });

    test('grupo de outra empresa é inacessível mesmo conhecendo o id', async () => {
      const grupoDeB = await criarGrupo('Exclusivo de B', { empresaId: empresaB, atorId: masterB });

      // MASTER de A, usando o id real de um grupo de B, na própria empresa: 404.
      await esperarHttpError(servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupoDeB.id, recurso: RECURSO, podeVisualizar: true,
      }), 404, 'GRUPO_NAO_ENCONTRADO');

      // MASTER de A tentando agir dentro da empresa B: nem ator ele é lá.
      await esperarHttpError(servico.configurarRecurso(pool, {
        empresaId: empresaB, atorId: masterA, grupoId: grupoDeB.id, recurso: RECURSO, podeVisualizar: true,
      }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');

      assert.equal(await lerRecurso(pool, grupoDeB.id, RECURSO), null, 'nada foi gravado no grupo de B');
    });
  });

  describe('configuração de ações', () => {
    test('MASTER configura ação ALTERNATIVA: TRUE e depois FALSE, ambos legíveis pelo RBAC', async () => {
      const grupo = await criarGrupo('Ações Alternativa');

      await servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: true,
      });
      assert.equal((await lerAcao(pool, grupo.id, ACAO_ALTERNATIVA)).permitido, true);
      assert.deepEqual(await permissoes.buscarPermissaoAcaoGrupo(pool, empresaA, grupo.id, ACAO_ALTERNATIVA), { permitido: true });

      const { alterado } = await servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: false,
      });

      assert.equal(alterado, true);
      assert.equal((await lerAcao(pool, grupo.id, ACAO_ALTERNATIVA)).permitido, false, 'FALSE persistido');
      assert.deepEqual(await permissoes.buscarPermissaoAcaoGrupo(pool, empresaA, grupo.id, ACAO_ALTERNATIVA), { permitido: false });

      const auditorias = await lerAuditoria(pool, empresaA, 'GRUPO_PERMISSAO_ACAO_CONFIGURADA', String(grupo.id));
      const ultima = auditorias[auditorias.length - 1];
      assert.deepEqual(ultima.dados_anteriores, { permitido: true });
      assert.deepEqual(ultima.dados_novos, { permitido: false });
      assert.equal(ultima.contexto.modoAutorizacaoIndividual, 'ALTERNATIVA');
    });

    test('ação em modo NENHUMA não recebe concessão nem negação por grupo (catálogo real)', async () => {
      const grupo = await criarGrupo('Tentativa NENHUMA');
      const { rows: [modo] } = await pool.query('SELECT modo_autorizacao_individual FROM acoes WHERE codigo = $1', [ACAO_NENHUMA]);
      assert.equal(modo.modo_autorizacao_individual, 'NENHUMA', 'o cenário depende do catálogo real');

      await esperarHttpError(servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_NENHUMA, permitido: true,
      }), 409, 'GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA');

      await esperarHttpError(servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_NENHUMA, permitido: false,
      }), 409, 'GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA');

      assert.equal(await lerAcao(pool, grupo.id, ACAO_NENHUMA), null, 'nenhuma linha criada');
    });

    test('ação OBRIGATORIA não recebe concessão por grupo: grupo não substitui autorização individual nem SST', async () => {
      const grupo = await criarGrupo('Tentativa OBRIGATORIA');
      const { rows: [config] } = await pool.query('SELECT modo_autorizacao_individual, exige_sst FROM acoes WHERE codigo = $1', [ACAO_OBRIGATORIA]);
      assert.deepEqual(config, { modo_autorizacao_individual: 'OBRIGATORIA', exige_sst: true });

      await esperarHttpError(servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_OBRIGATORIA, permitido: true,
      }), 409, 'GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA');

      assert.equal(await lerAcao(pool, grupo.id, ACAO_OBRIGATORIA), null);
    });

    test('ação inexistente ou inativa é rejeitada com 400', async () => {
      const grupo = await criarGrupo('Ação Inválida');

      await esperarHttpError(servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: 'ACAO_QUE_NAO_EXISTE', permitido: true,
      }), 400, 'GRUPO_PERMISSAO_ACAO_INVALIDA');

      await pool.query('UPDATE acoes SET ativo = false WHERE codigo = $1', [ACAO_ALTERNATIVA]);
      try {
        await esperarHttpError(servico.configurarAcao(pool, {
          empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: true,
        }), 400, 'GRUPO_PERMISSAO_ACAO_INVALIDA');
      } finally {
        await pool.query('UPDATE acoes SET ativo = true WHERE codigo = $1', [ACAO_ALTERNATIVA]);
      }

      assert.equal(await lerAcao(pool, grupo.id, ACAO_ALTERNATIVA), null);
    });

    test('retirar a opinião com NULL é permitido mesmo depois de a ação deixar de ser ALTERNATIVA', async () => {
      const grupo = await criarGrupo('Limpeza de Obsoleta');
      await servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: true,
      });

      // O catálogo muda: a ação deixa de ser ALTERNATIVA e a configuração
      // do grupo fica obsoleta. Limpar precisa continuar possível.
      await pool.query('UPDATE acoes SET modo_autorizacao_individual = $1 WHERE codigo = $2', ['OBRIGATORIA', ACAO_ALTERNATIVA]);
      try {
        await esperarHttpError(servico.configurarAcao(pool, {
          empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: false,
        }), 409, 'GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA');

        const { alterado } = await servico.configurarAcao(pool, {
          empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: null,
        });

        assert.equal(alterado, true);
        assert.equal((await lerAcao(pool, grupo.id, ACAO_ALTERNATIVA)).permitido, null);
      } finally {
        await pool.query('UPDATE acoes SET modo_autorizacao_individual = $1 WHERE codigo = $2', ['ALTERNATIVA', ACAO_ALTERNATIVA]);
      }
    });

    test('não-MASTER recebe 403 e grupo de outra empresa é inacessível', async () => {
      const grupo = await criarGrupo('Protegido Ação');
      const grupoDeB = await criarGrupo('Ação de B', { empresaId: empresaB, atorId: masterB });

      await esperarHttpError(servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: adminA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: true,
      }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');

      await esperarHttpError(servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupoDeB.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: true,
      }), 404, 'GRUPO_NAO_ENCONTRADO');

      assert.equal(await lerAcao(pool, grupo.id, ACAO_ALTERNATIVA), null);
      assert.equal(await lerAcao(pool, grupoDeB.id, ACAO_ALTERNATIVA), null);
    });
  });

  describe('grupo inativo', () => {
    test('configurar permissões de grupo inativo é permitido, fica armazenado e NÃO reativa o grupo', async () => {
      const grupo = await criarGrupo('Inativo Configurável');
      await grupoServico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      await servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true, podeCriar: false,
      });
      await servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: true,
      });

      const { rows: [linhaGrupo] } = await pool.query('SELECT ativo FROM grupos_acesso WHERE id = $1', [grupo.id]);
      assert.equal(linhaGrupo.ativo, false, 'editar permissões não reativa o grupo');
      assert.equal((await lerRecurso(pool, grupo.id, RECURSO)).pode_visualizar, true, 'a configuração fica armazenada');
      assert.equal((await lerAcao(pool, grupo.id, ACAO_ALTERNATIVA)).permitido, true);
    });

    test('reativar o grupo depois faz as configurações TRUE voltarem a valer, sem reconfigurar nada', async () => {
      const grupo = await criarGrupo('Inativa e Reativa');
      const membro = await inserirUsuario(pool, empresaA, 'membro-reativa@demo.safeworkengenharia.com.br');
      await pool.query('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupo.id, membro]);
      await servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true,
      });
      await grupoServico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, membro), { id: grupo.id, ativo: false });
      assert.equal((await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, grupo.id, RECURSO)).podeVisualizar, true,
        'a configuração permanece armazenada enquanto inativo');

      await grupoServico.reativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, membro), { id: grupo.id, ativo: true });
      assert.equal((await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, grupo.id, RECURSO)).podeVisualizar, true);
    });
  });

  describe('listagens', () => {
    test('listam apenas as configurações do grupo da própria empresa; grupo de outra empresa é 404', async () => {
      const grupo = await criarGrupo('Com Listagem');
      const grupoDeB = await criarGrupo('Listagem de B', { empresaId: empresaB, atorId: masterB });
      await servico.configurarRecurso(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true });
      await servico.configurarRecurso(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: 'stockValidity', podeCriar: false });
      await servico.configurarAcao(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: true });

      const recursos = await servico.listarRecursos(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });
      const acoes = await servico.listarAcoes(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      assert.deepEqual(recursos.map((r) => r.recurso), ['materials', 'stockValidity']);
      assert.equal(recursos[0].podeVisualizar, true);
      assert.equal(recursos[1].podeCriar, false);
      assert.equal(acoes.length, 1);
      assert.equal(acoes[0].permitido, true);

      await esperarHttpError(servico.listarRecursos(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupoDeB.id }), 404, 'GRUPO_NAO_ENCONTRADO');
      await esperarHttpError(servico.listarAcoes(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupoDeB.id }), 404, 'GRUPO_NAO_ENCONTRADO');
    });

    // Ajuste da Subetapa 3N: as duas listagens passaram a exigir a mesma
    // autoridade administrativa das operações de escrita deste serviço
    // (mesma decisão já tomada para grupo-acesso.service.js na 3M).
    test('ADMINISTRADOR sem autoridade recebe 403 nas duas listagens, contra PostgreSQL real', async () => {
      const grupo = await criarGrupo('Listagem Sem Autoridade');

      await esperarHttpError(servico.listarRecursos(pool, { empresaId: empresaA, atorId: adminA, grupoId: grupo.id }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
      await esperarHttpError(servico.listarAcoes(pool, { empresaId: empresaA, atorId: adminA, grupoId: grupo.id }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
    });
  });

  describe('segurança transacional', () => {
    test('falha real da auditoria após gravar o recurso: ROLLBACK — nenhuma configuração e nenhum log', async (t) => {
      const grupo = await criarGrupo('Rollback Recurso');
      const auditoriaAntes = await contarAuditoria(pool, empresaA);
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada depois do UPSERT'); });

      await assert.rejects(servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true,
      }), /falha simulada/);

      assert.equal(await lerRecurso(pool, grupo.id, RECURSO), null, 'o UPSERT foi desfeito');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
    });

    test('falha real da auditoria ao atualizar configuração existente: ROLLBACK preserva o valor anterior', async (t) => {
      const grupo = await criarGrupo('Rollback Atualização');
      await servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true, podeCriar: false,
      });
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada'); });

      await assert.rejects(servico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: false,
      }), /falha simulada/);

      const linha = await lerRecurso(pool, grupo.id, RECURSO);
      assert.equal(linha.pode_visualizar, true, 'o valor anterior foi restaurado');
      assert.equal(linha.pode_criar, false);
    });

    test('falha real da auditoria ao configurar ação: ROLLBACK', async (t) => {
      const grupo = await criarGrupo('Rollback Ação');
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada'); });

      await assert.rejects(servico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: true,
      }), /falha simulada/);

      assert.equal(await lerAcao(pool, grupo.id, ACAO_ALTERNATIVA), null);
    });
  });

  describe('não-interferência com o RBAC existente', () => {
    test('nada aqui altera grupos_acesso, catálogo de ações, perfis, SST, bloqueios ou autorizações individuais', async () => {
      const grupo = await criarGrupo('Sem Efeito Colateral Perm');
      const { rows: [antes] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM permissoes_recurso) AS pr,
               (SELECT count(*)::int FROM permissoes_acao) AS pa,
               (SELECT count(*)::int FROM vinculo_sst) AS sst,
               (SELECT count(*)::int FROM usuario_bloqueios) AS bloq,
               (SELECT count(*)::int FROM usuario_autorizacoes) AS aut,
               (SELECT count(*)::int FROM acoes WHERE ativo) AS acoes_ativas,
               (SELECT count(*)::int FROM grupos_acesso WHERE empresa_id = $1) AS grupos`, [empresaA]);

      await servico.configurarRecurso(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true });
      await servico.configurarAcao(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: false });
      await servico.listarRecursos(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      const { rows: [depois] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM permissoes_recurso) AS pr,
               (SELECT count(*)::int FROM permissoes_acao) AS pa,
               (SELECT count(*)::int FROM vinculo_sst) AS sst,
               (SELECT count(*)::int FROM usuario_bloqueios) AS bloq,
               (SELECT count(*)::int FROM usuario_autorizacoes) AS aut,
               (SELECT count(*)::int FROM acoes WHERE ativo) AS acoes_ativas,
               (SELECT count(*)::int FROM grupos_acesso WHERE empresa_id = $1) AS grupos`, [empresaA]);

      assert.deepEqual(depois, antes, 'nenhuma tabela fora de grupo_permissoes_* foi tocada');
      const { rows: [catalogo] } = await pool.query('SELECT modo_autorizacao_individual, exige_sst FROM acoes WHERE codigo = $1', [ACAO_OBRIGATORIA]);
      assert.deepEqual(catalogo, { modo_autorizacao_individual: 'OBRIGATORIA', exige_sst: true }, 'catálogo intacto');
    });

    test('grupo chamado "SST" configurado com permissões não cria vinculo_sst', async () => {
      const { rows: [antes] } = await pool.query('SELECT count(*)::int AS total FROM vinculo_sst');
      const grupo = await criarGrupo('SST');

      await servico.configurarRecurso(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true });
      await servico.configurarAcao(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: true });

      const { rows: [depois] } = await pool.query('SELECT count(*)::int AS total FROM vinculo_sst');
      assert.equal(depois.total, antes.total, 'nenhum vinculo_sst criado');
      assert.equal(await permissoes.usuarioIntegraSst(pool, empresaA, masterA), false);
    });
  });
});
