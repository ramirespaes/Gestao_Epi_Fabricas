'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const servico = require('../../src/services/material.service');
const materialRepo = require('../../src/repositories/material.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — associação da imagem no SERVIÇO DE MATERIAIS, sem PostgreSQL. Contrato: `imagem` ausente = não toca em
 * nada de imagem; `null` remove; `{origem,id}` associa DEPOIS de travar o material e a imagem (FOR SHARE), na mesma transação; imagem de outra
 * empresa/inexistente/inativa = 404 IMAGEM_NAO_ENCONTRADA uniforme; a empresa da consulta é a do contexto. Complementa material.service.test.js, que
 * NÃO muda (regressão obrigatória: o serviço sem imagem se comporta como hoje).
 */

const imagemEmpresaRepo = () => exigirModulo('src/repositories/imagem-empresa.repository');
const imagemPadraoRepo = () => exigirModulo('src/repositories/imagem-padrao.repository');
const vinculoRepo = () => exigirModulo('src/repositories/material-imagem.repository');

const EMPRESA = 42;
const ATOR = 7;
const MATERIAL_ID = 30;
const CLS = { categoria: 'Outros', categoriaDescricao: 'Item de teste', tipo: 'Outros', tipoDescricao: 'Item de teste' };

const material = (extra = {}) => ({
  id: MATERIAL_ID, empresaId: EMPRESA, nome: 'Botina', tipo: 'Outros', tipoDescricao: 'Item de teste', fabricante: null, prazoUsoDias: 365, unidade: 'par', estoqueMinimo: 5,
  ativo: true, exigeTamanho: false, categoria: 'Outros', modeloClassificacao: 'V2', categoriaDescricao: 'Item de teste', grupoProtecao: null, grupoProtecaoDescricao: null,
  tipoMaterialId: null, criadoEm: new Date(), atualizadoEm: new Date(), ...extra,
});

function clienteFalso(ordem) {
  return {
    query: async (texto) => { ordem.push(texto); return { rows: [], rowCount: 0 }; },
    release: () => { ordem.push('RELEASE'); },
  };
}
const poolFalso = (cliente) => ({ connect: async () => cliente, query: (...a) => cliente.query(...a) });

/** `imagemEmpresa` / `imagemPadrao`: o que o repositório devolve para a trava FOR SHARE (null = não existe NESTA empresa). */
function mundo(t, ordem, { existente = material(), imagemEmpresa = { id: '9', estado: 'ATIVA', versao: 1, nome: 'Img' }, imagemPadrao = { id: '4', ativo: true, versao: 1, nome: 'Pad' }, atual = null } = {}) {
  const marca = (nome, valor) => async (...args) => { ordem.push(nome); return typeof valor === 'function' ? valor(...args) : valor; };
  return {
    bloqueio: t.mock.method(materialRepo, 'buscarPorIdParaAtualizacao', marca('material', existente)),
    buscarId: t.mock.method(materialRepo, 'buscarPorId', marca('materialLeitura', existente)),
    criar: t.mock.method(materialRepo, 'criar', marca('criar', (_c, d) => material({ ...d }))),
    atualizar: t.mock.method(materialRepo, 'atualizar', marca('atualizar', () => existente)),
    empresa: t.mock.method(imagemEmpresaRepo(), 'buscarPorIdParaAssociacao', marca('imagemEmpresa', imagemEmpresa)),
    padrao: t.mock.method(imagemPadraoRepo(), 'buscarPorIdParaAssociacao', marca('imagemPadrao', imagemPadrao)),
    definir: t.mock.method(vinculoRepo(), 'definir', marca('definir', undefined)),
    obter: t.mock.method(vinculoRepo(), 'obterPorMaterial', marca('obter', atual)),
    obterVarios: t.mock.method(vinculoRepo(), 'obterPorMateriais', marca('obterVarios', new Map())),
    auditoria: t.mock.method(auditoriaRepo, 'registrar', marca('auditoria', { id: '1', criadoEm: new Date() })),
  };
}
const dasImagens = (ordem) => ordem.filter((o) => ['imagemEmpresa', 'imagemPadrao', 'definir'].includes(o));
async function esperarHttp(promessa, status, codigo) {
  await assert.rejects(promessa, (e) => { assert.equal(e.status, status); assert.equal(e.codigo, codigo); return true; });
}

describe('criar com imagem', () => {
  test('imagem da empresa: material criado, imagem travada FOR SHARE (empresa do contexto), vínculo gravado, auditoria — tudo na MESMA transação e nesta ordem', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem);
    const r = await servico.criar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Botina', prazoUsoDias: 180, exigeTamanho: false, ...CLS, imagem: { origem: 'EMPRESA', id: 9 } });
    const corpo = ordem.filter((o) => ['BEGIN', 'criar', 'imagemEmpresa', 'definir', 'auditoria', 'COMMIT'].includes(o));
    assert.deepEqual(corpo, ['BEGIN', 'criar', 'imagemEmpresa', 'definir', 'auditoria', 'COMMIT']);
    assert.equal(m.empresa.mock.calls[0].arguments[1], EMPRESA);
    assert.equal(m.empresa.mock.calls[0].arguments[2], '9', 'entra 9 (inteiro seguro) ou "9"; o id BIGINT circula como texto decimal');
    assert.deepEqual(m.definir.mock.calls[0].arguments.slice(1), [EMPRESA, MATERIAL_ID, { imagemPadraoId: null, imagemEmpresaId: '9' }]);
    assert.equal(m.padrao.mock.calls.length, 0);
    assert.deepEqual(r.imagem, { origem: 'EMPRESA', id: '9', versao: 1, nome: 'Img' });
    assert.deepEqual(m.auditoria.mock.calls[0].arguments[1].dadosNovos.imagem, { origem: 'EMPRESA', id: '9' });
  });

  test('imagem PADRÃO: trava a padrão (global, sem empresa), grava só imagemPadraoId e nunca consulta a biblioteca da empresa', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem);
    await servico.criar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Botina', prazoUsoDias: 180, exigeTamanho: false, ...CLS, imagem: { origem: 'PADRAO', id: 4 } });
    assert.deepEqual(m.padrao.mock.calls[0].arguments.slice(1), ['4']);
    assert.equal(m.empresa.mock.calls.length, 0);
    assert.deepEqual(m.definir.mock.calls[0].arguments[3], { imagemPadraoId: '4', imagemEmpresaId: null });
  });

  test('imagem inexistente/outra empresa/inativa: 404 IMAGEM_NAO_ENCONTRADA, ROLLBACK, e o vínculo e a auditoria NÃO acontecem', async (t) => {
    for (const [origem, cenario] of [['EMPRESA', { imagemEmpresa: null }], ['EMPRESA', { imagemEmpresa: { id: 9, estado: 'INATIVA', versao: 1, nome: 'x' } }], ['PADRAO', { imagemPadrao: null }], ['PADRAO', { imagemPadrao: { id: 4, ativo: false, versao: 1, nome: 'x' } }]]) {
      const ordem = [];
      const m = mundo(t, ordem, cenario);
      await esperarHttp(servico.criar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Botina', prazoUsoDias: 180, exigeTamanho: false, ...CLS, imagem: { origem, id: origem === 'EMPRESA' ? 9 : 4 } }), 404, 'IMAGEM_NAO_ENCONTRADA');
      assert.equal(ordem.filter((o) => o === 'ROLLBACK').length, 1);
      assert.equal(ordem.includes('COMMIT'), false);
      assert.equal(m.definir.mock.calls.length + m.auditoria.mock.calls.length, 0);
    }
  });

  test('sem `imagem` (ou imagem: undefined) NENHUMA operação de imagem é feita e a resposta traz imagem: null — o comportamento atual é preservado', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem);
    const r = await servico.criar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Botina', prazoUsoDias: 180, exigeTamanho: false, ...CLS });
    assert.deepEqual(dasImagens(ordem), []);
    assert.equal(r.imagem, null);
    assert.equal('imagem' in m.auditoria.mock.calls[0].arguments[1].dadosNovos, false, 'a auditoria só cita a imagem quando ela foi informada');
  });

  test('imagem malformada é 400 VALIDACAO em body.imagem ANTES de abrir transação (sem BEGIN, sem consulta)', async (t) => {
    // O id BIGINT aceita inteiro seguro ou texto decimal canônico ("1" É válido agora); recusa zero, negativo, zeros à esquerda, não numérico,
    // número acima de 2^53 e texto acima de 2^63-1.
    const invalidas = [{ origem: 'empresa', id: 1 }, { origem: 'EMPRESA', id: 0 }, { origem: 'EMPRESA', id: '0' }, { origem: 'EMPRESA', id: '01' }, { origem: 'EMPRESA', id: 'abc' }, { origem: 'EMPRESA', id: '' },
      { origem: 'EMPRESA', id: 9007199254740993 }, { origem: 'EMPRESA', id: '9223372036854775808' }, { origem: 'EMPRESA', id: 1, caminho: 'x' }, { origem: 'EMPRESA', id: 1, versao: 2 }, { origem: 'EMPRESA', id: 1, zz: 1 }, { id: 1 }, [], 'x', 5];
    for (const imagem of invalidas) {
      const ordem = [];
      mundo(t, ordem);
      await assert.rejects(servico.criar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Botina', prazoUsoDias: 180, exigeTamanho: false, ...CLS, imagem }), (e) => {
        assert.deepEqual([e.status, e.codigo], [400, 'VALIDACAO']);
        assert.equal(e.detalhes.some((d) => d.campo === 'body.imagem'), true);
        return true;
      }, JSON.stringify(imagem));
      assert.equal(ordem.includes('BEGIN'), false);
    }
  });
});

describe('alterar com imagem', () => {
  test('ordem de travas: material (FOR UPDATE) → imagem (FOR SHARE) → vínculo → auditoria; a imagem NUNCA é travada antes do material', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem);
    await servico.alterar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, materialId: MATERIAL_ID, imagem: { origem: 'EMPRESA', id: 9 } });
    const corpo = ordem.filter((o) => ['BEGIN', 'material', 'imagemEmpresa', 'definir', 'auditoria', 'COMMIT'].includes(o));
    assert.deepEqual(corpo, ['BEGIN', 'material', 'imagemEmpresa', 'definir', 'auditoria', 'COMMIT']);
    assert.equal(m.empresa.mock.calls[0].arguments[1], EMPRESA);
  });

  test('um corpo só com `imagem` é alteração válida (não é MATERIAL_SEM_ALTERACAO), inclusive `imagem: null`', async (t) => {
    for (const imagem of [{ origem: 'PADRAO', id: 4 }, null]) {
      const ordem = [];
      const m = mundo(t, ordem, { atual: { origem: 'EMPRESA', id: '9', versao: 1, nome: 'Img' } });
      await servico.alterar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, materialId: MATERIAL_ID, imagem });
      assert.equal(m.definir.mock.calls.length, 1, JSON.stringify(imagem));
      assert.equal(ordem.filter((o) => o === 'COMMIT').length, 1);
    }
  });

  test('`imagem: null` remove sem travar nenhuma imagem (soltar não depende de existência nem de estado); a auditoria guarda anterior → null', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { atual: { origem: 'EMPRESA', id: '9', versao: 2, nome: 'Img' } });
    await servico.alterar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, materialId: MATERIAL_ID, imagem: null });
    assert.equal(m.empresa.mock.calls.length + m.padrao.mock.calls.length, 0);
    assert.deepEqual(m.definir.mock.calls[0].arguments[3], { imagemPadraoId: null, imagemEmpresaId: null });
    const a = m.auditoria.mock.calls[0].arguments[1];
    assert.deepEqual([a.dadosAnteriores.imagem, a.dadosNovos.imagem], [{ origem: 'EMPRESA', id: '9' }, null]);
  });

  test('`imagem` ausente: nenhuma trava de imagem, nenhum vínculo e a auditoria não cita imagem (comportamento atual)', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { atual: { origem: 'EMPRESA', id: '9', versao: 1, nome: 'Img' } });
    await servico.alterar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, materialId: MATERIAL_ID, nome: 'Botina reforçada' });
    assert.equal(m.empresa.mock.calls.length + m.padrao.mock.calls.length + m.definir.mock.calls.length, 0);
    const a = m.auditoria.mock.calls[0].arguments[1];
    assert.equal('imagem' in a.dadosAnteriores || 'imagem' in a.dadosNovos, false);
  });

  test('reenviar a imagem que o material JÁ tem não exige que ela esteja ativa (a associação existente sobrevive à inativação) e não regrava o vínculo', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { imagemEmpresa: { id: '9', estado: 'INATIVA', versao: 1, nome: 'Img' }, atual: { origem: 'EMPRESA', id: '9', versao: 1, nome: 'Img' } });
    await servico.alterar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, materialId: MATERIAL_ID, nome: 'Outro nome', imagem: { origem: 'EMPRESA', id: 9 } });
    assert.equal(m.definir.mock.calls.length, 0);
    assert.equal(ordem.filter((o) => o === 'COMMIT').length, 1);
  });

  test('imagem inválida desfaz TUDO (tudo ou nada): ROLLBACK, sem COMMIT, sem auditoria, mesmo com outros campos válidos', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { imagemEmpresa: null });
    await esperarHttp(servico.alterar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, materialId: MATERIAL_ID, nome: 'Outro nome', imagem: { origem: 'EMPRESA', id: 9 } }), 404, 'IMAGEM_NAO_ENCONTRADA');
    assert.deepEqual([ordem.includes('COMMIT'), ordem.filter((o) => o === 'ROLLBACK').length, m.auditoria.mock.calls.length, m.definir.mock.calls.length], [false, 1, 0, 0]);
  });

  test('material de outra empresa/inexistente é 404 MATERIAL_NAO_ENCONTRADO ANTES de qualquer consulta de imagem (a imagem não revela nada sobre material alheio)', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { existente: null });
    await esperarHttp(servico.alterar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, materialId: MATERIAL_ID, imagem: { origem: 'EMPRESA', id: 9 } }), 404, 'MATERIAL_NAO_ENCONTRADO');
    assert.equal(m.empresa.mock.calls.length + m.padrao.mock.calls.length, 0);
  });
});

describe('leitura', () => {
  test('buscar traz `imagem` do vínculo (ou null) e listar a obtém de TODOS os materiais da página numa única consulta por empresa (sem N+1)', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { atual: { origem: 'PADRAO', id: '4', versao: 3, nome: 'Pad' } });
    t.mock.method(materialRepo, 'listarPorEmpresa', async () => [material({ id: 1 }), material({ id: 2 })]);
    t.mock.method(materialRepo, 'contarPorEmpresa', async () => 2);
    const b = await servico.buscar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, materialId: MATERIAL_ID });
    assert.deepEqual(b.imagem, { origem: 'PADRAO', id: '4', versao: 3, nome: 'Pad' });
    m.obterVarios.mock.mockImplementation(async () => new Map([[1, { origem: 'EMPRESA', id: '9', versao: 1, nome: 'Img' }]]));
    const l = await servico.listar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA });
    assert.deepEqual(l.materiais.map((x) => x.imagem && x.imagem.id), ['9', null]);
    assert.equal(m.obterVarios.mock.calls.length, 1);
    assert.deepEqual(m.obterVarios.mock.calls[0].arguments.slice(1), [EMPRESA, [1, 2]]);
  });
});
