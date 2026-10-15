'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TOGGLES, PENDENCIAS, GRUPOS, buscar } = require('../../src/rbac/toggles');
const { ACOES_COM_EFEITO, ESCOPO_PROVISIONAMENTO_MASTER, RECURSOS_COM_EFEITO } = require('../../src/rbac/recursos');
const { avisosDosAcessos } = require('../../src/rbac/avisos-acessos');

/**
 * Etapa H — integração do Atendimento Token ao catálogo de acessos ON/OFF da Gestão de Usuários.
 *
 * Contrato aprovado: SETE toggles, um por permissão REAL já aplicada pelas rotas do Token, num grupo próprio ATENDIMENTO.
 * Nenhuma permissão nova, nenhuma migration, nenhum toggle para as abas, para excluir (não há rota) nem para Monitoramento e
 * Histórico (Etapa J). `TOKEN_GERENCIAR_REDES` é OBRIGATORIA: só concessão individual (o serviço de grupo a deixa de fora).
 * Dependência de leitura só para Cadastrar, Editar, Revogar e Gerar ativação (a leitura do PRÓPRIO Token); a Prévia NÃO
 * concede a leitura de funcionários (dado pessoal): só aviso.
 */

const SETE = {
  tokenVisualizar: ['Consultar', { tipo: 'RECURSO', recurso: 'atendimentoToken', operacoes: ['visualizar'] }],
  tokenCadastrar: ['Cadastrar dispositivo', { tipo: 'RECURSO', recurso: 'atendimentoToken', operacoes: ['criar'] }],
  tokenEditar: ['Editar dispositivo', { tipo: 'RECURSO', recurso: 'atendimentoToken', operacoes: ['editar'] }],
  tokenRevogar: ['Revogar dispositivo', { tipo: 'ACAO', codigo: 'TOKEN_REVOGAR_DISPOSITIVO' }],
  tokenGerarAtivacao: ['Gerar ativação (QR)', { tipo: 'ACAO', codigo: 'TOKEN_GERAR_ATIVACAO' }],
  tokenRedes: ['Redes autorizadas', { tipo: 'ACAO', codigo: 'TOKEN_GERENCIAR_REDES' }],
  tokenPrevia: ['Prévia do catálogo', { tipo: 'ACAO', codigo: 'TOKEN_PREVIA_CATALOGO_REAL' }],
};
const LEITURA_TOKEN = [{ tipo: 'RECURSO', recurso: 'atendimentoToken', operacoes: ['visualizar'] }];
const simples = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

describe('T1 — os sete toggles do Atendimento Token no catálogo', () => {
  test('T1.1 existem exatamente os sete, no grupo ATENDIMENTO, com o rótulo e a regra da permissão real', () => {
    const doToken = TOGGLES.filter((t) => t.grupo === 'ATENDIMENTO');
    assert.deepEqual(doToken.map((t) => t.id).sort(), Object.keys(SETE).sort());
    for (const [id, [rotulo, regra]] of Object.entries(SETE)) {
      const t = buscar(id);
      assert.ok(t, `toggle ${id} ausente`);
      assert.equal(t.rotulo, rotulo, id);
      assert.deepEqual(simples(t.regra), regra, id);
    }
  });

  test('T1.2 o grupo ATENDIMENTO é um grupo conhecido do catálogo', () => {
    assert.ok(GRUPOS.includes('ATENDIMENTO'));
  });

  test('T1.3 cada regra aponta para a permissão que as rotas do Token realmente exigem e para nada além', () => {
    const recurso = RECURSOS_COM_EFEITO.find((r) => r.recurso === 'atendimentoToken');
    assert.ok(recurso);
    for (const t of TOGGLES.filter((x) => x.grupo === 'ATENDIMENTO')) {
      if (t.regra.tipo === 'ACAO') assert.ok(ACOES_COM_EFEITO.includes(t.regra.codigo), t.id);
      else for (const op of t.regra.operacoes) assert.ok(recurso.operacoes.includes(op), `${t.id}.${op}`);
    }
    assert.equal(TOGGLES.some((t) => t.regra.tipo === 'RECURSO' && t.regra.recurso === 'atendimentoToken' && t.regra.operacoes.includes('excluir')), false, 'não há rota de exclusão: sem toggle de excluir');
  });

  test('T1.4 nenhum toggle para Monitoramento e Histórico (Etapa J) nem para as abas; as ações da J não são oferecidas', () => {
    const acoes = TOGGLES.filter((t) => t.regra.tipo === 'ACAO').map((t) => t.regra.codigo);
    assert.equal(acoes.includes('TOKEN_VISUALIZAR_MONITORAMENTO'), false);
    assert.equal(acoes.includes('TOKEN_VISUALIZAR_HISTORICO'), false);
    assert.equal(ACOES_COM_EFEITO.includes('TOKEN_VISUALIZAR_MONITORAMENTO'), false);
    assert.equal(ACOES_COM_EFEITO.includes('TOKEN_VISUALIZAR_HISTORICO'), false);
    assert.equal(TOGGLES.filter((t) => t.grupo === 'ATENDIMENTO').length, 7);
    for (const aba of ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'historico']) assert.equal(Boolean(buscar(aba)), false, aba);
  });

  test('T1.5 a pendência genérica "token" deixa de existir; Monitoramento e Histórico seguem como pendência explícita da Etapa J', () => {
    assert.equal(PENDENCIAS.some((p) => p.id === 'token'), false);
    const j = PENDENCIAS.find((p) => /monitoramento/i.test(p.rotulo) && /hist[óo]rico/i.test(p.rotulo));
    assert.ok(j, 'pendência de Monitoramento e Histórico');
    assert.equal(j.situacao, 'SEM_ENFORCEMENT');
    assert.match(j.motivo, /Etapa J/);
    assert.equal(PENDENCIAS.length, 8, 'mesmo número de pendências: uma saiu e uma entrou');
  });
});

describe('T2 — dependências e modos', () => {
  test('T2.1 Cadastrar, Editar, Revogar e Gerar ativação garantem SÓ a leitura do próprio Token ao serem ligados', () => {
    for (const id of ['tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao']) {
      assert.deepEqual(simples(buscar(id).dependencias), LEITURA_TOKEN, id);
    }
  });

  test('T2.2 Consultar, Redes e Prévia não têm dependências; a Prévia nunca concede a leitura de funcionários', () => {
    for (const id of ['tokenVisualizar', 'tokenRedes', 'tokenPrevia']) assert.deepEqual(buscar(id).dependencias ?? [], [], id);
    const todas = TOGGLES.filter((t) => t.grupo === 'ATENDIMENTO').flatMap((t) => t.dependencias ?? []);
    assert.equal(todas.some((d) => d.recurso === 'employeeHistory'), false, 'nenhuma dependência de funcionários (dado pessoal)');
  });

  test('T2.3 nenhum modo especial: sem concessão (SST) e sem semBloqueio nos sete', () => {
    for (const id of Object.keys(SETE)) {
      assert.equal(buscar(id).regra.concessao, undefined, id);
      assert.equal(buscar(id).regra.semBloqueio, undefined, id);
    }
  });

  test('T2.4 modos reais na migration 087: Redes OBRIGATORIA (por isso só concessão individual) e as outras três ações ALTERNATIVA', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '087_insert_acoes_atendimento_token.sql'), 'utf8').replace(/--[^\n]*/g, '');
    const linha = (codigo) => sql.split('\n').find((l) => l.trimStart().startsWith(`('${codigo}',`)) ?? '';
    const modo = (codigo) => /'(ALTERNATIVA|OBRIGATORIA)'\)[,;]\s*$/.exec(linha(codigo))?.[1];
    assert.equal(modo('TOKEN_GERENCIAR_REDES'), 'OBRIGATORIA');
    for (const c of ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO', 'TOKEN_PREVIA_CATALOGO_REAL']) assert.equal(modo(c), 'ALTERNATIVA', c);
  });

  test('T2.5 o MASTER recebe as quatro ações e as três operações pelo provisionamento (sem concessão artificial); as da Etapa J não', () => {
    for (const c of ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO', 'TOKEN_GERENCIAR_REDES', 'TOKEN_PREVIA_CATALOGO_REAL']) assert.ok(ESCOPO_PROVISIONAMENTO_MASTER.acoes.includes(c), c);
    assert.equal(ESCOPO_PROVISIONAMENTO_MASTER.acoes.some((c) => /MONITORAMENTO|HISTORICO$/.test(c) && c.startsWith('TOKEN_')), false);
    const r = ESCOPO_PROVISIONAMENTO_MASTER.recursos.find((x) => x.recurso === 'atendimentoToken');
    assert.deepEqual([...r.operacoes], ['visualizar', 'criar', 'editar']);
  });
});

describe('T3 — avisos informativos', () => {
  const acessos = (mapa) => TOGGLES.map((t) => ({ id: t.id, ligado: mapa[t.id] === true }));
  const codigos = (mapa) => avisosDosAcessos(acessos(mapa)).map((a) => a.codigo).sort();

  test('T3.1 Cadastrar/Editar/Revogar/Gerar ligados sem Consultar: aviso TOKEN_SEM_CONSULTAR', () => {
    for (const id of ['tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao']) {
      assert.deepEqual(codigos({ [id]: true }), ['TOKEN_SEM_CONSULTAR'], id);
    }
    assert.deepEqual(codigos({ tokenCadastrar: true, tokenVisualizar: true }), []);
    assert.deepEqual(codigos({ tokenVisualizar: true }), []);
  });

  test('T3.2 Redes e Prévia sozinhas não geram o aviso de Consultar (abrem a Central por conta própria)', () => {
    assert.deepEqual(codigos({ tokenRedes: true }), []);
    assert.deepEqual(codigos({ tokenPrevia: true, historicoFuncionarios: true }), []);
  });

  test('T3.3 Prévia ligada e Histórico de Funcionários desligado: aviso PREVIA_SEM_HISTORICO_FUNCIONARIOS; com o Histórico ligado, não', () => {
    assert.deepEqual(codigos({ tokenPrevia: true }), ['PREVIA_SEM_HISTORICO_FUNCIONARIOS']);
    assert.deepEqual(codigos({ tokenPrevia: true, historicoFuncionarios: true }), []);
  });

  test('T3.4 os avisos de Funcionários continuam com a mesma regra e podem aparecer junto com os do Token', () => {
    assert.deepEqual(codigos({ cadastrarFuncionario: true }), ['FUNCIONARIOS_SEM_VISUALIZAR']);
    assert.deepEqual(codigos({ cadastrarFuncionario: true, tokenPrevia: true, tokenEditar: true }).sort(),
      ['FUNCIONARIOS_SEM_VISUALIZAR', 'PREVIA_SEM_HISTORICO_FUNCIONARIOS', 'TOKEN_SEM_CONSULTAR'].sort());
    assert.deepEqual(codigos({ exportarHistoricoFuncionarios: true }), ['EXPORTAR_HISTORICO_SEM_VISUALIZAR']);
  });

  test('T3.5 o aviso só informa: a lista de acessos recebida não é alterada', () => {
    const lista = acessos({ tokenPrevia: true });
    const copia = JSON.stringify(lista);
    avisosDosAcessos(lista);
    assert.equal(JSON.stringify(lista), copia);
  });
});
