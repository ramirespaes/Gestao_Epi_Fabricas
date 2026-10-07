'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');

/**
 * E8 — Operações de estoque: módulo js/operacoes-estoque.js com fetch
 * injetado, página pages/operations.html em DOM simulado e inspeção
 * estática. A prova com PostgreSQL real está em
 * backend/test/integracao/estoque-operacoes-historico.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const modulo = () => require('../js/operacoes-estoque'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const ATAQUE = '<img src=x onerror=alert(1)>';
const ESCAPADO = '&lt;img src=x onerror=alert(1)&gt;';
const NOME = 'Operações de estoque';
const SUBTITULO = 'Consulte o histórico de saldos iniciais, entradas, baixas e entregas de estoque, lote a lote, com data, quantidade, motivo e responsável. As operações registradas não podem ser editadas nem excluídas.';

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search });
      const r = responder(opcoes.method, u);
      if (r instanceof Error) throw r;
      return r;
    },
  });
}

// 12D-2: toda linha traz `entrega`: null fora da ENTREGA; só { origem } para quem não vê a ficha;
// com o detalhe, { origem, fichaId, fichaNumero, trabalhador { id, nome, matricula }, solicitacao { id, numero } | null }.
const operacao = (extra) => ({
  operacaoId: '31', tipo: 'ENTRADA', quantidade: 5, motivo: null, justificativa: null, responsavel: 'Maria Estoquista',
  criadoEm: '2026-09-27T13:05:00.000Z', loteId: 12, materialId: 7, material: 'Botina de segurança', codigoInterno: 'EPI-1',
  tamanho: '42', caNumero: '38271', caValidade: '2030-12-31', entrega: null, ...extra,
});
const ENTREGA_DIRETA = { origem: 'DIRETA' };
const ENTREGA_DIRETA_COM_DETALHE = { origem: 'DIRETA', fichaId: 9, fichaNumero: 12, trabalhador: { id: 5, nome: 'João da Silva', matricula: 'M-100' }, solicitacao: null };
const ENTREGA_SOLICITACAO_COM_DETALHE = { origem: 'SOLICITACAO', fichaId: 9, fichaNumero: 12, trabalhador: { id: 5, nome: 'João da Silva', matricula: 'M-100' }, solicitacao: { id: 3, numero: 5 } };
const entrega = (dados, extra) => operacao({ operacaoId: '41', tipo: 'ENTREGA', quantidade: 2, entrega: dados, ...extra });
const OPERACOES = [
  operacao(),
  operacao({ operacaoId: '30', tipo: 'BAIXA', quantidade: 2, motivo: 'AVARIA', criadoEm: '2026-09-10T02:30:00.000Z' }),
  operacao({ operacaoId: '29', tipo: 'BAIXA', quantidade: 1, motivo: 'OUTRO', justificativa: 'Doação para treinamento', criadoEm: '2026-09-10T03:00:00.000Z' }),
  operacao({ operacaoId: '2', tipo: 'SALDO_INICIAL', quantidade: 10, responsavel: null, tamanho: null, caNumero: null, caValidade: null, criadoEm: '2026-09-01T12:00:00.000Z' }),
];
const listagem = (extra = {}) => ({ status: 'ok', operacoes: OPERACOES, total: 4, pagina: 1, limite: 50, paginas: 1, ...extra });

// Marcações de um trecho de HTML e nomes de atributo, com os valores entre aspas neutralizados.
const marcacoes = (html) => [...String(html).matchAll(/<\s*([a-zA-Z][\w-]*)([^>]*)>/g)].map((m) => ({ nome: m[1].toLowerCase(), atributos: m[2] }));
const nomesDeAtributo = (a) => [...a.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/([^\s="'/]+)\s*=/g)].map((m) => m[1].toLowerCase());
const semElementoInjetado = (html) => {
  for (const m of marcacoes(html)) {
    assert.notEqual(m.nome, 'img', html);
    assert.equal(nomesDeAtributo(m.atributos).some((n) => n.startsWith('on')), false, `atributo de evento em <${m.nome}>`);
  }
};
const celulas = (linhaHtml) => [...linhaHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const linhas = (html) => html.split('</tr>').filter((l) => l.includes('<td'));

describe('módulo: consulta, textos e HTML', () => {
  test('a consulta leva só tipo da lista, datas AAAA-MM-DD, busca aparada e paginação; nunca empresa nem ordenação', async () => {
    servidor(() => resposta(200, listagem()));
    const O = modulo();
    await O.acoes.listar({ tipo: 'BAIXA', de: '2026-09-01', ate: '2026-09-30', busca: '  botina & 50%  ', pagina: 2 });
    await O.acoes.listar({ tipo: 'TRANSFERENCIA', de: '01/09/2026', ate: "2026-09-30' OR 1=1", busca: '   ', pagina: 0 });
    await O.acoes.listar({ tipo: 'SALDO_INICIAL' });
    assert.deepEqual(chamadas.map((c) => c.caminho), [
      '/api/estoque/operacoes?tipo=BAIXA&de=2026-09-01&ate=2026-09-30&busca=botina%20%26%2050%25&pagina=2&limite=50',
      '/api/estoque/operacoes?pagina=1&limite=50',
      '/api/estoque/operacoes?tipo=SALDO_INICIAL&pagina=1&limite=50',
    ]);
    assert.ok(chamadas.every((c) => c.metodo === 'GET'));
    assert.equal(chamadas.some((c) => /empresa|ordem|order/i.test(c.caminho)), false);
    assert.deepEqual(O.FILTROS.map((f) => f[0]), ['', 'SALDO_INICIAL', 'ENTRADA', 'BAIXA', 'ENTREGA']);
    assert.deepEqual(O.FILTROS.map((f) => f[1]), ['Todas', 'Saldo inicial', 'Entrada', 'Baixa', 'Entrega']);
  });

  test('12D-3: ENTREGA é um tipo aceito e a origem (DIRETA ou SOLICITACAO) vai ao servidor só com ENTREGA ou sem tipo', async () => {
    servidor(() => resposta(200, listagem()));
    const O = modulo();
    await O.acoes.listar({ tipo: 'ENTREGA' });
    await O.acoes.listar({ tipo: 'ENTREGA', origem: 'DIRETA' });
    await O.acoes.listar({ tipo: 'ENTREGA', origem: 'SOLICITACAO', de: '2026-09-01', busca: 'botina', pagina: 3 });
    await O.acoes.listar({ origem: 'SOLICITACAO' });
    assert.deepEqual(chamadas.map((c) => c.caminho), [
      '/api/estoque/operacoes?tipo=ENTREGA&pagina=1&limite=50',
      '/api/estoque/operacoes?tipo=ENTREGA&origem=DIRETA&pagina=1&limite=50',
      '/api/estoque/operacoes?tipo=ENTREGA&origem=SOLICITACAO&de=2026-09-01&busca=botina&pagina=3&limite=50',
      '/api/estoque/operacoes?origem=SOLICITACAO&pagina=1&limite=50',
    ]);
    assert.deepEqual(O.ORIGENS, [['', 'Todas'], ['DIRETA', 'Direta'], ['SOLICITACAO', 'Solicitação']]);
  });

  test('12D-3: origem inválida nunca vai ao servidor; origem com outro tipo (que nunca tem origem) também não', async () => {
    servidor(() => resposta(200, listagem()));
    const O = modulo();
    for (const origem of ['direta', 'OUTRA', "DIRETA' OR 1=1", '', null, undefined, 7]) await O.acoes.listar({ tipo: 'ENTREGA', origem });
    for (const tipo of ['BAIXA', 'ENTRADA', 'SALDO_INICIAL']) await O.acoes.listar({ tipo, origem: 'DIRETA' });
    assert.equal(chamadas.some((c) => /origem=/.test(c.caminho)), false);
    assert.equal(O.origemPermitida('DIRETA'), true);
    assert.equal(O.origemPermitida('SOLICITACAO'), true);
    assert.equal(O.origemPermitida(''), false);
  });

  test('data e hora em São Paulo, no formato dd/mm/aaaa HH:mm; meia-noite é 00:00; valor inválido vira "—"', () => {
    const T = modulo().texto;
    assert.equal(T.dataHora('2026-09-10T02:30:00.000Z'), '09/09/2026 23:30');
    assert.equal(T.dataHora('2026-09-10T03:00:00.000Z'), '10/09/2026 00:00');
    assert.equal(T.dataHora('2026-09-01T12:00:00.000Z'), '01/09/2026 09:00');
    for (const invalido of [null, undefined, '', 'ontem', ATAQUE]) assert.equal(T.dataHora(invalido), '—', String(invalido));
  });

  test('textos: tamanho null é "Único"; sinal só na tela (+ entrada e saldo inicial, − baixa); motivo com rótulo; "—" quando não se aplica', () => {
    const T = modulo().texto;
    assert.deepEqual([T.tamanho(null), T.tamanho(''), T.tamanho('42')], ['Único', 'Único', '42']);
    assert.deepEqual([T.quantidade(OPERACOES[0]), T.quantidade(OPERACOES[1]), T.quantidade(OPERACOES[3])], ['+5', '−2', '+10']);
    assert.deepEqual(
      ['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO', 'DEVOLUCAO_FORNECEDOR', 'OUTRO'].map((motivo) => T.motivo({ tipo: 'BAIXA', motivo })),
      ['CA vencido', 'Avaria', 'Descarte', 'Perda', 'Ajuste de inventário', 'Devolução ao fornecedor', 'Outro'],
    );
    assert.deepEqual([T.motivo(OPERACOES[0]), T.motivo(OPERACOES[3])], ['—', '—']);
    assert.deepEqual([T.justificativa(OPERACOES[2]), T.justificativa(OPERACOES[1])], ['Doação para treinamento', '—']);
    assert.deepEqual([T.responsavel(OPERACOES[0]), T.responsavel(OPERACOES[3])], ['Maria Estoquista', '—']);
    assert.deepEqual([T.ca(OPERACOES[0]), T.ca(OPERACOES[3])], ['38271', '—']);
  });

  test('tipos: saldo inicial tem nome próprio e nunca aparece como entrada manual', () => {
    const O = modulo();
    assert.deepEqual(Object.keys(O.TIPOS), ['SALDO_INICIAL', 'ENTRADA', 'BAIXA', 'ENTREGA']);
    assert.deepEqual([O.TIPOS.SALDO_INICIAL.rotulo, O.TIPOS.ENTRADA.rotulo, O.TIPOS.BAIXA.rotulo, O.TIPOS.ENTREGA.rotulo], ['Saldo inicial', 'Entrada', 'Baixa', 'Entrega']);
    assert.equal(O.TIPOS.ENTREGA.sinal, '−', 'a entrega tira do estoque');
    const [saldo] = linhas(O.render.linhas([OPERACOES[3]]));
    const [, operacaoTexto, material, tamanho, ca, quantidade, motivo, justificativa, responsavel] = celulas(saldo);
    assert.match(operacaoTexto, /^Saldo inicial/);
    assert.equal(/Entrada/.test(operacaoTexto), false);
    assert.match(operacaoTexto, /migrado/i, 'o saldo inicial veio do controle anterior, não de uma entrada');
    assert.deepEqual([material.startsWith('Botina'), tamanho, ca, quantidade, motivo, justificativa, responsavel], [true, 'Único', '— Lote 12', '+10', '—', '—', '—']);
  });

  test('linhas: dez colunas na ordem; baixa com motivo e justificativa; referência da operação e do lote', () => {
    const html = modulo().render.linhas(OPERACOES);
    const [entrada, avaria, outro] = linhas(html).map(celulas);
    assert.equal(entrada.length, 10);
    assert.deepEqual(entrada, ['27/09/2026 10:05', 'Entrada', 'Botina de segurança EPI-1', '42', '38271 Lote 12', '+5', '—', '—', 'Maria Estoquista', 'Op. 31']);
    assert.deepEqual([avaria[0], avaria[1], avaria[5], avaria[6], avaria[7]], ['09/09/2026 23:30', 'Baixa', '−2', 'Avaria', '—']);
    assert.deepEqual([outro[6], outro[7]], ['Outro', 'Doação para treinamento']);
  });

  test('12D-3: ENTREGA aparece como "Entrega" com a origem discreta (Direta ou Por solicitação) e quantidade com sinal de menos', () => {
    const R = modulo().render;
    const [direta] = linhas(R.linhas([entrega(ENTREGA_DIRETA)])).map(celulas);
    const [porSolicitacao] = linhas(R.linhas([entrega({ origem: 'SOLICITACAO' })])).map(celulas);
    assert.equal(direta.length, 10);
    assert.deepEqual([direta[1], direta[5], direta[6], direta[9]], ['Entrega Direta', '−2', '—', 'Op. 41']);
    assert.deepEqual([porSolicitacao[1], porSolicitacao[5]], ['Entrega Por solicitação', '−2']);
    const html = R.linhas([entrega(ENTREGA_DIRETA)]);
    assert.match(html, /class="tipo tipo-entrega"/);
    assert.match(html, /class="numero tipo-entrega"/);
    assert.equal(/Por solicitação/.test(html), false, 'a origem DIRETA nunca aparece como solicitação');
    assert.equal(/Direta/.test(R.linhas([entrega({ origem: 'SOLICITACAO' })])), false, 'a origem SOLICITACAO nunca aparece como direta');
  });

  test('12D-3: origem desconhecida ou ausente não é adivinhada: só "Entrega", sem "Direta" nem "Por solicitação"', () => {
    const R = modulo().render;
    for (const dados of [{ origem: 'FUTURA' }, { origem: null }, {}, null, undefined]) {
      const [celula] = linhas(R.linhas([entrega(dados)])).map(celulas);
      assert.equal(celula[1], 'Entrega', JSON.stringify(dados));
    }
  });

  test('12D-3: com o detalhe permitido pelo servidor, a referência mostra ficha, trabalhador (nome e matrícula) e solicitação', () => {
    const R = modulo().render;
    const ref = (dados) => linhas(R.linhas([entrega(dados)])).map(celulas)[0][9];
    assert.equal(ref(ENTREGA_SOLICITACAO_COM_DETALHE), 'Op. 41 Ficha 12 João da Silva · M-100 Solicitação 5');
    assert.equal(ref(ENTREGA_DIRETA_COM_DETALHE), 'Op. 41 Ficha 12 João da Silva · M-100', 'a entrega direta não tem solicitação e nada é inventado');
    assert.equal(ref({ ...ENTREGA_DIRETA_COM_DETALHE, trabalhador: { id: 5, nome: 'João da Silva', matricula: null } }), 'Op. 41 Ficha 12 João da Silva');
  });

  test('12D-3: sem o detalhe (perfil sem ficha), a linha não mostra ficha, trabalhador, solicitação nem aviso de falta de permissão', () => {
    const R = modulo().render;
    for (const dados of [ENTREGA_DIRETA, { origem: 'SOLICITACAO' }, null]) {
      const html = R.linhas([entrega(dados)]);
      assert.equal(celulas(linhas(html)[0])[9], 'Op. 41');
      assert.equal(/Ficha|Trabalhador|permiss|restrit|oculto|\*\*\*/i.test(html), false, JSON.stringify(dados));
    }
  });

  test('12D-3: o CPF e qualquer outro dado fora do contrato nunca são mostrados, mesmo que cheguem na resposta', () => {
    const R = modulo().render;
    const trabalhador = { ...ENTREGA_SOLICITACAO_COM_DETALHE.trabalhador, cpf: '123.456.789-09', cpfMascarado: '***.456.789-**', cpfHash: 'abc123' };
    const html = R.linhas([entrega({ ...ENTREGA_SOLICITACAO_COM_DETALHE, trabalhador, cpf: '987.654.321-00', solicitante: 'Fulano Solicitante', justificativaSst: 'Texto SST secreto' }, { cpf: '111.222.333-44' })]);
    for (const proibido of ['123.456', '987.654', '456.789', '111.222', 'abc123', 'Fulano Solicitante', 'SST secreto']) assert.equal(html.includes(proibido), false, proibido);
    assert.equal(/cpf/i.test(semComentarios(ler('js/operacoes-estoque.js'))), false, 'o módulo nem lê um campo de CPF');
  });

  test('12D-3: XSS no detalhe da entrega: ficha, trabalhador, matrícula, solicitação e origem saem escapados', () => {
    const atacada = entrega({
      origem: ATAQUE, fichaId: 1, fichaNumero: ATAQUE, trabalhador: { id: 1, nome: ATAQUE, matricula: ATAQUE }, solicitacao: { id: 1, numero: ATAQUE },
    });
    const html = modulo().render.linhas([atacada]);
    assert.ok(html.includes(ESCAPADO));
    semElementoInjetado(html);
  });

  test('XSS: tudo o que vem do servidor é texto escapado, inclusive tipo e motivo desconhecidos', () => {
    const atacada = operacao({
      material: ATAQUE, codigoInterno: `"><${ATAQUE}`, tamanho: ATAQUE, caNumero: ATAQUE, justificativa: ATAQUE, responsavel: ATAQUE,
      tipo: ATAQUE, motivo: ATAQUE, operacaoId: `1"><${ATAQUE}`, loteId: ATAQUE, criadoEm: ATAQUE, quantidade: ATAQUE,
    });
    const html = modulo().render.linhas([atacada]);
    assert.ok(html.includes(ESCAPADO));
    semElementoInjetado(html);
    semElementoInjetado(modulo().render.vazio(ATAQUE));
  });

  test('histórico só de leitura: nenhuma linha traz botão, link ou ação de editar ou excluir', () => {
    const html = modulo().render.tabela(OPERACOES);
    assert.equal(/<(button|a|input|select|form)\b/i.test(html), false);
    assert.equal(/editar|excluir|apagar|remover|data-[a-z-]+=/i.test(html), false);
  });

  test('tabela vazia e paginação: texto pronto, com total e páginas', () => {
    const R = modulo().render;
    assert.match(R.tabela([], { mensagemVazia: 'Nenhuma operação.' }), /<td colspan="10" class="estado">Nenhuma operação\.<\/td>/);
    assert.deepEqual(R.paginacao({ total: 0, pagina: 1, limite: 50, paginas: 0 }, 0), { texto: 'Nenhuma operação', anterior: false, proxima: false });
    assert.deepEqual(R.paginacao({ total: 120, pagina: 2, limite: 50, paginas: 3 }, 50), { texto: 'Operações 51–100 de 120 · página 2 de 3', anterior: true, proxima: true });
    assert.deepEqual(R.paginacao({ total: 120, pagina: 3, limite: 50, paginas: 3 }, 20), { texto: 'Operações 101–120 de 120 · página 3 de 3', anterior: true, proxima: false });
  });

  test('mensagens de falha: texto próprio, sem repetir o que o servidor mandou', () => {
    const M = modulo().mensagens;
    const segredo = { ok: false, status: 400, codigo: 'VALIDACAO', mensagem: 'SEGREDO-INTERNO', detalhes: [{ caminho: 'query.tipo', valor: 'SEGREDO-9' }] };
    for (const r of [segredo, { ok: false, status: 403 }, { ok: false, status: 0 }, { ok: false, status: 500, mensagem: 'SEGREDO-INTERNO' }]) {
      const texto = M.erroListagem(r);
      assert.equal(typeof texto, 'string');
      assert.equal(/SEGREDO/.test(texto), false, texto);
    }
    assert.match(M.erroListagem({ ok: false, status: 403 }), /perfil/i);
    assert.match(M.erroListagem({ ok: false, status: 0 }), /rede/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado: o script embutido de operations.html
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa' }, usuario: { id: 7, nome: 'Pessoa', perfil: 'MASTER' } };
const SO_VER = { recursos: { materials: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: {} };

function montarPagina({ responder, acesso = true } = {}) {
  servidor(responder || (() => resposta(200, listagem())));
  const html = ler('pages/operations.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, atributos: {}, listeners: {},
    tagName: id === 'filtroTipo' || id === 'filtroOrigem' ? 'SELECT' : 'INPUT',
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.atributos[k] = String(v); }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
  });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, location: { search: '' } },
    EpiHttp, EpiOperacoesEstoque: modulo(),
    EpiPermissoes: { prepararPagina: async (o) => { sandbox.opcoesPagina = o; return acesso ? { permissoes: SO_VER, podeAlterar: false } : null; }, acao: P.acao, recurso: P.recurso },
    EpiSessaoEmpresarial: { montar: async () => CONTEXTO, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, Promise, String, Number, Array, Object, JSON,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click') => { for (const fn of (el(id).listeners[ev] || [])) await fn({}); await esperar(); };
  return { el, sandbox, esperar, disparar };
}
const leituras = () => chamadas.map((c) => c.caminho);

describe('página (DOM simulado)', () => {
  test('abre pela permissão de ver estoque e lista a primeira página; nenhuma escrita', async () => {
    const pg = montarPagina();
    await pg.esperar();
    assert.equal(pg.sandbox.opcoesPagina.pagina, 'operations');
    assert.deepEqual(leituras(), ['/api/estoque/operacoes?pagina=1&limite=50']);
    assert.ok(chamadas.every((c) => c.metodo === 'GET'));
    assert.match(pg.el('operacoesCorpo').innerHTML, /Saldo inicial/);
    assert.equal(pg.el('paginacaoTexto').textContent, 'Operações 1–4 de 4 · página 1 de 1');
  });

  test('sem acesso à página: nenhuma consulta', async () => {
    const pg = montarPagina({ acesso: false });
    await pg.esperar();
    assert.deepEqual(leituras(), []);
  });

  test('filtros: tipo, período e busca vão para o servidor; limpar volta a todas', async () => {
    const pg = montarPagina();
    await pg.esperar();
    Object.assign(pg.el('filtroTipo'), { value: 'BAIXA' });
    Object.assign(pg.el('filtroDe'), { value: '2026-09-01' });
    Object.assign(pg.el('filtroAte'), { value: '2026-09-30' });
    Object.assign(pg.el('filtroBusca'), { value: '  38271 ' });
    await pg.disparar('botaoFiltrar');
    assert.equal(leituras().at(-1), '/api/estoque/operacoes?tipo=BAIXA&de=2026-09-01&ate=2026-09-30&busca=38271&pagina=1&limite=50');
    await pg.disparar('botaoLimparFiltros');
    assert.equal(leituras().at(-1), '/api/estoque/operacoes?pagina=1&limite=50');
    assert.deepEqual(['filtroTipo', 'filtroDe', 'filtroAte', 'filtroBusca'].map((id) => pg.el(id).value), ['', '', '', '']);
  });

  test('12D-3: tipo ENTREGA e origem vão ao servidor; página seguinte mantém; Limpar zera os cinco filtros', async () => {
    const pg = montarPagina({ responder: (m, u) => resposta(200, listagem({ total: 120, paginas: 3, pagina: Number(u.searchParams.get('pagina')) })) });
    await pg.esperar();
    Object.assign(pg.el('filtroTipo'), { value: 'ENTREGA' });
    Object.assign(pg.el('filtroOrigem'), { value: 'SOLICITACAO' });
    await pg.disparar('botaoFiltrar');
    assert.equal(leituras().at(-1), '/api/estoque/operacoes?tipo=ENTREGA&origem=SOLICITACAO&pagina=1&limite=50');
    await pg.disparar('paginaProxima');
    assert.equal(leituras().at(-1), '/api/estoque/operacoes?tipo=ENTREGA&origem=SOLICITACAO&pagina=2&limite=50');
    await pg.disparar('botaoLimparFiltros');
    assert.deepEqual(['filtroTipo', 'filtroOrigem', 'filtroDe', 'filtroAte', 'filtroBusca'].map((id) => pg.el(id).value), ['', '', '', '', '']);
    assert.equal(leituras().at(-1), '/api/estoque/operacoes?pagina=1&limite=50');
  });

  test('12D-3: a origem só vale sem tipo ou com ENTREGA; com outro tipo o campo zera e fica desabilitado, e volta ao escolher ENTREGA', async () => {
    const pg = montarPagina();
    await pg.esperar();
    Object.assign(pg.el('filtroOrigem'), { value: 'DIRETA' });
    Object.assign(pg.el('filtroTipo'), { value: 'BAIXA' });
    await pg.disparar('filtroTipo', 'change');
    assert.deepEqual([pg.el('filtroOrigem').value, pg.el('filtroOrigem').disabled], ['', true]);
    assert.equal(leituras().at(-1), '/api/estoque/operacoes?tipo=BAIXA&pagina=1&limite=50');
    Object.assign(pg.el('filtroTipo'), { value: 'ENTREGA' });
    await pg.disparar('filtroTipo', 'change');
    assert.equal(pg.el('filtroOrigem').disabled, false);
    Object.assign(pg.el('filtroOrigem'), { value: 'DIRETA' });
    await pg.disparar('filtroOrigem', 'change');
    assert.equal(leituras().at(-1), '/api/estoque/operacoes?tipo=ENTREGA&origem=DIRETA&pagina=1&limite=50');
  });

  test('12D-3: a tabela da página mostra a entrega com a origem e, quando o servidor liberou, a ficha e o trabalhador; o filtro de origem conta como filtro no vazio', async () => {
    const itens = [entrega(ENTREGA_SOLICITACAO_COM_DETALHE), entrega(ENTREGA_DIRETA, { operacaoId: '40' })];
    const pg = montarPagina({ responder: () => resposta(200, listagem({ operacoes: itens, total: 2 })) });
    await pg.esperar();
    const corpo = pg.el('operacoesCorpo').innerHTML;
    assert.match(corpo, /Por solicitação/);
    assert.match(corpo, /Direta/);
    assert.match(corpo, /João da Silva · M-100/);
    const vazio = montarPagina({ responder: () => resposta(200, listagem({ operacoes: [], total: 0, paginas: 0 })) });
    await vazio.esperar();
    assert.match(vazio.el('operacoesCorpo').innerHTML, /Nenhuma operação de estoque registrada nesta empresa/);
    Object.assign(vazio.el('filtroOrigem'), { value: 'DIRETA' });
    await vazio.disparar('botaoFiltrar');
    assert.match(vazio.el('operacoesCorpo').innerHTML, /Nenhuma operação para este filtro/);
  });

  test('período invertido: nada é consultado e o campo fica marcado', async () => {
    const pg = montarPagina();
    await pg.esperar();
    const antes = leituras().length;
    Object.assign(pg.el('filtroDe'), { value: '2026-09-30' });
    Object.assign(pg.el('filtroAte'), { value: '2026-09-01' });
    await pg.disparar('botaoFiltrar');
    assert.equal(leituras().length, antes);
    assert.equal(pg.el('filtroAte').atributos['aria-invalid'], 'true');
    assert.match(pg.el('aviso').innerHTML, /período/i);
  });

  test('paginação: próxima e anterior pedem a página certa', async () => {
    const pg = montarPagina({ responder: (m, u) => resposta(200, listagem({ total: 120, paginas: 3, pagina: Number(u.searchParams.get('pagina')) })) });
    await pg.esperar();
    assert.equal(pg.el('paginaProxima').disabled, false);
    await pg.disparar('paginaProxima');
    assert.equal(leituras().at(-1), '/api/estoque/operacoes?pagina=2&limite=50');
    await pg.disparar('paginaAnterior');
    assert.equal(leituras().at(-1), '/api/estoque/operacoes?pagina=1&limite=50');
  });

  test('falha na consulta: mensagem própria no aviso e tabela sem dados', async () => {
    const pg = montarPagina({ responder: () => resposta(500, { status: 'error', codigo: 'ERRO_INTERNO', message: 'SEGREDO-INTERNO' }) });
    await pg.esperar();
    assert.equal(/SEGREDO/.test(pg.el('aviso').innerHTML), false);
    assert.equal(/Botina/.test(pg.el('operacoesCorpo').innerHTML), false);
  });
});

describe('inspeção estática', () => {
  const html = ler('pages/operations.html');
  const codigo = semComentarios(html);

  test('página integrada: sessão real, permissões do servidor; sem protótipo, sem planilha externa, sem auditoria', () => {
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/operacoes-estoque.js']);
    for (const proibido of [/db-api\.js/, /main\.js/, /xlsx/i, /localStorage/, /sessionStorage/, /document\.cookie/, /showView\(/, /setActiveNav/, /data-page=/, /localhost:3000/, /auditoria/i, /Cobresul/, /doLogin/]) {
      assert.equal(proibido.test(codigo.replace(/onclick="(closeMobileMenu|toggleSidebar)\(\)"/g, '')), false, `contém ${proibido}`);
    }
    assert.equal(/auditoria/i.test(semComentarios(ler('js/operacoes-estoque.js'))), false);
    assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
    assert.match(codigo, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'operations'/);
    for (const id of ['identidade', 'botaoSair', 'botaoTrocarEmpresa']) assert.equal(html.includes(`id="${id}"`), false, id);
  });

  test('só leitura: página e módulo não têm ação de editar ou excluir, nem requisição que não seja GET', () => {
    const modulo = semComentarios(ler('js/operacoes-estoque.js'));
    for (const trecho of [codigo, modulo]) {
      assert.equal(/'(POST|PUT|PATCH|DELETE)'/.test(trecho), false);
      assert.equal(/>\s*(Editar|Excluir|Apagar|Remover)\b/i.test(trecho), false);
    }
    assert.match(modulo, /requisitar\('GET', CAMINHO/);
  });

  test('nome único "Operações de estoque" no título, no cabeçalho e no menu; o nome antigo saiu', () => {
    assert.match(html, /<title>Operações de estoque — Gestão de EPIs<\/title>/);
    assert.match(html, /<h2>Operações de estoque<\/h2>/);
    assert.ok(html.includes(`<p>${SUBTITULO}</p>`));
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="operations" style="display:none"><div class="nav-icon gray">receipt_long<\/div>Operações de estoque<\/a>/);
    assert.equal(/Operações \/ Log|Operações e Logs|Logs do Sistema/i.test(codigo), false);
  });

  test('filtros com as opções do módulo; período com dois campos de data; colunas pedidas', () => {
    const trecho = html.slice(html.indexOf('id="filtroTipo"')).split('</select>')[0];
    assert.deepEqual([...trecho.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]), modulo().FILTROS.map((f) => f[0]));
    // 12D-3: origem da entrega, com rótulo associado e as opções do módulo.
    assert.match(html, /<label for="filtroOrigem">Origem da entrega<\/label>/);
    const origens = html.slice(html.indexOf('id="filtroOrigem"')).split('</select>')[0];
    assert.deepEqual([...origens.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]), modulo().ORIGENS);
    assert.match(html, /<input id="filtroDe" class="input" type="date"/);
    assert.match(html, /<input id="filtroAte" class="input" type="date"/);
    assert.match(html, /<input id="filtroBusca" class="input" type="search" maxlength="100"/);
    const colunas = [...html.slice(html.indexOf('<thead>'), html.indexOf('</thead>')).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(colunas, ['Data/hora', 'Operação', 'Material', 'Tamanho', 'CA / lote', 'Quantidade', 'Motivo', 'Justificativa', 'Responsável', 'Referência']);
  });

  test('innerHTML só com texto fixo, o render do módulo ou o aviso escapado', () => {
    const script = html.slice(html.lastIndexOf('<script>'));
    const origens = [...script.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(origens.length > 0);
    for (const origem of origens) {
      assert.match(origem, /^(''|O\.render\.[a-zA-Z]+\([^)]*\)|'<div class="notice" style="' \+ cor \+ '">' \+ O\.render\.escaparHtml\(texto\) \+ '<\/div>')$/, origem);
    }
  });

  test('visual de vidro com tema claro e escuro pelos tokens do sistema; tabela com rolagem e legenda acessível', () => {
    assert.match(html, /\.vidro\{[^}]*backdrop-filter:blur\(/);
    assert.match(html, /html\[data-theme="dark"\] \.vidro\{/);
    assert.match(html, /<div class="table-wrap"/);
    // 12D-3: o tipo Entrega tem cor própria nos dois temas, e o selo sempre traz o texto (nunca só cor).
    assert.match(html, /\.tipo\.tipo-entrega\{/);
    assert.match(html, /td\.numero\.tipo-entrega\{/);
    assert.match(html, /--tipo-entrega:[^;]+;--tipo-entrega-fundo:/);
    assert.match(html, /html\[data-theme="dark"\] \.operacoes\{[^}]*--tipo-entrega:/);
    assert.match(html, /<caption class="sr-only">/);
    assert.match(html, /id="aviso" role="status" aria-live="polite"/);
  });
});

describe('permissão, menus, Portal e publicação', () => {
  const NAO_ADMINISTRATIVAS = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html'))
    .filter((f) => !['autorizacoes-individuais.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'grupos-acesso.html', 'new-user.html', 'user-admin.html'].includes(f));

  test('a página abre com operations.visualizar, a permissão própria (E9)', () => {
    assert.deepEqual(P.PAGINAS.operations, { abrir: [{ recurso: 'operations', operacao: 'visualizar' }], alterar: [] });
  });

  test('as outras páginas integradas oferecem Operações de estoque (oculta até a permissão); nenhuma mantém o item "em integração"', () => {
    for (const arquivo of ['materials', 'available-items', 'dashboard', 'employee-groups', 'employee-history', 'import-employees', 'stock-validity']) {
      const pagina = ler(`pages/${arquivo}.html`);
      assert.match(pagina, /<a href="operations\.html" data-pagina="operations" style="display:none"><div class="nav-icon gray">receipt_long<\/div>Operações de estoque<\/a>/, arquivo);
      assert.equal(/receipt_long<\/div>Operações<span/.test(pagina), false, arquivo);
    }
  });

  test('o mesmo nome em todo menu que tem o item, no Portal, no catálogo de permissões e na administração de usuários', () => {
    assert.equal(NAO_ADMINISTRATIVAS.length, 22);
    for (const arquivo of NAO_ADMINISTRATIVAS) {
      const rotulos = [...ler(`pages/${arquivo}`).matchAll(/<div class="nav-icon gray">receipt_long<\/div>([^<]*)</g)].map((m) => m[1]);
      assert.deepEqual(rotulos, [NOME], arquivo);
    }
    assert.match(ler('portal/inicio.html'), /<a href="\.\.\/pages\/operations\.html" data-pagina="operations" style="display:none">Operações de estoque<\/a>/);
    assert.equal(require('../js/grupo-permissoes').RECURSOS.find((r) => r.id === 'operations').nome, NOME); // eslint-disable-line global-require
    const admin = ler('pages/gestao-usuarios.html');
    assert.equal(/<strong>Operações<\/strong>/.test(admin), false);
    assert.equal(/Logs e auditoria|Consulta logs/.test(admin), false);
  });

  test('publicação: módulo e página na allowlist', () => {
    const allowlist = JSON.parse(ler('publicacao/allowlist.json'));
    const itens = JSON.stringify(allowlist);
    assert.ok(itens.includes('"js/operacoes-estoque.js"'));
    assert.ok(itens.includes('"pages/operations.html"'));
  });
});
