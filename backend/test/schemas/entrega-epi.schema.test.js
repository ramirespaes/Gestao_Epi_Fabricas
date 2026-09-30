'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const schemas = require('../../src/schemas/entrega-epi.schema');

/**
 * Schemas das rotas da entrega de EPI (10E/10F): estritos, só formato. O
 * serviço transacional revalida tudo de novo, de propósito.
 */

const CHAVE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const DECLARACAO = 'Declaro que recebi os EPIs relacionados (texto fictício).';
const TRACOS = [[[10, 10], [20, 12]], [[40, 40]]];
const item = (extra = {}) => ({ materialId: 30, loteId: 7, quantidade: 1, motivo: 'ADMISSAO', ...extra });
const aceite = (extra = {}) => ({ modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO, ...extra });
const corpo = (extra = {}) => ({ funcionarioId: 5, itens: [item()], confirmacao: aceite(), chaveIdempotencia: CHAVE, ...extra });

const parse = (c) => schemas.registrar.body.safeParse(c);
const codigosDe = (r) => r.error.issues.map((i) => [i.path.join('.'), i.code === 'custom' ? i.params?.codigo : i.code]);
const recusa = (c, caminho, codigo) => {
  const r = parse(c);
  assert.equal(r.success, false, JSON.stringify(c).slice(0, 80));
  assert.ok(codigosDe(r).some(([p, cod]) => p === caminho && cod === codigo), JSON.stringify(codigosDe(r)));
};

describe('registrar.body — estrito', () => {
  test('corpo válido com 1 item e ACEITE_PRESENCIAL: aceito, chave em minúsculas, justificativas ausentes ficam ausentes', () => {
    const r = parse(corpo({ chaveIdempotencia: CHAVE.toUpperCase() }));
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.deepEqual(r.data, corpo());
  });

  test('20 itens aceitos; 0 e 21 recusados; lote repetido recusado', () => {
    const itens = (n) => Array.from({ length: n }, (_, i) => item({ loteId: i + 1 }));
    assert.equal(parse(corpo({ itens: itens(20) })).success, true);
    recusa(corpo({ itens: [] }), 'itens', 'too_small');
    recusa(corpo({ itens: itens(21) }), 'itens', 'too_big');
    recusa(corpo({ itens: [item(), item({ quantidade: 2 })] }), 'itens', 'LOTE_REPETIDO');
  });

  test('campos desconhecidos e campos do servidor são recusados (empresaId, atorId, responsavelId, origem, entregueEm, dataOperacional, fichaId, snapshots, previstoNoGhe, hashConteudo, requisicaoHash, ip, userAgent)', () => {
    for (const [chave, valor] of [
      ['empresaId', 1], ['atorId', 1], ['usuarioId', 1], ['responsavelId', 1], ['origem', 'DIRETA'], ['entregueEm', '2026-09-30T12:00:00Z'],
      ['dataOperacional', '2026-09-30'], ['fichaId', 1], ['numeroFicha', 1], ['empresa', { nome: 'x' }], ['trabalhador', { nome: 'x' }],
      ['hashConteudo', 'a'.repeat(64)], ['requisicaoHash', 'a'.repeat(64)], ['ip', '1.1.1.1'], ['userAgent', 'x'], ['extra', true],
    ]) {
      recusa(corpo({ [chave]: valor }), '', 'unrecognized_keys');
    }
    recusa(corpo({ itens: [item({ previstoNoGhe: true })] }), 'itens.0', 'unrecognized_keys');
    recusa(corpo({ itens: [item({ material: { nome: 'x' } })] }), 'itens.0', 'unrecognized_keys');
    recusa(corpo({ confirmacao: aceite({ ip: '1.1.1.1' }) }), 'confirmacao', 'unrecognized_keys');
    recusa(corpo({ confirmacao: aceite({ hashConteudo: 'a'.repeat(64) }) }), 'confirmacao', 'unrecognized_keys');
  });

  test('funcionarioId, materialId e loteId: inteiros positivos no corpo', () => {
    recusa(corpo({ funcionarioId: 0 }), 'funcionarioId', 'ID_INVALIDO');
    recusa(corpo({ funcionarioId: '5' }), 'funcionarioId', 'invalid_type');
    recusa(corpo({ itens: [item({ materialId: 1.5 })] }), 'itens.0.materialId', 'ID_INVALIDO');
    recusa(corpo({ itens: [item({ loteId: -1 })] }), 'itens.0.loteId', 'ID_INVALIDO');
    const { funcionarioId, ...semFuncionario } = corpo();
    recusa(semFuncionario, 'funcionarioId', 'invalid_type');
  });

  test('quantidade: inteiro positivo até o INTEGER do PostgreSQL', () => {
    recusa(corpo({ itens: [item({ quantidade: 0 })] }), 'itens.0.quantidade', 'too_small');
    recusa(corpo({ itens: [item({ quantidade: 1.5 })] }), 'itens.0.quantidade', 'invalid_type');
    recusa(corpo({ itens: [item({ quantidade: 2147483648 })] }), 'itens.0.quantidade', 'too_big');
    assert.equal(parse(corpo({ itens: [item({ quantidade: 2147483647 })] })).success, true);
  });

  test('motivo da lista; OUTRO exige justificativa; justificativas aparadas até 500, sem controle', () => {
    recusa(corpo({ itens: [item({ motivo: 'TROCA' })] }), 'itens.0.motivo', 'invalid_value');
    recusa(corpo({ itens: [item({ motivo: 'OUTRO' })] }), 'itens.0.justificativa', 'JUSTIFICATIVA_OBRIGATORIA');
    recusa(corpo({ itens: [item({ motivo: 'OUTRO', justificativa: '' })] }), 'itens.0.justificativa', 'JUSTIFICATIVA_INVALIDA');
    recusa(corpo({ itens: [item({ justificativa: 'x'.repeat(501) })] }), 'itens.0.justificativa', 'JUSTIFICATIVA_INVALIDA');
    recusa(corpo({ itens: [item({ justificativaForaGhe: 'a\u0007b' })] }), 'itens.0.justificativaForaGhe', 'JUSTIFICATIVA_INVALIDA');
    for (const motivo of ['ADMISSAO', 'SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO', 'OUTRO']) {
      const r = parse(corpo({ itens: [item({ motivo, justificativa: ' Justificativa ', justificativaForaGhe: ' Visita ' })] }));
      assert.equal(r.success, true, motivo);
      assert.deepEqual([r.data.itens[0].justificativa, r.data.itens[0].justificativaForaGhe], ['Justificativa', 'Visita']);
    }
  });

  test('chave de idempotência: UUID', () => {
    recusa(corpo({ chaveIdempotencia: 'abc' }), 'chaveIdempotencia', 'invalid_format');
    const { chaveIdempotencia, ...semChave } = corpo();
    recusa(semChave, 'chaveIdempotencia', 'invalid_type');
  });

  test('confirmação: ausente, nula ou com modo desconhecido é recusada', () => {
    const { confirmacao, ...semConfirmacao } = corpo();
    recusa(semConfirmacao, 'confirmacao', 'invalid_type');
    recusa(corpo({ confirmacao: null }), 'confirmacao', 'invalid_type');
    recusa(corpo({ confirmacao: aceite({ modo: 'BIOMETRIA' }) }), 'confirmacao.modo', 'invalid_value');
  });

  test('DESENHO exige traços válidos; ACEITE_PRESENCIAL recusa traços', () => {
    assert.equal(parse(corpo({ confirmacao: aceite({ modo: 'DESENHO', tracos: TRACOS }) })).success, true);
    recusa(corpo({ confirmacao: aceite({ modo: 'DESENHO' }) }), 'confirmacao.tracos', 'TRACOS_OBRIGATORIOS');
    recusa(corpo({ confirmacao: aceite({ modo: 'DESENHO', tracos: null }) }), 'confirmacao.tracos', 'TRACOS_OBRIGATORIOS');
    recusa(corpo({ confirmacao: aceite({ tracos: TRACOS }) }), 'confirmacao.tracos', 'TRACOS_NAO_SE_APLICAM');
    for (const tracos of [[], [[]], 'abc', { a: 1 }, [[[1]]], [[[1, 2, 3]]], [[[-1, 2]]], [[[10001, 2]]], [[[1.5, 2]]], [[['1', 2]]]]) {
      const r = parse(corpo({ confirmacao: aceite({ modo: 'DESENHO', tracos }) }));
      assert.equal(r.success, false, JSON.stringify(tracos));
      assert.ok(codigosDe(r).every(([p]) => p.startsWith('confirmacao.tracos')), JSON.stringify(codigosDe(r)));
    }
    recusa(corpo({ confirmacao: aceite({ modo: 'DESENHO', tracos: Array.from({ length: 65 }, () => [[1, 1]]) }) }), 'confirmacao.tracos', 'TRACOS_INVALIDOS');
    recusa(corpo({ confirmacao: aceite({ modo: 'DESENHO', tracos: [Array.from({ length: 1501 }, (_, i) => [i % 100, i % 100])] }) }), 'confirmacao.tracos', 'TRACOS_INVALIDOS');
  });

  test('declaracaoVersao no formato; declaracaoTexto exato de 1 a 4000 caracteres, sem controle além de quebra de linha', () => {
    recusa(corpo({ confirmacao: aceite({ declaracaoVersao: 'nr6 2026' }) }), 'confirmacao.declaracaoVersao', 'FORMATO_INVALIDO');
    recusa(corpo({ confirmacao: aceite({ declaracaoVersao: 'A'.repeat(31) }) }), 'confirmacao.declaracaoVersao', 'FORMATO_INVALIDO');
    for (const declaracaoTexto of ['', '   ', ' x', 'x ', 'a\tb', 'a\u0000b', 'x'.repeat(4001), '\u{1D400}'.repeat(4001)]) {
      recusa(corpo({ confirmacao: aceite({ declaracaoTexto }) }), 'confirmacao.declaracaoTexto', 'DECLARACAO_INVALIDA');
    }
    const comQuebra = 'Linha 1\nLinha 2';
    assert.equal(parse(corpo({ confirmacao: aceite({ declaracaoTexto: comQuebra }) })).data.confirmacao.declaracaoTexto, comQuebra);
    const astral = '\u{1D400}'.repeat(4000);
    const r = parse(corpo({ confirmacao: aceite({ declaracaoTexto: astral }) }));
    assert.equal(r.success, true, 'exatamente 4000 caracteres fora do BMP');
    assert.equal(r.data.confirmacao.declaracaoTexto, astral);
    assert.equal(parse(corpo({ confirmacao: aceite({ declaracaoTexto: 'x'.repeat(4000) }) })).success, true);
  });
});

describe('contexto e consultas — params, query e body estritos', () => {
  test('contexto: funcionarioId e materialId de rota são inteiros canônicos; a query de materiais é paginada e estrita', () => {
    assert.deepEqual(schemas.contexto.params.safeParse({ funcionarioId: '12' }).data, { funcionarioId: 12 });
    assert.equal(schemas.contexto.params.safeParse({ funcionarioId: '0' }).success, false);
    assert.deepEqual(schemas.contextoLotes.params.safeParse({ funcionarioId: '12', materialId: '3' }).data, { funcionarioId: 12, materialId: 3 });
    assert.deepEqual(schemas.contextoMateriais.query.safeParse({}).data, { pagina: 1, limite: 20 });
    assert.deepEqual(schemas.contextoMateriais.query.safeParse({ busca: ' Bot ', previstoNoGhe: 'true', pagina: '2', limite: '5' }).data, { busca: 'Bot', previstoNoGhe: true, pagina: 2, limite: 5 });
    assert.equal(schemas.contextoMateriais.query.safeParse({ empresaId: '1' }).success, false);
    assert.equal(schemas.contextoMateriais.query.safeParse({ previstoNoGhe: 'sim' }).success, false);
  });

  test('fichas: query estrita, sem CPF, com filtros opcionais e período coerente', () => {
    const q = (v) => schemas.fichas.query.safeParse(v);
    assert.deepEqual(q({}).data, { pagina: 1, limite: 20 });
    const completa = q({ busca: 'Bot', numero: '3', funcionarioId: '5', materialId: '7', ativo: 'false', de: '2026-09-01', ate: '2026-09-30', pagina: '1', limite: '10' });
    assert.deepEqual(completa.data, { busca: 'Bot', numero: 3, funcionarioId: 5, materialId: 7, ativo: false, de: '2026-09-01', ate: '2026-09-30', pagina: 1, limite: 10 });
    assert.equal(q({ cpf: '52998224725' }).success, false);
    assert.equal(q({ empresaId: '1' }).success, false);
    const invertido = q({ de: '2026-09-30', ate: '2026-09-01' });
    assert.equal(invertido.success, false);
    assert.ok(invertido.error.issues.some((i) => i.params?.codigo === 'PERIODO_INVERTIDO'));
    assert.equal(q({ numero: '0' }).success, false);
    assert.equal(q({ de: '2026-02-30' }).success, false);
  });

  test('consulta por CPF: só o CPF, no corpo, normalizado e com dígitos verificadores', () => {
    assert.deepEqual(schemas.consultaCpf.body.safeParse({ cpf: '529.982.247-25' }).data, { cpf: '52998224725' });
    assert.equal(schemas.consultaCpf.body.safeParse({ cpf: '52998224726' }).success, false);
    assert.equal(schemas.consultaCpf.body.safeParse({ cpf: '52998224725', empresaId: 1 }).success, false);
    assert.equal(schemas.consultaCpf.body.safeParse({}).success, false);
  });

  test('entregas da ficha: período e paginação; id de rota', () => {
    assert.deepEqual(schemas.fichaEntregas.query.safeParse({}).data, { pagina: 1, limite: 20 });
    assert.equal(schemas.fichaEntregas.query.safeParse({ de: '2026-09-30', ate: '2026-09-01' }).success, false);
    assert.deepEqual(schemas.porId.params.safeParse({ id: '9' }).data, { id: 9 });
    assert.equal(schemas.porId.params.safeParse({ id: 'abc' }).success, false);
  });
});
