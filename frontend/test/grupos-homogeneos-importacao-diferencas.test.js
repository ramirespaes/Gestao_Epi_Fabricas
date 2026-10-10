'use strict';

/**
 * Importação GHE / EPIs — o preview mostra só as DIFERENÇAS reais (RED).
 *
 * Problema (validação manual): reselecionar a MESMA planilha já importada chega a um preview com todas as linhas e o botão
 * "Confirmar importação" habilitado, o que sugere que há algo novo. O backend já é idempotente; a interface precisa
 * representar o estado real.
 *
 * Diagnóstico do contrato atual (nada de backend muda): cada linha do preview já vem classificada pelo servidor
 * (`situacao`, `aplicavel`), `resumo.aplicaveis` conta só o que grava (NOVO_VINCULO e CLASSIFICACAO_ALTERADA) e `ghes[].operacao`
 * diz se um GHE será CRIADO ou receberá CÓDIGO. VINCULO_EXISTENTE é "sem alteração" (aplicavel=false). Falta a interface:
 *   - classificar por diferença: novo GHE, novo vínculo, alteração, sem alteração (e as linhas com problema);
 *   - resumo com "Sem alteração: N" e "Serão aplicadas: N";
 *   - tabela principal só com o que grava ou tem problema; os itens sem alteração ficam atrás de "Mostrar itens já existentes";
 *   - "Nenhuma alteração para importar. …" e "Confirmar importação" desabilitado quando não há o que gravar.
 *
 * Os dados do preview vêm do `analisarLote` REAL do backend (função pura, sem banco), para o contrato não divergir. Os
 * números seguem a planilha de referência: 32 GHEs e 243 linhas (vínculos GHE × EPI) — linhas NÃO são GHEs.
 *
 * Regras que NÃO mudam (e têm suíte própria no backend): confirmação atômica e idempotente, RBAC criar+editar, auditoria só
 * quando algo é gravado (importacaoId nulo sem alteração), servidor como autoridade. A confirmação continua reenviando as
 * linhas ORIGINAIS: o servidor recalcula e só grava as diferenças.
 *
 * Arquivo novo; nenhum teste existente foi alterado.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const I = require('../js/importacao-ghe');
const { analisarLote } = require('../../backend/src/utils/ghe-importacao');

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const semTags = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const celulas = (html) => [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
const linhasDeDados = (html) => celulas(html).filter((c) => c.length === 7); // a linha de estado (colspan) não conta

// Função do módulo que ainda não existe no RED: ao ser chamada falha com asserção clara (nunca TypeError).
const exigir = (objeto, rotulo) => new Proxy(objeto || {}, { get: (alvo, nome) => (nome in alvo ? alvo[nome] : () => assert.fail(`ainda não implementado: ${rotulo}.${String(nome)}`)) });
const diferencas = () => exigir(I.diferencas, 'diferencas');
const mensagens = () => exigir(I.mensagens, 'mensagens');

// ─── "Banco" de teste na escala da planilha de referência: 32 GHEs, 243 vínculos ─────────────────
const CABECALHO = ['GHE', 'DESCRIÇÃO', 'EPI', 'CLASSIFICAÇÃO'];
const NOMES_EPI = Array.from({ length: 30 }, (_, i) => `EPI de Teste ${String(i + 1).padStart(2, '0')}`);
const TIPOS = NOMES_EPI.map((nome, i) => ({ id: i + 1, nome, ativo: true }));
const gheDeTeste = (i) => ({ id: i, codigo: `GHE-${String(i).padStart(3, '0')}`, nome: `SETOR DE TESTE ${String(i).padStart(2, '0')}`, ativo: true });

/** 32 GHEs; 19 com 8 EPIs e 13 com 7: 19×8 + 13×7 = 243 vínculos, todos OBRIGATÓRIO. */
function banco243() {
  const ghes = Array.from({ length: 32 }, (_, k) => gheDeTeste(k + 1));
  const vinculos = [];
  ghes.forEach((g, k) => {
    const n = k < 19 ? 8 : 7;
    for (let t = 1; t <= n; t += 1) vinculos.push({ gheId: g.id, tipoId: t, classificacao: 'OBRIGATORIO' });
  });
  return { ghes, tipos: TIPOS, vinculos };
}
const linhaDe = (banco, v, classificacao = 'Obrigatório') => {
  const g = banco.ghes.find((x) => x.id === v.gheId);
  const t = banco.tipos.find((x) => x.id === v.tipoId);
  return [g.codigo, g.nome, t.nome, classificacao];
};
/** A planilha idêntica ao que já está no banco (243 linhas de dados, a partir da linha 2). */
const planilhaIdentica = (banco) => [CABECALHO, ...banco.vinculos.map((v) => linhaDe(banco, v))];
const novoVinculoDe = (banco, gheId) => linhaDe(banco, { gheId, tipoId: 20 }); // tipo 20 nunca está vinculado em banco243

function analisar(matriz, banco) {
  const montado = I.planilha.montarLinhas(matriz);
  assert.equal(montado.ok, true, 'a planilha de teste precisa ser válida');
  return { linhas: montado.linhas, dados: { status: 'ok', ...analisarLote({ linhas: montado.linhas, ghes: banco.ghes, tipos: banco.tipos, vinculos: banco.vinculos }) } };
}

// ═══════════════════════════════════════════════════════════════════
// Módulo: classificação por diferença, mensagens e resumo
// ═══════════════════════════════════════════════════════════════════
describe('premissa do contrato real: a planilha de referência tem 32 GHEs e 243 vínculos', () => {
  test('reimportar a mesma planilha: o servidor devolve 243 linhas VINCULO_EXISTENTE, nenhuma aplicável e 32 GHEs existentes (linhas não são GHEs)', () => {
    const banco = banco243();
    assert.equal(banco.vinculos.length, 243);
    const { dados } = analisar(planilhaIdentica(banco), banco);
    assert.equal(dados.linhas.length, 243);
    assert.deepEqual(dados.resumo.porSituacao, { VINCULO_EXISTENTE: 243 });
    assert.equal(dados.resumo.aplicaveis, 0);
    assert.deepEqual(dados.resumo.ghes, { GHE_EXISTENTE: 32 });
    assert.equal(dados.ghes.length, 32);
    assert.equal(dados.ghes.every((g) => g.operacao === null), true);
  });
});

describe('módulo: diferencas.resumir — o que de fato muda', () => {
  test('mesma planilha: 243 analisadas, 243 sem alteração, 0 para importar, nada para confirmar', () => {
    const banco = banco243();
    const { dados } = analisar(planilhaIdentica(banco), banco);
    const r = diferencas().resumir(dados);
    assert.deepEqual(
      { analisadas: r.analisadas, semAlteracao: r.semAlteracao, importaveis: r.importaveis, comProblema: r.comProblema, novosGhes: r.novosGhes, novosVinculos: r.novosVinculos, alteracoes: r.alteracoes, ghesComCodigo: r.ghesComCodigo, haAlteracao: r.haAlteracao },
      { analisadas: 243, semAlteracao: 243, importaveis: 0, comProblema: 0, novosGhes: 0, novosVinculos: 0, alteracoes: 0, ghesComCodigo: 0, haAlteracao: false },
    );
  });

  test('5 vínculos novos em GHEs existentes: 248 analisadas, 243 sem alteração, 5 para importar (novos vínculos, nenhum GHE novo)', () => {
    const banco = banco243();
    const { dados } = analisar([...planilhaIdentica(banco), ...[1, 2, 3, 4, 5].map((id) => novoVinculoDe(banco, id))], banco);
    const r = diferencas().resumir(dados);
    assert.deepEqual(
      { analisadas: r.analisadas, semAlteracao: r.semAlteracao, importaveis: r.importaveis, novosVinculos: r.novosVinculos, novosGhes: r.novosGhes, alteracoes: r.alteracoes, comProblema: r.comProblema, haAlteracao: r.haAlteracao },
      { analisadas: 248, semAlteracao: 243, importaveis: 5, novosVinculos: 5, novosGhes: 0, alteracoes: 0, comProblema: 0, haAlteracao: true },
    );
  });

  test('vínculo existente com classificação diferente: é uma alteração efetiva (não é sem alteração)', () => {
    const banco = banco243();
    const matriz = planilhaIdentica(banco);
    matriz[1] = [...matriz[1].slice(0, 3), 'Não obrigatório'];
    const { dados } = analisar(matriz, banco);
    const r = diferencas().resumir(dados);
    assert.deepEqual([r.analisadas, r.semAlteracao, r.importaveis, r.alteracoes, r.novosVinculos, r.haAlteracao], [243, 242, 1, 1, 0, true]);
  });

  test('GHE novo: o código ainda não existe e será criado, com os vínculos dele', () => {
    const banco = banco243();
    const novo = ['GHE-033', 'SETOR NOVO', NOMES_EPI[0], 'Obrigatório'];
    const { dados } = analisar([...planilhaIdentica(banco), novo, [novo[0], novo[1], NOMES_EPI[1], 'Obrigatório'], [novo[0], novo[1], NOMES_EPI[2], 'Não obrigatório']], banco);
    const r = diferencas().resumir(dados);
    assert.deepEqual([r.analisadas, r.semAlteracao, r.importaveis, r.novosGhes, r.novosVinculos, r.haAlteracao], [246, 243, 3, 1, 3, true]);
  });

  test('GHE legado (sem código) cujos vínculos já existem: nenhuma linha grava, mas o GHE vai receber o código — isso É uma alteração', () => {
    const banco = { ...banco243(), ghes: [...banco243().ghes, { id: 40, codigo: null, nome: 'LEGADO ANTIGO', ativo: true }], vinculos: [...banco243().vinculos, { gheId: 40, tipoId: 1, classificacao: 'OBRIGATORIO' }] };
    const { dados } = analisar([CABECALHO, ['GHE-040', 'LEGADO ANTIGO', NOMES_EPI[0], 'Obrigatório']], banco);
    assert.equal(dados.resumo.aplicaveis, 0, 'premissa: o servidor não conta linha aplicável');
    assert.equal(dados.ghes[0].operacao, 'ATRIBUIR_CODIGO', 'premissa: o servidor registra a atribuição de código');
    const r = diferencas().resumir(dados);
    assert.deepEqual([r.importaveis, r.semAlteracao, r.ghesComCodigo, r.haAlteracao], [0, 1, 1, true]);
  });

  test('linha com problema (EPI inexistente) e linha repetida no arquivo: não gravam, ficam contadas como "com problema" e não escondem o resto', () => {
    const banco = banco243();
    const matriz = [...planilhaIdentica(banco), [banco.ghes[0].codigo, banco.ghes[0].nome, 'EPI Que Não Existe', 'Obrigatório'], planilhaIdentica(banco)[1]];
    const { dados } = analisar(matriz, banco);
    const r = diferencas().resumir(dados);
    assert.deepEqual([r.analisadas, r.semAlteracao, r.importaveis, r.comProblema, r.haAlteracao], [245, 243, 0, 2, false]);
  });
});

describe('módulo: diferencas.linhasVisiveis — a tabela principal', () => {
  test('mesma planilha: nenhuma linha na tabela principal; com "mostrar itens já existentes" aparecem as 243, na ordem da planilha', () => {
    const banco = banco243();
    const { dados } = analisar(planilhaIdentica(banco), banco);
    assert.deepEqual(diferencas().linhasVisiveis(dados, { mostrarExistentes: false }), []);
    const todas = diferencas().linhasVisiveis(dados, { mostrarExistentes: true });
    assert.equal(todas.length, 243);
    assert.deepEqual(todas.map((l) => l.linha).slice(0, 3), [2, 3, 4]);
  });

  test('5 novos entre 243 existentes: a tabela principal tem só os 5 (linhas 245 a 249), e todas as 248 com o botão secundário', () => {
    const banco = banco243();
    const { dados } = analisar([...planilhaIdentica(banco), ...[1, 2, 3, 4, 5].map((id) => novoVinculoDe(banco, id))], banco);
    assert.deepEqual(diferencas().linhasVisiveis(dados, { mostrarExistentes: false }).map((l) => l.linha), [245, 246, 247, 248, 249]);
    assert.equal(diferencas().linhasVisiveis(dados, { mostrarExistentes: true }).length, 248);
  });

  test('o padrão (sem argumento) esconde os itens já existentes; problema fica visível mesmo escondendo os existentes; ordem da planilha', () => {
    const banco = banco243();
    const matriz = [...planilhaIdentica(banco), [banco.ghes[1].codigo, banco.ghes[1].nome, 'EPI Que Não Existe', 'Obrigatório'], novoVinculoDe(banco, 3)];
    const { dados } = analisar(matriz, banco);
    const visiveis = diferencas().linhasVisiveis(dados);
    assert.deepEqual(visiveis.map((l) => [l.linha, l.situacao]), [[245, 'EPI_NAO_ENCONTRADO'], [246, 'NOVO_VINCULO']]);
  });

  test('GHE legado que vai receber código: as linhas dele aparecem na tabela principal, mesmo sendo "vínculo existente"', () => {
    const banco = { ...banco243(), ghes: [...banco243().ghes, { id: 40, codigo: null, nome: 'LEGADO ANTIGO', ativo: true }], vinculos: [...banco243().vinculos, { gheId: 40, tipoId: 1, classificacao: 'OBRIGATORIO' }] };
    const { dados } = analisar([CABECALHO, ['GHE-040', 'LEGADO ANTIGO', NOMES_EPI[0], 'Obrigatório']], banco);
    assert.deepEqual(diferencas().linhasVisiveis(dados, { mostrarExistentes: false }).map((l) => l.linha), [2]);
  });
});

describe('módulo: mensagens e resumo', () => {
  test('mensagem de "nada a importar": uma para planilha já cadastrada, outra quando só há linhas com problema, nenhuma quando há alteração', () => {
    const m = mensagens();
    assert.equal(m.SEM_ALTERACAO, 'Nenhuma alteração para importar. Os dados desta planilha já estão cadastrados.');
    assert.match(m.SEM_ALTERACAO_COM_PROBLEMAS, /^Nenhuma alteração para importar\./);
    assert.match(m.SEM_ALTERACAO_COM_PROBLEMAS, /problema/i);
    assert.equal(/já estão cadastrados/.test(m.SEM_ALTERACAO_COM_PROBLEMAS), false);

    const banco = banco243();
    const identica = diferencas().resumir(analisar(planilhaIdentica(banco), banco).dados);
    const comProblema = diferencas().resumir(analisar([...planilhaIdentica(banco), [banco.ghes[0].codigo, banco.ghes[0].nome, 'EPI Que Não Existe', 'Obrigatório']], banco).dados);
    const comNovos = diferencas().resumir(analisar([...planilhaIdentica(banco), novoVinculoDe(banco, 1)], banco).dados);
    assert.equal(m.semAlteracao(identica), m.SEM_ALTERACAO);
    assert.equal(m.semAlteracao(comProblema), m.SEM_ALTERACAO_COM_PROBLEMAS);
    assert.equal(m.semAlteracao(comNovos), null);
  });

  test('resumo do preview: "Linhas lidas", "Sem alteração" e "Serão aplicadas" com os números do servidor; "Vínculo existente" não aparece mais como contagem solta', () => {
    const banco = banco243();
    const idem = analisar(planilhaIdentica(banco), banco).dados;
    const textoIdem = semTags(I.render.resumoPrevia(idem.resumo, idem.ghes));
    assert.match(textoIdem, /Linhas lidas:\s*243/);
    assert.match(textoIdem, /Sem alteração:\s*243/);
    assert.match(textoIdem, /Serão aplicadas:\s*0/);
    assert.equal(/Vínculo existente:/.test(textoIdem), false);

    const misto = analisar([...planilhaIdentica(banco), ...[1, 2, 3, 4, 5].map((id) => novoVinculoDe(banco, id))], banco).dados;
    const textoMisto = semTags(I.render.resumoPrevia(misto.resumo, misto.ghes));
    assert.match(textoMisto, /Linhas lidas:\s*248/);
    assert.match(textoMisto, /Sem alteração:\s*243/);
    assert.match(textoMisto, /Serão aplicadas:\s*5/);
    assert.match(textoMisto, /Novo vínculo:\s*5/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página em DOM simulado: o preview vem do analisarLote real sobre o "banco" do cenário
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };
const ACESSO_TOTAL = { permissoes: { recursos: { employeeGroups: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: {}, administracao: {} }, podeAlterar: true };
const PK = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const TEXTO_SEM_ALTERACAO = 'Nenhuma alteração para importar. Os dados desta planilha já estão cadastrados.';

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, o) => {
      const u = new URL(url);
      chamadas.push({ metodo: o.method, caminho: u.pathname + u.search, corpo: o.body === undefined ? undefined : JSON.parse(o.body) });
      return responder(u, o);
    },
  });
}
beforeEach(() => servidor(() => resposta(200, { status: 'ok' })));

/** Servidor do cenário: preview = analisarLote real sobre o banco; confirmar = resultado coerente com a análise. */
function servidorDoCenario(banco) {
  return (u, o) => {
    if (u.pathname === '/api/grupos-homogeneos' && o.method === 'GET') return resposta(200, { status: 'ok', grupos: banco.ghes, total: banco.ghes.length, pagina: 1, limite: 100 });
    if (u.pathname.endsWith('/importacao/preview') || u.pathname.endsWith('/importacao/confirmar')) {
      const linhas = JSON.parse(o.body).linhas;
      const analise = analisarLote({ linhas, ghes: banco.ghes, tipos: banco.tipos, vinculos: banco.vinculos });
      if (u.pathname.endsWith('/importacao/preview')) return resposta(200, { status: 'ok', ...analise });
      const aplicadas = analise.linhas.filter((l) => l.aplicavel).length;
      return resposta(200, {
        status: 'ok', importacaoId: aplicadas > 0 ? '3f2b8a52-6f0b-4d2e-9b1c-0a1b2c3d4e5f' : null, ghes: analise.ghes,
        resumo: { ...analise.resumo, aplicadas, ghesCriados: 0, ghesComCodigoAtribuido: 0, vinculosCriados: aplicadas, classificacoesAlteradas: 0, semAlteracao: analise.linhas.length - aplicadas, bloqueadas: 0 },
        linhas: analise.linhas.map((l) => ({ ...l, resultado: l.aplicavel ? 'APLICADA' : 'SEM_ALTERACAO' })),
      });
    }
    return resposta(500, { status: 'error' });
  };
}

function montarPagina(matriz, banco) {
  servidor(servidorDoCenario(banco));
  const html = ler('pages/employee-groups.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const confirmacoes = [];
  const el = (id) => (mapa[id] = mapa[id] || {
    id, value: '', innerHTML: '', textContent: '', disabled: false, hidden: undefined, style: {}, listeners: {}, files: [],
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    focus() {}, click() {},
  });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, confirm: (p) => { confirmacoes.push(p); return true; }, readXlsxFile: async () => [{ data: matriz }] },
    EpiHttp, EpiGruposHomogeneos: require('../js/grupos-homogeneos'), EpiImportacaoGhe: I, // eslint-disable-line global-require
    EpiPermissoes: { prepararPagina: async () => ACESSO_TOTAL },
    EpiSessaoEmpresarial: { montar: async () => CONTEXTO, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, setTimeout, Promise, String, Number, Array, Object, JSON, Uint8Array,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 60; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev, alvo) => { for (const fn of (el(id).listeners[ev] || [])) await fn({ target: alvo, preventDefault() {} }); await esperar(); };
  return {
    el, sandbox, esperar, confirmacoes,
    clicar: (id) => disparar(id, 'click', undefined),
    importar: async (nome = 'planilha.xlsx') => {
      await esperar();
      el('arquivoImportacaoGhe').files = [{ name: nome, size: 2048, slice: () => ({ arrayBuffer: async () => PK.buffer }) }];
      await disparar('arquivoImportacaoGhe', 'change', el('arquivoImportacaoGhe'));
    },
    tabela: () => linhasDeDados(el('importacaoCorpo').innerHTML),
    avisoImportacao: () => semTags(el('importacaoAviso').innerHTML),
    resumo: () => semTags(el('importacaoResumo').innerHTML),
  };
}
const posts = (sufixo) => chamadas.filter((c) => c.metodo === 'POST' && c.caminho.endsWith(sufixo));

describe('inspeção estática: pages/employee-groups.html', () => {
  test('o painel de importação tem o botão secundário "Mostrar itens já existentes" (escondido até haver itens sem alteração)', () => {
    const html = ler('pages/employee-groups.html');
    const inicio = html.search(/<section[^>]*\bid="painelImportacaoGhe"[^>]*>/);
    const painel = html.slice(inicio, html.indexOf('</section>', inicio));
    assert.match(painel, /<button[^>]*\bid="botaoMostrarExistentes"[^>]*>/, 'falta #botaoMostrarExistentes dentro do painel');
    assert.match(painel, /<button[^>]*\bid="botaoMostrarExistentes"[^>]*\btype="button"|<button[^>]*\btype="button"[^>]*\bid="botaoMostrarExistentes"/);
    assert.match(painel, /<button[^>]*\bid="botaoMostrarExistentes"[^>]*\bhidden\b|<button[^>]*\bhidden\b[^>]*\bid="botaoMostrarExistentes"/, 'começa escondido');
    assert.match(semTags(painel.slice(painel.indexOf('id="botaoMostrarExistentes"'))), /^[^]*?Mostrar itens já existentes/);
  });
});

describe('página: reimportar a MESMA planilha (243 linhas, 32 GHEs)', () => {
  test('o preview diz que não há nada a importar: mensagem clara, resumo correto, tabela principal vazia e Confirmar desabilitado', async () => {
    const banco = banco243();
    const pg = montarPagina(planilhaIdentica(banco), banco);
    await pg.importar('Importacao_GHE_EPI.xlsx');
    assert.equal(posts('/importacao/preview').length, 1);
    assert.equal(pg.el('painelImportacaoGhe').hidden, false, 'o preview abre');
    assert.ok(pg.avisoImportacao().includes(TEXTO_SEM_ALTERACAO), `mensagem esperada; houve: "${pg.avisoImportacao()}"`);
    assert.match(pg.resumo(), /Linhas lidas:\s*243/);
    assert.match(pg.resumo(), /Sem alteração:\s*243/);
    assert.match(pg.resumo(), /Serão aplicadas:\s*0/);
    assert.equal(pg.tabela().length, 0, 'nenhuma das 243 linhas ocupa a tabela principal');
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, true, 'Confirmar importação desabilitado');
  });

  test('mesmo clicando no botão desabilitado nada acontece: nenhuma pergunta, nenhum POST de confirmação, nenhuma releitura de lista', async () => {
    const banco = banco243();
    const pg = montarPagina(planilhaIdentica(banco), banco);
    await pg.importar();
    const listagensAntes = chamadas.filter((c) => c.metodo === 'GET' && c.caminho.startsWith('/api/grupos-homogeneos')).length;
    await pg.clicar('botaoConfirmarImportacao');
    assert.equal(pg.confirmacoes.length, 0, 'nenhuma confirmação humana é pedida');
    assert.equal(posts('/importacao/confirmar').length, 0, 'nada é enviado para confirmar');
    assert.equal(chamadas.filter((c) => c.metodo === 'GET' && c.caminho.startsWith('/api/grupos-homogeneos')).length, listagensAntes, 'a lista não é recarregada');
    assert.deepEqual(chamadas.filter((c) => c.metodo !== 'GET').map((c) => c.caminho), ['/api/grupos-homogeneos/importacao/preview'], 'a única escrita-like é o preview, que não grava');
  });

  test('"Mostrar itens já existentes" mostra as 243 linhas (só para conferência) e volta a esconder; Confirmar segue desabilitado', async () => {
    const banco = banco243();
    const pg = montarPagina(planilhaIdentica(banco), banco);
    await pg.importar();
    assert.strictEqual(pg.el('botaoMostrarExistentes').hidden, false, 'há itens já existentes: o botão aparece');
    assert.match(semTags(pg.el('botaoMostrarExistentes').innerHTML + pg.el('botaoMostrarExistentes').textContent), /Mostrar itens já existentes/);
    await pg.clicar('botaoMostrarExistentes');
    assert.equal(pg.tabela().length, 243);
    assert.match(semTags(pg.el('botaoMostrarExistentes').innerHTML + pg.el('botaoMostrarExistentes').textContent), /Ocultar itens já existentes/);
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, true);
    await pg.clicar('botaoMostrarExistentes');
    assert.equal(pg.tabela().length, 0);
  });

  test('uma nova escolha de arquivo ou o cancelamento voltam ao padrão (itens já existentes escondidos)', async () => {
    const banco = banco243();
    const pg = montarPagina(planilhaIdentica(banco), banco);
    await pg.importar();
    await pg.clicar('botaoMostrarExistentes');
    assert.equal(pg.tabela().length, 243);
    await pg.clicar('botaoCancelarImportacao');
    assert.equal(pg.el('painelImportacaoGhe').hidden, true);
    await pg.importar();
    assert.equal(pg.tabela().length, 0, 'o novo preview começa com os existentes escondidos');
  });
});

describe('página: planilha com 5 novos vínculos entre 243 existentes (248 linhas)', () => {
  const matriz = (banco) => [...planilhaIdentica(banco), ...[1, 2, 3, 4, 5].map((id) => novoVinculoDe(banco, id))];

  test('só as 5 linhas que gravam entram na tabela principal; o resumo conta 243 sem alteração e 5 para aplicar; Confirmar habilitado e sem a mensagem de "nada a importar"', async () => {
    const banco = banco243();
    const pg = montarPagina(matriz(banco), banco);
    await pg.importar();
    assert.deepEqual(pg.tabela().map((c) => semTags(c[0])), ['245', '246', '247', '248', '249']);
    assert.deepEqual(pg.tabela().map((c) => semTags(c[5])), Array(5).fill('Novo vínculo'));
    assert.match(pg.resumo(), /Linhas lidas:\s*248/);
    assert.match(pg.resumo(), /Sem alteração:\s*243/);
    assert.match(pg.resumo(), /Serão aplicadas:\s*5/);
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, false);
    assert.equal(pg.avisoImportacao().includes('Nenhuma alteração para importar'), false);
  });

  test('"Mostrar itens já existentes" acrescenta as 243 (248 no total), na ordem da planilha', async () => {
    const banco = banco243();
    const pg = montarPagina(matriz(banco), banco);
    await pg.importar();
    assert.equal(pg.tabela().length, 5, 'por padrão só as 5 linhas que gravam');
    await pg.clicar('botaoMostrarExistentes');
    assert.equal(pg.tabela().length, 248);
    assert.deepEqual(pg.tabela().slice(0, 2).map((c) => semTags(c[0])), ['2', '3']);
  });

  test('a confirmação continua reenviando as 248 linhas ORIGINAIS (o servidor recalcula e só grava as diferenças); nada de filtro no cliente', async () => {
    const banco = banco243();
    const pg = montarPagina(matriz(banco), banco);
    await pg.importar();
    await pg.clicar('botaoConfirmarImportacao');
    assert.equal(pg.confirmacoes.length, 1);
    assert.equal(posts('/importacao/confirmar').length, 1);
    assert.deepEqual(posts('/importacao/confirmar')[0].corpo, posts('/importacao/preview')[0].corpo, 'mesmo corpo do preview');
    assert.equal(posts('/importacao/confirmar')[0].corpo.linhas.length, 248);
    assert.deepEqual(Object.keys(posts('/importacao/confirmar')[0].corpo), ['linhas']);
  });
});

describe('página: alteração de classificação, GHE novo, GHE legado e linhas com problema', () => {
  test('vínculo existente com classificação diferente: aparece como alteração e habilita a confirmação', async () => {
    const banco = banco243();
    const m = planilhaIdentica(banco);
    m[1] = [...m[1].slice(0, 3), 'Não obrigatório'];
    const pg = montarPagina(m, banco);
    await pg.importar();
    assert.deepEqual(pg.tabela().map((c) => [semTags(c[0]), semTags(c[5])]), [['2', 'Classificação será alterada']]);
    assert.match(pg.resumo(), /Sem alteração:\s*242/);
    assert.match(pg.resumo(), /Serão aplicadas:\s*1/);
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, false);
  });

  test('GHE novo: as linhas dele aparecem, o resumo conta o GHE novo (não as linhas) e a confirmação fica habilitada', async () => {
    const banco = banco243();
    const novo = ['GHE-033', 'SETOR NOVO'];
    const pg = montarPagina([...planilhaIdentica(banco), [...novo, NOMES_EPI[0], 'Obrigatório'], [...novo, NOMES_EPI[1], 'Obrigatório'], [...novo, NOMES_EPI[2], 'Não obrigatório']], banco);
    await pg.importar();
    assert.equal(pg.tabela().length, 3);
    assert.match(pg.resumo(), /Novo GHE:\s*1\b/);
    assert.match(pg.resumo(), /Novo vínculo:\s*3/);
    assert.match(pg.resumo(), /Sem alteração:\s*243/);
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, false);
  });

  test('GHE legado que só vai receber código (vínculos já existem): não diz "já cadastrados", mostra o GHE e habilita a confirmação', async () => {
    const banco = { ...banco243(), ghes: [...banco243().ghes, { id: 40, codigo: null, nome: 'LEGADO ANTIGO', ativo: true }], vinculos: [...banco243().vinculos, { gheId: 40, tipoId: 1, classificacao: 'OBRIGATORIO' }] };
    const pg = montarPagina([CABECALHO, ['GHE-040', 'LEGADO ANTIGO', NOMES_EPI[0], 'Obrigatório']], banco);
    await pg.importar();
    assert.equal(pg.avisoImportacao().includes('já estão cadastrados'), false);
    assert.match(pg.resumo(), /GHE existente receberá código:\s*1/);
    assert.equal(pg.tabela().length, 1);
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, false);
  });

  test('só linhas com problema e o resto já existente: o problema continua visível, não se diz "já cadastrados" e Confirmar fica desabilitado', async () => {
    const banco = banco243();
    const pg = montarPagina([...planilhaIdentica(banco), [banco.ghes[0].codigo, banco.ghes[0].nome, 'EPI Que Não Existe', 'Obrigatório']], banco);
    await pg.importar();
    assert.deepEqual(pg.tabela().map((c) => [semTags(c[0]), semTags(c[5])]), [['245', 'EPI não encontrado']]);
    assert.match(pg.avisoImportacao(), /^Nenhuma alteração para importar\./);
    assert.equal(pg.avisoImportacao().includes('já estão cadastrados'), false);
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, true);
  });

  test('problema junto com novos vínculos: as linhas com problema e as novas ficam na tabela principal e a confirmação (parcial, como hoje) segue habilitada', async () => {
    const banco = banco243();
    const pg = montarPagina([...planilhaIdentica(banco), novoVinculoDe(banco, 1), [banco.ghes[0].codigo, banco.ghes[0].nome, 'EPI Que Não Existe', 'Obrigatório']], banco);
    await pg.importar();
    assert.deepEqual(pg.tabela().map((c) => semTags(c[0])), ['245', '246']);
    assert.match(pg.resumo(), /não serão aplicadas/i);
    assert.equal(pg.el('botaoConfirmarImportacao').disabled, false);
  });
});
