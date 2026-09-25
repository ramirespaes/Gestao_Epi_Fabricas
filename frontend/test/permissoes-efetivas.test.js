'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');

/**
 * Permissões efetivas no frontend (Bloco 9, Etapa C, Parte C1), com `fetch`
 * injetado. O cálculo real e a equivalência com as rotas estão em
 * backend/test/integracao/permissoes-efetivas.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const PAGINAS = ['grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais'];

const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const area = (v) => ({ consultar: v, alterar: v });
function corpo(extra = {}) {
  return {
    status: 'ok',
    empresaId: 3,
    usuarioId: 7,
    perfil: 'ADMINISTRADOR',
    recursos: { materials: { visualizar: true, criar: false, editar: false, excluir: false } },
    acoes: { MOVIMENTAR_ESTOQUE: false },
    administracao: {
      gruposAcesso: area(true),
      permissoesGrupo: area(false),
      vinculosGrupo: area(true),
      autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: true },
    },
    ...extra,
  };
}

// O que a página exibe (EpiSessaoEmpresarial): mesmos valores de corpo().
const ESPERADO = { empresaId: 3, usuarioId: 7, perfil: 'ADMINISTRADOR' };
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa' }, usuario: { id: 7, nome: 'Pessoa', perfil: 'ADMINISTRADOR' } };

let chamadas;
function servidor(r) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => { chamadas.push({ url, opcoes }); if (r instanceof Error) throw r; return r; },
  });
}

function linkFalso(pagina) {
  return { style: { display: 'none' }, getAttribute: (n) => (n === 'data-pagina' ? pagina : null) };
}

beforeEach(() => servidor(resposta(200, corpo())));

describe('carregar: do servidor, validado, da empresa certa', () => {
  test('GET /auth/permissoes com credentials, sem corpo; resposta válida da empresa esperada', async () => {
    const r = await P.carregar(ESPERADO);
    assert.equal(r.ok, true);
    assert.equal(chamadas[0].url, `${BASE}/auth/permissoes`);
    assert.deepEqual([chamadas[0].opcoes.method, chamadas[0].opcoes.credentials, chamadas[0].opcoes.body], ['GET', 'include', undefined]);
    assert.equal(r.permissoes.administracao.gruposAcesso.consultar, true);
  });

  test('mesma empresa e MESMO usuário com o mesmo perfil: aceita', async () => {
    const r = await P.carregar({ empresaId: 3, usuarioId: 7, perfil: 'ADMINISTRADOR' });
    assert.equal(r.ok, true);
  });

  test('mesma empresa e OUTRO usuário (outra aba entrou com outra pessoa): falha fechada', async () => {
    assert.deepEqual(await P.carregar({ empresaId: 3, usuarioId: 8, perfil: 'ADMINISTRADOR' }), { ok: false, motivo: 'CONTEXTO_DIVERGENTE' });
  });

  test('mesmo usuário com PERFIL ALTERADO (a página exibe o perfil antigo): falha fechada', async () => {
    assert.deepEqual(await P.carregar({ empresaId: 3, usuarioId: 7, perfil: 'MASTER' }), { ok: false, motivo: 'CONTEXTO_DIVERGENTE' });
  });

  test('EMPRESA diferente (troca de empresa em outra aba): falha fechada', async () => {
    assert.deepEqual(await P.carregar({ empresaId: 4, usuarioId: 7, perfil: 'ADMINISTRADOR' }), { ok: false, motivo: 'CONTEXTO_DIVERGENTE' });
  });

  test('contexto esperado INCOMPLETO ou malformado: falha fechada sem nem consultar o servidor', async () => {
    for (const esperado of [undefined, {}, { empresaId: 3 }, { empresaId: 3, usuarioId: 7 }, { empresaId: 3, perfil: 'ADMINISTRADOR' },
      { empresaId: '3', usuarioId: 7, perfil: 'ADMINISTRADOR' }, { empresaId: 3, usuarioId: 0, perfil: 'ADMINISTRADOR' }, { empresaId: 3, usuarioId: 7, perfil: '' }]) {
      servidor(resposta(200, corpo()));
      assert.deepEqual(await P.carregar(esperado), { ok: false, motivo: 'CONTEXTO_DIVERGENTE' }, JSON.stringify(esperado));
      assert.equal(chamadas.length, 0, 'nenhuma requisição sem contexto completo');
    }
  });

  test('esperadoDoContexto: extrai empresa, usuário e perfil do contexto da página; ausências viram null', () => {
    assert.deepEqual(P.esperadoDoContexto(CONTEXTO), ESPERADO);
    assert.deepEqual(P.esperadoDoContexto({ empresa: { id: 3 } }), { empresaId: 3, usuarioId: null, perfil: null });
    assert.deepEqual(P.esperadoDoContexto(null), { empresaId: null, usuarioId: null, perfil: null });
  });

  test('401 = SEM_SESSAO; 5xx e rede = FALHA', async () => {
    servidor(resposta(401, { codigo: 'SESSAO_INVALIDA' }));
    assert.deepEqual(await P.carregar(ESPERADO), { ok: false, motivo: 'SEM_SESSAO' });
    servidor(resposta(500, { codigo: 'ERRO_INTERNO' }));
    assert.deepEqual(await P.carregar(ESPERADO), { ok: false, motivo: 'FALHA' });
    servidor(new TypeError('rede'));
    assert.deepEqual(await P.carregar(ESPERADO), { ok: false, motivo: 'FALHA' });
  });

  test('qualquer desvio de formato é RESPOSTA_INVALIDA (falha fechada): "true" em texto, área faltando, número, recurso sem operação', async () => {
    const ruins = [
      corpo({ administracao: { ...corpo().administracao, gruposAcesso: { consultar: 'true', alterar: true } } }),
      corpo({ administracao: { gruposAcesso: area(true) } }),
      corpo({ acoes: { MOVIMENTAR_ESTOQUE: 1 } }),
      corpo({ recursos: { materials: { visualizar: true } } }),
      corpo({ empresaId: '3' }),
      null,
    ];
    for (const c of ruins) {
      servidor(resposta(200, c));
      assert.deepEqual(await P.carregar(ESPERADO), { ok: false, motivo: 'RESPOSTA_INVALIDA' }, JSON.stringify(c));
    }
  });

  test('campos extras do servidor não são copiados', async () => {
    servidor(resposta(200, corpo({ segredo: 'x', administracao: { ...corpo().administracao, extra: area(true) } })));
    const r = await P.carregar(ESPERADO);
    assert.equal('segredo' in r.permissoes, false);
    assert.equal('extra' in r.permissoes.administracao, false);
  });
});

describe('decisões: só `true` explícito libera', () => {
  const perm = () => corpo();

  test('podeAbrir: permissões e integrantes exigem também consultar grupos (a página lista grupos por essa rota)', () => {
    const p = perm();
    assert.equal(P.podeAbrir(p, 'grupos-acesso'), true);
    assert.equal(P.podeAbrir(p, 'grupo-permissoes'), false, 'sem permissoesGrupo');
    assert.equal(P.podeAbrir(p, 'grupo-usuarios'), true);
    assert.equal(P.podeAbrir(p, 'autorizacoes-individuais'), true);
    const semGrupos = corpo({ administracao: { ...corpo().administracao, gruposAcesso: area(false), vinculosGrupo: area(true) } });
    assert.equal(P.podeAbrir(semGrupos, 'grupo-usuarios'), false, 'vínculos sem consultar grupos: a página não funcionaria');
  });

  test('podeAlterar nunca decorre de podeAbrir; autorizações individuais decidem por operação (sem "alterar" geral)', () => {
    const soLeitura = corpo({ administracao: { ...corpo().administracao, gruposAcesso: { consultar: true, alterar: false } } });
    assert.deepEqual([P.podeAbrir(soLeitura, 'grupos-acesso'), P.podeAlterar(soLeitura, 'grupos-acesso')], [true, false]);
    assert.equal(P.podeAlterar(perm(), 'autorizacoes-individuais'), false);
  });

  test('null, página desconhecida e nomes herdados do prototype nunca liberam', () => {
    assert.equal(P.podeAbrir(null, 'grupos-acesso'), false);
    assert.equal(P.podeAlterar(null, 'grupos-acesso'), false);
    assert.equal(P.podeAbrir(perm(), 'dashboard'), false);
    assert.equal(P.podeAbrir(perm(), '__proto__'), false);
    assert.equal(P.podeAbrir(perm(), 'toString'), false);
    assert.equal(P.recurso(perm(), 'toString', 'visualizar'), false);
    assert.equal(P.acao(perm(), 'constructor'), false);
    assert.equal(P.administra(perm(), 'constructor', 'consultar'), false);
  });

  test('recurso e ação: separados, estritos', () => {
    const p = perm();
    assert.deepEqual([P.recurso(p, 'materials', 'visualizar'), P.recurso(p, 'materials', 'criar'), P.recurso(p, 'reports', 'visualizar')], [true, false, false]);
    assert.equal(P.acao(p, 'MOVIMENTAR_ESTOQUE'), false);
  });
});

describe('menu, página e somente leitura', () => {
  test('aplicarMenu mostra só o que abre; com null esconde tudo', () => {
    const links = PAGINAS.map(linkFalso);
    P.aplicarMenu(corpo(), links);
    assert.deepEqual(links.map((l) => l.style.display), ['', 'none', '', '']);
    P.aplicarMenu(null, links);
    assert.deepEqual(links.map((l) => l.style.display), ['none', 'none', 'none', 'none']);
  });

  test('prepararPagina: sucesso devolve podeAlterar e aplica o menu', async () => {
    const links = PAGINAS.map(linkFalso);
    const avisos = [];
    const r = await P.prepararPagina({ pagina: 'grupos-acesso', contexto: CONTEXTO, links, aviso: (m) => avisos.push(m) });
    assert.deepEqual(r.podeAlterar, true);
    assert.deepEqual([avisos, links[0].style.display], [[], '']);
  });

  test('prepararPagina: falha na consulta -> nada abre, menu todo oculto, aviso de falha', async () => {
    servidor(resposta(500, {}));
    const links = PAGINAS.map((p) => ({ ...linkFalso(p), style: { display: '' } }));
    const avisos = [];
    assert.equal(await P.prepararPagina({ pagina: 'grupos-acesso', contexto: CONTEXTO, links, aviso: (m) => avisos.push(m) }), null);
    assert.deepEqual(links.map((l) => l.style.display), ['none', 'none', 'none', 'none']);
    assert.deepEqual(avisos, [P.MENSAGENS.FALHA]);
  });

  test('prepararPagina: resposta de outro usuário/perfil -> menu todo oculto, aviso de sessão alterada, nada abre', async () => {
    const links = PAGINAS.map((p) => ({ ...linkFalso(p), style: { display: '' } }));
    const avisos = [];
    const outro = { ...CONTEXTO, usuario: { id: 8, nome: 'Outra', perfil: 'ADMINISTRADOR' } };
    assert.equal(await P.prepararPagina({ pagina: 'grupos-acesso', contexto: outro, links, aviso: (m) => avisos.push(m) }), null);
    assert.deepEqual(links.map((l) => l.style.display), ['none', 'none', 'none', 'none']);
    assert.deepEqual(avisos, [P.MENSAGENS.CONTEXTO_DIVERGENTE]);

    const perfilAntigo = { ...CONTEXTO, usuario: { ...CONTEXTO.usuario, perfil: 'MASTER' } };
    assert.equal(await P.prepararPagina({ pagina: 'grupos-acesso', contexto: perfilAntigo, links: [], aviso: () => {} }), null);
  });

  test('prepararPagina: sem acesso à página -> aviso de acesso, nada carrega; 401 -> Portal', async () => {
    const avisos = [];
    assert.equal(await P.prepararPagina({ pagina: 'grupo-permissoes', contexto: CONTEXTO, links: [], aviso: (m) => avisos.push(m) }), null);
    assert.deepEqual(avisos, [P.MENSAGENS.SEM_ACESSO]);

    servidor(resposta(401, {}));
    let encerrada = 0;
    globalThis.EpiSessaoEmpresarial = { sessaoEncerrada: () => { encerrada += 1; } };
    try {
      assert.equal(await P.prepararPagina({ pagina: 'grupos-acesso', contexto: CONTEXTO, links: [] }), null);
      assert.equal(encerrada, 1);
    } finally {
      delete globalThis.EpiSessaoEmpresarial;
    }
  });

  test('somenteLeitura remove botões de operação e desabilita campos', () => {
    const removidos = [];
    const campos = [{ disabled: false }, { disabled: false }];
    const raiz = {
      querySelectorAll: (sel) => (sel === '[data-acao]'
        ? [{ parentNode: { removeChild: (el) => removidos.push(el) }, id: 'b1' }]
        : campos),
    };
    P.somenteLeitura(raiz);
    assert.equal(removidos.length, 1);
    assert.deepEqual(campos.map((c) => c.disabled), [true, true]);
  });
});

describe('páginas (inspeção estática)', () => {
  const ler = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
  const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  for (const pagina of PAGINAS) {
    test(`${pagina}: carrega o módulo após a sessão, prepara a página com o próprio nome, e os quatro links nascem ocultos`, () => {
      const html = ler(`pages/${pagina}.html`);
      const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
      assert.ok(scripts.indexOf('../js/sessao-empresarial.js') < scripts.indexOf('../js/permissoes-efetivas.js'));
      assert.match(semComentarios(html), new RegExp(`EpiPermissoes\\.prepararPagina\\(\\{\\s*pagina: '${pagina}'`));
      const links = [...html.matchAll(/<a [^>]*data-pagina="([^"]+)"[^>]*>/g)];
      assert.deepEqual(links.map((m) => m[1]).sort(), [...PAGINAS].sort());
      for (const m of links) assert.match(m[0], /style="display:none"/, `${m[1]} deve nascer oculto`);
      assert.equal(/localStorage|sessionStorage/.test(semComentarios(html)), false);
    });
  }

  test('grupos-acesso: "Novo grupo" nasce oculto e só aparece com alterar', () => {
    const html = ler('pages/grupos-acesso.html');
    assert.match(html, /<button id="botaoNovo" class="filled-btn" style="display:none">/);
    assert.match(semComentarios(html), /\$\('botaoNovo'\)\.style\.display = acesso\.podeAlterar \? '' : 'none';/);
  });

  test('portal/inicio: os quatro módulos administrativos (e, desde a C2, Materiais) nascem ocultos e dependem das permissões', () => {
    const html = ler('portal/inicio.html');
    const links = [...html.matchAll(/<a [^>]*data-pagina="([^"]+)"[^>]*>/g)];
    assert.deepEqual(links.map((m) => m[1]), ['grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais', 'materials']);
    for (const m of links) assert.match(m[0], /style="display:none"/);
    assert.match(html, /<script src="\.\.\/js\/permissoes-efetivas\.js"><\/script>/);
    assert.match(ler('portal/inicio.js'), /EpiPermissoes\.carregar\(window\.EpiPermissoes\.esperadoDoContexto\(ctx\)\)/, 'o Portal confere empresa, usuário e perfil');
    assert.match(ler('portal/inicio.js'), /CONTEXTO_DIVERGENTE/);
  });

  test('o módulo não persiste nada no navegador', () => {
    const codigo = semComentarios(ler('js/permissoes-efetivas.js'));
    assert.equal(/localStorage|sessionStorage|document\.cookie|setItem|getItem/.test(codigo), false);
  });
});
