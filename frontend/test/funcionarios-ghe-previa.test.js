'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const F = require('../js/funcionarios');

/**
 * 12K-E — resolução do Nome GHE na prévia e seleção explícita do GHE pelo SST. Módulo puro (sem navegador):
 * `F.ghe.resolver`, `F.planilha.interpretar(linhas, { ghes })`, `F.ghe.selecionar`, `F.lotes.montar` e `F.render.previa`.
 * Dados sintéticos.
 */

const OFICIAL = ['Nome', 'Setor', 'Cargo', 'Dt.Admissão', 'CPF', 'Situação', 'Nome GHE'];
const CPFS = ['52998224725', '11144477735', '39053344705', '16899535009'];
const pessoa = (n, extra = {}) => ({ Nome: `Pessoa ${n}`, Setor: 'Produção', Cargo: 'Operador', 'Dt.Admissão': '01/02/2020', CPF: CPFS[n], Situação: 'Ativo', 'Nome GHE': 'LAMINAÇÃO (SPINNER BLOCK)', ...extra });
const matriz = (...registros) => [OFICIAL, ...registros.map((r) => OFICIAL.map((c) => r[c]))];

// GHEs da empresa; o primeiro tem quebra de linha e espaços repetidos no próprio nome cadastrado.
const GHES = [
  { id: 11, nome: 'LAMINAÇÃO\r\n(SPINNER BLOCK)', ativo: true },
  { id: 12, nome: 'ALMOXARIFADO  -  INFLAMAVEL', ativo: true },
  { id: 13, nome: 'AMBIGUO X', ativo: true },
  { id: 14, nome: 'AMBIGUO  X', ativo: true },
  { id: 15, nome: 'GHE ANTIGO', ativo: false },
  { id: 16, nome: 'Gasosos liquefeitos / Inflamáveis (Armazenamento)', ativo: true },
];
// Falha clara (e não TypeError) enquanto a API nova não existe.
beforeEach(() => {
  assert.equal(typeof (F.ghe && F.ghe.resolver), 'function', 'F.ghe.resolver ainda não existe');
  assert.equal(typeof (F.ghe && F.ghe.selecionar), 'function', 'F.ghe.selecionar ainda não existe');
});

const erroGhe = (l) => l.erros.filter((e) => e.campo === 'ghe').map((e) => e.mensagem);

describe('12K-E — F.ghe.resolver', () => {
  test('correspondência única após normalizar espaço, tab, CR e LF; devolve o GHE canônico', () => {
    for (const entrada of ['LAMINAÇÃO (SPINNER BLOCK)', 'LAMINAÇÃO\n(SPINNER BLOCK)', 'LAMINAÇÃO\r\n(SPINNER BLOCK)', 'LAMINAÇÃO\r(SPINNER BLOCK)', 'LAMINAÇÃO\t(SPINNER BLOCK)', '  LAMINAÇÃO   (SPINNER   BLOCK) ']) {
      const r = F.ghe.resolver(entrada, GHES);
      assert.equal(r.estado, 'ENCONTRADO', JSON.stringify(entrada));
      assert.equal(r.ghe.id, 11);
    }
    assert.equal(F.ghe.resolver('ALMOXARIFADO - INFLAMAVEL', GHES).ghe.id, 12);
  });

  test('não altera maiúsculas, acentos nem pontuação', () => {
    assert.equal(F.ghe.resolver('laminação (spinner block)', GHES).estado, 'INEXISTENTE');
    assert.equal(F.ghe.resolver('LAMINACAO (SPINNER BLOCK)', GHES).estado, 'INEXISTENTE');
    assert.equal(F.ghe.resolver('LAMINAÇÃO [SPINNER BLOCK]', GHES).estado, 'INEXISTENTE');
  });

  test('classifica: não informado, inválido, inexistente, ambíguo e inativo — sem escolher nenhum', () => {
    assert.equal(F.ghe.resolver('', GHES).estado, 'NAO_INFORMADO');
    assert.equal(F.ghe.resolver('   \r\n\t ', GHES).estado, 'NAO_INFORMADO');
    assert.equal(F.ghe.resolver(null, GHES).estado, 'NAO_INFORMADO');
    assert.equal(F.ghe.resolver('GHE\u0007', GHES).estado, 'INVALIDO');
    assert.equal(F.ghe.resolver('GHE\u0001 X', GHES).estado, 'INVALIDO');
    assert.equal(F.ghe.resolver('NAO EXISTE', GHES).estado, 'INEXISTENTE');
    const ambiguo = F.ghe.resolver('AMBIGUO X', GHES);
    assert.equal(ambiguo.estado, 'AMBIGUO');
    assert.equal(ambiguo.ghe, undefined, 'nenhum GHE é escolhido');
    assert.equal(F.ghe.resolver('GHE ANTIGO', GHES).estado, 'INATIVO');
  });
});

describe('12K-E — prévia com GHEs da empresa', () => {
  test('correspondência única resolve sozinha: sem erro, nome canônico e id do GHE real', () => {
    const r = F.planilha.interpretar(matriz(pessoa(0, { 'Nome GHE': 'LAMINAÇÃO\r\n(SPINNER BLOCK)' })), { ghes: GHES });
    const l = r.linhas[0];
    assert.deepEqual(l.erros, []);
    assert.equal(l.dados.gheId, 11);
    assert.equal(l.dados.ghe, 'LAMINAÇÃO (SPINNER BLOCK)');
    assert.equal(l.gheResolucao.selecionavel, false);
  });

  test('cada problema de GHE tem a sua mensagem e é selecionável, exceto caractere de controle', () => {
    const r = F.planilha.interpretar(matriz(
      pessoa(0, { 'Nome GHE': '' }), pessoa(1, { 'Nome GHE': 'NAO EXISTE' }), pessoa(2, { 'Nome GHE': 'AMBIGUO X' }), pessoa(3, { 'Nome GHE': 'GHE\u0007' }),
    ), { ghes: GHES });
    assert.deepEqual(r.linhas.map(erroGhe), [['Nome GHE não informado.'], ['GHE não encontrado.'], ['GHE ambíguo.'], ['Nome GHE com caractere inválido.']]);
    assert.deepEqual(r.linhas.map((l) => l.gheResolucao.selecionavel), [true, true, true, false]);
    assert.deepEqual(r.linhas.map((l) => l.gheResolucao.estado), ['NAO_INFORMADO', 'INEXISTENTE', 'AMBIGUO', 'INVALIDO']);
    assert.deepEqual([r.validas, r.comErro], [0, 4]);
  });

  test('GHE inativo é erro e não é selecionável como destino; nenhum GHE é escolhido automaticamente', () => {
    const r = F.planilha.interpretar(matriz(pessoa(0, { 'Nome GHE': 'GHE ANTIGO' })), { ghes: GHES });
    assert.deepEqual(erroGhe(r.linhas[0]), ['GHE inativo.']);
    assert.equal(r.linhas[0].dados.gheId, undefined);
    assert.equal(r.linhas[0].gheResolucao.selecionavel, true, 'o SST pode escolher outro GHE ativo');
  });

  test('sem a lista de GHEs (indisponível), só a validação local vale e o envio leva o nome', () => {
    const r = F.planilha.interpretar(matriz(pessoa(0), pessoa(1, { 'Nome GHE': '' })));
    assert.deepEqual(r.linhas.map(erroGhe), [[], ['Nome GHE não informado.']]);
    assert.equal(r.linhas[0].gheResolucao, undefined);
  });
});

describe('12K-E — F.ghe.selecionar', () => {
  const comProblemas = () => F.planilha.interpretar(matriz(
    pessoa(0, { 'Nome GHE': 'NAO EXISTE' }), pessoa(1, { 'Nome GHE': '', CPF: 'invalido' }), pessoa(2, { 'Nome GHE': 'AMBIGUO X' }),
  ), { ghes: GHES });

  test('a escolha explícita resolve só o problema do GHE e usa o GHE canônico selecionado', () => {
    const [naoEncontrado] = comProblemas().linhas;
    const l = F.ghe.selecionar(naoEncontrado, GHES[1]);
    assert.deepEqual(l.erros, []);
    assert.deepEqual([l.dados.gheId, l.dados.ghe], [12, 'ALMOXARIFADO - INFLAMAVEL']);
    assert.equal(l.gheSelecionado, true);
    assert.equal(l.exibicao.ghe, 'ALMOXARIFADO - INFLAMAVEL');
  });

  test('outro erro da mesma linha continua; a linha só fica apta quando todos forem resolvidos', () => {
    const [, vazioComCpfRuim] = comProblemas().linhas;
    const l = F.ghe.selecionar(vazioComCpfRuim, GHES[0]);
    assert.deepEqual(l.erros.map((e) => e.campo), ['cpf']);
    assert.equal(l.dados.gheId, 11);
  });

  test('ambíguo: o SST escolhe qual dos GHEs; o id escolhido é o que vai, sem ambiguidade', () => {
    const [, , ambiguo] = comProblemas().linhas;
    assert.equal(F.ghe.selecionar(ambiguo, GHES[3]).dados.gheId, 14);
    assert.equal(F.ghe.selecionar(ambiguo, GHES[2]).dados.gheId, 13);
  });

  test('recusa selecionar GHE inativo, linha sem problema de GHE ou caractere de controle', () => {
    const { linhas } = comProblemas();
    assert.throws(() => F.ghe.selecionar(linhas[0], GHES[4]), TypeError, 'inativo');
    const ok = F.planilha.interpretar(matriz(pessoa(0)), { ghes: GHES }).linhas[0];
    assert.throws(() => F.ghe.selecionar(ok, GHES[1]), TypeError, 'a linha já está resolvida');
    const controle = F.planilha.interpretar(matriz(pessoa(0, { 'Nome GHE': 'GHE\u0007' })), { ghes: GHES }).linhas[0];
    assert.throws(() => F.ghe.selecionar(controle, GHES[1]), TypeError, 'controle inválido não é selecionável');
  });

  test('a linha original não é mutada', () => {
    const [original] = comProblemas().linhas;
    const antes = JSON.stringify(original);
    F.ghe.selecionar(original, GHES[1]);
    assert.equal(JSON.stringify(original), antes);
  });
});

describe('12K-E — envio e prévia', () => {
  const meta = { importacaoId: 'a'.repeat(32), arquivo: { nome: 'x.csv', formato: 'csv', totalLinhas: 3 } };

  test('o envio leva gheId (resolvido ou escolhido); sem lista de GHEs leva o nome; linha com problema não vai', () => {
    const r = F.planilha.interpretar(matriz(pessoa(0), pessoa(1, { 'Nome GHE': 'NAO EXISTE' }), pessoa(2, { 'Nome GHE': '' })), { ghes: GHES });
    r.linhas[1] = F.ghe.selecionar(r.linhas[1], GHES[5]);
    const [lote] = F.lotes.montar(r.linhas, meta);
    assert.deepEqual(lote.linhas.map((l) => [l.linha, l.gheId, l.ghe]), [[2, 11, undefined], [3, 16, undefined]]);
    const semLista = F.planilha.interpretar(matriz(pessoa(0)));
    assert.deepEqual(F.lotes.montar(semLista.linhas, meta)[0].linhas.map((l) => [l.gheId, l.ghe]), [[undefined, 'LAMINAÇÃO (SPINNER BLOCK)']]);
  });

  test('a prévia oferece "Selecionar GHE" só nas linhas selecionáveis, com os GHEs ATIVOS escapados, sem pré-seleção', () => {
    const r = F.planilha.interpretar(matriz(pessoa(0), pessoa(1, { 'Nome GHE': 'NAO EXISTE' }), pessoa(2, { 'Nome GHE': 'GHE\u0007' })), { ghes: GHES });
    const ativos = GHES.filter((g) => g.ativo);
    const html = F.render.previa(r.linhas, ativos);
    assert.equal((html.match(/<select/g) || []).length, 1);
    assert.match(html, /<select[^>]*data-linha="3"/);
    assert.match(html, /<option value="">Selecionar GHE<\/option>/);
    assert.equal((html.match(/<option value="\d+"/g) || []).length, ativos.length);
    assert.doesNotMatch(html, /GHE ANTIGO/, 'inativo não é opção');
    assert.doesNotMatch(html, /selected/, 'nenhum GHE vem selecionado');
    const perigosa = F.render.previa(F.planilha.interpretar(matriz(pessoa(1, { 'Nome GHE': 'X' })), { ghes: GHES }).linhas, [{ id: 99, nome: '<img src=x onerror=alert(1)>', ativo: true }]);
    assert.doesNotMatch(perigosa, /<img/);
    assert.match(perigosa, /&lt;img/);
  });

  test('depois da escolha a linha mostra o GHE selecionado e fica válida', () => {
    const r = F.planilha.interpretar(matriz(pessoa(0, { 'Nome GHE': 'NAO EXISTE' })), { ghes: GHES });
    r.linhas[0] = F.ghe.selecionar(r.linhas[0], GHES[1]);
    const html = F.render.previa(r.linhas, GHES.filter((g) => g.ativo));
    assert.match(html, /ALMOXARIFADO - INFLAMAVEL/);
    assert.match(html, /import-row-ok/);
  });
});

describe('12K-E — relatório', () => {
  test('rótulos do servidor para GHE inexistente, ambíguo e inválido', () => {
    const r = F.planilha.interpretar(matriz(pessoa(0), pessoa(1), pessoa(2)));
    const enviado = { linhas: [
      { linha: 2, situacao: 'RECUSADO', codigo: 'FUNCIONARIO_GHE_INEXISTENTE', campos: ['ghe'] },
      { linha: 3, situacao: 'RECUSADO', codigo: 'FUNCIONARIO_GHE_AMBIGUO', campos: ['ghe'] },
      { linha: 4, situacao: 'RECUSADO', codigo: 'FUNCIONARIO_GHE_INVALIDO', campos: ['ghe'] },
    ] };
    assert.deepEqual(F.fluxo.consolidar(r.linhas, enviado).porMotivo, [['GHE não encontrado', 1], ['GHE ambíguo', 1], ['GHE inválido', 1]]);
  });
});
