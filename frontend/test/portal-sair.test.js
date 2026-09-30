'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const EpiPortal = require('../js/portal-cliente');
const EpiPermissoes = require('../js/permissoes-efetivas');

/**
 * Sair e Sair da empresa no Portal do Cliente (inicio.js e empresas.js).
 * O cookie de sessão é HttpOnly: só o servidor revoga e remove. A saída só
 * conta como concluída com resposta 2xx; sem confirmação a página continua
 * como estava, avisa que a sessão pode continuar ativa e deixa tentar de
 * novo. Mesma regra de js/sessao-empresarial.js e do Painel Privado.
 */

const RAIZ = path.join(__dirname, '..');
const BASE = 'http://localhost:3000/api';
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const respostaTexto = (status, texto) => ({ status, ok: status >= 200 && status < 300, text: async () => texto });

const EMAIL = 'p7@exemplo-cliente.com.br';
const CONTEXTO = { usuario: { id: 7, nome: 'Pessoa 7', email: EMAIL, perfil: 'MASTER' }, empresa: { id: 3, nome: 'Empresa 3', cnpj: '11222333000181' } };
const GLOBAL_ME = { status: 'ok', identidade: { id: 9, email: EMAIL }, empresas: [{ id: 3, nome: 'Empresa 3', perfil: 'MASTER' }], contexto: CONTEXTO };
const SEM_EMPRESA_ME = { status: 'ok', identidade: { id: 9, email: EMAIL }, empresas: [], contexto: null };
const PERMISSOES = { status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'MASTER', recursos: {}, acoes: {}, administracao: { gruposAcesso: { consultar: true, alterar: true }, permissoesGrupo: { consultar: true, alterar: true }, vinculosGrupo: { consultar: true, alterar: true }, usuarios: { consultar: true, alterar: true }, autorizacoesIndividuais: { consultar: true, concederDireta: true, delegar: true } } };
const NAO_AUTENTICADO = () => resposta(401, { status: 'erro', codigo: 'NAO_AUTENTICADO' });

const SAIR_TUDO = 'POST /auth/global/logout';
const SAIR_EMPRESA = 'POST /auth/logout';

const FALHAS = [
  { nome: 'falha de rede (status 0)', rota: () => new TypeError('Failed to fetch') },
  { nome: '403 (origem recusada)', rota: () => resposta(403, { status: 'erro', codigo: 'ORIGEM_NAO_PERMITIDA' }) },
  { nome: '429 (muitas requisições)', rota: () => resposta(429, { status: 'erro', codigo: 'LIMITE_EXCEDIDO' }) },
  { nome: '500', rota: () => resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO' }) },
  { nome: '503', rota: () => resposta(503, { status: 'erro', codigo: 'INDISPONIVEL' }) },
  { nome: '200 sem corpo JSON (saída não confirmada)', rota: () => respostaTexto(200, '<html>proxy</html>') },
  { nome: 'falha inesperada (a camada HTTP rejeita)', acoes: { sairDaEmpresa: () => Promise.reject(new Error('inesperado')), sairCompletamente: () => Promise.reject(new Error('inesperado')) } },
];

let chamadas;
/** Servidor falso por rota: resposta, Error (rede) ou função que devolve um deles (ou uma Promise). */
function servidor(rotas) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const chave = `${opcoes.method} ${new URL(url).pathname.replace(/^\/api/, '')}`;
      chamadas.push(chave);
      let r = rotas[chave];
      if (typeof r === 'function') r = await r();
      if (r instanceof Error) throw r;
      if (r === undefined) return resposta(404, { status: 'erro', codigo: 'NAO_ENCONTRADO' });
      return r;
    },
  });
}
const pedidosDeSaida = () => chamadas.filter((c) => c === SAIR_TUDO || c === SAIR_EMPRESA);

function elemento(id, classesIniciais) {
  const classes = new Set(classesIniciais);
  const ouvintes = {};
  return {
    id,
    textContent: '',
    innerHTML: '',
    disabled: false,
    get className() { return [...classes].join(' '); },
    set className(valor) { classes.clear(); String(valor).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener(ev, fn) { (ouvintes[ev] = ouvintes[ev] || []).push(fn); },
    querySelectorAll: () => [],
    disparar(ev) { for (const fn of (ouvintes[ev] || []).slice()) fn({ type: ev, target: this }); },
  };
}

/** Só os elementos com id do HTML real existem; a classe inicial vem do HTML. */
function documentoDe(arquivoHtml) {
  const porId = new Map();
  for (const m of ler(arquivoHtml).matchAll(/<[a-z][a-z0-9]*\b([^<>]*)>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[1]);
    if (!id) continue;
    const classe = /\bclass="([^"]*)"/.exec(m[1]);
    porId.set(id[1], elemento(id[1], classe ? classe[1].split(/\s+/).filter(Boolean) : []));
  }
  return { getElementById: (id) => porId.get(id) ?? null, querySelectorAll: () => [] };
}

/** Executa o script da página num DOM mínimo; a navegação é registrada, não executada. */
function pagina(script, { acoes } = {}) {
  const html = script.replace(/\.js$/, '.html');
  const documento = documentoDe(html);
  const navegacoes = [];
  const inicial = `http://localhost:5500/${html}`;
  const eventosJanela = {};
  const janela = {
    EpiHttp,
    EpiPortal: acoes ? { ...EpiPortal, acoes: { ...EpiPortal.acoes, ...acoes } } : EpiPortal,
    EpiPermissoes,
    SAFEWORK_PORTAL_API_BASE_URL: BASE,
    location: {
      hostname: 'localhost', origin: 'http://localhost:5500', pathname: `/${html}`, search: '', hash: '',
      get href() { return navegacoes.length > 0 ? navegacoes[navegacoes.length - 1] : inicial; },
      set href(destino) { navegacoes.push(String(destino)); },
    },
    addEventListener(ev, fn) { (eventosJanela[ev] = eventosJanela[ev] || []).push(fn); },
  };
  const contexto = vm.createContext({ window: janela, document: documento, console, setTimeout, Promise, Number, String, Array, Object, JSON });
  vm.runInContext(ler(script), contexto, { filename: path.join(RAIZ, script) });

  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => { setImmediate(r); }); };
  const el = (id) => {
    const e = documento.getElementById(id);
    assert.ok(e, `${html} não tem #${id}`);
    return e;
  };
  return {
    el,
    navegacoes,
    esperar,
    /** Como o navegador: botão desabilitado não recebe clique. Devolve se o clique chegou. */
    clicar(id) {
      if (el(id).disabled) return false;
      el(id).disparar('click');
      return true;
    },
    /** Evento entregue mesmo com o botão desabilitado: prova a trava do próprio script. */
    forcarClique(id) { el(id).disparar('click'); },
    async pageshow(persisted) { for (const fn of (eventosJanela.pageshow || [])) fn({ persisted }); await esperar(); },
  };
}

/** Resposta que só chega quando o teste liberar. */
function pendente() {
  let liberar;
  const promessa = new Promise((r) => { liberar = r; });
  return { rota: () => promessa, liberar };
}

const AVISO_NAO_CONFIRMADA = /não foi possível confirmar a saída/i;
const AVISO_SESSAO_ATIVA = /pode continuar ativa/i;

// ═══════════════════════════════════════════════════════════════════
// Início do Portal (inicio.js): "Sair da empresa" e "Sair"
// ═══════════════════════════════════════════════════════════════════
describe('Portal do Cliente — início (inicio.js): a saída só conclui com confirmação do servidor', () => {
  const ACOES = [
    { nome: 'Sair da empresa', botao: 'botao-sair-empresa', outro: 'botao-sair', rota: SAIR_EMPRESA, destino: 'empresas.html' },
    { nome: 'Sair', botao: 'botao-sair', outro: 'botao-sair-empresa', rota: SAIR_TUDO, destino: 'index.html' },
  ];
  const rotasDoInicio = (extra = {}) => ({
    'GET /auth/global/me': () => resposta(200, GLOBAL_ME),
    'GET /auth/permissoes': () => resposta(200, PERMISSOES),
    ...extra,
  });

  async function abrir(rotas, opcoes) {
    servidor(rotas);
    const pg = pagina('portal/inicio.js', opcoes);
    await pg.esperar();
    assert.equal(pg.el('conteudo').classList.contains('oculto'), false, 'pré-condição: sessão confirmada na tela');
    return pg;
  }

  function assertPaginaIntacta(pg, acao) {
    assert.deepEqual(pg.navegacoes, [], 'não navega sem confirmação');
    assert.equal(pg.el('conteudo').classList.contains('oculto'), false, 'o conteúdo continua disponível');
    assert.equal(pg.el('acoes').classList.contains('oculto'), false, 'as ações continuam disponíveis');
    assert.equal(pg.el('usuario-email').textContent, EMAIL);
    assert.equal(pg.el('empresa-ativa').textContent, 'Empresa 3');
    assert.match(pg.el('mensagem').textContent, AVISO_NAO_CONFIRMADA);
    assert.match(pg.el('mensagem').textContent, AVISO_SESSAO_ATIVA);
    assert.equal(pg.el('mensagem').classList.contains('erro'), true);
    assert.equal(pg.el(acao.botao).disabled, false, 'o botão volta a ficar habilitado');
    assert.equal(pg.el(acao.outro).disabled, false, 'o outro botão de saída também');
  }

  for (const acao of ACOES) {
    describe(acao.nome, () => {
      test(`2xx confirmado: um único pedido e a página vai para ${acao.destino}`, async () => {
        const pg = await abrir(rotasDoInicio({ [acao.rota]: () => resposta(200, { status: 'ok' }) }));
        assert.equal(pg.clicar(acao.botao), true);
        await pg.esperar();
        assert.deepEqual(pedidosDeSaida(), [acao.rota]);
        assert.deepEqual(pg.navegacoes, [acao.destino]);
      });

      for (const falha of FALHAS) {
        test(`${falha.nome}: não navega, o conteúdo continua, avisa que a saída não foi confirmada e reabilita o botão`, async () => {
          const rotas = falha.rota ? rotasDoInicio({ [acao.rota]: falha.rota }) : rotasDoInicio();
          const pg = await abrir(rotas, { acoes: falha.acoes });
          assert.equal(pg.clicar(acao.botao), true);
          await pg.esperar();
          assertPaginaIntacta(pg, acao);
        });
      }

      test('clique repetido com o pedido pendente: um único pedido, nenhum outro botão de saída dispara; confirmado, navega uma vez', async () => {
        const espera = pendente();
        const pg = await abrir(rotasDoInicio({ [acao.rota]: espera.rota }));
        assert.equal(pg.clicar(acao.botao), true);
        await pg.esperar();
        assert.equal(pg.el(acao.botao).disabled, true, 'desabilitado enquanto o servidor não responde');
        assert.equal(pg.el(acao.outro).disabled, true, 'o outro botão de saída também');
        assert.equal(pg.clicar(acao.botao), false);
        pg.clicar(acao.outro);
        pg.forcarClique(acao.botao);
        pg.forcarClique(acao.outro);
        await pg.esperar();
        assert.deepEqual(pedidosDeSaida(), [acao.rota], 'um único pedido de saída');
        assert.deepEqual(pg.navegacoes, []);
        espera.liberar(resposta(200, { status: 'ok' }));
        await pg.esperar();
        assert.deepEqual(pg.navegacoes, [acao.destino]);
      });

      test('nova tentativa depois da falha: o aviso some durante o pedido e a segunda, confirmada, navega', async () => {
        const segunda = pendente();
        let tentativa = 0;
        const pg = await abrir(rotasDoInicio({ [acao.rota]: () => { tentativa += 1; return tentativa === 1 ? resposta(503, { status: 'erro' }) : segunda.rota(); } }));
        pg.clicar(acao.botao);
        await pg.esperar();
        assertPaginaIntacta(pg, acao);
        assert.equal(pg.clicar(acao.botao), true, 'a nova tentativa é aceita');
        await pg.esperar();
        assert.equal(pg.el('mensagem').textContent, '', 'o aviso antigo não fica na tela durante a nova tentativa');
        segunda.liberar(resposta(200, { status: 'ok' }));
        await pg.esperar();
        assert.deepEqual(pedidosDeSaida(), [acao.rota, acao.rota]);
        assert.deepEqual(pg.navegacoes, [acao.destino]);
      });
    });
  }

  test('BFCache: restaurada depois de uma saída confirmada, com sessão válida de novo, os botões de saída voltam a funcionar', async () => {
    const pg = await abrir(rotasDoInicio({ [SAIR_EMPRESA]: () => resposta(200, { status: 'ok' }), [SAIR_TUDO]: () => resposta(200, { status: 'ok' }) }));
    pg.clicar('botao-sair-empresa');
    await pg.esperar();
    assert.deepEqual(pg.navegacoes, ['empresas.html']);
    // A pessoa escolheu a empresa de novo e voltou pelo histórico.
    await pg.pageshow(true);
    assert.equal(pg.el('conteudo').classList.contains('oculto'), false);
    assert.equal(pg.el('botao-sair-empresa').disabled, false);
    assert.equal(pg.el('botao-sair').disabled, false);
    assert.equal(pg.clicar('botao-sair'), true);
    await pg.esperar();
    assert.deepEqual(pedidosDeSaida(), [SAIR_EMPRESA, SAIR_TUDO]);
    assert.deepEqual(pg.navegacoes, ['empresas.html', 'index.html']);
  });

  test('BFCache: restaurada depois de uma saída confirmada e sessão encerrada, esconde os dados e vai ao login', async () => {
    let logado = true;
    const pg = await abrir(rotasDoInicio({
      'GET /auth/global/me': () => (logado ? resposta(200, GLOBAL_ME) : NAO_AUTENTICADO()),
      [SAIR_TUDO]: () => { logado = false; return resposta(200, { status: 'ok' }); },
    }));
    pg.clicar('botao-sair');
    await pg.esperar();
    await pg.pageshow(true);
    assert.equal(pg.el('conteudo').classList.contains('oculto'), true);
    assert.equal(pg.el('usuario-email').textContent, '');
    assert.deepEqual(pg.navegacoes, ['index.html', 'index.html']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Seleção de empresa (empresas.js): "Sair"
// ═══════════════════════════════════════════════════════════════════
describe('Portal do Cliente — seleção de empresa (empresas.js): a saída só conclui com confirmação do servidor', () => {
  const rotasDaSelecao = (extra = {}, me = GLOBAL_ME) => ({ 'GET /auth/global/me': () => resposta(200, me), ...extra });

  async function abrir(rotas, opcoes) {
    servidor(rotas);
    const pg = pagina('portal/empresas.js', opcoes);
    await pg.esperar();
    assert.equal(pg.el('botao-sair').classList.contains('oculto'), false, 'pré-condição: Sair visível');
    return pg;
  }

  function assertSelecaoIntacta(pg) {
    assert.deepEqual(pg.navegacoes, [], 'não navega sem confirmação');
    assert.equal(pg.el('selecao').classList.contains('oculto'), false, 'a lista continua disponível');
    assert.match(pg.el('lista-empresas').innerHTML, /Empresa 3/);
    assert.equal(pg.el('identificacao').textContent, EMAIL);
    assert.match(pg.el('mensagem').textContent, AVISO_NAO_CONFIRMADA);
    assert.match(pg.el('mensagem').textContent, AVISO_SESSAO_ATIVA);
    assert.equal(pg.el('mensagem').classList.contains('erro'), true);
    assert.equal(pg.el('botao-sair').disabled, false, 'o botão volta a ficar habilitado');
    assert.equal(pg.el('botao-sair').classList.contains('oculto'), false);
  }

  test('2xx confirmado: um único pedido e a página vai ao login', async () => {
    const pg = await abrir(rotasDaSelecao({ [SAIR_TUDO]: () => resposta(200, { status: 'ok' }) }));
    assert.equal(pg.clicar('botao-sair'), true);
    await pg.esperar();
    assert.deepEqual(pedidosDeSaida(), [SAIR_TUDO]);
    assert.deepEqual(pg.navegacoes, ['index.html']);
  });

  for (const falha of FALHAS) {
    test(`${falha.nome}: não navega, a lista continua, avisa que a saída não foi confirmada e reabilita o botão`, async () => {
      const rotas = falha.rota ? rotasDaSelecao({ [SAIR_TUDO]: falha.rota }) : rotasDaSelecao();
      const pg = await abrir(rotas, { acoes: falha.acoes });
      pg.clicar('botao-sair');
      await pg.esperar();
      assertSelecaoIntacta(pg);
    });
  }

  test('sem empresa disponível: a falha aparece no bloco visível e o botão volta; a nova tentativa confirmada vai ao login', async () => {
    const segunda = pendente();
    let tentativa = 0;
    const pg = await abrir(rotasDaSelecao({ [SAIR_TUDO]: () => { tentativa += 1; return tentativa === 1 ? new TypeError('Failed to fetch') : segunda.rota(); } }, SEM_EMPRESA_ME));
    assert.equal(pg.el('sem-empresa').classList.contains('oculto'), false);
    pg.clicar('botao-sair');
    await pg.esperar();
    assert.deepEqual(pg.navegacoes, []);
    assert.equal(pg.el('sem-empresa').classList.contains('oculto'), false);
    assert.match(pg.el('mensagem-sem-empresa').textContent, AVISO_NAO_CONFIRMADA);
    assert.match(pg.el('mensagem-sem-empresa').textContent, AVISO_SESSAO_ATIVA);
    assert.equal(pg.el('mensagem-sem-empresa').classList.contains('erro'), true);
    assert.equal(pg.el('botao-sair').disabled, false);
    assert.equal(pg.clicar('botao-sair'), true);
    await pg.esperar();
    assert.equal(pg.el('mensagem-sem-empresa').textContent, EpiPortal.mensagens.SEM_EMPRESA, 'durante a nova tentativa volta o texto normal do bloco');
    segunda.liberar(resposta(200, { status: 'ok' }));
    await pg.esperar();
    assert.deepEqual(pg.navegacoes, ['index.html']);
  });

  test('clique repetido com o pedido pendente: um único pedido; confirmado, navega uma vez', async () => {
    const espera = pendente();
    const pg = await abrir(rotasDaSelecao({ [SAIR_TUDO]: espera.rota }));
    pg.clicar('botao-sair');
    await pg.esperar();
    assert.equal(pg.el('botao-sair').disabled, true, 'desabilitado enquanto o servidor não responde');
    assert.equal(pg.clicar('botao-sair'), false);
    pg.forcarClique('botao-sair');
    await pg.esperar();
    assert.deepEqual(pedidosDeSaida(), [SAIR_TUDO]);
    espera.liberar(resposta(200, { status: 'ok' }));
    await pg.esperar();
    assert.deepEqual(pg.navegacoes, ['index.html']);
  });

  test('nova tentativa depois da falha: o aviso some durante o pedido e a segunda, confirmada, vai ao login', async () => {
    const segunda = pendente();
    let tentativa = 0;
    const pg = await abrir(rotasDaSelecao({ [SAIR_TUDO]: () => { tentativa += 1; return tentativa === 1 ? resposta(500, { status: 'erro' }) : segunda.rota(); } }));
    pg.clicar('botao-sair');
    await pg.esperar();
    assertSelecaoIntacta(pg);
    assert.equal(pg.clicar('botao-sair'), true);
    await pg.esperar();
    assert.equal(pg.el('mensagem').textContent, '');
    segunda.liberar(resposta(200, { status: 'ok' }));
    await pg.esperar();
    assert.deepEqual(pedidosDeSaida(), [SAIR_TUDO, SAIR_TUDO]);
    assert.deepEqual(pg.navegacoes, ['index.html']);
  });

  test('BFCache: restaurada depois de uma saída confirmada, com sessão válida de novo, o Sair volta a funcionar', async () => {
    const pg = await abrir(rotasDaSelecao({ [SAIR_TUDO]: () => resposta(200, { status: 'ok' }) }));
    pg.clicar('botao-sair');
    await pg.esperar();
    assert.deepEqual(pg.navegacoes, ['index.html']);
    // Novo login em outra aba; a pessoa volta pelo histórico.
    await pg.pageshow(true);
    assert.match(pg.el('lista-empresas').innerHTML, /Empresa 3/);
    assert.equal(pg.el('botao-sair').disabled, false);
    assert.equal(pg.clicar('botao-sair'), true);
    await pg.esperar();
    assert.deepEqual(pedidosDeSaida(), [SAIR_TUDO, SAIR_TUDO]);
  });

  test('BFCache: restaurada depois de uma saída confirmada e sessão encerrada, limpa a identificação e vai ao login', async () => {
    let logado = true;
    const pg = await abrir({
      'GET /auth/global/me': () => (logado ? resposta(200, GLOBAL_ME) : NAO_AUTENTICADO()),
      [SAIR_TUDO]: () => { logado = false; return resposta(200, { status: 'ok' }); },
    });
    pg.clicar('botao-sair');
    await pg.esperar();
    await pg.pageshow(true);
    assert.deepEqual([pg.el('identificacao').textContent, pg.el('lista-empresas').innerHTML], ['', '']);
    assert.deepEqual(pg.navegacoes, ['index.html', 'index.html']);
  });
});

describe('o Portal não depende do Painel Privado para sair', () => {
  test('inicio.html e empresas.html não carregam scripts do Painel Privado, e os scripts não usam SafeworkSair', () => {
    for (const html of ['portal/inicio.html', 'portal/empresas.html']) {
      assert.equal(/painel-privado\//.test(ler(html)), false, html);
    }
    for (const script of ['portal/inicio.js', 'portal/empresas.js']) {
      assert.equal(/SafeworkSair|painel-privado/.test(ler(script)), false, script);
    }
  });
});
