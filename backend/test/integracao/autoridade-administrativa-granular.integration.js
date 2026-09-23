'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const autorizacaoServico = require('../../src/services/autorizacao-individual.service');
const grupoServico = require('../../src/services/grupo-acesso.service');
const permissaoServico = require('../../src/services/grupo-permissao.service');
const vinculoServico = require('../../src/services/grupo-usuario.service');
const autoridade = require('../../src/services/autoridade-administrativa');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const permissoes = require('../../src/repositories/permissao.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Autoridade administrativa granular contra PostgreSQL real (Bloco 8,
 * Incremento 8, Etapa 5A, Subetapa 3Q).
 *
 * É um teste deliberadamente TRANSVERSAL, porque a funcionalidade é
 * transversal: o MASTER concede a autoridade pelo serviço de autorizações
 * individuais já aprovado na 3I (concederDireta/delegar/revogar, com toda
 * a sua transação, cadeia de origem e auditoria), e o efeito aparece nos
 * três serviços administrativos aprovados na 3J/3K/3L. Nada é simulado:
 * as concessões são linhas reais em usuario_autorizacoes, as ações vêm do
 * catálogo real (migration 024) e as operações são as de produção.
 *
 * Schema temporário exclusivo, removido em cascata ao final.
 */

// 024 é indispensável aqui: é a migration que insere as três ações
// administrativas no catálogo. 004/006 entram por causa de `funcionarios`
// (FK de grupos_acesso não depende disso, mas a 020 exige 005/006 na
// ordem histórica); 022 pelas exceções individuais de recurso.
const MIGRATIONS = ['000', '001', '002', '003', '004', '005', '006', '009', '010', '011', '012', '013', '014', '016', '017', '018', '019', '020', '021', '022', '023', '024'];

const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28';

const { GRUPOS_ACESSO, PERMISSOES_GRUPO, VINCULOS_GRUPO } = autoridade.ACOES_ADMINISTRATIVAS;
const RECURSO = 'materials';
const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE';

async function inserirUsuario(pool, empresaId, email, perfil = 'ADMINISTRADOR', ativo = true) {
  const { rows } = await pool.query(
    'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [empresaId, `Usuário ${email}`, email, HASH, perfil, ativo],
  );
  return rows[0].id;
}

async function contarAuditoria(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

async function contarGrupos(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM grupos_acesso WHERE empresa_id = $1', [empresaId]);
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

describe('autoridade administrativa granular em PostgreSQL real', () => {
  let contexto;
  let pool;
  let empresaA;
  let empresaB;
  let masterA;
  let masterB;

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
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  /** O MASTER concede a autoridade administrativa pelo caminho real da 3I. */
  const conceder = (usuarioId, acaoAdministrativa, { empresaId = empresaA, atorId = masterA, podeDelegar = false } = {}) => (
    autorizacaoServico.concederDireta(pool, {
      empresaId, concedidoPor: atorId, usuarioId, acaoCodigo: acaoAdministrativa, podeDelegar,
    })
  );

  const criarGrupo = (nome, { empresaId = empresaA, atorId = masterA } = {}) => grupoServico.criar(pool, { empresaId, atorId, nome });

  describe('catálogo da migration 024', () => {
    test('as três ações administrativas existem, ativas, em modo OBRIGATORIA e sem exigir SST', async () => {
      const { rows } = await pool.query(
        'SELECT codigo, ativo, exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo = ANY($1::text[]) ORDER BY codigo',
        [[GRUPOS_ACESSO, PERMISSOES_GRUPO, VINCULOS_GRUPO]],
      );

      assert.equal(rows.length, 3);
      for (const linha of rows) {
        assert.equal(linha.ativo, true, linha.codigo);
        assert.equal(linha.exige_sst, false, linha.codigo);
        assert.equal(linha.modo_autorizacao_individual, 'OBRIGATORIA', `${linha.codigo} precisa ser OBRIGATORIA`);
      }
    });

    test('OBRIGATORIA é o que impede promover o perfil ADMINISTRADOR em bloco: permissoes_acao do perfil não basta', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-permissao-de-perfil@demo.safeworkengenharia.com.br');
      // Permissão por PERFIL para a ação administrativa — o cenário exato
      // que NÃO deve conceder autoridade a todos os ADMINISTRADORES.
      await pool.query(
        'INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido) VALUES ($1, $2, $3, true)',
        [empresaA, 'ADMINISTRADOR', GRUPOS_ACESSO],
      );

      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Pelo Perfil' }), 403, 'GRUPO_NAO_AUTORIZADO');

      await pool.query('DELETE FROM permissoes_acao WHERE empresa_id = $1 AND acao_codigo = $2', [empresaA, GRUPOS_ACESSO]);
    });

    test('as oito ações anteriores continuam com a configuração da 017 — a 024 é puramente aditiva', async () => {
      const { rows } = await pool.query(
        'SELECT codigo, exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo NOT LIKE $1 ORDER BY codigo',
        ['ADMINISTRAR%'],
      );

      assert.equal(rows.length, 8);
      const porCodigo = Object.fromEntries(rows.map((r) => [r.codigo, r]));
      assert.equal(porCodigo.APROVAR_SOLICITACAO.modo_autorizacao_individual, 'OBRIGATORIA');
      assert.equal(porCodigo.APROVAR_SOLICITACAO.exige_sst, true);
      assert.equal(porCodigo.MOVIMENTAR_ESTOQUE.modo_autorizacao_individual, 'ALTERNATIVA');
      assert.equal(porCodigo.GERENCIAR_USUARIOS.modo_autorizacao_individual, 'NENHUMA');
      assert.equal(porCodigo.ALTERAR_CONFIGURACOES.exige_sst, false);
    });
  });

  describe('MASTER — autoridade preservada', () => {
    test('MASTER continua administrando as três áreas sem nenhuma autorização individual', async () => {
      const grupo = await criarGrupo('Master Segue Podendo');
      const membro = await inserirUsuario(pool, empresaA, 'membro-master@demo.safeworkengenharia.com.br');

      const alterado = await grupoServico.alterar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id, nome: 'Renomeado pelo Master' });
      assert.equal(alterado.nome, 'Renomeado pelo Master');

      const { alterado: permissaoAlterada } = await permissaoServico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true,
      });
      assert.equal(permissaoAlterada, true);

      const vinculo = await vinculoServico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: membro, grupoId: grupo.id });
      assert.equal(vinculo.alterado, true);

      const { rows } = await pool.query(
        'SELECT count(*)::int AS total FROM usuario_autorizacoes WHERE empresa_id = $1 AND usuario_id = $2',
        [empresaA, masterA],
      );
      assert.equal(rows[0].total, 0, 'o MASTER não precisou de autorização individual nenhuma');
    });
  });

  describe('ADMINISTRADOR expressamente autorizado', () => {
    test('sem autorização: recusado nas três áreas, sem gravar nada', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-sem-nada@demo.safeworkengenharia.com.br');
      const grupo = await criarGrupo('Alvo Admin Sem Nada');
      const membro = await inserirUsuario(pool, empresaA, 'membro-admin-sem-nada@demo.safeworkengenharia.com.br');
      const gruposAntes = await contarGrupos(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Não Deveria Existir' }), 403, 'GRUPO_NAO_AUTORIZADO');
      await esperarHttpError(grupoServico.listar(pool, { empresaId: empresaA, atorId: admin }), 403, 'GRUPO_NAO_AUTORIZADO');
      await esperarHttpError(permissaoServico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: admin, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true,
      }), 403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA');
      await esperarHttpError(vinculoServico.vincular(pool, {
        empresaId: empresaA, atorId: admin, usuarioId: membro, grupoId: grupo.id,
      }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');

      assert.equal(await contarGrupos(pool, empresaA), gruposAntes, 'nenhum grupo criado');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'nenhuma recusa auditada');
    });

    test('autorizado para ADMINISTRAR_GRUPOS_ACESSO: administra grupos de verdade, com auditoria no nome dele', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-grupos@demo.safeworkengenharia.com.br');
      await conceder(admin, GRUPOS_ACESSO);

      const grupo = await grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Criado pelo Administrador' });
      assert.equal(grupo.criadoPor, admin);

      const { rows } = await pool.query(
        "SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'GRUPO_ACESSO_CRIADO' AND referencia = $2",
        [empresaA, String(grupo.id)],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].usuario_id, admin, 'a auditoria registra o ADMINISTRADOR que agiu, não o MASTER que o autorizou');

      // E também as demais operações da mesma área, inclusive leitura.
      assert.ok((await grupoServico.listar(pool, { empresaId: empresaA, atorId: admin })).length > 0);
      assert.equal((await grupoServico.buscar(pool, { empresaId: empresaA, atorId: admin, grupoId: grupo.id })).id, grupo.id);
      assert.equal((await grupoServico.inativar(pool, { empresaId: empresaA, atorId: admin, grupoId: grupo.id })).alterado, true);
      assert.equal((await grupoServico.reativar(pool, { empresaId: empresaA, atorId: admin, grupoId: grupo.id })).alterado, true);
    });

    test('GRANULARIDADE REAL: autorizado só para permissões não administra grupos nem vínculos', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-so-permissoes@demo.safeworkengenharia.com.br');
      const grupo = await criarGrupo('Alvo Granularidade');
      const membro = await inserirUsuario(pool, empresaA, 'membro-granularidade@demo.safeworkengenharia.com.br');
      await conceder(admin, PERMISSOES_GRUPO);

      // Pode o que recebeu:
      const { alterado } = await permissaoServico.configurarAcao(pool, {
        empresaId: empresaA, atorId: admin, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: false,
      });
      assert.equal(alterado, true);
      assert.equal((await permissaoServico.listarRecursos(pool, { empresaId: empresaA, atorId: admin, grupoId: grupo.id })).length, 0);

      // E nada além disso:
      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Fora do Escopo' }), 403, 'GRUPO_NAO_AUTORIZADO');
      await esperarHttpError(grupoServico.buscar(pool, { empresaId: empresaA, atorId: admin, grupoId: grupo.id }), 403, 'GRUPO_NAO_AUTORIZADO');
      await esperarHttpError(vinculoServico.vincular(pool, {
        empresaId: empresaA, atorId: admin, usuarioId: membro, grupoId: grupo.id,
      }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');
      await esperarHttpError(vinculoServico.listarUsuariosDoGrupo(pool, { empresaId: empresaA, atorId: admin, grupoId: grupo.id }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');
    });

    test('autorizado para vínculos: move pessoas entre grupos, e a negação do grupo passa a valer para o RBAC', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-vinculos@demo.safeworkengenharia.com.br');
      const membro = await inserirUsuario(pool, empresaA, 'membro-vinculos@demo.safeworkengenharia.com.br', 'USUARIO');
      const grupo = await criarGrupo('Grupo Para Vincular');
      await conceder(admin, VINCULOS_GRUPO);

      const vinculo = await vinculoServico.vincular(pool, { empresaId: empresaA, atorId: admin, usuarioId: membro, grupoId: grupo.id });

      assert.deepEqual(vinculo, { usuarioId: membro, grupoAnteriorId: null, grupoAtualId: grupo.id, alterado: true });
      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, membro), { id: grupo.id, ativo: true });
      const membros = await vinculoServico.listarUsuariosDoGrupo(pool, { empresaId: empresaA, atorId: admin, grupoId: grupo.id });
      assert.equal(membros.some((m) => m.id === membro), true);

      const desvinculo = await vinculoServico.desvincular(pool, { empresaId: empresaA, atorId: admin, usuarioId: membro });
      assert.equal(desvinculo.alterado, true);
      assert.equal(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, membro), null);
    });

    test('ADMINISTRADOR inativado depois da concessão perde a autoridade, sem que nada seja revogado', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-sera-inativado@demo.safeworkengenharia.com.br');
      const concessao = await conceder(admin, GRUPOS_ACESSO);
      assert.ok(await grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Antes de Inativar' }));

      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [admin]);

      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Depois de Inativar' }), 403, 'GRUPO_NAO_AUTORIZADO');
      const { rows } = await pool.query('SELECT 1 FROM usuario_autorizacoes WHERE id = $1', [concessao.id]);
      assert.equal(rows.length, 1, 'a concessão continua existindo: quem mudou foi o estado do usuário');
    });

    test('bloqueio individual na ação administrativa prevalece sobre a concessão', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-bloqueado@demo.safeworkengenharia.com.br');
      await conceder(admin, GRUPOS_ACESSO);
      await pool.query('INSERT INTO usuario_bloqueios (usuario_id, acao_codigo) VALUES ($1, $2)', [admin, GRUPOS_ACESSO]);

      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Bloqueado' }), 403, 'GRUPO_NAO_AUTORIZADO');

      await pool.query('DELETE FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = $2', [admin, GRUPOS_ACESSO]);
      assert.ok(await grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Desbloqueado' }));
    });
  });

  describe('isolamento multiempresa e proibição de autoconcessão', () => {
    test('autoridade concedida na empresa A não administra a empresa B', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-cruzado@demo.safeworkengenharia.com.br');
      await conceder(admin, GRUPOS_ACESSO);
      const grupoDeB = await criarGrupo('Grupo de B', { empresaId: empresaB, atorId: masterB });
      const gruposBAntes = await contarGrupos(pool, empresaB);

      // O ator de A nem é encontrado na empresa B: 403 antes de qualquer 404.
      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaB, atorId: admin, nome: 'Invasao' }), 403, 'GRUPO_NAO_AUTORIZADO');
      await esperarHttpError(grupoServico.buscar(pool, { empresaId: empresaB, atorId: admin, grupoId: grupoDeB.id }), 403, 'GRUPO_NAO_AUTORIZADO');
      // Com a sessão correta (A), um grupo de B simplesmente não existe.
      await esperarHttpError(grupoServico.buscar(pool, { empresaId: empresaA, atorId: admin, grupoId: grupoDeB.id }), 404, 'GRUPO_NAO_ENCONTRADO');

      assert.equal(await contarGrupos(pool, empresaB), gruposBAntes);
    });

    test('ADMINISTRADOR não concede poder administrativo a si mesmo nem a outros: concederDireta é do MASTER', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-autoconcessao@demo.safeworkengenharia.com.br');
      const colega = await inserirUsuario(pool, empresaA, 'colega-autoconcessao@demo.safeworkengenharia.com.br');
      await conceder(admin, GRUPOS_ACESSO);

      // A si mesmo: recusado duas vezes (autoconcessão e perfil não-MASTER).
      await esperarHttpError(autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: admin, usuarioId: admin, acaoCodigo: GRUPOS_ACESSO,
      }), 400, 'AUTOCONCESSAO_NAO_PERMITIDA');

      // A outro ADMINISTRADOR: recusado por não ser MASTER.
      await esperarHttpError(autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: admin, usuarioId: colega, acaoCodigo: GRUPOS_ACESSO,
      }), 403, 'CONCESSAO_NAO_AUTORIZADA');

      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: colega, nome: 'Nao Autorizado' }), 403, 'GRUPO_NAO_AUTORIZADO');
    });

    test('executar não é delegar: sem pode_delegar, o ADMINISTRADOR autorizado não repassa a autoridade', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-sem-delegar@demo.safeworkengenharia.com.br');
      const colega = await inserirUsuario(pool, empresaA, 'colega-sem-delegar@demo.safeworkengenharia.com.br');
      const origem = await conceder(admin, VINCULOS_GRUPO); // podeDelegar = false (padrão)

      await esperarHttpError(autorizacaoServico.delegar(pool, {
        empresaId: empresaA, concedidoPor: admin, origemId: origem.id, usuarioId: colega,
      }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      const membro = await inserirUsuario(pool, empresaA, 'membro-sem-delegar@demo.safeworkengenharia.com.br');
      const grupo = await criarGrupo('Grupo Sem Delegar');
      await esperarHttpError(vinculoServico.vincular(pool, {
        empresaId: empresaA, atorId: colega, usuarioId: membro, grupoId: grupo.id,
      }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');
      // ...mas quem tem a autorização continua podendo executar.
      assert.equal((await vinculoServico.vincular(pool, {
        empresaId: empresaA, atorId: admin, usuarioId: membro, grupoId: grupo.id,
      })).alterado, true);
    });

    test('com pode_delegar=true concedido pelo MASTER, a autoridade é repassável e o delegado administra de fato', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-pode-delegar@demo.safeworkengenharia.com.br');
      const delegado = await inserirUsuario(pool, empresaA, 'delegado-admin@demo.safeworkengenharia.com.br');
      const origem = await conceder(admin, GRUPOS_ACESSO, { podeDelegar: true });

      const delegada = await autorizacaoServico.delegar(pool, {
        empresaId: empresaA, concedidoPor: admin, origemId: origem.id, usuarioId: delegado,
      });

      assert.equal(delegada.origemId, origem.id);
      assert.equal(delegada.podeDelegar, false, 'a delegação não propaga o direito de delegar por conta própria');
      assert.ok(await grupoServico.criar(pool, { empresaId: empresaA, atorId: delegado, nome: 'Criado pelo Delegado' }));
    });
  });

  describe('revogação da autoridade administrativa', () => {
    test('revogar a autorização derruba a autoridade na operação seguinte, e a cascata alcança o delegado', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-sera-revogado@demo.safeworkengenharia.com.br');
      const delegado = await inserirUsuario(pool, empresaA, 'delegado-sera-revogado@demo.safeworkengenharia.com.br');
      const origem = await conceder(admin, GRUPOS_ACESSO, { podeDelegar: true });
      await autorizacaoServico.delegar(pool, { empresaId: empresaA, concedidoPor: admin, origemId: origem.id, usuarioId: delegado });
      assert.ok(await grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Antes da Revogacao' }));
      assert.ok(await grupoServico.criar(pool, { empresaId: empresaA, atorId: delegado, nome: 'Delegado Antes' }));

      const { descendentesObservados } = await autorizacaoServico.revogar(pool, {
        empresaId: empresaA, revogadoPor: masterA, autorizacaoId: origem.id, motivo: 'fim do projeto',
      });

      assert.equal(descendentesObservados, 1);
      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Depois da Revogacao' }), 403, 'GRUPO_NAO_AUTORIZADO');
      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: delegado, nome: 'Delegado Depois' }), 403, 'GRUPO_NAO_AUTORIZADO');
    });

    test('revogar uma área não afeta a autoridade sobre as outras', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-duas-areas@demo.safeworkengenharia.com.br');
      const grupo = await criarGrupo('Alvo Duas Areas');
      const deGrupos = await conceder(admin, GRUPOS_ACESSO);
      await conceder(admin, PERMISSOES_GRUPO);

      await autorizacaoServico.revogar(pool, { empresaId: empresaA, revogadoPor: masterA, autorizacaoId: deGrupos.id });

      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Perdeu Grupos' }), 403, 'GRUPO_NAO_AUTORIZADO');
      assert.equal((await permissaoServico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: admin, grupoId: grupo.id, recurso: RECURSO, podeCriar: true,
      })).alterado, true, 'a autoridade sobre permissões permanece');
    });
  });

  describe('concorrência entre operação administrativa e revogação (correção pós-auditoria da 3Q)', () => {
    test('revogação em curso bloqueia a operação do ADMINISTRADOR até o COMMIT, e depois ela é recusada', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-corrida@demo.safeworkengenharia.com.br');
      const concessao = await conceder(admin, GRUPOS_ACESSO);
      const gruposAntes = await contarGrupos(pool, empresaA);

      // Conexão externa simula a revogação do MASTER já em curso: ela trava
      // a linha da autorização exatamente como revogar() faz (FOR UPDATE
      // antes do DELETE) e só então exclui.
      const externa = await pool.connect();
      try {
        await externa.query('BEGIN');
        await externa.query('SELECT id FROM usuario_autorizacoes WHERE id = $1 FOR UPDATE', [concessao.id]);

        // O ADMINISTRADOR inicia a operação administrativa: sem a correção,
        // ela leria a autorização sem lock, passaria direto e criaria o
        // grupo com uma autoridade que está sendo revogada.
        const operacao = grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Durante a Revogacao' });

        // Tempo para a operação alcançar o FOR UPDATE e ficar bloqueada.
        await new Promise((resolve) => { setTimeout(resolve, 150); });
        assert.equal(await contarGrupos(pool, empresaA), gruposAntes, 'a operação ainda não gravou nada: está bloqueada');

        await externa.query('DELETE FROM usuario_autorizacoes WHERE id = $1', [concessao.id]);
        await externa.query('COMMIT');

        await esperarHttpError(operacao, 403, 'GRUPO_NAO_AUTORIZADO');
      } finally {
        externa.release();
      }

      assert.equal(await contarGrupos(pool, empresaA), gruposAntes, 'nenhum grupo foi criado com autoridade revogada');
    });

    test('a revogação espera a operação em curso terminar: serialização nos dois sentidos', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-corrida-inversa@demo.safeworkengenharia.com.br');
      const concessao = await conceder(admin, GRUPOS_ACESSO);

      // Agora o inverso: a operação administrativa é que trava primeiro.
      const externa = await pool.connect();
      try {
        await externa.query('BEGIN');
        // Reproduz o que a operação faz ao verificar a autoridade.
        await externa.query(
          'SELECT id FROM usuario_autorizacoes WHERE empresa_id = $1 AND usuario_id = $2 AND acao_codigo = $3 FOR UPDATE',
          [empresaA, admin, GRUPOS_ACESSO],
        );

        const revogacao = autorizacaoServico.revogar(pool, {
          empresaId: empresaA, revogadoPor: masterA, autorizacaoId: concessao.id,
        });

        await new Promise((resolve) => { setTimeout(resolve, 150); });
        const { rows } = await pool.query('SELECT 1 FROM usuario_autorizacoes WHERE id = $1', [concessao.id]);
        assert.equal(rows.length, 1, 'a revogação está bloqueada: a autorização ainda existe');

        await externa.query('COMMIT');
        await revogacao;
      } finally {
        externa.release();
      }

      assert.equal((await pool.query('SELECT 1 FROM usuario_autorizacoes WHERE id = $1', [concessao.id])).rows.length, 0);
      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Depois da Espera' }), 403, 'GRUPO_NAO_AUTORIZADO');
    });

    test('o MASTER não é afetado por lock nenhum: opera normalmente com a autorização de um ADMINISTRADOR travada', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-lock-nao-afeta-master@demo.safeworkengenharia.com.br');
      const concessao = await conceder(admin, GRUPOS_ACESSO);

      const externa = await pool.connect();
      try {
        await externa.query('BEGIN');
        await externa.query('SELECT id FROM usuario_autorizacoes WHERE id = $1 FOR UPDATE', [concessao.id]);

        // O MASTER decide por perfil e nem consulta usuario_autorizacoes:
        // o lock acima não pode atrasá-lo nem bloqueá-lo.
        const grupo = await grupoServico.criar(pool, { empresaId: empresaA, atorId: masterA, nome: 'Master Durante Lock' });
        assert.ok(grupo.id);

        await externa.query('ROLLBACK');
      } finally {
        externa.release();
      }
    });

    test('a CONSULTA do ADMINISTRADOR não é bloqueada por uma revogação em curso — leitura não põe nem espera lock', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-leitura-sem-lock@demo.safeworkengenharia.com.br');
      const concessao = await conceder(admin, GRUPOS_ACESSO);
      await criarGrupo('Alvo Leitura Sem Lock');

      const externa = await pool.connect();
      try {
        await externa.query('BEGIN');
        await externa.query('SELECT id FROM usuario_autorizacoes WHERE id = $1 FOR UPDATE', [concessao.id]);

        // Enquanto a autorização está travada, a listagem precisa responder
        // normalmente: uma consulta HTTP não deve esperar por lock de linha.
        const grupos = await grupoServico.listar(pool, { empresaId: empresaA, atorId: admin });
        assert.ok(grupos.length > 0, 'a consulta respondeu sem esperar o lock');

        await externa.query('ROLLBACK');
      } finally {
        externa.release();
      }
    });
  });

  describe('preservação e segurança transacional', () => {
    test('rollback: falha real da auditoria desfaz a operação feita pelo ADMINISTRADOR autorizado', async (t) => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-rollback@demo.safeworkengenharia.com.br');
      await conceder(admin, GRUPOS_ACESSO);
      const gruposAntes = await contarGrupos(pool, empresaA);
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada pós-gravação'); });

      await assert.rejects(grupoServico.criar(pool, { empresaId: empresaA, atorId: admin, nome: 'Rollback Admin' }), /falha simulada/);

      assert.equal(await contarGrupos(pool, empresaA), gruposAntes, 'o INSERT do grupo foi desfeito');
    });

    test('a concessão administrativa não altera perfil, grupo, SST, permissões de perfil nem tri-state de grupo', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-sem-efeito-colateral@demo.safeworkengenharia.com.br');
      const grupo = await criarGrupo('Sem Efeito Colateral 3Q');
      await permissaoServico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: true, podeCriar: false,
      });
      const { rows: [antes] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM permissoes_acao WHERE empresa_id = $1) AS pa,
               (SELECT count(*)::int FROM permissoes_recurso WHERE empresa_id = $1) AS pr,
               (SELECT count(*)::int FROM vinculo_sst WHERE empresa_id = $1) AS sst,
               (SELECT count(*)::int FROM usuario_bloqueios) AS bloq,
               (SELECT count(*)::int FROM acoes WHERE ativo) AS acoes_ativas,
               (SELECT perfil FROM usuarios WHERE id = $2) AS perfil,
               (SELECT grupo_acesso_id FROM usuarios WHERE id = $2) AS grupo_do_admin`, [empresaA, admin]);

      await conceder(admin, PERMISSOES_GRUPO);

      const { rows: [depois] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM permissoes_acao WHERE empresa_id = $1) AS pa,
               (SELECT count(*)::int FROM permissoes_recurso WHERE empresa_id = $1) AS pr,
               (SELECT count(*)::int FROM vinculo_sst WHERE empresa_id = $1) AS sst,
               (SELECT count(*)::int FROM usuario_bloqueios) AS bloq,
               (SELECT count(*)::int FROM acoes WHERE ativo) AS acoes_ativas,
               (SELECT perfil FROM usuarios WHERE id = $2) AS perfil,
               (SELECT grupo_acesso_id FROM usuarios WHERE id = $2) AS grupo_do_admin`, [empresaA, admin]);

      assert.deepEqual(depois, antes, 'conceder autoridade administrativa só criou a linha em usuario_autorizacoes');
      // O tri-state do grupo continua exatamente como o MASTER deixou.
      const configuracao = await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, grupo.id, RECURSO);
      assert.equal(configuracao.podeVisualizar, true);
      assert.equal(configuracao.podeCriar, false, 'FALSE continua FALSE');
      assert.equal(configuracao.podeEditar, null, 'NULL continua NULL');
    });

    test('a autoridade administrativa não concede a ação de negócio, e a ação de negócio não concede autoridade', async () => {
      const admin = await inserirUsuario(pool, empresaA, 'admin-dominios-separados@demo.safeworkengenharia.com.br');
      const operador = await inserirUsuario(pool, empresaA, 'operador-dominios-separados@demo.safeworkengenharia.com.br');
      await conceder(admin, GRUPOS_ACESSO);
      await conceder(operador, ACAO_ALTERNATIVA);

      // Quem administra grupos não ganhou MOVIMENTAR_ESTOQUE...
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, admin, ACAO_ALTERNATIVA), false);
      // ...e quem pode movimentar estoque não administra grupos.
      await esperarHttpError(grupoServico.criar(pool, { empresaId: empresaA, atorId: operador, nome: 'Pelo Operador' }), 403, 'GRUPO_NAO_AUTORIZADO');
    });
  });
});
