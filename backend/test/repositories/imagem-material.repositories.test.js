'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — contrato dos TRÊS repositórios (imagem da empresa, imagem padrão e vínculo material × imagem), sem
 * PostgreSQL: executor falso. Repositório não decide regra de negócio nem autorização: valida formato (TypeError), monta SQL parametrizado,
 * filtra SEMPRE pela empresa (exceto a biblioteca padrão, que é global), trava onde o contrato pede (FOR SHARE na associação, FOR UPDATE na
 * mudança de estado) e NUNCA apaga. O comportamento com banco real está nas suítes de integração.
 */

const repoEmpresa = () => exigirModulo('src/repositories/imagem-empresa.repository');
const repoPadrao = () => exigirModulo('src/repositories/imagem-padrao.repository');
const repoVinculo = () => exigirModulo('src/repositories/material-imagem.repository');

const EMPRESA = 4242;
const HEX = (c) => c.repeat(64);

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return { chamadas, query: async (texto, valores) => { chamadas.push({ texto, valores }); return { rows: linhas, rowCount: linhas.length }; } };
};

const linhaEmpresa = (extra = {}) => ({
  id: '9', empresa_id: EMPRESA, nome: 'Imagem', sha256: HEX('a'), sha256_mestre: HEX('b'), sha256_exibicao: HEX('c'), sha256_miniatura: HEX('d'), formato: 'PNG',
  largura: 1024, altura: 1024, bytes_mestre: 10, bytes_exibicao: 5, bytes_miniatura: 2, versao: 1, estado: 'ATIVA', criado_por: 3,
  criado_em: new Date('2026-10-16T12:00:00Z'), atualizado_em: new Date('2026-10-16T12:00:00Z'), inativada_em: null, ...extra,
});
const dados = (extra = {}) => ({
  empresaId: EMPRESA, nome: 'Imagem', sha256: HEX('a'), sha256Mestre: HEX('b'), sha256Exibicao: HEX('c'), sha256Miniatura: HEX('d'), formato: 'PNG',
  largura: 1024, altura: 1024, bytesMestre: 10, bytesExibicao: 5, bytesMiniatura: 2, criadoPor: 3, ...extra,
});

describe('imagem-empresa.repository', () => {
  test('inserir: INSERT parametrizado com a empresa do chamador e devolve o objeto mapeado em camelCase', async () => {
    const ex = executorFalso([linhaEmpresa()]);
    const r = await repoEmpresa().inserir(ex, dados());
    assert.match(ex.chamadas[0].texto, /INSERT INTO imagens_empresa/);
    assert.equal(ex.chamadas[0].valores[0], EMPRESA);
    assert.deepEqual([r.id, r.empresaId, r.estado, r.versao, r.sha256Exibicao, r.bytesMiniatura, r.criadoPor], ['9', EMPRESA, 'ATIVA', 1, HEX('c'), 2, 3]); // BIGINT: o id é string decimal (decisão da V7)
    assert.equal(/\$\d/.test(ex.chamadas[0].texto), true, 'valores por parâmetro');
    assert.equal(ex.chamadas[0].texto.includes(HEX('a')), false, 'nenhum valor concatenado no SQL');
  });

  test('inserir recusa dados fora do formato (TypeError) antes de consultar: empresa, SHA-256 (64 hexadecimais minúsculos), formato, medidas e bytes', async () => {
    const ex = executorFalso();
    for (const ruim of [
      { empresaId: 0 }, { empresaId: '4242' }, { sha256: 'A'.repeat(64) }, { sha256: 'a'.repeat(63) }, { sha256Mestre: 'g'.repeat(64) },
      { formato: 'GIF' }, { formato: 'png' }, { largura: 0 }, { altura: 1.5 }, { bytesMestre: 0 }, { bytesMiniatura: -1 }, { nome: '' }, { criadoPor: 0 },
    ]) await assert.rejects(repoEmpresa().inserir(ex, dados(ruim)), TypeError, JSON.stringify(ruim));
    assert.equal(ex.chamadas.length, 0);
  });

  test('buscarPorSha256 e buscarPorId filtram SEMPRE pela empresa e não filtram o estado (a inativa também é achada)', async () => {
    const ex = executorFalso([linhaEmpresa({ estado: 'INATIVA' })]);
    const r = await repoEmpresa().buscarPorSha256(ex, EMPRESA, HEX('a'));
    await repoEmpresa().buscarPorId(ex, EMPRESA, 9);
    for (const c of ex.chamadas) { assert.match(c.texto, /empresa_id = \$1/); assert.equal(c.valores[0], EMPRESA); assert.equal(/estado\s*=/.test(c.texto), false); }
    assert.equal(r.estado, 'INATIVA');
    assert.equal(await repoEmpresa().buscarPorId(executorFalso([]), EMPRESA, 9), null);
    await assert.rejects(repoEmpresa().buscarPorSha256(ex, EMPRESA, 'xyz'), TypeError);
    await assert.rejects(repoEmpresa().buscarPorId(ex, EMPRESA, 0), TypeError);
  });

  test('buscarPorIdParaAssociacao trava com FOR SHARE e buscarPorIdParaAtualizacao com FOR UPDATE, ambas pela empresa', async () => {
    const ex = executorFalso([linhaEmpresa()]);
    await repoEmpresa().buscarPorIdParaAssociacao(ex, EMPRESA, 9);
    await repoEmpresa().buscarPorIdParaAtualizacao(ex, EMPRESA, 9);
    assert.match(ex.chamadas[0].texto, /FOR SHARE/);
    assert.match(ex.chamadas[1].texto, /FOR UPDATE/);
    for (const c of ex.chamadas) assert.deepEqual(c.valores, [EMPRESA, '9']); // entra 9 (inteiro seguro) ou '9'; vai '9'
    await repoEmpresa().buscarPorIdParaAssociacao(ex, EMPRESA, '9007199254740993');
    assert.deepEqual(ex.chamadas.at(-1).valores, [EMPRESA, '9007199254740993'], 'BIGINT acima de 2^53 mantém a precisão');
    await assert.rejects(repoEmpresa().buscarPorIdParaAssociacao(ex, EMPRESA, '9223372036854775808'), TypeError);
    await assert.rejects(repoEmpresa().buscarPorIdParaAssociacao(ex, EMPRESA, 9007199254740993), TypeError, 'número inseguro');
    await assert.rejects(repoEmpresa().buscarPorIdParaAssociacao(ex, EMPRESA, '09'), TypeError);
  });

  test('atualizarEstado só aceita ATIVA ou INATIVA, filtra pela empresa e acompanha inativada_em; atualizarNome só mexe no nome', async () => {
    const ex = executorFalso([linhaEmpresa({ estado: 'INATIVA' })]);
    const r = await repoEmpresa().atualizarEstado(ex, EMPRESA, 9, 'INATIVA');
    assert.match(ex.chamadas[0].texto, /UPDATE imagens_empresa/);
    assert.match(ex.chamadas[0].texto, /inativada_em/);
    assert.deepEqual(ex.chamadas[0].valores.slice(0, 3), [EMPRESA, '9', 'INATIVA']);
    assert.equal(r.estado, 'INATIVA');
    await assert.rejects(repoEmpresa().atualizarEstado(ex, EMPRESA, 9, 'APAGADA'), TypeError);
    await repoEmpresa().atualizarNome(ex, EMPRESA, 9, 'Novo nome');
    const atribuicoes = ex.chamadas.at(-1).texto.split(/\bWHERE\b/i)[0];
    assert.match(atribuicoes, /SET\s+nome\s*=/);
    for (const coluna of ['sha256', 'bytes_', 'largura', 'versao', 'criado_por']) assert.equal(atribuicoes.includes(coluna), false, `a coluna imutável ${coluna} não pode ser alterada`);
  });

  test('travarBiblioteca usa advisory lock transacional de 64 bits da empresa; contarUso e somarConsumo filtram pela empresa', async () => {
    const ex = executorFalso([{ n: 2, imagens: 3, bytes: '100' }]);
    await repoEmpresa().travarBiblioteca(ex, EMPRESA);
    assert.match(ex.chamadas[0].texto, /pg_advisory_xact_lock/);
    assert.equal(ex.chamadas[0].valores[0], require('../../src/utils/lock-biblioteca-imagens').lockDaBiblioteca(EMPRESA));
    await repoEmpresa().contarUso(ex, EMPRESA, 9);
    assert.match(ex.chamadas[1].texto, /materiais/);
    assert.match(ex.chamadas[1].texto, /imagem_empresa_id/);
    assert.deepEqual(ex.chamadas[1].valores, [EMPRESA, '9']);
    const consumo = await repoEmpresa().somarConsumo(ex, EMPRESA);
    assert.match(ex.chamadas[2].texto, /empresa_id = \$1/);
    // `bytes` = soma dos MESTRES (o contrato da cota, docs. 04 e 13); `bytesArmazenados` soma também as derivadas (transparência).
    assert.deepEqual(Object.keys(consumo).sort(), ['bytes', 'bytesArmazenados', 'imagens']);
    assert.deepEqual([consumo.imagens, consumo.bytes], [3, 100]);
    assert.match(ex.chamadas[2].texto, /sum\(bytes_mestre\)/);
    await assert.rejects(repoEmpresa().travarBiblioteca(ex, 'x'), TypeError);
  });

  test('listar e contar: busca por parâmetro com os coringas do LIKE escapados, limite entre 1 e 100, estado opcional, sempre pela empresa', async () => {
    const ex = executorFalso([{ total: 0 }]); // o `contar` lê `total` da primeira linha; `listar` mapeia a linha vazia de teste sem uso
    await repoEmpresa().listar(ex, EMPRESA, { busca: '50%_\\x', estado: 'ATIVA', pagina: 2, limite: 10 });
    await repoEmpresa().contar(ex, EMPRESA, { busca: 'x', estado: null });
    for (const c of ex.chamadas) { assert.match(c.texto, /empresa_id = \$1/); assert.equal(c.valores[0], EMPRESA); }
    assert.equal(ex.chamadas[0].valores.some((v) => v === '50\\%\\_\\\\x'), true, 'coringas escapados');
    await assert.rejects(repoEmpresa().listar(ex, EMPRESA, { limite: 101 }), TypeError);
    await assert.rejects(repoEmpresa().listar(ex, EMPRESA, { limite: 0 }), TypeError);
    await assert.rejects(repoEmpresa().listar(ex, EMPRESA, { estado: 'QUALQUER' }), TypeError);
  });
});

describe('imagem-padrao.repository (biblioteca global, somente leitura para a aplicação)', () => {
  test('não tem NENHUMA função de escrita; ler não filtra empresa (é global), mas a associação trava com FOR SHARE', async () => {
    const repo = repoPadrao();
    for (const nome of Object.keys(repo)) assert.equal(/^(inserir|criar|atualizar|alterar|remover|excluir|apagar|definir|inativar|reativar)/.test(nome), false, `escrita exposta: ${nome}`);
    const ex = executorFalso([{ id: '5', nome: 'P', sha256: HEX('a'), sha256_miniatura: HEX('b'), formato: 'PNG', largura: 1024, altura: 1024, versao: 1, ativo: true, ilustrativa: true }]);
    const r = await repo.buscarPorIdParaAssociacao(ex, 5);
    assert.match(ex.chamadas[0].texto, /FOR SHARE/);
    assert.equal(ex.chamadas[0].valores[0], '5');
    assert.deepEqual([r.id, r.ativo, r.versao], ['5', true, 1]);
    assert.equal(await repo.buscarPorIdParaAssociacao(executorFalso([]), 5), null);
    await assert.rejects(repo.buscarPorIdParaAssociacao(ex, 0), TypeError);
  });

  test('listar traz só ATIVAS por padrão, com sugestão por NOME de tipo (nunca por id), busca escapada e limite 1–100', async () => {
    const ex = executorFalso([]);
    await repoPadrao().listar(ex, { busca: '100%', tipoNome: 'Luva de Segurança', pagina: 1, limite: 30 });
    const { texto, valores } = ex.chamadas[0];
    assert.match(texto, /imagens_padrao/);
    assert.match(texto, /ativo/);
    assert.match(texto, /imagens_padrao_tipos/);
    assert.equal(valores.includes('Luva de Segurança'), true);
    assert.equal(valores.includes('100\\%'), true);
    await assert.rejects(repoPadrao().listar(ex, { limite: 101 }), TypeError);
    assert.equal(texto.includes('Luva de Segurança'), false);
  });
});

describe('material-imagem.repository (vínculo no próprio material)', () => {
  test('definir atualiza SÓ as duas colunas de imagem, pela empresa e pelo id do material, com no máximo uma preenchida', async () => {
    const ex = executorFalso([{ id: 30 }]);
    await repoVinculo().definir(ex, EMPRESA, 30, { imagemPadraoId: null, imagemEmpresaId: 9 });
    await repoVinculo().definir(ex, EMPRESA, 30, { imagemPadraoId: 4, imagemEmpresaId: null });
    await repoVinculo().definir(ex, EMPRESA, 30, { imagemPadraoId: null, imagemEmpresaId: null });
    assert.match(ex.chamadas[0].texto, /UPDATE materiais/);
    assert.match(ex.chamadas[0].texto, /empresa_id = \$/);
    assert.deepEqual(ex.chamadas[0].valores.slice(0, 2), [EMPRESA, 30]);
    assert.equal(/\bnome\b/.test(ex.chamadas[0].texto.split(/\bWHERE\b/i)[0]), false, 'só as duas colunas de imagem são atribuídas');
    await assert.rejects(repoVinculo().definir(ex, EMPRESA, 30, { imagemPadraoId: 4, imagemEmpresaId: 9 }), TypeError, 'duas imagens');
    await assert.rejects(repoVinculo().definir(ex, EMPRESA, 30, { imagemPadraoId: 0, imagemEmpresaId: null }), TypeError);
    await assert.rejects(repoVinculo().definir(ex, 0, 30, { imagemPadraoId: null, imagemEmpresaId: null }), TypeError);
  });

  test('obterPorMateriais: lista vazia não consulta; ids inválidos são TypeError; a consulta é por empresa e devolve a imagem associada (o que o catálogo do Totem decide é outra camada), como Map', async () => {
    const ex = executorFalso([{ material_id: 30, origem: 'EMPRESA', imagem_id: '9', versao: 2, nome: 'Img' }]);
    assert.equal((await repoVinculo().obterPorMateriais(ex, EMPRESA, [])).size, 0);
    assert.equal(ex.chamadas.length, 0);
    const mapa = await repoVinculo().obterPorMateriais(ex, EMPRESA, [30]);
    assert.deepEqual(mapa.get(30), { origem: 'EMPRESA', id: '9', versao: 2, nome: 'Img' });
    assert.match(ex.chamadas[0].texto, /empresa_id = \$1/);
    await assert.rejects(repoVinculo().obterPorMateriais(ex, EMPRESA, [0]), TypeError);
    await assert.rejects(repoVinculo().obterPorMateriais(ex, EMPRESA, 'x'), TypeError);
    const um = await repoVinculo().obterPorMaterial(executorFalso([]), EMPRESA, 30);
    assert.equal(um, null);
  });
});

describe('o que cada repositório de imagem pode apagar', () => {
  const texto = (arquivo) => {
    const caminho = path.join(__dirname, '..', '..', 'src', 'repositories', `${arquivo}.repository.js`);
    assert.equal(fs.existsSync(caminho), true, `módulo ainda não implementado: src/repositories/${arquivo}.repository.js`);
    return fs.readFileSync(caminho, 'utf8');
  };

  test('a biblioteca padrão e o vínculo com o material NUNCA apagam; ninguém usa TRUNCATE ou DROP', () => {
    for (const arquivo of ['imagem-padrao', 'material-imagem']) assert.equal(/\b(DELETE|TRUNCATE|DROP)\b/i.test(texto(arquivo)), false, `${arquivo} não pode apagar`);
    assert.equal(/\b(TRUNCATE|DROP)\b/i.test(texto('imagem-empresa')), false);
  });

  test('a biblioteca da empresa só pode conter UM DELETE: a exclusão da própria imagem, sempre por empresa e id (operação da exclusão, ainda não implementada nesta unidade)', () => {
    const apagamentos = texto('imagem-empresa').match(/DELETE\s+FROM\s+[^`'"]*/gi) ?? [];
    for (const a of apagamentos) assert.match(a.replace(/\s+/g, ' '), /^DELETE FROM imagens_empresa WHERE empresa_id = \$1 AND id = \$2/i);
    assert.ok(apagamentos.length <= 1);
  });
});
