'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente } = require('./helpers/ambiente-http-12d2');
const { dependeDaMigration } = require('./helpers/classificacao-v2');

/**
 * RED — "valor efetivo de exibição" do Grupo nos filtros (decisão 1 de 07/10/2026): LEGADO categoria = 'Ferramenta' e
 * V2 categoria = 'Outros' + categoria_descricao = 'Ferramenta' aparecem JUNTOS como "Ferramenta" na listagem e nas
 * opções de filtro. A regra vem do helper central (classificacao-material.SQL.grupoEfetivo), nunca de COALESCE solto.
 * PostgreSQL real, schema temporário; as colunas V2 são da migration 082 (ainda inexistente).
 */

describe('valor efetivo do Grupo nos filtros de estoque (RED)', () => {
  let amb;
  let master;
  const q = (sql, params) => amb.pool.query(sql, params);

  before(async () => {
    amb = await montarAmbiente();
    master = amb.como(amb.d.master);
  });
  after(async () => { if (amb) await amb.encerrar(); });

  async function novo(marca, sufixo, classificar) {
    const id = await amb.f.material();
    await q('UPDATE materiais SET nome = $2 WHERE id = $1', [id, `${marca} ${sufixo}`]);
    await classificar(id);
    await amb.f.estoque(id, 5);
    return id;
  }
  const legado = (categoria) => (id) => q("UPDATE materiais SET categoria = $2, tipo = 'Outros', tipo_descricao = 'Chave' WHERE id = $1", [id, categoria]);
  const v2Outros = (descricao) => (id) => dependeDaMigration(q(
    "UPDATE materiais SET categoria = 'Outros', categoria_descricao = $2, modelo_classificacao = 'V2', tipo = 'Outros', tipo_descricao = 'Chave' WHERE id = $1", [id, descricao],
  ), 'colunas da classificação V2 em materiais');
  const itens = async (query) => {
    const r = await master.get(`/api/estoque/itens-disponiveis?${query}&limite=100`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.itens;
  };

  test('filtro categoria=Ferramenta traz o LEGADO ("Ferramenta") e o V2 ("Outros" + "Ferramenta") juntos; cada item expõe `grupo` efetivo e a categoria bruta', async () => {
    const marca = 'VE01';
    await novo(marca, 'chave legada', legado('Ferramenta'));
    await novo(marca, 'chave v2', v2Outros('Ferramenta'));
    await novo(marca, 'capacete', legado('EPI'));
    const lista = await itens(`categoria=Ferramenta&busca=${marca}`);
    assert.deepEqual(lista.map((i) => i.material.split(' ').slice(1).join(' ')).sort(), ['chave legada', 'chave v2']);
    assert.deepEqual(lista.map((i) => i.grupo), ['Ferramenta', 'Ferramenta']);
    assert.deepEqual(lista.map((i) => i.categoria).sort(), ['Ferramenta', 'Outros'], 'a categoria bruta continua disponível');
    const todos = await itens(`busca=${marca}`);
    assert.equal(todos.length, 3);
    assert.equal(todos.find((i) => i.material.endsWith('capacete')).grupo, 'EPI');
  });

  test('filtro categoria=Outros = grupo ESTRUTURAL Outros: devolve todos os V2 "Outros", qualquer que seja a descrição, e nenhum legado', async () => {
    const marca = 'VE02';
    await novo(marca, 'chave v2', v2Outros('Ferramenta'));
    await novo(marca, 'graxa v2', v2Outros('Material de consumo'));
    await novo(marca, 'chave legada', legado('Ferramenta'));
    const lista = await itens(`categoria=Outros&busca=${marca}`);
    assert.deepEqual(lista.map((i) => i.material.split(' ').slice(1).join(' ')).sort(), ['chave v2', 'graxa v2']);
    assert.deepEqual(lista.map((i) => i.grupo).sort(), ['Ferramenta', 'Material de consumo'], 'o grupo exibido continua sendo o efetivo');
  });

  test('as opções de filtro (GET /estoque/itens-disponiveis → filtros.categorias) listam o grupo EFETIVO uma vez e também "Outros" (grupo estrutural)', async () => {
    const marca = 'VE03';
    await novo(marca, 'legado', legado('Material de consumo'));
    await novo(marca, 'v2', v2Outros('Material de consumo'));
    const r = await master.get('/api/estoque/itens-disponiveis?limite=1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const categorias = r.body.filtros.categorias;
    assert.equal(categorias.filter((c) => c === 'Material de consumo').length, 1);
    assert.equal(categorias.includes('Outros'), true, 'há V2 com grupo estrutural Outros');
    assert.deepEqual(categorias, [...categorias].sort(), 'ordenadas');
  });
});
