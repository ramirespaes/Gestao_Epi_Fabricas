'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const empresas = require('../../src/repositories/empresa.repository');
const permissoes = require('../../src/repositories/permissao.repository');

/**
 * Repositório de permissões (RBAC) contra PostgreSQL real.
 *
 * O ponto central, como no repositório de usuários, é o isolamento entre
 * empresas: duas empresas recebem o mesmo perfil, o mesmo recurso e a mesma
 * ação, e nenhuma leitura feita no contexto de uma pode alcançar a
 * permissão ou o bloqueio da outra.
 *
 * Também comprova, com dado real, que um valor `false` persistido continua
 * `false` na leitura (não vira `null` nem `true`), e que um registro
 * simplesmente ausente devolve `null` — a distinção entre as duas coisas é
 * o ponto principal deste incremento.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito. Nenhum INSERT/UPDATE/DELETE
 * é exercitado pelo repositório: só pelos testes, diretamente no cliente,
 * para preparar o cenário.
 */

const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const PERFIL = 'ADMINISTRADOR';
const RECURSO = 'materials';
const ACAO_MOVIMENTAR = 'MOVIMENTAR_ESTOQUE';
const ACAO_APROVAR = 'APROVAR_SOLICITACAO';

const inserirUsuario = async (cliente, empresaId, email, perfil = PERFIL) => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [empresaId, 'Usuário Teste', email, '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28', perfil],
  );
  return rows[0].id;
};

const inserirPermissaoRecurso = async (cliente, empresaId, perfil, recurso, flags) => {
  await cliente.query(
    `INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [empresaId, perfil, recurso, flags.podeVisualizar, flags.podeCriar, flags.podeEditar, flags.podeExcluir],
  );
};

const inserirPermissaoAcao = async (cliente, empresaId, perfil, acaoCodigo, permitido) => {
  await cliente.query(
    `INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido) VALUES ($1, $2, $3, $4)`,
    [empresaId, perfil, acaoCodigo, permitido],
  );
};

const inserirBloqueio = async (cliente, usuarioId, acaoCodigo) => {
  await cliente.query(
    'INSERT INTO usuario_bloqueios (usuario_id, acao_codigo) VALUES ($1, $2)',
    [usuarioId, acaoCodigo],
  );
};

const inserirVinculoSst = async (cliente, empresaId, usuarioId, concedidoPor) => {
  await cliente.query(
    'INSERT INTO vinculo_sst (usuario_id, empresa_id, concedido_por) VALUES ($1, $2, $3)',
    [usuarioId, empresaId, concedidoPor],
  );
};

const inserirAutorizacaoIndividual = async (cliente, empresaId, usuarioId, acaoCodigo, autorizadoPor) => {
  await cliente.query(
    'INSERT INTO usuario_autorizacoes (usuario_id, empresa_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)',
    [usuarioId, empresaId, acaoCodigo, autorizadoPor],
  );
};

const inserirGrupoAcesso = async (cliente, empresaId, nome, criadoPor, ativo = true) => {
  const { rows } = await cliente.query(
    'INSERT INTO grupos_acesso (empresa_id, nome, criado_por, ativo) VALUES ($1, $2, $3, $4) RETURNING id',
    [empresaId, nome, criadoPor, ativo],
  );
  return rows[0].id;
};

const atribuirGrupoAoUsuario = async (cliente, usuarioId, grupoAcessoId) => {
  await cliente.query('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupoAcessoId, usuarioId]);
};

const inserirGrupoPermissaoRecurso = async (cliente, empresaId, grupoAcessoId, recurso, flags) => {
  await cliente.query(
    `INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [empresaId, grupoAcessoId, recurso, flags.podeVisualizar, flags.podeCriar, flags.podeEditar, flags.podeExcluir],
  );
};

const inserirGrupoPermissaoAcao = async (cliente, empresaId, grupoAcessoId, acaoCodigo, permitido) => {
  await cliente.query(
    'INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido) VALUES ($1, $2, $3, $4)',
    [empresaId, grupoAcessoId, acaoCodigo, permitido],
  );
};

const inserirPermissaoRecursoIndividual = async (cliente, empresaId, usuarioId, recurso, flags, concedidoPor) => {
  await cliente.query(
    `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [empresaId, usuarioId, recurso, flags.podeVisualizar, flags.podeCriar, flags.podeEditar, flags.podeExcluir, concedidoPor],
  );
};

describe('repositório de permissões em PostgreSQL real', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let usuarioA;
  let usuarioB;
  let concessorA;
  let concessorB;
  let usuarioSemGrupoA;
  let usuarioGrupoInativoA;
  let usuarioGrupoNomeSstA;
  let grupoAtivoA;
  let grupoInativoA;
  let grupoAtivoB;
  let grupoNomeSstA;
  let usuarioExcecaoA;
  let usuarioExcecaoB;
  let usuarioSemExcecaoA;

  before(async () => {
    // 013 é necessária aqui não pela tabela sessoes (não usada neste arquivo),
    // mas pela UNIQUE (empresa_id, id) que ela adiciona a usuarios — a mesma
    // reaproveitada pelas FKs compostas de vinculo_sst/usuario_autorizacoes
    // (018/019). 020/021 trazem grupos_acesso e suas permissões (Subetapa 3C);
    // 022 traz usuario_permissoes_recurso (Subetapa 3F).
    contexto = await abrirSchemaTemporario(['000', '001', '002', '003', '005', '009', '010', '011', '013', '016', '017', '018', '019', '020', '021', '022']);
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ_B, 'Empresa B'), 'ok');

    empresaA = (await empresas.buscarPorCnpj(contexto.cliente, CNPJ_A)).id;
    empresaB = (await empresas.buscarPorCnpj(contexto.cliente, CNPJ_B)).id;

    usuarioA = await inserirUsuario(contexto.cliente, empresaA, 'ana.souza@demo.safeworkengenharia.com.br');
    usuarioB = await inserirUsuario(contexto.cliente, empresaB, 'carlos.lima@demo.safeworkengenharia.com.br');
    concessorA = await inserirUsuario(contexto.cliente, empresaA, 'concessor.a@demo.safeworkengenharia.com.br', 'MASTER');
    concessorB = await inserirUsuario(contexto.cliente, empresaB, 'concessor.b@demo.safeworkengenharia.com.br', 'MASTER');
    usuarioSemGrupoA = await inserirUsuario(contexto.cliente, empresaA, 'sem.grupo@demo.safeworkengenharia.com.br');
    usuarioGrupoInativoA = await inserirUsuario(contexto.cliente, empresaA, 'grupo.inativo@demo.safeworkengenharia.com.br');
    usuarioGrupoNomeSstA = await inserirUsuario(contexto.cliente, empresaA, 'grupo.nome.sst@demo.safeworkengenharia.com.br');

    grupoAtivoA = await inserirGrupoAcesso(contexto.cliente, empresaA, 'Grupo Ativo A', concessorA, true);
    grupoInativoA = await inserirGrupoAcesso(contexto.cliente, empresaA, 'Grupo Inativo A', concessorA, false);
    grupoAtivoB = await inserirGrupoAcesso(contexto.cliente, empresaB, 'Grupo Ativo B', concessorB, true);
    // Grupo com o nome "SST" — deliberadamente não deve ter nenhum efeito
    // sobre usuarioIntegraSst, que só enxerga vinculo_sst (018). O nome é
    // só um rótulo escolhido pela empresa, sem significado especial.
    grupoNomeSstA = await inserirGrupoAcesso(contexto.cliente, empresaA, 'SST', concessorA, true);

    await atribuirGrupoAoUsuario(contexto.cliente, usuarioA, grupoAtivoA);
    await atribuirGrupoAoUsuario(contexto.cliente, usuarioGrupoInativoA, grupoInativoA);
    await atribuirGrupoAoUsuario(contexto.cliente, usuarioGrupoNomeSstA, grupoNomeSstA);
    // usuarioSemGrupoA e usuarioB permanecem sem grupo (grupo_acesso_id NULL).

    await inserirGrupoPermissaoRecurso(contexto.cliente, empresaA, grupoAtivoA, RECURSO, {
      podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: true,
    });
    await inserirGrupoPermissaoRecurso(contexto.cliente, empresaA, grupoAtivoA, 'equipamentos', {
      podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null,
    });
    await inserirGrupoPermissaoRecurso(contexto.cliente, empresaA, grupoInativoA, RECURSO, {
      podeVisualizar: false, podeCriar: null, podeEditar: null, podeExcluir: null,
    });
    await inserirGrupoPermissaoRecurso(contexto.cliente, empresaB, grupoAtivoB, RECURSO, {
      podeVisualizar: false, podeCriar: null, podeEditar: null, podeExcluir: null,
    });

    await inserirGrupoPermissaoAcao(contexto.cliente, empresaA, grupoAtivoA, ACAO_MOVIMENTAR, true);
    await inserirGrupoPermissaoAcao(contexto.cliente, empresaA, grupoAtivoA, ACAO_APROVAR, false);
    await inserirGrupoPermissaoAcao(contexto.cliente, empresaA, grupoNomeSstA, ACAO_APROVAR, true);
    await inserirGrupoPermissaoAcao(contexto.cliente, empresaB, grupoAtivoB, ACAO_MOVIMENTAR, null);
    // REALIZAR_ENTREGA deliberadamente sem linha para grupoAtivoA: cobre
    // "ausência de configuração" (grupo existe, ação existe, sem opinião).

    // Exceções individuais de recurso (Subetapa 3F) — usuarioExcecaoA reaproveita
    // grupoAtivoA como grupo principal, propositalmente: prova que a leitura
    // individual é uma tabela totalmente independente da de grupo, nunca
    // interferindo uma na outra.
    usuarioExcecaoA = await inserirUsuario(contexto.cliente, empresaA, 'excecao.individual.a@demo.safeworkengenharia.com.br');
    usuarioExcecaoB = await inserirUsuario(contexto.cliente, empresaB, 'excecao.individual.b@demo.safeworkengenharia.com.br');
    usuarioSemExcecaoA = await inserirUsuario(contexto.cliente, empresaA, 'sem.excecao.individual.a@demo.safeworkengenharia.com.br');
    await atribuirGrupoAoUsuario(contexto.cliente, usuarioExcecaoA, grupoAtivoA);

    await inserirPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioExcecaoA, RECURSO, {
      podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null,
    }, concessorA);
    await inserirPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioExcecaoA, 'equipamentos', {
      podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null,
    }, concessorA);
    await inserirPermissaoRecursoIndividual(contexto.cliente, empresaB, usuarioExcecaoB, RECURSO, {
      podeVisualizar: false, podeCriar: null, podeEditar: null, podeExcluir: true,
    }, concessorB);
    // usuarioSemExcecaoA e usuarioA (que tem grupo, mas nenhuma exceção
    // individual) deliberadamente sem nenhuma linha em
    // usuario_permissoes_recurso — cobre "usuário sem configuração
    // individual".

    // Mesmo perfil, mesmo recurso, flags deliberadamente diferentes entre as
    // duas empresas — um vazamento entre contratantes ficaria visível na
    // asserção porque os valores não coincidem.
    await inserirPermissaoRecurso(contexto.cliente, empresaA, PERFIL, RECURSO, {
      podeVisualizar: true, podeCriar: true, podeEditar: false, podeExcluir: false,
    });
    await inserirPermissaoRecurso(contexto.cliente, empresaB, PERFIL, RECURSO, {
      podeVisualizar: true, podeCriar: false, podeEditar: false, podeExcluir: false,
    });

    await inserirPermissaoAcao(contexto.cliente, empresaA, PERFIL, ACAO_MOVIMENTAR, true);
    await inserirPermissaoAcao(contexto.cliente, empresaB, PERFIL, ACAO_MOVIMENTAR, false);

    await inserirBloqueio(contexto.cliente, usuarioA, ACAO_APROVAR);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('buscarPermissaoRecurso: cada empresa lê só a sua própria flag, mesmo perfil e recurso', async () => {
    const daEmpresaA = await permissoes.buscarPermissaoRecurso(contexto.cliente, empresaA, PERFIL, RECURSO);
    const daEmpresaB = await permissoes.buscarPermissaoRecurso(contexto.cliente, empresaB, PERFIL, RECURSO);

    assert.deepEqual(daEmpresaA, { podeVisualizar: true, podeCriar: true, podeEditar: false, podeExcluir: false });
    assert.deepEqual(daEmpresaB, { podeVisualizar: true, podeCriar: false, podeEditar: false, podeExcluir: false });
    assert.notDeepEqual(daEmpresaA, daEmpresaB, 'a permissão de uma empresa não pode vazar para a outra');
  });

  test('buscarPermissaoRecurso: registro ausente devolve null', async () => {
    const semRegistro = await permissoes.buscarPermissaoRecurso(contexto.cliente, empresaA, PERFIL, 'recursoInexistente');

    assert.equal(semRegistro, null);
  });

  test('buscarPermissaoRecurso: flag false persistida continua false na leitura', async () => {
    const daEmpresaB = await permissoes.buscarPermissaoRecurso(contexto.cliente, empresaB, PERFIL, RECURSO);

    assert.equal(daEmpresaB.podeCriar, false);
    assert.notEqual(daEmpresaB.podeCriar, null, 'false não pode ser confundido com ausência de registro');
  });

  test('buscarPermissaoAcao: cada empresa lê só a sua própria permissão, mesmo perfil e ação', async () => {
    const daEmpresaA = await permissoes.buscarPermissaoAcao(contexto.cliente, empresaA, PERFIL, ACAO_MOVIMENTAR);
    const daEmpresaB = await permissoes.buscarPermissaoAcao(contexto.cliente, empresaB, PERFIL, ACAO_MOVIMENTAR);

    assert.deepEqual(daEmpresaA, { permitido: true });
    assert.deepEqual(daEmpresaB, { permitido: false });
  });

  test('buscarPermissaoAcao: registro ausente devolve null', async () => {
    const semRegistro = await permissoes.buscarPermissaoAcao(contexto.cliente, empresaA, PERFIL, ACAO_APROVAR);

    assert.equal(semRegistro, null);
  });

  test('usuarioTemBloqueio: bloqueio de usuário da empresa A não aparece ao consultar pela empresa B', async () => {
    const comoA = await permissoes.usuarioTemBloqueio(contexto.cliente, empresaA, usuarioA, ACAO_APROVAR);
    const comoB = await permissoes.usuarioTemBloqueio(contexto.cliente, empresaB, usuarioA, ACAO_APROVAR);

    assert.equal(comoA, true);
    assert.equal(comoB, false, 'consultar o mesmo usuario_id pela empresa errada não pode confirmar o bloqueio');
  });

  test('usuarioTemBloqueio: bloqueio em uma ação não implica bloqueio em outra', async () => {
    const acaoBloqueada = await permissoes.usuarioTemBloqueio(contexto.cliente, empresaA, usuarioA, ACAO_APROVAR);
    const outraAcao = await permissoes.usuarioTemBloqueio(contexto.cliente, empresaA, usuarioA, ACAO_MOVIMENTAR);

    assert.equal(acaoBloqueada, true);
    assert.equal(outraAcao, false);
  });

  test('usuarioTemBloqueio: usuário sem nenhum bloqueio devolve false', async () => {
    const bloqueado = await permissoes.usuarioTemBloqueio(contexto.cliente, empresaB, usuarioB, ACAO_APROVAR);

    assert.equal(bloqueado, false);
  });

  test('nenhuma das consultas grava ou altera dado: repetir a leitura devolve sempre o mesmo resultado', async () => {
    const antes = await permissoes.buscarPermissaoRecurso(contexto.cliente, empresaA, PERFIL, RECURSO);
    await permissoes.buscarPermissaoRecurso(contexto.cliente, empresaA, PERFIL, RECURSO);
    await permissoes.buscarPermissaoAcao(contexto.cliente, empresaA, PERFIL, ACAO_MOVIMENTAR);
    await permissoes.usuarioTemBloqueio(contexto.cliente, empresaA, usuarioA, ACAO_APROVAR);
    const depois = await permissoes.buscarPermissaoRecurso(contexto.cliente, empresaA, PERFIL, RECURSO);

    assert.deepEqual(antes, depois);

    const { rows } = await contexto.cliente.query('SELECT count(*)::int AS total FROM permissoes_recurso');
    assert.equal(rows[0].total, 2, 'nenhuma leitura pode ter inserido ou removido linhas');
  });

  test('buscarConfiguracaoAcao: reflete os valores reais semeados pela migration 017', async () => {
    const aprovar = await permissoes.buscarConfiguracaoAcao(contexto.cliente, 'APROVAR_SOLICITACAO');
    const movimentar = await permissoes.buscarConfiguracaoAcao(contexto.cliente, 'MOVIMENTAR_ESTOQUE');

    assert.deepEqual(aprovar, { ativo: true, exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
    assert.deepEqual(movimentar, { ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' });
  });

  test('buscarConfiguracaoAcao: ação inexistente no catálogo devolve null', async () => {
    const configuracao = await permissoes.buscarConfiguracaoAcao(contexto.cliente, 'ACAO_QUE_NAO_EXISTE');

    assert.equal(configuracao, null);
  });

  test('usuarioIntegraSst: concessão real, isolada por empresa', async () => {
    await inserirVinculoSst(contexto.cliente, empresaA, usuarioA, concessorA);

    assert.equal(await permissoes.usuarioIntegraSst(contexto.cliente, empresaA, usuarioA), true);
    assert.equal(await permissoes.usuarioIntegraSst(contexto.cliente, empresaB, usuarioB), false, 'usuarioB nunca recebeu SST');
    assert.equal(
      await permissoes.usuarioIntegraSst(contexto.cliente, empresaB, usuarioA),
      false,
      'consultar o usuário de A pela empresa B não pode confirmar a participação',
    );
  });

  test('usuarioTemAutorizacaoIndividual: concessão real, isolada por empresa e por ação', async () => {
    await inserirAutorizacaoIndividual(contexto.cliente, empresaA, usuarioA, 'MOVIMENTAR_ESTOQUE', concessorA);

    assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(contexto.cliente, empresaA, usuarioA, 'MOVIMENTAR_ESTOQUE'), true);
    assert.equal(
      await permissoes.usuarioTemAutorizacaoIndividual(contexto.cliente, empresaA, usuarioA, 'REALIZAR_ENTREGA'),
      false,
      'autorização para uma ação não pode valer para outra',
    );
    assert.equal(
      await permissoes.usuarioTemAutorizacaoIndividual(contexto.cliente, empresaB, usuarioB, 'MOVIMENTAR_ESTOQUE'),
      false,
      'a autorização de A não pode vazar para a empresa B',
    );
  });

  describe('buscarGrupoAcessoDoUsuario', () => {
    test('usuário com grupo ativo: devolve id e ativo=true', async () => {
      const grupo = await permissoes.buscarGrupoAcessoDoUsuario(contexto.cliente, empresaA, usuarioA);

      assert.deepEqual(grupo, { id: grupoAtivoA, ativo: true });
    });

    test('usuário com grupo inativo: devolve ativo=false sem interpretar', async () => {
      const grupo = await permissoes.buscarGrupoAcessoDoUsuario(contexto.cliente, empresaA, usuarioGrupoInativoA);

      assert.deepEqual(grupo, { id: grupoInativoA, ativo: false });
    });

    test('usuário sem grupo: devolve null', async () => {
      const grupo = await permissoes.buscarGrupoAcessoDoUsuario(contexto.cliente, empresaA, usuarioSemGrupoA);

      assert.equal(grupo, null);
    });

    test('usuário existente consultado pela empresa errada: devolve null (isolamento cruzado)', async () => {
      const grupo = await permissoes.buscarGrupoAcessoDoUsuario(contexto.cliente, empresaB, usuarioA);

      assert.equal(grupo, null, 'usuarioA pertence à empresa A; consultar pela empresa B não pode revelar o grupo');
    });

    test('usuário inexistente: devolve null', async () => {
      const grupo = await permissoes.buscarGrupoAcessoDoUsuario(contexto.cliente, empresaA, 9999999);

      assert.equal(grupo, null);
    });

    test('cada usuário lê só o seu próprio grupo, não o de outra empresa com o mesmo perfil', async () => {
      const grupo = await permissoes.buscarGrupoAcessoDoUsuario(contexto.cliente, empresaA, usuarioA);

      assert.equal(grupo.id, grupoAtivoA);
      assert.notEqual(grupo.id, grupoAtivoB, 'grupo de A não pode coincidir com o grupo de B');
    });
  });

  describe('buscarPermissaoRecursoGrupo', () => {
    test('valores TRUE/FALSE/NULL mistos na mesma linha são preservados exatamente como persistidos', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoGrupo(contexto.cliente, empresaA, grupoAtivoA, RECURSO);

      assert.deepEqual(permissao, { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: true });
    });

    test('linha existente com todos os campos NULL é distinta de linha ausente', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoGrupo(contexto.cliente, empresaA, grupoAtivoA, 'equipamentos');

      assert.deepEqual(permissao, { podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null });
      assert.notEqual(permissao, null, 'a linha existe (todas as colunas NULL); não pode ser confundida com ausência de registro');
    });

    test('recurso sem nenhuma configuração para o grupo devolve null', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoGrupo(contexto.cliente, empresaA, grupoAtivoA, 'recursoNuncaConfigurado');

      assert.equal(permissao, null);
    });

    test('isolamento entre empresas: consultar o grupo de A pela empresa B devolve null', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoGrupo(contexto.cliente, empresaB, grupoAtivoA, RECURSO);

      assert.equal(permissao, null, 'grupoAtivoA pertence à empresa A; a empresa B não pode alcançar sua configuração');
    });

    test('recursos distintos no mesmo grupo não se confundem', async () => {
      const materials = await permissoes.buscarPermissaoRecursoGrupo(contexto.cliente, empresaA, grupoAtivoA, RECURSO);
      const equipamentos = await permissoes.buscarPermissaoRecursoGrupo(contexto.cliente, empresaA, grupoAtivoA, 'equipamentos');

      assert.notDeepEqual(materials, equipamentos);
    });

    test('grupo inativo: valores são devolvidos sem qualquer interpretação do estado ativo/inativo', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoGrupo(contexto.cliente, empresaA, grupoInativoA, RECURSO);

      assert.deepEqual(permissao, { podeVisualizar: false, podeCriar: null, podeEditar: null, podeExcluir: null });
    });
  });

  describe('buscarPermissaoAcaoGrupo', () => {
    test('permitido = true é preservado exatamente', async () => {
      const permissao = await permissoes.buscarPermissaoAcaoGrupo(contexto.cliente, empresaA, grupoAtivoA, ACAO_MOVIMENTAR);

      assert.deepEqual(permissao, { permitido: true });
    });

    test('permitido = false é preservado exatamente (não vira ausência nem true)', async () => {
      const permissao = await permissoes.buscarPermissaoAcaoGrupo(contexto.cliente, empresaA, grupoAtivoA, ACAO_APROVAR);

      assert.deepEqual(permissao, { permitido: false });
      assert.notEqual(permissao, null);
    });

    test('linha existente com permitido = NULL é distinta de linha ausente', async () => {
      const permissao = await permissoes.buscarPermissaoAcaoGrupo(contexto.cliente, empresaB, grupoAtivoB, ACAO_MOVIMENTAR);

      assert.deepEqual(permissao, { permitido: null });
      assert.notEqual(permissao, null, 'a linha existe com permitido NULL; não pode ser confundida com ausência de registro');
    });

    test('ação sem nenhuma configuração para o grupo devolve null (ausência de configuração)', async () => {
      const permissao = await permissoes.buscarPermissaoAcaoGrupo(contexto.cliente, empresaA, grupoAtivoA, 'REALIZAR_ENTREGA');

      assert.equal(permissao, null);
    });

    test('isolamento entre empresas: consultar o grupo de A pela empresa B devolve null', async () => {
      const permissao = await permissoes.buscarPermissaoAcaoGrupo(contexto.cliente, empresaB, grupoAtivoA, ACAO_MOVIMENTAR);

      assert.equal(permissao, null, 'grupoAtivoA pertence à empresa A; a empresa B não pode alcançar sua configuração');
    });

    test('ações distintas no mesmo grupo não se confundem', async () => {
      const movimentar = await permissoes.buscarPermissaoAcaoGrupo(contexto.cliente, empresaA, grupoAtivoA, ACAO_MOVIMENTAR);
      const aprovar = await permissoes.buscarPermissaoAcaoGrupo(contexto.cliente, empresaA, grupoAtivoA, ACAO_APROVAR);

      assert.notDeepEqual(movimentar, aprovar);
    });

    test('grupo chamado "SST" não interfere em usuarioIntegraSst: só vinculo_sst determina participação real', async () => {
      const permissaoDoGrupoSst = await permissoes.buscarPermissaoAcaoGrupo(contexto.cliente, empresaA, grupoNomeSstA, ACAO_APROVAR);
      const grupoDoUsuario = await permissoes.buscarGrupoAcessoDoUsuario(contexto.cliente, empresaA, usuarioGrupoNomeSstA);
      const integraSst = await permissoes.usuarioIntegraSst(contexto.cliente, empresaA, usuarioGrupoNomeSstA);

      assert.deepEqual(permissaoDoGrupoSst, { permitido: true }, 'o grupo "SST" tem sua própria configuração de ação, independente de vinculo_sst');
      assert.deepEqual(grupoDoUsuario, { id: grupoNomeSstA, ativo: true });
      assert.equal(integraSst, false, 'pertencer a um grupo chamado SST não é o mesmo que ter uma linha em vinculo_sst');
    });
  });

  describe('buscarPermissaoRecursoIndividual', () => {
    test('valores TRUE/FALSE/NULL mistos na mesma linha são preservados exatamente como persistidos', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioExcecaoA, RECURSO);

      assert.deepEqual(permissao, { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null });
    });

    test('linha existente com todos os campos NULL é distinta de linha ausente', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioExcecaoA, 'equipamentos');

      assert.deepEqual(permissao, { podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null });
      assert.notEqual(permissao, null, 'a linha existe (todas as colunas NULL); não pode ser confundida com ausência de registro');
    });

    test('usuário sem nenhuma exceção individual devolve null, mesmo tendo grupo e permissão de perfil', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioSemExcecaoA, RECURSO);

      assert.equal(permissao, null);
    });

    test('usuário com grupo, mas sem exceção individual, também devolve null: as duas tabelas são independentes', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioA, RECURSO);

      assert.equal(permissao, null, 'usuarioA tem grupoAtivoA, mas nenhuma linha própria em usuario_permissoes_recurso');
    });

    test('recurso sem nenhuma configuração individual para o usuário devolve null', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioExcecaoA, 'recursoNuncaConfigurado');

      assert.equal(permissao, null);
    });

    test('isolamento entre empresas: consultar a exceção de um usuário pela empresa errada devolve null', async () => {
      const permissao = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaB, usuarioExcecaoA, RECURSO);

      assert.equal(permissao, null, 'usuarioExcecaoA pertence à empresa A; a empresa B não pode alcançar sua exceção individual');
    });

    test('valores opostos entre empresas, para o mesmo recurso, não vazam de uma para a outra', async () => {
      const daEmpresaA = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioExcecaoA, RECURSO);
      const daEmpresaB = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaB, usuarioExcecaoB, RECURSO);

      assert.deepEqual(daEmpresaA, { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: null });
      assert.deepEqual(daEmpresaB, { podeVisualizar: false, podeCriar: null, podeEditar: null, podeExcluir: true });
      assert.notDeepEqual(daEmpresaA, daEmpresaB, 'a exceção de uma empresa não pode vazar para a outra');
    });

    test('usuários diferentes no mesmo recurso não se confundem', async () => {
      const deExcecaoA = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioExcecaoA, RECURSO);
      const deSemExcecaoA = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioSemExcecaoA, RECURSO);

      assert.notEqual(deExcecaoA, null);
      assert.equal(deSemExcecaoA, null);
    });

    test('mesmo usuário em recursos diferentes não se confunde', async () => {
      const materials = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioExcecaoA, RECURSO);
      const equipamentos = await permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioExcecaoA, 'equipamentos');

      assert.notDeepEqual(materials, equipamentos);
    });

    test('entradas inválidas são recusadas antes de qualquer consulta ao banco', async () => {
      await assert.rejects(() => permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, 0, usuarioExcecaoA, RECURSO), /empresa/i);
      await assert.rejects(() => permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, 0, RECURSO), /usuário/i);
      await assert.rejects(() => permissoes.buscarPermissaoRecursoIndividual(contexto.cliente, empresaA, usuarioExcecaoA, ''), /recurso/i);
    });

    test('falha real do PostgreSQL propaga, não vira null nem valor presumido', async () => {
      const clienteEncerrado = new Client({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      });
      await clienteEncerrado.connect();
      await clienteEncerrado.end();

      await assert.rejects(() => permissoes.buscarPermissaoRecursoIndividual(clienteEncerrado, empresaA, usuarioExcecaoA, RECURSO));
    });
  });

  describe('não interferência nas consultas existentes', () => {
    test('as nove consultas anteriores continuam com o mesmo resultado após a existência de exceções individuais de recurso', async () => {
      const recursoA = await permissoes.buscarPermissaoRecurso(contexto.cliente, empresaA, PERFIL, RECURSO);
      const recursoB = await permissoes.buscarPermissaoRecurso(contexto.cliente, empresaB, PERFIL, RECURSO);
      const acaoA = await permissoes.buscarPermissaoAcao(contexto.cliente, empresaA, PERFIL, ACAO_MOVIMENTAR);
      const acaoB = await permissoes.buscarPermissaoAcao(contexto.cliente, empresaB, PERFIL, ACAO_MOVIMENTAR);
      const bloqueio = await permissoes.usuarioTemBloqueio(contexto.cliente, empresaA, usuarioA, ACAO_APROVAR);
      const configuracao = await permissoes.buscarConfiguracaoAcao(contexto.cliente, 'APROVAR_SOLICITACAO');
      const sst = await permissoes.usuarioIntegraSst(contexto.cliente, empresaA, usuarioA);
      const autorizacaoIndividual = await permissoes.usuarioTemAutorizacaoIndividual(contexto.cliente, empresaA, usuarioA, 'MOVIMENTAR_ESTOQUE');
      const grupoDoUsuario = await permissoes.buscarGrupoAcessoDoUsuario(contexto.cliente, empresaA, usuarioA);
      const permissaoDoGrupo = await permissoes.buscarPermissaoRecursoGrupo(contexto.cliente, empresaA, grupoAtivoA, RECURSO);

      assert.deepEqual(recursoA, { podeVisualizar: true, podeCriar: true, podeEditar: false, podeExcluir: false });
      assert.deepEqual(recursoB, { podeVisualizar: true, podeCriar: false, podeEditar: false, podeExcluir: false });
      assert.deepEqual(acaoA, { permitido: true });
      assert.deepEqual(acaoB, { permitido: false });
      assert.equal(bloqueio, true);
      assert.deepEqual(configuracao, { ativo: true, exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
      assert.equal(sst, true);
      assert.equal(autorizacaoIndividual, true);
      assert.deepEqual(grupoDoUsuario, { id: grupoAtivoA, ativo: true });
      assert.deepEqual(permissaoDoGrupo, { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: true });
    });

    test('as tabelas de grupo e de exceção individual não ganharam nem perderam linhas por conta das leituras', async () => {
      const { rows: recurso } = await contexto.cliente.query('SELECT count(*)::int AS total FROM grupo_permissoes_recurso');
      const { rows: acao } = await contexto.cliente.query('SELECT count(*)::int AS total FROM grupo_permissoes_acao');
      const { rows: grupos } = await contexto.cliente.query('SELECT count(*)::int AS total FROM grupos_acesso');
      const { rows: individual } = await contexto.cliente.query('SELECT count(*)::int AS total FROM usuario_permissoes_recurso');

      assert.equal(recurso[0].total, 4);
      assert.equal(acao[0].total, 4);
      assert.equal(grupos[0].total, 4);
      assert.equal(individual[0].total, 3);
    });
  });
});
