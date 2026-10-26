'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../src/repositories/empresa.repository');

function executorFalso(linhas = []) {
  const chamadas = [];
  return { chamadas, query: async (sql, params) => { chamadas.push({ sql, params }); return { rows: linhas }; } };
}

const LINHA = {
  id: 7, nome: 'Razão Ltda', nome_fantasia: null, cnpj: '11222333000181', inscricao_estadual: null, situacao_inscricao_estadual: null,
  endereco: null, numero: null, complemento: null, bairro: null, cidade: null, uf: null, cep: null, telefone: '11', email: null,
  representante_nome: null, representante_cargo: null, representante_email: null, representante_telefone: null,
  financeiro_nome: null, financeiro_email: null, financeiro_telefone: null,
  email_sst: 'sst@e.com', email_almoxarifado: null, versao: 4, ativo: true, criado_em: new Date(), atualizado_em: new Date(),
};

describe('empresa.repository — Dados da Empresa', () => {
  test('a projeção detalhada traz versão e os e-mails de SST e Almoxarifado', async () => {
    const e = executorFalso([LINHA]);
    const empresa = await repo.buscarDetalhesPorId(e, 7);
    assert.match(e.chamadas[0].sql, /email_sst, email_almoxarifado, versao/);
    assert.equal(empresa.versao, 4);
    assert.equal(empresa.emailSst, 'sst@e.com');
    assert.equal(empresa.emailAlmoxarifado, null);
  });

  test('a lista branca do Portal tem os 19 opcionais do Painel mais os dois e-mails, sem razão social nem CNPJ', () => {
    assert.equal(repo.CAMPOS_PORTAL.length, repo.CAMPOS_OPCIONAIS.length + 2);
    const colunas = repo.CAMPOS_PORTAL.map(([, coluna]) => coluna);
    for (const proibida of ['nome', 'cnpj', 'ativo', 'versao', 'id', 'empresa_id']) {
      assert.equal(colunas.includes(proibida), false, proibida);
    }
    assert.ok(colunas.includes('email_sst') && colunas.includes('email_almoxarifado'));
  });

  test('atualizarDadosEmpresariais: UPDATE único com WHERE id e versão, só as colunas pedidas, sem nome nem cnpj no texto', async () => {
    const e = executorFalso([LINHA]);
    const r = await repo.atualizarDadosEmpresariais(e, 7, { telefone: '1199', emailSst: null }, 4);
    assert.equal(r.versao, 4);
    assert.equal(e.chamadas.length, 1);
    const { sql, params } = e.chamadas[0];
    assert.match(sql, /^UPDATE empresas SET telefone = \$3, email_sst = \$4 WHERE id = \$1 AND versao = \$2 RETURNING /);
    assert.deepEqual(params, [7, 4, '1199', null]);
    const antesDoReturning = sql.split('RETURNING')[0];
    assert.doesNotMatch(antesDoReturning, /\bnome\b|\bcnpj\b|\bativo\b|\bversao\s*=\s*\$[3-9]/);
  });

  test('atualizarDadosEmpresariais devolve null quando nenhuma linha casa (empresa inexistente OU versão antiga)', async () => {
    assert.equal(await repo.atualizarDadosEmpresariais(executorFalso([]), 7, { telefone: '1' }, 4), null);
  });

  test('atualizarDadosEmpresariais recusa, antes de tocar o banco, qualquer chave fora da lista branca', async () => {
    for (const chave of ['razaoSocial', 'nome', 'cnpj', 'ativo', 'versao', 'id', 'empresa_id', 'empresaId', 'criado_em', 'telefone; DROP TABLE empresas']) {
      const e = executorFalso([LINHA]);
      await assert.rejects(repo.atualizarDadosEmpresariais(e, 7, { [chave]: 'x' }, 4), TypeError, chave);
      assert.equal(e.chamadas.length, 0, chave);
    }
  });

  test('atualizarDadosEmpresariais valida empresa, versão, vazio e valores', async () => {
    const e = executorFalso([LINHA]);
    await assert.rejects(repo.atualizarDadosEmpresariais(e, 0, { telefone: '1' }, 1), TypeError);
    await assert.rejects(repo.atualizarDadosEmpresariais(e, 7, { telefone: '1' }, 0), TypeError);
    await assert.rejects(repo.atualizarDadosEmpresariais(e, 7, { telefone: '1' }, null), TypeError);
    await assert.rejects(repo.atualizarDadosEmpresariais(e, 7, {}, 1), TypeError);
    await assert.rejects(repo.atualizarDadosEmpresariais(e, 7, { uf: 'sp' }, 1), TypeError);
    await assert.rejects(repo.atualizarDadosEmpresariais(e, 7, { telefone: 'x'.repeat(21) }, 1), TypeError);
    assert.equal(e.chamadas.length, 0);
  });

  test('atualizar (Painel): versaoEsperada opcional acrescenta AND versao; sem ela o texto é o de sempre', async () => {
    const sem = executorFalso([LINHA]);
    await repo.atualizar(sem, 7, { telefoneInformado: true, telefone: '1' });
    assert.doesNotMatch(sem.chamadas[0].sql, /AND versao/);
    const com = executorFalso([LINHA]);
    await repo.atualizar(com, 7, { telefoneInformado: true, telefone: '1' }, { versaoEsperada: 4 });
    assert.match(com.chamadas[0].sql, /WHERE id = \$1 AND versao = \$\d+ RETURNING/);
    assert.equal(com.chamadas[0].params.at(-1), 4);
    await assert.rejects(repo.atualizar(executorFalso([LINHA]), 7, { cnpj: '1' }, { versaoEsperada: 4 }), TypeError);
  });
});
