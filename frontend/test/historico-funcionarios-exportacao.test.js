'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Histórico de Funcionários — pacote I (RED): exportação na tela (independente do formato).
 *
 * Contrato proposto:
 *   - #botaoExportarHistorico só aparece (e habilita) com o colaborador identificado e com as DUAS permissões efetivas
 *     de GET /auth/permissoes (recursos.employeeHistory.visualizar E acoes.EXPORTAR_HISTORICO_FUNCIONARIOS); é só
 *     conveniência: quem decide é o servidor;
 *   - EpiHistoricoFuncionarios.FORMATOS_EXPORTACAO: os mesmos ids e extensões de FORMATOS do serviço do backend; com
 *     mais de um, #historyExportFormato escolhe (padrão: o primeiro);
 *   - o clique chama EpiHistoricoFuncionarios.acoes.exportar(funcionarioId, { formato, de?, ate? }) com o período
 *     APLICADO (pacote H) e, no sucesso, acoes.salvarArquivo(document, blob, nomeArquivo); #historyExportEstado diz o
 *     andamento e a falha (texto fixo; 403 fala de permissão);
 *   - acoes.exportar: POST /funcionarios/:id/historico/exportacao com credentials 'include' e corpo JSON; devolve
 *     { ok: true, blob, nomeArquivo } (nome do Content-Disposition) ou { ok: false, status, codigo };
 *   - resposta de outro colaborador, de antes do Limpar ou repetida não baixa nada; um clique por vez.
 */

const ARQUIVO = 'pages/employee-history.html';
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ visualizar = true, exportar = true, epis = false } = {}) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { employeeHistory: { ...NENHUMA, visualizar }, epiFicha: { ...NENHUMA, visualizar: epis } },
  acoes: { EXPORTAR_HISTORICO_FUNCIONARIOS: exportar },
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(false),
  },
});
const contexto = () => ({
  status: 'ok', usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@validacao-epi.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'SafeWork Homologação Ltda', cnpj: '11222333000181' }, preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const funcionario = (id) => ({
  id, empresaId: 3, nome: `Pessoa ${id}`, matricula: `M-${id}`, cpfMascarado: '***.***.***-25', setor: `Setor ${id}`, funcao: `Função ${id}`,
  situacao: 'ATIVO', ativo: true, grupoHomogeneoId: 10, grupoHomogeneo: { id: 10, codigo: 'GHE-010', descricao: 'Caldeiraria' },
});
const okLista = (itens) => ({ status: 200, corpo: { status: 'ok', funcionarios: itens, total: itens.length, pagina: 1, limite: 20 } });
const okEventos = (id, tipo) => ({ status: 200, corpo: { status: 'ok', funcionarioId: id, tipo, eventos: [], total: 0, pagina: 1, limite: 20 } });
const erro = (status, codigo) => ({ status, corpo: { status: 'error', codigo, message: 'texto do servidor que não aparece' } });

async function abrir({ perms = {}, exportacao, lista = [funcionario(11), funcionario(12)] } = {}) {
  const rotas = {
    'GET /auth/me': { status: 200, corpo: contexto() },
    'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
    'GET /auth/permissoes': { status: 200, corpo: permissoes(perms) },
    'GET /funcionarios': okLista(lista),
    'POST /funcionarios/consulta-cpf': okLista([funcionario(11)]),
  };
  for (const id of [11, 12]) {
    rotas[`GET /funcionarios/${id}`] = { status: 200, corpo: { status: 'ok', funcionario: funcionario(id) } };
    rotas[`GET /funcionarios/${id}/eventos`] = (c) => okEventos(id, new URL(c.url).searchParams.get('tipo'));
    if (exportacao !== undefined) rotas[`POST /funcionarios/${id}/historico/exportacao`] = exportacao;
  }
  const pg = abrirPagina(ARQUIVO, { rotas });
  await pg.esperar();
  await pg.esperar();
  return pg;
}
async function assentar(pg) { for (let i = 0; i < 6; i += 1) await pg.esperar(); }
async function buscar(pg, valor = 'Pessoa') {
  pg.el('historySearchValue').value = valor;
  await pg.el('botaoConsultar').disparar('click');
  await assentar(pg);
}
async function selecionar(pg, id) {
  const b = pg.consulta(`#historyResultados [data-id="${id}"]`)[0];
  assert.ok(b, `resultado ${id}`);
  await b.disparar('click');
  await assentar(pg);
}
async function abrirCom11(opcoes) { const pg = await abrir(opcoes); await buscar(pg); await selecionar(pg, 11); return pg; }
const existe = (pg, id) => pg.consulta(`#${id}`).length > 0;
const visivel = (pg, id) => existe(pg, id) && pg.visivel(id);
const usavel = (pg, id) => visivel(pg, id) && !pg.el(id).disabled;
const H = (pg) => pg.janela.EpiHistoricoFuncionarios;
const exportacoes = (pg) => pg.chamadas.filter((c) => c.metodo === 'POST' && /\/historico\/exportacao$/.test(c.caminho));
const estado = (pg) => (existe(pg, 'historyExportEstado') ? pg.texto('historyExportEstado').replace(/\s+/g, ' ').trim() : '');
const adiada = () => { let liberar; const p = new Promise((r) => { liberar = r; }); return { p, liberar: (v) => liberar(v) }; };
function formatos(pg) {
  const lista = H(pg).FORMATOS_EXPORTACAO;
  assert.ok(Array.isArray(lista) && lista.length > 0, 'FORMATOS_EXPORTACAO ausente');
  return lista;
}
/** Troca acoes.exportar e acoes.salvarArquivo por versões controladas pelo teste (o módulo os chama pelo objeto acoes). */
function interceptar(pg, resposta) {
  const registro = { exportar: [], salvos: [] };
  const acoes = H(pg).acoes;
  assert.equal(typeof acoes.exportar, 'function', 'acoes.exportar ausente');
  assert.equal(typeof acoes.salvarArquivo, 'function', 'acoes.salvarArquivo ausente');
  acoes.exportar = (id, opcoes) => { registro.exportar.push([id, opcoes]); return typeof resposta === 'function' ? resposta(id, opcoes) : Promise.resolve(resposta); };
  acoes.salvarArquivo = (doc, blob, nome) => { registro.salvos.push({ blob, nome }); };
  return registro;
}
async function clicarExportar(pg) {
  assert.ok(usavel(pg, 'botaoExportarHistorico'), 'botão Exportar indisponível');
  await pg.el('botaoExportarHistorico').disparar('click');
  await assentar(pg);
}
const SUCESSO = { ok: true, blob: { tamanho: 3 }, nomeArquivo: 'historico-funcionario-11-completo.arq' };

// ═══════════════════════════════════════════════════════════════════
describe('IF1 — permissões e exibição', () => {
  test('IF1.1 com as duas permissões: oculto antes da escolha, visível e habilitado depois; Limpar oculta de novo', async () => {
    const pg = await abrir();
    assert.equal(visivel(pg, 'botaoExportarHistorico'), false);
    await buscar(pg);
    assert.equal(visivel(pg, 'botaoExportarHistorico'), false);
    await selecionar(pg, 11);
    assert.equal(usavel(pg, 'botaoExportarHistorico'), true);
    await pg.el('botaoLimparHistorico').disparar('click');
    await assentar(pg);
    assert.equal(visivel(pg, 'botaoExportarHistorico'), false);
  });

  test('IF1.2 só Visualizar (sem Exportar): consulta o histórico, mas o botão não aparece e nada é pedido', async () => {
    const pg = await abrirCom11({ perms: { exportar: false } });
    assert.equal(pg.el('historyEmployeeName').value, 'Pessoa 11');
    assert.equal(visivel(pg, 'botaoExportarHistorico'), false);
    assert.equal(usavel(pg, 'botaoExportarHistorico'), false);
    assert.deepEqual(exportacoes(pg), []);
  });

  test('IF1.3 os formatos da tela são os do servidor (mesmos ids e extensões)', async () => {
    const pg = await abrir();
    const caminho = path.join(__dirname, '..', '..', 'backend', 'src', 'services', 'funcionario-historico-exportacao.service.js');
    assert.ok(fs.existsSync(caminho), 'serviço de exportação do backend ausente');
    const backend = require(caminho);
    assert.deepEqual(JSON.parse(JSON.stringify(formatos(pg).map((x) => [x.id, x.extensao]))), backend.FORMATOS.map((x) => [x.id, x.extensao]));
    if (formatos(pg).length > 1) assert.ok(existe(pg, 'historyExportFormato'), 'mais de um formato: escolha em #historyExportFormato');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('IF2 — pedido ao servidor', () => {
  test('IF2.1 todo o histórico: POST /funcionarios/11/historico/exportacao { formato } com credenciais, sem de/ate e sem CPF', async () => {
    const pg = await abrirCom11({ exportacao: { status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO' } } });
    await clicarExportar(pg);
    const [c] = exportacoes(pg);
    assert.ok(c, String(pg.chamadas.map((x) => x.chave)));
    assert.deepEqual(c.corpo, { formato: formatos(pg)[0].id });
    assert.equal(c.credentials, 'include');
    assert.equal(c.temQuery, false, 'nada na URL');
  });

  test('IF2.2 com período aplicado (pacote H): o mesmo de/ate das consultas vai no corpo', async () => {
    const pg = await abrirCom11({ exportacao: { status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO' } } });
    pg.el('historyPeriodoInicial').value = '2026-01-01';
    pg.el('historyPeriodoFinal').value = '2026-01-31';
    await pg.el('botaoAplicarPeriodo').disparar('click');
    await assentar(pg);
    await clicarExportar(pg);
    assert.deepEqual(exportacoes(pg)[0].corpo, { formato: formatos(pg)[0].id, de: '2026-01-01', ate: '2026-01-31' });
  });

  test('IF2.3 datas digitadas e não aplicadas não entram na exportação', async () => {
    const pg = await abrirCom11({ exportacao: { status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO' } } });
    pg.el('historyPeriodoInicial').value = '2026-01-01';
    pg.el('historyPeriodoFinal').value = '2026-01-31';
    await clicarExportar(pg);
    assert.deepEqual(exportacoes(pg)[0].corpo, { formato: formatos(pg)[0].id });
  });

  test('IF2.4 busca por CPF: o CPF nunca vai à exportação (nem URL nem corpo)', async () => {
    const pg = await abrir({ exportacao: { status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO' } } });
    await buscar(pg, '529.982.247-25');
    await clicarExportar(pg);
    const c = exportacoes(pg)[0];
    assert.equal(/52998224725|529\.982/.test(`${c.url} ${c.corpoBruto}`), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('IF3 — resultado na tela', () => {
  test('IF3.1 sucesso: salva o arquivo com o nome do servidor, uma vez; o estado diz que foi gerado', async () => {
    const pg = await abrirCom11();
    const r = interceptar(pg, SUCESSO);
    await clicarExportar(pg);
    assert.deepEqual(JSON.parse(JSON.stringify(r.exportar)), [[11, { formato: formatos(pg)[0].id }]]);
    assert.deepEqual(r.salvos.map((s) => s.nome), ['historico-funcionario-11-completo.arq']);
    assert.match(estado(pg), /gerad|conclu|baixad/i);
  });

  test('IF3.2 falhas: 403 fala de permissão; 404, 400, 500 e rede têm texto fixo; nada é salvo e o texto do servidor não aparece', async () => {
    for (const [nome, resposta, padrao] of [
      ['403', { ok: false, status: 403, codigo: 'EXPORTACAO_NAO_AUTORIZADA' }, /permiss/i],
      ['404', { ok: false, status: 404, codigo: 'FUNCIONARIO_NAO_ENCONTRADO' }, /não foi possível|não encontrado/i],
      ['400', { ok: false, status: 400, codigo: 'VALIDACAO' }, /não foi possível|período|inválid/i],
      ['500', { ok: false, status: 500, codigo: 'ERRO_INTERNO' }, /não foi possível/i],
      ['rede', { ok: false, status: 0, codigo: null }, /não foi possível/i],
    ]) {
      const pg = await abrirCom11();
      const r = interceptar(pg, resposta);
      await clicarExportar(pg);
      assert.deepEqual(r.salvos, [], nome);
      assert.match(estado(pg), padrao, `${nome}: ${estado(pg)}`);
      assert.equal(pg.textoDoDom().includes('texto do servidor'), false, nome);
      assert.equal(usavel(pg, 'botaoExportarHistorico'), true, `${nome}: pode tentar de novo`);
    }
  });

  test('IF3.3 401 durante a exportação: sessão encerrada e ida ao Portal, nada salvo', async () => {
    const pg = await abrirCom11();
    const r = interceptar(pg, { ok: false, status: 401, codigo: 'SESSAO_INVALIDA' });
    await clicarExportar(pg);
    assert.deepEqual(r.salvos, []);
    assert.ok(pg.navegacoes.some((d) => /portal\/index\.html/.test(d)), String(pg.navegacoes));
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('IF4 — respostas atrasadas e clique repetido', () => {
  test('IF4.1 exportação de A pendente e B escolhido: o arquivo de A não é salvo', async () => {
    const pg = await abrirCom11();
    const a = adiada();
    const r = interceptar(pg, () => a.p);
    const pendente = pg.el('botaoExportarHistorico').disparar('click');
    await assentar(pg);
    await selecionar(pg, 12);
    a.liberar(SUCESSO);
    await pendente;
    await assentar(pg);
    assert.deepEqual(r.salvos, []);
  });

  test('IF4.2 Limpar com exportação pendente: nada é salvo', async () => {
    const pg = await abrirCom11();
    const a = adiada();
    const r = interceptar(pg, () => a.p);
    const pendente = pg.el('botaoExportarHistorico').disparar('click');
    await assentar(pg);
    await pg.el('botaoLimparHistorico').disparar('click');
    a.liberar(SUCESSO);
    await pendente;
    await assentar(pg);
    assert.deepEqual(r.salvos, []);
  });

  test('IF4.3 um clique por vez: enquanto gera, o botão fica desabilitado e um segundo clique não pede de novo', async () => {
    const pg = await abrirCom11();
    const a = adiada();
    const r = interceptar(pg, () => a.p);
    const pendente = pg.el('botaoExportarHistorico').disparar('click');
    await assentar(pg);
    assert.equal(pg.el('botaoExportarHistorico').disabled, true);
    await pg.el('botaoExportarHistorico').disparar('click');
    a.liberar(SUCESSO);
    await pendente;
    await assentar(pg);
    assert.equal(r.exportar.length, 1);
    assert.equal(r.salvos.length, 1);
    assert.equal(pg.el('botaoExportarHistorico').disabled, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('IF5 — módulo: pedido binário e gravação do arquivo', () => {
  const MODULO = path.join(__dirname, '..', 'js', 'historico-funcionarios.js');
  function carregar(fetchFalso) {
    delete require.cache[require.resolve(MODULO)];
    globalThis.EpiHttp = { configurar: () => ({ baseUrl: 'http://api.teste/api' }), requisitar: async () => ({ ok: false, status: 0 }) };
    globalThis.EpiFuncionarios = {};
    globalThis.fetch = fetchFalso;
    return require(MODULO);
  }
  const resposta = (status, { corpo = null, blob = null, cabecalhos = {} } = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (n) => cabecalhos[String(n).toLowerCase()] ?? null },
    blob: async () => blob, json: async () => corpo, text: async () => JSON.stringify(corpo),
  });

  test('IF5.1 exportar: POST com credenciais e JSON; devolve o blob e o nome do Content-Disposition', async () => {
    const chamadas = [];
    const blob = { tipo: 'arquivo' };
    const M = carregar(async (url, opcoes) => { chamadas.push({ url, opcoes }); return resposta(200, { blob, cabecalhos: { 'content-disposition': 'attachment; filename="historico-funcionario-11-20260101-20260131.arq"' } }); });
    assert.equal(typeof M.acoes.exportar, 'function', 'acoes.exportar ausente');
    const r = await M.acoes.exportar(11, { formato: 'x', de: '2026-01-01', ate: '2026-01-31' });
    assert.deepEqual(r, { ok: true, blob, nomeArquivo: 'historico-funcionario-11-20260101-20260131.arq' });
    assert.equal(chamadas[0].url, 'http://api.teste/api/funcionarios/11/historico/exportacao');
    assert.equal(chamadas[0].opcoes.method, 'POST');
    assert.equal(chamadas[0].opcoes.credentials, 'include');
    assert.deepEqual(JSON.parse(chamadas[0].opcoes.body), { formato: 'x', de: '2026-01-01', ate: '2026-01-31' });
  });

  test('IF5.2 exportar: erro do servidor vira { ok: false, status, codigo }; falha de rede, status 0; nome perigoso nunca é usado', async () => {
    let M = carregar(async () => resposta(403, { corpo: { status: 'error', codigo: 'EXPORTACAO_NAO_AUTORIZADA' } }));
    assert.equal(typeof M.acoes.exportar, 'function', 'acoes.exportar ausente');
    assert.deepEqual(await M.acoes.exportar(11, { formato: 'x' }), { ok: false, status: 403, codigo: 'EXPORTACAO_NAO_AUTORIZADA' });
    M = carregar(async () => { throw new Error('rede'); });
    assert.deepEqual(await M.acoes.exportar(11, { formato: 'x' }), { ok: false, status: 0, codigo: null });
    M = carregar(async () => resposta(200, { blob: {}, cabecalhos: { 'content-disposition': 'attachment; filename="../../etc/passwd"' } }));
    const r = await M.acoes.exportar(11, { formato: 'x' });
    assert.equal(r.ok, true);
    assert.equal(/[\\/]|\.\./.test(r.nomeArquivo), false, r.nomeArquivo);
  });

  test('IF5.3 salvarArquivo: âncora com download e URL do blob, clicada uma vez e liberada', async () => {
    const M = carregar(async () => resposta(500));
    const eventos = [];
    const doc = {
      createElement: (tag) => ({ tag, click() { eventos.push(['click', this.download, this.href]); }, remove() { eventos.push(['remove']); }, setAttribute(k, v) { this[k] = v; } }),
      body: { appendChild: (e) => eventos.push(['append', e.tag]) },
    };
    const antigo = globalThis.URL;
    globalThis.URL = { createObjectURL: () => 'blob:teste', revokeObjectURL: (u) => eventos.push(['revoke', u]) };
    try {
      assert.equal(typeof M.acoes.salvarArquivo, 'function', 'acoes.salvarArquivo ausente');
      await M.acoes.salvarArquivo(doc, { tipo: 'arquivo' }, 'historico-funcionario-11-completo.arq');
    } finally { globalThis.URL = antigo; }
    assert.deepEqual(eventos.filter((e) => e[0] === 'click'), [['click', 'historico-funcionario-11-completo.arq', 'blob:teste']]);
    assert.ok(eventos.some((e) => e[0] === 'revoke' && e[1] === 'blob:teste'));
  });

  test('IF5.4 nada do arquivo vai para armazenamento do navegador; o módulo não monta HTML', () => {
    const fonte = fs.readFileSync(MODULO, 'utf8');
    assert.equal(/localStorage|sessionStorage|indexedDB/.test(fonte), false);
    assert.equal(/innerHTML/.test(fonte), false);
  });
});
