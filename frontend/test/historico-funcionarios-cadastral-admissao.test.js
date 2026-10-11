'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — pacote G, complemento RED: DATA DE ADMISSÃO no cartão "Histórico de Alterações Cadastrais".
 *
 * O servidor manda `{ campo: 'dataAdmissao', anterior, novo }` com datas YYYY-MM-DD; a tela mostra "Data de admissão" em
 * dd/mm/aaaa, sem deslocamento de fuso (2026-01-01 é 01/01/2026, nunca 31/12/2025); valor fora do formato vira "—", nunca
 * o texto cru. Crachá nunca aparece. A ficha resumida do A+B continua com os seis campos (sem admissão).
 */

const ARQUIVO = 'pages/employee-history.html';
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar: true }, epiFicha: { ...NENHUMA, visualizar: false } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok', usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const funcionario = { id: 11, empresaId: 3, nome: 'Pessoa 11', matricula: 'M-11', cpfMascarado: '***.***.***-25', setor: 'Setor 11', funcao: 'Função 11',
  cracha: 'CR-11', dataAdmissao: '2026-01-05', situacao: 'ATIVO', ativo: true, grupoHomogeneoId: 10, grupoHomogeneo: { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' } };
const A = (campo, anterior, novo) => ({ campo, anterior, novo });
const evento = (id, extra = {}) => ({ id: String(id), tipo: 'ALTERACAO', ocorridoEm: '2026-04-11T01:15:00.000Z', alteracoes: [], responsavel: { id: 7, nome: 'Responsável Fictício' }, ...extra });
const okEventos = (tipo, eventos) => ({ status: 200, corpo: { status: 'ok', funcionarioId: 11, tipo, eventos, total: eventos.length, pagina: 1, limite: 20 } });

async function abrirCom(eventosCadastrais) {
  const pg = abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      'GET /funcionarios': { status: 200, corpo: { status: 'ok', funcionarios: [funcionario], total: 1, pagina: 1, limite: 20 } },
      'GET /funcionarios/11': { status: 200, corpo: { status: 'ok', funcionario } },
      'GET /funcionarios/11/eventos': (c) => {
        const tipo = new URL(c.url).searchParams.get('tipo');
        return okEventos(tipo, tipo === 'CADASTRAL' ? eventosCadastrais : []);
      },
    },
  });
  await pg.esperar();
  await pg.esperar();
  pg.el('historySearchValue').value = 'Pessoa';
  await pg.el('botaoConsultar').disparar('click');
  for (let i = 0; i < 5; i += 1) await pg.esperar();
  return pg;
}
const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const textoEvento = (pg, id) => {
  const e = pg.consulta(`#historyCadastralTimeline [data-evento-id="${id}"]`)[0];
  assert.ok(e, `o evento ${id} não está no histórico cadastral`);
  return limpo(e.textContent);
};

describe('Data de admissão no histórico cadastral', () => {
  test('AF1 alteração: "Data de admissão: 05/01/2026 → 01/02/2026" (dd/mm/aaaa, nunca o texto YYYY-MM-DD)', async () => {
    const pg = await abrirCom([evento(1, { alteracoes: [A('dataAdmissao', '2026-01-05', '2026-02-01')] })]);
    const t = textoEvento(pg, 1);
    assert.match(t, /Data de admissão:? 05\/01\/2026 → 01\/02\/2026/);
    assert.equal(/2026-0[12]-0[15]/.test(t), false, t);
  });

  test('AF2 cadastro e importação: só o valor inicial formatado', async () => {
    const pg = await abrirCom([
      evento(2, { tipo: 'IMPORTACAO', alteracoes: [A('nome', null, 'Pessoa Importada'), A('dataAdmissao', null, '2025-11-03')] }),
      evento(1, { tipo: 'CADASTRO', alteracoes: [A('dataAdmissao', null, '2026-01-05')] }),
    ]);
    assert.match(textoEvento(pg, 2), /Data de admissão:? 03\/11\/2025/);
    assert.match(textoEvento(pg, 1), /Data de admissão:? 05\/01\/2026/);
    for (const id of [1, 2]) assert.equal(textoEvento(pg, id).includes('→'), false);
  });

  test('AF3 sem deslocamento de fuso: 2026-01-01 é 01/01/2026 (nunca 31/12/2025)', async () => {
    const pg = await abrirCom([evento(1, { alteracoes: [A('dataAdmissao', '2025-12-31', '2026-01-01')] })]);
    assert.match(textoEvento(pg, 1), /31\/12\/2025 → 01\/01\/2026/);
  });

  test('AF4 data junto com outro campo no mesmo evento: as duas linhas, na ordem do servidor', async () => {
    const pg = await abrirCom([evento(1, { alteracoes: [A('setor', 'Produção', 'Manutenção'), A('dataAdmissao', '2026-02-01', '2026-03-02')] })]);
    const t = textoEvento(pg, 1);
    assert.match(t, /Setor:? Produção → Manutenção[\s\S]*Data de admissão:? 01\/02\/2026 → 02\/03\/2026/);
  });

  test('AF5 valor fora do formato vira "—" (nunca o texto cru); nulo vira "—"', async () => {
    const pg = await abrirCom([evento(1, { alteracoes: [A('dataAdmissao', null, 'ontem às 10h')] })]);
    const t = textoEvento(pg, 1);
    assert.match(t, /Data de admissão:? — → —/);
    assert.equal(t.includes('ontem'), false);
  });

  test('AF6 crachá nunca aparece no histórico; a ficha do A+B continua com os seis campos, sem data de admissão', async () => {
    const pg = await abrirCom([evento(1, { alteracoes: [A('cracha', 'CR-1', 'CR-2'), A('dataAdmissao', '2026-01-05', '2026-02-01')] })]);
    const t = textoEvento(pg, 1);
    assert.equal(/CR-1|CR-2|[Cc]rach/.test(t), false, t);
    const html = semComentariosHtml(ler(ARQUIVO));
    const identificacao = html.slice(html.indexOf('id="historyEmployeeName"') - 400, html.indexOf('id="historyFichaEstado"'));
    assert.equal(/admiss/i.test(identificacao), false, 'a ficha resumida não ganha data de admissão');
    assert.equal(pg.textoDoDom().includes('CR-11'), false);
  });
});
