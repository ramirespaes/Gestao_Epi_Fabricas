'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina, ler } = require('./helpers/dom-pagina');

const R = require('../js/relatorios');

/**
 * Relatório — Fiscalização (12K-D6): módulo e página. Configurar → pré-visualizar → gerar → histórico → baixar. O servidor decide
 * limites, contagens e o pacote; a tela valida o que o servidor também valida e nunca monta o ZIP.
 */
const ARQUIVO = 'pages/reports.html';
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const ESC = ['FICHAS_ENTREGAS_CONFIRMADAS', 'TRILHA_AUDITORIA', 'HISTORICO_ESTOQUE_CA', 'REGRAS_GHE'];

const permissoes = ({ fiscal = true, auditoria = false } = {}) => ({
  status: 'ok', empresaId: 3, usuarioId: 1, perfil: 'USUARIO',
  recursos: { reportsFiscal: { ...NENHUMA, visualizar: fiscal }, reportsAudit: { ...NENHUMA, visualizar: auditoria } },
  acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok', usuario: { id: 1, nome: 'Pessoa', email: 'p@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'Empresa Teste', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const pacote = (extra = {}) => ({
  id: 12, status: 'CONCLUIDO', periodoInicio: '2026-09-01', periodoFim: '2026-09-30', finalidade: 'AUDITORIA_INTERNA', escopos: ESC.slice(0, 2),
  criadoEm: '2026-10-06T15:30:00.000Z', concluidoEm: '2026-10-06T15:31:00.000Z', geradoPor: { nome: 'Pessoa Real' }, tamanhoBytes: 2048, sha256: 'a'.repeat(64), erroCodigo: null, ...extra,
});
const previaOk = (linhas = {}) => ({
  status: 200,
  corpo: {
    status: 'ok',
    previa: {
      periodo: { inicio: '2026-09-01', fim: '2026-09-30', dias: 30 }, podeGerar: true, limiteLinhasPorModulo: 100000,
      escopos: ESC.map((escopo) => ({ escopo, linhas: linhas[escopo] ?? 5, vazio: (linhas[escopo] ?? 5) === 0, excedeLimite: false })),
    },
  },
});

function abrir({ rotas = {}, ...perm } = {}) {
  return abrirPagina(ARQUIVO, {
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes(perm) },
      'GET /relatorios/fiscalizacao/pacotes': () => ({ status: 200, corpo: { status: 'ok', itens: [pacote(), pacote({ id: 11, status: 'FALHA', erroCodigo: 'ZIP_EXCEDE_LIMITE', sha256: null })], total: 2, pagina: 1, limite: 20 } }),
      'POST /relatorios/fiscalizacao/previa': () => previaOk(),
      'POST /relatorios/fiscalizacao/pacotes': () => ({ status: 201, corpo: { status: 'ok', pacote: pacote({ id: 13 }) } }),
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
const chamadas = (pg, chave) => pg.chamadas.filter((c) => c.chave === chave);
async function definir(pg, id, valor) {
  const campo = pg.consulta(`#${id}`)[0];
  campo.value = valor;
  await campo.disparar('input');
  await campo.disparar('change');
}
async function preencher(pg, { inicio = '2026-09-01', fim = '2026-09-30', finalidade = 'AUDITORIA_INTERNA', observacao = '', escopos = ESC } = {}) {
  await definir(pg, 'fiscInicio', inicio);
  await definir(pg, 'fiscFim', fim);
  await definir(pg, 'fiscFinalidade', finalidade);
  await definir(pg, 'fiscObservacao', observacao);
  for (const e of ESC) await pg.marcar(`fiscEscopo-${e}`, escopos.includes(e));
}

describe('módulo: Fiscalização — contrato do formulário', () => {
  test('finalidades e módulos do pedido, com a nomenclatura correta (confirmadas, nunca "assinadas")', () => {
    assert.deepEqual(R.fiscal.FINALIDADES.map((f) => f.valor), ['FISCALIZACAO_TRABALHO', 'AUDITORIA_CLIENTE', 'AUDITORIA_INTERNA', 'SOLICITACAO_JURIDICA_DOCUMENTAL', 'OUTRA']);
    assert.deepEqual(R.fiscal.FINALIDADES.map((f) => f.rotulo), ['Fiscalização do Trabalho', 'Auditoria de cliente', 'Auditoria interna', 'Solicitação jurídica/documental', 'Outra']);
    assert.deepEqual(R.fiscal.ESCOPOS.map((s) => s.valor), ESC);
    assert.deepEqual(R.fiscal.ESCOPOS.map((s) => s.rotulo), ['Fichas/entregas de EPI confirmadas', 'Trilha de auditoria completa', 'Histórico de estoque e CA', 'Regras de GHE e elegibilidade']);
    assert.equal(/assinad/i.test(JSON.stringify([R.fiscal.FINALIDADES, R.fiscal.ESCOPOS])), false);
  });

  test('período: 366 dias inclusivos passam e 367 não; o mesmo dia vale 1', () => {
    assert.equal(R.fiscal.DIAS_MAXIMOS, 366);
    assert.equal(R.fiscal.diasInclusivos('2026-01-01', '2026-01-01'), 1);
    assert.equal(R.fiscal.diasInclusivos('2026-01-01', '2027-01-01'), 366);
    const base = { finalidade: 'AUDITORIA_INTERNA', observacao: '', escopos: ESC };
    assert.equal(R.fiscal.validar({ ...base, periodoInicio: '2026-01-01', periodoFim: '2027-01-01' }).ok, true);
    const longo = R.fiscal.validar({ ...base, periodoInicio: '2026-01-01', periodoFim: '2027-01-02' });
    assert.equal(longo.ok, false);
    assert.ok(longo.erros.periodoFim);
  });

  test('validar repete as regras do servidor: finalidade, "Outra" com observação, pelo menos um módulo, datas e tamanho', () => {
    const ok = { periodoInicio: '2026-09-01', periodoFim: '2026-09-30', finalidade: 'AUDITORIA_CLIENTE', observacao: '', escopos: [ESC[0]] };
    assert.equal(R.fiscal.validar(ok).ok, true);
    assert.ok(R.fiscal.validar({ ...ok, finalidade: '' }).erros.finalidade);
    assert.ok(R.fiscal.validar({ ...ok, finalidade: 'CURIOSIDADE' }).erros.finalidade);
    assert.ok(R.fiscal.validar({ ...ok, finalidade: 'OUTRA', observacao: '  ' }).erros.observacao);
    assert.equal(R.fiscal.validar({ ...ok, finalidade: 'OUTRA', observacao: 'Pedido do sindicato' }).ok, true);
    assert.ok(R.fiscal.validar({ ...ok, escopos: [] }).erros.escopos);
    assert.ok(R.fiscal.validar({ ...ok, periodoInicio: '2026-02-30' }).erros.periodoInicio);
    assert.ok(R.fiscal.validar({ ...ok, periodoInicio: '2026-10-01', periodoFim: '2026-09-01' }).erros.periodoFim);
    assert.ok(R.fiscal.validar({ ...ok, observacao: 'x'.repeat(501) }).erros.observacao);
  });

  test('o corpo enviado é exatamente o contrato: sem empresa, usuário, status, hash ou caminho; a chave só na geração', () => {
    const form = { periodoInicio: '2026-09-01', periodoFim: '2026-09-30', finalidade: 'AUDITORIA_INTERNA', observacao: ' nota ', escopos: [ESC[1], ESC[0]], empresaId: 9, sha256: 'x' };
    const previa = R.fiscal.corpo(form);
    assert.deepEqual(Object.keys(previa).sort(), ['escopos', 'finalidade', 'observacao', 'periodoFim', 'periodoInicio']);
    assert.equal(previa.observacao, 'nota');
    assert.deepEqual(R.fiscal.corpo({ ...form, observacao: '' }).observacao, undefined);
    const k = R.fiscal.novaChave();
    assert.match(k, /^[A-Za-z0-9_-]{8,128}$/);
    assert.notEqual(R.fiscal.novaChave(), k);
    assert.deepEqual(Object.keys(R.fiscal.corpoGeracao(form, k)).sort(), ['chaveIdempotencia', 'escopos', 'finalidade', 'observacao', 'periodoFim', 'periodoInicio']);
  });

  test('rotas: só os caminhos do D6; id de download validado antes da rede', async () => {
    const chamadasHttp = [];
    global.EpiHttp = { requisitar: async (m, c, corpo) => { chamadasHttp.push([m, c, corpo && Object.keys(corpo).sort()]); return { ok: true }; } };
    const corpo = R.fiscal.corpo({ periodoInicio: '2026-09-01', periodoFim: '2026-09-30', finalidade: 'AUDITORIA_INTERNA', observacao: '', escopos: ESC });
    await R.acoes.fiscalPrevia(corpo);
    await R.acoes.fiscalGerar(corpo, 'k-12345678');
    await R.acoes.fiscalListar(1, 20);
    delete global.EpiHttp;
    assert.deepEqual(chamadasHttp.map((c) => [c[0], c[1]]), [
      ['POST', '/relatorios/fiscalizacao/previa'], ['POST', '/relatorios/fiscalizacao/pacotes'], ['GET', '/relatorios/fiscalizacao/pacotes?pagina=1&limite=20'],
    ]);
    assert.equal(R.fiscal.caminhoDownload(12), '/relatorios/fiscalizacao/pacotes/12/download');
    for (const ruim of ['../x', '1/2', 0, -1, 1.5, '1e3', null, undefined]) assert.throws(() => R.fiscal.caminhoDownload(ruim), TypeError, String(ruim));
  });

  test('textos de erro do servidor: limite de linhas e de tamanho orientam reduzir o período; nunca o texto bruto do servidor', () => {
    for (const codigo of ['LIMITE_LINHAS_EXCEDIDO', 'PACOTE_EXCEDE_TAMANHO', 'PERIODO_MAXIMO_EXCEDIDO']) assert.match(R.fiscal.mensagemDeErro(codigo), /reduz/i, codigo);
    assert.match(R.fiscal.mensagemDeErro('GERACAO_EM_ANDAMENTO'), /andamento/i);
    assert.match(R.fiscal.mensagemDeErro('IDEMPOTENCIA_CONFLITO'), /nova tentativa|novo/i);
    assert.equal(R.fiscal.mensagemDeErro('CODIGO_QUE_NAO_EXISTE'), R.fiscal.mensagemDeErro(undefined), 'código desconhecido tem texto genérico seguro');
  });

  test('histórico: colunas, status e rótulos; falha mostra o código técnico traduzido, sem hash nem caminho', () => {
    assert.deepEqual(R.ABAS.fiscalPacotes.colunas.map((c) => c.rotulo), ['Pacote', 'Período', 'Finalidade', 'Módulos', 'Gerado por', 'Gerado em', 'Status']);
    assert.deepEqual(Object.keys(R.STATUS.fiscalPacotes), ['GERANDO', 'CONCLUIDO', 'FALHA']);
    assert.deepEqual(Object.values(R.STATUS.fiscalPacotes).map((s) => s.rotulo), ['Gerando', 'Concluído', 'Falhou']);
    const linha = (l) => R.ABAS.fiscalPacotes.colunas.map((c) => c.valor(l));
    assert.equal(linha(pacote())[0], 'FIS-12');
    assert.match(linha(pacote())[1], /01\/09\/2026.*30\/09\/2026/);
    assert.equal(/ZIP_EXCEDE_LIMITE|[a-f0-9]{64}/.test(JSON.stringify(linha(pacote({ status: 'FALHA', erroCodigo: 'ZIP_EXCEDE_LIMITE' })))), false);
  });
});

describe('Relatório — Fiscalização — página (DOM simulado, sessão e permissões reais)', () => {
  test('só com reportsFiscal a aba aparece e abre sozinha; o aviso "Em integração" some e o banner da NR-01 aparece', async () => {
    const pg = await pronta();
    const visiveis = pg.consulta('.report-tab[data-recurso]').filter((b) => pg.visivelNo(b)).map((b) => b.getAttribute('data-secao'));
    assert.deepEqual(visiveis, ['reportFiscal']);
    assert.equal(pg.consulta('#reportFiscal.active').length, 1);
    assert.match(pg.texto('reportFiscal'), /NR-01 — Acesso à Inspeção do Trabalho/);
    assert.equal(pg.consulta('[data-nao-integrada]').filter((n) => pg.visivelNo(n)).length, 0);
    assert.equal(chamadas(pg, 'GET /relatorios/fiscalizacao/pacotes').length, 1, 'o histórico carrega ao abrir');
    assert.equal(/Fichas de EPI assinadas|assinadas/i.test(pg.textoDoDom()), false);
  });

  test('sem reportsFiscal a aba some, Fiscalização não fica ativa e nenhuma rota do D6 é chamada', async () => {
    const pg = await pronta({ fiscal: false, auditoria: true });
    assert.equal(pg.consulta('.report-tab[data-recurso="reportsFiscal"]').filter((b) => pg.visivelNo(b)).length, 0);
    assert.equal(pg.consulta('#reportFiscal.active').length, 0);
    assert.equal(pg.consulta('.report-tab[data-recurso="reportsAudit"]').filter((b) => pg.visivelNo(b)).length, 1);
    assert.equal(pg.chamadas.filter((c) => c.url.includes('/relatorios/fiscalizacao')).length, 0);
  });

  test('o formulário tem os campos pedidos, as cinco finalidades e os quatro módulos', async () => {
    const pg = await pronta();
    for (const id of ['fiscInicio', 'fiscFim', 'fiscFinalidade', 'fiscObservacao', 'fiscPrevia', 'fiscGerar']) assert.equal(pg.consulta(`#${id}`).length, 1, id);
    for (const e of ESC) assert.equal(pg.consulta(`#fiscEscopo-${e}`).length, 1, e);
    const opcoes = pg.consulta('#fiscFinalidade option').map((o) => o.getAttribute('value')).filter(Boolean);
    assert.deepEqual(opcoes, R.fiscal.FINALIDADES.map((f) => f.valor));
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, true, 'gerar só depois de uma prévia válida');
  });

  test('pré-visualizar envia só o contrato, mostra as contagens por módulo e indica módulo vazio; não gera pacote', async () => {
    const pg = await pronta({ rotas: { 'POST /relatorios/fiscalizacao/previa': () => previaOk({ TRILHA_AUDITORIA: 0, REGRAS_GHE: 12 }) } });
    await preencher(pg);
    await pg.clicar('fiscPrevia');
    const envio = chamadas(pg, 'POST /relatorios/fiscalizacao/previa');
    assert.equal(envio.length, 1);
    assert.deepEqual(Object.keys(envio[0].corpo).sort(), ['escopos', 'finalidade', 'observacao', 'periodoFim', 'periodoInicio'].filter((k) => k !== 'observacao'));
    assert.equal(chamadas(pg, 'POST /relatorios/fiscalizacao/pacotes').length, 0, 'a prévia não gera ZIP');
    const resultado = pg.texto('fiscPreviaResultado');
    assert.match(resultado, /Fichas\/entregas de EPI confirmadas/);
    assert.match(resultado, /12/);
    assert.match(resultado, /Trilha de auditoria completa[\s\S]*(sem registros|nenhum registro)/i);
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, false);
  });

  test('"Outra" sem observação, período longo ou sem módulo: erro local, nada é enviado e Gerar continua bloqueado', async () => {
    const pg = await pronta();
    await preencher(pg, { finalidade: 'OUTRA', observacao: '' });
    await pg.clicar('fiscPrevia');
    assert.equal(chamadas(pg, 'POST /relatorios/fiscalizacao/previa').length, 0);
    assert.match(pg.texto('reportFiscal'), /observação/i);
    await preencher(pg, { inicio: '2025-01-01', fim: '2026-09-30' });
    await pg.clicar('fiscPrevia');
    assert.equal(chamadas(pg, 'POST /relatorios/fiscalizacao/previa').length, 0);
    await preencher(pg, { escopos: [] });
    await pg.clicar('fiscPrevia');
    assert.equal(chamadas(pg, 'POST /relatorios/fiscalizacao/previa').length, 0);
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, true);
  });

  test('módulo acima do limite: a prévia nomeia o módulo, mostra a quantidade, orienta reduzir o período e bloqueia Gerar', async () => {
    const excede = () => ({ status: 200, corpo: { status: 'ok', previa: {
      periodo: { inicio: '2026-09-01', fim: '2026-09-30', dias: 30 }, podeGerar: false, limiteLinhasPorModulo: 100000,
      escopos: [{ escopo: 'TRILHA_AUDITORIA', linhas: 130000, vazio: false, excedeLimite: true }, { escopo: 'REGRAS_GHE', linhas: 4, vazio: false, excedeLimite: false }],
    } } });
    const pg = await pronta({ rotas: { 'POST /relatorios/fiscalizacao/previa': excede } });
    await preencher(pg);
    await pg.clicar('fiscPrevia');
    assert.match(pg.texto('fiscPreviaResultado'), /Trilha de auditoria completa/);
    assert.match(pg.texto('fiscPreviaResultado'), /130\.?000/);
    assert.match(pg.texto('fiscPreviaResultado'), /reduz/i);
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, true);
  });

  test('mudar qualquer campo depois da prévia invalida a prévia e bloqueia Gerar de novo', async () => {
    const pg = await pronta();
    await preencher(pg);
    await pg.clicar('fiscPrevia');
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, false);
    await definir(pg, 'fiscFim', '2026-09-29');
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, true);
    await pg.clicar('fiscPrevia');
    await pg.marcar('fiscEscopo-REGRAS_GHE', false);
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, true);
  });

  test('gerar: envia o contrato com chave de idempotência, protege contra duplo clique e recarrega o histórico', async () => {
    const pg = await pronta();
    await preencher(pg);
    await pg.clicar('fiscPrevia');
    const antes = chamadas(pg, 'GET /relatorios/fiscalizacao/pacotes').length;
    pg.consulta('#fiscGerar')[0].disparar('click');
    await pg.clicar('fiscGerar');
    await pg.esperar();
    const envios = chamadas(pg, 'POST /relatorios/fiscalizacao/pacotes');
    assert.equal(envios.length, 1, 'duplo clique gera uma só requisição');
    assert.match(envios[0].corpo.chaveIdempotencia, /^[A-Za-z0-9_-]{8,128}$/);
    assert.equal(envios[0].corpo.escopos.length, 4);
    assert.equal(Object.keys(envios[0].corpo).some((k) => /empresa|usuario|status|sha|hash|caminho/i.test(k)), false);
    assert.ok(chamadas(pg, 'GET /relatorios/fiscalizacao/pacotes').length > antes, 'histórico recarregado');
    assert.match(pg.texto('aviso') + pg.texto('reportFiscal'), /gerado|concluíd/i);
  });

  test('erros de geração têm texto próprio e seguro (limite de linhas, de tamanho, em andamento); a prévia não é reaproveitada como sucesso', async () => {
    for (const [codigo, padrao] of [['LIMITE_LINHAS_EXCEDIDO', /reduz/i], ['PACOTE_EXCEDE_TAMANHO', /reduz/i], ['GERACAO_EM_ANDAMENTO', /andamento/i]]) {
      const pg = await pronta({ rotas: { 'POST /relatorios/fiscalizacao/pacotes': () => ({ status: codigo === 'GERACAO_EM_ANDAMENTO' ? 409 : 400, corpo: { status: 'erro', codigo, message: 'TEXTO DO SERVIDOR' } }) } });
      await preencher(pg);
      await pg.clicar('fiscPrevia');
      await pg.clicar('fiscGerar');
      const tela = pg.textoDoDom();
      assert.match(tela, padrao, codigo);
      assert.equal(tela.includes('TEXTO DO SERVIDOR'), false);
    }
  });

  test('histórico: pacotes com status, só o concluído tem Baixar (link do servidor, sem caminho local nem hash); falha mostra o motivo traduzido', async () => {
    const pg = await pronta();
    const linhas = pg.consulta('#corpo-fiscalPacotes tr');
    assert.equal(linhas.length, 2);
    assert.match(linhas[0].textContent, /FIS-12/);
    assert.match(linhas[0].textContent, /Concluído/);
    assert.match(linhas[1].textContent, /Falhou/);
    const baixar = pg.consulta('#corpo-fiscalPacotes [data-baixar]');
    assert.equal(baixar.length, 1, 'só o concluído baixa');
    assert.equal(baixar[0].getAttribute('data-baixar'), '12');
    assert.equal(/ZIP_EXCEDE_LIMITE|[a-f0-9]{64}|pacote-12\.zip/.test(pg.textoDoDom()), false);
  });

  test('o histórico vazio e o 403 do servidor têm texto próprio; nada usa innerHTML nem armazenamento do navegador', async () => {
    const vazio = await pronta({ rotas: { 'GET /relatorios/fiscalizacao/pacotes': () => ({ status: 200, corpo: { status: 'ok', itens: [], total: 0, pagina: 1, limite: 20 } }) } });
    assert.match(vazio.consulta('#corpo-fiscalPacotes tr')[0].textContent, /Nenhum pacote/i);
    const negado = await pronta({ rotas: { 'GET /relatorios/fiscalizacao/pacotes': () => ({ status: 403, corpo: { status: 'erro', codigo: 'SEM_PERMISSAO' } }) } });
    assert.match(negado.consulta('#corpo-fiscalPacotes tr')[0].textContent, new RegExp(R.TEXTOS.SEM_AUTORIDADE));
    const fonte = ler('js/relatorios.js') + ler(ARQUIVO);
    assert.equal(/localStorage|sessionStorage/.test(fonte.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), false);
  });
});

describe('Relatório — Fiscalização — mensagens de erro do formulário (UX)', () => {
  const erro = (pg, campo) => pg.texto(`fiscErro-${campo}`).trim();
  const previas = (pg) => chamadas(pg, 'POST /relatorios/fiscalizacao/previa').length;

  test('com o formulário vazio as mensagens aparecem; editar cada campo limpa SÓ a mensagem dele, sem chamar a API nem habilitar Gerar; novo clique em Pré-visualizar chama a API e habilita Gerar', async () => {
    const pg = await pronta();
    await pg.clicar('fiscPrevia');
    assert.equal(previas(pg), 0, 'formulário inválido não chega à rede');
    for (const c of ['periodoInicio', 'periodoFim', 'finalidade', 'escopos']) assert.notEqual(erro(pg, c), '', c);
    assert.equal(erro(pg, 'observacao'), '', 'observação só é exigida na finalidade Outra');

    await definir(pg, 'fiscInicio', '2026-09-01');
    assert.equal(erro(pg, 'periodoInicio'), '');
    assert.notEqual(erro(pg, 'periodoFim'), '', 'editar o início não limpa a mensagem do fim');
    assert.notEqual(erro(pg, 'finalidade'), '');
    assert.notEqual(erro(pg, 'escopos'), '');

    await definir(pg, 'fiscFim', '2026-09-30');
    assert.equal(erro(pg, 'periodoFim'), '');
    assert.notEqual(erro(pg, 'finalidade'), '');

    await definir(pg, 'fiscFinalidade', 'AUDITORIA_INTERNA');
    assert.equal(erro(pg, 'finalidade'), '');
    assert.notEqual(erro(pg, 'escopos'), '');

    await pg.marcar('fiscEscopo-REGRAS_GHE', true);
    assert.equal(erro(pg, 'escopos'), '');

    assert.equal(previas(pg), 0, 'editar não chama a API');
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, true, 'Gerar continua dependendo de uma nova prévia válida');

    await pg.clicar('fiscPrevia');
    assert.equal(previas(pg), 1, 'o novo clique chama a API');
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, false);
  });

  test('"Outra" sem observação mostra a mensagem; digitar a observação a limpa, e a validação continua valendo no clique', async () => {
    const pg = await pronta();
    await preencher(pg, { finalidade: 'OUTRA', observacao: '' });
    await pg.clicar('fiscPrevia');
    assert.notEqual(erro(pg, 'observacao'), '');
    assert.equal(previas(pg), 0);
    await definir(pg, 'fiscObservacao', 'Pedido do sindicato');
    assert.equal(erro(pg, 'observacao'), '');
    assert.equal(previas(pg), 0);
    assert.equal(pg.consulta('#fiscGerar')[0].disabled, true);
    await definir(pg, 'fiscObservacao', '');
    await pg.clicar('fiscPrevia');
    assert.notEqual(erro(pg, 'observacao'), '', 'a regra não foi enfraquecida: sem observação, "Outra" continua recusada');
    assert.equal(previas(pg), 0);
  });
});
