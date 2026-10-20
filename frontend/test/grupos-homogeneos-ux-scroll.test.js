'use strict';

/**
 * Gestão de GHE: Editar GHE mantém a rolagem para o formulário.
 * EPIs abre o mesmo painel logo abaixo do grupo selecionado, sem rolagem.
 * Consultas, permissões, vínculos e proteção contra respostas antigas permanecem.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const erroApi = (status, codigo) => resposta(status, { status: 'error', codigo, message: 'texto técnico do servidor' });
const semTags = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const OPCOES_ROLAGEM = { behavior: 'smooth', block: 'start' };

const ghe = (extra = {}) => ({ id: 5, codigo: 'GHE-002', nome: 'ALMOXARIFADO', descricao: null, setor: null, funcao: null, riscos: 'Ruído', ativo: true, ...extra });
const GRUPOS = [
  ghe({ id: 1, codigo: null, nome: 'GHE Produção' }), // legado sem código
  ghe(),
  ghe({ id: 6, codigo: 'GHE-003', nome: 'EXPEDIÇÃO' }),
  ghe({ id: 7, codigo: 'GHE-004', nome: 'ANTIGO', ativo: false }),
];
const CATALOGO = [
  { id: 21, nome: 'Capacete', grupo: 'EPI', grupoProtecao: 'Proteção da cabeça', ativo: true },
  { id: 22, nome: 'Luva de Raspa', grupo: 'EPI', grupoProtecao: 'Proteção das mãos', ativo: true },
];
const MATERIAIS = [{ id: 11, nome: 'Luva de raspa', tipo: 'Luva', categoria: 'EPI', codigoInterno: 'EPI-011', prazoUsoDias: 90, ativo: true }];

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoesFetch) => {
      const u = new URL(url);
      chamadas.push({ metodo: opcoesFetch.method, caminho: u.pathname + u.search });
      const r = typeof responder === 'function' ? responder(u, opcoesFetch) : responder;
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
beforeEach(() => servidor(resposta(200, { status: 'ok' })));

/** Servidor em memória: lista de GHE, tipos e materiais do GHE e as escritas aceitas. `intercepta` pode devolver uma resposta (ou promessa). */
function servidorPadrao({ intercepta = () => null, vinculado = new Map([[21, 'OBRIGATORIO']]) } = {}) {
  return (u, o) => {
    const injetada = intercepta(o.method, u.pathname);
    if (injetada) return injetada;
    if (u.pathname === '/api/grupos-homogeneos' && o.method === 'GET') return resposta(200, { status: 'ok', grupos: GRUPOS, total: GRUPOS.length, pagina: 1, limite: 100 });
    if (u.pathname === '/api/grupos-homogeneos' && o.method === 'POST') return resposta(201, { status: 'ok', grupo: ghe({ id: 99, codigo: 'GHE-099', nome: 'NOVO' }) });
    if (u.pathname.endsWith('/importacao/preview')) return resposta(200, previaDe(JSON.parse(o.body).linhas));
    if (u.pathname.endsWith('/importacao/confirmar')) return resposta(200, resultadoDe(previaDe(JSON.parse(o.body).linhas)));
    const m = u.pathname.match(/^\/api\/grupos-homogeneos\/(\d+)(?:\/(tipos-material|materiais|inativar|reativar))?(?:\/(\d+))?$/);
    if (!m) return resposta(500, { status: 'error' });
    const alvo = GRUPOS.find((g) => g.id === Number(m[1]));
    if (!alvo) return erroApi(404, 'GHE_NAO_ENCONTRADO');
    const grupo = { id: alvo.id, nome: alvo.nome, ativo: alvo.ativo };
    if (m[2] === 'tipos-material' && o.method === 'GET') {
      return resposta(200, { status: 'ok', grupo, tipos: CATALOGO.map((t) => ({ ...t, vinculado: vinculado.has(t.id), classificacao: vinculado.get(t.id) ?? null })) });
    }
    if (m[2] === 'materiais' && o.method === 'GET') return resposta(200, { status: 'ok', grupo, materiais: MATERIAIS.map((x) => ({ ...x, vinculado: false })) });
    return resposta(200, { status: 'ok', grupo: alvo, vinculo: {}, removido: true, criado: false, alterado: true });
  };
}
function previaDe(linhas) {
  const lista = linhas.map((l) => ({ linha: l.linha, ghe: l.ghe, descricao: l.descricao, epi: l.epi, classificacao: 'OBRIGATORIO', situacaoGhe: 'GHE_EXISTENTE', situacao: 'VINCULO_EXISTENTE', motivo: null, duplicadaDe: null, aplicavel: true, problemas: [] }));
  return { status: 'ok', resumo: { linhasRecebidas: lista.length, linhasIgnoradas: 0, aplicaveis: lista.length, porSituacao: { VINCULO_EXISTENTE: lista.length }, ghes: { GHE_EXISTENTE: 1 } }, ghes: [], linhas: lista };
}
function resultadoDe(previa) {
  return { ...previa, importacaoId: '3f2b8a52-6f0b-4d2e-9b1c-0a1b2c3d4e5f', resumo: { ...previa.resumo, aplicadas: 0, ghesCriados: 0, ghesComCodigoAtribuido: 0, vinculosCriados: 0, classificacoesAlteradas: 0, semAlteracao: previa.linhas.length, bloqueadas: 0 }, linhas: previa.linhas.map((l) => ({ ...l, resultado: 'SEM_ALTERACAO' })) };
}

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado: o script embutido de employee-groups.html, com scrollIntoView e focus instrumentados
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const acesso = ({ visualizar = true, criar = false, editar = false } = {}) => ({
  permissoes: { recursos: { employeeGroups: { visualizar, criar, editar, excluir: false } }, acoes: {}, administracao: {} }, podeAlterar: editar === true,
});
const ACESSO_TOTAL = acesso({ criar: true, editar: true });
const PK = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function montarPagina(responder, { acessoDaPagina = ACESSO_TOTAL, comScroll = true } = {}) {
  servidor(responder);
  const html = ler('pages/employee-groups.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const rolagens = []; // cada pedido de rolagem, com a fotografia da tela NO MOMENTO do pedido
  const focos = [];
  const foto = () => ({
    formOculto: mapa.formGrupo ? mapa.formGrupo.hidden : undefined,
    titulo: mapa.formGrupoTitulo ? mapa.formGrupoTitulo.textContent : undefined,
    codigo: mapa.gheCodigo ? mapa.gheCodigo.value : undefined,
    nome: mapa.gheNome ? mapa.gheNome.value : undefined,
    focosAteAgora: focos.length,
    tiposGhe: mapa.tiposGhe ? mapa.tiposGhe.textContent : undefined,
    tiposCorpo: mapa.tiposCorpo ? mapa.tiposCorpo.innerHTML : '',
    gheSelecionadoNaLista: mapa.gruposCorpo ? /class="selecionado"/.test(mapa.gruposCorpo.innerHTML) : false,
  });
  const el = (id) => {
    if (mapa[id]) return mapa[id];
    const novo = {
      id, value: '', innerHTML: '', textContent: '', disabled: false, hidden: undefined, style: {}, listeners: {}, files: [],
      appendChild(no) { no.parentNode = this; return no; },
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
      focus(opcoes) { focos.push({ id, opcoes }); },
      click() {},
    };
    if (comScroll) novo.scrollIntoView = function scrollIntoView(opcoes) { rolagens.push({ id, opcoes, estado: foto() }); };
    mapa[id] = novo;
    return novo;
  };
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, confirm: () => true, readXlsxFile: async () => [{ data: [['GHE', 'DESCRIÇÃO', 'EPI', 'CLASSIFICAÇÃO'], ['GHE-002', 'ALMOXARIFADO', 'Capacete', 'Obrigatório']] }] },
    EpiHttp, EpiGruposHomogeneos: require('../js/grupos-homogeneos'), EpiImportacaoGhe: require('../js/importacao-ghe'), // eslint-disable-line global-require
    EpiPermissoes: { prepararPagina: async () => acessoDaPagina },
    EpiSessaoEmpresarial: { montar: async () => CONTEXTO, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, setTimeout, Promise, String, Number, Array, Object, JSON, Uint8Array,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const evento = (acao, id) => ({ getAttribute: (n) => ({ 'data-acao': acao, 'data-id': String(id) })[n] ?? null, closest() { return this; } });
  const disparar = async (id, ev, alvo) => { for (const fn of (el(id).listeners[ev] || [])) await fn({ target: alvo, preventDefault() {} }); await esperar(); };
  const dispararSemEsperar = (id, ev, alvo) => Promise.all((el(id).listeners[ev] || []).map((fn) => fn({ target: alvo, preventDefault() {} })));
  return {
    el, sandbox, esperar, rolagens, focos,
    clicar: (id) => disparar(id, 'click', undefined),
    acaoGrupo: (acao, id) => disparar('gruposCorpo', 'click', evento(acao, id)),
    acaoGrupoSemEsperar: (acao, id) => dispararSemEsperar('gruposCorpo', 'click', evento(acao, id)),
    acaoTipo: (acao, id) => disparar('tiposCorpo', 'click', evento(acao, id)),
    escolherTipo: (id, valor) => disparar('tiposCorpo', 'change', { getAttribute: (n) => ({ 'data-tipo-id': String(id) })[n] ?? null, value: valor, closest() { return this; } }),
    marcarMaterial: (id, checked) => disparar('matrizCorpo', 'change', { getAttribute: (n) => ({ 'data-material-id': String(id) })[n] ?? null, checked }),
    escolherArquivo: async () => {
      el('arquivoImportacaoGhe').files = [{ name: 'ghe.xlsx', size: 2048, slice: () => ({ arrayBuffer: async () => PK.buffer }) }];
      await disparar('arquivoImportacaoGhe', 'change', el('arquivoImportacaoGhe'));
    },
    iniciar: async () => { await esperar(); },
  };
}

/** Exige exatamente um pedido de rolagem, devolve-o (e falha com mensagem clara, nunca com TypeError). */
function umaRolagem(pg, idEsperado, quando) {
  assert.equal(pg.rolagens.length, 1, `${quando}: esperava 1 pedido de rolagem; houve ${pg.rolagens.length}`);
  const r = pg.rolagens[0];
  assert.equal(r.id, idEsperado, `${quando}: a rolagem deveria ir para #${idEsperado}`);
  assert.deepEqual({ ...r.opcoes }, OPCOES_ROLAGEM, `${quando}: scrollIntoView({ behavior: 'smooth', block: 'start' })`);
  return r;
}

// ───────────────────────────────────────────────────────────────────
describe('inspeção estática: pages/employee-groups.html', () => {
  const html = ler('pages/employee-groups.html');

  test('a seção "EPIs do GHE" tem um alvo próprio (#painelEpisGhe) que contém o título e a tabela do bloco principal, e não o bloco de materiais', () => {
    const abertura = html.search(/<section[^>]*\bid="painelEpisGhe"[^>]*>/);
    assert.ok(abertura >= 0, 'falta <section id="painelEpisGhe"> envolvendo o bloco "EPIs do GHE"');
    const secao = html.slice(abertura, html.indexOf('</section>', abertura));
    assert.ok(secao.includes('id="tiposTitulo"') && secao.includes('id="tiposGhe"') && secao.includes('id="tiposCorpo"'), 'o painel precisa conter tiposTitulo, tiposGhe e tiposCorpo');
    assert.equal(secao.includes('id="matrizTitulo"') || secao.includes('id="matrizCorpo"'), false, 'o bloco de materiais diretos fica fora do painel');
    assert.equal((html.match(/id="painelEpisGhe"/g) || []).length, 1, 'id único');
  });

  test('o formulário (#formGrupo) continua sendo o alvo do Editar e nenhum outro lugar da página usa scroll próprio', () => {
    assert.ok(html.includes('id="formGrupo"'));
    assert.equal(/window\.scroll|scrollTo\(|location\.hash/.test(html.replace(/<!--[\s\S]*?-->/g, '')), false);
  });
});

describe('Editar: abre o formulário e rola até o início dele', () => {
  test('um pedido de rolagem para #formGrupo, com smooth/start, feito DEPOIS de o formulário estar aberto e preenchido', async () => {
    const pg = montarPagina(servidorPadrao());
    await pg.iniciar();
    assert.equal(pg.rolagens.length, 0, 'abrir a página não rola');
    await pg.acaoGrupo('editar', 5);
    const r = umaRolagem(pg, 'formGrupo', 'Editar GHE-002');
    assert.equal(r.estado.formOculto, false, 'o formulário já estava visível');
    assert.equal(r.estado.titulo, 'Editar GHE');
    assert.equal(r.estado.codigo, 'GHE-002');
    assert.equal(r.estado.nome, 'ALMOXARIFADO');
  });

  test('GHE legado sem código também rola, com o formulário já preenchido', async () => {
    const pg = montarPagina(servidorPadrao());
    await pg.iniciar();
    await pg.acaoGrupo('editar', 1);
    const r = umaRolagem(pg, 'formGrupo', 'Editar GHE legado');
    assert.equal(r.estado.formOculto, false);
    assert.equal(r.estado.codigo, '');
    assert.equal(r.estado.nome, 'GHE Produção');
  });

  test('o comportamento existente do Editar continua: formulário aberto e preenchido, foco no campo Descrição', async () => {
    const pg = montarPagina(servidorPadrao());
    await pg.iniciar();
    await pg.acaoGrupo('editar', 5);
    assert.equal(pg.el('formGrupo').hidden, false);
    assert.equal(pg.el('formGrupoTitulo').textContent, 'Editar GHE');
    assert.deepEqual([pg.el('gheCodigo').value, pg.el('gheNome').value, pg.el('gheRiscos').value], ['GHE-002', 'ALMOXARIFADO', 'Ruído']);
    assert.ok(pg.focos.some((f) => f.id === 'gheNome'), 'o foco continua indo para a Descrição');
  });

  test('o foco não disputa a rolagem suave: a rolagem é pedida antes e o foco usa preventScroll', async () => {
    const pg = montarPagina(servidorPadrao());
    await pg.iniciar();
    await pg.acaoGrupo('editar', 5);
    const r = umaRolagem(pg, 'formGrupo', 'Editar GHE-002');
    assert.equal(r.estado.focosAteAgora, 0, 'o foco só acontece depois do pedido de rolagem');
    const foco = pg.focos.find((f) => f.id === 'gheNome');
    assert.ok(foco, 'o foco continua indo para a Descrição');
    assert.deepEqual({ ...foco.opcoes }, { preventScroll: true });
  });

  test('cada clique em Editar é um pedido de rolagem (reabrir o mesmo GHE rola de novo)', async () => {
    const pg = montarPagina(servidorPadrao());
    await pg.iniciar();
    await pg.acaoGrupo('editar', 5);
    await pg.acaoGrupo('editar', 5);
    await pg.acaoGrupo('editar', 6);
    assert.equal(pg.rolagens.length, 3, 'três cliques, três pedidos');
    assert.deepEqual(pg.rolagens.map((r) => r.id), ['formGrupo', 'formGrupo', 'formGrupo']);
  });

  test('sem permissão de editar não há Editar: clicar na ação não abre o formulário nem rola', async () => {
    const pg = montarPagina(servidorPadrao(), { acessoDaPagina: acesso({ criar: false, editar: false }) });
    await pg.iniciar();
    await pg.acaoGrupo('editar', 5);
    assert.equal(pg.el('formGrupo').hidden === false, false);
    assert.equal(pg.rolagens.length, 0);
  });
});

describe('EPIs: abre junto ao grupo selecionado sem rolar', () => {
  test('abre o painel no destino do grupo e mantém as duas consultas', async () => {
    const pg = montarPagina(servidorPadrao());
    await pg.iniciar();
    await pg.acaoGrupo('selecionar', 5);
    assert.equal(pg.rolagens.length, 0);
    assert.equal(pg.el('painelEpisGhe').parentNode.id, 'episGhePosicao5');
    assert.match(pg.el('tiposGhe').textContent, /GHE-002/);
    assert.match(pg.el('tiposCorpo').innerHTML, /data-tipo-id="21"/);
    assert.match(pg.el('matrizCorpo').innerHTML, /data-material-id="11"/);
    const foco = pg.focos.find((f) => f.id === 'painelEpisGhe');
    assert.deepEqual({ ...foco.opcoes }, { preventScroll: true });
  });

  test('trocar ou reabrir o GHE move o mesmo painel e não rola', async () => {
    const pg = montarPagina(servidorPadrao());
    await pg.iniciar();
    const painel = pg.el('painelEpisGhe');
    for (const id of [5, 5, 6]) {
      await pg.acaoGrupo('selecionar', id);
      assert.equal(pg.el('painelEpisGhe'), painel);
      assert.equal(painel.parentNode.id, 'episGhePosicao' + id);
    }
    assert.equal(pg.rolagens.length, 0);
  });

  test('somente leitura e erro de consulta também não rolam', async () => {
    const pg = montarPagina(servidorPadrao({ intercepta: (metodo, caminho) => (/\/tipos-material$/.test(caminho) && metodo === 'GET' ? erroApi(500, 'ERRO_INTERNO') : null) }), { acessoDaPagina: acesso({ criar: false, editar: false }) });
    await pg.iniciar();
    await pg.acaoGrupo('selecionar', 5);
    assert.equal(pg.el('painelEpisGhe').parentNode.id, 'episGhePosicao5');
    assert.match(semTags(pg.el('tiposCorpo').innerHTML), /Não foi possível/);
    assert.equal(pg.rolagens.length, 0);
  });

  test('resposta antiga não troca o painel do GHE mais recente', async () => {
    let liberar;
    const porta = new Promise((r) => { liberar = r; });
    const padrao = servidorPadrao();
    const pg = montarPagina((u, o) => (o.method === 'GET' && u.pathname === '/api/grupos-homogeneos/5/tipos-material' ? porta.then(() => padrao(u, o)) : padrao(u, o)));
    await pg.iniciar();
    const primeira = pg.acaoGrupoSemEsperar('selecionar', 5);
    await pg.esperar();
    await pg.acaoGrupo('selecionar', 6);
    liberar(); await primeira; await pg.esperar();
    assert.equal(pg.el('painelEpisGhe').parentNode.id, 'episGhePosicao6');
    assert.match(pg.el('tiposGhe').textContent, /GHE-003/);
    assert.equal(pg.rolagens.length, 0);
  });

  test('401 encerra a sessão, recolhe o editor e não rola', async () => {
    const pg = montarPagina(servidorPadrao({ intercepta: (metodo, caminho) => (/\/tipos-material$/.test(caminho) && metodo === 'GET' ? erroApi(401, 'SESSAO_INVALIDA') : null) }));
    await pg.iniciar();
    await pg.acaoGrupo('selecionar', 5);
    assert.equal(pg.sandbox.encerrada, true);
    assert.equal(pg.rolagens.length, 0);
  });
});

describe('as outras ações NÃO rolam a página', () => {
  test('Novo GHE, cancelar, salvar, inativar e reativar', async () => {
    const pg = montarPagina(servidorPadrao());
    await pg.iniciar();
    await pg.clicar('botaoNovoGrupo');
    assert.equal(pg.el('formGrupo').hidden, false, 'o formulário abriu');
    pg.el('gheCodigo').value = 'GHE-099';
    pg.el('gheNome').value = 'NOVO';
    await pg.clicar('botaoSalvarGrupo');
    await pg.clicar('botaoNovoGrupo');
    await pg.clicar('botaoCancelarGrupo');
    await pg.acaoGrupo('inativar', 6);
    await pg.acaoGrupo('reativar', 7);
    assert.equal(pg.rolagens.length, 0, `rolagens indevidas: ${JSON.stringify(pg.rolagens.map((r) => r.id))}`);
  });

  test('importação: abrir o seletor, escolher o arquivo, confirmar e cancelar', async () => {
    const pg = montarPagina(servidorPadrao());
    await pg.iniciar();
    await pg.clicar('botaoImportarGhe');
    await pg.escolherArquivo();
    await pg.clicar('botaoConfirmarImportacao');
    await pg.escolherArquivo();
    await pg.clicar('botaoCancelarImportacao');
    assert.equal(pg.rolagens.length, 0, `rolagens indevidas: ${JSON.stringify(pg.rolagens.map((r) => r.id))}`);
  });

  test('dentro do painel aberto: vincular, alterar e desvincular tipo, marcar material, salvar e descartar não rolam de novo', async () => {
    const pg = montarPagina(servidorPadrao());
    await pg.iniciar();
    await pg.acaoGrupo('selecionar', 5);
    assert.equal(pg.rolagens.length, 0, 'abrir EPIs não rola');
    await pg.escolherTipo(22, 'NAO_OBRIGATORIO');
    await pg.acaoTipo('vincular-tipo', 22);
    await pg.escolherTipo(21, 'NAO_OBRIGATORIO');
    await pg.acaoTipo('alterar-tipo', 21);
    await pg.acaoTipo('desvincular-tipo', 21);
    await pg.marcarMaterial(11, true);
    await pg.clicar('botaoSalvarMatriz');
    await pg.marcarMaterial(11, false);
    await pg.clicar('botaoDescartarMatriz');
    assert.equal(pg.rolagens.length, 0, `rolagens indevidas: ${JSON.stringify(pg.rolagens.map((r) => r.id))}`);
  });
});

describe('navegador sem scrollIntoView', () => {
  test('Editar e EPIs funcionam normalmente e nada quebra (a rolagem só é pedida quando o elemento sabe rolar)', async () => {
    const pg = montarPagina(servidorPadrao(), { comScroll: false });
    await pg.iniciar();
    await pg.acaoGrupo('editar', 5);
    assert.equal(pg.el('formGrupo').hidden, false);
    assert.equal(pg.el('gheNome').value, 'ALMOXARIFADO');
    await pg.acaoGrupo('selecionar', 5);
    assert.match(pg.el('tiposCorpo').innerHTML, /data-tipo-id="21"/);
    assert.match(pg.el('matrizCorpo').innerHTML, /data-material-id="11"/);
    assert.equal(pg.rolagens.length, 0);
  });
});

// Estrutura com parser DOM: comprova posição, identidade dos nós e preservação
// durante o redesenho da lista, além dos testes de fluxo com elementos instrumentados.
async function montarEstrutura() {
  const { abrirPagina } = require('./helpers/dom-pagina');
  const html = ler('pages/employee-groups.html');
  const doc = abrirPagina('pages/employee-groups.html', {
    html: html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''),
  }).documento;
  // O helper compartilhado só registra innerHTML. Aqui o parser existente
  // materializa os corpos de tabela para exercitar a movimentação dos nós.
  for (const id of ['gruposCorpo', 'tiposCorpo', 'matrizCorpo']) {
    const corpo = doc.getElementById(id);
    let bruto = '';
    Object.defineProperty(corpo, 'innerHTML', {
      get() { return bruto; },
      set(valor) {
        bruto = String(valor);
        const fragmento = abrirPagina('pages/employee-groups.html', {
          html: '<table><tbody id="fragmento">' + bruto + '</tbody></table>',
        }).documento.getElementById('fragmento');
        corpo.replaceChildren(...fragmento.children);
      },
    });
  }
  servidor(servidorPadrao());
  let opcoesSessao;
  const sandbox = {
    document: doc,
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, confirm: () => true },
    EpiHttp,
    EpiGruposHomogeneos: require('../js/grupos-homogeneos'),
    EpiImportacaoGhe: require('../js/importacao-ghe'),
    EpiPermissoes: { prepararPagina: async () => ACESSO_TOTAL },
    EpiSessaoEmpresarial: { montar: async (o) => { opcoesSessao = o; return CONTEXTO; }, sessaoEncerrada() { opcoesSessao.aoEncerrar(); } },
    console, setTimeout, Promise, String, Number, Array, Object, JSON, Uint8Array,
  };
  vm.runInNewContext(html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>')), sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  await esperar();
  return { doc, esperar, encerrar: () => opcoesSessao.aoEncerrar() };
}

describe('EPIs inline — estrutura do DOM', () => {
  test('o editor fica imediatamente depois da linha selecionada e antes do próximo GHE', async () => {
    const { doc, esperar } = await montarEstrutura();
    const painel = doc.getElementById('painelEpisGhe');
    const corpo = doc.getElementById('gruposCorpo');
    assert.equal(painel.parentNode.id, 'painelEpisGheOrigem');
    await corpo.querySelector('[data-acao="selecionar"][data-id="5"]').click();
    await esperar();
    assert.equal(doc.getElementById('episGhePosicao5').children[0], painel);
    const indice = corpo.children.findIndex((n) => n.classList.contains('selecionado'));
    assert.equal(corpo.children[indice + 1].classList.contains('linha-epis-ghe'), true);
    assert.equal(corpo.children[indice + 1].children[0].getAttribute('colspan'), '4');
    assert.equal(corpo.children[indice + 2].querySelector('[data-acao="selecionar"]').getAttribute('data-id'), '6');
    assert.equal(doc.querySelectorAll('#painelEpisGhe').length, 1);
  });

  test('troca de grupo e recarga da lista preservam painel e controles; logout recolhe o editor', async () => {
    const { doc, esperar, encerrar } = await montarEstrutura();
    const painel = doc.getElementById('painelEpisGhe');
    const tipos = doc.getElementById('tiposCorpo');
    for (const id of [5, 6]) {
      await doc.querySelector('[data-acao="selecionar"][data-id="' + id + '"]').click();
      await esperar();
      assert.equal(doc.getElementById('painelEpisGhe'), painel);
      assert.equal(doc.getElementById('tiposCorpo'), tipos);
      assert.equal(painel.parentNode.id, 'episGhePosicao' + id);
    }
    await doc.querySelector('[data-acao="inativar"][data-id="5"]').click();
    await esperar();
    assert.equal(doc.getElementById('painelEpisGhe'), painel);
    assert.equal(painel.parentNode.id, 'episGhePosicao6');
    assert.equal(tipos.querySelectorAll('[data-tipo-id]').length > 0, true);
    encerrar();
    assert.equal(painel.parentNode.id, 'painelEpisGheOrigem');
    assert.equal(doc.getElementById('painelEpisGheOrigem').hidden, true);
    assert.equal(tipos.innerHTML, '');
  });
});
