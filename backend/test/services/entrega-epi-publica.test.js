'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { entregaPublica, confirmacaoPublica, funcionarioAtualPublico, fichaPublica } = require('../../src/services/entrega-epi-publica');

/**
 * Transformação pública das respostas da entrega de EPI: o que sai para o
 * cliente a partir do resultado interno do serviço e das leituras.
 */

const CONFIRMADA_EM = new Date('2026-09-30T15:00:00Z');
const ENTREGUE_EM = new Date('2026-09-30T14:59:00Z');

const interno = () => ({
  ficha: { id: 3, numero: 12, funcionarioId: 5 },
  entrega: {
    id: 10, empresaId: 42, fichaId: 3, responsavelId: 7, gheId: 2, origem: 'DIRETA', entregueEm: ENTREGUE_EM,
    entregueEmCanonico: '2026-09-30T14:59:00.000000Z', dataOperacional: '2026-09-30',
    chaveIdempotencia: '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c', requisicaoHash: 'b'.repeat(64),
    empresa: { nome: 'Empresa', cnpj: '11222333000181', endereco: 'Rua', cidade: 'Cidade', uf: 'SP' },
    trabalhador: { nome: 'Trabalhador', matricula: 'M-1', funcao: 'Operador', setor: 'Produção' },
    ghe: { id: 2, nome: 'GHE' },
    responsavel: { id: 7, nome: 'Responsável' },
  },
  itens: [{
    id: 100, empresaId: 42, entregaId: 10, materialId: 30, loteId: 7, quantidade: 2, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null,
    material: { nome: 'Botina', tipo: 'Calçado', codigoInterno: 'BOT-01', unidade: 'par', prazoUsoDias: 180, oculosComGrau: null, exigeCa: true },
    lote: { tamanho: '40', caNumero: '12345', caValidade: '2099-12-31', saldo: 98 }, operacaoId: '900',
  }],
  confirmacao: {
    entregaId: 10, empresaId: 42, modo: 'DESENHO', tracos: [[[1, 1]]], declaracaoVersao: 'NR6-2026-09', declaracaoTexto: 'Declaro.',
    confirmadaEm: CONFIRMADA_EM, ip: '203.0.113.10', dispositivo: 'Navegador', hashConteudo: 'a'.repeat(64),
  },
});

describe('entregaPublica', () => {
  test('devolve ficha, entrega histórica, itens com lote histórico sem saldo e confirmação sem IP/dispositivo; nunca chave, hash da requisição, empresaId nem IP', () => {
    const r = entregaPublica(interno());
    assert.deepEqual(r, {
      id: 10,
      ficha: { id: 3, numero: 12, funcionarioId: 5 },
      origem: 'DIRETA',
      entregueEm: ENTREGUE_EM,
      dataOperacional: '2026-09-30',
      empresa: { nome: 'Empresa', cnpj: '11222333000181', endereco: 'Rua', cidade: 'Cidade', uf: 'SP' },
      trabalhador: { nome: 'Trabalhador', matricula: 'M-1', funcao: 'Operador', setor: 'Produção' },
      ghe: { id: 2, nome: 'GHE' },
      responsavel: { id: 7, nome: 'Responsável' },
      itens: [{
        id: 100, materialId: 30, loteId: 7, quantidade: 2, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true, justificativaForaGhe: null,
        material: { nome: 'Botina', tipo: 'Calçado', codigoInterno: 'BOT-01', unidade: 'par', prazoUsoDias: 180, oculosComGrau: null, exigeCa: true },
        lote: { tamanho: '40', caNumero: '12345', caValidade: '2099-12-31' },
        operacaoId: '900',
      }],
      confirmacao: {
        modo: 'DESENHO', tracos: [[[1, 1]]], declaracaoVersao: 'NR6-2026-09', declaracaoTexto: 'Declaro.', confirmadaEm: CONFIRMADA_EM, hashConteudo: 'a'.repeat(64),
      },
    });
    const texto = JSON.stringify(r);
    for (const proibido of ['requisicaoHash', 'chaveIdempotencia', 'entregueEmCanonico', 'empresaId', '203.0.113.10', 'Navegador', 'dispositivo', '"ip"', 'saldo']) {
      assert.doesNotMatch(texto, new RegExp(proibido), proibido);
    }
  });

  test('sem GHE devolve ghe null; confirmação ausente devolve null', () => {
    const dados = interno();
    dados.entrega.ghe = null;
    dados.entrega.gheId = null;
    const r = entregaPublica({ ...dados, confirmacao: null });
    assert.deepEqual([r.ghe, r.confirmacao], [null, null]);
  });
});

describe('confirmacaoPublica e funcionarioAtualPublico', () => {
  test('confirmação pública mantém só modo, traços, declaração, instante e hash', () => {
    assert.deepEqual(Object.keys(confirmacaoPublica(interno().confirmacao)).sort(), ['confirmadaEm', 'declaracaoTexto', 'declaracaoVersao', 'hashConteudo', 'modo', 'tracos']);
  });

  test('funcionário atual sai com CPF mascarado e sem CPF completo; ficha pública só com id, número e data', () => {
    const f = funcionarioAtualPublico({
      id: 5, empresaId: 42, nome: 'Fulano', matricula: 'M-1', cpf: '52998224725', setor: 'Produção', funcao: 'Operador', ativo: true, grupoHomogeneoId: 2, telefone: '11999999999', cracha: 'C-1',
    });
    assert.deepEqual(f, { id: 5, nome: 'Fulano', matricula: 'M-1', cpfMascarado: '***.***.***-25', setor: 'Produção', funcao: 'Operador', ativo: true });
    assert.deepEqual(fichaPublica({ id: 3, empresaId: 42, numero: 12, funcionarioId: 5, criadaEm: CONFIRMADA_EM }), { id: 3, numero: 12, funcionarioId: 5, criadaEm: CONFIRMADA_EM });
    assert.equal(fichaPublica(null), null);
  });
});
