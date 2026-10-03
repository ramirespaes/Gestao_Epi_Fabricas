'use strict';

const {
  describe, test, before, after, beforeEach,
} = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations, inserir } = require('./helpers/entrega-epi');
const {
  montarMundoDoServico, chaveNova, esperarHttpError,
} = require('./helpers/solicitacao-epi-servico');
const { criarFerramentas } = require('./helpers/reserva-estoque');
const { avaliarPermissaoAcao } = require('../../src/middleware/autorizacao');
const vinculoSst = require('../../src/services/vinculo-sst.service');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { ESCOPO_PROVISIONAMENTO_MASTER } = require('../../src/rbac/recursos');

/**
 * Autoridade para encerrar a solicitação de EPI (12E-2), com a infraestrutura
 * central de autorização (avaliarPermissaoAcao, a mesma de
 * criarExigirPermissaoAcao) e a ação real do catálogo. ENCERRAR_SOLICITACAO
 * exige SST e autorização individual OBRIGATORIA, como aprovar e reprovar; a
 * rota da 12F só vai montar a fábrica com esse código.
 *
 * A diferença que importa: AUTODECISAO_PROIBIDA vale para aprovar e reprovar,
 * não para encerrar. Quem criou a solicitação e hoje tem autoridade SST e a
 * autorização individual encerra a própria solicitação aprovada, mas continua
 * proibido de decidir as próprias.
 */

const ENCERRAR = 'ENCERRAR_SOLICITACAO';
const APROVAR = 'APROVAR_SOLICITACAO';
const REPROVAR = 'REPROVAR_SOLICITACAO';
const servico = () => exigirModulo('src/services/solicitacao-epi.service');

describe('autoridade para encerrar a solicitação — autorização central (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let f;
  let sequencia = 0;

  const q = (sql, params) => pool.query(sql, params);
  const pode = (usuarioId, perfil, acao = ENCERRAR, empresaId = d.empresaA) => avaliarPermissaoAcao(pool, { empresaId, usuarioId, perfil }, acao);
  const autorizar = (usuarioId, acao = ENCERRAR, empresaId = d.empresaA, autorizadoPor = d.master) => inserir(pool, 'usuario_autorizacoes', {
    usuario_id: usuarioId, empresa_id: empresaId, acao_codigo: acao, autorizado_por: autorizadoPor,
  });
  const vincularSst = (usuarioId, empresaId = d.empresaA, atorId = d.master) => vinculoSst.concederVinculo(pool, { empresaId, atorId, usuarioId });
  const novoAdministrador = async () => {
    sequencia += 1;
    return (await inserir(pool, 'usuarios', {
      empresa_id: d.empresaA, nome: `Técnico ${sequencia}`, email: `tecnico-${sequencia}@example.invalid`, senha_hash: 'hash-de-teste', perfil: 'ADMINISTRADOR', ativo: true,
    })).id;
  };

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
    f = criarFerramentas(pool, d);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  // Sem a ação no catálogo os cenários nem se montam (as FKs de acao_codigo recusariam as concessões).
  beforeEach(async () => {
    const { rows } = await q('SELECT 1 FROM acoes WHERE codigo = $1', [ENCERRAR]);
    assert.equal(rows.length, 1, 'ação ENCERRAR_SOLICITACAO ainda não está no catálogo (migration 068)');
  });

  test('o catálogo descreve a ação como as outras decisões da SST: exige SST e autorização individual OBRIGATORIA', async () => {
    const { rows } = await q('SELECT ativo, exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo = $1', [ENCERRAR]);
    assert.deepEqual(rows, [{ ativo: true, exige_sst: true, modo_autorizacao_individual: 'OBRIGATORIA' }]);
  });

  test('não MASTER: só com vínculo SST E autorização individual própria; um sem o outro é recusado', async () => {
    const semNada = await novoAdministrador();
    assert.equal(await pode(semNada, 'ADMINISTRADOR'), false);

    const soVinculo = await novoAdministrador();
    await vincularSst(soVinculo);
    assert.equal(await pode(soVinculo, 'ADMINISTRADOR'), false, 'vínculo SST sem autorização individual');

    const soAutorizacao = await novoAdministrador();
    await autorizar(soAutorizacao);
    assert.equal(await pode(soAutorizacao, 'ADMINISTRADOR'), false, 'autorização individual sem vínculo SST');

    const completo = await novoAdministrador();
    await vincularSst(completo);
    await autorizar(completo);
    assert.equal(await pode(completo, 'ADMINISTRADOR'), true);
  });

  test('OBRIGATORIA: a permissão do perfil e a permissão do grupo não substituem a autorização individual', async () => {
    const usuario = await novoAdministrador();
    await vincularSst(usuario);
    await inserir(pool, 'permissoes_acao', { empresa_id: d.empresaA, perfil: 'ADMINISTRADOR', acao_codigo: ENCERRAR, permitido: true });
    const grupo = await inserir(pool, 'grupos_acesso', { empresa_id: d.empresaA, nome: 'SST', criado_por: d.master });
    await inserir(pool, 'grupo_permissoes_acao', { empresa_id: d.empresaA, grupo_acesso_id: grupo.id, acao_codigo: ENCERRAR, permitido: true });
    await q('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupo.id, usuario]);
    try {
      assert.equal(await pode(usuario, 'ADMINISTRADOR'), false);
    } finally {
      await q('UPDATE usuarios SET grupo_acesso_id = NULL WHERE id = $1', [usuario]);
      await q('DELETE FROM permissoes_acao WHERE empresa_id = $1 AND perfil = $2 AND acao_codigo = $3', [d.empresaA, 'ADMINISTRADOR', ENCERRAR]);
    }
  });

  test('a autorização é por ação: aprovar não dá encerrar, e encerrar não dá aprovar nem reprovar', async () => {
    const aprovador = await novoAdministrador();
    await vincularSst(aprovador);
    await autorizar(aprovador, APROVAR);
    assert.deepEqual([await pode(aprovador, 'ADMINISTRADOR', APROVAR), await pode(aprovador, 'ADMINISTRADOR', ENCERRAR)], [true, false]);
    const encerrador = await novoAdministrador();
    await vincularSst(encerrador);
    await autorizar(encerrador, ENCERRAR);
    assert.deepEqual(
      [await pode(encerrador, 'ADMINISTRADOR', ENCERRAR), await pode(encerrador, 'ADMINISTRADOR', APROVAR), await pode(encerrador, 'ADMINISTRADOR', REPROVAR)],
      [true, false, false],
    );
  });

  test('o bloqueio individual da ação é a última palavra, sobre vínculo e autorização', async () => {
    const usuario = await novoAdministrador();
    await vincularSst(usuario);
    await autorizar(usuario);
    assert.equal(await pode(usuario, 'ADMINISTRADOR'), true);
    await inserir(pool, 'usuario_bloqueios', { usuario_id: usuario, acao_codigo: ENCERRAR });
    assert.equal(await pode(usuario, 'ADMINISTRADOR'), false);
  });

  test('vínculo ou autorização de outra empresa não valem: a decisão é sempre na empresa da sessão', async () => {
    await vincularSst(d.sstB, d.empresaB, d.masterB);
    await autorizar(d.sstB, ENCERRAR, d.empresaB, d.masterB);
    assert.equal(await pode(d.sstB, 'ADMINISTRADOR', ENCERRAR, d.empresaB), true, 'na própria empresa');
    assert.equal(await pode(d.sstB, 'ADMINISTRADOR', ENCERRAR, d.empresaA), false, 'na empresa A, com o mesmo usuário');
  });

  test('MASTER: o provisionamento padrão não concede a ação; sem permissão do perfil é recusado; com ela, vale a regra central do MASTER', async () => {
    assert.equal(ESCOPO_PROVISIONAMENTO_MASTER.acoes.includes(ENCERRAR), false);
    for (const acao of [APROVAR, REPROVAR]) assert.equal(ESCOPO_PROVISIONAMENTO_MASTER.acoes.includes(acao), false, acao);
    await provisionamento.provisionar(pool, { empresaId: d.empresaA, dryRun: false });
    const { rows } = await q('SELECT count(*)::int AS n FROM permissoes_acao WHERE empresa_id = $1 AND acao_codigo IN ($2, $3, $4)', [d.empresaA, ENCERRAR, APROVAR, REPROVAR]);
    assert.equal(rows[0].n, 0, 'o provisionamento não grava as ações da SST');
    assert.equal(await pode(d.master, 'MASTER'), false, 'MASTER provisionado não encerra');

    await inserir(pool, 'permissoes_acao', { empresa_id: d.empresaA, perfil: 'MASTER', acao_codigo: ENCERRAR, permitido: true });
    try {
      assert.equal(await pode(d.master, 'MASTER'), true, 'com a permissão explícita do perfil, a regra central do MASTER dispensa SST e autorização individual');
      await inserir(pool, 'usuario_bloqueios', { usuario_id: d.master, acao_codigo: ENCERRAR });
      assert.equal(await pode(d.master, 'MASTER'), false, 'o bloqueio vale também para o MASTER');
    } finally {
      await q('DELETE FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = $2', [d.master, ENCERRAR]);
      await q('DELETE FROM permissoes_acao WHERE empresa_id = $1 AND perfil = $2 AND acao_codigo = $3', [d.empresaA, 'MASTER', ENCERRAR]);
    }
  });

  test('quem criou a solicitação e hoje tem SST e autorização para encerrar encerra a própria; a autodecisão continua proibida para aprovar e reprovar', async () => {
    const m = await f.material();
    await f.estoque(m, 2);
    const minhaAprovada = await f.aprovada({ materialId: m, quantidade: 2 });
    const minhaPendente = await servico().criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: d.trabalhador2, itens: [{ materialId: m, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });

    await vincularSst(d.solicitante);
    for (const acao of [ENCERRAR, APROVAR, REPROVAR]) await autorizar(d.solicitante, acao);
    for (const acao of [ENCERRAR, APROVAR, REPROVAR]) assert.equal(await pode(d.solicitante, 'USUARIO', acao), true, acao);

    assert.equal(typeof servico().encerrarSolicitacao, 'function', 'função ainda não implementada: encerrarSolicitacao');
    const visao = await servico().encerrarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, solicitacaoId: minhaAprovada.id, justificativa: 'Pedido em duplicidade com outra unidade', hoje: f.HOJE,
    });
    assert.deepEqual([visao.solicitacao.status, visao.solicitacao.encerramento.encerradaPor, visao.solicitacao.solicitanteUsuarioId], ['ENCERRADA', d.solicitante, d.solicitante]);

    await esperarHttpError(servico().decidirSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, solicitacaoId: minhaPendente.solicitacao.id, decisoes: [{ itemId: minhaPendente.itens[0].id, decisao: 'APROVADO' }], hoje: f.HOJE,
    }), 403, 'AUTODECISAO_PROIBIDA');
    await esperarHttpError(servico().decidirSolicitacao(pool, {
      empresaId: d.empresaA,
      atorId: d.solicitante,
      solicitacaoId: minhaPendente.solicitacao.id,
      decisoes: [{ itemId: minhaPendente.itens[0].id, decisao: 'REPROVADO', justificativa: 'Sem necessidade' }],
      hoje: f.HOJE,
    }), 403, 'AUTODECISAO_PROIBIDA');
    assert.equal((await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [minhaPendente.solicitacao.id])).rows[0].status, 'PENDENTE');
  });

  test('usuário inativo: o serviço recusa o encerramento mesmo com vínculo e autorização (a sessão já o barraria antes)', async () => {
    const m = await f.material();
    const alvo = await f.aprovada({ materialId: m, quantidade: 1 });
    const usuario = await novoAdministrador();
    await vincularSst(usuario);
    await autorizar(usuario);
    await q('UPDATE usuarios SET ativo = false WHERE id = $1', [usuario]);
    assert.equal(typeof servico().encerrarSolicitacao, 'function', 'função ainda não implementada: encerrarSolicitacao');
    await esperarHttpError(servico().encerrarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: usuario, solicitacaoId: alvo.id, justificativa: 'Teste de inativo', hoje: f.HOJE,
    }), 403, 'USUARIO_INATIVO');
  });
});
