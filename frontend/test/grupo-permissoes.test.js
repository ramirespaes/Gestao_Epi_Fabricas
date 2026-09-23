'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const EpiGrupoPermissoes = require('../js/grupo-permissoes');

const { acoes, mensagens, render, diferencaDeRecurso, temDiferenca, indexarPor } = EpiGrupoPermissoes;

/**
 * Testes da tela de permissões de grupo (Bloco 8, Incremento 8, Etapa
 * 5A, Subetapa 3T), com `fetch` injetado — sem navegador e sem banco.
 *
 * O que se prova aqui, em ordem de importância:
 *   1. TRUE, FALSE e NULL atravessam a camada inteira sem se
 *      converterem um no outro — especialmente FALSE, que nunca pode
 *      virar NULL;
 *   2. a gravação envia SOMENTE o que mudou, que é o que preserva as
 *      operações em que ninguém tocou;
 *   3. cada desfecho do backend vira um texto que uma pessoa sem
 *      vocabulário de RBAC entende;
 *   4. todo HTML sai escapado.
 *
 * O caminho ponta a ponta contra o backend real (login, cookie, 403 da
 * 3Q, 409 real de ação não-ALTERNATIVA) está em
 * backend/test/integracao/frontend-grupo-permissoes.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const GRUPO = 7;
const RECURSO = 'materials';
const ACAO = 'MOVIMENTAR_ESTOQUE';

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

beforeEach(() => {
  EpiHttp.configurar({ baseUrl: BASE, fetch: fetchFalso(resposta(200, { status: 'ok' })) });
});

// ─────────────────────────────────────────────────────────────────────
describe('ações — contratos reais da 3N e o catálogo da 3T', () => {
  test('as duas consultas e o catálogo usam GET, com cookie de sessão', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', recursos: [], acoes: [] }));
    EpiHttp.configurar({ fetch });

    await acoes.listarRecursos(GRUPO);
    await acoes.listarAcoes(GRUPO);
    await acoes.catalogoDeAcoes();

    assert.equal(fetch.chamadas[0].url, `${BASE}/grupos-acesso/7/permissoes/recursos`);
    assert.equal(fetch.chamadas[1].url, `${BASE}/grupos-acesso/7/permissoes/acoes`);
    assert.equal(fetch.chamadas[2].url, `${BASE}/catalogo/acoes`);
    for (const chamada of fetch.chamadas) {
      assert.equal(chamada.opcoes.method, 'GET');
      assert.equal(chamada.opcoes.credentials, 'include');
      assert.equal(chamada.opcoes.body, undefined);
    }
  });

  test('configurarRecurso envia PATCH só com as operações informadas', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', configuracao: {}, alterado: true }));
    EpiHttp.configurar({ fetch });

    await acoes.configurarRecurso(GRUPO, RECURSO, { podeCriar: true });

    const chamada = fetch.chamadas[0];
    assert.equal(chamada.url, `${BASE}/grupos-acesso/7/permissoes/recursos/materials`);
    assert.equal(chamada.opcoes.method, 'PATCH');
    assert.deepEqual(corpoDe(chamada), { podeCriar: true });
  });

  test('configurarRecurso preserva false e null no corpo, sem confundi-los', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', configuracao: {}, alterado: true }));
    EpiHttp.configurar({ fetch });

    await acoes.configurarRecurso(GRUPO, RECURSO, { podeVisualizar: false, podeExcluir: null });

    assert.deepEqual(corpoDe(fetch.chamadas[0]), { podeVisualizar: false, podeExcluir: null });
  });

  test('configurarRecurso descarta qualquer chave fora das quatro operações', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', configuracao: {}, alterado: true }));
    EpiHttp.configurar({ fetch });

    await acoes.configurarRecurso(GRUPO, RECURSO, {
      podeCriar: true, empresaId: 999, grupoAcessoId: 1, atorId: 1, isMaster: true,
    });

    assert.deepEqual(corpoDe(fetch.chamadas[0]), { podeCriar: true });
  });

  test('configurarAcao envia permitido, obrigatório, nos três estados', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', configuracao: {}, alterado: true }));
    EpiHttp.configurar({ fetch });

    await acoes.configurarAcao(GRUPO, ACAO, true);
    await acoes.configurarAcao(GRUPO, ACAO, false);
    await acoes.configurarAcao(GRUPO, ACAO, null);

    assert.equal(fetch.chamadas[0].url, `${BASE}/grupos-acesso/7/permissoes/acoes/MOVIMENTAR_ESTOQUE`);
    assert.equal(fetch.chamadas[0].opcoes.method, 'PATCH');
    assert.deepEqual(corpoDe(fetch.chamadas[0]), { permitido: true });
    assert.deepEqual(corpoDe(fetch.chamadas[1]), { permitido: false });
    assert.deepEqual(corpoDe(fetch.chamadas[2]), { permitido: null });
  });

  test('identificadores com caractere especial são codificados na URL', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', configuracao: {}, alterado: true }));
    EpiHttp.configurar({ fetch });

    await acoes.configurarRecurso(GRUPO, 'a/b?c', { podeCriar: true });

    assert.equal(fetch.chamadas[0].url, `${BASE}/grupos-acesso/7/permissoes/recursos/a%2Fb%3Fc`);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('diferença — só o que mudou vai para o servidor', () => {
  const atual = { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: false };

  test('nenhuma mudança devolve objeto vazio', () => {
    assert.deepEqual(diferencaDeRecurso(atual, { ...atual }), {});
    assert.equal(temDiferenca(diferencaDeRecurso(atual, { ...atual })), false);
  });

  test('mudar uma operação não arrasta as outras três', () => {
    const diferenca = diferencaDeRecurso(atual, { ...atual, podeCriar: true });

    assert.deepEqual(diferenca, { podeCriar: true });
    assert.deepEqual(Object.keys(diferenca), ['podeCriar']);
  });

  test('false que continua false não entra no corpo — e não vira null', () => {
    const diferenca = diferencaDeRecurso(atual, { ...atual, podeVisualizar: null });

    assert.deepEqual(diferenca, { podeVisualizar: null });
    assert.equal('podeCriar' in diferenca, false);
    assert.equal('podeExcluir' in diferenca, false);
  });

  test('false → null e null → false são mudanças distintas, ambas detectadas', () => {
    assert.deepEqual(diferencaDeRecurso({ podeCriar: false }, { podeCriar: null }), { podeCriar: null });
    assert.deepEqual(diferencaDeRecurso({ podeCriar: null }, { podeCriar: false }), { podeCriar: false });
  });

  test('true → false é detectado (negar não é o mesmo que deixar de permitir)', () => {
    assert.deepEqual(diferencaDeRecurso({ podeVisualizar: true }, { podeVisualizar: false }), { podeVisualizar: false });
  });

  test('sem configuração anterior, o estado de referência é null em todas as operações', () => {
    assert.deepEqual(diferencaDeRecurso(null, { podeCriar: null, podeEditar: true }), { podeEditar: true });
  });

  test('operação não editada na tela nunca entra na diferença', () => {
    assert.deepEqual(diferencaDeRecurso(atual, { podeCriar: true }), { podeCriar: true });
  });

  test('a diferença é o que o corpo da requisição acaba contendo', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', configuracao: {}, alterado: true }));
    EpiHttp.configurar({ fetch });

    const diferenca = diferencaDeRecurso(atual, { ...atual, podeEditar: false });
    await acoes.configurarRecurso(GRUPO, RECURSO, diferenca);

    assert.deepEqual(corpoDe(fetch.chamadas[0]), { podeEditar: false });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('mensagens — cada desfecho em português comum', () => {
  test('403 de permissões explica que falta autorização, sem jargão', () => {
    const texto = mensagens.deErro({ ok: false, status: 403, codigo: 'GRUPO_PERMISSAO_NAO_AUTORIZADA' });

    assert.match(texto, /não tem autorização/i);
  });

  test('403 do catálogo tem texto próprio', () => {
    assert.match(mensagens.deErro({ ok: false, status: 403, codigo: 'CATALOGO_NAO_AUTORIZADO' }), /catálogo/i);
  });

  test('409 explica por que permitir/negar não vale para aquela ação', () => {
    const texto = mensagens.deErro({ ok: false, status: 409, codigo: 'GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA' });

    assert.match(texto, /herdar/i);
    assert.match(texto, /alternativa/i);
  });

  test('404 de grupo, 400 sem alteração e ação inválida têm textos próprios', () => {
    assert.match(mensagens.deErro({ ok: false, status: 404, codigo: 'GRUPO_NAO_ENCONTRADO' }), /não existe/i);
    assert.match(mensagens.deErro({ ok: false, status: 400, codigo: 'GRUPO_PERMISSAO_SEM_ALTERACAO' }), /nada foi alterado/i);
    assert.match(mensagens.deErro({ ok: false, status: 400, codigo: 'GRUPO_PERMISSAO_ACAO_INVALIDA' }), /catálogo|desativada/i);
  });

  test('401 pede novo login e é reconhecido por exigeNovoLogin', () => {
    const sessao = { ok: false, status: 401, codigo: 'SESSAO_INVALIDA' };

    assert.equal(mensagens.exigeNovoLogin(sessao), true);
    assert.match(mensagens.deErro(sessao), /sessão expirou/i);
    assert.equal(mensagens.exigeNovoLogin({ ok: false, status: 403, codigo: 'X' }), false);
    assert.equal(mensagens.exigeNovoLogin({ ok: true }), false);
  });

  test('falha de rede vira aviso de conexão, não erro do servidor', () => {
    assert.match(mensagens.deErro({ ok: false, status: 0, codigo: 'FALHA_DE_REDE' }), /conexão/i);
  });

  test('erro de validação usa o detalhe do campo quando o código é desconhecido', () => {
    const texto = mensagens.deErro({
      ok: false, status: 400, codigo: 'VALIDACAO',
      detalhes: [{ campo: 'permitido', codigo: 'CAMPO_OBRIGATORIO', mensagem: 'Informe permitido' }],
    });

    assert.equal(texto, 'Informe permitido');
  });

  test('código desconhecido cai na mensagem do servidor, e depois num texto genérico', () => {
    assert.equal(mensagens.deErro({ ok: false, status: 500, codigo: 'X', mensagem: 'Falha interna' }), 'Falha interna');
    assert.match(mensagens.deErro({ ok: false, status: 500 }), /não foi possível/i);
  });

  test('resposta ok não produz mensagem de erro', () => {
    assert.equal(mensagens.deErro({ ok: true }), '');
    assert.equal(mensagens.deErro(null), '');
  });

  test('explicacaoDoEstado distingue os três estados, sem chamar FALSE de "sem permissão"', () => {
    assert.match(mensagens.explicacaoDoEstado(true), /permite/i);
    assert.match(mensagens.explicacaoDoEstado(false), /nega/i);
    assert.match(mensagens.explicacaoDoEstado(null), /perfil/i);
    assert.notEqual(mensagens.explicacaoDoEstado(false), mensagens.explicacaoDoEstado(null));
  });

  test('sucesso distingue "salvou" de "não havia o que salvar"', () => {
    assert.match(mensagens.deSucesso('materials', true), /salvas/i);
    assert.match(mensagens.deSucesso('materials', false), /nada mudou/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('render — tri-state na tela e HTML escapado', () => {
  test('paraTexto e paraValor são inversos e nunca confundem false com null', () => {
    assert.equal(render.paraTexto(true), 'true');
    assert.equal(render.paraTexto(false), 'false');
    assert.equal(render.paraTexto(null), 'null');
    assert.equal(render.paraValor('true'), true);
    assert.equal(render.paraValor('false'), false);
    assert.equal(render.paraValor('null'), null);
    for (const valor of [true, false, null]) {
      assert.equal(render.paraValor(render.paraTexto(valor)), valor);
    }
  });

  test('o seletor tem exatamente três opções, com rótulos para quem não sabe RBAC', () => {
    const html = render.seletor('podeCriar', null, false);

    assert.equal((html.match(/<option/g) || []).length, 3);
    assert.match(html, /Permitir/);
    assert.match(html, /Negar/);
    assert.match(html, /Herdar do perfil/);
  });

  test('o seletor marca como selecionada a opção do valor atual, inclusive false', () => {
    assert.match(render.seletor('podeCriar', false, false), /value="false" selected/);
    assert.match(render.seletor('podeCriar', true, false), /value="true" selected/);
    assert.match(render.seletor('podeCriar', null, false), /value="null" selected/);
  });

  test('linha de recurso traz as quatro operações independentes', () => {
    const html = render.linhaRecurso({ id: 'materials', nome: 'Materiais' }, {
      podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: false,
    });

    for (const operacao of EpiGrupoPermissoes.OPERACOES) {
      assert.match(html, new RegExp(`data-campo="${operacao}"`));
    }
    assert.equal((html.match(/<select/g) || []).length, 4);
  });

  test('recurso sem configuração nenhuma nasce herdando nas quatro operações', () => {
    const html = render.linhaRecurso({ id: 'materials', nome: 'Materiais' }, null);

    assert.equal((html.match(/value="null" selected/g) || []).length, 4);
    assert.equal(html.includes('value="true" selected'), false);
    assert.equal(html.includes('value="false" selected'), false);
  });

  test('ação ALTERNATIVA é configurável; NENHUMA e OBRIGATORIA só herdam', () => {
    const alternativa = render.linhaAcao(
      { codigo: 'MOVIMENTAR_ESTOQUE', nome: 'Movimentar', ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' },
      null,
    );
    const obrigatoria = render.linhaAcao(
      { codigo: 'ADMINISTRAR_GRUPOS_ACESSO', nome: 'Administrar', ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'OBRIGATORIA' },
      null,
    );

    assert.equal(alternativa.includes('disabled'), false);
    assert.match(obrigatoria, /disabled/);
    assert.match(obrigatoria, /só pode herdar do perfil/i);
  });

  test('ação desativada no catálogo é sinalizada e não é configurável', () => {
    const html = render.linhaAcao(
      { codigo: 'X', nome: 'X', ativo: false, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' },
      null,
    );

    assert.match(html, /desativada/i);
    assert.match(html, /disabled/);
  });

  test('exigeSst aparece como observação, sem virar permissão', () => {
    const html = render.linhaAcao(
      { codigo: 'X', nome: 'X', ativo: true, exigeSst: true, modoAutorizacaoIndividual: 'ALTERNATIVA' },
      null,
    );

    assert.match(html, /SST/);
    assert.equal(html.includes('data-campo="permitido" disabled'), false);
  });

  test('a configuração existente da ação chega marcada no seletor, inclusive false', () => {
    const html = render.linhaAcao(
      { codigo: 'X', nome: 'X', ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' },
      { permitido: false },
    );

    assert.match(html, /value="false" selected/);
  });

  test('a tabela de recursos cobre todos os recursos, configurados ou não', () => {
    const recursos = EpiGrupoPermissoes.RECURSOS;
    const html = render.tabelaRecursos(recursos, { materials: { podeCriar: true } });

    for (const recurso of recursos) {
      assert.match(html, new RegExp(`data-recurso="${recurso.id}"`));
    }
  });

  test('HTML de nome, código e mensagem sai escapado', () => {
    const veneno = '<img src=x onerror="alert(1)">';

    assert.equal(render.escaparHtml(veneno).includes('<img'), false);
    assert.equal(render.linhaRecurso({ id: veneno, nome: veneno }, null).includes('<img'), false);
    assert.equal(render.linhaAcao(
      { codigo: veneno, nome: veneno, ativo: true, exigeSst: false, modoAutorizacaoIndividual: veneno }, null,
    ).includes('<img'), false);
    assert.equal(render.falha(veneno).includes('<img'), false);
  });

  test('escaparHtml trata null e undefined como texto vazio', () => {
    assert.equal(render.escaparHtml(null), '');
    assert.equal(render.escaparHtml(undefined), '');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('catálogo de recursos — fonte real, não lista inventada', () => {
  test('são os 21 identificadores de página que a navegação legada reconhece', () => {
    const ids = EpiGrupoPermissoes.RECURSOS.map((r) => r.id);

    assert.equal(ids.length, 21);
    assert.deepEqual([...new Set(ids)].length, 21);
    for (const esperado of ['dashboard', 'materials', 'userAdmin', 'config', 'lgpd']) {
      assert.ok(ids.includes(esperado), `faltou ${esperado}`);
    }
  });

  test('não inclui self-service: o totem está fora de allPages', () => {
    assert.equal(EpiGrupoPermissoes.RECURSOS.some((r) => r.id === 'self-service'), false);
  });

  test('cada recurso tem rótulo legível, diferente do identificador técnico', () => {
    for (const recurso of EpiGrupoPermissoes.RECURSOS) {
      assert.equal(typeof recurso.nome, 'string');
      assert.ok(recurso.nome.length > 0);
    }
  });

  test('a lista é uma cópia nova a cada leitura: mutar uma não contamina a próxima', () => {
    const primeira = EpiGrupoPermissoes.RECURSOS;
    primeira.push({ id: 'intruso', nome: 'Intruso' });
    primeira[0].id = 'adulterado';

    const segunda = EpiGrupoPermissoes.RECURSOS;
    assert.equal(segunda.length, 21);
    assert.equal(segunda.some((r) => r.id === 'intruso'), false);
    assert.equal(segunda.some((r) => r.id === 'adulterado'), false);
  });

  test('OPERACOES também é cópia, e são exatamente as quatro da 3N', () => {
    EpiGrupoPermissoes.OPERACOES.push('podeTudo');
    render.OPERACOES.push('podeTudo');
    render.ROTULOS_OPERACAO.podeTudo = 'Tudo';

    assert.deepEqual(EpiGrupoPermissoes.OPERACOES, ['podeVisualizar', 'podeCriar', 'podeEditar', 'podeExcluir']);
    assert.deepEqual(render.OPERACOES, ['podeVisualizar', 'podeCriar', 'podeEditar', 'podeExcluir']);
    assert.equal('podeTudo' in render.ROTULOS_OPERACAO, false);
  });

  test('a mutação de uma leitura não altera o HTML gerado depois', () => {
    EpiGrupoPermissoes.OPERACOES.push('podeTudo');

    const html = render.linhaRecurso({ id: 'materials', nome: 'Materiais' }, null);

    assert.equal((html.match(/<select/g) || []).length, 4);
    assert.equal(html.includes('podeTudo'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('indexarPor — casar catálogo com o que está configurado', () => {
  test('indexa pela chave informada', () => {
    const mapa = indexarPor([{ recurso: 'materials', podeCriar: true }], 'recurso');

    assert.deepEqual(mapa.materials, { recurso: 'materials', podeCriar: true });
  });

  test('lista vazia ou ausente devolve mapa vazio', () => {
    assert.deepEqual(indexarPor([], 'recurso'), {});
    assert.deepEqual(indexarPor(undefined, 'recurso'), {});
  });

  test('as ações são indexadas por acaoCodigo, como a 3N devolve', () => {
    const mapa = indexarPor([{ acaoCodigo: ACAO, permitido: false }], 'acaoCodigo');

    assert.equal(mapa[ACAO].permitido, false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('autoridade nunca sai do cliente', () => {
  test('o corpo enviado jamais carrega empresaId, atorId, isMaster ou perfil', async () => {
    const fetch = fetchFalso(resposta(200, { status: 'ok', configuracao: {}, alterado: true }));
    EpiHttp.configurar({ fetch });

    await acoes.configurarRecurso(GRUPO, RECURSO, { podeCriar: true, empresaId: 1, isMaster: true });
    await acoes.configurarAcao(GRUPO, ACAO, true);

    for (const chamada of fetch.chamadas) {
      const corpo = corpoDe(chamada);
      for (const proibido of EpiHttp.CAMPOS_DE_AUTORIDADE_PROIBIDOS) {
        assert.equal(proibido in corpo, false, `${proibido} vazou no corpo`);
      }
    }
  });

  test('falha de rede vira envelope FALHA_DE_REDE, não exceção solta', async () => {
    EpiHttp.configurar({ fetch: fetchFalso(new TypeError('Failed to fetch')) });

    const resultado = await acoes.listarRecursos(GRUPO);

    assert.equal(resultado.ok, false);
    assert.equal(resultado.codigo, 'FALHA_DE_REDE');
    assert.match(mensagens.deErro(resultado), /conexão/i);
  });

  test('403 do backend chega como envelope e vira texto, sem quebrar a tela', async () => {
    EpiHttp.configurar({
      fetch: fetchFalso(erro(403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA', 'Sem autoridade')),
    });

    const resultado = await acoes.configurarAcao(GRUPO, ACAO, true);

    assert.equal(resultado.ok, false);
    assert.equal(resultado.status, 403);
    assert.match(mensagens.deErro(resultado), /não tem autorização/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Correção pós-auditoria da 3T: respostas fora de ordem
//
// Aqui não se testam funções isoladas, e sim o COMPORTAMENTO DA TELA: o
// controlador é exercitado com um `ui` falso que registra tudo o que
// seria pintado, e com um `fetch` cujas respostas eu resolvo na ordem
// que quiser — inclusive na ordem errada, que é a que provoca o defeito.
// ─────────────────────────────────────────────────────────────────────

/** fetch que só responde quando o teste mandar. */
function fetchDeferido() {
  const pendentes = [];
  const fn = async (url, opcoes) => new Promise((resolve, reject) => {
    pendentes.push({ url, opcoes, resolve, reject, respondido: false });
  });
  fn.pendentes = pendentes;

  const achar = (padrao) => pendentes.find((p) => !p.respondido && p.url.includes(padrao));

  fn.responder = (padrao, valor) => {
    const alvo = achar(padrao);
    assert.ok(alvo, `nenhuma requisição pendente casa com "${padrao}"`);
    alvo.respondido = true;
    alvo.resolve(valor);
    return alvo;
  };
  fn.responderTodos = (padrao, valor) => {
    let quantos = 0;
    for (const p of pendentes) {
      if (p.respondido || !p.url.includes(padrao)) continue;
      p.respondido = true;
      p.resolve(valor);
      quantos += 1;
    }
    return quantos;
  };
  fn.pendentesDe = (padrao) => pendentes.filter((p) => !p.respondido && p.url.includes(padrao));
  return fn;
}

/** `ui` falso: registra o que a tela exibiria, sem DOM nenhum. */
function uiFalso() {
  const registro = { recursos: [], acoes: [], avisos: [], inativo: [], sessao: [] };
  return {
    registro,
    renderRecursos(html) { registro.recursos.push(html); },
    renderAcoes(html) { registro.acoes.push(html); },
    aviso(texto, tipo) { registro.avisos.push({ texto, tipo }); },
    grupoInativo(valor) { registro.inativo.push(valor); },
    sessaoExpirada(mensagem) { registro.sessao.push(mensagem); },
  };
}

const ultimo = (lista) => lista[lista.length - 1];

const GRUPO_A = 7;
const GRUPO_B = 8;

// Permissões bem diferentes entre os dois grupos, para que confundi-los
// seja impossível de passar despercebido — e com os três estados
// presentes, para provar que o tri-state atravessa a correção.
const RECURSOS_A = [{ recurso: 'materials', podeVisualizar: true, podeCriar: true, podeEditar: true, podeExcluir: true }];
const RECURSOS_B = [{ recurso: 'materials', podeVisualizar: false, podeCriar: null, podeEditar: false, podeExcluir: null }];
const CATALOGO = [
  { codigo: 'MOVIMENTAR_ESTOQUE', nome: 'Movimentar estoque', descricao: null, ativo: true, exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' },
];

function montarCenario() {
  const fetch = fetchDeferido();
  EpiHttp.configurar({ baseUrl: BASE, fetch });
  const ui = uiFalso();
  const controlador = EpiGrupoPermissoes.criarControlador({ ui });
  return { fetch, ui, controlador };
}

/** Responde as três requisições de uma carga de grupo. */
function responderCarga(fetch, grupoId, { recursos = [], acoes: acoesDoGrupo = [], catalogo = CATALOGO } = {}) {
  fetch.responder(`/grupos-acesso/${grupoId}/permissoes/recursos`, resposta(200, { status: 'ok', recursos }));
  fetch.responder(`/grupos-acesso/${grupoId}/permissoes/acoes`, resposta(200, { status: 'ok', acoes: acoesDoGrupo }));
  // O catálogo é a MESMA URL nas duas cargas: não dá para distinguir
  // pela URL, então respondo todas as pendentes. A carga do outro grupo
  // segue incompleta enquanto as suas duas primeiras não forem
  // respondidas — que é justamente o que estes testes controlam.
  fetch.responderTodos('/catalogo/acoes', resposta(200, { status: 'ok', acoes: catalogo }));
}

describe('condição de corrida: carregamento fora de ordem', () => {
  test('A. selecionar o Grupo A e depois o Grupo B deixa duas cargas em voo', () => {
    const { fetch, controlador } = montarCenario();

    controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    controlador.selecionar(GRUPO_B, { nome: 'Grupo B' });

    assert.equal(fetch.pendentesDe(`/grupos-acesso/${GRUPO_A}/`).length, 2);
    assert.equal(fetch.pendentesDe(`/grupos-acesso/${GRUPO_B}/`).length, 2);
    assert.equal(controlador.grupoAtual(), GRUPO_B, 'o seletor já está em B');
  });

  test('B. a resposta do Grupo A chegando por último NÃO substitui o que está na tela', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const cargaA = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Grupo B' });

    responderCarga(fetch, GRUPO_B, { recursos: RECURSOS_B });
    assert.equal((await cargaB).status, 'ok');

    const telaDepoisDeB = ultimo(ui.registro.recursos);

    // Agora a resposta atrasada de A chega — o cenário exato do defeito.
    responderCarga(fetch, GRUPO_A, { recursos: RECURSOS_A });
    const resultadoA = await cargaA;

    assert.equal(resultadoA.status, 'obsoleta');
    assert.equal(resultadoA.grupo, GRUPO_A);
    assert.equal(ultimo(ui.registro.recursos), telaDepoisDeB, 'a tela não foi repintada pela resposta velha');
    assert.equal(controlador.grupoAtual(), GRUPO_B);
  });

  test('E. o tri-state exibido continua sendo o do Grupo B, sem FALSE virar NULL', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const cargaA = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Grupo B' });

    responderCarga(fetch, GRUPO_B, { recursos: RECURSOS_B });
    await cargaB;
    responderCarga(fetch, GRUPO_A, { recursos: RECURSOS_A });
    await cargaA;

    // B tem visualizar=false, criar=null, editar=false, excluir=null.
    // A tem os quatro true. Se a resposta velha tivesse vencido, a linha
    // de materials mostraria quatro "true selected".
    const html = ultimo(ui.registro.recursos);
    const linha = html.slice(html.indexOf('data-recurso="materials"'), html.indexOf('data-recurso="materials"') + 1400);

    assert.equal((linha.match(/value="false" selected/g) || []).length, 2, 'as duas negações de B continuam negações');
    assert.equal((linha.match(/value="true" selected/g) || []).length, 0, 'nada de A vazou');
    assert.equal(controlador.configuracaoDeRecurso('materials').podeVisualizar, false);
    assert.equal(controlador.configuracaoDeRecurso('materials').podeCriar, null, 'NULL continua NULL');
  });

  test('o estado interno também é o de B: a diferença do próximo save parte dele', async () => {
    const { fetch, controlador } = montarCenario();

    const cargaA = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Grupo B' });
    responderCarga(fetch, GRUPO_B, { recursos: RECURSOS_B });
    await cargaB;
    responderCarga(fetch, GRUPO_A, { recursos: RECURSOS_A });
    await cargaA;

    assert.deepEqual(controlador.configuracaoDeRecurso('materials'), RECURSOS_B[0]);
  });

  test('recarregar com carga pendente descarta a anterior', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const primeira = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    const segunda = controlador.recarregar();

    responderCarga(fetch, GRUPO_A, { recursos: RECURSOS_A });   // responde a 1ª
    responderCarga(fetch, GRUPO_A, { recursos: RECURSOS_B });   // responde a 2ª

    assert.equal((await primeira).status, 'obsoleta');
    assert.equal((await segunda).status, 'ok');
    assert.deepEqual(controlador.configuracaoDeRecurso('materials'), RECURSOS_B[0], 'venceu a carga mais recente');
    assert.equal(ui.registro.sessao.length, 0);
  });

  test('voltar para "Selecione…" com carga pendente não repinta depois', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    controlador.selecionar(null, {});
    const telaVazia = ultimo(ui.registro.recursos);

    responderCarga(fetch, GRUPO_A, { recursos: RECURSOS_A });

    assert.equal((await carga).status, 'obsoleta');
    assert.equal(ultimo(ui.registro.recursos), telaVazia);
    assert.equal(controlador.grupoAtual(), null);
  });
});

describe('condição de corrida: gravação concluída após trocar de grupo', () => {
  async function carregarGrupoA() {
    const cenario = montarCenario();
    const carga = cenario.controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    responderCarga(cenario.fetch, GRUPO_A, { recursos: RECURSOS_A });
    await carga;
    return cenario;
  }

  test('C. o PATCH vai para o grupo de origem, não para o selecionado depois', async () => {
    const { fetch, controlador } = await carregarGrupoA();

    // Começa a salvar em A...
    const salvando = controlador.salvarRecurso('materials', {
      podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true,
    });
    const patch = fetch.pendentesDe('/permissoes/recursos/materials')[0];

    // ...e o usuário troca para B antes da resposta chegar.
    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Grupo B' });
    responderCarga(fetch, GRUPO_B, { recursos: RECURSOS_B });
    await cargaB;

    assert.ok(patch.url.includes(`/grupos-acesso/${GRUPO_A}/`), `o PATCH saiu para ${patch.url}`);
    assert.equal(patch.opcoes.method, 'PATCH');
    assert.deepEqual(JSON.parse(patch.opcoes.body), { podeCriar: false }, 'só a operação alterada foi enviada');

    fetch.responder('/permissoes/recursos/materials', resposta(200, {
      status: 'ok',
      configuracao: { recurso: 'materials', podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true },
      alterado: true,
    }));

    const resultado = await salvando;
    assert.equal(resultado.status, 'obsoleta');
    assert.equal(resultado.grupo, GRUPO_A);
  });

  test('F. a gravação de A não altera o estado nem a tela de B', async () => {
    const { fetch, ui, controlador } = await carregarGrupoA();

    const salvando = controlador.salvarRecurso('materials', {
      podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true,
    });

    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Grupo B' });
    responderCarga(fetch, GRUPO_B, { recursos: RECURSOS_B });
    await cargaB;

    const telaDeB = ultimo(ui.registro.recursos);
    const avisosAteAqui = ui.registro.avisos.length;

    fetch.responder('/permissoes/recursos/materials', resposta(200, {
      status: 'ok',
      configuracao: { recurso: 'materials', podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true },
      alterado: true,
    }));
    await salvando;

    assert.equal(ultimo(ui.registro.recursos), telaDeB, 'a tela de B não foi repintada');
    assert.deepEqual(controlador.configuracaoDeRecurso('materials'), RECURSOS_B[0], 'o cache continua sendo o de B');
    assert.equal(ui.registro.avisos.length, avisosAteAqui, 'nem um "salvo" enganoso apareceu');
  });

  test('uma gravação obsoleta que FALHOU avisa, nomeando o grupo de origem', async () => {
    const { fetch, ui, controlador } = await carregarGrupoA();

    const salvando = controlador.salvarRecurso('materials', {
      podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true,
    });

    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Grupo B' });
    responderCarga(fetch, GRUPO_B, { recursos: RECURSOS_B });
    await cargaB;

    fetch.responder('/permissoes/recursos/materials', erro(403, 'GRUPO_PERMISSAO_NAO_AUTORIZADA', 'Sem autoridade'));
    await salvando;

    const recado = ultimo(ui.registro.avisos);
    assert.equal(recado.tipo, 'erro');
    assert.match(recado.texto, /Grupo A/, 'o recado diz a qual grupo o erro pertence');
    assert.equal(ultimo(ui.registro.recursos).includes('value="true" selected'), false, 'os dados de B seguem intactos');
  });

  test('a gravação de ação também respeita o grupo de origem', async () => {
    const { fetch, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    responderCarga(fetch, GRUPO_A, {
      recursos: RECURSOS_A,
      acoes: [{ acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: null }],
    });
    await carga;

    const salvando = controlador.salvarAcao('MOVIMENTAR_ESTOQUE', false);
    const patch = fetch.pendentesDe('/permissoes/acoes/MOVIMENTAR_ESTOQUE')[0];

    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Grupo B' });
    responderCarga(fetch, GRUPO_B, { recursos: RECURSOS_B, acoes: [] });
    await cargaB;

    assert.ok(patch.url.includes(`/grupos-acesso/${GRUPO_A}/`));
    assert.deepEqual(JSON.parse(patch.opcoes.body), { permitido: false }, 'NULL → FALSE, não NULL → ausente');

    fetch.responder('/permissoes/acoes/MOVIMENTAR_ESTOQUE', resposta(200, {
      status: 'ok', configuracao: { acaoCodigo: 'MOVIMENTAR_ESTOQUE', permitido: false }, alterado: true,
    }));

    assert.equal((await salvando).status, 'obsoleta');
    assert.equal(controlador.configuracaoDeAcao('MOVIMENTAR_ESTOQUE'), null, 'B não herdou a ação de A');
  });

  test('sem troca de grupo, a gravação segue funcionando normalmente', async () => {
    const { fetch, ui, controlador } = await carregarGrupoA();

    const salvando = controlador.salvarRecurso('materials', {
      podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true,
    });
    fetch.responder('/permissoes/recursos/materials', resposta(200, {
      status: 'ok',
      configuracao: { recurso: 'materials', podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true },
      alterado: true,
    }));

    const resultado = await salvando;
    assert.equal(resultado.status, 'ok');
    assert.equal(resultado.grupo, GRUPO_A);
    assert.equal(controlador.configuracaoDeRecurso('materials').podeCriar, false, 'FALSE gravado e refletido');
    assert.match(ultimo(ui.registro.avisos).texto, /salvas/i);
  });

  test('salvar sem nenhuma mudança não chega a produzir requisição', async () => {
    const { fetch, ui, controlador } = await carregarGrupoA();
    const pendentesAntes = fetch.pendentes.length;

    const resultado = await controlador.salvarRecurso('materials', {
      podeVisualizar: true, podeCriar: true, podeEditar: true, podeExcluir: true,
    });

    assert.equal(resultado.status, 'sem-mudanca');
    assert.equal(fetch.pendentes.length, pendentesAntes);
    assert.match(ultimo(ui.registro.avisos).texto, /nada mudou/i);
  });

  test('salvar sem grupo selecionado não dispara requisição nenhuma', async () => {
    const { fetch, controlador } = montarCenario();

    const resultado = await controlador.salvarRecurso('materials', { podeCriar: true });

    assert.equal(resultado.status, 'sem-grupo');
    assert.equal(fetch.pendentes.length, 0);
  });
});

describe('D. encerramento de sessão com requisição pendente', () => {
  test('401 numa carga devolve ao login e zera o grupo', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    fetch.responder(`/grupos-acesso/${GRUPO_A}/permissoes/recursos`, erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));
    fetch.responder(`/grupos-acesso/${GRUPO_A}/permissoes/acoes`, erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));
    fetch.responderTodos('/catalogo/acoes', erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));

    assert.equal((await carga).status, 'sessao');
    assert.equal(ui.registro.sessao.length, 1);
    assert.match(ui.registro.sessao[0], /sessão expirou/i);
    assert.equal(controlador.grupoAtual(), null);
  });

  test('401 vale mesmo numa resposta obsoleta: sessão não é por grupo', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const cargaA = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    const cargaB = controlador.selecionar(GRUPO_B, { nome: 'Grupo B' });
    responderCarga(fetch, GRUPO_B, { recursos: RECURSOS_B });
    await cargaB;

    fetch.responder(`/grupos-acesso/${GRUPO_A}/permissoes/recursos`, erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));
    fetch.responder(`/grupos-acesso/${GRUPO_A}/permissoes/acoes`, erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));

    assert.equal((await cargaA).status, 'sessao');
    assert.equal(ui.registro.sessao.length, 1, 'o login foi pedido, e não engolido pela guarda de obsolescência');
  });

  test('401 numa gravação pendente devolve ao login', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    responderCarga(fetch, GRUPO_A, { recursos: RECURSOS_A });
    await carga;

    const salvando = controlador.salvarRecurso('materials', {
      podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true,
    });
    fetch.responder('/permissoes/recursos/materials', erro(401, 'SESSAO_INVALIDA', 'Sessão inválida'));

    assert.equal((await salvando).status, 'sessao');
    assert.equal(ui.registro.sessao.length, 1);
    assert.equal(controlador.grupoAtual(), null);
    assert.equal(controlador.configuracaoDeRecurso('materials'), null, 'o estado foi descartado junto com a sessão');
  });

  test('encerrar() com carga pendente: a resposta tardia não pinta nada', async () => {
    const { fetch, ui, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    controlador.encerrar();
    const depoisDoLogout = ui.registro.recursos.length;

    responderCarga(fetch, GRUPO_A, { recursos: RECURSOS_A });

    assert.equal((await carga).status, 'obsoleta');
    assert.equal(ui.registro.recursos.length, depoisDoLogout, 'nada foi renderizado após o logout');
    assert.equal(controlador.grupoAtual(), null);
    assert.equal(controlador.configuracaoDeRecurso('materials'), null);
  });

  test('encerrar() com gravação pendente: o estado não ressuscita', async () => {
    const { fetch, controlador } = montarCenario();

    const carga = controlador.selecionar(GRUPO_A, { nome: 'Grupo A' });
    responderCarga(fetch, GRUPO_A, { recursos: RECURSOS_A });
    await carga;

    const salvando = controlador.salvarRecurso('materials', {
      podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true,
    });
    controlador.encerrar();

    fetch.responder('/permissoes/recursos/materials', resposta(200, {
      status: 'ok',
      configuracao: { recurso: 'materials', podeVisualizar: true, podeCriar: false, podeEditar: true, podeExcluir: true },
      alterado: true,
    }));

    assert.equal((await salvando).status, 'obsoleta');
    assert.equal(controlador.configuracaoDeRecurso('materials'), null);
    assert.equal(controlador.grupoAtual(), null);
  });
});
