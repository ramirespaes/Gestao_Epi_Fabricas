'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/empresa-cadastro.service');
const empresaRepo = require('../../src/repositories/empresa.repository');
const auditoriaPlataformaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do cadastro de empresas (Pacote 3), sem PostgreSQL:
 * ordem e atomicidade (BEGIN -> criar -> provisionar com o MESMO client ->
 * auditoria -> COMMIT), recusas antes de abrir conexão e tradução de
 * violações. Comportamento real: empresa-cadastro-convite-master.integration.js.
 */

const CNPJ = '12345678000195';
const empresaCriada = Object.freeze({ id: 10, razaoSocial: 'R', nomeFantasia: null, cnpj: CNPJ, inscricaoEstadual: null, situacaoInscricaoEstadual: null, endereco: null, numero: null, complemento: null, bairro: null, cidade: null, uf: null, cep: null, telefone: null, email: null, representante: {}, financeiro: {}, ativo: true });
const planoVazio = { empresa: { id: 10 }, perfil: 'MASTER', recursos: [], acoes: [] };

function clienteFalso() {
  const chamadas = [];
  return { chamadas, query: async (t) => { chamadas.push(t); return { rows: [], rowCount: 0 }; }, release: () => chamadas.push('RELEASE') };
}
function poolFalso(cliente) {
  const chamadas = { connect: 0 };
  return { chamadas, connect: async () => { chamadas.connect += 1; return cliente; } };
}
const contar = (chamadas, re) => chamadas.filter((t) => typeof t === 'string' && re.test(t)).length;
const base = { administradorId: 1, razaoSocial: 'Razão Social', cnpj: CNPJ };

describe('criar', () => {
  test('INSERT, provisionamento com o MESMO client (atorId null) e auditoria na mesma transação; prontaParaMaster refletido', async (t) => {
    const cliente = clienteFalso();
    const criar = t.mock.method(empresaRepo, 'criar', async () => empresaCriada);
    const prov = t.mock.method(provisionamento, 'provisionarComExecutor', async () => ({ plano: planoVazio, inseridos: { recursos: [], acoes: [] }, auditoriaId: '5' }));
    const audit = t.mock.method(auditoriaPlataformaRepo, 'registrar', async () => ({ id: '9' }));

    const r = await servico.criar(poolFalso(cliente), { ...base, uf: 'rs', cep: '95000-000', email: 'A@B.com', situacaoInscricaoEstadual: 'isento' });

    assert.equal(criar.mock.calls[0].arguments[0], cliente);
    assert.equal(prov.mock.calls[0].arguments[0], cliente, 'provisionamento participa da transação da empresa');
    assert.deepEqual(prov.mock.calls[0].arguments[1].atorId, null);
    assert.equal(audit.mock.calls[0].arguments[1].administradorId, 1);
    assert.equal(audit.mock.calls[0].arguments[1].empresaAfetadaId, 10);
    assert.equal(r.provisionamento.prontaParaMaster, true);
    assert.deepEqual([contar(cliente.chamadas, /^BEGIN$/), contar(cliente.chamadas, /^COMMIT$/), contar(cliente.chamadas, /^ROLLBACK$/)], [1, 1, 0]);
    // Normalizações aplicadas antes do repositório.
    const args = criar.mock.calls[0].arguments[1];
    assert.deepEqual([args.uf, args.cep, args.email, args.situacaoInscricaoEstadual], ['RS', '95000000', 'a@b.com', 'ISENTO']);
  });

  test('recusas antes de qualquer conexão: razão social vazia, CNPJ inválido, DV inválido, campo inválido, CONTRIBUINTE sem IE', async () => {
    const pool = poolFalso(clienteFalso());
    const casos = [
      [{ ...base, razaoSocial: '  ' }, 'EMPRESA_RAZAO_SOCIAL_INVALIDA'],
      [{ ...base, cnpj: 'abc' }, 'EMPRESA_CNPJ_INVALIDO'],
      [{ ...base, cnpj: '12345678000196' }, 'EMPRESA_CNPJ_DV_INVALIDO'],
      [{ ...base, uf: 'RSX' }, 'EMPRESA_DADOS_INVALIDOS'],
      [{ ...base, situacaoInscricaoEstadual: 'CONTRIBUINTE' }, 'EMPRESA_IE_EXIGIDA'],
    ];
    for (const [dados, codigo] of casos) {
      await assert.rejects(() => servico.criar(pool, dados), (e) => HttpError.ehHttpError(e) && e.status === 400 && e.codigo === codigo);
    }
    assert.equal(pool.chamadas.connect, 0);
  });

  test('CNPJ duplicado (23505 uq_empresas_cnpj) vira 409 com ROLLBACK; falha do provisionamento faz ROLLBACK sem auditoria', async (t) => {
    const cliente = clienteFalso();
    t.mock.method(empresaRepo, 'criar', async () => { throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_empresas_cnpj' }); });
    await assert.rejects(() => servico.criar(poolFalso(cliente), base), (e) => e.status === 409 && e.codigo === 'EMPRESA_CNPJ_EM_USO');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);

    const cliente2 = clienteFalso();
    t.mock.method(empresaRepo, 'criar', async () => empresaCriada);
    const erro = new Error('provisionamento falhou');
    t.mock.method(provisionamento, 'provisionarComExecutor', async () => { throw erro; });
    const audit = t.mock.method(auditoriaPlataformaRepo, 'registrar', async () => ({ id: '9' }));
    await assert.rejects(() => servico.criar(poolFalso(cliente2), base), (e) => e === erro);
    assert.equal(audit.mock.calls.length, 0);
    assert.deepEqual([contar(cliente2.chamadas, /^COMMIT$/), contar(cliente2.chamadas, /^ROLLBACK$/)], [0, 1]);
  });
});

describe('alterar / estado', () => {
  test('cnpj presente (mesmo undefined) é TypeError antes de tudo; nenhum campo é 400 sem conexão', async () => {
    const pool = poolFalso(clienteFalso());
    await assert.rejects(() => servico.alterar(pool, { administradorId: 1, empresaId: 10, cnpj: undefined }), TypeError);
    await assert.rejects(() => servico.alterar(pool, { administradorId: 1, empresaId: 10 }), (e) => e.codigo === 'EMPRESA_SEM_ALTERACAO');
    assert.equal(pool.chamadas.connect, 0);
  });

  test('alterar: coerência da IE avaliada sobre o estado resultante; auditoria com antes/depois', async (t) => {
    const cliente = clienteFalso();
    t.mock.method(empresaRepo, 'buscarDetalhesPorIdParaAtualizacao', async () => ({ ...empresaCriada, situacaoInscricaoEstadual: 'CONTRIBUINTE', inscricaoEstadual: '123' }));
    const atualizar = t.mock.method(empresaRepo, 'atualizar', async () => ({ ...empresaCriada, nomeFantasia: 'N' }));
    const audit = t.mock.method(auditoriaPlataformaRepo, 'registrar', async () => ({ id: '9' }));

    // Limpar a IE enquanto a situação persistida é CONTRIBUINTE -> 400 dentro da transação (ROLLBACK).
    await assert.rejects(() => servico.alterar(poolFalso(cliente), { administradorId: 1, empresaId: 10, inscricaoEstadual: null, inscricaoEstadualInformado: true }), (e) => e.codigo === 'EMPRESA_IE_EXIGIDA');
    assert.equal(atualizar.mock.calls.length, 0);

    await servico.alterar(poolFalso(clienteFalso()), { administradorId: 1, empresaId: 10, nomeFantasia: 'N', nomeFantasiaInformado: true });
    assert.deepEqual(atualizar.mock.calls[0].arguments[2], { nomeFantasia: 'N', nomeFantasiaInformado: true });
    assert.equal(audit.mock.calls[0].arguments[1].acao, 'EMPRESA_ALTERADA');
    assert.equal(audit.mock.calls[0].arguments[1].dadosNovos.nomeFantasia, 'N');
  });

  test('inativar já inativa: alterado=false sem auditoria; reativar audita EMPRESA_REATIVADA', async (t) => {
    t.mock.method(empresaRepo, 'buscarDetalhesPorIdParaAtualizacao', async () => ({ ...empresaCriada, ativo: false }));
    const estado = t.mock.method(empresaRepo, 'atualizarEstado', async () => ({ ...empresaCriada, ativo: true }));
    const audit = t.mock.method(auditoriaPlataformaRepo, 'registrar', async () => ({ id: '9' }));

    const r1 = await servico.inativar(poolFalso(clienteFalso()), { administradorId: 1, empresaId: 10 });
    assert.deepEqual([r1.alterado, estado.mock.calls.length, audit.mock.calls.length], [false, 0, 0]);
    const r2 = await servico.reativar(poolFalso(clienteFalso()), { administradorId: 1, empresaId: 10 });
    assert.deepEqual([r2.alterado, audit.mock.calls[0].arguments[1].acao], [true, 'EMPRESA_REATIVADA']);
  });

  test('consultarProvisionamento traduz ErroProvisionamento: inexistente -> 404, inativa -> 409', async (t) => {
    t.mock.method(provisionamento, 'planejar', async () => { throw new provisionamento.ErroProvisionamento('EMPRESA_NAO_ENCONTRADA', 'x'); });
    await assert.rejects(() => servico.consultarProvisionamento({}, { empresaId: 1 }), (e) => e.status === 404);
    t.mock.method(provisionamento, 'planejar', async () => { throw new provisionamento.ErroProvisionamento('EMPRESA_INATIVA', 'x'); });
    await assert.rejects(() => servico.consultarProvisionamento({}, { empresaId: 1 }), (e) => e.status === 409);
  });
});
