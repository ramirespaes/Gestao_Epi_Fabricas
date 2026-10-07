'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const Portal = require('../js/portal-cliente');
const Sessao = require('../js/sessao-empresarial');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Troca de senha obrigatória no primeiro acesso (Gestão de Usuários): quem
 * entra com senha PROVISÓRIA é levado a portal/trocar-senha.html e nada mais
 * abre até a troca. O bloqueio real é do servidor (403
 * TROCA_SENHA_OBRIGATORIA); aqui só o redirecionamento e a mensagem, sem
 * segunda tela nem segundo mecanismo de senha.
 */

const BASE = 'http://localhost:3000/api';
const EMPRESA = { id: 1, nome: 'Empresa Alfa', cnpj: '11222333000181', perfil: 'USUARIO' };
const identidade = (trocaSenhaObrigatoria) => ({ id: 7, email: 'pessoa@example.invalid', trocaSenhaObrigatoria });
const comContexto = (flag) => ({ identidade: identidade(flag), empresas: [EMPRESA], contexto: { usuario: { id: 3, nome: 'Pessoa', email: 'pessoa@example.invalid', perfil: 'USUARIO' }, empresa: EMPRESA } });
const semContexto = (flag) => ({ identidade: identidade(flag), empresas: [EMPRESA, { ...EMPRESA, id: 2 }], contexto: null });
const semEmpresa = (flag) => ({ identidade: identidade(flag), empresas: [], contexto: null });

describe('Portal.decisao: senha provisória leva à troca de senha antes de qualquer destino', () => {
  const { decisao } = Portal;

  test('com trocaSenhaObrigatoria=true o destino é "trocarSenha" em todos os cenários (com empresa, sem seleção, sem empresa), na validação e na entrada', () => {
    for (const dados of [comContexto(true), semContexto(true), semEmpresa(true)]) {
      assert.equal(decisao.destino(dados), 'trocarSenha', JSON.stringify(dados.contexto));
      assert.equal(decisao.entrada(dados), 'trocarSenha');
      assert.equal(decisao.destinoDaSessao({ ok: true, dados }), 'trocarSenha');
      assert.equal(decisao.entradaDaSessao({ ok: true, dados }), 'trocarSenha');
    }
    assert.equal(decisao.pagina('trocarSenha'), 'trocar-senha.html');
  });

  test('sem a obrigação (false, ausente ou identidade ausente) nada muda nos destinos de antes', () => {
    assert.equal(decisao.destino(comContexto(false)), 'inicio');
    assert.equal(decisao.entrada(comContexto(false)), 'painel');
    assert.equal(decisao.destino(semContexto(false)), 'selecionar');
    assert.equal(decisao.destino(semEmpresa(false)), 'semEmpresa');
    const semCampo = comContexto(false);
    delete semCampo.identidade.trocaSenhaObrigatoria;
    assert.equal(decisao.entrada(semCampo), 'painel');
    const semIdentidade = { empresas: [EMPRESA], contexto: comContexto(false).contexto };
    assert.equal(decisao.entrada(semIdentidade), 'painel');
    for (const ruim of ['true', 1, 'sim']) {
      assert.equal(decisao.destino({ ...comContexto(false), identidade: { ...identidade(ruim) } }), 'inicio', `só o booleano true obriga (${ruim})`);
    }
    assert.equal(decisao.destinoDaSessao({ ok: false, status: 401 }), 'login');
  });
});

describe('sessão empresarial: 403 TROCA_SENHA_OBRIGATORIA leva à troca de senha do Portal', () => {
  const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(corpo) });
  function fetchPorRota(rotas) {
    const chamadas = [];
    const fn = async (url, opcoes) => { const chave = `${opcoes.method} ${url.replace(BASE, '')}`; chamadas.push(chave); return rotas[chave] || resposta(404, { status: 'error', codigo: 'NAO_ENCONTRADO' }); };
    fn.chamadas = chamadas;
    return fn;
  }
  function janelaFalsa() {
    const j = {
      redirecionamentos: [], urlsSubstituidas: [], cookiesEscritos: [],
      location: { pathname: '/pages/dashboard.html', search: '', hash: '', replace: (d) => j.redirecionamentos.push(d) },
      history: { replaceState: (_e, _t, nova) => j.urlsSubstituidas.push(nova) },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: {},
    };
    Object.defineProperty(j.document, 'cookie', { set(v) { j.cookiesEscritos.push(v); }, get() { return ''; } });
    return j;
  }
  let fetch;
  beforeEach(() => { fetch = fetchPorRota({}); EpiHttp.configurar({ baseUrl: BASE, fetch }); });

  test('GET /auth/me com 403 TROCA_SENHA_OBRIGATORIA: não autentica, motivo próprio e vai para ../portal/trocar-senha.html sem consultar mais nada', async () => {
    fetch = fetchPorRota({ 'GET /auth/me': resposta(403, { status: 'error', codigo: 'TROCA_SENHA_OBRIGATORIA', message: 'Defina uma nova senha para continuar' }) });
    EpiHttp.configurar({ baseUrl: BASE, fetch });
    const j = janelaFalsa();
    const r = await Sessao.iniciar({ janela: j });
    assert.deepEqual(r, { autenticado: false, motivo: 'TROCA_SENHA_OBRIGATORIA' });
    assert.deepEqual(j.redirecionamentos, ['../portal/trocar-senha.html']);
    assert.deepEqual(fetch.chamadas, ['GET /auth/me']);
  });

  test('outro 403 continua FALHA sem redirecionar; 401 continua levando ao login', async () => {
    fetch = fetchPorRota({ 'GET /auth/me': resposta(403, { status: 'error', codigo: 'PERMISSAO_NEGADA', message: 'x' }) });
    EpiHttp.configurar({ baseUrl: BASE, fetch });
    const j = janelaFalsa();
    assert.deepEqual(await Sessao.iniciar({ janela: j }), { autenticado: false, motivo: 'FALHA' });
    assert.deepEqual(j.redirecionamentos, []);
    fetch = fetchPorRota({ 'GET /auth/me': resposta(401, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' }) });
    EpiHttp.configurar({ baseUrl: BASE, fetch });
    const j2 = janelaFalsa();
    assert.deepEqual(await Sessao.iniciar({ janela: j2 }), { autenticado: false, motivo: 'SEM_SESSAO' });
    assert.deepEqual(j2.redirecionamentos, ['../portal/index.html']);
  });
});

describe('portal/trocar-senha.html em modo obrigatório: a mesma página, com o aviso, sem segunda tela', () => {
  const PAGINA = 'portal/trocar-senha.html';
  const ME = 'GET /auth/global/me';
  const TROCAR = 'POST /auth/global/senha';
  const ok = (corpo) => ({ status: 200, corpo: { status: 'ok', ...corpo } });
  const SENHA_ALTERADA = { status: 200, corpo: { status: 'SENHA_ALTERADA' } };
  const abrir = async (dados) => { const pg = abrirPagina(PAGINA, { rotas: { [ME]: ok(dados), [TROCAR]: SENHA_ALTERADA } }); await pg.esperar(); return pg; };

  test('com trocaSenhaObrigatoria=true: formulário à vista, aviso de troca obrigatória como texto, nenhum redirecionamento; a troca segue pelo mesmo POST e o sucesso aparece', async () => {
    const pg = await abrir(comContexto(true));
    assert.equal(pg.visivel('form-troca'), true);
    assert.deepEqual(pg.navegacoes, []);
    assert.match(pg.texto('mensagem'), /senha provisória/i);
    assert.match(pg.texto('mensagem'), /nova senha/i);
    assert.doesNotMatch(pg.el('mensagem').getAttribute('class') || '', /erro/, 'é um aviso, não um erro');
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
    await pg.digitar('senha-atual', 'cometa-lanterna-ardosia-77');
    await pg.digitar('senha-nova', 'girassol-quartzo-bussola-58');
    await pg.digitar('senha-confirmacao', 'girassol-quartzo-bussola-58');
    await pg.clicar('botao-trocar');
    assert.equal(pg.chamadas.filter((c) => c.chave === TROCAR).length, 1);
    assert.equal(pg.visivel('sucesso'), true);
    assert.equal(pg.visivel('form-troca'), false);
  });

  test('sem a obrigação: nenhum aviso (comportamento de antes)', async () => {
    const pg = await abrir(comContexto(false));
    assert.equal(pg.visivel('form-troca'), true);
    assert.equal(pg.texto('mensagem').trim(), '');
  });
});
