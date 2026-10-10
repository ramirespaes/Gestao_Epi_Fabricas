'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');

/**
 * Incremento 6B (RED): "EPIs" do GHE passa a ser a gestão GHE × TIPO de material (API do Incremento 3), com os vínculos
 * diretos GHE × material (ghe_materiais) mantidos num bloco SECUNDÁRIO, independente.
 *
 * Área aberta pela ação EPIs (data-acao="selecionar"; faz DUAS leituras: tipos e materiais):
 *   BLOCO PRINCIPAL  "EPIs / Tipos previstos para o GHE"   (#tiposTitulo, #tiposGhe, tbody #tiposCorpo)
 *     cabeçalho: "EPIs do GHE" e a identificação "GHE-002 · ALMOXARIFADO" (legado sem código: só a descrição);
 *     colunas: EPI / Tipo | Grupo | Grupo de Proteção | Situação | Classificação | Ação
 *     linha: <tr data-tipo-id="ID">; a classificação aparece humanizada (Obrigatório / Não obrigatório), nunca o enum;
 *       - tipo ativo NÃO vinculado: <select data-tipo-id> com "Selecione…" marcado e as duas classificações (nada é escolhido
 *         pela tela) + botão data-acao="vincular-tipo"; sem escolha não há chamada;
 *       - tipo vinculado (ativo ou inativo): <select data-tipo-id> com a classificação atual marcada + botões
 *         data-acao="alterar-tipo" e data-acao="desvincular-tipo" (esta com confirmação); a mesma classificação não escreve;
 *       - GHE inativo: nenhuma linha oferece vincular (sem depender do 409), mas o vínculo existente segue editável e removível;
 *       - sem editar: só texto, sem select nem botões;
 *       - chamadas: PUT /grupos-homogeneos/:id/tipos-material/:tipoId { classificacao } e DELETE no mesmo caminho; depois de cada
 *         operação (e depois de qualquer falha) a lista é lida de novo: a tela mostra o estado do servidor, nunca uma escolha falsa.
 *   BLOCO SECUNDÁRIO "Vínculos diretos de materiais — exceções / legado"  (os ids e o comportamento atuais: #matrizTitulo,
 *     #matrizCorpo, #botaoSalvarMatriz, #botaoDescartarMatriz, #matrizResumo): continua usando /materiais; sem classificação;
 *     independente do bloco por tipo (vincular um tipo não cria vínculo direto e desvincular não remove o direto).
 * O botão "Importar GHE / EPIs" segue só como ponto de entrada (6C).
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const modulo = () => require('../js/grupos-homogeneos'); // eslint-disable-line global-require
// Função do módulo que ainda não existe no RED: ao ser chamada falha com asserção clara (nunca TypeError).
const exigir = (objeto, rotulo) => new Proxy(objeto, { get: (alvo, nome) => (nome in alvo ? alvo[nome] : () => assert.fail(`ainda não implementado: ${rotulo}.${String(nome)}`)) });
const api = () => { const m = modulo(); return { acoes: exigir(m.acoes, 'acoes'), render: exigir(m.render, 'render'), mensagens: exigir(m.mensagens, 'mensagens') }; };
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const erroApi = (status, codigo, detalhes) => resposta(status, { status: 'error', codigo, message: 'texto técnico do servidor', ...(detalhes ? { detalhes } : {}) });
const semTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const celulas = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
const linhaDoTipo = (html, id) => (html.match(new RegExp(`<tr[^>]*data-tipo-id="${id}"[^>]*>[\\s\\S]*?</tr>`)) || [''])[0];
const opcoes = (html) => [...html.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => ({ valor: m[1], marcada: m[2] !== undefined, texto: m[3] }));
const acoesDa = (html) => [...html.matchAll(/data-acao="([a-z-]+)"/g)].map((m) => m[1]);

const ghe = (extra = {}) => ({ id: 5, codigo: 'GHE-002', nome: 'ALMOXARIFADO', descricao: null, setor: null, funcao: null, riscos: null, ativo: true, ...extra });
const tipo = (extra = {}) => ({ id: 21, nome: 'Capacete', grupo: 'EPI', grupoProtecao: 'Proteção da cabeça', ativo: true, vinculado: false, classificacao: null, ...extra });
const material = (extra = {}) => ({ id: 11, nome: 'Luva de raspa', tipo: 'Luva', categoria: 'EPI', codigoInterno: 'EPI-011', prazoUsoDias: 90, ativo: true, ...extra });
const listaGrupos = (grupos) => ({ status: 'ok', grupos, total: grupos.length, pagina: 1, limite: 100 });

// Catálogo da empresa (o servidor só devolve ativos + inativos já vinculados, como a API real).
const CATALOGO = [
  { id: 21, nome: 'Capacete', grupo: 'EPI', grupoProtecao: 'Proteção da cabeça', ativo: true },
  { id: 22, nome: 'Luva de Raspa', grupo: 'EPI', grupoProtecao: 'Proteção das mãos', ativo: true },
  { id: 23, nome: 'Bota Antiga', grupo: 'EPI', grupoProtecao: 'Proteção dos pés', ativo: false },
  { id: 24, nome: 'Jaleco', grupo: 'Vestimenta', grupoProtecao: 'Proteção do tronco', ativo: true },
  { id: 25, nome: 'Tipo Inativo Solto', grupo: 'EPI', grupoProtecao: 'Proteção auditiva', ativo: false },
];

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoesFetch) => {
      const u = new URL(url);
      chamadas.push({ metodo: opcoesFetch.method, caminho: u.pathname + u.search, corpo: opcoesFetch.body === undefined ? undefined : JSON.parse(opcoesFetch.body) });
      const r = typeof responder === 'function' ? responder(u, opcoesFetch) : responder;
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
beforeEach(() => servidor(resposta(200, listaGrupos([ghe()]))));

/** Servidor em memória: GHEs, GHE × tipo (contrato do Incremento 3) e GHE × material (contrato antigo), independentes. */
function servidorCompleto({ grupos = [ghe()], vinculos = { 22: 'OBRIGATORIO', 23: 'NAO_OBRIGATORIO' }, diretos = [11], falhar = () => null } = {}) {
  const estado = { grupos: grupos.map((g) => ({ ...g })), vinculos: new Map(Object.entries(vinculos).map(([k, v]) => [Number(k), v])), diretos: new Set(diretos) };
  const materiais = [material(), material({ id: 12, nome: 'Óculos de proteção' })];
  const responder = (u, o) => {
    const injetada = falhar(o.method, u.pathname);
    if (injetada) return injetada;
    const corpo = o.body === undefined ? undefined : JSON.parse(o.body);
    if (u.pathname === '/api/grupos-homogeneos' && o.method === 'GET') return resposta(200, listaGrupos(estado.grupos));
    const m = u.pathname.match(/^\/api\/grupos-homogeneos\/(\d+)\/(tipos-material|materiais)(?:\/(\d+))?$/);
    if (!m) return resposta(500, { status: 'error' });
    const alvo = estado.grupos.find((g) => g.id === Number(m[1]));
    if (!alvo) return erroApi(404, 'GHE_NAO_ENCONTRADO');
    const id = m[3] === undefined ? null : Number(m[3]);
    if (m[2] === 'tipos-material') {
      if (o.method === 'GET') {
        const tipos = CATALOGO.filter((t) => t.ativo || estado.vinculos.has(t.id)).map((t) => ({ ...t, vinculado: estado.vinculos.has(t.id), classificacao: estado.vinculos.get(t.id) ?? null }));
        return resposta(200, { status: 'ok', grupo: { id: alvo.id, nome: alvo.nome, ativo: alvo.ativo }, tipos });
      }
      const catalogado = CATALOGO.find((t) => t.id === id);
      if (o.method === 'PUT') {
        if (!['OBRIGATORIO', 'NAO_OBRIGATORIO'].includes(corpo && corpo.classificacao)) return erroApi(400, 'VALIDACAO');
        if (!catalogado) return erroApi(404, 'TIPO_MATERIAL_NAO_ENCONTRADO');
        if (!estado.vinculos.has(id)) {
          if (!alvo.ativo) return erroApi(409, 'GHE_INATIVO');
          if (!catalogado.ativo) return erroApi(409, 'TIPO_MATERIAL_INATIVO');
        }
        const existia = estado.vinculos.has(id);
        estado.vinculos.set(id, corpo.classificacao);
        return resposta(existia ? 200 : 201, { status: 'ok', vinculo: { grupoHomogeneoId: alvo.id, tipoMaterialId: id, classificacao: corpo.classificacao }, criado: !existia, alterado: true });
      }
      if (o.method === 'DELETE') {
        if (!estado.vinculos.has(id)) return erroApi(404, 'GHE_TIPO_MATERIAL_NAO_VINCULADO');
        estado.vinculos.delete(id);
        return resposta(200, { status: 'ok', removido: true });
      }
    }
    if (m[2] === 'materiais') {
      if (o.method === 'GET') return resposta(200, { status: 'ok', grupo: { id: alvo.id, nome: alvo.nome, ativo: alvo.ativo }, materiais: materiais.map((x) => ({ ...x, vinculado: estado.diretos.has(x.id) })) });
      if (o.method === 'POST') { estado.diretos.add(corpo.materialId); return resposta(201, { status: 'ok', vinculo: {} }); }
      if (o.method === 'DELETE') { estado.diretos.delete(id); return resposta(200, { status: 'ok', removido: true }); }
    }
    return resposta(500, { status: 'error' });
  };
  return { estado, responder };
}

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado: o script embutido de employee-groups.html
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const acesso = ({ visualizar = true, criar = false, editar = false } = {}) => ({
  permissoes: { recursos: { employeeGroups: { visualizar, criar, editar, excluir: false } }, acoes: {}, administracao: {} }, podeAlterar: editar === true,
});
const ACESSO_TOTAL = acesso({ criar: true, editar: true });

function montarPagina(responder, { acessoDaPagina = ACESSO_TOTAL, confirmar = true } = {}) {
  servidor(responder);
  const html = ler('pages/employee-groups.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', innerHTML: '', textContent: '', disabled: false, hidden: undefined, style: {}, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    focus() {}, click() { this.cliques = (this.cliques || 0) + 1; },
  });
  const confirmacoes = [];
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, confirm: (pergunta) => { confirmacoes.push(pergunta); return confirmar; } },
    EpiHttp, EpiGruposHomogeneos: modulo(), EpiImportacaoGhe: require('../js/importacao-ghe'), // eslint-disable-line global-require
    EpiPermissoes: { prepararPagina: async () => acessoDaPagina },
    EpiSessaoEmpresarial: { montar: async () => CONTEXTO, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, setTimeout, Promise, String, Number, Array, Object, JSON,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, evento, alvo) => { for (const fn of (el(id).listeners[evento] || [])) await fn({ target: alvo, preventDefault() {} }); await esperar(); };
  const clicar = (id) => disparar(id, 'click', undefined);
  const acaoGrupo = (acao, id) => disparar('gruposCorpo', 'click', { getAttribute: (n) => ({ 'data-acao': acao, 'data-id': String(id) })[n] ?? null, closest() { return this; } });
  const acaoTipo = (acao, id) => disparar('tiposCorpo', 'click', { getAttribute: (n) => ({ 'data-acao': acao, 'data-id': String(id) })[n] ?? null, closest() { return this; } });
  const escolher = (id, valor) => disparar('tiposCorpo', 'change', { getAttribute: (n) => ({ 'data-tipo-id': String(id) })[n] ?? null, value: valor, closest() { return this; } });
  const marcarMaterial = (id, checked) => disparar('matrizCorpo', 'change', { getAttribute: (n) => ({ 'data-material-id': String(id) })[n] ?? null, checked });
  const abrirEpis = async (id = 5) => { await esperar(); await acaoGrupo('selecionar', id); };
  return { el, sandbox, esperar, clicar, acaoGrupo, acaoTipo, escolher, marcarMaterial, abrirEpis, confirmacoes };
}

const tipoDaTela = (pg, id) => linhaDoTipo(pg.el('tiposCorpo').innerHTML, id);
const chamadasDeTipos = () => chamadas.filter((c) => /\/tipos-material/.test(c.caminho));
const escritasDeTipos = () => chamadasDeTipos().filter((c) => c.metodo !== 'GET');

// ───────────────────────────────────────────────────────────────────
describe('módulo: ações e mensagens da gestão por tipo', () => {
  test('consultar, definir (PUT com a classificação) e desvincular (DELETE) usam a API do Incremento 3; empresa e ator nunca saem do navegador', async () => {
    const { acoes } = api();
    await acoes.consultarTipos(5);
    await acoes.definirTipo(5, 21, 'OBRIGATORIO');
    await acoes.definirTipo(5, 22, 'NAO_OBRIGATORIO');
    await acoes.desvincularTipo(5, 21);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), [
      'GET /api/grupos-homogeneos/5/tipos-material', 'PUT /api/grupos-homogeneos/5/tipos-material/21', 'PUT /api/grupos-homogeneos/5/tipos-material/22', 'DELETE /api/grupos-homogeneos/5/tipos-material/21',
    ]);
    assert.deepEqual([chamadas[1].corpo, chamadas[2].corpo], [{ classificacao: 'OBRIGATORIO' }, { classificacao: 'NAO_OBRIGATORIO' }]);
    assert.equal(chamadas.some((c) => /empresaId|usuarioId/.test(JSON.stringify(c))), false);
  });

  test('mensagens amigáveis para os erros da gestão por tipo, sem código técnico cru', () => {
    const { mensagens } = api();
    const msg = (status, codigo, detalhes) => mensagens.erro({ ok: false, status, codigo, detalhes });
    assert.match(msg(404, 'GHE_NAO_ENCONTRADO'), /GHE não encontrado/);
    assert.match(msg(409, 'GHE_INATIVO'), /GHE inativo/);
    assert.match(msg(404, 'TIPO_MATERIAL_NAO_ENCONTRADO'), /Tipo de EPI não encontrado/);
    assert.match(msg(409, 'TIPO_MATERIAL_INATIVO'), /Tipo de EPI inativo/);
    assert.match(msg(404, 'GHE_TIPO_MATERIAL_NAO_VINCULADO'), /já não estava vinculado/);
    assert.match(msg(400, 'VALIDACAO'), /inválidos/i);
    assert.match(msg(400, 'VALIDACAO', [{ campo: 'body.empresaId', codigo: 'CAMPO_NAO_PERMITIDO' }]), /inválidos/i);
    for (const [s, c] of [[404, 'GHE_NAO_ENCONTRADO'], [409, 'GHE_INATIVO'], [404, 'TIPO_MATERIAL_NAO_ENCONTRADO'], [409, 'TIPO_MATERIAL_INATIVO'], [404, 'GHE_TIPO_MATERIAL_NAO_VINCULADO'], [400, 'VALIDACAO']]) {
      assert.equal(/[A-Z]{3,}_[A-Z_]+/.test(msg(s, c)), false, c);
    }
  });
});

describe('render: identificação do GHE e rótulos humanos', () => {
  test('cabeçalho "GHE-002 · ALMOXARIFADO"; legado sem código mostra só a descrição, sem inventar código', () => {
    const { render } = api();
    assert.equal(render.identificacaoDoGhe({ codigo: 'GHE-002', nome: 'ALMOXARIFADO' }), 'GHE-002 · ALMOXARIFADO');
    assert.equal(render.identificacaoDoGhe({ codigo: null, nome: 'ALMOXARIFADO' }), 'ALMOXARIFADO');
    assert.equal(render.identificacaoDoGhe({ nome: 'ALMOXARIFADO' }), 'ALMOXARIFADO');
  });

  test('a classificação aparece humanizada; o enum técnico nunca vira texto da tela', () => {
    const { render } = api();
    assert.equal(render.rotuloClassificacao('OBRIGATORIO'), 'Obrigatório');
    assert.equal(render.rotuloClassificacao('NAO_OBRIGATORIO'), 'Não obrigatório');
    assert.equal(render.rotuloClassificacao(null), '—');
  });
});

describe('render.linhasTipos: uma linha por tipo, com as ações certas para cada situação', () => {
  const todos = () => [
    tipo({ id: 21 }),
    tipo({ id: 22, nome: 'Luva de Raspa', grupoProtecao: 'Proteção das mãos', vinculado: true, classificacao: 'OBRIGATORIO' }),
    tipo({ id: 23, nome: 'Bota Antiga', grupoProtecao: 'Proteção dos pés', ativo: false, vinculado: true, classificacao: 'NAO_OBRIGATORIO' }),
  ];

  test('seis células por linha: EPI / Tipo, Grupo, Grupo de Proteção, Situação, Classificação, Ação — texto humanizado', () => {
    const { render } = api();
    const linhas = celulas(render.linhasTipos(todos(), { podeEditar: false, gheAtivo: true }));
    assert.equal(linhas.length, 3);
    for (const l of linhas) assert.equal(l.length, 6);
    assert.deepEqual(linhas[1].slice(0, 5).map(semTags), ['Luva de Raspa', 'EPI', 'Proteção das mãos', 'Ativo', 'Obrigatório']);
    assert.deepEqual(linhas[2].slice(0, 5).map(semTags), ['Bota Antiga', 'EPI', 'Proteção dos pés', 'Inativo', 'Não obrigatório']);
    assert.equal(/OBRIGATORIO/.test(semTags(render.linhasTipos(todos(), { podeEditar: true, gheAtivo: true }))), false, 'sem enum cru no texto visível');
  });

  test('tipo ativo não vinculado: a classificação NÃO vem escolhida ("Selecione…") e a ação é Vincular', () => {
    const { render } = api();
    const linha = linhaDoTipo(render.linhasTipos(todos(), { podeEditar: true, gheAtivo: true }), 21);
    assert.deepEqual(opcoes(linha), [
      { valor: '', marcada: true, texto: 'Selecione…' }, { valor: 'OBRIGATORIO', marcada: false, texto: 'Obrigatório' }, { valor: 'NAO_OBRIGATORIO', marcada: false, texto: 'Não obrigatório' },
    ]);
    assert.match(linha, /<select[^>]*data-tipo-id="21"/);
    assert.deepEqual(acoesDa(linha), ['vincular-tipo']);
  });

  test('tipo vinculado (ativo ou inativo): mostra a classificação atual marcada e oferece Alterar e Desvincular; sem reativar o tipo', () => {
    const { render } = api();
    const html = render.linhasTipos(todos(), { podeEditar: true, gheAtivo: true });
    assert.deepEqual(opcoes(linhaDoTipo(html, 22)).filter((o) => o.marcada).map((o) => o.valor), ['OBRIGATORIO']);
    assert.deepEqual(opcoes(linhaDoTipo(html, 23)).filter((o) => o.marcada).map((o) => o.valor), ['NAO_OBRIGATORIO']);
    assert.deepEqual(acoesDa(linhaDoTipo(html, 22)), ['alterar-tipo', 'desvincular-tipo']);
    assert.deepEqual(acoesDa(linhaDoTipo(html, 23)), ['alterar-tipo', 'desvincular-tipo']);
    assert.match(semTags(linhaDoTipo(html, 23)), /Inativo/);
    assert.equal(/reativar/i.test(html), false);
  });

  test('GHE inativo: nenhum tipo oferece Vincular (nem a escolha); o vínculo existente continua editável e removível', () => {
    const { render } = api();
    const html = render.linhasTipos(todos(), { podeEditar: true, gheAtivo: false });
    assert.deepEqual(acoesDa(linhaDoTipo(html, 21)), []);
    assert.equal(/<select/.test(linhaDoTipo(html, 21)), false);
    assert.deepEqual(acoesDa(linhaDoTipo(html, 22)), ['alterar-tipo', 'desvincular-tipo']);
    assert.deepEqual(acoesDa(linhaDoTipo(html, 23)), ['alterar-tipo', 'desvincular-tipo']);
  });

  test('somente leitura: nenhum select nem botão; a classificação aparece como texto', () => {
    const { render } = api();
    const html = render.linhasTipos(todos(), { podeEditar: false, gheAtivo: true });
    assert.equal(/<select|<button|data-acao/.test(html), false);
    assert.match(semTags(linhaDoTipo(html, 22)), /Obrigatório/);
  });

  test('nomes e grupos são escapados', () => {
    const { render } = api();
    const html = render.linhasTipos([tipo({ nome: '<img src=x onerror=1>', grupoProtecao: '<b>x</b>' })], { podeEditar: true, gheAtivo: true });
    assert.equal(/<img|<b>x/.test(html), false);
    assert.match(html, /&lt;img/);
  });
});

describe('inspeção estática: pages/employee-groups.html', () => {
  const html = ler('pages/employee-groups.html');
  const cabecalhosAntes = (idDoCorpo) => {
    const posicao = html.indexOf(`id="${idDoCorpo}"`);
    const inicio = html.lastIndexOf('<thead>', posicao);
    return [...html.slice(inicio, html.indexOf('</thead>', inicio)).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => semTags(m[1]));
  };

  test('o bloco principal de tipos tem os ids e as colunas definidas e vem antes do bloco de vínculos diretos', () => {
    for (const id of ['tiposTitulo', 'tiposGhe', 'tiposCorpo']) assert.ok(html.includes(`id="${id}"`), `falta #${id}`);
    assert.deepEqual(cabecalhosAntes('tiposCorpo'), ['EPI / Tipo', 'Grupo', 'Grupo de Proteção', 'Situação', 'Classificação', 'Ação']);
    assert.ok(html.indexOf('id="tiposCorpo"') < html.indexOf('id="matrizCorpo"'), 'tipos primeiro, vínculos diretos depois');
    assert.match(html, /EPIs \/ Tipos previstos para o GHE/);
  });

  test('o bloco secundário de vínculos diretos de materiais continua, com o título "exceções / legado" e os mesmos ids', () => {
    for (const id of ['matrizTitulo', 'matrizCorpo', 'botaoSalvarMatriz', 'botaoDescartarMatriz', 'matrizResumo']) assert.ok(html.includes(`id="${id}"`), `falta #${id}`);
    const bloco = html.slice(html.indexOf('id="tiposCorpo"'), html.indexOf('id="matrizCorpo"'));
    assert.match(bloco, /Vínculos diretos de materiais/);
    assert.match(bloco, /[Ee]xceções \/ legado/);
    assert.deepEqual(cabecalhosAntes('matrizCorpo').slice(0, 2), ['Vinculado', 'EPI'], 'a matriz direta mantém as colunas, sem classificação');
    assert.equal(cabecalhosAntes('matrizCorpo').some((c) => /Classifica/.test(c)), false);
  });

  test('os scripts são os do 6C (biblioteca XLSX local e módulo de importação antes do módulo de GHE) e não há armazenamento local', () => {
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../vendor/read-excel-file-9.3.10.min.js', '../js/importacao-ghe.js', '../js/grupos-homogeneos.js']);
    assert.equal(/localStorage|sessionStorage/.test(html.replace(/<!--[\s\S]*?-->/g, '')), false);
  });
});

describe('página (DOM simulado): abrir os EPIs de um GHE', () => {
  test('clicar em EPIs seleciona o GHE e lê os TIPOS (API nova) e os materiais diretos (API antiga); o cabeçalho mostra código e descrição', async () => {
    const srv = servidorCompleto();
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    assert.ok(chamadas.some((c) => c.metodo === 'GET' && c.caminho === '/api/grupos-homogeneos/5/tipos-material'));
    assert.ok(chamadas.some((c) => c.metodo === 'GET' && c.caminho === '/api/grupos-homogeneos/5/materiais'));
    assert.match(pg.el('tiposTitulo').textContent, /EPIs do GHE/);
    assert.equal(pg.el('tiposGhe').textContent, 'GHE-002 · ALMOXARIFADO');
  });

  test('legado sem código: o cabeçalho mostra só a descrição', async () => {
    const pg = montarPagina(servidorCompleto({ grupos: [ghe({ codigo: null })] }).responder);
    await pg.abrirEpis();
    assert.equal(pg.el('tiposGhe').textContent, 'ALMOXARIFADO');
  });

  test('a tabela mostra os tipos ativos e o inativo já vinculado, com grupo, grupo de proteção e classificação humanizada; o inativo solto não aparece', async () => {
    const pg = montarPagina(servidorCompleto().responder, { acessoDaPagina: acesso() });
    await pg.abrirEpis();
    const html = pg.el('tiposCorpo').innerHTML;
    assert.deepEqual(celulas(html).map((l) => l.slice(0, 5).map(semTags)), [
      ['Capacete', 'EPI', 'Proteção da cabeça', 'Ativo', '—'],
      ['Luva de Raspa', 'EPI', 'Proteção das mãos', 'Ativo', 'Obrigatório'],
      ['Bota Antiga', 'EPI', 'Proteção dos pés', 'Inativo', 'Não obrigatório'],
      ['Jaleco', 'Vestimenta', 'Proteção do tronco', 'Ativo', '—'],
    ]);
    assert.equal(html.includes('Tipo Inativo Solto'), false);
    assert.equal(/OBRIGATORIO/.test(semTags(html)), false);
  });
});

describe('página (DOM simulado): vincular, alterar e desvincular tipos', () => {
  test('vincular exige escolher a classificação: sem escolha não há chamada e a tela pede a escolha', async () => {
    const pg = montarPagina(servidorCompleto().responder);
    await pg.abrirEpis();
    const antes = escritasDeTipos().length;
    await pg.acaoTipo('vincular-tipo', 21);
    assert.equal(escritasDeTipos().length, antes);
    assert.match(pg.el('aviso').innerHTML, /classifica/i);
    assert.deepEqual(opcoes(tipoDaTela(pg, 21)).filter((o) => o.marcada).map((o) => o.valor), [''], 'nada foi escolhido pela tela');
  });

  test('vincular com a classificação escolhida: PUT com o valor certo e a lista reflete o servidor', async () => {
    const srv = servidorCompleto();
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    await pg.escolher(21, 'NAO_OBRIGATORIO');
    await pg.acaoTipo('vincular-tipo', 21);
    const put = chamadasDeTipos().find((c) => c.metodo === 'PUT');
    assert.ok(put, 'nenhum PUT foi enviado ao vincular');
    assert.deepEqual([put.caminho, put.corpo], ['/api/grupos-homogeneos/5/tipos-material/21', { classificacao: 'NAO_OBRIGATORIO' }]);
    assert.equal(srv.estado.vinculos.get(21), 'NAO_OBRIGATORIO');
    assert.deepEqual(opcoes(tipoDaTela(pg, 21)).filter((o) => o.marcada).map((o) => o.valor), ['NAO_OBRIGATORIO']);
    assert.deepEqual(acoesDa(tipoDaTela(pg, 21)), ['alterar-tipo', 'desvincular-tipo']);
    assert.equal(chamadasDeTipos().at(-1).metodo, 'GET', 'depois da escrita a lista é lida de novo');
  });

  test('alterar a classificação de um vínculo existente: PUT; a mesma classificação não escreve nada', async () => {
    const srv = servidorCompleto();
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    await pg.acaoTipo('alterar-tipo', 22);
    await pg.escolher(22, 'OBRIGATORIO');
    await pg.acaoTipo('alterar-tipo', 22);
    assert.equal(escritasDeTipos().length, 0, 'sem mudança, sem escrita');

    await pg.escolher(22, 'NAO_OBRIGATORIO');
    await pg.acaoTipo('alterar-tipo', 22);
    const escritas = escritasDeTipos();
    assert.equal(escritas.length, 1);
    assert.deepEqual([escritas[0].metodo, escritas[0].caminho, escritas[0].corpo], ['PUT', '/api/grupos-homogeneos/5/tipos-material/22', { classificacao: 'NAO_OBRIGATORIO' }]);
    assert.equal(srv.estado.vinculos.get(22), 'NAO_OBRIGATORIO');
  });

  test('desvincular pede confirmação e usa DELETE; sem confirmar nada é chamado', async () => {
    const srv = servidorCompleto();
    const recusa = montarPagina(srv.responder, { confirmar: false });
    await recusa.abrirEpis();
    await recusa.acaoTipo('desvincular-tipo', 22);
    assert.equal(escritasDeTipos().length, 0);

    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    await pg.acaoTipo('desvincular-tipo', 22);
    assert.equal(pg.confirmacoes.length, 1);
    const apagar = escritasDeTipos();
    assert.equal(apagar.length, 1, 'um DELETE esperado');
    assert.deepEqual([apagar[0].metodo, apagar[0].caminho], ['DELETE', '/api/grupos-homogeneos/5/tipos-material/22']);
    assert.equal(srv.estado.vinculos.has(22), false);
    assert.deepEqual(acoesDa(tipoDaTela(pg, 22)), ['vincular-tipo'], 'o tipo ativo volta a poder ser vinculado');
  });

  test('tipo inativo já vinculado: a classificação pode ser corrigida e o vínculo pode ser removido; a tela não oferece reativar o tipo', async () => {
    const srv = servidorCompleto();
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    assert.match(semTags(tipoDaTela(pg, 23)), /Inativo/);
    await pg.escolher(23, 'OBRIGATORIO');
    await pg.acaoTipo('alterar-tipo', 23);
    assert.equal(srv.estado.vinculos.get(23), 'OBRIGATORIO');
    await pg.acaoTipo('desvincular-tipo', 23);
    assert.equal(srv.estado.vinculos.has(23), false);
    assert.equal(pg.el('tiposCorpo').innerHTML.includes('Bota Antiga'), false, 'removido e inativo: o servidor não o devolve mais');
    assert.equal(/reativar/i.test(pg.el('tiposCorpo').innerHTML), false);
  });
});

describe('página (DOM simulado): GHE inativo e permissões', () => {
  test('GHE inativo: nenhum tipo pode ser vinculado (sem depender do 409), mas o vínculo existente é corrigido e removido', async () => {
    const srv = servidorCompleto({ grupos: [ghe({ ativo: false })] });
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    assert.deepEqual(acoesDa(tipoDaTela(pg, 21)), []);
    assert.deepEqual(acoesDa(tipoDaTela(pg, 24)), []);
    await pg.escolher(22, 'NAO_OBRIGATORIO');
    await pg.acaoTipo('alterar-tipo', 22);
    assert.equal(srv.estado.vinculos.get(22), 'NAO_OBRIGATORIO');
    await pg.acaoTipo('desvincular-tipo', 22);
    assert.equal(srv.estado.vinculos.has(22), false);
    assert.equal(chamadasDeTipos().some((c) => c.metodo === 'PUT' && /\/21$|\/24$/.test(c.caminho)), false, 'nenhuma tentativa de criar vínculo');
  });

  test('somente visualizar: consulta tudo, mas sem select nem botões nos tipos', async () => {
    const pg = montarPagina(servidorCompleto().responder, { acessoDaPagina: acesso() });
    await pg.abrirEpis();
    const html = pg.el('tiposCorpo').innerHTML;
    assert.deepEqual(celulas(html).map((l) => semTags(l[0])), ['Capacete', 'Luva de Raspa', 'Bota Antiga', 'Jaleco']);
    assert.equal(/<select|<button|data-acao/.test(html), false);
    assert.match(semTags(html), /Obrigatório/);
    await pg.acaoTipo('vincular-tipo', 21);
    assert.equal(escritasDeTipos().length, 0, 'mesmo um clique forçado não escreve');
  });

  test('com permissão de editar as operações ficam disponíveis', async () => {
    const pg = montarPagina(servidorCompleto().responder, { acessoDaPagina: acesso({ editar: true }) });
    await pg.abrirEpis();
    assert.deepEqual(acoesDa(tipoDaTela(pg, 21)), ['vincular-tipo']);
    assert.deepEqual(acoesDa(tipoDaTela(pg, 22)), ['alterar-tipo', 'desvincular-tipo']);
  });
});

describe('página (DOM simulado): erros e fidelidade ao estado do servidor', () => {
  const tecnico = /[A-Z]{3,}_[A-Z_]+/;

  test('erros do PUT aparecem em texto amigável e a tela volta ao estado do servidor (não fica com a escolha falsa)', async () => {
    const casos = [[409, 'GHE_INATIVO', /GHE inativo/], [409, 'TIPO_MATERIAL_INATIVO', /Tipo de EPI inativo/], [404, 'TIPO_MATERIAL_NAO_ENCONTRADO', /Tipo de EPI não encontrado/], [404, 'GHE_NAO_ENCONTRADO', /GHE não encontrado/], [400, 'VALIDACAO', /inválidos/i]];
    for (const [status, codigo, esperado] of casos) {
      const srv = servidorCompleto({ falhar: (metodo) => (metodo === 'PUT' ? erroApi(status, codigo) : null) });
      const pg = montarPagina(srv.responder);
      await pg.abrirEpis();
      await pg.escolher(22, 'NAO_OBRIGATORIO');
      await pg.acaoTipo('alterar-tipo', 22);
      assert.match(pg.el('aviso').innerHTML, esperado, codigo);
      assert.equal(tecnico.test(pg.el('aviso').innerHTML), false, `${codigo}: sem código técnico`);
      assert.deepEqual(opcoes(tipoDaTela(pg, 22)).filter((o) => o.marcada).map((o) => o.valor), ['OBRIGATORIO'], `${codigo}: volta ao estado persistido`);
      assert.equal(chamadasDeTipos().at(-1).metodo, 'GET', `${codigo}: relê o servidor`);
    }
  });

  test('falha inesperada do PUT (500) ao vincular: nada fica marcado como vinculado na tela', async () => {
    const srv = servidorCompleto({ falhar: (metodo) => (metodo === 'PUT' ? resposta(500, { status: 'error', codigo: 'ERRO_INTERNO' }) : null) });
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    await pg.escolher(21, 'OBRIGATORIO');
    await pg.acaoTipo('vincular-tipo', 21);
    assert.match(pg.el('aviso').innerHTML, /Não foi possível concluir/);
    assert.deepEqual(acoesDa(tipoDaTela(pg, 21)), ['vincular-tipo']);
    assert.deepEqual(opcoes(tipoDaTela(pg, 21)).filter((o) => o.marcada).map((o) => o.valor), ['']);
    assert.equal(srv.estado.vinculos.has(21), false);
  });

  test('falha inesperada do DELETE (500): mensagem amigável e o vínculo continua na tela', async () => {
    const srv = servidorCompleto({ falhar: (metodo) => (metodo === 'DELETE' ? resposta(500, { status: 'error', codigo: 'ERRO_INTERNO' }) : null) });
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    await pg.acaoTipo('desvincular-tipo', 22);
    assert.match(pg.el('aviso').innerHTML, /Não foi possível concluir/);
    assert.equal(tecnico.test(pg.el('aviso').innerHTML), false);
    assert.deepEqual(acoesDa(tipoDaTela(pg, 22)), ['alterar-tipo', 'desvincular-tipo'], 'o vínculo continua na tela');
    assert.equal(srv.estado.vinculos.has(22), true);
    assert.equal(chamadasDeTipos().at(-1).metodo, 'GET', 'relê o servidor');
  });

  test('DELETE de vínculo que já não existe (404): mensagem amigável e a lista é relida', async () => {
    const srv = servidorCompleto({ falhar: (metodo) => (metodo === 'DELETE' ? erroApi(404, 'GHE_TIPO_MATERIAL_NAO_VINCULADO') : null) });
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    await pg.acaoTipo('desvincular-tipo', 22);
    assert.match(pg.el('aviso').innerHTML, /já não estava vinculado/);
    assert.equal(tecnico.test(pg.el('aviso').innerHTML), false);
    assert.equal(chamadasDeTipos().at(-1).metodo, 'GET', 'relê o servidor');
  });

  test('trocar de GHE descarta as escolhas pendentes e carrega os tipos do outro', async () => {
    const srv = servidorCompleto({ grupos: [ghe(), ghe({ id: 6, codigo: 'GHE-003', nome: 'PINTURA' })] });
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis(5);
    await pg.escolher(21, 'OBRIGATORIO');
    await pg.acaoGrupo('selecionar', 6);
    assert.equal(pg.el('tiposGhe').textContent, 'GHE-003 · PINTURA');
    assert.ok(chamadas.some((c) => c.caminho === '/api/grupos-homogeneos/6/tipos-material'));
    await pg.acaoTipo('vincular-tipo', 21);
    assert.equal(escritasDeTipos().length, 0, 'a escolha do GHE anterior não vale para o novo');
  });
});

describe('página (DOM simulado): os vínculos diretos continuam e são independentes', () => {
  test('o bloco de materiais diretos carrega pela API antiga e salva só as diferenças em /materiais', async () => {
    const srv = servidorCompleto();
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    assert.match(pg.el('matrizCorpo').innerHTML, /data-material-id="11" checked/);
    await pg.marcarMaterial(12, true);
    await pg.marcarMaterial(11, false);
    const antes = chamadas.length;
    await pg.clicar('botaoSalvarMatriz');
    assert.deepEqual(chamadas.slice(antes).map((c) => `${c.metodo} ${c.caminho}`), [
      'POST /api/grupos-homogeneos/5/materiais', 'DELETE /api/grupos-homogeneos/5/materiais/11', 'GET /api/grupos-homogeneos/5/materiais',
    ]);
    assert.deepEqual([...srv.estado.diretos], [12]);
    assert.equal(chamadas.slice(antes).some((c) => /tipos-material/.test(c.caminho)), false, 'salvar vínculos diretos não mexe nos tipos');
    assert.deepEqual([...srv.estado.vinculos.entries()], [[22, 'OBRIGATORIO'], [23, 'NAO_OBRIGATORIO']]);
  });

  test('vincular um tipo não cria vínculo direto e desvincular um tipo não remove o vínculo direto', async () => {
    const srv = servidorCompleto();
    const pg = montarPagina(srv.responder);
    await pg.abrirEpis();
    const diretosAntes = [...srv.estado.diretos];
    await pg.escolher(21, 'OBRIGATORIO');
    await pg.acaoTipo('vincular-tipo', 21);
    await pg.acaoTipo('desvincular-tipo', 22);
    assert.deepEqual([...srv.estado.diretos], diretosAntes);
    assert.equal(chamadas.some((c) => /\/materiais/.test(c.caminho) && (c.metodo === 'POST' || c.metodo === 'DELETE')), false, 'nenhuma escrita em /materiais');
  });
});

describe('página (DOM simulado): importação só começa com um arquivo escolhido', () => {
  test('abrir os EPIs e clicar em Importar só abre o seletor: nenhuma leitura de arquivo nem endpoint de importação', async () => {
    const pg = montarPagina(servidorCompleto().responder);
    await pg.abrirEpis();
    await pg.clicar('botaoImportarGhe');
    assert.equal(pg.el('arquivoImportacaoGhe').cliques, 1);
    assert.equal(/integra/i.test(pg.el('aviso').innerHTML), false);
    assert.equal(chamadas.some((c) => /importacao/.test(c.caminho)), false);
    assert.ok(chamadas.every((c) => c.caminho.startsWith('/api/grupos-homogeneos')));
  });
});
