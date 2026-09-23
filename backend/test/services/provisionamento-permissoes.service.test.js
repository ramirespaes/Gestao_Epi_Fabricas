'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/provisionamento-permissoes.service');
const empresaRepo = require('../../src/repositories/empresa.repository');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const permissaoRepo = require('../../src/repositories/permissao.repository');
const provisionamentoRepo = require('../../src/repositories/permissao-provisionamento.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');

/**
 * Serviço de provisionamento do MASTER (Bloco 9, Etapa B), sem PostgreSQL.
 * Pontos centrais: classificação AUSENTE/ADEQUADA/INSUFICIENTE/
 * NAO_CATALOGADA; dry-run não abre transação nem escreve; execução real
 * insere SÓ o ausente, nunca toca o existente, audita uma vez e só quando
 * inseriu; empresa inexistente/inativa e ator de outra empresa recusados.
 */

const EMPRESA = 42;
const ATOR = 7;

function criarClienteFalso() {
  const chamadas = [];
  return { chamadas, query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; }, release: () => { chamadas.push('RELEASE'); } };
}
const criarPoolFalso = (cliente) => ({ connect: async () => cliente, query: (...args) => cliente.query(...args) });
const contar = (chamadas, padrao) => chamadas.filter((c) => padrao.test(c)).length;

const flagsCompletas = { podeVisualizar: true, podeCriar: true, podeEditar: true, podeExcluir: false };

/**
 * Mundo configurável: `recursosExistentes` e `acoesExistentes` descrevem o
 * que "já está no banco"; `catalogo` descreve `acoes`.
 */
function mundo(t, {
  empresa = { id: EMPRESA, nome: 'Empresa A', cnpj: '11222333000181', ativo: true },
  recursosExistentes = new Map(),
  acoesExistentes = new Map(),
  catalogo = { MOVIMENTAR_ESTOQUE: { ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' } },
  ator = { id: ATOR, empresaId: EMPRESA },
} = {}) {
  t.mock.method(empresaRepo, 'buscarPorId', async (_e, id) => (id === EMPRESA && empresa ? empresa : null));
  t.mock.method(usuarioRepo, 'buscarPorId', async (_e, empresaId, id) => (ator && empresaId === ator.empresaId && id === ator.id ? ator : null));
  t.mock.method(permissaoRepo, 'buscarConfiguracaoAcao', async (_e, codigo) => catalogo[codigo] ?? null);
  return {
    listarRecursos: t.mock.method(provisionamentoRepo, 'listarPermissoesRecurso', async () => new Map(recursosExistentes)),
    listarAcoes: t.mock.method(provisionamentoRepo, 'listarPermissoesAcao', async () => new Map(acoesExistentes)),
    inserirRecurso: t.mock.method(provisionamentoRepo, 'inserirPermissaoRecursoSeAusente', async () => true),
    inserirAcao: t.mock.method(provisionamentoRepo, 'inserirPermissaoAcaoSeAusente', async () => true),
    registrar: t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '77', criadoEm: new Date() })),
  };
}

describe('planejar', () => {
  test('banco vazio: 3 recursos AUSENTES com as flags esperadas (excluir=false) e 1 ação AUSENTE', async (t) => {
    mundo(t);
    const plano = await servico.planejar({ query: async () => ({ rows: [] }) }, { empresaId: EMPRESA });
    assert.deepEqual(plano.empresa, { id: EMPRESA, nome: 'Empresa A', ativo: true });
    assert.equal(plano.perfil, 'MASTER');
    assert.deepEqual(plano.recursos.map((r) => [r.recurso, r.situacao]), [['materials', 'AUSENTE'], ['employeeHistory', 'AUSENTE'], ['employeeGroups', 'AUSENTE']]);
    assert.deepEqual(plano.recursos[0].esperado, flagsCompletas);
    assert.deepEqual(plano.acoes, [{ acaoCodigo: 'MOVIMENTAR_ESTOQUE', situacao: 'AUSENTE', catalogo: 'ATIVA', atual: null }]);
    assert.deepEqual(servico.resumir(plano), { AUSENTE: 4, ADEQUADA: 0, INSUFICIENTE: 0, NAO_CATALOGADA: 0, INSERIDA: 0 });
  });

  test('distingue ADEQUADA (todas as operações exigidas) de INSUFICIENTE (alguma negada), com as faltantes nomeadas', async (t) => {
    mundo(t, {
      recursosExistentes: new Map([
        ['materials', { recurso: 'materials', ...flagsCompletas }],
        ['employeeHistory', { recurso: 'employeeHistory', podeVisualizar: true, podeCriar: false, podeEditar: false, podeExcluir: false }],
      ]),
      acoesExistentes: new Map([['MOVIMENTAR_ESTOQUE', { acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: false }]]),
    });
    const plano = await servico.planejar({ query: async () => ({ rows: [] }) }, { empresaId: EMPRESA });
    const porRecurso = Object.fromEntries(plano.recursos.map((r) => [r.recurso, r]));
    assert.equal(porRecurso.materials.situacao, 'ADEQUADA');
    assert.deepEqual(porRecurso.materials.faltantes, []);
    assert.equal(porRecurso.employeeHistory.situacao, 'INSUFICIENTE');
    assert.deepEqual(porRecurso.employeeHistory.faltantes, ['criar', 'editar']);
    assert.equal(porRecurso.employeeGroups.situacao, 'AUSENTE');
    assert.equal(plano.acoes[0].situacao, 'INSUFICIENTE');
    assert.deepEqual(servico.resumir(plano), { AUSENTE: 1, ADEQUADA: 1, INSUFICIENTE: 2, NAO_CATALOGADA: 0, INSERIDA: 0 });
  });

  test('pode_excluir=true numa linha existente não é exigido nem conta contra: continua ADEQUADA', async (t) => {
    mundo(t, { recursosExistentes: new Map([['materials', { recurso: 'materials', ...flagsCompletas, podeExcluir: true }]]) });
    const plano = await servico.planejar({ query: async () => ({ rows: [] }) }, { empresaId: EMPRESA });
    assert.equal(plano.recursos[0].situacao, 'ADEQUADA');
  });

  test('ação fora do catálogo ou inativa: NAO_CATALOGADA (nada a conceder)', async (t) => {
    mundo(t, { catalogo: {} });
    const plano = await servico.planejar({ query: async () => ({ rows: [] }) }, { empresaId: EMPRESA });
    assert.deepEqual(plano.acoes[0], { acaoCodigo: 'MOVIMENTAR_ESTOQUE', situacao: 'NAO_CATALOGADA', catalogo: 'INEXISTENTE', atual: null });

    mundo(t, { catalogo: { MOVIMENTAR_ESTOQUE: { ativo: false, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' } } });
    const inativa = await servico.planejar({ query: async () => ({ rows: [] }) }, { empresaId: EMPRESA });
    assert.equal(inativa.acoes[0].catalogo, 'INATIVA');
  });

  test('empresa inexistente ou inativa: ErroProvisionamento com código, antes de ler permissões', async (t) => {
    const semEmpresa = mundo(t, { empresa: null });
    await assert.rejects(() => servico.planejar({}, { empresaId: EMPRESA }), (e) => e instanceof servico.ErroProvisionamento && e.codigo === 'EMPRESA_NAO_ENCONTRADA');
    assert.equal(semEmpresa.listarRecursos.mock.calls.length, 0);

    const inativa = mundo(t, { empresa: { id: EMPRESA, nome: 'X', cnpj: '11222333000181', ativo: false } });
    await assert.rejects(() => servico.planejar({}, { empresaId: EMPRESA }), (e) => e.codigo === 'EMPRESA_INATIVA');
    assert.equal(inativa.listarRecursos.mock.calls.length, 0);
  });
});

describe('provisionar — dry-run', () => {
  test('não abre transação, não insere, não audita; devolve o plano', async (t) => {
    const escritas = mundo(t);
    const cliente = criarClienteFalso();
    const r = await servico.provisionar(criarPoolFalso(cliente), { empresaId: EMPRESA, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(contar(cliente.chamadas, /^BEGIN$/), 0);
    assert.equal(escritas.inserirRecurso.mock.calls.length, 0);
    assert.equal(escritas.inserirAcao.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.deepEqual(r.inseridos, { recursos: [], acoes: [] });
    assert.equal(r.auditoriaId, null);
    assert.equal(r.plano.recursos.length, 3);
  });

  test('dryRun precisa ser booleano explícito; ids validados antes de qualquer leitura', async (t) => {
    const escritas = mundo(t);
    await assert.rejects(() => servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA }), TypeError);
    await assert.rejects(() => servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, dryRun: 'true' }), TypeError);
    await assert.rejects(() => servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: 0, dryRun: true }), TypeError);
    await assert.rejects(() => servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: -1, dryRun: true }), TypeError);
    assert.equal(escritas.listarRecursos.mock.calls.length, 0);
  });
});

describe('provisionar — execução real', () => {
  test('insere SÓ o AUSENTE com as flags esperadas, audita UMA vez com ator, commita', async (t) => {
    const escritas = mundo(t, {
      recursosExistentes: new Map([['materials', { recurso: 'materials', ...flagsCompletas }]]),
    });
    const cliente = criarClienteFalso();
    const r = await servico.provisionar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR, dryRun: false, ip: '127.0.0.1', dispositivo: 'cli' });

    assert.equal(r.dryRun, false);
    assert.deepEqual(r.inseridos, { recursos: ['employeeHistory', 'employeeGroups'], acoes: ['MOVIMENTAR_ESTOQUE'] });
    assert.equal(escritas.inserirRecurso.mock.calls.length, 2);
    for (const chamada of escritas.inserirRecurso.mock.calls) {
      const dados = chamada.arguments[1];
      assert.equal(dados.perfil, 'MASTER');
      assert.notEqual(dados.recurso, 'materials', 'a linha existente não é reinserida nem alterada');
      assert.deepEqual({ podeVisualizar: dados.podeVisualizar, podeCriar: dados.podeCriar, podeEditar: dados.podeEditar, podeExcluir: dados.podeExcluir }, flagsCompletas);
    }
    assert.deepEqual(escritas.inserirAcao.mock.calls[0].arguments[1], { empresaId: EMPRESA, perfil: 'MASTER', acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: true });

    assert.equal(escritas.registrar.mock.calls.length, 1);
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'PERMISSOES_MASTER_PROVISIONADAS');
    assert.equal(auditoria.usuarioId, ATOR);
    assert.equal(auditoria.referencia, String(EMPRESA));
    assert.equal(auditoria.contexto.origem, 'script_administrativo');
    assert.deepEqual(auditoria.dadosNovos.recursos.map((x) => x.recurso), ['employeeHistory', 'employeeGroups']);
    assert.deepEqual(auditoria.dadosNovos.acoes, [{ acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: true }]);
    assert.equal(r.auditoriaId, '77');
    assert.equal(contar(cliente.chamadas, /^BEGIN$/), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
    assert.equal(contar(cliente.chamadas, /^RELEASE$/), 1);

    // A/B/C/D/E — ajuste final (v4→v5): o plano FINAL não pode chamar de
    // AUSENTE o que foi inserido e confirmado; os dois itens que eram
    // AUSENTE viram INSERIDA, o que já existia (materials) permanece
    // ADEQUADA, e os totais refletem exatamente esse estado final.
    const porRecurso = Object.fromEntries(r.plano.recursos.map((x) => [x.recurso, x]));
    assert.equal(porRecurso.materials.situacao, 'ADEQUADA', 'já existia — não foi tocada, não vira INSERIDA');
    assert.equal(porRecurso.employeeHistory.situacao, 'INSERIDA');
    assert.equal(porRecurso.employeeGroups.situacao, 'INSERIDA');
    assert.equal(r.plano.acoes[0].situacao, 'INSERIDA');
    assert.deepEqual(servico.resumir(r.plano), { AUSENTE: 0, ADEQUADA: 1, INSUFICIENTE: 0, NAO_CATALOGADA: 0, INSERIDA: 3 });
  });

  test('A/B/C/D/E — empresa sem NENHUMA permissão: planejamento identifica 4 AUSENTES, execução insere os 4, plano final não tem nenhum AUSENTE restante', async (t) => {
    mundo(t); // tudo ausente: recursosExistentes/acoesExistentes vazios (padrão)
    const r = await servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, dryRun: false });

    assert.deepEqual(r.inseridos.recursos.sort(), ['employeeGroups', 'employeeHistory', 'materials']);
    assert.deepEqual(r.inseridos.acoes, ['MOVIMENTAR_ESTOQUE']);
    for (const item of r.plano.recursos) {
      assert.equal(item.situacao, 'INSERIDA', item.recurso);
      assert.deepEqual(item.faltantes, []);
    }
    assert.equal(r.plano.acoes[0].situacao, 'INSERIDA');
    // E — total de AUSENTES corresponde ao estado final EFETIVAMENTE
    // confirmado (zero — os 4 foram inseridos e confirmados nesta transação).
    assert.deepEqual(servico.resumir(r.plano), { AUSENTE: 0, ADEQUADA: 0, INSUFICIENTE: 0, NAO_CATALOGADA: 0, INSERIDA: 4 });
  });

  test('F — dry-run continua sendo SIMULAÇÃO: plano permanece AUSENTE (nunca INSERIDA), nada em inseridos', async (t) => {
    mundo(t);
    const r = await servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.inseridos, { recursos: [], acoes: [] });
    assert.ok(r.plano.recursos.every((x) => x.situacao === 'AUSENTE'));
    assert.ok(r.plano.acoes.every((x) => x.situacao === 'AUSENTE'));
    assert.deepEqual(servico.resumir(r.plano), { AUSENTE: 4, ADEQUADA: 0, INSUFICIENTE: 0, NAO_CATALOGADA: 0, INSERIDA: 0 });
  });

  test('G/H — execução mista: inserido vira INSERIDA; ADEQUADA preexistente continua ADEQUADA; INSUFICIENTE preexistente permanece INSUFICIENTE e sinalizada — nada se confunde', async (t) => {
    const escritas = mundo(t, {
      recursosExistentes: new Map([
        ['materials', { recurso: 'materials', ...flagsCompletas }], // já ADEQUADA
        ['employeeHistory', { recurso: 'employeeHistory', podeVisualizar: true, podeCriar: false, podeEditar: false, podeExcluir: false }], // INSUFICIENTE
        // employeeGroups: ausente -> será inserida
      ]),
      acoesExistentes: new Map([['MOVIMENTAR_ESTOQUE', { acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: false }]]), // INSUFICIENTE
    });
    const r = await servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, dryRun: false });

    const porRecurso = Object.fromEntries(r.plano.recursos.map((x) => [x.recurso, x]));
    assert.equal(porRecurso.materials.situacao, 'ADEQUADA');
    assert.equal(porRecurso.employeeHistory.situacao, 'INSUFICIENTE');
    assert.deepEqual(porRecurso.employeeHistory.faltantes, ['criar', 'editar']);
    assert.equal(porRecurso.employeeGroups.situacao, 'INSERIDA');
    assert.equal(r.plano.acoes[0].situacao, 'INSUFICIENTE');
    assert.deepEqual(r.inseridos.recursos, ['employeeGroups']);
    assert.deepEqual(r.inseridos.acoes, []);
    assert.deepEqual(servico.resumir(r.plano), { AUSENTE: 0, ADEQUADA: 1, INSUFICIENTE: 2, NAO_CATALOGADA: 0, INSERIDA: 1 });

    // H — nenhum segundo insert/nenhuma tentativa de tocar a linha
    // insuficiente preexistente.
    assert.equal(escritas.inserirRecurso.mock.calls.filter((c) => c.arguments[1].recurso === 'employeeHistory').length, 0);
    assert.equal(escritas.inserirAcao.mock.calls.length, 0);

    // J — auditoria e o que ela relata como pendência batem com o plano final.
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.deepEqual(auditoria.dadosNovos.recursos.map((x) => x.recurso), ['employeeGroups']);
    assert.deepEqual(auditoria.contexto.naoAlterados.recursosInsuficientes, [{ recurso: 'employeeHistory', faltantes: ['criar', 'editar'] }]);
    assert.deepEqual(auditoria.contexto.naoAlterados.acoesInsuficientes, ['MOVIMENTAR_ESTOQUE']);
  });

  test('I — corrida concorrente (correção da v4) continua funcionando junto do ajuste final: item que perdeu a corrida vira ADEQUADA/INSUFICIENTE, NUNCA INSERIDA (esta transação não foi quem inseriu)', async (t) => {
    const escritas = mundo(t);
    escritas.inserirRecurso.mock.mockImplementation(async (_c, { recurso }) => recurso !== 'materials');
    escritas.listarRecursos.mock.mockImplementation(async (_e, _empresaId, _perfil, recursos) => (
      recursos.length === 1 && recursos[0] === 'materials'
        ? new Map([['materials', { recurso: 'materials', ...flagsCompletas }]])
        : new Map()
    ));

    const r = await servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, dryRun: false });

    const materials = r.plano.recursos.find((x) => x.recurso === 'materials');
    assert.equal(materials.situacao, 'ADEQUADA', 'perdeu a corrida: relida, nunca INSERIDA por esta transação');
    assert.ok(!r.inseridos.recursos.includes('materials'));
    const restantes = r.plano.recursos.filter((x) => x.recurso !== 'materials');
    assert.ok(restantes.every((x) => x.situacao === 'INSERIDA'), 'os que não colidiram foram, de fato, inseridos por esta transação');
    assert.deepEqual(servico.resumir(r.plano), { AUSENTE: 0, ADEQUADA: 1, INSUFICIENTE: 0, NAO_CATALOGADA: 0, INSERIDA: 3 });
  });

  test('INSUFICIENTE não é tocada: nenhum insert para ela, e ela é relatada na auditoria como não alterada', async (t) => {
    const escritas = mundo(t, {
      recursosExistentes: new Map([['materials', { recurso: 'materials', podeVisualizar: true, podeCriar: true, podeEditar: false, podeExcluir: false }]]),
      acoesExistentes: new Map([['MOVIMENTAR_ESTOQUE', { acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: false }]]),
    });
    const r = await servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, dryRun: false });
    assert.deepEqual(r.inseridos, { recursos: ['employeeHistory', 'employeeGroups'], acoes: [] });
    assert.ok(escritas.inserirRecurso.mock.calls.every((c) => c.arguments[1].recurso !== 'materials'));
    assert.equal(escritas.inserirAcao.mock.calls.length, 0);
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.usuarioId, null);
    assert.equal(auditoria.contexto.origem, 'script_administrativo_sem_ator');
    assert.deepEqual(auditoria.contexto.naoAlterados, {
      recursosInsuficientes: [{ recurso: 'materials', faltantes: ['editar'] }],
      acoesInsuficientes: ['MOVIMENTAR_ESTOQUE'],
      acoesNaoCatalogadas: [],
    });
  });

  test('idempotência: tudo ADEQUADA → nenhum insert, nenhuma auditoria, ainda assim COMMIT limpo', async (t) => {
    const escritas = mundo(t, {
      recursosExistentes: new Map([
        ['materials', { recurso: 'materials', ...flagsCompletas }],
        ['employeeHistory', { recurso: 'employeeHistory', ...flagsCompletas }],
        ['employeeGroups', { recurso: 'employeeGroups', ...flagsCompletas }],
      ]),
      acoesExistentes: new Map([['MOVIMENTAR_ESTOQUE', { acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: true }]]),
    });
    const cliente = criarClienteFalso();
    const r = await servico.provisionar(criarPoolFalso(cliente), { empresaId: EMPRESA, dryRun: false });
    assert.deepEqual(r.inseridos, { recursos: [], acoes: [] });
    assert.equal(r.auditoriaId, null);
    assert.equal(escritas.registrar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  /**
   * Correção pós-auditoria independente de 23/09/2026 (Ajuste 2): quando
   * `inserirPermissaoRecursoSeAusente`/`inserirPermissaoAcaoSeAusente`
   * devolve `false` (ON CONFLICT DO NOTHING — outra transação inseriu a
   * mesma linha entre o planejamento e esta tentativa), o serviço NUNCA
   * presume o que aconteceu: relê a permissão real na MESMA transação e
   * reclassifica o item planejado como AUSENTE para ADEQUADA ou
   * INSUFICIENTE — nunca conta como inserido, nunca sobrescreve.
   *
   * Nestes testes, `listarPermissoesRecurso`/`listarPermissoesAcao` são
   * chamados duas vezes por item em conflito: a primeira (lista completa do
   * escopo) alimenta `planejar()`; a segunda (lista de um único item) é a
   * releitura pontual pós-conflito — distinguidas pelo tamanho da lista
   * recebida.
   */
  describe('corrida na inserção "se ausente" (conflito concorrente)', () => {
    test('A/B/F — linha concorrente já ADEQUADA: relida na mesma transação, reclassificada, NÃO contada como inserida nem auditada', async (t) => {
      const escritas = mundo(t);
      escritas.inserirRecurso.mock.mockImplementation(async (_c, { recurso }) => recurso !== 'materials');
      escritas.listarRecursos.mock.mockImplementation(async (_e, _empresaId, _perfil, recursos) => (
        recursos.length === 1 && recursos[0] === 'materials'
          ? new Map([['materials', { recurso: 'materials', ...flagsCompletas }]])
          : new Map()
      ));

      const r = await servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, dryRun: false });

      assert.deepEqual(r.inseridos.recursos, ['employeeHistory', 'employeeGroups'], 'materials NÃO entra em inseridos: a releitura mostrou que já existia');
      const materials = r.plano.recursos.find((x) => x.recurso === 'materials');
      assert.equal(materials.situacao, 'ADEQUADA');
      assert.deepEqual(materials.faltantes, []);
      const auditoria = escritas.registrar.mock.calls[0].arguments[1];
      assert.ok(!auditoria.dadosNovos.recursos.some((x) => x.recurso === 'materials'), 'auditoria nunca descreve uma inserção que não aconteceu');
      assert.equal(escritas.listarRecursos.mock.calls.length, 2, 'planejamento + exatamente uma releitura pontual');
      assert.equal(escritas.inserirRecurso.mock.calls.filter((c) => c.arguments[1].recurso === 'materials').length, 1, 'uma única tentativa de INSERT — nenhum DO UPDATE, nenhuma segunda tentativa');
    });

    test('A/B/C/G/H — linha concorrente NEGADA (INSUFICIENTE): preservada INTOCADA, relatada nominalmente, NÃO contada como inserida', async (t) => {
      const escritas = mundo(t);
      escritas.inserirRecurso.mock.mockImplementation(async (_c, { recurso }) => recurso !== 'employeeHistory');
      escritas.listarRecursos.mock.mockImplementation(async (_e, _empresaId, _perfil, recursos) => (
        recursos.length === 1 && recursos[0] === 'employeeHistory'
          ? new Map([['employeeHistory', { recurso: 'employeeHistory', podeVisualizar: true, podeCriar: false, podeEditar: false, podeExcluir: false }]])
          : new Map()
      ));

      const r = await servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, dryRun: false });

      assert.deepEqual(r.inseridos.recursos, ['materials', 'employeeGroups']);
      const employeeHistory = r.plano.recursos.find((x) => x.recurso === 'employeeHistory');
      assert.equal(employeeHistory.situacao, 'INSUFICIENTE');
      assert.deepEqual(employeeHistory.faltantes, ['criar', 'editar']);
      const auditoria = escritas.registrar.mock.calls[0].arguments[1];
      assert.ok(!auditoria.dadosNovos.recursos.some((x) => x.recurso === 'employeeHistory'), 'nenhuma inserção indevida registrada na auditoria');
      assert.deepEqual(auditoria.contexto.naoAlterados.recursosInsuficientes, [{ recurso: 'employeeHistory', faltantes: ['criar', 'editar'] }], 'comunicação expressa da pendência ao operador');
      assert.equal(escritas.inserirRecurso.mock.calls.filter((c) => c.arguments[1].recurso === 'employeeHistory').length, 1, 'nenhuma segunda tentativa de escrita sobre a linha negada');
    });

    test('A/B/C — mesma corrida, agora numa AÇÃO: negada concorrente vira INSUFICIENTE, preservada e relatada', async (t) => {
      const escritas = mundo(t);
      escritas.inserirAcao.mock.mockImplementation(async () => false);
      // Distinção pela ORDEM de chamada (a lista pedida é a mesma nas duas
      // leituras — ao contrário dos recursos, o escopo de ações tem um
      // único item): a 1ª (planejamento) mostra AUSENTE; a 2ª (releitura
      // pós-conflito, dentro da mesma transação) mostra a linha concorrente.
      let chamada = 0;
      escritas.listarAcoes.mock.mockImplementation(async (_e, _empresaId, _perfil, acoes) => {
        chamada += 1;
        return chamada === 1 ? new Map() : new Map([[acoes[0], { acaoCodigo: acoes[0], permitido: false }]]);
      });

      const r = await servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, dryRun: false });

      assert.deepEqual(r.inseridos.acoes, []);
      assert.equal(r.plano.acoes[0].situacao, 'INSUFICIENTE');
      const auditoria = escritas.registrar.mock.calls[0].arguments[1];
      assert.deepEqual(auditoria.contexto.naoAlterados.acoesInsuficientes, ['MOVIMENTAR_ESTOQUE']);
      assert.ok(!auditoria.dadosNovos.acoes.some((x) => x.acaoCodigo === 'MOVIMENTAR_ESTOQUE'));
    });

    test('F — mesma corrida numa AÇÃO, concorrente já ADEQUADA (permitido=true): reclassificada, não inserida', async (t) => {
      const escritas = mundo(t);
      escritas.inserirAcao.mock.mockImplementation(async () => false);
      let chamada = 0;
      escritas.listarAcoes.mock.mockImplementation(async (_e, _empresaId, _perfil, acoes) => {
        chamada += 1;
        return chamada === 1 ? new Map() : new Map([[acoes[0], { acaoCodigo: acoes[0], permitido: true }]]);
      });

      const r = await servico.provisionar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, dryRun: false });

      assert.deepEqual(r.inseridos.acoes, []);
      assert.equal(r.plano.acoes[0].situacao, 'ADEQUADA');
    });

    test('E/9 — estado indeterminado (releitura não encontra a linha após conflito): NUNCA presume sucesso — rejeita, ROLLBACK, sem auditoria', async (t) => {
      const escritas = mundo(t);
      escritas.inserirRecurso.mock.mockImplementation(async (_c, { recurso }) => recurso !== 'materials');
      // A releitura devolve vazio mesmo para 'materials' — estado que a
      // semântica real de ON CONFLICT DO NOTHING não deveria produzir; é
      // exatamente o caso defensivo que o serviço precisa recusar em vez de
      // presumir um resultado.
      const cliente = criarClienteFalso();

      await assert.rejects(
        servico.provisionar(criarPoolFalso(cliente), { empresaId: EMPRESA, dryRun: false }),
        (erro) => !(erro instanceof servico.ErroProvisionamento) && /estado indeterminado/i.test(erro.message) && erro.message.includes('materials'),
      );
      assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
      assert.equal(escritas.registrar.mock.calls.length, 0, 'nenhuma auditoria: a transação nunca chega a decidir o que houve');
    });

    test('E/9 — mesmo caso defensivo, agora numa AÇÃO', async (t) => {
      const escritas = mundo(t);
      escritas.inserirAcao.mock.mockImplementation(async () => false);
      // listarAcoes continua devolvendo vazio (padrão de mundo()) mesmo na releitura.
      const cliente = criarClienteFalso();
      await assert.rejects(
        servico.provisionar(criarPoolFalso(cliente), { empresaId: EMPRESA, dryRun: false }),
        (erro) => !(erro instanceof servico.ErroProvisionamento) && /estado indeterminado/i.test(erro.message) && erro.message.includes('MOVIMENTAR_ESTOQUE'),
      );
      assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
      assert.equal(escritas.registrar.mock.calls.length, 0);
    });
  });

  test('ator de outra empresa (ou inexistente): ATOR_INVALIDO com ROLLBACK, nada inserido', async (t) => {
    const escritas = mundo(t, { ator: { id: ATOR, empresaId: 99 } });
    const cliente = criarClienteFalso();
    await assert.rejects(() => servico.provisionar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR, dryRun: false }), (e) => e.codigo === 'ATOR_INVALIDO');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
    assert.equal(escritas.inserirRecurso.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
  });

  test('falha do banco no insert: ROLLBACK e propagação sem auditoria', async (t) => {
    const escritas = mundo(t);
    escritas.inserirAcao.mock.mockImplementation(async () => { throw Object.assign(new Error('fk'), { code: '23503' }); });
    const cliente = criarClienteFalso();
    await assert.rejects(() => servico.provisionar(criarPoolFalso(cliente), { empresaId: EMPRESA, dryRun: false }), (e) => e.code === '23503');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
    assert.equal(escritas.registrar.mock.calls.length, 0);
  });
});
