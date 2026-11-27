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
    // Cadastrar Produto está OFF, mas Entrada por Lote está ON: a Gestão de Estoque abre (qualquer um dos três).
    acoes: { ENTRADA_ESTOQUE: true, BAIXA_ESTOQUE: false },
    administracao: {
      gruposAcesso: area(true),
      permissoesGrupo: area(false),
      vinculosGrupo: area(true),
      usuarios: area(false),
      autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: true },
      vinculosSst: area(false),
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

  test('12G-0/12G-1: vínculos SST é área obrigatória do contrato; ausente ou fora do formato, nenhuma permissão', async () => {
    const { vinculosSst, ...semVinculos } = corpo().administracao;
    assert.deepEqual(vinculosSst, area(false));
    for (const ruim of [semVinculos, { ...semVinculos, vinculosSst: { consultar: true } }, { ...semVinculos, vinculosSst: { consultar: 'true', alterar: true } }, { ...semVinculos, vinculosSst: true }]) {
      servidor(resposta(200, corpo({ administracao: ruim })));
      assert.deepEqual(await P.carregar(ESPERADO), { ok: false, motivo: 'RESPOSTA_INVALIDA' }, String(JSON.stringify(ruim.vinculosSst)));
    }
  });

  test('12G-1: vínculos SST copiados só como consultar e alterar, e lidos por administra(); o perfil não decide', async () => {
    servidor(resposta(200, corpo({ perfil: 'ADMINISTRADOR', administracao: { ...corpo().administracao, vinculosSst: { consultar: true, alterar: true, outro: true } } })));
    const r = await P.carregar(ESPERADO);
    assert.equal(r.ok, true);
    assert.deepEqual(r.permissoes.administracao.vinculosSst, { consultar: true, alterar: true });
    assert.deepEqual([P.administra(r.permissoes, 'vinculosSst', 'consultar'), P.administra(r.permissoes, 'vinculosSst', 'alterar')], [true, true]);
    servidor(resposta(200, corpo({ perfil: 'MASTER' })));
    const master = await P.carregar({ ...ESPERADO, perfil: 'MASTER' });
    assert.equal(P.administra(master.permissoes, 'vinculosSst', 'alterar'), false, 'MASTER sem a área do servidor não administra vínculos');
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

  test('parte F: Novo usuário e Administração de usuários dependem só da área usuarios (GERENCIAR_USUARIOS)', async () => {
    const exigencia = { abrir: [['usuarios', 'consultar']], alterar: [['usuarios', 'alterar']] };
    assert.deepEqual([P.PAGINAS.newUser, P.PAGINAS.userAdmin], [exigencia, exigencia]);
    const sem = perm();
    assert.deepEqual([P.podeAbrir(sem, 'newUser'), P.podeAbrir(sem, 'userAdmin')], [false, false], 'grupos não abrem usuários');
    const com = corpo({ administracao: { ...corpo().administracao, gruposAcesso: area(false), vinculosGrupo: area(false), usuarios: area(true) } });
    assert.deepEqual([P.podeAbrir(com, 'newUser'), P.podeAlterar(com, 'newUser'), P.podeAbrir(com, 'userAdmin'), P.podeAlterar(com, 'userAdmin')], [true, true, true, true]);
    assert.equal(P.podeAbrir(com, 'grupos-acesso'), false, 'usuários não abrem grupos');
    const soLeitura = corpo({ administracao: { ...corpo().administracao, usuarios: { consultar: true, alterar: false } } });
    assert.deepEqual([P.podeAbrir(soLeitura, 'userAdmin'), P.podeAlterar(soLeitura, 'userAdmin')], [true, false]);

    const { usuarios, ...semArea } = corpo().administracao;
    assert.equal(usuarios.consultar, false);
    servidor(resposta(200, corpo({ administracao: semArea })));
    assert.deepEqual(await P.carregar(ESPERADO), { ok: false, motivo: 'RESPOSTA_INVALIDA' }, 'área usuarios ausente é resposta inválida');
    servidor(resposta(200, corpo({ administracao: { ...corpo().administracao, usuarios: { consultar: 'true', alterar: true } } })));
    assert.deepEqual(await P.carregar(ESPERADO), { ok: false, motivo: 'RESPOSTA_INVALIDA' });
  });

  test('10I: Ficha de EPI abre com epiFicha.visualizar OU REALIZAR_ENTREGA (duas autoridades independentes); alterar só com a ação', () => {
    assert.deepEqual(P.PAGINAS.epiFicha, {
      abrir: [{ recurso: 'epiFicha', operacao: 'visualizar' }, { acao: 'REALIZAR_ENTREGA' }],
      abrirComQualquer: true,
      alterar: [{ acao: 'REALIZAR_ENTREGA' }],
    });
    const com = (ficha, entrega) => corpo({ recursos: { ...corpo().recursos, epiFicha: { visualizar: ficha, criar: false, editar: false, excluir: false } }, acoes: { MOVIMENTAR_ESTOQUE: false, REALIZAR_ENTREGA: entrega } });
    const A = com(true, false); const B = com(false, true); const C = com(true, true); const D = com(false, false);
    assert.deepEqual([P.podeAbrir(A, 'epiFicha'), P.podeAlterar(A, 'epiFicha')], [true, false], 'A) só consulta');
    assert.deepEqual([P.podeAbrir(B, 'epiFicha'), P.podeAlterar(B, 'epiFicha')], [true, true], 'B) só entrega');
    assert.deepEqual([P.podeAbrir(C, 'epiFicha'), P.podeAlterar(C, 'epiFicha')], [true, true], 'C) ambas');
    assert.deepEqual([P.podeAbrir(D, 'epiFicha'), P.podeAlterar(D, 'epiFicha')], [false, false], 'D) nenhuma');
    assert.equal(P.podeAbrir(corpo({ recursos: { ...corpo().recursos, epiFicha: { visualizar: true, criar: true, editar: true, excluir: true } } }), 'epiFicha'), true);
    const links = ['epiFicha', 'employeeHistory'].map(linkFalso);
    P.aplicarMenu(B, links);
    assert.deepEqual(links.map((l) => l.style.display), ['', 'none'], 'quem só entrega vê a Ficha, não o Histórico');
    P.aplicarMenu(D, links);
    assert.deepEqual(links.map((l) => l.style.display), ['none', 'none']);
    // A regra "qualquer uma" só onde foi decidida: a Ficha (10I) e, na 12G-1, o Pedido
    // de EPI (ver OU criar) e as Entregas por solicitação (entregar OU encerrar).
    // E a Gestão de Estoque (`materials`): abre com qualquer um dos três acessos independentes.
    // Etapa H: a Central do Atendimento Token abre com a visualização do recurso OU uma das três ações da Central.
    const comQualquer = ['epiFicha', 'request', 'stockRequests', 'materials', 'reports', 'atendimentoToken'];
    for (const pagina of Object.keys(P.PAGINAS)) assert.equal(P.PAGINAS[pagina].abrirComQualquer, comQualquer.includes(pagina) ? true : undefined, pagina);
  });
});

describe('menu, página e somente leitura', () => {
  test('aplicarMenu mostra só o que abre; com null esconde tudo; as páginas de acessos estão fora da navegação (05/10/2026) e nunca aparecem, mesmo permitidas', () => {
    const links = [...PAGINAS, 'materials'].map(linkFalso);
    P.aplicarMenu(corpo(), links);
    assert.deepEqual(links.map((l) => l.style.display), ['none', 'none', 'none', 'none', ''], 'grupos-acesso e grupo-usuarios abririam pela permissão, mas estão ocultas da navegação; materials abre por materials.visualizar');
    assert.deepEqual([P.podeAbrir(corpo(), 'grupos-acesso'), P.navegacaoOculta('grupos-acesso'), P.navegacaoOculta('materials')], [true, true, false], 'a permissão continua: só a navegação esconde');
    P.aplicarMenu(null, links);
    assert.deepEqual(links.map((l) => l.style.display), ['none', 'none', 'none', 'none', 'none']);
  });

  test('prepararPagina: sucesso devolve podeAlterar e aplica o menu', async () => {
    const links = [...PAGINAS, 'materials'].map(linkFalso);
    const avisos = [];
    const r = await P.prepararPagina({ pagina: 'grupos-acesso', contexto: CONTEXTO, links, aviso: (m) => avisos.push(m) });
    assert.deepEqual(r.podeAlterar, true, 'a página legada continua abrindo por acesso direto');
    assert.deepEqual([avisos, links[0].style.display, links[4].style.display], [[], 'none', ''], 'o menu esconde a página de acessos e mostra materials');
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

describe('itens "Em integração": sem inspeção de protótipos; os dois módulos adiados somem do menu', () => {
  const ADIADOS = ['Compras / Entradas', 'Regras Função / Setor'];
  // <a class="nav-pendente" aria-disabled="true" title="Em integração"><div class="nav-icon">ícone</div>Rótulo<span class="nav-etiqueta">Em integração</span></a>
  function pendente(rotulo) {
    const atributos = { class: 'nav-pendente', 'aria-disabled': 'true', title: 'Em integração' };
    return {
      atributos,
      style: {},
      childNodes: [{ nodeType: 1, textContent: 'analytics' }, { nodeType: 3, textContent: rotulo }, { nodeType: 1, textContent: 'Em integração' }],
      getAttribute: (n) => (Object.hasOwn(atributos, n) ? atributos[n] : null),
      setAttribute: (n, v) => { atributos[n] = String(v); },
      removeAttribute: (n) => { delete atributos[n]; },
    };
  }
  const raizCom = (itens) => ({ querySelectorAll: (sel) => (sel === 'a.nav-pendente' ? itens : []) });

  test('a inspeção visual saiu com os protótipos: nenhuma exportação dela resta; a regra dos adiados continua', () => {
    for (const nome of ['INSPECAO_PROTOTIPOS', 'hrefDeInspecao', 'liberarInspecao']) assert.equal(nome in P, false, nome);
    assert.equal(typeof P.ocultarPendentes, 'function');
    assert.deepEqual(P.NAVEGACAO_OCULTA_PENDENTES, ADIADOS);
  });

  test('ocultarPendentes: os dois adiados somem sem link; os demais pendentes (inclusive Totem e Gestão de E-mails) ficam como o HTML os traz', () => {
    const adiados = ADIADOS.map(pendente);
    const outros = ['Autoatendimento (Totem)', 'Gestão de E-mails', 'Módulo Inexistente', 'Configurações'].map(pendente);
    P.ocultarPendentes(raizCom(outros.concat(adiados)));
    for (const a of adiados) {
      assert.equal(a.style.display, 'none');
      assert.equal(a.atributos.href, undefined);
    }
    for (const i of outros) {
      assert.deepEqual([i.atributos.href, i.atributos['aria-disabled'], i.atributos.title, i.atributos.class, i.style.display, i.style.cursor], [undefined, 'true', 'Em integração', 'nav-pendente', undefined, undefined], i.childNodes[1].textContent);
      assert.equal(i.childNodes[2].textContent, 'Em integração', 'etiqueta preservada');
    }
    assert.doesNotThrow(() => P.ocultarPendentes(null), 'sem documento (testes de módulo), não falha');
  });

  test('prepararPagina: nem o MASTER confirmado pelo servidor recebe link nos pendentes; falha na consulta mantém tudo sem link', async () => {
    const contextoMaster = { ...CONTEXTO, usuario: { ...CONTEXTO.usuario, perfil: 'MASTER' } };
    for (const [resp, contexto] of [[resposta(200, corpo({ perfil: 'MASTER' })), contextoMaster], [resposta(200, corpo()), CONTEXTO], [resposta(500, {}), contextoMaster]]) {
      const itens = [pendente('Gestão de E-mails'), pendente('Autoatendimento (Totem)'), pendente('Compras / Entradas')];
      servidor(resp);
      await P.prepararPagina({ pagina: 'grupos-acesso', contexto, links: [], aviso: () => {}, documento: raizCom(itens) });
      assert.deepEqual(itens.map((i) => i.atributos.href), [undefined, undefined, undefined]);
      assert.equal(itens[2].style.display, 'none');
    }
  });
});

describe('Suporte: página integrada, aberta a qualquer sessão empresarial válida', () => {
  const item = (rotulo, classes = ['nav-pendente']) => {
    const atributos = { class: classes.join(' '), 'aria-disabled': 'true', title: 'Em integração' };
    const lista = new Set(classes);
    return {
      atributos,
      style: {},
      classList: { contains: (c) => lista.has(c), remove: (c) => lista.delete(c), add: (c) => lista.add(c) },
      childNodes: [{ nodeType: 1, textContent: 'support_agent' }, { nodeType: 3, textContent: rotulo }],
      querySelectorAll: () => [],
      getAttribute: (n) => (Object.hasOwn(atributos, n) ? atributos[n] : null),
      setAttribute: (n, v) => { atributos[n] = String(v); },
      removeAttribute: (n) => { delete atributos[n]; },
    };
  };
  const raizCom = (itens) => ({ querySelectorAll: (sel) => (sel === '.nav a' ? itens : []) });

  test('PAGINAS.support abre para qualquer permissão válida, nunca tem "alterar" e continua fechada sem sessão', () => {
    assert.deepEqual(P.PAGINAS.support, { abrir: [], alterar: [] });
    for (const perfil of ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) assert.equal(P.podeAbrir(corpo({ perfil }), 'support'), true, perfil);
    assert.equal(P.podeAlterar(corpo(), 'support'), false);
    assert.equal(P.podeAbrir(null, 'support'), false);
  });

  test('o item "Em integração" vira link real para support.html com qualquer sessão válida (não só MASTER), sem marcador de inspeção', () => {
    for (const perfil of ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
      const suporte = item('Suporte');
      const outro = item('Privacidade / LGPD');
      P.ajustarMenuSuporte(corpo({ perfil }), raizCom([suporte, outro]));
      assert.equal(suporte.atributos.href, 'support.html', perfil);
      assert.doesNotMatch(suporte.atributos.href, /inspecao/);
      assert.equal(suporte.atributos['aria-disabled'], undefined);
      assert.equal(suporte.atributos.title, undefined);
      assert.equal(suporte.classList.contains('nav-pendente'), false);
      assert.equal(outro.atributos.href, undefined, 'nenhum outro item pendente é tocado');
      assert.equal(outro.atributos['aria-disabled'], 'true');
    }
  });

  test('com a consulta falha ou sem sessão: o item ainda "Em integração" fica como está e o já ajustado é escondido sem link', () => {
    const intocado = item('Suporte');
    P.ajustarMenuSuporte(null, raizCom([intocado]));
    assert.deepEqual([intocado.atributos.href, intocado.atributos['aria-disabled'], intocado.style.display], [undefined, 'true', undefined]);
    const ajustado = item('Suporte');
    P.ajustarMenuSuporte(corpo(), raizCom([ajustado]));
    P.ajustarMenuSuporte(null, raizCom([ajustado]));
    assert.deepEqual([ajustado.atributos.href, ajustado.style.display], [undefined, 'none']);
    assert.doesNotThrow(() => P.ajustarMenuSuporte(corpo(), null));
  });

  test('a página de Suporte (item estático data-pagina="support") não é duplicada nem reescrita pelo ajuste', () => {
    const estatico = item('Suporte', ['active']);
    estatico.atributos['data-pagina'] = 'support';
    delete estatico.atributos['aria-disabled'];
    P.ajustarMenuSuporte(corpo(), raizCom([estatico]));
    assert.equal(estatico.atributos.href, undefined, 'item estático da própria página não é tocado');
  });
});

describe('Configurações: página pessoal, aberta a qualquer sessão autenticada', () => {
  test('config abre com qualquer conjunto válido de permissões (a conta é da própria pessoa) e nunca tem "alterar" geral; null continua fechado', () => {
    assert.deepEqual(P.PAGINAS.config, { abrir: [], alterar: [] });
    assert.equal(P.podeAbrir(corpo(), 'config'), true);
    assert.equal(P.podeAbrir(corpo({ perfil: 'USUARIO', recursos: {}, acoes: {}, administracao: corpo().administracao }), 'config'), true);
    assert.equal(P.podeAlterar(corpo(), 'config'), false);
    assert.equal(P.podeAbrir(null, 'config'), false);
    // materials como par de comparação: grupos-acesso saiu da navegação em 05/10/2026 (fica 'none' mesmo permitido).
    const links = [linkFalso('config'), linkFalso('materials')];
    P.aplicarMenu(corpo(), links);
    assert.deepEqual(links.map((l) => l.style.display), ['', '']);
    P.aplicarMenu(null, links);
    assert.deepEqual(links.map((l) => l.style.display), ['none', 'none']);
  });
});

describe('páginas (inspeção estática)', () => {
  const ler = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
  const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // As quatro telas legadas de grupos e autorizações foram APOSENTADAS: só redirecionam para a Gestão de Usuários.
  for (const pagina of PAGINAS) {
    test(`${pagina}: aposentada — sem módulo, sem API, sem armazenamento, e redireciona para a Gestão de Usuários`, () => {
      const html = ler(`pages/${pagina}.html`);
      const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
      assert.deepEqual(scripts, ['../js/tema.js'], 'só o tema; nenhum módulo administrativo');
      const codigo = semComentarios(html);
      assert.equal(/EpiHttp|EpiPermissoes|requisitar|fetch\(|XMLHttpRequest|localStorage|sessionStorage|innerHTML/.test(codigo), false);
      assert.match(html, /http-equiv="refresh" content="0; url=gestao-usuarios\.html"/);
      assert.match(codigo, /window\.location\.replace\(/);
      assert.match(html, /<a href="gestao-usuarios\.html" id="destino">Gestão de Usuários<\/a>/);
      assert.equal(/<form|<input|<button|<table|<select/.test(codigo), false, 'nenhum controle administrativo');
    });
  }

  test('portal/inicio: os quatro módulos administrativos (e, desde a C2, Materiais) nascem ocultos e dependem das permissões', () => {
    const html = ler('portal/inicio.html');
    const links = [...html.matchAll(/<a [^>]*data-pagina="([^"]+)"[^>]*>/g)];
    // E10: na ordem do menu (fechamento-e10.test.js confere a ordem); 12G-1: as três páginas da solicitação.
    assert.deepEqual(links.map((m) => m[1]), ['dashboard', 'reports', 'materials', 'stockValidity', 'availableItems', 'operations', 'employeeGroups', 'deliveredItems', 'epiFicha', 'funcionarios', 'employeeHistory',
      'request', 'supervisorApproval', 'stockRequests',
      'grupos-acesso', 'grupo-permissoes', 'grupo-usuarios', 'autorizacoes-individuais', 'importEmployees', 'newUser', 'userAdmin', 'config', 'companyData']);
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
