'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const catalogoService = require('../../src/services/token-catalogo.service');
const catalogoRepo = require('../../src/repositories/token-catalogo.repository');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — mapeamento da IMAGEM no catálogo do Totem, sem PostgreSQL. O repositório do catálogo passa a devolver, por
 * material, `imagem_origem` ('EMPRESA' | 'PADRAO' | null), `imagem_id` e `imagem_versao` — já resolvidos para uma imagem VÁLIDA (existente, da empresa ou
 * padrão, ativa); o serviço só monta o contrato. Fonte única: o mesmo vínculo `materiais.imagem_*_id` do cadastro, sem tabela própria do Totem.
 */

const SEM_IMAGEM = { disponivel: false };
const linha = (extra = {}) => ({
  id: 1, nome: 'Luva', unidade: 'par', categoria: 'EPI', grupo_protecao: 'Proteção das mãos', tipo: null, tipo_material_id: null, exige_tamanho: false, tamanhos: [],
  imagem_origem: null, imagem_id: null, imagem_versao: null, ...extra,
});

async function montar(t, linhas) {
  t.mock.method(catalogoRepo, 'buscarGheDoFuncionario', async () => ({ ghe_id: 3, ghe_ativo: true }));
  t.mock.method(catalogoRepo, 'listarMateriaisAutorizados', async () => linhas);
  return catalogoService.montarCatalogoDoFuncionario({}, { empresaId: 1, funcionarioId: 2 });
}

describe('catálogo do Totem — contrato da imagem', () => {
  // Decisão da V7 (Unidade 3, ajuste de contratos): o catálogo NÃO expõe caminho, URL, chave de armazenamento nem diretório — só o identificador
  // da imagem do material. O acesso ao arquivo é decisão de unidade futura. O id BIGINT é texto decimal, sem perder precisão.
  test('imagem da empresa e padrão viram { disponivel:true, origem, id, versao } com as chaves exatas, SEM caminho nem URL', async (t) => {
    const r = await montar(t, [
      linha({ id: 1, imagem_origem: 'EMPRESA', imagem_id: '9', imagem_versao: 3 }),
      linha({ id: 2, imagem_origem: 'PADRAO', imagem_id: '4', imagem_versao: 1 }),
    ]);
    assert.deepEqual(r.materiais[0].imagem, { disponivel: true, origem: 'EMPRESA', id: '9', versao: 3 });
    assert.deepEqual(r.materiais[1].imagem, { disponivel: true, origem: 'PADRAO', id: '4', versao: 1 });
    assert.deepEqual(Object.keys(r.materiais[0].imagem).sort(), ['disponivel', 'id', 'origem', 'versao']);
    assert.equal(/caminho|url|chave|diretorio|\/api\//i.test(JSON.stringify(r)), false, 'nenhum caminho, URL ou chave de armazenamento no catálogo');
  });

  test('o id BIGINT mantém a precisão integral (texto decimal, mesmo acima de 2^53) e a versão sai como número', async (t) => {
    const r = await montar(t, [linha({ imagem_origem: 'EMPRESA', imagem_id: '9007199254740993', imagem_versao: '3' })]);
    assert.deepEqual(r.materiais[0].imagem, { disponivel: true, origem: 'EMPRESA', id: '9007199254740993', versao: 3 });
  });

  test('sem imagem válida (colunas nulas, parciais ou inconsistentes) → exatamente { disponivel:false }: o fallback do Totem nunca depende de dado incompleto', async (t) => {
    const r = await montar(t, [
      linha({ id: 1 }),
      linha({ id: 2, imagem_origem: 'EMPRESA', imagem_id: null, imagem_versao: 1 }),
      linha({ id: 3, imagem_origem: null, imagem_id: '5', imagem_versao: 1 }),
      linha({ id: 4, imagem_origem: 'OUTRA', imagem_id: '5', imagem_versao: 1 }),
      linha({ id: 5, imagem_origem: 'EMPRESA', imagem_id: '5', imagem_versao: 0 }),
      linha({ id: 6, imagem_origem: 'EMPRESA', imagem_id: '05', imagem_versao: 1 }),
    ]);
    for (const m of r.materiais) assert.deepEqual(m.imagem, SEM_IMAGEM, `material ${m.id}`);
  });

  test('o resto do material não muda: as chaves continuam as da Etapa E e nenhuma coluna de imagem vaza para fora de `imagem`', async (t) => {
    const r = await montar(t, [linha({ imagem_origem: 'EMPRESA', imagem_id: '9', imagem_versao: 1 })]);
    assert.deepEqual(Object.keys(r.materiais[0]).sort(), ['categoria', 'exigeTamanho', 'grupoProtecao', 'id', 'imagem', 'nome', 'tamanhos', 'tipo', 'unidade']);
    assert.equal(r.total, 1);
  });

  test('a imagem não filtra: material com e sem imagem aparecem, na ordem do repositório', async (t) => {
    const r = await montar(t, [linha({ id: 1 }), linha({ id: 2, imagem_origem: 'PADRAO', imagem_id: '4', imagem_versao: 1 })]);
    assert.deepEqual(r.materiais.map((m) => m.id), [1, 2]);
    assert.equal(r.estado, 'OK');
  });
});
