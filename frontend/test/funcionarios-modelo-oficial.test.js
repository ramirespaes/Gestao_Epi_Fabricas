'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const F = require('../js/funcionarios');

/**
 * 12K-E — modelo oficial da planilha de funcionários. Obrigatórios: Nome, Setor, Cargo, Dt.Admissão,
 * CPF, Situação, Nome GHE. Opcionais: Matrícula, Telefone, Nascimento. Dados sintéticos.
 */

const OFICIAL = ['Nome', 'Setor', 'Cargo', 'Dt.Admissão', 'CPF', 'Situação', 'Nome GHE'];
const CPF_A = '52998224725';
const CPF_B = '11144477735';
const pessoa = (extra = {}) => ({ Nome: 'Pessoa Teste', Setor: 'Produção', Cargo: 'Operador', 'Dt.Admissão': '01/02/2020', CPF: CPF_A, Situação: 'Ativo', 'Nome GHE': 'GHE Teste', ...extra });
const matriz = (cabecalho, ...registros) => [cabecalho, ...registros.map((r) => cabecalho.map((c) => (c in r ? r[c] : '')))];
const interpretar = (cabecalho, ...registros) => {
  const r = F.planilha.interpretar(matriz(cabecalho, ...registros));
  assert.equal(r.ok, true, `planilha recusada: ${r.codigo} ${(r.colunas || []).join(', ')}`);
  return r;
};
const mensagens = (l) => l.erros.map((e) => e.mensagem);

describe('12K-E — layout oficial', () => {
  test('os sete campos oficiais formam uma linha válida, sem Telefone, Matrícula nem Nascimento', () => {
    const r = interpretar(OFICIAL, pessoa());
    assert.equal(r.ok, true);
    assert.deepEqual(mensagens(r.linhas[0]), []);
    assert.equal(r.linhas[0].dados.dataAdmissao, '2020-02-01');
    assert.equal(r.linhas[0].dados.ghe, 'GHE Teste');
    assert.equal(r.validas, 1);
  });

  test('o modelo para download é o layout oficial, com Matrícula opcional e sem Telefone nem Nascimento', () => {
    assert.equal(F.planilha.modeloCsv(), '﻿Nome;Setor;Cargo;Dt.Admissão;CPF;Matrícula;Situação;Nome GHE\r\n');
  });

  test('título na linha 1, linha 2 vazia e cabeçalho na linha 3: dados na linha 4 com a numeração da planilha', () => {
    const linhas = [
      ['Listagem de Funcionários', '', '', '', '', '', ''],
      ['', '', '', '', '', '', ''],
      OFICIAL,
      OFICIAL.map((c) => pessoa()[c]),
    ];
    const r = F.planilha.interpretar(linhas);
    assert.equal(r.ok, true);
    assert.equal(r.linhas.length, 1);
    assert.equal(r.linhas[0].linha, 4);
    assert.equal(r.validas, 1);
  });

  test('linhas totalmente vazias depois dos dados continuam ignoradas', () => {
    const r = F.planilha.interpretar([...matriz(OFICIAL, pessoa()), ['', '', '', '', '', '', ''], [null, null, null, null, null, null, null]]);
    assert.equal(r.ok, true, `planilha recusada: ${r.codigo}`);
    assert.equal(r.linhas.length, 1);
  });

  test('aliases: Dt. Admissão, Dt Admissão e Nome GHE com caixa e espaços diferentes', () => {
    for (const adm of ['Dt. Admissão', 'dt.admissão', 'DT ADMISSÃO', 'Dt.Admissao']) {
      const cab = ['Nome', 'Setor', 'Cargo', adm, 'CPF', 'Situacao', '  nome   ghe '];
      const r = interpretar(cab, pessoa({ [adm]: '01/02/2020', Situacao: 'Ativo', '  nome   ghe ': 'GHE Teste' }));
      assert.equal(r.ok, true, adm);
      assert.deepEqual(mensagens(r.linhas[0]), [], adm);
    }
  });

  test('colunas obrigatórias ausentes são nomeadas pelo rótulo oficial; Matrícula ausente não é coluna ausente', () => {
    const r = F.planilha.interpretar([['Nome', 'Setor', 'CPF'], ['a', 'b', CPF_A]]);
    assert.deepEqual(r, { ok: false, codigo: 'COLUNAS_AUSENTES', colunas: ['Cargo', 'Dt.Admissão', 'Situação', 'Nome GHE'] });
    assert.deepEqual(F.planilha.OBRIGATORIAS.map((o) => o[1]), OFICIAL);
  });
});

describe('12K-E — campos opcionais', () => {
  test('Matrícula, Telefone e Nascimento: colunas ausentes não geram erro', () => {
    const r = interpretar(OFICIAL, pessoa());
    assert.deepEqual(mensagens(r.linhas[0]), []);
    assert.equal(r.linhas[0].dados.matricula === '' || r.linhas[0].dados.matricula == null, true);
    assert.equal(r.linhas[0].dados.telefone, null);
    assert.equal(r.linhas[0].dados.dataNascimento, null);
  });

  test('coluna Matrícula presente e vazia: sem erro e nenhuma matrícula é enviada', () => {
    const cab = [...OFICIAL, 'Matrícula'];
    const r = interpretar(cab, pessoa({ Matrícula: '' }));
    assert.deepEqual(mensagens(r.linhas[0]), []);
    const [lote] = F.lotes.montar(r.linhas, { importacaoId: 'a'.repeat(32), arquivo: { nome: 'x.csv', formato: 'csv', totalLinhas: 1 } });
    assert.equal(lote.linhas[0].matricula == null, true);
    assert.equal('matricula' in JSON.parse(JSON.stringify(lote)).linhas[0], false, 'a chave matrícula nem vai no corpo');
  });

  test('coluna Matrícula preenchida é validada e enviada', () => {
    const cab = [...OFICIAL, 'Matrícula'];
    const ok = interpretar(cab, pessoa({ Matrícula: 'M-123' }));
    assert.deepEqual(mensagens(ok.linhas[0]), []);
    const [lote] = F.lotes.montar(ok.linhas, { importacaoId: 'a'.repeat(32), arquivo: { nome: 'x.csv', formato: 'csv', totalLinhas: 1 } });
    assert.equal(lote.linhas[0].matricula, 'M-123');
    const longa = interpretar(cab, pessoa({ Matrícula: 'M'.repeat(31) }));
    assert.equal(longa.linhas[0].erros.some((e) => e.campo === 'matricula'), true);
  });

  test('Telefone: coluna ausente ou vazia não bloqueia; preenchido é validado e enviado para ser salvo', () => {
    const cab = [...OFICIAL, 'Telefone'];
    const vazio = interpretar(cab, pessoa({ Telefone: '' }));
    assert.deepEqual(mensagens(vazio.linhas[0]), []);
    const cheio = interpretar(cab, pessoa({ Telefone: '(47) 99999-0001' }));
    assert.deepEqual(mensagens(cheio.linhas[0]), []);
    const [lote] = F.lotes.montar(cheio.linhas, { importacaoId: 'a'.repeat(32), arquivo: { nome: 'x.csv', formato: 'csv', totalLinhas: 1 } });
    assert.equal(lote.linhas[0].telefone, '(47) 99999-0001');
    assert.equal(interpretar(cab, pessoa({ Telefone: '1'.repeat(21) })).linhas[0].erros.some((e) => e.campo === 'telefone'), true);
  });

  test('matrícula repetida na planilha continua apontando a primeira ocorrência', () => {
    const r = interpretar([...OFICIAL, 'Matrícula'], pessoa({ Matrícula: 'M1' }), pessoa({ CPF: CPF_B, Matrícula: 'M1' }));
    assert.equal(r.linhas[1].erros.some((e) => e.campo === 'matricula' && /repetida/.test(e.mensagem)), true);
  });

  test('duas linhas sem matrícula não são tratadas como repetidas', () => {
    const r = interpretar(OFICIAL, pessoa(), pessoa({ CPF: CPF_B }));
    assert.equal(r.validas, 2);
  });
});

describe('12K-E — erros por campo, todos de uma vez', () => {
  test('cada obrigatório vazio gera a sua mensagem', () => {
    const casos = [
      ['Nome', 'Nome não informado.'], ['Setor', 'Setor não informado.'], ['Cargo', 'Cargo não informado.'],
      ['Dt.Admissão', 'Data de admissão não informada.'], ['CPF', 'CPF não informado.'],
      ['Situação', 'Situação não informada.'], ['Nome GHE', 'Nome GHE não informado.'],
    ];
    for (const [campo, msg] of casos) {
      const r = interpretar(OFICIAL, pessoa({ [campo]: '' }));
      assert.deepEqual(mensagens(r.linhas[0]), [msg], campo);
      assert.equal(r.validas, 0, campo);
    }
  });

  test('todos os problemas da mesma linha aparecem juntos', () => {
    const r = interpretar([...OFICIAL, 'Observação'], { Observação: 'x' });
    assert.deepEqual([...mensagens(r.linhas[0])].sort(), [
      'Nome não informado.', 'Setor não informado.', 'Cargo não informado.', 'Nome GHE não informado.', 'Situação não informada.',
      'CPF não informado.', 'Data de admissão não informada.',
    ].sort());
    assert.equal(r.linhas[0].erros.length, 7);
  });

  test('CPF e data inválidos', () => {
    const r = interpretar(OFICIAL, pessoa({ CPF: '12345678900', 'Dt.Admissão': '31/02/2020' }));
    assert.deepEqual(mensagens(r.linhas[0]).sort(), ['CPF inválido.', 'Data de admissão inválida (use DD/MM/AAAA).'].sort());
  });
});

describe('12K-E — Nome GHE com quebra de linha', () => {
  test('quebra de linha (CRLF, LF) e espaços repetidos dentro do nome são aceitos e normalizados; vazio continua erro', () => {
    const casos = [
      ['LAMINAÇÃO\r\n(CATERPILLAR-FRESA)', 'LAMINAÇÃO (CATERPILLAR-FRESA)'],
      ['LAMINAÇÃO\n(SPINNER BLOCK)', 'LAMINAÇÃO (SPINNER BLOCK)'],
      ['LAMINAÇÃO\r(SPINNER BLOCK)', 'LAMINAÇÃO (SPINNER BLOCK)'],
      ['LAMINAÇÃO\t(SPINNER BLOCK)', 'LAMINAÇÃO (SPINNER BLOCK)'],
      ['LAMINAÇÃO \r\n  \n (SPINNER BLOCK)', 'LAMINAÇÃO (SPINNER BLOCK)'],
      ['  ALMOXARIFADO   -  INFLAMAVEL ', 'ALMOXARIFADO - INFLAMAVEL'],
      ['Gasosos liquefeitos / Inflamáveis (Armazenamento)', 'Gasosos liquefeitos / Inflamáveis (Armazenamento)'],
    ];
    for (const [entrada, esperado] of casos) {
      const r = interpretar(OFICIAL, pessoa({ 'Nome GHE': entrada }));
      assert.deepEqual(mensagens(r.linhas[0]), [], JSON.stringify(entrada));
      assert.equal(r.linhas[0].dados.ghe, esperado, JSON.stringify(entrada));
    }
    for (const vazio of ['', '   ', ' \r\n ']) {
      assert.deepEqual(mensagens(interpretar(OFICIAL, pessoa({ 'Nome GHE': vazio })).linhas[0]), ['Nome GHE não informado.'], JSON.stringify(vazio));
    }
  });

  test('a normalização do navegador é a mesma do servidor (mesma tabela de casos)', () => {
    const servidor = require('../../backend/src/utils/normalizacao').normalizarNomeGhe; // eslint-disable-line global-require
    assert.equal(typeof F.utilitarios.normalizarNomeGhe, 'function');
    for (const caso of ['A B', ' A  B ', 'A\nB', 'A\r\nB', 'A\rB', 'A\tB', 'A \r\n \t B', '\r\nA\r\n', 'Á  É', 'A B', 'a  B', '']) {
      assert.equal(F.utilitarios.normalizarNomeGhe(caso), servidor(caso), JSON.stringify(caso));
    }
  });

  test('o que não é quebra de linha continua inválido: caractere de controle, acima de 150 caracteres', () => {
    assert.equal(interpretar(OFICIAL, pessoa({ 'Nome GHE': 'GHE\u0007' })).linhas[0].erros.some((e) => e.campo === 'ghe'), true);
    assert.equal(interpretar(OFICIAL, pessoa({ 'Nome GHE': 'G'.repeat(151) })).linhas[0].erros.some((e) => e.campo === 'ghe'), true);
  });

  test('a prévia mostra o nome em uma linha e o envio leva o nome normalizado', () => {
    const r = interpretar(OFICIAL, pessoa({ 'Nome GHE': 'LAMINAÇÃO\r\n(SPINNER BLOCK)' }));
    assert.match(F.render.previa(r.linhas), /LAMINAÇÃO \(SPINNER BLOCK\)/);
    const [lote] = F.lotes.montar(r.linhas, { importacaoId: 'a'.repeat(32), arquivo: { nome: 'x.csv', formato: 'csv', totalLinhas: 1 } });
    assert.equal(lote.linhas[0].ghe, 'LAMINAÇÃO (SPINNER BLOCK)');
  });

  test('o relatório rotula GHE inexistente como "GHE não encontrado" e ambíguo como "GHE ambíguo"', () => {
    const r = interpretar(OFICIAL, pessoa(), pessoa({ CPF: CPF_B }));
    const enviado = { linhas: [
      { linha: 2, situacao: 'RECUSADO', codigo: 'FUNCIONARIO_GHE_INEXISTENTE', campos: ['ghe'] },
      { linha: 3, situacao: 'RECUSADO', codigo: 'FUNCIONARIO_GHE_AMBIGUO', campos: ['ghe'] },
    ] };
    const c = F.fluxo.consolidar(r.linhas, enviado);
    assert.deepEqual(c.porMotivo, [['GHE não encontrado', 1], ['GHE ambíguo', 1]]);
  });
});

describe('12K-E — Situação', () => {
  test('"Ativo" com qualquer caixa e espaços externos é aceito', () => {
    for (const s of ['Ativo', 'ATIVO', 'ativo', '  Ativo  ', ' aTiVo']) {
      const r = interpretar(OFICIAL, pessoa({ Situação: s }));
      assert.deepEqual(mensagens(r.linhas[0]), [], JSON.stringify(s));
    }
  });

  test('ausente, vazia ou só espaços: "Situação não informada."', () => {
    for (const s of ['', '   ']) {
      const r = interpretar(OFICIAL, pessoa({ Situação: s }));
      assert.deepEqual(mensagens(r.linhas[0]), ['Situação não informada.'], JSON.stringify(s));
    }
  });

  test('qualquer outro valor: "Situação não reconhecida", sem conversão silenciosa', () => {
    for (const s of ['Inativo', 'Afastado', 'Férias', 'Ativa', 'Ativo?']) {
      const r = interpretar(OFICIAL, pessoa({ Situação: s }));
      assert.equal(r.validas, 0, s);
      assert.equal(r.linhas[0].erros.length, 1, s);
      assert.match(r.linhas[0].erros[0].mensagem, /^Situação não reconhecida/, s);
    }
  });

  test('a linha aceita envia situação "ativo" ao servidor', () => {
    const r = interpretar(OFICIAL, pessoa({ Situação: ' ATIVO ' }));
    const [lote] = F.lotes.montar(r.linhas, { importacaoId: 'a'.repeat(32), arquivo: { nome: 'x.csv', formato: 'csv', totalLinhas: 1 } });
    assert.equal(lote.linhas[0].situacao, 'ativo');
  });
});

describe('12K-E — tela', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'import-employees.html'), 'utf8');

  test('a prévia mostra Setor, CPF, Admissão, Cargo, Nome GHE e Situação, sem Telefone, Matrícula nem Nascimento', () => {
    const cabecalho = /<thead>([\s\S]*?)<\/thead>/.exec(html)[1];
    const colunas = [...cabecalho.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(colunas, ['#', 'Nome', 'Setor', 'CPF', 'Admissão', 'Cargo', 'Nome GHE', 'Situação', 'Status']);
    const r = interpretar(OFICIAL, pessoa());
    const linhaHtml = F.render.previa(r.linhas);
    assert.equal((linhaHtml.match(/<td/g) || []).length, colunas.length);
    assert.equal(/\bnull\b|undefined/.test(linhaHtml), false);
  });

  test('o texto do modelo cita o layout oficial', () => {
    assert.match(html, /Nome, Setor, Cargo, Dt\.Admissão, CPF, Situação e Nome GHE/);
  });
});
