'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  criar,
  buscarPorId,
  buscarPorIdParaAtualizacao,
  listarPorEmpresa,
  contarPorEmpresa,
  atualizar,
  TAMANHO_MAXIMO_NOME,
} = require('../../src/repositories/material.repository');

/**
 * Contrato do repositório de materiais (Bloco 9, Etapa A). Não decide
 * nada: valida formato, monta SQL parametrizado, mapeia colunas para
 * camelCase e propaga erros do banco sem traduzir. Sem exclusão física —
 * não existe função de DELETE, de propósito.
 */

const EMPRESA_A = 4242;
const EMPRESA_B = 8888;

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: linhas.length };
    },
  };
};

const linha = (extra = {}) => ({
  id: 30,
  empresa_id: EMPRESA_A,
  nome: 'Botina de segurança',
  tipo: 'Sapatão / Botina',
  fabricante: 'Bracol',
  prazo_uso_dias: 365,
  unidade: 'par',
  estoque_minimo: 5,
  categoria: null,
  codigo_interno: null,
  descricao: null,
  ativo: true,
  criado_em: new Date('2026-09-23T12:00:00Z'),
  atualizado_em: new Date('2026-09-23T12:00:00Z'),
  ...extra,
});

const mapeada = {
  id: 30,
  empresaId: EMPRESA_A,
  nome: 'Botina de segurança',
  tipo: 'Sapatão / Botina',
  fabricante: 'Bracol',
  prazoUsoDias: 365,
  unidade: 'par',
  estoqueMinimo: 5,
  categoria: null,
  codigoInterno: null,
  descricao: null,
  exigeTamanho: null,
  oculosComGrau: null,
  tipoDescricao: null,
  // Classificação V2 (082): a linha sem as colunas é LEGADO, sem nenhum nível novo.
  modeloClassificacao: 'LEGADO',
  categoriaDescricao: null,
  grupoProtecao: null,
  grupoProtecaoDescricao: null,
  tipoMaterialId: null,
  tipoMaterialAtivo: null,
  ativo: true,
  criadoEm: new Date('2026-09-23T12:00:00Z'),
  atualizadoEm: new Date('2026-09-23T12:00:00Z'),
};

describe('criar', () => {
  test('INSERT parametrizado; ativo não é parâmetro (vem do DEFAULT da migration 007)', async () => {
    const executor = executorFalso([linha()]);

    const material = await criar(executor, { empresaId: EMPRESA_A, nome: 'Botina de segurança' });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+materiais/i);
    assert.match(texto, /returning/i);
    const colunas = texto.slice(texto.indexOf('('), texto.search(/\bvalues\b/i));
    assert.doesNotMatch(colunas, /\bativo\b/i, 'ativo nasce do DEFAULT, não é enviado');
    // Os cinco últimos são da classificação V2 (082): modelo ('LEGADO' quando o chamador não classifica), descrições, proteção e id do tipo.
    assert.deepEqual(valores, [EMPRESA_A, 'Botina de segurança', null, null, null, 'unidade', 0, null, null, null, null, null, null, 'LEGADO', null, null, null, null]);
    assert.deepEqual(material, mapeada);
  });

  test('campos opcionais viajam como parâmetro quando informados', async () => {
    const executor = executorFalso([linha()]);

    await criar(executor, {
      empresaId: EMPRESA_A,
      nome: 'Botina de segurança',
      tipo: 'Sapatão / Botina',
      fabricante: 'Bracol',
      prazoUsoDias: 365,
      unidade: 'par',
      estoqueMinimo: 5,
    });

    assert.deepEqual(executor.chamadas[0].valores, [
      EMPRESA_A, 'Botina de segurança', 'Sapatão / Botina', 'Bracol', 365, 'par', 5,
      null, null, null, null, null, null, 'LEGADO', null, null, null, null,
    ]);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    const base = { empresaId: EMPRESA_A, nome: 'Botina' };

    await assert.rejects(() => criar(executor, { ...base, empresaId: 0 }), /empresa/i);
    await assert.rejects(() => criar(executor, { ...base, nome: '' }), /nome/i);
    await assert.rejects(() => criar(executor, { ...base, nome: 'x'.repeat(TAMANHO_MAXIMO_NOME + 1) }), /nome/i);
    await assert.rejects(() => criar(executor, { ...base, tipo: '' }), /tipo/i);
    await assert.rejects(() => criar(executor, { ...base, prazoUsoDias: 0 }), /prazo/i);
    await assert.rejects(() => criar(executor, { ...base, prazoUsoDias: -5 }), /prazo/i);
    await assert.rejects(() => criar(executor, { ...base, prazoUsoDias: 1.5 }), /prazo/i);
    await assert.rejects(() => criar(executor, { ...base, estoqueMinimo: -1 }), /estoque/i);
    await assert.rejects(() => criar(executor, { ...base, unidade: '' }), /unidade/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('violação de constraint propaga com o SQLSTATE original, sem tradução', async () => {
    const erro = Object.assign(new Error('check violation'), { code: '23514' });
    const executor = { query: async () => { throw erro; } };

    await assert.rejects(
      () => criar(executor, { empresaId: EMPRESA_A, nome: 'Botina' }),
      (e) => e === erro && e.code === '23514',
    );
  });
});

describe('buscarPorId e buscarPorIdParaAtualizacao', () => {
  test('filtra por empresa E id, mapeia para camelCase, sem FOR UPDATE na variante comum', async () => {
    const executor = executorFalso([linha()]);

    const material = await buscarPorId(executor, EMPRESA_A, 30);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /from\s+materiais/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /\bid\s*=\s*\$2/i);
    assert.doesNotMatch(texto, /for\s+update/i);
    assert.deepEqual(valores, [EMPRESA_A, 30]);
    assert.deepEqual(material, mapeada);
  });

  test('a variante travada termina em FOR UPDATE, com o mesmo filtro', async () => {
    const executor = executorFalso([linha()]);

    await buscarPorIdParaAtualizacao(executor, EMPRESA_A, 30);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /for\s+update\s*$/i);
    assert.deepEqual(valores, [EMPRESA_A, 30]);
  });

  test('material de outra empresa (isolamento) devolve null nas duas variantes', async () => {
    assert.equal(await buscarPorId(executorFalso([]), EMPRESA_B, 30), null);
    assert.equal(await buscarPorIdParaAtualizacao(executorFalso([]), EMPRESA_B, 30), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => buscarPorId(executor, 0, 30), /empresa/i);
    await assert.rejects(() => buscarPorId(executor, EMPRESA_A, 0), /material/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('listarPorEmpresa e contarPorEmpresa', () => {
  test('sem filtro: pagina com LIMIT/OFFSET, ordena sem diferenciar maiúsculas', async () => {
    const executor = executorFalso([linha(), linha({ id: 31, nome: 'óculos', ativo: false })]);

    const materiais = await listarPorEmpresa(executor, EMPRESA_A);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /order\s+by\s+lower\(nome\)/i);
    assert.match(texto, /limit\s+\$4\s+offset\s+\$5/i);
    assert.deepEqual(valores, [EMPRESA_A, null, null, 20, 0]);
    assert.equal(materiais.length, 2);
  });

  test('página 2 com limite 10 calcula o deslocamento correto', async () => {
    const executor = executorFalso([]);

    await listarPorEmpresa(executor, EMPRESA_A, { pagina: 2, limite: 10 });

    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, null, null, 10, 10]);
  });

  test('filtro de busca viaja como parâmetro, sem concatenar no SQL', async () => {
    const executor = executorFalso([linha()]);

    await listarPorEmpresa(executor, EMPRESA_A, { busca: 'bot' });

    assert.match(executor.chamadas[0].texto, /ilike/i);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, null, 'bot', 20, 0]);
  });

  test('% e _ no termo de busca são tratados como texto literal, não como coringa do ILIKE (correção pós-auditoria de 23/09/2026)', async () => {
    const executor = executorFalso([]);

    await listarPorEmpresa(executor, EMPRESA_A, { busca: '100%_seguro' });

    // O termo chega escapado ($3), preservando o parametrizado — nunca
    // concatenado na string SQL. \\% e \\_ literais; \\\\ para o caso de a
    // própria busca já conter uma barra invertida.
    assert.equal(executor.chamadas[0].valores[2], '100\\%\\_seguro');
  });

  test('barra invertida literal no termo de busca também é escapada, antes dos outros coringas', async () => {
    const executor = executorFalso([]);

    await listarPorEmpresa(executor, EMPRESA_A, { busca: 'a\\b' });

    assert.equal(executor.chamadas[0].valores[2], 'a\\\\b');
  });

  test('contarPorEmpresa também escapa % e _ do termo de busca', async () => {
    const executor = executorFalso([{ total: 0 }]);

    await contarPorEmpresa(executor, EMPRESA_A, { busca: '50%' });

    assert.equal(executor.chamadas[0].valores[2], '50\\%');
  });

  test('contarPorEmpresa usa o mesmo filtro, sem paginação', async () => {
    const executor = executorFalso([{ total: 7 }]);

    const total = await contarPorEmpresa(executor, EMPRESA_A, { ativo: true, busca: 'bot' });

    assert.match(executor.chamadas[0].texto, /count\(\*\)/i);
    assert.deepEqual(executor.chamadas[0].valores, [EMPRESA_A, true, 'bot']);
    assert.equal(total, 7);
  });

  test('empresa sem materiais devolve lista vazia', async () => {
    assert.deepEqual(await listarPorEmpresa(executorFalso([]), EMPRESA_B), []);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => listarPorEmpresa(executor, 0), /empresa/i);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { ativo: 'sim' }), /ativo/i);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { pagina: 0 }), /p.gina/i);
    await assert.rejects(() => listarPorEmpresa(executor, EMPRESA_A, { limite: 0 }), /limite/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('atualizar', () => {
  test('UPDATE alcança os campos do cadastro — nunca id, empresa_id ou criado_em', async () => {
    const executor = executorFalso([linha({ nome: 'Botina reforçada' })]);

    await atualizar(executor, EMPRESA_A, 30, { nome: 'Botina reforçada' });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+materiais/i);
    const set = texto.slice(texto.search(/\bset\b/i), texto.search(/\bwhere\b/i));
    assert.match(set, /nome\s*=/i);
    assert.match(set, /tipo\s*=/i);
    assert.match(set, /estoque_minimo\s*=/i);
    assert.match(set, /ativo\s*=/i);
    assert.doesNotMatch(set, /empresa_id\s*=/i);
    assert.doesNotMatch(set, /criado_em\s*=/i);
    assert.doesNotMatch(set, /\bid\s*=/i);
    assert.match(set, /tipo_descricao\s*=/i);
    assert.deepEqual(valores, [
      EMPRESA_A, 30, 'Botina reforçada',
      false, null, false, null, false, null,
      null, null, null,
      false, null, false, null, false, null,
      null,
      false, null,
      false, null,
      // Classificação V2 (082): modelo (null = manter) e os quatro pares informado/valor (descrição do grupo, proteção, descrição da proteção, id do tipo).
      null,
      false, null, false, null, false, null, false, null,
    ]);
  });

  test('campos ausentes preservam o valor atual (COALESCE/CASE), inclusive o nome', async () => {
    const executor = executorFalso([linha()]);

    await atualizar(executor, EMPRESA_A, 30, {});

    assert.deepEqual(executor.chamadas[0].valores, [
      EMPRESA_A, 30, null,
      false, null, false, null, false, null,
      null, null, null,
      false, null, false, null, false, null,
      null,
      false, null,
      false, null,
      null,
      false, null, false, null, false, null, false, null,
    ]);
  });

  test('campo opcional informado como null explícito limpa o valor (via flag *Informado)', async () => {
    const executor = executorFalso([linha({ tipo: null })]);

    await atualizar(executor, EMPRESA_A, 30, { tipo: null, tipoInformado: true });

    assert.equal(executor.chamadas[0].valores[3], true, 'tipoInformado viaja como true');
    assert.equal(executor.chamadas[0].valores[4], null, 'tipo viaja como null explícito');
  });

  test('material inexistente nesta empresa devolve null', async () => {
    assert.equal(await atualizar(executorFalso([]), EMPRESA_B, 30, { nome: 'X' }), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => atualizar(executor, 0, 30, {}), /empresa/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 0, {}), /material/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 30, { nome: '' }), /nome/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 30, { estoqueMinimo: -1 }), /estoque/i);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 30, { ativo: 'sim' }), /ativo/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('categoria, codigo_interno e descricao — Parte C2 (migration 039)', () => {
  test('criar grava os três campos como parâmetros (nunca concatenados) e a projeção os devolve mapeados', async () => {
    const executor = executorFalso([linha({ categoria: 'EPI', codigo_interno: 'EPI-000245', descricao: 'Proteção leve' })]);
    const r = await criar(executor, { empresaId: EMPRESA_A, nome: 'Luva', categoria: 'EPI', codigoInterno: 'EPI-000245', descricao: 'Proteção leve' });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /categoria/);
    assert.match(texto, /codigo_interno/);
    assert.match(texto, /descricao/);
    assert.ok(valores.includes('EPI-000245') && valores.includes('EPI') && valores.includes('Proteção leve'));
    assert.equal(texto.includes('EPI-000245'), false);
    assert.deepEqual([r.categoria, r.codigoInterno, r.descricao], ['EPI', 'EPI-000245', 'Proteção leve']);
  });

  test('criar sem os três campos grava NULL (compatível com a 007 + 039)', async () => {
    const executor = executorFalso([linha()]);
    const r = await criar(executor, { empresaId: EMPRESA_A, nome: 'Luva' });
    assert.deepEqual([r.categoria, r.codigoInterno, r.descricao], [null, null, null]);
    assert.equal(executor.chamadas[0].valores.filter((v) => v === null).length >= 3, true);
  });

  test('atualizar: *Informado distingue "limpar" de "não mexer" também para os três campos', async () => {
    const executor = executorFalso([linha()]);
    await atualizar(executor, EMPRESA_A, 30, { codigoInternoInformado: true, codigoInterno: null, categoriaInformado: true, categoria: 'Uniforme' });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /codigo_interno = CASE WHEN/);
    assert.match(texto, /categoria = CASE WHEN/);
    assert.match(texto, /descricao = CASE WHEN/);
    assert.ok(valores.includes('Uniforme'));
  });

  test('recusa texto acima do limite antes de consultar', async () => {
    const executor = executorFalso([linha()]);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'L', codigoInterno: 'x'.repeat(31) }), /código interno/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'L', categoria: 'x'.repeat(31) }), /categoria/i);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'L', descricao: 'x'.repeat(501) }), /descrição/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('material sem CA — E10 (o CA é do lote)', () => {
  test('nenhuma consulta nem escrita do cadastro lê ou grava ca_numero e ca_validade', async () => {
    const executor = executorFalso([linha({ ca_numero: '38271', ca_validade: '2026-08-15' })]);
    const criado = await criar(executor, { empresaId: EMPRESA_A, nome: 'Botina de segurança', caNumero: '38271', caValidade: '2026-08-15' });
    await buscarPorId(executor, EMPRESA_A, 30);
    await buscarPorIdParaAtualizacao(executor, EMPRESA_A, 30);
    await listarPorEmpresa(executor, EMPRESA_A);
    await atualizar(executor, EMPRESA_A, 30, { nome: 'Botina reforçada', caNumero: '1', caNumeroInformado: true });
    assert.equal(executor.chamadas.length, 5);
    for (const { texto, valores } of executor.chamadas) {
      assert.doesNotMatch(texto, /ca_numero|ca_validade/, texto);
      assert.equal(valores.includes('38271') || valores.includes('2026-08-15'), false);
    }
    assert.deepEqual(['caNumero' in criado, 'caValidade' in criado], [false, false]);
  });
});

describe('exige_tamanho — migration 044', () => {
  test('a projeção lê exige_tamanho e o mapeamento devolve exigeTamanho, inclusive o null do legado', async () => {
    for (const valor of [true, false, null]) {
      const executor = executorFalso([linha({ exige_tamanho: valor })]);
      const r = await buscarPorId(executor, EMPRESA_A, 30);
      assert.match(executor.chamadas[0].texto, /\bexige_tamanho\b/);
      assert.equal(r.exigeTamanho, valor);
    }
  });

  test('criar grava exige_tamanho como parâmetro', async () => {
    const executor = executorFalso([linha({ exige_tamanho: false })]);
    await criar(executor, { empresaId: EMPRESA_A, nome: 'Óculos', prazoUsoDias: 180, exigeTamanho: false });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto.slice(0, texto.search(/\bvalues\b/i)), /\bexige_tamanho\b/);
    assert.equal(valores[10], false);
  });

  test('atualizar: ausente mantém o valor atual; informado grava; nunca apaga para null', async () => {
    const executor = executorFalso([linha()], [linha({ exige_tamanho: true })]);
    await atualizar(executor, EMPRESA_A, 30, {});
    await atualizar(executor, EMPRESA_A, 30, { exigeTamanho: true });
    const [ausente, informado] = executor.chamadas;
    assert.match(ausente.texto, /exige_tamanho\s*=\s*COALESCE\(\$19::boolean,\s*exige_tamanho\)/);
    assert.deepEqual([ausente.valores.length, ausente.valores[18], informado.valores[18]], [32, null, true]);
  });

  test('recusa valor que não é booleano antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'Óculos', exigeTamanho: 'sim' }), /tamanho/);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 30, { exigeTamanho: 1 }), /tamanho/);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('oculos_com_grau — migration 045', () => {
  test('a projeção lê oculos_com_grau e o mapeamento devolve oculosComGrau, inclusive o null', async () => {
    for (const valor of [true, false, null]) {
      const executor = executorFalso([linha({ oculos_com_grau: valor })]);
      const r = await buscarPorId(executor, EMPRESA_A, 30);
      assert.match(executor.chamadas[0].texto, /\boculos_com_grau\b/);
      assert.equal(r.oculosComGrau, valor);
    }
  });

  test('criar grava oculos_com_grau como parâmetro; ausente vai null', async () => {
    const executor = executorFalso([linha({ oculos_com_grau: true })], [linha()]);
    await criar(executor, { empresaId: EMPRESA_A, nome: 'Óculos', tipo: 'Óculos de proteção', prazoUsoDias: 180, exigeTamanho: false, oculosComGrau: true });
    await criar(executor, { empresaId: EMPRESA_A, nome: 'Luva', prazoUsoDias: 180, exigeTamanho: true });
    const [comValor, semValor] = executor.chamadas;
    assert.match(comValor.texto.slice(0, comValor.texto.search(/\bvalues\b/i)), /\boculos_com_grau\b/);
    // oculos_com_grau é o 12º parâmetro; o 13º é tipo_descricao (071); do 14º em diante, a classificação V2 (082).
    assert.deepEqual([comValor.valores.length, comValor.valores[11], semValor.valores[11], comValor.valores[12]], [18, true, null, null]);
  });

  test('atualizar: não informado mantém o valor atual; informado grava true, false ou null', async () => {
    const executor = executorFalso([linha()], [linha()], [linha()], [linha()]);
    await atualizar(executor, EMPRESA_A, 30, {});
    for (const valor of [true, false, null]) {
      await atualizar(executor, EMPRESA_A, 30, { oculosComGrau: valor, oculosComGrauInformado: true });
    }
    const [ausente, ...informados] = executor.chamadas;
    assert.match(ausente.texto, /oculos_com_grau\s*=\s*CASE WHEN \$20::boolean THEN \$21::boolean ELSE oculos_com_grau END/);
    assert.deepEqual(ausente.valores.slice(19, 21), [false, null]);
    assert.deepEqual(informados.map((c) => c.valores.slice(19, 21)), [[true, true], [true, false], [true, null]]);
  });

  test('recusa valor que não é booleano nem null antes de consultar', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => criar(executor, { empresaId: EMPRESA_A, nome: 'Óculos', oculosComGrau: 'sim' }), /grau/);
    await assert.rejects(() => atualizar(executor, EMPRESA_A, 30, { oculosComGrau: 1, oculosComGrauInformado: true }), /grau/);
    assert.equal(executor.chamadas.length, 0);
  });
});
