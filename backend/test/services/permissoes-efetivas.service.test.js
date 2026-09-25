'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/permissoes-efetivas.service');
const autorizacao = require('../../src/middleware/autorizacao');
const autoridade = require('../../src/services/autoridade-administrativa');
const delegacao = require('../../src/services/delegacao-destinatarios.service');
const autorizacaoIndividual = require('../../src/services/autorizacao-individual.service');
const permissaoRepo = require('../../src/repositories/permissao.repository');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const { RECURSOS_CONHECIDOS } = require('../../src/rbac/recursos');

/**
 * Serviço de permissões efetivas (Bloco 9, Etapa C, Parte C1), sem banco:
 * prova que ele só COMPÕE as decisões já existentes — nunca decide nada
 * sozinho — e que o contexto passado a elas é sempre o da sessão.
 */

const CONTEXTO = { empresaId: 3, usuarioId: 70, perfil: 'SUPERVISOR' };

function mockTudo(t, { recurso = async () => ({ visualizar: true, criar: false, editar: false, excluir: false }), acao = async () => true, admin = async () => false, delegar = async () => false, ator = { id: 70, ativo: true, perfil: 'SUPERVISOR' } } = {}) {
  return {
    recurso: t.mock.method(autorizacao, 'avaliarPermissaoRecurso', recurso),
    acao: t.mock.method(autorizacao, 'avaliarPermissaoAcao', acao),
    catalogo: t.mock.method(permissaoRepo, 'listarAcoes', async () => [{ codigo: 'MOVIMENTAR_ESTOQUE' }, { codigo: 'REALIZAR_ENTREGA' }]),
    admin: t.mock.method(autoridade, 'temAutoridadeAdministrativaLeitura', admin),
    delegar: t.mock.method(delegacao, 'atorPodeDelegar', delegar),
    ator: t.mock.method(usuarioRepo, 'buscarPorId', async () => ator),
  };
}

describe('permissoes-efetivas.calcular', () => {
  test('avalia CADA recurso conhecido e CADA ação do catálogo com as funções do middleware, sempre com o contexto da sessão', async (t) => {
    const m = mockTudo(t);
    const r = await servico.calcular({}, CONTEXTO);
    assert.equal(m.recurso.mock.calls.length, RECURSOS_CONHECIDOS.length);
    assert.deepEqual(m.recurso.mock.calls.map((c) => c.arguments[2]), [...RECURSOS_CONHECIDOS]);
    for (const c of [...m.recurso.mock.calls, ...m.acao.mock.calls]) assert.deepEqual(c.arguments[1], CONTEXTO);
    assert.deepEqual(Object.keys(r.acoes), ['MOVIMENTAR_ESTOQUE', 'REALIZAR_ENTREGA']);
    assert.deepEqual([r.empresaId, r.usuarioId, r.perfil], [3, 70, 'SUPERVISOR']);
  });

  test('áreas administrativas vêm da autoridade administrativa (uma pergunta por área), consultar === alterar pelo mesmo critério', async (t) => {
    const m = mockTudo(t, { admin: async (_p, _e, _u, acaoAdm) => acaoAdm === 'ADMINISTRAR_PERMISSOES_GRUPO' });
    const r = await servico.calcular({}, CONTEXTO);
    assert.deepEqual(m.admin.mock.calls.map((c) => c.arguments.slice(1)), [
      [3, 70, 'ADMINISTRAR_GRUPOS_ACESSO'], [3, 70, 'ADMINISTRAR_PERMISSOES_GRUPO'], [3, 70, 'ADMINISTRAR_VINCULOS_GRUPO'],
    ]);
    assert.deepEqual(r.administracao.gruposAcesso, { consultar: false, alterar: false });
    assert.deepEqual(r.administracao.permissoesGrupo, { consultar: true, alterar: true });
  });

  test('autorizações individuais: consultar = ator ativo; concederDireta = predicado da 3I; delegar = predicado de /delegacao/destinatarios', async (t) => {
    mockTudo(t, { delegar: async () => true, ator: { id: 70, ativo: true, perfil: 'SUPERVISOR' } });
    let r = await servico.calcular({}, CONTEXTO);
    assert.deepEqual(r.administracao.autorizacoesIndividuais, { consultar: true, concederDireta: false, delegar: true });

    t.mock.restoreAll();
    mockTudo(t, { ator: { id: 70, ativo: true, perfil: 'MASTER' } });
    r = await servico.calcular({}, { ...CONTEXTO, perfil: 'MASTER' });
    assert.equal(r.administracao.autorizacoesIndividuais.concederDireta, true);

    t.mock.restoreAll();
    mockTudo(t, { ator: null });
    r = await servico.calcular({}, CONTEXTO);
    assert.deepEqual(r.administracao.autorizacoesIndividuais, { consultar: false, concederDireta: false, delegar: false });
  });

  test('uma falha em qualquer decisão propaga (o controller devolve 500) — nunca vira "permitido"', async (t) => {
    mockTudo(t, { acao: async () => { throw new Error('banco'); } });
    await assert.rejects(() => servico.calcular({}, CONTEXTO), /banco/);
  });

  test('contexto inválido é erro de programação, antes de qualquer consulta', async (t) => {
    const m = mockTudo(t);
    for (const ruim of [{ ...CONTEXTO, empresaId: '3' }, { ...CONTEXTO, usuarioId: 0 }, { ...CONTEXTO, perfil: '' }]) {
      await assert.rejects(() => servico.calcular({}, ruim), TypeError);
    }
    assert.equal(m.recurso.mock.calls.length, 0);
  });
});

describe('predicados extraídos (mesma regra dos serviços)', () => {
  test('atorPodeConcederDireta: só MASTER ativo', () => {
    const f = autorizacaoIndividual.atorPodeConcederDireta;
    assert.equal(f({ ativo: true, perfil: 'MASTER' }), true);
    for (const ator of [null, undefined, { ativo: false, perfil: 'MASTER' }, { ativo: true, perfil: 'ADMINISTRADOR' }]) assert.equal(f(ator), false);
  });

  test('atorPodeDelegar: MASTER, inativo ou inexistente nunca; não-MASTER só com origem efetiva', async (t) => {
    const buscar = t.mock.method(usuarioRepo, 'buscarPorId', async () => ({ id: 70, ativo: true, perfil: 'MASTER' }));
    assert.equal(await delegacao.atorPodeDelegar({}, 3, 70), false);
    buscar.mock.mockImplementation(async () => null);
    assert.equal(await delegacao.atorPodeDelegar({}, 3, 70), false);
    buscar.mock.mockImplementation(async () => ({ id: 70, ativo: true, perfil: 'USUARIO' }));
    const autorizacaoRepo = require('../../src/repositories/autorizacao-individual.repository');
    t.mock.method(autorizacaoRepo, 'listarPorUsuario', async () => [{ podeDelegar: true, acaoAtiva: true, acaoModo: 'ALTERNATIVA', acaoExigeSst: false, acaoCodigo: 'MOVIMENTAR_ESTOQUE' }]);
    t.mock.method(permissaoRepo, 'usuarioTemAutorizacaoIndividual', async () => true);
    const bloqueio = t.mock.method(permissaoRepo, 'usuarioTemBloqueio', async () => false);
    assert.equal(await delegacao.atorPodeDelegar({}, 3, 70), true);
    bloqueio.mock.mockImplementation(async () => true);
    assert.equal(await delegacao.atorPodeDelegar({}, 3, 70), false, 'bloqueio individual prevalece');
  });

  test('temAutoridadeAdministrativaLeitura: mesmo critério de exigirAutoridadeAdministrativaLeitura, sem lançar', async (t) => {
    const buscar = t.mock.method(usuarioRepo, 'buscarPorId', async () => ({ id: 70, ativo: true, perfil: 'MASTER' }));
    assert.equal(await autoridade.temAutoridadeAdministrativaLeitura({}, 3, 70, 'ADMINISTRAR_GRUPOS_ACESSO'), true);
    buscar.mock.mockImplementation(async () => ({ id: 70, ativo: true, perfil: 'SUPERVISOR' }));
    assert.equal(await autoridade.temAutoridadeAdministrativaLeitura({}, 3, 70, 'ADMINISTRAR_GRUPOS_ACESSO'), false);
    await assert.rejects(() => autoridade.exigirAutoridadeAdministrativaLeitura({}, 3, 70, 'X', 'm', 'ADMINISTRAR_GRUPOS_ACESSO'), (e) => e.status === 403);
    await assert.rejects(() => autoridade.temAutoridadeAdministrativaLeitura({}, 3, 70, 'OUTRA'), TypeError);
  });

  test('middleware delega às funções exportadas: avaliarPermissaoRecurso decide as quatro operações com as mesmas leituras', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => ({ podeVisualizar: true, podeCriar: false, podeEditar: false, podeExcluir: false }));
    t.mock.method(permissaoRepo, 'buscarGrupoAcessoDoUsuario', async () => ({ id: 9, ativo: true }));
    t.mock.method(permissaoRepo, 'buscarPermissaoRecursoGrupo', async () => ({ podeVisualizar: null, podeCriar: true, podeEditar: null, podeExcluir: null }));
    t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => ({ podeVisualizar: false, podeCriar: null, podeEditar: null, podeExcluir: null }));
    assert.deepEqual(
      await autorizacao.avaliarPermissaoRecurso({}, CONTEXTO, 'materials'),
      { visualizar: false, criar: true, editar: false, excluir: false },
    );
  });
});
