'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/empresa-dados.service');
const empresaRepo = require('../../src/repositories/empresa.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');

const EMPRESA = 7;
const USUARIO = 11;

const base = (extra = {}) => ({
  id: EMPRESA, razaoSocial: 'Razão Ltda', nomeFantasia: 'Fantasia', cnpj: '11222333000181', inscricaoEstadual: null, situacaoInscricaoEstadual: null,
  endereco: 'Rua A', numero: '10', complemento: null, bairro: 'Centro', cidade: 'SP', uf: 'SP', cep: '01310100', telefone: '1140001000', email: 'contato@e.com',
  emailSst: null, emailAlmoxarifado: null,
  representante: { nome: 'Rep', cargo: 'Dir', email: 'rep@e.com', telefone: '11' }, financeiro: { nome: null, email: null, telefone: null },
  versao: 3, ativo: true, criadoEm: new Date(), atualizadoEm: new Date(), ...extra,
});

function mundo(t, { atual = base(), atualizacao = (campos) => base({ ...campos, versao: 4 }) } = {}) {
  const log = [];
  const client = {
    query: async (sql) => { log.push(sql); return { rows: [] }; },
    release: () => log.push('RELEASE'),
  };
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const m = {
    log,
    pool,
    buscar: t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => atual),
    travar: t.mock.method(empresaRepo, 'buscarDetalhesPorIdParaAtualizacao', async () => atual),
    atualizar: t.mock.method(empresaRepo, 'atualizarDadosEmpresariais', async (_c, _id, campos) => (atualizacao === null ? null : atualizacao(campos))),
    auditar: t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: new Date() })),
  };
  return m;
}

const chamada = (extra = {}) => ({ empresaId: EMPRESA, usuarioId: USUARIO, versaoEsperada: 3, campos: { telefone: '1199998888' }, ip: '127.0.0.1', dispositivo: 'teste', ...extra });

describe('empresa-dados.service — consultar', () => {
  test('devolve a projeção do Portal com versão e campos bloqueados, sem ativo nem carimbos', async (t) => {
    const m = mundo(t);
    const dados = await servico.consultar(m.pool, { empresaId: EMPRESA });
    assert.equal(dados.razaoSocial, 'Razão Ltda');
    assert.equal(dados.cnpj, '11222333000181');
    assert.equal(dados.versao, 3);
    assert.deepEqual(dados.camposBloqueados, ['razaoSocial', 'cnpj']);
    for (const chave of ['ativo', 'criadoEm', 'atualizadoEm', 'id']) assert.equal(Object.hasOwn(dados, chave), false, chave);
    assert.deepEqual(m.buscar.mock.calls[0].arguments.slice(1), [EMPRESA]);
  });

  test('empresa inexistente é 404', async (t) => {
    mundo(t, { atual: null });
    await assert.rejects(servico.consultar({ query: async () => ({ rows: [] }) }, { empresaId: EMPRESA }), (e) => e.status === 404 && e.codigo === 'EMPRESA_NAO_ENCONTRADA');
  });
});

describe('empresa-dados.service — alterar', () => {
  test('grava só o que mudou, audita só os nomes e as versões, e confirma a transação', async (t) => {
    const m = mundo(t);
    const r = await servico.alterar(m.pool, chamada({ campos: { telefone: '1199998888', nomeFantasia: 'Fantasia' } }));
    assert.equal(r.alterado, true);
    assert.deepEqual(r.camposAlterados, ['telefone']);
    assert.deepEqual(m.atualizar.mock.calls[0].arguments.slice(1), [EMPRESA, { telefone: '1199998888' }, 3]);
    assert.equal(r.dados.versao, 4);
    assert.equal(m.auditar.mock.callCount(), 1);
    const reg = m.auditar.mock.calls[0].arguments[1];
    assert.equal(reg.acao, 'EMPRESA_DADOS_ALTERADOS');
    assert.equal(reg.empresaId, EMPRESA);
    assert.equal(reg.usuarioId, USUARIO);
    assert.deepEqual(reg.contexto, { camposAlterados: ['telefone'], versaoAnterior: 3, versaoNova: 4 });
    assert.equal(JSON.stringify(reg).includes('1199998888'), false, 'valores nunca vão para a auditoria');
    assert.equal(JSON.stringify(reg).includes('1140001000'), false);
    assert.deepEqual(m.log.filter((x) => /BEGIN|COMMIT|ROLLBACK/.test(x)), ['BEGIN', 'COMMIT']);
  });

  test('nada realmente mudou: sem UPDATE, sem auditoria, versão intacta', async (t) => {
    const m = mundo(t);
    const r = await servico.alterar(m.pool, chamada({ campos: { telefone: '1140001000', complemento: null } }));
    assert.equal(r.alterado, false);
    assert.deepEqual(r.camposAlterados, []);
    assert.equal(r.dados.versao, 3);
    assert.equal(m.atualizar.mock.callCount(), 0);
    assert.equal(m.auditar.mock.callCount(), 0);
  });

  test('versão antiga: 409, sem UPDATE nem auditoria, com ROLLBACK', async (t) => {
    const m = mundo(t);
    await assert.rejects(servico.alterar(m.pool, chamada({ versaoEsperada: 2 })), (e) => e.status === 409 && e.codigo === 'EMPRESA_DADOS_DESATUALIZADOS');
    assert.equal(m.atualizar.mock.callCount(), 0);
    assert.equal(m.auditar.mock.callCount(), 0);
    assert.deepEqual(m.log.filter((x) => /BEGIN|COMMIT|ROLLBACK/.test(x)), ['BEGIN', 'ROLLBACK']);
  });

  test('o UPDATE condicional não casou (corrida): 409 e nada auditado', async (t) => {
    const m = mundo(t, { atualizacao: null });
    await assert.rejects(servico.alterar(m.pool, chamada()), (e) => e.status === 409 && e.codigo === 'EMPRESA_DADOS_DESATUALIZADOS');
    assert.equal(m.auditar.mock.callCount(), 0);
  });

  test('razão social, CNPJ e demais chaves proibidas são recusadas pelo serviço mesmo chamadas direto', async (t) => {
    const m = mundo(t);
    for (const chave of ['razaoSocial', 'cnpj', 'nome', 'ativo', 'empresaId', 'usuarioId', 'id', 'versao', 'qualquerOutra']) {
      await assert.rejects(servico.alterar(m.pool, chamada({ campos: { [chave]: 'x' } })), (e) => e.status === 400 && e.codigo === 'CAMPO_NAO_PERMITIDO', chave);
    }
    assert.equal(m.travar.mock.callCount(), 0, 'recusa antes de abrir qualquer leitura');
    assert.equal(m.atualizar.mock.callCount(), 0);
  });

  test('normaliza (e-mail, UF, CEP) antes de comparar e gravar', async (t) => {
    const m = mundo(t);
    await servico.alterar(m.pool, chamada({ campos: { emailSst: ' SST@E.com ', uf: 'rj', cep: '20000-000' } }));
    assert.deepEqual(m.atualizar.mock.calls[0].arguments[2], { emailSst: 'sst@e.com', uf: 'RJ', cep: '20000000' });
  });

  test('valor inválido é 400 EMPRESA_DADOS_INVALIDOS; sem campos é 400 EMPRESA_SEM_ALTERACAO', async (t) => {
    const m = mundo(t);
    await assert.rejects(servico.alterar(m.pool, chamada({ campos: { emailSst: 'nao-e-email' } })), (e) => e.codigo === 'EMPRESA_DADOS_INVALIDOS');
    await assert.rejects(servico.alterar(m.pool, chamada({ campos: {} })), (e) => e.codigo === 'EMPRESA_SEM_ALTERACAO');
  });

  test('CONTRIBUINTE exige o número, avaliado sobre o estado resultante', async (t) => {
    const m = mundo(t);
    await assert.rejects(servico.alterar(m.pool, chamada({ campos: { situacaoInscricaoEstadual: 'CONTRIBUINTE' } })), (e) => e.codigo === 'EMPRESA_IE_EXIGIDA');
    const ok = mundo(t, { atual: base({ inscricaoEstadual: '123456' }) });
    const r = await servico.alterar(ok.pool, chamada({ campos: { situacaoInscricaoEstadual: 'CONTRIBUINTE' } }));
    assert.equal(r.alterado, true);
  });

  test('contatos aninhados entram no diff pelo valor atual', async (t) => {
    const m = mundo(t);
    const r = await servico.alterar(m.pool, chamada({ campos: { representanteNome: 'Rep', representanteEmail: 'novo@e.com' } }));
    assert.deepEqual(r.camposAlterados, ['representanteEmail']);
  });

  test('empresa inexistente é 404 e identificadores inválidos são TypeError', async (t) => {
    const m = mundo(t, { atual: null });
    await assert.rejects(servico.alterar(m.pool, chamada()), (e) => e.status === 404);
    await assert.rejects(servico.alterar(m.pool, chamada({ empresaId: 0 })), TypeError);
    await assert.rejects(servico.alterar(m.pool, chamada({ usuarioId: null })), TypeError);
    await assert.rejects(servico.alterar(m.pool, chamada({ versaoEsperada: 0 })), TypeError);
  });
});
