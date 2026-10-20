'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');

/**
 * Biblioteca de Imagens, Unidade 3 (RED — contrato de EXCLUSÃO, V7 seção 2; NÃO implementado nesta rodada) — exclusão de imagem PRIVADA da empresa,
 * sem PostgreSQL. É a operação que REMOVE a linha da biblioteca (a imagem some da biblioteca e libera a cota lógica); não é inativar (a imagem fica,
 * continua contando na cota e pode ser reativada) e não é soltar a imagem do material (o material continua existindo e a imagem continua na
 * biblioteca). Não toca em arquivos: a limpeza física definitiva é outra operação, futura (ciclo de vida no doc. 28).
 *
 * Contrato: `excluir(pool, { empresaId, atorId, imagemId, confirmacao, ip, dispositivo })` → `{ excluida: true, imagemId }`.
 *   - `confirmacao` precisa ser exatamente `true` (a tela futura pede confirmação explícita): senão 400 VALIDACAO em `body.confirmacao`, sem abrir transação.
 *   - Ordem: BEGIN, imagem FOR UPDATE (pela empresa), contagem de uso, DELETE (por empresa e id), auditoria, COMMIT.
 *   - Em uso por material (ativo ou não): 409 IMAGEM_EM_USO, ROLLBACK, nada apagado nem auditado. Inexistente, de outra empresa ou "padrão": 404 uniforme.
 *   - Auditoria IMAGEM_MATERIAL_EXCLUIDA: só ids, formato e bytes. Sem decisão de autorização (matriz: `materials.editar`).
 * Hoje todos falham (`excluir` não existe): é a especificação do GREEN seguinte.
 */

const servico = () => exigirModulo('src/services/imagem-material.service');
const repoEmpresa = () => exigirModulo('src/repositories/imagem-empresa.repository');
const EMPRESA = 42;
const ATOR = 7;
const imagem = (extra = {}) => ({
  id: '5', empresaId: EMPRESA, nome: 'Imagem', formato: 'PNG', largura: 1024, altura: 1024, versao: 1, estado: 'ATIVA', criadoPor: ATOR,
  bytesMestre: 90000, bytesExibicao: 40000, bytesMiniatura: 9000, sha256: 'a'.repeat(64), ...extra,
});
const clienteFalso = (ordem) => ({ query: async (texto) => { ordem.push(texto); return { rows: [], rowCount: 0 }; }, release: () => ordem.push('RELEASE') });
const poolFalso = (c) => ({ connect: async () => c, query: (...a) => c.query(...a) });
const noCliente = (ordem) => ordem.filter((o) => o !== 'RELEASE');

function mundo(t, ordem, { existente = imagem(), uso = 0 } = {}) {
  // `node:test` restaura os mocks na ordem de CRIAÇÃO: mockar o mesmo método duas vezes no mesmo teste (laços) deixaria o primeiro mock
  // instalado para os testes seguintes do arquivo (o do repositório real, abaixo). Restaurar antes de mockar evita o resíduo.
  t.mock.reset();
  const r = repoEmpresa();
  const marca = (nome, valor) => async (...a) => { ordem.push(nome); return typeof valor === 'function' ? valor(...a) : valor; };
  return {
    paraAtualizacao: t.mock.method(r, 'buscarPorIdParaAtualizacao', marca('paraAtualizacao', existente)),
    uso: t.mock.method(r, 'contarUso', marca('uso', uso)),
    excluir: t.mock.method(r, 'excluir', marca('excluir', existente)),
    auditoria: t.mock.method(auditoriaRepo, 'registrar', marca('auditoria', { id: '1', criadoEm: new Date() })),
  };
}
async function esperarHttp(promessa, status, codigo) {
  await assert.rejects(promessa, (e) => { assert.equal(e.status, status); assert.equal(e.codigo, codigo); return true; });
}
const pedido = (extra = {}) => ({ empresaId: EMPRESA, atorId: ATOR, imagemId: '5', confirmacao: true, ...extra });

describe('excluir — serviço da biblioteca da empresa', () => {
  test('ordem: BEGIN, FOR UPDATE da imagem, contagem de uso, DELETE, auditoria, COMMIT; devolve { excluida: true, imagemId } com o id em texto', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem);
    const r = await servico().excluir(poolFalso(clienteFalso(ordem)), pedido());
    assert.deepEqual(noCliente(ordem), ['BEGIN', 'paraAtualizacao', 'uso', 'excluir', 'auditoria', 'COMMIT']);
    assert.deepEqual(r, { excluida: true, imagemId: '5' });
    for (const c of [m.paraAtualizacao, m.uso, m.excluir]) assert.equal(c.mock.calls[0].arguments[1], EMPRESA);
    assert.equal(m.excluir.mock.calls[0].arguments[2], '5');
  });

  test('sem confirmação explícita (ausente, false, "true", 1) é 400 VALIDACAO em body.confirmacao ANTES de abrir transação e nada é apagado', async (t) => {
    for (const confirmacao of [undefined, false, 'true', 1, null]) {
      const ordem = [];
      const m = mundo(t, ordem);
      await assert.rejects(servico().excluir(poolFalso(clienteFalso(ordem)), pedido({ confirmacao })), (e) => {
        assert.deepEqual([e.status, e.codigo], [400, 'VALIDACAO']);
        assert.equal(e.detalhes.some((d) => d.campo === 'body.confirmacao'), true);
        return true;
      }, String(confirmacao));
      assert.deepEqual(ordem, []);
      assert.equal(m.excluir.mock.calls.length, 0);
    }
  });

  test('imagem em uso por material: 409 IMAGEM_EM_USO, ROLLBACK, sem DELETE e sem auditoria', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { uso: 1 });
    await esperarHttp(servico().excluir(poolFalso(clienteFalso(ordem)), pedido()), 409, 'IMAGEM_EM_USO');
    assert.deepEqual(noCliente(ordem), ['BEGIN', 'paraAtualizacao', 'uso', 'ROLLBACK']);
    assert.equal(m.excluir.mock.calls.length + m.auditoria.mock.calls.length, 0);
  });

  test('inexistente ou de outra empresa (o repositório filtra pela empresa): 404 IMAGEM_NAO_ENCONTRADA, sem DELETE nem auditoria', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { existente: null });
    await esperarHttp(servico().excluir(poolFalso(clienteFalso(ordem)), pedido()), 404, 'IMAGEM_NAO_ENCONTRADA');
    assert.equal(m.excluir.mock.calls.length + m.auditoria.mock.calls.length, 0);
  });

  test('a imagem excluível é a ATIVA e a INATIVA sem vínculos (excluir não exige inativar antes)', async (t) => {
    for (const estado of ['ATIVA', 'INATIVA']) {
      const ordem = [];
      mundo(t, ordem, { existente: imagem({ estado }) });
      assert.equal((await servico().excluir(poolFalso(clienteFalso(ordem)), pedido())).excluida, true, estado);
    }
  });

  test('auditoria IMAGEM_MATERIAL_EXCLUIDA: referência = id, contexto só com id, formato e bytes (nunca nome, hash, caminho ou conteúdo); ator e empresa do contexto', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { existente: imagem({ nome: 'Nome secreto' }) });
    await servico().excluir(poolFalso(clienteFalso(ordem)), pedido({ ip: '203.0.113.1', dispositivo: 'agente' }));
    const a = m.auditoria.mock.calls[0].arguments[1];
    assert.deepEqual([a.acao, a.referencia, a.empresaId, a.usuarioId], ['IMAGEM_MATERIAL_EXCLUIDA', '5', EMPRESA, ATOR]);
    assert.deepEqual(a.contexto, { imagemId: '5', formato: 'PNG', bytes: 139000 });
    const bruto = JSON.stringify(a);
    for (const proibido of ['Nome secreto', 'a'.repeat(64), 'caminho', 'chave']) assert.equal(bruto.includes(proibido), false);
  });

  test('falha no DELETE ou na auditoria = ROLLBACK, conexão devolvida e erro original propagado', async (t) => {
    const erro = Object.assign(new Error('falha do banco'), { code: '57P01' });
    const ordem = [];
    const m = mundo(t, ordem);
    m.excluir.mock.mockImplementation(async () => { ordem.push('excluir'); throw erro; });
    await assert.rejects(servico().excluir(poolFalso(clienteFalso(ordem)), pedido()), (e) => e === erro);
    assert.deepEqual(noCliente(ordem).slice(-1), ['ROLLBACK']);
    assert.equal(ordem.at(-1), 'RELEASE');
  });

  test('empresa, ator e id inválidos são erro de programação (TypeError) antes de abrir conexão', async (t) => {
    const ordem = [];
    mundo(t, ordem);
    for (const ruim of [{ empresaId: '42' }, { atorId: 0 }, { imagemId: 'abc' }, { imagemId: '05' }, { imagemId: 0 }]) {
      await assert.rejects(servico().excluir(poolFalso(clienteFalso(ordem)), pedido(ruim)), TypeError, JSON.stringify(ruim));
    }
    assert.deepEqual(ordem, []);
  });

  test('a exclusão da biblioteca NÃO mexe em arquivos: o serviço não importa armazenamento nem fs (a limpeza física é operação futura, separada)', () => {
    const caminho = path.join(__dirname, '..', '..', 'src', 'services', 'imagem-material.service.js');
    assert.equal(fs.existsSync(caminho), true, 'módulo ainda não implementado');
    const texto = fs.readFileSync(caminho, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/storage|armazenamento|node:fs|require\('fs'\)|unlink|rmSync/i.test(texto), false);
    assert.equal(typeof servico().excluir, 'function', 'a operação `excluir` ainda não foi implementada');
  });
});

describe('excluir — repositório da biblioteca da empresa', () => {
  const ex = (rows) => { const chamadas = []; return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows, rowCount: rows.length }; } }; };

  test('DELETE parametrizado SEMPRE por empresa e id (nunca só por id), devolve a linha apagada ou null; id BIGINT em texto decimal', async () => {
    const e = ex([{ id: '5', empresa_id: EMPRESA, nome: 'Imagem', formato: 'PNG', estado: 'ATIVA' }]);
    const r = await repoEmpresa().excluir(e, EMPRESA, 5);
    assert.match(e.chamadas[0].texto.replace(/\s+/g, ' '), /^DELETE FROM imagens_empresa WHERE empresa_id = \$1 AND id = \$2/i);
    assert.deepEqual(e.chamadas[0].valores, [EMPRESA, '5']);
    assert.equal(r.id, '5');
    assert.equal(await repoEmpresa().excluir(ex([]), EMPRESA, 5), null);
    await assert.rejects(repoEmpresa().excluir(e, 0, 5), TypeError);
    await assert.rejects(repoEmpresa().excluir(e, EMPRESA, '05'), TypeError);
  });
});
