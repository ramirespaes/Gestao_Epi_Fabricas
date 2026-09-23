'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const EpiAutorizacoes = require('../js/autorizacoes-individuais');

const { acoes, mensagens, render, origensDelegaveis } = EpiAutorizacoes;

/**
 * Testes da tela de autorizações individuais e delegações (Bloco 8,
 * Incremento 8, Etapa 5A, Subetapa 3V), com `fetch` injetado e relógio
 * falso — sem navegador e sem banco.
 *
 * O que se prova aqui:
 *   1. os contratos da 3P são montados exatamente como o schema exige —
 *      em particular, DELEGADA nunca leva acaoCodigo;
 *   2. a tela nunca oferece um origemId arbitrário: as origens saem das
 *      autorizações do próprio ator, filtradas por podeDelegar;
 *   3. cada recusa da 3I vira um texto que explica a regra;
 *   4. a revogação jamais sugere que alcança autorizações independentes;
 *   5. as duas guardas de concorrência funcionam — chegada fora de ordem
 *      e partida atrasada.
 *
 * O caminho ponta a ponta está em
 * backend/test/integracao/frontend-autorizacoes.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const MASTER = 1;
const ADMIN = 5;
const ANA = 9;
const BRUNO = 11;

function fetchFalso(respostas) {
  const chamadas = [];
  const fila = Array.isArray(respostas) ? respostas.slice() : [respostas];
  const fn = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    const proxima = fila.length > 1 ? fila.shift() : fila[0];
    if (proxima instanceof Error) throw proxima;
    return proxima;
  };
  fn.chamadas = chamadas;
  return fn;
}

const resposta = (status, corpo) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)),
});

const erro = (status, codigo, message, detalhes) => resposta(status, { status: 'error', codigo, message, detalhes });

const corpoDe = (chamada) => JSON.parse(chamada.opcoes.body);

const autorizacao = (extra = {}) => ({
  id: 100, empresaId: 1, usuarioId: ANA, acaoCodigo: 'MOVIMENTAR_ESTOQUE',
  motivo: null, autorizadoPor: MASTER, podeDelegar: false, origemId: null,
  usuarioNome: 'Ana Souza', autorizadoPorNome: 'Master da Empresa',
  acaoNome: 'Movimentar estoque', acaoAtiva: true, acaoExigeSst: false,
  acaoModo: 'ALTERNATIVA', ...extra,
});

beforeEach(() => {
  EpiHttp.configurar({ baseUrl: BASE, fetch: fetchFalso(resposta(200, { status: 'ok' })) });
});

// ─────────────────────────────────────────────────────────────────────
describe('ações — contratos reais da 3P, 3T, 3U e a consulta da 3V', () => {
  test('listarDoUsuario consulta por usuarioId, com cookie e sem corpo', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', autorizacoes: [], escopo: 'TOTAL' }));
    EpiHttp.configurar({ fetch });

    await acoes.listarDoUsuario(ANA);

    assert.equal(fetch.chamadas[0].url, `${BASE}/autorizacoes-individuais?usuarioId=9`);
    assert.equal(fetch.chamadas[0].opcoes.method, 'GET');
    assert.equal(fetch.chamadas[0].opcoes.credentials, 'include');
    assert.equal(fetch.chamadas[0].opcoes.body, undefined);
  });

  test('concederDireta envia tipo DIRETA com acaoCodigo, e NUNCA origemId', async () => {
    const fetch = fetchFalso(resposta(201, { status: 'ok', autorizacao: {} }));
    EpiHttp.configurar({ fetch });

    await acoes.concederDireta({ usuarioId: ANA, acaoCodigo: 'MOVIMENTAR_ESTOQUE' });

    const corpo = corpoDe(fetch.chamadas[0]);
    assert.equal(fetch.chamadas[0].opcoes.method, 'POST');
    assert.deepEqual(corpo, { tipo: 'DIRETA', usuarioId: ANA, acaoCodigo: 'MOVIMENTAR_ESTOQUE' });
    assert.equal('origemId' in corpo, false, 'o schema da 3P recusaria os dois juntos');
  });

  test('delegar envia tipo DELEGADA com origemId, e NUNCA acaoCodigo', async () => {
    const fetch = fetchFalso(resposta(201, { status: 'ok', autorizacao: {} }));
    EpiHttp.configurar({ fetch });

    await acoes.delegar({ usuarioId: BRUNO, origemId: 100 });

    const corpo = corpoDe(fetch.chamadas[0]);
    assert.deepEqual(corpo, { tipo: 'DELEGADA', usuarioId: BRUNO, origemId: 100 });
    assert.equal('acaoCodigo' in corpo, false, 'a ação nasce da origem');
  });

  test('podeDelegar e motivo só viajam quando informados', async () => {
    const fetch = fetchFalso(resposta(201, { status: 'ok', autorizacao: {} }));
    EpiHttp.configurar({ fetch });

    await acoes.concederDireta({ usuarioId: ANA, acaoCodigo: 'X', podeDelegar: false, motivo: '   ' });
    await acoes.concederDireta({ usuarioId: ANA, acaoCodigo: 'X', podeDelegar: true, motivo: '  porque sim  ' });

    assert.deepEqual(corpoDe(fetch.chamadas[0]), { tipo: 'DIRETA', usuarioId: ANA, acaoCodigo: 'X' });
    assert.deepEqual(corpoDe(fetch.chamadas[1]), {
      tipo: 'DIRETA', usuarioId: ANA, acaoCodigo: 'X', podeDelegar: true, motivo: 'porque sim',
    });
  });

  test('revogar usa DELETE com o id na URL; motivo vazio não vira campo', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', revogada: {}, descendentesObservados: 0 }));
    EpiHttp.configurar({ fetch });

    await acoes.revogar(100);
    await acoes.revogar(100, '  erro de cadastro ');

    assert.equal(fetch.chamadas[0].url, `${BASE}/autorizacoes-individuais/100`);
    assert.equal(fetch.chamadas[0].opcoes.method, 'DELETE');
    assert.deepEqual(corpoDe(fetch.chamadas[0]), {});
    assert.deepEqual(corpoDe(fetch.chamadas[1]), { motivo: 'erro de cadastro' });
  });

  test('NÃO existe ação de "revogar em cascata": a cascata é do banco', () => {
    const nomes = Object.keys(acoes);

    // `listarDestinatarios` entrou no complemento de destinatários — a
    // única ação nova, e de leitura.
    assert.deepEqual(nomes.sort(), [
      'catalogoDeAcoes', 'concederDireta', 'delegar', 'listarDestinatarios', 'listarDoUsuario', 'listarUsuarios', 'revogar',
    ]);
    for (const nome of nomes) {
      assert.equal(/cascata|descendentes|transferir/i.test(nome), false);
    }
  });

  test('nenhum campo de autoridade sai do cliente', async () => {
    const fetch = fetchFalso(resposta(201, { status: 'ok', autorizacao: {} }));
    EpiHttp.configurar({ fetch });

    await acoes.concederDireta({ usuarioId: ANA, acaoCodigo: 'X' });
    await acoes.delegar({ usuarioId: BRUNO, origemId: 100 });

    for (const chamada of fetch.chamadas) {
      const corpo = corpoDe(chamada);
      for (const proibido of EpiHttp.CAMPOS_DE_AUTORIDADE_PROIBIDOS) {
        assert.equal(proibido in corpo, false, `${proibido} vazou`);
      }
      assert.equal('autorizadoPor' in corpo, false);
      assert.equal('concedidoPor' in corpo, false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('origens delegáveis — nunca um origemId arbitrário', () => {
  test('só autorizações repassáveis entram', () => {
    const origens = origensDelegaveis([
      autorizacao({ id: 1, podeDelegar: true }),
      autorizacao({ id: 2, podeDelegar: false }),
    ]);

    assert.deepEqual(origens.map((o) => o.id), [1]);
  });

  test('ação desativada ou de modo NENHUMA não serve de origem', () => {
    const origens = origensDelegaveis([
      autorizacao({ id: 1, podeDelegar: true, acaoAtiva: false }),
      autorizacao({ id: 2, podeDelegar: true, acaoModo: 'NENHUMA' }),
      autorizacao({ id: 3, podeDelegar: true, acaoModo: 'OBRIGATORIA' }),
    ]);

    assert.deepEqual(origens.map((o) => o.id), [3]);
  });

  test('lista ausente ou vazia devolve vazio', () => {
    assert.deepEqual(origensDelegaveis([]), []);
    assert.deepEqual(origensDelegaveis(undefined), []);
  });

  test('as opções de origem mostram a ação, porque é ela que será repassada', () => {
    const html = render.opcoesDeOrigem([autorizacao({ id: 7, acaoNome: 'Movimentar estoque' })]);

    assert.match(html, /value="7"/);
    assert.match(html, /Movimentar estoque/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('mensagens — as regras da 3I em português comum', () => {
  test('403 de concessão explica que conceder direto é só do Master', () => {
    assert.match(mensagens.deErro({ ok: false, status: 403, codigo: 'CONCESSAO_NAO_AUTORIZADA' }), /master/i);
  });

  test('403 de delegação explica que poder executar não é poder repassar', () => {
    const texto = mensagens.deErro({ ok: false, status: 403, codigo: 'DELEGACAO_NAO_AUTORIZADA' });

    assert.match(texto, /repass/i);
    assert.match(texto, /valendo para você agora/i, 'a autorização efetiva faz parte da regra');
  });

  test('403 de revogação explica o limite de quem concedeu', () => {
    assert.match(mensagens.deErro({ ok: false, status: 403, codigo: 'REVOGACAO_NAO_AUTORIZADA' }), /você mesmo concedeu/i);
  });

  test('409, 400 e 404 da 3I têm textos próprios', () => {
    assert.match(mensagens.deErro({ ok: false, status: 409, codigo: 'AUTORIZACAO_JA_EXISTE' }), /já tem/i);
    assert.match(mensagens.deErro({ ok: false, status: 400, codigo: 'AUTOCONCESSAO_NAO_PERMITIDA' }), /si mesmo/i);
    assert.match(mensagens.deErro({ ok: false, status: 400, codigo: 'CONCESSAO_INVALIDA' }), /desativada/i);
    assert.match(mensagens.deErro({ ok: false, status: 404, codigo: 'AUTORIZACAO_NAO_ENCONTRADA' }), /não existe mais/i);
  });

  test('401 pede novo login; rede e validação têm textos próprios', () => {
    const sessao = { ok: false, status: 401, codigo: 'SESSAO_INVALIDA' };

    assert.equal(mensagens.exigeNovoLogin(sessao), true);
    assert.match(mensagens.deErro(sessao), /sessão expirou/i);
    assert.match(mensagens.deErro({ ok: false, status: 0, codigo: 'FALHA_DE_REDE' }), /conexão/i);
    assert.equal(mensagens.deErro({
      ok: false, status: 400, codigo: 'VALIDACAO',
      detalhes: [{ campo: 'usuarioId', codigo: 'ID_INVALIDO', mensagem: 'Identificador inválido' }],
    }), 'Identificador inválido');
    assert.equal(mensagens.deErro({ ok: true }), '');
  });

  test('o escopo é explicado: a lista pode ser parcial, e isso se diz', () => {
    assert.match(mensagens.doEscopo('TOTAL', 'Ana'), /todas/i);
    assert.match(mensagens.doEscopo('PROPRIAS', 'Ana'), /suas/i);
    assert.match(mensagens.doEscopo('CONCEDIDAS_POR_MIM', 'Ana'), /apenas as autorizações que você mesmo concedeu/i);
  });

  test('a confirmação de revogação avisa da cascata SEM prometer demais', () => {
    const comRepasse = mensagens.confirmacaoDeRevogacao(autorizacao({ podeDelegar: true }));
    const semRepasse = mensagens.confirmacaoDeRevogacao(autorizacao({ podeDelegar: false }));

    assert.match(comRepasse, /repassadas também serão removidas/i);
    assert.equal(semRepasse.includes('também serão removidas'), false);
    for (const texto of [comRepasse, semRepasse]) {
      assert.match(texto, /por outro caminho não são afetadas/i, 'as independentes ficam');
      assert.match(texto, /ninguém é excluído/i);
    }
  });

  test('o resultado da revogação conta as derivadas, no singular e no plural', () => {
    assert.equal(mensagens.deRevogacao('Ana', 'X', 0).includes('também'), false);
    assert.match(mensagens.deRevogacao('Ana', 'X', 1), /A autorização que tinha sido repassada/);
    assert.match(mensagens.deRevogacao('Ana', 'X', 3), /3 autorizações repassadas/);
  });

  test('a ausência de origem explica o motivo certo para cada perfil', () => {
    assert.match(mensagens.semOrigemParaDelegar(true), /Master não delega/i);
    assert.match(mensagens.semOrigemParaDelegar(true), /concessão direta/i);
    assert.match(mensagens.semOrigemParaDelegar(false), /repassável/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('render — tipo, origem e HTML escapado', () => {
  test('direta e delegada são distinguidas por origemId, como no banco', () => {
    assert.equal(render.ehDelegada(autorizacao({ origemId: null })), false);
    assert.equal(render.ehDelegada(autorizacao({ origemId: 55 })), true);
    assert.match(render.selo(autorizacao({ origemId: null })), /Direta/);
    assert.match(render.selo(autorizacao({ origemId: 55 })), /Repassada/);
  });

  test('a linha mostra a ação por nome, com o código em segundo plano', () => {
    const html = render.linha(autorizacao());

    assert.match(html, /<strong>Movimentar estoque<\/strong>/);
    assert.match(html, /MOVIMENTAR_ESTOQUE/);
    assert.match(html, /Concedida por Master da Empresa/);
  });

  test('delegada diz de quem foi repassada', () => {
    const html = render.linha(autorizacao({ origemId: 55, autorizadoPorNome: 'Ana Souza' }));

    assert.match(html, /Repassada de Ana Souza/);
  });

  test('as observações explicam repasse, SST, ação desativada e modo NENHUMA', () => {
    assert.match(render.linha(autorizacao({ podeDelegar: true })), /pode repassar adiante/);
    assert.match(render.linha(autorizacao({ acaoExigeSst: true })), /exige vínculo com a SST/);
    assert.match(render.linha(autorizacao({ acaoAtiva: false })), /desativada no catálogo/);
    assert.match(render.linha(autorizacao({ acaoModo: 'NENHUMA' })), /não usa autorização individual/);
    assert.match(render.linha(autorizacao()), /—/, 'sem observação, travessão');
  });

  test('a linha só oferece revogar quando o controlador diz que pode — e nenhuma outra ação', () => {
    // AJUSTADO na correção pós-auditoria (item 3): antes, toda linha
    // trazia o botão, inclusive as que o backend recusaria com 403.
    const comBotao = render.linha(autorizacao(), { podeRevogar: true });
    const semBotao = render.linha(autorizacao(), { podeRevogar: false });
    const semOpcoes = render.linha(autorizacao());

    assert.match(comBotao, /data-acao="revogar"/);
    assert.equal(/data-acao="(?!revogar)/.test(comBotao), false);
    assert.equal(semBotao.includes('data-acao="revogar"'), false);
    assert.match(semBotao, /Só quem concedeu pode revogar/);
    assert.equal(semOpcoes.includes('data-acao="revogar"'), false, 'sem decisão explícita, sem botão');
  });

  test('as opções de ação excluem inativas e modo NENHUMA', () => {
    const html = render.opcoesDeAcao([
      { codigo: 'A', nome: 'Alternativa', ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' },
      { codigo: 'B', nome: 'Obrigatoria', ativo: true, exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' },
      { codigo: 'C', nome: 'Nenhuma', ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'NENHUMA' },
      { codigo: 'D', nome: 'Inativa', ativo: false, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' },
    ]);

    assert.match(html, /value="A"/);
    assert.match(html, /value="B"/);
    assert.equal(html.includes('value="C"'), false, 'NENHUMA não aceita autorização individual');
    assert.equal(html.includes('value="D"'), false, 'inativa seria recusada pelo backend');
    assert.match(html, /Obrigatoria \(exige SST\)/, 'a exigência de SST aparece antes de conceder');
  });

  test('nomes maliciosos NÃO viram HTML executável', () => {
    const veneno = '<img src=x onerror="alert(1)">';
    const malicioso = autorizacao({ usuarioNome: veneno, autorizadoPorNome: veneno, acaoNome: veneno, acaoCodigo: veneno });

    assert.equal(render.linha(malicioso).includes('<img'), false);
    assert.equal(render.tabela([malicioso]).includes('<img'), false);
    assert.equal(render.opcoesDeOrigem([malicioso]).includes('<img'), false);
    assert.equal(render.falha(veneno).includes('<img'), false);
    assert.equal(render.vazia(veneno).includes('<img'), false);
    assert.equal(render.opcoesDeAcao([
      { codigo: veneno, nome: veneno, ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' },
    ]).includes('<img'), false);
  });

  test('escaparHtml trata null e undefined como texto vazio', () => {
    assert.equal(render.escaparHtml(null), '');
    assert.equal(render.escaparHtml(undefined), '');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Controlador — comportamento da tela
// ─────────────────────────────────────────────────────────────────────

function fetchDeferido() {
  const pendentes = [];
  const fn = async (url, opcoes) => new Promise((resolve, reject) => {
    pendentes.push({ url, opcoes, resolve, reject, respondido: false });
  });
  fn.pendentes = pendentes;

  const casa = (criterio) => (p) => (typeof criterio === 'function' ? criterio(p) : p.url.includes(criterio));

  fn.responder = (criterio, valor) => {
    const alvo = pendentes.find((p) => !p.respondido && casa(criterio)(p));
    assert.ok(alvo, `nenhuma requisição pendente casa com "${criterio}"`);
    alvo.respondido = true;
    alvo.resolve(valor);
    return alvo;
  };
  fn.responderTodos = (criterio, valor) => {
    let quantos = 0;
    for (const p of pendentes) {
      if (p.respondido || !casa(criterio)(p)) continue;
      p.respondido = true;
      p.resolve(valor);
      quantos += 1;
    }
    return quantos;
  };
  fn.pendentesDe = (criterio) => pendentes.filter((p) => !p.respondido && casa(criterio)(p));
  return fn;
}

function uiFalso() {
  const registro = {
    autorizacoes: [], pessoas: [], avisos: [], escopos: [], origens: [],
    acoesConcediveis: [], podeConceder: [], avisoDelegacao: [], sessao: [], usuario: [],
  };
  return {
    registro,
    renderAutorizacoes(html) { registro.autorizacoes.push(html); },
    renderPessoas(valor, total) { registro.pessoas.push({ valor, total }); },
    aviso(texto, tipo) { registro.avisos.push({ texto, tipo }); },
    escopo(texto) { registro.escopos.push(texto); },
    origens(html, quantas) { registro.origens.push({ html, quantas }); },
    acoesConcediveis(html, temAlguma) { registro.acoesConcediveis.push({ html, temAlguma }); },
    podeConcederDireta(pode) { registro.podeConceder.push(pode); },
    avisoDelegacao(texto) { registro.avisoDelegacao.push(texto); },
    sessaoExpirada(mensagem) { registro.sessao.push(mensagem); },
    usuarioSelecionado(nome) { registro.usuario.push(nome); },
  };
}

function relogioFalso() {
  let proximoId = 1;
  const agendados = new Map();
  return {
    agendar(fn) { const id = proximoId; proximoId += 1; agendados.set(id, fn); return id; },
    cancelar(id) { agendados.delete(id); },
    pendentes() { return agendados.size; },
    avancar() {
      const pendentes = [...agendados.entries()];
      agendados.clear();
      for (const [, fn] of pendentes) fn();
    },
  };
}

const ultimo = (lista) => lista[lista.length - 1];
const ehConsultaDeAutorizacoes = (p) => p.url.startsWith(`${BASE}/autorizacoes-individuais?`);

/**
 * Espera a requisição aparecer. Depois de resolver uma promessa, quem a
 * aguardava só continua no microtask seguinte — responder à recarga no
 * mesmo bloco síncrono seria responder a algo que ainda não foi pedido.
 * A mesma lição do harness da 3U.
 */
async function aguardarRequisicao(fetch, criterio, tentativas = 50) {
  for (let i = 0; i < tentativas; i += 1) {
    if (fetch.pendentesDe(criterio).length > 0) return;
    await new Promise((resolver) => { setImmediate(resolver); });
  }
  assert.fail('a requisição esperada nunca foi emitida');
}

function montarCenario() {
  const fetch = fetchDeferido();
  EpiHttp.configurar({ baseUrl: BASE, fetch });
  const ui = uiFalso();
  const relogio = relogioFalso();
  const controlador = EpiAutorizacoes.criarControlador({
    ui, agendar: relogio.agendar, cancelar: relogio.cancelar,
  });
  return { fetch, ui, controlador, relogio };
}

const CATALOGO = [
  { codigo: 'MOVIMENTAR_ESTOQUE', nome: 'Movimentar estoque', ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' },
  { codigo: 'APROVAR_SOLICITACAO', nome: 'Aprovar solicitação', ativo: true, exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' },
];

/** Inicia o controlador como MASTER ou como ADMINISTRADOR. */
async function iniciar(cenario, { perfil = 'MASTER', id = MASTER, minhas = [] } = {}) {
  const promessa = cenario.controlador.iniciar({ id, perfil });
  cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
    status: 'ok', autorizacoes: minhas, escopo: 'PROPRIAS',
  }));
  cenario.fetch.responder('/catalogo/acoes', resposta(200, { status: 'ok', acoes: CATALOGO }));
  return promessa;
}

describe('controlador — início e identidade', () => {
  test('MASTER pode conceder direto; a tela é informada disso', async () => {
    const cenario = montarCenario();

    const resultado = await iniciar(cenario, { perfil: 'MASTER' });

    assert.equal(resultado.status, 'ok');
    assert.equal(resultado.podeConceder, true);
    assert.equal(ultimo(cenario.ui.registro.podeConceder), true);
    assert.equal(cenario.controlador.ehMaster(), true);
  });

  test('MASTER sem origens recebe a explicação certa: ele não delega', async () => {
    const cenario = montarCenario();

    await iniciar(cenario, { perfil: 'MASTER', minhas: [] });

    assert.match(ultimo(cenario.ui.registro.avisoDelegacao), /Master não delega/i);
    assert.equal(ultimo(cenario.ui.registro.origens).quantas, 0);
  });

  test('não-MASTER não pode conceder direto, mas pode ter origens', async () => {
    const cenario = montarCenario();

    const resultado = await iniciar(cenario, {
      perfil: 'ADMINISTRADOR', id: ADMIN,
      minhas: [autorizacao({ id: 70, usuarioId: ADMIN, podeDelegar: true })],
    });

    assert.equal(resultado.podeConceder, false);
    assert.equal(ultimo(cenario.ui.registro.podeConceder), false);
    assert.equal(resultado.origens, 1);
    assert.equal(ultimo(cenario.ui.registro.avisoDelegacao), '');
    assert.deepEqual(cenario.controlador.origensDelegaveis().map((o) => o.id), [70]);
  });

  test('não-MASTER sem nada repassável recebe a outra explicação', async () => {
    const cenario = montarCenario();

    await iniciar(cenario, {
      perfil: 'ADMINISTRADOR', id: ADMIN,
      minhas: [autorizacao({ id: 70, usuarioId: ADMIN, podeDelegar: false })],
    });

    assert.match(ultimo(cenario.ui.registro.avisoDelegacao), /repassável/i);
  });

  test('falta de autoridade no catálogo não impede o resto da tela', async () => {
    const cenario = montarCenario();

    const promessa = cenario.controlador.iniciar({ id: ADMIN, perfil: 'ADMINISTRADOR' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [autorizacao({ id: 70, usuarioId: ADMIN, podeDelegar: true })], escopo: 'PROPRIAS',
    }));
    cenario.fetch.responder('/catalogo/acoes', erro(403, 'CATALOGO_NAO_AUTORIZADO', 'Sem autoridade'));

    const resultado = await promessa;

    assert.equal(resultado.status, 'ok');
    assert.equal(resultado.acoes, 0, 'sem catálogo');
    assert.equal(resultado.origens, 1, 'mas a delegação segue possível');
  });
});

describe('controlador — consulta por pessoa', () => {
  async function comMaster() {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'MASTER' });
    return cenario;
  }

  test('sem pessoa selecionada, a tela pede a seleção e não consulta', async () => {
    const cenario = await comMaster();
    const antes = cenario.fetch.pendentes.length;

    const resultado = await cenario.controlador.selecionar(null);

    assert.equal(resultado.status, 'sem-usuario');
    assert.equal(cenario.fetch.pendentes.length, antes);
    assert.match(ultimo(cenario.ui.registro.autorizacoes), /Selecione uma pessoa/i);
  });

  test('selecionar carrega as autorizações e explica o escopo', async () => {
    const cenario = await comMaster();

    const carga = cenario.controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [autorizacao()], escopo: 'TOTAL',
    }));
    const resultado = await carga;

    assert.equal(resultado.status, 'ok');
    assert.equal(resultado.total, 1);
    assert.match(ultimo(cenario.ui.registro.autorizacoes), /Movimentar estoque/);
    assert.match(ultimo(cenario.ui.registro.escopos), /todas/i);
    assert.equal(ultimo(cenario.ui.registro.usuario), 'Ana Souza');
  });

  test('pessoa sem autorização nenhuma mostra mensagem própria', async () => {
    const cenario = await comMaster();

    const carga = cenario.controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [], escopo: 'TOTAL',
    }));
    await carga;

    assert.match(ultimo(cenario.ui.registro.autorizacoes), /não tem nenhuma autorização individual/i);
  });

  test('escopo parcial é dito à pessoa, para a lista não enganar', async () => {
    const cenario = await comMaster();

    const carga = cenario.controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [], escopo: 'CONCEDIDAS_POR_MIM',
    }));
    await carga;

    assert.match(ultimo(cenario.ui.registro.escopos), /apenas as autorizações que você mesmo concedeu/i);
  });

  test('403 na consulta vira mensagem, sem quebrar a tela', async () => {
    const cenario = await comMaster();

    const carga = cenario.controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, erro(403, 'AUTORIZACAO_CONSULTA_NAO_AUTORIZADA', 'Sem autoridade'));

    assert.equal((await carga).status, 'erro');
    assert.match(ultimo(cenario.ui.registro.autorizacoes), /não tem autorização para consultar/i);
  });

  test('falha de rede vira envelope, não exceção solta', async () => {
    EpiHttp.configurar({ baseUrl: BASE, fetch: fetchFalso(new TypeError('Failed to fetch')) });
    const controlador = EpiAutorizacoes.criarControlador({ ui: uiFalso() });
    await controlador.iniciar({ id: MASTER, perfil: 'MASTER' });

    const resultado = await controlador.selecionar({ id: ANA, nome: 'Ana Souza' });

    assert.equal(resultado.status, 'erro');
  });
});

describe('M. respostas fora de ordem', () => {
  async function comMaster() {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'MASTER' });
    return cenario;
  }

  test('a resposta atrasada da pessoa A não substitui a tela da pessoa B', async () => {
    const { fetch, ui, controlador } = await comMaster();

    const cargaA = controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    const cargaB = controlador.selecionar({ id: BRUNO, nome: 'Bruno Lima' });

    fetch.responder((p) => p.url.includes('usuarioId=11'), resposta(200, {
      status: 'ok', autorizacoes: [autorizacao({ id: 200, usuarioId: BRUNO, acaoNome: 'Aprovar solicitação' })], escopo: 'TOTAL',
    }));
    assert.equal((await cargaB).status, 'ok');
    const telaDeB = ultimo(ui.registro.autorizacoes);

    fetch.responder((p) => p.url.includes('usuarioId=9'), resposta(200, {
      status: 'ok', autorizacoes: [autorizacao({ id: 100, acaoNome: 'Movimentar estoque' })], escopo: 'TOTAL',
    }));
    const resultadoA = await cargaA;

    assert.equal(resultadoA.status, 'obsoleta');
    assert.equal(resultadoA.usuario, ANA);
    assert.equal(ultimo(ui.registro.autorizacoes), telaDeB);
    assert.match(telaDeB, /Aprovar solicitação/);
    assert.equal(controlador.usuarioSelecionado().id, BRUNO);
  });

  test('H. uma tecla dentro da janela do debounce descarta a resposta em voo', async () => {
    const { fetch, ui, relogio, controlador } = await comMaster();

    const primeira = controlador.digitar('an');
    relogio.avancar();
    assert.equal(fetch.pendentesDe(`${BASE}/usuarios`).length, 1);
    const telaAntes = ui.registro.pessoas.length;

    const segunda = controlador.digitar('ana');
    assert.equal(relogio.pendentes(), 1, 'a nova busca está só agendada');

    fetch.responder(`${BASE}/usuarios`, resposta(200, {
      status: 'ok', usuarios: [{ id: ANA, nome: 'Ana Souza' }, { id: BRUNO, nome: 'Bruno Lima' }], total: 2,
    }));

    assert.equal((await primeira).status, 'obsoleta');
    assert.equal(ui.registro.pessoas.length, telaAntes, 'nada foi pintado');

    relogio.avancar();
    fetch.responder(`${BASE}/usuarios`, resposta(200, {
      status: 'ok', usuarios: [{ id: ANA, nome: 'Ana Souza' }], total: 1,
    }));
    assert.equal((await segunda).status, 'ok');
  });

  test('buscarPessoas direto cancela a digitação agendada — a lição do ajuste da 3U', async () => {
    const { fetch, relogio, controlador } = await comMaster();

    const digitando = controlador.digitar('an');
    assert.equal(relogio.pendentes(), 1);

    const buscando = controlador.buscarPessoas('bruno');
    assert.equal(relogio.pendentes(), 0, 'o temporizador esquecido deixou de existir');
    assert.deepEqual(await digitando, { status: 'substituida' });

    const pedidos = fetch.pendentesDe(`${BASE}/usuarios`);
    assert.equal(pedidos.length, 1);
    assert.match(pedidos[0].url, /busca=bruno/);

    fetch.responder(`${BASE}/usuarios`, resposta(200, { status: 'ok', usuarios: [], total: 0 }));
    await buscando;

    const antes = fetch.pendentes.length;
    relogio.avancar();
    assert.equal(fetch.pendentes.length, antes, 'nada disparou tarde');
    assert.equal(controlador.buscaAtual(), 'bruno');
  });

  test('selecionar outra pessoa NÃO cancela a digitação agendada: são fluxos independentes', async () => {
    // AJUSTADO na correção pós-auditoria (defeito A): a versão anterior
    // codificava o acoplamento — selecionar alguém matava a pesquisa
    // lateral que a pessoa tinha acabado de digitar. Escolher uma pessoa
    // não muda o que está escrito no campo de busca.
    const { fetch, relogio, controlador } = await comMaster();

    const digitando = controlador.digitar('an');
    const selecionando = controlador.selecionar({ id: ANA, nome: 'Ana Souza' });

    assert.equal(relogio.pendentes(), 1, 'a busca digitada continua agendada');

    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, { status: 'ok', autorizacoes: [], escopo: 'TOTAL' }));
    await selecionando;

    relogio.avancar();
    assert.match(fetch.pendentesDe(`${BASE}/usuarios`)[0].url, /busca=an/);
    fetch.responder(`${BASE}/usuarios`, resposta(200, { status: 'ok', usuarios: [], total: 0 }));
    assert.equal((await digitando).status, 'ok');
  });
});

describe('N/O/P. confirmação amarrada ao contexto', () => {
  async function comAnaSelecionada({ perfil = 'MASTER', id = MASTER, minhas = [] } = {}) {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil, id, minhas });
    const carga = cenario.controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [autorizacao({ id: 100, podeDelegar: true })], escopo: 'TOTAL',
    }));
    await carga;
    return cenario;
  }

  test('o pedido de concessão congela pessoa, ação e contexto', async () => {
    const { controlador } = await comAnaSelecionada();

    const pedido = controlador.prepararConcessao({ acaoCodigo: 'MOVIMENTAR_ESTOQUE', acaoNome: 'Movimentar estoque' });

    assert.equal(pedido.tipo, 'DIRETA');
    assert.equal(pedido.usuarioId, ANA);
    assert.equal(pedido.usuarioNome, 'Ana Souza');
    assert.equal(pedido.acaoCodigo, 'MOVIMENTAR_ESTOQUE');
    assert.equal(Object.isFrozen(pedido), true);
  });

  test('o pedido de delegação tira a AÇÃO da origem, não do formulário', async () => {
    const { controlador } = await comAnaSelecionada({
      perfil: 'ADMINISTRADOR', id: ADMIN,
      minhas: [autorizacao({ id: 70, usuarioId: ADMIN, podeDelegar: true, acaoCodigo: 'APROVAR_SOLICITACAO', acaoNome: 'Aprovar solicitação' })],
    });

    const pedido = controlador.prepararDelegacao({ origemId: 70 });

    assert.equal(pedido.tipo, 'DELEGADA');
    assert.equal(pedido.origemId, 70);
    assert.equal(pedido.acaoCodigo, 'APROVAR_SOLICITACAO', 'herdada da origem');
    assert.equal(pedido.acaoNome, 'Aprovar solicitação');
  });

  test('E. uma origem que não é do ator não produz pedido nenhum', async () => {
    const { controlador } = await comAnaSelecionada({
      perfil: 'ADMINISTRADOR', id: ADMIN,
      minhas: [autorizacao({ id: 70, usuarioId: ADMIN, podeDelegar: true })],
    });

    assert.equal(controlador.prepararDelegacao({ origemId: 999 }), null, 'origem inventada');
    assert.equal(controlador.prepararDelegacao({ origemId: 100 }), null, 'origem de outra pessoa');
  });

  test('D. uma autorização sem podeDelegar não vira origem', async () => {
    const { controlador } = await comAnaSelecionada({
      perfil: 'ADMINISTRADOR', id: ADMIN,
      minhas: [autorizacao({ id: 70, usuarioId: ADMIN, podeDelegar: false })],
    });

    assert.deepEqual(controlador.origensDelegaveis(), []);
    assert.equal(controlador.prepararDelegacao({ origemId: 70 }), null);
  });

  test('o pedido de revogação congela a autorização alvo', async () => {
    const { controlador } = await comAnaSelecionada();

    const pedido = controlador.prepararRevogacao(100);

    assert.equal(pedido.tipo, 'REVOGACAO');
    assert.equal(pedido.autorizacaoId, 100);
    assert.equal(pedido.usuarioNome, 'Ana Souza');
    assert.equal(pedido.podeDelegar, true);
  });

  test('revogar uma autorização que não está na lista não produz pedido', async () => {
    const { controlador } = await comAnaSelecionada();

    assert.equal(controlador.prepararRevogacao(999), null);
  });

  test('P. confirmada sem mudança, a concessão vai para a pessoa certa', async () => {
    const { fetch, ui, controlador } = await comAnaSelecionada();

    const pedido = controlador.prepararConcessao({ acaoCodigo: 'MOVIMENTAR_ESTOQUE', acaoNome: 'Movimentar estoque' });
    const executando = controlador.confirmar(pedido);

    const post = fetch.pendentesDe(`${BASE}/autorizacoes-individuais`).filter((p) => p.opcoes.method === 'POST')[0];
    assert.deepEqual(JSON.parse(post.opcoes.body), {
      tipo: 'DIRETA', usuarioId: ANA, acaoCodigo: 'MOVIMENTAR_ESTOQUE',
    });

    fetch.responder((p) => p.opcoes.method === 'POST', resposta(201, { status: 'ok', autorizacao: {} }));
    await aguardarRequisicao(fetch, ehConsultaDeAutorizacoes);
    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [autorizacao()], escopo: 'TOTAL',
    }));

    const resultado = await executando;
    assert.equal(resultado.status, 'ok');
    assert.match(ultimo(ui.registro.avisos).texto, /agora pode/i);
  });

  test('N. trocar de pessoa com confirmação aberta INVALIDA o pedido', async () => {
    const { fetch, ui, controlador } = await comAnaSelecionada();

    const pedido = controlador.prepararConcessao({ acaoCodigo: 'MOVIMENTAR_ESTOQUE', acaoNome: 'Movimentar estoque' });
    assert.equal(controlador.pedidoValido(pedido), true);

    const trocando = controlador.selecionar({ id: BRUNO, nome: 'Bruno Lima' });
    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, { status: 'ok', autorizacoes: [], escopo: 'TOTAL' }));
    await trocando;

    assert.equal(controlador.pedidoValido(pedido), false);

    const antes = fetch.pendentes.length;
    const resultado = await controlador.confirmar(pedido);

    assert.equal(resultado.status, 'contexto-mudou');
    assert.equal(resultado.usuario, ANA);
    assert.equal(fetch.pendentes.length, antes, 'NADA foi enviado, nem para Ana nem para Bruno');
    assert.match(ultimo(ui.registro.avisos).texto, /pessoa selecionada mudou/i);
  });

  test('N. a confirmação aberta para Ana jamais executa sobre Bruno', async () => {
    const { fetch, controlador } = await comAnaSelecionada();

    const pedido = controlador.prepararConcessao({ acaoCodigo: 'MOVIMENTAR_ESTOQUE', acaoNome: 'Movimentar estoque' });
    const trocando = controlador.selecionar({ id: BRUNO, nome: 'Bruno Lima' });
    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, { status: 'ok', autorizacoes: [], escopo: 'TOTAL' }));
    await trocando;

    await controlador.confirmar(pedido);

    const posts = fetch.pendentes.filter((p) => p.opcoes.method === 'POST');
    assert.equal(posts.length, 0, 'nenhuma concessão foi emitida');
  });

  test('N. a revogação tem a mesma proteção', async () => {
    const { fetch, ui, controlador } = await comAnaSelecionada();

    const pedido = controlador.prepararRevogacao(100);
    const trocando = controlador.selecionar({ id: BRUNO, nome: 'Bruno Lima' });
    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, { status: 'ok', autorizacoes: [], escopo: 'TOTAL' }));
    await trocando;

    const antes = fetch.pendentes.length;
    assert.equal((await controlador.confirmar(pedido)).status, 'contexto-mudou');
    assert.equal(fetch.pendentes.length, antes, 'nenhum DELETE foi emitido');
    assert.match(ultimo(ui.registro.avisos).texto, /pessoa selecionada mudou/i);
  });

  test('O. recarregar invalida uma confirmação aberta', async () => {
    const { fetch, controlador } = await comAnaSelecionada();

    const pedido = controlador.prepararRevogacao(100);
    const recarregando = controlador.recarregar();
    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [autorizacao({ id: 100 })], escopo: 'TOTAL',
    }));
    await recarregando;

    // Recarregar NÃO troca a pessoa: o contexto continua o mesmo.
    assert.equal(controlador.pedidoValido(pedido), true);
  });

  test('digitar NÃO invalida a confirmação: a pessoa não mudou', async () => {
    const { relogio, controlador } = await comAnaSelecionada();

    const pedido = controlador.prepararConcessao({ acaoCodigo: 'X', acaoNome: 'X' });
    controlador.digitar('bru');
    relogio.avancar();

    assert.equal(controlador.pedidoValido(pedido), true);
  });

  test('F/G. revogar com sucesso informa as derivadas que caíram junto', async () => {
    const { fetch, ui, controlador } = await comAnaSelecionada();

    const executando = controlador.confirmar(controlador.prepararRevogacao(100));
    fetch.responder((p) => p.opcoes.method === 'DELETE', resposta(200, {
      status: 'ok', revogada: { id: 100 }, descendentesObservados: 2,
    }));
    await aguardarRequisicao(fetch, ehConsultaDeAutorizacoes);
    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, { status: 'ok', autorizacoes: [], escopo: 'TOTAL' }));

    assert.equal((await executando).status, 'ok');
    assert.match(ultimo(ui.registro.avisos).texto, /2 autorizações repassadas/);
  });

  test('H. sem derivadas, a mensagem não inventa cascata', async () => {
    const { fetch, ui, controlador } = await comAnaSelecionada();

    const executando = controlador.confirmar(controlador.prepararRevogacao(100));
    fetch.responder((p) => p.opcoes.method === 'DELETE', resposta(200, {
      status: 'ok', revogada: { id: 100 }, descendentesObservados: 0,
    }));
    await aguardarRequisicao(fetch, ehConsultaDeAutorizacoes);
    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, { status: 'ok', autorizacoes: [], escopo: 'TOTAL' }));

    await executando;

    assert.equal(ultimo(ui.registro.avisos).texto.includes('também'), false);
  });

  test('L. erro HTTP na operação vira mensagem e não recarrega a lista', async () => {
    const { fetch, ui, controlador } = await comAnaSelecionada();

    const executando = controlador.confirmar(controlador.prepararRevogacao(100));
    fetch.responder((p) => p.opcoes.method === 'DELETE', erro(403, 'REVOGACAO_NAO_AUTORIZADA', 'Sem autoridade'));

    assert.equal((await executando).status, 'erro');
    assert.match(ultimo(ui.registro.avisos).texto, /você mesmo concedeu/i);
    assert.equal(fetch.pendentesDe(ehConsultaDeAutorizacoes).length, 0, 'não recarregou após falhar');
  });

  test('confirmar sem pedido não faz nada', async () => {
    const { fetch, controlador } = await comAnaSelecionada();
    const antes = fetch.pendentes.length;

    assert.equal((await controlador.confirmar(null)).status, 'sem-pedido');
    assert.equal((await controlador.confirmar(undefined)).status, 'sem-pedido');
    assert.equal(fetch.pendentes.length, antes);
  });

  test('sem pessoa selecionada não se prepara pedido nenhum', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'MASTER' });

    assert.equal(cenario.controlador.prepararConcessao({ acaoCodigo: 'X', acaoNome: 'X' }), null);
    assert.equal(cenario.controlador.prepararDelegacao({ origemId: 1 }), null);
    assert.equal(cenario.controlador.prepararRevogacao(1), null);
  });
});

describe('J. sessão expirada', () => {
  test('401 na consulta devolve ao login e zera a seleção', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'MASTER' });

    const carga = cenario.controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));

    assert.equal((await carga).status, 'sessao');
    assert.equal(cenario.ui.registro.sessao.length, 1);
    assert.match(cenario.ui.registro.sessao[0], /sessão expirou/i);
    assert.equal(cenario.controlador.usuarioSelecionado(), null);
  });

  test('401 numa operação pendente devolve ao login', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'MASTER' });
    const carga = cenario.controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [autorizacao({ id: 100 })], escopo: 'TOTAL',
    }));
    await carga;

    const executando = cenario.controlador.confirmar(cenario.controlador.prepararRevogacao(100));
    cenario.fetch.responder((p) => p.opcoes.method === 'DELETE', erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));

    assert.equal((await executando).status, 'sessao');
    assert.equal(cenario.ui.registro.sessao.length, 1);
    assert.equal(cenario.controlador.usuarioSelecionado(), null);
  });

  test('encerrar com carga pendente: a resposta tardia não pinta nada', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'MASTER' });

    const carga = cenario.controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    cenario.controlador.encerrar();
    const depois = cenario.ui.registro.autorizacoes.length;

    cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [autorizacao()], escopo: 'TOTAL',
    }));

    assert.equal((await carga).status, 'obsoleta');
    assert.equal(cenario.ui.registro.autorizacoes.length, depois);
    assert.equal(cenario.controlador.usuarioSelecionado(), null);
    assert.equal(cenario.controlador.ehMaster(), false, 'a identidade foi descartada');
  });

  test('encerrar cancela a digitação agendada', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'MASTER' });

    const digitando = cenario.controlador.digitar('an');
    assert.equal(cenario.relogio.pendentes(), 1);

    cenario.controlador.encerrar();

    assert.equal(cenario.relogio.pendentes(), 0);
    assert.deepEqual(await digitando, { status: 'sessao' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Correção pós-auditoria da 3V — escritos ANTES da correção (RED)
// ─────────────────────────────────────────────────────────────────────

describe('DEFEITO A. pesquisa lateral × consulta de autorizações', () => {
  async function comMaster() {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'MASTER' });
    return cenario;
  }

  test('A1. pesquisar pessoas NÃO descarta a consulta legítima da pessoa selecionada', async () => {
    const { fetch, ui, controlador } = await comMaster();

    // 1. selecionar(Ana) — consulta fica pendente.
    const carga = controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    assert.equal(fetch.pendentesDe(ehConsultaDeAutorizacoes).length, 1);

    // 3. pesquisa lateral no meio.
    const pesquisa = controlador.buscarPessoas('bruno');

    // 4. resolve a consulta legítima de Ana.
    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [autorizacao()], escopo: 'TOTAL',
    }));
    const resultado = await carga;

    assert.equal(resultado.status, 'ok', 'a consulta de Ana é legítima e deve ser aplicada');
    assert.match(ultimo(ui.registro.autorizacoes), /Movimentar estoque/, 'a tela não pode ficar em "Carregando…"');

    fetch.responder(`${BASE}/usuarios`, resposta(200, { status: 'ok', usuarios: [], total: 0 }));
    await pesquisa;
  });

  test('A2. pesquisa lateral durante a recarga que segue uma escrita', async () => {
    const { fetch, ui, controlador } = await comMaster();
    const carga = controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [autorizacao({ id: 100 })], escopo: 'TOTAL',
    }));
    await carga;

    const executando = controlador.confirmar(controlador.prepararRevogacao(100));
    fetch.responder((p) => p.opcoes.method === 'DELETE', resposta(200, {
      status: 'ok', revogada: { id: 100 }, descendentesObservados: 0,
    }));
    await aguardarRequisicao(fetch, ehConsultaDeAutorizacoes);

    // Pesquisa lateral enquanto a recarga está em voo.
    const pesquisa = controlador.buscarPessoas('bruno');

    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, { status: 'ok', autorizacoes: [], escopo: 'TOTAL' }));
    const resultado = await executando;

    assert.equal(resultado.status, 'ok');
    assert.match(ultimo(ui.registro.autorizacoes), /não tem nenhuma autorização/i, 'a recarga foi aplicada');

    fetch.responder(`${BASE}/usuarios`, resposta(200, { status: 'ok', usuarios: [], total: 0 }));
    await pesquisa;
  });

  test('A3. simétrico: selecionar uma pessoa NÃO descarta a pesquisa lateral em voo', async () => {
    const { fetch, ui, controlador } = await comMaster();

    const pesquisa = controlador.buscarPessoas('bruno');
    const carga = controlador.selecionar({ id: ANA, nome: 'Ana Souza' });

    fetch.responder(`${BASE}/usuarios`, resposta(200, {
      status: 'ok', usuarios: [{ id: BRUNO, nome: 'Bruno Lima' }], total: 1,
    }));
    assert.equal((await pesquisa).status, 'ok', 'a pesquisa continua sendo o que a pessoa digitou');
    assert.equal(ultimo(ui.registro.pessoas).valor[0].nome, 'Bruno Lima');

    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, { status: 'ok', autorizacoes: [], escopo: 'TOTAL' }));
    await carga;
  });

  test('A4. a proteção DENTRO de cada fluxo continua: pessoa A atrasada não pinta B', async () => {
    const { fetch, ui, controlador } = await comMaster();

    const cargaA = controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    const cargaB = controlador.selecionar({ id: BRUNO, nome: 'Bruno Lima' });
    fetch.responder((p) => p.url.includes('usuarioId=11'), resposta(200, { status: 'ok', autorizacoes: [], escopo: 'TOTAL' }));
    await cargaB;
    const telaDeB = ultimo(ui.registro.autorizacoes);

    fetch.responder((p) => p.url.includes('usuarioId=9'), resposta(200, {
      status: 'ok', autorizacoes: [autorizacao()], escopo: 'TOTAL',
    }));
    assert.equal((await cargaA).status, 'obsoleta');
    assert.equal(ultimo(ui.registro.autorizacoes), telaDeB);
  });

  test('A5. e dentro da pesquisa: "an" atrasada não vence "ana"', async () => {
    const { fetch, ui, controlador } = await comMaster();

    const primeira = controlador.buscarPessoas('an');
    const segunda = controlador.buscarPessoas('ana');

    fetch.responder((p) => p.url.includes('busca=ana'), resposta(200, {
      status: 'ok', usuarios: [{ id: ANA, nome: 'Ana Souza' }], total: 1,
    }));
    assert.equal((await segunda).status, 'ok');
    const telaCorreta = ultimo(ui.registro.pessoas);

    fetch.responder((p) => p.url.includes('busca=an'), resposta(200, {
      status: 'ok', usuarios: [{ id: ANA, nome: 'Ana Souza' }, { id: BRUNO, nome: 'Bruno Lima' }], total: 2,
    }));
    assert.equal((await primeira).status, 'obsoleta');
    assert.equal(ultimo(ui.registro.pessoas), telaCorreta);
  });
});

describe('DEFEITO B. inicializações sobrepostas', () => {
  const ORIGEM_DE_A = autorizacao({ id: 70, usuarioId: 5, podeDelegar: true, acaoNome: 'Ação de A' });
  const ORIGEM_DE_B = autorizacao({ id: 80, usuarioId: 6, podeDelegar: true, acaoNome: 'Ação de B' });

  test('B1. as respostas atrasadas de A não substituem as origens de B', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const inicioA = controlador.iniciar({ id: 5, perfil: 'ADMINISTRADOR' });
    const inicioB = controlador.iniciar({ id: 6, perfil: 'ADMINISTRADOR' });

    // 3. resolve B primeiro.
    fetch.responder((p) => p.url.includes('usuarioId=6'), resposta(200, {
      status: 'ok', autorizacoes: [ORIGEM_DE_B], escopo: 'PROPRIAS',
    }));
    fetch.responderTodos('/catalogo/acoes', resposta(200, { status: 'ok', acoes: CATALOGO }));
    assert.equal((await inicioB).status, 'ok');
    assert.deepEqual(controlador.origensDelegaveis().map((o) => o.id), [80]);

    // 4. agora chegam as respostas antigas de A.
    fetch.responder((p) => p.url.includes('usuarioId=5'), resposta(200, {
      status: 'ok', autorizacoes: [ORIGEM_DE_A], escopo: 'PROPRIAS',
    }));
    const resultadoA = await inicioA;

    assert.equal(resultadoA.status, 'obsoleta', 'a inicialização de A ficou para trás');
    assert.deepEqual(controlador.origensDelegaveis().map((o) => o.id), [80], 'as origens continuam sendo as de B');
    assert.match(ultimo(ui.registro.origens).html, /Ação de B/);
    assert.equal(ultimo(ui.registro.origens).html.includes('Ação de A'), false);
  });

  test('B2. nenhuma saída visual de A é aplicada depois de B', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const inicioA = controlador.iniciar({ id: 1, perfil: 'MASTER' });
    const inicioB = controlador.iniciar({ id: 6, perfil: 'ADMINISTRADOR' });

    fetch.responder((p) => p.url.includes('usuarioId=6'), resposta(200, {
      status: 'ok', autorizacoes: [ORIGEM_DE_B], escopo: 'PROPRIAS',
    }));
    fetch.responderTodos('/catalogo/acoes', resposta(200, { status: 'ok', acoes: CATALOGO }));
    await inicioB;

    const podeConceder = ui.registro.podeConceder.length;
    const avisos = ui.registro.avisoDelegacao.length;
    const acoes = ui.registro.acoesConcediveis.length;
    const origens = ui.registro.origens.length;

    fetch.responder((p) => p.url.includes('usuarioId=1'), resposta(200, {
      status: 'ok', autorizacoes: [], escopo: 'PROPRIAS',
    }));
    await inicioA;

    assert.equal(ui.registro.podeConceder.length, podeConceder, 'MASTER de A não reabriu o cartão de conceder');
    assert.equal(ui.registro.avisoDelegacao.length, avisos);
    assert.equal(ui.registro.acoesConcediveis.length, acoes);
    assert.equal(ui.registro.origens.length, origens);
    assert.equal(controlador.ehMaster(), false, 'a identidade vigente é a de B');
  });

  test('B3. encerrar() durante uma inicialização pendente: nada é aplicado depois', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const inicio = controlador.iniciar({ id: 5, perfil: 'ADMINISTRADOR' });
    controlador.encerrar();
    const origens = ui.registro.origens.length;
    const podeConceder = ui.registro.podeConceder.length;

    fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [ORIGEM_DE_A], escopo: 'PROPRIAS',
    }));
    fetch.responderTodos('/catalogo/acoes', resposta(200, { status: 'ok', acoes: CATALOGO }));

    assert.equal((await inicio).status, 'obsoleta');
    assert.deepEqual(controlador.origensDelegaveis(), [], 'nada ressuscitou depois do logout');
    assert.equal(ui.registro.origens.length, origens);
    assert.equal(ui.registro.podeConceder.length, podeConceder);
    assert.equal(controlador.ehMaster(), false);
  });

  test('B4. um 401 atrasado da identidade A não derruba a sessão de B', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const inicioA = controlador.iniciar({ id: 5, perfil: 'ADMINISTRADOR' });
    const inicioB = controlador.iniciar({ id: 6, perfil: 'ADMINISTRADOR' });

    fetch.responder((p) => p.url.includes('usuarioId=6'), resposta(200, {
      status: 'ok', autorizacoes: [ORIGEM_DE_B], escopo: 'PROPRIAS',
    }));
    fetch.responderTodos('/catalogo/acoes', resposta(200, { status: 'ok', acoes: CATALOGO }));
    await inicioB;

    // A sessão de A foi encerrada no servidor; sua resposta atrasada é 401.
    fetch.responder((p) => p.url.includes('usuarioId=5'), erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));
    await inicioA;

    assert.equal(ui.registro.sessao.length, 0, 'B continua logado');
    assert.deepEqual(controlador.origensDelegaveis().map((o) => o.id), [80]);
  });
});

describe('ITEM 3. o botão Revogar só aparece para quem pode revogar', () => {
  test('MASTER vê Revogar em qualquer linha', () => {
    const html = render.linha(autorizacao({ autorizadoPor: MASTER }), { podeRevogar: true });

    assert.match(html, /data-acao="revogar"/);
  });

  test('não-MASTER que concedeu a linha vê Revogar', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'ADMINISTRADOR', id: ADMIN });
    const carga = cenario.controlador.selecionar({ id: ANA, nome: 'Ana Souza' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok', autorizacoes: [autorizacao({ id: 100, autorizadoPor: ADMIN, origemId: 70 })], escopo: 'CONCEDIDAS_POR_MIM',
    }));
    await carga;

    assert.match(ultimo(cenario.ui.registro.autorizacoes), /data-acao="revogar"/);
  });

  test('não-MASTER vendo uma autorização PRÓPRIA concedida por outro NÃO vê Revogar', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'ADMINISTRADOR', id: ADMIN });
    const carga = cenario.controlador.selecionar({ id: ADMIN, nome: 'Administrador' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok',
      autorizacoes: [autorizacao({ id: 100, usuarioId: ADMIN, autorizadoPor: MASTER, autorizadoPorNome: 'Master' })],
      escopo: 'PROPRIAS',
    }));
    await carga;

    const html = ultimo(cenario.ui.registro.autorizacoes);
    assert.equal(html.includes('data-acao="revogar"'), false, 'o backend recusaria com 403');
    assert.match(html, /Só quem concedeu pode revogar/i);
    assert.equal(cenario.controlador.prepararRevogacao(100), null, 'nem o pedido é montado');
  });

  test('a decisão é por linha: na mesma lista, uma com botão e outra sem', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'ADMINISTRADOR', id: ADMIN });
    const carga = cenario.controlador.selecionar({ id: ADMIN, nome: 'Administrador' });
    cenario.fetch.responder(ehConsultaDeAutorizacoes, resposta(200, {
      status: 'ok',
      autorizacoes: [
        autorizacao({ id: 100, usuarioId: ADMIN, autorizadoPor: MASTER }),
        autorizacao({ id: 101, usuarioId: ADMIN, autorizadoPor: ADMIN, acaoCodigo: 'OUTRA' }),
      ],
      escopo: 'PROPRIAS',
    }));
    await carga;

    const html = ultimo(cenario.ui.registro.autorizacoes);
    assert.equal((html.match(/data-acao="revogar"/g) || []).length, 1);
    assert.match(html, /data-autorizacao="101"[^>]*>Revogar/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Complemento de destinatários para delegação — escritos ANTES (RED)
// ─────────────────────────────────────────────────────────────────────

describe('DESTINATÁRIOS. o delegador não-MASTER pesquisa por uma consulta própria', () => {
  test('acoes.listarDestinatarios consulta GET /delegacao/destinatarios, com cookie e sem corpo', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', destinatarios: [], total: 0 }));
    EpiHttp.configurar({ fetch });

    await acoes.listarDestinatarios({ busca: '  ana ' });
    await acoes.listarDestinatarios({});

    assert.equal(fetch.chamadas[0].url, `${BASE}/delegacao/destinatarios?busca=ana`);
    assert.equal(fetch.chamadas[1].url, `${BASE}/delegacao/destinatarios`);
    for (const chamada of fetch.chamadas) {
      assert.equal(chamada.opcoes.method, 'GET');
      assert.equal(chamada.opcoes.credentials, 'include');
      assert.equal(chamada.opcoes.body, undefined);
    }
  });

  test('A. não-MASTER pesquisa pela consulta de destinatários, não pela rota administrativa da 3U', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, {
      perfil: 'ADMINISTRADOR', id: ADMIN,
      minhas: [autorizacao({ id: 70, usuarioId: ADMIN, podeDelegar: true })],
    });

    const pesquisa = cenario.controlador.buscarPessoas('bru');

    const pendentes = cenario.fetch.pendentesDe('/delegacao/destinatarios');
    assert.equal(pendentes.length, 1, 'a consulta certa para quem delega');
    assert.match(pendentes[0].url, /busca=bru/);
    assert.equal(cenario.fetch.pendentesDe(`${BASE}/usuarios`).length, 0, 'a rota da 3U não é chamada');

    cenario.fetch.responder('/delegacao/destinatarios', resposta(200, {
      status: 'ok', destinatarios: [{ id: BRUNO, nome: 'Bruno Lima', email: 'bruno@demo.safeworkengenharia.com.br' }], total: 1,
    }));
    const resultado = await pesquisa;

    assert.equal(resultado.status, 'ok');
    assert.equal(ultimo(cenario.ui.registro.pessoas).valor[0].nome, 'Bruno Lima');
  });

  test('o MASTER continua pesquisando pela rota da 3U', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, { perfil: 'MASTER' });

    cenario.controlador.buscarPessoas('bru');

    assert.equal(cenario.fetch.pendentesDe(`${BASE}/usuarios`).length, 1);
    assert.equal(cenario.fetch.pendentesDe('/delegacao/destinatarios').length, 0);
  });

  test('B. 403 da consulta de destinatários vira explicação, não erro genérico', () => {
    const texto = mensagens.deErro({ ok: false, status: 403, codigo: 'CONSULTA_DESTINATARIOS_NAO_AUTORIZADA' });

    assert.match(texto, /repass/i);
    assert.equal(/não foi possível concluir/i.test(texto), false);
  });

  test('I. a guarda da pesquisa continua valendo na consulta de destinatários', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, {
      perfil: 'ADMINISTRADOR', id: ADMIN,
      minhas: [autorizacao({ id: 70, usuarioId: ADMIN, podeDelegar: true })],
    });

    const primeira = cenario.controlador.buscarPessoas('an');
    const segunda = cenario.controlador.buscarPessoas('ana');

    cenario.fetch.responder((p) => p.url.includes('busca=ana'), resposta(200, {
      status: 'ok', destinatarios: [{ id: ANA, nome: 'Ana Souza', email: 'a@x' }], total: 1,
    }));
    assert.equal((await segunda).status, 'ok');
    const telaCorreta = ultimo(cenario.ui.registro.pessoas);

    cenario.fetch.responder((p) => p.url.includes('busca=an'), resposta(200, {
      status: 'ok', destinatarios: [{ id: ANA, nome: 'Ana Souza', email: 'a@x' }, { id: BRUNO, nome: 'Bruno Lima', email: 'b@x' }], total: 2,
    }));
    assert.equal((await primeira).status, 'obsoleta');
    assert.equal(ultimo(cenario.ui.registro.pessoas), telaCorreta);
  });

  test('J. 401 na consulta de destinatários devolve ao login', async () => {
    const cenario = montarCenario();
    await iniciar(cenario, {
      perfil: 'ADMINISTRADOR', id: ADMIN,
      minhas: [autorizacao({ id: 70, usuarioId: ADMIN, podeDelegar: true })],
    });

    const pesquisa = cenario.controlador.buscarPessoas('an');
    cenario.fetch.responder('/delegacao/destinatarios', erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));

    assert.equal((await pesquisa).status, 'sessao');
    assert.equal(cenario.ui.registro.sessao.length, 1);
  });
});
