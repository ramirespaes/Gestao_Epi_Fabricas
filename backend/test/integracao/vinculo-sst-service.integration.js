'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations, inserir } = require('./helpers/entrega-epi');
const {
  montarMundoDoServico, inserirUsuario, esperarHttpError, comLimite,
} = require('./helpers/solicitacao-epi-servico');
const permissaoRepo = require('../../src/repositories/permissao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');

/**
 * Administração do vínculo SST (12B) contra PostgreSQL real: só o MASTER ativo
 * da própria empresa concede e remove; usuário existente na mesma empresa,
 * sem duplicidade; auditoria na mesma transação; sem tocar a autorização
 * existente (permissões, autorizações individuais) e sem rota nem frontend.
 */

const servico = () => exigirModulo('src/services/vinculo-sst.service');
const repo = () => exigirModulo('src/repositories/vinculo-sst.repository');

describe('vínculo SST — serviço administrativo (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;

  const q = (sql, params) => pool.query(sql, params);
  const conceder = (usuarioId, extra = {}) => servico().concederVinculo(pool, { empresaId: d.empresaA, atorId: d.master, usuarioId, ...extra });
  const remover = (usuarioId, extra = {}) => servico().removerVinculo(pool, { empresaId: d.empresaA, atorId: d.master, usuarioId, ...extra });
  const integraSst = (usuarioId, empresaId = d.empresaA) => permissaoRepo.usuarioIntegraSst(pool, empresaId, usuarioId);
  const contar = async (tabela, onde = 'true', params = []) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${onde}`, params)).rows[0].n;
  const auditorias = (acao, alvo) => q(
    'SELECT usuario_id, referencia, descricao, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2 AND referencia = $3',
    [d.empresaA, acao, String(alvo)],
  ).then((r) => r.rows);
  const fotoDaAutorizacao = async () => (await q(
    `SELECT (SELECT count(*)::int FROM permissoes_acao) AS permissoes, (SELECT count(*)::int FROM usuario_autorizacoes) AS autorizacoes,
            (SELECT count(*)::int FROM usuario_bloqueios) AS bloqueios`,
  )).rows[0];

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('o MASTER ativo concede o vínculo: linha com quem concedeu e motivo; a camada de autorização passa a enxergar a participação na SST; auditoria na mesma transação', async () => {
    const autorizacaoAntes = await fotoDaAutorizacao();
    assert.equal(await integraSst(d.sst1), false);
    const resultado = await conceder(d.sst1, { motivo: '  Técnico de segurança do trabalho  ' });
    assert.deepEqual([resultado.usuarioId, resultado.concedidoPor, resultado.motivo], [d.sst1, d.master, 'Técnico de segurança do trabalho']);
    assert.ok(resultado.concedidoEm instanceof Date);
    assert.equal('empresaId' in resultado, false);
    assert.equal(await integraSst(d.sst1), true);
    const { rows: [linha] } = await q('SELECT empresa_id, concedido_por, motivo FROM vinculo_sst WHERE usuario_id = $1', [d.sst1]);
    assert.deepEqual([linha.empresa_id, linha.concedido_por, linha.motivo], [d.empresaA, d.master, 'Técnico de segurança do trabalho']);

    const eventos = await auditorias('VINCULO_SST_ADICIONADO', d.sst1);
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].usuario_id, d.master);
    assert.equal(eventos[0].descricao, 'Técnico de segurança do trabalho');
    assert.deepEqual(eventos[0].contexto, { usuarioId: d.sst1, comMotivo: true });
    assert.deepEqual(eventos[0].dados_novos, { usuarioId: d.sst1, concedidoPor: d.master });
    assert.equal(eventos[0].dados_anteriores, null);
    assert.deepEqual(await fotoDaAutorizacao(), autorizacaoAntes, 'a autorização existente não foi tocada');
  });

  test('o motivo é opcional; sem ele a auditoria registra comMotivo falso', async () => {
    const resultado = await conceder(d.sst2);
    assert.equal(resultado.motivo, null);
    const [evento] = await auditorias('VINCULO_SST_ADICIONADO', d.sst2);
    assert.deepEqual(evento.contexto, { usuarioId: d.sst2, comMotivo: false });
    assert.equal(evento.descricao, null);
  });

  test('vínculo duplicado é recusado sem segunda auditoria nem alterar o original', async () => {
    const antes = await q('SELECT concedido_por, concedido_em FROM vinculo_sst WHERE usuario_id = $1', [d.sst1]);
    await esperarHttpError(conceder(d.sst1, { atorId: d.master2 }), 409, 'VINCULO_SST_JA_EXISTE');
    assert.deepEqual((await q('SELECT concedido_por, concedido_em FROM vinculo_sst WHERE usuario_id = $1', [d.sst1])).rows, antes.rows);
    assert.equal((await auditorias('VINCULO_SST_ADICIONADO', d.sst1)).length, 1);
  });

  test('o MASTER remove o vínculo: a linha some, a participação cessa, o usuário continua existindo, e a remoção é auditada com o estado anterior', async () => {
    const removido = await remover(d.sst2);
    assert.equal(removido.usuarioId, d.sst2);
    assert.equal(await integraSst(d.sst2), false);
    assert.equal(await contar('usuarios', 'id = $1', [d.sst2]), 1);
    assert.equal(await integraSst(d.sst1), true, 'o vínculo de outro usuário não muda');
    const [evento] = await auditorias('VINCULO_SST_REMOVIDO', d.sst2);
    assert.equal(evento.usuario_id, d.master);
    assert.deepEqual(evento.contexto, { usuarioId: d.sst2 });
    assert.equal(evento.dados_anteriores.usuarioId, d.sst2);
    assert.equal(evento.dados_anteriores.concedidoPor, d.master);
    assert.equal(typeof evento.dados_anteriores.concedidoEm, 'string');
    assert.equal(evento.dados_novos, null);
  });

  test('remover vínculo que não existe: 404, sem auditoria', async () => {
    await esperarHttpError(remover(d.sst2), 404, 'VINCULO_SST_NAO_ENCONTRADO');
    await esperarHttpError(remover(d.solicitante), 404, 'VINCULO_SST_NAO_ENCONTRADO');
    assert.equal((await auditorias('VINCULO_SST_REMOVIDO', d.sst2)).length, 1);
  });

  test('só o MASTER ativo da própria empresa administra: ADMINISTRADOR (mesmo com vínculo), usuário comum, MASTER inativo, ator inexistente e MASTER de outra empresa recebem o mesmo 403', async () => {
    const antes = await contar('vinculo_sst');
    for (const atorId of [d.sst1, d.solicitante, d.masterInativo, 999999, d.masterB, d.sstB]) {
      await esperarHttpError(conceder(d.outroSolicitante, { atorId }), 403, 'SEM_AUTORIDADE_VINCULO_SST');
      await esperarHttpError(remover(d.sst1, { atorId }), 403, 'SEM_AUTORIDADE_VINCULO_SST');
    }
    assert.equal(await contar('vinculo_sst'), antes);
    assert.equal(await integraSst(d.sst1), true);
    assert.equal((await auditorias('VINCULO_SST_ADICIONADO', d.outroSolicitante)).length, 0);
  });

  test('o usuário alvo precisa existir na mesma empresa: inexistente e de outra empresa dão o mesmo 404, sem revelar qual; inativo não recebe vínculo', async () => {
    await esperarHttpError(conceder(999999), 404, 'USUARIO_NAO_ENCONTRADO');
    await esperarHttpError(conceder(d.usuarioB), 404, 'USUARIO_NAO_ENCONTRADO');
    await esperarHttpError(conceder(d.sstB), 404, 'USUARIO_NAO_ENCONTRADO');
    await esperarHttpError(conceder(d.usuarioInativo), 409, 'USUARIO_INATIVO');
    await esperarHttpError(remover(d.usuarioB), 404, 'VINCULO_SST_NAO_ENCONTRADO');
    assert.equal(await integraSst(d.usuarioB, d.empresaB), false);
    assert.equal(await contar('vinculo_sst', 'empresa_id = $1', [d.empresaB]), 0);
  });

  test('MASTER pode administrar, mas não recebe vínculo: concessão a alvo MASTER (ativo, inativo ou o próprio ator) é recusada com 409 claro, sem gravar nem auditar', async () => {
    const antes = await contar('vinculo_sst');
    for (const alvo of [d.master2, d.masterInativo, d.master]) {
      await esperarHttpError(conceder(alvo), 409, 'VINCULO_SST_NAO_SE_APLICA_AO_MASTER');
      assert.equal(await integraSst(alvo), false, `alvo ${alvo}`);
      assert.equal((await auditorias('VINCULO_SST_ADICIONADO', alvo)).length, 0, `alvo ${alvo}`);
    }
    assert.equal(await contar('vinculo_sst'), antes);
    // Só o perfil atual conta: o ADMINISTRADOR continua recebendo o vínculo.
    assert.equal((await conceder(d.sst2)).usuarioId, d.sst2);
    await remover(d.sst2);
  });

  test('dado legado de MASTER não é mexido sozinho: a concessão continua recusada pela regra do MASTER, e a remoção explícita do vínculo legado é permitida', async () => {
    await inserir(pool, 'vinculo_sst', { usuario_id: d.master2, empresa_id: d.empresaA, concedido_por: d.master });
    await esperarHttpError(conceder(d.master2), 409, 'VINCULO_SST_NAO_SE_APLICA_AO_MASTER');
    assert.equal(await integraSst(d.master2), true, 'o vínculo legado não foi removido automaticamente');
    assert.equal((await auditorias('VINCULO_SST_REMOVIDO', d.master2)).length, 0);
    await remover(d.master2);
    assert.equal(await integraSst(d.master2), false);
    assert.equal((await auditorias('VINCULO_SST_REMOVIDO', d.master2)).length, 1);
  });

  test('o perfil é lido do banco no momento: quem era ADMINISTRADOR com vínculo e virou MASTER continua com a linha até a remoção explícita', async () => {
    const promovido = await inserirUsuario(pool, d.empresaA, 'promovido-a@example.invalid', 'ADMINISTRADOR');
    await conceder(promovido);
    await q("UPDATE usuarios SET perfil = 'MASTER' WHERE id = $1", [promovido]);
    assert.equal(await integraSst(promovido), true, 'nada limpa o vínculo por conta própria');
    await esperarHttpError(conceder(promovido), 409, 'VINCULO_SST_NAO_SE_APLICA_AO_MASTER');
    await remover(promovido);
    assert.equal(await integraSst(promovido), false);
  });

  test('a empresa B administra o seu próprio vínculo, isolada da A', async () => {
    const resultado = await servico().concederVinculo(pool, { empresaId: d.empresaB, atorId: d.masterB, usuarioId: d.sstB });
    assert.equal(resultado.concedidoPor, d.masterB);
    assert.equal(await integraSst(d.sstB, d.empresaB), true);
    assert.equal(await integraSst(d.sstB, d.empresaA), false);
    assert.deepEqual((await repo().listarPorEmpresa(pool, d.empresaB)).map((v) => v.usuarioId), [d.sstB]);
    assert.ok(!(await repo().listarPorEmpresa(pool, d.empresaA)).some((v) => v.usuarioId === d.sstB));
    await esperarHttpError(servico().removerVinculo(pool, { empresaId: d.empresaA, atorId: d.master, usuarioId: d.sstB }), 404, 'VINCULO_SST_NAO_ENCONTRADO');
    assert.equal(await integraSst(d.sstB, d.empresaB), true, 'a empresa A não remove vínculo da B');
    await servico().removerVinculo(pool, { empresaId: d.empresaB, atorId: d.masterB, usuarioId: d.sstB });
  });

  test('remover o vínculo de usuário inativo é permitido (limpeza); o vínculo de um inativado antes continua enxergável', async () => {
    await inserir(pool, 'vinculo_sst', { usuario_id: d.usuarioInativo, empresa_id: d.empresaA, concedido_por: d.master });
    assert.equal(await integraSst(d.usuarioInativo), true);
    await remover(d.usuarioInativo);
    assert.equal(await integraSst(d.usuarioInativo), false);
  });

  test('atomicidade: se a auditoria falhar, o vínculo não é concedido nem removido', async (t) => {
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha de auditoria'); });
    await assert.rejects(conceder(d.outroSolicitante), /falha de auditoria/);
    await assert.rejects(remover(d.sst1), /falha de auditoria/);
    t.mock.restoreAll();
    assert.equal(await integraSst(d.outroSolicitante), false);
    assert.equal(await integraSst(d.sst1), true);
  });

  describe('concorrência', () => {
    test('cinco concessões simultâneas para o mesmo usuário: uma vence e quatro recebem 409; uma auditoria', async () => {
      const resultados = await Promise.allSettled(Array.from({ length: 5 }, () => conceder(d.outroSolicitante)));
      assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
      for (const r of resultados.filter((x) => x.status === 'rejected')) {
        assert.deepEqual([r.reason.status, r.reason.codigo], [409, 'VINCULO_SST_JA_EXISTE']);
      }
      assert.equal((await auditorias('VINCULO_SST_ADICIONADO', d.outroSolicitante)).length, 1);
      await remover(d.outroSolicitante);
    });

    test('dois MASTER removendo ao mesmo tempo o vínculo legado um do outro, repetidas vezes, não formam deadlock: as travas dos usuários seguem a ordem do id', async () => {
      for (let i = 0; i < 8; i += 1) {
        // Vínculo de MASTER só existe como dado legado: a concessão a MASTER é recusada, a remoção não.
        await inserir(pool, 'vinculo_sst', { usuario_id: d.master, empresa_id: d.empresaA, concedido_por: d.master });
        await inserir(pool, 'vinculo_sst', { usuario_id: d.master2, empresa_id: d.empresaA, concedido_por: d.master });
        const resultados = await comLimite(Promise.allSettled([
          remover(d.master2, { atorId: d.master }),
          remover(d.master, { atorId: d.master2 }),
        ]), `rodada ${i}`, 8000);
        assert.deepEqual(resultados.map((r) => r.status), ['fulfilled', 'fulfilled'], JSON.stringify(resultados.map((r) => r.reason?.message)));
      }
      assert.equal(await integraSst(d.master), false);
      assert.equal(await integraSst(d.master2), false);
    });

    test('concessão e remoção simultâneas do mesmo vínculo terminam em estado coerente com a auditoria', async () => {
      await conceder(d.outroSolicitante);
      const resultados = await Promise.allSettled([remover(d.outroSolicitante), conceder(d.outroSolicitante, { atorId: d.master2 })]);
      const removidas = (await auditorias('VINCULO_SST_REMOVIDO', d.outroSolicitante)).length;
      const adicionadas = (await auditorias('VINCULO_SST_ADICIONADO', d.outroSolicitante)).length;
      const existe = await integraSst(d.outroSolicitante);
      // Adicionadas menos removidas é o que existe: 1 + (concessão feita) − (remoção feita).
      assert.equal(adicionadas - removidas, existe ? 1 : 0, JSON.stringify(resultados.map((r) => r.status)));
      assert.ok(resultados.filter((r) => r.status === 'fulfilled').length >= 1);
    });
  });
});
