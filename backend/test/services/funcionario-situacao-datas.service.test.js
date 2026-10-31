'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const servico = require('../../src/services/funcionario.service');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Datas efetivas da situação do funcionário — serviço, sem PostgreSQL (RED, especificação 02 e decisões D1 a D6).
 *
 * Contrato do repositório novo (src/repositories/funcionario-situacao.repository.js), chamado pelo OBJETO do módulo como os
 * demais serviços (o teste o substitui por mock):
 *   registrar(executor, { empresaId, funcionarioId, situacaoAnterior, situacaoNova, dataEfetiva, registradoPor }) → { id, registradoEm }
 *   buscarUltimaDataEfetiva(executor, empresaId, funcionarioId) → 'AAAA-MM-DD' | null   (última data efetiva já registrada)
 *   resumirEntregasPosteriores(executor, empresaId, funcionarioId, dataEfetiva) → { total, primeiraEm, ultimaEm }
 *     (entregas com data_operacional ESTRITAMENTE posterior a dataEfetiva; datas civis 'AAAA-MM-DD')
 *
 * Ordem exigida dentro da transação: trava do funcionário → regras de data → consultas de cronologia e de entregas → UPDATE →
 * linha de histórico → auditoria. Recusas 409 novas (cronologia e entrega) fazem ROLLBACK e só então são auditadas, fora da
 * transação, com código técnico e sem data. O serviço recebe `hoje` (data civil de São Paulo) do controller e não lê o relógio.
 */

const EMPRESA = 42;
const ATOR_ID = 7;
const FUNC_ID = 70;
const HOJE = '2026-10-10';

const funcionario = (extra = {}) => ({
  id: FUNC_ID, empresaId: EMPRESA, grupoHomogeneoId: 50, matricula: 'MAT-000171', nome: 'Tício de Tal', cpf: '52998224725',
  dataNascimento: '1990-03-15', dataAdmissao: '2020-06-01', setor: 'Manutenção', funcao: 'Mecânico', cracha: 'CR-001284', telefone: '47999990000',
  situacao: 'ATIVO', ativo: true, criadoEm: new Date('2026-09-23T12:00:00Z'), atualizadoEm: new Date('2026-09-23T12:00:00Z'), ...extra,
});
const noEstado = (situacao, extra = {}) => funcionario({ situacao, ativo: situacao === 'ATIVO', ...extra });

const ARQUIVO_REPO = path.join(__dirname, '..', '..', 'src', 'repositories', 'funcionario-situacao.repository.js');
const NOMES_REPO = ['registrar', 'buscarUltimaDataEfetiva', 'resumirEntregasPosteriores'];

/**
 * Com o repositório real presente, ele é o substituído pelos mocks (o serviço o chama pelo objeto do módulo). Enquanto não existe
 * (fase RED), um objeto local com a mesma assinatura permite montar os mocks: o serviço atual não o conhece, então cada teste
 * falha pelo COMPORTAMENTO ausente (histórico não gravado, data não validada), e não por uma falha de importação que esconderia
 * tudo. A existência do módulo real é exigida em funcionario-situacao.repository.test.js.
 */
function repoSituacao() {
  if (!fs.existsSync(ARQUIVO_REPO)) {
    return Object.fromEntries(NOMES_REPO.map((nome) => [nome, async () => null]));
  }
  const repo = require(ARQUIVO_REPO);
  for (const nome of NOMES_REPO) assert.equal(typeof repo[nome], 'function', `repositório de situação sem ${nome}()`);
  return repo;
}

function ambiente({ conexaoPropria = false } = {}) {
  const ordem = [];
  // Conexão própria da auditoria da recusa (transação separada, com trava): só quando o teste a pede, a 2ª conexão do pool é ela.
  const auditoriaPropria = [];
  const propria = {
    query: async (texto, valores) => { auditoriaPropria.push(/pg_advisory_xact_lock/.test(texto) ? ['LOCK', valores[0]] : [texto]); return { rows: [], rowCount: 0 }; },
    release: () => { auditoriaPropria.push(['RELEASE']); },
  };
  let conexoes = 0;
  const cliente = {
    query: async (texto) => { if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(texto)) ordem.push(texto); return { rows: [], rowCount: 0 }; },
    release: () => { ordem.push('RELEASE'); },
  };
  const pool = { connect: async () => { conexoes += 1; return conexaoPropria && conexoes > 1 ? propria : cliente; }, query: (...args) => cliente.query(...args) };
  return { ordem, cliente, propria, auditoriaPropria, pool };
}

const SEM_ENTREGAS = { total: 0, primeiraEm: null, ultimaEm: null };

function mundo(t, {
  existente = funcionario(), ultima = null, entregas = SEM_ENTREGAS, falhaHistorico = false, falhaAuditoria = false,
  conexaoPropria = false, recente = false, falhaSupressao = false,
} = {}) {
  const repo = repoSituacao();
  const amb = ambiente({ conexaoPropria });
  const chamadas = { auditorias: [] };
  t.mock.method(funcionarioRepo, 'buscarPorIdParaAtualizacao', async (_c, empresaId, id) => {
    amb.ordem.push('travar');
    return existente !== null && empresaId === existente.empresaId && id === existente.id ? existente : null;
  });
  chamadas.atualizar = t.mock.method(funcionarioRepo, 'atualizar', async (_c, _e, _id, campos) => {
    amb.ordem.push('atualizar');
    return funcionario({ ...existente, situacao: campos.situacao, ativo: campos.situacao === 'ATIVO' });
  });
  chamadas.ultima = t.mock.method(repo, 'buscarUltimaDataEfetiva', async () => { amb.ordem.push('ultima'); return ultima; });
  chamadas.entregas = t.mock.method(repo, 'resumirEntregasPosteriores', async () => { amb.ordem.push('entregas'); return entregas; });
  chamadas.historico = t.mock.method(repo, 'registrar', async (_c, dados) => {
    amb.ordem.push('historico');
    if (falhaHistorico) throw new Error('falha induzida no histórico');
    return { id: '501', registradoEm: new Date('2026-10-11T01:30:00Z'), dataEfetiva: dados.dataEfetiva };
  });
  chamadas.auditoria = t.mock.method(auditoriaRepo, 'registrar', async (executor, dados) => {
    amb.ordem.push(`auditoria:${dados.acao}`);
    chamadas.auditorias.push({ executor, dados });
    if (falhaAuditoria && dados.acao === 'FUNCIONARIO_SITUACAO_ALTERADA') throw new Error('falha induzida na auditoria');
    return { id: '1', criadoEm: new Date() };
  });
  chamadas.existeRecente = t.mock.method(auditoriaRepo, 'existeRecente', async (executor, dados) => {
    amb.auditoriaPropria.push(['existeRecente', executor === amb.propria, dados]);
    if (falhaSupressao) throw new Error('falha induzida na consulta de supressão');
    return recente;
  });
  return { ...amb, ...chamadas, repo };
}

const ESCRITAS = new Set(['atualizar', 'historico', 'auditoria:FUNCIONARIO_SITUACAO_ALTERADA', 'auditoria:FUNCIONARIO_INATIVADO', 'auditoria:FUNCIONARIO_REATIVADO']);
const escritas = (ordem) => ordem.filter((x) => ESCRITAS.has(x));
const contar = (ordem, x) => ordem.filter((o) => o === x).length;

async function esperarHttpError(promessa, status, codigo) {
  let erro = null;
  try { await promessa; } catch (e) { erro = e; }
  assert.ok(erro !== null, `esperado HttpError ${status} ${codigo}, mas a operação foi aceita`);
  assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro.name}: ${erro.message}`);
  assert.equal(erro.status, status);
  assert.equal(erro.codigo, codigo);
  return erro;
}

const base = { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, hoje: HOJE };
const mudar = (m, extra) => servico.alterarSituacao(m.pool, { ...base, ...extra });

describe('transições com data efetiva — sucesso e gravação', () => {
  const CASOS = [
    ['ATIVO', 'INATIVO', '2026-10-01', 'INATIVAR'],
    ['ATIVO', 'AFASTADO', '2026-10-02', 'AFASTAR'],
    ['AFASTADO', 'INATIVO', '2026-10-03', 'INATIVAR'],
    ['AFASTADO', 'ATIVO', '2026-10-04', 'ATIVAR'],
  ];
  for (const [de, para, data, operacao] of CASOS) {
    test(`${de} → ${para}: grava a linha de histórico com a data efetiva, o ator e a situação anterior; mesma transação`, async (t) => {
      const m = mundo(t, { existente: noEstado(de), ultima: de === 'AFASTADO' ? '2026-09-01' : null });
      const r = await mudar(m, { situacao: para, dataEfetiva: data });
      assert.equal(r.alterado, true);
      assert.equal(r.funcionario.situacao, para);
      assert.equal(m.historico.mock.calls.length, 1);
      assert.deepEqual(m.historico.mock.calls[0].arguments[1], {
        empresaId: EMPRESA, funcionarioId: FUNC_ID, situacaoAnterior: de, situacaoNova: para, dataEfetiva: data, registradoPor: ATOR_ID,
      });
      assert.equal(m.historico.mock.calls[0].arguments[0], m.cliente, 'a linha vai na MESMA conexão da transação');
      assert.deepEqual(r.ultimaMudanca, { situacao: para, dataEfetiva: data, registradaEm: new Date('2026-10-11T01:30:00Z') });
      assert.equal(contar(m.ordem, 'COMMIT'), 1);
      assert.equal(contar(m.ordem, 'ROLLBACK'), 0);
      const alterada = m.auditorias.find((a) => a.dados.acao === 'FUNCIONARIO_SITUACAO_ALTERADA');
      assert.equal(alterada.dados.contexto.operacao, operacao);
    });
  }

  test('INATIVO → ATIVO (reativação) não exige data: a linha nasce com data nula e instante do servidor', async (t) => {
    const m = mundo(t, { existente: noEstado('INATIVO'), ultima: '2026-09-01' });
    const r = await mudar(m, { situacao: 'ATIVO' });
    assert.equal(r.alterado, true);
    assert.equal(m.historico.mock.calls.length, 1, 'a reativação de INATIVO grava exatamente uma linha de histórico');
    assert.deepEqual(m.historico.mock.calls[0].arguments[1], {
      empresaId: EMPRESA, funcionarioId: FUNC_ID, situacaoAnterior: 'INATIVO', situacaoNova: 'ATIVO', dataEfetiva: null, registradoPor: ATOR_ID,
    });
    assert.equal(r.ultimaMudanca.dataEfetiva, null);
    assert.equal(m.entregas.mock.calls.length, 0, 'reativar não consulta entregas');
  });

  test('empresa e ator são os do chamador; o repositório recebe só o que o contrato define (sem motivo, descrição ou observação)', async (t) => {
    const m = mundo(t);
    await mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01', motivo: 'x', descricao: 'y', observacao: 'z' });
    assert.equal(m.historico.mock.calls.length, 1, 'a inativação grava exatamente uma linha de histórico');
    assert.deepEqual(Object.keys(m.historico.mock.calls[0].arguments[1]).sort(),
      ['dataEfetiva', 'empresaId', 'funcionarioId', 'registradoPor', 'situacaoAnterior', 'situacaoNova']);
  });

  test('a ordem das operações: trava → cronologia → entregas → UPDATE → histórico → auditoria → COMMIT', async (t) => {
    const m = mundo(t);
    await mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' });
    const ordem = m.ordem.filter((x) => x !== 'RELEASE');
    const pos = (x) => ordem.indexOf(x);
    assert.equal(ordem[0], 'BEGIN');
    assert.ok(pos('travar') < pos('ultima'), 'a cronologia só é lida depois da trava');
    assert.ok(pos('travar') < pos('entregas'), 'as entregas só são lidas depois da trava (corrida com a entrega)');
    assert.ok(pos('entregas') < pos('atualizar'));
    assert.ok(pos('atualizar') < pos('historico'));
    assert.ok(pos('historico') < pos('auditoria:FUNCIONARIO_SITUACAO_ALTERADA'));
    assert.equal(ordem.at(-1), 'COMMIT');
  });
});

describe('validação da data efetiva no serviço (defesa em profundidade)', () => {
  test('INATIVO e AFASTADO sem data: 400 DATA_EFETIVA_OBRIGATORIA, sem escrita e com ROLLBACK', async (t) => {
    for (const [de, para] of [['ATIVO', 'INATIVO'], ['ATIVO', 'AFASTADO'], ['AFASTADO', 'INATIVO']]) {
      const m = mundo(t, { existente: noEstado(de) });
      await esperarHttpError(mudar(m, { situacao: para }), 400, 'DATA_EFETIVA_OBRIGATORIA');
      assert.deepEqual(escritas(m.ordem), [], `${de} → ${para}`);
      assert.equal(contar(m.ordem, 'ROLLBACK'), 1);
    }
  });

  test('AFASTADO → ATIVO sem data do retorno: 400 DATA_EFETIVA_OBRIGATORIA', async (t) => {
    const m = mundo(t, { existente: noEstado('AFASTADO'), ultima: '2026-09-01' });
    await esperarHttpError(mudar(m, { situacao: 'ATIVO' }), 400, 'DATA_EFETIVA_OBRIGATORIA');
    assert.deepEqual(escritas(m.ordem), []);
  });

  test('INATIVO → ATIVO com data: 400 DATA_EFETIVA_NAO_SE_APLICA (reativação não é retorno nem nova contratação)', async (t) => {
    const m = mundo(t, { existente: noEstado('INATIVO'), ultima: '2026-09-01' });
    await esperarHttpError(mudar(m, { situacao: 'ATIVO', dataEfetiva: '2026-10-01' }), 400, 'DATA_EFETIVA_NAO_SE_APLICA');
    assert.deepEqual(escritas(m.ordem), []);
  });

  test('data no formato ou calendário inválidos chega ao serviço: 400 DATA_EFETIVA_INVALIDA', async (t) => {
    for (const dataEfetiva of ['2026-02-30', '01/10/2026', '', 20261001, '2026-10-01T00:00:00Z']) {
      const m = mundo(t);
      await esperarHttpError(mudar(m, { situacao: 'INATIVO', dataEfetiva }), 400, 'DATA_EFETIVA_INVALIDA');
      assert.deepEqual(escritas(m.ordem), []);
    }
  });

  test('data futura é recusada (data civil: hoje vale, amanhã não): 400 DATA_EFETIVA_FUTURA', async (t) => {
    const hoje = mundo(t);
    await mudar(hoje, { situacao: 'INATIVO', dataEfetiva: HOJE });
    assert.equal(hoje.historico.mock.calls.length, 1, 'a data de hoje é aceita e grava uma linha de histórico');
    assert.equal(hoje.historico.mock.calls[0].arguments[1].dataEfetiva, HOJE);
    const amanha = mundo(t);
    await esperarHttpError(mudar(amanha, { situacao: 'INATIVO', dataEfetiva: '2026-10-11' }), 400, 'DATA_EFETIVA_FUTURA');
    assert.deepEqual(escritas(amanha.ordem), []);
  });

  test('anterior à admissão conhecida: 400 DATA_EFETIVA_ANTERIOR_A_ADMISSAO; no dia da admissão vale; sem admissão a regra não se aplica', async (t) => {
    const antes = mundo(t, { existente: funcionario({ dataAdmissao: '2020-06-01' }) });
    await esperarHttpError(mudar(antes, { situacao: 'AFASTADO', dataEfetiva: '2020-05-31' }), 400, 'DATA_EFETIVA_ANTERIOR_A_ADMISSAO');
    assert.deepEqual(escritas(antes.ordem), []);
    const igual = mundo(t, { existente: funcionario({ dataAdmissao: '2020-06-01' }) });
    await mudar(igual, { situacao: 'AFASTADO', dataEfetiva: '2020-06-01' });
    assert.equal(igual.historico.mock.calls.length, 1);
    const semAdmissao = mundo(t, { existente: funcionario({ dataAdmissao: null }) });
    await mudar(semAdmissao, { situacao: 'AFASTADO', dataEfetiva: '1999-01-01' });
    assert.equal(semAdmissao.historico.mock.calls.length, 1, 'legado sem admissão: nenhuma data é inventada nem exigida');
  });

  test('o serviço não usa o relógio do servidor: sem `hoje` a operação é rejeitada', async (t) => {
    const m = mundo(t);
    await assert.rejects(servico.alterarSituacao(m.pool, { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, situacao: 'INATIVO', dataEfetiva: '2026-10-01' }));
    assert.deepEqual(escritas(m.ordem), []);
  });
});

describe('consistência temporal contra a última data efetiva registrada', () => {
  test('data anterior à última registrada: 409 DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA com o limite em detalhes', async (t) => {
    // reativado, depois afastado em data anterior ao desligamento já registrado
    const ativo = mundo(t, { existente: noEstado('ATIVO'), ultima: '2026-08-15' });
    const erro = await esperarHttpError(mudar(ativo, { situacao: 'AFASTADO', dataEfetiva: '2026-08-14' }), 409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA');
    assert.equal(erro.detalhes.limite, '2026-08-15');
    assert.deepEqual(escritas(ativo.ordem), []);
    assert.equal(contar(ativo.ordem, 'ROLLBACK'), 1);
    assert.equal(ativo.entregas.mock.calls.length, 0, 'a cronologia é decidida antes de consultar as entregas');
    const igual = mundo(t, { existente: noEstado('ATIVO'), ultima: '2026-08-15' });
    await mudar(igual, { situacao: 'AFASTADO', dataEfetiva: '2026-08-15' });
    assert.equal(igual.historico.mock.calls.length, 1, 'no mesmo dia da última data efetiva é aceito');
  });

  test('retorno anterior ao início do afastamento: 409 com limite; retorno no mesmo dia do início é aceito', async (t) => {
    const antes = mundo(t, { existente: noEstado('AFASTADO'), ultima: '2026-09-10' });
    const erro = await esperarHttpError(mudar(antes, { situacao: 'ATIVO', dataEfetiva: '2026-09-09' }), 409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA');
    assert.equal(erro.detalhes.limite, '2026-09-10');
    assert.deepEqual(escritas(antes.ordem), []);
    const igual = mundo(t, { existente: noEstado('AFASTADO'), ultima: '2026-09-10' });
    await mudar(igual, { situacao: 'ATIVO', dataEfetiva: '2026-09-10' });
    assert.equal(igual.historico.mock.calls.length, 1, 'o retorno no mesmo dia do início grava uma linha de histórico');
    assert.equal(igual.historico.mock.calls[0].arguments[1].dataEfetiva, '2026-09-10');
  });

  test('desligamento de quem está afastado não pode ser anterior ao início do afastamento', async (t) => {
    const m = mundo(t, { existente: noEstado('AFASTADO'), ultima: '2026-09-10' });
    await esperarHttpError(mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-09-01' }), 409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA');
  });

  test('legado sem nenhuma data registrada: nenhum limite é inventado (só admissão e hoje valem)', async (t) => {
    const m = mundo(t, { existente: noEstado('AFASTADO'), ultima: null });
    await mudar(m, { situacao: 'ATIVO', dataEfetiva: '2020-06-02' });
    assert.equal(m.historico.mock.calls.length, 1);
  });
});

describe('desligamento e afastamento × entregas (D1 e D3)', () => {
  const ENTREGAS = { total: 2, primeiraEm: '2026-10-05', ultimaEm: '2026-10-08' };

  test('desligamento com entrega de data operacional posterior: 409 DESLIGAMENTO_ANTERIOR_A_ENTREGA, detalhes mínimos e nenhuma escrita', async (t) => {
    // conexaoPropria: a auditoria da recusa tem transação própria (COMMIT dela não conta na transação rejeitada, que só faz ROLLBACK).
    const m = mundo(t, { entregas: ENTREGAS, conexaoPropria: true });
    const erro = await esperarHttpError(mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }), 409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA');
    assert.deepEqual(erro.detalhes, { entregasPosteriores: 2, primeiraEntregaEm: '2026-10-05', ultimaEntregaEm: '2026-10-08' });
    assert.equal(m.entregas.mock.calls.length, 1, 'as entregas posteriores são consultadas exatamente uma vez');
    assert.deepEqual(m.entregas.mock.calls[0].arguments.slice(1), [EMPRESA, FUNC_ID, '2026-10-01']);
    assert.deepEqual(escritas(m.ordem), []);
    assert.equal(contar(m.ordem, 'ROLLBACK'), 1);
    assert.equal(contar(m.ordem, 'COMMIT'), 0);
  });

  test('afastamento com entrega posterior: 409 AFASTAMENTO_ANTERIOR_A_ENTREGA, sem confirmação de conflito e sem escrita', async (t) => {
    const m = mundo(t, { entregas: ENTREGAS });
    const erro = await esperarHttpError(mudar(m, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' }), 409, 'AFASTAMENTO_ANTERIOR_A_ENTREGA');
    assert.deepEqual(erro.detalhes, { entregasPosteriores: 2, primeiraEntregaEm: '2026-10-05', ultimaEntregaEm: '2026-10-08' });
    assert.deepEqual(escritas(m.ordem), []);
    // não existe caminho de ciência: o parâmetro é ignorado e o conflito continua recusado
    const m2 = mundo(t, { entregas: ENTREGAS });
    await esperarHttpError(mudar(m2, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01', reconheceConflito: true }), 409, 'AFASTAMENTO_ANTERIOR_A_ENTREGA');
  });

  test('AFASTADO → INATIVO também respeita as entregas', async (t) => {
    const m = mundo(t, { existente: noEstado('AFASTADO'), ultima: '2026-09-01', entregas: ENTREGAS });
    await esperarHttpError(mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-02' }), 409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA');
  });

  test('sem entrega posterior (inclusive só no mesmo dia, que o repositório não conta) a operação é aceita', async (t) => {
    const m = mundo(t, { entregas: SEM_ENTREGAS });
    await mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-05' });
    assert.equal(m.historico.mock.calls.length, 1);
  });

  test('retorno e reativação não consultam entregas', async (t) => {
    const retorno = mundo(t, { existente: noEstado('AFASTADO'), ultima: '2026-09-01', entregas: ENTREGAS });
    await mudar(retorno, { situacao: 'ATIVO', dataEfetiva: '2026-10-02' });
    assert.equal(retorno.entregas.mock.calls.length, 0);
    const reativacao = mundo(t, { existente: noEstado('INATIVO'), entregas: ENTREGAS });
    await mudar(reativacao, { situacao: 'ATIVO' });
    assert.equal(reativacao.entregas.mock.calls.length, 0);
  });

  test('a cronologia é decidida antes das entregas (um único conflito é informado)', async (t) => {
    const m = mundo(t, { ultima: '2026-10-09', entregas: ENTREGAS });
    await esperarHttpError(mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }), 409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA');
  });
});

describe('auditoria de sucesso e de recusa (D4)', () => {
  test('sucesso: vínculo com a linha de histórico por identificador; sem datas, motivo ou texto livre', async (t) => {
    const m = mundo(t);
    await mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' });
    const alterada = m.auditorias.find((a) => a.dados.acao === 'FUNCIONARIO_SITUACAO_ALTERADA').dados;
    assert.equal(String(alterada.contexto.historicoId), '501');
    assert.equal(alterada.contexto.operacao, 'INATIVAR');
    assert.equal(alterada.contexto.origem, 'GESTAO_FUNCIONARIOS');
    assert.deepEqual(alterada.dadosAnteriores, { situacao: 'ATIVO' });
    assert.deepEqual(alterada.dadosNovos, { situacao: 'INATIVO' });
    const texto = JSON.stringify(m.auditorias.map((a) => a.dados));
    for (const proibido of ['2026-10-01', '01/10/2026', 'dataEfetiva', 'motivo', 'descricao', 'observacao']) {
      assert.equal(texto.includes(proibido), false, `a auditoria não pode conter ${proibido}`);
    }
    assert.equal(m.auditorias.find((a) => a.dados.acao === 'FUNCIONARIO_SITUACAO_ALTERADA').executor, m.cliente, 'na mesma transação');
  });

  test('o evento legado continua só em ATIVO↔INATIVO e também sem datas', async (t) => {
    const m = mundo(t, { existente: noEstado('ATIVO') });
    await mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' });
    assert.ok(m.ordem.includes('auditoria:FUNCIONARIO_INATIVADO'));
    const afastar = mundo(t);
    await mudar(afastar, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
    assert.equal(afastar.ordem.includes('auditoria:FUNCIONARIO_INATIVADO'), false);
  });

  test('recusa 409 de cronologia ou de entrega: auditada DEPOIS do ROLLBACK, fora da transação, com código técnico e sem data', async (t) => {
    const casos = [
      ['DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA', { ultima: '2026-10-09' }, 'INATIVAR'],
      ['DESLIGAMENTO_ANTERIOR_A_ENTREGA', { entregas: { total: 1, primeiraEm: '2026-10-05', ultimaEm: '2026-10-05' } }, 'INATIVAR'],
    ];
    for (const [codigo, ajuste, operacao] of casos) {
      const m = mundo(t, { ...ajuste, conexaoPropria: true });
      await esperarHttpError(mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }), 409, codigo);
      const recusas = m.auditorias.filter((a) => a.dados.acao === 'FUNCIONARIO_SITUACAO_RECUSADA');
      assert.equal(recusas.length, 1, codigo);
      const { executor, dados } = recusas[0];
      assert.equal(executor, m.propria, 'a recusa é gravada na conexão própria, nunca na transação desfeita');
      assert.notEqual(executor, m.cliente, 'a recusa não pode ficar presa à transação desfeita');
      assert.ok(m.ordem.indexOf('auditoria:FUNCIONARIO_SITUACAO_RECUSADA') > m.ordem.indexOf('ROLLBACK'));
      assert.equal(dados.empresaId, EMPRESA);
      assert.equal(dados.usuarioId, ATOR_ID);
      assert.equal(dados.referencia, String(FUNC_ID));
      assert.deepEqual(dados.contexto, { operacao, codigo });
      const texto = JSON.stringify(dados);
      for (const proibido of ['2026-10-01', '2026-10-05', '2026-10-09', 'dataEfetiva']) assert.equal(texto.includes(proibido), false, proibido);
    }
  });

  const mudarInativando = (m) => mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' });
  const ENTREGA_POSTERIOR = { entregas: { total: 1, primeiraEm: '2026-10-05', ultimaEm: '2026-10-05' } };
  const travas = (m) => m.auditoriaPropria.filter(([x]) => x === 'LOCK').map(([, chave]) => chave);

  test('a auditoria da recusa roda em transação própria, serializada por trava, e consulta a supressão pelo CÓDIGO e pela operação (janela de 60 s)', async (t) => {
    const m = mundo(t, { ...ENTREGA_POSTERIOR, conexaoPropria: true });
    await esperarHttpError(mudarInativando(m), 409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA');
    assert.deepEqual(m.auditoriaPropria.map(([x]) => x), ['BEGIN', 'LOCK', 'existeRecente', 'COMMIT', 'RELEASE']);
    const [, noMesmo, consulta] = m.auditoriaPropria.find(([x]) => x === 'existeRecente');
    assert.equal(noMesmo, true, 'a consulta de supressão corre na mesma conexão da trava');
    assert.deepEqual(consulta, {
      empresaId: EMPRESA, usuarioId: ATOR_ID, acao: 'FUNCIONARIO_SITUACAO_RECUSADA', referencia: String(FUNC_ID), janelaSegundos: 60,
      contexto: { operacao: 'INATIVAR', codigo: 'DESLIGAMENTO_ANTERIOR_A_ENTREGA' },
    });
  });

  test('recusa idêntica dentro da janela é consolidada: nenhuma linha nova, mesmo 409, e a transação própria termina com COMMIT', async (t) => {
    const m = mundo(t, { ...ENTREGA_POSTERIOR, conexaoPropria: true, recente: true });
    await esperarHttpError(mudarInativando(m), 409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA');
    assert.equal(m.auditorias.some((a) => a.dados.acao === 'FUNCIONARIO_SITUACAO_RECUSADA'), false);
    assert.deepEqual(m.auditoriaPropria.map(([x]) => x), ['BEGIN', 'LOCK', 'existeRecente', 'COMMIT', 'RELEASE']);
    assert.equal(contar(m.ordem, 'ROLLBACK'), 1, 'a transação rejeitada continua desfeita');
  });

  test('a trava é por empresa, ator, colaborador, operação e CÓDIGO: o mesmo evento repete a chave; qualquer diferença a muda', async (t) => {
    const chave = async (ajuste, extra, base = {}) => {
      const m = mundo(t, { conexaoPropria: true, ...ajuste });
      await esperarHttpError(mudar(m, { ...base, ...extra }), 409, ajuste.codigo);
      return travas(m)[0];
    };
    const desligar = { situacao: 'INATIVO', dataEfetiva: '2026-10-01' };
    const afastar = { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' };
    const entrega = { ...ENTREGA_POSTERIOR };
    const igual1 = await chave({ ...entrega, codigo: 'DESLIGAMENTO_ANTERIOR_A_ENTREGA' }, desligar);
    const igual2 = await chave({ ...entrega, codigo: 'DESLIGAMENTO_ANTERIOR_A_ENTREGA' }, desligar);
    assert.match(igual1, /^-?\d+$/, 'bigint em texto');
    assert.equal(igual1, igual2, 'recusa idêntica => mesma trava');
    const outroCodigo = await chave({ ...entrega, codigo: 'AFASTAMENTO_ANTERIOR_A_ENTREGA' }, afastar);
    const cronologia = await chave({ ultima: '2026-10-09', codigo: 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA' }, desligar);
    const outroAtor = await chave({ ...entrega, codigo: 'DESLIGAMENTO_ANTERIOR_A_ENTREGA' }, desligar, { atorId: ATOR_ID + 1 });
    const outroColaborador = await chave({ ...entrega, codigo: 'DESLIGAMENTO_ANTERIOR_A_ENTREGA', existente: funcionario({ id: FUNC_ID + 1 }) }, desligar, { funcionarioId: FUNC_ID + 1 });
    const outraEmpresa = await chave({ ...entrega, codigo: 'DESLIGAMENTO_ANTERIOR_A_ENTREGA', existente: funcionario({ empresaId: EMPRESA + 1 }) }, desligar, { empresaId: EMPRESA + 1 });
    assert.equal(new Set([igual1, outroCodigo, cronologia, outroAtor, outroColaborador, outraEmpresa]).size, 6, 'seis eventos distintos, seis travas distintas');
  });

  test('a mesma recusa por CÓDIGO igual mas OPERAÇÃO diferente (cronologia ao desligar x ao afastar) também é evento distinto', async (t) => {
    const consultas = [];
    for (const situacao of ['INATIVO', 'AFASTADO']) {
      const m = mundo(t, { ultima: '2026-10-09', conexaoPropria: true });
      await esperarHttpError(mudar(m, { situacao, dataEfetiva: '2026-10-01' }), 409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA');
      consultas.push(m.auditoriaPropria.find(([x]) => x === 'existeRecente')[2].contexto);
    }
    assert.deepEqual(consultas, [
      { operacao: 'INATIVAR', codigo: 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA' },
      { operacao: 'AFASTAR', codigo: 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA' },
    ]);
  });

  test('falha da auditoria da recusa (qualquer etapa): ROLLBACK da transação própria, conexão devolvida, erro de domínio intacto e sem payload no log técnico', async (t) => {
    const registro = t.mock.method(console, 'error', () => {});
    const m = mundo(t, { ...ENTREGA_POSTERIOR, conexaoPropria: true, falhaSupressao: true });
    const erro = await esperarHttpError(mudarInativando(m), 409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA');
    assert.equal(erro.codigo, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA');
    assert.deepEqual(m.auditoriaPropria.map(([x]) => x), ['BEGIN', 'LOCK', 'existeRecente', 'ROLLBACK', 'RELEASE']);
    assert.equal(m.auditorias.some((a) => a.dados.acao === 'FUNCIONARIO_SITUACAO_RECUSADA'), false);
    const texto = JSON.stringify(registro.mock.calls.map((c) => c.arguments));
    for (const proibido of ['2026-10-01', '2026-10-05', 'falha induzida']) assert.equal(texto.includes(proibido), false, proibido);
  });

  test('só as recusas novas são auditadas: validação 400 e os 409 já existentes (igual, transição) não geram FUNCIONARIO_SITUACAO_RECUSADA', async (t) => {
    const semData = mundo(t);
    await esperarHttpError(mudar(semData, { situacao: 'INATIVO' }), 400, 'DATA_EFETIVA_OBRIGATORIA');
    const igual = mundo(t, { existente: noEstado('INATIVO') });
    await esperarHttpError(mudar(igual, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }), 409, 'FUNCIONARIO_SITUACAO_IGUAL');
    const transicao = mundo(t, { existente: noEstado('INATIVO') });
    await esperarHttpError(mudar(transicao, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' }), 409, 'FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA');
    for (const m of [semData, igual, transicao]) {
      assert.equal(m.auditorias.some((a) => a.dados.acao === 'FUNCIONARIO_SITUACAO_RECUSADA'), false);
    }
  });
});

describe('atomicidade: situação, histórico e auditoria na mesma transação', () => {
  test('falha ao gravar a linha de histórico: ROLLBACK, sem COMMIT e sem auditoria de sucesso', async (t) => {
    const m = mundo(t, { falhaHistorico: true });
    await assert.rejects(mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }), /falha induzida no histórico/);
    assert.equal(contar(m.ordem, 'ROLLBACK'), 1);
    assert.equal(contar(m.ordem, 'COMMIT'), 0);
    assert.equal(m.ordem.includes('auditoria:FUNCIONARIO_SITUACAO_ALTERADA'), false);
  });

  test('falha na auditoria: ROLLBACK e nenhum COMMIT (a situação e o histórico são desfeitos)', async (t) => {
    const m = mundo(t, { falhaAuditoria: true });
    await assert.rejects(mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }), /falha induzida na auditoria/);
    assert.equal(contar(m.ordem, 'ROLLBACK'), 1);
    assert.equal(contar(m.ordem, 'COMMIT'), 0);
  });

  test('funcionário inexistente nesta empresa: 404 FUNCIONARIO_NAO_ENCONTRADO, sem consultas de data nem escrita', async (t) => {
    const m = mundo(t, { existente: null });
    await esperarHttpError(mudar(m, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
    assert.deepEqual(escritas(m.ordem), []);
    assert.equal(m.entregas.mock.calls.length, 0);
    assert.equal(m.ultima.mock.calls.length, 0);
  });
});

describe('rotas legadas inativar e reativar passam pelas mesmas regras', () => {
  test('inativar exige a data: sem ela 400 DATA_EFETIVA_OBRIGATORIA e nenhuma escrita', async (t) => {
    const m = mundo(t);
    await esperarHttpError(servico.inativar(m.pool, { ...base }), 400, 'DATA_EFETIVA_OBRIGATORIA');
    assert.deepEqual(escritas(m.ordem), []);
  });

  test('inativar com data grava o mesmo histórico que a rota de situação', async (t) => {
    const m = mundo(t);
    const r = await servico.inativar(m.pool, { ...base, dataEfetiva: '2026-10-01' });
    assert.equal(r.alterado, true);
    assert.equal(m.historico.mock.calls.length, 1, 'inativar com data grava exatamente uma linha de histórico');
    assert.equal(m.historico.mock.calls[0].arguments[1].situacaoNova, 'INATIVO');
    assert.equal(m.historico.mock.calls[0].arguments[1].dataEfetiva, '2026-10-01');
  });

  test('inativar quem já está INATIVO continua idempotente: alterado false, sem histórico, sem entregas, sem auditoria', async (t) => {
    const m = mundo(t, { existente: noEstado('INATIVO'), entregas: { total: 3, primeiraEm: '2026-10-05', ultimaEm: '2026-10-08' } });
    const r = await servico.inativar(m.pool, { ...base, dataEfetiva: '2026-10-01' });
    assert.equal(r.alterado, false);
    assert.deepEqual(escritas(m.ordem), []);
    assert.equal(m.entregas.mock.calls.length, 0);
    assert.equal(m.auditorias.length, 0);
  });

  test('inativar quem já está INATIVO sem data continua sendo 400 (a validação do corpo vem antes)', async (t) => {
    const m = mundo(t, { existente: noEstado('INATIVO') });
    await esperarHttpError(servico.inativar(m.pool, { ...base }), 400, 'DATA_EFETIVA_OBRIGATORIA');
  });

  test('reativar INATIVO sem corpo continua igual; com data é 400 DATA_EFETIVA_NAO_SE_APLICA', async (t) => {
    const ok = mundo(t, { existente: noEstado('INATIVO') });
    const r = await servico.reativar(ok.pool, { ...base });
    assert.equal(r.alterado, true);
    assert.equal(ok.historico.mock.calls.length, 1, 'reativar INATIVO grava exatamente uma linha de histórico');
    assert.equal(ok.historico.mock.calls[0].arguments[1].dataEfetiva, null);
    const comData = mundo(t, { existente: noEstado('INATIVO') });
    await esperarHttpError(servico.reativar(comData.pool, { ...base, dataEfetiva: '2026-10-01' }), 400, 'DATA_EFETIVA_NAO_SE_APLICA');
  });

  test('reativar AFASTADO exige a data do retorno; com data respeita o início do afastamento', async (t) => {
    const sem = mundo(t, { existente: noEstado('AFASTADO'), ultima: '2026-09-01' });
    await esperarHttpError(servico.reativar(sem.pool, { ...base }), 400, 'DATA_EFETIVA_OBRIGATORIA');
    const antes = mundo(t, { existente: noEstado('AFASTADO'), ultima: '2026-09-10' });
    await esperarHttpError(servico.reativar(antes.pool, { ...base, dataEfetiva: '2026-09-01' }), 409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA');
    const ok = mundo(t, { existente: noEstado('AFASTADO'), ultima: '2026-09-10' });
    const r = await servico.reativar(ok.pool, { ...base, dataEfetiva: '2026-09-20' });
    assert.equal(r.alterado, true);
    assert.equal(ok.historico.mock.calls.length, 1, 'reativar AFASTADO com data válida grava exatamente uma linha de histórico');
    assert.equal(ok.historico.mock.calls[0].arguments[1].dataEfetiva, '2026-09-20');
  });

  test('reativar quem já está ATIVO continua idempotente (sem corpo): alterado false e nenhuma escrita', async (t) => {
    const m = mundo(t, { existente: noEstado('ATIVO') });
    const r = await servico.reativar(m.pool, { ...base });
    assert.equal(r.alterado, false);
    assert.deepEqual(escritas(m.ordem), []);
    assert.equal(m.auditorias.length, 0);
  });
});

describe('regras de estado preservadas', () => {
  test('INATIVO → AFASTADO continua 409 FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA e a mesma situação 409 FUNCIONARIO_SITUACAO_IGUAL', async (t) => {
    const a = mundo(t, { existente: noEstado('INATIVO') });
    await esperarHttpError(mudar(a, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' }), 409, 'FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA');
    const b = mundo(t, { existente: noEstado('AFASTADO') });
    await esperarHttpError(mudar(b, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' }), 409, 'FUNCIONARIO_SITUACAO_IGUAL');
    assert.deepEqual(escritas(a.ordem).concat(escritas(b.ordem)), []);
  });
});
