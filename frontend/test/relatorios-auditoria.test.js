'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler, semComentarios } = require('./helpers/dom-pagina');

const R = require('../js/relatorios');

/**
 * Relatório — Auditoria (12K-D5): módulo e página. Indicadores, solicitações aprovadas com entrega pendente, itens reprovados,
 * CAs vencidos (modal) e trilha de ações. Só leitura; o servidor decide os números.
 */

const ARQUIVO = 'pages/reports.html';
const ATAQUE = '<img src=x onerror=alert(1)>';

const solicitacao = (extra = {}) => ({
  solicitacaoId: 9, numero: 5, trabalhador: { nome: 'João Álvares' }, itens: [{ material: 'Botina', tamanho: '40', pendente: 3 }], aprovadoEm: '2026-09-26',
  aprovadoPor: { nome: 'Técnica SST' }, diasEmFila: 10, status: 'AGUARDANDO_ENTREGA', statusSolicitacao: 'APROVADA', ...extra,
});
const reprovada = (extra = {}) => ({
  itemId: 21, solicitacaoId: 9, numero: 5, trabalhador: { nome: 'João Álvares' }, item: { material: 'Botina', tamanho: '40' }, quantidade: 2,
  reprovadoEm: '2026-10-01', reprovadoPor: { nome: 'Técnica SST' }, motivo: 'Item fora da matriz do GHE', status: 'REPROVADO', ...extra,
});
const lote = (extra = {}) => ({
  loteId: 31, material: 'Óculos Ampla Visão', tamanho: 'Único', caNumero: '4444', caValidade: '2020-02-02', quantidadeDisponivel: 12, ...extra,
});
const evento = (extra = {}) => ({
  id: '55', criadoEm: '2026-10-06T15:30:00.000Z', usuario: { id: 4, nome: 'Pessoa Real' }, automatico: false, perfil: 'MASTER', acao: 'SOLICITACAO_EPI_DECIDIDA',
  referencia: '9', referenciaAmigavel: 'PED-0005 · João Álvares', ip: '198.51.100.7', dispositivo: 'Mozilla/5.0 ...', origem: { navegador: 'Chrome', sistema: 'Windows' }, ...extra,
});

describe('módulo: Auditoria — consulta, textos e CSV', () => {
  test('consultar envia só filtros válidos de cada tabela, com ordem padrão e paginação; nunca CPF', async () => {
    const chamadas = [];
    global.EpiHttp = { requisitar: async (m, c) => { chamadas.push([m, c]); return { ok: true }; } };
    await R.acoes.consultar('auditoriaSolicitacoes', { status: 'ATRASADO', item: 'botina' }, null, 1, 20);
    await R.acoes.consultar('auditoriaSolicitacoes', { status: 'PARCIALMENTE_ATENDIDA' }, { ordem: 'senha_hash' }, 1, 20);
    await R.acoes.consultar('auditoriaLog', { de: '2026-09-01', ate: '31/12/2026', usuario: 'Pessoa', acao: 'ENTREGA', busca: 'PED-5' }, null, 1, 20);
    await R.acoes.consultar('auditoriaLog', {}, { ordem: 'acao', direcao: 'asc' }, 1, 100);
    assert.deepEqual(chamadas.map((c) => c[1]), [
      '/relatorios/auditoria/solicitacoes-nao-atendidas?item=botina&ordem=diasEmFila&direcao=desc&pagina=1&limite=20',
      '/relatorios/auditoria/solicitacoes-nao-atendidas?status=PARCIALMENTE_ATENDIDA&ordem=diasEmFila&direcao=desc&pagina=1&limite=20',
      '/relatorios/auditoria/log?de=2026-09-01&usuario=Pessoa&acao=ENTREGA&busca=PED-5&ordem=dataHora&direcao=desc&pagina=1&limite=20',
      '/relatorios/auditoria/log?ordem=acao&direcao=asc&pagina=1&limite=100',
    ]);
    assert.equal(chamadas.some(([, c]) => /cpf|senha_hash|ATRASADO/i.test(c)), false, 'não existe "Atrasado" e nada sensível vai na URL');
    delete global.EpiHttp;
  });

  test('indicadores: os cinco números do servidor; sem número vira traço; rota própria', async () => {
    const chamadas = [];
    global.EpiHttp = { requisitar: async (m, c) => { chamadas.push([m, c]); return { ok: true }; } };
    await R.acoes.indicadoresAuditoria();
    assert.deepEqual(chamadas, [['GET', '/relatorios/auditoria/indicadores']]);
    delete global.EpiHttp;
    assert.deepEqual(R.modelo.indicadoresAuditoria({ indicadores: { entregasPendentes: 0, itensReprovados: 4, caVencidosEmEstoque: 2, logs30Dias: 148 } }),
      { entregasPendentes: '0', itensReprovados: '4', caVencidosEmEstoque: '2', logs30Dias: '148' });
    assert.deepEqual(R.modelo.indicadoresAuditoria({}), { entregasPendentes: '—', itensReprovados: '—', caVencidosEmEstoque: '—', logs30Dias: '—' });
  });

  test('solicitações não atendidas: colunas pedidas, "Aprovado por", nunca "Supervisor" nem "Atrasado"; status só os dois definidos', () => {
    assert.deepEqual(R.ABAS.auditoriaSolicitacoes.colunas.map((c) => c.rotulo), ['Pedido', 'Funcionário', 'EPI solicitado', 'Data da aprovação', 'Aprovado por', 'Dias em fila', 'Status']);
    assert.deepEqual(Object.keys(R.STATUS.auditoriaSolicitacoes), ['AGUARDANDO_ENTREGA', 'PARCIALMENTE_ATENDIDA']);
    assert.deepEqual(Object.values(R.STATUS.auditoriaSolicitacoes).map((x) => x.rotulo), ['Aguardando entrega', 'Parcialmente atendida']);
    const csv = R.modelo.csv('auditoriaSolicitacoes', [solicitacao(), solicitacao({ numero: 6, status: 'PARCIALMENTE_ATENDIDA', diasEmFila: 0 })]).slice(1).split('\r\n');
    assert.equal(csv[1], '"PED-0005";"João Álvares";"Botina (falta 3)";"26/09/2026";"Técnica SST";"10";"Aguardando entrega"');
    assert.match(csv[2], /"0";"Parcialmente atendida"$/);
    assert.equal(/Supervisor|Atrasad/i.test(csv.join('') + JSON.stringify(R.ABAS.auditoriaSolicitacoes.colunas.map((c) => c.rotulo))), false);
  });

  test('trilha: data/hora de São Paulo, sistema automático, perfil sem snapshot vira traço, referência amigável com a original, origem derivada', () => {
    assert.deepEqual(R.ABAS.auditoriaLog.colunas.map((c) => c.rotulo), ['Data / Hora', 'Usuário', 'Perfil', 'Ação', 'Referência', 'IP / Dispositivo']);
    const csv = R.modelo.csv('auditoriaLog', [
      evento(),
      evento({ id: '56', usuario: null, automatico: true, perfil: null, ip: null, dispositivo: null, origem: null, referenciaAmigavel: null, referencia: 'job-1' }),
      evento({ id: '57', origem: null, dispositivo: 'curl/8.0', ip: '198.51.100.8', perfil: null }),
    ]).slice(1).split('\r\n');
    assert.equal(csv[1], '"06/10/2026 12:30";"Pessoa Real";"MASTER";"SOLICITACAO_EPI_DECIDIDA";"PED-0005 · João Álvares";"198.51.100.7 · Chrome · Windows"');
    assert.equal(csv[2], '"06/10/2026 12:30";"Sistema automático";"—";"SOLICITACAO_EPI_DECIDIDA";"job-1";"—"');
    assert.match(csv[3], /"—";"SOLICITACAO_EPI_DECIDIDA";.*"198\.51\.100\.8 · curl\/8\.0"$/);
    assert.equal(/hash|token|senha|cpf/i.test(csv.join('')), false);
  });

  test('erro do período máximo e textos próprios', () => {
    assert.equal(R.modelo.erro({ status: 400, codigo: 'PERIODO_MAXIMO_EXCEDIDO' }), R.TEXTOS.PERIODO_MAXIMO);
    assert.equal(R.modelo.nomeArquivo('auditoriaLog', '2026-10-06'), 'relatorio-auditoria-log-de-acoes-2026-10-06.csv');
    assert.equal(R.ABAS.auditoriaCaVencidos.arquivo, undefined, 'o modal é só resumo: sem exportação própria');
  });
});

// ── página ──────────────────────────────────────────────────────────
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
function permissoes({ materiais = false, ficha: epi = false, auditoria = true, validade = true } = {}) {
  return {
    status: 'ok', empresaId: 3, usuarioId: 1, perfil: 'USUARIO',
    recursos: { materials: { ...NENHUMA, visualizar: materiais }, epiFicha: { ...NENHUMA, visualizar: epi }, reportsAudit: { ...NENHUMA, visualizar: auditoria }, stockValidity: { ...NENHUMA, visualizar: validade } },
    acoes: {},
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
    },
  };
}
const contexto = () => ({
  status: 'ok', usuario: { id: 1, nome: 'Pessoa', email: 'p@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'Empresa Teste', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const lista = (itens) => ({ status: 200, corpo: { status: 'ok', itens, total: itens.length, pagina: 1, limite: 20 } });

function abrir({ rotas = {}, transformar = null, ...perm } = {}) {
  return abrirPagina(ARQUIVO, {
    transformar,
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes(perm) },
      'GET /relatorios/auditoria/indicadores': () => ({ status: 200, corpo: { status: 'ok', indicadores: { entregasPendentes: 5, itensReprovados: 4, caVencidosEmEstoque: 2, logs30Dias: 148 } } }),
      'GET /relatorios/auditoria/solicitacoes-reprovadas': () => lista([reprovada(), reprovada({ itemId: 22, numero: 6, item: { material: 'Luva', tamanho: null }, quantidade: 6, motivo: '=cmd|\' /C calc\'!A0' }), reprovada({ itemId: 23, numero: 7, trabalhador: { nome: ATAQUE } })]),
      // Prévia: o modal pede só 5; o servidor diz que existem 18.
      'GET /relatorios/auditoria/ca-vencidos': () => ({ status: 200, corpo: { status: 'ok', itens: [lote(), lote({ loteId: 32, material: 'Capacete Classe B', tamanho: null, caNumero: '3333', quantidadeDisponivel: 5 }), lote({ loteId: 33, caNumero: '5555', quantidadeDisponivel: 1 }), lote({ loteId: 34, caNumero: '5556', quantidadeDisponivel: 2 }), lote({ loteId: 35, caNumero: '5557', quantidadeDisponivel: 3 })], total: 18, pagina: 1, limite: 5 } }),
      'GET /relatorios/auditoria/solicitacoes-nao-atendidas': () => lista([solicitacao(), solicitacao({ solicitacaoId: 10, numero: 6, status: 'PARCIALMENTE_ATENDIDA' })]),
      'GET /relatorios/auditoria/log': () => lista([evento(), evento({ id: '56', usuario: null, automatico: true, perfil: null, ip: null, dispositivo: null, origem: null })]),
      'GET /relatorios/estoque': () => ({ status: 200, corpo: { status: 'ok', indicadores: {}, alertas: [], linhas: [], total: 0, pagina: 1, limite: 20 } }),
      'GET /relatorios/proximo-vencimento': () => lista([]),
      ...rotas,
    },
  });
}
async function pronta(opcoes) {
  const pg = abrir(opcoes);
  await pg.esperar();
  await pg.esperar();
  return pg;
}
const consultas = (pg, rota) => pg.chamadas.filter((c) => c.chave === `GET /relatorios/${rota}`);
const celulas = (tr) => tr.children.map((td) => td.textContent.trim());
const cabecalho = (pg, id) => pg.consulta(`#cabecalho-${id} th`).map((th) => th.textContent.replace(/[ ▲▼]+$/, '').trim());

describe('Relatório — Auditoria — página (DOM simulado, sessão e permissões reais)', () => {
  test('só reportsAudit: a Auditoria é a primeira aba permitida e abre sozinha; as outras ficam ocultas e nada delas é consultado', async () => {
    const pg = await pronta();
    const visiveis = pg.consulta('.report-tab[data-recurso]').filter((b) => pg.visivelNo(b)).map((b) => b.getAttribute('data-secao'));
    assert.deepEqual(visiveis, ['reportAudit']);
    assert.ok(pg.consulta('.report-tab.active')[0].textContent.includes('Auditoria'));
    assert.equal(pg.consulta('#reportAudit.active').length, 1);
    for (const rota of ['estoque', 'proximo-vencimento', 'vencidos', 'epis-entregues']) assert.equal(consultas(pg, rota).length, 0, rota);
    for (const rota of ['auditoria/indicadores', 'auditoria/solicitacoes-nao-atendidas', 'auditoria/solicitacoes-reprovadas', 'auditoria/log']) assert.equal(consultas(pg, rota).length, 1, rota);
    assert.equal(consultas(pg, 'auditoria/ca-vencidos').length, 0, 'o modal só consulta quando é aberto');
  });

  test('sem reportsAudit a aba some e nenhuma rota da auditoria é chamada', async () => {
    const pg = await pronta({ auditoria: false, materiais: true });
    assert.equal(pg.consulta('.report-tab[data-recurso="reportsAudit"]').filter((b) => pg.visivelNo(b)).length, 0);
    for (const rota of ['auditoria/indicadores', 'auditoria/solicitacoes-nao-atendidas', 'auditoria/solicitacoes-reprovadas', 'auditoria/ca-vencidos', 'auditoria/log']) assert.equal(consultas(pg, rota).length, 0, rota);
    assert.equal(consultas(pg, 'estoque').length, 1, 'a primeira aba permitida é a do estoque');
  });

  test('com várias permissões a primeira aba permitida (na ordem da tela) abre; a Auditoria carrega só quando aberta', async () => {
    const pg = await pronta({ materiais: true, auditoria: true });
    assert.equal(consultas(pg, 'estoque').length, 1);
    assert.equal(consultas(pg, 'auditoria/log').length, 0, 'ainda não aberta');
    await pg.consulta('.report-tab[data-recurso="reportsAudit"]')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.equal(consultas(pg, 'auditoria/log').length, 1);
    await pg.consulta('.report-tab[data-recurso="reportsAudit"]')[0].disparar('click');
    await pg.esperar();
    assert.equal(consultas(pg, 'auditoria/log').length, 1, 'carrega uma vez');
  });

  test('indicadores reais do servidor, na ordem e com os rótulos pedidos; nenhum número fixo', async () => {
    const pg = await pronta();
    assert.deepEqual(['auditPendentes', 'auditCa', 'auditLogs', 'auditReprovados'].map((id) => pg.texto(id)), ['5', '2', '148', '4']);
    const rotulos = pg.consulta('#reportAudit .stat').map((e) => e.children[0].textContent.trim());
    assert.deepEqual(rotulos, ['Entregas pendentes', 'CA vencidos em estoque', 'Logs registrados (30d)', 'Itens reprovados']);
    assert.equal(/Fichas sem assinatura|assinatura desenhada|Aceite presencial|Notificar/i.test(pg.texto('reportAudit')), false, 'o card, a seção e a ação de fichas sem assinatura saíram');
    assert.match(pg.texto('reportAudit'), /Itens aprovados ainda a entregar\./);
    assert.equal(/Solicitações aprovadas com quantidade a entregar/.test(pg.texto('reportAudit')), false, 'a descrição antiga saiu');
    const sem = await pronta({ rotas: { 'GET /relatorios/auditoria/indicadores': () => ({ status: 500, corpo: { status: 'erro' } }) } });
    assert.deepEqual(['auditPendentes', 'auditCa', 'auditLogs', 'auditReprovados'].map((id) => sem.texto(id)), ['—', '—', '—', '—']);
  });

  test('ordem visual: indicadores, solicitações pendentes, reprovadas e trilha; colunas de cada tabela como definido', async () => {
    const pg = await pronta();
    const ids = pg.consulta('#reportAudit table').map((t) => t.querySelectorAll('thead')[0].getAttribute('id'));
    assert.equal(/Solicitações aprovadas não atendidas/.test(pg.texto('reportAudit')), false, 'o título antigo saiu');
    assert.deepEqual(ids.filter((i) => i !== 'cabecalho-auditoriaCaVencidos'), ['cabecalho-auditoriaSolicitacoes', 'cabecalho-auditoriaReprovadas', 'cabecalho-auditoriaLog']);
    assert.deepEqual(cabecalho(pg, 'auditoriaSolicitacoes'), ['Pedido', 'Funcionário', 'EPI solicitado', 'Data da aprovação', 'Aprovado por', 'Dias em fila', 'Status']);
    assert.deepEqual(cabecalho(pg, 'auditoriaLog'), ['Data / Hora', 'Usuário', 'Perfil', 'Ação', 'Referência', 'IP / Dispositivo']);
    const titulos = pg.consulta('#reportAudit .card-header h2').map((h) => h.textContent.trim());
    assert.deepEqual(titulos.filter((t) => t !== 'CAs vencidos em estoque'), ['Solicitações aprovadas pelo SST com entrega pendente', 'Solicitações reprovadas pelo SST', 'Log de ações — trilha de auditoria']);
    assert.deepEqual(['exportar-auditoriaSolicitacoes', 'exportar-auditoriaReprovadas', 'exportar-auditoriaLog'].map((id) => pg.consulta(`#${id}`)[0].textContent.trim().replace(/^download/, '')), ['Exportar', 'Exportar', 'Exportar log']);
    assert.deepEqual(cabecalho(pg, 'auditoriaReprovadas'), ['Pedido', 'Funcionário', 'Item solicitado', 'Quantidade', 'Data da reprovação', 'Reprovado por', 'Motivo', 'Status']);
  });

  test('solicitações: status só os dois definidos, dias em fila e "Aprovado por"; sem "Atrasado" nem "Supervisor"', async () => {
    const pg = await pronta();
    const linhas = pg.consulta('#corpo-auditoriaSolicitacoes tr');
    assert.deepEqual(celulas(linhas[0]), ['PED-0005', 'João Álvares', 'Botina (falta 3)', '26/09/2026', 'Técnica SST', '10', 'Aguardando entrega']);
    assert.equal(celulas(linhas[1])[6], 'Parcialmente atendida');
    assert.equal(/Atrasad|Supervisor/i.test(pg.texto('reportAudit')), false);
  });

  test('trilha: data/hora, usuário, perfil, ação, referência amigável e IP/dispositivo; automático e sem snapshot sem inventar', async () => {
    const pg = await pronta();
    const [humano, automatico] = pg.consulta('#corpo-auditoriaLog tr').map(celulas);
    assert.deepEqual(humano, ['06/10/2026 12:30', 'Pessoa Real', 'MASTER', 'SOLICITACAO_EPI_DECIDIDA', 'PED-0005 · João ÁlvaresRegistrada: 9', '198.51.100.7 · Chrome · Windows']);
    assert.deepEqual(automatico.slice(0, 3), ['06/10/2026 12:30', 'Sistema automático', '—']);
    assert.equal(automatico[5], '—');
  });

  test('filtros da trilha: período, usuário, ação e referência vão ao servidor; período invertido não consulta', async () => {
    const pg = await pronta();
    const parametros = () => [...new URL(consultas(pg, 'auditoria/log').at(-1).url).searchParams.entries()];
    assert.deepEqual(parametros(), [['ordem', 'dataHora'], ['direcao', 'desc'], ['pagina', '1'], ['limite', '20']], 'padrão: sem parâmetros de filtro (30 dias no servidor)');
    const areaFiltros = pg.consulta('#filtros-auditoriaLog')[0];
    const campo = (nome) => areaFiltros.querySelectorAll(`[data-filtro="${nome}"]`)[0];
    campo('usuario').value = 'Pessoa';
    campo('acao').value = 'ENTREGA';
    campo('busca').value = 'PED-5';
    campo('de').value = '2026-09-10';
    campo('ate').value = '2026-10-06';
    await areaFiltros.querySelectorAll('[data-acao-relatorio="filtrar"]')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.deepEqual(parametros(), [['de', '2026-09-10'], ['ate', '2026-10-06'], ['usuario', 'Pessoa'], ['acao', 'ENTREGA'], ['busca', 'PED-5'], ['ordem', 'dataHora'], ['direcao', 'desc'], ['pagina', '1'], ['limite', '20']]);
    const antes = consultas(pg, 'auditoria/log').length;
    campo('de').value = '2026-12-01';
    await areaFiltros.querySelectorAll('[data-acao-relatorio="filtrar"]')[0].disparar('click');
    await pg.esperar();
    assert.equal(consultas(pg, 'auditoria/log').length, antes);
    assert.match(pg.texto('aviso'), /Período inválido/);
  });

  test('período acima do máximo, 403 e vazio têm texto próprio', async () => {
    const excedido = await pronta({ rotas: { 'GET /relatorios/auditoria/log': () => ({ status: 400, corpo: { status: 'erro', codigo: 'PERIODO_MAXIMO_EXCEDIDO', message: 'x' } }) } });
    assert.equal(excedido.consulta('#corpo-auditoriaLog tr')[0].textContent.trim(), R.TEXTOS.PERIODO_MAXIMO);
    const negado = await pronta({ rotas: { 'GET /relatorios/auditoria/solicitacoes-nao-atendidas': () => ({ status: 403, corpo: { status: 'erro', codigo: 'SEM_PERMISSAO' } }) } });
    assert.equal(negado.consulta('#corpo-auditoriaSolicitacoes tr')[0].textContent.trim(), R.TEXTOS.SEM_AUTORIDADE);
    const vazio = await pronta({ rotas: { 'GET /relatorios/auditoria/solicitacoes-nao-atendidas': () => lista([]) } });
    assert.equal(vazio.consulta('#corpo-auditoriaSolicitacoes tr')[0].textContent.trim(), R.TEXTOS.VAZIO_SOLICITACOES);
  });

  test('solicitações reprovadas: uma linha por item, motivo, quem reprovou e "Reprovado"; fórmula do motivo é neutralizada no CSV', async () => {
    const pg = await pronta();
    const linhas = pg.consulta('#corpo-auditoriaReprovadas tr').map(celulas);
    assert.deepEqual(linhas[0], ['PED-0005', 'João Álvares', 'Botina (tam. 40)', '2', '01/10/2026', 'Técnica SST', 'Item fora da matriz do GHE', 'Reprovado']);
    assert.equal(linhas[1][2], 'Luva', 'sem tamanho, só o nome');
    assert.equal(linhas[2][1], ATAQUE, 'o nome vindo do servidor é texto puro');
    assert.equal(pg.consulta('#corpo-auditoriaReprovadas img').length, 0, 'nunca HTML');
    assert.equal(consultas(pg, 'auditoria/solicitacoes-reprovadas').length, 1);
    const csv = R.modelo.csv('auditoriaReprovadas', [reprovada({ motivo: '=SOMA(1;2)' })]).slice(1).split('\r\n');
    assert.equal(csv[0], '"Pedido";"Funcionário";"Item solicitado";"Quantidade";"Data da reprovação";"Reprovado por";"Motivo";"Status"');
    assert.equal(csv[1], '"PED-0005";"João Álvares";"Botina (tam. 40)";"2";"01/10/2026";"Técnica SST";"\'=SOMA(1;2)";"Reprovado"');
  });

  test('filtros das reprovadas (período da reprovação, funcionário, item) vão ao servidor; sem setor; período invertido não consulta', async () => {
    const pg = await pronta();
    const parametros = () => [...new URL(consultas(pg, 'auditoria/solicitacoes-reprovadas').at(-1).url).searchParams.entries()];
    assert.deepEqual(parametros(), [['ordem', 'dataReprovacao'], ['direcao', 'desc'], ['pagina', '1'], ['limite', '20']]);
    const areaFiltros = pg.consulta('#filtros-auditoriaReprovadas')[0];
    assert.deepEqual(areaFiltros.querySelectorAll('[data-filtro]').map((c) => c.getAttribute('data-filtro')), ['de', 'ate', 'funcionario', 'item']);
    const campo = (nome) => areaFiltros.querySelectorAll(`[data-filtro="${nome}"]`)[0];
    campo('de').value = '2026-09-01';
    campo('ate').value = '2026-10-06';
    campo('funcionario').value = 'joão';
    campo('item').value = 'botina';
    await areaFiltros.querySelectorAll('[data-acao-relatorio="filtrar"]')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.deepEqual(parametros(), [['de', '2026-09-01'], ['ate', '2026-10-06'], ['funcionario', 'joão'], ['item', 'botina'], ['ordem', 'dataReprovacao'], ['direcao', 'desc'], ['pagina', '1'], ['limite', '20']]);
    const antes = consultas(pg, 'auditoria/solicitacoes-reprovadas').length;
    campo('de').value = '2026-12-01';
    await areaFiltros.querySelectorAll('[data-acao-relatorio="filtrar"]')[0].disparar('click');
    await pg.esperar();
    assert.equal(consultas(pg, 'auditoria/solicitacoes-reprovadas').length, antes);
  });

  test('card "CA vencidos em estoque" é clicável (cursor e destaque); os demais cards não são', async () => {
    const pg = await pronta();
    const cartao = pg.consulta('#cartaoCa')[0];
    assert.match(cartao.getAttribute('class'), /clicavel/);
    assert.equal(cartao.getAttribute('role'), 'button');
    assert.equal(cartao.getAttribute('tabindex'), '0');
    assert.equal(pg.consulta('#reportAudit .stat.clicavel').length, 1);
    const css = ler(ARQUIVO);
    assert.match(css, /\.stat\.clicavel\{cursor:pointer/);
    assert.match(css, /\.stat\.clicavel:hover/);
  });

  const abrirModal = async (opcoes) => {
    const pg = await pronta(opcoes);
    await pg.consulta('#cartaoCa')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    return pg;
  };
  const linhasDoModal = (pg) => pg.consulta('#corpo-auditoriaCaVencidos tr').map(celulas);

  test('módulo: a prévia pede só 5 linhas, sem ordenação; o resumo diz "Exibindo N de M"; o destino é a Validade de Estoque filtrada por CA vencido', async () => {
    const chamadas = [];
    global.EpiHttp = { requisitar: async (m, c) => { chamadas.push([m, c]); return { ok: true }; } };
    await R.acoes.consultar('auditoriaCaVencidos', {}, null, 1, R.LIMITE_PREVIA_CA);
    delete global.EpiHttp;
    assert.deepEqual(chamadas, [['GET', '/relatorios/auditoria/ca-vencidos?pagina=1&limite=5']]);
    assert.equal(R.modelo.resumoCaVencidos(5, 18), 'Exibindo 5 de 18 CAs vencidos');
    assert.equal(R.modelo.resumoCaVencidos(2, 2), '2 CAs vencidos');
    assert.equal(R.modelo.resumoCaVencidos(1, 1), '1 CA vencido');
    assert.equal(R.modelo.resumoCaVencidos(0, 0), '');
    assert.deepEqual(R.ABAS.auditoriaCaVencidos.colunas.map((c) => c.rotulo), ['Produto / EPI', 'CA', 'Validade do CA', 'Lote', 'Quantidade disponível']);
    // A tela Validade de Estoque já aceita este filtro na URL: o atalho reutiliza a regra dela, sem lógica duplicada.
    assert.equal(R.DESTINO_CA_VENCIDO, 'stock-validity.html?situacao=VENCIDO');
    assert.equal(require('../js/validade-estoque').filtroDaUrl('?situacao=VENCIDO'), 'VENCIDO'); // eslint-disable-line global-require
  });

  test('modal-resumo: título, colunas, só as primeiras linhas, "Exibindo 5 de 18 CAs vencidos", quantidade disponível e nenhuma exportação ou baixa', async () => {
    const pg = await pronta();
    assert.equal(pg.visivel('modalCa'), false);
    assert.equal(consultas(pg, 'auditoria/ca-vencidos').length, 0, 'só consulta quando o card é clicado');
    await pg.consulta('#cartaoCa')[0].disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.equal(pg.visivel('modalCa'), true);
    assert.equal(pg.texto('modalCaTitulo').trim(), 'CAs vencidos em estoque');
    assert.match(pg.texto('modalCa'), /A investigação e a tratativa são feitas em Validade de Estoque; nenhuma baixa é feita por aqui/);
    assert.deepEqual(cabecalho(pg, 'auditoriaCaVencidos'), ['Produto / EPI', 'CA', 'Validade do CA', 'Lote', 'Quantidade disponível']);
    const linhas = linhasDoModal(pg);
    assert.equal(linhas.length, 5);
    assert.deepEqual(linhas[0], ['Óculos Ampla Visão', '4444', '02/02/2020', '#31 · Tam. Único', '12']);
    assert.deepEqual(linhas[1], ['Capacete Classe B', '3333', '02/02/2020', '#32 · Tam. Único', '5']);
    assert.equal(pg.texto('modalCaResumo').trim(), 'Exibindo 5 de 18 CAs vencidos');
    const url = new URL(consultas(pg, 'auditoria/ca-vencidos').at(-1).url);
    assert.deepEqual([...url.searchParams.entries()], [['pagina', '1'], ['limite', '5']]);
    assert.equal(pg.consulta('#exportar-auditoriaCaVencidos').length, 0, 'sem exportação no modal');
    assert.equal(/Exportar|Excel/.test(pg.texto('modalCa')), false);
    assert.ok(pg.chamadas.length > 0 && pg.chamadas.every((c) => c.chave.startsWith('GET ')), 'só leituras');
    assert.equal(pg.chamadas.some((c) => /baixa|estoque\/lotes/i.test(c.url)), false, 'nenhuma baixa de estoque');
  });

  test('modal: "Ver todos em Validade de Estoque" é um link para a tela existente já filtrada (nada navega sozinho)', async () => {
    const pg = await abrirModal();
    const link = pg.consulta('#verTodosValidade')[0];
    assert.equal(link.textContent.trim().replace(/^open_in_new/, ''), 'Ver todos em Validade de Estoque');
    assert.equal(link.localName, 'a');
    assert.equal(link.getAttribute('href'), R.DESTINO_CA_VENCIDO);
    assert.equal(pg.visivelNo(link), true);
    assert.equal(pg.visivel('modalCa'), true, 'abrir o modal não navegou');
  });

  test('modal: sem a permissão de abrir a Validade de Estoque o atalho não aparece, mas o resumo continua', async () => {
    const pg = await abrirModal({ validade: false });
    assert.equal(pg.visivel('modalCa'), true);
    assert.equal(linhasDoModal(pg).length, 5);
    assert.equal(pg.visivelNo(pg.consulta('#verTodosValidade')[0]), false);
  });

  test('modal: com até 5 registros mostra só a contagem, sem "Exibindo"', async () => {
    const dois = { status: 200, corpo: { status: 'ok', itens: [lote(), lote({ loteId: 32 })], total: 2, pagina: 1, limite: 5 } };
    const pg = await abrirModal({ rotas: { 'GET /relatorios/auditoria/ca-vencidos': () => dois } });
    assert.equal(pg.texto('modalCaResumo').trim(), '2 CAs vencidos');
    assert.equal(linhasDoModal(pg).length, 2);
  });

  test('modal: sem CAs vencidos o estado vazio informa e o atalho não aparece (e o card mostra 0)', async () => {
    const zero = { status: 200, corpo: { status: 'ok', itens: [], total: 0, pagina: 1, limite: 5 } };
    const pg = await abrirModal({ rotas: {
      'GET /relatorios/auditoria/ca-vencidos': () => zero,
      'GET /relatorios/auditoria/indicadores': () => ({ status: 200, corpo: { status: 'ok', indicadores: { entregasPendentes: 0, itensReprovados: 0, caVencidosEmEstoque: 0, logs30Dias: 1 } } }),
    } });
    assert.equal(pg.texto('auditCa'), '0');
    assert.equal(pg.consulta('#corpo-auditoriaCaVencidos tr')[0].textContent.trim(), 'Não há CAs vencidos em estoque.');
    assert.equal(pg.texto('modalCaResumo').trim(), '');
    assert.equal(pg.visivelNo(pg.consulta('#verTodosValidade')[0]), false);
  });

  test('modal: Fechar, Escape e clique fora fecham; reabrir consulta de novo', async () => {
    const pg = await abrirModal();
    assert.equal(pg.consulta('#fecharModalCa')[0].textContent.trim(), 'Fechar');
    await pg.consulta('#fecharModalCa')[0].disparar('click');
    assert.equal(pg.visivel('modalCa'), false);
    await pg.consulta('#cartaoCa')[0].disparar('keydown', { key: 'Enter' });
    await pg.esperar();
    await pg.esperar();
    assert.equal(pg.visivel('modalCa'), true);
    assert.equal(consultas(pg, 'auditoria/ca-vencidos').length, 2);
    await pg.consulta('#modalCa')[0].disparar('keydown', { key: 'Escape' });
    assert.equal(pg.visivel('modalCa'), false);
    await pg.consulta('#cartaoCa')[0].disparar('click');
    await pg.esperar();
    await pg.consulta('#modalCa')[0].disparar('click');
    assert.equal(pg.visivel('modalCa'), false, 'clique no fundo fecha');
  });

  test('modal: erro e 403 têm texto próprio e o atalho fica oculto', async () => {
    const negado = await abrirModal({ rotas: { 'GET /relatorios/auditoria/ca-vencidos': () => ({ status: 403, corpo: { status: 'erro', codigo: 'SEM_PERMISSAO' } }) } });
    assert.equal(negado.consulta('#corpo-auditoriaCaVencidos tr')[0].textContent.trim(), R.TEXTOS.SEM_AUTORIDADE);
    assert.equal(negado.visivelNo(negado.consulta('#verTodosValidade')[0]), false);
    const quebrado = await abrirModal({ rotas: { 'GET /relatorios/auditoria/ca-vencidos': () => ({ status: 500, corpo: { status: 'erro' } }) } });
    assert.equal(quebrado.consulta('#corpo-auditoriaCaVencidos tr')[0].textContent.trim(), R.TEXTOS.FALHA);
  });

  test('a seção é só leitura e segura: sem innerHTML nem armazenamento; o menu e a página abrem por reportsAudit', () => {
    for (const fonte of [semComentarios(ler(ARQUIVO)), semComentarios(ler('js/relatorios.js'))]) {
      assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB/.test(fonte), false);
    }
    assert.match(ler(ARQUIVO), /data-recurso="reportsAudit" data-carregar="auditoriaSolicitacoes auditoriaReprovadas auditoriaLog"/);
    assert.equal(ler(ARQUIVO).includes('data-aba'), false, 'a página usa só data-recurso e data-carregar');
    const P = require('../js/permissoes-efetivas'); // eslint-disable-line global-require
    assert.equal(P.podeAbrir({ ...permissoes({ auditoria: true }) }, 'reports'), true);
    assert.equal(P.podeAbrir({ ...permissoes({ auditoria: false }) }, 'reports'), false);
  });
});
