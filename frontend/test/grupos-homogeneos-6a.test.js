'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');

/**
 * Incremento 6A (RED): Gestão de GHE — listagem, cadastro e edição (pages/employee-groups.html + js/grupos-homogeneos.js).
 *
 * Contrato visual e de dados:
 *   - tabela principal: GHE (código) | Descrição | Situação | Ações. Setor e Função saem da interface (não do banco nem da API);
 *     a "Descrição" na tela é o campo `nome` da API (o campo físico `descricao` legado fica fora da tela);
 *   - ações por linha, na ordem: EPIs · Editar · Inativar (ativo) ou EPIs · Editar · Reativar (inativo); sem permissão de
 *     editar só resta EPIs; a ação EPIs continua o ponto de entrada da matriz (a gestão por tipo é do 6B);
 *   - formulário: Código GHE *, Descrição * (id gheNome), Riscos. Sem Setor, Função nem o antigo campo Descrição;
 *   - criar: código obrigatório; POST { nome, codigo, riscos } — o código vai aparado, como foi digitado (quem normaliza e
 *     valida é o backend), e NUNCA setor/funcao/descricao;
 *   - editar: PATCH { nome, riscos } mais \`codigo\` quando preenchido. Legado sem código (codigo = null) edita normalmente sem
 *     código e pode recebê-lo; GHE que já tem código não pode ter o campo esvaziado (a API recusa remover). O PATCH NUNCA leva
 *     setor/funcao/descricao: como a tela não os mostra, não pode apagá-los por ausência;
 *   - "Importar GHE / EPIs": botão #botaoImportarGhe no cabeçalho do cartão de GHE, visível só com criar E editar (a API exige
 *     as duas); no 6A só avisa "em integração" (a importação é o 6C);
 *   - erros do backend com texto amigável (nunca o código técnico cru): GHE_CODIGO_OBRIGATORIO, GHE_CODIGO_INVALIDO,
 *     GHE_CODIGO_EM_USO, GHE_NOME_EM_USO (agora "descrição"), GHE_NAO_ENCONTRADO.
 * Os testes do contrato antigo em test/grupos-homogeneos.test.js que divergem daqui serão atualizados no GREEN.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const modulo = () => require('../js/grupos-homogeneos'); // eslint-disable-line global-require
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const erroApi = (status, codigo) => resposta(status, { status: 'error', codigo, message: 'texto técnico do servidor' });

// Valores sentinela: se aparecerem na tela ou saírem num PATCH, é porque Setor, Função ou a antiga Descrição vazaram.
const LEGADO = { setor: 'SETOR-LEGADO-X', funcao: 'FUNCAO-LEGADA-Y', descricao: 'DESCRICAO-LEGADA-Z' };
const ghe = (extra = {}) => ({ id: 5, codigo: 'GHE-002', nome: 'ALMOXARIFADO', ...LEGADO, riscos: 'Ruído', ativo: true, ...extra });
const listaGrupos = (grupos) => ({ status: 'ok', grupos, total: grupos.length, pagina: 1, limite: 100 });

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo: opcoes.body === undefined ? undefined : JSON.parse(opcoes.body) });
      const r = typeof responder === 'function' ? responder(u, opcoes) : responder;
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
beforeEach(() => servidor(resposta(200, listaGrupos([ghe()]))));

/** Servidor em memória com o contrato real da API de GHE (inclusive que o PATCH só altera as chaves enviadas). */
function servidorGhe(grupos) {
  const estado = { grupos: grupos.map((g) => ({ ...g })), proximo: 100 };
  const normalizar = (c) => String(c).trim().toUpperCase();
  const valido = (c) => /^GHE-[0-9]{3,6}$/.test(c);
  const responder = (u, o) => {
    const corpo = o.body === undefined ? undefined : JSON.parse(o.body);
    if (u.pathname === '/api/grupos-homogeneos' && o.method === 'GET') return resposta(200, listaGrupos(estado.grupos));
    if (u.pathname === '/api/grupos-homogeneos' && o.method === 'POST') {
      if (corpo.codigo === undefined) return erroApi(400, 'GHE_CODIGO_OBRIGATORIO');
      const codigo = normalizar(corpo.codigo);
      if (!valido(codigo)) return erroApi(400, 'GHE_CODIGO_INVALIDO');
      if (estado.grupos.some((g) => g.codigo === codigo)) return erroApi(409, 'GHE_CODIGO_EM_USO');
      if (estado.grupos.some((g) => g.nome === corpo.nome)) return erroApi(409, 'GHE_NOME_EM_USO');
      estado.proximo += 1;
      const novo = { id: estado.proximo, codigo, nome: corpo.nome, descricao: null, setor: null, funcao: null, riscos: corpo.riscos ?? null, ativo: true };
      estado.grupos.push(novo);
      return resposta(201, { status: 'ok', grupo: novo });
    }
    const m = u.pathname.match(/^\/api\/grupos-homogeneos\/(\d+)(?:\/(inativar|reativar|materiais))?$/);
    if (m) {
      const alvo = estado.grupos.find((g) => g.id === Number(m[1]));
      if (!alvo) return erroApi(404, 'GHE_NAO_ENCONTRADO');
      if (m[2] === 'materiais' && o.method === 'GET') return resposta(200, { status: 'ok', grupo: { id: alvo.id, nome: alvo.nome, ativo: alvo.ativo }, materiais: [] });
      if (m[2] === 'inativar' || m[2] === 'reativar') { alvo.ativo = m[2] === 'reativar'; return resposta(200, { status: 'ok', grupo: alvo, alterado: true }); }
      if (o.method === 'PATCH') {
        if (Object.hasOwn(corpo, 'codigo')) {
          const codigo = corpo.codigo === null ? '' : normalizar(corpo.codigo);
          if (!valido(codigo)) return erroApi(400, 'GHE_CODIGO_INVALIDO');
          if (estado.grupos.some((g) => g.id !== alvo.id && g.codigo === codigo)) return erroApi(409, 'GHE_CODIGO_EM_USO');
          alvo.codigo = codigo;
        }
        for (const campo of ['nome', 'riscos', 'descricao', 'setor', 'funcao']) if (Object.hasOwn(corpo, campo)) alvo[campo] = corpo[campo];
        return resposta(200, { status: 'ok', grupo: alvo });
      }
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
  const clicar = async (id) => { for (const fn of (el(id).listeners.click || [])) await fn({ preventDefault() {} }); await esperar(); };
  const acaoGrupo = async (acao, id) => {
    const alvo = { getAttribute: (n) => ({ 'data-acao': acao, 'data-id': String(id) })[n] ?? null, closest() { return this; } };
    for (const fn of (el('gruposCorpo').listeners.click || [])) await fn({ target: alvo, preventDefault() {} });
    await esperar();
  };
  const preencher = (campos) => { for (const [id, valor] of Object.entries(campos)) el(id).value = valor; };
  return { el, sandbox, esperar, clicar, acaoGrupo, preencher, confirmacoes };
}

/** Texto das células <td> de cada linha da tabela de GHE. */
const celulas = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
const semTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// Rótulo visível dos botões: sem o nome do ícone (a fonte de ícones escreve o nome dentro de um <span>).
const rotuloVisivel = (s) => semTags(s.replace(/<span class="material-symbols-outlined">[^<]*<\/span>/g, ''));

// ───────────────────────────────────────────────────────────────────
describe('listagem: GHE | Descrição | Situação | Ações (render)', () => {
  test('uma linha por GHE com quatro células na ordem Código, Descrição, Situação, Ações; legado sem código mostra "—"', () => {
    const { render } = modulo();
    const linhas = celulas(render.linhasGrupos([ghe(), ghe({ id: 6, codigo: null, nome: 'PINTURA', ativo: false })], { podeEditar: true }));
    assert.equal(linhas.length, 2);
    for (const l of linhas) assert.equal(l.length, 4, 'GHE | Descrição | Situação | Ações');
    assert.deepEqual([semTags(linhas[0][0]), semTags(linhas[0][1]), semTags(linhas[0][2])], ['GHE-002', 'ALMOXARIFADO', 'Ativo']);
    assert.deepEqual([semTags(linhas[1][0]), semTags(linhas[1][1]), semTags(linhas[1][2])], ['—', 'PINTURA', 'Inativo']);
  });

  test('Setor, Função e a antiga Descrição não aparecem na tabela (os dados continuam no banco e na API)', () => {
    const { render } = modulo();
    const html = render.linhasGrupos([ghe()], { podeEditar: true });
    for (const sentinela of Object.values(LEGADO)) assert.equal(html.includes(sentinela), false, sentinela);
  });

  test('ações: EPIs · Editar · Inativar para ativo; EPIs · Editar · Reativar para inativo; sem editar, só EPIs', () => {
    const { render } = modulo();
    const rotulos = (html) => [...html.matchAll(/data-acao="([a-z]+)"[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[1]);
    assert.deepEqual(rotulos(render.linhasGrupos([ghe()], { podeEditar: true })), ['selecionar', 'editar', 'inativar']);
    assert.deepEqual(rotulos(render.linhasGrupos([ghe({ ativo: false })], { podeEditar: true })), ['selecionar', 'editar', 'reativar']);
    assert.deepEqual(rotulos(render.linhasGrupos([ghe()], { podeEditar: false })), ['selecionar']);
    assert.match(rotuloVisivel(render.linhasGrupos([ghe()], { podeEditar: true })), /EPIs\s+Editar\s+Inativar/);
    assert.match(rotuloVisivel(render.linhasGrupos([ghe({ ativo: false })], { podeEditar: true })), /EPIs\s+Editar\s+Reativar/);
  });

  test('código e descrição são escapados (nada vira HTML)', () => {
    const { render } = modulo();
    const html = render.linhasGrupos([ghe({ codigo: '<b>X</b>', nome: '<img src=x onerror=1>' })], { podeEditar: true });
    assert.equal(/<b>X<\/b>|<img/.test(html), false);
    assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
  });
});

describe('ações do módulo: o que vai para a API', () => {
  test('criar envia { nome, codigo, riscos }: código aparado e como digitado, sem setor, função nem descrição legada', async () => {
    const { acoes } = modulo();
    await acoes.criarGrupo({ codigo: '  ghe-010 ', nome: ' Montagem ', riscos: ' Ruído ', setor: 'X', funcao: 'Y', descricao: 'Z' });
    assert.deepEqual([chamadas[0].metodo, chamadas[0].caminho], ['POST', '/api/grupos-homogeneos']);
    assert.deepEqual(chamadas[0].corpo, { nome: 'Montagem', codigo: 'ghe-010', riscos: 'Ruído' });
  });

  test('criar sem código preenchido não manda a chave (o backend responde que é obrigatório); riscos vazio vira null', async () => {
    const { acoes } = modulo();
    await acoes.criarGrupo({ codigo: '   ', nome: 'Montagem', riscos: ' ' });
    assert.deepEqual(chamadas[0].corpo, { nome: 'Montagem', riscos: null });
  });

  test('editar envia { nome, riscos } e o código quando preenchido; nunca setor, função nem descrição, mesmo que cheguem nos dados', async () => {
    const { acoes } = modulo();
    await acoes.alterarGrupo(5, { codigo: ' GHE-020 ', nome: 'Almoxarifado II', riscos: '', setor: 'X', funcao: 'Y', descricao: 'Z' });
    assert.deepEqual([chamadas[0].metodo, chamadas[0].caminho], ['PATCH', '/api/grupos-homogeneos/5']);
    assert.deepEqual(chamadas[0].corpo, { nome: 'Almoxarifado II', riscos: null, codigo: 'GHE-020' });
  });

  test('editar legado sem código: o PATCH não leva a chave codigo (nem null, que a API recusaria)', async () => {
    const { acoes } = modulo();
    await acoes.alterarGrupo(6, { codigo: '', nome: 'Pintura', riscos: 'Ruído' });
    assert.deepEqual(chamadas[0].corpo, { nome: 'Pintura', riscos: 'Ruído' });
    await acoes.alterarGrupo(6, { codigo: null, nome: 'Pintura', riscos: 'Ruído' });
    assert.equal(Object.hasOwn(chamadas[1].corpo, 'codigo'), false);
  });
});

describe('mensagens de erro do backend para GHE (texto amigável, nunca o código técnico)', () => {
  test('código obrigatório, inválido e em uso; descrição em uso; GHE não encontrado', () => {
    const { mensagens } = modulo();
    const msg = (status, codigo) => mensagens.erro({ ok: false, status, codigo });
    assert.match(msg(400, 'GHE_CODIGO_OBRIGATORIO'), /Informe o código/);
    assert.match(msg(400, 'GHE_CODIGO_INVALIDO'), /GHE-/);
    assert.match(msg(400, 'GHE_CODIGO_INVALIDO'), /3 a 6 dígitos/);
    assert.match(msg(409, 'GHE_CODIGO_EM_USO'), /este código/);
    assert.match(msg(409, 'GHE_NOME_EM_USO'), /descrição/i);
    assert.match(msg(404, 'GHE_NAO_ENCONTRADO'), /GHE não encontrado/);
    for (const [s, c] of [[400, 'GHE_CODIGO_OBRIGATORIO'], [400, 'GHE_CODIGO_INVALIDO'], [409, 'GHE_CODIGO_EM_USO'], [409, 'GHE_NOME_EM_USO'], [404, 'GHE_NAO_ENCONTRADO']]) {
      assert.equal(/GHE_[A-Z_]+/.test(msg(s, c)), false, c);
    }
    assert.match(mensagens.erro({ ok: false, status: 400, codigo: 'VALIDACAO' }), /dados/i, 'os demais 400 seguem genéricos');
  });
});

describe('inspeção estática: pages/employee-groups.html', () => {
  const html = ler('pages/employee-groups.html');
  const formulario = html.slice(html.indexOf('<form id="formGrupo"'), html.indexOf('</form>', html.indexOf('<form id="formGrupo"')));
  const inicioTabela = html.lastIndexOf('<thead>', html.indexOf('id="gruposCorpo"')); // a tabela principal (o painel de importação do 6C tem outra)
  const cabecalhos = [...html.slice(inicioTabela, html.indexOf('</thead>', inicioTabela)).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => semTags(m[1]));

  test('a tabela principal tem exatamente GHE | Descrição | Situação | Ações (sem Setor nem Função)', () => {
    assert.deepEqual(cabecalhos, ['GHE', 'Descrição', 'Situação', 'Ações']);
  });

  test('o formulário tem Código GHE *, Descrição * e Riscos — sem Setor, Função nem o antigo campo Descrição', () => {
    assert.match(formulario, /<label for="gheCodigo">Código GHE \*<\/label>/);
    assert.match(formulario, /<input id="gheCodigo"/);
    assert.match(formulario, /<label for="gheNome">Descrição \*<\/label>/);
    assert.match(formulario, /<input id="gheNome"/);
    assert.match(formulario, /<label for="gheRiscos">Riscos<\/label>/);
    for (const proibido of [/id="gheSetor"/, /id="gheFuncao"/, /id="gheDescricao"/, /for="gheSetor"/, /for="gheFuncao"/, />Setor</, />Função</, />Nome \*</]) {
      assert.equal(proibido.test(formulario), false, String(proibido));
    }
  });

  test('o botão "Importar GHE / EPIs" fica no cabeçalho do cartão de GHE, ao lado de "Novo GHE", escondido até a permissão', () => {
    assert.match(html, /<button id="botaoImportarGhe"[^>]*\bhidden\b[^>]*>[\s\S]*?Importar GHE \/ EPIs[\s\S]*?<\/button>/);
    const cabecalhoDoCartao = html.slice(html.indexOf('<div class="card-header">'), html.indexOf('<form id="formGrupo"'));
    assert.ok(cabecalhoDoCartao.includes('id="botaoImportarGhe"') && cabecalhoDoCartao.includes('id="botaoNovoGrupo"'));
  });
});

describe('página (DOM simulado): listagem', () => {
  test('mostra código, descrição e situação de cada GHE; legado sem código aparece com "—"; Setor e Função não aparecem', async () => {
    const pg = montarPagina(resposta(200, listaGrupos([ghe(), ghe({ id: 6, codigo: null, nome: 'PINTURA', ativo: false })])));
    await pg.esperar();
    const linhas = celulas(pg.el('gruposCorpo').innerHTML);
    assert.deepEqual(linhas.map((l) => l.slice(0, 3).map(semTags)), [['GHE-002', 'ALMOXARIFADO', 'Ativo'], ['—', 'PINTURA', 'Inativo']]);
    for (const sentinela of Object.values(LEGADO)) assert.equal(pg.el('gruposCorpo').innerHTML.includes(sentinela), false, sentinela);
  });

  test('a ação EPIs existe para todos, inclusive para quem só visualiza', async () => {
    const pg = montarPagina(resposta(200, listaGrupos([ghe()])), { acessoDaPagina: acesso() });
    await pg.esperar();
    assert.match(pg.el('gruposCorpo').innerHTML, /data-acao="selecionar" data-id="5"/);
    assert.equal(/data-acao="(editar|inativar|reativar)"/.test(pg.el('gruposCorpo').innerHTML), false);
  });
});

describe('página (DOM simulado): novo GHE', () => {
  test('o formulário abre limpo, como "Novo GHE", e o código é obrigatório: sem ele nada vai para a API', async () => {
    const srv = servidorGhe([ghe()]);
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.clicar('botaoNovoGrupo');
    assert.equal(pg.el('formGrupo').hidden, false);
    assert.match(pg.el('formGrupoTitulo').textContent, /Novo GHE/);
    assert.deepEqual([pg.el('gheCodigo').value, pg.el('gheNome').value, pg.el('gheRiscos').value], ['', '', '']);
    pg.preencher({ gheNome: 'Montagem' });
    const antes = chamadas.length;
    await pg.clicar('botaoSalvarGrupo');
    assert.equal(chamadas.length, antes, 'nenhuma chamada sem o código');
    assert.match(pg.el('aviso').innerHTML, /Informe o código/);
  });

  test('a descrição também é obrigatória', async () => {
    const pg = montarPagina(servidorGhe([]).responder);
    await pg.esperar();
    await pg.clicar('botaoNovoGrupo');
    pg.preencher({ gheCodigo: 'GHE-010' });
    const antes = chamadas.length;
    await pg.clicar('botaoSalvarGrupo');
    assert.equal(chamadas.length, antes);
    assert.match(pg.el('aviso').innerHTML, /descri/i);
  });

  test('o POST leva codigo, nome (a Descrição) e riscos — nunca setor, função nem descrição legada; a lista recarregada mostra o código', async () => {
    const srv = servidorGhe([ghe()]);
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.clicar('botaoNovoGrupo');
    pg.preencher({ gheCodigo: ' ghe-010 ', gheNome: 'Montagem', gheRiscos: 'Ruído' });
    await pg.clicar('botaoSalvarGrupo');
    const post = chamadas.find((c) => c.metodo === 'POST');
    assert.deepEqual(post.corpo, { nome: 'Montagem', codigo: 'ghe-010', riscos: 'Ruído' });
    assert.equal(srv.estado.grupos.length, 2);
    assert.equal(pg.el('formGrupo').hidden, true);
    const linhas = celulas(pg.el('gruposCorpo').innerHTML).map((l) => l.slice(0, 2).map(semTags));
    assert.deepEqual(linhas, [['GHE-002', 'ALMOXARIFADO'], ['GHE-010', 'Montagem']]);
  });

  test('erros do servidor aparecem em texto amigável e o formulário mantém o que foi digitado', async () => {
    const casos = [
      [400, 'GHE_CODIGO_INVALIDO', /3 a 6 dígitos/], [400, 'GHE_CODIGO_OBRIGATORIO', /Informe o código/], [409, 'GHE_CODIGO_EM_USO', /este código/], [409, 'GHE_NOME_EM_USO', /descrição/i],
    ];
    for (const [status, codigo, esperado] of casos) {
      const pg = montarPagina((u, o) => (o.method === 'POST' ? erroApi(status, codigo) : resposta(200, listaGrupos([ghe()]))));
      await pg.esperar();
      await pg.clicar('botaoNovoGrupo');
      pg.preencher({ gheCodigo: 'GHE-077', gheNome: 'Digitado', gheRiscos: 'Calor' });
      await pg.clicar('botaoSalvarGrupo');
      assert.match(pg.el('aviso').innerHTML, esperado, codigo);
      assert.equal(/GHE_[A-Z_]+/.test(pg.el('aviso').innerHTML), false, `${codigo}: sem código técnico cru`);
      assert.deepEqual([pg.el('gheCodigo').value, pg.el('gheNome').value, pg.el('gheRiscos').value], ['GHE-077', 'Digitado', 'Calor'], codigo);
      assert.equal(pg.el('formGrupo').hidden, false);
    }
  });
});

describe('página (DOM simulado): editar GHE', () => {
  test('GHE com código: o formulário vem preenchido (código, descrição, riscos) e o código é editável; o PATCH leva o novo código', async () => {
    const srv = servidorGhe([ghe()]);
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('editar', 5);
    assert.match(pg.el('formGrupoTitulo').textContent, /Editar GHE/);
    assert.deepEqual([pg.el('gheCodigo').value, pg.el('gheNome').value, pg.el('gheRiscos').value], ['GHE-002', 'ALMOXARIFADO', 'Ruído']);
    pg.preencher({ gheCodigo: 'ghe-020' });
    await pg.clicar('botaoSalvarGrupo');
    const patch = chamadas.find((c) => c.metodo === 'PATCH');
    assert.equal(patch.caminho, '/api/grupos-homogeneos/5');
    assert.deepEqual(patch.corpo, { nome: 'ALMOXARIFADO', riscos: 'Ruído', codigo: 'ghe-020' });
    assert.equal(srv.estado.grupos[0].codigo, 'GHE-020');
    assert.equal(semTags(celulas(pg.el('gruposCorpo').innerHTML)[0][0]), 'GHE-020');
  });

  test('os dados legados (setor, função, descrição antiga) não aparecem no formulário e não são apagados pelo salvar', async () => {
    const srv = servidorGhe([ghe()]);
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('editar', 5);
    for (const id of ['gheSetor', 'gheFuncao', 'gheDescricao']) assert.equal(pg.el(id).value, '', `${id} não é preenchido`);
    pg.preencher({ gheRiscos: 'Ruído e calor' });
    await pg.clicar('botaoSalvarGrupo');
    const patch = chamadas.find((c) => c.metodo === 'PATCH');
    for (const campo of ['setor', 'funcao', 'descricao']) assert.equal(Object.hasOwn(patch.corpo, campo), false, `o PATCH não pode levar ${campo}`);
    const salvo = srv.estado.grupos[0];
    assert.deepEqual([salvo.setor, salvo.funcao, salvo.descricao, salvo.riscos], [LEGADO.setor, LEGADO.funcao, LEGADO.descricao, 'Ruído e calor']);
  });

  test('legado sem código continua editável sem preencher código; o PATCH não leva a chave codigo', async () => {
    const srv = servidorGhe([ghe({ id: 6, codigo: null, nome: 'PINTURA' })]);
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('editar', 6);
    assert.equal(pg.el('gheCodigo').value, '');
    pg.preencher({ gheRiscos: 'Vapores' });
    await pg.clicar('botaoSalvarGrupo');
    const patch = chamadas.find((c) => c.metodo === 'PATCH');
    assert.ok(patch, 'salvou sem código');
    assert.equal(Object.hasOwn(patch.corpo, 'codigo'), false);
    assert.equal(srv.estado.grupos[0].riscos, 'Vapores');
    assert.equal(srv.estado.grupos[0].codigo, null);
  });

  test('legado pode receber um código ao ser editado', async () => {
    const srv = servidorGhe([ghe({ id: 6, codigo: null, nome: 'PINTURA' })]);
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('editar', 6);
    pg.preencher({ gheCodigo: 'GHE-050' });
    await pg.clicar('botaoSalvarGrupo');
    assert.equal(chamadas.find((c) => c.metodo === 'PATCH').corpo.codigo, 'GHE-050');
    assert.equal(srv.estado.grupos[0].codigo, 'GHE-050');
  });

  test('GHE que já tem código não pode ficar sem ele: apagar o campo bloqueia o salvar antes da API', async () => {
    const srv = servidorGhe([ghe()]);
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('editar', 5);
    pg.preencher({ gheCodigo: '   ' });
    const antes = chamadas.length;
    await pg.clicar('botaoSalvarGrupo');
    assert.equal(chamadas.length, antes, 'nenhuma chamada');
    assert.match(pg.el('aviso').innerHTML, /código/i);
    assert.equal(pg.el('formGrupo').hidden, false);
  });

  test('erros ao editar: código em uso e GHE não encontrado aparecem em texto amigável', async () => {
    for (const [status, codigo, esperado] of [[409, 'GHE_CODIGO_EM_USO', /este código/], [404, 'GHE_NAO_ENCONTRADO', /GHE não encontrado/], [400, 'GHE_CODIGO_INVALIDO', /3 a 6 dígitos/]]) {
      const pg = montarPagina((u, o) => (o.method === 'PATCH' ? erroApi(status, codigo) : resposta(200, listaGrupos([ghe()]))));
      await pg.esperar();
      await pg.acaoGrupo('editar', 5);
      pg.preencher({ gheCodigo: 'GHE-099' });
      await pg.clicar('botaoSalvarGrupo');
      assert.match(pg.el('aviso').innerHTML, esperado, codigo);
      assert.equal(/GHE_[A-Z_]+/.test(pg.el('aviso').innerHTML), false, codigo);
    }
  });
});

describe('página (DOM simulado): inativar e reativar', () => {
  test('inativar pede confirmação, chama a API e a lista recarregada mostra Inativo com a ação Reativar (o registro não some)', async () => {
    const srv = servidorGhe([ghe()]);
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('inativar', 5);
    assert.equal(pg.confirmacoes.length, 1);
    assert.ok(chamadas.some((c) => c.metodo === 'POST' && c.caminho === '/api/grupos-homogeneos/5/inativar'));
    assert.equal(srv.estado.grupos[0].ativo, false);
    const linhas = celulas(pg.el('gruposCorpo').innerHTML);
    assert.equal(linhas.length, 1);
    assert.equal(semTags(linhas[0][2]), 'Inativo');
    assert.match(linhas[0][3], /data-acao="reativar"/);
    assert.equal(/data-acao="inativar"/.test(linhas[0][3]), false);
  });

  test('reativar volta a Ativo com a ação Inativar', async () => {
    const srv = servidorGhe([ghe({ ativo: false })]);
    const pg = montarPagina(srv.responder);
    await pg.esperar();
    await pg.acaoGrupo('reativar', 5);
    assert.ok(chamadas.some((c) => c.metodo === 'POST' && c.caminho === '/api/grupos-homogeneos/5/reativar'));
    const linhas = celulas(pg.el('gruposCorpo').innerHTML);
    assert.equal(semTags(linhas[0][2]), 'Ativo');
    assert.match(linhas[0][3], /data-acao="inativar"/);
  });

  test('sem confirmar, nada é chamado; GHE inexistente na operação mostra o texto amigável', async () => {
    const srv = servidorGhe([ghe()]);
    const semConfirmar = montarPagina(srv.responder, { confirmar: false });
    await semConfirmar.esperar();
    const antes = chamadas.length;
    await semConfirmar.acaoGrupo('inativar', 5);
    assert.equal(chamadas.length, antes);

    const naoExiste = montarPagina((u, o) => (o.method === 'POST' ? erroApi(404, 'GHE_NAO_ENCONTRADO') : resposta(200, listaGrupos([ghe()]))));
    await naoExiste.esperar();
    await naoExiste.acaoGrupo('inativar', 5);
    assert.match(naoExiste.el('aviso').innerHTML, /GHE não encontrado/);
  });
});

describe('página (DOM simulado): permissões e importação', () => {
  test('somente leitura: sem Novo GHE, sem Importar, sem Editar/Inativar/Reativar; só EPIs', async () => {
    const pg = montarPagina(servidorGhe([ghe()]).responder, { acessoDaPagina: acesso() });
    await pg.esperar();
    assert.equal(pg.el('botaoNovoGrupo').hidden, true);
    assert.equal(pg.el('botaoImportarGhe').hidden, true);
    assert.equal(/data-acao="(editar|inativar|reativar)"/.test(pg.el('gruposCorpo').innerHTML), false);
  });

  test('"Importar GHE / EPIs" só aparece com criar E editar (a API exige as duas)', async () => {
    const cenarios = [[acesso({ criar: true, editar: true }), false], [acesso({ criar: true }), true], [acesso({ editar: true }), true], [acesso(), true]];
    for (const [permissao, escondido] of cenarios) {
      const pg = montarPagina(servidorGhe([ghe()]).responder, { acessoDaPagina: permissao });
      await pg.esperar();
      assert.strictEqual(pg.el('botaoImportarGhe').hidden, escondido, JSON.stringify(permissao.permissoes.recursos.employeeGroups));
    }
  });

  test('o botão de importação só abre o seletor de arquivo: nenhuma chamada à API e nenhuma mensagem de "em integração" (a importação em si é coberta pelo 6C)', async () => {
    const pg = montarPagina(servidorGhe([ghe()]).responder);
    await pg.esperar();
    const antes = chamadas.length;
    await pg.clicar('botaoImportarGhe');
    assert.equal(chamadas.length, antes);
    assert.equal(pg.el('arquivoImportacaoGhe').cliques, 1);
    assert.equal(/integra/i.test(pg.el('aviso').innerHTML), false);
  });

  test('a tela só fala com /grupos-homogeneos e não guarda nada no navegador', async () => {
    const pg = montarPagina(servidorGhe([ghe()]).responder);
    await pg.esperar();
    await pg.clicar('botaoNovoGrupo');
    pg.preencher({ gheCodigo: 'GHE-010', gheNome: 'Montagem' });
    await pg.clicar('botaoSalvarGrupo');
    assert.ok(chamadas.every((c) => c.caminho.startsWith('/api/grupos-homogeneos')));
    assert.equal(/localStorage|sessionStorage/.test(fs.readFileSync(path.join(RAIZ, 'pages/employee-groups.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')), false);
  });
});
