'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Incremento 5A (RED): núcleo PURO da importação GHE / EPI (src/utils/ghe-importacao.js). Sem banco, sem HTTP.
 *
 * Entrada de `analisarLote({ linhas, ghes, tipos, vinculos })`:
 *   linhas   [{ ghe, descricao, epi, classificacao, linha? }]  texto como veio da planilha; `linha` = número na planilha
 *            (padrão: posição + 2, o cabeçalho é a linha 1);
 *   ghes     [{ id, codigo|null, nome, ativo }]                GHEs da empresa (nome = a "Descrição");
 *   tipos    [{ id, nome, ativo }]                             catálogo tipos_material da empresa;
 *   vinculos [{ gheId, tipoId, classificacao }]                ghe_tipos_material da empresa.
 *
 * Saída: { resumo, ghes, linhas } — uma entrada por linha NÃO vazia (linha totalmente vazia só entra em
 * resumo.linhasIgnoradas). Cada linha: { linha, ghe, descricao, epi, classificacao, situacaoGhe, gheId, gheInativo,
 * tipoMaterialId, tipoInativo, situacao, motivo, duplicadaDe, aplicavel, problemas:[{campo,codigo}] }.
 *   situacaoGhe: GHE_NOVO | GHE_EXISTENTE | LEGADO_RECEBERA_CODIGO | CONFLITO_GHE | AMBIGUO | null (linha inválida)
 *   situacao (vínculo): NOVO_VINCULO | VINCULO_EXISTENTE | CLASSIFICACAO_ALTERADA | EPI_NAO_ENCONTRADO | EPI_AMBIGUO |
 *     EPI_INATIVO | GHE_INATIVO | CONFLITO_GHE | GHE_AMBIGUO | DUPLICADA_NO_ARQUIVO | CONFLITO_NO_ARQUIVO | LINHA_INVALIDA
 *   motivo (conflitos de GHE): CODIGO_COM_DESCRICAO_DIFERENTE | DESCRICAO_COM_OUTRO_CODIGO |
 *     DESCRICAO_DIVERGENTE_NO_ARQUIVO | DESCRICAO_REPETIDA_NO_ARQUIVO
 *   aplicavel = a linha geraria uma escrita no 5C (NOVO_VINCULO ou CLASSIFICACAO_ALTERADA). Nada é gravado aqui.
 * `ghes` da saída: um por código válido do arquivo { codigo, descricao, situacao, gheId, ativo, operacao, linhas:[n] },
 *   operacao = 'CRIAR' | 'ATRIBUIR_CODIGO' | null — só há operação de GHE quando ele tem ao menos uma linha aplicável.
 * `resumo`: { linhasRecebidas, linhasIgnoradas, aplicaveis, porSituacao:{...}, ghes:{ <situacaoGhe>: n } }.
 *
 * Normalizações: código = utils/codigo-ghe (GHE- + 3 a 6 dígitos); descrição e EPI = aparar, colapsar espaços,
 * comparar sem diferenciar maiúsculas nem acentos, PONTUAÇÃO PRESERVADA, SEM aproximação; classificação = só os dois
 * rótulos conhecidos. Duplicata idêntica no arquivo não gera segunda operação; classificações diferentes para o mesmo
 * GHE + EPI no arquivo são conflito (nenhuma "última linha vence"). Ausência de GHE ou vínculo na planilha não remove nada.
 */

const nucleo = () => exigirModulo('src/utils/ghe-importacao');

const T = {
  capacete: { id: 1, nome: 'Capacete', ativo: true },
  luva: { id: 2, nome: 'Luva de Raspa', ativo: true },
  protetor: { id: 3, nome: 'Protetor Auricular', ativo: true },
  oculos: { id: 4, nome: 'Óculos de Proteção - Incolor', ativo: true },
  botaVelha: { id: 5, nome: 'Bota Antiga', ativo: false },
};
const TIPOS = Object.values(T);
const g = (id, codigo, nome, ativo = true) => ({ id, codigo, nome, ativo });
const v = (gheId, tipoId, classificacao) => ({ gheId, tipoId, classificacao });
const l = (ghe, descricao, epi, classificacao, linha) => ({ ghe, descricao, epi, classificacao, ...(linha === undefined ? {} : { linha }) });

function congelar(o) {
  if (o !== null && typeof o === 'object') { Object.values(o).forEach(congelar); Object.freeze(o); }
  return o;
}
const analisar = (linhas, base = {}) => nucleo().analisarLote(congelar({ linhas, ghes: [], tipos: TIPOS, vinculos: [], ...base }));
const so = (linhas, base) => analisar(linhas, base).linhas[0];

describe('normalização de texto, EPI e classificação', () => {
  test('chave canônica: aparar, colapsar espaços, sem maiúsculas nem acentos; pontuação preservada; sem aproximação', () => {
    const { chaveCanonica } = nucleo();
    assert.equal(chaveCanonica('  ÓCULOS   de\tProteção - Incolor '), 'oculos de protecao - incolor');
    assert.equal(chaveCanonica('Óculos de Proteção - Incolor'), chaveCanonica('oculos de protecao - incolor'));
    assert.notEqual(chaveCanonica('Luva de Raspa.'), chaveCanonica('Luva de Raspa'));
    assert.notEqual(chaveCanonica('Luva-de-Raspa'), chaveCanonica('Luva de Raspa'));
    assert.notEqual(chaveCanonica('Capacetes'), chaveCanonica('Capacete'));
    for (const v_ of [null, undefined, 3, {}, []]) assert.equal(chaveCanonica(v_), null);
  });

  test('classificação: só os dois rótulos conhecidos, com ou sem acento, caixa e espaços externos', () => {
    const { normalizarClassificacao } = nucleo();
    for (const entrada of ['OBRIGATÓRIO', 'Obrigatório', ' obrigatorio ', 'OBRIGATORIO']) assert.equal(normalizarClassificacao(entrada), 'OBRIGATORIO', entrada);
    for (const entrada of ['NÃO OBRIGATÓRIO', 'Não obrigatório', 'nao obrigatorio', '  NAO   OBRIGATORIO ', 'NAO_OBRIGATORIO']) assert.equal(normalizarClassificacao(entrada), 'NAO_OBRIGATORIO', entrada);
    for (const entrada of ['', '   ', 'OPCIONAL', 'SIM', 'OBRIGATORIA', 'OBRIG.', 'NÃO-OBRIGATÓRIO', 'NAOOBRIGATORIO', 'obrigatório?', null, undefined, 1, true]) {
      assert.equal(nucleo().normalizarClassificacao(entrada), null, String(entrada));
    }
  });
});

describe('linha a linha: campos e linhas vazias', () => {
  test('código aparado e em maiúsculas; descrição e EPI limpos; classificação normalizada; número da linha = posição + 2', () => {
    const r = analisar([l(' ghe-003 ', '  Soldagem   Mecânica ', ' capacete ', ' não obrigatório ')]);
    assert.deepEqual(
      [r.linhas[0].linha, r.linhas[0].ghe, r.linhas[0].descricao, r.linhas[0].epi, r.linhas[0].classificacao, r.linhas[0].problemas],
      [2, 'GHE-003', 'Soldagem Mecânica', 'capacete', 'NAO_OBRIGATORIO', []],
    );
    assert.equal(analisar([l('GHE-001', 'A', 'Capacete', 'Obrigatório', 57)]).linhas[0].linha, 57, 'o número informado pelo cliente é respeitado');
  });

  test('linha totalmente vazia é ignorada (e contada); linha parcialmente preenchida é inválida, com o motivo por campo', () => {
    const r = analisar([l('', '  ', null, undefined), l('GHE-001', 'Soldagem', '', 'talvez'), l(undefined, 'Só descrição', undefined, undefined)]);
    assert.equal(r.resumo.linhasRecebidas, 3);
    assert.equal(r.resumo.linhasIgnoradas, 1);
    assert.equal(r.linhas.length, 2);
    assert.deepEqual(r.linhas[0].problemas, [{ campo: 'epi', codigo: 'EPI_OBRIGATORIO' }, { campo: 'classificacao', codigo: 'CLASSIFICACAO_INVALIDA' }]);
    assert.deepEqual(r.linhas[1].problemas, [
      { campo: 'ghe', codigo: 'GHE_CODIGO_OBRIGATORIO' }, { campo: 'epi', codigo: 'EPI_OBRIGATORIO' }, { campo: 'classificacao', codigo: 'CLASSIFICACAO_OBRIGATORIA' },
    ]);
    for (const linha of r.linhas) {
      assert.deepEqual([linha.situacao, linha.situacaoGhe, linha.aplicavel], ['LINHA_INVALIDA', null, false]);
    }
    assert.deepEqual([r.linhas[0].linha, r.linhas[1].linha], [3, 4]);
  });

  test('código fora do formato, descrição longa ou com controle: linha inválida, nada resolvido', () => {
    for (const codigo of ['GHE-01', 'GHE-1234567', 'ABC-001', 'GHE 001', 'GHE-00１']) {
      const linha = so([l(codigo, 'Soldagem', 'Capacete', 'Obrigatório')]);
      assert.deepEqual([linha.situacao, linha.problemas], ['LINHA_INVALIDA', [{ campo: 'ghe', codigo: 'GHE_CODIGO_INVALIDO' }]], codigo);
    }
    assert.deepEqual(so([l('GHE-001', 'x'.repeat(151), 'Capacete', 'Obrigatório')]).problemas, [{ campo: 'descricao', codigo: 'DESCRICAO_INVALIDA' }]);
    assert.deepEqual(so([l('GHE-001', 'Sold\u0000agem', 'Capacete', 'Obrigatório')]).problemas, [{ campo: 'descricao', codigo: 'DESCRICAO_INVALIDA' }]);
    assert.equal(so([l('GHE-001', 'x'.repeat(150), 'Capacete', 'Obrigatório')]).situacao, 'NOVO_VINCULO', '150 caracteres é o teto da descrição');
  });
});

describe('resolução do GHE', () => {
  test('GHE novo: código e descrição inexistentes → GHE_NOVO + NOVO_VINCULO, aplicável', () => {
    const r = analisar([l('GHE-020', 'Montagem Nova', 'Capacete', 'Obrigatório')]);
    assert.deepEqual(
      [r.linhas[0].situacaoGhe, r.linhas[0].gheId, r.linhas[0].tipoMaterialId, r.linhas[0].situacao, r.linhas[0].aplicavel],
      ['GHE_NOVO', null, T.capacete.id, 'NOVO_VINCULO', true],
    );
    assert.deepEqual(r.ghes, [{ codigo: 'GHE-020', descricao: 'Montagem Nova', situacao: 'GHE_NOVO', gheId: null, ativo: null, operacao: 'CRIAR', linhas: [2] }]);
  });

  test('GHE existente: mesmo código e descrição compatível (caixa, acento e espaços) → GHE_EXISTENTE; sem operação de GHE', () => {
    const ghes = [g(10, 'GHE-001', 'Soldagem Mecânica')];
    const r = analisar([l('ghe-001', ' SOLDAGEM   mecanica', 'Capacete', 'Obrigatório')], { ghes });
    assert.deepEqual([r.linhas[0].situacaoGhe, r.linhas[0].gheId, r.linhas[0].situacao], ['GHE_EXISTENTE', 10, 'NOVO_VINCULO']);
    assert.equal(r.ghes[0].operacao, null);
  });

  test('vínculo do GHE existente: igual → VINCULO_EXISTENTE (sem escrita); classificação diferente → CLASSIFICACAO_ALTERADA (aplicável)', () => {
    const ghes = [g(10, 'GHE-001', 'Soldagem')];
    const vinculos = [v(10, T.capacete.id, 'OBRIGATORIO'), v(10, T.luva.id, 'OBRIGATORIO')];
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório'),
      l('GHE-001', 'Soldagem', 'Luva de Raspa', 'Não obrigatório'),
      l('GHE-001', 'Soldagem', 'Protetor Auricular', 'Obrigatório'),
    ], { ghes, vinculos });
    assert.deepEqual(r.linhas.map((x) => [x.situacao, x.aplicavel]), [['VINCULO_EXISTENTE', false], ['CLASSIFICACAO_ALTERADA', true], ['NOVO_VINCULO', true]]);
    assert.equal(r.resumo.aplicaveis, 2);
  });

  test('legado sem código com descrição canônica única → LEGADO_RECEBERA_CODIGO (operação ATRIBUIR_CODIGO)', () => {
    const ghes = [g(7, null, 'Pintura Industrial'), g(8, 'GHE-002', 'Outro')];
    const r = analisar([l('GHE-010', 'pintura  INDUSTRIAL', 'Capacete', 'Obrigatório')], { ghes });
    assert.deepEqual([r.linhas[0].situacaoGhe, r.linhas[0].gheId, r.linhas[0].situacao, r.linhas[0].aplicavel], ['LEGADO_RECEBERA_CODIGO', 7, 'NOVO_VINCULO', true]);
    assert.equal(r.ghes[0].operacao, 'ATRIBUIR_CODIGO');
    assert.equal(r.resumo.ghes.LEGADO_RECEBERA_CODIGO, 1);
  });

  test('o legado que já tem o vínculo continua com o código a atribuir, mas a linha não escreve vínculo', () => {
    const r = analisar([l('GHE-010', 'Pintura', 'Capacete', 'Obrigatório')], { ghes: [g(7, null, 'Pintura')], vinculos: [v(7, T.capacete.id, 'OBRIGATORIO')] });
    assert.deepEqual([r.linhas[0].situacao, r.linhas[0].aplicavel, r.ghes[0].operacao], ['VINCULO_EXISTENTE', false, 'ATRIBUIR_CODIGO']);
  });

  test('conflito: mesmo código com descrição diferente → CONFLITO_GHE em todas as linhas do GHE, nunca renomeia', () => {
    const r = analisar([
      l('GHE-001', 'Descrição completamente outra', 'Capacete', 'Obrigatório'),
      l('GHE-001', 'Descrição completamente outra', 'Luva de Raspa', 'Obrigatório'),
    ], { ghes: [g(10, 'GHE-001', 'Soldagem')] });
    for (const linha of r.linhas) assert.deepEqual([linha.situacaoGhe, linha.situacao, linha.motivo, linha.aplicavel], ['CONFLITO_GHE', 'CONFLITO_GHE', 'CODIGO_COM_DESCRICAO_DIFERENTE', false]);
    assert.equal(r.ghes[0].operacao, null);
  });

  test('conflito: a descrição já pertence a GHE com OUTRO código → CONFLITO_GHE (nunca renumera nem troca o código)', () => {
    const r = analisar([l('GHE-050', 'Soldagem', 'Capacete', 'Obrigatório')], { ghes: [g(10, 'GHE-001', 'Soldagem')] });
    assert.deepEqual([r.linhas[0].situacao, r.linhas[0].motivo, r.linhas[0].aplicavel], ['CONFLITO_GHE', 'DESCRICAO_COM_OUTRO_CODIGO', false]);
    const misto = analisar([l('GHE-050', 'Soldagem', 'Capacete', 'Obrigatório')], { ghes: [g(7, null, 'Soldagem'), g(10, 'GHE-001', 'SOLDAGEM')] });
    assert.equal(misto.linhas[0].motivo, 'DESCRICAO_COM_OUTRO_CODIGO', 'legado + GHE com outro código: vale o conflito');
  });

  test('descrição que corresponde a mais de um GHE legado → AMBIGUO / GHE_AMBIGUO, não grava', () => {
    const r = analisar([l('GHE-010', 'Soldagem', 'Capacete', 'Obrigatório')], { ghes: [g(7, null, 'Soldagem'), g(8, null, 'SOLDAGEM')] });
    assert.deepEqual([r.linhas[0].situacaoGhe, r.linhas[0].situacao, r.linhas[0].aplicavel, r.linhas[0].gheId], ['AMBIGUO', 'GHE_AMBIGUO', false, null]);
  });

  test('GHE inativo: vínculo novo ou alterado fica bloqueado (GHE_INATIVO); o que já está igual segue VINCULO_EXISTENTE; nada reativa', () => {
    const ghes = [g(10, 'GHE-003', 'Almoxarifado', false)];
    const r = analisar([
      l('GHE-003', 'Almoxarifado', 'Capacete', 'Obrigatório'),
      l('GHE-003', 'Almoxarifado', 'Luva de Raspa', 'Não obrigatório'),
      l('GHE-003', 'Almoxarifado', 'Protetor Auricular', 'Obrigatório'),
    ], { ghes, vinculos: [v(10, T.capacete.id, 'OBRIGATORIO'), v(10, T.luva.id, 'OBRIGATORIO')] });
    assert.deepEqual(r.linhas.map((x) => [x.situacaoGhe, x.gheInativo, x.situacao, x.aplicavel]), [
      ['GHE_EXISTENTE', true, 'VINCULO_EXISTENTE', false], ['GHE_EXISTENTE', true, 'GHE_INATIVO', false], ['GHE_EXISTENTE', true, 'GHE_INATIVO', false],
    ]);
    assert.equal(r.ghes[0].ativo, false);
    assert.equal(r.ghes[0].operacao, null);
  });
});

describe('resolução do EPI contra o catálogo de tipos', () => {
  const ghes = [g(10, 'GHE-001', 'Soldagem')];
  const um = (epi, base = {}) => so([l('GHE-001', 'Soldagem', epi, 'Obrigatório')], { ghes, ...base });

  test('nome do tipo sem diferenciar caixa, acento ou espaços; pontuação preservada; nada aproximado', () => {
    assert.deepEqual([um('óculos  DE proteção - incolor').tipoMaterialId, um('óculos  DE proteção - incolor').situacao], [T.oculos.id, 'NOVO_VINCULO']);
    for (const epi of ['Capacetes', 'Capacete de segurança', 'Luva de Raspa.', 'Oculos de Protecao Incolor', 'Capac']) {
      assert.deepEqual([um(epi).situacao, um(epi).tipoMaterialId, um(epi).aplicavel], ['EPI_NAO_ENCONTRADO', null, false], epi);
    }
  });

  test('duas correspondências canônicas → EPI_AMBIGUO (nada escolhido)', () => {
    const tipos = [...TIPOS, { id: 9, nome: 'CAPACETE', ativo: true }];
    assert.deepEqual([um('capacete', { tipos }).situacao, um('capacete', { tipos }).tipoMaterialId, um('capacete', { tipos }).aplicavel], ['EPI_AMBIGUO', null, false]);
  });

  test('tipo inativo: sem vínculo prévio → EPI_INATIVO (bloqueado); vínculo prévio é preservado e distinguido, sem apagar nem reativar', () => {
    assert.deepEqual([um('Bota Antiga').situacao, um('Bota Antiga').tipoInativo, um('Bota Antiga').aplicavel], ['EPI_INATIVO', true, false]);
    const iguais = um('Bota Antiga', { vinculos: [v(10, T.botaVelha.id, 'OBRIGATORIO')] });
    assert.deepEqual([iguais.situacao, iguais.tipoInativo, iguais.aplicavel], ['VINCULO_EXISTENTE', true, false]);
    const outra = so([l('GHE-001', 'Soldagem', 'Bota Antiga', 'Não obrigatório')], { ghes, vinculos: [v(10, T.botaVelha.id, 'OBRIGATORIO')] });
    assert.deepEqual([outra.situacao, outra.tipoInativo, outra.aplicavel], ['CLASSIFICACAO_ALTERADA', true, true]);
  });
});

describe('o arquivo inteiro: duplicatas, conflitos e consistência', () => {
  test('duplicata idêntica (mesmo GHE + EPI + classificação, mesmo escrita diferente) não gera segunda operação', () => {
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório'),
      l('ghe-001', 'SOLDAGEM', ' capacete ', 'OBRIGATORIO'),
      l('GHE-001', 'Soldagem', 'Luva de Raspa', 'Obrigatório'),
    ]);
    assert.deepEqual(r.linhas.map((x) => [x.situacao, x.duplicadaDe, x.aplicavel]), [['NOVO_VINCULO', null, true], ['DUPLICADA_NO_ARQUIVO', 2, false], ['NOVO_VINCULO', null, true]]);
    assert.equal(r.resumo.aplicaveis, 2);
    assert.equal(r.resumo.porSituacao.DUPLICADA_NO_ARQUIVO, 1);
  });

  test('mesmo GHE + EPI com classificações diferentes no arquivo → conflito nas DUAS linhas (nunca "a última vence")', () => {
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório'),
      l('GHE-001', 'Soldagem', 'Luva de Raspa', 'Obrigatório'),
      l('GHE-001', 'Soldagem', 'Capacete', 'Não obrigatório'),
    ]);
    assert.deepEqual(r.linhas.map((x) => [x.situacao, x.aplicavel]), [['CONFLITO_NO_ARQUIVO', false], ['NOVO_VINCULO', true], ['CONFLITO_NO_ARQUIVO', false]]);
    assert.equal(r.resumo.aplicaveis, 1);
  });

  test('o mesmo código com descrições diferentes no arquivo → CONFLITO_GHE em todas as suas linhas', () => {
    const r = analisar([l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório'), l('GHE-001', 'Pintura', 'Luva de Raspa', 'Obrigatório'), l('GHE-002', 'Montagem', 'Capacete', 'Obrigatório')]);
    assert.deepEqual(r.linhas.map((x) => [x.situacao, x.motivo]), [['CONFLITO_GHE', 'DESCRICAO_DIVERGENTE_NO_ARQUIVO'], ['CONFLITO_GHE', 'DESCRICAO_DIVERGENTE_NO_ARQUIVO'], ['NOVO_VINCULO', null]]);
  });

  test('a mesma descrição para dois códigos no arquivo → CONFLITO_GHE nos dois GHEs', () => {
    const r = analisar([l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório'), l('GHE-002', 'SOLDAGEM', 'Capacete', 'Obrigatório')]);
    assert.deepEqual(r.linhas.map((x) => [x.situacao, x.motivo]), Array(2).fill(['CONFLITO_GHE', 'DESCRICAO_REPETIDA_NO_ARQUIVO']));
  });

  test('GHE com todas as linhas bloqueadas não gera operação de GHE; o inválido não contamina as demais linhas', () => {
    const r = analisar([
      l('GHE-021', 'Nova', 'Inexistente', 'Obrigatório'), l('GHE-021', 'Nova', 'Bota Antiga', 'Obrigatório'),
      l('GHE-022', 'Outra', 'Capacete', 'Obrigatório'), l('GHE-X', '', '', 'talvez'),
    ]);
    assert.deepEqual(r.ghes.map((x) => [x.codigo, x.operacao]), [['GHE-021', null], ['GHE-022', 'CRIAR']]);
    assert.deepEqual(r.linhas.map((x) => x.situacao), ['EPI_NAO_ENCONTRADO', 'EPI_INATIVO', 'NOVO_VINCULO', 'LINHA_INVALIDA']);
  });

  test('lote misto: resumo por situação e por GHE, sem remover nada que a planilha não cite', () => {
    const ghes = [g(10, 'GHE-001', 'Soldagem'), g(7, null, 'Pintura'), g(11, 'GHE-003', 'Almoxarifado', false), g(12, 'GHE-004', 'Caldeiraria'), g(13, 'GHE-005', 'Fora da planilha')];
    const vinculos = [v(10, T.capacete.id, 'OBRIGATORIO'), v(10, T.protetor.id, 'OBRIGATORIO'), v(13, T.luva.id, 'OBRIGATORIO')];
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório'), l('GHE-001', 'Soldagem', 'Luva de Raspa', 'Não obrigatório'), l('GHE-001', 'Soldagem', 'Protetor Auricular', 'Não obrigatório'),
      l('GHE-010', 'Pintura', 'Capacete', 'Obrigatório'), l('GHE-020', 'Montagem Nova', 'Luva de Raspa', 'Obrigatório'), l('GHE-003', 'Almoxarifado', 'Capacete', 'Obrigatório'),
      l('GHE-004', 'Outra coisa', 'Capacete', 'Obrigatório'), l('GHE-021', 'Nova 2', 'Inexistente', 'Obrigatório'), l('GHE-021', 'Nova 2', 'Bota Antiga', 'Obrigatório'),
      l('GHE-X', '', '', 'talvez'), l('', '', '', ''), l('GHE-020', 'Montagem Nova', 'Luva de Raspa', 'OBRIGATÓRIO'),
    ], { ghes, vinculos });
    assert.equal(r.resumo.linhasRecebidas, 12);
    assert.equal(r.resumo.linhasIgnoradas, 1);
    assert.equal(r.resumo.aplicaveis, 4);
    assert.deepEqual(r.resumo.porSituacao, {
      VINCULO_EXISTENTE: 1, NOVO_VINCULO: 3, CLASSIFICACAO_ALTERADA: 1, GHE_INATIVO: 1, CONFLITO_GHE: 1, EPI_NAO_ENCONTRADO: 1, EPI_INATIVO: 1, LINHA_INVALIDA: 1, DUPLICADA_NO_ARQUIVO: 1,
    });
    assert.deepEqual(r.resumo.ghes, { GHE_EXISTENTE: 2, LEGADO_RECEBERA_CODIGO: 1, GHE_NOVO: 2, CONFLITO_GHE: 1 });
    assert.equal(r.ghes.some((x) => x.codigo === 'GHE-005'), false, 'o GHE que a planilha não cita não aparece nem é tocado');
    assert.equal(r.linhas.filter((x) => x.aplicavel).length, r.resumo.aplicaveis);
  });

  test('puro e determinístico: mesma entrada, mesma saída; a entrada não é alterada; 1000 linhas sem banco', () => {
    const entrada = congelar({ linhas: [l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório'), l('GHE-001', 'Soldagem', 'Luva de Raspa', 'Não obrigatório')], ghes: [g(10, 'GHE-001', 'Soldagem')], tipos: TIPOS, vinculos: [v(10, 1, 'OBRIGATORIO')] });
    assert.deepEqual(nucleo().analisarLote(entrada), nucleo().analisarLote(entrada));
    const grande = Array.from({ length: 1000 }, (_, i) => l(`GHE-${String(100 + (i % 40)).padStart(3, '0')}`, `Setor ${i % 40}`, TIPOS[i % 4].nome, 'Obrigatório'));
    const r = analisar(grande);
    assert.equal(r.linhas.length, 1000);
    assert.equal(r.resumo.aplicaveis + r.resumo.porSituacao.DUPLICADA_NO_ARQUIVO, 1000);
  });
});
