'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const servico = require('../../src/services/entrega-epi.service');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Parte pura do serviço de entrega, sem PostgreSQL: a validação recusa a
 * requisição antes de abrir transação; o hash da requisição lógica é
 * canônico; o hash de conteúdo é determinístico e exclui a si mesmo. O
 * fluxo transacional inteiro é provado com banco real em
 * test/integracao/entrega-epi-service.integration.js.
 */

const CHAVE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const DECLARACAO = 'Declaro que recebi os EPIs relacionados (texto fictício).';
const TRACOS = [[[10, 10], [20, 12]], [[40, 40]]];
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };

const poolFechado = { connect: async () => { throw new Error('não deve abrir transação'); }, query: async () => { throw new Error('não deve consultar'); } };
const item = (extra = {}) => ({ materialId: 30, loteId: 7, quantidade: 1, motivo: 'ADMISSAO', ...extra });
const dados = (extra = {}) => ({
  empresaId: 42, atorId: 7, funcionarioId: 5, itens: [item()], confirmacao: ACEITE, chaveIdempotencia: CHAVE, ...extra,
});

async function esperarValidacao(promessa, campo, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.deepEqual([erro.status, erro.codigo], [400, 'VALIDACAO']);
    assert.ok(erro.detalhes.some((d) => d.campo === campo && d.codigo === codigo), JSON.stringify(erro.detalhes));
    for (const detalhe of erro.detalhes) {
      assert.deepEqual(Object.keys(detalhe).sort(), ['campo', 'codigo', 'mensagem']);
    }
    return true;
  });
}

describe('registrarEntrega — validação antes de qualquer acesso ao banco', () => {
  test('identificadores da sessão e do trabalhador precisam ser inteiros positivos', async () => {
    for (const extra of [{ empresaId: 0 }, { atorId: -1 }, { funcionarioId: 1.5 }, { funcionarioId: '5' }]) {
      await assert.rejects(servico.registrarEntrega(poolFechado, dados(extra)), TypeError);
    }
  });

  test('itens: lista de 1 a 20, sem lote repetido; quantidade inteira positiva dentro do INTEGER; motivo da lista; OUTRO com justificativa', async () => {
    const muitos = Array.from({ length: 21 }, (_, i) => item({ loteId: i + 1 }));
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [] })), 'body.itens', 'ITENS_FORA_DO_LIMITE');
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: muitos })), 'body.itens', 'ITENS_FORA_DO_LIMITE');
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: 'x' })), 'body.itens', 'ITENS_FORA_DO_LIMITE');
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [item(), item({ quantidade: 3 })] })), 'body.itens', 'LOTE_REPETIDO');
    for (const quantidade of [0, -1, 1.5, '1', 2147483648]) {
      await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [item({ quantidade })] })), 'body.itens[0].quantidade', 'QUANTIDADE_INVALIDA');
    }
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [item({ materialId: 0 })] })), 'body.itens[0].materialId', 'FORMATO_INVALIDO');
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [item({ loteId: 'a' })] })), 'body.itens[0].loteId', 'FORMATO_INVALIDO');
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [item({ motivo: 'TROCA' })] })), 'body.itens[0].motivo', 'VALOR_NAO_PERMITIDO');
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [item({ motivo: 'OUTRO' })] })), 'body.itens[0].justificativa', 'JUSTIFICATIVA_OBRIGATORIA');
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [item({ justificativa: 'x'.repeat(501) })] })), 'body.itens[0].justificativa', 'JUSTIFICATIVA_INVALIDA');
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [item({ justificativa: 'com\u0007controle' })] })), 'body.itens[0].justificativa', 'JUSTIFICATIVA_INVALIDA');
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [item({ justificativaForaGhe: '   ' })] })), 'body.itens[0].justificativaForaGhe', 'JUSTIFICATIVA_INVALIDA');
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ itens: [item({ justificativaForaGhe: 'y'.repeat(501) })] })), 'body.itens[0].justificativaForaGhe', 'JUSTIFICATIVA_INVALIDA');
  });

  test('confirmação: modo da lista; DESENHO exige traços válidos; ACEITE_PRESENCIAL recusa traços; declaração versão e texto validados', async () => {
    const com = (confirmacao) => servico.registrarEntrega(poolFechado, dados({ confirmacao }));
    await esperarValidacao(com({ ...ACEITE, modo: 'BIOMETRIA' }), 'body.confirmacao.modo', 'VALOR_NAO_PERMITIDO');
    await esperarValidacao(com({ ...ACEITE, tracos: TRACOS }), 'body.confirmacao.tracos', 'TRACOS_NAO_SE_APLICAM');
    await esperarValidacao(com({ ...ACEITE, modo: 'DESENHO' }), 'body.confirmacao.tracos', 'TRACOS_OBRIGATORIOS');
    const desenho = (tracos) => com({ ...ACEITE, modo: 'DESENHO', tracos });
    for (const tracos of [[], [[]], 'abc', { a: 1 }, [[[1]]], [[[1, 2, 3]]], [[[-1, 2]]], [[[10001, 2]]], [[[1.5, 2]]], [[['1', 2]]], [[[1, 2]], 'x']]) {
      await esperarValidacao(desenho(tracos), 'body.confirmacao.tracos', 'TRACOS_INVALIDOS');
    }
    await esperarValidacao(desenho(Array.from({ length: 65 }, () => [[1, 1]])), 'body.confirmacao.tracos', 'TRACOS_INVALIDOS');
    await esperarValidacao(desenho([Array.from({ length: 2001 }, (_, i) => [i % 100, i % 100])]), 'body.confirmacao.tracos', 'TRACOS_INVALIDOS');
    await esperarValidacao(com({ ...ACEITE, declaracaoVersao: 'nr6' }), 'body.confirmacao.declaracaoVersao', 'FORMATO_INVALIDO');
    await esperarValidacao(com({ ...ACEITE, declaracaoVersao: 'A'.repeat(31) }), 'body.confirmacao.declaracaoVersao', 'FORMATO_INVALIDO');
    for (const declaracaoTexto of ['', ' x', 'x ', 'a\u0000b', 'x'.repeat(4001), null, 5]) {
      await esperarValidacao(com({ ...ACEITE, declaracaoTexto }), 'body.confirmacao.declaracaoTexto', 'DECLARACAO_INVALIDA');
    }
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ confirmacao: null })), 'body.confirmacao', 'FORMATO_INVALIDO');
  });

  test('chave de idempotência precisa ser UUID', async () => {
    await esperarValidacao(servico.registrarEntrega(poolFechado, dados({ chaveIdempotencia: 'abc' })), 'body.chaveIdempotencia', 'FORMATO_INVALIDO');
  });
});

describe('hashDaRequisicao — requisição lógica canônica', () => {
  const requisicao = (extra = {}) => ({
    funcionarioId: 5,
    itens: [item({ loteId: 9, materialId: 31, quantidade: 2, motivo: 'DESGASTE_DANO' }), item({ loteId: 7, justificativaForaGhe: 'Visita' })],
    confirmacao: { modo: 'DESENHO', tracos: TRACOS, declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO },
    ...extra,
  });

  test('a ordem dos itens recebida não muda o hash; qualquer conteúdo muda', () => {
    const base = servico.hashDaRequisicao(requisicao());
    assert.match(base, /^[0-9a-f]{64}$/);
    const invertida = requisicao();
    invertida.itens.reverse();
    assert.equal(servico.hashDaRequisicao(invertida), base);
    const variacoes = [
      requisicao({ funcionarioId: 6 }),
      requisicao({ itens: [item({ loteId: 9, materialId: 31, quantidade: 3, motivo: 'DESGASTE_DANO' }), item({ loteId: 7, justificativaForaGhe: 'Visita' })] }),
      requisicao({ itens: [item({ loteId: 9, materialId: 31, quantidade: 2, motivo: 'PERDA_EXTRAVIO' }), item({ loteId: 7, justificativaForaGhe: 'Visita' })] }),
      requisicao({ itens: [item({ loteId: 9, materialId: 31, quantidade: 2, motivo: 'DESGASTE_DANO' }), item({ loteId: 7, justificativaForaGhe: 'Outra' })] }),
      requisicao({ confirmacao: { modo: 'ACEITE_PRESENCIAL', tracos: null, declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO } }),
      requisicao({ confirmacao: { modo: 'DESENHO', tracos: [[[10, 10]]], declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO } }),
      requisicao({ confirmacao: { modo: 'DESENHO', tracos: TRACOS, declaracaoVersao: 'NR6-2026-10', declaracaoTexto: DECLARACAO } }),
      requisicao({ confirmacao: { modo: 'DESENHO', tracos: TRACOS, declaracaoVersao: 'NR6-2026-09', declaracaoTexto: `${DECLARACAO}!` } }),
    ];
    const hashes = new Set(variacoes.map((v) => servico.hashDaRequisicao(v)));
    assert.equal(hashes.size, variacoes.length);
    assert.equal(hashes.has(base), false);
  });

  test('a chave de idempotência, o ator, o IP e o dispositivo não entram no hash', () => {
    const a = servico.hashDaRequisicao({ ...requisicao(), chaveIdempotencia: CHAVE, atorId: 1, ip: '203.0.113.1', dispositivo: 'A' });
    const b = servico.hashDaRequisicao({ ...requisicao(), chaveIdempotencia: crypto.randomUUID(), atorId: 2, ip: '203.0.113.2', dispositivo: 'B' });
    assert.equal(a, b);
  });
});

describe('calcularHashConteudo — checksum do conteúdo histórico', () => {
  const entrega = () => ({
    id: 10, empresaId: 42, fichaId: 3, responsavelId: 7, gheId: 2, origem: 'DIRETA',
    entregueEmCanonico: '2026-09-30T18:00:00.123456Z', dataOperacional: '2026-09-30', chaveIdempotencia: CHAVE,
    empresa: { nome: 'Empresa', cnpj: '11222333000181', endereco: 'Rua', cidade: 'Cidade', uf: 'SP' },
    trabalhador: { nome: 'Trabalhador', matricula: 'M-1', funcao: 'Operador', setor: 'Produção' },
    ghe: { id: 2, nome: 'GHE' },
    responsavel: { id: 7, nome: 'Responsável' },
  });
  const itens = () => [{
    id: 100, materialId: 30, loteId: 7, quantidade: 2, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null,
    material: { nome: 'Botina', tipo: 'Calçado', codigoInterno: 'BOT-01', unidade: 'par', prazoUsoDias: 180, oculosComGrau: null, exigeCa: true },
    lote: { tamanho: '40', caNumero: '12345', caValidade: '2099-12-31' }, operacaoId: '900',
  }];
  const confirmacao = (extra = {}) => ({
    modo: 'DESENHO', tracos: TRACOS, declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO, hashConteudo: 'a'.repeat(64), confirmadaEm: new Date(), ...extra,
  });
  const ficha = () => ({ id: 3, numero: 12, funcionarioId: 5 });

  test('determinístico, hexadecimal de 64, sensível ao conteúdo histórico e indiferente ao próprio hash e ao id da operação', () => {
    const base = servico.calcularHashConteudo({ entrega: entrega(), ficha: ficha(), itens: itens(), confirmacao: confirmacao() });
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(base, servico.calcularHashConteudo({ entrega: entrega(), ficha: ficha(), itens: itens(), confirmacao: confirmacao({ hashConteudo: 'b'.repeat(64), confirmadaEm: new Date(0) }) }));
    const itemComOutraOperacao = [{ ...itens()[0], operacaoId: '901' }];
    assert.equal(base, servico.calcularHashConteudo({ entrega: entrega(), ficha: ficha(), itens: itemComOutraOperacao, confirmacao: confirmacao() }));

    const variacoes = [
      { entrega: { ...entrega(), dataOperacional: '2026-10-01' } },
      { entrega: { ...entrega(), entregueEmCanonico: '2026-09-30T18:00:00.123457Z' } },
      { entrega: { ...entrega(), empresa: { ...entrega().empresa, cnpj: '44555666000162' } } },
      { entrega: { ...entrega(), trabalhador: { ...entrega().trabalhador, setor: 'Outro' } } },
      { entrega: { ...entrega(), ghe: null } },
      { entrega: { ...entrega(), responsavel: { id: 8, nome: 'Outro' } } },
      { ficha: { ...ficha(), numero: 13 } },
      { itens: [{ ...itens()[0], quantidade: 3 }] },
      { itens: [{ ...itens()[0], lote: { ...itens()[0].lote, caValidade: '2030-01-01' } }] },
      { itens: [{ ...itens()[0], material: { ...itens()[0].material, prazoUsoDias: 90 } }] },
      { itens: [{ ...itens()[0], justificativaForaGhe: 'x', previstoNoGhe: false }] },
      { confirmacao: confirmacao({ modo: 'ACEITE_PRESENCIAL', tracos: null }) },
      { confirmacao: confirmacao({ tracos: [[[1, 1]]] }) },
      { confirmacao: confirmacao({ declaracaoVersao: 'NR6-2026-10' }) },
      { confirmacao: confirmacao({ declaracaoTexto: 'Outro texto' }) },
    ];
    const hashes = new Set(variacoes.map((v) => servico.calcularHashConteudo({ entrega: entrega(), ficha: ficha(), itens: itens(), confirmacao: confirmacao(), ...v })));
    assert.equal(hashes.size, variacoes.length);
    assert.equal(hashes.has(base), false);
  });
});
