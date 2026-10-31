'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — data efetiva nos eventos de situação (RED, especificação 02).
 *
 * O servidor passa a devolver, só nos eventos novos com data (desligamento, afastamento e retorno), o campo opcional `dataEfetiva`
 * (AAAA-MM-DD). A tela mostra "Data efetiva: dd/mm/aaaa" no evento QUANDO a resposta traz o campo; eventos antigos e a
 * reativação de inativo (sem data) continuam exatamente como hoje, sem espaço reservado, sem aviso de permissão e sem "—".
 * A exportação PDF/XLSX não muda nesta entrega (D2). Fixtures sintéticas.
 */

const ARQUIVO = 'pages/employee-history.html';
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar: true }, epiFicha: { ...NENHUMA, visualizar: true } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok',
  usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const pessoa = {
  id: 11, empresaId: 3, nome: 'Pessoa 11', matricula: 'M-11', cpfMascarado: '***.***.***-25', setor: 'Setor', funcao: 'Função',
  situacao: 'INATIVO', ativo: false, grupoHomogeneoId: 10, grupoHomogeneo: { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' },
};
const evento = (id, extra = {}) => ({
  id: String(id), tipo: 'ALTERACAO', ocorridoEm: '2026-10-11T01:15:00.000Z', anterior: 'ATIVO', novo: 'INATIVO', responsavel: { id: 7, nome: 'Responsável Fictício' }, ...extra,
});

async function abrir(eventos) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      'GET /funcionarios': { status: 200, corpo: { status: 'ok', funcionarios: [pessoa], total: 1, pagina: 1, limite: 20 } },
      'GET /fichas-epi': { status: 200, corpo: { status: 'ok', fichas: [], total: 0, pagina: 1, limite: 1 } },
      'GET /funcionarios/11': { status: 200, corpo: { status: 'ok', funcionario: pessoa } },
      'GET /funcionarios/11/eventos': (c) => {
        const tipo = new URL(c.url).searchParams.get('tipo');
        return { status: 200, corpo: { status: 'ok', funcionarioId: 11, tipo, eventos: tipo === 'SITUACAO' ? eventos : [], total: tipo === 'SITUACAO' ? eventos.length : 0, pagina: 1, limite: 20 } };
      },
    },
  });
  await pg.esperar();
  await pg.esperar();
  pg.el('historySearchValue').value = 'Pessoa';
  await pg.el('botaoConsultar').disparar('click');
  // Um único resultado é selecionado pela própria página (como nos demais testes do histórico).
  for (let i = 0; i < 5; i += 1) await pg.esperar();
  return pg;
}
const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const textoEvento = (pg, id) => {
  const e = pg.consulta(`#historySituacaoTimeline [data-evento-id="${id}"]`)[0];
  assert.ok(e, `o evento ${id} não está no histórico de situação`);
  return limpo(e.textContent);
};
const SUJEIRA = /\bnull\b|\bundefined\b|NaN|Invalid Date|\[object Object\]/;

describe('Histórico de Situação — data efetiva', () => {
  test('evento com dataEfetiva mostra "Data efetiva: dd/mm/aaaa" sem deslocamento de fuso (data civil)', async () => {
    const pg = await abrir([evento(901, { dataEfetiva: '2026-10-01' }), evento(902, { dataEfetiva: '2026-01-01', anterior: 'ATIVO', novo: 'AFASTADO' })]);
    assert.match(textoEvento(pg, 901), /Data efetiva:?\s*01\/10\/2026/);
    assert.match(textoEvento(pg, 902), /Data efetiva:?\s*01\/01\/2026/, '1º de janeiro não pode virar 31/12 por conversão de fuso');
  });

  test('evento sem dataEfetiva (antigo ou reativação de inativo) não mostra o rótulo, "—" nem sujeira', async () => {
    const pg = await abrir([evento(903), evento(904, { anterior: 'INATIVO', novo: 'ATIVO' })]);
    for (const id of [903, 904]) {
      const t = textoEvento(pg, id);
      assert.doesNotMatch(t, /Data efetiva/i, `evento ${id}`);
      assert.doesNotMatch(t, SUJEIRA);
    }
  });

  test('dataEfetiva fora do formato não é exibida (nenhum texto inventado)', async () => {
    const pg = await abrir([evento(905, { dataEfetiva: 'ontem' }), evento(906, { dataEfetiva: '2026-02-30' }), evento(907, { dataEfetiva: 20261001 })]);
    for (const id of [905, 906, 907]) {
      const t = textoEvento(pg, id);
      assert.doesNotMatch(t, /Data efetiva/i, `evento ${id}`);
      assert.doesNotMatch(t, SUJEIRA);
    }
  });

  test('o restante do evento continua como hoje: tipo, situação anterior e nova, data/hora da operação e responsável', async () => {
    const pg = await abrir([evento(908, { dataEfetiva: '2026-10-01' })]);
    const t = textoEvento(pg, 908);
    assert.match(t, /10\/10\/2026/, 'o instante da operação continua no fuso de São Paulo (22:15 do dia 10)');
    assert.match(t, /Alteração/);
    assert.match(t, /Situação anterior:?\s*Ativo/);
    assert.match(t, /Situação nova:?\s*Inativo/);
    assert.match(t, /Responsável Fictício/);
  });

  test('a página de histórico nunca altera situação: nenhuma chamada a /situacao, /inativar ou /reativar', async () => {
    const pg = await abrir([evento(909, { dataEfetiva: '2026-10-01' })]);
    assert.equal(pg.chamadas.some((c) => c.metodo !== 'GET' || /\/(situacao|inativar|reativar)$/.test(c.caminho)), false);
  });
});
