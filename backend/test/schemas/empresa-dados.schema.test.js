'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schemas = require('../../src/schemas/empresa-dados.schema');
const painel = require('../../src/schemas/empresa-cadastro.schema');

const corpo = (extra = {}) => ({ versao: 1, ...extra });
const analisar = (valor) => schemas.alterar.body.safeParse(valor);

describe('Dados da Empresa — schema do PATCH', () => {
  test('aceita só a versão mais um campo editável e normaliza e-mail, UF e CEP', () => {
    const r = analisar(corpo({ telefone: '(11) 4000-1000', emailSst: ' SST@Empresa.com.br ', uf: 'sp', cep: '01310-100' }));
    assert.equal(r.success, true);
    assert.equal(r.data.versao, 1);
    assert.equal(r.data.emailSst, 'sst@empresa.com.br');
    assert.equal(r.data.uf, 'SP');
  });

  test('versão é obrigatória, inteira e positiva', () => {
    for (const invalido of [{}, { versao: 0 }, { versao: -1 }, { versao: 1.5 }, { versao: '1' }, { versao: null }]) {
      assert.equal(analisar({ telefone: '1', ...invalido }).success, false, JSON.stringify(invalido));
    }
  });

  test('razão social e CNPJ são recusados como campo não permitido (nenhuma permissão os libera)', () => {
    for (const chave of ['razaoSocial', 'cnpj', 'nome']) {
      const r = analisar(corpo({ [chave]: 'Outra Empresa Ltda' }));
      assert.equal(r.success, false, chave);
      assert.equal(r.error.issues.some((i) => i.code === 'unrecognized_keys'), true, chave);
    }
  });

  test('empresa, usuário, ativo, id e versão extra vindos do cliente são recusados', () => {
    for (const chave of ['empresaId', 'empresa_id', 'usuarioId', 'ativo', 'id', 'camposBloqueados', 'atualizadoEm']) {
      assert.equal(analisar(corpo({ [chave]: 1 })).success, false, chave);
    }
  });

  test('null limpa um campo opcional; o contrato aceita os e-mails de SST e Almoxarifado', () => {
    assert.equal(analisar(corpo({ emailSst: null, emailAlmoxarifado: null, complemento: null })).success, true);
  });

  test('valida formato e tamanho: e-mail, UF, CEP, situação da IE e textos acima do limite', () => {
    const invalidos = [
      { emailSst: 'sem-arroba' },
      { emailAlmoxarifado: 'a@b' },
      { uf: 'SPP' },
      { cep: '123' },
      { situacaoInscricaoEstadual: 'ISENTA' },
      { telefone: '1'.repeat(21) },
      { bairro: 'x'.repeat(101) },
      { endereco: 'x'.repeat(201) },
      { nomeFantasia: 'x'.repeat(151) },
    ];
    for (const invalido of invalidos) {
      assert.equal(analisar(corpo(invalido)).success, false, JSON.stringify(invalido));
    }
  });

  test('os campos editáveis são os do cadastro do Painel mais os dois e-mails novos; nenhum deles é razão social ou CNPJ', () => {
    assert.deepEqual([...schemas.CAMPOS_EDITAVEIS].sort(), [...painel.CAMPOS_OPCIONAIS, 'emailSst', 'emailAlmoxarifado'].sort());
    for (const proibido of ['razaoSocial', 'cnpj', 'nome', 'ativo', 'versao']) {
      assert.equal(schemas.CAMPOS_EDITAVEIS.includes(proibido), false, proibido);
    }
  });
});

describe('Painel — o PATCH cadastral EXIGE `versao` e continua sem aceitar CNPJ', () => {
  test('versão é obrigatória, inteira e positiva (sem ela não há comparação-e-troca); CNPJ continua recusado', () => {
    assert.equal(painel.alterar.body.safeParse({ telefone: '1' }).success, false, 'sem versão não pode passar: seria sobrescrita silenciosa');
    assert.equal(painel.alterar.body.safeParse({}).success, false);
    for (const invalido of [{ versao: 0 }, { versao: -1 }, { versao: 1.5 }, { versao: '3' }, { versao: null }]) {
      assert.equal(painel.alterar.body.safeParse({ telefone: '1', ...invalido }).success, false, JSON.stringify(invalido));
    }
    assert.equal(painel.alterar.body.safeParse({ telefone: '1', versao: 3 }).success, true);
    assert.equal(painel.alterar.body.safeParse({ versao: 3, razaoSocial: 'Outra Ltda' }).success, true, 'o Painel continua podendo editar a razão social');
    assert.equal(painel.alterar.body.safeParse({ telefone: '1', versao: 3, cnpj: '11222333000181' }).success, false);
  });

  test('a UI do Painel não ganha campos novos: os e-mails de SST e Almoxarifado não são aceitos por ele', () => {
    assert.equal(painel.alterar.body.safeParse({ emailSst: 'sst@empresa.com.br' }).success, false);
    assert.equal(painel.criar.body.safeParse({ razaoSocial: 'X', cnpj: '11222333000181', emailAlmoxarifado: 'a@empresa.com.br' }).success, false);
  });
});
