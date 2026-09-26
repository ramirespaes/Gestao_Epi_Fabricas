'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/funcionario.service');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');
const gheRepo = require('../../src/repositories/grupo-homogeneo-exposicao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Serviço de funcionários (Bloco 9, Etapa B), sem PostgreSQL. Pontos
 * centrais: CPF validado por DV e persistido só com dígitos; vínculo só a
 * GHE existente e ativo da mesma empresa; matrícula/CPF duplicados
 * distinguidos pela constraint; CPF/nascimento/telefone NUNCA na
 * auditoria; nenhuma leitura ou escrita em `usuarios`.
 */

const EMPRESA = 42;
const EMPRESA_OUTRA = 99;
const ATOR_ID = 7;
const FUNC_ID = 70;
const GHE_ATIVO = 50;
const GHE_INATIVO = 51;

const funcionario = (extra = {}) => ({
  id: FUNC_ID, empresaId: EMPRESA, grupoHomogeneoId: GHE_ATIVO, matricula: 'MAT-000171', nome: 'Tício de Tal',
  cpf: '52998224725', dataNascimento: '1990-03-15', setor: 'Manutenção', funcao: 'Mecânico', cracha: 'CR-001284',
  telefone: '47999990000', ativo: true, criadoEm: new Date('2026-09-23T12:00:00Z'), atualizadoEm: new Date('2026-09-23T12:00:00Z'), ...extra,
});

function criarClienteFalso() {
  const chamadas = [];
  return { chamadas, query: async (texto) => { chamadas.push(texto); return { rows: [], rowCount: 0 }; }, release: () => { chamadas.push('RELEASE'); } };
}
const criarPoolFalso = (cliente) => ({ connect: async () => cliente, query: (...args) => cliente.query(...args) });
const contar = (chamadas, padrao) => chamadas.filter((c) => padrao.test(c)).length;

function mundoValido(t, { existente = funcionario() } = {}) {
  const localizar = async (_c, empresaId, id) => (empresaId === EMPRESA && existente && id === existente.id ? existente : null);
  t.mock.method(funcionarioRepo, 'buscarPorIdParaAtualizacao', localizar);
  t.mock.method(funcionarioRepo, 'buscarPorId', localizar);
  t.mock.method(funcionarioRepo, 'listarPorEmpresa', async () => [existente].filter(Boolean));
  t.mock.method(funcionarioRepo, 'contarPorEmpresa', async () => (existente ? 1 : 0));
  const ghes = { [GHE_ATIVO]: { id: GHE_ATIVO, empresaId: EMPRESA, ativo: true }, [GHE_INATIVO]: { id: GHE_INATIVO, empresaId: EMPRESA, ativo: false } };
  // Correção pós-auditoria da Etapa B: a verificação do GHE para vínculo
  // usa a leitura TRAVADA (buscarPorIdParaVinculo, FOR SHARE), nunca a
  // leitura sem lock (buscarPorId) — esta última fica mockada só para
  // comprovar que não é chamada.
  const buscarGhe = t.mock.method(gheRepo, 'buscarPorIdParaVinculo', async (_c, empresaId, id) => (empresaId === EMPRESA ? (ghes[id] ?? null) : null));
  t.mock.method(gheRepo, 'buscarPorId', async () => { throw new Error('vínculo não pode usar leitura sem lock (buscarPorId)'); });
  return {
    buscarGhe,
    criar: t.mock.method(funcionarioRepo, 'criar', async (_c, dados) => funcionario({ ...dados })),
    atualizar: t.mock.method(funcionarioRepo, 'atualizar', async (_c, _e, _id, campos) => funcionario({
      nome: campos.nome ?? existente.nome, cpf: existente.cpf, telefone: campos.telefoneInformado ? campos.telefone : existente.telefone,
      grupoHomogeneoId: campos.grupoHomogeneoIdInformado ? campos.grupoHomogeneoId : existente.grupoHomogeneoId,
      ativo: campos.ativo ?? existente.ativo,
    })),
    registrar: t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: new Date() })),
  };
}

async function esperarHttpError(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.equal(erro.status, status);
    assert.equal(erro.codigo, codigo);
    return true;
  });
}

const base = { empresaId: EMPRESA, atorId: ATOR_ID, matricula: 'MAT-000171', nome: 'Tício de Tal', cpf: '529.982.247-25' };

function assertSemDadosSensiveis(auditoria) {
  for (const chave of ['cpf', 'dataNascimento', 'telefone']) {
    assert.ok(!(auditoria.dadosNovos && chave in auditoria.dadosNovos), `${chave} não pode estar em dadosNovos`);
    assert.ok(!(auditoria.dadosAnteriores && chave in auditoria.dadosAnteriores), `${chave} não pode estar em dadosAnteriores`);
  }
  assert.ok(!JSON.stringify(auditoria).includes('52998224725'), 'o CPF em si nunca aparece na auditoria');
}

describe('criar', () => {
  test('CPF com máscara é normalizado e validado; cria, audita FUNCIONARIO_CRIADO sem dados sensíveis, commita', async (t) => {
    const escritas = mundoValido(t);
    const cliente = criarClienteFalso();

    const r = await servico.criar(criarPoolFalso(cliente), { ...base, grupoHomogeneoId: GHE_ATIVO, telefone: '47999990000' });

    assert.equal(r.id, FUNC_ID);
    assert.equal(escritas.criar.mock.calls[0].arguments[1].cpf, '52998224725');
    assert.equal(escritas.buscarGhe.mock.calls.length, 1, 'GHE informado é verificado');
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'FUNCIONARIO_CRIADO');
    assertSemDadosSensiveis(auditoria);
    assert.deepEqual(auditoria.contexto.camposSensiveisOmitidos, ['cpf', 'dataNascimento', 'telefone']);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('sem GHE não consulta o repositório de GHE', async (t) => {
    const escritas = mundoValido(t);
    await servico.criar(criarPoolFalso(criarClienteFalso()), base);
    assert.equal(escritas.buscarGhe.mock.calls.length, 0);
  });

  test('CPF com DV inválido ou sequência repetida: 400 FUNCIONARIO_CPF_INVALIDO antes de abrir transação', async (t) => {
    mundoValido(t);
    for (const cpf of ['529.982.247-26', '11111111111', '123']) {
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.criar(criarPoolFalso(cliente), { ...base, cpf }), 400, 'FUNCIONARIO_CPF_INVALIDO');
      assert.equal(cliente.chamadas.length, 0);
    }
  });

  test('matrícula ou nome vazios: 400 específicos', async (t) => {
    mundoValido(t);
    await esperarHttpError(servico.criar(criarPoolFalso(criarClienteFalso()), { ...base, matricula: '  ' }), 400, 'FUNCIONARIO_MATRICULA_INVALIDA');
    await esperarHttpError(servico.criar(criarPoolFalso(criarClienteFalso()), { ...base, nome: '' }), 400, 'FUNCIONARIO_NOME_INVALIDO');
  });

  test('GHE inexistente nesta empresa: 400 FUNCIONARIO_GHE_INVALIDO; GHE inativo: 409 FUNCIONARIO_GHE_INATIVO — ROLLBACK, nada gravado', async (t) => {
    const escritas = mundoValido(t);
    const inexistente = criarClienteFalso();
    await esperarHttpError(servico.criar(criarPoolFalso(inexistente), { ...base, grupoHomogeneoId: 999 }), 400, 'FUNCIONARIO_GHE_INVALIDO');
    assert.equal(contar(inexistente.chamadas, /^ROLLBACK$/), 1);

    const inativo = criarClienteFalso();
    await esperarHttpError(servico.criar(criarPoolFalso(inativo), { ...base, grupoHomogeneoId: GHE_INATIVO }), 409, 'FUNCIONARIO_GHE_INATIVO');
    assert.equal(contar(inativo.chamadas, /^ROLLBACK$/), 1);
    assert.equal(escritas.criar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
  });

  test('duplicidade distinguida pela constraint: matrícula → 409 MATRICULA_EM_USO; CPF → 409 CPF_EM_USO; FK → 400 GHE_INVALIDO', async (t) => {
    const casos = [
      ['uq_funcionarios_empresa_matricula', '23505', 409, 'FUNCIONARIO_MATRICULA_EM_USO'],
      ['uq_funcionarios_empresa_cpf', '23505', 409, 'FUNCIONARIO_CPF_EM_USO'],
      ['fk_funcionarios_ghe_mesma_empresa', '23503', 400, 'FUNCIONARIO_GHE_INVALIDO'],
    ];
    for (const [constraint, code, status, codigo] of casos) {
      const escritas = mundoValido(t);
      escritas.criar.mock.mockImplementation(async () => { throw Object.assign(new Error('violação'), { code, constraint }); });
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.criar(criarPoolFalso(cliente), base), status, codigo);
      assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
      assert.equal(escritas.registrar.mock.calls.length, 0);
    }
  });
});

describe('buscar e listar', () => {
  test('isolamento: funcionário de outra empresa é 404', async (t) => {
    mundoValido(t);
    await esperarHttpError(servico.buscar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA_OUTRA, funcionarioId: FUNC_ID }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
  });

  test('listar repassa filtro por GHE e devolve total/página/limite', async (t) => {
    const escritas = mundoValido(t);
    const r = await servico.listar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, grupoHomogeneoId: GHE_ATIVO, pagina: 1, limite: 10 });
    assert.equal(r.funcionarios.length, 1);
    assert.equal(r.total, 1);
    assert.equal(funcionarioRepo.listarPorEmpresa.mock.calls[0].arguments[2].grupoHomogeneoId, GHE_ATIVO);
    assert.ok(escritas);
  });
});

describe('alterar', () => {
  test('troca de GHE verifica o novo GHE; audita anterior/novo sem dados sensíveis', async (t) => {
    const escritas = mundoValido(t, { existente: funcionario({ grupoHomogeneoId: null }) });
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, grupoHomogeneoId: GHE_ATIVO, grupoHomogeneoIdInformado: true });
    assert.equal(escritas.buscarGhe.mock.calls.length, 1);
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.acao, 'FUNCIONARIO_ALTERADO');
    assert.equal(auditoria.dadosAnteriores.grupoHomogeneoId, null);
    assert.equal(auditoria.dadosNovos.grupoHomogeneoId, GHE_ATIVO);
    assertSemDadosSensiveis(auditoria);
  });

  test('desvincular (grupoHomogeneoId null) não consulta GHE; manter o mesmo GHE também não', async (t) => {
    const escritas = mundoValido(t);
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, grupoHomogeneoId: null, grupoHomogeneoIdInformado: true });
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, grupoHomogeneoId: GHE_ATIVO, grupoHomogeneoIdInformado: true });
    assert.equal(escritas.buscarGhe.mock.calls.length, 0);
  });

  test('troca para GHE inativo: 409 FUNCIONARIO_GHE_INATIVO', async (t) => {
    mundoValido(t);
    await esperarHttpError(
      servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, grupoHomogeneoId: GHE_INATIVO, grupoHomogeneoIdInformado: true }),
      409, 'FUNCIONARIO_GHE_INATIVO',
    );
  });

  test('CPF imutável: alterar NÃO aceita cpf — igual, diferente, inválido, null ou undefined EXPLÍCITO é erro de programação (TypeError), sem transação, sem escrita, sem auditoria', async (t) => {
    const escritas = mundoValido(t);
    // 'undefined' aqui vira cpf: undefined como PROPRIEDADE PRÓPRIA do objeto
    // literal (shorthand `{ cpf }` sempre cria a chave, mesmo quando o valor
    // é undefined) — é exatamente o caso que Object.hasOwn(dados, 'cpf')
    // precisa reconhecer e que uma checagem `cpf !== undefined` sobre o
    // valor já desestruturado NÃO reconheceria (correção pós-auditoria
    // independente de 23/09/2026).
    for (const cpf of ['52998224725', '529.982.247-25', '111.444.777-35', '00000000000', null, undefined]) {
      const dados = { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, nome: 'Tício T.', cpf };
      assert.ok(Object.hasOwn(dados, 'cpf'), 'pré-condição do teste: a chave cpf precisa estar presente no objeto');
      const cliente = criarClienteFalso();
      await assert.rejects(
        servico.alterar(criarPoolFalso(cliente), dados),
        (erro) => erro instanceof TypeError && !HttpError.ehHttpError(erro) && /cpf/i.test(erro.message),
        String(cpf),
      );
      assert.equal(cliente.chamadas.length, 0, 'nenhum BEGIN: recusado antes da transação');
    }
    assert.equal(escritas.atualizar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
  });

  test('CPF imutável: cpf: undefined explícito é recusado mesmo isolado (sem outro campo), antes de qualquer leitura do funcionário', async (t) => {
    const escritas = mundoValido(t);
    const dados = { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, cpf: undefined };
    assert.ok(Object.hasOwn(dados, 'cpf'));
    await assert.rejects(
      servico.alterar(criarPoolFalso(criarClienteFalso()), dados),
      (erro) => erro instanceof TypeError && /cpf/i.test(erro.message),
    );
    assert.equal(escritas.atualizar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
    // buscarPorIdParaAtualizacao é chamado DENTRO da transação; sem transação, não é chamado.
    assert.equal(funcionarioRepo.buscarPorIdParaAtualizacao.mock.calls.length, 0);
  });

  test('campo sensível alterado (telefone) é registrado só pelo nome; o repositório nunca recebe chave cpf e "cpf" nunca entra em camposSensiveisAlterados', async (t) => {
    const escritas = mundoValido(t);
    const auditorias = [];
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, telefone: '47988887777', telefoneInformado: true });
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, nome: 'Tício T.', dataNascimento: '1990-03-16', dataNascimentoInformado: true });
    for (const chamada of escritas.atualizar.mock.calls) {
      assert.ok(!Object.hasOwn(chamada.arguments[3], 'cpf'), 'atualizar não recebe cpf nem como null');
    }
    for (const chamada of escritas.registrar.mock.calls) {
      auditorias.push(chamada.arguments[1]);
    }
    assert.deepEqual(auditorias.map((a) => a.contexto.camposSensiveisAlterados), [['telefone'], ['dataNascimento']]);
    assert.ok(!JSON.stringify(auditorias).includes('47988887777'));
    for (const a of auditorias) assertSemDadosSensiveis(a);
  });

  test('nenhum campo: 400 FUNCIONARIO_SEM_ALTERACAO', async (t) => {
    mundoValido(t);
    await esperarHttpError(servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID }), 400, 'FUNCIONARIO_SEM_ALTERACAO');
  });
});

describe('inativar e reativar', () => {
  test('inativar audita FUNCIONARIO_INATIVADO; repetido é idempotente sem auditoria; reativar audita FUNCIONARIO_REATIVADO', async (t) => {
    const escritas = mundoValido(t);
    const r = await servico.inativar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID });
    assert.equal(r.alterado, true);
    assert.equal(escritas.registrar.mock.calls[0].arguments[1].acao, 'FUNCIONARIO_INATIVADO');
    assertSemDadosSensiveis(escritas.registrar.mock.calls[0].arguments[1]);

    const repetido = mundoValido(t, { existente: funcionario({ ativo: false }) });
    const r2 = await servico.inativar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID });
    assert.equal(r2.alterado, false);
    assert.equal(repetido.registrar.mock.calls.length, 0);

    const reativado = mundoValido(t, { existente: funcionario({ ativo: false }) });
    await servico.reativar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID });
    assert.equal(reativado.registrar.mock.calls[0].arguments[1].acao, 'FUNCIONARIO_REATIVADO');
  });

  test('inexistente nesta empresa: 404 com ROLLBACK', async (t) => {
    mundoValido(t, { existente: null });
    const cliente = criarClienteFalso();
    await esperarHttpError(servico.inativar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// C4 (25/09/2026): data de admissão, CPF exato e importação em lote.
// ═══════════════════════════════════════════════════════════════════
const crypto = require('node:crypto');
const declaracao = require('../../src/services/declaracao-lgpd');

describe('C4 — data de admissão no cadastro e na edição', () => {
  test('criar repassa dataAdmissao; admissão até o nascimento ou antes de 1900: 400 FUNCIONARIO_DATA_ADMISSAO_INVALIDA sem abrir transação', async (t) => {
    const escritas = mundoValido(t);
    await servico.criar(criarPoolFalso(criarClienteFalso()), { ...base, dataNascimento: '1990-03-15', dataAdmissao: '2020-06-01' });
    assert.equal(escritas.criar.mock.calls[0].arguments[1].dataAdmissao, '2020-06-01');
    for (const extra of [{ dataNascimento: '1990-03-15', dataAdmissao: '1990-03-15' }, { dataNascimento: '1990-03-15', dataAdmissao: '1980-01-01' }, { dataAdmissao: '1899-12-31' }]) {
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.criar(criarPoolFalso(cliente), { ...base, ...extra }), 400, 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA');
      assert.equal(contar(cliente.chamadas, /^BEGIN$/), 0, JSON.stringify(extra));
    }
    assert.equal(escritas.criar.mock.calls.length, 1);
  });

  test('alterar compara com as datas já gravadas: admissão antes do nascimento existente, ou nascimento depois da admissão existente → 400 e ROLLBACK', async (t) => {
    const escritas = mundoValido(t, { existente: funcionario({ dataNascimento: '1990-03-15', dataAdmissao: '2010-01-01' }) });
    for (const extra of [{ dataAdmissao: '1989-01-01', dataAdmissaoInformado: true }, { dataNascimento: '2011-01-01', dataNascimentoInformado: true }]) {
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.alterar(criarPoolFalso(cliente), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, ...extra }), 400, 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA');
      assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
    }
    assert.equal(escritas.atualizar.mock.calls.length, 0);
    await servico.alterar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, atorId: ATOR_ID, funcionarioId: FUNC_ID, dataAdmissao: null, dataAdmissaoInformado: true });
    const campos = escritas.atualizar.mock.calls[0].arguments[3];
    assert.deepEqual([campos.dataAdmissao, campos.dataAdmissaoInformado], [null, true]);
  });

  test('CHECK do banco traduzido pela constraint: admissão → DATA_ADMISSAO_INVALIDA; formato de CPF → CPF_INVALIDO; outra → DADOS_INVALIDOS', async (t) => {
    const casos = [
      ['chk_funcionarios_admissao_apos_nascimento', 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA'],
      ['chk_funcionarios_data_admissao_minima', 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA'],
      ['chk_funcionarios_cpf_formato', 'FUNCIONARIO_CPF_INVALIDO'],
      ['chk_outra', 'FUNCIONARIO_DADOS_INVALIDOS'],
    ];
    for (const [constraint, codigo] of casos) {
      const escritas = mundoValido(t);
      escritas.criar.mock.mockImplementation(async () => { throw Object.assign(new Error('violação'), { code: '23514', constraint }); });
      await esperarHttpError(servico.criar(criarPoolFalso(criarClienteFalso()), base), 400, codigo);
    }
  });

  test('auditoria inclui a data de admissão (dado de vínculo) e continua sem CPF, nascimento e telefone', async (t) => {
    const escritas = mundoValido(t);
    await servico.criar(criarPoolFalso(criarClienteFalso()), { ...base, dataAdmissao: '2020-06-01', telefone: '47999990000', dataNascimento: '1990-03-15' });
    const auditoria = escritas.registrar.mock.calls[0].arguments[1];
    assert.equal(auditoria.dadosNovos.dataAdmissao, '2020-06-01');
    assertSemDadosSensiveis(auditoria);
  });

  test('listar repassa o CPF exato (já normalizado) ao repositório', async (t) => {
    mundoValido(t);
    await servico.listar(criarPoolFalso(criarClienteFalso()), { empresaId: EMPRESA, cpf: '52998224725', pagina: 1, limite: 10 });
    assert.equal(funcionarioRepo.listarPorEmpresa.mock.calls[0].arguments[2].cpf, '52998224725');
    assert.equal(funcionarioRepo.contarPorEmpresa.mock.calls[0].arguments[2].cpf, '52998224725');
  });
});

describe('C4 — declaração LGPD da importação (versão e hash do texto apresentado)', () => {
  test('versão atual conhecida; hash = SHA-256 do texto exato; versão desconhecida não tem texto', () => {
    assert.equal(declaracao.VERSAO_ATUAL, 'IMPORTACAO-FUNCIONARIOS-V1');
    const texto = declaracao.textoDaVersao('IMPORTACAO-FUNCIONARIOS-V1');
    assert.match(texto, /foram informados sobre o tratamento dos seus dados pessoais/);
    assert.doesNotMatch(texto, /consent/i, 'declaração de informação, não consentimento');
    assert.equal(declaracao.hashDaVersao('IMPORTACAO-FUNCIONARIOS-V1'), crypto.createHash('sha256').update(texto, 'utf8').digest('hex'));
    assert.equal(declaracao.versaoConhecida('IMPORTACAO-FUNCIONARIOS-V0'), false);
    assert.equal(declaracao.textoDaVersao('X'), null);
  });
});

describe('C4 — importação em lote', () => {
  const IMPORTACAO = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const linhaImp = (linha, extra = {}) => ({
    linha, nome: `Funcionário ${linha}`, cpf: '52998224725', matricula: `MAT-${linha}`, dataAdmissao: '2020-06-01',
    dataNascimento: '1990-03-15', setor: 'Produção', funcao: 'Operador', telefone: '47999990000', ...extra,
  });
  const pedido = (linhas, extra = {}) => ({
    empresaId: EMPRESA, atorId: ATOR_ID, importacaoId: IMPORTACAO, lote: { numero: 1, total: 2 },
    arquivo: { nome: 'funcionarios.xlsx', formato: 'xlsx', totalLinhas: 150 },
    declaracaoLgpd: { versao: 'IMPORTACAO-FUNCIONARIOS-V1', confirmada: true }, linhas, ip: '10.0.0.1', dispositivo: 'teste', ...extra,
  });

  test('lote misto: cada linha tem resultado próprio e transação própria; uma linha ruim não desfaz nem interrompe as demais', async (t) => {
    const escritas = mundoValido(t);
    let id = 1000;
    escritas.criar.mock.mockImplementation(async (_c, dados) => {
      if (dados.matricula === 'MAT-4') throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_funcionarios_empresa_cpf' });
      if (dados.matricula === 'MAT-5') throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_funcionarios_empresa_matricula' });
      if (dados.matricula === 'MAT-6') throw new Error('falha inesperada com 52998224725 na mensagem');
      id += 1;
      return funcionario({ ...dados, id });
    });
    const erroLog = t.mock.method(console, 'error', () => {});
    const cliente = criarClienteFalso();
    const r = await servico.importar(criarPoolFalso(cliente), pedido([
      linhaImp(2), linhaImp(3, { cpf: '52998224726' }), linhaImp(4), linhaImp(5), linhaImp(6), linhaImp(7, { dataAdmissao: '1985-01-01' }), linhaImp(8),
    ]));
    assert.deepEqual(r.linhas, [
      { linha: 2, situacao: 'CADASTRADO', funcionarioId: 1001 },
      { linha: 3, situacao: 'RECUSADO', codigo: 'FUNCIONARIO_CPF_INVALIDO', motivo: 'CPF inválido.', campos: ['cpf'] },
      { linha: 4, situacao: 'DUPLICADO', codigo: 'FUNCIONARIO_CPF_EM_USO', motivo: 'CPF já cadastrado nesta empresa.' },
      { linha: 5, situacao: 'DUPLICADO', codigo: 'FUNCIONARIO_MATRICULA_EM_USO', motivo: 'Matrícula já cadastrada nesta empresa.' },
      { linha: 6, situacao: 'ERRO', codigo: 'ERRO_INTERNO', motivo: 'Erro ao processar esta linha. Ela não foi gravada.' },
      { linha: 7, situacao: 'RECUSADO', codigo: 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA', motivo: 'Data de admissão inválida: deve ser a partir de 1900 e posterior ao nascimento.', campos: ['dataAdmissao'] },
      { linha: 8, situacao: 'CADASTRADO', funcionarioId: 1002 },
    ]);
    assert.deepEqual(r.resumo, { cadastrados: 2, duplicados: 2, recusados: 2, erros: 1 });
    assert.deepEqual([r.importacaoId, r.lote], [IMPORTACAO, { numero: 1, total: 2 }]);
    // linhas que chegaram ao banco (2, 4, 5, 6, 8) + o registro do lote: uma transação cada
    assert.equal(contar(cliente.chamadas, /^BEGIN$/), 6);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 3, 'linhas 2 e 8 e a auditoria do lote');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 3, 'linhas 4, 5 e 6');
    assert.equal(escritas.atualizar.mock.calls.length, 0, 'nunca altera funcionário existente');
    // log técnico da linha com erro: só identificadores, nunca dados pessoais
    assert.equal(erroLog.mock.calls.length, 1);
    const logado = JSON.stringify(erroLog.mock.calls[0].arguments);
    assert.match(logado, /importacao/);
    assert.doesNotMatch(logado, /52998224725|Funcionário 6|47999990000|1990-03-15/);
  });

  test('a resposta nunca devolve nome, CPF, telefone nem datas das linhas', async (t) => {
    mundoValido(t);
    const r = await servico.importar(criarPoolFalso(criarClienteFalso()), pedido([linhaImp(2), linhaImp(3, { cpf: '1' })]));
    assert.doesNotMatch(JSON.stringify(r), /52998224725|Funcionário 2|47999990000|1990-03-15|2020-06-01/);
  });

  test('auditoria: FUNCIONARIO_CRIADO por linha com origem, importacaoId e linha; um FUNCIONARIOS_IMPORTACAO_LOTE com declaração (versão, hash), contadores e nenhum dado pessoal', async (t) => {
    const escritas = mundoValido(t);
    await servico.importar(criarPoolFalso(criarClienteFalso()), pedido([linhaImp(2), linhaImp(3, { cpf: '1' })]));
    const eventos = escritas.registrar.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(eventos.map((e) => e.acao), ['FUNCIONARIO_CRIADO', 'FUNCIONARIOS_IMPORTACAO_LOTE']);
    const criado = eventos[0];
    assert.deepEqual([criado.contexto.origem, criado.contexto.importacaoId, criado.contexto.linha], ['importacao', IMPORTACAO, 2]);
    assertSemDadosSensiveis(criado);
    const lote = eventos[1];
    assert.deepEqual([lote.empresaId, lote.usuarioId, lote.referencia, lote.ip, lote.dispositivo], [EMPRESA, ATOR_ID, IMPORTACAO, '10.0.0.1', 'teste']);
    assert.deepEqual(lote.contexto, {
      versaoDeclaracao: 'IMPORTACAO-FUNCIONARIOS-V1',
      hashTextoDeclaracao: declaracao.hashDaVersao('IMPORTACAO-FUNCIONARIOS-V1'),
      declaracaoConfirmada: true,
      lote: 1, totalLotes: 2, formato: 'xlsx', nomeArquivo: 'funcionarios.xlsx', totalLinhasArquivo: 150,
      linhasNoLote: 2, cadastrados: 1, duplicados: 0, recusados: 1, erros: 0,
    });
    assert.doesNotMatch(JSON.stringify(lote), /52998224725|Funcionário|47999990000|1990-03-15/);
  });

  test('declaração ausente, não confirmada ou de versão desconhecida: 400 IMPORTACAO_DECLARACAO_LGPD_INVALIDA antes de qualquer transação', async (t) => {
    const escritas = mundoValido(t);
    for (const declaracaoLgpd of [undefined, { versao: 'IMPORTACAO-FUNCIONARIOS-V1', confirmada: false }, { versao: 'IMPORTACAO-FUNCIONARIOS-V0', confirmada: true }]) {
      const cliente = criarClienteFalso();
      await esperarHttpError(servico.importar(criarPoolFalso(cliente), pedido([linhaImp(2)], { declaracaoLgpd })), 400, 'IMPORTACAO_DECLARACAO_LGPD_INVALIDA');
      assert.equal(contar(cliente.chamadas, /^BEGIN$/), 0);
    }
    assert.equal(escritas.criar.mock.calls.length, 0);
    assert.equal(escritas.registrar.mock.calls.length, 0);
  });

  test('mais de 100 linhas no lote: TypeError de contrato (a rota já recusa com 400), nada gravado', async (t) => {
    const escritas = mundoValido(t);
    const linhas = Array.from({ length: 101 }, (_, i) => linhaImp(i + 2));
    await assert.rejects(servico.importar(criarPoolFalso(criarClienteFalso()), pedido(linhas)), TypeError);
    assert.equal(escritas.criar.mock.calls.length, 0);
  });

  test('importação nunca vincula GHE nem aceita crachá: o repositório recebe só os campos da planilha', async (t) => {
    const escritas = mundoValido(t);
    await servico.importar(criarPoolFalso(criarClienteFalso()), pedido([linhaImp(2)]));
    const dados = escritas.criar.mock.calls[0].arguments[1];
    assert.deepEqual(dados, {
      empresaId: EMPRESA, matricula: 'MAT-2', nome: 'Funcionário 2', cpf: '52998224725', grupoHomogeneoId: null,
      dataNascimento: '1990-03-15', dataAdmissao: '2020-06-01', setor: 'Produção', funcao: 'Operador', cracha: null, telefone: '47999990000',
    });
    assert.equal(escritas.buscarGhe.mock.calls.length, 0);
  });
});
