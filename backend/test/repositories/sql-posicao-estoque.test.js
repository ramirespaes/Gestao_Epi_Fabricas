'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Fragmentos de SQL da definição única de "utilizável" e da demanda pendente
 * (12D-1). Funções puras: recebem os ALIASES das tabelas e a REFERÊNCIA dos
 * parâmetros (`$n`) que a consulta que os usa declarou, e devolvem texto. Nada
 * assume `$1`, `$2` ou `$3`: cada consulta tem o seu contrato de parâmetros, e
 * a reutilização não pode deslocar nem colidir placeholders. Aliases e
 * referências são validados, porque entram direto no texto do SQL.
 */

const sql = () => exigirModulo('src/repositories/sql/posicao-estoque');
const normalizar = (texto) => texto.replace(/\s+/g, ' ').trim();
const placeholders = (texto) => [...new Set(texto.match(/\$\d+/g) ?? [])];

const LOTE = { lote: 'l', material: 'm', hoje: '$2' };

describe('o módulo é puro: sem dependência de repository (nada de dependência circular)', () => {
  test('não tem nenhum require', () => {
    sql();
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'repositories', 'sql', 'posicao-estoque.js'), 'utf8');
    assert.equal(/require\(/.test(fonte), false);
  });
});

describe('bloqueio por CA e físico utilizável', () => {
  test('bloqueadoPorCa: material que exige CA com CA ausente ou vencido na data (o mesmo predicado de sempre)', () => {
    assert.equal(
      normalizar(sql().bloqueadoPorCa(LOTE)),
      'm.exige_ca AND (l.ca_validade IS NULL OR l.ca_validade < $2::date)',
    );
  });

  test('fisicoUtilizavel: o saldo, ou zero se o lote está bloqueado', () => {
    assert.equal(
      normalizar(sql().fisicoUtilizavel(LOTE)),
      'CASE WHEN m.exige_ca AND (l.ca_validade IS NULL OR l.ca_validade < $2::date) THEN 0 ELSE l.saldo END',
    );
  });

  test('saldoBloqueado: o saldo do lote bloqueado, ou zero (o BLOQUEADO da leitura de lotes)', () => {
    assert.equal(
      normalizar(sql().saldoBloqueado(LOTE)),
      'CASE WHEN m.exige_ca AND (l.ca_validade IS NULL OR l.ca_validade < $2::date) THEN l.saldo ELSE 0 END',
    );
  });
});

describe('situação do CA', () => {
  test('com dias de alerta: inclui A_VENCER (a leitura do estoque e a validade)', () => {
    assert.equal(
      normalizar(sql().situacaoCa({ ...LOTE, diasAlerta: '$3' })),
      "CASE WHEN NOT m.exige_ca THEN 'NAO_EXIGE_CA' WHEN l.ca_validade IS NULL THEN 'SEM_CA' WHEN l.ca_validade < $2::date THEN 'VENCIDO' "
      + "WHEN l.ca_validade = $2::date THEN 'VENCE_HOJE' WHEN l.ca_validade <= $2::date + $3::int THEN 'A_VENCER' ELSE 'VALIDO' END",
    );
  });

  test('sem dias de alerta: sem A_VENCER (o contexto da entrega), com a data no parâmetro que o chamador declarou', () => {
    assert.equal(
      normalizar(sql().situacaoCa({ lote: 'l', material: 'm', hoje: '$3' })),
      "CASE WHEN NOT m.exige_ca THEN 'NAO_EXIGE_CA' WHEN l.ca_validade IS NULL THEN 'SEM_CA' WHEN l.ca_validade < $3::date THEN 'VENCIDO' "
      + "WHEN l.ca_validade = $3::date THEN 'VENCE_HOJE' ELSE 'VALIDO' END",
    );
  });

  test('a data e os dias não podem ser o mesmo parâmetro (confusão de placeholders)', () => {
    assert.throws(() => sql().situacaoCa({ ...LOTE, diasAlerta: '$2' }), TypeError);
  });
});

describe('demanda pendente', () => {
  const ITEM = { item: 'i', solicitacao: 's', funcionario: 'f', material: 'm', entregue: 'e' };

  test('fonteDaDemanda: solicitação atendível, trabalhador e material ativos e a entregue derivada dos itens da entrega', () => {
    const texto = normalizar(sql().fonteDaDemanda(ITEM));
    assert.match(texto, /JOIN solicitacoes_epi s ON s\.empresa_id = i\.empresa_id AND s\.id = i\.solicitacao_id AND s\.status IN \('APROVADA', 'APROVADA_PARCIAL'\)/);
    assert.match(texto, /JOIN funcionarios f ON f\.empresa_id = s\.empresa_id AND f\.id = s\.funcionario_id AND f\.ativo/);
    assert.match(texto, /JOIN materiais m ON m\.empresa_id = i\.empresa_id AND m\.id = i\.material_id AND m\.ativo/);
    assert.match(texto, /LEFT JOIN LATERAL \( SELECT sum\(ei\.quantidade\)::bigint AS entregue FROM entregas_epi_itens ei WHERE ei\.empresa_id = i\.empresa_id AND ei\.solicitacao_item_id = i\.id \) e ON true/);
    assert.equal(placeholders(texto).length, 0, 'a fonte da demanda não usa parâmetro: a empresa entra pela consulta que a usa');
    assert.doesNotMatch(texto, /quantidade_entregue|entregas_epi\b(?!_itens)/);
  });

  test('statusAtendiveis e entregueDoItem: as peças da demanda que a fila FIFO, com o seu próprio desenho de JOINs, também usa', () => {
    assert.equal(normalizar(sql().statusAtendiveis({ solicitacao: 's' })), "s.status IN ('APROVADA', 'APROVADA_PARCIAL')");
    assert.equal(normalizar(sql().statusAtendiveis({ solicitacao: 'so' })), "so.status IN ('APROVADA', 'APROVADA_PARCIAL')");
    assert.equal(
      normalizar(sql().entregueDoItem({ item: 'i', entregue: 'e' })),
      'LEFT JOIN LATERAL ( SELECT sum(ei.quantidade)::bigint AS entregue FROM entregas_epi_itens ei WHERE ei.empresa_id = i.empresa_id AND ei.solicitacao_item_id = i.id ) e ON true',
    );
    const completo = normalizar(sql().fonteDaDemanda(ITEM));
    assert.ok(completo.includes(normalizar(sql().entregueDoItem(ITEM))), 'a fonte completa usa a mesma peça');
    assert.ok(completo.includes(normalizar(sql().statusAtendiveis(ITEM))));
    assert.throws(() => sql().statusAtendiveis({ solicitacao: 'S;' }), TypeError);
    assert.throws(() => sql().entregueDoItem({ item: 'i' }), TypeError);
  });

  test('pendenteDoItem e itemComPendente: aprovada menos entregue, e só item que ainda falta entregar', () => {
    assert.equal(normalizar(sql().pendenteDoItem(ITEM)), 'i.quantidade_aprovada - COALESCE(e.entregue, 0)');
    assert.equal(normalizar(sql().itemComPendente(ITEM)), 'i.quantidade_aprovada > COALESCE(e.entregue, 0)');
  });

  test('os aliases são os recebidos', () => {
    const texto = normalizar(sql().fonteDaDemanda({ item: 'it', solicitacao: 'so', funcionario: 'fu', material: 'ma', entregue: 'en' }));
    assert.match(texto, /JOIN solicitacoes_epi so ON so\.empresa_id = it\.empresa_id AND so\.id = it\.solicitacao_id/);
    assert.match(texto, /JOIN funcionarios fu ON fu\.empresa_id = so\.empresa_id/);
    assert.match(texto, /JOIN materiais ma ON ma\.empresa_id = it\.empresa_id AND ma\.id = it\.material_id AND ma\.ativo/);
    assert.match(texto, /\) en ON true/);
    assert.equal(normalizar(sql().pendenteDoItem({ item: 'it', entregue: 'en' })), 'it.quantidade_aprovada - COALESCE(en.entregue, 0)');
  });
});

describe('contrato explícito de aliases e parâmetros', () => {
  test('o parâmetro da data é o que o chamador passou: nenhum outro placeholder aparece', () => {
    for (const ref of ['$1', '$2', '$7', '$12']) {
      for (const f of ['bloqueadoPorCa', 'fisicoUtilizavel', 'saldoBloqueado']) {
        assert.deepEqual(placeholders(sql()[f]({ lote: 'lt', material: 'mt', hoje: ref })), [ref], `${f} ${ref}`);
      }
      assert.deepEqual(placeholders(sql().situacaoCa({ lote: 'l', material: 'm', hoje: ref, diasAlerta: '$99' })).sort(), [ref, '$99'].sort());
      assert.deepEqual(placeholders(sql().situacaoCa({ lote: 'l', material: 'm', hoje: ref })), [ref]);
    }
  });

  test('os aliases recebidos são os usados, em todas as ocorrências', () => {
    const texto = sql().fisicoUtilizavel({ lote: 'lote_x', material: 'mat_y', hoje: '$4' });
    assert.match(texto, /mat_y\.exige_ca AND \(lote_x\.ca_validade IS NULL OR lote_x\.ca_validade < \$4::date\)/);
    assert.match(texto, /ELSE lote_x\.saldo END/);
    assert.equal(/\bl\.|\bm\./.test(texto), false, 'nenhum alias fixo vazou');
  });

  test('referência de parâmetro inválida é erro de programação: só $n com n de 1 a 999', () => {
    for (const hoje of ['2026-10-02', '$0', '$', '$a', '1', '$1; DROP TABLE x', "$1' OR '1'='1", '$1000', 2, null, undefined, '', ' $1']) {
      assert.throws(() => sql().bloqueadoPorCa({ ...LOTE, hoje }), TypeError, String(hoje));
    }
  });

  test('alias inválido é erro de programação: só identificador minúsculo simples', () => {
    for (const alias of ['L', 'l.x', 'l; DROP', '1l', '', 'l l', '"l"', null, undefined, 3]) {
      assert.throws(() => sql().bloqueadoPorCa({ ...LOTE, lote: alias }), TypeError, String(alias));
      assert.throws(() => sql().fonteDaDemanda({ item: 'i', solicitacao: 's', funcionario: 'f', material: alias, entregue: 'e' }), TypeError, String(alias));
    }
  });

  test('faltar uma chave do contrato é erro, nunca um padrão silencioso', () => {
    assert.throws(() => sql().bloqueadoPorCa({ lote: 'l', material: 'm' }), TypeError);
    assert.throws(() => sql().bloqueadoPorCa({ material: 'm', hoje: '$2' }), TypeError);
    assert.throws(() => sql().bloqueadoPorCa(), TypeError);
    assert.throws(() => sql().fonteDaDemanda({ item: 'i' }), TypeError);
  });

  test('é determinístico e sem estado: duas chamadas iguais dão o mesmo texto', () => {
    assert.equal(sql().situacaoCa({ ...LOTE, diasAlerta: '$3' }), sql().situacaoCa({ ...LOTE, diasAlerta: '$3' }));
  });
});
