'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const EpiGrupoUsuarios = require('../js/grupo-usuarios');

const { acoes, mensagens, render, indexarPor } = EpiGrupoUsuarios;

/**
 * Testes da tela de integrantes dos grupos (Bloco 8, Incremento 8, Etapa
 * 5A, Subetapa 3U), com `fetch` injetado — sem navegador e sem banco.
 *
 * O que se prova aqui:
 *   1. os três contratos da 3O são chamados exatamente como o backend os
 *      define — inclusive o DELETE sem grupo na URL;
 *   2. vincular quem já está em outro grupo é transferência, e a tela
 *      diz isso em palavras;
 *   3. cada desfecho do backend vira um texto que uma pessoa sem
 *      vocabulário de RBAC entende;
 *   4. todo HTML sai escapado;
 *   5. resposta fora de ordem não pinta o grupo errado — a guarda que a
 *      3T ensinou, aqui desde o primeiro dia.
 *
 * O caminho ponta a ponta contra o backend real está em
 * backend/test/integracao/frontend-grupo-usuarios.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const GRUPO_A = 7;
const GRUPO_B = 8;

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

const usuario = (extra = {}) => ({
  id: 10, nome: 'Ana Souza', email: 'ana@demo.safeworkengenharia.com.br',
  perfil: 'USUARIO', ativo: true, grupoAcessoId: null, ...extra,
});

beforeEach(() => {
  EpiHttp.configurar({ baseUrl: BASE, fetch: fetchFalso(resposta(200, { status: 'ok' })) });
});

// ─────────────────────────────────────────────────────────────────────
describe('ações — contratos reais da 3O e a consulta da 3U', () => {
  test('listarDoGrupo usa GET na rota da 3O, com cookie e sem corpo', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', usuarios: [] }));
    EpiHttp.configurar({ fetch });

    await acoes.listarDoGrupo(GRUPO_A);

    assert.equal(fetch.chamadas[0].url, `${BASE}/grupos-acesso/7/usuarios`);
    assert.equal(fetch.chamadas[0].opcoes.method, 'GET');
    assert.equal(fetch.chamadas[0].opcoes.credentials, 'include');
    assert.equal(fetch.chamadas[0].opcoes.body, undefined);
  });

  test('vincular usa PUT com grupo e usuário na URL, SEM corpo', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', vinculo: {}, alterado: true }));
    EpiHttp.configurar({ fetch });

    await acoes.vincular(GRUPO_A, 10);

    assert.equal(fetch.chamadas[0].url, `${BASE}/grupos-acesso/7/usuarios/10`);
    assert.equal(fetch.chamadas[0].opcoes.method, 'PUT');
    assert.equal(fetch.chamadas[0].opcoes.body, undefined, 'nenhum dado de negócio no corpo');
  });

  test('desvincular usa DELETE SEM grupo na URL — o contrato da 3O remove o vínculo atual', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', vinculo: {}, alterado: true }));
    EpiHttp.configurar({ fetch });

    await acoes.desvincular(10);

    assert.equal(fetch.chamadas[0].url, `${BASE}/usuarios/10/grupo-acesso`);
    assert.equal(fetch.chamadas[0].opcoes.method, 'DELETE');
    assert.equal(fetch.chamadas[0].url.includes('grupos-acesso/'), false, 'nenhum grupo na URL de desvincular');
    assert.equal(fetch.chamadas[0].opcoes.body, undefined);
  });

  test('listarDaEmpresa sem filtro não envia query nenhuma', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', usuarios: [], total: 0 }));
    EpiHttp.configurar({ fetch });

    await acoes.listarDaEmpresa();
    await acoes.listarDaEmpresa({});
    await acoes.listarDaEmpresa({ busca: '   ', vinculo: 'todos' });

    for (const chamada of fetch.chamadas) {
      assert.equal(chamada.url, `${BASE}/usuarios`);
    }
  });

  test('listarDaEmpresa envia busca, vínculo e paginação quando informados', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', usuarios: [], total: 0 }));
    EpiHttp.configurar({ fetch });

    await acoes.listarDaEmpresa({ busca: '  ana  ', vinculo: 'sem_grupo', pagina: 2, limite: 50 });

    assert.equal(fetch.chamadas[0].url, `${BASE}/usuarios?busca=ana&vinculo=sem_grupo&pagina=2&limite=50`);
  });

  test('vínculo inválido é descartado em vez de virar filtro desconhecido', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', usuarios: [], total: 0 }));
    EpiHttp.configurar({ fetch });

    await acoes.listarDaEmpresa({ vinculo: 'inventado' });

    assert.equal(fetch.chamadas[0].url, `${BASE}/usuarios`);
  });

  test('a busca é codificada na URL, sem quebrar a query', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', usuarios: [], total: 0 }));
    EpiHttp.configurar({ fetch });

    await acoes.listarDaEmpresa({ busca: 'a&b=c d' });

    assert.equal(fetch.chamadas[0].url, `${BASE}/usuarios?busca=a%26b%3Dc%20d`);
  });

  test('NÃO existe ação de excluir usuário nem de excluir grupo', () => {
    const nomes = Object.keys(acoes);

    assert.deepEqual(nomes.sort(), ['desvincular', 'listarDaEmpresa', 'listarDoGrupo', 'vincular']);
    for (const nome of nomes) {
      assert.equal(/excluir|remover.*usuario|apagar/i.test(nome), false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('mensagens — cada desfecho em português comum', () => {
  test('os 409 da 3L têm texto próprio e explicam o motivo', () => {
    assert.match(mensagens.deErro({ ok: false, status: 409, codigo: 'GRUPO_INATIVO' }), /inativo/i);
    assert.match(mensagens.deErro({ ok: false, status: 409, codigo: 'USUARIO_INATIVO' }), /inativa/i);
    assert.match(mensagens.deErro({ ok: false, status: 409, codigo: 'USUARIO_MASTER_SEM_GRUPO' }), /master/i);
    assert.match(mensagens.deErro({ ok: false, status: 409, codigo: 'AUTOVINCULO_NAO_PERMITIDO' }), /próprio grupo/i);
  });

  test('403 de vínculo e 403 de consulta têm textos distintos', () => {
    const vinculo = mensagens.deErro({ ok: false, status: 403, codigo: 'GRUPO_VINCULO_NAO_AUTORIZADA' });
    const consulta = mensagens.deErro({ ok: false, status: 403, codigo: 'USUARIO_CONSULTA_NAO_AUTORIZADA' });

    assert.match(vinculo, /não tem autorização/i);
    assert.match(consulta, /não tem autorização/i);
    assert.notEqual(vinculo, consulta);
  });

  test('404 de grupo e de usuário são distinguíveis', () => {
    assert.match(mensagens.deErro({ ok: false, status: 404, codigo: 'GRUPO_NAO_ENCONTRADO' }), /grupo/i);
    assert.match(mensagens.deErro({ ok: false, status: 404, codigo: 'USUARIO_NAO_ENCONTRADO' }), /pessoa/i);
  });

  test('401 pede novo login e é reconhecido por exigeNovoLogin', () => {
    const sessao = { ok: false, status: 401, codigo: 'SESSAO_INVALIDA' };

    assert.equal(mensagens.exigeNovoLogin(sessao), true);
    assert.match(mensagens.deErro(sessao), /sessão expirou/i);
    assert.equal(mensagens.exigeNovoLogin({ ok: false, status: 403, codigo: 'X' }), false);
    assert.equal(mensagens.exigeNovoLogin({ ok: true }), false);
  });

  test('falha de rede vira aviso de conexão', () => {
    assert.match(mensagens.deErro({ ok: false, status: 0, codigo: 'FALHA_DE_REDE' }), /conexão/i);
  });

  test('erro de validação usa o detalhe do campo; código desconhecido cai no genérico', () => {
    assert.equal(mensagens.deErro({
      ok: false, status: 400, codigo: 'VALIDACAO',
      detalhes: [{ campo: 'busca', codigo: 'BUSCA_INVALIDA', mensagem: 'Texto de busca inválido' }],
    }), 'Texto de busca inválido');
    assert.match(mensagens.deErro({ ok: false, status: 500 }), /não foi possível/i);
    assert.equal(mensagens.deErro({ ok: true }), '');
  });

  test('o sucesso do vínculo distingue incluir, transferir e "já estava"', () => {
    assert.match(mensagens.deVinculo('Ana', { grupoAnteriorId: null }, true), /agora faz parte/i);
    assert.match(mensagens.deVinculo('Ana', { grupoAnteriorId: 30 }, true), /transferid/i);
    assert.match(mensagens.deVinculo('Ana', { grupoAnteriorId: 7 }, false), /já estava/i);
  });

  test('o sucesso do desvínculo explica que volta a valer só o perfil', () => {
    assert.match(mensagens.deDesvinculo('Ana', true), /perfil/i);
    assert.match(mensagens.deDesvinculo('Ana', false), /já não estava/i);
  });

  test('a confirmação de retirada avisa que negar deixa de valer, e que ninguém é excluído', () => {
    const texto = mensagens.confirmacaoDeDesvinculo('Ana', 'Almoxarifado');

    assert.match(texto, /NEGAVA/);
    assert.match(texto, /liberado/i, 'o efeito contraintuitivo fica explícito');
    assert.match(texto, /não é excluída/i);
  });

  test('a confirmação de transferência explica que é um grupo por pessoa', () => {
    const texto = mensagens.confirmacaoDeTransferencia('Ana', 'Obra Norte', 'Almoxarifado');

    assert.match(texto, /Obra Norte/);
    assert.match(texto, /Almoxarifado/);
    assert.match(texto, /um grupo só/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('render — HTML escapado e estado do vínculo em palavras', () => {
  test('a identificação mostra nome em destaque e e-mail como desempate', () => {
    const html = render.identificacao(usuario());

    assert.match(html, /<strong>Ana Souza<\/strong>/);
    assert.match(html, /ana@demo\.safeworkengenharia\.com\.br/);
  });

  test('quem está no grupo só oferece retirar — nunca excluir', () => {
    const html = render.linhaVinculado(usuario({ grupoAcessoId: GRUPO_A }));

    assert.match(html, /data-acao="desvincular"/);
    assert.match(html, /Retirar do grupo/);
    assert.equal(/excluir|apagar|remover permanentemente/i.test(html), false);
  });

  test('sem grupo: botão de incluir, habilitado', () => {
    const html = render.linhaDisponivel(usuario({ grupoAcessoId: null }), GRUPO_A, {});

    assert.match(html, /Sem grupo/);
    assert.match(html, /Incluir no grupo/);
    assert.equal(html.includes('disabled'), false);
  });

  test('em outro grupo: o botão diz transferir e nomeia o grupo atual', () => {
    const html = render.linhaDisponivel(usuario({ grupoAcessoId: GRUPO_B }), GRUPO_A, { 8: 'Obra Norte' });

    assert.match(html, /Obra Norte/);
    assert.match(html, /Transferir para cá/);
    assert.equal(html.includes('disabled'), false);
  });

  test('já neste grupo: sinalizado e sem ação', () => {
    const html = render.linhaDisponivel(usuario({ grupoAcessoId: GRUPO_A }), GRUPO_A, {});

    assert.match(html, /Já está neste grupo/);
    assert.match(html, /disabled/);
  });

  test('MASTER e inativo aparecem desabilitados — cortesia, não barreira', () => {
    const master = render.linhaDisponivel(usuario({ perfil: 'MASTER' }), GRUPO_A, {});
    const inativo = render.linhaDisponivel(usuario({ ativo: false }), GRUPO_A, {});

    assert.match(master, /disabled/);
    assert.match(inativo, /disabled/);
  });

  test('o selo distingue ativo de inativo', () => {
    assert.match(render.selo(usuario({ ativo: true })), /badge-ok/);
    assert.match(render.selo(usuario({ ativo: false })), /badge-danger/);
  });

  test('o resumo da busca não deixa a página parecer a lista inteira', () => {
    assert.match(render.resumoDaBusca(0, 0), /nenhuma pessoa/i);
    assert.match(render.resumoDaBusca(1, 1), /1 pessoa/);
    assert.match(render.resumoDaBusca(20, 137), /20 de 137/);
    // Desde a correção pós-auditoria existem controles de página, então
    // o texto deixou de mandar "refinar a busca": dá para navegar.
    assert.equal(/refine/i.test(render.resumoDaBusca(20, 137)), false);
  });

  test('a linha de disponíveis leva o grupo atual como DADO, não como texto', () => {
    const semGrupo = render.linhaDisponivel(usuario({ grupoAcessoId: null }), GRUPO_A, {});
    const comGrupo = render.linhaDisponivel(usuario({ grupoAcessoId: GRUPO_B }), GRUPO_A, { 8: 'Obra Norte' });

    assert.match(semGrupo, /data-grupo-atual=""/);
    assert.match(comGrupo, /data-grupo-atual="8"/);
  });

  test('os controles de página mostram posição, total e limites', () => {
    const meio = render.paginacao({ pagina: 2, totalPaginas: 7, total: 137, temAnterior: true, temProxima: true });

    assert.match(meio, /Página 2 de 7/);
    assert.match(meio, /137 pessoas/);
    assert.match(meio, /data-acao="pagina-anterior"/);
    assert.match(meio, /data-acao="pagina-proxima"/);
    assert.equal(meio.includes('disabled'), false);
  });

  test('na primeira página, "Anterior" fica desabilitado; na última, "Próxima"', () => {
    const primeira = render.paginacao({ pagina: 1, totalPaginas: 3, total: 50, temAnterior: false, temProxima: true });
    const ultima = render.paginacao({ pagina: 3, totalPaginas: 3, total: 50, temAnterior: true, temProxima: false });

    assert.match(primeira, /data-acao="pagina-anterior" disabled/);
    assert.equal(primeira.includes('data-acao="pagina-proxima" disabled'), false);
    assert.match(ultima, /data-acao="pagina-proxima" disabled/);
    assert.equal(ultima.includes('data-acao="pagina-anterior" disabled'), false);
  });

  test('sem resultado nenhum, os controles de página somem', () => {
    assert.equal(render.paginacao({ pagina: 1, totalPaginas: 1, total: 0, temAnterior: false, temProxima: false }), '');
    assert.equal(render.paginacao(null), '');
  });

  test('o singular do total é respeitado', () => {
    assert.match(render.paginacao({ pagina: 1, totalPaginas: 1, total: 1, temAnterior: false, temProxima: false }), /1 pessoa\b/);
  });

  test('nome e e-mail maliciosos NÃO viram HTML executável', () => {
    const veneno = '<img src=x onerror="alert(1)">';
    const malicioso = usuario({ nome: veneno, email: veneno, perfil: veneno });

    assert.equal(render.linhaVinculado(malicioso).includes('<img'), false);
    assert.equal(render.linhaDisponivel(malicioso, GRUPO_A, { null: veneno }).includes('<img'), false);
    assert.equal(render.identificacao(malicioso).includes('<img'), false);
    assert.equal(render.falha(veneno).includes('<img'), false);
    assert.equal(render.vazia(veneno).includes('<img'), false);
  });

  test('o nome de outro grupo também é escapado', () => {
    const html = render.linhaDisponivel(usuario({ grupoAcessoId: GRUPO_B }), GRUPO_A, { 8: '<script>x</script>' });

    assert.equal(html.includes('<script>'), false);
  });

  test('escaparHtml trata null e undefined como texto vazio', () => {
    assert.equal(render.escaparHtml(null), '');
    assert.equal(render.escaparHtml(undefined), '');
  });

  test('VINCULOS é cópia nova a cada leitura', () => {
    EpiGrupoUsuarios.VINCULOS.push('inventado');

    assert.deepEqual(EpiGrupoUsuarios.VINCULOS, ['todos', 'sem_grupo', 'com_grupo']);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('indexarPor', () => {
  test('indexa pela chave informada e trata lista ausente', () => {
    assert.deepEqual(indexarPor([usuario()], 'id')[10].nome, 'Ana Souza');
    assert.deepEqual(indexarPor([], 'id'), {});
    assert.deepEqual(indexarPor(undefined, 'id'), {});
  });
});

// ─────────────────────────────────────────────────────────────────────
// Controlador: comportamento da tela, com respostas fora de ordem
// ─────────────────────────────────────────────────────────────────────

function fetchDeferido() {
  const pendentes = [];
  const fn = async (url, opcoes) => new Promise((resolve, reject) => {
    pendentes.push({ url, opcoes, resolve, reject, respondido: false });
  });
  fn.pendentes = pendentes;

  // O critério aceita função porque substring não basta aqui: a URL do
  // DELETE (`/usuarios/10/grupo-acesso`) CONTÉM a da listagem
  // (`/usuarios`), e responder "todas as /usuarios" acabaria resolvendo
  // a desvinculação com o corpo de uma listagem.
  const casa = (criterio) => (p) => (typeof criterio === 'function'
    ? criterio(p)
    : p.url.includes(criterio));

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

/** Só a LISTAGEM de usuários: `/usuarios` exato ou com query. */
const ehListagemDeUsuarios = (p) => p.url === `${BASE}/usuarios` || p.url.startsWith(`${BASE}/usuarios?`);

/**
 * Espera a requisição aparecer. Depois de resolver uma promessa, o
 * código que a aguardava só continua no microtask seguinte — responder
 * à recarga no mesmo bloco síncrono seria responder a algo que ainda
 * não foi pedido.
 */
async function aguardarRequisicao(fetch, criterio, tentativas = 50) {
  for (let i = 0; i < tentativas; i += 1) {
    if (fetch.pendentesDe(criterio).length > 0) return;
    await new Promise((resolver) => { setImmediate(resolver); });
  }
  assert.fail(`a requisição "${criterio}" nunca foi emitida`);
}

function uiFalso() {
  const registro = {
    vinculados: [], disponiveis: [], avisos: [], resumos: [], inativo: [], sessao: [], paginacao: [],
  };
  return {
    registro,
    renderVinculados(html) { registro.vinculados.push(html); },
    renderDisponiveis(html) { registro.disponiveis.push(html); },
    aviso(texto, tipo) { registro.avisos.push({ texto, tipo }); },
    resumo(texto) { registro.resumos.push(texto); },
    paginacao(html) { registro.paginacao.push(html); },
    grupoInativo(valor) { registro.inativo.push(valor); },
    sessaoExpirada(mensagem) { registro.sessao.push(mensagem); },
  };
}

/**
 * Relógio controlado pelo teste, no lugar de setTimeout. É o que torna
 * possível examinar a janela dos 300 ms de agrupamento sem esperá-la —
 * e, principalmente, agir DENTRO dela.
 */
function relogioFalso() {
  let proximoId = 1;
  const agendados = new Map();
  return {
    agendar(fn) { const id = proximoId; proximoId += 1; agendados.set(id, fn); return id; },
    cancelar(id) { agendados.delete(id); },
    pendentes() { return agendados.size; },
    /** Dispara tudo o que estiver agendado, como faria o tempo passando. */
    avancar() {
      const pendentes = [...agendados.entries()];
      agendados.clear();
      for (const [, fn] of pendentes) fn();
    },
  };
}

const ultimo = (lista) => lista[lista.length - 1];

const ANA = usuario({ id: 10, nome: 'Ana Souza', grupoAcessoId: GRUPO_A });
const BRUNO = usuario({ id: 11, nome: 'Bruno Lima', email: 'bruno@demo.safeworkengenharia.com.br', grupoAcessoId: GRUPO_B });

function montarCenario() {
  const fetch = fetchDeferido();
  EpiHttp.configurar({ baseUrl: BASE, fetch });
  const ui = uiFalso();
  const relogio = relogioFalso();
  const controlador = EpiGrupoUsuarios.criarControlador({
    ui,
    agendar: relogio.agendar,
    cancelar: relogio.cancelar,
  });
  return { fetch, ui, controlador, relogio };
}

/** Responde as duas requisições de uma carga de grupo. */
function responderCarga(fetch, grupoId, { doGrupo = [], daEmpresa = [], total = null } = {}) {
  fetch.responder(`/grupos-acesso/${grupoId}/usuarios`, resposta(200, { status: 'ok', usuarios: doGrupo }));
  // A listagem tem a MESMA URL nas duas cargas: respondo todas as
  // pendentes. A carga do outro grupo segue incompleta enquanto a dela
  // não for respondida.
  fetch.responderTodos(ehListagemDeUsuarios, resposta(200, {
    status: 'ok', usuarios: daEmpresa, total: total === null ? daEmpresa.length : total,
  }));
}

describe('controlador — carregamento e respostas fora de ordem', () => {
  test('A. carrega o grupo e mostra vinculados e disponíveis', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA, BRUNO], total: 2 });
    const resultado = await carga;

    assert.equal(resultado.status, 'ok');
    assert.equal(resultado.vinculados, 1);
    assert.match(ultimo(ui.registro.vinculados), /Ana Souza/);
    assert.match(ultimo(ui.registro.disponiveis), /Bruno Lima/);
    assert.match(ultimo(ui.registro.resumos), /2 pessoas/);
    assert.equal(controlador.estaVinculado(10), true);
    assert.equal(controlador.estaVinculado(11), false);
  });

  test('B. a resposta atrasada do Grupo A NÃO substitui a tela do Grupo B', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const cargaA = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });

    responderCarga(fetch, GRUPO_B, { doGrupo: [BRUNO], daEmpresa: [BRUNO] });
    assert.equal((await cargaB).status, 'ok');
    const telaDeB = ultimo(ui.registro.vinculados);

    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA] });
    const resultadoA = await cargaA;

    assert.equal(resultadoA.status, 'obsoleta');
    assert.equal(resultadoA.grupo, GRUPO_A);
    assert.equal(ultimo(ui.registro.vinculados), telaDeB, 'a tela não foi repintada pela resposta velha');
    assert.match(telaDeB, /Bruno Lima/);
    assert.equal(controlador.grupoAtual(), GRUPO_B);
  });

  test('o estado interno de vinculados também é o de B', async () => {
    const { fetch, controlador } = montarCenario();

    const cargaA = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });
    responderCarga(fetch, GRUPO_B, { doGrupo: [BRUNO], daEmpresa: [BRUNO] });
    await cargaB;
    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA] });
    await cargaA;

    assert.equal(controlador.estaVinculado(11), true, 'Bruno, de B');
    assert.equal(controlador.estaVinculado(10), false, 'Ana, de A, não entrou');
  });

  test('busca digitada fora de ordem: só o último resultado pinta a tela', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(fetch, GRUPO_A, { doGrupo: [], daEmpresa: [ANA, BRUNO], total: 2 });
    await carga;

    const primeira = controlador.buscar({ busca: 'an' });
    const segunda = controlador.buscar({ busca: 'ana' });

    // Cada busca dispara DUAS requisições (os do grupo e os da empresa),
    // e as do grupo têm a mesma URL nas duas — respondo ambas de uma vez.
    // O que decide a ordem é a consulta de usuários, que carrega o texto
    // buscado na URL e por isso é distinguível.
    fetch.responderTodos(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));

    // A segunda chega primeiro; a primeira, atrasada, chega depois.
    fetch.responder(`${BASE}/usuarios?busca=ana`, resposta(200, { status: 'ok', usuarios: [ANA], total: 1 }));
    assert.equal((await segunda).status, 'ok');
    const telaCorreta = ultimo(ui.registro.disponiveis);

    fetch.responder(`${BASE}/usuarios?busca=an`, resposta(200, { status: 'ok', usuarios: [ANA, BRUNO], total: 2 }));

    assert.equal((await primeira).status, 'obsoleta');
    assert.equal(ultimo(ui.registro.disponiveis), telaCorreta);
    assert.match(telaCorreta, /Ana Souza/);
    assert.equal(telaCorreta.includes('Bruno Lima'), false, 'o resultado de "an" não venceu');
    assert.equal(controlador.filtroAtual().busca, 'ana');
  });

  test('o filtro de vínculo viaja na consulta', async () => {
    const { fetch, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(fetch, GRUPO_A, { doGrupo: [], daEmpresa: [] });
    await carga;

    controlador.buscar({ busca: '', vinculo: 'sem_grupo' });

    assert.equal(fetch.pendentesDe('vinculo=sem_grupo').length, 1);
  });

  test('sem grupo selecionado, a tela pede a seleção e não consulta', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const resultado = await controlador.selecionar(null, {});

    assert.equal(resultado.status, 'sem-grupo');
    assert.equal(fetch.pendentes.length, 0);
    assert.match(ultimo(ui.registro.vinculados), /Selecione um grupo/i);
  });

  test('grupo sem ninguém mostra mensagem própria, não tabela vazia', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(fetch, GRUPO_A, { doGrupo: [], daEmpresa: [ANA], total: 1 });
    await carga;

    assert.match(ultimo(ui.registro.vinculados), /Ninguém está neste grupo ainda/i);
  });

  test('grupo inativo é sinalizado ao selecionar', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado', inativo: true });
    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [] });
    await carga;

    assert.equal(ui.registro.inativo.includes(true), true);
  });

  test('falha HTTP na carga vira mensagem, sem quebrar a tela', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, erro(403, 'GRUPO_VINCULO_NAO_AUTORIZADA', 'Sem autoridade'));
    fetch.responderTodos(ehListagemDeUsuarios, erro(403, 'USUARIO_CONSULTA_NAO_AUTORIZADA', 'Sem autoridade'));

    assert.equal((await carga).status, 'erro');
    assert.match(ultimo(ui.registro.vinculados), /não tem autorização/i);
  });

  test('falha de rede vira envelope, não exceção solta', async () => {
    EpiHttp.configurar({ baseUrl: BASE, fetch: fetchFalso(new TypeError('Failed to fetch')) });
    const controlador = EpiGrupoUsuarios.criarControlador({ ui: uiFalso() });

    const resultado = await controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });

    assert.equal(resultado.status, 'erro');
  });

  test('recarregar com carga pendente descarta a anterior', async () => {
    const { fetch, controlador } = montarCenario();

    const primeira = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    const segunda = controlador.recarregar();

    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA] });
    responderCarga(fetch, GRUPO_A, { doGrupo: [BRUNO], daEmpresa: [BRUNO] });

    assert.equal((await primeira).status, 'obsoleta');
    assert.equal((await segunda).status, 'ok');
    assert.equal(controlador.estaVinculado(11), true, 'venceu a carga mais recente');
  });
});

describe('controlador — gravação com troca de grupo no meio', () => {
  async function carregarGrupoA() {
    const cenario = montarCenario();
    const carga = cenario.controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(cenario.fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA, BRUNO], total: 2 });
    await carga;
    return cenario;
  }

  test('C. vincular usa o grupo de origem, não o selecionado depois', async () => {
    const { fetch, controlador } = await carregarGrupoA();

    const vinculando = controlador.vincular(11, 'Bruno Lima');
    const put = fetch.pendentesDe('/usuarios/11')[0];

    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });
    responderCarga(fetch, GRUPO_B, { doGrupo: [BRUNO], daEmpresa: [BRUNO] });
    await cargaB;

    assert.ok(put.url.includes(`/grupos-acesso/${GRUPO_A}/usuarios/11`), `o PUT saiu para ${put.url}`);
    assert.equal(put.opcoes.method, 'PUT');

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios/11`, resposta(200, {
      status: 'ok', vinculo: { usuarioId: 11, grupoAnteriorId: GRUPO_B, grupoAtualId: GRUPO_A }, alterado: true,
    }));

    const resultado = await vinculando;
    assert.equal(resultado.status, 'obsoleta');
    assert.equal(resultado.grupo, GRUPO_A);
  });

  test('D. a gravação de A não altera a tela nem o estado de B', async () => {
    const { fetch, ui, controlador } = await carregarGrupoA();

    const vinculando = controlador.vincular(11, 'Bruno Lima');
    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });
    responderCarga(fetch, GRUPO_B, { doGrupo: [BRUNO], daEmpresa: [BRUNO] });
    await cargaB;

    const telaDeB = ultimo(ui.registro.vinculados);
    const avisosAteAqui = ui.registro.avisos.length;

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios/11`, resposta(200, {
      status: 'ok', vinculo: { usuarioId: 11, grupoAnteriorId: null, grupoAtualId: GRUPO_A }, alterado: true,
    }));
    await vinculando;

    assert.equal(ultimo(ui.registro.vinculados), telaDeB, 'a tela de B não foi repintada');
    assert.equal(ui.registro.avisos.length, avisosAteAqui, 'nenhum "incluído" enganoso apareceu');
  });

  test('desvincular obsoleto que falhou avisa, nomeando o grupo de origem', async () => {
    const { fetch, ui, controlador } = await carregarGrupoA();

    const desvinculando = controlador.desvincular(10, 'Ana Souza');
    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });
    responderCarga(fetch, GRUPO_B, { doGrupo: [BRUNO], daEmpresa: [BRUNO] });
    await cargaB;

    fetch.responder('/usuarios/10/grupo-acesso', erro(403, 'GRUPO_VINCULO_NAO_AUTORIZADA', 'Sem autoridade'));
    await desvinculando;

    const recado = ultimo(ui.registro.avisos);
    assert.equal(recado.tipo, 'erro');
    assert.match(recado.texto, /Almoxarifado/, 'o recado diz a qual grupo o erro pertence');
  });

  test('sem troca de grupo, vincular funciona e recarrega a lista', async () => {
    const { fetch, ui, controlador } = await carregarGrupoA();

    const vinculando = controlador.vincular(11, 'Bruno Lima');
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios/11`, resposta(200, {
      status: 'ok', vinculo: { usuarioId: 11, grupoAnteriorId: GRUPO_B, grupoAtualId: GRUPO_A }, alterado: true,
    }));
    // A recarga que segue o sucesso só é emitida no microtask seguinte.
    await aguardarRequisicao(fetch, `/grupos-acesso/${GRUPO_A}/usuarios`);
    responderCarga(fetch, GRUPO_A, {
      doGrupo: [ANA, usuario({ id: 11, nome: 'Bruno Lima', grupoAcessoId: GRUPO_A })],
      daEmpresa: [ANA, usuario({ id: 11, nome: 'Bruno Lima', grupoAcessoId: GRUPO_A })],
      total: 2,
    });

    const resultado = await vinculando;
    assert.equal(resultado.status, 'ok');
    assert.match(ultimo(ui.registro.avisos).texto, /transferid/i);
    assert.equal(controlador.estaVinculado(11), true, 'a lista foi atualizada após a alteração');
  });

  test('desvincular com sucesso recarrega e avisa', async () => {
    const { fetch, ui, controlador } = await carregarGrupoA();

    const desvinculando = controlador.desvincular(10, 'Ana Souza');
    fetch.responder('/usuarios/10/grupo-acesso', resposta(200, {
      status: 'ok', vinculo: { usuarioId: 10, grupoAnteriorId: GRUPO_A, grupoAtualId: null }, alterado: true,
    }));
    await aguardarRequisicao(fetch, `/grupos-acesso/${GRUPO_A}/usuarios`);
    responderCarga(fetch, GRUPO_A, { doGrupo: [], daEmpresa: [usuario({ id: 10, grupoAcessoId: null })], total: 1 });

    assert.equal((await desvinculando).status, 'ok');
    assert.match(ultimo(ui.registro.avisos).texto, /perfil/i);
    assert.equal(controlador.estaVinculado(10), false, 'o vínculo sumiu da lista');
    assert.match(ultimo(ui.registro.vinculados), /Ninguém está neste grupo/i);
  });

  test('sem grupo selecionado, vincular e desvincular não disparam requisição', async () => {
    const { fetch, controlador } = montarCenario();

    assert.equal((await controlador.vincular(10, 'Ana')).status, 'sem-grupo');
    assert.equal((await controlador.desvincular(10, 'Ana')).status, 'sem-grupo');
    assert.equal(fetch.pendentes.length, 0);
  });
});

describe('controlador — encerramento de sessão com requisição pendente', () => {
  test('401 numa carga devolve ao login e zera o grupo', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));
    fetch.responderTodos(ehListagemDeUsuarios, erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));

    assert.equal((await carga).status, 'sessao');
    assert.equal(ui.registro.sessao.length, 1);
    assert.match(ui.registro.sessao[0], /sessão expirou/i);
    assert.equal(controlador.grupoAtual(), null);
  });

  test('401 vale mesmo numa resposta obsoleta: sessão não é por grupo', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const cargaA = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });
    responderCarga(fetch, GRUPO_B, { doGrupo: [BRUNO], daEmpresa: [BRUNO] });
    await cargaB;

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));
    fetch.responderTodos(ehListagemDeUsuarios, erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));

    assert.equal((await cargaA).status, 'sessao');
    assert.equal(ui.registro.sessao.length, 1, 'o login foi pedido, não engolido pela guarda');
  });

  test('401 numa gravação pendente devolve ao login', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA] });
    await carga;

    const desvinculando = controlador.desvincular(10, 'Ana Souza');
    fetch.responder('/usuarios/10/grupo-acesso', erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));

    assert.equal((await desvinculando).status, 'sessao');
    assert.equal(ui.registro.sessao.length, 1);
    assert.equal(controlador.grupoAtual(), null);
    assert.equal(controlador.estaVinculado(10), false, 'o estado foi descartado junto com a sessão');
  });

  test('encerrar() com carga pendente: a resposta tardia não pinta nada', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    controlador.encerrar();
    const depoisDoLogout = ui.registro.vinculados.length;

    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA] });

    assert.equal((await carga).status, 'obsoleta');
    assert.equal(ui.registro.vinculados.length, depoisDoLogout, 'nada foi renderizado após o logout');
    assert.equal(controlador.grupoAtual(), null);
  });

  test('encerrar() com gravação pendente: o estado não ressuscita', async () => {
    const { fetch, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA] });
    await carga;

    const vinculando = controlador.vincular(11, 'Bruno Lima');
    controlador.encerrar();

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios/11`, resposta(200, {
      status: 'ok', vinculo: { usuarioId: 11, grupoAnteriorId: null, grupoAtualId: GRUPO_A }, alterado: true,
    }));

    assert.equal((await vinculando).status, 'obsoleta');
    assert.equal(controlador.grupoAtual(), null);
    assert.equal(controlador.estaVinculado(11), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Correção pós-auditoria da 3U
// ─────────────────────────────────────────────────────────────────────

/** Muitas pessoas, para haver o que paginar. */
const pessoas = (quantas, deslocamento = 0) => Array.from({ length: quantas }, (_, i) => usuario({
  id: 100 + deslocamento + i,
  nome: `Pessoa ${String(deslocamento + i).padStart(3, '0')}`,
  email: `p${deslocamento + i}@demo.safeworkengenharia.com.br`,
  grupoAcessoId: null,
}));

/** Carga inicial do Grupo A com uma lista paginada de `total` pessoas. */
async function cenarioPaginado({ total = 50, porPagina = 20 } = {}) {
  const cenario = montarCenario();
  const carga = cenario.controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
  cenario.fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
  cenario.fetch.responder(ehListagemDeUsuarios, resposta(200, {
    status: 'ok', usuarios: pessoas(porPagina), total, pagina: 1, limite: porPagina,
  }));
  await carga;
  return cenario;
}

describe('A/B. paginação — navegação e limites', () => {
  test('a carga inicial fica na página 1 e informa o total', async () => {
    const { ui, controlador } = await cenarioPaginado({ total: 50 });

    assert.deepEqual(controlador.paginacao(), {
      pagina: 1, totalPaginas: 3, total: 50, limite: 20, temAnterior: false, temProxima: true,
    });
    assert.match(ultimo(ui.registro.paginacao), /Página 1 de 3/);
    assert.match(ultimo(ui.registro.paginacao), /50 pessoas/);
    assert.match(ultimo(ui.registro.paginacao), /data-acao="pagina-anterior" disabled/);
  });

  test('avançar pede a página seguinte ao mesmo endpoint', async () => {
    const { fetch, ui, controlador } = await cenarioPaginado({ total: 50 });

    const indo = controlador.proximaPagina();
    const pedido = fetch.pendentesDe(ehListagemDeUsuarios)[0];
    assert.match(pedido.url, /pagina=2/);
    assert.match(pedido.url, /^http:\/\/localhost:3000\/api\/usuarios\?/, 'mesmo endpoint, sem rota nova');

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, {
      status: 'ok', usuarios: pessoas(20, 20), total: 50, pagina: 2, limite: 20,
    }));

    assert.equal((await indo).status, 'ok');
    assert.equal(controlador.paginacao().pagina, 2);
    assert.match(ultimo(ui.registro.disponiveis), /Pessoa 020/);
    assert.equal(ultimo(ui.registro.disponiveis).includes('Pessoa 000'), false);
  });

  test('voltar pede a página anterior', async () => {
    const { fetch, controlador } = await cenarioPaginado({ total: 50 });

    const indo = controlador.proximaPagina();
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: pessoas(20, 20), total: 50, limite: 20 }));
    await indo;

    const voltando = controlador.paginaAnterior();
    assert.match(fetch.pendentesDe(ehListagemDeUsuarios)[0].url, /pagina=1/);
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: pessoas(20), total: 50, limite: 20 }));

    assert.equal((await voltando).status, 'ok');
    assert.equal(controlador.paginacao().pagina, 1);
  });

  test('B. na primeira página, voltar é recusado e não gera requisição', async () => {
    const { fetch, controlador } = await cenarioPaginado({ total: 50 });
    const antes = fetch.pendentes.length;

    const resultado = await controlador.paginaAnterior();

    assert.equal(resultado.status, 'fora-do-intervalo');
    assert.equal(controlador.paginacao().pagina, 1);
    assert.equal(fetch.pendentes.length, antes, 'nenhuma requisição foi emitida');
  });

  test('B. na última página, avançar é recusado e não gera requisição', async () => {
    const { fetch, controlador } = await cenarioPaginado({ total: 30, porPagina: 20 });

    const indo = controlador.proximaPagina();
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: pessoas(10, 20), total: 30, limite: 20 }));
    await indo;

    assert.equal(controlador.paginacao().pagina, 2);
    assert.equal(controlador.paginacao().temProxima, false);

    const antes = fetch.pendentes.length;
    const resultado = await controlador.proximaPagina();

    assert.equal(resultado.status, 'fora-do-intervalo');
    assert.equal(controlador.paginacao().pagina, 2);
    assert.equal(fetch.pendentes.length, antes);
  });

  test('irParaPagina recusa zero, negativo, fracionário e além da última', async () => {
    const { fetch, controlador } = await cenarioPaginado({ total: 50 });
    const antes = fetch.pendentes.length;

    for (const destino of [0, -1, 1.5, 4, 999, 'dois', null]) {
      const resultado = await controlador.irParaPagina(destino);
      assert.equal(resultado.status, 'fora-do-intervalo', `${destino} deveria ser recusado`);
    }

    assert.equal(controlador.paginacao().pagina, 1);
    assert.equal(fetch.pendentes.length, antes);
  });

  test('pedir a página em que já se está não refaz a consulta', async () => {
    const { fetch, controlador } = await cenarioPaginado({ total: 50 });
    const antes = fetch.pendentes.length;

    assert.equal((await controlador.irParaPagina(1)).status, 'sem-mudanca');
    assert.equal(fetch.pendentes.length, antes);
  });

  test('uma página só: nenhum dos dois botões fica habilitado', async () => {
    const { controlador } = await cenarioPaginado({ total: 5, porPagina: 20 });

    assert.deepEqual(controlador.paginacao(), {
      pagina: 1, totalPaginas: 1, total: 5, limite: 20, temAnterior: false, temProxima: false,
    });
  });

  test('lista vazia ainda é "página 1 de 1", nunca 1 de 0', async () => {
    const { controlador } = await cenarioPaginado({ total: 0, porPagina: 20 });

    assert.equal(controlador.paginacao().totalPaginas, 1);
    assert.equal(controlador.paginacao().pagina, 1);
  });
});

describe('C. filtro e seleção durante a paginação voltam à primeira página', () => {
  async function irParaPagina2() {
    const cenario = await cenarioPaginado({ total: 50 });
    const indo = cenario.controlador.proximaPagina();
    cenario.fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    cenario.fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: pessoas(20, 20), total: 50, limite: 20 }));
    await indo;
    assert.equal(cenario.controlador.paginacao().pagina, 2);
    return cenario;
  }

  test('buscar na página 2 volta para a página 1', async () => {
    const { fetch, controlador } = await irParaPagina2();

    const buscando = controlador.buscar({ busca: 'pessoa' });

    assert.equal(controlador.paginacao().pagina, 1);
    const pedido = fetch.pendentesDe(ehListagemDeUsuarios)[0];
    assert.match(pedido.url, /busca=pessoa/);
    assert.match(pedido.url, /pagina=1/);

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: pessoas(3), total: 3, limite: 20 }));
    await buscando;
  });

  test('trocar o filtro de situação na página 2 volta para a página 1', async () => {
    const { fetch, controlador } = await irParaPagina2();

    controlador.buscar({ busca: '', vinculo: 'sem_grupo' });

    assert.equal(controlador.paginacao().pagina, 1);
    assert.match(fetch.pendentesDe(ehListagemDeUsuarios)[0].url, /pagina=1/);
  });

  test('trocar de grupo na página 2 volta para a página 1', async () => {
    const { fetch, controlador } = await irParaPagina2();

    controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });

    assert.equal(controlador.paginacao().pagina, 1);
    assert.match(fetch.pendentesDe(ehListagemDeUsuarios)[0].url, /pagina=1/);
  });

  test('digitar na página 2 volta para a página 1 quando a busca dispara', async () => {
    const { fetch, relogio, controlador } = await irParaPagina2();

    const digitando = controlador.digitar({ busca: 'pes' });
    relogio.avancar();

    assert.equal(controlador.paginacao().pagina, 1);
    assert.match(fetch.pendentesDe(ehListagemDeUsuarios)[0].url, /pagina=1/);

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: pessoas(2), total: 2, limite: 20 }));
    await digitando;
  });
});

describe('D. resposta antiga de outra página não pinta a tela', () => {
  test('a resposta da página 1, atrasada, não substitui a página 2', async () => {
    const { fetch, ui, controlador } = await cenarioPaginado({ total: 50 });

    // Vai para a 2 sem responder; depois volta para a 1; depois responde
    // as duas na ordem errada.
    const indoPara2 = controlador.proximaPagina();
    const voltandoPara1 = controlador.paginaAnterior();

    // Responde primeiro a mais RECENTE (página 1).
    fetch.responderTodos(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(
      (p) => p.url.includes('pagina=1'),
      resposta(200, { status: 'ok', usuarios: pessoas(20), total: 50, limite: 20 }),
    );
    assert.equal((await voltandoPara1).status, 'ok');
    const telaCorreta = ultimo(ui.registro.disponiveis);

    // Agora a resposta atrasada da página 2.
    fetch.responder(
      (p) => p.url.includes('pagina=2'),
      resposta(200, { status: 'ok', usuarios: pessoas(20, 20), total: 50, limite: 20 }),
    );

    const resultado = await indoPara2;
    assert.equal(resultado.status, 'obsoleta');
    assert.equal(resultado.pagina, 2);
    assert.equal(ultimo(ui.registro.disponiveis), telaCorreta);
    assert.match(telaCorreta, /Pessoa 000/);
    assert.equal(telaCorreta.includes('Pessoa 020'), false);
    assert.equal(controlador.paginacao().pagina, 1);
  });
});

describe('E/F. confirmação amarrada ao contexto', () => {
  async function comDuasPessoas() {
    const cenario = montarCenario();
    const carga = cenario.controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    cenario.controlador.definirNomesDeGrupo([
      { id: GRUPO_A, nome: 'Almoxarifado' }, { id: GRUPO_B, nome: 'Obra Norte' },
    ]);
    responderCarga(cenario.fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA, BRUNO], total: 2 });
    await carga;
    return cenario;
  }

  test('o pedido congela usuário, grupo de destino, nome e contexto', async () => {
    const { controlador } = await comDuasPessoas();

    const pedido = controlador.prepararVinculo(11, 'Bruno Lima');

    assert.equal(pedido.tipo, 'vincular');
    assert.equal(pedido.usuarioId, 11);
    assert.equal(pedido.grupoId, GRUPO_A);
    assert.equal(pedido.nomeDoGrupo, 'Almoxarifado');
    assert.equal(typeof pedido.contexto, 'number');
    assert.equal(Object.isFrozen(pedido), true, 'um pedido alterável não provaria nada');
  });

  test('E. confirmada sem mudança de contexto, a transferência vai ao grupo certo', async () => {
    const { fetch, controlador } = await comDuasPessoas();

    const pedido = controlador.prepararVinculo(11, 'Bruno Lima');
    const executando = controlador.confirmar(pedido);

    const put = fetch.pendentesDe('/usuarios/11')[0];
    assert.ok(put.url.includes(`/grupos-acesso/${GRUPO_A}/usuarios/11`), `saiu para ${put.url}`);

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios/11`, resposta(200, {
      status: 'ok', vinculo: { usuarioId: 11, grupoAnteriorId: GRUPO_B, grupoAtualId: GRUPO_A }, alterado: true,
    }));
    await aguardarRequisicao(fetch, `/grupos-acesso/${GRUPO_A}/usuarios`);
    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA, BRUNO], daEmpresa: [ANA, BRUNO], total: 2 });

    const resultado = await executando;
    assert.equal(resultado.status, 'ok');
    assert.equal(resultado.grupo, GRUPO_A);
  });

  test('F. trocar de grupo com a confirmação aberta INVALIDA o pedido', async () => {
    const { fetch, ui, controlador } = await comDuasPessoas();

    const pedido = controlador.prepararVinculo(11, 'Bruno Lima');
    assert.equal(controlador.pedidoValido(pedido), true);

    // A pessoa troca de grupo antes de clicar em "Transferir".
    const trocando = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });
    responderCarga(fetch, GRUPO_B, { doGrupo: [], daEmpresa: [BRUNO], total: 1 });
    await trocando;

    assert.equal(controlador.pedidoValido(pedido), false);

    const pendentesAntes = fetch.pendentes.length;
    const resultado = await controlador.confirmar(pedido);

    assert.equal(resultado.status, 'contexto-mudou');
    assert.equal(resultado.grupo, GRUPO_A, 'o pedido ainda sabe de onde veio');
    assert.equal(fetch.pendentes.length, pendentesAntes, 'NADA foi enviado — nem para A nem para B');
    assert.match(ultimo(ui.registro.avisos).texto, /seleção mudou/i);
    assert.equal(ultimo(ui.registro.avisos).tipo, 'erro');
  });

  test('F. a confirmação aberta para o Grupo A jamais executa contra o Grupo B', async () => {
    const { fetch, controlador } = await comDuasPessoas();

    const pedido = controlador.prepararVinculo(11, 'Bruno Lima');
    const trocando = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });
    responderCarga(fetch, GRUPO_B, { doGrupo: [], daEmpresa: [BRUNO], total: 1 });
    await trocando;

    await controlador.confirmar(pedido);

    const paraB = fetch.pendentes.filter((p) => p.url.includes(`/grupos-acesso/${GRUPO_B}/usuarios/11`));
    const paraA = fetch.pendentes.filter((p) => p.url.includes(`/grupos-acesso/${GRUPO_A}/usuarios/11`));
    assert.equal(paraB.length, 0, 'não vazou para o grupo novo');
    assert.equal(paraA.length, 0, 'nem foi executado no antigo pelas costas');
  });

  test('G. a desvinculação tem a mesma proteção', async () => {
    const { fetch, ui, controlador } = await comDuasPessoas();

    const pedido = controlador.prepararDesvinculo(10, 'Ana Souza');
    assert.equal(pedido.tipo, 'desvincular');
    assert.equal(pedido.grupoId, GRUPO_A);

    const trocando = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });
    responderCarga(fetch, GRUPO_B, { doGrupo: [], daEmpresa: [BRUNO], total: 1 });
    await trocando;

    const pendentesAntes = fetch.pendentes.length;
    const resultado = await controlador.confirmar(pedido);

    assert.equal(resultado.status, 'contexto-mudou');
    assert.equal(fetch.pendentes.length, pendentesAntes, 'nenhum DELETE foi emitido');
    assert.match(ultimo(ui.registro.avisos).texto, /seleção mudou/i);
  });

  test('G. desvinculação confirmada sem troca de contexto funciona', async () => {
    const { fetch, controlador } = await comDuasPessoas();

    const pedido = controlador.prepararDesvinculo(10, 'Ana Souza');
    const executando = controlador.confirmar(pedido);

    assert.equal(fetch.pendentesDe('/usuarios/10/grupo-acesso').length, 1);
    fetch.responder('/usuarios/10/grupo-acesso', resposta(200, {
      status: 'ok', vinculo: { usuarioId: 10, grupoAnteriorId: GRUPO_A, grupoAtualId: null }, alterado: true,
    }));
    await aguardarRequisicao(fetch, `/grupos-acesso/${GRUPO_A}/usuarios`);
    responderCarga(fetch, GRUPO_A, { doGrupo: [], daEmpresa: [ANA, BRUNO], total: 2 });

    assert.equal((await executando).status, 'ok');
  });

  test('recarregar também invalida a confirmação aberta', async () => {
    const { fetch, controlador } = await comDuasPessoas();

    const pedido = controlador.prepararVinculo(11, 'Bruno Lima');
    const recarregando = controlador.recarregar();
    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA, BRUNO], total: 2 });
    await recarregando;

    assert.equal(controlador.pedidoValido(pedido), false);
    assert.equal((await controlador.confirmar(pedido)).status, 'contexto-mudou');
  });

  test('BUSCAR não invalida a confirmação: o grupo continua o mesmo', async () => {
    const { fetch, controlador } = await comDuasPessoas();

    const pedido = controlador.prepararVinculo(11, 'Bruno Lima');
    const buscando = controlador.buscar({ busca: 'bruno' });
    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [BRUNO], total: 1 });
    await buscando;

    assert.equal(controlador.pedidoValido(pedido), true, 'digitar não muda o grupo de destino');

    const executando = controlador.confirmar(pedido);
    assert.equal(fetch.pendentesDe(`/grupos-acesso/${GRUPO_A}/usuarios/11`).length, 1);
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios/11`, resposta(200, {
      status: 'ok', vinculo: { usuarioId: 11, grupoAnteriorId: null, grupoAtualId: GRUPO_A }, alterado: true,
    }));
    await aguardarRequisicao(fetch, `/grupos-acesso/${GRUPO_A}/usuarios`);
    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA, BRUNO], daEmpresa: [BRUNO], total: 1 });
    assert.equal((await executando).status, 'ok');
  });

  test('confirmar sem pedido, ou com pedido nulo, não faz nada', async () => {
    const { fetch, controlador } = await comDuasPessoas();
    const antes = fetch.pendentes.length;

    assert.equal((await controlador.confirmar(null)).status, 'sem-pedido');
    assert.equal((await controlador.confirmar(undefined)).status, 'sem-pedido');
    assert.equal(fetch.pendentes.length, antes);
  });

  test('sem grupo selecionado não se prepara pedido nenhum', () => {
    const { controlador } = montarCenario();

    assert.equal(controlador.prepararVinculo(10, 'Ana'), null);
    assert.equal(controlador.prepararDesvinculo(10, 'Ana'), null);
  });
});

describe('H. digitação: a guarda age na tecla, não depois do agrupamento', () => {
  async function comListaCarregada() {
    const cenario = montarCenario();
    const carga = cenario.controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(cenario.fetch, GRUPO_A, { doGrupo: [], daEmpresa: [ANA, BRUNO], total: 2 });
    await carga;
    return cenario;
  }

  test('o agrupamento continua existindo: várias teclas, uma consulta', async () => {
    const { fetch, relogio, controlador } = await comListaCarregada();
    const antes = fetch.pendentes.length;

    controlador.digitar({ busca: 'a' });
    controlador.digitar({ busca: 'an' });
    const ultima = controlador.digitar({ busca: 'ana' });

    assert.equal(fetch.pendentes.length, antes, 'nada saiu antes do tempo');
    assert.equal(relogio.pendentes(), 1, 'as teclas anteriores foram canceladas');

    relogio.avancar();

    const pedido = fetch.pendentesDe(ehListagemDeUsuarios)[0];
    assert.match(pedido.url, /busca=ana/);
    assert.equal(fetch.pendentesDe(ehListagemDeUsuarios).length, 1, 'uma consulta só');

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: [ANA], total: 1, limite: 20 }));
    await ultima;
  });

  test('teclas substituídas resolvem como "substituida", sem ficar penduradas', async () => {
    const { relogio, controlador } = await comListaCarregada();

    const primeira = controlador.digitar({ busca: 'a' });
    const segunda = controlador.digitar({ busca: 'an' });

    assert.equal((await primeira).status, 'substituida');
    assert.equal(relogio.pendentes(), 1, 'só a última tecla segue agendada');
    assert.equal(typeof segunda.then, 'function');
  });

  test('H. resposta em voo é descartada por uma tecla DENTRO da janela de agrupamento', async () => {
    const { fetch, ui, relogio, controlador } = await comListaCarregada();

    // Primeira busca: dispara de verdade.
    const primeira = controlador.digitar({ busca: 'an' });
    relogio.avancar();
    assert.equal(fetch.pendentesDe(ehListagemDeUsuarios).length, 1, 'a consulta de "an" está em voo');

    const telaAntes = ultimo(ui.registro.disponiveis);

    // A pessoa digita mais uma letra. O agendamento ainda NÃO disparou —
    // estamos dentro dos 300 ms. Era exatamente aqui que a versão
    // anterior aceitava a resposta velha.
    const segunda = controlador.digitar({ busca: 'ana' });
    assert.equal(relogio.pendentes(), 1, 'a nova consulta está só agendada');

    // Agora chega a resposta de "an", ainda dentro da janela.
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, {
      status: 'ok', usuarios: [ANA, BRUNO], total: 2, limite: 20,
    }));

    assert.equal((await primeira).status, 'obsoleta', 'a resposta velha foi recusada');
    assert.equal(ultimo(ui.registro.disponiveis), telaAntes, 'a lista não foi repintada');

    // E a busca nova segue normalmente.
    relogio.avancar();
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: [ANA], total: 1, limite: 20 }));

    assert.equal((await segunda).status, 'ok');
    assert.match(ultimo(ui.registro.disponiveis), /Ana Souza/);
    assert.equal(ultimo(ui.registro.disponiveis).includes('Bruno Lima'), false);
  });

  test('H. o mesmo vale para uma troca de grupo dentro da janela', async () => {
    const { fetch, ui, relogio, controlador } = await comListaCarregada();

    const buscando = controlador.digitar({ busca: 'an' });
    relogio.avancar();

    // Troca de grupo enquanto a busca está em voo.
    const trocando = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(
      (p) => p.url.includes('busca=an'),
      resposta(200, { status: 'ok', usuarios: [ANA, BRUNO], total: 2, limite: 20 }),
    );
    assert.equal((await buscando).status, 'obsoleta');

    responderCarga(fetch, GRUPO_B, { doGrupo: [BRUNO], daEmpresa: [BRUNO], total: 1 });
    await trocando;

    assert.match(ultimo(ui.registro.vinculados), /Bruno Lima/);
    assert.equal(controlador.grupoAtual(), GRUPO_B);
  });

  test('encerrar a sessão cancela a digitação agendada', async () => {
    const { relogio, controlador } = await comListaCarregada();

    const digitando = controlador.digitar({ busca: 'an' });
    assert.equal(relogio.pendentes(), 1);

    controlador.encerrar();

    assert.equal(relogio.pendentes(), 0, 'nada dispara depois do logout');
    assert.equal((await digitando).status, 'sessao');
  });

  test('trocar de grupo cancela a digitação agendada', async () => {
    const { fetch, relogio, controlador } = await comListaCarregada();

    const digitando = controlador.digitar({ busca: 'an' });
    const trocando = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });

    assert.equal(relogio.pendentes(), 0, 'a busca agendada foi descartada');
    assert.equal((await digitando).status, 'substituida');

    responderCarga(fetch, GRUPO_B, { doGrupo: [], daEmpresa: [], total: 0 });
    await trocando;
  });
});

describe('I. contratos da 3O preservados pela correção', () => {
  test('nenhum endpoint novo foi criado: as quatro ações continuam as mesmas', () => {
    assert.deepEqual(Object.keys(acoes).sort(), ['desvincular', 'listarDaEmpresa', 'listarDoGrupo', 'vincular']);
  });

  test('a paginação usa GET /usuarios, e não uma rota de página', async () => {
    const { fetch, controlador } = await cenarioPaginado({ total: 50 });

    controlador.proximaPagina();

    const pedido = fetch.pendentesDe(ehListagemDeUsuarios)[0];
    assert.match(pedido.url, /^http:\/\/localhost:3000\/api\/usuarios\?/);
    assert.equal(pedido.opcoes.method, 'GET');
    assert.equal(pedido.opcoes.credentials, 'include');
  });

  test('a transferência continua sendo PUT no contrato da 3O, sem corpo', async () => {
    const { fetch, controlador } = montarCenario();
    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(fetch, GRUPO_A, { doGrupo: [], daEmpresa: [BRUNO], total: 1 });
    await carga;

    controlador.confirmar(controlador.prepararVinculo(11, 'Bruno Lima'));

    const put = fetch.pendentesDe('/usuarios/11')[0];
    assert.equal(put.opcoes.method, 'PUT');
    assert.equal(put.opcoes.body, undefined);
    assert.equal(put.url, `${BASE}/grupos-acesso/${GRUPO_A}/usuarios/11`);
  });

  test('a desvinculação continua sem grupo na URL', async () => {
    const { fetch, controlador } = montarCenario();
    const carga = controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(fetch, GRUPO_A, { doGrupo: [ANA], daEmpresa: [ANA], total: 1 });
    await carga;

    controlador.confirmar(controlador.prepararDesvinculo(10, 'Ana Souza'));

    const del = fetch.pendentesDe('/usuarios/10/grupo-acesso')[0];
    assert.equal(del.opcoes.method, 'DELETE');
    assert.equal(del.url, `${BASE}/usuarios/10/grupo-acesso`);
    assert.equal(del.url.includes('grupos-acesso/'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Ajuste final pós-auditoria da 3U: digitação agendada × filtro imediato
//
// O defeito reproduzido pela auditoria não era uma resposta velha
// chegando atrasada — para isso a guarda de geração já servia. Era uma
// REQUISIÇÃO velha sendo emitida tarde: o temporizador da digitação
// sobrevivia a uma chamada direta a buscar() e, ao disparar, refazia a
// pesquisa com o filtro que a pessoa já havia abandonado.
// ─────────────────────────────────────────────────────────────────────

describe('ajuste final: buscar() cancela a digitação agendada', () => {
  async function comListaCarregada() {
    const cenario = montarCenario();
    const carga = cenario.controlador.selecionar(GRUPO_A, { nome: 'Almoxarifado' });
    responderCarga(cenario.fetch, GRUPO_A, { doGrupo: [], daEmpresa: [ANA, BRUNO], total: 2 });
    await carga;
    return cenario;
  }

  test('A–H. digitar "ana" e trocar o filtro antes dos 300 ms', async () => {
    // A. grupo já selecionado por comListaCarregada().
    const { fetch, relogio, controlador } = await comListaCarregada();

    // B. digita "ana" — fica agendado, nada sai ainda.
    const digitando = controlador.digitar({ busca: 'ana' });
    assert.equal(relogio.pendentes(), 1);
    assert.equal(fetch.pendentesDe(ehListagemDeUsuarios).length, 0);

    // C. antes dos 300 ms, troca o filtro de situação.
    const buscando = controlador.buscar({ busca: '', vinculo: 'sem_grupo' });

    // F (parte 1). o temporizador esquecido deixou de existir.
    assert.equal(relogio.pendentes(), 0, 'a digitação agendada foi cancelada');

    // H. a promessa da digitação substituída resolve, sem ficar pendurada.
    assert.deepEqual(await digitando, { status: 'substituida' });

    // D. a pesquisa executada é a do filtro NOVO.
    const pedidos = fetch.pendentesDe(ehListagemDeUsuarios);
    assert.equal(pedidos.length, 1, 'uma consulta só');
    assert.match(pedidos[0].url, /vinculo=sem_grupo/);
    assert.equal(pedidos[0].url.includes('busca=ana'), false, 'o termo abandonado não viajou');

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, {
      status: 'ok', usuarios: [BRUNO], total: 1, limite: 20,
    }));
    assert.equal((await buscando).status, 'ok');

    // E. o relógio passa dos 300 ms.
    const emitidasAntes = fetch.pendentes.length;
    relogio.avancar();

    // F (parte 2). nenhuma pesquisa antiga foi emitida depois.
    assert.equal(fetch.pendentes.length, emitidasAntes, 'nada disparou tarde');

    // G. o filtro vigente continua sendo o que a pessoa escolheu.
    assert.deepEqual(controlador.filtroAtual(), { busca: '', vinculo: 'sem_grupo' });
  });

  test('a lista exibida continua sendo a do filtro novo, mesmo depois do relógio', async () => {
    const { fetch, ui, relogio, controlador } = await comListaCarregada();

    const digitando = controlador.digitar({ busca: 'ana' });
    const buscando = controlador.buscar({ busca: '', vinculo: 'sem_grupo' });

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: [BRUNO], total: 1, limite: 20 }));
    await buscando;
    await digitando;

    const telaCorreta = ultimo(ui.registro.disponiveis);
    assert.match(telaCorreta, /Bruno Lima/);
    assert.equal(telaCorreta.includes('Ana Souza'), false);

    relogio.avancar();

    assert.equal(ultimo(ui.registro.disponiveis), telaCorreta, 'nada repintou depois');
  });

  test('CENÁRIO INVERSO: digitar depois de buscar continua vencendo', async () => {
    const { fetch, relogio, controlador } = await comListaCarregada();

    // Filtro aplicado primeiro...
    const buscando = controlador.buscar({ busca: '', vinculo: 'com_grupo' });
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: [ANA], total: 1, limite: 20 }));
    await buscando;

    // ...e a digitação vem depois: ela é que deve valer.
    const digitando = controlador.digitar({ busca: 'bruno', vinculo: 'com_grupo' });
    assert.equal(relogio.pendentes(), 1, 'buscar anterior não impede a digitação seguinte');

    relogio.avancar();

    const pedido = fetch.pendentesDe(ehListagemDeUsuarios)[0];
    assert.match(pedido.url, /busca=bruno/);
    assert.match(pedido.url, /vinculo=com_grupo/);

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: [BRUNO], total: 1, limite: 20 }));

    assert.equal((await digitando).status, 'ok');
    assert.deepEqual(controlador.filtroAtual(), { busca: 'bruno', vinculo: 'com_grupo' });
  });

  test('depois de cancelada por buscar(), uma nova digitação funciona normalmente', async () => {
    const { fetch, relogio, controlador } = await comListaCarregada();

    const descartada = controlador.digitar({ busca: 'ana' });
    const buscando = controlador.buscar({ busca: '', vinculo: 'sem_grupo' });
    assert.deepEqual(await descartada, { status: 'substituida' });

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: [BRUNO], total: 1, limite: 20 }));
    await buscando;

    const nova = controlador.digitar({ busca: 'bru', vinculo: 'sem_grupo' });
    assert.equal(relogio.pendentes(), 1);
    relogio.avancar();

    assert.match(fetch.pendentesDe(ehListagemDeUsuarios)[0].url, /busca=bru/);
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: [BRUNO], total: 1, limite: 20 }));

    assert.equal((await nova).status, 'ok');
  });

  test('a chamada do próprio temporizador não se autocancela nem recursiona', async () => {
    const { fetch, relogio, controlador } = await comListaCarregada();

    const digitando = controlador.digitar({ busca: 'ana' });
    relogio.avancar();   // o temporizador chama buscar() por dentro

    const pedidos = fetch.pendentesDe(ehListagemDeUsuarios);
    assert.equal(pedidos.length, 1, 'a busca agendada realmente aconteceu');
    assert.match(pedidos[0].url, /busca=ana/);

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: [ANA], total: 1, limite: 20 }));

    assert.equal((await digitando).status, 'ok', 'a promessa resolve com o resultado real, não "substituida"');
    assert.deepEqual(controlador.filtroAtual(), { busca: 'ana', vinculo: 'todos' });
  });

  test('paginar também continua cancelando a digitação agendada', async () => {
    const { fetch, relogio, controlador } = await cenarioPaginado({ total: 50 });

    const digitando = controlador.digitar({ busca: 'pes' });
    assert.equal(relogio.pendentes(), 1);

    const indo = controlador.proximaPagina();
    assert.equal(relogio.pendentes(), 0);
    assert.deepEqual(await digitando, { status: 'substituida' });
    assert.match(fetch.pendentesDe(ehListagemDeUsuarios)[0].url, /pagina=2/);
    assert.equal(fetch.pendentesDe(ehListagemDeUsuarios)[0].url.includes('busca=pes'), false);

    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: pessoas(20, 20), total: 50, limite: 20 }));
    await indo;

    relogio.avancar();
    assert.equal(controlador.paginacao().pagina, 2, 'nenhuma busca tardia voltou para a página 1');
  });

  test('as duas gerações continuam existindo e fazendo papéis distintos', async () => {
    const { fetch, controlador } = await comListaCarregada();

    // Um pedido de confirmação sobrevive a uma busca (contexto igual)...
    const pedido = controlador.prepararVinculo(11, 'Bruno Lima');
    const buscando = controlador.buscar({ busca: '', vinculo: 'sem_grupo' });
    fetch.responder(`/grupos-acesso/${GRUPO_A}/usuarios`, resposta(200, { status: 'ok', usuarios: [] }));
    fetch.responder(ehListagemDeUsuarios, resposta(200, { status: 'ok', usuarios: [BRUNO], total: 1, limite: 20 }));
    await buscando;

    assert.equal(controlador.pedidoValido(pedido), true, 'buscar não mexe na geração de contexto');

    // ...mas não a uma troca de grupo.
    const trocando = controlador.selecionar(GRUPO_B, { nome: 'Obra Norte' });
    responderCarga(fetch, GRUPO_B, { doGrupo: [], daEmpresa: [BRUNO], total: 1 });
    await trocando;

    assert.equal(controlador.pedidoValido(pedido), false);
  });
});
