'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Consulta de TODOS os pares (empresa, material, tamanho) da posição de
 * estoque (12D-1), sem PostgreSQL real: forma do SQL, ordem dos parâmetros,
 * validação, mapeamento e a paginação. O cálculo de verdade (universo,
 * fórmulas, mínimo efetivo) é provado em banco real.
 *
 * Contrato de parâmetros desta consulta (só dela; os fragmentos recebem as
 * referências):
 *   $1 empresa, $2 hoje, $3 dias de alerta, $4 categoria, $5 tipo, $6 tamanho,
 *   $7 validade, $8 busca (já escapada), $9 situação, $10 limite, $11 offset.
 */

const repo = () => exigirModulo('src/repositories/posicao-estoque.repository');

const EMPRESA = 42;
const HOJE = '2026-10-02';

const base = (extra = {}) => ({ hoje: HOJE, diasAlerta: 60, pagina: 1, limite: 10, ...extra });

function executorFalso(linhas) {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows: linhas, rowCount: linhas.length }; },
  };
}

// O banco devolve bigint como texto.
const linhaDoBanco = (extra = {}) => ({
  total: 23,
  material_id: 30,
  nome: 'Luva de raspa',
  codigo_interno: 'EPI-030',
  categoria: 'EPI',
  tipo: 'Luva',
  unidade: 'par',
  tamanho_chave: 'P',
  saldo: '8',
  bloqueado: '3',
  fisico_utilizavel: '5',
  demanda_pendente: '2',
  comprometido: '2',
  saldo_livre: '3',
  sem_cobertura: '0',
  minimo_efetivo: 5,
  minimo_origem: 'PROPRIO',
  abaixo_do_minimo: true,
  deficit: '2',
  necessidade: '2',
  ca_validade: '2027-01-31',
  validade: 'ok',
  ...extra,
});

describe('listarPosicoes — uma única consulta de leitura, sem N+1', () => {
  test('um único executor.query, só leitura, com o universo (lotes, demanda, mínimo próprio e padrão de material sem tamanho) e empresa em cada fonte', async () => {
    const executor = executorFalso([linhaDoBanco()]);
    await repo().listarPosicoes(executor, EMPRESA, base());
    assert.equal(executor.chamadas.length, 1, 'uma consulta só para a página e o total');
    const { texto } = executor.chamadas[0];
    assert.match(texto, /^WITH\b/);
    assert.doesNotMatch(texto, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    assert.doesNotMatch(texto, /\bFOR\s+(NO KEY\s+)?(UPDATE|SHARE)\b|pg_advisory/i);
    assert.doesNotMatch(texto, /CURRENT_DATE|now\(\)/i, 'a data operacional é parâmetro');
    assert.match(texto, /FROM estoque_lotes l\s+JOIN materiais m ON m\.empresa_id = l\.empresa_id AND m\.id = l\.material_id/);
    assert.match(texto, /l\.empresa_id = \$1/);
    assert.match(texto, /FROM estoque_minimos em/);
    assert.match(texto, /em\.empresa_id = \$1/);
    assert.match(texto, /i\.empresa_id = \$1/, 'a demanda também é da empresa');
    assert.match(texto, /\bUNION\b/);
    assert.match(texto, /m\.ativo/);
    assert.match(texto, /m\.exige_tamanho = false AND m\.estoque_minimo > 0/, 'material sem tamanho com mínimo padrão aparece sem lote');
  });

  test('o físico utilizável e a demanda vêm dos fragmentos da definição única, com as referências desta consulta ($2 é a data)', async () => {
    const executor = executorFalso([linhaDoBanco()]);
    await repo().listarPosicoes(executor, EMPRESA, base());
    const { texto } = executor.chamadas[0];
    assert.match(texto, /m\.exige_ca AND \(l\.ca_validade IS NULL OR l\.ca_validade < \$2::date\)/);
    assert.match(texto, /l\.ca_validade <= \$2::date \+ \$3::int/);
    assert.match(texto, /i\.quantidade_aprovada > COALESCE\(e\.entregue, 0\)/);
    assert.match(texto, /s\.status IN \('APROVADA', 'APROVADA_PARCIAL'\)/);
  });

  test('as fórmulas são do SQL: comprometido, livre, sem cobertura, déficit e necessidade a partir de U, D e do mínimo efetivo', async () => {
    const executor = executorFalso([linhaDoBanco()]);
    await repo().listarPosicoes(executor, EMPRESA, base());
    const texto = executor.chamadas[0].texto.replace(/\s+/g, ' ');
    assert.match(texto, /LEAST\(fisico_utilizavel, demanda_pendente\) AS comprometido/);
    assert.match(texto, /GREATEST\(0, fisico_utilizavel - demanda_pendente\) AS saldo_livre/);
    assert.match(texto, /GREATEST\(0, demanda_pendente - fisico_utilizavel\) AS sem_cobertura/);
    assert.match(texto, /COALESCE\(mp\.minimo, m\.estoque_minimo\) AS minimo_efetivo/);
    assert.match(texto, /CASE WHEN mp\.minimo IS NOT NULL THEN 'PROPRIO' ELSE 'PADRAO' END AS minimo_origem/);
    assert.match(texto, /GREATEST\(0, minimo_efetivo - saldo_livre\) AS deficit/);
    assert.match(texto, /sem_cobertura \+ GREATEST\(0, minimo_efetivo - saldo_livre\) AS necessidade/);
    assert.match(texto, /minimo_efetivo > 0 AND saldo_livre < minimo_efetivo/);
    assert.doesNotMatch(texto, /fisico_utilizavel < minimo_efetivo/, 'o mínimo é comparado com o saldo livre, nunca com o físico');
  });

  test('ordem e paginação: nome, material e tamanho (sem tamanho primeiro), LIMIT $10 OFFSET $11', async () => {
    const executor = executorFalso([linhaDoBanco()]);
    await repo().listarPosicoes(executor, EMPRESA, base({ pagina: 3, limite: 10 }));
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /ORDER BY lower\(nome\), material_id, tamanho_chave/);
    assert.match(texto, /LIMIT \$10 OFFSET \$11/);
    assert.deepEqual(valores, [EMPRESA, HOJE, 60, null, null, null, null, null, null, 10, 20, false]);
  });

  test('o total vem de uma CTE própria que não depende de a página ter linha: nada de count(*) OVER()', async () => {
    const executor = executorFalso([linhaDoBanco()]);
    await repo().listarPosicoes(executor, EMPRESA, base());
    const texto = executor.chamadas[0].texto;
    assert.doesNotMatch(texto, /count\(\*\)\s+OVER/i);
    assert.match(texto, /SELECT count\(\*\)::int AS total FROM filtrada/);
    assert.match(texto, /FROM total\s+LEFT JOIN pagina ON true/);
  });
});

describe('listarPosicoes — filtros em parâmetros, nunca concatenados', () => {
  test('categoria, tipo, tamanho, validade, busca (escapada) e situação seguem como parâmetros $4 a $9', async () => {
    const executor = executorFalso([linhaDoBanco()]);
    await repo().listarPosicoes(executor, EMPRESA, base({
      categoria: 'CAT-UNICA', tipo: 'TIPO-UNICO', tamanho: 'TAM-UNICO', validade: 'expired', busca: '50%_x', situacao: 'ABAIXO_MINIMO',
    }));
    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [EMPRESA, HOJE, 60, 'CAT-UNICA', 'TIPO-UNICO', 'TAM-UNICO', 'expired', '50\\%\\_x', 'ABAIXO_MINIMO', 10, 0, false]);
    // As constantes de validade e de situação aparecem no SQL como comparação fixa; os valores de texto livre só vão em parâmetro.
    assert.doesNotMatch(texto, /CAT-UNICA|TIPO-UNICO|TAM-UNICO|50%/, 'nenhum valor de filtro no texto do SQL');
    assert.match(texto, /m\.categoria = \$4::text/);
    assert.match(texto, /m\.tipo = \$5::text/);
    assert.match(texto, /tamanho_chave = \$6::text/);
    assert.match(texto, /validade = \$7::text/);
    assert.match(texto, /m\.nome ILIKE '%' \|\| \$8::text \|\| '%' OR m\.codigo_interno ILIKE '%' \|\| \$8::text \|\| '%'/);
    assert.match(texto, /\$9::text/);
  });

  test('cada situação filtra pelo campo derivado certo', async () => {
    const esperado = {
      SEM_ESTOQUE: /fisico_utilizavel = 0/,
      ABAIXO_MINIMO: /abaixo_do_minimo/,
      COM_COMPROMETIDO: /comprometido > 0/,
      SEM_COBERTURA: /sem_cobertura > 0/,
      COM_NECESSIDADE: /necessidade > 0/,
    };
    assert.deepEqual([...repo().SITUACOES], Object.keys(esperado));
    for (const [situacao, padrao] of Object.entries(esperado)) {
      const executor = executorFalso([linhaDoBanco()]);
      await repo().listarPosicoes(executor, EMPRESA, base({ situacao }));
      assert.match(executor.chamadas[0].texto, padrao, situacao);
    }
  });

  test('somenteComNecessidade (12D-2) é o parâmetro $12 e filtra pela necessidade derivada (G + déficit); combina com a situação', async () => {
    const executor = executorFalso([linhaDoBanco()]);
    await repo().listarPosicoes(executor, EMPRESA, base({ situacao: 'SEM_COBERTURA', somenteComNecessidade: true }));
    const { texto, valores } = executor.chamadas[0];
    assert.equal(valores[8], 'SEM_COBERTURA');
    assert.equal(valores[11], true);
    assert.match(texto, /\$12::boolean IS NOT TRUE OR necessidade > 0/);
    assert.match(texto, /sem_cobertura > 0[\s\S]*\$12::boolean/, 'os dois filtros valem juntos (AND), nenhum substitui o outro');
    const sem = executorFalso([linhaDoBanco()]);
    await repo().listarPosicoes(sem, EMPRESA, base());
    assert.equal(sem.chamadas[0].valores[11], false, 'ausente é falso');
  });

  test('entradas inválidas são erro de programação, antes de consultar', async () => {
    const executor = executorFalso([]);
    const invalidos = [
      { hoje: '2026-13-01' }, { hoje: undefined }, { diasAlerta: 0 }, { diasAlerta: '60' }, { pagina: 0 }, { pagina: 1.5 }, { limite: 0 }, { limite: -1 },
      { situacao: 'QUALQUER' }, { validade: 'vencido' }, { busca: '' }, { busca: 7 }, { categoria: 7 }, { tipo: {} }, { tamanho: 3 },
      { somenteComNecessidade: 'true' }, { somenteComNecessidade: 1 }, { somenteComNecessidade: null },
    ];
    for (const extra of invalidos) {
      await assert.rejects(() => repo().listarPosicoes(executor, EMPRESA, base(extra)), TypeError, JSON.stringify(extra));
    }
    for (const empresa of [0, -1, 1.5, '42', null]) {
      await assert.rejects(() => repo().listarPosicoes(executor, empresa, base()), TypeError, String(empresa));
    }
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('listarPosicoes — mapeamento e paginação', () => {
  test('o item público: números de verdade (bigint do banco chega como texto), tamanho ausente é null, origem do mínimo', async () => {
    const executor = executorFalso([linhaDoBanco(), linhaDoBanco({ material_id: 31, tamanho_chave: '', minimo_origem: 'PADRAO', minimo_efetivo: 7 })]);
    const { itens, total } = await repo().listarPosicoes(executor, EMPRESA, base());
    assert.equal(total, 23);
    assert.deepEqual(itens[0], {
      materialId: 30,
      material: 'Luva de raspa',
      codigoInterno: 'EPI-030',
      categoria: 'EPI',
      tipo: 'Luva',
      tamanho: 'P',
      unidade: 'par',
      saldo: 8,
      bloqueado: 3,
      fisicoUtilizavel: 5,
      demandaPendente: 2,
      comprometido: 2,
      saldoLivre: 3,
      semCobertura: 0,
      estoqueMinimo: 5,
      minimoOrigem: 'PROPRIO',
      abaixoDoMinimo: true,
      deficit: 2,
      necessidade: 2,
      caValidade: '2027-01-31',
      validade: 'ok',
    });
    assert.equal(itens[1].tamanho, null, 'o tamanho vazio da chave é tamanho ausente');
    assert.equal(itens[1].minimoOrigem, 'PADRAO');
    assert.ok(itens.every((i) => typeof i.fisicoUtilizavel === 'number' && typeof i.saldoLivre === 'number'));
  });

  test('PÁGINA ALÉM DO ÚLTIMO RESULTADO: total 23, limite 10, página 4, sem itens — o total continua 23', async () => {
    // O banco devolve uma linha só, com o total e as colunas do item nulas.
    const executor = executorFalso([{ total: 23, material_id: null, nome: null, tamanho_chave: null }]);
    const r = await repo().listarPosicoes(executor, EMPRESA, base({ pagina: 4, limite: 10 }));
    assert.deepEqual(r, { itens: [], total: 23 });
    assert.deepEqual(executor.chamadas[0].valores.slice(-3), [10, 30, false]);
  });

  test('total zero com a lista vazia: nenhum par', async () => {
    const executor = executorFalso([{ total: 0, material_id: null }]);
    assert.deepEqual(await repo().listarPosicoes(executor, EMPRESA, base()), { itens: [], total: 0 });
  });

  test('uma página cheia traz o mesmo total em todas as linhas e devolve só os itens', async () => {
    const linhas = [1, 2, 3].map((n) => linhaDoBanco({ material_id: 30 + n, total: 3 }));
    const r = await repo().listarPosicoes(executorFalso(linhas), EMPRESA, base());
    assert.equal(r.total, 3);
    assert.deepEqual(r.itens.map((i) => i.materialId), [31, 32, 33]);
  });

  test('o banco não devolver nenhuma linha é erro de contrato, não "zero itens"', async () => {
    await assert.rejects(() => repo().listarPosicoes(executorFalso([]), EMPRESA, base()), /total/i);
  });
});

describe('resumirPosicoes — a agregação do Dashboard sobre o mesmo universo', () => {
  const resumo = { pares: '5', fisico_utilizavel: '30', demanda_pendente: '9', comprometido: '8', saldo_livre: '22', sem_cobertura: '1', pares_abaixo_do_minimo: '2', deficit: '6', necessidade: '7' };

  test('uma consulta de leitura, sem paginação, sobre o mesmo universo, e os números viram inteiros', async () => {
    const executor = executorFalso([resumo]);
    const r = await repo().resumirPosicoes(executor, EMPRESA, { hoje: HOJE });
    assert.equal(executor.chamadas.length, 1);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /^WITH\b/);
    assert.doesNotMatch(texto, /LIMIT|OFFSET|\b(INSERT|UPDATE|DELETE)\b/i);
    assert.match(texto, /FROM estoque_minimos em/);
    assert.deepEqual(valores, [EMPRESA, HOJE]);
    assert.deepEqual(r, {
      pares: 5, fisicoUtilizavel: 30, demandaPendente: 9, comprometido: 8, saldoLivre: 22, semCobertura: 1, paresAbaixoDoMinimo: 2, deficit: 6, necessidade: 7,
    });
  });

  test('entradas inválidas são erro de programação', async () => {
    const executor = executorFalso([resumo]);
    await assert.rejects(() => repo().resumirPosicoes(executor, 0, { hoje: HOJE }), TypeError);
    await assert.rejects(() => repo().resumirPosicoes(executor, EMPRESA, { hoje: '2026-02-30' }), TypeError);
    await assert.rejects(() => repo().resumirPosicoes(executor, EMPRESA), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('listarPosicoesDoMaterial (12D-2) — a posição dos pares de UM material, para o contexto da entrega', () => {
  const MATERIAL = 30;
  const linhaDoMaterial = (extra = {}) => ({
    tamanho_chave: 'P', fisico_utilizavel: '5', comprometido: '2', saldo_livre: '3', sem_cobertura: '0', minimo_efetivo: 5, minimo_origem: 'PROPRIO', abaixo_do_minimo: true, ...extra,
  });

  test('uma consulta de leitura, com o material como $3 já nas fontes (lotes, demanda, mínimo e universo), empresa em cada uma', async () => {
    const executor = executorFalso([linhaDoMaterial()]);
    await repo().listarPosicoesDoMaterial(executor, EMPRESA, MATERIAL, { hoje: HOJE });
    assert.equal(executor.chamadas.length, 1);
    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [EMPRESA, HOJE, MATERIAL]);
    assert.doesNotMatch(texto, /\b(INSERT|UPDATE|DELETE)\b/i);
    assert.match(texto, /WHERE l\.empresa_id = \$1 AND m\.ativo\s+AND l\.material_id = \$3/);
    assert.match(texto, /WHERE i\.empresa_id = \$1 AND i\.decisao = 'APROVADO' AND i\.material_id = \$3/);
    assert.match(texto, /WHERE em\.empresa_id = \$1\s+AND em\.material_id = \$3/);
    assert.match(texto, /WHERE m\.empresa_id = \$1 AND m\.ativo AND m\.id = \$3 AND m\.exige_tamanho = false/);
    assert.match(texto, /ORDER BY tamanho_chave/);
  });

  test('o item é só a posição agregada do par: sem solicitação, sem demanda por pessoa e sem validade', async () => {
    const executor = executorFalso([linhaDoMaterial(), linhaDoMaterial({ tamanho_chave: '', minimo_origem: 'PADRAO', minimo_efetivo: 0, abaixo_do_minimo: false })]);
    const itens = await repo().listarPosicoesDoMaterial(executor, EMPRESA, MATERIAL, { hoje: HOJE });
    assert.deepEqual(itens[0], {
      tamanho: 'P', fisicoUtilizavel: 5, comprometido: 2, saldoLivre: 3, semCobertura: 0, estoqueMinimo: 5, minimoOrigem: 'PROPRIO', abaixoDoMinimo: true,
    });
    assert.equal(itens[1].tamanho, null, 'o tamanho vazio da chave é tamanho ausente');
    assert.deepEqual(Object.keys(itens[0]).sort(), ['abaixoDoMinimo', 'comprometido', 'estoqueMinimo', 'fisicoUtilizavel', 'minimoOrigem', 'saldoLivre', 'semCobertura', 'tamanho']);
  });

  test('material sem nenhum par (inativo ou sem lote, demanda nem mínimo): lista vazia', async () => {
    assert.deepEqual(await repo().listarPosicoesDoMaterial(executorFalso([]), EMPRESA, MATERIAL, { hoje: HOJE }), []);
  });

  test('entradas inválidas são erro de programação, antes de consultar', async () => {
    const executor = executorFalso([]);
    for (const [e, m] of [[0, MATERIAL], [EMPRESA, 0], [EMPRESA, 1.5], ['42', MATERIAL], [EMPRESA, null]]) {
      await assert.rejects(() => repo().listarPosicoesDoMaterial(executor, e, m, { hoje: HOJE }), TypeError, JSON.stringify([e, m]));
    }
    await assert.rejects(() => repo().listarPosicoesDoMaterial(executor, EMPRESA, MATERIAL, { hoje: '2026-02-30' }), TypeError);
    await assert.rejects(() => repo().listarPosicoesDoMaterial(executor, EMPRESA, MATERIAL), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });
});
