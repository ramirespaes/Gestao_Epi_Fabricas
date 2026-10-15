'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Etapa A1 (RED): o núcleo da importação GHE / EPI (src/utils/ghe-importacao.js) agrupa os tipos de EPI que a planilha
 * cita e o catálogo da empresa ainda não tem, para a SST poder cadastrá-los de forma explícita pela rota existente
 * (POST /tipos-material). Decisão de contrato (D1 + opção A): o campo vive DENTRO de `resumo`, nunca no nível principal.
 *
 *   resumo.tiposNaoEncontrados: [{ nome, variantes, linhas, ghes, reservado, nomeExcedeLimite }]   sempre presente ([] se nada)
 *     - um item por CHAVE DE COMPARAÇÃO da importação (chaveCanonica: sem caixa, sem acento, espaços colapsados, pontuação
 *       preservada, sem aproximação) — a mesma regra que decide EPI_NAO_ENCONTRADO; nenhuma outra normalização;
 *     - entram só as linhas cuja situação é EPI_NAO_ENCONTRADO (EPI_INATIVO, EPI_AMBIGUO, linha inválida e conflito de GHE
 *       não entram);
 *     - nome = texto limpo da PRIMEIRA ocorrência; variantes = textos limpos distintos, na ordem em que aparecem;
 *     - linhas = números das linhas, na ordem do arquivo; ghes = códigos normalizados, únicos, na ordem em que aparecem;
 *     - reservado = a chave é a de "Outros" (o catálogo nunca aceita esse nome); nomeExcedeLimite = mais de 100 caracteres
 *       (pontos de código), o teto do nome no catálogo;
 *     - itens na ordem da primeira ocorrência no arquivo.
 *   Nada mais muda: situação, ids, aplicáveis, contadores e GHEs do arquivo continuam como hoje.
 */

const nucleo = () => exigirModulo('src/utils/ghe-importacao');

const TIPOS = [
  { id: 1, nome: 'Capacete', ativo: true },
  { id: 2, nome: 'Bota Antiga', ativo: false },
  { id: 3, nome: 'Óculos Ampla Visão', ativo: true },
  { id: 4, nome: 'Oculos Ampla Visao', ativo: true },
];
const l = (ghe, descricao, epi, classificacao = 'Obrigatório') => ({ ghe, descricao, epi, classificacao });

function congelar(o) {
  if (o !== null && typeof o === 'object') { Object.values(o).forEach(congelar); Object.freeze(o); }
  return o;
}
const analisar = (linhas, base = {}) => nucleo().analisarLote(congelar({ linhas, ghes: [], tipos: TIPOS, vinculos: [], ...base }));

/** A lista nova, exigida como array: ausência é falha funcional (nunca TypeError). */
function naoEncontrados(resultado) {
  const lista = resultado.resumo.tiposNaoEncontrados;
  assert.ok(Array.isArray(lista), `resumo.tiposNaoEncontrados deveria ser uma lista; veio ${JSON.stringify(lista)}`);
  return lista;
}

describe('A1 — resumo.tiposNaoEncontrados: presença e contrato', () => {
  test('sempre presente: lista vazia quando todos os EPIs existem; o nível principal do resultado não ganha campo novo', () => {
    const r = analisar([l('GHE-001', 'Soldagem', 'Capacete')]);
    assert.deepEqual(naoEncontrados(r), []);
    assert.deepEqual(Object.keys(r).sort(), ['ghes', 'linhas', 'resumo']);
  });

  test('cada item tem exatamente nome, variantes, linhas, ghes, reservado e nomeExcedeLimite', () => {
    const r = analisar([l('GHE-001', 'Soldagem', 'Luva Nitrila')]);
    const lista = naoEncontrados(r);
    assert.equal(lista.length, 1);
    assert.deepEqual(Object.keys(lista[0]).sort(), ['ghes', 'linhas', 'nome', 'nomeExcedeLimite', 'reservado', 'variantes']);
    assert.deepEqual(lista[0], { nome: 'Luva Nitrila', variantes: ['Luva Nitrila'], linhas: [2], ghes: ['GHE-001'], reservado: false, nomeExcedeLimite: false });
  });
});

describe('A1 — agrupamento pela chave de comparação da importação', () => {
  test('caixa, acento e espaços repetidos são o mesmo tipo: um item, nome da primeira ocorrência e as variantes na ordem', () => {
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Luva Nitrila'),
      l('GHE-002', 'Pintura', '  luva    nitrila '),
      l('GHE-003', 'Montagem', 'LÚVA NITRÍLA'),
      l('GHE-004', 'Caldeiraria', 'Luva Nitrila'),
    ]);
    assert.deepEqual(r.linhas.map((x) => x.situacao), ['EPI_NAO_ENCONTRADO', 'EPI_NAO_ENCONTRADO', 'EPI_NAO_ENCONTRADO', 'EPI_NAO_ENCONTRADO'], 'premissa');
    assert.deepEqual(naoEncontrados(r), [{
      nome: 'Luva Nitrila', variantes: ['Luva Nitrila', 'luva nitrila', 'LÚVA NITRÍLA'], linhas: [2, 3, 4, 5],
      ghes: ['GHE-001', 'GHE-002', 'GHE-003', 'GHE-004'], reservado: false, nomeExcedeLimite: false,
    }]);
  });

  test('sem aproximação: pontuação, plural e hífen fazem tipos distintos, na ordem da primeira ocorrência', () => {
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Luva Nitrila.'),
      l('GHE-001', 'Soldagem', 'Luvas Nitrila'),
      l('GHE-001', 'Soldagem', 'Luva-Nitrila'),
      l('GHE-002', 'Pintura', 'Luva Nitrila'),
    ]);
    assert.deepEqual(naoEncontrados(r).map((x) => [x.nome, x.linhas]), [
      ['Luva Nitrila.', [2]], ['Luvas Nitrila', [3]], ['Luva-Nitrila', [4]], ['Luva Nitrila', [5]],
    ]);
  });

  test('linhas e GHEs afetados: GHE com código normalizado, sem repetição, na ordem em que aparece; linha repetida conta as duas', () => {
    const r = analisar([
      l(' ghe-002 ', 'Pintura', 'Respirador Novo'),
      l('GHE-001', 'Soldagem', 'Respirador Novo'),
      l('GHE-002', 'Pintura', 'Capacete'),
      l('GHE-002', 'Pintura', 'Respirador Novo'),
    ]);
    const [item] = naoEncontrados(r);
    assert.deepEqual(item.linhas, [2, 3, 5]);
    assert.deepEqual(item.ghes, ['GHE-002', 'GHE-001']);
  });

  test('vários tipos inexistentes no mesmo arquivo: um item por tipo, cada um com as próprias linhas e GHEs', () => {
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Protetor Facial'),
      l('GHE-002', 'Pintura', 'Cinturão Paraquedista'),
      l('GHE-003', 'Montagem', 'Protetor Facial'),
    ]);
    assert.deepEqual(naoEncontrados(r).map((x) => [x.nome, x.linhas, x.ghes]), [
      ['Protetor Facial', [2, 4], ['GHE-001', 'GHE-003']],
      ['Cinturão Paraquedista', [3], ['GHE-002']],
    ]);
  });
});

describe('A1 — só EPI_NAO_ENCONTRADO entra na lista', () => {
  test('tipo existente, tipo inativo (EPI_INATIVO) e tipo ambíguo (EPI_AMBIGUO) não entram; o inexistente entra', () => {
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Capacete'),
      l('GHE-001', 'Soldagem', 'Bota Antiga'),
      l('GHE-001', 'Soldagem', 'oculos ampla visao'),
      l('GHE-001', 'Soldagem', 'Mangote Novo'),
    ]);
    assert.deepEqual(r.linhas.map((x) => x.situacao), ['NOVO_VINCULO', 'EPI_INATIVO', 'EPI_AMBIGUO', 'EPI_NAO_ENCONTRADO'], 'premissa');
    assert.deepEqual(naoEncontrados(r).map((x) => x.nome), ['Mangote Novo']);
  });

  test('GHE existente e inativo com EPI inexistente: a linha é EPI_NAO_ENCONTRADO e entra; conflito de GHE não entra', () => {
    const ghes = [{ id: 10, codigo: 'GHE-001', nome: 'Soldagem', ativo: false }, { id: 11, codigo: 'GHE-002', nome: 'Pintura', ativo: true }];
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Avental Novo'),
      l('GHE-002', 'Outra descrição', 'Perneira Nova'),
    ], { ghes });
    assert.deepEqual(r.linhas.map((x) => x.situacao), ['EPI_NAO_ENCONTRADO', 'CONFLITO_GHE'], 'premissa');
    assert.deepEqual(naoEncontrados(r).map((x) => [x.nome, x.ghes]), [['Avental Novo', ['GHE-001']]]);
  });

  test('linhas inválidas e vazias não entram (EPI vazio, classificação inválida, código inválido, linha toda vazia)', () => {
    const r = analisar([
      l('GHE-001', 'Soldagem', ''),
      l('GHE-001', 'Soldagem', 'Bota Nova', 'talvez'),
      l('GHE-X', 'Soldagem', 'Bota Nova'),
      l('', '', '', ''),
      l('GHE-001', 'Soldagem', 'Bota Nova'),
    ]);
    assert.deepEqual(r.linhas.map((x) => x.situacao), ['LINHA_INVALIDA', 'LINHA_INVALIDA', 'LINHA_INVALIDA', 'EPI_NAO_ENCONTRADO'], 'premissa');
    assert.deepEqual(naoEncontrados(r), [{ nome: 'Bota Nova', variantes: ['Bota Nova'], linhas: [6], ghes: ['GHE-001'], reservado: false, nomeExcedeLimite: false }]);
  });
});

describe('A1 — "Outros" e nome acima do teto do catálogo', () => {
  test('"Outros" (qualquer caixa ou acento) entra marcado como reservado; "Outros EPIs" é um nome comum', () => {
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Outros'),
      l('GHE-002', 'Pintura', 'OUTROS'),
      l('GHE-003', 'Montagem', 'Óutros'),
      l('GHE-001', 'Soldagem', 'Outros EPIs'),
    ]);
    assert.deepEqual(naoEncontrados(r).map((x) => [x.nome, x.variantes, x.linhas, x.reservado]), [
      ['Outros', ['Outros', 'OUTROS', 'Óutros'], [2, 3, 4], true],
      ['Outros EPIs', ['Outros EPIs'], [5], false],
    ]);
  });

  test('nomeExcedeLimite: 100 pontos de código ainda cabem (inclusive com acento); 101 não', () => {
    const cem = `Ó${'a'.repeat(99)}`;
    const centoEUm = `Ó${'b'.repeat(100)}`;
    assert.equal(Array.from(cem).length, 100);
    const r = analisar([l('GHE-001', 'Soldagem', cem), l('GHE-001', 'Soldagem', centoEUm)]);
    assert.deepEqual(naoEncontrados(r).map((x) => [Array.from(x.nome).length, x.nomeExcedeLimite]), [[100, false], [101, true]]);
  });
});

describe('A1 — nada do contrato atual muda', () => {
  test('situações, ids, aplicáveis, contadores e GHEs do arquivo são os mesmos de antes; a entrada não é alterada', () => {
    const ghes = [{ id: 10, codigo: 'GHE-001', nome: 'Soldagem', ativo: true }];
    const vinculos = [{ gheId: 10, tipoId: 1, classificacao: 'OBRIGATORIO' }];
    const r = analisar([
      l('GHE-001', 'Soldagem', 'Capacete'),
      l('GHE-001', 'Soldagem', 'Luva Nova'),
      l('GHE-002', 'Pintura', 'Capacete'),
      l('GHE-002', 'Pintura', 'Luva Nova'),
    ], { ghes, vinculos });
    assert.deepEqual(r.linhas.map((x) => [x.situacao, x.tipoMaterialId, x.aplicavel]), [
      ['VINCULO_EXISTENTE', 1, false], ['EPI_NAO_ENCONTRADO', null, false], ['NOVO_VINCULO', 1, true], ['EPI_NAO_ENCONTRADO', null, false],
    ]);
    assert.equal(r.resumo.aplicaveis, 1);
    assert.deepEqual(r.resumo.porSituacao, { VINCULO_EXISTENTE: 1, EPI_NAO_ENCONTRADO: 2, NOVO_VINCULO: 1 });
    assert.deepEqual(r.ghes.map((x) => [x.codigo, x.situacao, x.operacao]), [['GHE-001', 'GHE_EXISTENTE', null], ['GHE-002', 'GHE_NOVO', 'CRIAR']]);
    assert.deepEqual(Object.keys(r.resumo).sort(), ['aplicaveis', 'ghes', 'linhasIgnoradas', 'linhasRecebidas', 'porSituacao', 'tiposNaoEncontrados']);
    assert.deepEqual(naoEncontrados(r).map((x) => [x.nome, x.linhas, x.ghes]), [['Luva Nova', [3, 5], ['GHE-001', 'GHE-002']]]);
  });
});
